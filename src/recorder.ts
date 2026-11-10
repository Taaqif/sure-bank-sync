/**
 * "Train" recorder: while a person clicks through a bank site (in the debug
 * window or the remote browser view), record each step with several selector
 * candidates, a screenshot and the page HTML. The result is a "recipe" (e.g.
 * login, discover, download, statements) used to write or repair a provider.
 *
 * Privacy: password/code-like fields are never recorded, and typed values that
 * match the connection's stored login are saved as {{field}} placeholders.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { redactHtml } from "./providers/base.js";

export type SelectorCandidate =
  | { kind: "testid"; attr: string; value: string }
  | { kind: "role"; role: string; name: string }
  | { kind: "label" | "placeholder" | "text"; value: string }
  | { kind: "css"; value: string };

export interface RecordedElement {
  tag: string;
  type?: string;
  role?: string;
  name?: string;
  selectors: SelectorCandidate[];
  html: string;
}

export interface RecordedStep {
  n: number;
  /** seconds since recording started */
  t: number;
  kind: "click" | "fill" | "select" | "press" | "nav" | "download";
  tab: number;
  url: string;
  el?: RecordedElement;
  value?: string;
  masked?: boolean;
  key?: string;
  /** click position in the page (CSS px) */
  x?: number;
  y?: number;
  /** download: saved file name, CSV header row and data row count */
  file?: string;
  header?: string[];
  rows?: number;
  /** screenshot / HTML saved for this step (files in the run's debug folder) */
  shot?: string;
  htmlFile?: string;
  /** suggested Playwright call */
  code?: string;
}

export interface Recording {
  recipe: string;
  provider: string;
  connectionId: string;
  startedAt: string;
  finishedAt?: string;
  steps: RecordedStep[];
}

export const RECIPE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const RECIPE_SUGGESTIONS = ["login", "discover", "download", "statements"];
export const recordingFile = (recipe: string) => `recipe-${recipe}.json`;

/*
 * Runs in the bank page. Plain JS string on purpose: code compiled by tsx can
 * reference helpers (like __name) that don't exist inside the page.
 */
const PAGE_SCRIPT = String.raw`(() => {
  if (window.__sbsRecorder) return;
  window.__sbsRecorder = true;
  const send = (d) => { try { window.__sbsRecord(d); } catch (e) {} };
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const randomish = (s) => /[0-9a-f]{8}-[0-9a-f]{4}|\d{4,}|^(mat-|mq-random|ng-|cdk-|:r)/i.test(s || "");
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "A" && el.hasAttribute("href")) return "link";
    if (t === "SELECT") return "combobox";
    if (t === "TEXTAREA") return "textbox";
    if (t === "INPUT") {
      if (type === "checkbox" || type === "radio") return type;
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (["", "text", "email", "password", "search", "tel", "number", "url"].includes(type)) return "textbox";
    }
    return "";
  };
  const labelOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText : ""; }).join(" ");
      if (clean(t)) return clean(t);
    }
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
    const wrap = el.closest("label");
    return wrap && wrap !== el ? clean(wrap.innerText) : "";
  };
  const isField = (el) => ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
  const nameOf = (el) => clean(labelOf(el) || (isField(el) ? "" : el.innerText) || el.getAttribute("title") || el.getAttribute("alt") || "");
  const target = (el) => (el && el.closest ? el.closest("button, a, input, select, textarea, label, summary, [role], [data-testid], [data-test], [data-qa]") || el : el);
  const stableClasses = (el) => [...el.classList].filter((c) => !randomish(c) && !/^(ng-|mat-mdc-|cdk-)/.test(c) && !/--(opened|active|selected|focus|hover|disabled)/.test(c)).slice(0, 2);
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      const tid = node.getAttribute("data-testid");
      if (tid) { parts.unshift('[data-testid="' + tid + '"]'); break; }
      if (node.id && !randomish(node.id)) { parts.unshift("#" + CSS.escape(node.id)); break; }
      let part = node.tagName.toLowerCase() + stableClasses(node).map((c) => "." + CSS.escape(c)).join("");
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const describe = (el) => {
    const selectors = [];
    for (const attr of ["data-testid", "data-test", "data-qa"]) {
      const v = el.getAttribute(attr);
      if (v) selectors.push({ kind: "testid", attr, value: v });
    }
    const role = roleOf(el);
    const name = nameOf(el);
    if (role && name && name.length <= 80) selectors.push({ kind: "role", role, name });
    if (isField(el)) {
      const label = labelOf(el);
      if (label) selectors.push({ kind: "label", value: label });
      const ph = el.getAttribute("placeholder");
      if (ph) selectors.push({ kind: "placeholder", value: ph });
      for (const attr of ["name", "formcontrolname"]) {
        const v = el.getAttribute(attr);
        if (v && !randomish(v)) selectors.push({ kind: "css", value: el.tagName.toLowerCase() + "[" + attr + '="' + v + '"]' });
      }
    } else {
      const text = clean(el.innerText);
      if (text && text.length <= 60) selectors.push({ kind: "text", value: text });
    }
    if (el.id && !randomish(el.id)) selectors.push({ kind: "css", value: "#" + CSS.escape(el.id) });
    selectors.push({ kind: "css", value: cssPath(el) });
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      role: role || undefined,
      name: name ? name.slice(0, 120) : undefined,
      selectors,
      html: el.outerHTML.replace(/\s+/g, " ").slice(0, 800),
    };
  };
  const secret = (el) => {
    const type = (el.getAttribute("type") || "").toLowerCase();
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    const hints = [el.name, el.id, el.getAttribute("formcontrolname"), el.getAttribute("placeholder"), el.getAttribute("aria-label")].join(" ");
    return type === "password" || /password|one-time-code/.test(auto) || /pass|pin\b|otp|secret|cvv|security code|verification code/i.test(hints);
  };
  document.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    const el = target(e.target);
    if (!el || !el.tagName) return;
    send({ kind: "click", x: Math.round(e.clientX), y: Math.round(e.clientY), el: describe(el) });
  }, true);
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!el || !el.matches || !el.matches("input, select, textarea")) return;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "checkbox" || type === "radio" || type === "file") return;
    if (el.tagName === "SELECT") {
      const opt = el.selectedOptions && el.selectedOptions[0];
      send({ kind: "select", value: opt ? clean(opt.textContent) : el.value, el: describe(el) });
    } else if (secret(el)) {
      send({ kind: "fill", masked: true, el: describe(el) });
    } else {
      send({ kind: "fill", value: el.value, el: describe(el) });
    }
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!e.isTrusted || !["Enter", "Escape", "Tab"].includes(e.key)) return;
    const el = target(e.target);
    send({ kind: "press", key: e.key, el: el && el.tagName ? describe(el) : undefined });
  }, true);
})();`;

const q = (s: string) => JSON.stringify(s);

/** Best Playwright call for a step, from the most specific selector. */
export function suggestCode(step: Pick<RecordedStep, "kind" | "el" | "value" | "masked" | "key">): string | undefined {
  const sel = step.el?.selectors ?? [];
  const pick = (k: SelectorCandidate["kind"]) => sel.find((s) => s.kind === k);
  let loc: string | undefined;
  const tid = pick("testid") as Extract<SelectorCandidate, { kind: "testid" }> | undefined;
  const role = pick("role") as Extract<SelectorCandidate, { kind: "role" }> | undefined;
  const label = pick("label") as { value: string } | undefined;
  const ph = pick("placeholder") as { value: string } | undefined;
  const text = pick("text") as { value: string } | undefined;
  const css = pick("css") as { value: string } | undefined;
  if (tid) loc = `page.locator(${q(`[${tid.attr}="${tid.value}"]`)})`;
  else if (role) loc = `page.getByRole(${q(role.role)}, { name: ${q(role.name)}, exact: true })`;
  else if (label) loc = `page.getByLabel(${q(label.value)}, { exact: true })`;
  else if (ph) loc = `page.getByPlaceholder(${q(ph.value)}, { exact: true })`;
  else if (text) loc = `page.getByText(${q(text.value)}, { exact: true })`;
  else if (css) loc = `page.locator(${q(css.value)})`;
  switch (step.kind) {
    case "click":
      return loc && `await ${loc}.click();`;
    case "fill":
      return loc && `await ${loc}.fill(${step.masked ? "/* secret */ ctx.credentials.password" : q(step.value ?? "")});`;
    case "select":
      return loc && `await ${loc}.selectOption({ label: ${q(step.value ?? "")} });`;
    case "press":
      return loc ? `await ${loc}.press(${q(step.key ?? "")});` : `await page.keyboard.press(${q(step.key ?? "")});`;
    default:
      return undefined;
  }
}

/** Replace typed values that equal a stored login field with {{field}}. */
export function scrubValue(value: string, credentials: Record<string, string>): string {
  for (const [key, v] of Object.entries(credentials)) if (v && value === v) return `{{${key}}}`;
  return value;
}

/** CSV header row and data row count, for a downloaded file. */
export function csvSummary(text: string): { header: string[]; rows: number } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  return { header: (lines[0] ?? "").split(",").map((h) => h.replace(/^"|"$/g, "").trim()).slice(0, 30), rows: Math.max(0, lines.length - 1) };
}

export interface RecorderOptions {
  recipe: string;
  provider: string;
  connectionId: string;
  dir: string;
  credentials: Record<string, string>;
  /** values never written (secret login fields), even if typed into a non-secret box */
  secrets: string[];
  label: (url: string) => string;
  log: (msg: string) => void;
}

/** Start recording every page of `browser`. Call stop() to write recipe-<name>.json. */
export async function startRecording(browser: BrowserContext, o: RecorderOptions) {
  await mkdir(o.dir, { recursive: true });
  const started = Date.now();
  const rec: Recording = { recipe: o.recipe, provider: o.provider, connectionId: o.connectionId, startedAt: new Date().toISOString(), steps: [] };
  let n = 0;
  let stopped = false;
  let chain: Promise<unknown> = Promise.resolve();
  const tabOf = (page: Page) => Math.max(0, browser.pages().indexOf(page));
  const base = (page: Page) => ({ n: ++n, t: Math.round((Date.now() - started) / 100) / 10, tab: tabOf(page), url: o.label(page.url()) });

  const add = (page: Page, step: Omit<RecordedStep, "n" | "t" | "tab" | "url">, capture: boolean) => {
    if (stopped) return;
    const s: RecordedStep = { ...base(page), ...step };
    s.code = suggestCode(s);
    rec.steps.push(s);
    o.log(`train: step ${s.n} ${s.kind}${s.key ? ` ${s.key}` : ""} ${s.el?.name ? q(s.el.name.slice(0, 60)) : ""}${s.kind === "nav" ? s.url : ""}`);
    if (!capture) return;
    const name = `train-${o.recipe}-${String(s.n).padStart(3, "0")}`;
    // Captures run one at a time so steps keep their order on disk.
    chain = chain.then(async () => {
      try {
        await page.screenshot({ path: join(o.dir, `${name}.png`) });
        s.shot = `${name}.png`;
        await writeFile(join(o.dir, `${name}.html`), redactHtml(await page.content(), o.credentials));
        s.htmlFile = `${name}.html`;
      } catch {
        // page navigated or closed mid-capture
      }
    });
  };

  await browser.exposeBinding("__sbsRecord", (source, raw: unknown) => {
    const d = raw as Partial<RecordedStep>;
    if (!d || typeof d !== "object" || !["click", "fill", "select", "press"].includes(String(d.kind))) return;
    const page = source.page;
    let value = typeof d.value === "string" ? d.value.slice(0, 500) : undefined;
    let masked = d.masked === true;
    if (value !== undefined && o.secrets.includes(value)) {
      value = undefined;
      masked = true;
    }
    if (value !== undefined) value = scrubValue(value, o.credentials);
    add(page, { kind: d.kind as RecordedStep["kind"], el: d.el, value, masked: masked || undefined, key: d.key, x: d.x, y: d.y }, true);
  });

  const watch = (page: Page) => {
    let last = "";
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = o.label(frame.url());
      if (url === last || url === "about:blank") return;
      last = url;
      add(page, { kind: "nav" }, false);
    });
    page.on("download", async (dl) => {
      const file = `train-${o.recipe}-download-${dl.suggestedFilename().replace(/[^\w.-]+/g, "_")}`;
      try {
        await dl.saveAs(join(o.dir, file));
        const summary = /\.csv$/i.test(file) ? csvSummary(await readFile(join(o.dir, file), "utf8")) : {};
        add(page, { kind: "download", file, ...summary }, false);
      } catch (e) {
        o.log(`train: couldn't save download: ${(e as Error).message}`);
      }
    });
  };
  browser.pages().forEach(watch);
  browser.on("page", watch);
  await browser.addInitScript(PAGE_SCRIPT);
  // Pages already open get the script now; new documents get it from the init script.
  for (const page of browser.pages()) {
    for (const frame of page.frames()) await frame.evaluate(PAGE_SCRIPT).catch(() => {});
  }
  o.log(`train: recording "${o.recipe}". Do the steps in the browser, then press Finish recording.`);

  return {
    steps: () => rec.steps.length,
    async stop(): Promise<Recording> {
      stopped = true;
      await chain;
      rec.finishedAt = new Date().toISOString();
      await writeFile(join(o.dir, recordingFile(o.recipe)), JSON.stringify(rec, null, 2));
      o.log(`train: saved ${rec.steps.length} steps to ${recordingFile(o.recipe)}`);
      return rec;
    },
  };
}
