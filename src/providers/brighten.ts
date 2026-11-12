/**
 * Brighten home loans (myloan.brighten.com.au).
 *
 * Login: username + password, then an SMS code. The code is asked for
 * through the web UI's code box (ctx.requestMfa), so nobody has to take over
 * the browser. A session lasts about a day and is kept in the saved browser
 * profile, so a run within a day of the last one is usually already logged in.
 *
 * The portal is one GraphQL endpoint (/graphql). Login state is read from
 * its answers rather than the page text: loginV2 says MFAREQUIRED, then
 * AuthSucceeded; userSession answers once logged in.
 *
 * Data: the same GraphQL queries the portal uses (like Stake's API), not
 * the pages: financeSummary lists the loan accounts, accountByIdOrNumber
 * returns an account's whole transaction history (no date filter; the
 * period is applied here). Debug runs also save every answer (network/) and
 * every query the portal sends (network/gql-*.json, login values blanked).
 *
 * Brighten's server leaves out its intermediate certificate, so Node's own
 * HTTP client (and browser.request) refuses it. Chromium fetches the missing
 * certificate itself, so API calls must run inside the page (#api).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Request, Response } from "playwright";
import { AuthError, captureJson, pause, ProviderError, settle, snapshot, type DateRange, type ProviderContext, type ProviderDefinition } from "./base.js";
import type { BankAccount, BankTransaction } from "../models.js";

const LOGIN_URL = "https://myloan.brighten.com.au/";
const HOST = /(^|\.)brighten\.com\.au$/;

const USER =
  'input[type="email"], input[autocomplete="username"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[id*="email" i], input[name*="login" i]';
const PASSWORD = 'input[type="password"]';
const CODE =
  'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="code" i], input[id*="code" i], input[name*="token" i], input[id*="token" i], input[inputmode="numeric"]';
const SUBMIT = /log ?in|sign ?in|continue|next|verify|submit|confirm/i;
/** "Close other sessions" on the active sessions page (its "Log Out" button, right next to it, ends this session). */
const CLOSE_OTHERS = '#closeOtherSessionsButton';
const CLOSE_OTHERS_NAME = /^\s*close other sessions\s*$/i;
/** GraphQL variables never written to debug files. */
const SECRET_VAR = /pass|token|code|otp|secret|mfa|pin/i;
/** Codes are asked for this many times before giving up (a typo shouldn't end the run). */
const CODE_TRIES = 2;

type AuthState = "none" | "mfa" | "in" | "bad";

export const brighten: ProviderDefinition = {
  name: "brighten",
  label: "Brighten",
  note:
    "Map it to a Loan account in Sure: interest and fees go in as money out, repayments as money in. " +
    "Brighten texts a code to your phone when it logs in; the run waits for someone to type it in the banner at the top of the page " +
    "(up to the MFA timeout in Settings). A login stays valid for about a day, so runs within a day of the last one usually skip the SMS.",
  credentialFields: [
    { key: "username", label: "Username" },
    { key: "password", label: "Password", secret: true },
  ],
  syncPeriod: {
    allTime: true,
    note: "Brighten sends the loan's whole history every time, so any period is quick. Use All time for a first import.",
  },
  startUrl: LOGIN_URL,
  create: (ctx) => new BrightenProvider(ctx),
};

class BrightenProvider {
  #page: Page | null = null;
  #auth: AuthState = "none";
  #authMessage = "";
  #gqlSaved = 0;

  /** Read through a method: the response handler changes #auth while login awaits. */
  #state(): AuthState {
    return this.#auth;
  }

  constructor(private readonly ctx: ProviderContext) {
    ctx.browser.on("response", (r: Response) => void this.#watch(r));
    if (ctx.debug) {
      captureJson(ctx, HOST);
      ctx.browser.on("request", (r: Request) => void this.#saveQuery(r));
    }
  }

  /** Follow the login from the portal's GraphQL answers. */
  async #watch(r: Response): Promise<void> {
    if (!isGraphql(r.url()) || r.request().method() !== "POST") return;
    const body = (await r.json().catch(() => null)) as { data?: Record<string, any> } | null;
    const data = body?.data;
    if (!data) return;
    const login = data.loginV2;
    if (login) {
      if (login.AuthSucceeded) this.#auth = "in";
      else if (login.AuthError === "MFAREQUIRED") this.#auth = "mfa";
      else {
        this.#auth = "bad";
        this.#authMessage = String(login.AuthMessage || login.AuthError || "");
      }
    } else if (data.userSession?.Id) {
      this.#auth = "in";
    }
  }

  /** Debug: save each GraphQL query and its variables (login values blanked), so the data side can be built from them. */
  async #saveQuery(r: Request): Promise<void> {
    if (!isGraphql(r.url()) || r.method() !== "POST") return;
    try {
      const posted = r.postDataJSON() as unknown;
      const ops = (Array.isArray(posted) ? posted : [posted]) as { operationName?: string; query?: string; variables?: unknown }[];
      const secrets = Object.values(this.ctx.credentials).filter((v) => v && v.length >= 3);
      const dir = join(this.ctx.debugDir, "network");
      await mkdir(dir, { recursive: true });
      for (const op of ops) {
        const n = String(++this.#gqlSaved).padStart(3, "0");
        const name = op.operationName || /(?:query|mutation)\s+(\w+)/.exec(op.query ?? "")?.[1] || "anonymous";
        const variables = blank(op.variables, secrets);
        await writeFile(join(dir, `gql-${n}-${name}.json`), JSON.stringify({ operationName: name, variables, query: op.query }, null, 2));
      }
    } catch {
      // not JSON or page gone; capture is best-effort
    }
  }

  async login(): Promise<void> {
    const { ctx } = this;
    const page = ctx.browser.pages()[0] ?? (await ctx.browser.newPage());
    this.#page = page;
    this.#auth = "none";
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await settle(page, { maxMs: 15_000 });

    const first = await this.#until(page, 30_000, () => this.#state() === "in" || this.#visible(page, USER, PASSWORD));
    if (this.#state() === "in") {
      ctx.log("brighten: already logged in");
      return this.#afterLogin(page);
    }
    if (!first) {
      await snapshot(ctx, "brighten-no-login-form");
      throw new ProviderError("Brighten: the login page didn't show a login form");
    }

    ctx.log("brighten: logging in");
    const user = page.locator(USER).first();
    if (await user.isVisible().catch(() => false)) await this.#type(user, ctx.credentials.username ?? "");
    const password = page.locator(PASSWORD).first();
    if (!(await password.isVisible().catch(() => false))) {
      // Username first, password on the next step.
      await this.#submit(page);
      await password.waitFor({ state: "visible", timeout: 20_000 });
    }
    await this.#type(password, ctx.credentials.password ?? "");
    await this.#submit(page);

    await this.#until(page, 45_000, () => this.#state() !== "none");
    if (this.#state() === "bad") {
      await snapshot(ctx, "brighten-login");
      throw new AuthError(`Brighten: login not accepted${this.#authMessage ? ` (${this.#authMessage})` : ""}`);
    }
    for (let attempt = 1; this.#state() !== "in"; attempt++) {
      if (this.#state() === "none") {
        await snapshot(ctx, "brighten-login");
        throw new ProviderError("Brighten: login didn't finish (no SMS code step and no session)");
      }
      if (attempt > CODE_TRIES) {
        await snapshot(ctx, "brighten-code");
        throw new AuthError(`Brighten didn't accept the SMS code${this.#authMessage ? ` (${this.#authMessage})` : ""}`);
      }
      await this.#enterCode(page, attempt);
    }
    ctx.log("brighten: logged in");
    await this.#afterLogin(page);
  }

  /** Ask for the SMS code in the web UI and type it in. Leaves #auth "in", "bad" (wrong code) or "none" (no answer). */
  async #enterCode(page: Page, attempt: number): Promise<void> {
    const { ctx } = this;
    const boxes = page.locator(CODE);
    await boxes.first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    if (!(await boxes.first().isVisible().catch(() => false))) {
      await snapshot(ctx, "brighten-no-code-box");
      throw new ProviderError("Brighten asked for an SMS code but no code box showed");
    }
    const code = (
      await ctx.requestMfa(
        attempt === 1
          ? "Brighten texted a code to your phone. Type it here."
          : `Brighten didn't accept that code${this.#authMessage ? ` (${this.#authMessage})` : ""}. Type the latest code from the SMS.`,
      )
    ).replace(/\s/g, "");
    if (!/^\d{4,8}$/.test(code)) throw new AuthError("Brighten: that doesn't look like an SMS code (expected 4-8 digits)");

    ctx.log("brighten: entering the SMS code");
    await boxes.first().click();
    await boxes.first().fill("").catch(() => {});
    // One box or one box per digit: typing fills either.
    await page.keyboard.type(code, { delay: 80 });
    await pause(300, 700);
    this.#auth = "mfa";
    this.#authMessage = "";
    await this.#submit(page).catch(() => {});
    await this.#until(page, 30_000, () => this.#state() !== "mfa");
    if (this.#state() === "mfa") this.#auth = "none";
  }

  /**
   * Every fresh login opens a session that lasts a day, so the portal often
   * stops on an "active sessions" page listing the others. Close them (as a
   * person would). The data comes from the API either way, so if no button
   * is found the run carries on.
   */
  async #afterLogin(page: Page): Promise<void> {
    await settle(page, { maxMs: 15_000 });
    if (!/activesessions/i.test(page.url())) return;
    await snapshot(this.ctx, "brighten-active-sessions");
    const button = page.locator(CLOSE_OTHERS).or(page.getByRole("button", { name: CLOSE_OTHERS_NAME })).first();
    if (await button.isVisible().catch(() => false)) {
      this.ctx.log("brighten: other sessions open, closing them");
      await button.click();
      await settle(page, { maxMs: 15_000 });
    } else {
      this.ctx.log("brighten: other sessions open and no Close other sessions button found; carrying on");
    }
  }

  async #visible(page: Page, ...selectors: string[]): Promise<boolean> {
    for (const s of selectors) if (await page.locator(s).first().isVisible().catch(() => false)) return true;
    return false;
  }

  /** Poll `done` every half second for up to `ms`. */
  async #until(page: Page, ms: number, done: () => boolean | Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await done()) return true;
      await page.waitForTimeout(500);
    }
    return !!(await done());
  }

  /** Type like a person, retrying if the page cleared the box. */
  async #type(box: ReturnType<Page["locator"]>, value: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await box.click();
      await box.fill("");
      await box.pressSequentially(value, { delay: 40 + Math.random() * 40 });
      await pause(300, 600);
      if ((await box.inputValue().catch(() => "")) === value) return;
    }
    await snapshot(this.ctx, "brighten-typing");
    throw new ProviderError("Brighten: a login box keeps clearing itself");
  }

  async #submit(page: Page): Promise<void> {
    const button = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').or(page.getByRole("button", { name: SUBMIT })).first();
    if (await button.isVisible().catch(() => false)) await button.click();
    else await page.keyboard.press("Enter");
  }

  /**
   * Run a GraphQL query from inside the logged-in page, so it uses the
   * page's session cookie and Chromium's certificate handling (see the top of the file).
   */
  async #gql<T>(operationName: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const page = this.#page;
    if (!page) throw new ProviderError("Brighten: not logged in");
    const res = await page.evaluate(
      async (body) => {
        const r = await fetch("/graphql", {
          method: "POST",
          credentials: "include",
          // The portal's own GraphQL client sends "Interfi: 1" on every call; without it queries fail with "Unexpected Execution Error".
          headers: { "Content-Type": "application/json", Accept: "application/json", Interfi: "1" },
          body: JSON.stringify(body),
        });
        return { status: r.status, text: await r.text() };
      },
      { operationName, query, variables },
    );
    if (res.status === 401 || res.status === 403) throw new AuthError(`Brighten: session not accepted (HTTP ${res.status})`);
    if (res.status < 200 || res.status >= 300) throw new ProviderError(`Brighten: ${operationName} answered HTTP ${res.status}`);
    const body = JSON.parse(res.text) as { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] };
    const err = body.errors?.[0];
    if (err?.extensions?.code === "AUTH_NOT_AUTHENTICATED") throw new AuthError("Brighten: the session ended (not authenticated)");
    if (err || !body.data) throw new ProviderError(`Brighten: ${operationName} failed: ${err?.message ?? "no data"}`);
    if (this.ctx.debug) await this.#saveAnswer(operationName, body.data);
    return body.data;
  }

  async #saveAnswer(name: string, data: unknown): Promise<void> {
    const dir = join(this.ctx.debugDir, "network");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `api-${name}-${Date.now()}.json`), JSON.stringify(data, null, 2));
  }

  #accounts: BankAccount[] | null = null;

  async listAccounts(): Promise<BankAccount[]> {
    if (this.#accounts) return this.#accounts;
    const data = await this.#gql<{ financeSummary?: { Instruments?: { Accounts?: Item[] }[] } }>("FinanceSummary", ACCOUNTS_QUERY);
    const raw = (data.financeSummary?.Instruments ?? []).flatMap((i) => i.Accounts ?? []);
    this.#accounts = raw.filter((a) => a.Number != null).map(toAccount);
    if (!this.#accounts.length) throw new ProviderError("Brighten: no loan accounts found");
    return this.#accounts;
  }

  async fetchTransactions(range: DateRange): Promise<BankTransaction[]> {
    const all: BankTransaction[] = [];
    for (const account of await this.listAccounts()) {
      // The portal's query has no date filter: it returns the loan's whole history, filtered here.
      const data = await this.#gql<{ accountByIdOrNumber?: { Transactions?: Item[] } }>("accountByIdOrNumber", TRANSACTIONS_QUERY, {
        idOrNumber: account.id,
      });
      const items = data.accountByIdOrNumber?.Transactions ?? [];
      const { rows, skipped, outOfRange } = parseBrighten(items, account, range);
      this.ctx.log(`brighten: ${account.name}: ${items.length} rows from Brighten, ${rows.length} in ${range.since} → ${range.until}`);
      if (outOfRange) this.ctx.log(`brighten: ${outOfRange} outside the period`);
      for (const why of skipped) this.ctx.log(`brighten: skipped ${why}`);
      all.push(...rows);
    }
    return all;
  }
}

type Item = Record<string, any>;

/** The portal's own queries, word for word (it may reject queries it doesn't know). */
const ACCOUNTS_QUERY = `query FinanceSummary {
  financeSummary {
    Id
    TotalPrincipal {
      CurrencyCode
      Amount
      __typename
    }
    TotalRedraw {
      CurrencyCode
      Amount
      __typename
    }
    Instruments {
      Id
      Number
      LoanPurpose
      Description
      TotalPrincipal
      TotalRedraw
      Status
      IsUnderHardshipAgreement
      InstrumentType
      Term
      TotalTermMonths
      RemainingTermMonths
      MaturityDate
      PrimaryBorrower
      Accounts {
        Id
        Number
        Description
        DisplayOrder
        InstrumentId
        LegacyNumber
        ProductType
        CurrentBalance
        Redraw
        InterestType
        CardAccount
        RemainingDisbursementAmount
        IsCashAccount
        IsNonMaturing
        DisableDisbursements
        EnablePayId
        PayId
        __typename
      }
      __typename
    }
    __typename
  }
}`;

const TRANSACTIONS_QUERY = `query accountByIdOrNumber($idOrNumber: String!) {
  accountByIdOrNumber(idOrNumber: $idOrNumber) {
    Id
    Number
    Description
    DisplayOrder
    InstrumentId
    LegacyNumber
    ProductType
    CurrentBalance
    Redraw
    ArrearsBalance
    InterestType
    CardAccount
    CardAvailable
    MonthlyInstalment
    NextInstalmentDue
    OffsetAccount
    BpayNumber
    BillerCode
    Rate
    RemainingDisbursementAmount
    IsCashAccount
    IsNonMaturing
    DisableDisbursements
    EnablePayId
    PayId
    RemainingTermMonths
    InstalmentFrequency
    RepaymentType
    InterestPaidFinancialYear
    InterestPaidToDate
    LastPaymentAmount
    LastPaymentDate
    IsNoLoanTerm
    Transactions {
      Id
      SequenceNumber
      TransactionNumber
      Processed
      Effective
      EffectiveDate
      TransactionType
      StatementText
      Increase
      Decrease
      Balance
      Note
      WasReversed
      WasDishonoured
      WasBackedOut
      WasWaived
      AppearsOnStatement
      CreatedOn
      IsPending
      BatchPaymentId
      __typename
    }
    Statements {
      Id
      Number
      InstrumentId
      AccountNumber
      AccountId
      PartyId
      ProcessedDate
      PeriodFrom
      PeriodTo
      FileId
      Filename
      Type
      AdHoc
      __typename
    }
    Cards {
      Id
      Number
      HolderRelationship
      State
      ExpiryDate
      Type
      NameOnCard
      __typename
    }
    CurrentUserAccountAuthority {
      Id
      BPay
      Operate
      InterAccount
      DirectDebit
      PayAnyone
      Redraw
      View
      __typename
    }
    __typename
  }
}`;

/** A Brighten loan account: the account number is its id (the portal looks accounts up by it). */
export function toAccount(a: Item): BankAccount {
  const number = String(a.Number);
  const product = String(a.Description || a.ProductType || "Home loan").trim();
  return { id: number, name: `Brighten ${product} (…${number.slice(-4)})`, currency: "AUD" };
}

/**
 * Brighten loan transactions -> rows for Sure, in the bank convention (money
 * out negative): interest, fees and drawdowns add to the loan (Increase) so
 * they're negative; repayments (Decrease) are positive.
 *
 * Only rows that appear on the statement count: the rest are the lender's
 * own bookkeeping (scheduled interest that duplicates the charge, moving the
 * loan between funders), which nets to nothing. A reversed row and its
 * reversal cancel out, so both are left out. Rate-change notices have no amount.
 */
export function parseBrighten(
  items: Item[],
  account: BankAccount,
  range: DateRange,
): { rows: BankTransaction[]; skipped: string[]; outOfRange: number } {
  const counts = new Map<string, number>();
  const skip = (why: string) => counts.set(why, (counts.get(why) ?? 0) + 1);
  const dateOf = (t: Item) => String(t.EffectiveDate || t.Processed || "").slice(0, 10);
  const cents = (t: Item) => Math.round((Number(t.Decrease) || 0) * 100) - Math.round((Number(t.Increase) || 0) * 100);

  // Pair each reversed row with a "reversal" row of the opposite amount on the same day.
  const cancelled = new Set<Item>();
  for (const t of items.filter((x) => x.WasReversed)) {
    const match = items.find(
      (x) => x !== t && !cancelled.has(x) && /revers/i.test(String(x.TransactionType ?? x.StatementText)) && dateOf(x) === dateOf(t) && cents(x) === -cents(t),
    );
    if (match) cancelled.add(t).add(match);
  }

  let outOfRange = 0;
  const rows: BankTransaction[] = [];
  for (const t of items) {
    const date = dateOf(t);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      skip("row without a date");
      continue;
    }
    if (date < range.since || date > range.until) {
      outOfRange++;
      continue;
    }
    if (t.AppearsOnStatement === false) continue;
    if (cancelled.has(t)) {
      skip("reversed (and its reversal)");
      continue;
    }
    const amountCents = cents(t);
    if (!amountCents) continue;
    const text = String(t.StatementText ?? "").trim();
    const description = (text && !text.includes("{{") ? text : String(t.Note || t.TransactionType || "Brighten transaction")).trim();
    rows.push({
      account,
      date,
      amountCents,
      description,
      bankId: t.Id ? String(t.Id) : t.TransactionNumber ? `txn:${t.TransactionNumber}` : undefined,
      pending: t.IsPending ? true : undefined,
    });
  }
  return { rows, skipped: [...counts].map(([why, n]) => `${n} × ${why}`), outOfRange };
}

const isGraphql = (url: string) => {
  try {
    const u = new URL(url);
    return HOST.test(u.host) && u.pathname.startsWith("/graphql");
  } catch {
    return false;
  }
};

/** Copy of GraphQL variables with login values and secret-looking fields replaced by "…". */
export function blank(v: unknown, secrets: string[], key = ""): unknown {
  if (key && SECRET_VAR.test(key)) return "…";
  if (typeof v === "string") return secrets.some((x) => v.includes(x)) ? "…" : v;
  if (Array.isArray(v)) return v.map((x) => blank(x, secrets));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x, secrets, k)]));
  return v;
}
