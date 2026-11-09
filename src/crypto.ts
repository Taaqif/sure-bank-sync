/** Encrypts secrets (bank logins, Sure API keys) before they hit the database. AES-256-GCM. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class CryptoError extends Error {}

const PREFIX = "v1:";

export function generateKey(): string {
  return randomBytes(32).toString("base64");
}

export class Crypto {
  readonly #key: Buffer;

  constructor(key: string) {
    const buf = Buffer.from(key.trim(), "base64");
    if (buf.length !== 32) {
      throw new CryptoError(
        "SURE_SYNC_SECRET_KEY must be 32 bytes, base64 encoded. Generate one with: npx sure-bank-sync --generate-key",
      );
    }
    this.#key = buf;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  decrypt(token: string): string {
    if (!token.startsWith(PREFIX)) throw new CryptoError("unrecognised encrypted value");
    const raw = Buffer.from(token.slice(PREFIX.length), "base64");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      throw new CryptoError(
        "cannot decrypt stored secret: SURE_SYNC_SECRET_KEY differs from the one used to save it",
      );
    }
  }
}
