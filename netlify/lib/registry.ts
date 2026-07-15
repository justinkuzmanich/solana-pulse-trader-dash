// esbuild inlines the registry at bundle time — one source of truth with the SQL generator.
import registry from "../../config/terminals.json";

export type Terminal = { name: string; color: string; feeAccounts: string[]; retiredFeeAccounts?: string[] };

export const TERMINALS: Terminal[] = (registry as any).terminals;
export const TERMINAL_NAMES: string[] = TERMINALS.map((t) => t.name);
