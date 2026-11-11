/**
 * Macquarie Bank (Australia) personal online banking.
 *
 * Login: online.macquarie.com.au (Macquarie ID + password), then MFA: an SMS
 * code goes through the code box; an "approve in the Macquarie app" prompt
 * waits until it's approved. Any step the scraper doesn't recognise is handed
 * to a person through the browser view instead of failing.
 *
 * Also handled: Macquarie's "I'm not a robot" checkbox (handed to a person)
 * and the "trust this browser" page (answered yes, with a nickname for the
 * browser: options.browserName, default "Sure Bank Sync").
 *
 * Accounts: the rows on /io/#/accounts (product name, "BSB | number").
 * Transactions: per account, click it -> "Download transactions" (top right of
 * the Transactions panel) -> CSV, parsed by header.
 */
import type { Locator, Page } from "playwright";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAmount, type BankAccount, type BankTransaction } from "../models.js";
import { bankDate, parseCsv } from "./csv.js";
import { RetryLogin } from "../mfa.js";
import { AuthError, ProviderError, captureJson, pause, settle, snapshot, type ProviderContext, type ProviderDefinition } from "./base.js";

const LOGIN_URL = "https://online.macquarie.com.au/personal/";
const ACCOUNTS_URL = "https://online.macquarie.com.au/io/#/accounts";
const HOST = /(^|\.)macquarie\.com\.au$/;

/** Nickname given to the trusted browser when the connection's options don't set browserName. */
export const DEFAULT_BROWSER_NAME = "Sure Bank Sync";

/**
 * The trusted browser's nickname. Macquarie allows only letters, numbers,
 * quotes, colons and spaces, so anything else becomes a space.
 */
export function browserNickname(options: Record<string, unknown>): string {
  const raw = typeof options.browserName === "string" ? options.browserName : "";
  const name = raw.replace(/[^A-Za-z0-9'"‘’“”: ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  return name || DEFAULT_BROWSER_NAME;
}

const SEL = {
  username: [
    "#username",
    'input[autocomplete="username"]',
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[name*="macquarie" i]',
    'input[id*="macquarie" i]',
    'input[name*="client" i]',
    'input[type="text"]:not([readonly])',
  ].join(", "),
  password: '#password, input[type="password"]',
  code: [
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
    'input[name*="token" i]',
  ].join(", "),
  downloadButton: '[data-testid="transactions-download-button"], button[aria-label="Download"]',
  downloadCsv: '[data-testid="download-format-csv"]',
  addFilter: ".mq-add-filter__button",
  logout: 'a:has-text("Log out"), button:has-text("Log out"), a:has-text("Logout"), button:has-text("Logout"), [aria-label*="log out" i]',
};
const SUBMIT = /^\s*(log ?in|sign ?in|next|continue)\s*$/i;
const VERIFY_SUBMIT = /^\s*(verify|confirm|continue|submit|next)\s*$/i;
const ERROR_TEXT = /(incorrect|invalid|doesn'?t match|not recognised).{0,40}(id|password|details)|account (is |has been )?(locked|suspended)|too many (failed )?attempts/i;
const APP_APPROVAL_TEXT = /approve.{0,40}(app|notification|device|login|log in|sign ?in)|check your (phone|device|app)|sent a (notification|request)|waiting for (approval|you to approve)/i;
/** Macquarie's own "Help us keep your account secure / I'm not a robot" check. */
const ROBOT_FRAME = 'iframe#sec-cpt-if, iframe[src*="akamai-challenge"]';
export const ROBOT_TEXT = /confirm you['’]?re not a robot|i['’]?m not a robot|help us keep your account secure/i;
const CODE_TEXT = /(sms|text message|one[- ]time|verification|security) code|enter the code|code (we|that we) sent/i;

const visible = (l: Locator) => l.first().isVisible().catch(() => false);

/**
 * Parse a Macquarie transactions CSV. Columns are matched by header name:
 * a date, a description (Details / Description / Narrative, else Original
 * Description) and either a signed Amount or Debit/Credit columns.
 */
export function parseMacquarieCsv(text: string, account: BankAccount): BankTransaction[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headerAt = rows.findIndex((r) => r.some((c) => /date/i.test(c)));
  if (headerAt < 0) throw new ProviderError(`Macquarie CSV: no header row (first row: ${JSON.stringify(rows[0]?.slice(0, 6))})`);
  const h = rows[headerAt]!.map((c) => c.toLowerCase().trim());
  const find = (...res: RegExp[]) => {
    for (const re of res) {
      const i = h.findIndex((c) => re.test(c));
      if (i >= 0) return i;
    }
    return -1;
  };
  const c = {
    date: find(/^transaction date$/, /^date$/, /date/),
    desc: find(/^details$/, /^description$/, /narrative/, /^original description$/, /desc/),
    amount: find(/^amount$/, /amount/),
    debit: find(/debit|withdrawal/),
    credit: find(/credit|deposit/),
  };
  if (c.date < 0 || c.desc < 0 || (c.amount < 0 && c.debit < 0 && c.credit < 0)) {
    throw new ProviderError(`Macquarie CSV: unrecognised header ${JSON.stringify(h)}`);
  }
  return rows.slice(headerAt + 1).flatMap((r, i) => {
    if (r.length < 2) return [];
    const date = bankDate(r[c.date] ?? "");
    if (!date) throw new ProviderError(`Macquarie CSV row ${i + 1}: bad date ${JSON.stringify(r[c.date])}`);
    let amountCents: number;
    if (c.debit >= 0 || c.credit >= 0) {
      const debit = c.debit >= 0 && r[c.debit]?.trim() ? Math.abs(parseAmount(r[c.debit]!)) : 0;
      const credit = c.credit >= 0 && r[c.credit]?.trim() ? Math.abs(parseAmount(r[c.credit]!)) : 0;
      amountCents = debit || credit ? credit - debit : c.amount >= 0 ? parseAmount(r[c.amount] ?? "0") : 0;
    } else amountCents = parseAmount(r[c.amount] ?? "");
    return [{ account, date, amountCents, description: (r[c.desc] ?? "").replace(/\s+/g, " ").trim() }];
  });
}

export const macquarie: ProviderDefinition = {
  name: "macquarie",
  label: "Macquarie Bank (AU)",
  credentialFields: [
    { key: "username", label: "Macquarie ID" },
    { key: "password", label: "Password", secret: true },
  ],
  // The transactions date filter takes any range, so any period works.
  startUrl: LOGIN_URL,
  optionsHint: `Macquarie: {"browserName": "Sure Bank Sync"} sets the nickname given when trusting this browser (letters, numbers, quotes, colons and spaces).`,
  syncPeriod: {},
  create: (ctx: ProviderContext) => {
    // Full API responses hold account data: only capture them on debug runs.
    if (ctx.debug) captureJson(ctx, HOST);
    let page: Page;
    /** our account id -> Macquarie's account key (for opening an account later) */
    const accountKeys = new Map<string, string>();

    const loggedIn = async () => {
      const hash = (() => {
        try {
          return new URL(page.url()).hash + new URL(page.url()).pathname;
        } catch {
          return "";
        }
      })();
      if (/login|logon|auth|verify|mfa|challenge|otp/i.test(hash)) return false;
      return visible(page.locator(SEL.logout));
    };

    const bodyText = () => page.locator("body").innerText().catch(() => "");

    /**
     * Is the robot check showing? It can sit in an embedded frame (Akamai's
     * challenge), so check every frame's text and the challenge URL too.
     */
    async function robotShown(text?: string): Promise<boolean> {
      if (/akamai[_-]challenge/i.test(page.url())) return true;
      // Akamai's challenge iframe (#sec-cpt-if, /challenge/akamai-challenge.html)
      if (await visible(page.locator(ROBOT_FRAME))) return true;
      if (ROBOT_TEXT.test(text ?? (await bodyText()))) return true;
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        if (/sec-cpt|akamai[_-]challenge/i.test(frame.url())) return true;
        const t = await frame.locator("body").innerText({ timeout: 1000 }).catch(() => "");
        if (ROBOT_TEXT.test(t)) return true;
      }
      return false;
    }

    type State = "logged_in" | "code" | "app" | "robot" | "trust" | "rejected" | "unknown";
    async function state(timeout = 30_000): Promise<State> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await loggedIn()) return "logged_in";
        if (/#\/trust-browser/.test(page.url())) return "trust";
        const text = await bodyText();
        if (ERROR_TEXT.test(text)) return "rejected";
        if (await robotShown(text)) return "robot";
        if (await visible(page.locator(SEL.code).locator("visible=true"))) return "code";
        // Only once the login form is gone: the login page itself mentions the app in a notice.
        const onForm = await visible(page.locator(SEL.password));
        if (!onForm && APP_APPROVAL_TEXT.test(text)) return "app";
        if (!onForm && CODE_TEXT.test(text)) return "code";
        // Check often: the robot check expires about 30 seconds after it appears.
        await pause(250, 400);
      }
      return "unknown";
    }

    async function clickSubmit(re: RegExp): Promise<boolean> {
      const btn = page.getByRole("button", { name: re }).locator("visible=true").first();
      if (await btn.count()) {
        await btn.click();
        return true;
      }
      return false;
    }

    /** "2026-11-09" -> "09/11/2026" */
    const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

    /**
     * Transactions filter: Add filter -> Date range -> Custom -> dates -> Apply.
     * Required: the unfiltered view has no date limit, so a miss fails the run.
     * Debug runs save a snapshot after each step (filter-<i>-<n>-<step>).
     */
    async function applyDateRange(range: { since: string; until: string }, i: number): Promise<void> {
      const text = `${dmy(range.since)} - ${dmy(range.until)}`;
      let step = "start";
      let n = 0;
      const at = async (name: string) => {
        step = name;
        ctx.log(`macquarie: date filter: ${name}`);
        if (ctx.debug) await snapshot(ctx, `filter-${i}-${++n}-${name}`);
      };
      try {
        await at("open add filter");
        await page.locator(SEL.addFilter).first().click({ timeout: 10_000 });
        await pause(500, 900);

        await at("tick date range");
        await page.getByText("Date range", { exact: true }).locator("visible=true").first().click({ timeout: 10_000 });
        await pause(500, 900);

        await at("pick custom");
        let custom = page.getByText("Custom", { exact: true }).locator("visible=true").first();
        if (!(await visible(custom))) {
          // The options live under the "Date range" chip.
          await page.getByText(/^\s*Date range/).locator("visible=true").last().click({ timeout: 10_000 });
          await pause(500, 900);
          custom = page.getByText("Custom", { exact: true }).locator("visible=true").first();
        }
        await custom.click({ timeout: 10_000 });
        await pause(500, 900);

        await at("type dates");
        // The visible "DD/MM/YYYY - DD/MM/YYYY" box sits over an Angular Material range
        // input; Apply enables only once its fromDate/toDate controls hold dates.
        const from = page.locator('input.mat-start-date, input[formcontrolname="fromDate"]').first();
        const to = page.locator('input.mat-end-date, input[formcontrolname="toDate"]').first();
        const apply = page.locator("button.mq-filter__dropdown-footer-button").filter({ hasText: /^\s*Apply\s*$/ }).locator("visible=true").first();
        if (await from.count()) {
          for (const [box, value] of [[from, dmy(range.since)], [to, dmy(range.until)]] as const) {
            await box.fill(value, { force: true });
            await box.dispatchEvent("blur");
          }
        }
        if (await apply.isDisabled().catch(() => true)) {
          // Fall back to typing into the visible box like a person.
          const shown = page.locator(".mq-datepicker__input").locator("visible=true").first();
          await shown.click({ timeout: 10_000 });
          await shown.fill("");
          await shown.pressSequentially(text, { delay: 60, timeout: 15_000 });
          await page.keyboard.press("Tab");
        }
        await pause(400, 800);
        ctx.log(`macquarie: date filter: from=${await from.inputValue().catch(() => "?")} to=${await to.inputValue().catch(() => "?")}`);

        await at("apply");
        const enabled = page.locator("button.mq-filter__dropdown-footer-button:not([disabled])").filter({ hasText: /^\s*Apply\s*$/ }).first();
        await enabled.waitFor({ timeout: 10_000 }).catch(() => {
          throw new Error("Apply stayed disabled after entering the dates");
        });
        await apply.click({ timeout: 10_000 });
        await settle(page);
        await at("applied");
        ctx.log(`macquarie: filtered transactions to ${text}`);
      } catch (e) {
        await snapshot(ctx, `date-filter-failed-${i}`);
        if (ctx.debug) ctx.log(`macquarie: visible controls: ${await visibleControls()}`);
        throw new ProviderError(`Macquarie: date range filter failed at "${step}" (${(e as Error).message.split("\n")[0]})`);
      }
    }

    /** Labels of visible buttons, inputs and options (UI text only), to fix selectors from a debug run. */
    function visibleControls(): Promise<string> {
      return page
        .$$eval('button, input, label, [role="radio"], [role="checkbox"], [role="option"], [role="menuitem"]', (els) =>
          els
            .filter((el) => (el as unknown as { offsetParent: unknown }).offsetParent !== null)
            .map((el) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const e = el as any;
              const bits = [e.tagName.toLowerCase()];
              const role = e.getAttribute("role");
              if (role) bits.push(`role=${role}`);
              if (e.type && e.tagName === "INPUT") bits.push(`type=${e.type}`);
              const id = e.getAttribute("data-testid");
              if (id) bits.push(`testid=${id}`);
              if (e.placeholder) bits.push(`ph="${e.placeholder}"`);
              const label = e.getAttribute("aria-label");
              if (label) bits.push(`aria="${label}"`);
              const t = (e.innerText || "").trim().replace(/\s+/g, " ").slice(0, 40);
              if (t) bits.push(`"${t}"`);
              return bits.join(" ");
            })
            .slice(0, 80)
            .join(" | "),
        )
        .catch((err: Error) => `(couldn't list: ${err.message})`);
    }

    async function typeInto(l: Locator, value: string): Promise<void> {
      await l.click();
      if ((await l.inputValue().catch(() => "")) !== "") await l.fill("");
      await l.pressSequentially(value, { delay: 85 });
    }

    return {
      async login() {
        page = ctx.browser.pages()[0] ?? (await ctx.browser.newPage());
        await dismissWhatsNew(page, ctx.log);
        ctx.log("macquarie: opening login page");
        await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await settle(page);
        if (await loggedIn()) {
          ctx.log("macquarie: already logged in");
          return;
        }

        const user = page.locator(SEL.username).locator("visible=true").first();
        await user.waitFor({ timeout: 30_000 }).catch(async () => {
          await snapshot(ctx, "no-login-form");
          throw new ProviderError("Macquarie: couldn't find the login form (see the screenshot)");
        });
        // Bot protection (Akamai) scores time on the login page; type after a person-like pause.
        await pause(5000, 9000);
        await typeInto(user, ctx.credentials.username!);
        await pause(300, 800);

        // Some logins ask for the ID first, then the password on a second step.
        let pass = page.locator(SEL.password).locator("visible=true").first();
        if (!(await pass.count())) {
          ctx.log("macquarie: two-step login, submitting the ID first");
          await clickSubmit(SUBMIT);
          await pass.waitFor({ timeout: 20_000 }).catch(() => {});
          pass = page.locator(SEL.password).locator("visible=true").first();
        }
        if (!(await pass.count())) {
          await snapshot(ctx, "no-password-field");
          throw new ProviderError("Macquarie: no password field after the ID (see the screenshot)");
        }
        await typeInto(pass, ctx.credentials.password!);
        await pause(400, 900);
        if (!(await clickSubmit(SUBMIT))) await pass.press("Enter");
        ctx.log("macquarie: credentials submitted");

        let trustTried = false;
        for (let step = 1; step <= 6; step++) {
          const s = await state();
          if (s === "logged_in") {
            ctx.log("macquarie: logged in");
            await settle(page);
            return;
          }
          if (s === "rejected") {
            const why = (await bodyText()).match(ERROR_TEXT)?.[0] ?? "rejected";
            await snapshot(ctx, "login-failed");
            throw new AuthError(`Macquarie login failed: ${why}`);
          }
          await snapshot(ctx, `step-${step}`);
          if (s === "code") {
            ctx.log("macquarie: asking for the verification code");
            const code = (await ctx.requestMfa("Macquarie sent a verification code (SMS). Enter it here.")).replace(/\s+/g, "");
            const input = page.locator(SEL.code).locator("visible=true").first();
            if (!(await input.count())) throw new ProviderError("Macquarie: the code box disappeared");
            await typeInto(input, code);
            await pause(300, 700);
            if (!(await clickSubmit(VERIFY_SUBMIT))) await input.press("Enter");
            await settle(page);
            continue;
          }
          if (s === "robot") {
            ctx.log("macquarie: \"I'm not a robot\" check shown");
            await ctx.requestBrowserHelp(
              page,
              "Macquarie wants you to confirm you're not a robot. Be quick: the check expires after about 30 seconds. Tick the box (and solve any picture puzzle), then press Continue. If it expires, the sync logs in again.",
              async () => (await loggedIn()) || !(await robotShown()),
            );
            await settle(page);
            // The check expired (or was dismissed) and left us on the login form: start over.
            const next = await state(10_000);
            if (next === "unknown" && (await visible(page.locator(SEL.password).locator("visible=true")))) {
              await snapshot(ctx, "robot-expired");
              throw new RetryLogin("the robot check ended without logging in");
            }
            continue;
          }
          if (s === "trust") {
            // "Trust this browser?": yes, so Macquarie asks for MFA less often.
            // It needs a nickname for the browser before the button works.
            const yes = page.getByRole("button", { name: /trust|yes|remember|continue/i }).locator("visible=true").first();
            if (!trustTried && (await yes.count())) {
              trustTried = true;
              const nick = page.locator('input[formcontrolname="nickname"], #nickname').locator("visible=true").first();
              if (await nick.count()) {
                const name = browserNickname(ctx.options);
                ctx.log(`macquarie: naming this browser "${name}"`);
                await typeInto(nick, name);
                await pause(300, 600);
              }
              ctx.log(`macquarie: trusting this browser ("${(await yes.innerText()).trim()}")`);
              await yes.click();
              await settle(page);
              continue;
            }
            // Still here after trying (e.g. the name was refused): a person finishes it.
            ctx.log("macquarie: couldn't finish the trust-browser page by itself, asking you");
            await ctx.requestBrowserHelp(page, "Macquarie asks whether to trust this browser. Choose to trust it.", async () =>
              !/#\/trust-browser/.test(page.url()),
            );
            continue;
          }
          if (s === "app") {
            ctx.log("macquarie: waiting for approval in the Macquarie app");
            await ctx.requestBrowserHelp(
              page,
              "Macquarie wants you to approve this login in the Macquarie app. Approve it on your phone; the run continues by itself.",
              async () => (await loggedIn()) || !APP_APPROVAL_TEXT.test(await bodyText()),
            );
            continue;
          }
          // Unknown step: hand it to a person rather than guessing.
          ctx.log("macquarie: unrecognised login step, asking you to finish it in the browser view");
          await ctx.requestBrowserHelp(
            page,
            "Macquarie is showing a login step the sync doesn't recognise. Finish logging in in the browser view; the run continues once you're in.",
            loggedIn,
          );
        }
        throw new ProviderError("Macquarie login did not finish within 6 steps");
      },

      async listAccounts() {
        if (!/#\/accounts/.test(page.url())) {
          await page.goto(ACCOUNTS_URL, { waitUntil: "domcontentloaded" });
        }
        await page.locator("[data-accountid]").first().waitFor({ state: "attached", timeout: 30_000 }).catch(async () => {
          await snapshot(ctx, "no-accounts");
          throw new ProviderError("Macquarie: no accounts found on the accounts page");
        });
        await settle(page);
        // Runs in the page: no DOM typings here, and no named inner functions
        // (tsx wraps those with a helper that doesn't exist in the page).
        const rows = await page.$$eval("[data-accountid]", (els) =>
          els.map((el) => {
            const row = el.closest("tr");
            const [name, number] = [".accounts-list-group-table__product-name", ".accounts-list-group-table__account-number"].map(
              (sel) => ((row?.querySelector(sel) as { innerText?: string } | null)?.innerText ?? "").replace(/\s+/g, " ").trim(),
            );
            return { key: el.getAttribute("data-accountid") ?? "", name: name ?? "", number: number ?? "" };
          }),
        );
        const accounts = rows
          .filter((r) => r.key)
          .map((r) => {
            const m = /(\d{3}-?\d{3})\s*\|\s*(\d+)/.exec(r.number);
            accountKeys.set(m ? `${m[1]} ${m[2]}` : r.key, r.key);
            return {
              id: m ? `${m[1]} ${m[2]}` : r.key,
              name: r.name || r.key,
              currency: /-([A-Z]{3})$/.exec(r.key)?.[1] ?? "AUD",
            } satisfies BankAccount;
          });
        const unique = [...new Map(accounts.map((a) => [a.id, a])).values()];
        if (!unique.length) throw new ProviderError("Macquarie: couldn't read any accounts");
        return unique;
      },

      async fetchTransactions(range) {
        const accounts = await this.listAccounts!();
        const all: BankTransaction[] = [];
        for (const [i, acct] of accounts.entries()) {
          // Accounts page -> click the account -> "Download transactions" (top right of Transactions).
          if (!/#\/accounts\/?$/.test(page.url())) {
            await page.goto(ACCOUNTS_URL, { waitUntil: "domcontentloaded" });
            await page.locator("[data-accountid]").first().waitFor({ state: "attached", timeout: 30_000 });
            await settle(page);
          }
          await page.keyboard.press("Escape").catch(() => {}); // close a side menu left open
          const key = accountKeys.get(acct.id)!;
          const row = page.locator(`[data-accountid="${key}"]`).locator("xpath=ancestor::tr[1]");
          ctx.log(`macquarie: opening ${acct.name}`);
          await row.locator(".accounts-list-group-table__product-name").first().click();
          const dl = page.locator(SEL.downloadButton).first();
          await dl.waitFor({ timeout: 30_000 }).catch(async () => {
            await snapshot(ctx, `no-download-${i}`);
            throw new ProviderError(`Macquarie: no "Download transactions" button for ${acct.name}`);
          });
          await settle(page);

          await applyDateRange(range, i);
          if (await visible(page.getByText(/nothing to see here/i))) {
            ctx.log(`macquarie: ${acct.name}: no transactions in the sync period`);
            await page.goto(ACCOUNTS_URL, { waitUntil: "domcontentloaded" });
            continue;
          }

          // Download -> ".CSV" (the sheet's CSV button downloads straight away).
          await dl.click();
          const csvButton = page.locator(SEL.downloadCsv).first();
          await csvButton.waitFor({ timeout: 15_000 }).catch(async () => {
            await snapshot(ctx, `download-sheet-${i}`);
            throw new ProviderError(`Macquarie: the download sheet has no .CSV button for ${acct.name}`);
          });
          const download = page.waitForEvent("download", { timeout: 60_000 });
          await csvButton.click();
          const file = await download;
          const path = await file.path();
          if (ctx.debug) await file.saveAs(join(ctx.debugDir, `macquarie-${i}-${file.suggestedFilename()}`));
          const txns = parseMacquarieCsv(await readFile(path, "utf8"), acct).filter(
            (t) => t.date >= range.since && t.date <= range.until,
          );
          ctx.log(`macquarie: ${acct.name}: ${txns.length} transactions in the sync period`);
          all.push(...txns);
          await page.goto(ACCOUNTS_URL, { waitUntil: "domcontentloaded" });
        }
        return all;
      },

      async logout() {
        const btn = page?.locator(SEL.logout).first();
        if (btn && (await visible(btn))) {
          await btn.click();
          await settle(page);
          ctx.log("macquarie: logged out");
        }
      },
    };
  },
};

/**
 * Macquarie sometimes covers the page with a full-screen "What's new"
 * announcement (e.g. Confirmation of Payee), possibly over several slides.
 * Whenever it's in the way of a click or typing, page through it and close
 * it, the way a person would.
 */
const watched = new WeakSet<Page>();
export async function dismissWhatsNew(page: Page, log: (m: string) => void): Promise<void> {
  if (watched.has(page)) return;
  watched.add(page);
  const popup = page.locator("mq-whats-new .mq-whats-new__actions");
  await page.addLocatorHandler(popup, async () => {
    const title = (await page.locator("mq-whats-new .mq-whats-new__information-title").first().innerText().catch(() => "")).trim();
    log(`macquarie: closing a "What's new" popup${title ? ` (${title})` : ""}`);
    for (let i = 0; i < 8 && (await popup.isVisible().catch(() => false)); i++) {
      const close = page
        .locator("mq-whats-new .mq-whats-new__actions--finish, mq-whats-new .mq-whats-new__dismiss-button-container button")
        .or(page.locator("mq-whats-new").getByRole("button", { name: /got it|close|skip|done|next|not now|maybe later/i }))
        .locator("visible=true")
        .first();
      if (!(await close.count())) break;
      await close.click();
      await page.waitForTimeout(400 + Math.random() * 400);
    }
  });
}
