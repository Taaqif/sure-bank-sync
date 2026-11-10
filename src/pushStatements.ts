/**
 * DRAFT: send downloaded statements to Sure.
 *
 * Sure has no statement upload API yet, so this only works out where each
 * statement would go (the account mapping used for transactions), skips
 * ones already sent, and logs the plan. Nothing is written to Sure and
 * nothing is marked as sent.
 *
 * When Sure adds the API: call SureClient.uploadStatement() for each planned
 * statement and markSynced() it with its statementId (same table as
 * transactions, ids prefixed "statement:"), counting stats.created.
 */
import { maskAccountId, type BankStatement } from "./models.js";
import type { RunStats, RunStore } from "./runs.js";
import type { ConfigStore, Connection } from "./store.js";

export interface StatementDeps {
  store: ConfigStore;
  runs: RunStore;
}

/** Stable id for a statement: account + issue date (+ file name, in case a bank issues two on one day). */
export function statementId(st: BankStatement): string {
  return `statement:${st.account.id}:${st.date}:${st.fileName}`;
}

export async function pushStatements(
  deps: StatementDeps,
  conn: Connection,
  statements: BankStatement[],
  stats: RunStats,
  log: (msg: string) => void,
  verbose = false,
): Promise<void> {
  const accounts = new Map(statements.map((s) => [s.account.id, s.account]));
  deps.store.recordBankAccounts(conn.id, [...accounts.values()]);
  const mapping = new Map(deps.store.bankAccounts(conn.id).map((a) => [a.bankAccountId, a]));
  const done = deps.runs.alreadySynced(conn.id, statements.map(statementId));
  const show = (id: string) => (verbose ? id : maskAccountId(id));

  for (const st of statements) {
    const where = mapping.get(st.account.id);
    const label = `${st.account.name} (${show(st.account.id)}), issued ${st.date}`;
    if (done.has(statementId(st))) {
      stats.skipped++;
      log(`statement: ${label}: already sent`);
    } else if (!where?.sureAccountId) {
      if (!where?.ignored) stats.unmapped++;
      log(`statement: ${label}: ${where?.ignored ? "account ignored" : "account not mapped"}, skipped`);
    } else {
      log(`statement: ${label}: would send ${st.fileName} (${Math.ceil(st.data.length / 1024)} KB)`);
    }
  }
  log("Sure has no statement upload API yet: nothing was sent");
}
