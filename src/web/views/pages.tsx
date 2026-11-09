import type { BankAccountRow, Run } from "../../db/schema.js";
import type { MfaRequest } from "../../mfa.js";
import type { ProviderDefinition } from "../../providers/index.js";
import type { Connection, Settings, User } from "../../store.js";
import type { SureAccount } from "../../sureClient.js";
import { Layout } from "./layout.js";
import { Badge, CredentialInputs, RunsTable, ago, formatWhen } from "./parts.js";

// --- dashboard -------------------------------------------------------------

export interface ConnectionRow {
  conn: Connection;
  providerLabel: string;
  running: boolean;
  last?: Run;
  lastOk?: Run;
  nextRun: Date | null;
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
  if (r.mfa) return <Badge status="awaiting_mfa" label="awaiting code" />;
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
            needs a code: {r.mfa!.prompt}
            <form method="post" action={`/connections/${r.conn.id}/mfa`}>
              <input type="text" name="code" autocomplete="one-time-code" inputmode="numeric" required />
              <button type="submit">Submit</button>
            </form>
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
                <td class="muted">{formatWhen(r.nextRun, p.settings.timezone)}</td>
                <td>{r.last ? `${r.last.created} / ${r.last.fetched}` : ""}</td>
                <td>
                  <form method="post" action={`/connections/${r.conn.id}/run`}>
                    <button type="submit" disabled={r.running}>Run now</button>
                  </form>
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
  <Layout title="Settings" nav="settings" msg={p.msg} error={p.error}>
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
        <label>
          Default schedule (cron)
          <input type="text" name="schedule" value={p.s.schedule} required />
          <small>minute hour day month weekday. "0 6 * * *" = 6am daily. Connections can override.</small>
        </label>
        <label>
          Lookback days
          <input type="number" name="lookbackDays" value={String(p.s.lookbackDays)} min="1" max="365" required />
          <small>How far back each run fetches. Already-synced transactions are skipped.</small>
        </label>
        <label>
          MFA timeout (seconds)
          <input type="number" name="mfaTimeoutSeconds" value={String(p.s.mfaTimeoutSeconds)} min="30" max="3600" required />
          <small>How long a run waits for a code to be typed in on the dashboard.</small>
        </label>
        <label class="check">
          <input type="checkbox" name="skipPending" checked={p.s.skipPending} /> Skip pending transactions
        </label>
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

function AdvancedFields(p: { conn?: Connection; settings: Settings }) {
  return (
    <>
      <label>
        Schedule override (cron)
        <input type="text" name="schedule" value={p.conn?.schedule ?? ""} placeholder={`default: ${p.settings.schedule}`} />
      </label>
      <label>
        Lookback days override
        <input
          type="number"
          name="lookbackDays"
          value={p.conn?.lookbackDays ? String(p.conn.lookbackDays) : ""}
          min="1"
          max="365"
          placeholder={`default: ${p.settings.lookbackDays}`}
        />
      </label>
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
  <Layout title="Add connection" nav="dashboard" msg={p.msg}>
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
          <details>
            <summary>Advanced</summary>
            <div class="stack" style="padding:12px 0 0">
              <AdvancedFields settings={p.settings} />
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
  return (
    <Layout title={p.conn.id} nav="dashboard" msg={p.msg}>
      <div class="row between">
        <h2>
          {p.conn.userName} · {p.conn.id} <span class="muted">({p.provider?.label ?? p.conn.provider})</span>
        </h2>
        <form method="post" action={`/connections/${p.conn.id}/run`}>
          <button type="submit" disabled={p.running}>{p.running ? "Running…" : "Run now"}</button>
        </form>
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
            No accounts discovered yet. Click <strong>Run now</strong>: accounts found at the bank will appear here to map.
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
          <AdvancedFields conn={p.conn} settings={p.settings} />
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

export const RunPage = (p: { run: Run; shots: string[] }) => (
  <Layout title={`Run ${p.run.id}`} nav="dashboard">
    <h2>
      Run #{p.run.id} · <a href={`/connections/${p.run.connectionId}`}>{p.run.connectionId}</a> <Badge status={p.run.status} />
    </h2>
    <p class="muted">
      {p.run.trigger} · started {p.run.startedAt}
      {p.run.finishedAt && ` · finished ${p.run.finishedAt}`}
      <br />
      fetched {p.run.fetched} · new {p.run.created} · already synced {p.run.skipped} · unmapped {p.run.unmapped}
    </p>
    {p.run.error && <pre class="failed">{p.run.error}</pre>}
    <h2>Log</h2>
    <pre>{p.run.log || "(empty)"}</pre>
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
