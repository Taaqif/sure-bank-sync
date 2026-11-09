/**
 * Virtual screen (Xvfb) for running the browser with a real window but no
 * physical display. Banks such as Amex block Chrome's windowless (headless)
 * mode, so normal runs use a windowed browser on this screen instead.
 *
 * One Xvfb is started on first use and kept for the life of the process.
 * Set SURE_SYNC_HEADLESS=1 to skip it and use headless Chrome.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { logger } from "./log.js";

const log = logger("display");

let starting: Promise<string | null> | undefined;
let proc: ChildProcess | undefined;

/** Screen size; the browser window fits inside it. */
const SCREEN = "1920x1080x24";

/** DISPLAY value (e.g. ":99") of the virtual screen, or null when Xvfb isn't available. */
export function virtualDisplay(): Promise<string | null> {
  if (process.env.SURE_SYNC_HEADLESS === "1") return Promise.resolve(null);
  starting ??= start().catch((e: Error) => {
    log.warn(`Xvfb unavailable, falling back to headless Chrome: ${e.message}`);
    return null;
  });
  return starting;
}

/** First display number with no X server lock file. */
function freeDisplay(): number {
  for (let n = 99; n < 199; n++) if (!existsSync(`/tmp/.X${n}-lock`)) return n;
  throw new Error("no free X display number");
}

async function start(): Promise<string> {
  const n = freeDisplay();
  const display = `:${n}`;
  // Note: under WSLg /tmp/.X11-unix is read-only, so Xvfb can't create its socket
  // file there; it still listens on the abstract socket, which Chrome uses.
  // Run Xvfb under a small shell that kills it once our stdin pipe closes, so it
  // never outlives this process (even on a crash or a killed test worker).
  const child = spawn(
    "sh",
    ["-c", 'Xvfb "$0" -screen 0 "$1" -nolisten tcp & x=$!; trap "kill $x" EXIT; cat >/dev/null', display, SCREEN],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  let exited: number | null | undefined;
  child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  child.on("exit", (code) => {
    exited = code;
    if (proc === child) {
      log.warn(`Xvfb exited (code ${code}); it will be restarted for the next run`);
      proc = undefined;
      starting = undefined;
    }
  });
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    const deadline = Date.now() + 10_000;
    const check = () => {
      if (exited !== undefined) return reject(new Error(`Xvfb exited (code ${exited}): ${lastError(stderr)}`));
      if (existsSync(`/tmp/.X${n}-lock`)) return setTimeout(resolve, 400);
      if (Date.now() > deadline) {
        child.stdin?.end();
        return reject(new Error("Xvfb didn't start within 10s"));
      }
      setTimeout(check, 100);
    };
    check();
  });
  if (exited !== undefined) throw new Error(`Xvfb exited (code ${exited}): ${lastError(stderr)}`);
  proc = child;
  log.info(`virtual screen ready on ${display}`);
  return display;
}

const lastError = (stderr: string) =>
  stderr.split("\n").filter((l) => l.trim() && !/xkbcomp|keysym|not fatal/i.test(l)).at(-1)?.trim() ?? "";

/** Stop the virtual screen (on shutdown). */
export function stopDisplay(): void {
  // Closing the watcher's stdin makes it kill Xvfb and exit.
  proc?.stdin?.end();
  proc = undefined;
  starting = undefined;
}

process.once("exit", stopDisplay);
