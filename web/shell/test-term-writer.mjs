// ci: web-browser/terminal.1 order=40 runner=bun
// The terminal's one writer (web/shell/term-writer.ts, plan-term-xterm r2.7 §2, §4), against a recording sink: writes in
// order, one in flight, each at most 64 KiB; the combining filter (at most 8 after a base, none after a control, an
// escape or an output boundary, the run carried across slices); the per-generation charges (combining, OSC 8 links
// and their units), never decremented, a new generation before a fragment would pass a budget, a fragment over a
// budget on its own cut first; the reset after each output; stale callbacks and dispose.  Budgets small and injected.
//   bun web/shell/test-term-writer.mjs
import { TermWriter, BUDGET, SLICE, PIECE, RESET, LEAVE_ALT, CUT_NOTE } from "./term-writer.ts";

let checks = 0, fails = 0;
const ok = (c, what) => { checks++; if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${what}`); };
// (zero width as xterm's v6 table has it for these: combining marks, ZWJ, variation selectors)
const zw = (cp) => (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f);
const M = "́"; // (a combining acute)

/** A writer over a recording sink; `auto` calls each callback on a later turn (as xterm does). */
function rig(budget = BUDGET, { auto = true } = {}) {
  const r = { writes: [], pending: [], gens: 0, inflightMax: 0, inflight: 0 };
  const sinks = [];
  const mk = (g) => ({
    write(data, done) {
      r.inflight++;
      r.inflightMax = Math.max(r.inflightMax, r.inflight);
      r.writes.push({ g, data });
      const fin = () => { r.inflight--; done(); };
      if (auto) setTimeout(fin, 0);
      else r.pending.push(fin);
    },
  });
  sinks.push(mk(0));
  const w = new TermWriter(() => sinks[sinks.length - 1], zw, () => { r.gens++; sinks.push(mk(r.gens)); }, budget);
  r.text = (g) => r.writes.filter((x) => g === undefined || x.g === g).map((x) => x.data).join("");
  return { w, r };
}

// order, one in flight, 64 KiB pieces, never inside a surrogate pair
{
  const { w, r } = rig();
  const big = "a".repeat(SLICE - 1) + "😀" + "b".repeat(SLICE * 2);
  const p1 = w.write(big, "output");
  const p2 = w.write("tail", "ui");
  await Promise.all([p1, p2]);
  ok(w.stats.inflightMax === 1, `one write in flight at a time (${w.stats.inflightMax})`);
  ok(r.writes.every((x) => x.data.length <= PIECE), `every write handed to xterm in pieces of at most 8 KiB (${Math.max(...r.writes.map((x) => x.data.length))})`);
  ok(r.writes.every((x) => !/^[\udc00-\udfff]/.test(x.data) && !/[\ud800-\udbff]$/.test(x.data)), "no write starts or ends inside a surrogate pair");
  ok(r.text() === big + "tail", "everything arrives, in order");
  ok(!w.writing, "and the writer is idle after");
}

// the combining filter
{
  const { w, r } = rig();
  await w.write("e" + M.repeat(10) + " x\r" + M + "\x1b[1m" + M + "y" + M, "output");
  const out = r.text();
  ok(out.startsWith("e" + M.repeat(8) + " x\r"), "at most 8 marks after a base");
  ok(!out.includes("\r" + M) && out.includes("\x1b[1m") && !out.includes("m" + M + "y"), "none after a control (CR) or an escape sequence");
  ok(out.endsWith("y" + M), "a base after them starts a new run");
  ok(w.charges.combining === 9, `every passed mark charged (${w.charges.combining})`);
  // a run split across two slices counts once
  const { w: w2, r: r2 } = rig();
  await w2.write("a".repeat(SLICE - 4) + "e" + M.repeat(3) + M.repeat(7), "output");
  ok(w2.stats.writes === 2 && (r2.text().match(/́/g) || []).length === 8, `a run split across slices: 8 marks in all (${(r2.text().match(/́/g) || []).length})`);
  // an output boundary ends the run
  const { w: w3, r: r3 } = rig();
  await w3.write("e" + M, "output");
  await w3.endOutput();
  await w3.write(M + "f", "output");
  ok(r3.text() === "e" + M + RESET + "f", "a mark at the start of the next output (after the reset) is dropped");
  // ZWJ and variation selectors count as combining
  const { w: w4, r: r4 } = rig();
  await w4.write("a" + "‍".repeat(5) + "️".repeat(5), "output");
  ok(r4.text() === "a" + "‍".repeat(5) + "️".repeat(3), "ZWJ and variation selectors are charged and capped as marks");
}

// CAN aborts an open sequence; the reset after each output
{
  const { w, r } = rig();
  await w.write("\x1b]0;title-never-ended", "output");
  await w.endOutput();
  await w.write("next", "output");
  ok(r.text().startsWith(RESET) && r.text().endsWith("next"), "an unterminated OSC is held and dropped; the reset (CAN first) follows");
  ok(RESET.startsWith("\x18") && !RESET.includes(LEAVE_ALT) && RESET.includes("\x1b[!p"), "the reset: CAN and a soft reset; no buffer switch in the normal buffer (it would restore a saved cursor)");
  let alt = true;
  const sinkA = { writes: [], write(d, done) { this.writes.push(d); setTimeout(done, 0); } };
  const wa = new TermWriter(() => sinkA, zw, () => {}, BUDGET, () => alt);
  await wa.endOutput();
  alt = false;
  await wa.endOutput();
  ok(sinkA.writes[0] === "\x18" + LEAVE_ALT + RESET.slice(1) && sinkA.writes[1] === RESET, "in the alternate buffer the reset leaves it, CAN still first");
  const { w: w2, r: r2 } = rig();
  await w2.write("\x1bP1$qm", "output");
  await w2.endOutput();
  ok(r2.text() === "\x1bP1$qm" + RESET, "an open DCS is written as is and aborted by the reset's CAN");
}

// OSC 8: counted and unit-charged before writing; left out whole when past a budget
{
  const small = { marksPerBase: 8, combining: 100, links: 2, linkUnits: 60 };
  const link = (u, id = "") => `\x1b]8;${id};${u}\x1b\\x\x1b]8;;\x1b\\`;
  const { w, r } = rig(small);
  await w.write(link("https://a.example/1") + link("https://a.example/2"), "output");
  ok(w.charges.links === 2 && r.gens === 0, `two links charged (${w.charges.links}), no new generation`);
  await w.write(link("https://a.example/3"), "output");
  ok(r.gens === 1 && w.charges.links === 1 && r.text(1).includes("a.example/3"), "the third: a new generation first, charged there");
  // units bound: a few long links
  const { w: wu, r: ru } = rig(small);
  await wu.write(link("https://b.example/" + "u".repeat(30)), "output");
  await wu.write(link("https://b.example/" + "v".repeat(30)), "output");
  ok(ru.gens === 1 && wu.charges.linkUnits < 60, `units bound: the second long link starts a new generation (${ru.gens}; ${wu.charges.linkUnits} units)`);
  // a fragment whose links alone pass the budget: cut, never half written
  const { w: wc, r: rc } = rig(small);
  await wc.write(link("https://c.example/1") + link("https://c.example/2") + link("https://c.example/3"), "output");
  const t = rc.text();
  ok(wc.charges.links === 2 && !t.includes("c.example/3") && t.includes(CUT_NOTE), "a fragment over a budget on its own: cut at it, with the note");
  ok((t.match(/\x1b\]8;/g) || []).length === (t.match(/\x1b\\/g) || []).length, "no half link sequence is ever written");
  // id and other parameters count as units
  const { w: wi } = rig(small);
  await wi.write(link("https://d.example/", "id=" + "k".repeat(20)), "output");
  ok(wi.charges.linkUnits === ("id=" + "k".repeat(20) + ";https://d.example/").length, `parameters and the URI are both charged (${wi.charges.linkUnits})`);
}

// combining charges: monotone, a new generation at the budget, nothing un-charged
{
  const small = { marksPerBase: 8, combining: 20, links: 10, linkUnits: 1000 };
  const { w, r } = rig(small);
  await w.write(("e" + M.repeat(8)).repeat(2), "output");
  ok(w.charges.combining === 16 && r.gens === 0, "16 charged");
  await w.write("\x1b[2J\x1b[3J", "output"); // (a clear: releases nothing)
  ok(w.charges.combining === 16, "a clear doesn't un-charge");
  await w.write("e" + M.repeat(8), "output");
  ok(r.gens === 1 && w.charges.combining === 8, `past the budget: a new generation first, then charged there (${r.gens}, ${w.charges.combining})`);
  // revisits: marks aimed back at a cell by CR, BS or cursor motion are dropped, and nothing passes uncharged
  const { w: wr, r: rr } = rig(small);
  await wr.write("e" + M.repeat(8) + "\r" + M.repeat(8) + "\b" + M.repeat(8) + "\x1b[1D" + M.repeat(8), "output");
  ok((rr.text().match(/́/g) || []).length === 8 && wr.charges.combining === 8, "marks after CR, BS or a cursor motion never reach a cell");
  // the alternate buffer stays charged
  const { w: wa } = rig(small);
  await wa.write("\x1b[?1049h" + "e" + M.repeat(8), "output");
  await wa.endOutput();
  ok(wa.charges.combining === 8, "marks written in the alternate buffer stay charged after leaving it");
}

// style runs (S2's cap, at parity): colour kept for 19,999 runs, then the rest plain, the text always kept
{
  const small = { ...BUDGET, styleRuns: 5 };
  const runs = (n) => Array.from({ length: n }, (_, i) => `\x1b[3${i % 7 + 1}m${String.fromCharCode(97 + (i % 26))}`).join("");
  const { w, r } = rig(small);
  await w.write(runs(4), "output");
  ok((r.text().match(/\x1b\[3\dm/g) || []).length === 4 && !w.colourCut, `cap - 1 runs (4 of 5): every colour kept (${JSON.stringify(r.text())})`);
  const { w: w2, r: r2 } = rig(small);
  await w2.write(runs(7) + "\x1b[1mtail", "output");
  const t = r2.text();
  ok(w2.colourCut && t.replace(/\x1b\[[0-9;]*m/g, "") === "abcdefgtail" && t.endsWith("\x1b[0mefgtail") , `past the cap: one reset, later colours left out, every character kept (${JSON.stringify(t)})`);
  const { w: w3, r: r3 } = rig(small);
  await w3.write(runs(3), "output");
  await w3.write(runs(3), "output");
  ok(w3.colourCut, "the count carries across writes of one output");
  await w3.endOutput();
  await w3.write(runs(2), "output");
  ok(!w3.colourCut && r3.text().endsWith("\x1b[32mb"), "and starts again with the next output");
  ok(BUDGET.styleRuns === 20000, "the shipped cap: S2's 20,000");
  const { w: w4, r: r4 } = rig(small);
  await w4.write("\x1b[31m\x1b[1m\x1b[4mx\ny\nz", "output");
  ok(r4.text() === "\x1b[31m\x1b[1m\x1b[4mx\ny\nz", "several changes before one text, and line ends in one style: one run");
}

// a full-screen erase right after another, nothing drawn between, is left out; anything drawn or a style change keeps it
{
  const { w, r } = rig();
  await w.write("\x1b[2J\x01\x1b]0;t\x07".repeat(1000), "output");
  ok((r.text().match(/\x1b\[2J/g) || []).length === 1 && (r.text().match(/\x1b\]0;t\x07/g) || []).length === 1000, "repeated erases with only controls and titles between: one erase, every title kept");
  const { w: w2, r: r2 } = rig();
  await w2.write("\x1b[2Jx\x1b[2J\x1b[44m\x1b[2J\x1b[K\x1b[2J", "output");
  ok((r2.text().match(/\x1b\[2J/g) || []).length === 4 && r2.text().includes("\x1b[44m\x1b[2J"), `text, a style change or another sequence between keeps each erase, the style written before it: ${JSON.stringify(r2.text())}`);
}

// stale callbacks, dispose, the generation fence
{
  const { w, r } = rig(BUDGET, { auto: false });
  const p = w.write("one", "ui");
  await new Promise((s) => setTimeout(s, 0));
  ok(r.pending.length === 1 && w.writing, "a write waits for xterm's callback");
  w.dispose();
  await p;
  ok(true, "dispose lets a waiting write go");
  r.pending[0](); // (the late callback: a no-op)
  await w.write("after", "ui");
  ok(r.writes.length === 1, "nothing is written after dispose");
}

console.log(`${checks - fails}/${checks} checks passed`);
if (fails) process.exit(1);
