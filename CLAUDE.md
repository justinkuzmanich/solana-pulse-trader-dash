# Solana Trade Pulse — CLAUDE.md

## What this project is

A single-page dashboard that answers one question for memecoin traders: **"Is it worth trading Solana right now?"** It is aimed at both new and experienced traders — every metric has a plain-language read, and the whole page re-renders when the user picks a timeframe (5M / 1H / 6H / 1D) in the header.

The frontend is **finished and approved** (`index.html`, vanilla JS + canvas, no build step, no frameworks). It currently runs on clearly-labeled demo data. The job now is to wire it to live data **without changing the layout or visual design**.

Deploy target: **Netlify** (static site + serverless functions). The owner has an existing Netlify pattern from a prior project (ANSEM dashboard): static frontend + hardened serverless proxy functions that hide API keys. Reuse that pattern.

## Core concept: terminal-scoped data

This dashboard does NOT track all Solana activity. It tracks trading routed through
**trading terminals**: Axiom, Photon, GMGN, BullX, Trojan, Phantom (list will grow).

Terminals are identified on-chain by their **platform fee accounts** — every trade
placed through a terminal pays a fee to a known wallet. A "trader" = a unique wallet
whose transaction paid one of those fee accounts in the window.

- Maintain the fee-account registry as a config file: `config/terminals.json`
  `[{ "name": "Axiom", "color": "#9945FF", "feeAccounts": ["..."] }, ...]`
- Source the current fee addresses from Dune community mappings (adam_tehc's
  "Trading Bots on Solana" dashboard is the reference; also dune spellbook
  `dex_solana.bot_trades` for older bots). Verify addresses before shipping —
  do not trust any single blog post.
- Terminals rotate/add fee accounts. Registry updates must be a one-line change.

## Frontend data contract

The frontend expects these endpoints (stubs referenced in `index.html` CONFIG):

### 1. GET `/.netlify/functions/market-stats?window=5m|1h|6h|24h`
```json
{
  "window": "1h",
  "traders": 41200,        "tradersTyp": 36500,
  "tx": 1460000,           "txTyp": 1280000,
  "vol": 168000000,        "volTyp": 151000000,
  "created": 1290,         "createdTyp": 1080,
  "migrated": 21,          "migratedTyp": 15,
  "terminals": [
    { "name": "Axiom", "traders": 15600, "tx": 552000, "vol": 63800000, "share": 0.38 }
  ],
  "asOf": "2026-07-14T21:04:00Z"
}
```
`*Typ` values = the 7-day average for the SAME window at the SAME time of day
(hour-of-day + day-of-week matched). This is what powers every "vs typical" delta
and the heat score. Compute and cache these server-side.

### 2. GET `/.netlify/functions/history`
Last 5 complete days of terminal volume: `{ "days": [{ "t": 1720900800000, "v": 3190000000 }] }`

### 3. Heartbeat — client-side, no function needed
`getRecentPerformanceSamples` + `getSlot` polled every 10s directly from the browser
against a Helius RPC endpoint (env: `HELIUS_RPC_URL`; fine to expose a rate-limited
public RPC URL, but prefer a domain-restricted Helius key).
The pulse conveyor eases toward each new tps reading (see `nextSample()` — demo
generator gets replaced by ease-toward-target of live tps).
The SLOW/TYPICAL/BUSY/FRENZY scale must self-calibrate: TYPICAL = rolling 24h avg
tps, SLOW = 0.5×, BUSY = 1.55×, FRENZY = 1.95×, CEIL = 2.2×.

### 4. SOL price
CoinGecko simple price, client-side, already wired in an earlier iteration — keep free tier, 5-min poll.

## Data pipeline (build in this order)

### Phase 1 — Dune (1h / 6h / 24h stats)
- One Dune SQL query over Solana DEX trades filtered to the fee-account registry:
  unique signers, tx count, USD volume, grouped by terminal and window.
- Second query (or same, extended) for tokens created / migrated:
  pump.fun + other launchpad create & migrate instructions.
- Netlify **scheduled function** runs the queries every 5–10 min (stay inside Dune
  free/plus tier credits), writes results to Netlify Blobs (or a JSON cache).
- `market-stats` function serves from cache. Never call Dune per page load.
- Compute `*Typ` baselines from a rolling 7-day Dune query, cached hourly.
- Known limitation: Dune Solana ingestion lags minutes; that's fine for 1h+.

### Phase 2 — Live 5-minute window
- **Helius webhooks** on the fee-account registry → serverless endpoint →
  rolling unique-signer sets + counters in Upstash Redis (5m granularity buckets).
- **PumpPortal free WebSocket** (or Helius webhook on pump.fun program) for
  real-time token created / migrated events → same Redis counters.
- `market-stats?window=5m` reads Redis instead of the Dune cache.
- If Redis/webhooks are not yet configured, `5m` should return an honest
  `{ "unavailable": true }` and the frontend shows its "add key" state — never
  fabricate live numbers.

### Phase 3 — Heat score (server-side, in market-stats)
```
heat = clamp(0..100,
    50
  + 42 * w_t * ln(traders/tradersTyp)
  + 28 * w_v * ln(vol/volTyp)
  + 18 * w_c * ln(created/createdTyp)
  + 12 * w_m * ln(migrated/migratedTyp))
```
with w_* = 1 (tunable). ln() keeps symmetry (2× typical ≈ same distance as 0.5×).
Return `heat` in the payload; frontend zones: <25 Cold, <45 Quiet, <70 Active,
<88 Hot, else Frenzy. Traders weighted heaviest by design — it is the owner's
core "is it worth it" signal.

## Env vars (Netlify)
- `DUNE_API_KEY`
- `HELIUS_API_KEY` / `HELIUS_RPC_URL`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `HELIUS_WEBHOOK_SECRET` (verify webhook signatures)

## Hard rules
- Never expose API keys client-side; all keyed calls go through functions.
- Never fabricate data. Estimated values must be labeled `est` in the UI;
  unavailable values show the explicit unavailable state.
- Do not redesign the frontend. Visual changes only if wiring strictly requires
  them, and keep the existing design tokens (CSS vars in `:root`).
- Keep the demo mode: if all fetches fail, the page falls back to simulated
  data with the amber "demo data" badge — this already exists conceptually,
  preserve the pattern when replacing demo code.
- Respect `prefers-reduced-motion` (already implemented — don't break it).

## Repo layout to create
```
/index.html                  ← the approved frontend (do not restyle)
/config/terminals.json       ← fee-account registry
/netlify/functions/
   market-stats.ts
   history.ts
   dune-refresh.ts           ← scheduled, fills the cache
   helius-webhook.ts         ← phase 2
/netlify.toml
CLAUDE.md                    ← this file
```

## Testing checklist
- [ ] `market-stats` returns valid JSON for all four windows
- [ ] Deltas match hand-checked Dune dashboard values for the same period
- [ ] Terminal shares sum to ~1.0
- [ ] 5m window updates within seconds of a webhook event
- [ ] Kill all keys → page degrades to demo mode with badge, no console spam
- [ ] Heat score responds sensibly at 0.5× and 2× typical inputs
