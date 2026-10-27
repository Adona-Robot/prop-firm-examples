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
  IDEMPOTENCY_KEY_IN_PROGRESS: "Still being placed. Wait a moment, then check your positions.",
  UPSTREAM_UNAVAILABLE: "We could not confirm this. Check your positions and orders before sending it again.",
  ACCOUNT_TEMPORARILY_UNAVAILABLE: "Account temporarily unavailable.",
};

// One key per order, made when it is first sent and kept until a FINAL answer: an
// accepted order, or a refusal of the order itself. Sent again (no answer, a reload of the
// request, the server unsure), the order carries the same key, and Adona places it once.
// Changed in any field, it is another order, with another key.
// Kept in the tab's sessionStorage, so a reload of the page keeps them too.
const STORE = "order-keys";
const keys = new Map(Object.entries((() => {
  try { return JSON.parse(sessionStorage.getItem(STORE)) ?? {}; } catch { return {}; }
})()));

function saveKeys() {
  try { sessionStorage.setItem(STORE, JSON.stringify(Object.fromEntries(keys))); } catch { /* private mode: memory only */ }
}

function keyFor(what) {
  if (!keys.has(what)) {
    keys.set(what, crypto.randomUUID());
    saveKeys();
  }
  return keys.get(what);
}

// Final: the order was taken, or refused for what it is (4xx). Not final: no answer at
// all, or our server or Adona unsure (5xx, 502): the next send reuses the key.
function settle(what, error) {
  if (!error || (error.status >= 400 && error.status < 500 && error.code !== "IDEMPOTENCY_KEY_IN_PROGRESS")) {
    keys.delete(what);
    saveKeys();
  }
}

async function order(path, body) {
  const what = `${path} ${JSON.stringify(body ?? {})}`;
  try {
    const ack = await call("POST", path, body, keyFor(what));
    settle(what);
    return ack;
  } catch (error) {
    settle(what, error);
    throw error;
  }
}

// Signed out (expired, or signed in elsewhere): back to the sign-in.
function signedOut() {
  if (socket) socket.close(1000);
  $("cockpit").hidden = true;
  $("signin").hidden = false;
}

async function call(method, path, body, idempotencyKey) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(csrf && method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const error = new Error(SAY.UPSTREAM_UNAVAILABLE);
    error.status = 0; // no answer: not final
    throw error;
  }
  const json = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/api/login") signedOut();
  if (!response.ok) {
    const retry = response.headers.get("Retry-After");
    const error = new Error(SAY[json.detail] ?? json.detail ?? `error ${response.status}`);
    error.code = json.detail;
    error.status = response.status;
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
  try { await draw(); } catch { /* signed out, or a passing failure: the next refresh retries */ }
}

async function draw() {
  const [{ positions }, { orders }] = await Promise.all([call("GET", "/api/positions"), call("GET", "/api/pending-orders")]);
  const pos = $("positions").tBodies[0];
  pos.replaceChildren();
  for (const p of positions) {
    const row = pos.insertRow();
    [p.symbol, p.side, p.net_lots, p.entry_price, p.stop_loss_price, p.take_profit_price].forEach((v) => cell(row, v));
    // Absent for an index or energy: no current valuation is published for those.
    cell(row, p.net_unrealized_pnl ?? "n/a");
    button(row, "Close", () => order(`/api/positions/${encodeURIComponent(p.position_id)}/close`));
  }
  const pend = $("pending").tBodies[0];
  pend.replaceChildren();
  for (const o of orders) {
    const row = pend.insertRow();
    [o.symbol, o.side, o.kind, o.entry_price, o.quantity, o.stop_loss_price, o.take_profit_price].forEach((v) => cell(row, v));
    button(row, "Cancel", () => order(`/api/orders/${encodeURIComponent(o.order_id)}/cancel`));
  }
}

function showExecution(e) {
  const row = $("executions").tBodies[0].insertRow(0);
  [new Date(e.created_at).toLocaleTimeString(), e.intent_kind, e.symbol, e.side, e.status, e.filled_qty, e.avg_price, e.reject_reason].forEach((v) => cell(row, v));
}

// Live prices for the ONE symbol on screen. Each signed-in trader is one connection on
// your data plan (each open tab too), and a symbol followed live most of its open hours is
// billed as a continuous feed: subscribe to what is displayed, nothing more.
let watching = 0; // the latest request: an older one that finishes late gives up
let backoff = 1000;

function stale() {
  $("bid").textContent = $("ask").textContent = "-";
  $("quote-at").textContent = "no live price";
}

async function watch(symbol) {
  const generation = ++watching;
  if (socket) { socket.onclose = null; socket.close(1000); socket = null; }
  stale();
  let ticket;
  try {
    const { token } = await call("GET", "/api/data-token");
    const response = await fetch(`${dataApi}/v1/ws-ticket`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`ticket ${response.status}`);
    ({ ticket } = await response.json());
  } catch {
    if (generation === watching) setTimeout(() => generation === watching && watch(symbol), backoff = Math.min(backoff * 2, 30_000));
    return;
  }
  if (generation !== watching) return; // the trader moved on meanwhile
  socket = new WebSocket(`${dataApi.replace(/^http/, "ws")}/v1/stream`, ["adona.data.v1", `ticket.${ticket}`]);
  // Dropped: say so (never a frozen price that looks live), then come back. A close
  // with a reason (1008) is an answer, such as an access cut: no loop on it.
  socket.onclose = (event) => {
    stale();
    if (event.code !== 1008 && generation === watching) setTimeout(() => generation === watching && watch(symbol), backoff = Math.min(backoff * 2, 30_000));
  };
  socket.onopen = () => socket.send(JSON.stringify({ type: "subscribe", request_id: "q", payload: { channels: [`quote:${symbol}`] } }));
  socket.onmessage = (event) => {
    const { type, payload } = JSON.parse(event.data);
    if ((type === "quote.snapshot" || type === "quote.update") && payload.symbol === symbol) {
      backoff = 1000;
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
  const executionsFeed = new EventSource("/api/stream");
  executionsFeed.addEventListener("execution", (event) => {
    showExecution(JSON.parse(event.data));
    refresh();
  });
  // Closed for good (signed out, the server gone): check the session, which signs out.
  executionsFeed.onerror = () => {
    if (executionsFeed.readyState === EventSource.CLOSED) call("GET", "/api/session").catch(() => {});
  };
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
  const place = event.submitter ?? event.target.querySelector("button");
  if (place.disabled) return;
  place.disabled = true; // one order per click, until its answer
  result.textContent = "Sending...";
  try {
    const ack = await order("/api/orders", { ...form, symbol: $("symbol").value, entry_price: form.entry_price || undefined });
    result.textContent = `Accepted (${ack.position_id ?? ack.order_id ?? ack.event_id}).`;
  } catch (error) {
    result.textContent = error.retryAfter && error.status === 429 ? `${error.message} Retry in ${error.retryAfter} s.` : error.message;
  } finally {
    place.disabled = false;
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
