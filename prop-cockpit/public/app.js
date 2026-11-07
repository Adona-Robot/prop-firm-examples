// The page. It never holds a key nor a token: it talks to YOUR server (/api/...), which
// relays this trader's confirmations and the live price on screen (/api/stream).

import { relistAfterExecutions } from "./relist.js";

const $ = (id) => document.getElementById(id);
let csrf = null;
let livePrices = false; // your server relays live prices (it holds a data key)
let feed = null; // the EventSource of /api/stream

// What a refusal code means for the person in front of the page. The full list, and what
// to do about each, is in the API reference.
const SAY = {
  STOP_LOSS_REQUIRED: "Set a stop loss.",
  TAKE_PROFIT_REQUIRED: "Set a take profit.",
  SYMBOL_NOT_TRADABLE_BY_API: "This symbol cannot be traded here.",
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
  NO_TRADING_ACCOUNT: "You have no trading account yet.",
  EXPOSURE_UNAVAILABLE: "Your account cannot be read right now. Retry in a few seconds.",
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

// Why a position closed, when the trader did not close it themselves (`trigger_reason`).
const WHY = {
  SL_HIT: "Stop loss",
  TP_HIT: "Take profit",
  BREACH: "Account rule",
  ACCOUNT_ENDED: "Account ended",
  DESK: "Closed by the desk",
  MANUAL: "",
};

// Signed out (expired, or signed in elsewhere): back to the sign-in.
function signedOut() {
  if (feed) { feed.close(); feed = null; }
  $("cockpit").hidden = true;
  $("signin").hidden = false;
}

async function call(method, path, body, idempotencyKey) {
  let response;
  // Every write is JSON, a close or a cancel with an empty body too: your server refuses
  // any other type, which is what keeps a form on another site out.
  if (method !== "GET") body ??= {};
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
const afterExecution = relistAfterExecutions(refresh);

async function draw() {
  const [{ positions }, { orders }] = await Promise.all([call("GET", "/api/positions"), call("GET", "/api/pending-orders")]);
  const pos = $("positions").tBodies[0];
  pos.replaceChildren();
  for (const p of positions) {
    const row = pos.insertRow();
    [p.symbol, p.side, p.net_lots, p.entry_price, p.stop_loss_price, p.take_profit_price].forEach((v) => cell(row, v));
    // Absent for an index or energy: no current valuation is published for those.
    cell(row, p.net_unrealized_pnl ?? "n/a");
    button(row, "Reduce", () => {
      const quantity = prompt(`Lots to take off ${p.symbol}`, "");
      if (!quantity) return Promise.resolve();
      return order(`/api/positions/${encodeURIComponent(p.position_id)}/reduce`, { symbol: p.symbol, quantity });
    });
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
  [new Date(e.created_at).toLocaleTimeString(), e.intent_kind, e.symbol, e.side, e.status, e.filled_qty, e.avg_price,
    WHY[e.trigger_reason] ?? e.trigger_reason ?? "", SAY[e.reject_reason] ?? e.reject_reason].forEach((v) => cell(row, v));
}

// The ONE symbol on screen, live from your server (it relays one price socket to every
// page: one connection on your data plan, whatever the number of pages). A symbol
// followed live most of its open hours is billed as a continuous feed: the page asks for
// the symbol it shows, nothing more.
let watching = 0; // the latest request: an older one that finishes late gives up
let live = false; // a live price for the symbol on screen
let shown = null; // the symbol whose price is on screen

// Never an empty screen: until the first live price (a page just opened, a symbol just
// chosen, the stream reconnecting), the last known price, from the executable price your
// server reads (a market BUY fills at the ask, a SELL at the bid), with the time the API
// gives for it (`as_of`: the price is at least that old), marked as such. On a closed
// market it is that market's last price, said closed (`market_open: false`): an order now
// would be refused. The next live price replaces it. Two reads of a quota of thirty a
// minute per trader: one symbol change, or one reconnection, costs two.
async function lastKnown(symbol, generation) {
  try {
    const [sell, buy] = await Promise.all(["SELL", "BUY"].map((side) =>
      call("GET", `/api/price?symbol=${encodeURIComponent(symbol)}&side=${side}&intent=open`)));
    if (generation !== watching || live) return;
    $("bid").textContent = sell.price;
    $("ask").textContent = buy.price;
    const at = new Date(buy.as_of).toLocaleString();
    $("quote-at").textContent = buy.market_open === false ? `market closed, last known as of ${at}` : `last known as of ${at}`;
  } catch {
    // The quota, a server restarting: what is on screen stays, and says it is not live.
    if (generation === watching && !live) $("quote-at").textContent = "no live price";
  }
}

function stale(symbol, generation) {
  live = false;
  if (!symbol) return;
  $("quote-at").textContent = "no live price";
  void lastKnown(symbol, generation);
}

// One stream per page: this trader's executions, and the price of `symbol`. A new symbol
// opens a new stream; the browser reconnects a dropped one by itself.
function watch(symbol) {
  const generation = ++watching;
  if (feed) feed.close();
  // A new symbol clears the old one's price. A reconnection keeps it on screen, said not
  // live, while it comes back: never an empty screen.
  if (symbol !== shown) { $("bid").textContent = $("ask").textContent = "-"; shown = symbol; }
  stale(symbol, generation);
  feed = new EventSource(symbol ? `/api/stream?symbol=${encodeURIComponent(symbol)}` : "/api/stream");
  feed.addEventListener("quote", (event) => {
    const quote = JSON.parse(event.data);
    if (generation !== watching || quote.symbol !== symbol) return;
    live = true;
    $("bid").textContent = quote.bid;
    $("ask").textContent = quote.ask;
    $("quote-at").textContent = new Date(quote.as_of).toLocaleTimeString();
  });
  feed.addEventListener("quote-stale", () => { if (generation === watching) stale(symbol, generation); });
  feed.addEventListener("execution", (event) => {
    showExecution(JSON.parse(event.data));
    afterExecution();
  });
  feed.onerror = () => {
    if (generation !== watching) return;
    stale(symbol, generation);
    // Closed for good (signed out, the server gone): check the session, which signs out.
    if (feed.readyState === EventSource.CLOSED) call("GET", "/api/session").catch(() => {});
  };
}

async function start() {
  const session = await call("GET", "/api/session");
  ({ csrf, live_prices: livePrices } = session);
  $("who").textContent = session.user;
  $("signin").hidden = true;
  $("cockpit").hidden = false;
  const { symbols } = await call("GET", "/api/symbols");
  $("symbol").replaceChildren(...symbols.map((s) => new Option(s, s)));
  $("symbol").onchange = () => watch($("symbol").value);
  watch(symbols[0] ?? null); // the executions come on this stream too, symbol or not

  // History first; then your server relays THIS trader's executions as they come (watch).
  const { executions } = await call("GET", "/api/executions");
  executions.slice().reverse().forEach(showExecution);
  if (!livePrices) $("quote-at").textContent = "last known prices: your server brings no live prices";
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
