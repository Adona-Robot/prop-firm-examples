// The cockpit against a REAL Adona Robot: the "ready to trade" checklist, through this
// server, as a trader's page would go through it. Run it against your own Adona Robot.
//
//   ADONA_API=... ADONA_TENANT_KEY=... ADONA_DATA_KEY=... \
//   CHECK_TRADERS=<external_ref of trader A>,<external_ref of trader B> node check/live.mjs
//
// Both traders need an open account; with CHECK_PRODUCT=<your product's slug>, it opens one
// for each first. It opens and closes one small EURUSD position for trader A: run it on a
// demo account, never on a funded one. The checklist itself is `check/checklist.mjs`.

import { Adona } from "../adona.mjs";
import { checklist } from "./checklist.mjs";

const [refA, refB] = (process.env.CHECK_TRADERS ?? "").split(",").map((s) => s.trim());
if (!refA || !refB) throw new Error("set CHECK_TRADERS=<external_ref A>,<external_ref B>");

await checklist({
  adona: new Adona({
    api: process.env.ADONA_API ?? "https://api.adona-robot.com",
    tenantKey: process.env.ADONA_TENANT_KEY,
    dataKey: process.env.ADONA_DATA_KEY || undefined,
  }),
  refA,
  refB,
  product: process.env.CHECK_PRODUCT,
  symbol: process.env.CHECK_SYMBOL ?? "EURUSD",
  waitMs: Number(process.env.CHECK_WAIT_MS ?? 30_000),
});
