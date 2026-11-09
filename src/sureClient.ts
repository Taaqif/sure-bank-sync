/** Minimal client for the Sure REST API (/api/v1). */
import { formatCents, type IdentifiedTransaction } from "./models.js";

export class SureError extends Error {}

export interface SureAccount {
  id: string;
  name: string;
  currency?: string;
  classification?: string;
  account_type?: string;
}

export class SureClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly source: string,
    private readonly timeoutMs = 30_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          "X-Api-Key": this.apiKey,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new SureError(`${method} ${path}: ${describe(e)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new SureError(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  async listAccounts(): Promise<SureAccount[]> {
    const data = await this.request<{ accounts?: SureAccount[] } | SureAccount[]>("GET", "/accounts?per_page=100");
    return Array.isArray(data) ? data : (data.accounts ?? []);
  }

  /**
   * Create a transaction. Idempotent: Sure returns the existing entry (HTTP 200)
   * when external_id + source already exist on the account.
   */
  async createTransaction(sureAccountId: string, txn: IdentifiedTransaction): Promise<{ id?: string } | null> {
    return this.request("POST", "/transactions", {
      transaction: {
        account_id: sureAccountId,
        date: txn.date,
        amount: formatCents(Math.abs(txn.amountCents)),
        name: txn.description.slice(0, 255),
        currency: txn.account.currency,
        nature: txn.amountCents > 0 ? "income" : "expense",
        external_id: txn.externalId,
        source: this.source,
      },
    });
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return cause instanceof Error ? `${e.message} (${cause.message})` : e.message;
  }
  return String(e);
}
