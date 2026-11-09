/** Map scraped transactions to Sure accounts, drop what's already synced, push the rest. */
import { assignExternalIds, formatCents, type BankAccount, type BankTransaction, type IdentifiedTransaction } from "./models.js";
import type { RunStats, RunStore } from "./runs.js";
import type { ConfigStore, Connection, Settings } from "./store.js";
import { SureClient, SureError } from "./sureClient.js";

export interface PushDeps {
  store: ConfigStore;
  runs: RunStore;
  fetch?: typeof fetch;
}

export async function pushTransactions(
  deps: PushDeps,
  conn: Connection,
  settings: Settings,
  txns: BankTransaction[],
  stats: RunStats,
  log: (msg: string) => void,
  /** read from Sure only; log the writes instead of making them, and don't mark anything synced */
  dryRun = false,
): Promise<void> {
  // Remember every account we saw so it shows up for mapping in the UI.
  const seen = new Map<string, BankAccount>(txns.map((t) => [t.account.id, t.account]));
  deps.store.recordBankAccounts(conn.id, [...seen.values()]);

  if (settings.skipPending) {
    const pending = txns.filter((t) => t.pending).length;
    if (pending) log(`skipping ${pending} pending`);
    txns = txns.filter((t) => !t.pending);
  }

  const accounts = new Map(deps.store.bankAccounts(conn.id).map((a) => [a.bankAccountId, a]));
  const mapped: [string, IdentifiedTransaction][] = [];
  const unmappedNames = new Set<string>();
  let ignored = 0;
  for (const t of assignExternalIds(txns)) {
    const a = accounts.get(t.account.id);
    if (a?.ignored) ignored++;
    else if (a?.sureAccountId) mapped.push([a.sureAccountId, t]);
    else {
      stats.unmapped++;
      unmappedNames.add(`${t.account.name} (${t.account.id})`);
    }
  }
  for (const name of [...unmappedNames].sort()) {
    log(`not mapped to a Sure account yet: ${name}. Map it on the connection page.`);
  }
  if (ignored) log(`skipping ${ignored} from ignored accounts`);

  const done = deps.runs.alreadySynced(
    conn.id,
    mapped.map(([, t]) => t.externalId),
  );
  const todo = mapped.filter(([, t]) => !done.has(t.externalId));
  stats.skipped = mapped.length - todo.length;
  if (!todo.length) return;

  const sure = new SureClient(settings.sureUrl, deps.store.sureApiKey(conn.userId), settings.sureSource, 30_000, deps.fetch);

  if (dryRun) {
    // Account names make the log readable; reading is fine in dry run.
    let names = new Map<string, string>();
    try {
      names = new Map((await sure.listAccounts()).map((a) => [a.id, a.name]));
    } catch (e) {
      if (!(e instanceof SureError)) throw e;
      log(`[dry run] couldn't read Sure accounts (${e.message}); showing ids`);
    }
    log(`[dry run] would push ${todo.length} transactions to Sure (nothing written)`);
    for (const [accountId, t] of todo) {
      const nature = t.amountCents > 0 ? "income " : "expense";
      log(
        `[dry run] would create ${t.date} ${nature} ${formatCents(Math.abs(t.amountCents)).padStart(10)} ` +
          `${t.description} → ${names.get(accountId) ?? accountId}`,
      );
      stats.created++;
    }
    return;
  }

  log(`pushing ${todo.length} transactions to Sure`);
  for (const [accountId, t] of todo) {
    const entry = await sure.createTransaction(accountId, t);
    deps.runs.markSynced(conn.id, t.externalId, accountId, entry?.id ? String(entry.id) : null);
    stats.created++;
  }
}
