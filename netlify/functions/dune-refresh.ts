// Scheduled refresh: fills the Blobs cache from Dune. Runs every 5 minutes as a
// cheap tick; actual Dune executions happen only when due, inside a monthly
// credit budget. Two-phase (trigger on one tick, collect on a later tick) so a
// slow Small-engine query never hits the function timeout.
//
// Env: DUNE_API_KEY, DUNE_QUERY_MAIN, DUNE_QUERY_BASELINE
// Tuning: REFRESH_MINUTES (default 120), DUNE_MONTHLY_CREDIT_BUDGET (default 2300)
import { executeQuery, executionStatus, executionRows, TERMINAL_STATES } from "../lib/dune";
import { getJSON, setJSON } from "../lib/store";
import { TERMINAL_NAMES } from "../lib/registry";

type Job = "main" | "baseline";
const JOBS: Job[] = ["main", "baseline"];
// conservative per-run credit estimates, used only as a fallback until the API
// reports an actual (both scan one day of solana.account_activity on Small
// engine, single-pass — real cost confirmed once the first live execution completes)
const EST_CREDITS: Record<Job, number> = { main: 20, baseline: 25 };

const QUERY_ENV: Record<Job, string> = {
  main: "DUNE_QUERY_MAIN",
  baseline: "DUNE_QUERY_BASELINE",
};

export default async () => {
  if (!process.env.DUNE_API_KEY || !process.env.DUNE_QUERY_MAIN) {
    return json({ skipped: "DUNE_API_KEY / DUNE_QUERY_MAIN not configured" });
  }

  const state: any = (await getJSON("state")) ?? {};
  state.pending ??= {};
  state.lastTrigger ??= {};
  const month = new Date().toISOString().slice(0, 7);
  if (state.month !== month) {
    state.month = month;
    state.creditsUsed = 0;
  }
  const log: string[] = [];

  // ---- phase 1: collect finished executions ----
  for (const job of JOBS) {
    const p = state.pending[job];
    if (!p) continue;
    try {
      const st = await executionStatus(p.executionId);
      if (st.state === "QUERY_STATE_COMPLETED") {
        state.creditsUsed += st.execution_cost_credits ?? EST_CREDITS[job];
        const rows = await executionRows(p.executionId);
        await processJob(job, rows, state);
        delete state.pending[job];
        log.push(`${job}: collected ${rows.length} rows`);
      } else if (TERMINAL_STATES.has(st.state)) {
        state.creditsUsed += st.execution_cost_credits ?? 0;
        // Log the full status payload (not just the state name) — the actual
        // field name Dune uses for failure detail is unconfirmed from here
        // (no network access to their docs), so capture everything.
        let resultsError: string | null = null;
        if (st.state !== "QUERY_STATE_COMPLETED") {
          try {
            await executionRows(p.executionId);
          } catch (re: any) {
            resultsError = re.message; // dune()'s thrown Error includes the raw response body
          }
        }
        state.lastError = { job, state: st.state, at: new Date().toISOString(), statusPayload: st, resultsError };
        delete state.pending[job];
        log.push(`${job}: execution ended ${st.state}`);
      } else if (Date.now() - p.startedAt > 20 * 60_000) {
        delete state.pending[job]; // stale — stop tracking, will re-trigger when due
        log.push(`${job}: pending execution stale, dropped`);
      } else {
        log.push(`${job}: still running`);
      }
    } catch (e: any) {
      log.push(`${job}: status/collect error ${e.message}`);
    }
  }

  // ---- phase 2: trigger due jobs within budget ----
  const budget = Number(process.env.DUNE_MONTHLY_CREDIT_BUDGET ?? 2300);
  const cadenceMin = Number(process.env.REFRESH_MINUTES ?? 120);
  const dayMin = 24 * 60;

  // baseline is now a cheap 1-day scan too (see gen-dune-sql.mjs) — runs
  // daily forever, rolling its own 7-day average in processJob below.
  const due: Array<[Job, number, boolean]> = [
    ["main", cadenceMin, true],
    ["baseline", dayMin, true],
  ];

  for (const [job, everyMin, wanted] of due) {
    if (!wanted || state.pending[job]) continue;
    const queryId = process.env[QUERY_ENV[job]];
    if (!queryId) continue;
    const last = state.lastTrigger[job] ?? 0;
    if (Date.now() - last < everyMin * 60_000) continue;
    if (state.creditsUsed + EST_CREDITS[job] > budget) {
      state.lastSkip = { job, reason: "credit budget", at: new Date().toISOString() };
      log.push(`${job}: skipped, credit budget (${state.creditsUsed}/${budget})`);
      continue;
    }
    try {
      const ex = await executeQuery(queryId);
      state.pending[job] = { executionId: ex.execution_id, startedAt: Date.now() };
      state.lastTrigger[job] = Date.now();
      log.push(`${job}: triggered ${ex.execution_id}`);
    } catch (e: any) {
      state.lastError = { job, error: e.message, at: new Date().toISOString() };
      log.push(`${job}: trigger error ${e.message}`);
    }
  }

  await setJSON("state", state);
  // console.log (not just the response body) — nobody reads a scheduled
  // function's HTTP response, so this is the only way to see progress in
  // the Netlify function logs.
  console.log(`[dune-refresh] ${log.length ? log.join(" | ") : "nothing due this tick"} — credits ${state.creditsUsed}/${budget} (${state.month})`);
  if (state.lastError) console.log(`[dune-refresh] lastError:`, JSON.stringify(state.lastError));
  return json({ log, creditsUsed: state.creditsUsed, month: state.month });
};

export const config = { schedule: "*/5 * * * *" };

/* ---------------- result processing ---------------- */

async function processJob(job: Job, rows: Record<string, any>[], state: any) {
  if (job === "main") return processMain(rows);

  // baseline: query returns ONE day's raw per-bucket values (section
  // day_1h/day_6h/day_24h, lday_*) — accumulate into a rolling 7-day array
  // keyed by the day the scan covers, then average across whatever's stored
  // (see gen-dune-sql.mjs for why this is 1-day scoped instead of 7-day).
  const base: any = {};
  const lbase: any = {};
  for (const r of rows) {
    const sec = String(r.section ?? "");
    const bucket = String(r.bucket ?? "");
    if (sec.startsWith("day_")) {
      const win = sec.slice(4);
      (base[win] ??= {})[bucket] = { traders: num(r.traders), tx: num(r.tx), vol: num(r.vol) };
    } else if (sec.startsWith("lday_")) {
      const win = sec.slice(5);
      (lbase[win] ??= {})[bucket] = { created: num(r.created), migrated: num(r.migrated) };
    }
  }

  // the SQL scans "yesterday" relative to when it runs — key by that date
  const scannedDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const days: any[] = ((await getJSON("baselineDays")) ?? [])
    .filter((d: any) => d.day !== scannedDay);
  days.push({ day: scannedDay, base, lbase });
  days.sort((a: any, b: any) => a.day.localeCompare(b.day));
  const trimmed = days.slice(-7);
  await setJSON("baselineDays", trimmed);

  await setJSON("baselines", {
    base: averageAcrossDays(trimmed, "base", ["traders", "tx", "vol"]),
    lbase: averageAcrossDays(trimmed, "lbase", ["created", "migrated"]),
    daysCovered: trimmed.length,
    updatedAt: new Date().toISOString(),
  });
}

/** Averages per-bucket field values across N stored daily readings. */
function averageAcrossDays(days: any[], key: "base" | "lbase", fields: string[]) {
  const sums: Record<string, Record<string, Record<string, number>>> = {};
  const counts: Record<string, Record<string, number>> = {};
  for (const d of days) {
    for (const [win, buckets] of Object.entries<any>(d[key] ?? {})) {
      sums[win] ??= {};
      counts[win] ??= {};
      for (const [bucket, vals] of Object.entries<any>(buckets)) {
        sums[win][bucket] ??= Object.fromEntries(fields.map((f) => [f, 0]));
        counts[win][bucket] = (counts[win][bucket] ?? 0) + 1;
        for (const f of fields) sums[win][bucket][f] += num(vals[f]);
      }
    }
  }
  const out: any = {};
  for (const win of Object.keys(sums)) {
    out[win] = {};
    for (const bucket of Object.keys(sums[win])) {
      const n = counts[win][bucket];
      out[win][bucket] = Object.fromEntries(fields.map((f) => [f, sums[win][bucket][f] / n]));
    }
  }
  return out;
}

async function processMain(rows: Record<string, any>[]) {
  const windows: any = { "1h": emptyWin(), "6h": emptyWin(), "24h": emptyWin() };
  let asOfMs: number | null = null;

  for (const r of rows) {
    const sec = r.section, bucket = String(r.bucket ?? ""), term = r.terminal;
    if (sec !== "window" || !windows[bucket]) continue;
    if (term === "__total__") {
      Object.assign(windows[bucket], { traders: num(r.traders), tx: num(r.tx), vol: num(r.vol) });
      if (r.max_bt != null) asOfMs = Math.max(asOfMs ?? 0, Math.round(Number(r.max_bt) * 1000));
    } else if (term === "__launch__") {
      Object.assign(windows[bucket], { created: num(r.created), migrated: num(r.migrated) });
    } else {
      windows[bucket].terminals.push({ name: term, traders: num(r.traders), tx: num(r.tx), vol: num(r.vol) });
    }
  }

  // every registry terminal appears, zeros for the quiet ones; share of window volume
  for (const win of Object.keys(windows)) {
    const w = windows[win];
    const byName = new Map(w.terminals.map((t: any) => [t.name, t]));
    w.terminals = TERMINAL_NAMES.map(
      (name) => byName.get(name) ?? { name, traders: 0, tx: 0, vol: 0 }
    ).map((t: any) => ({ ...t, share: w.vol > 0 ? t.vol / w.vol : 0 }));
  }

  const asOf = new Date(asOfMs ?? Date.now()).toISOString();
  await setJSON("stats", { asOf, updatedAt: new Date().toISOString(), windows });

  // rolling snapshot log → self-computing "typical" baselines after 7 days
  const snapshots: any[] = ((await getJSON("snapshots")) ?? []).filter(
    (s) => Date.now() - s.t < 14 * 86_400_000
  );
  snapshots.push({
    t: Date.now(),
    asOfMs: asOfMs ?? Date.now(),
    windows: Object.fromEntries(
      Object.entries(windows).map(([k, w]: [string, any]) => [
        k,
        { traders: w.traders, tx: w.tx, vol: w.vol, created: w.created, migrated: w.migrated },
      ])
    ),
  });
  await setJSON("snapshots", snapshots);
}

const emptyWin = () => ({ traders: 0, tx: 0, vol: 0, created: 0, migrated: 0, terminals: [] as any[] });
const num = (v: any) => (v == null ? 0 : Number(v));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
