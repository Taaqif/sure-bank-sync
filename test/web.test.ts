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
      form({ sureUrl: "http://sure2", timezone: "UTC", schedule: "bad", lookbackDays: "30", mfaTimeoutSeconds: "300" }),
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

  it("requires login and blocks cross-site posts", async () => {
    const env = setup();
    const { app } = makeApp(env, { password: "s3cret" });
    const basic = (u: string, p: string) => ({ Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });
    expect((await get(app, "/")).status).toBe(401);
    expect((await get(app, "/", basic("admin", "wrong"))).status).toBe(401);
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
});
