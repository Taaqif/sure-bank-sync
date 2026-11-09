/** Interface every bank provider implements. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page, Request } from "playwright";
import type { BankAccount, BankTransaction } from "../models.js";

/** Expected failure (bad password, site changed, locked out...). Shown as-is in the UI. */
export class ProviderError extends Error {}
export class AuthError extends ProviderError {}

export interface CredentialField {
  key: string;
  label: string;
  secret?: boolean;
}

export interface ProviderContext {
  connectionId: string;
  credentials: Record<string, string>;
  options: Record<string, unknown>;
  /** persistent per-connection browser profile (cookies kept between runs) */
  browser: BrowserContext;
  /** screenshots/HTML dumps for this run */
  debugDir: string;
  /** debug run: capture network, keep downloaded files in debugDir */
  debug: boolean;
  log: (msg: string) => void;
  /** prompt -> code typed into the web UI */
  requestMfa: (prompt: string) => Promise<string>;
  /**
   * Hand `page` to a person through the web UI's remote browser view (e.g. to
   * solve a CAPTCHA). Resolves when `until` returns true or they click Done.
   */
  requestBrowserHelp: (page: Page, prompt: string, until?: () => Promise<boolean>, opts?: BrowserHelpOptions) => Promise<void>;
}

export interface BrowserHelpOptions {
  /** how long to wait for the person (default: the MFA timeout setting) */
  timeoutMs?: number;
  /** label of the browser view's "Done" button */
  doneLabel?: string;
}

export const pause = (min: number, max: number) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

/**
 * Analytics, telemetry and bot-sensor calls that never stop on bank sites.
 * Waiting for them to finish ("networkidle") always runs into the timeout.
 */
const BACKGROUND_TRAFFIC =
  /beacon|analytics|collect|pixel|telemetry|metrics|tracking|tagging|consent|sumologic|dynatrace|omns\.|demdex|adobe|doubleclick|googletag|google-analytics|newrelic|nr-data|datadog|sentry|hotjar|akam\/|_sec\/|\/bf$|report\/errors|\/v4\/|\/MS-/i;

/**
 * Wait for the page to finish loading its own data: no page, XHR or fetch
 * request in flight (ignoring background traffic) for `quietMs`, at most
 * `maxMs`. Then a short human-like pause.
 */
export async function settle(page: Page, opts: { maxMs?: number; quietMs?: number } = {}): Promise<void> {
  const maxMs = opts.maxMs ?? 8_000;
  const quietMs = opts.quietMs ?? 500;
  const deadline = Date.now() + maxMs;
  const inflight = new Set<Request>();
  const onStart = (r: Request) => {
    if (["document", "xhr", "fetch"].includes(r.resourceType()) && !BACKGROUND_TRAFFIC.test(r.url())) inflight.add(r);
  };
  const onEnd = (r: Request) => inflight.delete(r);
  page.on("request", onStart);
  page.on("requestfinished", onEnd);
  page.on("requestfailed", onEnd);
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: maxMs }).catch(() => {});
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if (inflight.size) quietSince = Date.now();
      else if (Date.now() - quietSince >= quietMs) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    page.off("request", onStart);
    page.off("requestfinished", onEnd);
    page.off("requestfailed", onEnd);
  }
  await pause(300, 700);
}

/** Save screenshot + HTML of every open page. Call liberally when debugging selectors. */
export async function snapshot(ctx: ProviderContext, name: string): Promise<void> {
  await mkdir(ctx.debugDir, { recursive: true });
  for (const [i, page] of ctx.browser.pages().entries()) {
    try {
      // Full-page capture briefly resizes the page; skip it when a person is using the window.
      await page.screenshot({ path: join(ctx.debugDir, `${name}-${i}.png`), fullPage: !ctx.debug });
      await writeFile(join(ctx.debugDir, `${name}-${i}.html`), await page.content());
    } catch (e) {
      ctx.log(`snapshot ${name} failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Save every JSON response from matching hosts into <debugDir>/network/.
 * Used to learn a bank's internal API during development. Response bodies
 * only (no request headers/cookies). Returns a counter of files saved.
 */
export function captureJson(ctx: ProviderContext, hostPattern: RegExp): { count: number } {
  const state = { count: 0 };
  const dir = join(ctx.debugDir, "network");
  ctx.browser.on("response", async (res) => {
    try {
      const url = new URL(res.url());
      if (!hostPattern.test(url.host)) return;
      if (!(res.headers()["content-type"] ?? "").includes("json")) return;
      const body = await res.text();
      const n = String(++state.count).padStart(3, "0");
      const slug = (url.pathname + url.hash).replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 80);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${n}-${res.request().method()}-${slug}.json`),
        JSON.stringify({ url: res.url(), status: res.status(), body: safeJson(body.slice(0, 2_000_000)) }, null, 2),
      );
    } catch {
      // page closed mid-response etc.; capture is best-effort
    }
  });
  return state;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface DateRange {
  /** YYYY-MM-DD inclusive */
  since: string;
  /** YYYY-MM-DD inclusive */
  until: string;
}

export interface BankProvider {
  /** Get to an authenticated state. Use ctx.requestMfa() for OTPs. */
  login(): Promise<void>;
  /** Every account this login can see (so it can be mapped even before it has transactions). */
  listAccounts?(): Promise<BankAccount[]>;
  /** All transactions across all accounts within the range. */
  fetchTransactions(range: DateRange): Promise<BankTransaction[]>;
  logout?(): Promise<void>;
}

export type SyncPeriod =
  | { choices: number[]; default: number; note?: string }
  | { fixed: string; label: string };

export interface ProviderDefinition {
  /** stored provider id */
  name: string;
  /** shown in the UI */
  label: string;
  /** login fields the UI asks for; all are required */
  credentialFields: CredentialField[];
  /**
   * How much history a run fetches. Either day choices that make sense for
   * this bank (with a default), or `fixed`: the bank decides, explained in a
   * short note shown instead of the picker.
   */
  syncPeriod: SyncPeriod;
  /** where a Train recording starts when it isn't logging in first */
  startUrl?: string;
  create(ctx: ProviderContext): BankProvider;
}
