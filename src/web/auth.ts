/**
 * Web UI authentication, configured only through environment variables.
 *
 * SURE_SYNC_AUTH picks the mode:
 *   password  one admin login (SURE_SYNC_ADMIN_USER / SURE_SYNC_ADMIN_PASSWORD)
 *   oidc      sign in with an OpenID Connect provider (Pocket ID, Authelia,
 *             Authentik, Keycloak, Zitadel, Google, Microsoft Entra, ...)
 *   none      no login (only behind a proxy that already authenticates, or
 *             on a trusted network)
 * Unset: password when SURE_SYNC_ADMIN_PASSWORD is set, else oidc when
 * SURE_SYNC_OIDC_ISSUER is set, else none (with a loud warning).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import * as oidc from "openid-client";

export type AuthMode = "password" | "oidc" | "none";

export interface OidcSettings {
  issuer: string;
  clientId: string;
  /** empty: public client (PKCE only) */
  clientSecret?: string;
  scopes: string;
  /** shown on the sign-in button */
  name: string;
  /** lower-cased; empty = any */
  allowedEmails: string[];
  /** empty = any */
  allowedGroups: string[];
  groupsClaim: string;
}

export interface AuthConfig {
  mode: AuthMode;
  /** password mode */
  admin?: { user: string; password: string };
  oidc?: OidcSettings;
  /** trust X-Forwarded-For / -Proto / -Host from a reverse proxy */
  trustProxy: boolean;
  /** external URL, e.g. https://sync.example.com (used for OIDC redirects) */
  publicUrl?: string;
}

export class AuthConfigError extends Error {}

const list = (v: string | undefined) =>
  (v ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test((v ?? "").trim());

/** Read auth settings from the environment. Throws AuthConfigError on a bad combination. */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const password = env.SURE_SYNC_ADMIN_PASSWORD || undefined;
  const issuer = env.SURE_SYNC_OIDC_ISSUER?.trim() || undefined;
  const requested = (env.SURE_SYNC_AUTH ?? "").trim().toLowerCase();
  if (requested && !["password", "oidc", "none"].includes(requested)) {
    throw new AuthConfigError(`SURE_SYNC_AUTH must be password, oidc or none (got ${JSON.stringify(requested)})`);
  }
  const mode = (requested || (password ? "password" : issuer ? "oidc" : "none")) as AuthMode;
  const publicUrl = env.SURE_SYNC_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined;
  if (publicUrl && !/^https?:\/\/[^/]+$/i.test(publicUrl)) {
    throw new AuthConfigError("SURE_SYNC_PUBLIC_URL must be like https://sync.example.com (no path)");
  }
  const cfg: AuthConfig = { mode, trustProxy: truthy(env.SURE_SYNC_TRUST_PROXY), publicUrl };

  if (mode === "password") {
    if (!password) throw new AuthConfigError("SURE_SYNC_AUTH=password needs SURE_SYNC_ADMIN_PASSWORD");
    cfg.admin = { user: env.SURE_SYNC_ADMIN_USER || "admin", password };
  }
  if (mode === "oidc") {
    const clientId = env.SURE_SYNC_OIDC_CLIENT_ID?.trim();
    if (!issuer || !clientId) {
      throw new AuthConfigError("SURE_SYNC_AUTH=oidc needs SURE_SYNC_OIDC_ISSUER and SURE_SYNC_OIDC_CLIENT_ID");
    }
    if (!/^https?:\/\//i.test(issuer)) throw new AuthConfigError("SURE_SYNC_OIDC_ISSUER must be a URL");
    const allowedGroups = list(env.SURE_SYNC_OIDC_ALLOWED_GROUPS);
    const scopes = list(env.SURE_SYNC_OIDC_SCOPES).length
      ? list(env.SURE_SYNC_OIDC_SCOPES)
      : ["openid", "email", "profile", ...(allowedGroups.length ? ["groups"] : [])];
    if (!scopes.includes("openid")) scopes.unshift("openid");
    cfg.oidc = {
      issuer,
      clientId,
      clientSecret: env.SURE_SYNC_OIDC_CLIENT_SECRET || undefined,
      scopes: scopes.join(" "),
      name: env.SURE_SYNC_OIDC_NAME?.trim() || "single sign-on",
      allowedEmails: list(env.SURE_SYNC_OIDC_ALLOWED_EMAILS).map((e) => e.toLowerCase()),
      allowedGroups,
      groupsClaim: env.SURE_SYNC_OIDC_GROUPS_CLAIM?.trim() || "groups",
    };
  }
  return cfg;
}

/** Startup warnings worth logging for this config. */
export function authWarnings(cfg: AuthConfig): string[] {
  const w: string[] = [];
  if (cfg.mode === "none") {
    w.push(
      "web UI has NO login (SURE_SYNC_AUTH=none or nothing configured). Anyone who can reach it can change bank logins. " +
        "Only run like this behind a proxy that authenticates, or on a network you trust.",
    );
  }
  if (cfg.mode === "oidc" && !cfg.oidc!.allowedEmails.length && !cfg.oidc!.allowedGroups.length) {
    w.push(
      "OIDC: every user of the identity provider can sign in. Set SURE_SYNC_OIDC_ALLOWED_EMAILS or SURE_SYNC_OIDC_ALLOWED_GROUPS to limit it.",
    );
  }
  if (cfg.mode === "oidc" && !cfg.publicUrl) {
    w.push("OIDC: SURE_SYNC_PUBLIC_URL is not set; the redirect URL is guessed from each request. Set it to your external URL.");
  }
  return w;
}

// --- sessions ----------------------------------------------------------------

export const SESSION_COOKIE = "sbs_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;

/**
 * What a session is bound to: changing it (new admin password, different
 * OIDC client) signs everyone out.
 */
export function sessionBinding(cfg: AuthConfig): string {
  if (cfg.mode === "password") return `password\0${cfg.admin!.user}\0${cfg.admin!.password}`;
  if (cfg.mode === "oidc") return `oidc\0${cfg.oidc!.issuer}\0${cfg.oidc!.clientId}`;
  return "none";
}

function mac(secret: string, binding: string, data: string): string {
  const key = createHmac("sha256", secret).update(`session\0${binding}`).digest();
  return createHmac("sha256", key).update(data).digest("base64url");
}

/** Cookie value "<expires>.<user, base64url>.<hmac>". */
export function createSession(
  secret: string,
  binding: string,
  user: string,
  now = Date.now(),
  ttlSeconds = SESSION_TTL_SECONDS,
): string {
  const expires = Math.floor(now / 1000) + ttlSeconds;
  const data = `${expires}.${Buffer.from(user).toString("base64url")}`;
  return `${data}.${mac(secret, binding, data)}`;
}

/** The signed-in user, or null for a missing, forged or expired cookie. */
export function verifySession(token: string | undefined, secret: string, binding: string, now = Date.now()): string | null {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3) return null;
  const [exp, user, sig] = parts as [string, string, string];
  const expires = Number(exp);
  if (!Number.isInteger(expires) || expires * 1000 < now) return null;
  const want = Buffer.from(mac(secret, binding, `${exp}.${user}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return Buffer.from(user, "base64url").toString();
}

/** Only allow redirects to local paths ("/x", not "//evil.com" or "https://..."). */
export function safeNext(next: string | undefined): string {
  return next && /^\/(?!\/)[^\s\\]*$/.test(next) ? next : "/";
}

/** Simple in-memory failed-login limiter per client key. */
export class LoginLimiter {
  readonly #fails = new Map<string, number[]>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    const recent = (this.#fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.#fails.set(key, recent);
    return recent.length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    this.#fails.set(key, [...(this.#fails.get(key) ?? []), now]);
  }

  reset(key: string): void {
    this.#fails.delete(key);
  }
}

// --- OIDC ----------------------------------------------------------------------

/** Short-lived state between "Sign in" and the provider's callback (kept in a signed cookie). */
export interface OidcPending {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
}

export const OIDC_COOKIE = "sbs_oidc";
export const OIDC_PENDING_SECONDS = 600;

export function sealPending(secret: string, p: OidcPending, now = Date.now()): string {
  return createSession(secret, "oidc-pending", JSON.stringify(p), now, OIDC_PENDING_SECONDS);
}

export function openPending(secret: string, token: string | undefined, now = Date.now()): OidcPending | null {
  const raw = verifySession(token, secret, "oidc-pending", now);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OidcPending;
  } catch {
    return null;
  }
}

export class OidcDenied extends Error {}

/** Decide whether the provider's user may use the app; returns the name to show. */
export function checkClaims(s: OidcSettings, claims: Record<string, unknown>): string {
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : undefined;
  const groupsRaw = claims[s.groupsClaim];
  const groups = Array.isArray(groupsRaw) ? groupsRaw.map(String) : typeof groupsRaw === "string" ? [groupsRaw] : [];
  const display =
    email ?? (typeof claims.preferred_username === "string" ? claims.preferred_username : undefined) ?? String(claims.sub);
  if (!s.allowedEmails.length && !s.allowedGroups.length) return display;
  if (email && claims.email_verified !== false && s.allowedEmails.includes(email)) return display;
  if (groups.some((g) => s.allowedGroups.includes(g))) return display;
  throw new OidcDenied(
    `${display} isn't allowed to use this app` +
      (s.allowedGroups.length && !groups.length ? ` (the provider sent no "${s.groupsClaim}" claim)` : ""),
  );
}

/** OIDC client: discovery is done on first use and cached (retried after a failure). */
export class OidcClient {
  #config?: Promise<oidc.Configuration>;

  constructor(readonly settings: OidcSettings) {}

  config(): Promise<oidc.Configuration> {
    if (!this.#config) {
      const s = this.settings;
      const url = new URL(s.issuer);
      // Lab setups sometimes run the provider over plain http.
      const options = url.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : undefined;
      this.#config = (
        s.clientSecret
          ? oidc.discovery(url, s.clientId, s.clientSecret, undefined, options)
          : oidc.discovery(url, s.clientId, undefined, oidc.None(), options)
      ).catch((e: unknown) => {
        this.#config = undefined;
        throw e;
      });
    }
    return this.#config;
  }

  /** Where to send the browser to sign in, and the state to keep until the callback. */
  async start(redirectUri: string, next: string): Promise<{ url: string; pending: OidcPending }> {
    const config = await this.config();
    const verifier = oidc.randomPKCECodeVerifier();
    const pending: OidcPending = { state: oidc.randomState(), nonce: oidc.randomNonce(), verifier, next };
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: this.settings.scopes,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state: pending.state,
      nonce: pending.nonce,
    });
    return { url: url.href, pending };
  }

  /** Finish sign-in from the callback URL; returns the user to show. Throws OidcDenied when not allowed. */
  async finish(callbackUrl: URL, pending: OidcPending): Promise<string> {
    const config = await this.config();
    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: pending.verifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
    let claims: Record<string, unknown> = { ...(tokens.claims() ?? {}) };
    // Some providers only put email/groups in userinfo.
    const missing = !claims.email || (this.settings.allowedGroups.length && !(this.settings.groupsClaim in claims));
    if (missing && tokens.access_token && config.serverMetadata().userinfo_endpoint) {
      const info = await oidc.fetchUserInfo(config, tokens.access_token, String(claims.sub)).catch(() => null);
      // ID token claims win; userinfo fills the gaps.
      if (info) claims = { ...info, ...claims };
    }
    return checkClaims(this.settings, claims);
  }
}
