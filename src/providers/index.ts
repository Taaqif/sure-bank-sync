import { amex } from "./amex.js";
import { anz } from "./anz.js";
import { brighten } from "./brighten.js";
import { ALL_TIME, ALL_TIME_DAYS, DEFAULT_PERIOD_DAYS, type ProviderDefinition } from "./base.js";
import { commbank } from "./commbank.js";
import { demo } from "./demo.js";
import { macquarie } from "./macquarie.js";
import { stake } from "./stake.js";

export const PROVIDERS: Record<string, ProviderDefinition> = Object.fromEntries(
  [anz, amex, brighten, commbank, macquarie, stake, demo].map((p) => [p.name, p]),
);

/** Days of history a connection fetches: its own choice, else the standard default. */
export function syncDays(conn: { provider: string; lookbackDays: number | null }): number {
  const p = PROVIDERS[conn.provider]?.syncPeriod;
  if (!p) return 31;
  if (conn.lookbackDays === ALL_TIME) return p.allTime ? ALL_TIME_DAYS : DEFAULT_PERIOD_DAYS;
  return conn.lookbackDays ?? DEFAULT_PERIOD_DAYS;
}

/** "last 14 days" / "all time" */
export function syncLabel(conn: { provider: string; lookbackDays: number | null }): string {
  return syncDays(conn) === ALL_TIME_DAYS ? "all time" : `last ${syncDays(conn)} days`;
}

export * from "./base.js";
