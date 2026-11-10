import type { SyncPeriod } from "../../providers/base.js";
import { EVERY_HOURS, MONTH_DAYS, WEEKDAYS, halfYearMonths, cronPreview, cronPreviewText, describeCron, ordinal, parseCron, type ScheduleMode } from "../../schedule.js";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Schedule picker. Posts a cron string as `name`; "" means "use default"
 * when `defaultCron` is given (connection override).
 */
export function ScheduleField(p: { name: string; label: string; value: string | null; defaultCron?: string; timezone: string }) {
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
    ["monthly", "Monthly"],
    ["halfyearly", "Every 6 months"],
    ["custom", "Custom (cron)"],
  );
  // Hidden server-side too, so the script doesn't shift the layout on load.
  const hide = (modes: string) => (modes.split(" ").includes(mode) ? "" : "display:none;");
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
          <select data-s="every" data-show="every" style={`${hide("every")}width:auto`}>
            {EVERY_HOURS.map((h) => (
              <option value={String(h)} selected={h === spec.everyHours}>
                every {h} hours
              </option>
            ))}
          </select>
          <select data-s="weekday" data-show="weekly" style={`${hide("weekly")}width:auto`}>
            {WEEKDAYS.map((d, i) => (
              <option value={String(i)} selected={i === spec.weekday}>
                on {d}
              </option>
            ))}
          </select>
          <select data-s="halfmonth" data-show="halfyearly" style={`${hide("halfyearly")}width:auto`}>
            {[1, 2, 3, 4, 5, 6].map((m) => (
              <option value={String(m)} selected={m === spec.month}>
                in {halfYearMonths(m)}
              </option>
            ))}
          </select>
          <select data-s="monthday" data-show="monthly halfyearly" style={`${hide("monthly halfyearly")}width:auto`}>
            {MONTH_DAYS.map((d) => (
              <option value={String(d)} selected={d === spec.dayOfMonth}>
                on the {ordinal(d)}
              </option>
            ))}
          </select>
          <span data-show="daily weekdays weekly monthly halfyearly" class="row" style={hide("daily weekdays weekly monthly halfyearly")}>
            at <input type="time" data-s="time" value={`${pad(spec.hour)}:${pad(spec.minute)}`} style="width:auto" />
          </span>
          <span data-show="hourly every" class="row" style={hide("hourly every")}>
            at minute <input type="number" data-s="minute" min="0" max="59" value={String(spec.minute)} style="width:5em" />
          </span>
        </div>
      </label>
      <label class="cron-line">
        <small>cron</small>
        <input type="text" name={p.name} value={useDefault ? "" : spec.cron} data-s="cron" placeholder={p.defaultCron ?? ""} />
      </label>
      {/* Rendered with the page (and a fixed height) so it doesn't shift the layout when it updates. */}
      <small class="hint preview" data-s="preview" >
        {cronPreviewText(cronPreview(p.value || p.defaultCron || "", p.timezone))}
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
      case "monthly": return mm + " " + hh + " " + $("monthday").value + " * *";
      case "halfyearly": return mm + " " + hh + " " + $("monthday").value + " " + $("halfmonth").value + "," + (Number($("halfmonth").value) + 6) + " *";
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
        preview.title = preview.textContent;
        preview.style.color = r.ok ? "" : "var(--bad)";
      } catch {}
    }, 250);
  }
  box.querySelectorAll("select, input:not([data-s=cron])").forEach((el) => el.addEventListener("input", () => refresh(false)));
  cron.addEventListener("input", () => { mode.value = "custom"; refresh(true); });
  if (tzInput) tzInput.addEventListener("change", () => refresh(true));
  // The server already rendered the preview: just set up visibility, no fetch.
  show();
});`;
