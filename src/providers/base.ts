/** Interface every bank provider implements. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import type { BankTransaction } from "../models.js";

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
  log: (msg: string) => void;
  /** prompt -> code typed into the web UI */
  requestMfa: (prompt: string) => Promise<string>;
}

/** Save screenshot + HTML of every open page. Call liberally when debugging selectors. */
export async function snapshot(ctx: ProviderContext, name: string): Promise<void> {
  await mkdir(ctx.debugDir, { recursive: true });
  for (const [i, page] of ctx.browser.pages().entries()) {
    try {
      await page.screenshot({ path: join(ctx.debugDir, `${name}-${i}.png`), fullPage: true });
      await writeFile(join(ctx.debugDir, `${name}-${i}.html`), await page.content());
    } catch (e) {
      ctx.log(`snapshot ${name} failed: ${(e as Error).message}`);
    }
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
  /** All transactions across all accounts within the range. */
  fetchTransactions(range: DateRange): Promise<BankTransaction[]>;
  logout?(): Promise<void>;
}

export interface ProviderDefinition {
  /** stored provider id */
  name: string;
  /** shown in the UI */
  label: string;
  /** login fields the UI asks for; all are required */
  credentialFields: CredentialField[];
  create(ctx: ProviderContext): BankProvider;
}
