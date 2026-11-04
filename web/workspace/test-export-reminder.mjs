// ci: web-browser/board-unit.2 order=160 runner=bun
// The Storage panel's export reminder (web/workspace/preview.ts exportReminder): when it is due, and its words.
//   bun web/workspace/test-export-reminder.mjs
import { EXPORT_DUE_DAYS, exportReminder, exportStatus } from "./preview.ts";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const D = 86_400_000, now = Date.UTC(2026, 10, 2, 12);
const last = (days, partial = false) => ({ at: now - days * D, partial });
check(EXPORT_DUE_DAYS === 7, `due after ${EXPORT_DUE_DAYS} days`);
check(exportReminder(last(7), true, now) === null, "exactly 7 days: not yet due");
check(exportReminder({ at: now - 7 * D - 1, partial: false }, true, now) === "Last export: 7 days ago", "7 days and 1 ms: due, \"Last export: 7 days ago\"");
check(exportReminder(last(9), true, now) === "Last export: 9 days ago", "9 days: \"Last export: 9 days ago\"");
check(exportReminder(last(9), false, now) === "Last export: 9 days ago", "an old export is due even if the workspace is empty now");
check(exportReminder(undefined, true, now) === "No export yet", "none, with files: \"No export yet\"");
check(exportReminder(undefined, false, now) === null, "none, and nothing to export: no reminder");
check(exportReminder(last(1, true), true, now) === "Last export: yesterday, partial", "a partial export doesn't count: due, and said");
check(exportReminder(last(0.5), true, now) === null, "12 hours ago: no reminder");
check(exportStatus(last(3), now) === "Last export prepared on this device: 3 days ago", "the plain status line unchanged");
const fails = results.filter(([ok]) => !ok).map(([, w]) => w);
if (fails.length) { console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  ")); process.exit(1); }
console.log(`ok: the export reminder, ${results.length} checks`);
