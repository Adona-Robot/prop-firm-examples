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

Your server reads each connected trader's executions (`GET /v1/prop/traders/{id}/executions`)
and relays new ones to **that trader's** open pages, over Server-Sent Events, and to no one
else's. A test signs two traders in and checks that each receives their own executions only.

Each connected trader is one read every two seconds: thirty traders online make about fifteen
reads a second. Poll less often if your page can wait.

## Prices: what the page shows, and what an order fills at

- **The live prices are for display** (charts, the bid and ask on screen). They never promise
  the price of an execution.
- **Never an empty screen.** Until the stream's first tick (the page just opened, a symbol
  just chosen, the stream reconnecting, our side restarting), the page shows the last known
  price from the executable price, with the time the API gives for it (`as_of`), marked
  "last known". The next tick replaces it. On a closed market the executable price is
  refused, and the page says "no live price".
- **The executable price** (`GET /v1/prop/traders/{id}/executable-price`) is what a market
  order would fill at now. It is indicative too: the order fills when it is processed. On a
  close, `side` is the closing order's (SELL to close a BUY). It has a quota per minute.
- **The execution decides**: its price is in the trader's executions.
- **Indices and energy** are traded in the Adona cockpit only: an order on one through the API
  is refused (`SYMBOL_NOT_TRADABLE_BY_API`), and a position on one shows what its execution
  fixed, with no current valuation. `GET /v1/prop/traders/{id}/tradable-symbols` lists what an
  order may name: the page offers those only.

## What your data plan sees

- **Each signed-in trader is one connection, and so is each extra tab they open.** Your plan
  is sized by the month's peak of simultaneous connections.
- **The data token is the trader's to see.** It lives twelve hours in their browser, and a
  curious trader can use it for any symbol of your data account, on your bill. Hand it to
  people you trust with that, as you would any feature of your product.
- **Subscribe to what is on screen, nothing more.** A symbol followed live most of its open
  hours in a month is billed as a continuous feed, on top of the plan. A page left open all day
  on every symbol does exactly that, so this one follows the displayed symbol only.

The plans and the continuous-feed rule, with their figures, are on
[adona-robot.com](https://adona-robot.com/en).

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
