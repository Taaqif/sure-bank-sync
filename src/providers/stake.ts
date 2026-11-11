/**
 * Stake (hellostake.com), Australian shares (ASX) only: the AUD wallet's
 * deposits, withdrawals and dividends, and ASX buys and sells. Wall St (USD)
 * isn't covered.
 *
 * Login: the trading web app with email + password, then the 2FA code, made
 * here from the authenticator secret. Stake has no CSV export, so data comes
 * from the JSON API the web app itself calls, using the session token the
 * app sends in its "Stake-Session-Token" header. Endpoints follow the
 * open-source stake-python client:
 *   GET /api/asx/transactions          funding (DEPOSIT, WITHDRAWAL, DIVIDEND_DEPOSIT, SETTLEMENT...)
 *   GET /api/asx/orders/tradeActivity  executed ASX orders
 * Both page with size/page and answer { items, hasNext }.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, Request } from "playwright";
import type { BankAccount, BankTransaction } from "../models.js";
import { parseTotpSecret, totp, totpSecondsLeft } from "../totp.js";
import { AuthError, captureJson, pause, ProviderError, settle, snapshot, type DateRange, type ProviderContext, type ProviderDefinition } from "./base.js";

const APP_URL = "https://trading.hellostake.com/";
const TRANSACTIONS_URL = "https://trading.hellostake.com/platform/balances/transactions?active=AU_TRADING";
const DEFAULT_API = "https://api2.prd.hellostake.com";
const TOKEN_HEADER = "stake-session-token";
const TZ = "Australia/Sydney";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export const STAKE_AUD: BankAccount = { id: "stake-asx-aud", name: "Stake ASX (AUD)", currency: "AUD" };

const EMAIL = 'input[type="email"], input[name*="email" i], input[name="username"], input[autocomplete="username"]';
const PASSWORD = 'input[type="password"]';
const OTP =
  'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i], input[id*="otp" i], input[id*="code" i], input[inputmode="numeric"]';
const SUBMIT = 'button[type="submit"]';

export const stake: ProviderDefinition = {
  name: "stake",
  label: "Stake (ASX, AUD only)",
  note:
    "AUD only: Australian shares (ASX) and the AUD cash wallet. Wall St (USD) isn't imported. " +
    "Map it to an Investment account in Sure: deposits, withdrawals, dividends, buys and sells go in as trades, " +
    "and anything already in that account (for example entered by hand) is skipped.",
  credentialFields: [
    { key: "email", label: "Email" },
    { key: "password", label: "Password", secret: true },
    {
      key: "totpSecret",
      label: "2FA secret",
      secret: true,
      hint: "The setup key (or otpauth:// link) from when you turned on 2FA in Stake. Used to make the login code.",
    },
  ],
  syncPeriod: {
    allTime: true,
    note: "Use All time for a first import of your whole history, then switch back: anything already in Sure is skipped either way.",
  },
  startUrl: APP_URL,
  unfinished: true,
  create: (ctx) => new StakeProvider(ctx),
};

class StakeProvider {
  #token: string | null = null;
  #api = DEFAULT_API;

  constructor(private readonly ctx: ProviderContext) {
    // The web app sends its session token on every API call; keep the latest.
    ctx.browser.on("request", (r: Request) => this.#sniff(r));
    if (ctx.debug) captureJson(ctx, /hellostake\.com$/);
  }

  #sniff(r: Request): void {
    try {
      const url = new URL(r.url());
      if (!url.host.endsWith("hellostake.com")) return;
      const token = r.headers()[TOKEN_HEADER];
      if (!token) return;
      this.#token = token;
      this.#api = url.origin;
    } catch {
      // odd URL; ignore
    }
  }

  async login(): Promise<void> {
    const { ctx } = this;
    let secret;
    try {
      secret = parseTotpSecret(ctx.credentials.totpSecret ?? "");
    } catch (e) {
      throw new AuthError(`Stake: ${(e as Error).message}`);
    }
    const page = ctx.browser.pages()[0] ?? (await ctx.browser.newPage());
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });

    // A remembered session sends its token straight away.
    const first = await this.#waitFor(page, 30_000, [EMAIL, PASSWORD]);
    if (first === "token") {
      ctx.log("stake: already logged in");
      return;
    }
    if (first === "timeout") {
      await snapshot(ctx, "stake-no-login-form");
      throw new ProviderError("Stake: the login page didn't show a login form");
    }

    // The login page redraws itself just after it opens (Angular), which
    // empties anything typed too early: let it settle, then type and check.
    await settle(page);
    ctx.log("stake: logging in");
    const email = page.locator(EMAIL).first();
    if (await email.isVisible().catch(() => false)) await this.#type(page, email, ctx.credentials.email ?? "", "email");
    const password = page.locator(PASSWORD).first();
    if (!(await password.isVisible().catch(() => false))) {
      // Email first, password on the next step.
      await this.#submit(page);
      await password.waitFor({ state: "visible", timeout: 15_000 });
    }
    await this.#type(page, password, ctx.credentials.password ?? "", "password");
    await this.#submit(page);

    const next = await this.#waitFor(page, 30_000, [OTP]);
    if (next === "selector") {
      // Don't type a code that expires mid-submit.
      if (totpSecondsLeft(secret) < 5) await new Promise((r) => setTimeout(r, totpSecondsLeft(secret) * 1000 + 500));
      ctx.log("stake: entering the 2FA code");
      const boxes = page.locator(OTP);
      await boxes.first().click();
      // One box or one box per digit: typing fills either.
      await page.keyboard.type(totp(secret), { delay: 80 });
      await pause(300, 700);
      if ((await boxes.count()) === 1) await this.#submit(page).catch(() => {});
      const done = await this.#waitFor(page, 30_000, []);
      if (done !== "token") {
        await snapshot(ctx, "stake-2fa");
        throw new AuthError("Stake didn't accept the 2FA code. Check the 2FA secret (and that this computer's clock is right).");
      }
    } else if (next !== "token") {
      await snapshot(ctx, "stake-login");
      const text = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
      if (/incorrect|invalid|wrong|not match/.test(text)) throw new AuthError("Stake: email or password not accepted");
      throw new ProviderError("Stake: login didn't finish (no 2FA prompt and no session)");
    }
    ctx.log("stake: logged in");
    await settle(page);
  }

  /** Wait until the app has a session token, or one of `selectors` is visible. */
  async #waitFor(page: Page, ms: number, selectors: string[]): Promise<"token" | "selector" | "timeout"> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.#token) return "token";
      for (const s of selectors) {
        if (await page.locator(s).first().isVisible().catch(() => false)) return "selector";
      }
      await page.waitForTimeout(250);
    }
    return this.#token ? "token" : "timeout";
  }

  /** Type like a person and make sure the box kept it (retyping up to 3 times). */
  async #type(page: Page, box: Locator, value: string, what: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await box.click();
      await box.fill("");
      await box.pressSequentially(value, { delay: 40 + Math.random() * 40 });
      await pause(400, 800);
      if ((await box.inputValue().catch(() => "")) === value) return;
      this.ctx.log(`stake: the ${what} box was cleared, typing it again`);
      await settle(page);
    }
    await snapshot(this.ctx, `stake-${what}`);
    throw new ProviderError(`Stake: the ${what} box keeps clearing itself`);
  }

  /** Press the form's button once it's enabled (Stake greys it out until the form is valid). */
  async #submit(page: Page): Promise<void> {
    const named = page.getByRole("button", { name: /log ?in|sign ?in|continue|next|verify|submit/i });
    const button = page.locator(`${SUBMIT}:visible`).or(named).first();
    const deadline = Date.now() + 10_000;
    while (!(await button.isEnabled().catch(() => false))) {
      if (Date.now() > deadline) {
        await snapshot(this.ctx, "stake-button-disabled");
        throw new ProviderError("Stake: the Log In button stayed greyed out (the page didn't accept what was typed)");
      }
      await page.waitForTimeout(250);
    }
    await button.click();
  }

  async listAccounts(): Promise<BankAccount[]> {
    return [STAKE_AUD];
  }

  async fetchTransactions(range: DateRange): Promise<BankTransaction[]> {
    if (this.ctx.debug) await this.#visitTransactionsPage();
    const fundings = await this.#pages("Stake funding", "/api/asx/transactions", { status: "RECONCILED", sort: "insertedAt,desc" }, (x) =>
      sydneyDate(x.insertedAt),
    range.since);
    const trades = await this.#pages("Stake orders", "/api/asx/orders/tradeActivity", {}, (x) => String(x.executionDate ?? sydneyDate(x.placedTimestamp)), range.since);
    const { rows, skipped, outOfRange } = parseStake(fundings, trades, range);
    this.ctx.log(`stake: funding by type: ${countBy(fundings, (f) => String(f.action ?? "?"))}`);
    if (outOfRange) this.ctx.log(`stake: ${outOfRange} outside ${range.since} → ${range.until} (pick a longer sync period to include them)`);
    for (const s of skipped) this.ctx.log(`stake: skipped ${s}`);
    this.ctx.log(`stake: ${rows.length} AUD activities in range`);
    return rows;
  }

  /** Debug runs: open the AUD transactions page so the JSON it loads is saved too. */
  async #visitTransactionsPage(): Promise<void> {
    const page = this.ctx.browser.pages()[0];
    if (!page) return;
    try {
      await page.goto(TRANSACTIONS_URL, { waitUntil: "domcontentloaded" });
      await settle(page, { maxMs: 15_000 });
      // Load a few more pages of history if the list scrolls.
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 4000);
        await settle(page, { maxMs: 5_000 });
      }
      await snapshot(this.ctx, "stake-transactions");
    } catch (e) {
      this.ctx.log(`stake: couldn't open the transactions page: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  /**
   * GET every page of a Stake list. Stops early only once a whole page is
   * older than `since`, so it works whichever way Stake sorts.
   */
  async #pages(label: string, path: string, params: Record<string, string>, dateOf: (x: Item) => string, since: string): Promise<Item[]> {
    if (!this.#token) throw new ProviderError("Stake: no session token; log in first");
    const out: Item[] = [];
    let n = 0;
    for (; n < MAX_PAGES; n++) {
      const q = new URLSearchParams({ ...params, size: String(PAGE_SIZE), page: String(n) });
      const url = `${this.#api}${path}?${q}`;
      const res = await this.ctx.browser.request.get(url, {
        headers: { [TOKEN_HEADER]: this.#token, Accept: "application/json" },
        timeout: 30_000,
      });
      if (res.status() === 401 || res.status() === 403) throw new AuthError(`Stake: session not accepted (HTTP ${res.status()})`);
      if (!res.ok()) throw new ProviderError(`Stake: ${path} answered HTTP ${res.status()}`);
      const body = (await res.json()) as { items?: Item[]; hasNext?: boolean };
      if (this.ctx.debug) await this.#save(path, n, body);
      const items = Array.isArray(body) ? (body as Item[]) : (body.items ?? []);
      out.push(...items);
      const newest = items.map(dateOf).filter(Boolean).sort().at(-1);
      if (!body.hasNext || !items.length || (newest && newest < since)) break;
    }
    const dates = out.map(dateOf).filter(Boolean).sort();
    this.ctx.log(`stake: ${label}: ${out.length} rows over ${Math.min(n + 1, MAX_PAGES)} page(s)${dates.length ? `, ${dates[0]} → ${dates.at(-1)}` : ""}`);
    return out;
  }

  async #save(path: string, n: number, body: unknown): Promise<void> {
    const dir = join(this.ctx.debugDir, "network");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `stake${path.replace(/\W+/g, "_")}-page${n}.json`), JSON.stringify(body, null, 2));
  }
}

type Item = Record<string, unknown>;

/**
 * Stake funding records and executed orders -> rows for Sure. Only AUD and
 * the range; settlements are left out (the buy/sell itself is the trade).
 * Returns what was left out and why, for the log.
 */
export function parseStake(
  fundings: Item[],
  trades: Item[],
  range: DateRange,
): { rows: BankTransaction[]; skipped: string[]; outOfRange: number } {
  let outOfRange = 0;
  const rows: BankTransaction[] = [];
  const skippedCount = new Map<string, number>();
  const skip = (why: string) => skippedCount.set(why, (skippedCount.get(why) ?? 0) + 1);
  const inRange = (d: string) => d >= range.since && d <= range.until;

  for (const f of fundings) {
    const date = sydneyDate(f.insertedAt);
    if (!date) {
      skip("funding without a date");
      continue;
    }
    if (!inRange(date)) {
      outOfRange++;
      continue;
    }
    const currency = String(f.currency ?? "AUD").toUpperCase();
    if (currency !== "AUD") {
      skip(`${currency} (not AUD)`);
      continue;
    }
    if (f.status && String(f.status) !== "RECONCILED") {
      skip("not yet reconciled");
      continue;
    }
    const action = String(f.action ?? "");
    const cents = Math.round(Math.abs(Number(f.amount)) * 100);
    if (!Number.isFinite(cents) || !cents) {
      skip(`${action || "funding"} without an amount`);
      continue;
    }
    const debit = String(f.side ?? "").toUpperCase() === "DEBIT";
    const id = String(f.id ?? "");
    const reference = String(f.reference ?? "").trim();
    const base = { account: STAKE_AUD, date, bankId: id ? `funding:${id}` : undefined };
    if (action === "DEPOSIT") {
      rows.push({ ...base, amountCents: cents, description: reference || "Stake deposit", investment: { kind: "deposit" } });
    } else if (action === "WITHDRAWAL") {
      rows.push({ ...base, amountCents: -cents, description: reference || "Stake withdrawal", investment: { kind: "withdrawal" } });
    } else if (action === "DIVIDEND_DEPOSIT") {
      const ticker = dividendTicker(f);
      if (!ticker) {
        skip("dividend without a ticker Sure can file it under (run a debug run and share the network files)");
        continue;
      }
      rows.push({
        ...base,
        amountCents: debit ? -cents : cents,
        description: reference || `Dividend ${ticker}`,
        investment: { kind: "dividend", ticker, exchange: "XASX" },
      });
    } else {
      skip(action ? action.toLowerCase().replace(/_/g, " ") : "unknown funding");
    }
  }

  for (const t of trades) {
    const date = String(t.executionDate ?? "").slice(0, 10) || sydneyDate(t.completedTimestamp ?? t.placedTimestamp);
    if (!date) {
      skip("order without a date");
      continue;
    }
    if (!inRange(date)) {
      outOfRange++;
      continue;
    }
    const status = String(t.orderStatus ?? "").toUpperCase();
    if (/CANCEL|REJECT|EXPIRE|PENDING|OPEN/.test(status)) continue;
    const side = String(t.side ?? "").toUpperCase();
    const units = Number(t.units);
    const ticker = baseTicker(String(t.instrumentCode ?? t.symbol ?? ""));
    if ((side !== "BUY" && side !== "SELL") || !(units > 0) || !ticker) {
      skip("order without side, units or ticker");
      continue;
    }
    const gross = Number(t.consideration);
    const price = Number(t.averagePrice ?? t.effectivePrice) || (gross > 0 ? gross / units : NaN);
    if (!(price > 0)) {
      skip("order without a price");
      continue;
    }
    const grossCents = Math.round((gross > 0 ? gross : units * price) * 100);
    const feeCents = Math.round((Number(t.userBrokerageFees) || 0) * 100);
    const sell = side === "SELL";
    const id = t.brokerOrderId ?? t.contractNoteNumber;
    rows.push({
      account: STAKE_AUD,
      date,
      // cash: a buy costs the shares plus brokerage, a sell brings in the shares less brokerage
      amountCents: sell ? grossCents - feeCents : -(grossCents + feeCents),
      description: `${sell ? "Sell" : "Buy"} ${num(units)} ${ticker}`,
      bankId: id != null ? `order:${id}:${date}` : undefined,
      investment: { kind: sell ? "sell" : "buy", ticker, exchange: "XASX", qty: num(units), price: num(price), feeCents },
    });
  }

  const skipped = [...skippedCount].map(([why, n]) => `${n} × ${why}`);
  return { rows, skipped, outOfRange };
}

function countBy(items: Item[], key: (x: Item) => string): string {
  const m = new Map<string, number>();
  for (const x of items) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].map(([k, n]) => `${k} ${n}`).join(", ") || "none";
}

/**
 * A dividend's company: a ticker field if Stake sends one, else a code in the
 * reference that's clearly a ticker ("CBA.AX", or "CBA" right before "DIV").
 * Guessing wrong would file the dividend under the wrong share, so anything
 * less certain gives null.
 */
export function dividendTicker(f: Item): string | null {
  for (const k of ["symbol", "instrumentCode", "ticker"]) {
    if (typeof f[k] === "string" && f[k]) return baseTicker(f[k] as string);
  }
  const ref = String(f.reference ?? "").toUpperCase();
  const m = /\b([A-Z0-9]{2,6})\.(?:AX|ASX|XAU|XASX)\b/.exec(ref) ?? /\b([A-Z0-9]{2,6})\s+(?:FINAL |INTERIM |SPECIAL )?DIV(?:IDEND)?\b/.exec(ref);
  return m ? m[1]! : null;
}

/** "CBA.XAU" / "CBA.AX" -> "CBA" */
function baseTicker(s: string): string {
  return s.trim().toUpperCase().split(/[.:\s]/)[0] ?? "";
}

/** 12.5 -> "12.5", 0.1 + 0.2 -> "0.3": no float noise in what Sure gets. */
function num(n: number): string {
  return String(Number(n.toFixed(6)));
}

/** A Stake timestamp as a YYYY-MM-DD date in Sydney (where the ASX is). */
export function sydneyDate(v: unknown): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
