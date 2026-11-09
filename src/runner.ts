/** Runs one sync for one connection: scrape -> map -> dedupe -> push to Sure. */
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { logger } from "./log.js";
import { virtualDisplay } from "./display.js";
import { MfaBroker, MfaTimeout, RETRY, RetryLogin } from "./mfa.js";
import { startRecording } from "./recorder.js";
import { RemoteHub } from "./remote.js";
import { maskAccountId, type BankTransaction } from "./models.js";
import { PROVIDERS, syncDays, ProviderError, snapshot, type DateRange, type ProviderContext } from "./providers/index.js";
import type { BankProvider, ProviderDefinition } from "./providers/base.js";
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
  /** record a person's steps as a named recipe (debug run). Ignored unless DEBUG_TOOLS. */
  train?: TrainOptions;
}

export interface TrainOptions {
  /** recipe name, e.g. "date-filter" */
  recipe: string;
  /** log in with the stored login first, then record; otherwise start at the provider's startUrl */
  login: boolean;
}

/** A person gets this long to record a recipe. */
const TRAIN_TIMEOUT_MS = 30 * 60_000;

interface RunFlags {
  dryRun: boolean;
  discover: boolean;
  debug: boolean;
  train?: TrainOptions;
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

/**
 * Counting lock whose size can change (read on every acquire/release).
 * Waiters are served first come, first served.
 */
export class Slots {
  #used = 0;
  #waiters: (() => void)[] = [];
  constructor(private readonly capacity: () => number) {}

  get used(): number {
    return this.#used;
  }

  /** True when a slot is free right now (no queue). */
  get available(): boolean {
    return this.#waiters.length === 0 && this.#used < this.capacity();
  }

  /** Take a slot, waiting in line if needed. Aborting `signal` gives up the place in line. */
  async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.available) {
      this.#used++;
      return;
    }
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

  release(): void {
    this.#used = Math.max(0, this.#used - 1);
    this.drain();
  }

  /** Hand free slots to waiters (also call after the capacity grows). */
  drain(): void {
    while (this.#waiters.length && this.#used < this.capacity()) {
      this.#used++;
      this.#waiters.shift()!();
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
  /** holds one of the browser slots (false while parked waiting for a person) */
  hasSlot?: boolean;
}

export class Runner {
  readonly #active = new Map<string, ActiveRun>();
  /** live browser views for runs waiting on a person */
  readonly remote = new RemoteHub();
  /**
   * Runs with a browser doing work. Size: the "Browsers at once" setting
   * (or `maxConcurrent` when given, for tests).
   */
  readonly #browsers: Slots;
  /**
   * Runs waiting for a person (code, robot check) hand their slot to the
   * next run while they wait, up to this many (same size); beyond that they
   * keep their slot.
   */
  readonly #parked: Slots;
  /** One run per bank at a time, so a bank never sees two logins at once. */
  readonly #banks = new Map<string, Slots>();

  constructor(
    private readonly store: ConfigStore,
    private readonly runs: RunStore,
    readonly mfa: MfaBroker,
    private readonly dataDir: string,
    maxConcurrent?: number,
  ) {
    const size = () => maxConcurrent ?? this.store.settings().maxBrowsers;
    this.#browsers = new Slots(size);
    this.#parked = new Slots(size);
  }

  /** Call after "Browsers at once" changes, so queued runs can start straight away. */
  capacityChanged(): void {
    this.#browsers.drain();
    this.#parked.drain();
  }

  #bankLock(provider: string): Slots {
    let lock = this.#banks.get(provider);
    if (!lock) this.#banks.set(provider, (lock = new Slots(() => 1)));
    return lock;
  }

  /**
   * While a run waits for a person, give its browser slot to the next run
   * (if fewer than the limit are already parked). Returns a function that
   * takes a slot back afterwards, waiting in line if needed.
   */
  async #park(active: ActiveRun, rlog: (m: string) => void): Promise<() => Promise<void>> {
    if (!active.hasSlot || !this.#parked.available) return async () => {};
    await this.#parked.acquire();
    active.hasSlot = false;
    this.#browsers.release();
    return async () => {
      this.#parked.release();
      if (!this.#browsers.available) rlog("waiting for a browser slot to carry on");
      await this.#browsers.acquire(active.abort.signal);
      active.hasSlot = true;
    };
  }

  /** Is any run in progress? */
  anyRunning(): boolean {
    return this.#active.size > 0;
  }

  /** Run ids in progress (their debug folders are in use). */
  activeRunIds(): number[] {
    return [...this.#active.values()].flatMap((a) => (a.runId ? [a.runId] : []));
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
      const train = DEBUG_TOOLS ? opts.train : undefined;
      const debug = DEBUG_TOOLS && (opts.debug ?? !!train);
      const discover = !train && (opts.discover ?? false);
      const dryRun = discover || debug || (opts.dryRun ?? settings.dryRun);
      const runId = this.runs.start(connectionId, conn.userName, train ? "train" : discover ? "discover" : trigger, dryRun);
      active.runId = runId;
      await this.#run(runId, conn, settings, { dryRun, discover, debug, train }, active);
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
      if (flags.train) rlog(`TRAIN: recording recipe "${flags.train.recipe}"; nothing fetched or written`);
      else if (flags.debug) rlog("DEBUG RUN: visible browser, network capture and downloads kept; nothing written to Sure");
      if (discover) rlog("DISCOVER: listing accounts only, no transactions fetched");
      else if (dryRun) rlog("DRY RUN: nothing will be written to Sure");
      rlog(`${conn.provider}, ${range.since} → ${range.until}`);
      const bank = this.#bankLock(conn.provider);
      if (!bank.available) rlog(`waiting for another ${def.label} run to finish (one per bank at a time)`);
      await bank.acquire(signal);
      let txns: BankTransaction[];
      try {
        if (!this.#browsers.available) rlog("waiting for a browser slot (Settings → Browsers at once)");
        await this.#browsers.acquire(signal);
        active.hasSlot = true;
        this.runs.setStatus(runId, "running");
        try {
          txns = await this.#scrape(runId, conn, settings, creds, debugDir, range, rlog, flags, active);
        } finally {
          if (active.hasSlot) this.#browsers.release();
          active.hasSlot = false;
        }
      } finally {
        bank.release();
      }
      signal.throwIfAborted();
      if (flags.train) {
        this.runs.finish(runId, "success", stats);
        rlog("done: recording saved. The steps are listed on this run's page.");
        return;
      }
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
    // Banks remember a trusted device through this profile's cookies. A new
    // one every run means the data folder isn't kept between runs/containers.
    const saved = await stat(join(profile, "Default")).catch(() => null);
    rlog(
      saved
        ? "using the saved browser from earlier runs (banks should recognise this device)"
        : "new saved browser: the bank sees a new device and may ask to approve this login",
    );
    await mkdir(profile, { recursive: true });
    // Debug runs: a window on your screen. Other runs: a window on a virtual
    // screen (Xvfb), because some banks block windowless Chrome. Headless only
    // as a fallback when Xvfb isn't available.
    const display = debug ? null : await virtualDisplay();
    rlog(`browser: ${debug ? "visible window" : display ? "window on virtual screen" : "headless (Xvfb not available)"}`);
    const browser = await chromium.launchPersistentContext(profile, {
      // Full Chromium for every mode, also headless ("new headless"): it's the
      // only browser in the Docker image, and banks treat it like normal Chrome.
      channel: "chromium",
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
        const resume = await this.#park(active, rlog);
        try {
          return await this.mfa.request(conn.id, runId, prompt, settings.mfaTimeoutSeconds * 1000);
        } finally {
          this.runs.setStatus(runId, "running");
          await resume();
        }
      },
      requestBrowserHelp: async (page, prompt, until, opts) => {
        rlog(`waiting for you in the browser view: ${prompt}`);
        this.runs.setStatus(runId, "awaiting_mfa");
        const resume = await this.#park(active, rlog);
        await this.remote.open(conn.id, page, prompt, opts?.doneLabel);
        const answered = this.mfa.request(conn.id, runId, prompt, opts?.timeoutMs ?? settings.mfaTimeoutSeconds * 1000, "browser");
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
          if ((await answered) === RETRY) throw new RetryLogin("retry pressed in the browser view");
        } finally {
          waiting = false;
          await watch;
          await this.remote.close(conn.id);
          this.runs.setStatus(runId, "running");
          await resume();
        }
      },
    };
    const def = PROVIDERS[conn.provider]!;
    const provider = def.create(ctx);
    try {
      if (flags.train) {
        await this.#train(flags.train, conn, def, provider, ctx, rlog, settings.verboseLogs);
        return [];
      }
      await withRetry(() => provider.login(), rlog);
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

  /** Log in (optional), then record what a person does until they press Finish recording. */
  async #train(
    train: TrainOptions,
    conn: Connection,
    def: ProviderDefinition,
    provider: BankProvider,
    ctx: ProviderContext,
    rlog: (m: string) => void,
    verbose: boolean,
  ): Promise<void> {
    const browser = ctx.browser;
    if (train.login) {
      await withRetry(() => provider.login(), rlog);
      rlog("logged in; recording starts now");
    } else {
      if (!def.startUrl) throw new ProviderError(`${def.label} has no start page; tick "Log in first"`);
      const page = browser.pages()[0] ?? (await browser.newPage());
      await page.goto(def.startUrl, { waitUntil: "domcontentloaded" });
    }
    const secrets = def.credentialFields.filter((f) => f.secret).map((f) => ctx.credentials[f.key]).filter((v): v is string => !!v);
    const recorder = await startRecording(browser, {
      recipe: train.recipe,
      provider: conn.provider,
      connectionId: conn.id,
      dir: ctx.debugDir,
      credentials: ctx.credentials,
      secrets,
      label: navLabel,
      log: verbose ? rlog : () => {},
    });
    try {
      const pages = browser.pages();
      const page = pages[pages.length - 1] ?? (await browser.newPage());
      await ctx.requestBrowserHelp(
        page,
        `Recording "${train.recipe}": do the steps in the bank's page (here or in the browser window), then press Finish recording.`,
        undefined,
        { timeoutMs: TRAIN_TIMEOUT_MS, doneLabel: "Finish recording" },
      );
    } catch (e) {
      if (!(e instanceof MfaTimeout)) throw e;
      rlog("recording time limit reached; saving what was recorded");
    } finally {
      const rec = await recorder.stop();
      if (!verbose) rlog(`train: saved ${rec.steps.length} steps`);
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

/** Retry presses allowed per run, so a stuck page can't loop forever. */
const MAX_RETRIES = 5;

/** Run the login again (from the bank's login page) when a person presses Retry or a provider asks to start over. */
async function withRetry(login: () => Promise<void>, rlog: (m: string) => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await login();
    } catch (e) {
      if (!(e instanceof RetryLogin) || attempt > MAX_RETRIES) throw e;
      rlog(`retrying the login: ${(e as Error).message} (${attempt} of ${MAX_RETRIES})`);
    }
  }
}
