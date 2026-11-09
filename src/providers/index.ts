import { amex } from "./amex.js";
import { anz } from "./anz.js";
import type { ProviderDefinition } from "./base.js";
import { demo } from "./demo.js";

export const PROVIDERS: Record<string, ProviderDefinition> = Object.fromEntries(
  [anz, amex, demo].map((p) => [p.name, p]),
);

export * from "./base.js";
