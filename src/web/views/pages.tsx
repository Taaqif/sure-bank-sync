import type { BankAccountRow, Run } from "../../db/schema.js";
import type { RunsPage } from "../../runs.js";
import type { MfaRequest } from "../../mfa.js";
import type { ProviderDefinition } from "../../providers/index.js";
import type { Connection, Settings, User } from "../../store.js";
import type { SureAccount } from "../../sureClient.js";
import { useContext } from "hono/jsx";
import { BareLayout, Layout, NeedsBrowser, UiContext, Version } from "./layout.js";
import { RECIPE_SUGGESTIONS, type RecordedStep, type Recording } from "../../recorder.js";
import { Badge, CredentialInputs, RunsTable, ago, formatWhen } from "./parts.js";
import { LookbackField, SCHEDULE_JS, ScheduleField } from "./schedule.js";

// --- dashboard -------------------------------------------------------------

export interface ConnectionRow {
  conn: Connection;
  providerLabel: string;
  running: boolean;
  last?: Run;
  lastOk?: Run;
  nextRun: Date | null;
  /** e.g. "Daily at 06:00 · last 14 days" */
  scheduleLabel: string;
  mfa?: MfaRequest;
  unmapped: number;
}

export interface DashboardProps {
  rows: ConnectionRow[];
  runs: RunsPage;
  settings: Settings;
  hasUsers: boolean;
}

function SetupHint({ settings, hasUsers, rows }: DashboardProps) {
  if (!settings.sureUrl)
    return <div class="flash error">Setup step 1: <a href="/settings">set your Sure URL</a>.</div>;
  if (!hasUsers)
    return <div class="flash error">Setup step 2: <a href="/users">add a household member</a> with their Sure API key.</div>;
  if (!rows.length) return <div class="flash">Setup step 3: <a href="/connections/new">add a bank connection</a>.</div>;
  return null;
}

/** "LIVE" badge: this part of the page refreshes itself. */
export const LiveBadge = (p: { id?: string; title?: string; hidden?: boolean }) => (
  <span id={p.id} class="live" title={p.title ?? "Updating live"} style={p.hidden ? "display:none" : undefined}>
    LIVE
  </span>
);

/** Live state for the dashboard script: needs_you / running / idle. */
const rowState = (r: ConnectionRow) => (r.mfa ? "needs_you" : r.running ? "running" : "idle");

function StatusCell({ r }: { r: ConnectionRow }) {
  if (r.mfa) {
    return (
      <a href={r.mfa.kind === "browser" ? `/connections/${r.conn.id}/remote` : "#needs-you"}>
        <Badge status="awaiting_mfa" label={r.mfa.kind === "browser" ? "needs you: browser" : "needs you: code"} />
      </a>
    );
  }
  if (r.running) {
    return (
      <a href={r.last ? `/runs/${r.last.id}` : "#"}>
        <Badge status="running" label="running…" />
      </a>
    );
  }
  if (!r.conn.enabled && !r.last) return <Badge status="disabled" />;
  if (r.last)
    return (
      <a href={`/runs/${r.last.id}`}>
        <Badge status={r.last.status} />
      </a>
    );
  return <span class="muted">—</span>;
}

/** The auto-refreshing part of the dashboard. */
export function DashboardStatus(p: DashboardProps) {
  return (
    <>
      <SetupHint {...p} />
      {p.rows
        .filter((r) => r.mfa)
        .map((r) => (
          <div class="mfa attention" id="needs-you">
            <strong>
              {r.conn.userName} · {r.conn.id}
            </strong>{" "}
            {r.mfa!.kind === "browser" ? (
              <div style="margin-top:8px">
                <NeedsBrowser items={[{ connectionId: r.conn.id, prompt: r.mfa!.prompt }]} />
              </div>
            ) : (
              <>
                needs a code: {r.mfa!.prompt}
                <form method="post" action={`/connections/${r.conn.id}/mfa`}>
                  <input type="text" name="code" autocomplete="one-time-code" inputmode="numeric" required />
                  <button type="submit">Submit</button>
                </form>
              </>
            )}
          </div>
        ))}

      <div class="row between">
        <h2>
          Connections
          <LiveBadge title="Updating live" />
        </h2>
        {p.hasUsers && (
          <a href="/connections/new">
            <button type="button">Add connection</button>
          </a>
        )}
      </div>
      <div class="card">
        {p.rows.length ? (
          <table>
            <tr>
              <th>Person</th><th>Connection</th><th>Bank</th><th>Status</th><th>Last run</th>
              <th>Last success</th><th>Next run</th><th></th>
            </tr>
            {p.rows.map((r) => (
              <tr
                data-conn={r.conn.id}
                data-state={rowState(r)}
                data-run={r.last ? String(r.last.id) : ""}
                data-status={r.last?.status ?? ""}
                data-created={r.last ? String(r.last.created) : ""}
                data-dry={r.last?.dryRun ? "1" : ""}
                data-error={r.last?.error ?? ""}
              >
                <td>{r.conn.userName}</td>
                <td>
                  <a href={`/connections/${r.conn.id}`}>{r.conn.id}</a>
                  {r.unmapped > 0 && (
                    <>
                      <br />
                      <a href={`/connections/${r.conn.id}#accounts`} class="awaiting_mfa" style="font-size:12px">
                        {r.unmapped} account{r.unmapped > 1 ? "s" : ""} to map
                      </a>
                    </>
                  )}
                </td>
                <td>{r.providerLabel}</td>
                <td><StatusCell r={r} /></td>
                <td>{ago(r.last?.startedAt)}</td>
                <td>{ago(r.lastOk?.finishedAt)}</td>
                <td class="muted">
                  {formatWhen(r.nextRun, p.settings.timezone)}
                  <br />
                  <small>{r.scheduleLabel}</small>
                </td>
                <td>
                  {r.running ? (
                    <CancelButton connectionId={r.conn.id} />
                  ) : (
                    <form method="post" action={`/connections/${r.conn.id}/run`}>
                      <button type="submit">Run now</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </table>
        ) : (
          <div class="empty">No bank connections yet.</div>
        )}
      </div>

      <h2 id="recent-runs">
        Recent runs
        <LiveBadge />
      </h2>
      <RunsTable {...p.runs} href={(n) => (n > 1 ? `/?runs=${n}#recent-runs` : "/#recent-runs")} />
    </>
  );
}

/*
 * Live dashboard: refresh fast while something is running or waiting on you
 * (2s), slowly when idle (10s) or in a background tab (15s, so the tab title
 * still flags pending actions). Never refresh while someone is typing a code.
 * Shows a toast when a run finishes and puts "action needed" in the title.
 */
const REFRESH_JS = `
const el = document.getElementById("status");
const toasts = document.getElementById("toasts");
const baseTitle = document.title;
let prev = snapshot();
let timer;

function snapshot() {
  const m = new Map();
  el.querySelectorAll("tr[data-conn]").forEach((tr) => m.set(tr.dataset.conn, { ...tr.dataset }));
  return m;
}
function busy(snap) { return [...snap.values()].some((r) => r.state !== "idle"); }
function updateTitle(snap) {
  const n = [...snap.values()].filter((r) => r.state === "needs_you").length;
  document.title = (n ? "⚠ " + n + " action needed · " : busy(snap) ? "⟳ " : "") + baseTitle;
}
function toast(conn, r) {
  const ok = r.status === "success";
  const t = document.createElement("a");
  t.className = "toast " + (r.status || "");
  t.href = "/runs/" + r.run;
  const what = r.status === "success"
    ? (r.dry ? "dry run done: " + r.created + " would be sent" : "done: " + r.created + " new")
    : r.status === "cancelled" ? "cancelled" : "failed" + (r.error ? ": " + r.error : "");
  t.textContent = conn + " " + what;
  toasts.appendChild(t);
  setTimeout(() => t.remove(), ok ? 8000 : 20000);
}
function diff(now) {
  for (const [conn, r] of now) {
    const before = prev.get(conn);
    if (!before) continue;
    if (r.state === "idle" && r.run && (before.state !== "idle" || before.run !== r.run) && r.status !== "running") toast(conn, r);
    if (r.state === "needs_you" && before.state !== "needs_you") document.getElementById("needs-you")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  prev = now;
}
async function refreshStatus() {
  const typing = [...el.querySelectorAll("input")].some(i => i.value || i === document.activeElement);
  if (!typing) {
    try {
      const r = await fetch("/partials/status" + location.search, { credentials: "same-origin" });
      if (r.ok) { el.innerHTML = await r.text(); diff(snapshot()); }
    } catch {}
  }
  updateTitle(prev);
  schedule();
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(refreshStatus, document.hidden ? 15000 : busy(prev) ? 2000 : 10000);
}
window.refreshLive = refreshStatus;
// Pressing Run now / Cancel reloads the page; check again soon after.
updateTitle(prev);
schedule();`;

export const DashboardPage = (p: DashboardProps & { msg?: string }) => (
  <Layout nav="dashboard" msg={p.msg} script={REFRESH_JS} hideNeeds>
    <div id="status">
      <DashboardStatus {...p} />
    </div>
    <div id="toasts" class="toasts" aria-live="polite" />
  </Layout>
);

// --- settings --------------------------------------------------------------

const mb = (bytes: number) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`);

export interface StorageInfo {
  /** state.db + WAL files */
  dbBytes: number;
  runs: number;
  /** run log text inside the database */
  logBytes: number;
  /** "already sent to Sure" records (kept: they prevent duplicates) */
  synced: number;
  debugRuns: number;
  debugBytes: number;
  appLogBytes: number;
  browser: { profiles: number; bytes: number };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const SettingsPage = (p: { s: Settings; storage?: StorageInfo; msg?: string; error?: string }) => (
  <Layout title="Settings" nav="settings" msg={p.msg} error={p.error} script={SCHEDULE_JS}>
    <h2>Settings</h2>
    <div class="card">
      <form class="stack" method="post" action="/settings">
        <label>
          Sure URL
          <input type="url" name="sureUrl" value={p.s.sureUrl} placeholder="http://sure-web:3000" required />
          <small>Base URL of your Sure instance as seen from this container.</small>
        </label>
        <label>
          Timezone
          <input type="text" name="timezone" value={p.s.timezone} required />
          <small>Used for schedules and "today", e.g. Australia/Melbourne.</small>
        </label>
        <ScheduleField name="schedule" label="Default schedule" value={p.s.schedule} timezone={p.s.timezone} />
        <label>
          MFA timeout (seconds)
          <input type="number" name="mfaTimeoutSeconds" value={String(p.s.mfaTimeoutSeconds)} min="30" max="3600" required />
          <small>How long a run waits for a code, robot check or other step from you.</small>
        </label>
        <label>
          Browsers at once
          <select name="maxBrowsers">
            {[1, 2, 3, 4].map((n) => (
              <option value={String(n)} selected={p.s.maxBrowsers === n}>
                {n}
              </option>
            ))}
          </select>
          <small>
            How many runs can use a browser at the same time; others queue. Each bank still runs one connection at a
            time. Runs waiting for you hand their place to the next run (up to the same number again). Each browser
            uses roughly 300-500 MB of memory.
          </small>
        </label>
        <label class="check">
          <input type="checkbox" name="skipPending" checked={p.s.skipPending} /> Skip pending transactions
        </label>
        <label class="check">
          <input type="checkbox" name="dryRun" checked={p.s.dryRun} /> Dry run mode
        </label>
        <small class="hint" style="margin-top:-10px">
          Every sync scrapes the bank and reads Sure, but only logs the transactions it would create. Nothing is
          written or marked as synced, so turning this off later imports them for real.
        </small>
        <label class="check">
          <input type="checkbox" name="saveNetworkLog" checked={p.s.saveNetworkLog} /> Save network log with failed runs
        </label>
        <small class="hint" style="margin-top:-10px">
          Failed runs always keep a screenshot, the page HTML and the browser console. This adds every request the
          bank's page made (method, status, address without query string; no headers, cookies or bodies). Debug runs
          always include it.
        </small>
        <label class="check">
          <input type="checkbox" name="verboseLogs" checked={p.s.verboseLogs} /> Verbose logs
        </label>
        <small class="hint" style="margin-top:-10px">
          Off: logs show counts and only the last 4 digits of account numbers. On: also every transaction (date,
          amount, description) and full account numbers. Turn on only while troubleshooting.
        </small>
        <label>
          Source tag
          <input type="text" name="sureSource" value={p.s.sureSource} />
          <small>Stored on each transaction in Sure to detect duplicates. Don't change after the first sync.</small>
        </label>
        <div>
          <button type="submit">Save</button>
        </div>
      </form>
    </div>

    {p.storage && <StorageSection st={p.storage} />}
  </Layout>
);

/** Settings -> Storage: what uses disk space, and cleanup where it's safe. */
const StorageSection = ({ st }: { st: StorageInfo }) => {
  const total = st.dbBytes + st.debugBytes + st.appLogBytes + st.browser.bytes;
  return (
    <>
      <h2 id="storage">Storage</h2>
      <div class="card">
        <table class="storage">
          <tr>
            <th>What</th>
            <th>Size</th>
            <th />
          </tr>
          <tr>
            <td>
              Database
              <div class="hint">
                {plural(st.runs, "run")} (logs {mb(st.logBytes)}), {plural(st.synced, "synced transaction record")},
                settings and logins. The last 500 runs are kept automatically. Synced records are never deleted: they
                stop transactions being sent to Sure twice.
              </div>
            </td>
            <td>{mb(st.dbBytes)}</td>
            <td>
              <form method="post" action="/settings/storage/runs" class="row" onsubmit="return confirm('Delete these runs and their logs?')">
                <select name="olderThanDays" style="width:auto">
                  <option value="90">older than 90 days</option>
                  <option value="30" selected>older than 30 days</option>
                  <option value="7">older than 7 days</option>
                  <option value="0">all finished runs</option>
                </select>
                <button type="submit" class="secondary">
                  Delete runs
                </button>
              </form>
            </td>
          </tr>
          <tr>
            <td>
              Debug files
              <div class="hint">
                Screenshots, page HTML, browser logs and downloads of {plural(st.debugRuns, "run")}. The last 30 are kept
                automatically. They can contain account details.
              </div>
            </td>
            <td>{mb(st.debugBytes)}</td>
            <td>
              <form method="post" action="/settings/storage/debug" onsubmit="return confirm('Delete all debug files? Runs in progress keep theirs.')">
                <button type="submit" class="secondary" disabled={st.debugRuns === 0}>
                  Delete debug files
                </button>
              </form>
            </td>
          </tr>
          <tr>
            <td>
              App log
              <div class="hint">What the Logs page shows.</div>
            </td>
            <td>{mb(st.appLogBytes)}</td>
            <td>
              <form method="post" action="/settings/storage/app-log" onsubmit="return confirm('Clear the app log?')">
                <button type="submit" class="secondary">
                  Clear app log
                </button>
              </form>
            </td>
          </tr>
          <tr>
            <td>
              Saved browsers
              <div class="hint">
                Cookies, sessions and remembered devices of {plural(st.browser.profiles, "connection")}. Clearing logs
                every connection out; banks then treat the next login as a new device (expect identity checks).
              </div>
            </td>
            <td>{mb(st.browser.bytes)}</td>
            <td>
              <form
                method="post"
                action="/settings/clear-browsers"
                onsubmit="return confirm('Delete every saved browser? All connections are logged out and banks will treat the next login as a new device (expect identity checks).')"
              >
                <button type="submit" class="danger" disabled={st.browser.profiles === 0}>
                  Clear all browser data
                </button>
              </form>
            </td>
          </tr>
          <tr class="total">
            <td>Total</td>
            <td>{mb(total)}</td>
            <td />
          </tr>
        </table>
      </div>

      <h2>Delete everything</h2>
      <div class="card danger-card">
        <form
          class="stack"
          method="post"
          action="/settings/storage/everything"
          onsubmit="const v = prompt('Delete all run history, debug files, the app log and every saved browser? All connections are logged out.\n\nType DELETE to confirm.'); if (v !== 'DELETE') return false; this.confirm.value = v; return true;"
        >
          <div class="cols">
            <div>
              <strong>Deleted</strong>
              <ul>
                <li>Run history and logs</li>
                <li>Debug files</li>
                <li>App log</li>
                <li>Saved browsers (every connection is logged out)</li>
              </ul>
            </div>
            <div>
              <strong>Kept</strong>
              <ul>
                <li>Settings and household</li>
                <li>Connections, logins and account mappings</li>
                <li>Synced transaction records</li>
              </ul>
            </div>
          </div>
          <input type="hidden" name="confirm" value="" />
          <div>
            <button type="submit" class="danger">
              Delete everything ({mb(total - st.dbBytes + st.logBytes)})
            </button>
          </div>
        </form>
      </div>
    </>
  );
};

// --- household -------------------------------------------------------------

export const UsersPage = (p: { users: { user: User; conns: Connection[] }[]; msg?: string }) => (
  <Layout title="Household" nav="household" msg={p.msg}>
    <h2>Household</h2>
    <div class="card">
      {p.users.length ? (
        <table>
          <tr><th>Person</th><th>Connections</th><th></th></tr>
          {p.users.map(({ user, conns }) => (
            <tr>
              <td><a href={`/users/${user.id}`}>{user.name}</a></td>
              <td>
                {conns.length ? (
                  conns.map((c, i) => (
                    <>
                      {i > 0 && ", "}
                      <a href={`/connections/${c.id}`}>{c.id}</a>
                    </>
                  ))
                ) : (
                  <span class="muted">none</span>
                )}
              </td>
              <td><a href={`/connections/new?userId=${user.id}`}>Add connection</a></td>
            </tr>
          ))}
        </table>
      ) : (
        <div class="empty">Nobody added yet.</div>
      )}
    </div>

    <h2>Add person</h2>
    <div class="card">
      <form class="stack" method="post" action="/users">
        <label>
          Name <input type="text" name="name" required />
        </label>
        <label>
          Sure API key
          <input type="password" name="sureApiKey" autocomplete="off" required />
          <small>In Sure: Settings → API Keys → create one with read/write scope. Stored encrypted.</small>
        </label>
        <div>
          <button type="submit">Add</button>
        </div>
      </form>
    </div>
  </Layout>
);

export const UserPage = (p: { user: User; conns: Connection[]; msg?: string }) => (
  <Layout title={p.user.name} nav="household" msg={p.msg}>
    <h2>{p.user.name}</h2>
    <div class="card">
      <form class="stack" method="post" action={`/users/${p.user.id}`}>
        <label>
          Name <input type="text" name="name" value={p.user.name} required />
        </label>
        <label>
          Sure API key
          <input type="password" name="sureApiKey" autocomplete="off" placeholder="•••••••• (unchanged)" />
          <small>Leave blank to keep the current key.</small>
        </label>
        <div class="row">
          <button type="submit">Save</button>
          <button type="submit" class="secondary" formaction={`/users/${p.user.id}/test`}>
            Test Sure connection
          </button>
        </div>
      </form>
    </div>

    <div class="row between">
      <h2>Connections</h2>
      <a href={`/connections/new?userId=${p.user.id}`}>
        <button type="button">Add connection</button>
      </a>
    </div>
    <div class="card">
      {p.conns.length ? (
        <table>
          {p.conns.map((c) => (
            <tr>
              <td><a href={`/connections/${c.id}`}>{c.id}</a></td>
              <td>{c.provider}</td>
              <td>{c.enabled ? "enabled" : "disabled"}</td>
            </tr>
          ))}
        </table>
      ) : (
        <div class="empty">No connections.</div>
      )}
    </div>

    <form
      method="post"
      action={`/users/${p.user.id}/delete`}
      class="actions"
      onsubmit="return confirm('Delete this person and all their bank connections? Transactions already in Sure are kept.')"
    >
      <button type="submit" class="danger">Delete {p.user.name}</button>
    </form>
  </Layout>
);

// --- connections -----------------------------------------------------------

function ScheduleFields(p: { conn?: Connection; settings: Settings; provider?: ProviderDefinition }) {
  return (
    <>
      <ScheduleField
        name="schedule"
        label="Schedule"
        value={p.conn?.schedule ?? null}
        defaultCron={p.settings.schedule}
        timezone={p.settings.timezone}
      />
      {p.provider && <LookbackField name="lookbackDays" value={p.conn?.lookbackDays ?? null} period={p.provider.syncPeriod} />}
    </>
  );
}

function AdvancedFields(p: { conn?: Connection }) {
  return (
    <>
      <label>
        Options (JSON)
        <textarea name="options">{JSON.stringify(p.conn?.options ?? {})}</textarea>
        <small>Provider specific. Demo bank: {'{"mfa": true}'} tests the code prompt.</small>
      </label>
    </>
  );
}

export const ConnectionNewPage = (p: {
  users: User[];
  providers: ProviderDefinition[];
  provider: ProviderDefinition;
  userId?: number;
  settings: Settings;
  msg?: string;
}) => (
  <Layout title="Add connection" nav="dashboard" msg={p.msg} script={SCHEDULE_JS}>
    <h2>Add bank connection</h2>
    {!p.users.length ? (
      <div class="flash error">
        Add a <a href="/users">household member</a> first.
      </div>
    ) : (
      <div class="card">
        <form class="stack" method="get" action="/connections/new">
          <label>
            Bank
            <select name="provider" onchange="this.form.submit()">
              {p.providers.map((d) => (
                <option value={d.name} selected={d.name === p.provider.name}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          {p.userId !== undefined && <input type="hidden" name="userId" value={String(p.userId)} />}
          <noscript>
            <button type="submit" class="secondary">Change bank</button>
          </noscript>
        </form>
        <form class="stack" method="post" action="/connections" style="padding-top:0">
          <input type="hidden" name="provider" value={p.provider.name} />
          <label>
            Person
            <select name="userId" required>
              {p.users.map((u) => (
                <option value={String(u.id)} selected={u.id === p.userId}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <CredentialInputs fields={p.provider.credentialFields} />
          <label class="check">
            <input type="checkbox" name="enabled" checked /> Run on schedule
          </label>
          <ScheduleFields settings={p.settings} provider={p.provider} />
          <details>
            <summary>Advanced</summary>
            <div class="stack" style="padding:12px 0 0">
              <AdvancedFields />
            </div>
          </details>
          <div>
            <button type="submit">Add connection</button>
          </div>
        </form>
      </div>
    )}
  </Layout>
);

/** Connection title and run buttons (refreshed live). */
export const ConnActions = (p: { conn: Connection; provider?: ProviderDefinition; running: boolean }) => {
  const ui = useContext(UiContext);
  return (
    <div id="conn-actions" class="row between" data-running={p.running ? "1" : undefined}>
      <h2>
        {p.conn.userName} · {p.conn.id} <span class="muted">({p.provider?.label ?? p.conn.provider})</span>
        <LiveBadge title="Updating live" />
      </h2>
      <div class="row">
        <form method="post" action={`/connections/${p.conn.id}/run`} class="row">
          {ui.debugTools && (
            <button type="submit" class="secondary" name="debug" value="1" disabled={p.running} title="Dry run with a visible, slowed-down browser; captures network data and keeps downloads">
              Debug run
            </button>
          )}
          <button type="submit" class="secondary" name="discover" value="1" disabled={p.running} title="Log in and list accounts to map; no transactions, nothing written">
            Discover accounts
          </button>
          <button type="submit" class="secondary" name="dryRun" value="1" disabled={p.running} title="Scrape and log what would be sent, write nothing">
            Dry run now
          </button>
          <button type="submit" disabled={p.running}>{p.running ? "Running…" : "Run now"}</button>
        </form>
        {p.running && <CancelButton connectionId={p.conn.id} />}
      </div>
    </div>
  );
};

/** The connection's run table (refreshed live). */
export const ConnRuns = (p: { conn: Connection; runs: RunsPage }) => (
  <div id="conn-runs">
    <h2 id="runs">
      Runs
      <LiveBadge title="Updating live" />
    </h2>
    <RunsTable {...p.runs} href={(n) => `/connections/${encodeURIComponent(p.conn.id)}${n > 1 ? `?runs=${n}` : ""}#runs`} />
  </div>
);

/*
 * Connection page: refresh the run buttons and the runs table every 2s while
 * a run is going (10s otherwise, 15s in a background tab). Forms elsewhere on
 * the page (mapping, edit) are left alone.
 */
const CONN_LIVE_JS = `
(() => {
  const id = document.getElementById("conn").dataset.id;
  let timer;
  async function poll() {
    try {
      const r = await fetch("/connections/" + encodeURIComponent(id) + "/partials/live" + location.search, { credentials: "same-origin" });
      if (r.ok) {
        const doc = new DOMParser().parseFromString(await r.text(), "text/html");
        for (const part of ["conn-actions", "conn-runs"]) {
          const fresh = doc.getElementById(part);
          const old = document.getElementById(part);
          if (fresh && old && fresh.innerHTML !== old.innerHTML) old.replaceWith(fresh);
        }
      }
    } catch {}
    const running = !!document.querySelector("#conn-actions[data-running]");
    timer = setTimeout(poll, document.hidden ? 15000 : running ? 2000 : 10000);
  }
  window.refreshLive = () => { clearTimeout(timer); poll(); };
  timer = setTimeout(poll, 2000);
})();`;

export const ConnectionPage = (p: {
  conn: Connection;
  provider?: ProviderDefinition;
  users: User[];
  accounts: BankAccountRow[];
  sureAccounts: SureAccount[];
  sureError?: string;
  runs: RunsPage;
  running: boolean;
  settings: Settings;
  msg?: string;
}) => {
  const known = new Set(p.sureAccounts.map((a) => a.id));
  const ui = useContext(UiContext);
  return (
    <Layout title={p.conn.id} nav="dashboard" msg={p.msg} script={SCHEDULE_JS + CONN_LIVE_JS}>
      <div id="conn" data-id={p.conn.id} />
      <ConnActions conn={p.conn} provider={p.provider} running={p.running} />

      <h2 id="accounts">Accounts</h2>
      {p.sureError && <div class="flash error">Couldn't load Sure accounts: {p.sureError}</div>}
      <div class="card">
        {p.accounts.length ? (
          <form method="post" action={`/connections/${p.conn.id}/accounts`}>
            <table>
              <tr><th>Bank account</th><th>Number</th><th>Last seen</th><th>Sends to Sure account</th></tr>
              {p.accounts.map((a) => (
                <tr>
                  <td>{a.name}</td>
                  <td class="muted">{a.bankAccountId}</td>
                  <td class="muted">{ago(a.lastSeen)}</td>
                  <td>
                    <select name={`map_${a.bankAccountId}`}>
                      <option value="">— not mapped (skip for now) —</option>
                      <option value="__ignore__" selected={a.ignored}>Ignore this account</option>
                      {p.sureAccounts.map((s) => (
                        <option value={s.id} selected={!a.ignored && s.id === a.sureAccountId}>
                          {s.name}
                          {s.currency ? ` (${s.currency})` : ""}
                        </option>
                      ))}
                      {a.sureAccountId && !known.has(a.sureAccountId) && (
                        <option value={a.sureAccountId} selected>
                          {a.sureAccountId} (not found in Sure)
                        </option>
                      )}
                    </select>
                  </td>
                </tr>
              ))}
            </table>
            <div class="actions" style="padding:0 12px">
              <button type="submit">Save mapping</button>
            </div>
          </form>
        ) : (
          <div class="empty">
            No accounts discovered yet. Click <strong>Discover accounts</strong>: the accounts this login can see will
            appear here to map. Nothing is imported.
          </div>
        )}
      </div>

      <ConnRuns conn={p.conn} runs={p.runs} />

      {ui.debugTools && <TrainForm connectionId={p.conn.id} running={p.running} canStartLoggedOut={!!p.provider?.startUrl} />}

      <h2>Edit connection</h2>
      <div class="card">
        <form class="stack" method="post" action={`/connections/${p.conn.id}`}>
          <label>
            Person
            <select name="userId">
              {p.users.map((u) => (
                <option value={String(u.id)} selected={u.id === p.conn.userId}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          {p.provider && <CredentialInputs fields={p.provider.credentialFields} setKeys={p.conn.credentialKeys} />}
          <label class="check">
            <input type="checkbox" name="enabled" checked={p.conn.enabled} /> Run on schedule
          </label>
          <ScheduleFields conn={p.conn} settings={p.settings} provider={p.provider} />
          <details>
            <summary>Advanced</summary>
            <div class="stack" style="padding:12px 0 0">
              <AdvancedFields conn={p.conn} />
            </div>
          </details>
          <div>
            <button type="submit">Save</button>
          </div>
        </form>
      </div>

      <form
        method="post"
        action={`/connections/${p.conn.id}/delete`}
        class="actions"
        onsubmit="return confirm('Delete this connection? Its saved login and browser session are removed. Transactions already in Sure are kept.')"
      >
        <button type="submit" class="danger">Delete connection</button>
      </form>
    </Layout>
  );
};

// --- runs ------------------------------------------------------------------

/** Debug tools: record a person's steps in the bank site as a named recipe. */
const TrainForm = (p: { connectionId: string; running: boolean; canStartLoggedOut: boolean }) => (
  <>
    <h2 id="train">
      Train <span class="tag">debug</span>
    </h2>
    <div class="card">
      <form class="stack" method="post" action={`/connections/${p.connectionId}/train`}>
        <p class="hint" style="margin:0">
          Record your steps in the bank's site. Each click, typed value and download is saved with a screenshot until
          you press <strong>Finish recording</strong>. Passwords and codes aren't recorded; values matching the stored
          login are saved as placeholders. The steps appear on the run's page.
        </p>
        <label>
          Recipe
          <select name="recipe" onchange="document.getElementById('train-other').hidden = this.value !== '';">
            {RECIPE_SUGGESTIONS.map((r) => (
              <option value={r}>{r}</option>
            ))}
            <option value="">Other…</option>
          </select>
          <small>What you're about to show, e.g. setting the date filter.</small>
        </label>
        <label id="train-other" hidden>
          Recipe name
          <input type="text" name="recipeOther" pattern="[a-zA-Z0-9][a-zA-Z0-9 -]{0,39}" placeholder="e.g. statements" />
          <small>Letters, numbers and dashes.</small>
        </label>
        <label class="check">
          <input type="checkbox" name="login" value="1" checked disabled={!p.canStartLoggedOut} />
          Log in first with the stored login
        </label>
        {!p.canStartLoggedOut && <input type="hidden" name="login" value="1" />}
        <div>
          <button type="submit" disabled={p.running}>
            Start recording
          </button>
        </div>
      </form>
    </div>
  </>
);

const stepAction = (s: RecordedStep) => {
  switch (s.kind) {
    case "click":
      return `click ${s.el?.name ? `"${s.el.name.slice(0, 60)}"` : s.el?.tag ?? ""}`;
    case "fill":
      return `type ${s.masked ? "(secret, not recorded)" : `"${s.value ?? ""}"`} into ${s.el?.name ? `"${s.el.name.slice(0, 40)}"` : s.el?.tag ?? "a field"}`;
    case "select":
      return `choose "${s.value ?? ""}"`;
    case "press":
      return `press ${s.key}`;
    case "nav":
      return `page: ${s.url}`;
    case "download":
      return `download ${s.file}${s.header ? ` (${s.rows} rows; columns: ${s.header.join(", ")})` : ""}`;
  }
};

/** Steps of a Train recording, with selector candidates and screenshots. */
const RecordingView = (p: { runId: number; rec: Recording }) => (
  <>
    <h2>
      Recipe "{p.rec.recipe}" <span class="muted">({p.rec.steps.length} steps)</span>
    </h2>
    <p>
      <a href={`/runs/${p.runId}/debug/recipe-${p.rec.recipe}.json`}>JSON</a>
    </p>
    {p.rec.steps.length === 0 && <div class="card empty">Nothing was recorded.</div>}
    {p.rec.steps.map((s) => (
      <div class={`card trainstep ${s.kind}`}>
        <div>
          <strong>{s.n}.</strong> {stepAction(s)} <span class="muted">· {s.t}s{s.tab ? ` · tab ${s.tab}` : ""}</span>
        </div>
        {s.code && <pre class="code">{s.code}</pre>}
        {s.el && s.el.selectors.length > 0 && (
          <details>
            <summary class="muted">selectors and element</summary>
            <ul class="sel">
              {s.el.selectors.map((c) => (
                <li>
                  <code>{c.kind === "role" ? `role=${c.role} name="${c.name}"` : c.kind === "testid" ? `[${c.attr}="${c.value}"]` : `${c.kind}: ${c.value}`}</code>
                </li>
              ))}
            </ul>
            <pre class="code">{s.el.html}</pre>
          </details>
        )}
        {s.shot && (
          <p class="muted">
            <a href={`/runs/${p.runId}/debug/${s.shot}`}>
              <img class="stepshot" src={`/runs/${p.runId}/debug/${s.shot}`} alt={`step ${s.n}`} loading="lazy" />
            </a>
            {s.htmlFile && (
              <>
                <br />
                <a href={`/runs/${p.runId}/debug/${s.htmlFile}`}>page html</a>
              </>
            )}
          </p>
        )}
      </div>
    ))}
  </>
);

/** Stops the connection's run in progress (closes its browser). */
export const CancelButton = (p: { connectionId: string }) => (
  <form method="post" action={`/connections/${p.connectionId}/cancel`}>
    <button type="submit" class="danger" title="Stop this run now. Nothing more is written to Sure.">
      Cancel
    </button>
  </form>
);

/*
 * While a run is in progress, poll for new log lines (only the part not yet
 * shown), status and counts. Keeps following the log if you're scrolled to
 * the bottom. Reloads once when the run ends, to show screenshots and logs.
 */
const RUN_LIVE_JS = `
(() => {
  const root = document.getElementById("run");
  const pre = document.getElementById("run-log");
  const badge = document.getElementById("run-badge");
  const stats = document.getElementById("run-stats");
  const needs = document.getElementById("run-needs");
  let offset = Number(root.dataset.logLength);
  let timer;
  const atBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 60;
  async function poll() {
    try {
      const r = await fetch("/api/runs/" + root.dataset.id + "?from=" + offset, { credentials: "same-origin" });
      if (r.ok) {
        const d = await r.json();
        const follow = atBottom();
        if (d.log) {
          if (pre.dataset.empty) { pre.textContent = ""; delete pre.dataset.empty; }
          pre.textContent += d.log;
          offset = d.logLength;
        }
        badge.className = "badge " + d.status;
        badge.textContent = d.status === "awaiting_mfa" ? "needs you" : d.status;
        stats.textContent = d.stats;
        needs.innerHTML = "";
        if (d.needs && d.needs.kind !== "browser") {
          const a = document.createElement("a");
          a.href = d.needs.kind === "browser" ? "/connections/" + encodeURIComponent(root.dataset.conn) + "/remote" : "/#needs-you";
          a.textContent = d.needs.kind === "browser" ? "Open browser" : "Enter code on the dashboard";
          needs.append("Needs you: " + d.needs.prompt + " ", a);
        }
        if (follow) window.scrollTo(0, document.body.scrollHeight);
        if (d.finished) { location.reload(); return; }
      }
    } catch {}
    timer = setTimeout(poll, document.hidden ? 5000 : 1500);
  }
  window.refreshLive = () => { clearTimeout(timer); poll(); };
  timer = setTimeout(poll, 1500);
})();`;

export const runStats = (run: Run) =>
  `fetched ${run.fetched} · ${run.dryRun ? "would create" : "new"} ${run.created} · already synced ${run.skipped} · unmapped ${run.unmapped}`;

export const RunPage = (p: { run: Run; shots: string[]; logs?: string[]; recordings?: Recording[]; msg?: string }) => {
  const live = p.run.status === "running" || p.run.status === "awaiting_mfa";
  return (
  <Layout title={`Run ${p.run.id}`} nav="dashboard" msg={p.msg} script={live ? RUN_LIVE_JS : undefined}>
    <div id="run" data-id={String(p.run.id)} data-conn={p.run.connectionId} data-log-length={String(p.run.log.length)} />
    <div class="row between">
      <h2>
        Run #{p.run.id} · <a href={`/connections/${p.run.connectionId}`}>{p.run.connectionId}</a>{" "}
        <span id="run-badge" class={`badge ${p.run.status}`}>
          {p.run.status === "awaiting_mfa" ? "needs you" : p.run.status}
        </span>
        {p.run.dryRun && <span class="tag">dry run: nothing written</span>}
      </h2>
      {live && <CancelButton connectionId={p.run.connectionId} />}
    </div>
    <p class="muted">
      {p.run.trigger} · started {p.run.startedAt}
      {p.run.finishedAt && ` · finished ${p.run.finishedAt}`}
      <br />
      <span id="run-stats">{runStats(p.run)}</span>
    </p>
    {live && <div id="run-needs" class="needs" />}
    {p.run.error && <pre class="failed">{p.run.error}</pre>}
    <h2>Log{live && <LiveBadge />}</h2>
    <pre id="run-log" data-empty={p.run.log ? undefined : "1"}>
      {p.run.log || "(empty)"}
    </pre>
    {p.logs && p.logs.length > 0 && (
      <>
        <h2>Browser logs</h2>
        <p>
          {p.logs.map((f, i) => (
            <>
              {i > 0 && " · "}
              <a href={`/runs/${p.run.id}/debug/${f}`}>{f === "console.txt" ? "Console" : f === "network.txt" ? "Network" : f}</a>
            </>
          ))}
        </p>
      </>
    )}
    {(p.recordings ?? []).map((rec) => (
      <RecordingView runId={p.run.id} rec={rec} />
    ))}
    {p.shots.length > 0 && (
      <>
        <h2>Debug screenshots</h2>
        <div class="shots">
          {p.shots.map((s) => (
            <>
              <p class="muted">
                {s} · <a href={`/runs/${p.run.id}/debug/${s.replace(/\.png$/, ".html")}`}>html</a>
              </p>
              <a href={`/runs/${p.run.id}/debug/${s}`}>
                <img src={`/runs/${p.run.id}/debug/${s}`} alt={s} />
              </a>
            </>
          ))}
        </div>
      </>
    )}
  </Layout>
  );
};

// --- logs ------------------------------------------------------------------

export interface LogEntry {
  text: string;
  level: string;
}

export function LogLines({ entries }: { entries: LogEntry[] }) {
  if (!entries.length) return <span class="muted">No log lines match.</span>;
  return (
    <>
      {entries.map((e) => (
        <div class={`l-${e.level}`}>{e.text}</div>
      ))}
    </>
  );
}

const LOGS_JS = `
const box = document.getElementById("logs");
const form = document.getElementById("logfilter");
const atBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 40;
box.scrollTop = box.scrollHeight;
async function refresh() {
  const follow = atBottom();
  const q = new URLSearchParams(new FormData(form));
  try {
    const r = await fetch("/partials/logs?" + q, { credentials: "same-origin" });
    if (r.ok) box.innerHTML = await r.text();
  } catch {}
  if (follow) box.scrollTop = box.scrollHeight;
}
form.addEventListener("change", refresh);
form.addEventListener("submit", (e) => { e.preventDefault(); refresh(); history.replaceState(null, "", "?" + new URLSearchParams(new FormData(form))); });
const live = () => document.getElementById("live").checked;
const dot = document.getElementById("logs-live");
const showDot = () => { dot.style.display = live() ? "" : "none"; };
document.getElementById("live").addEventListener("change", showDot);
showDot();
window.refreshLive = () => { if (live()) refresh(); };
setInterval(() => { if (live() && !document.hidden) refresh(); }, 5000);`;

export const LogsPage = (p: { entries: LogEntry[]; level: string; q: string; maxMb: string }) => (
  <Layout title="Logs" nav="logs" script={LOGS_JS}>
    <h2>
      Logs
      <LiveBadge id="logs-live" />
    </h2>
    <div class="card">
      <form class="toolbar" id="logfilter" method="get" action="/logs">
        <select name="level">
          {["debug", "info", "warn", "error"].map((l) => (
            <option value={l} selected={l === p.level}>
              {l === "debug" ? "all levels" : `${l} and above`}
            </option>
          ))}
        </select>
        <input type="text" name="q" value={p.q} placeholder="filter, e.g. alice-anz" />
        <label class="row">
          <input type="checkbox" id="live" checked /> live
        </label>
        <span class="hint">
          last 1000 entries · file capped at {p.maxMb} MB, older lines rotated out
        </span>
      </form>
      <pre class="logs" id="logs">
        <LogLines entries={p.entries} />
      </pre>
    </div>
  </Layout>
);

// --- login -----------------------------------------------------------------

export const LoginPage = (p: {
  next: string;
  error?: string;
  info?: string;
  username?: string;
  mode?: "password" | "oidc";
  /** OIDC provider name for the button */
  providerName?: string;
}) => (
  <BareLayout title="Sign in">
    <div class="login-wrap">
      <div class="login">
        <h1>Bank Sync → Sure</h1>
        <p class="sub">Sign in to manage bank syncing.</p>
        {p.info && <div class="flash">{p.info}</div>}
        {p.error && <div class="flash error">{p.error}</div>}
        {p.mode === "oidc" ? (
          <form method="get" action="/auth/oidc/start">
            <input type="hidden" name="next" value={p.next} />
            <button type="submit" autofocus>
              Sign in with {p.providerName ?? "single sign-on"}
            </button>
          </form>
        ) : (
        <form method="post" action="/login">
          <input type="hidden" name="next" value={p.next} />
          <label>
            Username
            <input type="text" name="username" value={p.username ?? ""} autocomplete="username" required autofocus={!p.username} />
          </label>
          <label>
            Password
            <input type="password" name="password" autocomplete="current-password" required autofocus={!!p.username} />
          </label>
          <button type="submit">Sign in</button>
        </form>
        )}
        <Version />
      </div>
    </div>
  </BareLayout>
);

// --- remote browser view -----------------------------------------------------

const REMOTE_JS = `
(() => {
  const root = document.getElementById("remote");
  const id = root.dataset.id;
  const img = document.getElementById("screen");
  const status = document.getElementById("rstatus");
  let size = { width: 0, height: 0 };
  // Inputs go one at a time, in order. Consecutive mouse moves collapse into
  // the latest one so a slow connection doesn't build up a backlog.
  const queue = [];
  let busy = false;
  const send = (body) => {
    const last = queue[queue.length - 1];
    if (body.type === "move" && last && last.type === "move") queue[queue.length - 1] = body;
    else queue.push(body);
    pump();
  };
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const body = queue.shift();
      try {
        const r = await fetch("/connections/" + encodeURIComponent(id) + "/remote/input", {
          method: "POST", credentials: "same-origin",
          headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        if (!r.ok) r.json().then((j) => status.textContent = "Input not delivered: " + (j.error || r.status)).catch(() => {});
      } catch { status.textContent = "Connection lost"; }
    }
    busy = false;
  }
  const point = (e) => {
    const r = img.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * size.width, y: (e.clientY - r.top) / r.height * size.height };
  };
  const es = new EventSource("/connections/" + encodeURIComponent(id) + "/remote/stream");
  es.addEventListener("frame", (e) => {
    const f = JSON.parse(e.data);
    size = { width: f.width, height: f.height };
    img.src = "data:image/jpeg;base64," + f.data;
    status.textContent = "Live. Click and type in the picture below.";
  });
  es.addEventListener("end", () => {
    es.close();
    status.textContent = "The run no longer needs you. Back to the connection…";
    document.getElementById("remote-live").style.display = "none";
    setTimeout(() => { location.href = "/connections/" + encodeURIComponent(id); }, 1500);
  });
  es.onerror = () => { status.textContent = "Reconnecting…"; };
  // Mouse: movement (throttled), press and release, so hover, clicks and drags all reach the page.
  let lastMove = 0;
  img.addEventListener("mousemove", (e) => {
    const now = Date.now();
    if (now - lastMove < 40) return;
    lastMove = now;
    send({ type: "move", ...point(e) });
  });
  // Mouse: keyboard focus goes to the hidden text box, so typing and pasting
  // work in every browser (Firefox and Safari only paste into text fields).
  img.addEventListener("mousedown", (e) => { e.preventDefault(); keys.focus({ preventScroll: true }); send({ type: "down", ...point(e) }); });
  img.addEventListener("mouseup", (e) => { e.preventDefault(); send({ type: "up", ...point(e) }); });
  img.addEventListener("dragstart", (e) => e.preventDefault());
  img.addEventListener("contextmenu", (e) => e.preventDefault());

  // Touch (phones/tablets): tap = click, one-finger drag = scroll the bank page.
  let touch = null;
  img.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touch = { x: t.clientX, y: t.clientY, lastY: t.clientY, lastX: t.clientX, moved: false };
  }, { passive: true });
  img.addEventListener("touchmove", (e) => {
    if (!touch || e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    if (Math.abs(t.clientX - touch.x) + Math.abs(t.clientY - touch.y) > 8) touch.moved = true;
    if (!touch.moved) return;
    const scale = size.height / img.getBoundingClientRect().height || 1;
    const dy = (touch.lastY - t.clientY) * scale, dx = (touch.lastX - t.clientX) * scale;
    touch.lastY = t.clientY; touch.lastX = t.clientX;
    send({ type: "wheel", ...point(t), dx, dy });
  }, { passive: false });
  img.addEventListener("touchend", (e) => {
    if (!touch) return;
    if (!touch.moved) {
      e.preventDefault(); // no synthetic mouse events on top of ours
      const p = point({ clientX: touch.x, clientY: touch.y });
      send({ type: "move", ...p });
      send({ type: "down", ...p });
      send({ type: "up", ...p });
    }
    touch = null;
  });

  // Phone keyboard: a hidden input opens it; what's typed goes to the bank page.
  const keys = document.getElementById("rkeys");
  document.getElementById("rkeyboard").addEventListener("click", () => { keys.value = ""; keys.focus(); });
  keys.addEventListener("beforeinput", (e) => {
    e.preventDefault();
    if (e.inputType === "deleteContentBackward") send({ type: "key", key: "Backspace" });
    else if (e.inputType === "insertLineBreak") send({ type: "key", key: "Enter" });
    else if (e.data) for (const ch of e.data) send({ type: "key", key: ch === " " ? "Space" : ch });
  });
  const NAMED = ["Enter", "Backspace", "Tab", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
  keys.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // let Ctrl/Cmd+V paste
    if (NAMED.includes(e.key)) { e.preventDefault(); send({ type: "key", key: e.key }); }
  });
  // Show when typing goes to the bank page.
  keys.addEventListener("focus", () => img.classList.add("typing"));
  keys.addEventListener("blur", () => img.classList.remove("typing"));

  // Logs panel: refreshed while open.
  const logs = document.getElementById("rlogs");
  let logTimer;
  async function loadLogs() {
    try {
      const r = await fetch("/connections/" + encodeURIComponent(id) + "/remote/logs", { credentials: "same-origin" });
      if (r.ok) {
        const d = await r.json();
        for (const [k, text] of [["run", d.run], ["console", d.console.join("\\n")], ["network", d.network.join("\\n")]]) {
          const pre = document.getElementById("rlog-" + k);
          const follow = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
          pre.textContent = text || "(nothing yet)";
          if (follow) pre.scrollTop = pre.scrollHeight;
        }
      }
    } catch {}
    if (logs.open) logTimer = setTimeout(loadLogs, 2000);
  }
  logs.addEventListener("toggle", () => { clearTimeout(logTimer); if (logs.open) loadLogs(); });
  img.addEventListener("wheel", (e) => { e.preventDefault(); send({ type: "wheel", ...point(e), dx: e.deltaX, dy: e.deltaY }); }, { passive: false });
  img.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    send({ type: "key", key: e.key === " " ? "Space" : e.key });
  });
  // Paste: Ctrl/Cmd+V on the picture or in the Keyboard box, or the Paste button.
  const pasteText = (text) => {
    text = (text || "").replace(/\\r\\n?/g, "\\n");
    if (!text) return;
    if (text.length > 2000) { status.textContent = "That's too long to paste (2000 characters max)."; return; }
    send({ type: "text", text });
    status.textContent = "Pasted " + text.length + " character" + (text.length === 1 ? "" : "s") + ".";
  };
  document.addEventListener("paste", (e) => {
    if (e.target !== img && e.target !== keys) return;
    e.preventDefault();
    pasteText(e.clipboardData && e.clipboardData.getData("text/plain"));
    if (e.target === keys) keys.value = "";
  });
  document.getElementById("rpaste").addEventListener("click", async () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      status.textContent = "This button needs the app on HTTPS (or localhost). Click the field in the picture and press Ctrl+V (Cmd+V on a Mac) instead, or on a phone tap Keyboard and paste.";
      return;
    }
    try {
      pasteText(await navigator.clipboard.readText());
    } catch {
      status.textContent = "The browser didn't allow reading the clipboard. Click the field in the picture and press Ctrl+V (Cmd+V on a Mac) instead.";
    }
  });
  window.refreshLive = () => {};
})();`;

export const RemotePage = (p: { connectionId: string; prompt?: string; doneLabel?: string; starting?: boolean }) => (
  <Layout
    title={`Browser · ${p.connectionId}`}
    nav="dashboard"
    hideNeeds
    script={p.prompt ? REMOTE_JS : p.starting ? "setTimeout(() => location.reload(), 2000);" : undefined}
  >
    <div class="row between">
      <h2>
        <a href={`/connections/${p.connectionId}`}>{p.connectionId}</a> · browser
        {p.prompt && <LiveBadge id="remote-live" title="Live view" />}
      </h2>
      {p.prompt && (
        <div class="row">
          <form method="post" action={`/connections/${p.connectionId}/remote/done`}>
            <button type="submit" title="Tell the run to carry on">
              {p.doneLabel ?? "Done"}
            </button>
          </form>
          <form method="post" action={`/connections/${p.connectionId}/remote/retry`}>
            <button type="submit" class="secondary" title="Start the login again from the bank's login page">
              Retry
            </button>
          </form>
          <CancelButton connectionId={p.connectionId} />
        </div>
      )}
    </div>
    {p.prompt ? (
      <div id="remote" data-id={p.connectionId}>
        <div class="mfa">
          {p.prompt}
          <br />
          <small id="rstatus" class="muted">
            Connecting…
          </small>
        </div>
        <div class="remote-tools">
          <button type="button" id="rkeyboard" class="secondary">
            Keyboard
          </button>
          <button type="button" id="rpaste" class="secondary" title="Type the clipboard's text into the bank page">
            Paste
          </button>
          <small class="muted">Tap to click, drag to scroll. On a computer, click a field in the picture, then type or press Ctrl+V to paste.</small>
          <input id="rkeys" class="rkeys" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck={false} aria-label="Type into the bank page" />
        </div>
        <img id="screen" class="screen" tabindex={0} draggable={false} alt="Live view of the bank's page" />
        <details id="rlogs" class="rlogs">
          <summary>
            <span class="button-like">Logs</span> run log, browser console and network calls
          </summary>
          <h3>Run log</h3>
          <pre id="rlog-run" class="rlog" />
          <h3>Browser console</h3>
          <pre id="rlog-console" class="rlog" />
          <h3>Network</h3>
          <pre id="rlog-network" class="rlog" />
        </details>
      </div>
    ) : (
      <div class="card empty">
        {p.starting
          ? "The run is starting (logging in etc.). This page opens the browser view when it's ready…"
          : "Nothing is waiting for you in the browser right now."}
      </div>
    )}
  </Layout>
);
