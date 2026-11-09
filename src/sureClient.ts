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
   * Create a CSV transaction import into one account and ask Sure to publish it.
   * Sure matches existing entries on date + amount + currency + name and
   * updates them instead of duplicating.
   */
  async createTransactionImport(sureAccountId: string, csv: string): Promise<SureImport> {
    const res = await this.request<{ data: SureImport }>("POST", "/imports", {
      type: "TransactionImport",
      account_id: sureAccountId,
      raw_file_content: csv,
      col_sep: ",",
      date_col_label: "date",
      amount_col_label: "amount",
      name_col_label: "name",
      date_format: "%Y-%m-%d",
      number_format: "1,234.56",
      amount_type_strategy: "signed_amount",
      signage_convention: "inflows_positive",
      publish: "true",
    });
    return res.data;
  }

  async getImport(id: string): Promise<SureImport> {
    return (await this.request<{ data: SureImport }>("GET", `/imports/${encodeURIComponent(id)}`)).data;
  }
}

export interface SureImport {
  id: string;
  status: string;
  error?: string;
  stats?: { rows_count?: number; valid_rows_count?: number; invalid_rows_count?: number };
}

/** Rows -> CSV for a Sure TransactionImport: date (YYYY-MM-DD), signed amount (inflows positive), name. */
export function toImportCsv(txns: IdentifiedTransaction[]): string {
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = txns.map((t) => [t.date, formatCents(t.amountCents), q(t.description.slice(0, 255))].join(","));
  return ["date,amount,name", ...lines].join("\n") + "\n";
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return cause instanceof Error ? `${e.message} (${cause.message})` : e.message;
  }
  return String(e);
}
