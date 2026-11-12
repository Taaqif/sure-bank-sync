import { describe, expect, it } from "vitest";
import { blank, parseBrighten, toAccount } from "../src/providers/brighten.js";

describe("brighten debug capture", () => {
  it("blanks login values and secret-looking variables in saved GraphQL queries", () => {
    const vars = {
      input: { UserName: "tye123", Password: "hunter22", MfaToken: "123456", Remember: true },
      idOrNumber: "3d4e8bda",
      filters: [{ note: "sent by tye123" }, { from: "2026-11-01" }],
    };
    expect(blank(vars, ["tye123", "hunter22"])).toEqual({
      input: { UserName: "…", Password: "…", MfaToken: "…", Remember: true },
      idOrNumber: "3d4e8bda",
      filters: [{ note: "…" }, { from: "2026-11-01" }],
    });
  });
});

describe("parseBrighten", () => {
  const account = { id: "621684", name: "Brighten loan", currency: "AUD" };
  const row = (o: Record<string, unknown>) => ({ Increase: 0, Decrease: 0, AppearsOnStatement: true, WasReversed: false, IsPending: false, Note: "", ...o });
  // Shape of a real new loan's history (newest first), amounts changed.
  const items = [
    row({ Id: "a", EffectiveDate: "2026-11-12", TransactionType: "Direct Debit Repayment", StatementText: "Direct Debit Repayment", Decrease: 3000.5 }),
    row({ Id: "b", EffectiveDate: "2026-11-11", TransactionType: "Schedule Interest", StatementText: "Schedule Interest", Increase: 3000.5, AppearsOnStatement: false }),
    row({ Id: "c", EffectiveDate: "2026-11-11", TransactionType: "Interest Charge", StatementText: "Interest Charge", Increase: 3000.5 }),
    row({ Id: "d", EffectiveDate: "2026-11-11", TransactionType: "Notice of Interest Rate Change", StatementText: "Interest rate changed from {{rateChange.RateBefore}}", Note: "Interest rate changed" }),
    row({ Id: "e", EffectiveDate: "2026-11-02", TransactionType: "Principal Balance on Swapped Loan Acquired", Increase: 400000, AppearsOnStatement: false }),
    row({ Id: "f", EffectiveDate: "2026-11-02", TransactionType: "Principal Balance on Loans Swapped Out", Decrease: 400000, AppearsOnStatement: false }),
    row({ Id: "g", EffectiveDate: "2026-10-12", TransactionType: "Loan Advance", StatementText: "Loan Advance", Increase: 400000 }),
    row({ Id: "h", EffectiveDate: "2026-10-12", TransactionType: "Settlement Amount Reversal", StatementText: "Settlement Amount Reversal", Decrease: 1200000 }),
    row({ Id: "i", EffectiveDate: "2026-10-12", TransactionType: "Loan Advance", StatementText: "Loan Advance", Increase: 1200000, WasReversed: true }),
  ];

  it("keeps statement rows with an amount, signed as money in/out of the loan", () => {
    const { rows, skipped } = parseBrighten(items, account, { since: "2026-01-01", until: "2026-12-31" });
    expect(rows.map((r) => [r.bankId, r.date, r.amountCents, r.description])).toEqual([
      ["a", "2026-11-12", 300050, "Direct Debit Repayment"],
      ["c", "2026-11-11", -300050, "Interest Charge"],
      ["g", "2026-10-12", -40000000, "Loan Advance"],
    ]);
    expect(skipped).toEqual(["2 × reversed (and its reversal)"]);
    // What's kept adds up to the loan balance.
    expect(rows.reduce((s, r) => s + r.amountCents, 0)).toBe(-40000000);
  });

  it("applies the period itself (Brighten has no date filter)", () => {
    const { rows, outOfRange } = parseBrighten(items, account, { since: "2026-11-05", until: "2026-11-11" });
    expect(rows.map((r) => r.bankId)).toEqual(["c"]);
    expect(outOfRange).toBe(6);
  });

  it("names accounts by product and last digits", () => {
    expect(toAccount({ Number: 621684, ProductType: "Easy Builder", Description: "" })).toEqual({ id: "621684", name: "Brighten Easy Builder (…1684)", currency: "AUD" });
  });
});
