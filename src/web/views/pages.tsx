import type { BankAccountRow, Run } from "../../db/schema.js";
import type { MfaRequest } from "../../mfa.js";
import type { ProviderDefinition } from "../../providers/index.js";
import type { Connection, Settings, User } from "../../store.js";
import type { SureAccount } from "../../sureClient.js";
import { useContext } from "hono/jsx";
import { BareLayout, Layout, UiContext } from "./layout.js";
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
  runs: Run[];
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

function StatusCell({ r }: { r: ConnectionRow }) {
  if (!r.conn.enabled) return <Badge status="disabled" />;
  if (r.mfa) {
    return (
      <a href={r.mfa.kind === "browser" ? `/connections/${r.conn.id}/remote` : "#needs-you"}>
        <Badge status="awaiting_mfa" label={r.mfa.kind === "browser" ? "needs you: browser" : "needs you: code"} />
      </a>
    );
  }
  if (r.running) return <Badge status="running" />;
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
          <div class="mfa">
            <strong>
              {r.conn.userName} · {r.conn.id}
            </strong>{" "}
            {r.mfa!.kind === "browser" ? (
              <>
                needs you in the browser: {r.mfa!.prompt}
                <div style="margin-top:8px">
                  <a href={`/connections/${r.conn.id}/remote`}>
                    <button type="button">Open browser</button>
                  </a>
                </div>
              </>
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
        <h2>Connections</h2>
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
              <th>Last success</th><th>Next run</th><th>New / fetched</th><th></th>
            </tr>
            {p.rows.map((r) => (
              <tr>
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
                <td>{r.last ? `${r.last.created} / ${r.last.fetched}` : ""}</td>
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

      <h2>Recent runs</h2>
      <RunsTable runs={p.runs} />
    </>
  );
}

// Refresh status every 5s, but never while someone is typing an MFA code.
const REFRESH_JS = `
setInterval(async () => {
  const el = document.getElementById("status");
  const typing = [...el.querySelectorAll("input")].some(i => i.value || i === document.activeElement);
  if (typing) return;
  try {
    const r = await fetch("/partials/status", { credentials: "same-origin" });
    if (r.ok) el.innerHTML = await r.text();
  } catch {}
}, 5000);`;

export const DashboardPage = (p: DashboardProps & { msg?: string }) => (
  <Layout nav="dashboard" msg={p.msg} script={REFRESH_JS}>
    <div id="status">
      <DashboardStatus {...p} />
    </div>
  </Layout>
);

// --- settings --------------------------------------------------------------

export const SettingsPage = (p: { s: Settings; msg?: string; error?: string }) => (
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
        <ScheduleField name="schedule" label="Default schedule" value={p.s.schedule} />
        <label>
          MFA timeout (seconds)
          <input type="number" name="mfaTimeoutSeconds" value={String(p.s.mfaTimeoutSeconds)} min="30" max="3600" required />
          <small>How long a run waits for a code to be typed in on the dashboard.</small>
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
  </Layout>
);

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
      <ScheduleField name="schedule" label="Schedule" value={p.conn?.schedule ?? null} defaultCron={p.settings.schedule} />
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

export const ConnectionPage = (p: {
  conn: Connection;
  provider?: ProviderDefinition;
  users: User[];
  accounts: BankAccountRow[];
  sureAccounts: SureAccount[];
  sureError?: string;
  runs: Run[];
  running: boolean;
  settings: Settings;
  msg?: string;
}) => {
  const known = new Set(p.sureAccounts.map((a) => a.id));
  const ui = useContext(UiContext);
  return (
    <Layout title={p.conn.id} nav="dashboard" msg={p.msg} script={SCHEDULE_JS}>
      <div class="row between">
        <h2>
          {p.conn.userName} · {p.conn.id} <span class="muted">({p.provider?.label ?? p.conn.provider})</span>
        </h2>
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

      <h2>Runs</h2>
      <RunsTable runs={p.runs} />

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

/** Stops the connection's run in progress (closes its browser). */
export const CancelButton = (p: { connectionId: string }) => (
  <form method="post" action={`/connections/${p.connectionId}/cancel`}>
    <button type="submit" class="danger" title="Stop this run now. Nothing more is written to Sure.">
      Cancel
    </button>
  </form>
);

export const RunPage = (p: { run: Run; shots: string[]; logs?: string[]; msg?: string }) => {
  const live = p.run.status === "running" || p.run.status === "awaiting_mfa";
  return (
  <Layout title={`Run ${p.run.id}`} nav="dashboard" msg={p.msg}>
    <div class="row between">
      <h2>
        Run #{p.run.id} · <a href={`/connections/${p.run.connectionId}`}>{p.run.connectionId}</a> <Badge status={p.run.status} />
        {p.run.dryRun && <span class="tag">dry run: nothing written</span>}
      </h2>
      {live && <CancelButton connectionId={p.run.connectionId} />}
    </div>
    <p class="muted">
      {p.run.trigger} · started {p.run.startedAt}
      {p.run.finishedAt && ` · finished ${p.run.finishedAt}`}
      <br />
      fetched {p.run.fetched} · {p.run.dryRun ? "would create" : "new"} {p.run.created} · already synced {p.run.skipped} · unmapped {p.run.unmapped}
    </p>
    {p.run.error && <pre class="failed">{p.run.error}</pre>}
    <h2>Log</h2>
    <pre>{p.run.log || "(empty)"}</pre>
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
setInterval(() => { if (document.getElementById("live").checked) refresh(); }, 5000);`;

export const LogsPage = (p: { entries: LogEntry[]; level: string; q: string; maxMb: string }) => (
  <Layout title="Logs" nav="logs" script={LOGS_JS}>
    <h2>Logs</h2>
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

export const LoginPage = (p: { next: string; error?: string; username?: string }) => (
  <BareLayout title="Sign in">
    <div class="login-wrap">
      <div class="login">
        <h1>Bank Sync → Sure</h1>
        <p class="sub">Sign in to manage bank syncing.</p>
        {p.error && <div class="flash error">{p.error}</div>}
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
  img.addEventListener("mousedown", (e) => { e.preventDefault(); img.focus(); send({ type: "down", ...point(e) }); });
  img.addEventListener("mouseup", (e) => { e.preventDefault(); send({ type: "up", ...point(e) }); });
  img.addEventListener("dragstart", (e) => e.preventDefault());
  img.addEventListener("contextmenu", (e) => e.preventDefault());

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
  window.refreshLive = () => {};
})();`;

export const RemotePage = (p: { connectionId: string; prompt?: string }) => (
  <Layout title={`Browser · ${p.connectionId}`} nav="dashboard" script={p.prompt ? REMOTE_JS : undefined}>
    <div class="row between">
      <h2>
        <a href={`/connections/${p.connectionId}`}>{p.connectionId}</a> · browser
      </h2>
      {p.prompt && (
        <div class="row">
          <form method="post" action={`/connections/${p.connectionId}/remote/done`}>
            <button type="submit" class="secondary" title="Tell the run to carry on">
              Done
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
      <div class="card empty">Nothing is waiting for you in the browser right now.</div>
    )}
  </Layout>
);
