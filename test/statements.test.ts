import { describe, expect, it } from "vitest";
import { form, makeApp, setup } from "./helpers.js";

const get = (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, path: string) =>
  app.request(path, { headers: { Host: "localhost" } });

function demoConn(env: ReturnType<typeof setup>, statementsEnabled = true) {
  return env.store.saveConnection(null, {
    userId: env.userId, provider: "demo", enabled: true, schedule: null, lookbackDays: null,
    statementsEnabled, statementSchedule: null, credentials: {}, options: {},
  });
}

describe("statements", () => {
  it("runs a statement import as its own kind of run (Sure has no API yet: nothing sent)", async () => {
    const env = setup();
    const { runner } = makeApp(env);
    const id = demoConn(env);
    const runId = await runner.run(id, "manual", { kind: "statements" });
    const run = env.runs.get(runId)!;
    expect(run.status).toBe("success");
    expect(run.kind).toBe("statements");
    expect(run.fetched).toBeGreaterThan(0);
    expect(run.fetched % 2).toBe(0); // one per account per month
    expect(run.log).toContain("statement: Demo Everyday");
    expect(run.log).toContain("nothing was sent");
  });

  it("fails clearly for banks without statement support", async () => {
    const env = setup();
    const { runner } = makeApp(env);
    const runId = await runner.run("alice-anz", "manual", { kind: "statements" });
    expect(env.runs.get(runId)!.status).toBe("failed");
    expect(env.runs.get(runId)!.error).toMatch(/can't import statements yet/);
  });

  it("schedules statements separately, only when turned on and supported", () => {
    const env = setup();
    const { scheduler } = makeApp(env);
    const on = demoConn(env, true);
    const off = demoConn(env, false);
    env.store.saveConnection("alice-anz", {
      userId: env.userId, provider: "anz", enabled: true, schedule: null, lookbackDays: null,
      statementsEnabled: true, statementSchedule: null, credentials: {}, options: {},
    });
    scheduler.reload();
    try {
      expect(scheduler.nextRun(on)).not.toBeNull();
      const next = scheduler.nextRun(on, "statements")!;
      expect(next.getTime()).not.toBe(scheduler.nextRun(on)!.getTime());
      expect(scheduler.nextRun(off, "statements")).toBeNull();
      expect(scheduler.nextRun("alice-anz", "statements")).toBeNull();
      // Statements don't depend on the transactions switch.
      env.store.saveConnection(on, {
        userId: env.userId, provider: "demo", enabled: false, schedule: null, lookbackDays: null,
        statementsEnabled: true, statementSchedule: null, credentials: {}, options: {},
      });
      scheduler.reload();
      expect(scheduler.nextRun(on)).toBeNull();
      expect(scheduler.nextRun(on, "statements")).not.toBeNull();
    } finally {
      scheduler.stop();
    }
  });

  it("saves statement settings from the connection form, and disables them for unsupported banks", async () => {
    const env = setup();
    const { app } = makeApp(env);
    const id = demoConn(env, false);
    const r = await app.request(
      `/connections/${id}`,
      form({ userId: String(env.userId), enabled: "on", schedule: "", statementsEnabled: "on", statementSchedule: "0 8 5 * *", options: "{}" }),
    );
    expect(r.status).toBe(303);
    expect(env.store.connection(id)).toMatchObject({ statementsEnabled: true, statementSchedule: "0 8 5 * *" });
    expect(await (await get(app, `/connections/${id}`)).text()).toContain("Monthly on the 5th at 08:00");

    await app.request(
      "/connections/alice-anz",
      form({ userId: String(env.userId), enabled: "on", schedule: "", statementsEnabled: "on", options: "{}" }),
    );
    expect(env.store.connection("alice-anz")!.statementsEnabled).toBe(false);
    const page = await (await get(app, "/connections/alice-anz")).text();
    expect(page).toContain("can&#39;t import statements yet");
    expect(page).toMatch(/<fieldset[^>]*disabled/);
  });

  it("saves the default statement schedule in settings", async () => {
    const env = setup();
    const { app } = makeApp(env);
    const s = env.store.settings();
    await app.request(
      "/settings",
      form({ sureUrl: s.sureUrl, sureSource: s.sureSource, timezone: s.timezone, schedule: s.schedule, statementSchedule: "0 9 2 * *", mfaTimeoutSeconds: "300", maxBrowsers: "2" }),
    );
    expect(env.store.settings().statementSchedule).toBe("0 9 2 * *");
  });
});
