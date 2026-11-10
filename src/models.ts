import { createHash } from "node:crypto";

/** An account as the bank presents it. */
export interface BankAccount {
  /** bank's own identifier (account number, card suffix, ...) */
  id: string;
  name: string;
  currency: string;
}

/** A transaction scraped from a bank. */
export interface BankTransaction {
  account: BankAccount;
  /** YYYY-MM-DD in the bank's local time */
  date: string;
  /** integer cents, bank convention: negative = money out, positive = money in */
  amountCents: number;
  description: string;
  /** stable id from the bank, if it provides one */
  bankId?: string;
  pending?: boolean;
  raw?: Record<string, string>;
  /**
   * Set by brokers: this row is a trade or cash movement in an investment
   * account and goes to Sure as a trade, not a CSV transaction import.
   * amountCents still follows the bank convention (a buy is money out).
   */
  investment?: InvestmentActivity;
}

export type InvestmentKind = "buy" | "sell" | "dividend" | "deposit" | "withdrawal" | "interest" | "fee";

export interface InvestmentActivity {
  kind: InvestmentKind;
  /** e.g. "CBA"; required for buy, sell and dividend */
  ticker?: string;
  /** exchange MIC so Sure finds the right listing, e.g. "XASX" */
  exchange?: string;
  /** units, buy/sell only (decimal string, always positive) */
  qty?: string;
  /** price per unit, buy/sell only (decimal string) */
  price?: string;
  /** brokerage, buy/sell only, integer cents */
  feeCents?: number;
}

/** A statement document downloaded from a bank (e.g. a monthly PDF). */
export interface BankStatement {
  account: BankAccount;
  /** YYYY-MM-DD the statement was issued (some banks show nothing else) */
  date: string;
  /** YYYY-MM-DD period covered, when the bank shows it */
  periodStart?: string;
  periodEnd?: string;
  fileName: string;
  /** e.g. "application/pdf" */
  contentType: string;
  /** file contents (downloads are removed with the browser, so read them in) */
  data: Buffer;
}

export interface IdentifiedTransaction extends BankTransaction {
  externalId: string;
}

/**
 * Give every transaction a stable id for idempotent upload.
 *
 * Uses the bank's id when present. Otherwise hashes the content plus an
 * occurrence counter, so two identical same-day purchases stay distinct.
 * Identical transactions are interchangeable, so input order doesn't matter.
 */
export function assignExternalIds(txns: BankTransaction[]): IdentifiedTransaction[] {
  const seen = new Map<string, number>();
  return txns.map((t) => {
    if (t.bankId) return { ...t, externalId: `${t.account.id}:${t.bankId}` };
    const desc = t.description.trim().split(/\s+/).join(" ").toLowerCase();
    const base = [t.account.id, t.date, formatCents(t.amountCents), desc].join("|");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const digest = createHash("sha256").update(`${base}|${n}`).digest("hex").slice(0, 24);
    return { ...t, externalId: `${t.account.id}:h${digest}` };
  });
}

/** -450 -> "-4.50" */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** "-1,234.56" / "$12.30" / "(4.50)" -> integer cents. Throws on junk. */
export function parseAmount(text: string): number {
  let s = text.trim().replace(/[$,\s]|AUD/gi, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`cannot parse amount ${JSON.stringify(text)}`);
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  return negative ? -cents : cents;
}

/**
 * Account number for logs: last 4 digits only ("012345 987654321" -> "••4321").
 * Ids without digits (e.g. "amex") are returned as-is.
 */
export function maskAccountId(id: string): string {
  const digits = id.replace(/\D/g, "");
  return digits.length > 4 ? `••${digits.slice(-4)}` : id;
}
