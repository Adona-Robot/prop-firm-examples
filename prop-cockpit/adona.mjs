// The calls your server makes to Adona Robot. Server side only: both keys live here.
//
// - `/v1/prop` with your TENANT key (adp_...): your traders, their orders, their trading,
//   and `WS /v1/prop/stream`, their confirmations pushed to this server.
// - `/v1` with your DATA key (adk_...), optional: ONE live price socket for this server,
//   which relays the prices to your pages. The browser never holds a data token. Without
//   a data key, bring your own prices: the page then shows the last known executable price.
//
// Every refusal answers {"detail": "CODE"}. `AdonaError` carries the status, the code and
// `Retry-After` when there is one: branch on the code, never on the text.

import { randomUUID } from "node:crypto";

export class AdonaError extends Error {
  constructor(status, code, retryAfter) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter; // seconds, or null
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Adona {
  constructor({ api, tenantKey, dataKey, fetchImpl = fetch, webSocketImpl = globalThis.WebSocket, timeoutMs = 10_000 }) {
    if (!tenantKey) throw new Error("set ADONA_TENANT_KEY in the environment");
    this.api = api.replace(/\/$/, "");
    this.tenantKey = tenantKey;
    this.dataKey = dataKey || null; // optional: your own price source instead
    this.fetch = fetchImpl;
    this.WebSocket = webSocketImpl;
    this.timeoutMs = timeoutMs;
    this.prop = null; // { token, until }
    this.data = null; // { token, until }
  }

  async #call(method, path, { bearer, body, headers = {} } = {}) {
    const response = await this.fetch(`${this.api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const retry = response.headers.get("Retry-After");
      throw new AdonaError(response.status, json.detail ?? "UNKNOWN", retry === null ? null : Number(retry));
    }
    return json;
  }

  // A prop token lives twelve hours; take a new one a minute before it ends.
  async #propToken() {
    if (!this.prop || Date.now() > this.prop.until) {
      const json = await this.#call("POST", "/v1/prop/tokens", { bearer: this.tenantKey });
      this.prop = { token: json.access_token, until: Date.now() + (json.expires_in - 60) * 1000 };
    }
    return this.prop.token;
  }

  // `/v1/prop`, once more with a fresh token if this one was refused as expired.
  async propCall(method, path, options = {}) {
    try {
      return await this.#call(method, path, { ...options, bearer: await this.#propToken() });
    } catch (error) {
      if (error instanceof AdonaError && error.status === 401 && error.code === "INVALID_JWT") {
        this.prop = null;
        return this.#call(method, path, { ...options, bearer: await this.#propToken() });
      }
      throw error;
    }
  }

  // `WS /v1/prop/stream`: every trader's confirmations, pushed to this server. The prop
  // token goes in `Authorization`, which a server can send and a browser cannot; Node's
  // WebSocket sends no `Origin`, which the stream would refuse. `after` resumes after the
  // last frame received (24 hours at most).
  async propStream({ after } = {}) {
    const url = new URL(`${this.api.replace(/^http/, "ws")}/v1/prop/stream`);
    if (after) url.searchParams.set("after", after);
    return new this.WebSocket(url, { headers: { Authorization: `Bearer ${await this.#propToken()}` } });
  }

  // ONE live price socket for this server (`WS /v1/stream`), on a data token of its own:
  // one connection on your data plan, whatever the number of pages open. A ticket, then
  // the socket, as for any data client.
  async priceStream() {
    if (!this.dataKey) throw new Error("no ADONA_DATA_KEY: bring your own prices");
    if (!this.data || Date.now() > this.data.until) {
      const json = await this.#call("POST", "/v1/tokens", { bearer: this.dataKey, body: { end_user_id: "cockpit-server" } });
      this.data = { token: json.access_token, until: Date.now() + (json.expires_in - 60) * 1000 };
    }
    const { ticket } = await this.#call("POST", "/v1/ws-ticket", { bearer: this.data.token });
    return new this.WebSocket(`${this.api.replace(/^http/, "ws")}/v1/stream`, ["adona.data.v1", `ticket.${ticket}`]);
  }

  // Your trader, by YOUR name of them (`external_ref`, set when you invited them).
  async traderByRef(externalRef) {
    const { traders } = await this.propCall("GET", `/v1/prop/traders?external_ref=${encodeURIComponent(externalRef)}`);
    return traders[0] ?? null;
  }

  // The reads. A symbol we do not distribute (an index, energy) shows only what the
  // execution fixed: no current valuation.
  tradableSymbols(traderId) { return this.propCall("GET", `/v1/prop/traders/${traderId}/tradable-symbols`); }
  positions(traderId) { return this.propCall("GET", `/v1/prop/traders/${traderId}/positions`); }
  pendingOrders(traderId) { return this.propCall("GET", `/v1/prop/traders/${traderId}/pending-orders`); }
  executions(traderId, { limit = 50, cursor } = {}) {
    const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    return this.propCall("GET", `/v1/prop/traders/${traderId}/executions?${query}`);
  }
  // The price a market order would fill at NOW: indicative, the fill decides. On a close,
  // `side` is the closing order's (SELL to close a BUY). It has a quota per minute.
  executablePrice(traderId, { symbol, side, intent }) {
    const query = new URLSearchParams({ symbol, side, intent });
    return this.propCall("GET", `/v1/prop/traders/${traderId}/executable-price?${query}`);
  }

  // The orders. Each one is sent with an Idempotency-Key: a NEW one per order you mean to
  // place, the SAME one when you send that order again. See `placeOnce`.
  openOrder(traderId, order, key) {
    return this.placeOnce("POST", `/v1/prop/traders/${traderId}/orders`, order, key);
  }
  reducePosition(traderId, positionId, { symbol, quantity }, key) {
    return this.placeOnce("POST", `/v1/prop/traders/${traderId}/positions/${encodeURIComponent(positionId)}/reduce`, { symbol, quantity }, key);
  }
  closePosition(traderId, positionId, key) {
    return this.placeOnce("POST", `/v1/prop/traders/${traderId}/positions/${encodeURIComponent(positionId)}/close`, undefined, key);
  }
  cancelOrder(traderId, orderId, key) {
    return this.placeOnce("POST", `/v1/prop/traders/${traderId}/orders/${encodeURIComponent(orderId)}/cancel`, undefined, key);
  }

  // One order, placed once, whatever the network does.
  //
  // - No answer (a timeout, a dropped connection) or a 5xx: we cannot know whether the
  //   order was placed, so it is sent AGAIN WITH THE SAME KEY. Adona answers what the first
  //   one became, or places it if it never arrived. Never a second position.
  // - IDEMPOTENCY_KEY_IN_PROGRESS: the first is still running; wait `Retry-After`, same key.
  // - IDEMPOTENCY_OUTCOME_UNKNOWN: Adona cannot tell either. Do NOT resend: read the
  //   trader's positions, then decide, with a new key if you place it again.
  // - Any other refusal is the answer (a rule, a quota with `Retry-After`): it is returned.
  async placeOnce(method, path, body, key = randomUUID(), { attempts = 4 } = {}) {
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.propCall(method, path, { body, headers: { "Idempotency-Key": key } });
      } catch (error) {
        last = error;
        const unanswered = !(error instanceof AdonaError);
        const busy = error instanceof AdonaError && (error.status >= 500 || error.code === "IDEMPOTENCY_KEY_IN_PROGRESS");
        if (!(unanswered || busy) || attempt === attempts) throw error;
        const wait = error instanceof AdonaError && error.retryAfter ? error.retryAfter * 1000 : 500 * attempt;
        await sleep(Math.min(wait, 10_000));
      }
    }
    throw last;
  }
}
