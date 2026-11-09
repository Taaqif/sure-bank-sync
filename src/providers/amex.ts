/**
 * American Express (Australia).
 *
 * Login: americanexpress.com/en-au/account/login (User ID + password). New
 * devices usually get an identity check (pick SMS/email, then a one-time
 * code); both steps go through the MFA box in the web UI. The connection's
 * browser profile remembers the device afterwards.
 *
 * Transactions: dashboard -> Recent Transactions "View All"
 * (/activity/recent?account_key=...) -> Download -> pick CSV in the "Select
 * Download File Type" modal -> Download, then parse the file. This covers the
 * current statement period only. Amex lists
 * charges as positive amounts; they are flipped so money out is negative.
 *
 * Selectors started from an earlier, unverified script and need checking with
 * a Debug run whenever Amex changes its pages.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, Response } from "playwright";
import { parseAmount, type BankAccount, type BankTransaction } from "../models.js";
import { bankDate, parseCsv } from "./csv.js";
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
  recentLink: 'a[href*="/activity/recent"]',
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

/**
 * Parse an Amex AU activity CSV. Header row required; columns matched by name
 * (Date, Description, Amount, plus optional Account #, Card Member, Reference).
 * Rows from several cards are split into one account per card number suffix.
 */
export function parseAmexCsv(text: string, fallback: BankAccount): BankTransaction[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const h = rows.shift()!.map((c) => c.toLowerCase().replace(/[^a-z#]/g, ""));
  const col = (...names: string[]) => h.findIndex((c) => names.includes(c));
  const c = {
    date: col("date", "transactiondate"),
    desc: col("description"),
    stmt: col("appearsonyourstatementas"),
    amount: col("amount"),
    account: col("account#", "accountnumber", "account"),
    reference: col("reference"),
  };
  if (c.date < 0 || c.amount < 0 || (c.desc < 0 && c.stmt < 0)) {
    throw new ProviderError(`Amex CSV: unrecognised header ${JSON.stringify(h)}`);
  }

  const accounts = new Map<string, BankAccount>();
  const accountFor = (raw: string | undefined): BankAccount => {
    const suffix = raw ? cardSuffix(raw) : "";
    if (!suffix) return fallback;
    let a = accounts.get(suffix);
    if (!a) accounts.set(suffix, (a = { id: `amex-${suffix}`, name: `Amex ••${suffix}`, currency: "AUD" }));
    return a;
  };

  return rows.map((r, i) => {
    const date = amexDate(r[c.date] ?? "");
    if (!date) throw new ProviderError(`Amex CSV row ${i + 2}: bad date ${JSON.stringify(r[c.date])}`);
    const description = ((c.desc >= 0 && r[c.desc]) || (c.stmt >= 0 && r[c.stmt]) || "").replace(/\s+/g, " ").trim();
    const reference = c.reference >= 0 ? (r[c.reference] ?? "").replace(/^['"]+|['"]+$/g, "").trim() : "";
    return {
      account: accountFor(c.account >= 0 ? r[c.account] : undefined),
      date,
      // Amex: charges positive, payments/refunds negative. Ours: money out negative.
      amountCents: -parseAmount(r[c.amount] ?? ""),
      description,
      bankId: reference || undefined,
    };
  });
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
  syncPeriod: {
    label: "current statement",
    fixed:
      "Amex doesn't support choosing a sync period. Each run downloads whatever Amex shows by default under Recent Transactions (the current statement period). Rows already in Sure are skipped.",
  },
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

      async fetchTransactions(range) {
        // Dashboard -> Recent Transactions "View All" (/activity/recent?account_key=...) -> Download -> CSV.
        if (!/^\/dashboard/.test(new URL(page.url()).pathname)) {
          await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
          await settle(page);
        }
        const recent = page.locator(SEL.recentLink).first();
        await recent.waitFor({ timeout: 30_000 }).catch(async () => {
          await snapshot(ctx, "no-recent-link");
          throw new ProviderError("Amex: no Recent Transactions link on the dashboard");
        });
        ctx.log("amex: opening Recent Transactions");
        await recent.click();
        await page.waitForURL(/\/activity\/recent/, { timeout: 30_000 });
        await settle(page);

        // "Recent Transactions (Since 11 Oct 2026. Closing 10 Nov 2026)": the file only covers this period.
        const since = /since\s+(\d{1,2}\s+[a-z]{3,}\.?\s+\d{4})/i.exec(await page.locator("body").innerText().catch(() => ""));
        const periodStart = since ? amexDate(since[1]!) : null;
        if (periodStart) ctx.log(`amex: current statement period starts ${periodStart}`);

        const download = page.getByRole("button", { name: /^\s*download\s*$/i }).or(page.getByRole("link", { name: /^\s*download\s*$/i })).first();
        await download.waitFor({ timeout: 30_000 }).catch(async () => {
          await snapshot(ctx, "no-download-button");
          throw new ProviderError("Amex: no Download button on Recent Transactions");
        });
        await download.click();

        // "Select Download File Type" modal: Excel is preselected, switch to CSV.
        const dialog = page.getByRole("dialog").filter({ hasText: /download file type/i }).first();
        await dialog.waitFor({ timeout: 20_000 });
        await pause(400, 800);
        const csv = dialog.getByRole("radio", { name: /^\s*csv\s*$/i }).first();
        // The radio input may be visually hidden; click its label like a person would.
        await dialog.locator("label").filter({ hasText: /^\s*CSV\s*$/ }).first().click({ timeout: 10_000 })
          .catch(() => csv.check({ force: true }));
        await pause(300, 700);
        if ((await csv.count()) && !(await csv.isChecked())) {
          await snapshot(ctx, "csv-not-selected");
          throw new ProviderError("Amex: couldn't select CSV in the download dialog");
        }

        ctx.log("amex: downloading CSV");
        const [dl] = await Promise.all([
          page.waitForEvent("download", { timeout: 60_000 }),
          dialog.getByRole("button", { name: /^\s*download\s*$/i }).last().click(),
        ]);
        const file = await dl.path();
        if (ctx.debug) await dl.saveAs(join(ctx.debugDir, "amex.csv"));

        const fallback: BankAccount = { id: "amex", name: "Amex card", currency: "AUD" };
        // No sync period for Amex: everything in the current statement file is used.
        const all = parseAmexCsv(await readFile(file, "utf8"), fallback);
        const txns = all.filter((t) => t.date <= range.until);
        const cards = [...new Set(all.map((t) => t.account.name))];
        ctx.log(
          `amex: ${txns.length} transactions in the current statement (${cards.join(", ") || "no rows"}; ${dl.suggestedFilename()})`,
        );
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
