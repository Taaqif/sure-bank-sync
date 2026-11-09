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
 * Transactions: for each account, choose a duration covering the lookback,
 * keep "Microsoft Excel(CSV)", click Download and parse the file.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Download, Page } from "playwright";
import { parseAmount, type BankAccount, type BankTransaction } from "../models.js";
import { AuthError, ProviderError, captureJson, snapshot, type ProviderContext, type ProviderDefinition } from "./base.js";

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
};
const CSV_FORMAT = "Microsoft Excel(CSV)";

/** Duration choices offered by ANZ, in days. Longer needs the date-range tab (not implemented). */
const DURATIONS = [7, 14, 30, 60, 90, 120];

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

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

/** "09/11/2026" (d/m/y) -> "2026-11-09" */
function anzDate(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : null;
}

/**
 * Parse ANZ's "Microsoft Excel(CSV)" export. Handles the classic headerless
 * layout (date, signed amount, description) and a headed layout with
 * separate debit/credit columns.
 */
export function parseAnzCsv(text: string, account: BankAccount): BankTransaction[] {
  const rows = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map(splitCsvLine);
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

const pause = (min: number, max: number) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await pause(1500, 2500);
}

export const anz: ProviderDefinition = {
  name: "anz",
  label: "ANZ Internet Banking",
  credentialFields: [
    { key: "customer_id", label: "Customer Registration Number" },
    { key: "password", label: "Password", secret: true },
  ],
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
        await pause(800, 1600);

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

      async fetchTransactions(range) {
        const accounts = await this.listAccounts!();
        const want = daysBetween(range.since, range.until);
        const days = DURATIONS.find((d) => d >= want) ?? DURATIONS.at(-1)!;
        if (want > days) ctx.log(`anz: lookback ${want} days is more than ANZ's longest duration; using last ${days} days`);
        const label = `Last ${days} days`;

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

          await page.locator(DOWNLOAD.durationInput).click();
          await page.locator(DOWNLOAD.durationOptions).filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first().click();
          await pause(300, 700);
          if ((await page.locator(DOWNLOAD.softwareInput).inputValue()) !== CSV_FORMAT) {
            await page.locator(DOWNLOAD.softwareInput).click();
            await page.locator(DOWNLOAD.softwareOptions).filter({ hasText: CSV_FORMAT }).first().click();
          }
          await pause(300, 700);

          ctx.log(`anz: ${acct.name}: downloading ${label} as CSV`);
          const waiting = nextDownload(ctx.browser, 60_000);
          await page.locator(DOWNLOAD.submit).click();
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
