// Your server: the one place that holds your keys and speaks to Adona Robot for your traders.
//
//   node server.mjs        (Node 22+, no dependency; configuration in .env.example)
//
// What the browser gets from it, and nothing more:
//   POST /api/login                  the DEMO sign-in (replace it with yours: see demo-login.mjs)
//   GET  /api/session                who is signed in, and the CSRF token for the writes
//   GET  /api/data-token             a twelve-hour data token for THIS trader (live prices)
//   GET  /api/symbols | /api/positions | /api/pending-orders | /api/executions
//   GET  /api/price?symbol&side&intent   the executable price, indicative
//   POST /api/orders                 open an order (SL and TP required: Adona refuses without)
//   POST /api/positions/:id/close    close a position
//   POST /api/orders/:id/cancel      cancel a resting order
//   GET  /api/stream                 Server-Sent Events: THIS trader's executions as they come
//
// Every /api route acts for the trader of the session, never for an id the browser sends.

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Adona, AdonaError } from "./adona.mjs";
import { demoUsers, assertLocalOnly, isLocalRequest } from "./demo-login.mjs";

const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

// On every answer: no other site may frame the order buttons, nor reinterpret a file.
const SAFE = { "Content-Security-Policy": "frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" };
// The key the page sends for one order: a UUID, prefixed here by the session's trader.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class BadRequest extends Error {}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...SAFE, ...headers });
  res.end(JSON.stringify(body));
}

// A refusal from Adona goes to the browser as its code (and `Retry-After`): the page says
// what to do. Anything else is ours, and says nothing of why.
function refuse(res, error) {
  if (error instanceof BadRequest) return send(res, 400, { detail: "BAD_REQUEST" });
  if (error instanceof AdonaError) {
    // 401: YOUR key or token was refused. That is yours to fix, not the trader's.
    if (error.status === 401) {
      console.error(`Adona refused our credentials: ${error.code}`);
      return send(res, 502, { detail: "UPSTREAM_UNAVAILABLE" });
    }
    const headers = error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {};
    return send(res, error.status >= 500 ? 503 : error.status, { detail: error.code }, headers);
  }
  console.error(error);
  return send(res, 502, { detail: "UPSTREAM_UNAVAILABLE" });
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new BadRequest("body too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new BadRequest("not JSON");
  }
}

function cookie(req, name) {
  const found = (req.headers.cookie ?? "").split(/;\s*/).find((part) => part.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : null;
}

function same(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

// The key of one order comes from the PAGE, made when the trader first sends it and kept
// until a final answer: the link between a trader's browser and your server hesitates
// too (a phone's network, a reload), and a key made here per request would make a click
// sent again a second order. Prefixed by the session's trader: nobody aims at another's.
function orderKey(req, traderId) {
  const key = req.headers["idempotency-key"];
  if (!UUID.test(String(key ?? ""))) throw new BadRequest("Idempotency-Key: a UUID from the page");
  return `${traderId}:${key}`;
}

// A write must come from this page: JSON (a form on another site cannot send it without a
// preflight), and, when the browser says where it comes from, from this very origin.
function sameOrigin(req) {
  const type = String(req.headers["content-type"] ?? "");
  const origin = req.headers.origin;
  return type.startsWith("application/json") && (!origin || origin === `http://${req.headers.host}`);
}

const SESSION_MS = 8 * 3600 * 1000;

export function createApp({ adona, users, pollMs = 2000, localOnly = true }) {
  // sid -> { user, traderId, csrf, until }. In memory, eight hours, for the example; yours
  // lives where your sessions live, with `Secure` cookies once served over HTTPS.
  const sessions = new Map();
  // traderId -> { clients: Set<res>, seen: Set<event_id>, timer }. One poll per CONNECTED
  // trader, relayed to that trader's own pages and nobody else's.
  const feeds = new Map();

  function sessionOf(req) {
    const sid = cookie(req, "sid");
    const session = sid ? sessions.get(sid) : null;
    if (!session) return null;
    if (Date.now() > session.until) {
      sessions.delete(sid);
      return null;
    }
    return session;
  }

  // The writes need the CSRF token the page read from /api/session, in a header a form on
  // another site cannot set. The session cookie is SameSite=Strict too.
  function csrfOk(req, session) {
    return same(req.headers["x-csrf-token"], session.csrf);
  }

  // Your trader's executions, polled by cursor and relayed to THEIR open pages.
  // Polled: one read per connected trader every `pollMs`.
  async function poll(traderId) {
    const feed = feeds.get(traderId);
    if (!feed) return;
    try {
      // Newest first: read pages back to the last one already relayed (at most a few).
      const fresh = [];
      let cursor;
      for (let page = 0; page < 5; page += 1) {
        const { executions, next_cursor } = await adona.executions(traderId, { limit: 50, cursor });
        const unseen = executions.filter((e) => !feed.seen.has(e.event_id));
        fresh.push(...unseen);
        if (!feed.primed || unseen.length < executions.length || !next_cursor) break;
        cursor = next_cursor;
      }
      for (const execution of fresh.reverse()) { // oldest first
        remember(feed, execution.event_id);
        if (!feed.primed) continue; // the first read is history, not news
        for (const client of feed.clients) client.write(`event: execution\ndata: ${JSON.stringify(execution)}\n\n`);
      }
      feed.primed = true;
    } catch (error) {
      console.error(`executions of ${traderId}:`, error.code ?? error.message);
    }
  }

  // What a feed has relayed, the last 500 ids: enough to recognise a page, and bounded.
  function remember(feed, id) {
    feed.seen.add(id);
    if (feed.seen.size > 500) feed.seen.delete(feed.seen.values().next().value);
  }

  function follow(traderId, res) {
    let feed = feeds.get(traderId);
    if (!feed) {
      feed = { clients: new Set(), seen: new Set(), primed: false, timer: null };
      feeds.set(traderId, feed);
      // One read at a time: the next is scheduled once this one is done, so a slow answer
      // never piles reads up.
      const tick = async () => {
        await poll(traderId);
        if (feeds.get(traderId) === feed) feed.timer = setTimeout(tick, pollMs);
      };
      tick();
    }
    feed.clients.add(res);
    res.on("close", () => {
      feed.clients.delete(res);
      if (feed.clients.size === 0) {
        clearTimeout(feed.timer);
        feeds.delete(traderId);
      }
    });
  }

  async function api(req, res, url) {
    const path = url.pathname;

    if (req.method === "POST" && !sameOrigin(req)) return send(res, 403, { detail: "CROSS_SITE" });

    if (req.method === "POST" && path === "/api/login") {
      const { username } = await body(req);
      const externalRef = users.get(String(username ?? ""));
      if (!externalRef) return send(res, 401, { detail: "UNKNOWN_USER" });
      const trader = await adona.traderByRef(externalRef);
      if (!trader) return send(res, 404, { detail: "NOT_A_TRADER_OF_YOURS" });
      const previous = cookie(req, "sid");
      if (previous) sessions.delete(previous); // a new sign-in ends the old session
      const sid = randomBytes(32).toString("base64url");
      sessions.set(sid, {
        user: username, traderId: trader.trader_id, csrf: randomBytes(32).toString("base64url"),
        until: Date.now() + SESSION_MS,
      });
      return send(res, 200, { ok: true }, {
        "Set-Cookie": `sid=${sid}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }

    const session = sessionOf(req);
    if (!session) return send(res, 401, { detail: "SIGN_IN" });
    const trader = session.traderId;

    if (req.method === "GET") {
      switch (path) {
        // The data API's address too: the page opens the live prices there itself.
        case "/api/session": return send(res, 200, { user: session.user, csrf: session.csrf, data_api: adona.api });
        case "/api/data-token": return send(res, 200, { token: await adona.dataToken(trader) });
        case "/api/symbols": return send(res, 200, await adona.tradableSymbols(trader));
        case "/api/positions": return send(res, 200, await adona.positions(trader));
        case "/api/pending-orders": return send(res, 200, await adona.pendingOrders(trader));
        case "/api/executions": return send(res, 200, await adona.executions(trader, { cursor: url.searchParams.get("cursor") ?? undefined }));
        case "/api/price": {
          const q = url.searchParams;
          return send(res, 200, await adona.executablePrice(trader, { symbol: q.get("symbol"), side: q.get("side"), intent: q.get("intent") }));
        }
        case "/api/stream":
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
          res.write(": connected\n\n");
          return follow(trader, res);
      }
    }

    if (req.method === "POST") {
      if (!csrfOk(req, session)) return send(res, 403, { detail: "CSRF" });
      if (path === "/api/logout") {
        sessions.delete(cookie(req, "sid"));
        return send(res, 200, { ok: true }, { "Set-Cookie": "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
      }
      if (path === "/api/orders") {
        const o = await body(req);
        // Passed on as asked: Adona judges the order (stop loss, take profit, the account's rules).
        const order = {
          symbol: o.symbol, side: o.side, quantity: o.quantity, order_kind: o.order_kind ?? "MARKET",
          stop_loss_price: o.stop_loss_price, take_profit_price: o.take_profit_price,
          ...(o.entry_price ? { entry_price: o.entry_price } : {}),
        };
        // A NEW key for this order. `placeOnce` reuses it on every retry of THIS order.
        // The page's key for THIS order: the same on every resend, from the page or from here.
        return send(res, 200, await adona.openOrder(trader, order, orderKey(req, trader)));
      }
      let match = path.match(/^\/api\/positions\/([A-Za-z0-9:._-]{1,128})\/close$/);
      if (match) return send(res, 200, await adona.closePosition(trader, match[1], orderKey(req, trader)));
      match = path.match(/^\/api\/orders\/([A-Za-z0-9:._-]{1,128})\/cancel$/);
      if (match) return send(res, 200, await adona.cancelOrder(trader, match[1], orderKey(req, trader)));
    }
    return send(res, 404, { detail: "Not Found" });
  }

  async function serveStatic(res, path) {
    const file = path === "/" ? "index.html" : path.slice(1);
    if (!/^[a-z-]+\.(html|js|css)$/.test(file)) return send(res, 404, { detail: "Not Found" });
    try {
      const content = await readFile(join(PUBLIC, file));
      res.writeHead(200, { "Content-Type": TYPES[extname(file)], "Cache-Control": "no-store", ...SAFE });
      res.end(content);
    } catch {
      send(res, 404, { detail: "Not Found" });
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (localOnly && !isLocalRequest(req)) return send(res, 403, { detail: "DEMO_SIGN_IN_IS_LOCAL_ONLY" });
    try {
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else await serveStatic(res, url.pathname);
    } catch (error) {
      if (!res.headersSent) refuse(res, error);
      else res.end();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8080);
  assertLocalOnly(host);
  const adona = new Adona({
    api: process.env.ADONA_API ?? "https://api.adona-robot.com",
    tenantKey: process.env.ADONA_TENANT_KEY,
    dataKey: process.env.ADONA_DATA_KEY,
  });
  createApp({ adona, users: demoUsers(process.env.DEMO_USERS) }).listen(port, host, () => {
    console.log(`prop cockpit on http://${host}:${port} (DEMO sign-in: local only)`);
  });
}
