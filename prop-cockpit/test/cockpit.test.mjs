// The example's own tests, against a FAKE Adona Robot on this machine: no key, no network.
//
//   node --test
//
// What they hold: each trader sees only their own executions; an order sent twice over a
// network that hesitates is placed once; the writes need the CSRF token; the server acts
// for the signed-in trader whatever the browser sends; the demo sign-in stays local; the
// browser never receives a key or a token, a data token included.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { randomUUID } from "node:crypto";

import { Adona } from "../adona.mjs";
import { createApp } from "../server.mjs";
import { assertLocalOnly } from "../demo-login.mjs";
import { checklist } from "../check/checklist.mjs";

// --- a fake Adona ------------------------------------------------------------------------

function fakeAdona() {
  const state = {
    traders: { "ref-alice": "t-alice", "ref-bob": "t-bob" },
    executions: { "t-alice": [], "t-bob": [] },
    // The open positions, and what a read lists: Adona lists a position a moment after its
    // confirmation is pushed, and keeps listing a closed one a moment too. Here: one read late.
    positions: { "t-alice": [], "t-bob": [] },
    listed: {},
    onPlaced: null, // what the test does once an order or a close is placed
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
    if (url.pathname === "/v1/prop/tokens") {
      state.propTokens = (state.propTokens ?? 0) + 1; // the first is "prop-token", then "prop-token-2"...
      return json(200, { access_token: state.propTokens === 1 ? "prop-token" : `prop-token-${state.propTokens}`, expires_in: 43200 });
    }
    if (url.pathname === "/v1/tokens") return json(200, { access_token: `data-${JSON.parse(raw).end_user_id}`, expires_in: 43200 });
    if (url.pathname === "/v1/ws-ticket") return json(200, { ticket: `ticket-${state.tickets = (state.tickets ?? 0) + 1}` });
    if (url.pathname === "/v1/prop/traders") {
      const id = state.traders[url.searchParams.get("external_ref")];
      return json(200, { traders: id ? [{ trader_id: id }] : [] });
    }
    let m = url.pathname.match(/^\/v1\/prop\/traders\/([^/]+)\/(executions|positions|pending-orders|tradable-symbols)$/);
    if (m) {
      const [, trader, what] = m;
      if (what === "executions") {
        // Newest first, by cursor towards older, as Adona pages them.
        const all = [...state.executions[trader]].reverse();
        const from = Number(url.searchParams.get("cursor") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const page = all.slice(from, from + limit);
        return json(200, { executions: page, ...(from + limit < all.length ? { next_cursor: String(from + limit) } : {}) });
      }
      if (what === "positions") {
        const shown = state.listed[trader] ?? [];
        state.listed[trader] = [...state.positions[trader]];
        return json(200, { positions: shown });
      }
      if (what === "pending-orders") return json(200, { orders: [] });
      return json(200, { symbols: ["EURUSD", "XAUUSD"] });
    }
    m = url.pathname.match(/^\/v1\/prop\/traders\/([^/]+)\/executable-price$/);
    if (m) {
      const [side, intent] = [url.searchParams.get("side"), url.searchParams.get("intent")];
      return json(200, { symbol: url.searchParams.get("symbol"), side, intent, price: "1.10000", as_of: new Date().toISOString(), market_open: true });
    }
    m = url.pathname.match(/^\/v1\/prop\/traders\/([^/]+)\/positions\/([^/]+)\/(close|reduce)$/);
    if (m && req.method === "POST") {
      state.orders.push({ trader: m[1], key: req.headers["idempotency-key"], position: m[2], kind: m[3], body: raw ? JSON.parse(raw) : {} });
      state.onPlaced?.(state.orders.at(-1));
      return json(200, { ingress_status: "PUBLISHED", event_id: `ev-${state.orders.length}` });
    }
    m = url.pathname.match(/^\/v1\/prop\/traders\/([^/]+)\/orders$/);
    if (m && req.method === "POST") {
      const key = req.headers["idempotency-key"];
      if (!key) return json(400, { detail: "IDEMPOTENCY_KEY_REQUIRED" });
      if (!JSON.parse(raw).stop_loss_price) return json(409, { detail: "STOP_LOSS_REQUIRED" });
      if (state.unknownOutcome) return json(409, { detail: "IDEMPOTENCY_OUTCOME_UNKNOWN" });
      if (state.inProgress) {
        // The first attempt is placed and still running; every retry hears IN_PROGRESS.
        if (!state.byKey.has(key)) { state.orders.push({ trader: m[1], key, body: JSON.parse(raw) }); state.byKey.set(key, { ingress_status: "PUBLISHED", event_id: "ev-slow" }); }
        res.writeHead(409, { "Content-Type": "application/json", "Retry-After": "0" });
        return res.end(JSON.stringify({ detail: "IDEMPOTENCY_KEY_IN_PROGRESS" }));
      }
      if (!state.byKey.has(key)) {
        const ack = { ingress_status: "PUBLISHED", event_id: `ev-${state.orders.length + 1}` };
        state.orders.push({ trader: m[1], key, body: JSON.parse(raw) });
        state.byKey.set(key, ack);
        state.onPlaced?.(state.orders.at(-1));
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

// A fake WebSocket, driven by the test: the sockets the server opens to Adona, both the
// prop stream and the price stream, without a network.
function fakeSockets() {
  const opened = [];
  class FakeSocket {
    constructor(url, options) {
      this.url = String(url);
      this.options = options;
      this.sent = [];
      this.readyState = 0;
      opened.push(this);
      setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
    }
    send(message) { this.sent.push(JSON.parse(message)); }
    close(code = 1000, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
    // The test's side: a frame from Adona, or Adona closing.
    push(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
    drop(code, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
  }
  const prop = () => opened.filter((s) => s.url.includes("/v1/prop/stream")).at(-1);
  const prices = () => opened.filter((s) => s.url.endsWith("/v1/stream")).at(-1);
  return { FakeSocket, opened, prop, prices };
}

async function world(t, { dataKey = "data-key-for-tests" } = {}) {
  const fake = fakeAdona();
  const api = await listen(fake.server);
  fake.sockets = fakeSockets();
  const adona = new Adona({ api, tenantKey: "tenant-key-for-tests", dataKey, timeoutMs: 2000, webSocketImpl: fake.sockets.FakeSocket });
  const app = createApp({ adona, users: new Map([["alice", "ref-alice"], ["bob", "ref-bob"]]) });
  const base = await listen(app);
  t.after(() => { app.closeAllConnections(); app.close(); fake.server.closeAllConnections(); fake.server.close(); });
  return { fake, base };
}

async function signIn(base, username) {
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ username }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const { csrf } = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
  return { cookie, csrf };
}

// Reads Server-Sent Events into `received` (`{ event, ...data }`) until aborted.
function listenStream(base, cookie, received, signal, symbol) {
  const path = symbol ? `/api/stream?symbol=${symbol}` : "/api/stream";
  return fetch(`${base}${path}`, { headers: { cookie }, signal }).then(async (response) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = block.split("\n").find((line) => line.startsWith("event: "));
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) received.push({ event: event?.slice(7), ...JSON.parse(data.slice(6)) });
      }
    }
  }).catch(() => {});
}

const JSON_TYPE = { "Content-Type": "application/json" };
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const executions = (received) => received.filter((e) => e.event === "execution").map((e) => e.event_id);
const frame = (trader, id, cursor = id) => ({ type: "execution", cursor, trader_id: trader, execution: { event_id: id, status: "FILLED" } });

const ORDER = { symbol: "EURUSD", side: "BUY", quantity: "0.1", stop_loss_price: "1.09", take_profit_price: "1.11" };

function placeFromPage(base, who, key, body = ORDER) {
  return fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { ...JSON_TYPE, cookie: who.cookie, "X-CSRF-Token": who.csrf, ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify(body),
  });
}

// A raw request, to set what `fetch` will not let a page set (Host, forwarding headers).
function raw(base, path, headers) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    request({ hostname, port, path, headers }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject).end();
  });
}

// --- the tests ---------------------------------------------------------------------------

test("each trader receives their own executions, and only theirs", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  const bob = await signIn(base, "bob");
  const stop = new AbortController();
  const toAlice = [], toBob = [];
  listenStream(base, alice.cookie, toAlice, stop.signal);
  listenStream(base, bob.cookie, toBob, stop.signal);
  await settle(100);
  const prop = fake.sockets.prop();
  assert.equal(prop.options.headers.Authorization, "Bearer prop-token", "the prop token travels from the server");
  prop.push({ type: "ready" });
  prop.push(frame("t-alice", "a-1"));
  prop.push(frame("t-bob", "b-1"));
  prop.push(frame("t-alice", "a-2"));
  await settle(100);
  stop.abort();
  assert.deepEqual(executions(toAlice), ["a-1", "a-2"]);
  assert.deepEqual(executions(toBob), ["b-1"]);
  assert.equal(fake.sockets.opened.filter((s) => s.url.includes("/v1/prop/stream")).length, 1, "one socket for every trader");
});

test("a dropped stream resumes after its last frame, and a frame sent again is shown once", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  const stop = new AbortController();
  const received = [];
  listenStream(base, alice.cookie, received, stop.signal);
  await settle(100);
  fake.sockets.prop().push(frame("t-alice", "a-1", "c-1"));
  fake.sockets.prop().drop(1011, "STREAM_UNAVAILABLE");
  await settle(1300); // the first pause before coming back
  const again = fake.sockets.prop();
  assert.equal(new URL(again.url).searchParams.get("after"), "c-1");
  again.push(frame("t-alice", "a-1", "c-1")); // at least once: the replay may repeat it
  again.push(frame("t-alice", "a-2", "c-2"));
  await settle(100);
  stop.abort();
  assert.deepEqual(executions(received), ["a-1", "a-2"]);
});

test("a stream closed with a refusal is not opened again in a loop", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  const stop = new AbortController();
  listenStream(base, alice.cookie, [], stop.signal);
  await settle(100);
  const before = fake.sockets.opened.length;
  fake.sockets.prop().drop(1008, "TENANT_ACCESS_REVOKED");
  await settle(1300);
  stop.abort();
  assert.equal(fake.sockets.opened.length, before, "an answer, not a hiccup");
});

test("a stream closed because its prop token expired comes back on a new token, after its cursor", async (t) => {
  // Adona re-checks the token of an open stream and closes it with 1008 INVALID_JWT
  // when the twelve hours are up: that close is not a refusal to fix by hand.
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  const stop = new AbortController();
  const received = [];
  listenStream(base, alice.cookie, received, stop.signal);
  await settle(100);
  fake.sockets.prop().push(frame("t-alice", "a-1", "c-1"));
  const before = fake.sockets.opened.length;
  fake.sockets.prop().drop(1008, "INVALID_JWT");
  await settle(1300); // the first pause before coming back
  assert.equal(fake.sockets.opened.length, before + 1, "the stream is opened again");
  const again = fake.sockets.prop();
  assert.equal(new URL(again.url).searchParams.get("after"), "c-1");
  assert.equal(again.options.headers.Authorization, "Bearer prop-token-2", "on a new prop token");
  again.push(frame("t-alice", "a-2", "c-2"));
  await settle(100);
  stop.abort();
  assert.deepEqual(executions(received), ["a-1", "a-2"]);
});

test("an order whose answer is lost is sent again with the same key, and placed once", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  fake.state.dropFirstAnswer = true;
  const response = await placeFromPage(base, alice, randomUUID());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).event_id, "ev-1");
  assert.equal(fake.state.orders.length, 1, "one position, not two");
  assert.equal(fake.state.calls.filter((c) => c === "POST /v1/prop/traders/t-alice/orders").length, 2);
});

test("an outcome Adona cannot tell is shown, never sent again", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  fake.state.unknownOutcome = true;
  const response = await placeFromPage(base, alice, randomUUID());
  assert.deepEqual([response.status, await response.json()], [409, { detail: "IDEMPOTENCY_OUTCOME_UNKNOWN" }]);
  assert.equal(fake.state.calls.filter((c) => c.endsWith("/orders")).length, 1);
});

test("a write with a wrong CSRF token is refused before Adona is called", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  const response = await fetch(`${base}/api/orders`, {
    method: "POST", headers: { ...JSON_TYPE, cookie: alice.cookie, "X-CSRF-Token": "a-wrong-token" }, body: JSON.stringify({ symbol: "EURUSD" }),
  });
  assert.equal(response.status, 403);
  assert.equal(fake.state.orders.length, 0);
});

test("the server acts for the signed-in trader, whatever the browser sends", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  await placeFromPage(base, alice, randomUUID(), { ...ORDER, trader_id: "t-bob" });
  assert.deepEqual(fake.state.orders.map((o) => o.trader), ["t-alice"]);
});

test("nothing is served without a session", async (t) => {
  const { base } = await world(t);
  for (const path of ["/api/positions", "/api/stream"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, path);
  }
});

test("the demo sign-in refuses to serve anything but this machine", () => {
  assert.throws(() => assertLocalOnly("0.0.0.0"));
  assert.throws(() => assertLocalOnly("10.0.0.5"));
  assert.doesNotThrow(() => assertLocalOnly("127.0.0.1"));
});

test("an order the page sends again with its key is placed once", async (t) => {
  // The answer between your server and the page is lost (a phone's network, a reload):
  // the page sends the same order again, with the key it made the first time.
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  const key = randomUUID();
  const first = await (await placeFromPage(base, alice, key)).json();
  const again = await (await placeFromPage(base, alice, key)).json();
  assert.deepEqual(again, first);
  assert.equal(fake.state.orders.length, 1, "one position, not two");
  assert.equal(fake.state.orders[0].key, `t-alice:${key}`, "the key is the page's, under the session's trader");
});

test("an order without the page's key is refused before Adona is called", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  for (const key of [undefined, "not-a-uuid", "t-bob:" + randomUUID()]) {
    const response = await placeFromPage(base, alice, key);
    assert.deepEqual([response.status, await response.json()], [400, { detail: "BAD_REQUEST" }], String(key));
  }
  assert.equal(fake.state.orders.length, 0);
});

test("the demo answers this machine only, even behind a proxy or a tunnel on it", async (t) => {
  const { base } = await world(t);
  const { port } = new URL(base);
  assert.equal(await raw(base, "/", { host: `127.0.0.1:${port}` }), 200);
  assert.equal(await raw(base, "/", { host: "demo.example.com" }), 403, "a Host that is not this machine's");
  assert.equal(await raw(base, "/", { host: `127.0.0.1:${port}`, "x-forwarded-for": "203.0.113.7" }), 403);
  assert.equal(await raw(base, "/", { host: `127.0.0.1:${port}`, forwarded: "for=203.0.113.7" }), 403);
});

test("a burst of executions is relayed whole, in order", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  const stop = new AbortController();
  const received = [];
  listenStream(base, alice.cookie, received, stop.signal);
  await settle(100);
  const burst = Array.from({ length: 120 }, (_, i) => `x-${i}`);
  for (const id of burst) fake.sockets.prop().push(frame("t-alice", id));
  await settle(200);
  stop.abort();
  assert.deepEqual(executions(received), burst);
});

test("one price socket serves every page, each its own symbol, and the browser gets no token", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  const bob = await signIn(base, "bob");
  const session = await (await fetch(`${base}/api/session`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(session.live_prices, true);
  assert.equal("data_api" in session, false);
  assert.equal((await fetch(`${base}/api/data-token`, { headers: { cookie: alice.cookie } })).status, 404);
  const stop = new AbortController();
  const toAlice = [], toBob = [];
  listenStream(base, alice.cookie, toAlice, stop.signal, "EURUSD");
  listenStream(base, bob.cookie, toBob, stop.signal, "XAUUSD");
  await settle(150);
  const prices = fake.sockets.prices();
  assert.deepEqual(prices.options, ["adona.data.v1", "ticket.ticket-1"]);
  assert.deepEqual(new Set(prices.sent.flatMap((m) => m.payload.channels)), new Set(["quote:EURUSD", "quote:XAUUSD"]));
  prices.push({ type: "quote.update", payload: { symbol: "EURUSD", bid: "1.1", ask: "1.2", as_of: "t" } });
  prices.push({ type: "quote.update", payload: { symbol: "XAUUSD", bid: "2.1", ask: "2.2", as_of: "t" } });
  await settle(100);
  stop.abort();
  assert.deepEqual(toAlice.filter((e) => e.event === "quote").map((e) => e.symbol), ["EURUSD"]);
  assert.deepEqual(toBob.filter((e) => e.event === "quote").map((e) => e.symbol), ["XAUUSD"]);
  assert.equal(fake.sockets.opened.filter((s) => s.url.endsWith("/v1/stream")).length, 1);
  assert.deepEqual(fake.state.calls.filter((c) => c === "POST /v1/tokens"), ["POST /v1/tokens"], "one data token, the server's");
});

test("a page cannot make the server follow a symbol that is not its trader's", async (t) => {
  const { base } = await world(t);
  const alice = await signIn(base, "alice");
  // Bounded: a server that followed it would answer with a stream that never ends.
  const response = await fetch(`${base}/api/stream?symbol=GBPUSD`, { headers: { cookie: alice.cookie }, signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { detail: "BAD_REQUEST" });
});

test("without a data key, no price socket: the page shows the last known prices", async (t) => {
  const { fake, base } = await world(t, { dataKey: "" });
  const alice = await signIn(base, "alice");
  const session = await (await fetch(`${base}/api/session`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(session.live_prices, false);
  const stop = new AbortController();
  listenStream(base, alice.cookie, [], stop.signal, "EURUSD");
  await settle(100);
  stop.abort();
  assert.equal(fake.sockets.prices(), undefined);
});

test("a position is closed and reduced by its opaque id, as long as Adona makes it", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  const id = `pos_${"A".repeat(200)}`; // sealed ids run up to 220 characters
  const headers = (key) => ({ ...JSON_TYPE, cookie: alice.cookie, "X-CSRF-Token": alice.csrf, "Idempotency-Key": key });
  const closed = await fetch(`${base}/api/positions/${id}/close`, { method: "POST", headers: headers(randomUUID()), body: "{}" });
  assert.equal(closed.status, 200);
  const reduced = await fetch(`${base}/api/positions/${id}/reduce`, {
    method: "POST", headers: headers(randomUUID()), body: JSON.stringify({ symbol: "EURUSD", quantity: "0.05" }),
  });
  assert.equal(reduced.status, 200);
  assert.deepEqual(fake.state.orders.map((o) => [o.kind, o.position, o.body]), [["close", id, {}], ["reduce", id, { symbol: "EURUSD", quantity: "0.05" }]]);
  const notOurs = await fetch(`${base}/api/positions/ev-123/close`, { method: "POST", headers: headers(randomUUID()), body: "{}" });
  assert.equal(notOurs.status, 404, "not an id Adona gives");
});

test("every answer forbids framing and sniffing", async (t) => {
  const { base } = await world(t);
  for (const path of ["/", "/app.js", "/api/positions"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'", path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
  }
});

test("a write from another site is refused, the sign-in too", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  const asForm = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"username":"bob"}' });
  assert.equal(asForm.status, 403, "a form on another site posts text/plain");
  const elsewhere = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { ...JSON_TYPE, cookie: alice.cookie, "X-CSRF-Token": alice.csrf, "Idempotency-Key": randomUUID(), origin: "http://evil.example" },
    body: JSON.stringify(ORDER),
  });
  assert.equal(elsewhere.status, 403);
  assert.equal(fake.state.orders.length, 0);
});

test("a sign-out ends the session", async (t) => {
  const { base } = await world(t);
  const alice = await signIn(base, "alice");
  const out = await fetch(`${base}/api/logout`, { method: "POST", headers: { ...JSON_TYPE, cookie: alice.cookie, "X-CSRF-Token": alice.csrf } });
  assert.equal(out.status, 200);
  assert.equal((await fetch(`${base}/api/positions`, { headers: { cookie: alice.cookie } })).status, 401);
});

test("an order still in progress after every retry is never placed twice", async (t) => {
  const { fake, base } = await world(t);
  const alice = await signIn(base, "alice");
  fake.state.inProgress = true;
  const key = randomUUID();
  const first = await placeFromPage(base, alice, key);
  assert.equal(first.status, 409);
  assert.equal((await first.json()).detail, "IDEMPOTENCY_KEY_IN_PROGRESS");
  fake.state.inProgress = false;
  await placeFromPage(base, alice, key); // the page sends it again, same key
  assert.equal(fake.state.orders.length, 1);
});

test("the checklist waits for Adona to list the opening's position, then to drop it after the close", async (t) => {
  const fake = fakeAdona();
  const api = await listen(fake.server);
  fake.sockets = fakeSockets();
  t.after(() => { fake.server.closeAllConnections(); fake.server.close(); });
  const adona = new Adona({ api, tenantKey: "tenant-key-for-tests", timeoutMs: 2000, webSocketImpl: fake.sockets.FakeSocket });
  // Adona confirms on the stream first; the list follows (one read late, in this fake).
  let fills = 0;
  fake.state.onPlaced = ({ trader, kind, body }) => setTimeout(() => {
    fills += 1;
    if (kind === "close") fake.state.positions[trader] = [];
    else fake.state.positions[trader] = [{ position_id: "pos_AAAAAAAAAAAAAAAAAAAAAAAA", symbol: body.symbol, side: body.side }];
    fake.sockets.prop().push({
      type: "execution", cursor: String(fills), trader_id: trader,
      execution: { event_id: `ev-fill-${fills}`, status: "FILLED", ...(kind === "close" ? { trigger_reason: "MANUAL" } : {}) },
    });
  }, 10);
  const said = [];
  await checklist({ adona, refA: "ref-alice", refB: "ref-bob", waitMs: 3000, log: (line) => said.push(line) });
  assert.equal(said.at(-1), "all checks passed");
  assert.deepEqual(fake.state.orders.map((o) => o.kind ?? "open"), ["open", "close"]);
});
