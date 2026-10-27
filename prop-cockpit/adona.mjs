// The calls your server makes to Adona Robot. Server side only: both keys live here.
//
// - `/v1/prop` with your TENANT key (adp_...): your traders, their orders, their trading.
// - `/v1` with your DATA key (adk_...): a twelve-hour token per trader, which the browser
//   uses for live prices.
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
  constructor({ api, tenantKey, dataKey, fetchImpl = fetch, timeoutMs = 10_000 }) {
    if (!tenantKey || !dataKey) throw new Error("set ADONA_TENANT_KEY and ADONA_DATA_KEY in the environment");
    this.api = api.replace(/\/$/, "");
    this.tenantKey = tenantKey;
    this.dataKey = dataKey;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.prop = null; // { token, until }
    this.dataTokens = new Map(); // end_user_id -> { token, until }
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

  // A data token for ONE trader (`end_user_id`): each connected trader is one person on
  // your data plan, and one socket at the month's peak.
  async dataToken(endUserId) {
    const held = this.dataTokens.get(endUserId);
    if (held && Date.now() < held.until) return held.token;
    const json = await this.#call("POST", "/v1/tokens", { bearer: this.dataKey, body: { end_user_id: endUserId } });
    const token = { token: json.access_token, until: Date.now() + (json.expires_in - 60) * 1000 };
    this.dataTokens.set(endUserId, token);
    return token.token;
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
