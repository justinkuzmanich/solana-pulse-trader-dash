// GET /.netlify/functions/market-stats?window=5m|1h|6h|24h
// Serves from the Blobs cache only — never calls Dune per page load.
// *Typ baselines: local snapshot history once it covers 7 days (same window,
// same time of day), else the daily Dune baseline query; null when neither
// exists yet (frontend shows the calibrating state — values are never invented).
import { getJSON } from "../lib/store";

export default async (req: Request) => {
  const url = new URL(req.url);
  const win = url.searchParams.get("window") ?? "1h";
  if (!["5m", "1h", "6h", "24h"].includes(win)) {
    return json({ error: "window must be 5m|1h|6h|24h" }, 400);
  }
  if (win === "5m") {
    // Honest stub until Phase 2 (webhooks + Redis) exists.
    return json({ window: "5m", unavailable: true, reason: "live 5-minute feed not configured" });
  }

  const stats: any = await getJSON("stats");
  if (!stats?.windows?.[win]) {
    // 200 + unavailable flag (not 5xx) so a cold cache doesn't spam the console
    return json({ window: win, unavailable: true, reason: "no data cached yet" });
  }
  const w = stats.windows[win];
  const asOfMs = Date.parse(stats.asOf);

  const typ =
    (await typFromSnapshots(win, asOfMs)) ?? (await typFromBaselines(win, asOfMs));

  const payload: any = {
    window: win,
    traders: w.traders, tradersTyp: typ?.traders ?? null,
    tx: w.tx, txTyp: typ?.tx ?? null,
    vol: w.vol, volTyp: typ?.vol ?? null,
    created: w.created, createdTyp: typ?.created ?? null,
    migrated: w.migrated, migratedTyp: typ?.migrated ?? null,
    terminals: w.terminals,
    asOf: stats.asOf,
    updatedAt: stats.updatedAt,
    typSource: typ?.source ?? null,
    heat: null,
  };
  payload.heat = heatScore(payload);

  return json(payload, 200, { "cache-control": "public, max-age=60" });
};

/* ---- typical values from our own accumulated snapshots (>=7 days) ---- */
async function typFromSnapshots(win: string, asOfMs: number) {
  const snaps: any[] = (await getJSON("snapshots")) ?? [];
  if (!snaps.length) return null;
  const weekAgo = asOfMs - 7 * 86_400_000;
  if (snaps[0].t > weekAgo + 12 * 3_600_000) return null; // not enough coverage yet

  const tod = (ms: number) => Math.floor((ms % 86_400_000) / 60_000); // UTC minutes-of-day
  const target = tod(asOfMs);
  const circDiff = (a: number, b: number) => Math.min(Math.abs(a - b), 1440 - Math.abs(a - b));

  // closest snapshot to the same time-of-day, per prior UTC day
  const byDay = new Map<number, any>();
  for (const s of snaps) {
    if (s.asOfMs < weekAgo || s.asOfMs > asOfMs - 3 * 3_600_000) continue;
    const d = Math.floor(s.asOfMs / 86_400_000);
    const diff = circDiff(tod(s.asOfMs), target);
    if (diff > 75) continue;
    const cur = byDay.get(d);
    if (!cur || diff < cur.diff) byDay.set(d, { diff, w: s.windows?.[win] });
  }
  const vals = [...byDay.values()].map((x) => x.w).filter(Boolean);
  if (vals.length < 4) return null;
  const avg = (k: string) => vals.reduce((a, v) => a + (Number(v[k]) || 0), 0) / vals.length;
  return { traders: avg("traders"), tx: avg("tx"), vol: avg("vol"), created: avg("created"), migrated: avg("migrated"), source: "snapshots" };
}

/* ---- bootstrap typical values from the daily Dune baseline query ---- */
async function typFromBaselines(win: string, asOfMs: number) {
  const b: any = await getJSON("baselines");
  if (!b?.base) return null;
  const hour = new Date(asOfMs).getUTCHours();
  const bucket = win === "1h" ? String(hour) : win === "6h" ? String(Math.floor(hour / 6)) : "0";
  const t = b.base[win]?.[bucket];
  const l = b.lbase?.[win]?.[bucket];
  if (!t) return null;
  return { traders: t.traders, tx: t.tx, vol: t.vol, created: l?.created ?? null, migrated: l?.migrated ?? null, source: "dune-baseline" };
}

/* ---- Phase 3 heat formula (implemented early — the gauge needs it).
   Terms with missing/zero baselines are omitted rather than invented. ---- */
function heatScore(p: any): number | null {
  const term = (v: number, typ: number | null, w: number) =>
    typ && typ > 0 && v > 0 ? w * Math.log(v / typ) : null;
  const t = term(p.traders, p.tradersTyp, 42);
  const v = term(p.vol, p.volTyp, 28);
  if (t == null || v == null) return null; // core signals required
  const c = term(p.created, p.createdTyp, 18) ?? 0;
  const m = term(p.migrated, p.migratedTyp, 12) ?? 0;
  return Math.max(0, Math.min(100, 50 + t + v + c + m));
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
