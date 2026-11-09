/**
 * Stateless signed session cookies for the single admin login.
 *
 * Cookie value: "<expiresAtSeconds>.<hmac>". The HMAC key mixes in the admin
 * username + password, so changing the password signs everyone out.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "sbs_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;

function sign(secret: string, user: string, password: string, expires: number): string {
  const key = createHmac("sha256", secret).update(`session\0${user}\0${password}`).digest();
  return createHmac("sha256", key).update(String(expires)).digest("base64url");
}

export function createSession(secret: string, user: string, password: string, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  return `${expires}.${sign(secret, user, password, expires)}`;
}

export function verifySession(
  token: string | undefined,
  secret: string,
  user: string,
  password: string,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const [exp, mac] = token.split(".");
  const expires = Number(exp);
  if (!mac || !Number.isInteger(expires) || expires * 1000 < now) return false;
  const want = Buffer.from(sign(secret, user, password, expires));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
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
