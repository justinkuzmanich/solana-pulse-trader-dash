// Thin Dune API client. Server-side only — the key never reaches the client.
// DUNE_API_BASE override exists for local pipeline tests against a mock server.
const BASE = process.env.DUNE_API_BASE || "https://api.dune.com/api/v1";

function key(): string {
  const k = process.env.DUNE_API_KEY;
  if (!k) throw new Error("DUNE_API_KEY not set");
  return k;
}

async function dune(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "x-dune-api-key": key(), "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dune ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function executeQuery(
  queryId: string,
  performance: "small" | "medium" | "large" = "small"
): Promise<{ execution_id: string }> {
  // Small is the only engine available on the Free plan (confirmed live —
  // Medium/Large require a paid plan) with a hard 2-minute timeout. Every
  // saved query is written to fit that: single reference per expensive CTE.
  return dune(`/query/${queryId}/execute`, {
    method: "POST",
    body: JSON.stringify({ performance }),
  });
}

export type DuneStatus = {
  state: string;
  execution_id: string;
  // present on newer API responses; used for the credit ledger when available
  execution_cost_credits?: number;
  // Dune's actual field names for failure detail are undocumented from here
  // (no network access to verify) — kept as unknown/any so dune-refresh can
  // log whatever comes back rather than silently dropping it.
  error?: unknown;
  [key: string]: unknown;
};

export async function executionStatus(executionId: string): Promise<DuneStatus> {
  return dune(`/execution/${executionId}/status`);
}

export async function executionRows(executionId: string): Promise<Record<string, any>[]> {
  const out: Record<string, any>[] = [];
  let offset = 0;
  const limit = 5000;
  for (;;) {
    const page = await dune(`/execution/${executionId}/results?limit=${limit}&offset=${offset}`);
    const rows = page?.result?.rows ?? [];
    out.push(...rows);
    if (rows.length < limit) return out;
    offset += limit;
  }
}

export const TERMINAL_STATES = new Set([
  "QUERY_STATE_COMPLETED",
  "QUERY_STATE_FAILED",
  "QUERY_STATE_CANCELLED",
  "QUERY_STATE_EXPIRED",
]);
