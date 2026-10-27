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
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Adona, AdonaError } from "./adona.mjs";
import { demoUsers, assertLocalOnly } from "./demo-login.mjs";

const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

// A refusal from Adona goes to the browser as its code (and `Retry-After`): the page says
// what to do. Anything else is ours, and says nothing of why.
function refuse(res, error) {
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
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function cookie(req, name) {
  const found = (req.headers.cookie ?? "").split(/;\s*/).find((part) => part.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : null;
}

function same(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp({ adona, users, pollMs = 2000 }) {
  // sid -> { user, traderId, csrf }. In memory for the example; yours lives where your
  // sessions live.
  const sessions = new Map();
  // traderId -> { clients: Set<res>, seen: Set<event_id>, timer }. One poll per CONNECTED
  // trader, relayed to that trader's own pages and nobody else's.
  const feeds = new Map();

  function sessionOf(req) {
    const sid = cookie(req, "sid");
    return sid ? sessions.get(sid) ?? null : null;
  }

  // The writes need the CSRF token the page read from /api/session, in a header a form on
  // another site cannot set. The session cookie is SameSite=Strict too.
  function csrfOk(req, session) {
    return same(req.headers["x-csrf-token"], session.csrf);
  }

  // Your trader's executions, polled by cursor and relayed to THEIR open pages.
  // Replaced by the prop socket (D3) when it exists: Adona will then push them.
  async function poll(traderId) {
    const feed = feeds.get(traderId);
    if (!feed) return;
    try {
      const { executions } = await adona.executions(traderId, { limit: 50 });
      const fresh = executions.filter((e) => !feed.seen.has(e.event_id)).reverse(); // oldest first
      for (const execution of fresh) {
        feed.seen.add(execution.event_id);
        if (!feed.primed) continue; // the first read is history, not news
        for (const client of feed.clients) client.write(`event: execution\ndata: ${JSON.stringify(execution)}\n\n`);
      }
      feed.primed = true;
    } catch (error) {
      console.error(`executions of ${traderId}:`, error.code ?? error.message);
    }
  }

  function follow(traderId, res) {
    let feed = feeds.get(traderId);
    if (!feed) {
      feed = { clients: new Set(), seen: new Set(), primed: false, timer: null };
      feeds.set(traderId, feed);
      feed.timer = setInterval(() => poll(traderId), pollMs);
      poll(traderId);
    }
    feed.clients.add(res);
    res.on("close", () => {
      feed.clients.delete(res);
      if (feed.clients.size === 0) {
        clearInterval(feed.timer);
        feeds.delete(traderId);
      }
    });
  }

  async function api(req, res, url) {
    const path = url.pathname;

    if (req.method === "POST" && path === "/api/login") {
      const { username } = await body(req);
      const externalRef = users.get(String(username ?? ""));
      if (!externalRef) return send(res, 401, { detail: "UNKNOWN_USER" });
      const trader = await adona.traderByRef(externalRef);
      if (!trader) return send(res, 404, { detail: "NOT_A_TRADER_OF_YOURS" });
      const sid = randomBytes(32).toString("base64url");
      sessions.set(sid, { user: username, traderId: trader.trader_id, csrf: randomBytes(32).toString("base64url") });
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
      if (path === "/api/orders") {
        const o = await body(req);
        // Passed on as asked: Adona judges the order (SL and TP, the rules, the 2 %).
        const order = {
          symbol: o.symbol, side: o.side, quantity: o.quantity, order_kind: o.order_kind ?? "MARKET",
          stop_loss_price: o.stop_loss_price, take_profit_price: o.take_profit_price,
          ...(o.entry_price ? { entry_price: o.entry_price } : {}),
        };
        // A NEW key for this order. `placeOnce` reuses it on every retry of THIS order.
        return send(res, 200, await adona.openOrder(trader, order, randomUUID()));
      }
      let match = path.match(/^\/api\/positions\/([A-Za-z0-9:._-]{1,128})\/close$/);
      if (match) return send(res, 200, await adona.closePosition(trader, match[1], randomUUID()));
      match = path.match(/^\/api\/orders\/([A-Za-z0-9:._-]{1,128})\/cancel$/);
      if (match) return send(res, 200, await adona.cancelOrder(trader, match[1], randomUUID()));
    }
    return send(res, 404, { detail: "Not Found" });
  }

  async function serveStatic(res, path) {
    const file = path === "/" ? "index.html" : path.slice(1);
    if (!/^[a-z-]+\.(html|js|css)$/.test(file)) return send(res, 404, { detail: "Not Found" });
    try {
      const content = await readFile(join(PUBLIC, file));
      res.writeHead(200, { "Content-Type": TYPES[extname(file)], "Cache-Control": "no-store" });
      res.end(content);
    } catch {
      send(res, 404, { detail: "Not Found" });
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
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
