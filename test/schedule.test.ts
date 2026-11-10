import { describe, expect, it } from "vitest";
import { buildCron, describeCron, nextRuns, parseCron } from "../src/schedule.js";
import { makeApp, setup } from "./helpers.js";

describe("schedule", () => {
  it("round-trips builder shapes", () => {
    for (const cron of ["15 * * * *", "0 */6 * * *", "30 6 * * *", "0 7 * * 1-5", "45 21 * * 0", "0 7 2 * *", "0 7 15 1,7 *"]) {
      expect(buildCron(parseCron(cron))).toBe(cron);
    }
    expect(parseCron("0 6 * * *")).toMatchObject({ mode: "daily", hour: 6, minute: 0 });
    expect(parseCron("0 */5 * * *").mode).toBe("custom"); // 5 isn't an offered interval
    expect(parseCron("0 6 1 * *")).toMatchObject({ mode: "monthly", dayOfMonth: 1, hour: 6 });
    expect(parseCron("0 6 31 * *").mode).toBe("custom"); // not every month has a 31st
    expect(parseCron("0 6 1 * 1").mode).toBe("custom");
    expect(parseCron("0 7 15 1,7 *")).toMatchObject({ mode: "halfyearly", month: 1, dayOfMonth: 15, hour: 7 });
    expect(parseCron("0 7 15 1,8 *").mode).toBe("custom");
  });

  it("describes schedules in plain words", () => {
    expect(describeCron("0 6 * * *")).toBe("Daily at 06:00");
    expect(describeCron("30 7 * * 1-5")).toBe("Weekdays at 07:30");
    expect(describeCron("0 9 * * 0")).toBe("Sundays at 09:00");
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours");
    expect(describeCron("0 6 1 * *")).toBe("Monthly on the 1st at 06:00");
    expect(describeCron("30 7 22 * *")).toBe("Monthly on the 22nd at 07:30");
    expect(describeCron("0 6 31 * *")).toBe("Custom (0 6 31 * *)");
    expect(describeCron("0 7 15 1,7 *")).toBe("Every 6 months: the 15th of Jan and Jul at 07:00");
  });

  it("computes next runs in the configured timezone", () => {
    const [next] = nextRuns("0 6 * * *", "Australia/Melbourne", 1, new Date("2026-11-09T12:00:00Z"));
    expect(next!.toISOString()).toBe("2026-11-09T19:00:00.000Z"); // 06:00 AEDT
  });

  it("serves a preview for the picker", async () => {
    const { app } = makeApp(setup());
    const ok = (await (await app.request("/api/cron-preview?cron=0+6+*+*+*&tz=UTC")).json()) as any;
    expect(ok).toMatchObject({ ok: true, description: "Daily at 06:00" });
    expect(ok.next).toHaveLength(3);
    const bad = (await (await app.request("/api/cron-preview?cron=nope")).json()) as any;
    expect(bad.ok).toBe(false);
  });

  it("renders the schedule picker on settings and the sync period on connection pages", async () => {
    const env = setup();
    const { app } = makeApp(env);
    const settings = await (await app.request("/settings", { headers: { Host: "localhost" } })).text();
    expect(settings).toContain("data-schedule");
    const conn = await (await app.request("/connections/alice-anz", { headers: { Host: "localhost" } })).text();
    expect(conn).toContain("Use default (Daily at 06:00)");
    expect(conn).toContain("Bank default (last 14 days)");
    expect(conn).not.toContain("Debug run"); // only with SURE_SYNC_DEBUG=1
    const home = await (await app.request("/", { headers: { Host: "localhost" } })).text();
    expect(home).toContain("Daily at 06:00 · last 14 days");
  });
});
