/** Map scraped transactions to Sure accounts, drop what's already synced, push the rest. */
import { assignExternalIds, type BankAccount, type BankTransaction, type IdentifiedTransaction } from "./models.js";
import type { RunStats, RunStore } from "./runs.js";
import type { ConfigStore, Connection, Settings } from "./store.js";
import { SureClient } from "./sureClient.js";

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

  log(`pushing ${todo.length} transactions to Sure`);
  const sure = new SureClient(settings.sureUrl, deps.store.sureApiKey(conn.userId), settings.sureSource, 30_000, deps.fetch);
  for (const [accountId, t] of todo) {
    const entry = await sure.createTransaction(accountId, t);
    deps.runs.markSynced(conn.id, t.externalId, accountId, entry?.id ? String(entry.id) : null);
    stats.created++;
  }
}
