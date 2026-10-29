// The terminal panel's renderer (web/shell/panel-render.ts; plan-bash-shell r8c E5.3, E5.4): line ends, SGR, visible
// escapes, and the per-command caps with the omission line charged.  A first set (the preview); E5.8's full list
// follows in step 6's PR.
//   bun web/shell/test-panel-render.mjs
import { Render, CAPS, classOf, applySgr, utf8Bytes } from "./panel-render.ts";

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
  check(r.runs.at(-1).text === `[… ${omitted} more bytes not shown]` && r.totals.omitted === omitted, `the exact omitted count (${r.runs.at(-1).text} vs ${omitted})`);
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

if (fails.length) {
  console.log(`test-panel-render: ${fails.length} of ${checks} FAILED:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`test-panel-render: all ${checks} checks pass`);
