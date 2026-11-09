/**
 * Console + size-capped file logging.
 *
 * The file sink writes to <dir>/app.log. When it would exceed maxBytes it is
 * renamed to app.log.1 (replacing the previous one) and a fresh file starts,
 * so disk use stays under ~2 x maxBytes.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;
const min = LEVELS[(process.env.LOG_LEVEL?.toLowerCase() as Level) ?? "info"] ?? LEVELS.info;

let sink: { path: string; maxBytes: number; size: number } | null = null;

export function configureLogFile(dir: string, maxBytes: number): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "app.log");
  sink = { path, maxBytes, size: existsSync(path) ? statSync(path).size : 0 };
}

function writeFile(line: string): void {
  if (!sink) return;
  const bytes = Buffer.byteLength(line);
  try {
    if (sink.size + bytes > sink.maxBytes && sink.size > 0) {
      renameSync(sink.path, `${sink.path}.1`);
      sink.size = 0;
    }
    appendFileSync(sink.path, line);
    sink.size += bytes;
  } catch (e) {
    console.error(`log file write failed: ${(e as Error).message}`);
  }
}

function emit(level: Level, scope: string, msg: string, err?: unknown) {
  if (LEVELS[level] < min) return;
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope}: ${msg}`;
  if (err instanceof Error && err.stack) line += `\n${err.stack}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
  writeFile(line + "\n");
}

export const logger = (scope: string) => ({
  debug: (m: string) => emit("debug", scope, m),
  info: (m: string) => emit("info", scope, m),
  warn: (m: string, e?: unknown) => emit("warn", scope, m, e),
  error: (m: string, e?: unknown) => emit("error", scope, m, e),
});

/** Bytes used by the app log (current + rotated file). */
export function logFileBytes(): number {
  if (!sink) return 0;
  return [sink.path, `${sink.path}.1`].reduce((n, p) => n + (existsSync(p) ? statSync(p).size : 0), 0);
}

/** Empty the app log and drop the rotated file. */
export function clearLogFile(): void {
  if (!sink) return;
  if (existsSync(sink.path)) truncateSync(sink.path, 0);
  rmSync(`${sink.path}.1`, { force: true });
  sink.size = 0;
}

/** Last `maxLines` log entries (rotated file first), oldest first. Stack traces stay attached to their entry. */
export function tailLog(maxLines = 1000, maxBytes = 512 * 1024): string[] {
  if (!sink) return [];
  const chunks: string[] = [];
  let budget = maxBytes;
  for (const p of [sink.path, `${sink.path}.1`]) {
    if (budget <= 0 || !existsSync(p)) continue;
    const size = statSync(p).size;
    const len = Math.min(size, budget);
    const buf = Buffer.alloc(len);
    const fd = openSync(p, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    let text = buf.toString("utf8");
    if (len < size) text = text.slice(text.indexOf("\n") + 1); // drop partial first line
    chunks.unshift(text);
    budget -= len;
  }
  // Group continuation lines (stack traces) with the entry they belong to.
  const entries: string[] = [];
  for (const line of chunks.join("").split("\n")) {
    if (!line) continue;
    if (/^\d{4}-\d\d-\d\dT/.test(line) || entries.length === 0) entries.push(line);
    else entries[entries.length - 1] += "\n" + line;
  }
  return entries.slice(-maxLines);
}
