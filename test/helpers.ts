import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Crypto, generateKey } from "../src/crypto.js";
import { openDb } from "../src/db/client.js";
import { MfaBroker } from "../src/mfa.js";
import { Runner } from "../src/runner.js";
import { RunStore } from "../src/runs.js";
import { Scheduler } from "../src/scheduler.js";
import { ConfigStore, DEFAULT_SETTINGS } from "../src/store.js";
import { createApp, type Services } from "../src/web/app.js";
import type { AuthConfig } from "../src/web/auth.js";

export function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sbs-test-"));
  const dbPath = join(dir, "state.db");
  const key = generateKey();
  const store = new ConfigStore(openDb(dbPath), new Crypto(key));
  store.saveSettings({ ...DEFAULT_SETTINGS, sureUrl: "http://sure.test/" });
  const userId = store.saveUser(null, "alice", "key-123");
  store.saveConnection(null, {
    userId,
    provider: "anz",
    enabled: true,
    schedule: null,
    lookbackDays: null,
    credentials: { customer_id: "111", password: "hunter2" },
    options: {},
  });
  const runs = new RunStore(store.db);
  return { dir, dbPath, key, store, runs, userId };
}

/** Records Sure API calls; dedupes on external_id like the real thing. */
export function fakeSure(
  accounts = [{ id: "acct-1", name: "Joint Everyday", currency: "AUD" }],
  importStatus = "complete",
  /** what GET /transactions returns (Sure's sign: positive amount_decimal = money out) */
  transactions: { id: string; date: string; name: string; amount_decimal: string }[] = [],
) {
  const calls: { method: string; url: string; headers: Headers; body: any }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", url, headers: new Headers(init?.headers), body });
    if (url.includes("/transactions?")) {
      return Response.json({ transactions, pagination: { page: 1, per_page: 100, total_count: transactions.length, total_pages: 1 } });
    }
    if (url.includes("/accounts")) return Response.json({ accounts });
    if (url.endsWith("/imports") && init?.method === "POST") {
      return Response.json({ data: { id: `imp-${calls.length}`, status: "importing" } }, { status: 201 });
    }
    if (/\/imports\/[^/]+$/.test(url)) return Response.json({ data: { id: url.split("/").pop(), status: importStatus } });
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

export function makeApp(
  env: ReturnType<typeof setup>,
  opts: { password?: string; auth?: AuthConfig; oidc?: Services["oidc"]; fetch?: typeof fetch } = {},
) {
  const mfa = new MfaBroker();
  const runner = new Runner(env.store, env.runs, mfa, env.dir);
  const scheduler = new Scheduler(env.store, runner);
  const app = createApp({
    store: env.store,
    runs: env.runs,
    runner,
    scheduler,
    mfa,
    dataDir: env.dir,
    auth: opts.auth ?? (opts.password ? { mode: "password", trustProxy: false, admin: { user: "admin", password: opts.password } } : undefined),
    oidc: opts.oidc,
    fetch: opts.fetch,
  });
  return { app, runner, scheduler, mfa };
}

export const form = (data: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: new URLSearchParams(data),
  headers: { "Content-Type": "application/x-www-form-urlencoded", Host: "localhost", ...headers },
});
