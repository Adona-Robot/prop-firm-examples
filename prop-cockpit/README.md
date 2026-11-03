# Prop cockpit: a reference trading front for a prop firm

A small, complete front through which **your** traders trade on their Adona Robot accounts
from **your** product. Copy it and make it yours: the design, the sign-in, the language,
everything. What it shows is the part to keep: where the keys live, how an order is placed
once, how each trader sees only their own trading.

It uses the public API only: `/v1/prop` (your traders and their trading) and, if you want
our prices, `/v1` (live prices). Node 22.4 or later, no dependency.

> **Availability.** Trading through `/v1/prop` is not open yet: until it is opened for your
> firm, those routes answer 404. Everything else in this file already holds.

## Run it

```sh
cp .env.example .env     # then fill in your keys and DEMO_USERS
npm start                # http://127.0.0.1:8080
npm test                 # against a fake Adona Robot: no key, no network
```

1. **Your tenant key** (`adp_...`) for `/v1/prop`, and, for our live prices, **your data key**
   (`adk_...`). Both stay in `.env`, on your server. Neither, nor any token, ever reaches a
   browser. Without a data key, bring your own prices: the page shows the last known
   executable price.
2. **Your traders**, invited through `POST /v1/prop/traders` with your own name for each
   (`external_ref`). `DEMO_USERS` maps a demo user name to that name.
   Each trades on an account you open for them on one of your products
   (`POST /v1/prop/traders/{id}/accounts`); until then the page answers `NO_TRADING_ACCOUNT`.

## How it is built

```
 browser  ──/api/...──────────▶  your server  ──/v1/prop (tenant key)──────────────▶  Adona Robot
          ◀──/api/stream (SSE)──      │        ◀──WS /v1/prop/stream (confirmations)──
                                      │        ──/v1/tokens, /v1/ws-ticket (data key)─▶
                                      └────────◀──WS /v1/stream (live prices)─────────
```

- **Your server holds the keys** (`server.mjs`, `adona.mjs`). It takes a prop token with the
  tenant key, and calls `/v1/prop` for the trader of the session, and for nobody else: the
  trader comes from the session, never from what the browser sends.
- **Your server keeps two sockets, each one for the whole server** (`feeds.mjs`): every
  trader's confirmations (`WS /v1/prop/stream`), and the live prices of the symbols on screen
  (`WS /v1/stream`, on one data token of its own). It relays both to each page over
  Server-Sent Events (`/api/stream`).
- **The browser never sees a key nor a token**, a data token included. It talks to your
  server only, so the address it reads prices from is yours.
- **The sign-in is yours.** `demo-login.mjs` signs in by user name alone and refuses to start
  anywhere but this machine. Replace it with your own sign-in. Keep the part that matters: your
  user is matched to your trader by your `external_ref`.
- **The writes carry a CSRF token.** The page reads it from `/api/session` and sends it in a
  header. The session cookie is `SameSite=Strict`, and no other site may frame the page
  (`frame-ancestors 'none'`).
- **The demo refuses anything that is not this machine**: another address, another `Host`,
  or a forwarding header. A proxy or a tunnel in front of it does not put it online.
- **Your sessions are yours to finish**: the demo's live in memory for eight hours, with a
  sign-out (`POST /api/logout`). Yours need `Secure` cookies once served over HTTPS.
- **A write must come from the page**: JSON only, and from this origin when the browser names
  one. A form on another site can do neither, the sign-in included.

## An order is placed once

A network that hesitates must never open a second position, and two networks hesitate here:
the trader's, between their browser and your server, and yours, between your server and
Adona Robot. Every order goes out with an `Idempotency-Key` header (required on an opening),
**made by the page** when the trader first sends the order and kept until a final answer. Your
server checks it is a UUID and prefixes it with the session's trader, so nobody aims at
another trader's key. Then, on either link:

- a **new** key for each order you mean to place;
- the **same** key when you send that order again: no answer (a timeout), a 5xx, or
  `IDEMPOTENCY_KEY_IN_PROGRESS` (wait `Retry-After`). Adona answers what the first one became,
  or places it if it never arrived;
- `IDEMPOTENCY_OUTCOME_UNKNOWN`: do **not** send it again. Read the trader's positions, then
  decide, with a new key if you place it again.

`order()` in `public/app.js` and `Adona.placeOnce` in `adona.mjs` do exactly this, and two
tests prove it: an answer lost between Adona and your server, then one lost between your server
and the page, each followed by the order sent again with the same key: one order placed.

## Each trader sees only their own executions

Your server holds one `WS /v1/prop/stream` for all your traders: the prop token in
`Authorization`, which a server can send and a browser cannot (the stream refuses any
handshake with an `Origin`). Each frame names its trader (`trader_id`); your server relays it
to **that trader's** open pages, over Server-Sent Events, and to no one else's. A test signs
two traders in and checks that each receives their own executions only.

- **Delivery is at least once.** A frame can come twice after a reconnection: your server
  drops an `event_id` it already relayed.
- **A drop is resumed, not lost.** Your server keeps the last frame's `cursor` and reconnects
  with `after=<cursor>` (24 hours, 1000 reports at most). Past that (`CURSOR_TOO_OLD`), the page
  reads `GET /v1/prop/traders/{id}/executions` on load, as it does anyway.
- **A close with 1008 is an answer** (a key revoked, a tenant suspended): never retried in a
  loop. 1013 is "later" (three sockets per tenant, thirty connections a minute); 1011 is ours,
  resume with your cursor.
- **Why a position closed** is in `trigger_reason` on a close the trader did not ask for:
  `SL_HIT`, `TP_HIT`, `BREACH`, `ACCOUNT_ENDED`, `DESK`; `MANUAL` for their own. The page shows
  it.

## Prices: what the page shows, and what an order fills at

- **The live prices are for display** (charts, the bid and ask on screen). They never promise
  the price of an execution.
- **Never an empty screen.** Until the first live price (the page just opened, a symbol
  just chosen, the stream reconnecting, our side restarting), the page shows the last known
  price from the executable price, with the time the API gives for it (`as_of`, the last
  update of that quote: the price is at least that old), marked "last known".
  The next tick replaces it. On a closed market, it is that market's last price, marked
  "market closed" (`market_open: false`): an order placed then is refused (`MARKET_CLOSED`).
- **The executable price** (`GET /v1/prop/traders/{id}/executable-price`) is what a market
  order would fill at now. It is indicative too: the order fills when it is processed. On a
  close, `side` is the closing order's (SELL to close a BUY). It has a quota per minute.
- **The execution decides**: its price is in the trader's executions.
- **Indices and energy** cannot be traded through the API: an order on one is refused
  (`SYMBOL_NOT_TRADABLE_BY_API`), and a position on one shows what its execution fixed, with
  no current valuation. `GET /v1/prop/traders/{id}/tradable-symbols` lists what an
  order may name: the page offers those only.

## What your data plan sees

- **Your server is one connection on your data plan**, whatever the number of traders and
  tabs: it holds one price socket and relays it. Your plan is sized by the month's peak of
  simultaneous connections.
- **No data token in a browser.** A token in a trader's page would let a curious trader read
  any symbol of your data account, on your bill. Here there is none to take.
- **Subscribe to what is on screen, nothing more.** Your server follows the symbols your pages
  show, and only those of each trader's own account. A symbol followed live most of its open
  hours in a month is billed as a continuous feed, on top of the plan.
- **Or bring your own prices.** The data module is billed apart; without a data key, the page
  shows the last known executable price, from `/v1/prop`.

The plans and the continuous-feed rule, with their figures, are on
[adona-robot.com](https://adona-robot.com/en).

## Refusals

Every refusal answers `{"detail": "CODE"}`: branch on the code. The ones a trading front
meets most:

| Code | Status | What to do |
|---|---|---|
| `STOP_LOSS_REQUIRED`, `TAKE_PROFIT_REQUIRED` | 409 | Every opening carries both. Ask the trader for them. |
| `SYMBOL_NOT_TRADABLE_BY_API` | 409 | An index or energy: not tradable through the API. |
| `SYMBOL_NOT_ALLOWED` | 409 | Not a symbol of this trader's account. |
| `MARKET_CLOSED` | 409 | Wait for the session to open. |
| `CONCURRENT_SL_EXCEEDED`, `CONCURRENT_TP_EXCEEDED` | 409 | The trader's open risk is at its limit. |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Send an `Idempotency-Key` with every opening. |
| `IDEMPOTENCY_KEY_IN_PROGRESS` | 409 | Same key, after `Retry-After`. |
| `IDEMPOTENCY_KEY_REUSED` | 409 | A key names one order: take a new one. |
| `IDEMPOTENCY_OUTCOME_UNKNOWN` | 409 | Read the positions before anything else. |
| `TRADER_ORDER_RATE_LIMITED`, `TENANT_ORDER_RATE_LIMITED`, `EXECUTABLE_PRICE_RATE_LIMITED` | 429 | Wait `Retry-After`. |
| `TRADING_API_BUSY`, `TRADING_QUOTA_UNAVAILABLE` | 503 | Wait `Retry-After`. |
| `EXPOSURE_UNAVAILABLE` | 503 | The account cannot be read right now: retry in a few seconds. |
| `NO_TRADING_ACCOUNT` | 409 | Open an account for this trader first. |
| `TRADER_NOT_FOUND` | 404 | Not a trader of yours. |

Closing, reducing and cancelling are never held back by the opening quotas. A position or an
order is named by an opaque id (`pos_...`, `ord_...`, up to 220 characters): pass it back as
it is, never read it. The full list,
route by route, is in the [API reference](https://adona-robot.com/en/reference).

## What it does not do

No risk logic in the front: Adona's rules judge every order (stop loss and take profit, the
account's limits). The page only asks for what those rules require.
