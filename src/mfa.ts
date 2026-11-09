/** Hand-off for one-time codes: a scraper waits, a human types it into the web UI. */

export class MfaTimeout extends Error {}
export class MfaCancelled extends Error {}
/** A person pressed Retry in the browser view: start the login again. */
export class RetryLogin extends Error {}

/** What the browser view's Retry button submits. */
export const RETRY = "\u0000retry";

export interface MfaRequest {
  connectionId: string;
  runId: number;
  prompt: string;
  /** "code": type a code; "browser": do something in the remote browser view */
  kind: "code" | "browser";
  createdAt: Date;
}

interface Pending extends MfaRequest {
  resolve: (code: string) => void;
  reject: (e: Error) => void;
}

export class MfaBroker {
  readonly #pending = new Map<string, Pending>();

  get(connectionId: string): MfaRequest | undefined {
    return this.#pending.get(connectionId);
  }

  pending(): MfaRequest[] {
    return [...this.#pending.values()];
  }

  request(connectionId: string, runId: number, prompt: string, timeoutMs: number, kind: MfaRequest["kind"] = "code"): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(connectionId);
        reject(new MfaTimeout(`no MFA code entered within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.#pending.set(connectionId, {
        connectionId,
        runId,
        prompt,
        kind,
        createdAt: new Date(),
        resolve: (code) => {
          clearTimeout(timer);
          this.#pending.delete(connectionId);
          resolve(code);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.#pending.delete(connectionId);
          reject(e);
        },
      });
    });
  }

  submit(connectionId: string, code: string): boolean {
    const p = this.#pending.get(connectionId);
    if (!p) return false;
    p.resolve(code.trim());
    return true;
  }

  /** Drop a pending prompt; the waiting run gets MfaCancelled. */
  cancel(connectionId: string): void {
    this.#pending.get(connectionId)?.reject(new MfaCancelled("cancelled"));
  }
}
