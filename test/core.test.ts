import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Crypto, CryptoError, generateKey } from "../src/crypto.js";
import { MfaBroker, MfaTimeout } from "../src/mfa.js";
import { assignExternalIds, formatCents, parseAmount, type BankAccount, type BankTransaction } from "../src/models.js";
import { pushTransactions } from "../src/push.js";
import { dateRange } from "../src/runner.js";
import { emptyStats } from "../src/runs.js";
import { ConfigStore, DEFAULT_SETTINGS, ValidationError } from "../src/store.js";
import { fakeSure, setup } from "./helpers.js";

const ACCT: BankAccount = { id: "012-345 6789999", name: "Everyday", currency: "AUD" };
const txn = (description = "COFFEE", amountCents = -450, extra: Partial<BankTransaction> = {}): BankTransaction => ({
  account: ACCT,
  date: "2026-11-01",
  amountCents,
  description,
  ...extra,
});

describe("crypto", () => {
  it("round-trips and rejects the wrong key", () => {
    const a = new Crypto(generateKey());
    const token = a.encrypt("hunter2");
    expect(token).not.toContain("hunter2");
    expect(a.decrypt(token)).toBe("hunter2");
    expect(() => new Crypto(generateKey()).decrypt(token)).toThrow(CryptoError);
    expect(() => new Crypto("short")).toThrow(CryptoError);
  });

  it("accepts the key as hex or base64", () => {
    const hex = generateKey();
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    const b64 = Buffer.from(hex, "hex").toString("base64");
    // Same bytes either way: data saved with one opens with the other.
    expect(new Crypto(b64).decrypt(new Crypto(hex).encrypt("pw"))).toBe("pw");
    expect(() => new Crypto("ab".repeat(31))).toThrow(CryptoError);
  });
});

describe("config store", () => {
  it("keeps secrets encrypted at rest", () => {
    const env = setup();
    const raw = readFileSync(env.dbPath).toString("latin1") + readFileSync(env.dbPath + "-wal").toString("latin1");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("key-123");
    expect(env.store.credentials("alice-anz")).toEqual({ customer_id: "111", password: "hunter2" });
    expect(env.store.sureApiKey(env.userId)).toBe("key-123");
    expect(env.store.connection("alice-anz")!.credentialKeys).toEqual(["customer_id", "password"]);
  });

  it("detects a changed secret key", () => {
    const env = setup();
    const other = new ConfigStore(env.store.db, new Crypto(generateKey()));
    expect(() => other.verifyKey()).toThrow(CryptoError);
  });

  it("keeps existing secrets when fields are left blank", () => {
    const { store, userId } = setup();
    store.saveConnection("alice-anz", {
      userId,
      provider: "anz",
      enabled: false,
      schedule: "0  7 * * *",
      lookbackDays: 10,
      credentials: { customer_id: "", password: "newpass" },
      options: {},
    });
    expect(store.credentials("alice-anz")).toEqual({ customer_id: "111", password: "newpass" });
    const c = store.connection("alice-anz")!;
    expect([c.enabled, c.schedule, c.lookbackDays]).toEqual([false, "0 7 * * *", 10]);
    store.saveUser(userId, "alice", "");
    expect(store.sureApiKey(userId)).toBe("key-123");
  });

  it("validates input", () => {
    const { store } = setup();
    expect(() => store.saveSettings({ ...DEFAULT_SETTINGS, schedule: "nope" })).toThrow(/cron/);
    expect(() => store.saveSettings({ ...DEFAULT_SETTINGS, timezone: "Mars/Base" })).toThrow(/timezone/);
    expect(() => store.saveSettings({ ...DEFAULT_SETTINGS, sureUrl: "ftp://x" })).toThrow(ValidationError);
    expect(() => store.saveUser(null, "alice", "k")).toThrow(/already exists/);
    expect(store.settings().sureUrl).toBe("http://sure.test");
  });

  it("generates unique connection ids and cascades deletes", () => {
    const { store, userId } = setup();
    const id = store.saveConnection(null, {
      userId, provider: "anz", enabled: true, schedule: null, lookbackDays: null, credentials: {}, options: {},
    });
    expect(id).toBe("alice-anz-2");
    store.deleteUser(userId);
    expect(store.connections()).toEqual([]);
  });
});

describe("transactions", () => {
  it("assigns stable, distinct external ids", () => {
    const a = assignExternalIds([txn(), txn(), txn("OTHER")]);
    const b = assignExternalIds([txn("OTHER"), txn(), txn()]);
    expect(new Set(a.map((t) => t.externalId)).size).toBe(3);
    expect(new Set(a.map((t) => t.externalId))).toEqual(new Set(b.map((t) => t.externalId)));
    expect(assignExternalIds([txn("X", 1, { bankId: "ABC" })])[0]!.externalId).toBe(`${ACCT.id}:ABC`);
  });

  it("parses and formats amounts", () => {
    expect(parseAmount("-1,234.56")).toBe(-123456);
    expect(parseAmount("$12.3")).toBe(1230);
    expect(parseAmount("(4.50)")).toBe(-450);
    expect(parseAmount("+7")).toBe(700);
    expect(() => parseAmount("abc")).toThrow();
    expect(formatCents(-450)).toBe("-4.50");
    expect(formatCents(250000)).toBe("2500.00");
  });

  it("computes the date range in the configured timezone", () => {
    // 2026-11-09 14:00 UTC is already the 10th in Melbourne
    expect(dateRange("Australia/Melbourne", 7, new Date("2026-11-09T14:00:00Z"))).toEqual({
      since: "2026-11-03",
      until: "2026-11-10",
    });
  });
});

describe("mfa", () => {
  it("hands a code from the UI to the waiting run", async () => {
    const broker = new MfaBroker();
    const p = broker.request("c1", 1, "code?", 5000);
    expect(broker.get("c1")!.prompt).toBe("code?");
    expect(broker.submit("c1", " 123456 ")).toBe(true);
    await expect(p).resolves.toBe("123456");
    expect(broker.get("c1")).toBeUndefined();
  });

  it("times out", async () => {
    await expect(new MfaBroker().request("c1", 1, "code?", 10)).rejects.toThrow(MfaTimeout);
  });
});

describe("push", () => {
  it("discovers accounts, maps, skips and dedupes", async () => {
    const env = setup();
    const sure = fakeSure();
    const deps = { store: env.store, runs: env.runs, fetch: sure.fetch };
    const conn = env.store.connection("alice-anz")!;
    const settings = env.store.settings();
    const card: BankAccount = { id: "3700", name: "Amex card", currency: "AUD" };
    const batch = [txn(), txn(), txn("SALARY", 250000), txn("PENDING", -1, { pending: true }), { ...txn("X", -100), account: card }];

    // First run: accounts discovered but unmapped -> nothing sent
    let s = emptyStats();
    await pushTransactions(deps, conn, settings, batch, s, () => {});
    expect(s.unmapped).toBe(4);
    expect(sure.calls).toHaveLength(0);
    expect(env.store.bankAccounts(conn.id).map((a) => a.bankAccountId).sort()).toEqual([ACCT.id, card.id].sort());

    // Map one, ignore the other -> one CSV import with 3 rows
    env.store.setMapping(conn.id, ACCT.id, "acct-1", false);
    env.store.setMapping(conn.id, card.id, null, true);
    s = emptyStats();
    await pushTransactions({ ...deps, pollMs: 1 }, conn, settings, batch, s, () => {});
    expect(s).toEqual({ fetched: 0, created: 3, skipped: 0, unmapped: 0 });

    const posts = sure.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("http://sure.test/api/v1/imports");
    expect(posts[0]!.headers.get("X-Api-Key")).toBe("key-123");
    expect(posts[0]!.body).toMatchObject({
      type: "TransactionImport",
      account_id: "acct-1",
      date_format: "%Y-%m-%d",
      signage_convention: "inflows_positive",
      publish: "true",
    });
    expect(posts[0]!.body.raw_file_content).toBe(
      "date,amount,name\n2026-11-01,-4.50,COFFEE\n2026-11-01,-4.50,COFFEE\n2026-11-01,2500.00,SALARY\n",
    );

    // Re-run: already synced locally, no API calls
    s = emptyStats();
    const before = sure.calls.length;
    await pushTransactions(deps, conn, settings, batch, s, () => {});
    expect(s.created).toBe(0);
    expect(s.skipped).toBe(3);
    expect(sure.calls).toHaveLength(before);
  });

  it("doesn't mark rows synced when the import fails or is still running", async () => {
    const env = setup();
    const conn = env.store.connection("alice-anz")!;
    env.store.recordBankAccounts(conn.id, [ACCT]);
    env.store.setMapping(conn.id, ACCT.id, "acct-1", false);

    const failing = fakeSure(undefined, "failed");
    await expect(
      pushTransactions({ store: env.store, runs: env.runs, fetch: failing.fetch, pollMs: 1 }, conn, env.store.settings(), [txn()], emptyStats(), () => {}),
    ).rejects.toThrow(/import .* failed/);

    const slow = fakeSure(undefined, "importing");
    const s = emptyStats();
    await pushTransactions(
      { store: env.store, runs: env.runs, fetch: slow.fetch, pollMs: 1, importTimeoutMs: 20 },
      conn, env.store.settings(), [txn()], s, () => {},
    );
    expect(s.created).toBe(0);
    expect(env.runs.alreadySynced(conn.id, assignExternalIds([txn()]).map((t) => t.externalId)).size).toBe(0);
  });
});

describe("dry run", () => {
  it("reads Sure but writes nothing and marks nothing synced", async () => {
    const env = setup();
    const sure = fakeSure();
    const deps = { store: env.store, runs: env.runs, fetch: sure.fetch };
    const conn = env.store.connection("alice-anz")!;
    env.store.recordBankAccounts(conn.id, [ACCT]);
    env.store.setMapping(conn.id, ACCT.id, "acct-1", false);
    const lines: string[] = [];

    // Default: counts only, no transaction details or full account numbers.
    let s = emptyStats();
    await pushTransactions(deps, conn, env.store.settings(), [txn(), txn("SALARY", 250000)], s, (m) => lines.push(m), true);
    expect(s.created).toBe(2);
    expect(lines.join("\n")).not.toContain("SALARY");
    expect(lines.some((l) => l.includes("would import 2 transactions into Joint Everyday"))).toBe(true);

    // Verbose logs list each transaction.
    lines.length = 0;
    s = emptyStats();
    const verbose = { ...env.store.settings(), verboseLogs: true };
    await pushTransactions(deps, conn, verbose, [txn(), txn("SALARY", 250000)], s, (m) => lines.push(m), true);
    expect(s.created).toBe(2);
    expect(sure.calls.every((c) => c.method === "GET")).toBe(true);
    expect(lines.some((l) => l.includes("would import 2026-11-01 income     2500.00 SALARY → Joint Everyday"))).toBe(true);
    expect(lines.some((l) => l.includes("would import 2 transactions into Joint Everyday as one CSV import"))).toBe(true);

    // A real run afterwards still sends both
    s = emptyStats();
    await pushTransactions({ ...deps, pollMs: 1 }, conn, env.store.settings(), [txn(), txn("SALARY", 250000)], s, () => {});
    expect(s.created).toBe(2);
    expect(sure.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("retention", () => {
  it("prunes old runs", () => {
    const { runs } = setup();
    for (let i = 0; i < 12; i++) runs.start("alice-anz", "alice", "manual");
    runs.prune(5);
    const left = runs.recent(undefined, 100);
    expect(left).toHaveLength(5);
    expect(left[0]!.id).toBe(12);
  });
});

describe("runs paging", () => {
  it("pages newest first and clamps the page number", () => {
    const { runs } = setup();
    for (let i = 0; i < 32; i++) runs.start(i % 2 ? "alice-anz" : "bob-amex", "x", "manual");
    const p1 = runs.page(undefined, 1);
    expect(p1).toMatchObject({ page: 1, pages: 3, total: 32 });
    expect(p1.runs.map((r) => r.id).slice(0, 2)).toEqual([32, 31]);
    expect(runs.page(undefined, 3).runs).toHaveLength(2);
    expect(runs.page(undefined, 99).page).toBe(3);
    expect(runs.page(undefined, -1).page).toBe(1);
    expect(runs.page("alice-anz", 1).total).toBe(16);
  });
});

describe("anz helpers", async () => {
  const { accountIdFromTile, daysBetween } = await import("../src/providers/anz.js");
  it("normalises tile account numbers", () => {
    expect(accountIdFromTile(" 012345\n 987654321 ")).toBe("012345 987654321");
    expect(daysBetween("2026-11-02", "2026-11-09")).toBe(8);
  });
});

describe("navigation log labels", async () => {
  const { navLabel } = await import("../src/runner.js");
  it("drops query strings but keeps hash routes", () => {
    expect(navLabel("https://banking5.ib.anz.com/IBUI/?token=abc#/download-transaction")).toBe(
      "https://banking5.ib.anz.com/IBUI/#/download-transaction",
    );
    expect(navLabel("https://b.ib.anz.com/IBUI/#/login?sessionId=SECRET&ctiId=x")).toBe("https://b.ib.anz.com/IBUI/#/login");
    expect(navLabel("not a url")).toBe("not a url");
  });
});

describe("anz csv", async () => {
  const { parseAnzCsv } = await import("../src/providers/anz.js");
  const acct = { id: "012345 987654321", name: "Everyday", currency: "AUD" };
  it("parses the headerless layout", () => {
    const csv = '09/11/2026,-4.50,"EFTPOS CAFE, MELBOURNE"\r\n01/11/2026,"2,500.00","SALARY ACME"\r\n';
    expect(parseAnzCsv(csv, acct)).toEqual([
      { account: acct, date: "2026-11-09", amountCents: -450, description: "EFTPOS CAFE, MELBOURNE" },
      { account: acct, date: "2026-11-01", amountCents: 250000, description: "SALARY ACME" },
    ]);
  });
  it("parses a headed debit/credit layout", () => {
    const csv = "Date,Details,Debit,Credit,Balance\n9/11/2026,COFFEE,4.50,,100.00\n1/11/2026,PAY,,2500.00,104.50\n";
    expect(parseAnzCsv(csv, acct).map((t) => [t.date, t.amountCents, t.description])).toEqual([
      ["2026-11-09", -450, "COFFEE"],
      ["2026-11-01", 250000, "PAY"],
    ]);
  });
  it("rejects junk", () => {
    expect(() => parseAnzCsv("what,is,this\nfoo,bar,baz\n", acct)).toThrow(/header/);
  });
});

describe("sessions", async () => {
  const { createSession, verifySession, safeNext } = await import("../src/web/auth.js");
  it("signs, expires and invalidates when the binding changes", () => {
    const t = createSession("k", "password\0admin\0pw", "admin", 0);
    expect(verifySession(t, "k", "password\0admin\0pw", 1000)).toBe("admin");
    expect(verifySession(t, "k", "password\0admin\0changed", 1000)).toBeNull();
    expect(verifySession(t, "other", "password\0admin\0pw", 1000)).toBeNull();
    expect(verifySession(t, "k", "password\0admin\0pw", 31 * 24 * 3600 * 1000)).toBeNull();
    expect(verifySession("garbage", "k", "password\0admin\0pw")).toBeNull();
    // the user part can't be swapped
    const [exp, , sig] = t.split(".");
    expect(verifySession(`${exp}.${Buffer.from("eve").toString("base64url")}.${sig}`, "k", "password\0admin\0pw", 1000)).toBeNull();
  });
  it("only allows local redirect targets", () => {
    expect(safeNext("/settings?x=1")).toBe("/settings?x=1");
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "", undefined]) expect(safeNext(bad)).toBe("/");
  });
});

describe("csv reader", async () => {
  const { parseCsv } = await import("../src/providers/csv.js");
  it("handles quotes, embedded newlines and blank lines", () => {
    expect(parseCsv('﻿a,"b, c","say ""hi"""\r\n\r\n1,"two\nlines",3')).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["1", "two\nlines", "3"],
    ]);
  });
});

describe("amex csv", async () => {
  const { parseAmexCsv, amexDate, amexDashboardAccounts } = await import("../src/providers/amex.js");
  it("lists the dashboard's cards with the same ids as the CSV rows", () => {
    const text = "Home\n-55501\nThe American Express® Explorer Credit Card\n••••55501\nRemaining Statement Balance";
    expect(amexDashboardAccounts(text)).toEqual([{ id: "amex-55501", name: "Amex ••55501", currency: "AUD" }]);
    const csv = "Date,Description,Amount,Account #\n03/10/2026,COFFEE,4.50,XXXX-XXXXXX-55501\n";
    expect(parseAmexCsv(csv, { id: "amex", name: "Amex card", currency: "AUD" })[0]!.account.id).toBe("amex-55501");
    expect(amexDashboardAccounts("no cards here")).toEqual([]);
  });
  const fallback = { id: "amex", name: "Amex card", currency: "AUD" };
  it("parses the extended export, flipping signs and splitting cards", () => {
    const csv = [
      "Date,Date Processed,Description,Card Member,Account #,Amount,Extended Details,Appears On Your Statement As,Address,Town/City,Postcode,Country,Reference,Category",
      `03/10/2026,04/10/2026,WOOLWORTHS 1234 SYDNEY,A PERSON,-12345,"1,204.50","line one\nline two",WOOLWORTHS,"1 MAIN ST\nSYDNEY",,,,'AT2627700110000100',General Purchases-Groceries`,
      `05/10/2026,05/10/2026,PAYMENT RECEIVED - THANK YOU,A PERSON,-12345,-500.00,,,,,,,'AT2627800220000200',`,
      `06/10/2026,06/10/2026,CAFE,B PERSON,-67890,4.50,,,,,,,,`,
    ].join("\n");
    const out = parseAmexCsv(csv, fallback);
    expect(out.map((t) => [t.account.id, t.date, t.amountCents, t.description, t.bankId])).toEqual([
      ["amex-12345", "2026-10-03", -120450, "WOOLWORTHS 1234 SYDNEY", "AT2627700110000100"],
      ["amex-12345", "2026-10-05", 50000, "PAYMENT RECEIVED - THANK YOU", "AT2627800220000200"],
      ["amex-67890", "2026-10-06", -450, "CAFE", undefined],
    ]);
    expect(out[0]!.account).toBe(out[1]!.account);
    expect(out[0]!.account.name).toBe("Amex ••12345");
  });
  it("uses the fallback account without an account column", () => {
    const [t] = parseAmexCsv("Date,Description,Amount\n1/10/2026,UBER *TRIP,15.00\n", fallback);
    expect(t).toMatchObject({ account: fallback, date: "2026-10-01", amountCents: -1500 });
  });
  it("reads other date styles and rejects junk", () => {
    expect(amexDate("3 Oct 2026")).toBe("2026-10-03");
    expect(amexDate("03 Sept. 2026")).toBe("2026-09-03");
    expect(() => parseAmexCsv("Date,Description,Amount\nsoon,X,1.00", fallback)).toThrow(/bad date/);
    expect(() => parseAmexCsv("what,is,this\n1,2,3", fallback)).toThrow(/header/);
  });
});

describe("cancel", () => {
  it("stops a run waiting for an MFA code and marks it cancelled", async () => {
    const { MfaBroker } = await import("../src/mfa.js");
    const { Runner } = await import("../src/runner.js");
    const env = setup();
    const id = env.store.saveConnection(null, {
      userId: env.userId,
      provider: "demo",
      enabled: false,
      schedule: null,
      lookbackDays: null,
      credentials: {},
      options: { mfa: true },
    });
    const mfa = new MfaBroker();
    const runner = new Runner(env.store, env.runs, mfa, env.dir);
    expect(runner.cancel(id)).toBe(false);

    const done = runner.run(id, "manual");
    for (let i = 0; i < 300 && !mfa.get(id); i++) await new Promise((r) => setTimeout(r, 50));
    expect(mfa.get(id)).toBeDefined();

    expect(runner.cancel(id)).toBe(true);
    const runId = await done;
    expect(runner.isRunning(id)).toBe(false);
    expect(mfa.get(id)).toBeUndefined();
    const run = env.runs.get(runId)!;
    expect(run.status).toBe("cancelled");
    expect(run.log).toContain("CANCELLED");
  }, 30_000);
});

describe("amex remembered user id", async () => {
  const { rememberedMatches } = await import("../src/providers/amex.js");
  it("keeps a masked value that fits the username and rejects others", () => {
    expect(rememberedMatches("Ta*****", "Tabitha1")).toBe(true);
    expect(rememberedMatches("ta•••••1", "Tabitha1")).toBe(true);
    expect(rememberedMatches("Bo*****", "Tabitha1")).toBe(false);
    expect(rememberedMatches("Ta*****2", "Tabitha1")).toBe(false);
    expect(rememberedMatches("Tabitha1", "Tabitha1")).toBe(true);
    expect(rememberedMatches("Ta*****Tabitha1", "Tabitha1")).toBe(false);
    expect(rememberedMatches("someoneelse", "Tabitha1")).toBe(false);
  });
});

describe("sync period", async () => {
  const { syncDays, syncLabel } = await import("../src/providers/index.js");
  it("uses the connection's choice, else the bank default; Amex is fixed", () => {
    expect(syncDays({ provider: "anz", lookbackDays: null })).toBe(14);
    expect(syncDays({ provider: "anz", lookbackDays: 60 })).toBe(60);
    expect(syncLabel({ provider: "anz", lookbackDays: 30 })).toBe("last 30 days");
    expect(syncLabel({ provider: "amex", lookbackDays: 60 })).toBe("current statement");
  });
});

describe("log masking", async () => {
  const { maskAccountId } = await import("../src/models.js");
  it("keeps only the last 4 digits of account numbers", () => {
    expect(maskAccountId("012345 987654321")).toBe("••4321");
    expect(maskAccountId("amex-55501")).toBe("••5501");
    expect(maskAccountId("amex")).toBe("amex");
  });
});

describe("macquarie robot check", async () => {
  const { ROBOT_TEXT } = await import("../src/providers/macquarie.js");
  it("matches straight and curly apostrophes", () => {
    expect(ROBOT_TEXT.test("Confirm you’re not a robot by selecting the checkbox below.")).toBe(true);
    expect(ROBOT_TEXT.test("I'm not a robot")).toBe(true);
    expect(ROBOT_TEXT.test("Log in to Macquarie")).toBe(false);
  });
});

describe("macquarie csv", async () => {
  const { parseMacquarieCsv } = await import("../src/providers/macquarie.js");
  const acct = { id: "182-182 000000001", name: "Offset Account 1", currency: "AUD" };
  it("reads debit/credit columns", () => {
    const csv = [
      "Transaction Date,Details,Account,Category,Subcategory,Tags,Notes,Debit,Credit,Balance,Original Description",
      '07 Nov 2026,Woolworths,Offset Account 1,Groceries,,,,"1,204.50",,100.00,WOOLWORTHS 4321 PERTH',
      "06 Nov 2026,Salary,Offset Account 1,Income,,,,,2500.00,1304.50,ACME PAY",
    ].join("\n");
    expect(parseMacquarieCsv(csv, acct).map((t) => [t.date, t.amountCents, t.description])).toEqual([
      ["2026-11-07", -120450, "Woolworths"],
      ["2026-11-06", 250000, "Salary"],
    ]);
  });
  it("reads a signed amount column", () => {
    const csv = "Date,Description,Amount,Balance\n9/11/2026,COFFEE,-4.50,10.00\n";
    expect(parseMacquarieCsv(csv, acct)).toEqual([{ account: acct, date: "2026-11-09", amountCents: -450, description: "COFFEE" }]);
  });
  it("rejects files it can't read", () => {
    expect(() => parseMacquarieCsv("foo,bar\n1,2\n", acct)).toThrow(/no header/);
  });
});
