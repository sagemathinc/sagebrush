// The terminal panel's renderer (web/shell/panel-render.ts; plan-bash-shell r8c E5.3, E5.4): line ends, SGR, visible
// escapes, and the per-command caps with the omission line charged.  A first set (the preview); E5.8's full list
// follows in step 6's PR.
//   bun web/shell/test-panel-render.mjs
import { Render, CAPS, SCROLLBACK, classOf, applySgr, utf8Bytes, evictCount, dropMarker } from "./panel-render.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => {
  checks++;
  if (!ok) fails.push(what);
};
const ALL = { bytes: Infinity, spans: Infinity, ms: Infinity };
function render(out, err = "") {
  const r = new Render(out, err, () => 0);
  const runs = [];
  for (let s; (s = r.next(ALL)); ) runs.push(...s);
  return { runs, text: runs.map((x) => x.text).join(""), totals: r.totals };
}
const PLAIN = { fg: -1, bg: -1, b: false, i: false, u: false, rev: false };

// line ends
check(render("a\r\nb\n").text === "a\nb\n", "\\r\\n -> \\n");
check(render("10%\r50%\r100%\n").text === "100%\n", "a lone \\r keeps the text after the last one");
check(render("a\tb").text === "a\tb", "tabs kept");

// SGR
check(render("\x1b[31mred\x1b[0m plain").runs[0].cls === "sb-fg-1", "31 -> sb-fg-1");
check(render("\x1b[01;34mx").runs[0].cls === "sb-fg-4 sb-b", "leading zeros allowed (01;34)");
check(render("\x1b[1mx\x1b[mY").runs.at(-1).cls === "", "ESC[m resets (an empty parameter is 0)");
check(render("\x1b[;1mx").runs[0].cls === "sb-b", "ESC[;1m: empty then 1");
check(render("\x1b[38;5;196mx\x1b[38;2;1;2;3my").text === "xy" && render("\x1b[38;5;196mx").runs[0].cls === "", "38;5;n and 38;2;r;g;b consumed and ignored");
check(render("\x1b[2;5;9;53mx").runs[0].cls === "", "faint, blink, strike, 53: ignored, not shown");
check(render("\x1b[91;102mx").runs[0].cls === "sb-fg-9 sb-bg-10", "bright 90-97 / 100-107");
check(classOf(applySgr(PLAIN, [7])) === "sb-fg-rev sb-bg-rev", "reverse with both defaults swaps them");
check(classOf(applySgr(PLAIN, [31, 7])) === "sb-fg-rev sb-bg-1", "reverse of fg 1 on the default bg");
check(classOf(applySgr(applySgr(PLAIN, [7]), [27])) === "", "27 restores the order");
check(classOf(applySgr(PLAIN, [44])) === "sb-fga-4 sb-bg-4", "a background alone: the auto fg class");
check(/^sb-[a-z0-9 -]*$/.test(classOf(applySgr(PLAIN, [1, 3, 4, 33, 45]))), "classes from the fixed table");

// visible escapes and controls (no HTML is ever produced: runs are text, and the panel makes text nodes)
check(render("\x1b[2J").text === "␛[2J", "a CSI cursor move is shown");
check(render("\x1b]0;title\x07").text === "␛]0;title␇", "OSC and BEL shown");
check(render("a\x00b\x7f").text === "a␀b␡", "NUL and DEL shown");
check(render("\x1b").text === "␛", "a lone ESC shown");
check(render("<b>&amp;</b>").text === "<b>&amp;</b>", "markup is text");

// stderr: marked, on its own line
{
  const r = render("out", "err\n");
  check(r.text === "out\nerr\n" && r.runs.at(-1).err === true && r.runs[0].err === false, "stderr marked, on its own line");
}

// S1: 1 MiB consumed, 64 KiB kept for stderr, cut at a scalar boundary; the exact omitted count
{
  const big = "€".repeat(400000); // 3 bytes each: 1 200 000 bytes
  const r = render(big, "E".repeat(70000));
  const shownOut = r.runs.filter((x) => !x.err && x.cls !== "sb-omit").map((x) => x.text).join("").replace(/\n/g, "");
  const shownErr = r.runs.filter((x) => x.err).map((x) => x.text).join("").replace(/\n/g, "");
  check(utf8Bytes(shownOut) === CAPS.inBytes - CAPS.errReserve - ((CAPS.inBytes - CAPS.errReserve) % 3), "stdout cut at a scalar boundary within its budget");
  check(shownErr.length === CAPS.errReserve, "stderr keeps its reserve");
  const omitted = utf8Bytes(big) + 70000 - utf8Bytes(shownOut) - utf8Bytes(shownErr);
  check(r.runs.at(-1).text.replace(/^\n/, "") === `[… ${omitted} more bytes not shown]` && r.totals.omitted === omitted, `the exact omitted count (${r.runs.at(-1).text} vs ${omitted})`);
}
{
  // (an SGR token straddling the cut is never split: it is consumed whole or not at all)
  const pad = "x".repeat(CAPS.inBytes - 3);
  const r = render(pad + "\x1b[31mred");
  check(!r.text.includes("␛"), "an SGR token at the cut isn't shown as a broken escape");
}

// S2: lines, markers included
{
  const r = render("l\n".repeat(6000));
  check(r.totals.lines <= CAPS.lines, `lines capped with the marker (${r.totals.lines})`);
  check(r.runs.at(-1).cls === "sb-omit", "the omission line ends a capped command");
  const shownLines = r.text.split("\n");
  check(shownLines.length === CAPS.lines && shownLines.slice(0, CAPS.lines - 1).every((x) => x === "l") && shownLines.at(-1).startsWith("[\u2026"), `6 000 lines: the first ${CAPS.lines - 1} content lines, then the omission line (${shownLines.length} lines)`);
}
{
  // (exactly CAPS.lines - 1 lines: all shown, nothing omitted; one more: the omission line)
  const at = render("l\n".repeat(CAPS.lines - 1));
  check(at.totals.omitted === 0 && at.text === "l\n".repeat(CAPS.lines - 1), "4 999 lines: all shown, no omission line");
  const past = render("l\n".repeat(CAPS.lines));
  check(past.totals.omitted === 2 && past.runs.at(-1).cls === "sb-omit" && past.totals.lines <= CAPS.lines, `5 000 lines: one past, the last omitted (${JSON.stringify(past.totals)})`);
}
// S2: spans
{
  const r = render("\x1b[31ma\x1b[32mb".repeat(15000));
  check(r.totals.spans <= CAPS.spans, `spans capped (${r.totals.spans})`);
}

// slices: a budget ends a slice; everything still comes out once
{
  const r = new Render("a\n".repeat(5000), "", () => 0);
  let n = 0, text = "";
  for (let s; (s = r.next({ bytes: 1000, spans: Infinity, ms: Infinity })); n++) text += s.map((x) => x.text).join("");
  check(n >= 10 && text === "a\n".repeat(4999).slice(0, -1) + "\n" + text.slice(text.lastIndexOf("[")), `sliced (${n} slices)`);
}

// S1/S2: dense controls, dense unknown escapes, plain text at the units cap; the omitted count is exactly the
// original bytes minus the consumed ones, and every per-command total stays within its cap, markers included
for (const [what, out] of [
  ["dense NUL and controls", "\x00\x01\x07\x7f".repeat(300000)],
  ["dense unknown escapes", "\x1b[2J\x1b]0;t\x07".repeat(120000)],
  ["plain text at the units cap", "a".repeat(CAPS.inBytes)],
  ["one line per scalar, 6 000 lines", "\u00e9\n".repeat(6000)],
]) {
  const r = new Render(out, "", () => 0);
  const runs = [];
  for (let sl; (sl = r.next(ALL)); ) runs.push(...sl);
  const t = r.totals;
  const text = runs.map((x) => x.text).join("");
  check(t.units <= CAPS.units && t.lines <= CAPS.lines && t.spans <= CAPS.spans && text.length === t.units, `${what}: within the per-command caps (${JSON.stringify(t)})`);
  check(t.omitted === r.totalBytes - t.consumed, `${what}: omitted = original bytes - consumed (${t.omitted})`);
  check(t.omitted === 0 ? runs.at(-1)?.cls !== "sb-omit" : runs.at(-1).text.replace(/^\n/, "") === `[\u2026 ${t.omitted} more bytes not shown]`, `${what}: the omission line says exactly that`);
}

// the scrollback (E5.4): evictCount at each cap's value and one past, several commands whose sum crosses each cap,
// the marker charged to every cap (its digits growing), the newest command never dropped
const sum = (cs) => cs.reduce((a, c) => ({ units: a.units + c.units, lines: a.lines + c.lines, spans: a.spans + c.spans }), { units: 0, lines: 0, spans: 0 });
function fitsAfter(cmds, slice, dropped, k) {
  const t = sum(cmds.slice(k)), d = dropped + k;
  const mu = d ? dropMarker(d).length : 0, m1 = d ? 1 : 0;
  return t.units + slice.units + mu <= SCROLLBACK.units && t.lines + slice.lines + m1 <= SCROLLBACK.lines && t.spans + slice.spans + m1 <= SCROLLBACK.spans;
}
function evicts(what, cmds, slice, dropped, want) {
  const k = evictCount(cmds, slice, dropped);
  const ok = k <= cmds.length - 1 && fitsAfter(cmds, slice, dropped, k) && (k === 0 || !fitsAfter(cmds, slice, dropped, k - 1));
  check(ok && (want === undefined || k === want), `scrollback, ${what}: drops ${k}${want === undefined ? "" : ` (want ${want})`}, the least that fits with the marker`);
}
const Z = { units: 0, lines: 0, spans: 0 };
for (const key of ["units", "lines", "spans"]) {
  const cap = SCROLLBACK[key];
  const old = { ...Z, [key]: Math.floor(cap / 2) }, newest = { ...Z };
  const exact = { ...Z, [key]: cap - old[key] };
  evicts(`${key} exactly at the cap`, [old, newest], exact, 0, 0);
  evicts(`${key} one past the cap`, [old, newest], { ...Z, [key]: exact[key] + 1 }, 0, 1);
  // (several commands whose sum crosses the cap)
  const per = Math.floor(cap / 7);
  const many = Array.from({ length: 9 }, () => ({ ...Z, [key]: per }));
  evicts(`${key}: nine commands' sum crossing it`, many, { ...Z, [key]: per }, 0);
  // (a marker already there: its room is part of the fit)
  evicts(`${key}: with 3 dropped before, exactly at the cap less the marker`, [old, newest], { ...Z, [key]: cap - old[key] - (key === "units" ? dropMarker(3).length : 1) }, 3, 0);
  evicts(`${key}: with 3 dropped before, one past`, [old, newest], { ...Z, [key]: cap - old[key] - (key === "units" ? dropMarker(3).length : 1) + 1 }, 3, 1);
}
// (the marker's own length grows from 9 to 10: charged at its new length)
{
  const cap = SCROLLBACK.units;
  const a = { ...Z, units: 1000 }, b = { ...Z, units: 1000 };
  const slice = { ...Z, units: cap - 1000 - dropMarker(10).length };
  evicts("units: the marker growing from 9 to 10 dropped", [a, b], slice, 9, 1);
}
// (the newest command alone is never dropped, even if a slice can't fit: the per-command caps make that impossible)
check(evictCount([{ ...Z, units: 5 }], { ...Z, units: SCROLLBACK.units * 2 }, 0) === 0, "scrollback: the newest command is never dropped");
check(CAPS.units + 2 * 256 + dropMarker(1e6).length <= SCROLLBACK.units && CAPS.lines + 2 + 1 <= SCROLLBACK.lines && CAPS.spans + 2 + 1 <= SCROLLBACK.spans,
  "scrollback: a command at its own caps, with its prompt and exit lines and the marker, always fits");

if (fails.length) {
  console.log(`test-panel-render: ${fails.length} of ${checks} FAILED:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`test-panel-render: all ${checks} checks pass`);
