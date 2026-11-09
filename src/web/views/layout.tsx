import { createContext, useContext, type Child } from "hono/jsx";
import { raw } from "hono/html";

/** Request-wide UI state every page can read (set in app.tsx). */
export const UiContext = createContext({
  dryRun: false,
  debugTools: false,
  auth: false,
  /** who is signed in (password or OIDC login) */
  user: undefined as string | undefined,
  /** runs waiting for a person in the browser view */
  needsBrowser: [] as { connectionId: string; prompt: string }[],
});

const CSS = `
:root {
  --bg: #f6f7f9; --card: #fff; --fg: #1d2330; --muted: #6b7280; --line: #e5e7eb;
  --ok: #15803d; --bad: #b91c1c; --warn: #b45309; --run: #1d4ed8; --accent: #111827;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --card: #171a21; --fg: #e5e7eb; --muted: #9ca3af; --line: #2a2f3a;
    --ok: #4ade80; --bad: #f87171; --warn: #fbbf24; --run: #60a5fa; --accent: #e5e7eb;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--fg); }
header { padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--card); }
header a { color: var(--fg); text-decoration: none; font-weight: 600; }
nav { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
nav a.brand { margin-right: 12px; }
nav a.tab { font-weight: 500; color: var(--muted); }
nav a.tab.on { color: var(--fg); }
main { max-width: 1100px; margin: 0 auto; padding: 20px 16px; }
h2 { font-size: 15px; margin: 24px 0 10px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
tr:last-child td { border-bottom: 0; }
a { color: var(--run); }
.muted { color: var(--muted); }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid currentColor; }
.success { color: var(--ok); } .failed { color: var(--bad); }
.running { color: var(--run); } .awaiting_mfa { color: var(--warn); } .disabled, .cancelled { color: var(--muted); }
button { font: inherit; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--accent); color: var(--bg); cursor: pointer; }
button:disabled { opacity: .4; cursor: default; }
button.secondary { background: transparent; color: var(--fg); }
button.danger { background: transparent; color: var(--bad); border-color: var(--bad); }
.mfa { border: 1px solid var(--warn); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; background: var(--card); }
.mfa form { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.mfa input { max-width: 200px; }
.flash { padding: 10px 14px; border-radius: 8px; border: 1px solid var(--ok); background: var(--card); margin-bottom: 16px; }
.flash.error { border-color: var(--bad); color: var(--bad); }
form.stack, div.stack { display: grid; gap: 14px; padding: 16px; max-width: 560px; }
.stack label { display: grid; gap: 4px; font-weight: 500; }
.stack label small, .hint { color: var(--muted); font-weight: 400; font-size: 12px; }
.stack label.check { display: flex; gap: 8px; align-items: center; }
input[type=text], input[type=password], input[type=number], input[type=url], select, textarea {
  font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); width: 100%; }
td select { width: auto; min-width: 220px; }
textarea { font-family: ui-monospace, monospace; font-size: 12px; min-height: 60px; }
[hidden] { display: none !important; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.between { justify-content: space-between; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
details summary { cursor: pointer; color: var(--muted); }
.empty { padding: 24px 16px; color: var(--muted); }
pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; }
.err { color: var(--bad); white-space: normal; max-width: 380px; overflow: hidden; text-overflow: ellipsis; }
.banner { background: var(--warn); color: var(--bg); padding: 6px 20px; font-weight: 600; font-size: 13px; }
.banner a { color: inherit; }
.tag { font-size: 11px; padding: 0 6px; border-radius: 4px; border: 1px dashed var(--warn); color: var(--warn); margin-left: 4px; }
.logs { max-height: 70vh; overflow: auto; margin: 0; border-radius: 0 0 8px 8px; border-width: 1px 0 0; }
.logs .l-WARN { color: var(--warn); } .logs .l-ERROR { color: var(--bad); } .logs .l-DEBUG { color: var(--muted); }
.toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 10px 12px; }
.toolbar input, .toolbar select { width: auto; }
.schedule { display: grid; gap: 6px; }
.schedule .row { flex-wrap: wrap; }
.cron-line { display: flex !important; gap: 8px; align-items: center; font-weight: 400 !important; }
.cron-line input { font-family: ui-monospace, monospace; font-size: 12px; max-width: 220px; }
button.link { background: none; border: 0; padding: 0; color: var(--muted); font-weight: 500; }
button.link:hover { color: var(--fg); }
nav form.who { margin-left: auto; display: flex; gap: 10px; align-items: center; font-size: 13px; }
.login-wrap { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
.login { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px 24px; }
.login h1 { font-size: 18px; margin: 0 0 4px; }
.login p.sub { color: var(--muted); margin: 0 0 20px; font-size: 13px; }
.login form { display: grid; gap: 14px; }
.login label { display: grid; gap: 4px; font-weight: 500; }
.login button[type=submit] { padding: 9px 12px; margin-top: 4px; }
table.storage td:nth-child(2) { white-space: nowrap; }
table.storage td:last-child { text-align: right; }
table.storage td:last-child form { justify-content: flex-end; }
table.storage td:first-child, table.storage td .hint { white-space: normal; }
table.storage td:first-child { width: 55%; }
table.storage td:last-child form.row { flex-wrap: nowrap; }
table.storage select { min-width: 0; }
table.storage td .hint { margin-top: 2px; }
table.storage tr.total td { font-weight: 600; }
.danger-card { border-color: var(--bad); }
.danger-card .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.danger-card ul { margin: 6px 0 0; padding-left: 18px; color: var(--muted); }
.pager { display: flex; gap: 14px; align-items: center; justify-content: center; margin: 10px 0 0; font-size: 13px; }
.mfa.attention { border-width: 2px; animation: attention 1.6s ease-in-out 3; }
@keyframes attention { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--warn) 35%, transparent); } }
.toasts { position: fixed; right: 16px; bottom: 16px; display: grid; gap: 8px; z-index: 10; max-width: min(420px, calc(100vw - 32px)); }
.toast { display: block; padding: 10px 14px; border-radius: 8px; background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--muted); color: var(--fg); text-decoration: none; box-shadow: 0 4px 16px rgba(0,0,0,.25); animation: toast-in .2s ease-out; }
.toast.success { border-left-color: var(--ok); } .toast.failed { border-left-color: var(--bad); }
@keyframes toast-in { from { transform: translateY(8px); opacity: 0; } }
.hint.preview { display: block; min-height: 1.5em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.trainstep { margin-bottom: 8px; }
.trainstep.nav { padding: 6px 14px; color: var(--muted); }
.trainstep pre.code { margin: 6px 0 0; padding: 6px 8px; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.trainstep ul.sel { margin: 6px 0; padding-left: 18px; font-size: 12px; }
.stepshot { max-width: min(520px, 100%); border: 1px solid var(--line); border-radius: 6px; margin-top: 6px; }
.cta { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin: 0 0 14px; padding: 12px 16px; border: 2px solid var(--warn); border-radius: 10px; background: color-mix(in srgb, var(--warn) 12%, var(--card)); animation: attention 1.6s ease-in-out 3; }
.cta strong { color: var(--warn); }
.cta small { display: block; color: var(--fg); margin-top: 2px; }
.cta-btn { display: inline-block; padding: 9px 16px; border-radius: 8px; background: var(--warn); color: var(--bg); font-weight: 700; text-decoration: none; white-space: nowrap; }
.cta-btn:hover { filter: brightness(1.1); }
.needs:not(:empty) { border: 1px solid var(--warn); border-radius: 8px; padding: 10px 14px; margin: 8px 0; background: var(--card); }
.live { display: inline-flex; align-items: center; gap: 5px; margin-left: 8px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--run); color: var(--run); font-size: 10px; font-weight: 700; letter-spacing: .06em; vertical-align: middle; }
.live::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: live-pulse 2.4s ease-in-out infinite; }
@keyframes live-pulse { 50% { opacity: .55; } }
.note { margin-top: 4px; padding: 8px 10px; border-left: 3px solid var(--line); background: var(--card); color: var(--muted); font-size: 13px; border-radius: 4px; }
.screen { display: block; width: 100%; max-width: 1366px; min-height: 200px; border: 1px solid var(--line); border-radius: 6px; cursor: crosshair; background: var(--card); }
.screen { touch-action: none; -webkit-user-select: none; user-select: none; }
.remote-tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 0 0 10px; }
.rkeys { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
@media (max-width: 700px) {
  #remote .mfa { font-size: 14px; }
  .rlog { font-size: 10.5px; max-height: 200px; }
  .row.between { flex-wrap: wrap; gap: 8px; }
}
.rlogs { margin-top: 14px; }
.rlogs summary { cursor: pointer; list-style: none; color: var(--muted); }
.rlogs summary::-webkit-details-marker { display: none; }
.rlogs .button-like { display: inline-block; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--line); color: var(--fg); margin-right: 8px; }
.rlogs[open] .button-like { background: var(--card); }
.rlogs h3 { font-size: 13px; margin: 14px 0 6px; color: var(--muted); font-weight: 600; }
.rlog { max-height: 260px; overflow: auto; font-size: 11.5px; margin: 0; white-space: pre; }
.screen:focus { outline: 2px solid var(--run); outline-offset: 2px; }
.shots img { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 12px; }
`;

/**
 * Keep pages fresh when the tab is shown again (switching back, phone
 * unlocked, back button). Pages with a live partial set window.refreshLive;
 * the rest reload, unless a form has unsaved edits.
 */
const FRESH_JS = `
(() => {
  let dirty = false;
  let hiddenAt = 0;
  document.addEventListener("input", (e) => { if (e.target.closest && e.target.closest("form")) dirty = true; });
  document.addEventListener("submit", () => { dirty = false; });
  function update() {
    if (typeof window.refreshLive === "function") return window.refreshLive();
    if (!dirty) location.reload();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 1000) update();
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) update(); });
})();`;

export type Nav = "dashboard" | "household" | "logs" | "settings";

/** Minimal page shell without navigation (login). */
export function BareLayout(props: { title: string; children?: Child }) {
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{props.title} · Bank Sync</title>
          <style dangerouslySetInnerHTML={{ __html: CSS }} />
        </head>
        <body>{props.children}</body>
      </html>
    </>
  );
}

/** "A run needs you in the browser" banner with a big button to the browser view. */
export function NeedsBrowser(p: { items: { connectionId: string; prompt: string }[] }) {
  return (
    <>
      {p.items.map((n) => (
        <div class="cta">
          <div>
            <strong>Needs you in the browser</strong> · {n.connectionId}
            <small>{n.prompt}</small>
          </div>
          <a class="cta-btn" href={`/connections/${encodeURIComponent(n.connectionId)}/remote`}>
            Open browser view →
          </a>
        </div>
      ))}
    </>
  );
}

/* Keeps the banner current on pages that don't reload themselves. */
const NEEDS_JS = `
(() => {
  const box = document.getElementById("needs-browser");
  if (!box) return;
  let last = box.dataset.state || "";
  async function poll() {
    try {
      const r = await fetch("/api/needs", { credentials: "same-origin" });
      if (r.ok) {
        const items = await r.json();
        const state = JSON.stringify(items);
        if (state !== last) {
          last = state;
          box.innerHTML = "";
          for (const n of items) {
            const div = document.createElement("div");
            div.className = "cta";
            const text = document.createElement("div");
            const strong = document.createElement("strong");
            strong.textContent = "Needs you in the browser";
            const small = document.createElement("small");
            small.textContent = n.prompt;
            text.append(strong, " · " + n.connectionId, small);
            const a = document.createElement("a");
            a.className = "cta-btn";
            a.href = "/connections/" + encodeURIComponent(n.connectionId) + "/remote";
            a.textContent = "Open browser view →";
            div.append(text, a);
            box.append(div);
          }
        }
      }
    } catch {}
    setTimeout(poll, document.hidden ? 10000 : 3000);
  }
  setTimeout(poll, 3000);
})();`;

export function Layout(props: {
  title?: string;
  nav?: Nav;
  msg?: string;
  error?: string;
  children?: Child;
  script?: string;
  /** pages with their own "needs you" UI (dashboard, browser view) */
  hideNeeds?: boolean;
}) {
  const tab = (n: Nav, href: string, label: string) => (
    <a class={`tab${props.nav === n ? " on" : ""}`} href={href}>
      {label}
    </a>
  );
  const msgIsError = props.msg?.startsWith("Error");
  const ui = useContext(UiContext);
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{props.title ? `${props.title} · Bank Sync` : "Bank Sync"}</title>
          <style dangerouslySetInnerHTML={{ __html: CSS }} />
        </head>
        <body>
          <header>
            <nav>
              <a class="brand" href="/">
                Bank Sync → Sure
              </a>
              {tab("dashboard", "/", "Dashboard")}
              {tab("household", "/users", "Household")}
              {tab("logs", "/logs", "Logs")}
              {tab("settings", "/settings", "Settings")}
              {ui.auth && (
                <form method="post" action="/logout" class="who">
                  {ui.user && <span class="muted">{ui.user}</span>}
                  <button type="submit" class="link">Log out</button>
                </form>
              )}
            </nav>
          </header>
          {ui.dryRun && (
            <div class="banner">
              Dry run mode is on: syncs only log what they would send to Sure. <a href="/settings">Turn off in Settings</a>
            </div>
          )}
          <main>
            {props.msg && <div class={`flash${msgIsError ? " error" : ""}`}>{props.msg}</div>}
            {props.error && <div class="flash error">{props.error}</div>}
            {!props.hideNeeds && (
              <div id="needs-browser" data-state={JSON.stringify(ui.needsBrowser)}>
                <NeedsBrowser items={ui.needsBrowser} />
              </div>
            )}
            {props.children}
          </main>
          <script dangerouslySetInnerHTML={{ __html: FRESH_JS }} />
          {!props.hideNeeds && <script dangerouslySetInnerHTML={{ __html: NEEDS_JS }} />}
          {props.script && <script dangerouslySetInnerHTML={{ __html: props.script }} />}
        </body>
      </html>
    </>
  );
}
