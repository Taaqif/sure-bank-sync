import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../src/providers/index.js";
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
  const noCustom = { choices: [7, 14], default: 7 };
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
    expect(() => runPeriod({ period: "custom", since: "2025-01-01" }, noCustom, tz)).toThrow(/custom dates/);
    expect(() => runPeriod({ period: "custom", since: "" }, demo, tz)).toThrow(/From date/);
    expect(() => runPeriod({ period: "custom", since: "2025-02-30" }, demo, tz)).toThrow(/From date/);
    expect(() => runPeriod({ period: "custom", since: "2025-03-01", until: "2025-01-01" }, demo, tz)).toThrow(/on or before/);
    expect(() => runPeriod({ period: "custom", since: "2025-01-01", until: "2999-01-01" }, demo, tz)).toThrow(/future/);
  });

  it("offers custom dates for banks that can search any range", async () => {
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
