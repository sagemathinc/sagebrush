// ci: checks.3 order=113 runner=bun
// A value a Run didn't reach keeps its value from an earlier run (@sagebrush's ruling, Nov 12; board's words): an item
// after a failed one, or one the Run never got to (stopped, or the session ended), whose code is the very code of that
// earlier value, shows it marked out of date, its title saying why; one with no such value shows its chip as before.
// The same in the preview (and so Present) and in the results file, so a reload shows the same.
//   bun web/latex/test-latex-kept-values.mjs
import { Engine } from "./engine/pipeline.mjs";
import { itemKey, KEPT, STALE_TITLE, BLOCKED, interactsAt } from "./engine/sagetex.mjs";
import { setKatex } from "./engine/render.mjs";
import { keepLast, statesOf, tally, resultsText } from "./run-core.mjs";
import { interactsHtml } from "./interact.ts";
setKatex((src) => "<span class=\"katex\">" + src.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]) + "</span>");

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 900)); };
const DOC = "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\nA: \\sage{1+1}\n\nB: \\sage{3+3}\n\nC: \\sage{2+2}\n\nD: $x = \\sage{5}$\n\\end{document}\n";
const items = new Engine().update(DOC).sageItems.map((it) => ({ key: itemKey(it), mode: it.mode, code: it.code }));
const keys = items.map((x) => x.key);
const before = [{ key: keys[0], s: "ok", latex: "2" }, { key: keys[1], s: "ok", latex: "6" }, { key: keys[2], s: "ok", latex: "4" }, { key: keys[3], s: "ok", latex: "5" }];
const ok = (latex) => ({ s: "ok", latex });

// an item after a failed one
{
  const st = keepLast(statesOf(items, [ok("2"), { s: "error", msg: "NameError: x" }], null), items, before, null);
  check("after a failed item: the failed one shows its error", st[1].s === "error" && /NameError/.test(st[1].msg), st[1]);
  check("after a failed item: the next keeps its earlier value, stale, saying why", st[2].s === "stale" && st[2].latex === "4" && st[2].why === "failed", st[2]);
  check("after a failed item: the status counts it as not run", JSON.stringify(tally(st)) === JSON.stringify({ ran: 2, failed: 1 }), tally(st));
  const file = JSON.parse(resultsText(st));
  check("the results file keeps it so (stale, why, its value), without the tally's mark", file.items[2].s === "stale" && file.items[2].why === "failed" && file.items[2].latex === "4" && !("ran" in file.items[2]), file.items[2]);
}
// the Run stopped, and the session ended
{
  const st = keepLast(statesOf(items, [ok("2")], "the run was stopped"), items, before, "the run was stopped");
  check("stopped: an item not reached keeps its value, saying the run was stopped", st[1].s === "stale" && st[1].latex === "6" && st[1].why === "stopped" && st[3].why === "stopped", [st[1], st[3]]);
  const e = keepLast(statesOf(items, [ok("2")], null), items, before, null);
  check("the session ended: kept, saying so", e[1].s === "stale" && e[1].why === "ended", e[1]);
}
// no earlier value for this code: the chip, as before
{
  const st = keepLast(statesOf(items, [ok("2"), { s: "error", msg: "boom" }], null), items, [before[0], before[1], { key: "an older code's key", s: "ok", latex: "99" }], null);
  check("a changed item with no earlier value of its code shows its chip", st[2].s === "blocked" && st[2].msg === BLOCKED && st[2].latex === undefined, st[2]);
  check("no earlier results at all: the chips, as before", keepLast(statesOf(items, [ok("2")], "the run was stopped"), items, [], "the run was stopped").slice(1).every((x) => x.s === "error"));
}
// a refused item is never kept; a value kept once can be kept again (from an earlier run, not the last)
{
  const refused = items.map((x, i) => (i === 1 ? { ...x, err: "unbalanced" } : x));
  const st = keepLast(statesOf(refused, [ok("2")], null), refused, before, null);
  check("a refused item keeps nothing (its own error)", st[1].s === "error" && st[1].latex === undefined, st[1]);
  const kept = keepLast(statesOf(items, [ok("2"), { s: "error", msg: "boom" }], null), items, before, null);
  const again = keepLast(statesOf(items, [ok("2"), { s: "error", msg: "boom" }], null), items, kept, null);
  check("a value kept once is kept again", again[2].s === "stale" && again[2].latex === "4" && again[2].why === "failed", again[2]);
}

// shown: the preview reads the file's kept values back, each with its own title; an unknown why is never shown
{
  const st = keepLast(statesOf(items, [ok("2"), { s: "error", msg: "boom" }], null), items, before, null);
  const saved = JSON.parse(resultsText(st)).items;
  const html = new Engine({ sage: { saved } }).update(DOC, { cold: true }).chunks.join("\n");
  const titles = [...html.matchAll(/class="sagestale" title="([^"]*)"/g)].map((m) => m[1]);
  check("the preview: kept values shown out of date, the title saying why (inline and in math)", titles.length === 2 && titles.every((t) => t === KEPT.failed) && html.includes(">4</span>") && html.includes("x = {5}"), { titles, html: html.slice(0, 700) });
  const forged = saved.map((x) => (x.s === "stale" ? { ...x, why: "toString" } : x));
  const h2 = new Engine({ sage: { saved: forged } }).update(DOC, { cold: true }).chunks.join("\n");
  check("an unknown why in the file: the generic title, never its text",  h2.includes('title="' + STALE_TITLE + '"'), h2.slice(0, 600));
}
// an interact kept: its placeholder carries the title, drawn with it
{
  const at = interactsAt([{ id: 1, controls: [], out: "", shows: [] }], (s) => String(s).replace(/"/g, "&quot;"), KEPT.stopped);
  check("an interact kept: its placeholder carries why", at.includes('data-stale="' + KEPT.stopped + '"'), at);
  const drawn = interactsHtml([{ id: 1, controls: [], out: "", shows: [] }], KEPT.stopped);
  check("an interact kept: drawn with why as its title", drawn.includes('sagestale" title="' + KEPT.stopped + '"'), drawn);
  check("an interact whose code changed: the generic title", interactsHtml([{ id: 1, controls: [], out: "", shows: [] }], true).includes('title="' + STALE_TITLE + '"'));
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}` : `ok: values kept from an earlier run, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
