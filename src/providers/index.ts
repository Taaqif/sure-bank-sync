import { amex } from "./amex.js";
import { anz } from "./anz.js";
import type { ProviderDefinition } from "./base.js";
import { demo } from "./demo.js";
import { macquarie } from "./macquarie.js";

export const PROVIDERS: Record<string, ProviderDefinition> = Object.fromEntries(
  [anz, amex, macquarie, demo].map((p) => [p.name, p]),
);

/**
 * Days of history a connection fetches: its own choice, else its bank's
 * default. Banks with a fixed period still get a nominal range (for logs).
 */
export function syncDays(conn: { provider: string; lookbackDays: number | null }): number {
  const p = PROVIDERS[conn.provider]?.syncPeriod;
  if (!p || "fixed" in p) return 31;
  return conn.lookbackDays ?? p.default;
}

/** "last 14 days" / "current statement" */
export function syncLabel(conn: { provider: string; lookbackDays: number | null }): string {
  const p = PROVIDERS[conn.provider]?.syncPeriod;
  return p && "fixed" in p ? p.label : `last ${syncDays(conn)} days`;
}

export * from "./base.js";
