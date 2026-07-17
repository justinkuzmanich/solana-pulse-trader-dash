#!/usr/bin/env node
/**
 * DEBUG TOOL — polls the production Netlify Blobs store directly (bypassing
 * the deployed site's HTTP endpoints entirely) to watch dune-refresh's
 * "state" and "stats" blobs change in near-real-time. Useful when diagnosing
 * why the live site isn't updating, without waiting on function log UI or
 * asking someone to keep refreshing the dashboard.
 *
 *   NETLIFY_AUTH_TOKEN=<personal access token> node scripts/watch-refresh.mjs
 *
 * Requires a Netlify auth token with access to the site (the CLI's own
 * token works — see NETLIFY_AUTH_TOKEN in your shell env after `netlify login`).
 */
import { getStore } from "@netlify/blobs";
const SITE_ID = process.env.NETLIFY_SITE_ID || "e5f7529f-5b8c-4933-a9cb-bb36bd4fcda3";
const store = getStore({ name: "trade-pulse", siteID: SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
let lastSeen = "";
for (;;) {
  const state = await store.get("state", { type: "json" });
  const stats = await store.get("stats", { type: "json" });
  const line = JSON.stringify({ state, statsAsOf: stats?.asOf, statsUpdated: stats?.updatedAt, oneHourTraders: stats?.windows?.["1h"]?.traders });
  if (line !== lastSeen) {
    console.log(new Date().toISOString(), line);
    lastSeen = line;
  }
  await new Promise((r) => setTimeout(r, 15000));
}
