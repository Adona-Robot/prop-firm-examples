# Prop cockpit: a reference trading front for a prop firm

A small, complete front through which **your** traders trade on their Adona Robot accounts
from **your** product. Copy it and make it yours: the design, the sign-in, the language,
everything. What it shows is the part to keep: where the keys live, how an order is placed
once, how each trader sees only their own trading.

It uses the public API only: `/v1/prop` (your traders and their trading) and `/v1` (live
prices). Node 22 or later, no dependency.

> **Availability.** Trading through `/v1/prop` is not open yet: until it is opened for your
> firm, those routes answer 404. Everything else in this file already holds.

## Run it

```sh
cp .env.example .env     # then fill in your two keys and DEMO_USERS
npm start                # http://127.0.0.1:8080
npm test                 # against a fake Adona Robot: no key, no network
```

1. **Your tenant key** (`adp_...`) for `/v1/prop`, and **your data key** (`adk_...`) for the
   live prices. Both stay in `.env`, on your server. Neither ever reaches a browser.
2. **Your traders**, invited through `POST /v1/prop/traders` with your own name for each
   (`external_ref`). `DEMO_USERS` maps a demo user name to that name.
3. **Your page's origin** (`http://127.0.0.1:8080` here) declared among the browser origins
   of your data account: the page opens the live prices itself.

## How it is built

```
 browser  ──/api/...──▶  your server  ──/v1/prop (tenant key)──▶  Adona Robot
    │                        └────────/v1/tokens (data key)───▶
    └──────/v1/ws-ticket, /v1/stream (data token)─────────────▶
```

- **Your server holds both keys** (`server.mjs`, `adona.mjs`). It takes a prop token with the
  tenant key, and a data token per trader with the data key (`POST /v1/tokens`, with the trader
  as `end_user_id`). It calls `/v1/prop` for the trader of the session, and for nobody else:
  the trader comes from the session, never from what the browser sends.
- **The browser never sees a key nor the prop token.** It receives a data token for its own
  trader and reads live prices with it (`/v1/ws-ticket`, then `/v1/stream`).
- **The sign-in is yours.** `demo-login.mjs` signs in by user name alone and refuses to start
  anywhere but this machine. Replace it with your own sign-in. Keep the part that matters: your
  user is matched to your trader by your `external_ref`.
- **The writes carry a CSRF token.** The page reads it from `/api/session` and sends it in a
  header. The session cookie is `SameSite=Strict`.

## An order is placed once

A network that hesitates must never open a second position. Every order goes out with an
`Idempotency-Key` header (required on an opening):

- a **new** key for each order you mean to place;
- the **same** key when you send that order again: no answer (a timeout), a 5xx, or
  `IDEMPOTENCY_KEY_IN_PROGRESS` (wait `Retry-After`). Adona answers what the first one became,
  or places it if it never arrived;
- `IDEMPOTENCY_OUTCOME_UNKNOWN`: do **not** send it again. Read the trader's positions, then
  decide, with a new key if you place it again.

`Adona.placeOnce` in `adona.mjs` does exactly this, and a test proves it: the answer to the
first order is lost, the order is sent again with the same key, and one order is placed.

## Each trader sees only their own executions

Your server reads each connected trader's executions (`GET /v1/prop/traders/{id}/executions`)
and relays new ones to **that trader's** open pages, over Server-Sent Events, and to no one
else's. A test signs two traders in and checks that each receives their own executions only.

*Polled for now: a dedicated stream of confirmations, planned for later, will push them instead.*

## Prices: what the page shows, and what an order fills at

- **The live prices are for display** (charts, the bid and ask on screen). They never promise
  the price of an execution.
- **The executable price** (`GET /v1/prop/traders/{id}/executable-price`) is what a market
  order would fill at now. It is indicative too: the order fills when it is processed. On a
  close, `side` is the closing order's (SELL to close a BUY). It has a quota per minute.
- **The execution decides**: its price is in the trader's executions.
- **Indices and energy** are traded in the Adona cockpit only: an order on one through the API
  is refused (`SYMBOL_NOT_TRADABLE_BY_API`), and a position on one shows what its execution
  fixed, with no current valuation. `GET /v1/prop/traders/{id}/tradable-symbols` lists what an
  order may name: the page offers those only.

## What your data plan sees

- **Each signed-in trader is one connection.** Your plan is sized by the month's peak of
  simultaneous connections: a class of 30 traders online fits in Starter.
- **Subscribe to what is on screen, nothing more.** A symbol followed live for more than 80% of
  its open hours in a month adds CHF 150 to that month's invoice. A page left open all day on
  every symbol does exactly that, so this one follows the displayed symbol only.

## Refusals

Every refusal answers `{"detail": "CODE"}`: branch on the code. The ones a trading front
meets most:

| Code | Status | What to do |
|---|---|---|
| `STOP_LOSS_REQUIRED`, `TAKE_PROFIT_REQUIRED` | 409 | Every opening carries both. Ask the trader for them. |
| `SYMBOL_NOT_TRADABLE_BY_API` | 409 | An index or energy: cockpit only. |
| `SYMBOL_NOT_ALLOWED` | 409 | Not a symbol of this trader's account. |
| `MARKET_CLOSED` | 409 | Wait for the session to open. |
| `CONCURRENT_SL_EXCEEDED`, `CONCURRENT_TP_EXCEEDED` | 409 | The trader's open risk is at its limit. |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Send an `Idempotency-Key` with every opening. |
| `IDEMPOTENCY_KEY_IN_PROGRESS` | 409 | Same key, after `Retry-After`. |
| `IDEMPOTENCY_KEY_REUSED` | 409 | A key names one order: take a new one. |
| `IDEMPOTENCY_OUTCOME_UNKNOWN` | 409 | Read the positions before anything else. |
| `TRADER_ORDER_RATE_LIMITED`, `TENANT_ORDER_RATE_LIMITED`, `EXECUTABLE_PRICE_RATE_LIMITED` | 429 | Wait `Retry-After`. |
| `TRADING_API_BUSY`, `TRADING_QUOTA_UNAVAILABLE` | 503 | Wait `Retry-After`. |
| `TRADER_NOT_FOUND` | 404 | Not a trader of yours. |

Closing, reducing and cancelling are never held back by the opening quotas. The full list,
route by route, is in the [API reference](https://adona-robot.com/en/reference).

## What it does not do

No risk logic in the front: Adona's rules judge every order (stop loss and take profit, the
account's limits), exactly as in the Adona cockpit. The page only asks for what those rules
require.
