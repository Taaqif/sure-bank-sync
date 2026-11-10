import { amex } from "./amex.js";
import { anz } from "./anz.js";
import { ALL_TIME, ALL_TIME_DAYS, type ProviderDefinition } from "./base.js";
import { commbank } from "./commbank.js";
import { demo } from "./demo.js";
import { macquarie } from "./macquarie.js";
import { stake } from "./stake.js";

export const PROVIDERS: Record<string, ProviderDefinition> = Object.fromEntries(
  [anz, amex, commbank, macquarie, stake, demo].map((p) => [p.name, p]),
);

/**
 * Days of history a connection fetches: its own choice, else its bank's
 * default. Banks with a fixed period still get a nominal range (for logs).
 */
export function syncDays(conn: { provider: string; lookbackDays: number | null }): number {
  const p = PROVIDERS[conn.provider]?.syncPeriod;
  if (!p || "fixed" in p) return 31;
  if (conn.lookbackDays === ALL_TIME) return p.allTime ? ALL_TIME_DAYS : p.default;
  return conn.lookbackDays ?? p.default;
}

/** "last 14 days" / "current statement" */
export function syncLabel(conn: { provider: string; lookbackDays: number | null }): string {
  const p = PROVIDERS[conn.provider]?.syncPeriod;
  if (p && "fixed" in p) return p.label;
  return syncDays(conn) === ALL_TIME_DAYS ? "all time" : `last ${syncDays(conn)} days`;
}

export * from "./base.js";
