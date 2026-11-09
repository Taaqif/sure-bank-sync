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

    let s = emptyStats();
    await pushTransactions(deps, conn, env.store.settings(), [txn(), txn("SALARY", 250000)], s, (m) => lines.push(m), true);
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
