import { describe, expect, it } from "vitest";
import { DEFAULT_PERIOD_DAYS, PERIOD_CHOICES, PROVIDERS, periodChoices, type ProviderDefinition } from "../src/providers/index.js";
import { runPeriod } from "../src/web/app.js";
import { makeApp, setup } from "./helpers.js";

const get = (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, path: string) =>
  app.request(path, { headers: { Host: "localhost" } });

function demoConn(env: ReturnType<typeof setup>) {
  return env.store.saveConnection(null, {
    userId: env.userId, provider: "demo", enabled: true, schedule: null, lookbackDays: null,
    credentials: {}, options: {},
  });
}

describe("run period", () => {
  const tz = "Australia/Melbourne";
  const demo = PROVIDERS.demo!.syncPeriod;
  const anz = PROVIDERS.anz!.syncPeriod;
  const stake = PROVIDERS.stake!.syncPeriod;

  it("parses the period picked on Run now", () => {
    expect(runPeriod({}, demo, tz)).toBeUndefined();
    expect(runPeriod({ period: "14" }, demo, tz)).toEqual({ days: 14 });
    expect(runPeriod({ period: "all" }, stake, tz)).toEqual({ days: 0 });
    expect(runPeriod({ period: "custom", since: "2025-01-01", until: "2025-03-31" }, demo, tz)).toEqual({
      since: "2025-01-01",
      until: "2025-03-31",
    });
  });

  it("rejects choices the bank doesn't offer and bad dates", () => {
    expect(() => runPeriod({ period: "13" }, demo, tz)).toThrow(/from the list/);
    expect(() => runPeriod({ period: "all" }, demo, tz)).toThrow(/all time/);
    expect(() => runPeriod({ period: "730" }, stake, tz)).toThrow(/from the list/); // longer: All time or custom dates
    expect(() => runPeriod({ period: "custom", since: "" }, demo, tz)).toThrow(/From date/);
    expect(() => runPeriod({ period: "custom", since: "2025-02-30" }, demo, tz)).toThrow(/From date/);
    expect(() => runPeriod({ period: "custom", since: "2025-03-01", until: "2025-01-01" }, demo, tz)).toThrow(/on or before/);
    expect(() => runPeriod({ period: "custom", since: "2025-01-01", until: "2999-01-01" }, demo, tz)).toThrow(/future/);
  });

  it("gives every bank the same choices, trimmed to how far back it goes", () => {
    for (const p of Object.values(PROVIDERS)) expect(periodChoices(p.syncPeriod)).toEqual(PERIOD_CHOICES);
    expect(PERIOD_CHOICES.at(-1)).toBe(365);
    expect(PERIOD_CHOICES).toContain(DEFAULT_PERIOD_DAYS);
    expect(DEFAULT_PERIOD_DAYS).toBe(7);
  });

  it("trims a run to the bank's history limit", async () => {
    const env = setup();
    const { runner } = makeApp(env);
    const demoDef = PROVIDERS.demo!;
    PROVIDERS.short = { ...demoDef, name: "short", label: "Short bank", syncPeriod: { maxDays: 30 } } as ProviderDefinition;
    try {
      const id = env.store.saveConnection(null, {
        userId: env.userId, provider: "short", enabled: true, schedule: null, lookbackDays: null, credentials: {}, options: {},
      });
      const runId = await runner.run(id, "manual", { dryRun: true, period: { since: "2020-01-01", until: "2025-03-31" } });
      const run = env.runs.get(runId)!;
      expect(run.log).toContain("Short bank keeps 30 days of history; fetching from 2025-03-01");
      expect(run.log).toContain("2025-03-01 → 2025-03-31");
    } finally {
      delete PROVIDERS.short;
    }
  });

  it("offers custom dates for every bank", async () => {
    const env = setup();
    const { app } = makeApp(env);
    const id = demoConn(env);
    const demoPage = await (await get(app, `/connections/${id}`)).text();
    expect(demoPage).toContain('id="run-dialog"');
    expect(demoPage).toContain('name="period"');
    expect(demoPage).toContain("Custom dates…");
    const anzPage = await (await get(app, "/connections/alice-anz")).text();
    expect(anzPage).toContain("Custom dates…");
  });

  it("fetches exactly the chosen dates for this run only", async () => {
    const env = setup();
    const { runner } = makeApp(env);
    const id = demoConn(env);
    const runId = await runner.run(id, "manual", { dryRun: true, period: { since: "2025-01-01", until: "2025-01-10" } });
    const run = env.runs.get(runId)!;
    expect(run.status).toBe("success");
    expect(run.log).toContain("2025-01-01 → 2025-01-10");
    expect(run.log).toContain("PERIOD: chosen for this run only");
    expect(run.fetched).toBe(11); // 10 coffees + salary on the 1st
    expect(env.store.connection(id)!.lookbackDays).toBeNull();
  });
});
