// The two sockets your server keeps to Adona Robot, each ONE for the whole server, and
// what it relays from them to your traders' pages (Server-Sent Events, /api/stream).
//
// - ExecutionsFeed: `WS /v1/prop/stream`, every trader's confirmations. A frame goes to
//   the pages of ITS trader (`trader_id`), never anyone else's.
// - PriceFeed: `WS /v1/stream`, live prices for the symbols your pages show. Optional:
//   without a data key, bring your own prices.
//
// Both come back on their own after a drop, and both say on the page when they are not
// live. A close with a code that is an answer (1008: a key revoked, a tenant suspended)
// is never retried in a loop: it is logged for you to fix. One 1008 is not: INVALID_JWT
// on the confirmations stream is its twelve-hour token running out.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ANSWER = 1008; // a refusal: retrying changes nothing
const LATER = 1013; // "later": a limit, wait longer before coming back

// The page's SSE, one per open tab: `{ traderId, symbol, send(event, data) }`.
export class Pages {
  constructor() { this.all = new Set(); }
  add(page) { this.all.add(page); }
  delete(page) { this.all.delete(page); }
  of(traderId) { return [...this.all].filter((p) => p.traderId === traderId); }
  watching(symbol) { return [...this.all].filter((p) => p.symbol === symbol); }
  symbols() { return new Set([...this.all].map((p) => p.symbol).filter(Boolean)); }
}

// Reconnects with a growing pause, back to the first one once a socket held.
class Backoff {
  constructor(firstMs = 1000, maxMs = 30_000) { this.firstMs = firstMs; this.maxMs = maxMs; this.ms = firstMs; }
  next() { const ms = this.ms; this.ms = Math.min(this.ms * 2, this.maxMs); return ms; }
  reset() { this.ms = this.firstMs; }
}

export class ExecutionsFeed {
  constructor({ adona, pages, backoff = new Backoff() }) {
    this.adona = adona;
    this.pages = pages;
    this.backoff = backoff;
    this.cursor = null; // the last frame received: a reconnection resumes after it
    this.seen = new Map(); // trader_id -> Set(event_id), the last 500: at least once, shown once
    this.socket = null;
    this.stopped = false;
  }

  start() { this.stopped = false; void this.#open(); }

  stop() {
    this.stopped = true;
    if (this.socket) { this.socket.onclose = null; this.socket.close(1000); this.socket = null; }
  }

  async #open() {
    if (this.stopped) return;
    let socket;
    try {
      socket = await this.adona.propStream({ after: this.cursor ?? undefined });
    } catch (error) {
      console.error("executions stream:", error.code ?? error.message);
      await sleep(this.backoff.next());
      return this.#open();
    }
    this.socket = socket;
    socket.onmessage = (event) => this.#frame(JSON.parse(event.data));
    socket.onclose = async (event) => {
      this.socket = null;
      if (this.stopped) return;
      if (event.code === ANSWER) {
        // CURSOR_TOO_OLD: the 24 hours passed; the pages read GET .../executions on load.
        if (event.reason === "CURSOR_TOO_OLD" || event.reason === "INVALID_CURSOR") {
          this.cursor = null;
        } else if (event.reason === "INVALID_JWT") {
          // Adona re-checks the token of an open stream: twelve hours on, it closes it.
          // A new token, and the stream resumes after its cursor.
          this.adona.forgetPropToken();
        } else {
          console.error(`executions stream refused: ${event.reason}. Fix it, then restart.`);
          return;
        }
      }
      await sleep(event.code === LATER ? Math.max(this.backoff.next(), 10_000) : this.backoff.next());
      void this.#open();
    };
  }

  #frame(frame) {
    if (frame.type === "ready") return this.backoff.reset();
    if (frame.type !== "execution") return; // "ping" every thirty seconds
    this.cursor = frame.cursor;
    const seen = this.seen.get(frame.trader_id) ?? new Set();
    this.seen.set(frame.trader_id, seen);
    const id = frame.execution.event_id;
    if (seen.has(id)) return; // at least once: a resumption can send one again
    seen.add(id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
    for (const page of this.pages.of(frame.trader_id)) page.send("execution", frame.execution);
  }
}

export class PriceFeed {
  constructor({ adona, pages, backoff = new Backoff() }) {
    this.adona = adona;
    this.pages = pages;
    this.backoff = backoff;
    this.socket = null;
    this.subscribed = new Set();
    this.live = false;
    this.stopped = false;
  }

  get enabled() { return Boolean(this.adona.dataKey); }

  start() { this.stopped = false; if (this.enabled) void this.#open(); }

  stop() {
    this.stopped = true;
    if (this.socket) { this.socket.onclose = null; this.socket.close(1000); this.socket = null; }
  }

  // The symbols on screen changed (a page opened, closed, or moved to another symbol):
  // subscribe to what is displayed, nothing more. A symbol followed live most of its open
  // hours is billed as a continuous feed on your data plan.
  sync() {
    if (!this.socket || this.socket.readyState !== 1) return;
    const wanted = this.pages.symbols();
    const add = [...wanted].filter((s) => !this.subscribed.has(s));
    const drop = [...this.subscribed].filter((s) => !wanted.has(s));
    if (add.length) this.#send("subscribe", add);
    if (drop.length) this.#send("unsubscribe", drop);
    this.subscribed = wanted;
  }

  #send(type, symbols) {
    this.socket.send(JSON.stringify({ type, request_id: type, payload: { channels: symbols.map((s) => `quote:${s}`) } }));
  }

  async #open() {
    if (this.stopped) return;
    let socket;
    try {
      socket = await this.adona.priceStream();
    } catch (error) {
      console.error("price stream:", error.code ?? error.message);
      await sleep(this.backoff.next());
      return this.#open();
    }
    this.socket = socket;
    this.subscribed = new Set();
    socket.onopen = () => this.sync();
    socket.onmessage = (event) => {
      const { type, payload } = JSON.parse(event.data);
      if (type !== "quote.snapshot" && type !== "quote.update") return;
      this.live = true;
      this.backoff.reset();
      const quote = { symbol: payload.symbol, bid: payload.bid, ask: payload.ask, as_of: payload.as_of };
      for (const page of this.pages.watching(payload.symbol)) page.send("quote", quote);
    };
    socket.onclose = async (event) => {
      this.socket = null;
      this.live = false;
      // Said on every page: never a frozen price that looks live.
      for (const page of this.pages.all) page.send("quote-stale", {});
      if (this.stopped) return;
      if (event.code === ANSWER) {
        console.error(`price stream refused: ${event.reason}. Fix it, then restart.`);
        return;
      }
      await sleep(this.backoff.next());
      void this.#open();
    };
  }
}
