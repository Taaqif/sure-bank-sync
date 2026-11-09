/** Run history and record of what's already been pushed to Sure. */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { nowIso, type Db } from "./db/client.js";
import { runs, synced, type Run, type RunStatus } from "./db/schema.js";

export interface RunStats {
  fetched: number;
  created: number;
  skipped: number;
  unmapped: number;
}

export const emptyStats = (): RunStats => ({ fetched: 0, created: 0, skipped: 0, unmapped: 0 });

export const RUNS_PAGE_SIZE = 15;

export interface RunsPage {
  runs: Run[];
  /** 1-based */
  page: number;
  pages: number;
  total: number;
}

export class RunStore {
  constructor(readonly db: Db) {
    // Runs left open by a crash/restart can never finish.
    db.update(runs)
      .set({ status: "failed", error: "interrupted (process restarted)", finishedAt: nowIso() })
      .where(inArray(runs.status, ["running", "awaiting_mfa"]))
      .run();
  }

  start(connectionId: string, userName: string, trigger: Run["trigger"], dryRun = false): number {
    return this.db
      .insert(runs)
      .values({ connectionId, userName, trigger, dryRun, status: "running", startedAt: nowIso() })
      .returning({ id: runs.id })
      .get().id;
  }

  setStatus(id: number, status: RunStatus): void {
    this.db.update(runs).set({ status }).where(eq(runs.id, id)).run();
  }

  appendLog(id: number, line: string): void {
    this.db
      .update(runs)
      .set({ log: sql`${runs.log} || ${line + "\n"}` })
      .where(eq(runs.id, id))
      .run();
  }

  finish(id: number, status: "success" | "failed" | "cancelled", stats: RunStats, error: string | null = null): void {
    this.db
      .update(runs)
      .set({ status, finishedAt: nowIso(), error, ...stats })
      .where(eq(runs.id, id))
      .run();
  }

  /** Keep the newest `keep` runs so history (and per-run logs) can't grow forever. */
  prune(keep: number): void {
    this.db.run(sql`DELETE FROM runs WHERE id <= (SELECT id FROM runs ORDER BY id DESC LIMIT 1 OFFSET ${keep})`);
  }

  /** Rows and run-log text size, for Settings -> Storage. */
  storageStats(): { runs: number; logBytes: number; synced: number } {
    const r = this.db.select({ n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(length(${runs.log})), 0)` }).from(runs).get();
    const s = this.db.select({ n: sql<number>`count(*)` }).from(synced).get();
    return { runs: r?.n ?? 0, logBytes: r?.bytes ?? 0, synced: s?.n ?? 0 };
  }

  /** Delete finished runs started more than `days` ago (0: all finished runs). Returns how many. */
  deleteFinishedOlderThan(days: number, now = Date.now()): number {
    if (days <= 0) return this.db.run(sql`DELETE FROM runs WHERE status NOT IN ('running', 'awaiting_mfa')`).changes;
    const cutoff = new Date(now - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const res = this.db.run(
      sql`DELETE FROM runs WHERE status NOT IN ('running', 'awaiting_mfa') AND started_at < ${cutoff}`,
    );
    return res.changes;
  }

  /** Give freed space back to the disk. */
  compact(): void {
    this.db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
    this.db.run(sql`VACUUM`);
  }

  get(id: number): Run | undefined {
    return this.db.select().from(runs).where(eq(runs.id, id)).get();
  }

  recent(connectionId?: string, limit = 50, offset = 0): Run[] {
    const q = this.db.select().from(runs);
    return (connectionId ? q.where(eq(runs.connectionId, connectionId)) : q).orderBy(desc(runs.id)).limit(limit).offset(offset).all();
  }

  count(connectionId?: string): number {
    const q = this.db.select({ n: sql<number>`count(*)` }).from(runs);
    return (connectionId ? q.where(eq(runs.connectionId, connectionId)) : q).get()?.n ?? 0;
  }

  /** One page (1-based) of runs, newest first. */
  page(connectionId: string | undefined, page: number, size = RUNS_PAGE_SIZE): RunsPage {
    const total = this.count(connectionId);
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
    return { runs: this.recent(connectionId, size, (current - 1) * size), page: current, pages, total };
  }

  last(connectionId: string): Run | undefined {
    return this.recent(connectionId, 1)[0];
  }

  lastSuccess(connectionId: string): Run | undefined {
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.connectionId, connectionId), eq(runs.status, "success")))
      .orderBy(desc(runs.id))
      .limit(1)
      .get();
  }

  // --- synced transactions -------------------------------------------
  alreadySynced(connectionId: string, externalIds: string[]): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < externalIds.length; i += 500) {
      const chunk = externalIds.slice(i, i + 500);
      const rows = this.db
        .select({ id: synced.externalId })
        .from(synced)
        .where(and(eq(synced.connectionId, connectionId), inArray(synced.externalId, chunk)))
        .all();
      for (const r of rows) out.add(r.id);
    }
    return out;
  }

  markSynced(connectionId: string, externalId: string, sureAccountId: string, sureEntryId: string | null): void {
    this.db
      .insert(synced)
      .values({ connectionId, externalId, sureAccountId, sureEntryId, syncedAt: nowIso() })
      .onConflictDoUpdate({
        target: [synced.connectionId, synced.externalId],
        set: { sureAccountId, sureEntryId, syncedAt: nowIso() },
      })
      .run();
  }
}
