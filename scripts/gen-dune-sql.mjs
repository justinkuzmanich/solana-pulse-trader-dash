#!/usr/bin/env node
/**
 * Generates the three Dune SQL queries in /queries from config/terminals.json.
 * Run `npm run gen:sql` after any registry change, then paste the regenerated
 * SQL into the corresponding saved Dune queries (IDs live in env vars
 * DUNE_QUERY_MAIN / DUNE_QUERY_HISTORY / DUNE_QUERY_BASELINE).
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

/* ---------------- 1. MAIN query: windows + hourly, every refresh ---------------- */
const mainSql = `-- Solana Trade Pulse — MAIN stats query (generated from config/terminals.json; do not edit by hand)
-- Result columns: section, bucket, terminal, traders, tx, vol, created, migrated
${baseCtes(24)}
SELECT 'window' AS section, w.win AS bucket, COALESCE(tt.terminal, '__total__') AS terminal,
       COUNT(DISTINCT tt.trader_id) AS traders, COUNT(DISTINCT tt.tx_id) AS tx, SUM(tt.amount_usd) AS vol,
       CAST(NULL AS bigint) AS created, CAST(NULL AS bigint) AS migrated
FROM term_trades tt
CROSS JOIN (VALUES ('1h', 1), ('6h', 6), ('24h', 24)) AS w(win, hrs)
WHERE tt.block_time >= now() - interval '1' hour * w.hrs
GROUP BY GROUPING SETS ((w.win, tt.terminal), (w.win))

UNION ALL
SELECT 'hourly', CAST(CAST(to_unixtime(date_trunc('hour', tt.block_time)) AS bigint) AS varchar), '__total__',
       COUNT(DISTINCT tt.trader_id), COUNT(DISTINCT tt.tx_id), SUM(tt.amount_usd), NULL, NULL
FROM term_trades tt
GROUP BY date_trunc('hour', tt.block_time)

UNION ALL
SELECT 'window', w.win, '__launch__',
       NULL, NULL, NULL,
       COUNT(CASE WHEN kind = 'created' THEN 1 END), COUNT(CASE WHEN kind = 'migrated' THEN 1 END)
FROM launch_ix
CROSS JOIN (VALUES ('1h', 1), ('6h', 6), ('24h', 24)) AS w(win, hrs)
WHERE block_time >= now() - interval '1' hour * w.hrs
GROUP BY w.win

UNION ALL
SELECT 'hourly', CAST(CAST(to_unixtime(date_trunc('hour', block_time)) AS bigint) AS varchar), '__launch__',
       NULL, NULL, NULL,
       COUNT(CASE WHEN kind = 'created' THEN 1 END), COUNT(CASE WHEN kind = 'migrated' THEN 1 END)
FROM launch_ix
GROUP BY date_trunc('hour', block_time)

UNION ALL
SELECT 'meta', 'max_block_time', '__total__', NULL, NULL, to_unixtime(MAX(tt.block_time)), NULL, NULL
FROM term_trades tt
`;

/* ---------------- 2. HISTORY query: last 5 complete days, daily ---------------- */
const historySql = `-- Solana Trade Pulse — HISTORY query (generated; do not edit by hand)
-- Last 5 complete UTC days of terminal volume. Columns: t (epoch sec), v (USD)
${baseCtes(5, true)}
SELECT CAST(to_unixtime(date_trunc('day', block_time)) AS bigint) AS t,
       SUM(amount_usd) AS v
FROM term_trades
GROUP BY date_trunc('day', block_time)
ORDER BY t
`;

/* ---------------- 3. BASELINE query: 7 complete days, daily until local history accumulates ---------------- */
const baselineSql = `-- Solana Trade Pulse — BASELINE ("typical") query (generated; do not edit by hand)
-- 7-day averages per time-of-day bucket, matching each dashboard window.
-- base_1h: bucket = hour-of-day 0..23 · base_6h: bucket = 6h block 0..3 · base_24h: bucket = 0
-- Trades metrics use per-bucket DISTINCT counts averaged across the 7 days.
-- Columns: section, bucket, terminal, traders, tx, vol, created, migrated
${baseCtes(7, true)}
, per_1h AS (
  SELECT date_trunc('day', block_time) AS d, hour(block_time) AS b,
         COUNT(DISTINCT trader_id) AS traders, COUNT(DISTINCT tx_id) AS tx, SUM(amount_usd) AS vol
  FROM term_trades GROUP BY 1, 2
),
per_6h AS (
  SELECT date_trunc('day', block_time) AS d, hour(block_time) / 6 AS b,
         COUNT(DISTINCT trader_id) AS traders, COUNT(DISTINCT tx_id) AS tx, SUM(amount_usd) AS vol
  FROM term_trades GROUP BY 1, 2
),
per_24h AS (
  SELECT date_trunc('day', block_time) AS d, 0 AS b,
         COUNT(DISTINCT trader_id) AS traders, COUNT(DISTINCT tx_id) AS tx, SUM(amount_usd) AS vol
  FROM term_trades GROUP BY 1, 2
),
l_per_1h AS (
  SELECT date_trunc('day', block_time) AS d, hour(block_time) AS b,
         COUNT(CASE WHEN kind = 'created' THEN 1 END) AS created,
         COUNT(CASE WHEN kind = 'migrated' THEN 1 END) AS migrated
  FROM launch_ix GROUP BY 1, 2
),
l_per_6h AS (
  SELECT date_trunc('day', block_time) AS d, hour(block_time) / 6 AS b,
         COUNT(CASE WHEN kind = 'created' THEN 1 END) AS created,
         COUNT(CASE WHEN kind = 'migrated' THEN 1 END) AS migrated
  FROM launch_ix GROUP BY 1, 2
),
l_per_24h AS (
  SELECT date_trunc('day', block_time) AS d, 0 AS b,
         COUNT(CASE WHEN kind = 'created' THEN 1 END) AS created,
         COUNT(CASE WHEN kind = 'migrated' THEN 1 END) AS migrated
  FROM launch_ix GROUP BY 1, 2
)
SELECT 'base_1h' AS section, CAST(b AS varchar) AS bucket, '__total__' AS terminal,
       AVG(traders) AS traders, AVG(tx) AS tx, AVG(vol) AS vol, NULL AS created, NULL AS migrated
FROM per_1h GROUP BY b
UNION ALL
SELECT 'base_6h', CAST(b AS varchar), '__total__', AVG(traders), AVG(tx), AVG(vol), NULL, NULL
FROM per_6h GROUP BY b
UNION ALL
SELECT 'base_24h', CAST(b AS varchar), '__total__', AVG(traders), AVG(tx), AVG(vol), NULL, NULL
FROM per_24h GROUP BY b
UNION ALL
SELECT 'lbase_1h', CAST(b AS varchar), '__launch__', NULL, NULL, NULL, AVG(created), AVG(migrated)
FROM l_per_1h GROUP BY b
UNION ALL
SELECT 'lbase_6h', CAST(b AS varchar), '__launch__', NULL, NULL, NULL, AVG(created), AVG(migrated)
FROM l_per_6h GROUP BY b
UNION ALL
SELECT 'lbase_24h', CAST(b AS varchar), '__launch__', NULL, NULL, NULL, AVG(created), AVG(migrated)
FROM l_per_24h GROUP BY b
`;

mkdirSync(join(root, "queries"), { recursive: true });
writeFileSync(join(root, "queries/trade-pulse-main.sql"), mainSql);
writeFileSync(join(root, "queries/trade-pulse-history.sql"), historySql);
writeFileSync(join(root, "queries/trade-pulse-baseline.sql"), baselineSql);
console.log("Wrote queries/trade-pulse-{main,history,baseline}.sql");
console.log(
  `Registry: ${registry.terminals.length} terminals, ` +
    `${registry.terminals.reduce((n, t) => n + t.feeAccounts.length, 0)} active + ` +
    `${registry.terminals.reduce((n, t) => n + (t.retiredFeeAccounts ?? []).length, 0)} retired fee accounts`
);
