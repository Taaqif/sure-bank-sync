import type { RunsPage } from "../../runs.js";
import type { CredentialField } from "../../providers/index.js";

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const secs = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  for (const [unit, n] of [["d", 86400], ["h", 3600], ["m", 60]] as const) {
    if (secs >= n) return `${Math.floor(secs / n)}${unit} ago`;
  }
  return `${secs}s ago`;
}

/** Run length: "45s", "3m 12s", "1h 4m"; still running counts up to now. */
export function duration(start: string, end: string | null | undefined, now = Date.now()): string {
  const secs = Math.max(0, Math.round(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  if (!Number.isFinite(secs)) return "—";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

export function formatWhen(d: Date | null, tz: string): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

const STATUS_LABEL: Record<string, string> = { awaiting_mfa: "needs you" };
export const Badge = (p: { status: string; label?: string }) => (
  <span class={`badge ${p.status}`}>{p.label ?? STATUS_LABEL[p.status] ?? p.status}</span>
);

/** Runs table with Newer/Older links; `href(n)` builds the link to page n. */
export function RunsTable({ runs, page, pages, total, href }: RunsPage & { href: (page: number) => string }) {
  return (
    <>
    <div class="card">
      <table>
        <tr>
          <th>#</th><th>Connection</th><th>Trigger</th><th>Status</th><th>Started</th><th>Duration</th>
          <th>Fetched</th><th>New</th><th>Skipped</th><th>Unmapped</th><th>Error</th>
        </tr>
        {runs.length === 0 && (
          <tr>
            <td colspan={11} class="muted">No runs yet.</td>
          </tr>
        )}
        {runs.map((r) => (
          <tr>
            <td><a href={`/runs/${r.id}`}>{r.id}</a></td>
            <td>{r.connectionId}</td>
            <td class="muted">
              {r.trigger}
              {r.kind === "statements" && <span class="tag">statements</span>}
              {r.dryRun && <span class="tag">dry run</span>}
            </td>
            <td><Badge status={r.status} /></td>
            <td>{ago(r.startedAt)}</td>
            <td>{duration(r.startedAt, r.finishedAt)}{!r.finishedAt && "…"}</td>
            <td>{r.fetched}</td>
            <td>{r.created}</td>
            <td>{r.skipped}</td>
            <td>{r.unmapped}</td>
            <td class="err" title={r.error ?? ""}>{r.error ?? ""}</td>
          </tr>
        ))}
      </table>
    </div>
    {pages > 1 && (
      <div class="pager">
        {page > 1 ? <a href={href(page - 1)}>← Newer</a> : <span class="muted">← Newer</span>}
        <span class="muted">
          Page {page} of {pages} · {total} runs
        </span>
        {page < pages ? <a href={href(page + 1)}>Older →</a> : <span class="muted">Older →</span>}
      </div>
    )}
    </>
  );
}

export function CredentialInputs(p: { fields: CredentialField[]; setKeys?: string[] }) {
  return (
    <>
      {p.fields.map((f) => {
        const isSet = p.setKeys?.includes(f.key);
        return (
          <label>
            {f.label}
            <input
              type={f.secret ? "password" : "text"}
              name={`cred_${f.key}`}
              autocomplete="off"
              placeholder={isSet ? "•••••••• (unchanged)" : undefined}
              required={!isSet}
            />
            {isSet && <small>Leave blank to keep the saved value.</small>}
          </label>
        );
      })}
    </>
  );
}
