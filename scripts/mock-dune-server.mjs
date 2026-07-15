#!/usr/bin/env node
/**
 * LOCAL TEST ONLY — a mock of the three Dune API endpoints dune-refresh uses,
 * serving synthetic rows shaped exactly like the generated SQL in /queries.
 * Lets `netlify dev` exercise the full pipeline (refresh → Blobs → endpoints)
 * in sandboxes where api.dune.com is unreachable. Values are fake by design;
 * never point production at this (remove DUNE_API_BASE from env).
 *
 *   node scripts/mock-dune-server.mjs   # listens on :9999
 *   query IDs: 101 = main, 102 = history, 103 = baseline
 */
import { createServer } from "node:http";

const TERMS = ["Axiom", "Photon", "GMGN", "BullX", "Trojan", "Phantom"];
// rough mid-2026 real-world scale (measured via DefiLlama 2026-07-15)
const DAY = { traders: 62000, tx: 210000, vol: 56e6, created: 26000, migrated: 310 };
const SHARE = { Axiom: 0.52, Photon: 0.012, GMGN: 0.08, BullX: 0.0001, Trojan: 0.045, Phantom: 0.34 };
const WINF = { "1h": 1 / 24, "6h": 6 / 24, "24h": 1 };
const jitter = () => 0.85 + Math.random() * 0.3;

function mainRows() {
  const rows = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [win, f] of Object.entries(WINF)) {
    const j = jitter();
    // uniques don't scale linearly with window length; cheap approximation is fine for a mock
    const uniq = Math.pow(f, 0.75);
    rows.push({ ...row("window", win, "__total__", DAY.traders * uniq * j, DAY.tx * f * j, DAY.vol * f * j), max_bt: nowSec - 90 });
    rows.push({ ...row("window", win, "__launch__"), created: Math.round(DAY.created * f * j), migrated: Math.round(DAY.migrated * f * j) });
    for (const t of TERMS) {
      const s = SHARE[t];
      rows.push(row("window", win, t, DAY.traders * uniq * s * j, DAY.tx * f * s * j, DAY.vol * f * s * j));
    }
  }
  return rows;
}

function historyRows() {
  const rows = [];
  const day0 = Math.floor(Date.now() / 86400000) * 86400; // today 00:00 UTC, sec
  for (let d = 5; d >= 1; d--) rows.push({ t: day0 - d * 86400, v: DAY.vol * jitter() });
  return rows;
}

function baselineRows() {
  const rows = [];
  for (let h = 0; h < 24; h++) {
    const shape = 0.7 + 0.5 * Math.sin(((h - 20 + 24) % 24) / 24 * 2 * Math.PI); // US-evening hump
    rows.push(row("base_1h", String(h), "__total__", (DAY.traders / 24) * 2.2 * shape, (DAY.tx / 24) * shape, (DAY.vol / 24) * shape));
    rows.push({ ...row("lbase_1h", String(h), "__launch__"), created: Math.round((DAY.created / 24) * shape), migrated: Math.round((DAY.migrated / 24) * shape) });
  }
  for (let b = 0; b < 4; b++) {
    rows.push(row("base_6h", String(b), "__total__", DAY.traders * 0.42, DAY.tx / 4, DAY.vol / 4));
    rows.push({ ...row("lbase_6h", String(b), "__launch__"), created: Math.round(DAY.created / 4), migrated: Math.round(DAY.migrated / 4) });
  }
  rows.push(row("base_24h", "0", "__total__", DAY.traders, DAY.tx, DAY.vol));
  rows.push({ ...row("lbase_24h", "0", "__launch__"), created: DAY.created, migrated: DAY.migrated });
  return rows;
}

const row = (section, bucket, terminal, traders = null, tx = null, vol = null) => ({
  section, bucket, terminal,
  traders: traders == null ? null : Math.round(traders),
  tx: tx == null ? null : Math.round(tx),
  vol, created: null, migrated: null,
});

const GEN = { 101: mainRows, 102: historyRows, 103: baselineRows };

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
  let m;
  if ((m = url.pathname.match(/^\/api\/v1\/query\/(\d+)\/execute$/))) {
    return send({ execution_id: `mock-${m[1]}-${Date.now()}`, state: "QUERY_STATE_PENDING" });
  }
  if ((m = url.pathname.match(/^\/api\/v1\/execution\/mock-(\d+)-\d+\/status$/))) {
    return send({ execution_id: url.pathname.split("/")[4], state: "QUERY_STATE_COMPLETED", execution_cost_credits: 4 });
  }
  if ((m = url.pathname.match(/^\/api\/v1\/execution\/mock-(\d+)-\d+\/results$/))) {
    const gen = GEN[m[1]];
    if (!gen) { res.statusCode = 404; return send({ error: "unknown mock query" }); }
    const rows = gen();
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 5000);
    return send({ result: { rows: rows.slice(offset, offset + limit) } });
  }
  res.statusCode = 404; send({ error: "not found" });
}).listen(9999, () => console.log("mock Dune API on :9999 (queries 101/102/103)"));
