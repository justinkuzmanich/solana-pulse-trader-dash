// GET /.netlify/functions/history — last 5 complete days of terminal volume,
// served from the Blobs cache (filled daily by dune-refresh).
import { getJSON } from "../lib/store";

export default async () => {
  const h: any = await getJSON("history");
  if (!h?.days?.length) {
    // 200 + unavailable flag (not 5xx) so a cold cache doesn't spam the console
    return new Response(JSON.stringify({ unavailable: true, reason: "no data cached yet" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ days: h.days }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
};
