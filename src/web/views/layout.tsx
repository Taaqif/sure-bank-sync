import { createContext, useContext, type Child } from "hono/jsx";
import { raw } from "hono/html";

/** Request-wide UI state every page can read (set in app.tsx). */
export const UiContext = createContext({ dryRun: false, debugTools: false, auth: false });

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
.running { color: var(--run); } .awaiting_mfa { color: var(--warn); } .disabled { color: var(--muted); }
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
.login-wrap { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
.login { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px 24px; }
.login h1 { font-size: 18px; margin: 0 0 4px; }
.login p.sub { color: var(--muted); margin: 0 0 20px; font-size: 13px; }
.login form { display: grid; gap: 14px; }
.login label { display: grid; gap: 4px; font-weight: 500; }
.login button[type=submit] { padding: 9px 12px; margin-top: 4px; }
.shots img { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 12px; }
`;

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

export function Layout(props: { title?: string; nav?: Nav; msg?: string; error?: string; children?: Child; script?: string }) {
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
                <form method="post" action="/logout" style="margin-left:auto">
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
            {props.children}
          </main>
          {props.script && <script dangerouslySetInnerHTML={{ __html: props.script }} />}
        </body>
      </html>
    </>
  );
}
