// Your server: the one place that holds your keys and speaks to Adona Robot for your traders.
//
//   node server.mjs        (Node 22+, no dependency; configuration in .env.example)
//
// What the browser gets from it, and nothing more:
//   POST /api/login                  the DEMO sign-in (replace it with yours: see demo-login.mjs)
//   GET  /api/session                who is signed in, and the CSRF token for the writes
//   GET  /api/symbols | /api/positions | /api/pending-orders | /api/executions
//   GET  /api/price?symbol&side&intent   the executable price, indicative
//   POST /api/orders                 open an order (SL and TP required: Adona refuses without)
//   POST /api/positions/:id/reduce   take lots off a position
//   POST /api/positions/:id/close    close a position
//   POST /api/orders/:id/cancel      cancel a resting order
//   GET  /api/stream?symbol=EURUSD   Server-Sent Events: THIS trader's executions as they
//                                    come, and the live price of the symbol on screen
//
// No key and no token ever reach the browser, a data token included: this server holds
// ONE socket for every trader's confirmations and ONE for live prices (feeds.mjs).
//
// Every /api route acts for the trader of the session, never for an id the browser sends.

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Adona, AdonaError } from "./adona.mjs";
import { ExecutionsFeed, Pages, PriceFeed } from "./feeds.mjs";
import { demoUsers, assertLocalOnly, isLocalRequest } from "./demo-login.mjs";

const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

// On every answer: no other site may frame the order buttons, nor reinterpret a file.
const SAFE = { "Content-Security-Policy": "frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" };
// The key the page sends for one order: a UUID, prefixed here by the session's trader.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A position's or an order's id, as Adona gives it: opaque, `pos_` or `ord_` and up to 220
// characters. Passed back as it is, never read.
const POSITION_ID = "pos_[A-Za-z0-9_-]{22,216}";
const ORDER_ID = "ord_[A-Za-z0-9_-]{22,216}";
const SYMBOL = /^[A-Z0-9._-]{1,32}$/;

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
// Served at a public address (HTTPS, your own sign-in), set PUBLIC_ORIGIN to it.
function sameOrigin(req, publicOrigin) {
  const type = String(req.headers["content-type"] ?? "");
  const origin = req.headers.origin;
  return type.startsWith("application/json") && (!origin || origin === (publicOrigin ?? `http://${req.headers.host}`));
}

const SESSION_MS = 8 * 3600 * 1000;

export function createApp({ adona, users, localOnly = true, publicOrigin }) {
  // sid -> { user, traderId, csrf, until, symbols }. In memory, eight hours, for the
  // example; yours lives where your sessions live, with `Secure` cookies over HTTPS.
  const sessions = new Map();
  const pages = new Pages();
  const executionsFeed = new ExecutionsFeed({ adona, pages });
  const priceFeed = new PriceFeed({ adona, pages });
  let started = false;

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

  // The trader's own symbols, read once per session: a page may watch those and no other,
  // so nobody makes this server follow a symbol for nothing.
  async function symbolsOf(session) {
    session.symbols ??= new Set((await adona.tradableSymbols(session.traderId)).symbols);
    return session.symbols;
  }

  // One page's stream: this trader's confirmations, and the live price of ITS symbol.
  async function follow(req, res, session, symbol) {
    if (symbol && !(SYMBOL.test(symbol) && (await symbolsOf(session)).has(symbol))) {
      return send(res, 400, { detail: "BAD_REQUEST" });
    }
    if (!started) {
      started = true;
      executionsFeed.start();
      priceFeed.start();
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", ...SAFE });
    res.write(": connected\n\n");
    const page = {
      traderId: session.traderId,
      symbol: priceFeed.enabled ? symbol : null,
      send: (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    };
    pages.add(page);
    priceFeed.sync();
    if (!priceFeed.live) page.send("quote-stale", {});
    req.on("close", () => {
      pages.delete(page);
      priceFeed.sync();
    });
  }

  async function api(req, res, url) {
    const path = url.pathname;

    if (req.method === "POST" && !sameOrigin(req, publicOrigin)) return send(res, 403, { detail: "CROSS_SITE" });

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
        case "/api/session": return send(res, 200, { user: session.user, csrf: session.csrf, live_prices: priceFeed.enabled });
        case "/api/symbols": return send(res, 200, await adona.tradableSymbols(trader));
        case "/api/positions": return send(res, 200, await adona.positions(trader));
        case "/api/pending-orders": return send(res, 200, await adona.pendingOrders(trader));
        case "/api/executions": return send(res, 200, await adona.executions(trader, { cursor: url.searchParams.get("cursor") ?? undefined }));
        case "/api/price": {
          const q = url.searchParams;
          return send(res, 200, await adona.executablePrice(trader, { symbol: q.get("symbol"), side: q.get("side"), intent: q.get("intent") }));
        }
        case "/api/stream": return follow(req, res, session, url.searchParams.get("symbol"));
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
        // The page's key for THIS order: the same on every resend, from the page or from here.
        return send(res, 200, await adona.openOrder(trader, order, orderKey(req, trader)));
      }
      let match = path.match(new RegExp(`^/api/positions/(${POSITION_ID})/close$`));
      if (match) return send(res, 200, await adona.closePosition(trader, match[1], orderKey(req, trader)));
      match = path.match(new RegExp(`^/api/positions/(${POSITION_ID})/reduce$`));
      if (match) {
        const { symbol, quantity } = await body(req);
        return send(res, 200, await adona.reducePosition(trader, match[1], { symbol, quantity }, orderKey(req, trader)));
      }
      match = path.match(new RegExp(`^/api/orders/(${ORDER_ID})/cancel$`));
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

  const server = createServer(async (req, res) => {
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
  server.on("close", () => { executionsFeed.stop(); priceFeed.stop(); });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8080);
  assertLocalOnly(host);
  const adona = new Adona({
    api: process.env.ADONA_API ?? "https://api.adona-robot.com",
    tenantKey: process.env.ADONA_TENANT_KEY,
    dataKey: process.env.ADONA_DATA_KEY || undefined,
  });
  createApp({ adona, users: demoUsers(process.env.DEMO_USERS), publicOrigin: process.env.PUBLIC_ORIGIN || undefined }).listen(port, host, () => {
    console.log(`prop cockpit on http://${host}:${port} (DEMO sign-in: local only)`);
  });
}
