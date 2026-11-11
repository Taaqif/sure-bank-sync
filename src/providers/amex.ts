/**
 * American Express (Australia).
 *
 * Login: americanexpress.com/en-au/account/login (User ID + password). New
 * devices usually get an identity check (pick SMS/email, then a one-time
 * code); both steps go through the MFA box in the web UI. The connection's
 * browser profile remembers the device afterwards.
 *
 * Transactions: activity search (/activity/search): type the sync period into
 * its Date Range (checked against the page's hidden YYYY-MM-DD inputs), press
 * Search, and read the JSON the page loads from
 * /api/servicing/v1/financials/transactions. Amex
 * lists amounts as positive with a DEBIT/CREDIT type; charges become money
 * out (negative).
 *
 * Selectors started from an earlier, unverified script and need checking with
 * a Debug run whenever Amex changes its pages.
 */
import type { Locator, Page, Response } from "playwright";
import type { BankAccount, BankTransaction } from "../models.js";
import { bankDate } from "./csv.js";
import { AuthError, ProviderError, captureJson, pause, settle, snapshot, type ProviderContext, type ProviderDefinition } from "./base.js";

const LOGIN_URL = "https://www.americanexpress.com/en-au/account/login";
const APP_HOST = "global.americanexpress.com";
const DASHBOARD_URL = `https://${APP_HOST}/dashboard`;

const SEL = {
  username: "#eliloUserID",
  password: "#eliloPassword",
  submit: "#loginSubmit",
  rememberMe: "#rememberMe",
  /** "View All" on the dashboard's Recent Transactions card */
  rememberMeLabel: 'label[for="rememberMe"]',
  /** present on any signed-in page */
  signedIn: 'a[href*="logout" i], button:has-text("Log Out"), [data-testid*="logout" i]',
  logout: 'a[href*="logout" i], button:has-text("Log Out"), [data-testid*="logout" i]',
  /** one-time code field on the identity check */
  codeInput: [
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
  ].join(", "),
  choices: 'button, [role="button"], [role="radio"], label',
  /** Google reCAPTCHA shown when Amex suspects automation */
  captcha: 'iframe[src*="recaptcha"][title*="reCAPTCHA" i], iframe[src*="recaptcha/api2/anchor"]',
};
const VERIFY_TEXT = /verify (it'?s|your identity)|one[- ]time (code|password)|verification code|confirm (it'?s|your identity)/i;
const ERROR_TEXT = /(incorrect|invalid|doesn'?t match).*(user ?id|password)|(user ?id|password).*(incorrect|invalid)|account (is |has been )?locked|temporarily (locked|suspended)/i;
/** how an identity-check option for sending a code tends to read */
const SEND_CHOICE = /sms|text|e-?mail|call|phone|mobile|send|\*{2,}|•{2,}/i;

const UNAVAILABLE_TEXT = /information is unavailable at this time/i;
const visible = (l: Locator) => l.first().isVisible().catch(() => false);

/** "03/10/2026", "3 Oct 2026", "03 Oct. 2026", "2026-10-03" -> "2026-10-03" */
export const amexDate = bankDate;

/**
 * Does the User ID Amex pre-filled ("Ta*****", maybe with visible trailing
 * characters) belong to `username`? Unmasked values must match exactly.
 */
export function rememberedMatches(shown: string, username: string): boolean {
  const m = /^([^*•]*)[*•]+([^*•]*)$/.exec(shown);
  if (!m) return shown.toLowerCase() === username.toLowerCase();
  const [, head, tail] = m as unknown as [string, string, string];
  const u = username.toLowerCase();
  return head.length + tail.length < u.length + 1 && u.startsWith(head.toLowerCase()) && u.endsWith(tail.toLowerCase());
}

/** "-12345" / "XXXX-XXXXXX-12345" -> "12345" (last digits only; never the full number) */
function cardSuffix(s: string): string {
  return /(\d{4,5})\D*$/.exec(s)?.[1] ?? "";
}

/** The account the CSV rows and the dashboard both map to for a card ending in `suffix`. */
export const amexAccount = (suffix: string): BankAccount => ({ id: `amex-${suffix}`, name: `Amex ••${suffix}`, currency: "AUD" });

/**
 * Cards shown on the dashboard ("••••21002" under the card name, "-21002" in
 * the card switcher), as accounts. Same ids as the CSV rows.
 */
export function amexDashboardAccounts(text: string): BankAccount[] {
  const suffixes = new Set<string>();
  for (const m of text.matchAll(/[•·*]{2,}\s*(\d{4,5})\b/g)) suffixes.add(m[1]!);
  return [...suffixes].map(amexAccount);
}

const SEARCH_URL = `https://${APP_HOST}/activity/search`;
const TXN_API_PATH = "/api/servicing/v1/financials/transactions";
const API_PAGE = 1000;

/**
 * Type a YYYY-MM-DD date into one of the search page's Day / Month / Year
 * groups, then check the page took it (it keeps the result in a hidden
 * YYYY-MM-DD input).
 */
async function typeAmexDate(page: Page, group: Locator, hidden: string, date: string): Promise<void> {
  const [y, m, d] = date.split("-") as [string, string, string];
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const [label, value] of [["Day", d], ["Month", m], ["Year", y]] as const) {
      const box = group.getByLabel(label, { exact: true });
      await box.click();
      await page.keyboard.press("ControlOrMeta+A");
      await box.pressSequentially(value, { delay: 60 });
      await pause(100, 250);
    }
    await page.keyboard.press("Tab");
    await pause(200, 400);
    if ((await group.locator(hidden).inputValue().catch(() => "")) === date) return;
  }
  throw new ProviderError(`Amex: the search page didn't take the date ${date}`);
}

/** The app's own request headers worth repeating (the browser adds cookies and the rest). */
function apiHeaders(all: Record<string, string>): Record<string, string> {
  const skip = /^(:|cookie$|host$|content-length$|connection$|accept-encoding$|user-agent$|referer$|origin$|sec-|priority$)/i;
  return Object.fromEntries(Object.entries(all).filter(([k]) => !skip.test(k)));
}

/** One transaction from Amex's activity API (only the fields used). */
export interface AmexApiTxn {
  reference_id?: string;
  identifier?: string;
  description?: string;
  /** YYYY-MM-DD the purchase was made (the CSV's Date) */
  charge_date?: string;
  post_date?: string;
  /** always positive; `type` says which way */
  amount?: number;
  /** DEBIT = charge, CREDIT = payment or refund */
  type?: string;
  display_account_number?: string;
}

/**
 * Activity API rows -> transactions, one account per card number. Ids are
 * Amex's reference (as in the old CSV's Reference column), so rows synced
 * from the CSV aren't sent again.
 */
export function parseAmexTransactions(rows: AmexApiTxn[]): BankTransaction[] {
  const accounts = new Map<string, BankAccount>();
  const out: BankTransaction[] = [];
  for (const r of rows) {
    const date = r.charge_date ?? r.post_date ?? "";
    const cents = Math.round(Math.abs(Number(r.amount)) * 100);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(cents)) {
      throw new ProviderError(`Amex: unexpected transaction ${JSON.stringify({ date, amount: r.amount })}`);
    }
    const suffix = cardSuffix(r.display_account_number ?? "");
    let account = accounts.get(suffix);
    if (!account) accounts.set(suffix, (account = suffix ? amexAccount(suffix) : { id: "amex", name: "Amex card", currency: "AUD" }));
    out.push({
      account,
      date,
      // charges are money out; payments and refunds money in
      amountCents: String(r.type).toUpperCase() === "CREDIT" ? cents : -cents,
      description: (r.description ?? "").replace(/\s+/g, " ").trim(),
      bankId: r.reference_id || r.identifier || undefined,
    });
  }
  return out;
}

const STEP_TIMEOUT = 45_000;

export const amex: ProviderDefinition = {
  name: "amex",
  label: "American Express (AU)",
  credentialFields: [
    { key: "username", label: "User ID" },
    { key: "password", label: "Password", secret: true },
  ],
  startUrl: LOGIN_URL,
  syncPeriod: { choices: [7, 14, 30, 60, 90, 180], default: 14, customRange: true },
  create: (ctx: ProviderContext) => {
    // Full API responses hold account data: only capture them on debug runs.
    if (ctx.debug) captureJson(ctx, /(^|\.)americanexpress\.com$/);
    let page: Page;

    const onApp = () => {
      try {
        const u = new URL(page.url());
        return u.host === APP_HOST && !/login|logon/i.test(u.pathname);
      } catch {
        return false;
      }
    };

    /** Wait until the page is signed in, asks for verification, or shows a login error. */
    async function state(timeout = STEP_TIMEOUT): Promise<"signed_in" | "verify" | "captcha" | "rejected" | "timeout"> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (onApp() && (await visible(page.locator(SEL.signedIn)))) return "signed_in";
        if (await visible(page.locator(SEL.captcha))) return "captcha";
        const body = await page.locator("body").innerText().catch(() => "");
        if (ERROR_TEXT.test(body)) return "rejected";
        if (VERIFY_TEXT.test(body)) return "verify";
        await pause(700, 1000);
      }
      return onApp() ? "signed_in" : "timeout";
    }

    async function choices(): Promise<{ locator: Locator; text: string }[]> {
      const out: { locator: Locator; text: string }[] = [];
      for (const locator of await page.locator(SEL.choices).all()) {
        if (out.length >= 15) break;
        if (!(await locator.isVisible().catch(() => false))) continue;
        const text = (await locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (text && text.length < 120 && !out.some((o) => o.text === text)) out.push({ locator, text });
      }
      const likely = out.filter((o) => SEND_CHOICE.test(o.text));
      return likely.length ? likely : out;
    }

    /**
     * Amex showed a reCAPTCHA. It is never solved automatically: a person
     * solves it in the web UI's browser view (or the debug window).
     */
    async function captchaStep(): Promise<void> {
      await snapshot(ctx, "captcha");
      await ctx.requestBrowserHelp(
        page,
        "Amex is showing a CAPTCHA. Solve it (including any picture puzzle); the run continues once it's gone.",
        async () => !(await visible(page.locator(SEL.captcha))),
      );
      await pause(800, 1500);
      // If the form is still there once the CAPTCHA is gone, submit it again.
      if (!(await visible(page.locator(SEL.captcha))) && (await visible(page.locator(SEL.submit))) && !onApp()) {
        ctx.log("amex: CAPTCHA done, submitting the login again");
        await page.locator(SEL.submit).click();
      }
    }

    /** One identity-check step: type a code if there's a field, else pick how to receive it. */
    async function verifyStep(step: number): Promise<void> {
      await snapshot(ctx, `verify-${step}`);
      const code = page.locator(SEL.codeInput).locator("visible=true").first();
      if (await code.count()) {
        const value = await ctx.requestMfa("Amex sent a one-time code. Enter it here.");
        const before = page.url();
        await code.click();
        await code.pressSequentially(value.replace(/\s+/g, ""), { delay: 90 });
        await pause(300, 700);
        const confirm = page.getByRole("button", { name: /verify|continue|confirm|submit|next/i }).first();
        if (await visible(confirm)) await confirm.click();
        else await code.press("Enter");
        await Promise.race([
          code.waitFor({ state: "detached", timeout: 30_000 }),
          page.waitForURL((u) => u.toString() !== before, { timeout: 30_000 }),
        ]).catch(() => {});
        await settle(page);
        return;
      }

      const opts = await choices();
      if (!opts.length) throw new ProviderError("Amex identity check shows no code field or options (see the screenshot)");
      ctx.log(`amex: identity check options: ${opts.map((o, i) => `${i + 1}. ${o.text}`).join(" | ")}`);
      const answer = await ctx.requestMfa(
        `Amex wants to verify it's you. Reply with the number of how to get the code: ${opts.map((o, i) => `${i + 1}. ${o.text}`).join("  ")}`,
      );
      const picked = opts[Number(answer.trim()) - 1];
      if (!picked) throw new ProviderError(`Amex identity check: "${answer}" isn't one of the options`);
      ctx.log(`amex: chose "${picked.text}"`);
      await picked.locator.click();
      // A radio choice may need a separate send/continue button.
      const send = page.getByRole("button", { name: /send|continue|next/i }).first();
      await pause(500, 900);
      if (await visible(send)) await send.click();
      await settle(page);
    }

    return {
      async login() {
        page = ctx.browser.pages()[0] ?? (await ctx.browser.newPage());
        ctx.log("amex: opening login page");
        await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
        const opened = Date.now();
        const user = page.locator(SEL.username);
        await user.waitFor({ timeout: 30_000 });
        // Let the page's scripts finish loading: a Log in click before then is silently ignored.
        await settle(page);

        // With Remember Me, Amex pre-fills a masked User ID ("Ta*****"). Keep it
        // when it's ours; otherwise clear the field before typing.
        const username = ctx.credentials.username!;
        const current = (await user.inputValue().catch(() => "")).trim();
        if (current && rememberedMatches(current, username)) {
          ctx.log("amex: User ID remembered by Amex, typing password only");
        } else {
          await user.click();
          if (current) {
            ctx.log("amex: clearing a different pre-filled User ID");
            await user.fill("");
            await pause(200, 500);
          }
          await user.pressSequentially(username, { delay: 90 });
        }
        await pause(300, 800);
        await page.locator(SEL.password).click();
        await page.locator(SEL.password).pressSequentially(ctx.credentials.password!, { delay: 80 });
        await pause(400, 900);
        // Remembered devices get fewer CAPTCHAs and identity checks. Best effort:
        // the real input is visually hidden behind its label, so click the label.
        try {
          const box = page.locator(SEL.rememberMe);
          if ((await box.count()) && !(await box.isChecked())) {
            await page.locator(SEL.rememberMeLabel).click({ timeout: 5_000 });
            await pause(300, 700);
            if (!(await box.isChecked())) ctx.log("amex: couldn't tick Remember Me (continuing)");
          }
        } catch (e) {
          ctx.log(`amex: couldn't tick Remember Me (continuing): ${(e as Error).message.split("\n")[0]}`);
        }
        // Spend a human amount of time on the page before submitting.
        const minDwell = 6000 + Math.random() * 3000;
        if (Date.now() - opened < minDwell) await pause(minDwell - (Date.now() - opened), minDwell - (Date.now() - opened) + 500);

        // Log login API calls (method, status, path; no bodies) so a silent failure shows up in the run log.
        let loginSent = false;
        const onResponse = (res: Response) => {
          const req = res.request();
          if (/\/myca\/logon\/.*\/login/.test(req.url())) loginSent = true;
          const api = ["xhr", "fetch"].includes(req.resourceType()) && req.method() !== "GET";
          if (!api && req.resourceType() !== "document") return;
          try {
            const u = new URL(res.url());
            if (/americanexpress\.com$/.test(u.host)) ctx.log(`amex: ${req.method()} ${u.host}${u.pathname} -> ${res.status()}`);
          } catch {}
        };
        page.on("response", onResponse);
        try {
          await page.locator(SEL.submit).click({ timeout: 15_000 });
          ctx.log("amex: credentials submitted");

          // If the click didn't send the login (page not ready), click once more.
          for (let i = 0; i < 24 && !loginSent && !onApp(); i++) await pause(450, 550);
          const stalled = async () =>
            !loginSent && !onApp() && !(await visible(page.locator(SEL.captcha))) && (await visible(page.locator(SEL.submit)));
          if (await stalled()) {
            ctx.log("amex: login wasn't sent, clicking Log in again");
            await pause(800, 1500);
            await page.locator(SEL.submit).click({ timeout: 15_000 });
            for (let i = 0; i < 20 && !loginSent && !onApp(); i++) await pause(450, 550);
          }
          // Fallback: Amex sometimes refuses the automated submit (the login request is blocked
          // before it leaves the page). Hand the page to a person to press Log in.
          if (await stalled()) {
            ctx.log("amex: login still not sent; asking you to press Log in");
            await snapshot(ctx, "login-stalled");
            await ctx.requestBrowserHelp(
              page,
              "Amex's login page stalled. Press Log in in the browser view (re-enter the password if the box is empty). The run continues once you're past the login page.",
              async () => loginSent || onApp() || (await visible(page.locator(SEL.captcha))),
            );
          }

          for (let step = 1; step <= 8; step++) {
            const s = await state();
            if (s === "signed_in") {
              ctx.log("amex: logged in");
              await settle(page);
              return;
            }
            if (s === "rejected") {
              const text = (await page.locator("body").innerText().catch(() => "")).match(ERROR_TEXT)?.[0] ?? "";
              await snapshot(ctx, "login-failed");
              throw new AuthError(`Amex login failed: ${text || "rejected"}`);
            }
            if (s === "captcha") {
              ctx.log("amex: CAPTCHA shown");
              await captchaStep();
              continue;
            }
            if (s === "timeout") {
              await snapshot(ctx, "login-stuck");
              throw new ProviderError(`Amex login did not finish (stuck at ${new URL(page.url()).host}${new URL(page.url()).pathname})`);
            }
            ctx.log(`amex: identity check (step ${step})`);
            await verifyStep(step);
          }
          throw new ProviderError("Amex login did not finish within 8 steps");
        } finally {
          page.off("response", onResponse);
        }
      },

      async listAccounts() {
        if (!/^\/dashboard/.test(new URL(page.url()).pathname)) {
          await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
          await settle(page);
        }
        // The card tiles render after the page loads; wait for a "••••12345".
        await page
          .getByText(/[•·*]{2,}\s*\d{4,5}/)
          .first()
          .waitFor({ timeout: 30_000 })
          .catch(() => {});
        const accounts = amexDashboardAccounts(await page.locator("body").innerText().catch(() => ""));
        if (!accounts.length) {
          await snapshot(ctx, "no-cards");
          throw new ProviderError("Amex: couldn't find a card number on the dashboard (see the screenshot)");
        }
        return accounts;
      },

      async fetchTransactions(range) {
        // Activity search (/activity/search): set its Date Range to the sync
        // period and press Search. The page then loads the transactions from a
        // JSON API; read that response rather than a downloaded file.
        ctx.log("amex: opening activity search");
        await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });
        const start = page.getByRole("group", { name: "Start date", exact: true });
        const end = page.getByRole("group", { name: "End date", exact: true });
        await start.waitFor({ timeout: 45_000 }).catch(async () => {
          await snapshot(ctx, "amex-search");
          const text = await page.locator("body").innerText().catch(() => "");
          if (UNAVAILABLE_TEXT.test(text)) {
            throw new ProviderError("Amex says \"Your information is unavailable at this time\" (a problem on Amex's side; the next run usually works)");
          }
          throw new ProviderError("Amex: no date range on the activity search page");
        });
        await settle(page);

        ctx.log(`amex: searching ${range.since} to ${range.until}`);
        await typeAmexDate(page, start, 'input[name$="-start-date"]', range.since);
        await pause(200, 500);
        await typeAmexDate(page, end, 'input[name$="-end-date"]', range.until);
        await pause(300, 700);

        const posted = page.waitForResponse(
          (r) => r.url().includes(TXN_API_PATH) && /[?&]status=posted\b/.test(r.url()) && r.url().includes(`start_date=${range.since}`),
          { timeout: 45_000 },
        );
        posted.catch(() => {});
        // The date range's own Search button (the business-name form has another).
        await page.locator('button[type="button"]').filter({ hasText: /^\s*Search\s*$/ }).first().click();
        let res: Response;
        try {
          res = await posted;
        } catch {
          await snapshot(ctx, "amex-search-results");
          throw new ProviderError("Amex: pressing Search didn't load any transactions");
        }
        if (res.status() === 401 || res.status() === 403) throw new AuthError(`Amex: transactions API refused the session (HTTP ${res.status()})`);
        if (!res.ok()) throw new ProviderError(`Amex: transactions API answered HTTP ${res.status()}`);
        const first = (await res.json()) as { total_count?: number; transactions?: AmexApiTxn[] };
        const rows = [...(first.transactions ?? [])];

        // More than one page (over 1000 transactions): ask for the rest the way the page did.
        if (rows.length < (first.total_count ?? 0)) {
          const headers = apiHeaders(await res.request().allHeaders());
          const next = new URL(res.url());
          for (let offset = rows.length; offset < (first.total_count ?? 0) && offset < 20_000; offset += API_PAGE) {
            next.searchParams.set("offset", String(offset));
            const more = await page.evaluate(
              async ([url, h]) => {
                const r = await fetch(url, { headers: h, credentials: "include" });
                return { status: r.status, text: await r.text() };
              },
              [next.toString(), headers] as const,
            );
            if (more.status !== 200) throw new ProviderError(`Amex: transactions API answered HTTP ${more.status} for more results`);
            const got = (JSON.parse(more.text) as { transactions?: AmexApiTxn[] }).transactions ?? [];
            if (!got.length) break;
            rows.push(...got);
          }
        }

        const txns = parseAmexTransactions(rows).filter((t) => t.date >= range.since && t.date <= range.until);
        const cards = [...new Set(txns.map((t) => t.account.name))];
        ctx.log(`amex: ${txns.length} posted transactions ${range.since} to ${range.until}${cards.length ? ` (${cards.join(", ")})` : ""}`);
        return txns;
      },

      async logout() {
        const btn = page?.locator(SEL.logout).first();
        if (btn && (await btn.isVisible().catch(() => false))) {
          await btn.click();
          await settle(page);
          ctx.log("amex: logged out");
        }
      },
    };
  },
};
