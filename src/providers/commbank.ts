/**
 * Commonwealth Bank NetBank (Australia).
 *
 * Built from Train recordings (Nov 2026).
 *
 * Login: client number + password at /auth/logon. Then usually
 * /auth/logon/mfa, where the page polls until the log on is approved in the
 * CommBank app, and lands on /banking. A "NetBank has a new look" welcome
 * with "Skip for now" may show once.
 *
 * Accounts: the home page accounts table (one link per account).
 *
 * Transactions: account page -> "Download transaction summary" -> type the
 * From/To dates -> CSV -> Download. The file has a header row:
 * Transaction Date, Description, Amount, Balance (dd/mm/yyyy, signed amount).
 * Older NetBank exports had no header (date, amount, description, balance);
 * both are parsed.
 *
 * Statements: /banking/accounts/statements -> Account picker -> Financial
 * year picker -> a list of statements by "Date issued" (no period shown) ->
 * tick one -> "Download (PDF)". Accounts and years with no statements are
 * normal (e.g. savings statements come every six months).
 */
import { parseAmount, type BankAccount, type BankStatement, type BankTransaction } from "../models.js";
import { bankDate, dmyDate, parseCsv } from "./csv.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Download, Locator, Page } from "playwright";
import { AuthError, ProviderError, pause, settle, snapshot, type ProviderContext, type ProviderDefinition } from "./base.js";

const LOGIN_URL = "https://netbank.web.commbank.com.au/auth/logon";

/** Hooks from the live logon app (Nov 2026). */
const SEL = {
  client: "#clientNumber",
  password: "#password",
  submit: '[data-tracking-id="logon-button"]',
  /** shown instead of the client number box when NetBank remembers it ("Ends with 5428") */
  savedClient: '[data-testid="remove-btn"]',
  confirmRemoveClient: "#confirm-remove-client-number",
  /** text shown when the log on is refused */
  alert: '[role="alert"], [aria-live="assertive"]',
  /** home page accounts table: one link per account (class names carry a hashed prefix) */
  accountLink: 'a[class*="account-info__link"][href*="/banking/accounts/"]',
  accountName: '[class*="account-info__link__name"]',
  accountNumber: '[class*="_account-number"] [aria-hidden="true"]',
  /** account page -> download dialog */
  openDownload: (page: Page) => page.getByRole("button", { name: "Download transaction summary", exact: true }),
  dialog: 'dialog[data-tracking-id="transaction-report-modal"]',
  csvOption: 'label:has(input[type="radio"][value="CSV"])',
  downloadFile: '[data-tracking-id="transaction-report-modal--file-download"]',
  /** statements page */
  accountPicker: (page: Page) => page.getByRole("combobox", { name: "Account", exact: true }),
  yearPicker: (page: Page) => page.getByRole("combobox", { name: "Financial year", exact: true }),
  statementRows: 'table:has(caption:text-is("Financial statements")) tbody tr',
  downloadPdf: (page: Page) => page.getByRole("button", { name: "Download (PDF)", exact: true }),
  /** "NetBank has a new look" welcome */
  skipWelcome: '[data-tracking-id="mc-welcome--skip"]',
};

const path = (page: Page) => new URL(page.url()).pathname;
const isBanking = (page: Page) => path(page).startsWith("/banking");
const isMfa = (page: Page) => path(page).startsWith("/auth/logon/mfa");

const LOGIN_TIMEOUT = 45_000;
const HOME_URL = "https://netbank.web.commbank.com.au/banking";
const STATEMENTS_URL = "https://netbank.web.commbank.com.au/banking/accounts/statements";

/**
 * Australian financial years (as NetBank labels them, "2026 - 2027") that
 * overlap a date range, newest first. A year runs 1 July to 30 June.
 */
export function financialYears(since: string, until: string): string[] {
  const fy = (ymd: string) => {
    const [y, m] = ymd.split("-").map(Number) as [number, number];
    return m >= 7 ? y : y - 1;
  };
  const out: string[] = [];
  for (let y = fy(until); y >= fy(since); y--) out.push(`${y} - ${y + 1}`);
  return out;
}

/** Account id from the home page number: whitespace collapsed, e.g. "066-003 1036 0393". */
export function accountIdFromNumber(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Parse a NetBank CSV export. Handles the classic headerless layout
 * (date, amount, description, balance) and a headed layout with an amount
 * or debit/credit columns.
 */
export function parseCommbankCsv(text: string, account: BankAccount): BankTransaction[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];

  let col = { date: 0, amount: 1, debit: -1, credit: -1, desc: 2 };
  if (!dmyDate(rows[0]![0] ?? "")) {
    const h = rows.shift()!.map((c) => c.toLowerCase());
    const find = (re: RegExp) => h.findIndex((c) => re.test(c));
    col = {
      date: find(/date/),
      amount: find(/^amount/),
      debit: find(/debit|withdraw/),
      credit: find(/credit|deposit/),
      desc: find(/desc|detail|narrat/),
    };
    if (col.date < 0 || col.desc < 0 || (col.amount < 0 && col.debit < 0 && col.credit < 0)) {
      throw new ProviderError(`CommBank CSV: unrecognised header ${JSON.stringify(h)}`);
    }
  }

  return rows.map((r, i) => {
    const date = dmyDate(r[col.date] ?? "");
    if (!date) throw new ProviderError(`CommBank CSV row ${i + 1}: bad date ${JSON.stringify(r[col.date])}`);
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

/**
 * Type a date into a NetBank date field (react-aria: day/month/year
 * spinbutton segments), then check the field's hidden ISO value.
 */
async function typeDate(field: Locator, ymd: string): Promise<void> {
  const [y, m, d] = ymd.split("-") as [string, string, string];
  for (const [type, digits] of [["day", d], ["month", m], ["year", y]] as const) {
    const seg = field.locator(`[role="spinbutton"][data-type="${type}"]`);
    await seg.click();
    for (let i = 0; i < 4; i++) await seg.press("Backspace");
    await seg.pressSequentially(digits, { delay: 60 });
  }
  const id = await field.getAttribute("id");
  const value = id ? await field.page().locator(`input[name="${id}"]`).first().inputValue().catch(() => "") : "";
  if (value !== ymd) throw new ProviderError(`CommBank: couldn't set the date to ${ymd} (field shows ${value || "nothing"})`);
}

export const commbank: ProviderDefinition = {
  name: "commbank",
  label: "CommBank NetBank",
  credentialFields: [
    { key: "client_number", label: "Client number" },
    { key: "password", label: "Password", secret: true },
  ],
  startUrl: LOGIN_URL,
  syncPeriod: { choices: [7, 14, 30, 60, 90], default: 14, customRange: true },
  // Six-monthly runs look back a little over six months, so a late run still catches the last statement.
  statements: { lookbackDays: 200, note: "PDF statements, by the date NetBank issued them." },
  create: (ctx: ProviderContext) => {
    let page: Page;
    let accountsCache: BankAccount[] | undefined;

    /** Close the one-off "new look" welcome if it's showing (it can take a few seconds to appear). */
    async function skipWelcome(waitMs: number) {
      const skip = page.locator(SEL.skipWelcome);
      if (!(await skip.waitFor({ timeout: waitMs }).then(() => true, () => false))) return;
      ctx.log("commbank: skipping the \"new look\" welcome");
      await skip.click();
      await settle(page);
    }

    return {
      async login() {
        page = ctx.browser.pages()[0] ?? (await ctx.browser.newPage());
        ctx.log("commbank: opening log on page");
        await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
        if (isBanking(page)) {
          ctx.log("commbank: still logged in from last time");
          return;
        }
        await page.locator(`${SEL.client}, ${SEL.password}`).first().waitFor({ timeout: 30_000 });
        await pause(2000, 4000);

        // NetBank may remember the client number and show only "Ends with NNNN" plus the password box.
        const clientNumber = ctx.credentials.client_number!.replace(/\s+/g, "");
        if (!(await page.locator(SEL.client).isVisible()) && (await page.locator(SEL.savedClient).isVisible())) {
          const shown = (await page.locator("body").innerText()).match(/ends with\s*(\d{3,4})/i)?.[1];
          if (shown && clientNumber.endsWith(shown)) ctx.log("commbank: client number already remembered by NetBank");
          else {
            ctx.log("commbank: NetBank remembers a different client number; removing it");
            await page.locator(SEL.savedClient).click();
            await page.locator(SEL.confirmRemoveClient).click();
            await page.locator(SEL.client).waitFor({ timeout: 15_000 });
            await pause(500, 1000);
          }
        }

        // Typed with human-ish delays: the page runs behavioural bot detection.
        if (await page.locator(SEL.client).isVisible()) {
          await page.locator(SEL.client).click();
          await page.locator(SEL.client).fill("");
          await page.locator(SEL.client).pressSequentially(clientNumber, { delay: 90 });
          await pause(300, 800);
        }
        await page.locator(SEL.password).click();
        await page.locator(SEL.password).pressSequentially(ctx.credentials.password!, { delay: 80 });
        await pause(400, 900);
        await page.locator(SEL.submit).click();
        ctx.log("commbank: credentials submitted");

        const moved = await page
          .waitForURL((u) => u.pathname.startsWith("/banking") || u.pathname.startsWith("/auth/logon/mfa"), { timeout: LOGIN_TIMEOUT })
          .then(() => true, () => false);
        if (!moved) {
          const text = (await page.locator(SEL.alert).allInnerTexts().catch(() => [])).join(" ").replace(/\s+/g, " ").trim();
          await snapshot(ctx, "login-failed");
          if (text) throw new AuthError(`CommBank log on failed: ${text}`);
          throw new ProviderError(`CommBank log on did not finish within ${LOGIN_TIMEOUT / 1000}s (stuck at ${path(page)})`);
        }

        if (isMfa(page)) {
          ctx.log("commbank: waiting for approval in the CommBank app");
          await ctx.requestBrowserHelp(
            page,
            "CommBank wants you to approve this log on in the CommBank app. Approve it on your phone; the run continues by itself. (If it offers a code instead, enter it here.)",
            async () => isBanking(page),
          );
          if (!isBanking(page)) {
            await page.waitForURL((u) => u.pathname.startsWith("/banking"), { timeout: 30_000 }).catch(async () => {
              await snapshot(ctx, "mfa-stuck");
              throw new ProviderError(`CommBank: approval finished but NetBank didn't open (at ${path(page)})`);
            });
          }
        }
        ctx.log("commbank: logged in");
        await settle(page);
        await skipWelcome(10_000);
      },
      async listAccounts() {
        if (accountsCache) return accountsCache;
        if (path(page) !== "/banking") {
          await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
          await settle(page);
          await skipWelcome(5_000);
        }
        const links = page.locator(SEL.accountLink);
        await links.first().waitFor({ timeout: 30_000 }).catch(() => {});
        const accounts: BankAccount[] = [];
        for (const link of await links.all()) {
          const name = (await link.locator(SEL.accountName).first().innerText().catch(() => "")).trim();
          const number = await link.locator(SEL.accountNumber).first().innerText().catch(() => "");
          if (name) accounts.push({ id: accountIdFromNumber(number) || name, name, currency: "AUD" });
        }
        if (!accounts.length) {
          await snapshot(ctx, "no-accounts");
          throw new ProviderError("CommBank: no accounts found on the NetBank home page");
        }
        accountsCache = accounts;
        return accounts;
      },
      async fetchTransactions(range) {
        const accounts = await this.listAccounts!();
        const all: BankTransaction[] = [];
        for (const [i, acct] of accounts.entries()) {
          if (path(page) !== "/banking") {
            await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
            await settle(page);
          }
          ctx.log(`commbank: opening ${acct.name}`);
          // Same order as listAccounts(); check the name in case the table changed.
          const link = page.locator(SEL.accountLink).nth(i);
          await link.waitFor({ timeout: 30_000 });
          const name = (await link.locator(SEL.accountName).first().innerText()).trim();
          if (name !== acct.name) throw new ProviderError(`CommBank: expected account "${acct.name}" in row ${i + 1}, found "${name}"`);
          await link.click();
          await SEL.openDownload(page).waitFor({ timeout: 30_000 });
          await settle(page);
          await SEL.openDownload(page).click();

          const dialog = page.locator(SEL.dialog);
          await dialog.waitFor({ timeout: 15_000 });
          await pause(300, 700);
          await typeDate(dialog.getByRole("group", { name: "From", exact: true }), range.since);
          await pause(200, 500);
          await typeDate(dialog.getByRole("group", { name: "To", exact: true }), range.until);
          await pause(200, 500);
          await dialog.locator(SEL.csvOption).click();
          await pause(300, 700);

          ctx.log(`commbank: ${acct.name}: downloading ${range.since} to ${range.until} as CSV`);
          const dl = await downloadReport(ctx, page, dialog, acct.name);
          // Playwright keeps downloads in a temp dir removed with the browser; only debug runs keep a copy.
          const file = await dl.path();
          if (ctx.debug) await dl.saveAs(join(ctx.debugDir, `commbank-${i}.csv`));
          const txns = parseCommbankCsv(await readFile(file, "utf8"), acct).filter((t) => t.date >= range.since && t.date <= range.until);
          ctx.log(`commbank: ${acct.name}: ${txns.length} transactions in range (${dl.suggestedFilename()})`);
          all.push(...txns);

          await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
          await settle(page);
        }
        return all;
      },

      async fetchStatements(range) {
        const accounts = await this.listAccounts!();
        ctx.log("commbank: opening statements");
        await page.goto(STATEMENTS_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await SEL.accountPicker(page).waitFor({ timeout: 30_000 });
        await settle(page);

        const out: BankStatement[] = [];
        for (const acct of accounts) {
          // Pick the account by its number (names can repeat).
          await SEL.accountPicker(page).click();
          const option = page.getByRole("option").filter({ hasText: acct.id === acct.name ? acct.name : acct.id });
          if (!(await option.first().waitFor({ timeout: 5_000 }).then(() => true, () => false))) {
            ctx.log(`commbank: ${acct.name}: not in the statements account list, skipped`);
            await page.keyboard.press("Escape");
            continue;
          }
          await option.first().click();
          await settle(page);

          let found = 0;
          for (const year of financialYears(range.since, range.until)) {
            await SEL.yearPicker(page).click();
            const yearOption = page.getByRole("option", { name: year, exact: true });
            if (!(await yearOption.waitFor({ timeout: 5_000 }).then(() => true, () => false))) {
              await page.keyboard.press("Escape");
              continue;
            }
            await yearOption.click();
            await settle(page);

            const rows = page.locator(SEL.statementRows);
            const wanted: { label: string; date: string }[] = [];
            for (const label of (await rows.allInnerTexts()).map((t) => t.trim())) {
              const date = bankDate(label);
              if (date && date >= range.since && date <= range.until) wanted.push({ label, date });
            }
            for (const { label, date } of wanted) {
              // Tick it the way a person does: click the row's label (the box itself is styled over).
              const row = rows.filter({ hasText: label }).first();
              const box = row.getByRole("checkbox");
              if (!(await box.isChecked())) await row.locator("label").first().click();
              if (!(await box.isChecked())) throw new ProviderError(`CommBank: couldn't select the ${label} statement`);
              await pause(300, 700);
              const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), SEL.downloadPdf(page).click()]);
              const data = await readFile(await dl.path());
              out.push({ account: acct, date, fileName: dl.suggestedFilename() || `Statement_${date}.pdf`, contentType: "application/pdf", data });
              found++;
              if (await box.isChecked()) await row.locator("label").first().click();
              await pause(300, 700);
            }
          }
          ctx.log(`commbank: ${acct.name}: ${found ? `${found} statement${found > 1 ? "s" : ""}` : "no statements"} issued ${range.since} to ${range.until}`);
        }
        return out;
      },
    };
  },
};

/**
 * Press Download in the transaction summary dialog and wait for the file.
 * NetBank sometimes ignores the press or shows "We couldn't create your
 * transaction summary"; both get a few more tries. Files that open in a new
 * tab are caught too.
 */
async function downloadReport(ctx: ProviderContext, page: Page, dialog: Locator, account: string): Promise<Download> {
  const errorDialog = page.locator('dialog[aria-describedby="transaction-summary-download-error-description"][open]');
  // The count shows once NetBank has taken the dates in; pressing before that can be ignored.
  await dialog.getByText(/This summary will show/i).first().waitFor({ timeout: 10_000 }).catch(() => {});
  for (let attempt = 1; attempt <= 3; attempt++) {
    const file = anyDownload(ctx.browser, 30_000);
    if (attempt === 1 || !(await errorDialog.isVisible().catch(() => false))) await dialog.locator(SEL.downloadFile).click();
    else await errorDialog.getByRole("button", { name: "Try again" }).click();
    const outcome = await Promise.race([
      file.wait,
      errorDialog.waitFor({ timeout: 30_000 }).then(
        () => "error" as const,
        () => "nothing" as const,
      ),
    ]);
    file.stop();
    if (typeof outcome === "object") return outcome;
    if (attempt === 3) break;
    if (outcome === "error") ctx.log(`commbank: ${account}: NetBank couldn't create the summary, trying again shortly`);
    else ctx.log(`commbank: ${account}: no file after pressing Download, pressing it again`);
    await pause(5_000, 8_000);
  }
  await snapshot(ctx, "commbank-download");
  throw new ProviderError(`CommBank: ${account}: the transaction summary didn't download after 3 tries`);
}

/** The next download from any tab of the browser (NetBank may open one for the file). */
function anyDownload(browser: BrowserContext, timeoutMs: number): { wait: Promise<Download | "nothing">; stop: () => void } {
  let done: (d: Download | "nothing") => void = () => {};
  const wait = new Promise<Download | "nothing">((r) => (done = r));
  const onDownload = (d: Download) => done(d);
  const watch = (p: Page) => p.on("download", onDownload);
  browser.pages().forEach(watch);
  browser.on("page", watch);
  const timer = setTimeout(() => done("nothing"), timeoutMs);
  return {
    wait,
    stop: () => {
      clearTimeout(timer);
      browser.off("page", watch);
      for (const p of browser.pages()) p.off("download", onDownload);
    },
  };
}
