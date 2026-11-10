/**
 * Time-based one-time codes (RFC 6238), as made by authenticator apps, so a
 * login can type its own 2FA code from the stored secret.
 */
import { createHmac } from "node:crypto";

export interface TotpSecret {
  key: Buffer;
  digits: number;
  period: number;
  algorithm: "sha1" | "sha256" | "sha512";
}

/**
 * Accepts the base32 secret shown under a setup QR code ("JBSW Y3DP ...",
 * spaces and case ignored) or the whole otpauth://totp/... link.
 * Throws a readable error for anything else.
 */
export function parseTotpSecret(input: string): TotpSecret {
  const text = input.trim();
  let secret = text;
  let digits = 6;
  let period = 30;
  let algorithm: TotpSecret["algorithm"] = "sha1";
  if (/^otpauth:/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error("the 2FA link isn't a valid otpauth:// link");
    }
    secret = url.searchParams.get("secret") ?? "";
    digits = Number(url.searchParams.get("digits") ?? 6);
    period = Number(url.searchParams.get("period") ?? 30);
    const alg = (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
    if (alg !== "sha1" && alg !== "sha256" && alg !== "sha512") throw new Error(`unsupported 2FA algorithm ${alg}`);
    algorithm = alg;
  }
  if (![6, 7, 8].includes(digits) || !(period > 0)) throw new Error("the 2FA link has odd digits/period settings");
  const key = base32Decode(secret);
  if (key.length < 10) throw new Error("the 2FA secret looks too short; paste the setup key or otpauth:// link");
  return { key, digits, period, algorithm };
}

/** The code for `at` (default now). */
export function totp(secret: TotpSecret, at = Date.now()): string {
  const counter = Math.floor(at / 1000 / secret.period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(secret.algorithm, secret.key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** secret.digits).padStart(secret.digits, "0");
}

/** Seconds until the current code changes. */
export function totpSecondsLeft(secret: TotpSecret, at = Date.now()): number {
  return secret.period - (Math.floor(at / 1000) % secret.period);
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error("the 2FA secret isn't valid base32 (letters A-Z and digits 2-7)");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
