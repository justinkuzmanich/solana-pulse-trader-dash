import { getStore } from "@netlify/blobs";

// One blob store holds everything the functions serve. Keys:
//   stats     — latest windows payload from the main Dune query
//   history   — last 5 complete days of terminal volume
//   baselines — bootstrap "typical" values from the daily Dune baseline query
//   snapshots — rolling log of refresh results (self-computing baselines after 7d)
//   state     — refresh scheduler state + credit ledger
export function pulseStore() {
  return getStore({ name: "trade-pulse", consistency: "strong" });
}

export async function getJSON<T = any>(key: string): Promise<T | null> {
  try {
    return ((await pulseStore().get(key, { type: "json" })) as T) ?? null;
  } catch {
    return null;
  }
}

export async function setJSON(key: string, value: unknown): Promise<void> {
  await pulseStore().setJSON(key, value);
}
