/**
 * Remote view of a run's browser, for steps only a person can do (CAPTCHAs).
 *
 * Streams the page with Chrome's screencast (works headless, so it works in
 * Docker) and replays clicks, scrolling and typing sent from the web UI.
 * At most one session per connection; it lives only while a run waits.
 */
import type { CDPSession, Page } from "playwright";
import { logger } from "./log.js";

const log = logger("remote");

export interface Frame {
  /** base64 JPEG */
  data: string;
  /** page size in CSS pixels, for mapping clicks */
  width: number;
  height: number;
}

export type RemoteInput =
  | { type: "click"; x: number; y: number }
  | { type: "move" | "down" | "up"; x: number; y: number }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; key: string }
  /** pasted text */
  | { type: "text"; text: string };

/** Named keys the UI may send; single characters are typed as text. */
const KEYS = new Set([
  "Enter", "Tab", "Backspace", "Delete", "Escape", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
]);

export class RemoteSession {
  frame?: Frame;
  #frameListeners = new Set<(f: Frame) => void>();
  #endListeners = new Set<() => void>();
  #queue: Promise<unknown> = Promise.resolve();
  ended = false;

  constructor(
    readonly connectionId: string,
    readonly prompt: string,
    private readonly page: Page,
    private readonly cdp: CDPSession,
    /** label of the "Done" button in the browser view */
    readonly doneLabel = "Done",
  ) {}

  /** Get frames (the latest one straight away) until the session ends. */
  subscribe(onFrame: (f: Frame) => void, onEnd: () => void): () => void {
    if (this.ended) {
      onEnd();
      return () => {};
    }
    this.#frameListeners.add(onFrame);
    this.#endListeners.add(onEnd);
    if (this.frame) onFrame(this.frame);
    return () => {
      this.#frameListeners.delete(onFrame);
      this.#endListeners.delete(onEnd);
    };
  }

  /** Inputs run one at a time, in order. */
  input(i: RemoteInput): Promise<void> {
    const run = async () => {
      if (this.ended) return;
      const m = this.page.mouse;
      switch (i.type) {
        case "click":
          await m.move(i.x, i.y, { steps: 3 });
          await m.click(i.x, i.y);
          break;
        case "move":
          await m.move(i.x, i.y);
          break;
        case "down":
          await m.move(i.x, i.y);
          await m.down();
          break;
        case "up":
          await m.move(i.x, i.y);
          await m.up();
          break;
        case "wheel":
          await m.move(i.x, i.y);
          await m.wheel(i.dx, i.dy);
          break;
        case "text":
          // Typed key by key so sites that listen for key events see it; long text is inserted at once.
          if (i.text.length <= 200) await this.page.keyboard.type(i.text);
          else await this.page.keyboard.insertText(i.text);
          break;
        case "key":
          if (i.key.length === 1) await this.page.keyboard.type(i.key);
          else if (KEYS.has(i.key)) await this.page.keyboard.press(i.key === "Space" ? " " : i.key);
          break;
      }
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  /** @internal */
  emit(f: Frame): void {
    this.frame = f;
    for (const fn of this.#frameListeners) fn(f);
  }

  /** @internal */
  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    for (const fn of this.#endListeners) fn();
    this.#frameListeners.clear();
    this.#endListeners.clear();
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await this.cdp.detach().catch(() => {});
  }
}

export class RemoteHub {
  readonly #sessions = new Map<string, RemoteSession>();

  get(connectionId: string): RemoteSession | undefined {
    return this.#sessions.get(connectionId);
  }

  /** Start streaming `page` for a connection (replaces an older session). */
  async open(connectionId: string, page: Page, prompt: string, doneLabel?: string): Promise<RemoteSession> {
    await this.close(connectionId);
    const cdp = await page.context().newCDPSession(page);
    const session = new RemoteSession(connectionId, prompt, page, cdp, doneLabel);
    cdp.on("Page.screencastFrame", (ev) => {
      session.emit({ data: ev.data, width: ev.metadata.deviceWidth, height: ev.metadata.deviceHeight });
      cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1200 });
    this.#sessions.set(connectionId, session);
    log.info(`remote view open for ${connectionId}`);
    return session;
  }

  async close(connectionId: string): Promise<void> {
    const s = this.#sessions.get(connectionId);
    if (!s) return;
    this.#sessions.delete(connectionId);
    await s.end();
    log.info(`remote view closed for ${connectionId}`);
  }
}
