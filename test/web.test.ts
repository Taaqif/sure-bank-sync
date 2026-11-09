import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeSure, form, makeApp, setup } from "./helpers.js";

const ACCT_ID = "012-345 6789999";
const get = (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, path: string, headers = {}) =>
  app.request(path, { headers: { Host: "localhost", ...headers } });

describe("web", () => {
  it("renders every page without leaking secrets", async () => {
    const env = setup();
    const sure = fakeSure();
    const { app } = makeApp(env, { fetch: sure.fetch });
    env.store.recordBankAccounts("alice-anz", [{ id: ACCT_ID, name: "Everyday", currency: "AUD" }]);
    const runId = env.runs.start("alice-anz", "alice", "manual");
    env.runs.finish(runId, "failed", { fetched: 0, created: 0, skipped: 0, unmapped: 0 }, "boom");

    const home = await (await get(app, "/")).text();
    expect(home).toContain("alice-anz");
    expect(home).toContain("boom");
    expect(home).toContain("1 account to map");
    expect(home.startsWith("<!doctype html>")).toBe(true);

    for (const p of ["/settings", "/users", `/users/${env.userId}`, "/connections/new", "/connections/new?provider=amex", `/runs/${runId}`]) {
      expect((await get(app, p)).status, p).toBe(200);
    }
    const page = await (await get(app, "/connections/alice-anz")).text();
    expect(page).toContain("Joint Everyday");
    expect(page).not.toContain("hunter2");
    expect(page).not.toContain("key-123");

    expect((await get(app, "/runs/999")).status).toBe(404);
    expect((await get(app, `/runs/${runId}/debug/..%2F..%2Fstate.db`)).status).toBe(404);
    const status = (await (await get(app, "/api/status")).json()) as Record<string, unknown>[];
    expect(status[0]).toMatchObject({ id: "alice-anz", lastStatus: "failed", unmappedAccounts: 1 });
  });

  it("saves account mappings", async () => {
    const env = setup();
    const { app } = makeApp(env);
    env.store.recordBankAccounts("alice-anz", [{ id: ACCT_ID, name: "Everyday", currency: "AUD" }]);
    const r = await app.request("/connections/alice-anz/accounts", form({ [`map_${ACCT_ID}`]: "acct-1" }));
    expect(r.status).toBe(303);
    expect(env.store.bankAccounts("alice-anz")[0]!.sureAccountId).toBe("acct-1");
    await app.request("/connections/alice-anz/accounts", form({ [`map_${ACCT_ID}`]: "__ignore__" }));
    expect(env.store.bankAccounts("alice-anz")[0]).toMatchObject({ sureAccountId: null, ignored: true });
  });

  it("creates, validates and deletes people and connections", async () => {
    const env = setup();
    const { app } = makeApp(env);
    expect((await app.request("/users", form({ name: "bob", sureApiKey: "bob-key" }))).status).toBe(303);
    const bob = env.store.users().find((u) => u.name === "bob")!;

    let r = await app.request(
      "/connections",
      form({ userId: String(bob.id), provider: "amex", enabled: "on", cred_username: "bob@x", cred_password: "pw", options: "{}" }),
    );
    expect(r.headers.get("location")).toMatch(/^\/connections\/bob-amex\?/);
    expect(env.store.credentials("bob-amex")).toEqual({ username: "bob@x", password: "pw" });

    r = await app.request("/connections", form({ userId: String(bob.id), provider: "amex", cred_username: "x" }));
    expect(decodeURIComponent(r.headers.get("location")!)).toContain("required: Password");

    r = await app.request(
      "/settings",
      form({ sureUrl: "http://sure2", timezone: "UTC", schedule: "bad", lookbackDays: "30", mfaTimeoutSeconds: "300", dryRun: "on" }),
    );
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("cron needs 5 fields");
    expect(env.store.settings().sureUrl).toBe("http://sure.test");

    const profile = join(env.dir, "browser", "bob-amex");
    mkdirSync(profile, { recursive: true });
    await app.request("/connections/bob-amex/delete", form({}));
    expect(env.store.connection("bob-amex")).toBeUndefined();
    expect(existsSync(profile)).toBe(false);
  });

  it("redirects to a login page and signs in with a session cookie", async () => {
    const env = setup();
    const { app } = makeApp(env, { password: "s3cret" });

    const r = await get(app, "/settings?x=1");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/login?next=%2Fsettings%3Fx%3D1");
    expect((await app.request("/api/status", { headers: { Host: "localhost" } })).status).toBe(401);

    const page = await (await get(app, "/login?next=/settings")).text();
    expect(page).toContain('name="password"');
    expect(page).not.toContain("Household"); // no nav before login

    const bad = await app.request("/login", form({ username: "admin", password: "nope", next: "/settings" }));
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain("Wrong username or password");

    const ok = await app.request("/login", form({ username: "admin", password: "s3cret", next: "/settings" }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/settings");
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/sbs_session=.*HttpOnly.*SameSite=Lax/i);
    const session = cookie.split(";")[0]!;

    const home = await get(app, "/", { Cookie: session });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Log out");

    // open redirects are refused
    const evil = await app.request("/login", form({ username: "admin", password: "s3cret", next: "//evil.example" }));
    expect(evil.headers.get("location")).toBe("/");

    // a tampered cookie is rejected
    expect((await get(app, "/", { Cookie: session.replace(/.$/, "x") })).status).toBe(303);
  });

  it("rate-limits failed logins", async () => {
    const env = setup();
    const { app } = makeApp(env, { password: "s3cret" });
    for (let i = 0; i < 10; i++) await app.request("/login", form({ username: "admin", password: "x" }));
    const r = await app.request("/login", form({ username: "admin", password: "s3cret" }));
    expect(r.status).toBe(429);
  }, 15_000);

  it("still accepts basic auth for scripts and blocks cross-site posts", async () => {
    const env = setup();
    const { app } = makeApp(env, { password: "s3cret" });
    const basic = (u: string, p: string) => ({ Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });
    expect((await get(app, "/", basic("admin", "wrong"))).status).toBe(303);
    expect((await get(app, "/", basic("admin", "s3cret"))).status).toBe(200);
    expect((await get(app, "/healthz")).status).toBe(200);

    const r = await app.request(
      "/users",
      form({ name: "eve", sureApiKey: "k" }, { ...basic("admin", "s3cret"), Origin: "http://evil.example" }),
    );
    expect(r.status).toBe(403);
    expect(env.store.users()).toHaveLength(1);
    const ok = await app.request(
      "/users",
      form({ name: "eve", sureApiKey: "k" }, { ...basic("admin", "s3cret"), Origin: "http://localhost" }),
    );
    expect(ok.status).toBe(303);
  });

  it("shows logs, dry-run banner and dry-run tag", async () => {
    const env = setup();
    const { app } = makeApp(env);
    const logs = await (await get(app, "/logs?level=warn")).text();
    expect(logs).toContain("Logs");
    expect(logs).toContain("warn and above");
    expect((await get(app, "/partials/logs?q=nothing-matches-this")).status).toBe(200);

    expect(await (await get(app, "/")).text()).not.toContain("Dry run mode is on");
    env.store.saveSettings({ ...env.store.settings(), dryRun: true });
    expect(await (await get(app, "/settings")).text()).toContain("Dry run mode is on");

    const runId = env.runs.start("alice-anz", "alice", "manual", true);
    expect(await (await get(app, `/runs/${runId}`)).text()).toContain("dry run: nothing written");
  });

  it("serves captured HTML as plain text", async () => {
    const env = setup();
    const { app } = makeApp(env);
    const runId = env.runs.start("alice-anz", "alice", "manual");
    const dir = join(env.dir, "debug", `run-${runId}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "failure-0.html"), "<script>alert(1)</script>");
    const r = await get(app, `/runs/${runId}/debug/failure-0.html`);
    expect(r.headers.get("content-type")).toContain("text/plain");
  });

  it("saves the browser console with a failed run's debug files", async () => {
    const env = setup();
    const { app, runner } = makeApp(env);
    const id = env.store.saveConnection(null, {
      userId: env.userId, provider: "demo", enabled: false, schedule: null, lookbackDays: null,
      credentials: {}, options: { fail: true },
    });
    const runId = await runner.run(id, "manual", { discover: true });
    expect(env.runs.get(runId)!.status).toBe("failed");
    const page = await (await get(app, `/runs/${runId}`)).text();
    expect(page).toContain(">Console</a>");
    expect(page).not.toContain(">Network</a>"); // off by default
    const log = await (await get(app, `/runs/${runId}/debug/console.txt`)).text();
    expect(log).toContain("warning demo: login service unavailable");
  }, 30_000);
});
