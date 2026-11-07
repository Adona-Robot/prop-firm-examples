# Adona Robot prop firm examples

Reference code for the Adona Robot prop firm API (`/v1/prop`): what your server does for
your traders, and what their pages need from it. Copy it and make it yours.

| Example | What it shows |
|---|---|
| [`prop-cockpit/`](prop-cockpit/) | A complete trading front for your traders: your keys on your server, an order placed once whatever the network does, each trader's confirmations pushed to their own pages only, live prices relayed by your server. Node 22.4 or later, no dependency. |

The module is described at [adona-robot.com/en/prop-firms](https://adona-robot.com/en/prop-firms),
its first calls in [the prop firm quickstart](https://adona-robot.com/en/prop-firms/quickstart),
and every `/v1/prop` route and refusal in
[the API reference](https://adona-robot.com/en/reference#prop).
Examples for the market data API are in
[market-data-examples](https://github.com/Adona-Robot/market-data-examples).

MIT licence: see [LICENSE](LICENSE).
