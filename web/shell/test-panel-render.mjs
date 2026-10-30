// The terminal panel's renderer (web/shell/panel-render.ts; plan-bash-shell r8c E5.3, E5.4): line ends, SGR, visible
// escapes, and the per-command caps with the omission line charged.  A first set (the preview); E5.8's full list
// follows in step 6's PR.
//   bun web/shell/test-panel-render.mjs
import { Render, CAPS, SCROLLBACK, PAGE, PAGE_BACK, classOf, applySgr, utf8Bytes, evictCount, dropMarker } from "./panel-render.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => {
  checks++;
  if (!ok) fails.push(what);
};
const ALL = { bytes: Infinity, spans: Infinity, ms: Infinity };
// (as web/shell/panel.ts paints: a restart run takes back the open line's runs, those since its last line end)
function apply(runs) {
  const kept = [];
  let open = 0;
  for (const x of runs) {
    if (x.restart) {
      kept.splice(kept.length - open, open);
      open = 0;
      continue;
    }
    kept.push(x);
    open = x.text.endsWith("\n") ? 0 : open + 1;
  }
  return kept;
}
function render(out, err = "", budget = ALL, now = () => 0) {
  const r = new Render(out, err, now);
  const raw = [];
  for (let s; (s = r.next(budget)); ) raw.push(...s);
  const runs = apply(raw);
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

// TP-2: a lone \r over a line longer than one slice: the same text whatever the slicing (bytes, runs, a clock whose
// 8 ms cut falls mid-line), and the totals take the dropped runs back
{
  const prog = Array.from({ length: 20001 }, (_, i) => "\rprogress " + String(i).padStart(5)).join("") + "\n" +
    "\x1b[32mok\x1b[0m " + Array.from({ length: 3000 }, (_, i) => "\r\x1b[31m" + i + "\x1b[0m%").join("") + "\n";
  const want = render(prog).text;
  let tick = 0;
  const budgets = [["one byte", { bytes: 1, spans: Infinity, ms: Infinity }], ["one run", { bytes: Infinity, spans: 1, ms: Infinity }],
    ["the shipped slice", { bytes: 65536, spans: 1000, ms: Infinity }], ["8 ms on an advancing clock", { bytes: Infinity, spans: Infinity, ms: 8 }]];
  check(want === "progress 20000\n2999%\n", `a progress line, one slice: ${JSON.stringify(want)}`);
  for (const [what, b] of budgets) {
    const r = render(prog, "", b, what.startsWith("8 ms") ? () => (tick += 0.37) : () => 0);
    check(r.text === want && r.totals.units === want.length, `a progress line, sliced by ${what}: the same text (${JSON.stringify(r.text.slice(0, 60))}), units ${r.totals.units}`);
  }
}

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
  check(t.omitted === utf8Bytes(out) - t.consumed, `${what}: omitted = original bytes - consumed (${t.omitted})`);
  check(t.omitted === 0 ? runs.at(-1)?.cls !== "sb-omit" : runs.at(-1).text.replace(/^\n/, "") === `[\u2026 ${t.omitted} more bytes not shown]`, `${what}: the omission line says exactly that`);
}

// E5.5 (DB2-TERM-326-1): no slice scans more than its byte budget, construction included: a 32 MiB result whose
// 31 MiB tail is omitted takes many slices, each charged at most its 64 KiB plus one token (a plain run: 4 096
// scalars, at most 16 KiB), and the omitted count is still exact
{
  const MiB = 1048576, BUDGET = { bytes: 65536, spans: Infinity, ms: Infinity };
  const tail = "\u00e9".repeat(16 * MiB); // 2 bytes each: 32 MiB
  const err = "e".repeat(MiB);
  const r = new Render(tail, err, () => 0);
  let calls = 0, maxStep = 0, prev = 0;
  for (let sl; (sl = r.next(BUDGET)); calls++) {
    const t = r.totals, done = t.consumed + t.work;
    maxStep = Math.max(maxStep, done - prev);
    prev = done;
  }
  const t = r.totals;
  check(maxStep <= 65536 + 16384, `a large omitted tail: every slice's scan within its budget plus one token (max ${maxStep} B)`);
  check(calls >= Math.floor((32 * MiB + MiB) / (65536 + 16384)), `a large omitted tail takes many slices (${calls})`);
  check(t.omitted === 32 * MiB + MiB - t.consumed, `a large omitted tail: the omitted count exact (${t.omitted})`);
}

// DB2-TERM-326-1 r2: the scans look at the clock too: on a clock that advances 1 ms per look and an 8 ms budget (no
// byte limit), the stderr reservation and the omitted tail each end their slice within a bounded number of scalars,
// and the result is the same
{
  const MiB = 1048576;
  const tail = "\u00e9".repeat(4 * MiB), err = "e".repeat(MiB);
  let clock = 0;
  const r = new Render(tail, err, () => clock++);
  let calls = 0, maxStep = 0, prev = 0;
  for (let sl; (sl = r.next({ bytes: Infinity, spans: Infinity, ms: 8 })); calls++) {
    const t = r.totals, done = t.consumed + t.work;
    maxStep = Math.max(maxStep, done - prev);
    prev = done;
  }
  const t = r.totals;
  check(maxStep <= 8 * 4 * 4096 + 16384 && calls > 100, `an advancing clock: every slice's scan bounded by its clock checks (max ${maxStep} B, ${calls} slices)`);
  check(t.omitted === 8 * MiB + MiB - t.consumed, `an advancing clock: the omitted count exact (${t.omitted})`);
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

// TP-9: no class name outside the fixed table: every SGR parameter 0..255, alone, after 7, and in 38/48 forms
{
  const TABLE = new Set(["sb-fg-rev", "sb-bg-rev", "sb-b", "sb-i", "sb-u"]);
  for (let i = 0; i < 16; i++) for (const k of ["fg", "bg", "fga"]) TABLE.add(`sb-${k}-${i}`);
  const seen = new Set();
  const forms = [];
  for (let p = 0; p < 256; p++) forms.push([p], [7, p], [p, 7], [38, 5, p], [48, 5, p], [38, 2, p, p, p], [48, 2, p, 0, p], [p, 41, 7], [p, 102]);
  for (const ps of forms) for (const c of classOf(applySgr(PLAIN, ps)).split(" ").filter(Boolean)) seen.add(c);
  for (const ps of forms) {
    const r = render(`\x1b[${ps.join(";")}mx`);
    for (const x of r.runs) for (const c of x.cls.split(" ").filter(Boolean)) seen.add(c);
  }
  const outside = [...seen].filter((c) => !TABLE.has(c));
  check(outside.length === 0 && seen.size >= 50, `every class from the fixed table (${seen.size} seen${outside.length ? "; outside: " + outside.join(" ") : ""})`);
}

// TP-9: both themes' contrast, computed from the palette the panel injects: each of the 16 >= 4.5:1 on its theme's
// background (min 4.91 light, 6.15 dark), and the background-only rule (sb-fga-N: the theme's bg as text) the better
// of the theme's fg and bg on every one of the 16
{
  const { palette } = await import("./panel.ts");
  const css = palette();
  const blocks = [...css.matchAll(/\{([^{}]*--sb-term-c0[^{}]*)\}/g)].map((m) => Object.fromEntries([...m[1].matchAll(/--sb-term-(\w+):(#[0-9a-f]{6})/g)].map((x) => [x[1], x[2]]))).filter((b) => b.c0 && b.bg);
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = (h) => 0.2126 * lin(parseInt(h.slice(1, 3), 16)) + 0.7152 * lin(parseInt(h.slice(3, 5), 16)) + 0.0722 * lin(parseInt(h.slice(5, 7), 16));
  const cr = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  check(blocks.length === 3 && JSON.stringify(blocks[1]) === JSON.stringify(blocks[2]), `the palette: light, dark, and dark again for the system setting (${blocks.length} blocks)`);
  for (const [name, t, minWant] of [["light", blocks[0], 4.91], ["dark", blocks[1], 6.15]]) {
    const ratios = Array.from({ length: 16 }, (_, i) => cr(t["c" + i], t.bg));
    const min = Math.min(...ratios);
    check(min >= 4.5 && Math.abs(min - minWant) < 0.005, `${name}: every colour >= 4.5:1 on the background (min ${min.toFixed(2)})`);
    check(Array.from({ length: 16 }, (_, i) => cr(t.bg, t["c" + i]) >= cr(t.fg, t["c" + i])).every(Boolean), `${name}: on each colour as a background, the theme's bg reads better than its fg (sb-fga-N)`);
  }
}

// ---- long lines: pages of PAGE units (the long-line design: pages, not a cap; @sagebrush, board, daybreak2)
{
  // (the pages of each line: the text of each page, its first one the part before any page run)
  const pagesOf = (runs) => {
    const lines = [];
    let cur = [""];
    for (const x of runs) {
      if (x.page) cur.push("");
      else {
        const parts = x.text.split("\n");
        cur[cur.length - 1] += parts[0];
        for (const q of parts.slice(1)) (lines.push(cur), (cur = [q]));
      }
    }
    if (cur.join("")) lines.push(cur);
    return lines;
  };
  const pageRuns = (runs) => runs.filter((x) => x.page).length;
  // (every join at a grapheme-cluster boundary of the whole line, by its own Intl.Segmenter pass: B-LL-1)
  const atBounds = (ps) => {
    const b = new Set([...new Intl.Segmenter().segment(ps.join(""))].map((g) => g.index));
    let at = 0;
    return ps.slice(0, -1).every((p) => b.has((at += p.length)));
  };
  // (at 4 095, 4 096 and 4 097 units: no page, no page, one)
  for (const [n, want] of [[PAGE - 1, 0], [PAGE, 0], [PAGE + 1, 1]]) {
    const r = render("a".repeat(n) + "\n");
    check(pageRuns(r.runs) === want && r.text === "a".repeat(n) + "\n", `a line of ${n} units: ${want} page run(s)`);
  }
  // (every page at most PAGE units; the text the same as without pages)
  const big = render("x".repeat(3 * PAGE + 100) + "\n");
  const pg = pagesOf(big.runs)[0];
  check(pg.length === 4 && pg.every((p) => p.length <= PAGE) && pg.join("") === "x".repeat(3 * PAGE + 100), `a line of 3 pages and 100: pages ${pg.map((p) => p.length).join(", ")}`);
  // (astral pairs and clusters never split at a join, and no page starts with a continuation: B-LL-1)
  const cases = [
    ["an astral pair across the edge", "a".repeat(PAGE - 1) + "\u{1d7d8}".repeat(10)],
    ["a combining mark at the edge", "a".repeat(PAGE - 1) + "é" + "b".repeat(10)],
    ["a ZWJ emoji at the edge", "a".repeat(PAGE - 3) + "\u{1f469}‍\u{1f4bb}" + "b".repeat(10)],
    ["a variation selector at the edge", "a".repeat(PAGE - 1) + "❤️" + "b".repeat(10)],
    ["a skin-tone modifier at the edge", "a".repeat(PAGE - 2) + "\u{1f44d}\u{1f3fd}" + "b".repeat(10)],
    ["a flag (a regional-indicator pair) on the edge (BLL1-R1)", "a".repeat(PAGE - 2) + "\u{1f1f8}\u{1f1ea}" + "b".repeat(10)],
    ["a Hangul L+V+T syllable on the edge (BLL1-R1)", "a".repeat(PAGE - 2) + "\u1100\u1161\u11a8" + "b".repeat(10)],
  ];
  for (const [what, line] of cases) {
    const r = render(line + "\n");
    const ps = pagesOf(r.runs)[0];
    const ok = ps.join("") === line && ps.every((p) => p.length <= PAGE) && atBounds(ps);
    check(ok, `${what}: the cluster kept whole, no page over ${PAGE} (pages ${ps.map((p) => p.length).join(", ")})`);
  }
  // (the finite cluster policy, @sagebrush's ruling on DB2-LL-337-1 with board's CONCUR: a join moves back at most
  // PAGE_BACK units to its cluster's start, on the logical line (across slice flushes and style runs); a longer
  // cluster is split at a scalar boundary.  Each at three slicings)
  {
    let tick = 0;
    const slicings = [["one slice", ALL, () => 0], ["one byte", { bytes: 1, spans: Infinity, ms: Infinity }, () => 0],
      ["the shipped slice", { bytes: 65536, spans: 1000, ms: Infinity }, () => 0], ["an advancing clock", { bytes: Infinity, spans: Infinity, ms: 8 }, () => (tick += 0.37)]];
    const M = "\u0301";
    const kept = (what, input, plain, firstLen, firstStart) => {
      for (const [how, b, now] of slicings) {
        const r = render(input + "\n", "", b, now);
        const ps = pagesOf(r.runs)[0];
        const ok = ps.join("") === plain && ps.every((p) => p.length <= PAGE) && ps[0].length === firstLen && ps[1]?.startsWith(firstStart) &&
          ps.slice(1).every((p) => !/^[\udc00-\udfff]/.test(p)) && (firstLen === PAGE || firstLen === PAGE - 1 || atBounds(ps)) && r.totals.spans === r.runs.length + 1;
        check(ok, `${what}, ${how}: pages ${ps.map((p) => p.length).join(", ")}, page 2 starts ${JSON.stringify(ps[1]?.slice(0, 3))}, spans ${r.totals.spans} for ${r.runs.length} runs`);
      }
    };
    // (a cluster across a slice flush: the base ends the tokenizer's 4 096-scalar run, its marks start the next;
    // and an SGR that changes nothing between them, so the one-byte slicing flushes there)
    kept("a cluster across a slice flush", "a".repeat(PAGE - 1) + "e" + M + M + "b".repeat(20), "a".repeat(PAGE - 1) + "e" + M + M + "b".repeat(20), PAGE - 1, "e" + M);
    kept("a cluster across a flush at an SGR", "a".repeat(PAGE - 2) + "e" + "\x1b[0m" + M + M + M + "b".repeat(20), "a".repeat(PAGE - 2) + "e" + M + M + M + "b".repeat(20), PAGE - 2, "e" + M);
    // (a cluster over two style runs, its base inside a run: that run splits, its classes on both parts)
    {
      const input = "a".repeat(PAGE - 4) + "\x1b[31mxe\x1b[32m" + M + M + M + M + "\x1b[0m" + "b".repeat(20);
      kept("a cluster over two style runs", input, "a".repeat(PAGE - 4) + "xe" + M + M + M + M + "b".repeat(20), PAGE - 3, "e" + M);
      const r = render(input + "\n");
      const red = r.runs.filter((x) => x.cls === "sb-fg-1");
      check(red.length === 2 && red[0].text === "x" && red[1].text === "e", `the base's run split at the join, its classes on both: ${JSON.stringify(red.map((x) => x.text))}`);
    }
    // (a base 33 and 64 units back: kept whole, the page that much shorter)
    for (const back of [33, 40, PAGE_BACK]) {
      const line = "a".repeat(PAGE - back) + "e" + M.repeat(back + 10) + "b".repeat(20);
      kept(`a base ${back} units back`, line, line, PAGE - back, "e" + M);
    }
    // (BLL1-R1 at every slicing: a flag and a Hangul syllable across the edge move whole to the next page)
    kept("a flag on the edge", "a".repeat(PAGE - 2) + "\u{1f1f8}\u{1f1ea}" + "b".repeat(20), "a".repeat(PAGE - 2) + "\u{1f1f8}\u{1f1ea}" + "b".repeat(20), PAGE - 2, "\u{1f1f8}\u{1f1ea}");
    kept("a Hangul L+V+T syllable on the edge", "a".repeat(PAGE - 2) + "\u1100\u1161\u11a8" + "b".repeat(20), "a".repeat(PAGE - 2) + "\u1100\u1161\u11a8" + "b".repeat(20), PAGE - 2, "\u1100\u1161\u11a8");
    // (a cluster over PAGE_BACK: split at the edge, the defined behaviour; with astral marks, at a scalar boundary)
    {
      const line = "a".repeat(PAGE - 100) + "e" + M.repeat(200) + "b".repeat(20);
      kept("a cluster over PAGE_BACK, split at the edge", line, line, PAGE, M);
      const astral = "a".repeat(PAGE - 100) + "e" + "\u{1d167}".repeat(100) + "b".repeat(20);
      kept("a cluster of astral marks over PAGE_BACK, split at a scalar boundary", astral, astral, PAGE - 1, "\u{1d167}");
    }
    // (a cluster at the page's own start needs no move: a line of marks after one base, two pages over)
    {
      const line = "e" + M.repeat(3 * PAGE);
      const r = render(line + "\n");
      const ps = pagesOf(r.runs)[0];
      check(ps.join("") === line && ps.every((p) => p.length === PAGE || p === ps.at(-1)) && ps.length === 4, `one cluster longer than the line's pages: split at each edge (pages ${ps.map((p) => p.length).join(", ")})`);
    }
  }
  // (a styled run across a join: two runs with the same classes, each charged: B-LL-2)
  {
    const r = render("\x1b[31;1m" + "y".repeat(PAGE + 50) + "\x1b[0m\n");
    const styled = r.runs.filter((x) => x.cls && !x.page);
    check(styled.length === 2 && styled.every((x) => x.cls === "sb-fg-1 sb-b") && styled[0].text.length === PAGE && pageRuns(r.runs) === 1, `a styled run across a join: ${styled.length} runs of "${styled[0]?.cls}"`);
    check(r.totals.spans === r.runs.length + 1, `each part and the join charged as runs, plus the line end after the last page (${r.totals.spans} for ${r.runs.length} runs)`);
  }
  // (escapes and controls at a join: the same text as without pages)
  {
    const line = "z".repeat(PAGE - 3) + "\x1b[2J\x01\x1b]0;t\x07" + "\x1b[32mgreen\x1b[0m" + "w".repeat(PAGE);
    const r = render(line + "\n");
    const want = "z".repeat(PAGE - 3) + "␛[2J␁␛]0;t␇green" + "w".repeat(PAGE) + "\n";
    check(r.text === want && pagesOf(r.runs)[0].every((p) => p.length <= PAGE), "escapes and controls across a join: the same text, pages within PAGE");
  }
  // (TP-2's \r restart across joins and slices: the line shows its text after the last \r, at any slicing)
  {
    const line = Array.from({ length: 6 }, (_, i) => "\r" + String(i).repeat(PAGE + 300)).join("") + "\n";
    const want = "5".repeat(PAGE + 300) + "\n";
    let tick = 0;
    for (const [what, b, now] of [["one slice", ALL, () => 0], ["one byte", { bytes: 1, spans: Infinity, ms: Infinity }, () => 0],
      ["the shipped slice", { bytes: 65536, spans: 1000, ms: Infinity }, () => 0], ["an advancing clock", { bytes: Infinity, spans: Infinity, ms: 8 }, () => (tick += 0.37)]]) {
      const r = render(line, "", b, now);
      check(r.text === want && pageRuns(r.runs) === 1 && r.totals.units === want.length, `\\r over a paged line, ${what}: only the last text and its one join (units ${r.totals.units})`);
    }
  }
  // (the caps hold with pages: one 1 MiB line of alternating styles: runs <= 20 000 with the joins, units <= 1 MiB)
  {
    const r = render("\x1b[31ma\x1b[32mb".repeat(100000) + "\n" + "q".repeat(2 * CAPS.inBytes));
    const t = r.totals;
    check(t.spans <= CAPS.spans && t.units <= CAPS.units && t.lines <= CAPS.lines, `the caps hold on paged lines (${JSON.stringify({ units: t.units, spans: t.spans, lines: t.lines })})`);
    check(r.runs.at(-1).cls === "sb-omit", "and the omission line still ends a capped command");
  }
  // (a paged line cut by the caps: the omission line starts a line of its own, even when the slice before it ended on
  // a join, or the marker's slice has no other run)
  for (const [what, b] of [["one slice", ALL], ["the shipped slice", { bytes: 65536, spans: 1000, ms: Infinity }], ["4 Ki slices", { bytes: PAGE, spans: Infinity, ms: Infinity }]]) {
    const r = render("q".repeat(2 * CAPS.inBytes), "", b);
    const m = r.runs.at(-1);
    const ps = pagesOf(r.runs);
    check(m.cls === "sb-omit" && m.text.startsWith("\n") && ps.length === 2 && ps[0].every((p) => p.length <= PAGE) && r.totals.units <= CAPS.units,
      `a paged line past the unit cap, ${what}: the omission line on its own line (${JSON.stringify(m.text.slice(0, 12))}, pages ${ps[0].length})`);
  }
  // (past the run cap, a join costs a run: no page run ever holds text, and no page grows past PAGE)
  {
    const r = render("\x1b[31ma\x1b[32mb".repeat(15000) + "\x1b[0m" + "p".repeat(3 * PAGE) + "\n");
    const ps = pagesOf(r.runs);
    check(r.runs.every((x) => !x.page || x.text === "") && ps.every((l) => l.every((p) => p.length <= PAGE)) && r.totals.spans <= CAPS.spans,
      `past the run cap: page runs empty, pages within PAGE (max ${Math.max(...ps.flat().map((p) => p.length))}, spans ${r.totals.spans})`);
  }
}

if (fails.length) {
  console.log(`test-panel-render: ${fails.length} of ${checks} FAILED:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`test-panel-render: all ${checks} checks pass`);
