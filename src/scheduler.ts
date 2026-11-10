import { Cron } from "croner";
import type { RunKind } from "./db/schema.js";
import { logger } from "./log.js";
import { PROVIDERS } from "./providers/index.js";
import { AlreadyRunning, UnknownConnection, type Runner } from "./runner.js";
import type { ConfigStore } from "./store.js";

const log = logger("scheduler");
/** Spread logins so the same bank isn't hit by several people at once. */
const JITTER_MS = 120_000;
/**
 * Statement runs are rare (monthly), so one that finds its connection busy
 * tries again later instead of waiting a month.
 */
const STATEMENT_RETRY_MS = 10 * 60_000;
const STATEMENT_RETRIES = 6;

const jobKey = (connectionId: string, kind: RunKind) => `${connectionId}\0${kind}`;

export class Scheduler {
  readonly #jobs = new Map<string, Cron>();

  constructor(
    private readonly store: ConfigStore,
    private readonly runner: Runner,
  ) {}

  /** Rebuild all jobs from the store. Call after any config change. */
  reload(): void {
    this.stop();
    const settings = this.store.settings();
    const add = (connectionId: string, kind: RunKind, expr: string) => {
      const job = new Cron(expr, { timezone: settings.timezone }, () => {
        setTimeout(() => void this.#fire(connectionId, kind, 0), Math.random() * JITTER_MS);
      });
      this.#jobs.set(jobKey(connectionId, kind), job);
      log.info(`scheduled ${connectionId}${kind === "statements" ? " statements" : ""}: ${expr} (${settings.timezone})`);
    };
    // Transactions and statements are switched on separately, per connection
    // and for everyone in Settings.
    if (!settings.transactionSchedules) log.info("transaction schedules are off in Settings");
    if (!settings.statementSchedules) log.info("statement schedules are off in Settings");
    for (const conn of this.store.connections()) {
      if (settings.transactionSchedules && conn.enabled) add(conn.id, "transactions", conn.schedule ?? settings.schedule);
      if (settings.statementSchedules && conn.statementsEnabled && PROVIDERS[conn.provider]?.statements) {
        add(conn.id, "statements", conn.statementSchedule ?? settings.statementSchedule);
      }
    }
  }

  stop(): void {
    for (const job of this.#jobs.values()) job.stop();
    this.#jobs.clear();
  }

  nextRun(connectionId: string, kind: RunKind = "transactions"): Date | null {
    return this.#jobs.get(jobKey(connectionId, kind))?.nextRun() ?? null;
  }

  async #fire(connectionId: string, kind: RunKind, attempt: number): Promise<void> {
    // A retry outlives config changes: only go ahead if the job still exists.
    if (attempt > 0 && !this.#jobs.has(jobKey(connectionId, kind))) return;
    try {
      await this.runner.run(connectionId, "schedule", { kind });
    } catch (e) {
      if (e instanceof AlreadyRunning) {
        if (kind === "statements" && attempt < STATEMENT_RETRIES) {
          log.info(`${connectionId} busy, trying the statement import again in ${STATEMENT_RETRY_MS / 60_000} minutes`);
          setTimeout(() => void this.#fire(connectionId, kind, attempt + 1), STATEMENT_RETRY_MS).unref();
        } else log.info(`${connectionId} still running, skipping scheduled ${kind} run`);
      } else if (e instanceof UnknownConnection) log.info(`${connectionId} was deleted, skipping`);
      else log.error(`scheduled ${kind} run of ${connectionId} failed`, e);
    }
  }
}
