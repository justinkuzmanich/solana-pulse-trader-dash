// GET /.netlify/functions/heartbeat-config — hands the browser its RPC URL for
// the live heartbeat. The Helius key inside this URL is expected to be
// domain-restricted in the Helius dashboard, so exposing it here is deliberate
// and matches CLAUDE.md ("prefer a domain-restricted Helius key").
export default async () => {
  const rpcUrl = process.env.HELIUS_RPC_URL || null;
  return new Response(JSON.stringify(rpcUrl ? { rpcUrl } : { unavailable: true }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
};
