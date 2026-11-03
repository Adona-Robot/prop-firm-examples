// The cockpit against a REAL Adona Robot: the "ready to trade" checklist, through this
// server, as a trader's page would go through it. Adona's own CI runs it on every change
// of /v1/prop, against a throwaway stack; you can run it against yours.
//
//   ADONA_API=... ADONA_TENANT_KEY=... ADONA_DATA_KEY=... \
//   CHECK_TRADERS=<external_ref of trader A>,<external_ref of trader B> node check/live.mjs
//
// Both traders need an open account. It opens and closes one small EURUSD position for
// trader A: run it on a demo account, never on a funded one.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Adona } from "../adona.mjs";
import { createApp } from "../server.mjs";

const SYMBOL = process.env.CHECK_SYMBOL ?? "EURUSD";
const LOTS = "0.01";
const GAP = 0.003; // the stop loss and take profit, this far from the price
const WAIT_MS = Number(process.env.CHECK_WAIT_MS ?? 30_000);

const [refA, refB] = (process.env.CHECK_TRADERS ?? "").split(",").map((s) => s.trim());
if (!refA || !refB) throw new Error("set CHECK_TRADERS=<external_ref A>,<external_ref B>");

const adona = new Adona({
  api: process.env.ADONA_API ?? "https://api.adona-robot.com",
  tenantKey: process.env.ADONA_TENANT_KEY,
  dataKey: process.env.ADONA_DATA_KEY || undefined,
});
const app = createApp({ adona, users: new Map([["a", refA], ["b", refB]]) });
await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${app.address().port}`;
const JSON_TYPE = { "Content-Type": "application/json" };

const ok = (what) => console.log(`ok   ${what}`);

async function signIn(username) {
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ username }) });
  assert.equal(login.status, 200, `sign-in of ${username}: ${login.status}`);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
  return { cookie, csrf: session.csrf, session };
}

// The page's stream, read into `events` until the check ends.
function stream(who, symbol, events, signal) {
  fetch(`${base}/api/stream${symbol ? `?symbol=${symbol}` : ""}`, { headers: { cookie: who.cookie }, signal }).then(async (response) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = block.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
        const data = block.split("\n").find((l) => l.startsWith("data: "));
        if (event && data) events.push({ event, ...JSON.parse(data.slice(6)) });
      }
    }
  }).catch(() => {});
}

async function until(what, test) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const found = test();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${what}: nothing within ${WAIT_MS} ms`);
}

function post(who, path, body, key = randomUUID()) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...JSON_TYPE, cookie: who.cookie, "X-CSRF-Token": who.csrf, "Idempotency-Key": key },
    body: JSON.stringify(body ?? {}),
  });
}

const stop = new AbortController();
try {
  const a = await signIn("a");
  const b = await signIn("b");
  assert.equal("data_api" in a.session, false, "no data API address for the page");
  ok("two traders signed in; the page receives no key and no token");

  const { symbols } = await (await fetch(`${base}/api/symbols`, { headers: { cookie: a.cookie } })).json();
  assert.ok(symbols.includes(SYMBOL), `${SYMBOL} among ${symbols}`);
  ok(`${SYMBOL} is tradable`);

  const toA = [], toB = [];
  stream(a, SYMBOL, toA, stop.signal);
  stream(b, null, toB, stop.signal);

  if (a.session.live_prices) {
    await until("a live price relayed by the server", () => toA.find((e) => e.event === "quote" && e.symbol === SYMBOL));
    ok("a live price, relayed by the server");
  }

  const price = await (await fetch(`${base}/api/price?symbol=${SYMBOL}&side=BUY&intent=open`, { headers: { cookie: a.cookie } })).json();
  const at = Number(price.price);
  const order = {
    symbol: SYMBOL, side: "BUY", quantity: LOTS,
    stop_loss_price: (at - GAP).toFixed(5), take_profit_price: (at + GAP).toFixed(5),
  };

  const noStop = await post(a, "/api/orders", { ...order, stop_loss_price: undefined });
  assert.deepEqual([noStop.status, (await noStop.json()).detail], [409, "STOP_LOSS_REQUIRED"]);
  ok("an opening without a stop loss is refused");

  const key = randomUUID();
  const first = await post(a, "/api/orders", order, key);
  assert.equal(first.status, 200, `the opening: ${first.status} ${JSON.stringify(await first.clone().json())}`);
  const ack = await first.json();
  const again = await (await post(a, "/api/orders", order, key)).json();
  assert.deepEqual(again, ack, "the same key answers the same order");
  ok("an opening sent twice with its key is one order");

  await until("the opening's confirmation, pushed", () => toA.find((e) => e.event === "execution" && e.status === "FILLED"));
  ok("its confirmation came by the stream, to trader A");

  const { positions } = await (await fetch(`${base}/api/positions`, { headers: { cookie: a.cookie } })).json();
  const position = positions.find((p) => p.symbol === SYMBOL);
  assert.ok(position && /^pos_/.test(position.position_id), `an opaque position id: ${position?.position_id}`);
  const before = toA.filter((e) => e.event === "execution").length;
  const closed = await post(a, `/api/positions/${encodeURIComponent(position.position_id)}/close`);
  assert.equal(closed.status, 200, `the close: ${closed.status}`);
  const close = await until("the close's confirmation", () =>
    toA.filter((e) => e.event === "execution").slice(before).find((e) => e.status === "FILLED"));
  assert.equal(close.trigger_reason, "MANUAL", "a close the trader asked for");
  ok("the position closed by its opaque id, said MANUAL");

  assert.equal(toB.filter((e) => e.event === "execution").length, 0, "trader B saw none of A's");
  ok("trader B received none of trader A's executions");
  console.log("all checks passed");
} finally {
  stop.abort();
  app.closeAllConnections();
  app.close();
}
