// The page. It never holds a key nor the prop token: it talks to YOUR server (/api/...),
// and reads live prices with a data token your server gives it for this trader.

const $ = (id) => document.getElementById(id);
let csrf = null;
let dataApi = null; // the data API, for the live prices only (from your server)
let socket = null;

// What a refusal code means for the person in front of the page. The full list, and what
// to do about each, is in the API reference.
const SAY = {
  STOP_LOSS_REQUIRED: "Set a stop loss.",
  TAKE_PROFIT_REQUIRED: "Set a take profit.",
  SYMBOL_NOT_TRADABLE_BY_API: "This symbol is traded in the Adona cockpit only.",
  SYMBOL_NOT_ALLOWED: "Not a symbol of your account.",
  MARKET_CLOSED: "The market is closed.",
  CONCURRENT_SL_EXCEEDED: "Your open stop losses would exceed your limit.",
  CONCURRENT_TP_EXCEEDED: "Your open take profits would exceed your limit.",
  TRADER_ORDER_RATE_LIMITED: "Too many orders this minute.",
  EXECUTABLE_PRICE_RATE_LIMITED: "Too many price requests this minute.",
  IDEMPOTENCY_OUTCOME_UNKNOWN: "We could not confirm this order. Check your positions before placing it again.",
  ACCOUNT_TEMPORARILY_UNAVAILABLE: "Account temporarily unavailable.",
};

async function call(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(csrf && method !== "GET" ? { "X-CSRF-Token": csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const retry = response.headers.get("Retry-After");
    const error = new Error(SAY[json.detail] ?? json.detail ?? `error ${response.status}`);
    error.code = json.detail;
    error.retryAfter = retry;
    throw error;
  }
  return json;
}

function cell(row, value) {
  const td = row.insertCell();
  td.textContent = value ?? "";
  return td;
}

function button(row, label, action) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = async () => {
    b.disabled = true;
    try { await action(); } catch (error) { alert(error.message); } finally { b.disabled = false; refresh(); }
  };
  row.insertCell().append(b);
}

async function refresh() {
  const [{ positions }, { orders }] = await Promise.all([call("GET", "/api/positions"), call("GET", "/api/pending-orders")]);
  const pos = $("positions").tBodies[0];
  pos.replaceChildren();
  for (const p of positions) {
    const row = pos.insertRow();
    [p.symbol, p.side, p.net_lots, p.entry_price, p.stop_loss_price, p.take_profit_price].forEach((v) => cell(row, v));
    // Absent for an index or energy: no current valuation is published for those.
    cell(row, p.net_unrealized_pnl ?? "n/a");
    button(row, "Close", () => call("POST", `/api/positions/${encodeURIComponent(p.position_id)}/close`));
  }
  const pend = $("pending").tBodies[0];
  pend.replaceChildren();
  for (const o of orders) {
    const row = pend.insertRow();
    [o.symbol, o.side, o.kind, o.entry_price, o.quantity, o.stop_loss_price, o.take_profit_price].forEach((v) => cell(row, v));
    button(row, "Cancel", () => call("POST", `/api/orders/${encodeURIComponent(o.order_id)}/cancel`));
  }
}

function showExecution(e) {
  const row = $("executions").tBodies[0].insertRow(0);
  [new Date(e.created_at).toLocaleTimeString(), e.intent_kind, e.symbol, e.side, e.status, e.filled_qty, e.avg_price, e.reject_reason].forEach((v) => cell(row, v));
}

// Live prices for the ONE symbol on screen. Each signed-in trader is one connection on
// your data plan, and a symbol followed live most of its open hours is billed as a
// continuous feed: subscribe to what is displayed, nothing more.
async function watch(symbol) {
  if (socket) socket.close(1000);
  $("bid").textContent = $("ask").textContent = "-";
  const { token } = await call("GET", "/api/data-token");
  const response = await fetch(`${dataApi}/v1/ws-ticket`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return;
  const { ticket } = await response.json();
  socket = new WebSocket(`${dataApi.replace(/^http/, "ws")}/v1/stream`, ["adona.data.v1", `ticket.${ticket}`]);
  socket.onopen = () => socket.send(JSON.stringify({ type: "subscribe", request_id: "q", payload: { channels: [`quote:${symbol}`] } }));
  socket.onmessage = (event) => {
    const { type, payload } = JSON.parse(event.data);
    if ((type === "quote.snapshot" || type === "quote.update") && payload.symbol === symbol) {
      $("bid").textContent = payload.bid;
      $("ask").textContent = payload.ask;
      $("quote-at").textContent = new Date(payload.as_of).toLocaleTimeString();
    }
  };
}

async function start() {
  const session = await call("GET", "/api/session");
  ({ csrf, data_api: dataApi } = session);
  $("who").textContent = session.user;
  $("signin").hidden = true;
  $("cockpit").hidden = false;
  const { symbols } = await call("GET", "/api/symbols");
  $("symbol").replaceChildren(...symbols.map((s) => new Option(s, s)));
  $("symbol").onchange = () => watch($("symbol").value);
  if (symbols.length) watch(symbols[0]);

  const { executions } = await call("GET", "/api/executions");
  executions.slice().reverse().forEach(showExecution);
  // Your server relays THIS trader's executions as they come, and nobody else's.
  new EventSource("/api/stream").addEventListener("execution", (event) => {
    showExecution(JSON.parse(event.data));
    refresh();
  });
  await refresh();
}

$("login").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await call("POST", "/api/login", { username: new FormData(event.target).get("username") });
    await start();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
};

$("order").onsubmit = async (event) => {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(event.target));
  const result = $("order-result");
  result.textContent = "Sending...";
  try {
    const ack = await call("POST", "/api/orders", { ...form, symbol: $("symbol").value, entry_price: form.entry_price || undefined });
    result.textContent = `Accepted (${ack.position_id ?? ack.order_id ?? ack.event_id}).`;
  } catch (error) {
    result.textContent = error.retryAfter ? `${error.message} Retry in ${error.retryAfter} s.` : error.message;
  }
  refresh();
};

$("price").onclick = async () => {
  const side = new FormData($("order")).get("side");
  try {
    const p = await call("GET", `/api/price?symbol=${encodeURIComponent($("symbol").value)}&side=${side}&intent=open`);
    $("order-result").textContent = `A ${side} at market would fill near ${p.price} now (indicative).`;
  } catch (error) {
    $("order-result").textContent = error.message;
  }
};

call("GET", "/api/session").then(start).catch(() => {});
