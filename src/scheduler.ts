import { Cron } from "croner";
import { logger } from "./log.js";
import { AlreadyRunning, UnknownConnection, type Runner } from "./runner.js";
import type { ConfigStore } from "./store.js";

const log = logger("scheduler");
/** Spread logins so the same bank isn't hit by several people at once. */
const JITTER_MS = 120_000;

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
    for (const conn of this.store.connections()) {
      if (!conn.enabled) continue;
      const expr = conn.schedule ?? settings.schedule;
      const job = new Cron(expr, { timezone: settings.timezone }, () => {
        setTimeout(() => void this.#fire(conn.id), Math.random() * JITTER_MS);
      });
      this.#jobs.set(conn.id, job);
      log.info(`scheduled ${conn.id}: ${expr} (${settings.timezone})`);
    }
  }

  stop(): void {
    for (const job of this.#jobs.values()) job.stop();
    this.#jobs.clear();
  }

  nextRun(connectionId: string): Date | null {
    return this.#jobs.get(connectionId)?.nextRun() ?? null;
  }

  async #fire(connectionId: string): Promise<void> {
    try {
      await this.runner.run(connectionId, "schedule");
    } catch (e) {
      if (e instanceof AlreadyRunning) log.info(`${connectionId} still running, skipping scheduled run`);
      else if (e instanceof UnknownConnection) log.info(`${connectionId} was deleted, skipping`);
      else log.error(`scheduled run of ${connectionId} failed`, e);
    }
  }
}
