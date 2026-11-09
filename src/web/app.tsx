import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { getConnInfo } from "@hono/node-server/conninfo";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Child } from "hono/jsx";
import { clearLogFile, logFileBytes, logger, tailLog } from "../log.js";
import type { MfaBroker } from "../mfa.js";
import { PROVIDERS, syncLabel } from "../providers/index.js";
import { DEBUG_TOOLS, type Runner } from "../runner.js";
import { RECIPE_RE, type Recording } from "../recorder.js";
import { cronPreview, describeCron } from "../schedule.js";
import type { RunStore } from "../runs.js";
import type { Scheduler } from "../scheduler.js";
import { ValidationError, type ConfigStore, type ConnectionInput } from "../store.js";
import { SureClient, SureError, type SureAccount } from "../sureClient.js";
import { LoginLimiter, SESSION_COOKIE, SESSION_TTL_SECONDS, createSession, safeNext, verifySession } from "./session.js";
import { UiContext } from "./views/layout.js";
import {
  ConnectionNewPage,
  LoginPage,
  LogLines,
  LogsPage,
  type LogEntry,
  ConnectionPage,
  DashboardPage,
  DashboardStatus,
  RemotePage,
  RunPage,
  runStats,
  SettingsPage,
  UserPage,
  UsersPage,
  type ConnectionRow,
  type DashboardProps,
  type StorageInfo,
} from "./views/pages.js";

export interface Services {
  store: ConfigStore;
  runs: RunStore;
  runner: Runner;
  scheduler: Scheduler;
  mfa: MfaBroker;
  dataDir: string;
  admin?: { user: string; password: string };
  /** signs session cookies; defaults to a per-process random secret */
  sessionSecret?: string;
  /** shown on the logs page */
  logMaxBytes?: number;
  /** for tests */
  fetch?: typeof fetch;
}

const log = logger("web");

type Body = Record<string, string | File | (string | File)[]>;
const str = (b: Body, k: string): string => {
  const v = b[k];
  return typeof v === "string" ? v : "";
};

function redirect(c: Context, url: string, msg?: string) {
  if (msg) url += (url.includes("?") ? "&" : "?") + "msg=" + encodeURIComponent(msg);
  return c.redirect(url, 303);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createApp(svc: Services) {
  const { store, runs } = svc;
  const app = new Hono();

  // Browsers resend basic-auth credentials on cross-site form posts, so
  // reject POSTs whose Origin/Referer isn't this host. Compares host only
  // so it works behind a TLS-terminating reverse proxy.
  app.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      const src = c.req.header("origin") ?? c.req.header("referer");
      const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
      if (src && src !== "null") {
        let srcHost: string | undefined;
        try {
          srcHost = new URL(src).host;
        } catch {}
        if (srcHost !== host) return c.text("cross-origin request blocked", 403);
      } else if (src === "null") {
        return c.text("cross-origin request blocked", 403);
      }
    }
    await next();
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // --- login ----------------------------------------------------------------
  const secret = svc.sessionSecret ?? randomBytes(32).toString("hex");
  const limiter = new LoginLimiter();
  // Socket address, not X-Forwarded-For (a client could rotate that header to dodge the limit).
  const clientKey = (c: Context) => {
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "local";
    }
  };
  const isHttps = (c: Context) =>
    (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")) === "https";

  function authenticated(c: Context): boolean {
    const admin = svc.admin!;
    if (verifySession(getCookie(c, SESSION_COOKIE), secret, admin.user, admin.password)) return true;
    // Basic auth still works for scripts/curl, but not from web browsers: they
    // keep sending saved Basic credentials, which would undo Log out.
    // Browsers mark every request with Sec-Fetch-Mode; scripts don't.
    if (c.req.header("sec-fetch-mode")) return false;
    const [scheme, encoded] = (c.req.header("authorization") ?? "").split(" ");
    if (scheme?.toLowerCase() === "basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString();
      const i = decoded.indexOf(":");
      return i >= 0 && safeEqual(decoded.slice(0, i), admin.user) && safeEqual(decoded.slice(i + 1), admin.password);
    }
    return false;
  }

  app.get("/login", (c) => {
    if (!svc.admin || authenticated(c)) return c.redirect(safeNext(c.req.query("next")), 303);
    return c.html(<LoginPage next={safeNext(c.req.query("next"))} />);
  });

  app.post("/login", async (c) => {
    if (!svc.admin) return c.redirect("/", 303);
    const b = await c.req.parseBody();
    const next = safeNext(str(b, "next"));
    const key = clientKey(c);
    if (limiter.blocked(key)) {
      log.warn(`login blocked for ${key}: too many failed attempts`);
      return c.html(<LoginPage next={next} error="Too many failed attempts. Try again in 15 minutes." />, 429);
    }
    const ok = safeEqual(str(b, "username"), svc.admin.user) && safeEqual(str(b, "password"), svc.admin.password);
    if (!ok) {
      limiter.fail(key);
      log.warn(`failed login for ${JSON.stringify(str(b, "username").slice(0, 40))} from ${key}`);
      await new Promise((r) => setTimeout(r, 400));
      return c.html(<LoginPage next={next} username={str(b, "username")} error="Wrong username or password." />, 401);
    }
    limiter.reset(key);
    setCookie(c, SESSION_COOKIE, createSession(secret, svc.admin.user, svc.admin.password), {
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps(c),
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    log.info(`login from ${key}`);
    return c.redirect(next, 303);
  });

  app.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/login", 303);
  });

  app.use("*", async (c, next) => {
    if (!svc.admin || authenticated(c)) return next();
    const path = c.req.path;
    const wantsHtml = c.req.method === "GET" && !path.startsWith("/api/") && !path.startsWith("/partials/");
    if (wantsHtml) {
      const target = path + (new URL(c.req.url).search || "");
      return c.redirect(`/login?next=${encodeURIComponent(target)}`, 303);
    }
    return c.json({ error: "login_required" }, 401);
  });

  const msgOf = (c: Context) => c.req.query("msg");
  const page = (c: Context, node: Child, status?: 200 | 400) =>
    c.html(
      <UiContext.Provider
        value={{
          dryRun: store.settings().dryRun,
          debugTools: DEBUG_TOOLS,
          auth: !!svc.admin,
          needsBrowser: svc.mfa
            .pending()
            .filter((m) => m.kind === "browser")
            .map((m) => ({ connectionId: m.connectionId, prompt: m.prompt })),
        }}
      >
        {node}
      </UiContext.Provider>,
      status,
    );
  const removeProfile = (id: string) => rm(join(svc.dataDir, "browser", id), { recursive: true, force: true });
  const sureClient = (userId: number, timeoutMs: number) => {
    const s = store.settings();
    return new SureClient(s.sureUrl, store.sureApiKey(userId), s.sureSource, timeoutMs, svc.fetch);
  };

  function connectionRows(): ConnectionRow[] {
    const s = store.settings();
    return store.connections().map((conn) => ({
      scheduleLabel: conn.enabled
        ? `${describeCron(conn.schedule ?? s.schedule)} · ${syncLabel(conn)}`
        : "not scheduled",
      conn,
      providerLabel: PROVIDERS[conn.provider]?.label ?? conn.provider,
      running: svc.runner.isRunning(conn.id),
      last: runs.last(conn.id),
      lastOk: runs.lastSuccess(conn.id),
      nextRun: svc.scheduler.nextRun(conn.id),
      mfa: svc.mfa.get(conn.id),
      unmapped: store.bankAccounts(conn.id).filter((a) => !a.sureAccountId && !a.ignored).length,
    }));
  }

  const runsPage = (c: Context) => Number(c.req.query("runs")) || 1;
  const dashboard = (c: Context): DashboardProps => ({
    rows: connectionRows(),
    runs: runs.page(undefined, runsPage(c)),
    settings: store.settings(),
    hasUsers: store.users().length > 0,
  });

  // --- status ---------------------------------------------------------------
  app.get("/", (c) => page(c, <DashboardPage {...dashboard(c)} msg={msgOf(c)} />));
  app.get("/partials/status", (c) => page(c, <DashboardStatus {...dashboard(c)} />));

  app.get("/api/status", (c) =>
    c.json(
      connectionRows().map((r) => ({
        id: r.conn.id,
        user: r.conn.userName,
        provider: r.conn.provider,
        enabled: r.conn.enabled,
        running: r.running,
        awaitingMfa: !!r.mfa,
        unmappedAccounts: r.unmapped,
        lastStatus: r.last?.status ?? null,
        lastRunAt: r.last?.startedAt ?? null,
        lastSuccessAt: r.lastOk?.finishedAt ?? null,
        nextRunAt: r.nextRun?.toISOString() ?? null,
      })),
    ),
  );

  // Live preview for the schedule picker.
  app.get("/api/needs", (c) =>
    c.json(
      svc.mfa
        .pending()
        .filter((m) => m.kind === "browser")
        .map((m) => ({ connectionId: m.connectionId, prompt: m.prompt })),
    ),
  );

  app.get("/api/cron-preview", (c) => {
    const s = store.settings();
    const tz = c.req.query("tz")?.trim() || s.timezone;
    return c.json(cronPreview((c.req.query("cron") ?? "").trim(), tz));
  });

  // --- settings -------------------------------------------------------------
  /** Total size of the files under `root`. */
  async function dirBytes(root: string): Promise<number> {
    let bytes = 0;
    const walk = async (p: string): Promise<void> => {
      for (const e of await readdir(p, { withFileTypes: true }).catch(() => [])) {
        const full = join(p, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) bytes += (await stat(full).catch(() => ({ size: 0 }))).size;
      }
    };
    await walk(root);
    return bytes;
  }

  /** Saved browser profiles (one per connection) and their size on disk. */
  async function browserData(): Promise<{ profiles: number; bytes: number }> {
    const root = join(svc.dataDir, "browser");
    const dirs = await readdir(root).catch(() => [] as string[]);
    return { profiles: dirs.length, bytes: await dirBytes(root) };
  }

  /** What takes space in the data folder, for Settings -> Storage. */
  async function storage(): Promise<StorageInfo> {
    const fileBytes = async (p: string) => (await stat(p).catch(() => ({ size: 0 }))).size;
    const db = join(svc.dataDir, "state.db");
    const debugDirs = (await readdir(join(svc.dataDir, "debug")).catch(() => [] as string[])).filter((d) => /^run-\d+$/.test(d));
    return {
      dbBytes: (await fileBytes(db)) + (await fileBytes(`${db}-wal`)) + (await fileBytes(`${db}-shm`)),
      ...runs.storageStats(),
      debugRuns: debugDirs.length,
      debugBytes: await dirBytes(join(svc.dataDir, "debug")),
      appLogBytes: logFileBytes(),
      browser: await browserData(),
    };
  }

  app.get("/settings", async (c) =>
    page(c, <SettingsPage s={store.settings()} storage={await storage()} msg={msgOf(c)} />),
  );

  // Storage cleanup. Run history and debug files of runs in progress are kept.
  app.post("/settings/storage/runs", async (c) => {
    const days = Number((await c.req.parseBody()).olderThanDays);
    if (![0, 7, 30, 90].includes(days)) return redirect(c, "/settings#storage", "Error: pick how old");
    const n = runs.deleteFinishedOlderThan(days);
    runs.compact();
    log.info(`deleted ${n} runs older than ${days} days`);
    return redirect(c, "/settings#storage", `Deleted ${n} run${n === 1 ? "" : "s"} and their logs`);
  });

  app.post("/settings/storage/debug", async (c) => {
    const root = join(svc.dataDir, "debug");
    const keep = new Set(svc.runner.activeRunIds().map((id) => `run-${id}`));
    const dirs = (await readdir(root).catch(() => [] as string[])).filter((d) => /^run-\d+$/.test(d) && !keep.has(d));
    await Promise.all(dirs.map((d) => rm(join(root, d), { recursive: true, force: true })));
    log.info(`deleted debug files of ${dirs.length} runs`);
    return redirect(c, "/settings#storage", `Deleted debug files of ${dirs.length} run${dirs.length === 1 ? "" : "s"}`);
  });

  app.post("/settings/storage/app-log", (c) => {
    clearLogFile();
    log.info("app log cleared from Settings");
    return redirect(c, "/settings#storage", "Cleared the app log");
  });

  // Forget every saved browser: cookies, sessions and remembered devices for all connections.
  app.post("/settings/clear-browsers", async (c) => {
    if (svc.runner.anyRunning()) return redirect(c, "/settings#storage", "Error: stop the runs in progress first");
    const { profiles } = await browserData();
    await rm(join(svc.dataDir, "browser"), { recursive: true, force: true });
    log.info(`cleared ${profiles} browser profiles`);
    return redirect(c, "/settings#storage", `Cleared ${profiles} saved browser${profiles === 1 ? "" : "s"}`);
  });

  app.post("/settings", async (c) => {
    const b = await c.req.parseBody();
    const input = {
      sureUrl: str(b, "sureUrl"),
      sureSource: str(b, "sureSource"),
      timezone: str(b, "timezone"),
      schedule: str(b, "schedule"),
      skipPending: b.skipPending === "on",
      mfaTimeoutSeconds: str(b, "mfaTimeoutSeconds"),
      dryRun: b.dryRun === "on",
      saveNetworkLog: b.saveNetworkLog === "on",
      verboseLogs: b.verboseLogs === "on",
    };
    try {
      store.saveSettings(input);
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      const shown = { ...store.settings(), ...input, mfaTimeoutSeconds: Number(input.mfaTimeoutSeconds) };
      return page(c, <SettingsPage s={shown} storage={await storage()} error={e.message} />, 400);
    }
    svc.scheduler.reload();
    return redirect(c, "/settings", "Settings saved");
  });

  // --- household ------------------------------------------------------------
  app.get("/users", (c) => {
    const conns = store.connections();
    const users = store.users().map((user) => ({ user, conns: conns.filter((x) => x.userId === user.id) }));
    return page(c, <UsersPage users={users} msg={msgOf(c)} />);
  });

  app.post("/users", async (c) => {
    const b = await c.req.parseBody();
    try {
      store.saveUser(null, str(b, "name"), str(b, "sureApiKey"));
    } catch (e) {
      if (e instanceof ValidationError) return redirect(c, "/users", `Error: ${e.message}`);
      throw e;
    }
    return redirect(c, "/users", "Person added");
  });

  app.get("/users/:id{[0-9]+}", (c) => {
    const id = Number(c.req.param("id"));
    const user = store.user(id);
    if (!user) return c.notFound();
    return page(c, <UserPage user={user} conns={store.connections().filter((x) => x.userId === id)} msg={msgOf(c)} />);
  });

  app.post("/users/:id{[0-9]+}", async (c) => {
    const id = Number(c.req.param("id"));
    if (!store.user(id)) return c.notFound();
    const b = await c.req.parseBody();
    try {
      store.saveUser(id, str(b, "name"), str(b, "sureApiKey"));
    } catch (e) {
      if (e instanceof ValidationError) return redirect(c, `/users/${id}`, `Error: ${e.message}`);
      throw e;
    }
    return redirect(c, `/users/${id}`, "Saved");
  });

  app.post("/users/:id{[0-9]+}/test", async (c) => {
    const id = Number(c.req.param("id"));
    if (!store.user(id)) return c.notFound();
    if (!store.isConfigured()) return redirect(c, `/users/${id}`, "Error: set the Sure URL in Settings first");
    try {
      const accts = await sureClient(id, 10_000).listAccounts();
      return redirect(c, `/users/${id}`, `Connected to Sure: ${accts.length} accounts visible`);
    } catch (e) {
      if (e instanceof SureError) return redirect(c, `/users/${id}`, `Error: ${e.message}`);
      throw e;
    }
  });

  app.post("/users/:id{[0-9]+}/delete", async (c) => {
    const id = Number(c.req.param("id"));
    const connIds = store
      .connections()
      .filter((x) => x.userId === id)
      .map((x) => x.id);
    if (connIds.some((x) => svc.runner.isRunning(x))) return redirect(c, `/users/${id}`, "Error: wait for running syncs to finish");
    store.deleteUser(id);
    await Promise.all(connIds.map(removeProfile));
    svc.scheduler.reload();
    return redirect(c, "/users", "Person deleted");
  });

  // --- connections ----------------------------------------------------------
  function connectionInput(b: Body, provider: string): ConnectionInput {
    const def = PROVIDERS[provider];
    if (!def) throw new ValidationError("pick a bank");
    let options: unknown;
    try {
      options = JSON.parse(str(b, "options").trim() || "{}");
    } catch {
      options = null;
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new ValidationError('options must be a JSON object, e.g. {"mfa": true}');
    }
    const lookback = str(b, "lookbackDays").trim();
    return {
      userId: Number(str(b, "userId")),
      provider,
      enabled: b.enabled === "on",
      schedule: str(b, "schedule") || null,
      // Banks with a fixed period ignore any stored choice.
      lookbackDays: lookback && !("fixed" in def.syncPeriod) ? Number(lookback) : null,
      credentials: Object.fromEntries(def.credentialFields.map((f) => [f.key, str(b, `cred_${f.key}`).trim()])),
      options: options as Record<string, unknown>,
    };
  }

  app.get("/connections/new", (c) => {
    const provider = PROVIDERS[c.req.query("provider") ?? ""] ?? Object.values(PROVIDERS)[0]!;
    const userId = c.req.query("userId");
    return page(
      c,
      <ConnectionNewPage
        users={store.users()}
        providers={Object.values(PROVIDERS)}
        provider={provider}
        userId={userId ? Number(userId) : undefined}
        settings={store.settings()}
        msg={msgOf(c)}
      />,
    );
  });

  app.post("/connections", async (c) => {
    const b = await c.req.parseBody();
    const provider = str(b, "provider");
    let id: string;
    try {
      const input = connectionInput(b, provider);
      const missing = PROVIDERS[provider]!.credentialFields.filter((f) => !input.credentials[f.key]).map((f) => f.label);
      if (missing.length) throw new ValidationError(`required: ${missing.join(", ")}`);
      id = store.saveConnection(null, input);
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      const q = new URLSearchParams({ provider, userId: str(b, "userId") });
      return redirect(c, `/connections/new?${q}`, `Error: ${e.message}`);
    }
    svc.scheduler.reload();
    return redirect(c, `/connections/${id}`, "Connection added. Run it once to discover accounts, then map them below.");
  });

  app.get("/connections/:id", async (c) => {
    const conn = store.connection(c.req.param("id"));
    if (!conn) return c.notFound();
    const settings = store.settings();
    let sureAccounts: SureAccount[] = [];
    let sureError: string | undefined;
    if (!settings.sureUrl) sureError = "Sure URL not set in Settings";
    else {
      try {
        sureAccounts = await sureClient(conn.userId, 8_000).listAccounts();
      } catch (e) {
        if (!(e instanceof SureError)) throw e;
        sureError = e.message;
      }
    }
    return page(
      c,
      <ConnectionPage
        conn={conn}
        provider={PROVIDERS[conn.provider]}
        users={store.users()}
        accounts={store.bankAccounts(conn.id)}
        sureAccounts={sureAccounts}
        sureError={sureError}
        runs={runs.page(conn.id, runsPage(c))}
        running={svc.runner.isRunning(conn.id)}
        settings={settings}
        msg={msgOf(c)}
      />,
    );
  });

  app.post("/connections/:id", async (c) => {
    const conn = store.connection(c.req.param("id"));
    if (!conn) return c.notFound();
    const b = await c.req.parseBody();
    try {
      store.saveConnection(conn.id, connectionInput(b, conn.provider));
    } catch (e) {
      if (e instanceof ValidationError) return redirect(c, `/connections/${conn.id}`, `Error: ${e.message}`);
      throw e;
    }
    svc.scheduler.reload();
    return redirect(c, `/connections/${conn.id}`, "Saved");
  });

  app.post("/connections/:id/accounts", async (c) => {
    const id = c.req.param("id");
    if (!store.connection(id)) return c.notFound();
    const b = await c.req.parseBody();
    for (const a of store.bankAccounts(id)) {
      const choice = str(b, `map_${a.bankAccountId}`);
      if (choice === "__ignore__") store.setMapping(id, a.bankAccountId, null, true);
      else store.setMapping(id, a.bankAccountId, choice || null, false);
    }
    return redirect(c, `/connections/${id}`, "Account mapping saved. Run again to import the skipped transactions.");
  });

  app.post("/connections/:id/delete", async (c) => {
    const id = c.req.param("id");
    if (svc.runner.isRunning(id)) return redirect(c, `/connections/${id}`, "Error: wait for the current run to finish");
    store.deleteConnection(id);
    await removeProfile(id);
    svc.scheduler.reload();
    return redirect(c, "/", `Deleted ${id}`);
  });

  app.post("/connections/:id/run", async (c) => {
    const id = c.req.param("id");
    if (!store.connection(id)) return c.notFound();
    const b = await c.req.parseBody();
    svc.runner.startBackground(id, {
      dryRun: b.dryRun === "1" || undefined,
      discover: b.discover === "1" || undefined,
      debug: b.debug === "1" || undefined,
    });
    const back = c.req.header("referer");
    let path = "/";
    try {
      if (back) path = new URL(back).pathname;
    } catch {}
    return c.redirect(path, 303);
  });

  app.post("/connections/:id/cancel", (c) => {
    const id = c.req.param("id");
    if (!store.connection(id)) return c.notFound();
    const ok = svc.runner.cancel(id);
    return redirect(c, `/connections/${id}#runs`, ok ? `Cancelled the run of ${id}` : `${id} isn't running`);
  });

  // Train (debug tools only): record a person's steps as a named recipe.
  app.post("/connections/:id/train", async (c) => {
    const id = c.req.param("id");
    if (!store.connection(id)) return c.notFound();
    if (!DEBUG_TOOLS) return redirect(c, `/connections/${id}`, "Error: Train needs SURE_SYNC_DEBUG=1");
    const b = await c.req.parseBody();
    const recipe = (str(b, "recipe") || str(b, "recipeOther")).toLowerCase().replace(/\s+/g, "-");
    if (!RECIPE_RE.test(recipe)) return redirect(c, `/connections/${id}`, "Error: recipe name: letters, numbers and dashes only");
    if (svc.runner.isRunning(id)) return redirect(c, `/connections/${id}`, "Error: wait for the current run to finish");
    svc.runner.startBackground(id, { train: { recipe, login: b.login === "1" } });
    return c.redirect(`/connections/${id}/remote`, 303);
  });

  // --- remote browser view (a person solves a CAPTCHA etc.) ----------------
  app.get("/connections/:id/remote", (c) => {
    const id = c.req.param("id");
    if (!store.connection(id)) return c.notFound();
    const session = svc.runner.remote.get(id);
    return page(
      c,
      <RemotePage connectionId={id} prompt={session?.prompt} doneLabel={session?.doneLabel} starting={!session && svc.runner.isRunning(id)} />,
    );
  });

  app.get("/connections/:id/remote/stream", (c) => {
    const session = svc.runner.remote.get(c.req.param("id"));
    return streamSSE(c, async (stream) => {
      if (!session) {
        await stream.writeSSE({ event: "end", data: "" });
        return;
      }
      let done = false;
      let wake: () => void = () => {};
      let pending: { data: string; width: number; height: number } | undefined;
      const unsubscribe = session.subscribe(
        (f) => {
          pending = f;
          wake();
        },
        () => {
          done = true;
          wake();
        },
      );
      stream.onAbort(() => {
        done = true;
        wake();
      });
      try {
        // Send only the newest frame; a slow client skips frames instead of queueing them.
        while (!done || pending) {
          if (pending) {
            const f = pending;
            pending = undefined;
            await stream.writeSSE({ event: "frame", data: JSON.stringify(f) });
            continue;
          }
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 15_000); // keep-alive
          });
          if (!done && !pending) await stream.writeSSE({ event: "ping", data: "" });
        }
        if (session.ended) await stream.writeSSE({ event: "end", data: "" });
      } finally {
        unsubscribe();
      }
    });
  });

  app.post("/connections/:id/remote/input", async (c) => {
    const session = svc.runner.remote.get(c.req.param("id"));
    if (!session) return c.json({ error: "no_session" }, 404);
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    try {
      if (b?.type === "click" || b?.type === "move" || b?.type === "down" || b?.type === "up") {
        await session.input({ type: b.type, x: num(b.x), y: num(b.y) });
      }
      else if (b?.type === "wheel") {
        await session.input({ type: "wheel", x: num(b.x), y: num(b.y), dx: num(b.dx), dy: num(b.dy) });
      } else if (b?.type === "key" && typeof b.key === "string" && b.key.length <= 20) {
        await session.input({ type: "key", key: b.key });
      } else if (b?.type === "text" && typeof b.text === "string" && b.text.length > 0 && b.text.length <= 2000) {
        await session.input({ type: "text", text: b.text });
      } else return c.json({ error: "bad_input" }, 400);
    } catch (e) {
      return c.json({ error: (e as Error).message.split("\n")[0] }, 409);
    }
    return c.json({ ok: true });
  });

  // Logs panel in the browser view: run log + the bank page's console and network.
  app.get("/connections/:id/remote/logs", (c) => {
    const id = c.req.param("id");
    const live = svc.runner.liveBrowserLog(id);
    const run = live?.runId ? runs.get(live.runId) : undefined;
    return c.json({
      run: run ? run.log.split("\n").slice(-300).join("\n") : "",
      console: live?.console ?? [],
      network: live?.network ?? [],
    });
  });

  app.post("/connections/:id/remote/done", (c) => {
    const id = c.req.param("id");
    if (svc.mfa.get(id)?.kind === "browser") svc.mfa.submit(id, "done");
    return redirect(c, `/connections/${id}`, "Run continued");
  });

  app.post("/connections/:id/mfa", async (c) => {
    const b = await c.req.parseBody();
    svc.mfa.submit(c.req.param("id"), str(b, "code"));
    return redirect(c, "/");
  });

  // --- logs -----------------------------------------------------------------
  const LEVEL_RANK: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
  function logEntries(c: Context): { entries: LogEntry[]; level: string; q: string } {
    const level = ["debug", "info", "warn", "error"].includes(c.req.query("level") ?? "") ? c.req.query("level")! : "debug";
    const q = (c.req.query("q") ?? "").trim();
    const minRank = LEVEL_RANK[level.toUpperCase()] ?? 0;
    const needle = q.toLowerCase();
    const entries = tailLog(5000)
      .map((text) => ({ text, level: /^\S+ (\w+)/.exec(text)?.[1] ?? "INFO" }))
      .filter((e) => (LEVEL_RANK[e.level] ?? 1) >= minRank && (!needle || e.text.toLowerCase().includes(needle)))
      .slice(-1000);
    return { entries, level, q };
  }

  app.get("/logs", (c) =>
    page(c, <LogsPage {...logEntries(c)} maxMb={((svc.logMaxBytes ?? 0) / 1_000_000).toFixed(1)} />),
  );
  app.get("/partials/logs", (c) => c.html(<LogLines entries={logEntries(c).entries} />));

  // --- runs -----------------------------------------------------------------
  app.get("/runs/:id{[0-9]+}", async (c) => {
    const run = runs.get(Number(c.req.param("id")));
    if (!run) return c.notFound();
    const files = await readdir(join(svc.dataDir, "debug", `run-${run.id}`)).catch(() => [] as string[]);
    const logs = ["console.txt", "network.txt"].filter((f) => files.includes(f));
    const recordings: Recording[] = [];
    for (const f of files.filter((f) => /^recipe-.+\.json$/.test(f)).sort()) {
      const text = await readFile(join(svc.dataDir, "debug", `run-${run.id}`, f), "utf8").catch(() => "");
      try {
        recordings.push(JSON.parse(text) as Recording);
      } catch {}
    }
    const shots = files.filter((f) => f.endsWith(".png") && !f.startsWith("train-")).sort();
    return page(c, <RunPage run={run} shots={shots} logs={logs} recordings={recordings} msg={msgOf(c)} />);
  });

  // Live run page: log lines after `from`, status and counts.
  app.get("/api/runs/:id{[0-9]+}", (c) => {
    const run = runs.get(Number(c.req.param("id")));
    if (!run) return c.json({ error: "not_found" }, 404);
    const from = Math.max(0, Number(c.req.query("from")) || 0);
    const needs = svc.mfa.get(run.connectionId);
    return c.json({
      status: run.status,
      finished: run.status !== "running" && run.status !== "awaiting_mfa",
      log: run.log.slice(from),
      logLength: run.log.length,
      stats: runStats(run),
      needs: needs && needs.runId === run.id ? { kind: needs.kind, prompt: needs.prompt } : null,
    });
  });

  app.get("/runs/:id{[0-9]+}/debug/:name", async (c) => {
    const dir = resolve(svc.dataDir, "debug", `run-${c.req.param("id")}`);
    const path = resolve(dir, c.req.param("name"));
    if (!path.startsWith(dir + "/")) return c.notFound();
    const data = await readFile(path).catch(() => null);
    if (!data) return c.notFound();
    // Captured bank pages must never execute in this origin: serve HTML as text.
    const type = path.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8";
    return c.body(data, 200, { "Content-Type": type, "X-Content-Type-Options": "nosniff" });
  });

  app.onError((e, c) => {
    log.error(`${c.req.method} ${c.req.path} failed`, e);
    return c.text(`Internal error: ${e.message}`, 500);
  });

  return app;
}
