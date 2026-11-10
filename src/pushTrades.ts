/**
 * Send broker activity (buys, sells, dividends, deposits...) to Sure as
 * trades, one at a time, skipping anything already there.
 *
 * Sure trades have no external id to dedupe on, so two checks run first:
 * our own record of what was sent, then a look at the Sure account itself,
 * because people often enter some of these by hand. A hand-entered row may
 * use the trade date or the settlement date, so dates match within a few days.
 */
import { formatCents, type IdentifiedTransaction, type InvestmentKind } from "./models.js";
import type { RunStats, RunStore } from "./runs.js";
import { SureClient, SureError, type SureTradeInput } from "./sureClient.js";

/** How far apart (days) a hand-entered row's date may be from the broker's. */
export const DATE_SLACK_DAYS = 5;

const CASH_KINDS = new Set<InvestmentKind>(["deposit", "withdrawal", "dividend", "interest", "fee"]);

/** Something already in the Sure account that a broker row could be. */
export interface ExistingEntry {
  date: string;
  /** bank convention: negative = money out */
  amountCents: number;
  /** trades only */
  ticker?: string | null;
  qty?: number | null;
}

export async function pushInvestments(
  deps: { runs: RunStore; signal?: AbortSignal },
  sure: SureClient,
  connectionId: string,
  rows: [string, IdentifiedTransaction][],
  stats: RunStats,
  log: (msg: string) => void,
  opts: { dryRun: boolean; verbose: boolean },
): Promise<void> {
  const failures: string[] = [];
  const byAccount = new Map<string, IdentifiedTransaction[]>();
  for (const [accountId, t] of rows) byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), t]);

  for (const [accountId, txns] of byAccount) {
    deps.signal?.throwIfAborted();
    const dates = txns.map((t) => t.date).sort();
    const start = shiftDate(dates[0]!, -DATE_SLACK_DAYS);
    const end = shiftDate(dates.at(-1)!, DATE_SLACK_DAYS);
    let existing: ExistingEntry[];
    try {
      const [trades, cash] = await Promise.all([sure.listTrades(accountId, start, end), sure.listTransactions(accountId, start, end)]);
      existing = [...trades, ...cash];
    } catch (e) {
      if (!(e instanceof SureError)) throw e;
      // Without the check, hand-entered rows would be duplicated: don't send anything.
      log(`couldn't read what's already in Sure account ${accountId} (${e.message}); skipping its trades this run`);
      failures.push(`couldn't check Sure for existing trades (${e.message})`);
      continue;
    }

    const matched = matchExisting(txns, existing);
    if (matched.size) {
      log(`${matched.size} already in Sure (sent before or entered by hand); not adding them again`);
      stats.skipped += matched.size;
      if (!opts.dryRun) for (const t of matched) deps.runs.markSynced(connectionId, t.externalId, accountId, "sure:existing");
    }

    for (const t of txns) {
      if (matched.has(t)) continue;
      const body = toTradeInput(accountId, t);
      const what = describeActivity(t);
      if (opts.dryRun) {
        log(opts.verbose ? `[dry run] would add ${what}` : `[dry run] would add a ${t.investment!.kind} on ${t.date}`);
        stats.created++;
        continue;
      }
      deps.signal?.throwIfAborted();
      try {
        const created = await sure.createTrade(body);
        deps.runs.markSynced(connectionId, t.externalId, accountId, `trade:${created.id}`);
        stats.created++;
        log(opts.verbose ? `added ${what}` : `added a ${t.investment!.kind} on ${t.date}`);
      } catch (e) {
        if (!(e instanceof SureError)) throw e;
        if (/does not support trades|investment or crypto/i.test(e.message)) {
          throw new SureError(
            "The Sure account this is mapped to isn't an Investment account. Map it to an Investment account in Sure on the connection page.",
          );
        }
        log(`couldn't add ${what}: ${e.message}`);
        failures.push(`${t.date} ${t.investment!.kind} (${e.message})`);
      }
    }
  }
  // Whatever was added is recorded; fail the run so the rest gets noticed.
  if (failures.length) throw new SureError(`${failures.length} not sent to Sure: ${failures.join("; ")}`);
}

/**
 * Broker rows that are already in Sure. Buys and sells match a trade with the
 * same ticker and units; cash movements match anything with the same amount.
 * Dates may differ by up to DATE_SLACK_DAYS (closest wins), and each Sure
 * entry matches one row at most.
 */
export function matchExisting(rows: IdentifiedTransaction[], existing: ExistingEntry[]): Set<IdentifiedTransaction> {
  const found = new Set<IdentifiedTransaction>();
  const pool = [...existing];
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  for (const t of sorted) {
    const inv = t.investment!;
    let best = -1;
    let bestGap = Infinity;
    for (const [i, x] of pool.entries()) {
      const gap = Math.abs(dayNumber(x.date) - dayNumber(t.date));
      if (gap > DATE_SLACK_DAYS || gap >= bestGap) continue;
      const same = CASH_KINDS.has(inv.kind)
        ? x.amountCents === t.amountCents
        : x.ticker != null &&
          baseTicker(x.ticker) === baseTicker(inv.ticker ?? "") &&
          x.qty != null &&
          Math.abs(Math.abs(x.qty) - Number(inv.qty)) < 1e-6 &&
          Math.sign(x.qty) === (inv.kind === "sell" ? -1 : 1);
      if (same) {
        best = i;
        bestGap = gap;
      }
    }
    if (best >= 0) {
      pool.splice(best, 1);
      found.add(t);
    }
  }
  return found;
}

export function toTradeInput(accountId: string, t: IdentifiedTransaction): SureTradeInput {
  const inv = t.investment!;
  const ticker = inv.ticker ? (inv.exchange ? `${inv.ticker}|${inv.exchange}` : inv.ticker) : undefined;
  const base = { account_id: accountId, type: inv.kind, date: t.date, currency: t.account.currency };
  if (inv.kind === "buy" || inv.kind === "sell") {
    return { ...base, ticker, qty: inv.qty, price: inv.price, fee: formatCents(inv.feeCents ?? 0) };
  }
  return { ...base, amount: formatCents(Math.abs(t.amountCents)), ...(ticker ? { ticker } : {}) };
}

function describeActivity(t: IdentifiedTransaction): string {
  const inv = t.investment!;
  const amount = `${t.account.currency} ${formatCents(Math.abs(t.amountCents))}`;
  if (inv.kind === "buy" || inv.kind === "sell") return `${inv.kind} ${inv.qty} ${inv.ticker} @ ${inv.price} on ${t.date} (${amount})`;
  return `${inv.kind}${inv.ticker ? ` ${inv.ticker}` : ""} ${amount} on ${t.date}`;
}

/** "CBA.AX" / "CBA.XASX" / "cba" -> "CBA" */
function baseTicker(s: string): string {
  return s.trim().toUpperCase().split(/[.:|]/)[0]!;
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function shiftDate(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * 86_400_000).toISOString().slice(0, 10);
}
