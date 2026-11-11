/**
 * ANZ Internet Banking (Australia).
 *
 * Login: login.anz.com SPA (CRN + password, no OTP for this customer),
 * which hands off to https://bankingN.ib.anz.com/IBUI/ (host varies).
 *
 * Navigation is click-based, like a person: home -> account tile ->
 * Transactions tab -> Download. (Opening #/download-transaction directly and
 * pressing Search was silently ignored by the app.)
 *
 * Transactions: for each account, open Download, pick the "Date range" tab,
 * type From/To (DD/MM/YYYY, up to 2 years back), keep "Microsoft
 * Excel(CSV)", click Download and parse the file. If the Date range tab
 * isn't there, the fixed durations (up to 120 days) are used instead.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Download, Page } from "playwright";
import { parseAmount, type BankAccount, type BankTransaction } from "../models.js";
import { parseCsv, dmyDate as anzDate } from "./csv.js";
import { AuthError, ProviderError, captureJson, pause, settle, snapshot, type ProviderContext, type ProviderDefinition } from "./base.js";

const LOGIN_URL = "https://login.anz.com/internetbanking";
const IB_HOST = /^banking\d*\.ib\.anz\.com$/;

/** data-test-id hooks from the live login app (Nov 2026). */
const SEL = {
  crn: "#customerRegistrationNumber",
  password: "#password",
  submit: '[data-test-id="log-in-btn"]',
  /** any of these means login didn't go through; their text is the reason */
  failure: [
    '[data-test-id^="error-message"]',
    '[data-test-id="error-title"]',
    '[data-test-id="lockout-header"]',
    '[data-test-id="anz-plus-app-required"]',
    '[data-test-id="no-longer-use-anz-classic"]',
    '[data-test-id="outage-title"]',
  ].join(", "),
  logout: 'a:has-text("Log out"), button:has-text("Log out"), [data-test-id*="logout" i]',
};

/** Home page account tiles and the account page. */
const HOME = {
  navHome: '[data-test-id="home"] [role="button"]',
  tiles: '[data-test-id^="list-item-home-screen-list-display-"]',
  tile: (i: number) => `[data-test-id="list-item-home-screen-list-display-${i}"]`,
  tileName: '[data-test-id="card-name"]',
  tileNumber: '[data-test-id="card-number"]',
};
const ACCOUNT = {
  download: (page: Page) => page.getByRole("button", { name: /^\s*Download\s*$/i }).first(),
};

/** "Download transactions" page reached from an account's Download button. */
const DOWNLOAD = {
  durationInput: '[data-test-id="drop-down-search-duration1-dropdown-field"]',
  durationOptions: '[data-test-id^="drop-down-search-duration1-dropdown-result-"]',
  softwareInput: '[data-test-id="drop-down-search-software-dropdown-field"]',
  softwareOptions: '[data-test-id^="drop-down-search-software-dropdown-result-"]',
  submit: '[data-test-id="footer-primary-button_button"]',
  dateRangeTab: '[data-testid="Date range"], [role="tab"]:has-text("Date range")',
  from: "#fromdate-textfield",
  to: "#todate-textfield",
  /** where ANZ says what's wrong with the dates: under the boxes, or a banner on top */
  problems: '#fromdate-textfield-message, #todate-textfield-message, #search-alert, [role="alert"]',
};
const CSV_FORMAT = "Microsoft Excel(CSV)";

/** Duration choices offered by ANZ, in days (the fallback when the Date range tab is missing). */
const DURATIONS = [7, 14, 30, 60, 90, 120];
/** ANZ's Date range goes back this far ("You can download up to 2 years of transactions"). */
const MAX_DAYS_BACK = 365 * 2;

/** YYYY-MM-DD -> DD/MM/YYYY (ANZ's date boxes). */
export const anzDmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Today by ANZ's clock (Melbourne). */
export const anzToday = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne" }).format(now);

/**
 * The range ANZ will accept. To must be a past date ("Please enter a past
 * date in Date Range"), so it's yesterday at the latest; From goes back at
 * most 2 years.
 */
export function anzRange(range: { since: string; until: string }, today = anzToday()): { since: string; until: string; notes: string[] } {
  const notes: string[] = [];
  let { since, until } = range;
  const latest = addDays(today, -1);
  if (until > latest) {
    until = latest;
    notes.push(`ANZ only downloads up to yesterday; fetching to ${until}`);
  }
  const earliest = addDays(until, -MAX_DAYS_BACK);
  if (since < earliest) {
    since = earliest;
    notes.push(`ANZ only has 2 years of history; fetching from ${since}`);
  }
  if (since > until) since = until;
  return { since, until, notes };
}

/** Resolve with the next download from any tab (ANZ may post a form into a new tab). */
function nextDownload(browser: BrowserContext, timeout: number): Promise<Download> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProviderError(`ANZ: no file downloaded within ${timeout / 1000}s`)), timeout);
    const hook = (p: Page) =>
      p.once("download", (d) => {
        clearTimeout(timer);
        resolve(d);
      });
    browser.pages().forEach(hook);
    browser.on("page", hook);
  });
}

/**
 * Parse ANZ's "Microsoft Excel(CSV)" export. Handles the classic headerless
 * layout (date, signed amount, description) and a headed layout with
 * separate debit/credit columns.
 */
export function parseAnzCsv(text: string, account: BankAccount): BankTransaction[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];

  let col = { date: 0, amount: 1, debit: -1, credit: -1, desc: 2 };
  if (!anzDate(rows[0]![0] ?? "")) {
    const h = rows.shift()!.map((c) => c.toLowerCase());
    const find = (re: RegExp) => h.findIndex((c) => re.test(c));
    col = {
      date: find(/date/),
      amount: find(/^amount/),
      debit: find(/debit|withdraw/),
      credit: find(/credit|deposit/),
      desc: find(/desc|detail|narrat|remark|particular/),
    };
    if (col.date < 0 || col.desc < 0 || (col.amount < 0 && col.debit < 0 && col.credit < 0)) {
      throw new ProviderError(`ANZ CSV: unrecognised header ${JSON.stringify(h)}`);
    }
  }

  return rows.map((r, i) => {
    const date = anzDate(r[col.date] ?? "");
    if (!date) throw new ProviderError(`ANZ CSV row ${i + 1}: bad date ${JSON.stringify(r[col.date])}`);
    let amountCents: number;
    if (col.amount >= 0) amountCents = parseAmount(r[col.amount] ?? "");
    else {
      const debit = r[col.debit]?.trim() ? Math.abs(parseAmount(r[col.debit]!)) : 0;
      const credit = r[col.credit]?.trim() ? Math.abs(parseAmount(r[col.credit]!)) : 0;
      amountCents = credit - debit;
    }
    return { account, date, amountCents, description: (r[col.desc] ?? "").replace(/\s+/g, " ").trim() };
  });
}

/** Account id from the tile number: whitespace collapsed, e.g. "012345 987654321". */
export function accountIdFromTile(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function daysBetween(since: string, until: string): number {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) + 1;
}

const LOGIN_TIMEOUT = 60_000;

export const anz: ProviderDefinition = {
  name: "anz",
  label: "ANZ Internet Banking",
  credentialFields: [
    { key: "customer_id", label: "Customer Registration Number" },
    { key: "password", label: "Password", secret: true },
  ],
  // The Download page's Date range tab takes any dates up to 2 years back.
  startUrl: LOGIN_URL,
  syncPeriod: { maxDays: MAX_DAYS_BACK, note: "ANZ downloads up to 2 years of history." },
  create: (ctx: ProviderContext) => {
    // Full API responses hold account data: only capture them on debug runs.
    const captured = ctx.debug ? captureJson(ctx, /(^|\.)anz\.com$/) : { count: 0 };
    let page: Page;
    let accountsCache: BankAccount[] | undefined;

    /** Back to the accounts overview by clicking Home (not by URL). */
    async function goHome() {
      if (await page.locator(HOME.tiles).first().isVisible().catch(() => false)) return;
      await page.locator(HOME.navHome).first().click();
      await page.locator(HOME.tiles).first().waitFor({ timeout: 30_000 });
      await settle(page);
    }

    return {
      async login() {
        page = ctx.browser.pages()[0] ?? (await ctx.browser.newPage());
        ctx.log("anz: opening login page");
        await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.locator(SEL.crn).waitFor({ timeout: 30_000 });
        // Bot protection scores time on the login page; type after a person-like pause.
        await pause(5000, 9000);

        // Typed with human-ish delays: the page runs behavioural bot detection.
        await page.locator(SEL.crn).click();
        await page.locator(SEL.crn).pressSequentially(ctx.credentials.customer_id!, { delay: 90 });
        await pause(300, 800);
        await page.locator(SEL.password).click();
        await page.locator(SEL.password).pressSequentially(ctx.credentials.password!, { delay: 80 });
        await pause(400, 900);
        await page.locator(SEL.submit).click();
        ctx.log("anz: credentials submitted");

        const outcome = await Promise.race([
          page
            .waitForURL((u) => IB_HOST.test(u.host) && u.pathname.startsWith("/IBUI"), { timeout: LOGIN_TIMEOUT })
            .then(() => "ok" as const),
          page
            .locator(SEL.failure)
            .first()
            .waitFor({ state: "visible", timeout: LOGIN_TIMEOUT })
            .then(() => "failed" as const),
        ]).catch(() => "timeout" as const);

        if (outcome === "failed") {
          const text = (await page.locator(SEL.failure).allInnerTexts()).join(" ").replace(/\s+/g, " ").trim();
          await snapshot(ctx, "login-failed");
          throw new AuthError(`ANZ login failed: ${text || "unknown error"}`);
        }
        if (outcome === "timeout") {
          throw new ProviderError(`ANZ login did not finish within ${LOGIN_TIMEOUT / 1000}s (stuck at ${page.url()})`);
        }
        ctx.log(`anz: logged in (${new URL(page.url()).host})`);
        await settle(page);
      },

      async listAccounts() {
        if (accountsCache) return accountsCache;
        await goHome();
        const tiles = page.locator(HOME.tiles);
        const accounts: BankAccount[] = [];
        for (let i = 0; i < (await tiles.count()); i++) {
          const tile = page.locator(HOME.tile(i));
          const name = (await tile.locator(HOME.tileName).first().innerText()).trim();
          const number = await tile.locator(HOME.tileNumber).first().innerText().catch(() => "");
          accounts.push({ id: accountIdFromTile(number) || name, name, currency: "AUD" });
        }
        if (!accounts.length) {
          await snapshot(ctx, "no-accounts");
          throw new ProviderError("ANZ: no account tiles found on the home page");
        }
        accountsCache = accounts;
        return accounts;
      },

      async fetchTransactions(wanted) {
        const accounts = await this.listAccounts!();
        const range = anzRange(wanted);
        for (const n of range.notes) ctx.log(`anz: ${n}`);

        /** Type a date into one of ANZ's DD/MM/YYYY boxes (they start filled in). */
        async function typeDate(sel: string, iso: string) {
          const box = page.locator(sel).first();
          await box.click();
          await box.press("Control+a");
          await box.press("Backspace");
          await box.pressSequentially(anzDmy(iso), { delay: 80 });
          await box.press("Tab");
          await pause(300, 600);
        }

        /** Pick the Date range tab and type the dates. False when the tab isn't there. */
        async function useDateRange(): Promise<boolean> {
          const tab = page.locator(DOWNLOAD.dateRangeTab).first();
          if (!(await tab.isVisible().catch(() => false))) return false;
          await tab.click();
          await page.locator(DOWNLOAD.from).waitFor({ timeout: 10_000 });
          await pause(300, 700);
          await typeDate(DOWNLOAD.from, range.since);
          await typeDate(DOWNLOAD.to, range.until);
          return true;
        }

        /** Fallback: the shortest fixed duration that covers the range from today. */
        async function useDuration(): Promise<string> {
          const want = daysBetween(range.since, range.until);
          const days = DURATIONS.find((d) => d >= want) ?? DURATIONS.at(-1)!;
          if (want > days) ctx.log(`anz: ${want} days is more than ANZ's longest duration; using last ${days} days`);
          const label = `Last ${days} days`;
          await page.locator(DOWNLOAD.durationInput).click();
          await page.locator(DOWNLOAD.durationOptions).filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first().click();
          await pause(300, 700);
          return label;
        }

        const all: BankTransaction[] = [];
        for (const [i, acct] of accounts.entries()) {
          await goHome();
          ctx.log(`anz: opening ${acct.name}`);
          await page.locator(HOME.tile(i)).click();
          await ACCOUNT.download(page).waitFor({ timeout: 30_000 });
          await settle(page);
          await ACCOUNT.download(page).click();
          await page.locator(DOWNLOAD.softwareInput).waitFor({ timeout: 30_000 });
          await settle(page);

          let period = `${range.since} to ${range.until}`;
          if (!(await useDateRange())) {
            ctx.log("anz: no Date range tab on the download page; using a fixed duration");
            period = await useDuration();
          }
          if ((await page.locator(DOWNLOAD.softwareInput).inputValue()) !== CSV_FORMAT) {
            await page.locator(DOWNLOAD.softwareInput).click();
            await page.locator(DOWNLOAD.softwareOptions).filter({ hasText: CSV_FORMAT }).first().click();
          }
          await pause(300, 700);

          ctx.log(`anz: ${acct.name}: downloading ${period} as CSV`);
          const waiting = nextDownload(ctx.browser, 60_000);
          waiting.catch(() => {}); // handled below; a date error means no download
          await page.locator(DOWNLOAD.submit).click();
          // ANZ shows date problems under the boxes instead of downloading.
          const problem = await Promise.race([
            waiting.then(() => ""),
            page
              .locator(DOWNLOAD.problems)
              .filter({ hasText: /\S/ })
              .first()
              .waitFor({ state: "visible", timeout: 10_000 })
              .then(async () =>
                (await page.locator(DOWNLOAD.problems).filter({ hasText: /\S/ }).allInnerTexts()).join(" ").replace(/\s+/g, " ").trim(),
              )
              .catch(() => ""),
          ]);
          if (problem) {
            await snapshot(ctx, `anz-dates-${i}`);
            throw new ProviderError(`ANZ refused the dates ${period}: ${problem}`);
          }
          const dl = await waiting;
          // Playwright keeps downloads in a temp dir removed with the browser;
          // only debug runs keep a copy.
          const file = await dl.path();
          if (ctx.debug) await dl.saveAs(join(ctx.debugDir, `anz-${i}.csv`));
          const txns = parseAnzCsv(await readFile(file, "utf8"), acct).filter(
            (t) => t.date >= range.since && t.date <= range.until,
          );
          ctx.log(`anz: ${acct.name}: ${txns.length} transactions in range (${dl.suggestedFilename()})`);
          all.push(...txns);

          // ANZ may have opened the download in a new tab; close extras.
          for (const p of ctx.browser.pages()) if (p !== page) await p.close().catch(() => {});
        }
        return all;
      },

      async logout() {
        // ANZ limits concurrent sessions, so always try to end ours.
        const btn = page?.locator(SEL.logout).first();
        if (btn && (await btn.isVisible().catch(() => false))) {
          await btn.click();
          await settle(page);
          ctx.log("anz: logged out");
        } else {
          ctx.log("anz: no logout button found (session will expire on its own)");
        }
      },
    };
  },
};
