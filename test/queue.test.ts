import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MfaBroker } from "../src/mfa.js";
import { PROVIDERS, type ProviderDefinition } from "../src/providers/index.js";
import { Runner, Slots } from "../src/runner.js";
import { setup } from "./helpers.js";

describe("Slots", () => {
  it("queues past the capacity, first come first served, and grows on drain", async () => {
    let cap = 1;
    const s = new Slots(() => cap);
    await s.acquire();
    const order: number[] = [];
    const a = s.acquire().then(() => order.push(1));
    const b = s.acquire().then(() => order.push(2));
    expect(s.available).toBe(false);
    cap = 2;
    s.drain();
    await a;
    expect(order).toEqual([1]);
    s.release();
    await b;
    expect(order).toEqual([1, 2]);
  });

  it("gives up the place in line when aborted", async () => {
    const s = new Slots(() => 1);
    await s.acquire();
    const ac = new AbortController();
    const waiting = s.acquire(ac.signal);
    ac.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    s.release();
    expect(s.used).toBe(0);
  });
});

/**
 * Real runs (headless browsers) with pretend banks that record when each run
 * is "inside the bank", so overlaps are visible.
 */
describe("runner queueing", () => {
  const events: string[] = [];
  const inside = new Map<string, number>();
  let maxInsideSameBank = 0;
  const pretendBank = (name: string): ProviderDefinition => ({
    name,
    label: name,
    credentialFields: [],
    syncPeriod: { choices: [1], default: 1 },
    create: (ctx) => ({
      async login() {
        const n = (inside.get(name) ?? 0) + 1;
        inside.set(name, n);
        maxInsideSameBank = Math.max(maxInsideSameBank, n);
        events.push(`start ${ctx.connectionId}`);
        if (ctx.options.code) await ctx.requestMfa("code please");
        await new Promise((r) => setTimeout(r, 300));
        events.push(`end ${ctx.connectionId}`);
        inside.set(name, (inside.get(name) ?? 1) - 1);
      },
      async fetchTransactions() {
        return [];
      },
    }),
  });

  const headless = process.env.SURE_SYNC_HEADLESS;
  beforeAll(() => {
    process.env.SURE_SYNC_HEADLESS = "1";
    PROVIDERS["bank-a"] = pretendBank("bank-a");
    PROVIDERS["bank-b"] = pretendBank("bank-b");
  });
  afterAll(() => {
    delete PROVIDERS["bank-a"];
    delete PROVIDERS["bank-b"];
    if (headless === undefined) delete process.env.SURE_SYNC_HEADLESS;
    else process.env.SURE_SYNC_HEADLESS = headless;
  });

  /** Connections for the pretend banks; returns the store, run history and the new connection ids. */
  function env(conns: { provider: string; options?: Record<string, unknown> }[]) {
    const e = setup();
    const ids = conns.map((c) =>
      e.store.saveConnection(null, {
        userId: e.userId,
        provider: c.provider,
        enabled: true,
        schedule: null,
        lookbackDays: null,
        credentials: {},
        options: c.options ?? {},
      }),
    );
    return { ...e, ids };
  }

  it("runs one connection per bank at a time", async () => {
    events.length = 0;
    maxInsideSameBank = 0;
    const e = env([{ provider: "bank-a" }, { provider: "bank-a" }]);
    const runner = new Runner(e.store, e.runs, new MfaBroker(), e.dir, 4);
    await Promise.all(e.ids.map((id) => runner.run(id, "manual", { dryRun: true })));
    expect(maxInsideSameBank).toBe(1);
    expect(events).toHaveLength(4);
    const logs = e.runs.recent(undefined, 5).map((r) => r.log).join("\n");
    expect(logs).toContain("waiting for another bank-a run to finish");
  }, 60_000);

  it("lets the next run go while one waits for a code", async () => {
    events.length = 0;
    const e = env([{ provider: "bank-a", options: { code: true } }, { provider: "bank-b" }]);
    const [a, b] = e.ids as [string, string];
    const mfa = new MfaBroker();
    const runner = new Runner(e.store, e.runs, mfa, e.dir, 1);
    const first = runner.run(a, "manual", { dryRun: true });
    // wait until the first run is waiting for its code
    for (let i = 0; i < 400 && !mfa.get(a); i++) await new Promise((r) => setTimeout(r, 50));
    expect(mfa.get(a)).toBeDefined();
    // the second run gets the only browser slot and finishes while the first still waits
    await runner.run(b, "manual", { dryRun: true });
    expect(events).toContain(`end ${b}`);
    expect(events).not.toContain(`end ${a}`);
    mfa.submit(a, "123456");
    await first;
    expect(events.indexOf(`end ${b}`)).toBeLessThan(events.indexOf(`end ${a}`));
  }, 60_000);

  it("queues runs beyond the browser limit", async () => {
    events.length = 0;
    const e = env([{ provider: "bank-a" }, { provider: "bank-b" }]);
    const runner = new Runner(e.store, e.runs, new MfaBroker(), e.dir, 1);
    await Promise.all(e.ids.map((id) => runner.run(id, "manual", { dryRun: true })));
    // with one browser, the second run starts only after the first ends
    expect(events[1]).toMatch(/^end /);
    const logs = e.runs.recent(undefined, 5).map((r) => r.log).join("\n");
    expect(logs).toContain("waiting for a browser slot");
  }, 60_000);
});
