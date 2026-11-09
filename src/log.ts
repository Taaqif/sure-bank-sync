const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const min = LEVELS[(process.env.LOG_LEVEL?.toLowerCase() as Level) ?? "info"] ?? LEVELS.info;

function emit(level: Level, scope: string, msg: string, err?: unknown) {
  if (LEVELS[level] < min) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${scope}: ${msg}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
  if (err instanceof Error && err.stack) console.error(err.stack);
}

export const logger = (scope: string) => ({
  debug: (m: string) => emit("debug", scope, m),
  info: (m: string) => emit("info", scope, m),
  warn: (m: string, e?: unknown) => emit("warn", scope, m, e),
  error: (m: string, e?: unknown) => emit("error", scope, m, e),
});
