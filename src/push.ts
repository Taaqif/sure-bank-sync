/**
 * Map scraped transactions to Sure accounts, drop what's already synced, and
 * send the rest to Sure as one CSV import per Sure account.
 */
import { assignExternalIds, formatCents, maskAccountId, type BankAccount, type BankTransaction, type IdentifiedTransaction } from "./models.js";
import type { RunStats, RunStore } from "./runs.js";
import type { ConfigStore, Connection, Settings } from "./store.js";
import { SureClient, SureError, toImportCsv, type SureImport, type SureTransaction } from "./sureClient.js";

export interface PushDeps {
  store: ConfigStore;
  runs: RunStore;
  fetch?: typeof fetch;
  /** how long to wait for Sure to finish an import (ms) */
  importTimeoutMs?: number;
  /** delay between import status checks (ms) */
  pollMs?: number;
  /** stop before the next import / status check when aborted */
  signal?: AbortSignal;
}

const DONE = new Set(["complete"]);
const FAILED = new Set(["failed", "revert_failed", "reverted"]);

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
      unmappedNames.add(`${t.account.name} (${settings.verboseLogs ? t.account.id : maskAccountId(t.account.id)})`);
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
  let todo = mapped.filter(([, t]) => !done.has(t.externalId));
  stats.skipped = mapped.length - todo.length;
  if (!todo.length) return;

  const sure = new SureClient(settings.sureUrl, deps.store.sureApiKey(conn.userId), settings.sureSource, 30_000, deps.fetch);

  // Rows we have no local record of may still be in Sure (new database, or a
  // run that timed out). Sure's import matches on name too, so a transaction
  // renamed or turned into a transfer in Sure would come back as a duplicate.
  const found = await alreadyInSure(sure, todo, log);
  if (found.size) {
    log(`${found.size} already in Sure; not importing them again`);
    for (const [accountId, t] of todo) {
      if (found.has(t) && !dryRun) deps.runs.markSynced(conn.id, t.externalId, accountId, "sure:existing");
    }
    todo = todo.filter(([, t]) => !found.has(t));
    stats.skipped += found.size;
  }
  if (!todo.length) return;

  if (dryRun) {
    // Account names make the log readable; reading is fine in dry run.
    let names = new Map<string, string>();
    try {
      names = new Map((await sure.listAccounts()).map((a) => [a.id, a.name]));
    } catch (e) {
      if (!(e instanceof SureError)) throw e;
      log(`[dry run] couldn't read Sure accounts (${e.message}); showing ids`);
    }
    const groups = new Map<string, number>();
    for (const [accountId] of todo) groups.set(accountId, (groups.get(accountId) ?? 0) + 1);
    for (const [accountId, n] of groups) {
      log(`[dry run] would import ${n} transactions into ${names.get(accountId) ?? accountId} as one CSV import (nothing written)`);
    }
    // Individual transactions only with verbose logs on (they're personal data).
    for (const [accountId, t] of todo) {
      if (settings.verboseLogs) {
        const nature = t.amountCents > 0 ? "income " : "expense";
        log(
          `[dry run] would import ${t.date} ${nature} ${formatCents(Math.abs(t.amountCents)).padStart(10)} ` +
            `${t.description} → ${names.get(accountId) ?? accountId}`,
        );
      }
      stats.created++;
    }
    if (!settings.verboseLogs) log("[dry run] turn on verbose logs in Settings to list each transaction");
    return;
  }

  // One import per Sure account.
  const byAccount = new Map<string, IdentifiedTransaction[]>();
  for (const [accountId, t] of todo) byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), t]);

  for (const [accountId, rows] of byAccount) {
    deps.signal?.throwIfAborted();
    log(`importing ${rows.length} transactions into Sure account ${accountId}`);
    const created = await sure.createTransactionImport(accountId, toImportCsv(rows));
    const result = await waitForImport(sure, created, deps, log);
    if (result.status === "timeout") {
      log(`import ${created.id} still running; not marking as synced (Sure dedupes if it's sent again)`);
      continue;
    }
    for (const t of rows) deps.runs.markSynced(conn.id, t.externalId, accountId, `import:${created.id}`);
    stats.created += rows.length;
    log(`import ${created.id} complete (${rows.length} rows)`);
  }
}

/**
 * Rows that already have a matching transaction in their Sure account: same
 * date and amount, preferring one with the same name. Each Sure transaction
 * matches at most one row, so two identical coffees in the bank and one in
 * Sure import exactly one.
 */
export async function alreadyInSure(
  sure: SureClient,
  rows: [string, IdentifiedTransaction][],
  log: (m: string) => void,
): Promise<Set<IdentifiedTransaction>> {
  const found = new Set<IdentifiedTransaction>();
  const byAccount = new Map<string, IdentifiedTransaction[]>();
  for (const [accountId, t] of rows) byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), t]);
  const norm = (s: string) => s.trim().split(/\s+/).join(" ").toLowerCase();

  for (const [accountId, txns] of byAccount) {
    const dates = txns.map((t) => t.date).sort();
    let existing: SureTransaction[];
    try {
      existing = await sure.listTransactions(accountId, dates[0]!, dates.at(-1)!);
    } catch (e) {
      if (!(e instanceof SureError)) throw e;
      log(`couldn't read existing Sure transactions (${e.message}); relying on Sure's import matching`);
      continue;
    }
    const pool = new Map<string, SureTransaction[]>();
    for (const x of existing) {
      const k = `${x.date}|${x.amountCents}`;
      pool.set(k, [...(pool.get(k) ?? []), x]);
    }
    // Same name first, so a different same-amount purchase isn't the one skipped.
    for (const sameName of [true, false]) {
      for (const t of txns) {
        if (found.has(t)) continue;
        const candidates = pool.get(`${t.date}|${t.amountCents}`);
        const i = candidates?.findIndex((x) => !sameName || norm(x.name) === norm(t.description)) ?? -1;
        if (i < 0) continue;
        candidates!.splice(i, 1);
        found.add(t);
      }
    }
  }
  return found;
}

async function waitForImport(
  sure: SureClient,
  imp: SureImport,
  deps: PushDeps,
  log: (m: string) => void,
): Promise<{ status: "complete" | "timeout" }> {
  const deadline = Date.now() + (deps.importTimeoutMs ?? 120_000);
  let current = imp;
  while (true) {
    if (DONE.has(current.status)) return { status: "complete" };
    if (FAILED.has(current.status)) {
      throw new SureError(`Sure import ${imp.id} ${current.status}${current.error ? `: ${current.error}` : ""}`);
    }
    if (Date.now() > deadline) return { status: "timeout" };
    deps.signal?.throwIfAborted();
    await new Promise((r) => setTimeout(r, deps.pollMs ?? 2000));
    current = await sure.getImport(imp.id);
    log(`import ${imp.id}: ${current.status}`);
  }
}
