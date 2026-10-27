// The example's own tests, against a FAKE Adona Robot on this machine: no key, no network.
//
//   node --test
//
// What they hold: each trader sees only their own executions; an order sent twice over a
// network that hesitates is placed once; the writes need the CSRF token; the server acts
// for the signed-in trader whatever the browser sends; the demo sign-in stays local.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { Adona } from "../adona.mjs";
import { createApp } from "../server.mjs";
import { assertLocalOnly } from "../demo-login.mjs";

// --- a fake Adona ------------------------------------------------------------------------

function fakeAdona() {
  const state = {
    traders: { "ref-alice": "t-alice", "ref-bob": "t-bob" },
    executions: { "t-alice": [], "t-bob": [] },
    orders: [], // what was PLACED, once per key
    byKey: new Map(),
    dropFirstAnswer: false, // the first order's answer is lost on the way back
    unknownOutcome: false,
    calls: [],
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://fake");
    const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    state.calls.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/v1/prop/tokens") return json(200, { access_token: "prop-token", expires_in: 43200 });
    if (url.pathname === "/v1/tokens") return json(200, { access_token: `data-${JSON.parse(raw).end_user_id}`, expires_in: 43200 });
    if (url.pathname === "/v1/prop/traders") {
      const id = state.traders[url.searchParams.get("external_ref")];
      return json(200, { traders: id ? [{ trader_id: id }] : [] });
    }
    let m = url.pathname.match(/^\/v1\/prop\/traders\/([^/]+)\/(executions|positions|pending-orders|tradable-symbols)$/);
    if (m) {
      const [, trader, what] = m;
      if (what === "executions") return json(200, { executions: [...state.executions[trader]].reverse() });
      if (what === "positions") return json(200, { positions: [] });
      if (what === "pending-orders") return json(200, { orders: [] });
      return json(200, { symbols: ["EURUSD"] });
    }
    m = url.pathname.match(/^\/v1\/prop\/traders\/([^/]+)\/orders$/);
    if (m && req.method === "POST") {
      const key = req.headers["idempotency-key"];
      if (!key) return json(400, { detail: "IDEMPOTENCY_KEY_REQUIRED" });
      if (state.unknownOutcome) return json(409, { detail: "IDEMPOTENCY_OUTCOME_UNKNOWN" });
      if (!state.byKey.has(key)) {
        const ack = { ingress_status: "PUBLISHED", event_id: `ev-${state.orders.length + 1}` };
        state.orders.push({ trader: m[1], key, body: JSON.parse(raw) });
        state.byKey.set(key, ack);
        if (state.dropFirstAnswer) {
          state.dropFirstAnswer = false;
          return req.socket.destroy(); // placed, but the answer never arrives
        }
      }
      return json(200, state.byKey.get(key));
    }
    json(404, { detail: "Not Found" });
  });
  return { state, server };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function world(t) {
  const fake = fakeAdona();
  const api = await listen(fake.server);
  const adona = new Adona({ api, tenantKey: "tenant-key-for-tests", dataKey: "data-key-for-tests", timeoutMs: 2000 });
  const app = createApp({ adona, users: new Map([["alice", "ref-alice"], ["bob", "ref-bob"]]), pollMs: 50 });
  const base = await listen(app);
  t.after(() => { app.closeAllConnections(); app.close(); fake.server.closeAllConnections(); fake.server.close(); });
  return { fake, base };
}

async function signIn(base, username) {
  const login = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ username }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const { csrf } = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
  return { cookie, csrf };
}

// Reads Server-Sent Events into `received` until aborted.
function listenStream(base, cookie, received, signal) {
  return fetch(`${base}/api/stream`, { headers: { cookie }, signal }).then(async (response) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) received.push(JSON.parse(data.slice(6)));
      }
    }
  }).catch(() => {});
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- the tests ---------------------------------------------------------------------------

test("each trader receives their own executions, and only theirs", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  const bob = await signIn(base, "bob");
  const stop = new AbortController();
  const toAlice = [], toBob = [];
  listenStream(base, alice.cookie, toAlice, stop.signal);
  listenStream(base, bob.cookie, toBob, stop.signal);
  await settle(150); // both feeds primed: what was there before is history

  fake.state.executions["t-alice"].push({ event_id: "a-1", status: "FILLED" });
  fake.state.executions["t-bob"].push({ event_id: "b-1", status: "FILLED" });
  fake.state.executions["t-alice"].push({ event_id: "a-2", status: "FILLED" });
  await settle(200);
  stop.abort();

  assert.deepEqual(toAlice.map((e) => e.event_id), ["a-1", "a-2"]);
  assert.deepEqual(toBob.map((e) => e.event_id), ["b-1"]);
});

test("an order whose answer is lost is sent again with the same key, and placed once", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  fake.state.dropFirstAnswer = true;
  const response = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { cookie: alice.cookie, "X-CSRF-Token": alice.csrf },
    body: JSON.stringify({ symbol: "EURUSD", side: "BUY", quantity: "0.1", stop_loss_price: "1.09", take_profit_price: "1.11" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).event_id, "ev-1");
  assert.equal(fake.state.orders.length, 1, "one position, not two");
  assert.equal(fake.state.calls.filter((c) => c === "POST /v1/prop/traders/t-alice/orders").length, 2);
});

test("an outcome Adona cannot tell is shown, never sent again", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  fake.state.unknownOutcome = true;
  const response = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { cookie: alice.cookie, "X-CSRF-Token": alice.csrf },
    body: JSON.stringify({ symbol: "EURUSD", side: "BUY", quantity: "0.1", stop_loss_price: "1.09", take_profit_price: "1.11" }),
  });
  assert.deepEqual([response.status, await response.json()], [409, { detail: "IDEMPOTENCY_OUTCOME_UNKNOWN" }]);
  assert.equal(fake.state.calls.filter((c) => c.endsWith("/orders")).length, 1);
});

test("a write without the CSRF token is refused before Adona is called", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  const response = await fetch(`${base}/api/orders`, {
    method: "POST", headers: { cookie: alice.cookie }, body: JSON.stringify({ symbol: "EURUSD" }),
  });
  assert.equal(response.status, 403);
  assert.equal(fake.state.orders.length, 0);
});

test("the server acts for the signed-in trader, whatever the browser sends", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { cookie: alice.cookie, "X-CSRF-Token": alice.csrf },
    body: JSON.stringify({ trader_id: "t-bob", symbol: "EURUSD", side: "BUY", quantity: "0.1", stop_loss_price: "1.09", take_profit_price: "1.11" }),
  });
  assert.deepEqual(fake.state.orders.map((o) => o.trader), ["t-alice"]);
});

test("nothing is served without a session", async (t) => {
  const { base } = await world(t);
  for (const path of ["/api/positions", "/api/data-token", "/api/stream"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, path);
  }
});

test("the demo sign-in refuses to serve anything but this machine", () => {
  assert.throws(() => assertLocalOnly("0.0.0.0"));
  assert.throws(() => assertLocalOnly("10.0.0.5"));
  assert.doesNotThrow(() => assertLocalOnly("127.0.0.1"));
});
