// Scheduled refresh: fills the Blobs cache from Dune. Runs every 5 minutes as a
// cheap tick; actual Dune executions happen only when due, inside a monthly
// credit budget. Two-phase (trigger on one tick, collect on a later tick) so a
// slow Small-engine query never hits the function timeout.
//
// Env: DUNE_API_KEY, DUNE_QUERY_MAIN, DUNE_QUERY_HISTORY, DUNE_QUERY_BASELINE
// Tuning: REFRESH_MINUTES (default 120), DUNE_MONTHLY_CREDIT_BUDGET (default 2300)
import { executeQuery, executionStatus, executionRows, TERMINAL_STATES } from "../lib/dune";
import { getJSON, setJSON } from "../lib/store";
import { TERMINAL_NAMES } from "../lib/registry";

type Job = "main" | "history" | "baseline";
const JOBS: Job[] = ["main", "history", "baseline"];
// conservative per-run credit estimates, used only as a fallback until the API
// reports an actual (main/baseline scan solana.account_activity on Medium
// engine — real cost confirmed once the first live execution completes)
const EST_CREDITS: Record<Job, number> = { main: 20, history: 15, baseline: 35 };

const QUERY_ENV: Record<Job, string> = {
  main: "DUNE_QUERY_MAIN",
  history: "DUNE_QUERY_HISTORY",
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
        state.lastError = { job, state: st.state, at: new Date().toISOString() };
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

  const snapshots: any[] = (await getJSON("snapshots")) ?? [];
  const coverageDays = snapshots.length
    ? (Date.now() - snapshots[0].t) / 86_400_000
    : 0;

  const due: Array<[Job, number, boolean]> = [
    ["main", cadenceMin, true],
    ["history", dayMin, true],
    // baseline only needed until local snapshots cover 7 days
    ["baseline", dayMin, coverageDays < 7.5],
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
  return json({ log, creditsUsed: state.creditsUsed, month: state.month });
};

export const config = { schedule: "*/5 * * * *" };

/* ---------------- result processing ---------------- */

async function processJob(job: Job, rows: Record<string, any>[], state: any) {
  if (job === "main") return processMain(rows);
  if (job === "history") {
    const days = rows
      .filter((r) => r.t != null && r.v != null)
      .map((r) => ({ t: Number(r.t) * 1000, v: Number(r.v) }))
      .sort((a, b) => a.t - b.t)
      .slice(-5);
    await setJSON("history", { days, updatedAt: new Date().toISOString() });
    return;
  }
  // baseline
  const base: any = {};
  const lbase: any = {};
  for (const r of rows) {
    const sec = String(r.section ?? "");
    const bucket = String(r.bucket ?? "");
    if (sec.startsWith("base_")) {
      const win = sec.slice(5);
      (base[win] ??= {})[bucket] = { traders: num(r.traders), tx: num(r.tx), vol: num(r.vol) };
    } else if (sec.startsWith("lbase_")) {
      const win = sec.slice(6);
      (lbase[win] ??= {})[bucket] = { created: num(r.created), migrated: num(r.migrated) };
    }
  }
  await setJSON("baselines", { base, lbase, updatedAt: new Date().toISOString() });
}

async function processMain(rows: Record<string, any>[]) {
  const windows: any = { "1h": emptyWin(), "6h": emptyWin(), "24h": emptyWin() };
  const hourly: Record<string, any> = {};
  let asOfMs: number | null = null;

  for (const r of rows) {
    const sec = r.section, bucket = String(r.bucket ?? ""), term = r.terminal;
    if (sec === "meta" && bucket === "max_block_time" && r.vol != null) {
      asOfMs = Math.round(Number(r.vol) * 1000);
    } else if (sec === "window" && windows[bucket]) {
      if (term === "__total__") {
        Object.assign(windows[bucket], { traders: num(r.traders), tx: num(r.tx), vol: num(r.vol) });
      } else if (term === "__launch__") {
        Object.assign(windows[bucket], { created: num(r.created), migrated: num(r.migrated) });
      } else {
        windows[bucket].terminals.push({ name: term, traders: num(r.traders), tx: num(r.tx), vol: num(r.vol) });
      }
    } else if (sec === "hourly") {
      const h = (hourly[bucket] ??= { t: Number(bucket) * 1000 });
      if (term === "__total__") Object.assign(h, { traders: num(r.traders), tx: num(r.tx), vol: num(r.vol) });
      else if (term === "__launch__") Object.assign(h, { created: num(r.created), migrated: num(r.migrated) });
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
  await setJSON("stats", {
    asOf,
    updatedAt: new Date().toISOString(),
    windows,
    hourly: Object.values(hourly).sort((a: any, b: any) => a.t - b.t),
  });

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
