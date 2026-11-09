/**
 * Friendly schedules on top of 5-field cron.
 *
 * The UI edits a ScheduleSpec (daily at 06:00, every 6 hours, ...). It is
 * stored as cron so power users can still type any expression ("custom").
 */
import { Cron } from "croner";

export type ScheduleMode = "hourly" | "every" | "daily" | "weekdays" | "weekly" | "custom";

export interface ScheduleSpec {
  mode: ScheduleMode;
  /** minute past the hour, 0-59 */
  minute: number;
  /** hour of day, 0-23 (daily/weekdays/weekly) */
  hour: number;
  /** every N hours (mode "every") */
  everyHours: number;
  /** 0 = Sunday ... 6 = Saturday (mode "weekly") */
  weekday: number;
  /** raw cron (mode "custom") */
  cron: string;
}

export const EVERY_HOURS = [2, 3, 4, 6, 8, 12];
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");

export function buildCron(s: ScheduleSpec): string {
  switch (s.mode) {
    case "hourly":
      return `${s.minute} * * * *`;
    case "every":
      return `${s.minute} */${s.everyHours} * * *`;
    case "daily":
      return `${s.minute} ${s.hour} * * *`;
    case "weekdays":
      return `${s.minute} ${s.hour} * * 1-5`;
    case "weekly":
      return `${s.minute} ${s.hour} * * ${s.weekday}`;
    case "custom":
      return s.cron.trim().split(/\s+/).join(" ");
  }
}

/** Recognise the cron shapes the builder produces; anything else is "custom". */
export function parseCron(expr: string): ScheduleSpec {
  const cron = expr.trim().split(/\s+/).join(" ");
  const base: ScheduleSpec = { mode: "custom", minute: 0, hour: 6, everyHours: 6, weekday: 1, cron };
  const f = cron.split(" ");
  if (f.length !== 5) return base;
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  const num = (s: string, max: number) => (/^\d{1,2}$/.test(s) && Number(s) <= max ? Number(s) : null);
  const minute = num(mi, 59);
  if (minute === null || dom !== "*" || mon !== "*") return base;

  if (h === "*" && dow === "*") return { ...base, mode: "hourly", minute };
  const every = /^\*\/(\d{1,2})$/.exec(h);
  if (every && dow === "*" && EVERY_HOURS.includes(Number(every[1]))) {
    return { ...base, mode: "every", minute, everyHours: Number(every[1]) };
  }
  const hour = num(h, 23);
  if (hour === null) return base;
  if (dow === "*") return { ...base, mode: "daily", minute, hour };
  if (dow === "1-5") return { ...base, mode: "weekdays", minute, hour };
  const wd = num(dow, 7);
  if (wd !== null) return { ...base, mode: "weekly", minute, hour, weekday: wd % 7 };
  return base;
}

/** "0 6 * * *" -> "Daily at 06:00" */
export function describeCron(expr: string): string {
  const s = parseCron(expr);
  const at = `${pad(s.hour)}:${pad(s.minute)}`;
  switch (s.mode) {
    case "hourly":
      return s.minute === 0 ? "Every hour" : `Every hour at :${pad(s.minute)}`;
    case "every":
      return `Every ${s.everyHours} hours${s.minute ? ` at :${pad(s.minute)}` : ""}`;
    case "daily":
      return `Daily at ${at}`;
    case "weekdays":
      return `Weekdays at ${at}`;
    case "weekly":
      return `${WEEKDAYS[s.weekday]}s at ${at}`;
    case "custom":
      return `Custom (${s.cron})`;
  }
}

/** Next `n` run times for a cron in a timezone; throws on invalid cron. */
export function nextRuns(expr: string, timezone: string, n = 3, from?: Date): Date[] {
  const job = new Cron(expr, { timezone, paused: true });
  try {
    return job.nextRuns(n, from ?? new Date());
  } finally {
    job.stop();
  }
}
