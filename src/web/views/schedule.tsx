import type { SyncPeriod } from "../../providers/base.js";
import { EVERY_HOURS, WEEKDAYS, describeCron, parseCron, type ScheduleMode } from "../../schedule.js";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Schedule picker. Posts a cron string as `name`; "" means "use default"
 * when `defaultCron` is given (connection override).
 */
export function ScheduleField(p: { name: string; label: string; value: string | null; defaultCron?: string; hint?: string }) {
  const useDefault = p.defaultCron !== undefined && !p.value;
  const spec = parseCron(p.value || p.defaultCron || "0 6 * * *");
  const mode: ScheduleMode | "default" = useDefault ? "default" : spec.mode;
  const modes: [ScheduleMode | "default", string][] = [];
  if (p.defaultCron !== undefined) modes.push(["default", `Use default (${describeCron(p.defaultCron)})`]);
  modes.push(
    ["hourly", "Every hour"],
    ["every", "Every few hours"],
    ["daily", "Daily"],
    ["weekdays", "Weekdays"],
    ["weekly", "Weekly"],
    ["custom", "Custom (cron)"],
  );
  return (
    <div class="schedule" data-schedule data-default={p.defaultCron ?? ""}>
      <label>
        {p.label}
        <div class="row">
          <select data-s="mode" style="width:auto">
            {modes.map(([v, l]) => (
              <option value={v} selected={v === mode}>
                {l}
              </option>
            ))}
          </select>
          <select data-s="every" data-show="every" style="width:auto">
            {EVERY_HOURS.map((h) => (
              <option value={String(h)} selected={h === spec.everyHours}>
                every {h} hours
              </option>
            ))}
          </select>
          <select data-s="weekday" data-show="weekly" style="width:auto">
            {WEEKDAYS.map((d, i) => (
              <option value={String(i)} selected={i === spec.weekday}>
                on {d}
              </option>
            ))}
          </select>
          <span data-show="daily weekdays weekly" class="row">
            at <input type="time" data-s="time" value={`${pad(spec.hour)}:${pad(spec.minute)}`} style="width:auto" />
          </span>
          <span data-show="hourly every" class="row">
            at minute <input type="number" data-s="minute" min="0" max="59" value={String(spec.minute)} style="width:5em" />
          </span>
        </div>
      </label>
      <label class="cron-line">
        <small>cron</small>
        <input type="text" name={p.name} value={useDefault ? "" : spec.cron} data-s="cron" placeholder={p.defaultCron ?? ""} />
      </label>
      <small class="hint" data-s="preview">
        {p.hint ?? ""}
      </small>
    </div>
  );
}

/**
 * Sync period picker (days of history per run), with the bank's own choices
 * and default. Banks with a fixed period get a note instead of a picker.
 */
export function LookbackField(p: { name: string; value: number | null; period: SyncPeriod }) {
  const period = p.period;
  if ("fixed" in period) {
    return (
      <div>
        <strong>Sync period</strong>
        <div class="note">{period.fixed}</div>
      </div>
    );
  }
  const choices = [...period.choices];
  if (p.value && !choices.includes(p.value)) choices.push(p.value);
  choices.sort((a, b) => a - b);
  const days = (n: number) => (n === 1 ? "Last 1 day" : `Last ${n} days`);
  return (
    <label>
      Sync period
      <select name={p.name}>
        <option value="" selected={!p.value}>
          Bank default ({days(period.default).toLowerCase()})
        </option>
        {choices.map((n) => (
          <option value={String(n)} selected={n === p.value}>
            {days(n)}
          </option>
        ))}
      </select>
      <small>
        How much history each run fetches. Transactions already in Sure are skipped.
        {period.note ? ` ${period.note}` : ""}
      </small>
    </label>
  );
}

/** Client side of ScheduleField: builds the cron and shows the next run times. */
export const SCHEDULE_JS = `
document.querySelectorAll("[data-schedule]").forEach((box) => {
  const $ = (k) => box.querySelector('[data-s="' + k + '"]');
  const cron = $("cron"), mode = $("mode"), preview = $("preview");
  const tzInput = document.querySelector('input[name="timezone"]');
  let timer;
  function build() {
    const m = mode.value;
    const [hh, mm] = ($("time").value || "06:00").split(":").map(Number);
    const minute = Math.min(59, Math.max(0, Number($("minute").value) || 0));
    switch (m) {
      case "default": return "";
      case "hourly": return minute + " * * * *";
      case "every": return minute + " */" + $("every").value + " * * *";
      case "daily": return mm + " " + hh + " * * *";
      case "weekdays": return mm + " " + hh + " * * 1-5";
      case "weekly": return mm + " " + hh + " * * " + $("weekday").value;
      default: return cron.value;
    }
  }
  function show() {
    const m = mode.value;
    box.querySelectorAll("[data-show]").forEach((el) => {
      el.style.display = el.dataset.show.split(" ").includes(m) ? "" : "none";
    });
  }
  function refresh(fromCron) {
    if (!fromCron) cron.value = build();
    show();
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const expr = cron.value || box.dataset.default;
      if (!expr) { preview.textContent = ""; return; }
      const q = new URLSearchParams({ cron: expr, tz: tzInput ? tzInput.value : "" });
      try {
        const r = await (await fetch("/api/cron-preview?" + q, { credentials: "same-origin" })).json();
        preview.textContent = r.ok ? r.description + " · next: " + r.next.join(", ") : "⚠ " + r.error;
        preview.style.color = r.ok ? "" : "var(--bad)";
      } catch {}
    }, 250);
  }
  box.querySelectorAll("select, input:not([data-s=cron])").forEach((el) => el.addEventListener("input", () => refresh(false)));
  cron.addEventListener("input", () => { mode.value = "custom"; refresh(true); });
  if (tzInput) tzInput.addEventListener("change", () => refresh(true));
  refresh(true);
});`;
