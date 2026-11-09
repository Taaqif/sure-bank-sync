/** Runs one sync for one connection: scrape -> map -> dedupe -> push to Sure. */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { logger } from "./log.js";
import { virtualDisplay } from "./display.js";
import { MfaBroker } from "./mfa.js";
import { RemoteHub } from "./remote.js";
import { maskAccountId, type BankTransaction } from "./models.js";
import { PROVIDERS, syncDays, ProviderError, snapshot, type DateRange, type ProviderContext } from "./providers/index.js";
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
/** The run was cancelled from the UI. */
export class Cancelled extends Error {}

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

const BROWSER_LOG_MAX = 5000;

/**
 * Console messages and network requests from a run's browser, kept in memory
 * and written next to the debug screenshots (console.txt, network.txt).
 * Network lines have no headers, cookies or bodies, and URLs lose their query.
 */
function recordBrowser(browser: BrowserContext, timezone: string) {
  const consoleLines: string[] = [];
  const network: string[] = [];
  const now = () => new Date().toLocaleTimeString("en-GB", { timeZone: timezone, hour12: false });
  const push = (list: string[], line: string) => {
    if (list.length < BROWSER_LOG_MAX) list.push(line);
    else if (list.length === BROWSER_LOG_MAX) list.push("… (log truncated)");
  };
  const tabOf = (page: Page) => {
    const i = browser.pages().indexOf(page);
    return i > 0 ? ` [tab ${i}]` : "";
  };
  const watch = (page: Page) => {
    page.on("console", (m) => {
      const loc = m.location();
      const where = loc.url ? ` (${navLabel(loc.url)}:${loc.lineNumber})` : "";
      push(consoleLines, `${now()}${tabOf(page)} ${m.type().padEnd(7)} ${m.text().replace(/\s+/g, " ").slice(0, 2000)}${where}`);
    });
    page.on("pageerror", (e) => push(consoleLines, `${now()}${tabOf(page)} pageerror ${e.message.replace(/\s+/g, " ").slice(0, 2000)}`));
  };
  browser.pages().forEach(watch);
  browser.on("page", watch);

  const skip = (url: string) => url.startsWith("data:") || url.startsWith("blob:");
  browser.on("requestfinished", async (req) => {
    if (skip(req.url())) return;
    const res = await req.response().catch(() => null);
    const ms = Math.round(req.timing().responseEnd);
    push(network, `${now()} ${req.method().padEnd(6)} ${String(res?.status() ?? "-").padEnd(3)} ${req.resourceType().padEnd(10)} ${ms >= 0 ? `${ms}ms`.padStart(7) : "      -"} ${navLabel(req.url())}`);
  });
  browser.on("requestfailed", (req) => {
    if (skip(req.url())) return;
    push(network, `${now()} ${req.method().padEnd(6)} ERR ${req.resourceType().padEnd(10)}       - ${navLabel(req.url())} (${req.failure()?.errorText ?? "failed"})`);
  });

  return {
    /** Latest lines, for the live browser view. */
    tail(n: number): { console: string[]; network: string[] } {
      return { console: consoleLines.slice(-n), network: network.slice(-n) };
    },
    async write(dir: string, withNetwork: boolean): Promise<void> {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "console.txt"), consoleLines.join("\n") + "\n");
      if (withNetwork) await writeFile(join(dir, "network.txt"), network.join("\n") + "\n");
    },
  };
}

class Semaphore {
  #free: number;
  #waiters: (() => void)[] = [];
  constructor(n: number) {
    this.#free = n;
  }
  /** Run `fn` once a slot is free. Aborting `signal` while queued gives up the place in line. */
  async use<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.#free > 0) this.#free--;
    else {
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          this.#waiters = this.#waiters.filter((w) => w !== waiter);
          reject(signal!.reason);
        };
        this.#waiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
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

interface ActiveRun {
  runId?: number;
  abort: AbortController;
  /** open while scraping; closed on cancel so in-flight browser steps fail fast */
  browser?: BrowserContext;
  /** console + network of the run's browser, while it's open */
  browserLog?: ReturnType<typeof recordBrowser>;
}

export class Runner {
  readonly #active = new Map<string, ActiveRun>();
  /** live browser views for runs waiting on a person */
  readonly remote = new RemoteHub();
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

  /** Is any run in progress? */
  anyRunning(): boolean {
    return this.#active.size > 0;
  }

  isRunning(connectionId: string): boolean {
    return this.#active.has(connectionId);
  }

  /** Console and network lines from a connection's run in progress (for the browser view). */
  liveBrowserLog(connectionId: string, n = 300): { runId?: number; console: string[]; network: string[] } | undefined {
    const active = this.#active.get(connectionId);
    if (!active?.browserLog) return undefined;
    return { runId: active.runId, ...active.browserLog.tail(n) };
  }

  /** Stop a run in progress. Returns false when nothing is running for the connection. */
  cancel(connectionId: string): boolean {
    const active = this.#active.get(connectionId);
    if (!active || active.abort.signal.aborted) return !!active;
    log.info(`cancelling run of ${connectionId}`);
    active.abort.abort(new Cancelled("cancelled from the web UI"));
    this.mfa.cancel(connectionId);
    this.remote.close(connectionId).catch(() => {});
    active.browser?.close().catch(() => {});
    return true;
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
    if (this.#active.has(connectionId)) throw new AlreadyRunning(connectionId);
    const active: ActiveRun = { abort: new AbortController() };
    this.#active.set(connectionId, active);
    try {
      const settings = this.store.settings();
      const debug = DEBUG_TOOLS && (opts.debug ?? false);
      const discover = opts.discover ?? false;
      const dryRun = discover || debug || (opts.dryRun ?? settings.dryRun);
      const runId = this.runs.start(connectionId, conn.userName, discover ? "discover" : trigger, dryRun);
      active.runId = runId;
      await this.#run(runId, conn, settings, { dryRun, discover, debug }, active);
      return runId;
    } finally {
      this.#active.delete(connectionId);
    }
  }

  /** Fire and forget (used by "Run now"). */
  startBackground(connectionId: string, opts: RunOptions = {}): void {
    if (this.isRunning(connectionId)) return;
    this.run(connectionId, "manual", opts).catch((e) => {
      if (!(e instanceof AlreadyRunning)) log.error(`background run of ${connectionId} failed`, e);
    });
  }

  async #run(runId: number, conn: Connection, settings: Settings, flags: RunFlags, active: ActiveRun): Promise<void> {
    const { dryRun, discover } = flags;
    const signal = active.abort.signal;
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

      const range = dateRange(settings.timezone, syncDays(conn));
      if (flags.debug) rlog("DEBUG RUN: visible browser, network capture and downloads kept; nothing written to Sure");
      if (discover) rlog("DISCOVER: listing accounts only, no transactions fetched");
      else if (dryRun) rlog("DRY RUN: nothing will be written to Sure");
      rlog(`waiting for browser slot (${conn.provider}, ${range.since} → ${range.until})`);
      const txns = await this.#browsers.use(
        () => this.#scrape(runId, conn, settings, creds, debugDir, range, rlog, flags, active),
        signal,
      );
      signal.throwIfAborted();
      if (discover) {
        const n = this.store.bankAccounts(conn.id).length;
        this.runs.finish(runId, "success", stats);
        rlog(`done: ${n} accounts known for this connection. Map them on the connection page.`);
        return;
      }
      stats.fetched = txns.length;
      rlog(`fetched ${txns.length} transactions`);

      await pushTransactions({ store: this.store, runs: this.runs, signal }, conn, settings, txns, stats, rlog, dryRun);
      this.runs.finish(runId, "success", stats);
      rlog(
        `done${dryRun ? " (dry run)" : ""}: ${stats.created} ${dryRun ? "would be created" : "new"}, ` +
          `${stats.skipped} already synced, ${stats.unmapped} unmapped`,
      );
    } catch (e) {
      if (signal.aborted) {
        rlog("CANCELLED");
        this.runs.finish(runId, "cancelled", stats, "cancelled from the web UI");
        return;
      }
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
    active: ActiveRun,
  ): Promise<BankTransaction[]> {
    const { discover, debug } = flags;
    const profile = join(this.dataDir, "browser", conn.id);
    await mkdir(profile, { recursive: true });
    // Debug runs: a window on your screen. Other runs: a window on a virtual
    // screen (Xvfb), because some banks block windowless Chrome. Headless only
    // as a fallback when Xvfb isn't available.
    const display = debug ? null : await virtualDisplay();
    rlog(`browser: ${debug ? "visible window" : display ? "window on virtual screen" : "headless (Xvfb not available)"}`);
    const browser = await chromium.launchPersistentContext(profile, {
      headless: !debug && !display,
      env: display ? { ...process.env, DISPLAY: display } : undefined,
      slowMo: debug ? Number(process.env.SURE_SYNC_SLOWMO ?? 150) : undefined,
      acceptDownloads: true,
      locale: "en-AU",
      timezoneId: settings.timezone,
      // Debug: follow the real window so the page scrolls and resizes normally. Otherwise a fixed size.
      viewport: debug ? null : { width: 1366, height: 900 },
      args: [
        "--disable-blink-features=AutomationControlled",
        ...(debug ? ["--window-size=1366,960"] : display ? ["--window-size=1366,1000", "--window-position=0,0"] : []),
      ],
    });
    let closedByUser = false;
    browser.on("close", () => {
      if (!active.abort.signal.aborted && active.browser) closedByUser = true;
    });

    // Playwright waits forever by default; a stuck step should fail instead.
    browser.setDefaultTimeout(30_000);
    browser.setDefaultNavigationTimeout(45_000);
    active.browser = browser;
    if (active.abort.signal.aborted) {
      await browser.close();
      throw active.abort.signal.reason;
    }

    trackNavigation(browser, rlog);
    const browserLog = recordBrowser(browser, settings.timezone);
    active.browserLog = browserLog;
    let failed = false;

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
      requestBrowserHelp: async (page, prompt, until) => {
        rlog(`waiting for you in the browser view: ${prompt}`);
        this.runs.setStatus(runId, "awaiting_mfa");
        await this.remote.open(conn.id, page, prompt);
        const answered = this.mfa.request(conn.id, runId, prompt, settings.mfaTimeoutSeconds * 1000, "browser");
        let waiting = true;
        const watch = until
          ? (async () => {
              while (waiting) {
                await new Promise((r) => setTimeout(r, 1500));
                if (waiting && (await until().catch(() => false))) {
                  rlog("browser step done");
                  this.mfa.submit(conn.id, "done");
                }
              }
            })()
          : Promise.resolve();
        try {
          await answered;
        } finally {
          waiting = false;
          await watch;
          await this.remote.close(conn.id);
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
        const id = (a: { id: string }) => (settings.verboseLogs ? a.id : maskAccountId(a.id));
        rlog(`found ${accounts.length} accounts: ${accounts.map((a) => `${a.name} (${id(a)})`).join(", ")}`);
      } else if (discover) {
        throw new ProviderError(`${conn.provider} can't list accounts; do a dry run instead to find them`);
      }
      const txns = discover ? [] : await provider.fetchTransactions(range);
      await provider.logout?.().catch((e: Error) => rlog(`logout failed (ignored): ${e.message}`));
      return txns;
    } catch (e) {
      failed = true;
      if (active.abort.signal.aborted) throw e;
      if (closedByUser) throw new ProviderError("the browser window was closed before the run finished");
      await snapshot(ctx, "failure");
      if (debug && PAUSE_ON_ERROR) {
        rlog(`paused on error for inspection: ${(e as Error).message}. Press Resume in the Playwright Inspector to finish.`);
        await browser.pages()[0]?.pause();
      }
      throw e;
    } finally {
      if (failed || debug) {
        await browserLog
          .write(debugDir, debug || settings.saveNetworkLog)
          .catch((e: Error) => rlog(`couldn't save browser logs: ${e.message}`));
      }
      active.browser = undefined;
      await browser.close().catch(() => {});
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
