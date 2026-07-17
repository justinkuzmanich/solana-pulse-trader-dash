#!/usr/bin/env node
/**
 * Generates the two Dune SQL queries in /queries from config/terminals.json.
 * Run `npm run gen:sql` after any registry change, then paste the regenerated
 * SQL into the corresponding saved Dune queries (IDs live in env vars
 * DUNE_QUERY_MAIN / DUNE_QUERY_BASELINE).
 *
 * Attribution method (mirrors Dune spellbook bot_trades / phantom_swapper):
 * a terminal trade = a tx in dex_solana.trades whose account_activity shows a
 * positive SOL balance_change to a fee account, OR a positive SPL
 * token_balance_change whose token_balance_owner is a fee account (covers
 * USDC fees + Phantom's referral-owned token accounts).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(root, "config/terminals.json"), "utf8"));

// pump.fun (6EF8...) Anchor discriminators, computed as sha256("global:<method>")[0..8]:
//   create  = 0x181ec828051c0777   migrate = 0x9beae792ec9ea21e
// Migrations moved to the in-program `migrate` ix (PumpSwap era, 2025+), which is
// the only migration path in current windows. Other launchpads (LaunchLab etc.)
// can be added here once their instruction discriminators are verified.
const LAUNCHPADS = [
  {
    name: "pump.fun",
    program: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    created: "0x181ec828051c0777",
    migrated: "0x9beae792ec9ea21e",
  },
];

const feeValues = registry.terminals
  .flatMap((t) => [...t.feeAccounts, ...(t.retiredFeeAccounts ?? [])].map((a) => `    ('${t.name}', '${a}')`))
  .join(",\n");

const launchFilter = LAUNCHPADS.map(
  (l) =>
    `(executing_account = '${l.program}' AND bytearray_substring(data, 1, 8) IN (${l.created}, ${l.migrated}))`
).join("\n       OR ");
const createdDiscs = LAUNCHPADS.map((l) => l.created).join(", ");

/** Shared CTEs, parameterized by lookback. `complete` clips to complete UTC days. */
const baseCtes = (lookback, complete = false) => `WITH fee_accounts (terminal, address) AS (
  VALUES
${feeValues}
),
fee_txs AS (
  SELECT f.terminal, aa.tx_id
  FROM solana.account_activity aa
  JOIN fee_accounts f ON aa.address = f.address
  WHERE ${timeFilter("aa.block_time", lookback, complete)}
    AND aa.tx_success = true
    AND aa.balance_change > 0
  UNION
  SELECT f.terminal, aa.tx_id
  FROM solana.account_activity aa
  JOIN fee_accounts f ON aa.token_balance_owner = f.address
  WHERE ${timeFilter("aa.block_time", lookback, complete)}
    AND aa.tx_success = true
    AND aa.token_balance_change > 0
),
term_trades AS (
  SELECT ft.terminal, t.tx_id, t.trader_id, t.amount_usd, t.block_time
  FROM dex_solana.trades t
  JOIN fee_txs ft ON t.tx_id = ft.tx_id
  WHERE ${timeFilter("t.block_time", lookback, complete)}
),
launch_ix AS (
  SELECT block_time,
         CASE WHEN bytearray_substring(data, 1, 8) IN (${createdDiscs})
              THEN 'created' ELSE 'migrated' END AS kind
  FROM solana.instruction_calls
  WHERE (${launchFilter})
    AND ${timeFilter("block_time", lookback, complete)}
    AND tx_success = true
)`;

function timeFilter(col, lookbackHoursOrDays, complete) {
  if (!complete) return `${col} >= now() - interval '${lookbackHoursOrDays}' hour`;
  return `${col} >= date_trunc('day', now()) - interval '${lookbackHoursOrDays}' day
    AND ${col} < date_trunc('day', now())`;
}

/* ---------------- 1. MAIN query: windows only, every refresh ----------------
   Single reference to term_trades and a single reference to launch_ix — each
   is the expensive part (a join through solana.account_activity), so every
   extra UNION ALL branch that re-references either CTE risks re-deriving it
   from scratch. (Free-tier Small engine has a hard 2-minute cap; there is no
   Medium/Large on Free, so this query must stay a single pass over each.)
   asOf is folded in as an extra column (max_bt) instead of a separate branch
   that would trigger a third term_trades derivation.

   win_defs + a LEFT JOIN at the very end guarantees a __total__/__launch__
   row for every window even when zero rows qualify (e.g. Dune's Solana
   ingestion lagging past the 1h cutoff at query time) — without it, a
   CROSS JOIN + WHERE that filters out every row for a window produces NO
   row for that group at all, which the app then silently defaults to 0,
   indistinguishable from a real measured zero. The LEFT JOIN is cheap (3
   literal rows), so this doesn't reintroduce a second term_trades scan. */
const mainSql = `-- Solana Trade Pulse — MAIN stats query (generated from config/terminals.json; do not edit by hand)
-- Result columns: section, bucket, terminal, traders, tx, vol, created, migrated, max_bt
${baseCtes(24)}
, win_defs (win, hrs) AS (VALUES ('1h', 1), ('6h', 6), ('24h', 24))
, term_agg AS (
  SELECT w.win AS win, COALESCE(tt.terminal, '__total__') AS terminal,
         COUNT(DISTINCT tt.trader_id) AS traders, COUNT(DISTINCT tt.tx_id) AS tx, SUM(tt.amount_usd) AS vol,
         MAX(tt.block_time) AS max_bt
  FROM term_trades tt
  CROSS JOIN win_defs w
  WHERE tt.block_time >= now() - interval '1' hour * w.hrs
  GROUP BY GROUPING SETS ((w.win, tt.terminal), (w.win))
)
, launch_agg AS (
  SELECT w.win AS win,
         COUNT(CASE WHEN kind = 'created' THEN 1 END) AS created,
         COUNT(CASE WHEN kind = 'migrated' THEN 1 END) AS migrated
  FROM launch_ix
  CROSS JOIN win_defs w
  WHERE block_time >= now() - interval '1' hour * w.hrs
  GROUP BY w.win
)
SELECT 'window' AS section, wd.win AS bucket, '__total__' AS terminal,
       COALESCE(ta.traders, 0) AS traders, COALESCE(ta.tx, 0) AS tx, COALESCE(ta.vol, 0) AS vol,
       CAST(NULL AS bigint) AS created, CAST(NULL AS bigint) AS migrated,
       to_unixtime(ta.max_bt) AS max_bt
FROM win_defs wd
LEFT JOIN term_agg ta ON ta.win = wd.win AND ta.terminal = '__total__'

UNION ALL
SELECT 'window', ta.win, ta.terminal,
       ta.traders, ta.tx, ta.vol,
       CAST(NULL AS bigint), CAST(NULL AS bigint),
       CAST(NULL AS double)
FROM term_agg ta
WHERE ta.terminal != '__total__'

UNION ALL
SELECT 'window', wd.win, '__launch__',
       CAST(NULL AS bigint), CAST(NULL AS bigint), CAST(NULL AS double),
       COALESCE(la.created, 0), COALESCE(la.migrated, 0),
       CAST(NULL AS double)
FROM win_defs wd
LEFT JOIN launch_agg la ON la.win = wd.win
`;

/* ---------------- 2. BASELINE query: one day's per-hour bucket values, accumulated over 7 daily runs ----------------
   A 7-day account_activity scan times out on Small even single-pass — same
   data-volume ceiling History hit. Rescoped to the most recently completed
   day only (the size already proven to fit — Main scans the same order of
   magnitude and succeeds). Still single-pass: GROUPING SETS gets all three
   bucket granularities (hour-of-day, 6h block, whole day) from one reference
   to term_trades / launch_ix, and dune-refresh accumulates 7 of these daily
   readings, averaging them itself instead of asking Dune to average 7 days
   in one execution.
   Even at 1-day scope this still timed out — the culprit is COUNT(DISTINCT)
   combined with GROUPING SETS, a known-expensive pattern in Trino-family
   engines (computing exact per-group distinct counts across multiple
   grouping levels needs a separate dedup pass per level). Switched to
   approx_distinct (HyperLogLog), which Trino specifically optimizes for
   this exact multi-grouping-set shape — one sketch, merged per level.
   Trade-off accepted only here: these are "typical" reference values, not
   the live headline numbers (Main keeps exact COUNT(DISTINCT)), so a small
   (~2%) approximation error doesn't affect the honesty of any number the
   user reads as "right now." */
const baselineSql = `-- Solana Trade Pulse — BASELINE query (generated; do not edit by hand)
-- Most recently completed day's per-bucket values — dune-refresh averages 7
-- of these daily readings into the "typical" baseline. traders/tx are
-- approximate (approx_distinct) — reference values only, not live headline
-- numbers, traded for fitting the Free-tier Small engine's time limit.
-- day_1h: bucket = hour-of-day 0..23 · day_6h: bucket = 6h block 0..3 · day_24h: bucket = 0
-- Columns: section, bucket, terminal, traders, tx, vol, created, migrated
${baseCtes(1, true)}
, keyed AS (
  SELECT trader_id, tx_id, amount_usd, hour(block_time) AS h1, hour(block_time) / 6 AS h6
  FROM term_trades
),
per_bucket AS (
  SELECT h1, h6,
         approx_distinct(trader_id) AS traders, approx_distinct(tx_id) AS tx, SUM(amount_usd) AS vol
  FROM keyed
  GROUP BY GROUPING SETS ((h1), (h6), ())
),
lkeyed AS (
  SELECT kind, hour(block_time) AS h1, hour(block_time) / 6 AS h6
  FROM launch_ix
),
l_per_bucket AS (
  SELECT h1, h6,
         COUNT(CASE WHEN kind = 'created' THEN 1 END) AS created,
         COUNT(CASE WHEN kind = 'migrated' THEN 1 END) AS migrated
  FROM lkeyed
  GROUP BY GROUPING SETS ((h1), (h6), ())
)
SELECT CASE WHEN h1 IS NOT NULL THEN 'day_1h' WHEN h6 IS NOT NULL THEN 'day_6h' ELSE 'day_24h' END AS section,
       CAST(COALESCE(h1, h6, 0) AS varchar) AS bucket, '__total__' AS terminal,
       traders, tx, vol,
       CAST(NULL AS double) AS created, CAST(NULL AS double) AS migrated
FROM per_bucket

UNION ALL
SELECT CASE WHEN h1 IS NOT NULL THEN 'lday_1h' WHEN h6 IS NOT NULL THEN 'lday_6h' ELSE 'lday_24h' END,
       CAST(COALESCE(h1, h6, 0) AS varchar), '__launch__',
       CAST(NULL AS double), CAST(NULL AS double), CAST(NULL AS double),
       created, migrated
FROM l_per_bucket
`;

mkdirSync(join(root, "queries"), { recursive: true });
writeFileSync(join(root, "queries/trade-pulse-main.sql"), mainSql);
writeFileSync(join(root, "queries/trade-pulse-baseline.sql"), baselineSql);
console.log("Wrote queries/trade-pulse-{main,baseline}.sql");
console.log(
  `Registry: ${registry.terminals.length} terminals, ` +
    `${registry.terminals.reduce((n, t) => n + t.feeAccounts.length, 0)} active + ` +
    `${registry.terminals.reduce((n, t) => n + (t.retiredFeeAccounts ?? []).length, 0)} retired fee accounts`
);
