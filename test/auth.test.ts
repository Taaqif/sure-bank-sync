import { createServer, type Server } from "node:http";
import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthConfigError, OidcClient, OidcDenied, authFromEnv, authWarnings, checkClaims, type OidcSettings } from "../src/web/auth.js";
import { makeApp, setup } from "./helpers.js";

const base: OidcSettings = {
  issuer: "https://id.example",
  clientId: "c",
  scopes: "openid email",
  name: "Pocket ID",
  allowedEmails: [],
  allowedGroups: [],
  groupsClaim: "groups",
};

describe("auth config from env", () => {
  it("picks a mode from what's set", () => {
    expect(authFromEnv({}).mode).toBe("none");
    expect(authFromEnv({ SURE_SYNC_ADMIN_PASSWORD: "x" }).mode).toBe("password");
    expect(authFromEnv({ SURE_SYNC_OIDC_ISSUER: "https://id.example", SURE_SYNC_OIDC_CLIENT_ID: "c" }).mode).toBe("oidc");
    expect(authFromEnv({ SURE_SYNC_AUTH: "none", SURE_SYNC_ADMIN_PASSWORD: "x" }).mode).toBe("none");
  });

  it("rejects incomplete or unknown settings", () => {
    expect(() => authFromEnv({ SURE_SYNC_AUTH: "password" })).toThrow(AuthConfigError);
    expect(() => authFromEnv({ SURE_SYNC_AUTH: "oidc", SURE_SYNC_OIDC_ISSUER: "https://id.example" })).toThrow(/CLIENT_ID/);
    expect(() => authFromEnv({ SURE_SYNC_AUTH: "ldap" })).toThrow(/password, oidc or none/);
    expect(() => authFromEnv({ SURE_SYNC_PUBLIC_URL: "https://x.example/app" })).toThrow(/no path/);
  });

  it("reads OIDC options and adds the groups scope when groups are required", () => {
    const cfg = authFromEnv({
      SURE_SYNC_OIDC_ISSUER: "https://id.example",
      SURE_SYNC_OIDC_CLIENT_ID: "c",
      SURE_SYNC_OIDC_ALLOWED_EMAILS: "Alice@Example.com, bob@example.com",
      SURE_SYNC_OIDC_ALLOWED_GROUPS: "finance",
      SURE_SYNC_TRUST_PROXY: "true",
      SURE_SYNC_PUBLIC_URL: "https://sync.example.com/",
    });
    expect(cfg.oidc).toMatchObject({ allowedEmails: ["alice@example.com", "bob@example.com"], allowedGroups: ["finance"], scopes: "openid email profile groups" });
    expect(cfg.trustProxy).toBe(true);
    expect(cfg.publicUrl).toBe("https://sync.example.com");
  });

  it("warns about open setups", () => {
    expect(authWarnings(authFromEnv({})).join()).toMatch(/NO login/);
    expect(authWarnings(authFromEnv({ SURE_SYNC_OIDC_ISSUER: "https://id.example", SURE_SYNC_OIDC_CLIENT_ID: "c" })).join()).toMatch(/every user/);
  });
});

describe("who may sign in with OIDC", () => {
  it("allows anyone when no list is set", () => {
    expect(checkClaims(base, { sub: "1", email: "A@x.com" })).toBe("a@x.com");
  });
  it("checks verified emails and groups", () => {
    const s = { ...base, allowedEmails: ["a@x.com"], allowedGroups: ["finance"] };
    expect(checkClaims(s, { sub: "1", email: "a@x.com", email_verified: true })).toBe("a@x.com");
    expect(() => checkClaims(s, { sub: "1", email: "a@x.com", email_verified: false })).toThrow(OidcDenied);
    expect(checkClaims(s, { sub: "2", email: "b@x.com", groups: ["finance"] })).toBe("b@x.com");
    expect(() => checkClaims(s, { sub: "3", email: "c@x.com", groups: ["kids"] })).toThrow(/isn't allowed/);
    expect(() => checkClaims({ ...base, allowedGroups: ["finance"] }, { sub: "4", email: "d@x.com" })).toThrow(/no "groups" claim/);
  });
});

describe("web login modes", () => {
  it("needs no login in none mode and has no Log out", async () => {
    const { app } = makeApp(setup(), { auth: { mode: "none", trustProxy: false } });
    const r = await app.request("/");
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain("Log out");
    expect((await app.request("/login")).headers.get("location")).toBe("/");
  });

  it("limits failed logins per client address behind a trusted proxy", async () => {
    const { app } = makeApp(setup(), { auth: { mode: "password", trustProxy: true, admin: { user: "admin", password: "s3cret" } } });
    const post = (ip: string, password: string) =>
      app.request("/login", {
        method: "POST",
        body: new URLSearchParams({ username: "admin", password }),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Host: "localhost", "X-Forwarded-For": `6.6.6.6, ${ip}` },
      });
    for (let i = 0; i < 10; i++) await post("203.0.113.9", "x");
    expect((await post("203.0.113.9", "s3cret")).status).toBe(429);
    // someone else behind the same proxy isn't locked out
    expect((await post("198.51.100.7", "s3cret")).status).toBe(303);
  }, 20_000);
});

/** A tiny OpenID provider: discovery, JWKS, authorize (auto-approves) and token with PKCE. */
function fakeProvider(claims: Record<string, unknown>) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; challenge: string; clientId: string }>();
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  let issuer = "";
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (o: unknown) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(o));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/jwks") return json({ keys: [jwk] });
    if (url.pathname === "/authorize") {
      const code = randomUUID();
      codes.set(code, { nonce: url.searchParams.get("nonce")!, challenge: url.searchParams.get("code_challenge")!, clientId: url.searchParams.get("client_id")! });
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state")!);
      back.searchParams.set("iss", issuer);
      res.writeHead(302, { Location: back.href });
      return res.end();
    }
    if (url.pathname === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const p = new URLSearchParams(body);
      const entry = codes.get(p.get("code")!);
      const challenge = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
      if (!entry || challenge !== entry.challenge) {
        res.statusCode = 400;
        return json({ error: "invalid_grant" });
      }
      const now = Math.floor(Date.now() / 1000);
      const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
      const payload = b64({ iss: issuer, aud: entry.clientId, sub: "user-1", iat: now, exp: now + 300, nonce: entry.nonce, ...claims });
      const sig = createSign("RSA-SHA256").update(`${head}.${payload}`).sign(privateKey).toString("base64url");
      return json({ access_token: "at", token_type: "Bearer", expires_in: 300, id_token: `${head}.${payload}.${sig}` });
    }
    res.statusCode = 404;
    res.end();
  });
  return {
    server,
    async start() {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return issuer;
    },
  };
}

describe("OIDC sign-in end to end", () => {
  const provider = fakeProvider({ email: "alice@example.com", email_verified: true, groups: ["finance"] });
  let issuer = "";
  beforeAll(async () => {
    issuer = await provider.start();
  });
  afterAll(() => provider.server.close());

  async function signIn(settings: Partial<OidcSettings>) {
    const oidc = { ...base, issuer, clientId: "sure-bank-sync", ...settings };
    const { app } = makeApp(setup(), {
      auth: { mode: "oidc", trustProxy: false, publicUrl: "http://localhost", oidc },
      oidc: new OidcClient(oidc),
    });
    // login page shows the provider button
    expect(await (await app.request("/login")).text()).toContain("Sign in with Pocket ID");
    const start = await app.request("/auth/oidc/start?next=/settings");
    expect(start.status).toBe(302);
    const pendingCookie = start.headers.get("set-cookie")!.split(";")[0]!;
    // the browser goes to the provider, which sends it back
    const back = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const callback = new URL(back.headers.get("location")!);
    const done = await app.request(`/auth/oidc/callback${callback.search}`, { headers: { Cookie: pendingCookie } });
    return { app, done };
  }

  it("signs in, lands on the page asked for and shows who is signed in", async () => {
    const { app, done } = await signIn({ allowedGroups: ["finance"] });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/settings");
    const session = done.headers.get("set-cookie")!.match(/sbs_session=[^;]+/)![0];
    const page = await (await app.request("/settings", { headers: { Cookie: session } })).text();
    expect(page).toContain("alice@example.com");
    // logging out lands on the sign-in page, not straight back in
    const out = await app.request("/logout", { method: "POST", headers: { Cookie: session, Host: "localhost" } });
    expect(out.headers.get("location")).toBe("/login?loggedOut=1");
  });

  it("refuses users outside the allowed list", async () => {
    const { done } = await signIn({ allowedEmails: ["bob@example.com"] });
    expect(done.status).toBe(403);
    expect(await done.text()).toContain("allowed to use this app");
  });

  it("refuses a callback without the sign-in cookie", async () => {
    const oidc = { ...base, issuer, clientId: "sure-bank-sync" };
    const { app } = makeApp(setup(), { auth: { mode: "oidc", trustProxy: false, publicUrl: "http://localhost", oidc }, oidc: new OidcClient(oidc) });
    const r = await app.request("/auth/oidc/callback?code=x&state=y");
    expect(r.status).toBe(401);
    expect(await r.text()).toContain("Try again");
  });
});
