import { describe, expect, it } from "vitest";
import { assignExternalIds, type BankTransaction } from "../src/models.js";
import { dividendTicker, parseStake, STAKE_AUD, sydneyDate } from "../src/providers/stake.js";
import { pushTransactions } from "../src/push.js";
import { matchExisting, toTradeInput } from "../src/pushTrades.js";
import { emptyStats } from "../src/runs.js";
import { moneyCents } from "../src/sureClient.js";
import { parseTotpSecret, totp } from "../src/totp.js";
import { setup } from "./helpers.js";

describe("totp", () => {
  // RFC 6238 test vectors (SHA1, secret "12345678901234567890").
  const secret = parseTotpSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("t=%i -> %s", (t, code) => {
    expect(totp(secret, t * 1000)).toBe(code);
  });

  it("reads otpauth links and spaced lowercase keys", () => {
    const link = parseTotpSecret("otpauth://totp/Stake:me?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&issuer=Stake");
    expect(totp(link, 59_000)).toBe("94287082");
    expect(totp(parseTotpSecret("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"), 59_000)).toBe("287082");
  });

  it("rejects junk", () => {
    expect(() => parseTotpSecret("not a secret!")).toThrow(/base32/);
    expect(() => parseTotpSecret("ABCD")).toThrow(/too short/);
  });
});

describe("stake parsing", () => {
  const range = { since: "2026-10-01", until: "2026-11-10" };

  it("keeps AUD deposits, withdrawals, dividends and ASX trades; drops the rest", () => {
    const fundings = [
      { id: "f1", action: "DEPOSIT", amount: 1000, currency: "AUD", side: "CREDIT", status: "RECONCILED", insertedAt: "2026-10-02T23:30:00Z", reference: "PAYID" },
      { id: "f2", action: "WITHDRAWAL", amount: 50.5, currency: "AUD", side: "DEBIT", status: "RECONCILED", insertedAt: "2026-10-05T01:00:00Z" },
      { id: "f3", action: "DIVIDEND_DEPOSIT", amount: 12.34, currency: "AUD", side: "CREDIT", status: "RECONCILED", insertedAt: "2026-10-06T01:00:00Z", reference: "CBA FINAL DIV" },
      { id: "f4", action: "SETTLEMENT", amount: 503, currency: "AUD", side: "DEBIT", status: "RECONCILED", insertedAt: "2026-10-07T01:00:00Z" },
      { id: "f5", action: "DEPOSIT", amount: 10, currency: "USD", side: "CREDIT", status: "RECONCILED", insertedAt: "2026-10-07T01:00:00Z" },
      { id: "f6", action: "DEPOSIT", amount: 10, currency: "AUD", side: "CREDIT", status: "RECONCILED", insertedAt: "2026-09-01T01:00:00Z" },
    ];
    const trades = [
      { brokerOrderId: 77, side: "BUY", units: 5, averagePrice: 100, consideration: 500, userBrokerageFees: 3, instrumentCode: "CBA.XAU", executionDate: "2026-10-07", orderStatus: "FILLED" },
      { brokerOrderId: 78, side: "SELL", units: 2, averagePrice: 0.1 + 0.2, consideration: 0.6, userBrokerageFees: 0, instrumentCode: "XYZ", executionDate: "2026-10-08", orderStatus: "FILLED" },
      { brokerOrderId: 79, side: "BUY", units: 1, averagePrice: 1, instrumentCode: "ABC", executionDate: "2026-10-09", orderStatus: "CANCELLED" },
    ];
    const { rows, skipped } = parseStake(fundings, trades, range);
    expect(rows.map((r) => [r.date, r.amountCents, r.investment?.kind, r.investment?.ticker])).toEqual([
      ["2026-10-03", 100000, "deposit", undefined], // 23:30 UTC is the next morning in Sydney
      ["2026-10-05", -5050, "withdrawal", undefined],
      ["2026-10-06", 1234, "dividend", "CBA"],
      ["2026-10-07", -50300, "buy", "CBA"],
      ["2026-10-08", 60, "sell", "XYZ"],
    ]);
    expect(rows[3]!.investment).toMatchObject({ qty: "5", price: "100", feeCents: 300, exchange: "XASX" });
    expect(rows[4]!.investment!.price).toBe("0.3");
    expect(rows.every((r) => r.account === STAKE_AUD)).toBe(true);
    expect(skipped).toEqual(["1 × settlement", "1 × USD (not AUD)"]);
  });

  it("only takes a dividend ticker it's sure of", () => {
    expect(dividendTicker({ symbol: "WES.AX" })).toBe("WES");
    expect(dividendTicker({ reference: "Dividend BHP.AX" })).toBe("BHP");
    expect(dividendTicker({ reference: "VAS INTERIM DIVIDEND" })).toBe("VAS");
    expect(dividendTicker({ reference: "Dividend payment" })).toBeNull();
  });

  it("dates in Sydney time", () => {
    expect(sydneyDate("2026-06-30T15:00:00Z")).toBe("2026-07-01");
    expect(sydneyDate("2026-06-30")).toBe("2026-06-30");
    expect(sydneyDate(undefined)).toBe("");
  });
});

const row = (date: string, amountCents: number, investment: BankTransaction["investment"]): BankTransaction => ({
  account: STAKE_AUD,
  date,
  amountCents,
  description: "x",
  investment,
});

describe("trade dedupe", () => {
  it("matches hand-entered rows by amount (cash) or ticker + units (trades), within a few days", () => {
    const rows = assignExternalIds([
      row("2026-10-03", 100000, { kind: "deposit" }),
      row("2026-10-06", 1234, { kind: "dividend", ticker: "CBA" }),
      row("2026-10-07", -50300, { kind: "buy", ticker: "CBA", qty: "5", price: "100", feeCents: 300 }),
      row("2026-10-08", 60, { kind: "sell", ticker: "XYZ", qty: "2", price: "0.3" }),
      row("2026-10-20", 100000, { kind: "deposit" }),
    ]);
    const found = matchExisting(rows, [
      { date: "2026-10-04", amountCents: 100000 }, // the deposit, entered a day late
      { date: "2026-10-06", amountCents: 1234, ticker: "CBA", qty: 0 }, // dividend trade
      { date: "2026-10-09", amountCents: -50000, ticker: "CBA.AX", qty: 5 }, // settlement date, no fee
      { date: "2026-10-08", amountCents: 60, ticker: "XYZ", qty: 2 }, // a buy, not the sell
    ]);
    expect([...found].map((t) => `${t.date} ${t.investment!.kind}`).sort()).toEqual([
      "2026-10-03 deposit",
      "2026-10-06 dividend",
      "2026-10-07 buy",
    ]);
  });

  it("builds Sure trade bodies", () => {
    const [buy, div] = assignExternalIds([
      row("2026-10-07", -50300, { kind: "buy", ticker: "CBA", exchange: "XASX", qty: "5", price: "100", feeCents: 300 }),
      row("2026-10-06", 1234, { kind: "dividend", ticker: "CBA", exchange: "XASX" }),
    ]);
    expect(toTradeInput("inv", buy!)).toEqual({ account_id: "inv", type: "buy", date: "2026-10-07", currency: "AUD", ticker: "CBA|XASX", qty: "5", price: "100", fee: "3.00" });
    expect(toTradeInput("inv", div!)).toEqual({ account_id: "inv", type: "dividend", date: "2026-10-06", currency: "AUD", amount: "12.34", ticker: "CBA|XASX" });
    expect(moneyCents("-A$1,234.50")).toBe(-123450);
    expect(moneyCents("$0.60")).toBe(60);
  });

  it("sends only what isn't in Sure yet, and remembers it", async () => {
    const env = setup();
    const connId = env.store.saveConnection(null, {
      userId: env.userId, provider: "stake", enabled: true, schedule: null, lookbackDays: null,
      credentials: { email: "a@b.c", password: "pw", totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" }, options: {},
    });
    env.store.recordBankAccounts(connId, [STAKE_AUD]);
    env.store.setMapping(connId, STAKE_AUD.id, "inv-1", false);
    const conn = env.store.connection(connId)!;
    const posted: any[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/trades?")) {
        return Response.json({ trades: [{ id: "t1", date: "2026-10-06", amount: "-$12.34", qty: "0", security: { ticker: "CBA" } }], pagination: { total_pages: 1 } });
      }
      if (url.includes("/transactions?")) {
        return Response.json({ transactions: [{ id: "x1", date: "2026-10-04", name: "Deposit", amount_decimal: "-1000.00" }], pagination: { total_pages: 1 } });
      }
      if (url.endsWith("/trades") && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)).trade);
        return Response.json({ id: `new-${posted.length}` }, { status: 201 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }) as typeof fetch;
    const txns = [
      row("2026-10-03", 100000, { kind: "deposit" }),
      row("2026-10-06", 1234, { kind: "dividend", ticker: "CBA", exchange: "XASX" }),
      row("2026-10-07", -50300, { kind: "buy", ticker: "CBA", exchange: "XASX", qty: "5", price: "100", feeCents: 300 }),
    ];
    const deps = { store: env.store, runs: env.runs, fetch: fetchImpl };
    const stats = emptyStats();
    await pushTransactions(deps, conn, env.store.settings(), txns, stats, () => {});
    expect(posted).toEqual([{ account_id: "inv-1", type: "buy", date: "2026-10-07", currency: "AUD", ticker: "CBA|XASX", qty: "5", price: "100", fee: "3.00" }]);
    expect(stats).toMatchObject({ created: 1, skipped: 2 });

    // Second run: everything is on record, Sure isn't even asked.
    const again = emptyStats();
    await pushTransactions(deps, conn, env.store.settings(), txns, again, () => {});
    expect(posted).toHaveLength(1);
    expect(again).toMatchObject({ created: 0, skipped: 3 });
  });
});
