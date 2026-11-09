/** Runs one sync for one connection: scrape -> map -> dedupe -> push to Sure. */
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { logger } from "./log.js";
import { MfaBroker } from "./mfa.js";
import type { BankTransaction } from "./models.js";
import { PROVIDERS, ProviderError, snapshot, type DateRange, type ProviderContext } from "./providers/index.js";
import { pushTransactions } from "./push.js";
import { emptyStats, type RunStore } from "./runs.js";
import type { ConfigStore, Connection, Settings } from "./store.js";
import { SureError } from "./sureClient.js";

const log = logger("runner");
const DEBUG_DIRS_KEPT = 30;
/**
 * Debug tools (visible browser, network capture, kept downloads) only exist
 * when the process runs with SURE_SYNC_DEBUG=1, and only for runs started as
 * debug runs. Normal runs are always headless.
 */
export const DEBUG_TOOLS = process.env.SURE_SYNC_DEBUG === "1";
/** Debug runs: open the Playwright Inspector on failure instead of closing the browser. */
const PAUSE_ON_ERROR = process.env.SURE_SYNC_PAUSE_ON_ERROR === "1";
const RUNS_KEPT = 500;

export class AlreadyRunning extends Error {}

export interface RunOptions {
  dryRun?: boolean;
  discover?: boolean;
  /** visible, slowed-down browser + capture; dry run. Ignored unless DEBUG_TOOLS. */
  debug?: boolean;
}

interface RunFlags {
  dryRun: boolean;
  discover: boolean;
  debug: boolean;
}
export class UnknownConnection extends Error {}

/**
 * "https://host/path?secret=1#/route?sessionId=x" -> "https://host/path#/route".
 * Query strings (including ones inside SPA hash routes) can hold session tokens.
 */
export function navLabel(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.hash.split("?")[0]}`;
  } catch {
    return raw;
  }
}

/** Log every top-level navigation (incl. in-app hash routes and new tabs) to the run log. */
function trackNavigation(browser: BrowserContext, rlog: (m: string) => void): void {
  let last = "";
  const watch = (page: Page, tab: number) => {
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const label = navLabel(frame.url());
      if (label === last || label === "about:blank") return;
      last = label;
      rlog(`nav${tab > 0 ? ` [tab ${tab}]` : ""}: ${label}`);
    });
  };
  browser.pages().forEach(watch);
  browser.on("page", (page) => {
    const tab = browser.pages().indexOf(page);
    if (tab > 0) rlog(`new tab ${tab} opened`);
    watch(page, tab);
  });
}

class Semaphore {
  #free: number;
  #waiters: (() => void)[] = [];
  constructor(n: number) {
    this.#free = n;
  }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((r) => this.#waiters.push(r));
    try {
      return await fn();
    } finally {
      const next = this.#waiters.shift();
      if (next) next();
      else this.#free++;
    }
  }
}

/** Today in `tz` as YYYY-MM-DD, and `days` before it. */
export function dateRange(tz: string, days: number, now = new Date()): DateRange {
  const until = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const d = new Date(`${until}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return { since: d.toISOString().slice(0, 10), until };
}

export class Runner {
  readonly #running = new Set<string>();
  readonly #browsers: Semaphore;

  constructor(
    private readonly store: ConfigStore,
    private readonly runs: RunStore,
    readonly mfa: MfaBroker,
    private readonly dataDir: string,
    maxConcurrent = 2,
  ) {
    this.#browsers = new Semaphore(maxConcurrent);
  }

  isRunning(connectionId: string): boolean {
    return this.#running.has(connectionId);
  }

  /**
   * Run a sync to completion. Returns the run id.
   * - `dryRun` defaults to the global setting.
   * - `discover`: log in and record the accounts the bank exposes; no transactions, nothing written.
   */
  async run(
    connectionId: string,
    trigger: "schedule" | "manual" = "schedule",
    opts: RunOptions = {},
  ): Promise<number> {
    const conn = this.store.connection(connectionId);
    if (!conn) throw new UnknownConnection(connectionId);
    if (this.#running.has(connectionId)) throw new AlreadyRunning(connectionId);
    this.#running.add(connectionId);
    try {
      const settings = this.store.settings();
      const debug = DEBUG_TOOLS && (opts.debug ?? false);
      const discover = opts.discover ?? false;
      const dryRun = discover || debug || (opts.dryRun ?? settings.dryRun);
      const runId = this.runs.start(connectionId, conn.userName, discover ? "discover" : trigger, dryRun);
      await this.#run(runId, conn, settings, { dryRun, discover, debug });
      return runId;
    } finally {
      this.#running.delete(connectionId);
    }
  }

  /** Fire and forget (used by "Run now"). */
  startBackground(connectionId: string, opts: RunOptions = {}): void {
    if (this.isRunning(connectionId)) return;
    this.run(connectionId, "manual", opts).catch((e) => {
      if (!(e instanceof AlreadyRunning)) log.error(`background run of ${connectionId} failed`, e);
    });
  }

  async #run(runId: number, conn: Connection, settings: Settings, flags: RunFlags): Promise<void> {
    const { dryRun, discover } = flags;
    const rlog = (msg: string) => {
      log.info(`[${conn.id} #${runId}] ${msg}`);
      const t = new Date().toLocaleTimeString("en-GB", { timeZone: settings.timezone, hour12: false });
      this.runs.appendLog(runId, `${t} ${msg}`);
    };
    const stats = emptyStats();
    const debugDir = join(this.dataDir, "debug", `run-${runId}`);
    try {
      if (!settings.sureUrl) throw new ProviderError("Sure URL is not set: open Settings in the web UI");
      const def = PROVIDERS[conn.provider];
      if (!def) throw new ProviderError(`unknown provider ${JSON.stringify(conn.provider)}`);
      const creds = this.store.credentials(conn.id);
      const missing = def.credentialFields.filter((f) => !creds[f.key]).map((f) => f.label);
      if (missing.length) throw new ProviderError(`missing credentials: ${missing.join(", ")}`);

      const range = dateRange(settings.timezone, conn.lookbackDays ?? settings.lookbackDays);
      if (flags.debug) rlog("DEBUG RUN: visible browser, network capture and downloads kept; nothing written to Sure");
      if (discover) rlog("DISCOVER: listing accounts only, no transactions fetched");
      else if (dryRun) rlog("DRY RUN: nothing will be written to Sure");
      rlog(`waiting for browser slot (${conn.provider}, ${range.since} → ${range.until})`);
      const txns = await this.#browsers.use(() =>
        this.#scrape(runId, conn, settings, creds, debugDir, range, rlog, flags),
      );
      if (discover) {
        const n = this.store.bankAccounts(conn.id).length;
        this.runs.finish(runId, "success", stats);
        rlog(`done: ${n} accounts known for this connection. Map them on the connection page.`);
        return;
      }
      stats.fetched = txns.length;
      rlog(`fetched ${txns.length} transactions`);

      await pushTransactions({ store: this.store, runs: this.runs }, conn, settings, txns, stats, rlog, dryRun);
      this.runs.finish(runId, "success", stats);
      rlog(
        `done${dryRun ? " (dry run)" : ""}: ${stats.created} ${dryRun ? "would be created" : "new"}, ` +
          `${stats.skipped} already synced, ${stats.unmapped} unmapped`,
      );
    } catch (e) {
      const expected = e instanceof ProviderError || e instanceof SureError;
      const msg = e instanceof Error ? (expected ? e.message : `${e.name}: ${e.message}`) : String(e);
      rlog(`FAILED: ${msg}`);
      if (!expected) log.error(`run ${runId} crashed`, e);
      this.runs.finish(runId, "failed", stats, msg);
    } finally {
      this.runs.prune(RUNS_KEPT);
      await this.#pruneDebug();
    }
  }

  async #scrape(
    runId: number,
    conn: Connection,
    settings: Settings,
    credentials: Record<string, string>,
    debugDir: string,
    range: DateRange,
    rlog: (m: string) => void,
    flags: RunFlags,
  ): Promise<BankTransaction[]> {
    const { discover, debug } = flags;
    const profile = join(this.dataDir, "browser", conn.id);
    await mkdir(profile, { recursive: true });
    const browser = await chromium.launchPersistentContext(profile, {
      headless: !debug,
      slowMo: debug ? Number(process.env.SURE_SYNC_SLOWMO ?? 150) : undefined,
      acceptDownloads: true,
      locale: "en-AU",
      timezoneId: settings.timezone,
      viewport: { width: 1366, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
    });

    trackNavigation(browser, rlog);

    const ctx: ProviderContext = {
      connectionId: conn.id,
      credentials,
      options: conn.options,
      browser,
      debugDir,
      debug,
      log: rlog,
      requestMfa: async (prompt) => {
        rlog(`waiting for MFA code: ${prompt}`);
        this.runs.setStatus(runId, "awaiting_mfa");
        try {
          return await this.mfa.request(conn.id, runId, prompt, settings.mfaTimeoutSeconds * 1000);
        } finally {
          this.runs.setStatus(runId, "running");
        }
      },
    };
    const provider = PROVIDERS[conn.provider]!.create(ctx);
    try {
      await provider.login();
      rlog("logged in");
      if (provider.listAccounts) {
        const accounts = await provider.listAccounts();
        this.store.recordBankAccounts(conn.id, accounts);
        rlog(`found ${accounts.length} accounts: ${accounts.map((a) => `${a.name} (${a.id})`).join(", ")}`);
      } else if (discover) {
        throw new ProviderError(`${conn.provider} can't list accounts; do a dry run instead to find them`);
      }
      const txns = discover ? [] : await provider.fetchTransactions(range);
      await provider.logout?.().catch((e: Error) => rlog(`logout failed (ignored): ${e.message}`));
      return txns;
    } catch (e) {
      await snapshot(ctx, "failure");
      if (debug && PAUSE_ON_ERROR) {
        rlog(`paused on error for inspection: ${(e as Error).message}. Press Resume in the Playwright Inspector to finish.`);
        await browser.pages()[0]?.pause();
      }
      throw e;
    } finally {
      await browser.close();
    }
  }

  async #pruneDebug(): Promise<void> {
    const root = join(this.dataDir, "debug");
    const dirs = await readdir(root).catch(() => [] as string[]);
    const old = dirs
      .filter((d) => /^run-\d+$/.test(d))
      .sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)))
      .slice(DEBUG_DIRS_KEPT);
    await Promise.all(old.map((d) => rm(join(root, d), { recursive: true, force: true })));
  }
}
