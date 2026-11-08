// ci: web-browser/terminal.1 order=40 runner=bun
// The terminal's one writer (web/shell/term-writer.ts, plan-term-xterm r2.7 §2, §4), against a recording sink: writes in
// order, one in flight, each at most 64 KiB; the combining filter (at most 8 after a base, none after a control, an
// escape or an output boundary, the run carried across slices); the per-generation charges (combining, OSC 8 links
// and their units), never decremented, a new generation before a fragment would pass a budget, a fragment over a
// budget on its own cut first; the reset after each output; stale callbacks and dispose.  Budgets small and injected.
//   bun web/shell/test-term-writer.mjs
import { TermWriter, BUDGET, SLICE, PIECE, RESET, LEAVE_ALT, CUT_NOTE, MAX_ITEMS, MAX_QUEUED, ITEM_MAX, HEADROOM, HOLD, END_MAX } from "./term-writer.ts";

let checks = 0, fails = 0;
const ok = (c, what) => { checks++; if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${what}`); };
// (zero width as xterm's v6 table has it for these: combining marks, ZWJ, variation selectors)
const zw = (cp) => (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f);
const M = "́"; // (a combining acute)

/** a command's end: the writer's one admission, then its end */
const end = (w, omitted = 0) => w.endOutput(w.tryStartCommand(), omitted);

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
  const big = "a".repeat(ITEM_MAX - 1) + "😀" + "b".repeat(SLICE * 2);
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
  await w2.write("a".repeat(ITEM_MAX - 4) + "e" + M.repeat(3) + M.repeat(7), "output");
  ok(w2.stats.writes === 2 && (r2.text().match(/́/g) || []).length === 8, `a run split across slices: 8 marks in all (${(r2.text().match(/́/g) || []).length})`);
  // an output boundary ends the run
  const { w: w3, r: r3 } = rig();
  await w3.write("e" + M, "output");
  await end(w3);
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
  await end(w);
  await w.write("next", "output");
  ok(r.text().startsWith(RESET) && r.text().endsWith("next"), "an unterminated OSC is held and dropped; the reset (CAN first) follows");
  ok(RESET.startsWith("\x18") && !RESET.includes(LEAVE_ALT) && RESET.includes("\x1b[!p"), "the reset: CAN and a soft reset; no buffer switch in the normal buffer (it would restore a saved cursor)");
  let alt = true;
  const sinkA = { writes: [], write(d, done) { this.writes.push(d); setTimeout(done, 0); } };
  const wa = new TermWriter(() => sinkA, zw, () => {}, BUDGET, () => alt);
  await end(wa);
  alt = false;
  await end(wa);
  ok(sinkA.writes[0] === "\x18" + LEAVE_ALT + RESET.slice(1) && sinkA.writes[1] === RESET, "in the alternate buffer the reset leaves it, CAN still first");
  const { w: w2, r: r2 } = rig();
  await w2.write("\x1bP1$qm", "output");
  await end(w2);
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
  ok(wc.charges.links === 2 && !t.includes("c.example/3") && t.includes(CUT_NOTE) && rc.gens === 0, "a fragment over a budget on its own: cut at it, with the note, and no needless new generation (W11)");
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
  await end(wa);
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
  await end(w3);
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

// idle() is a barrier: it settles only after every earlier write's last callback (ENGINE E1, PERF P2)
{
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("a".repeat(100), "output");
  let settled = false;
  const p = w.idle().then(() => (settled = true));
  await new Promise((s) => setTimeout(s, 0));
  ok(!settled && r.pending.length === 1, "idle() waits while a write is in flight");
  r.pending.shift()();
  await p;
  ok(settled, "and settles after its last callback");
  const { w: wd } = rig(BUDGET, { auto: false });
  void wd.write("x", "ui");
  const pd = wd.idle();
  wd.dispose();
  await pd;
  ok(true, "dispose lets a waiting idle() go");
}

// the queue is finite (ENGINE E3, SEC T854-3, PERF P1): a blocked sink, 10 000 redraws and 10 000 small writes
{
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("first", "ui");
  await new Promise((s) => setTimeout(s, 0));
  let made = 0;
  const ps = [];
  for (let i = 0; i < 10000; i++) ps.push(w.writeLazy(() => (made++, "R" + i), "redraw"));
  for (let i = 0; i < 10000; i++) ps.push(w.write("o" + i + "\n", "output"));
  ok(w.queueMax <= MAX_ITEMS, `queued items stay within ${MAX_ITEMS} (${w.queueMax})`);
  while (r.pending.length) { r.pending.shift()(); await new Promise((s) => setTimeout(s, 0)); }
  await Promise.all(ps);
  ok(made === 1 && r.text().includes("R9999") && !r.text().includes("R9998"), `redraws waiting are replaced: the last one runs, once (${made})`);
  ok(r.text().includes("o0\n") && r.text().includes("o9999\n"), "every small write still arrives, merged, in order");
  ok(ps.length === 20000, "and every caller's promise settles");
}

// the bound holds whatever the calls (ENGINE E3, SEC T854-3, PERF P1): alternating kinds, repeated keyed replacement,
// large merges, a blocked sink
{
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("first", "ui");
  await new Promise((s) => setTimeout(s, 0));
  const k = new Set();
  for (let i = 0; i < 1000; i++) k.add(w.writeLazy(() => "k" + i, "redraw"));
  ok(k.size === 1 && w.backlog === 2, "1 000 keyed replacements: one item, one completion, nothing kept per call");
  const ps = new Set();
  for (let i = 0; i < 10000; i++) {
    ps.add(w.write("o" + i, "output"));
    ps.add(w.write("u" + i, "ui"));
  }
  ok(w.queueMax <= MAX_ITEMS && w.backlog <= MAX_ITEMS && w.stats.dropped > 0, `alternating kinds: at most ${MAX_ITEMS} items in the ledger (${w.queueMax}), the rest dropped and counted (${w.stats.dropped})`);
  ok(ps.size <= MAX_ITEMS + 1, `calls share their items' completions: ${ps.size} distinct promises for 20 000 calls`);
  while (r.pending.length) { r.pending.shift()(); await new Promise((s) => setTimeout(s, 0)); }
  await Promise.all([...ps, ...k]);
  ok(r.text().includes("k999") && !r.text().includes("k998"), "the last keyed write wins, and every completion settles");
  const { w: wb, r: rb } = rig(BUDGET, { auto: false });
  void wb.write("first", "ui");
  await new Promise((s) => setTimeout(s, 0));
  for (let i = 0; i < 40; i++) void wb.write("b".repeat(SLICE), "output");
  ok(wb.stats.dropped > 0, `queued bytes stay within ${MAX_QUEUED}: past it a write is dropped (${wb.stats.dropped})`);
  wb.dispose();
  void rb;
}

// a command's refresh written lazily is admitted as output: S2's cap applies (SEC T854-4)
{
  const small = { ...BUDGET, styleRuns: 2 };
  const { w, r } = rig(small);
  await w.writeLazy(() => "\x1b[31ma\x1b[32mb\x1b[33mc", "replace", true);
  ok(w.colourCut && (r.text().match(/\x1b\[3\dm/g) || []).length === 1, `a lazy output write keeps S2's cap (${JSON.stringify(r.text())})`);
}

// the panel's own text is admitted too (SEC T854-1): its marks capped per cell and charged; no style cap on it
{
  const small = { ...BUDGET, combining: 10, styleRuns: 2 };
  const { w, r } = rig(small);
  await w.write("x" + M.repeat(20), "ui");
  ok(w.charges.combining === 8 && (r.text().match(/\u0301/g) || []).length === 8, `marks in the panel's own text: at most 8, and charged (${w.charges.combining})`);
  await w.writeLazy(() => "y" + M.repeat(20));
  ok(w.charges.combining === 8 && r.gens === 1, "a lazy write is admitted too (the second run passes the budget: a new generation)");
  const { w: w2, r: r2 } = rig(small);
  await w2.write("\x1b[1ma\x1b[0m \x1b[1mb\x1b[0m \x1b[1mc\x1b[0m", "ui");
  ok((r2.text().match(/\x1b\[1m/g) || []).length === 3, "the panel's own styles aren't counted against S2's cap");
}

// the generation notice is written through the writer, before the fragment that started the generation
{
  const small = { ...BUDGET, links: 1 };
  const link = (u) => `\x1b]8;;${u}\x1b\\x\x1b]8;;\x1b\\`;
  const r = { writes: [] };
  const sinks = [{ write: (d, cb) => (r.writes.push([0, d]), setTimeout(cb, 0)) }];
  const w = new TermWriter(() => sinks[sinks.length - 1], zw, () => { sinks.push({ write: (d, cb) => (r.writes.push([1, d]), setTimeout(cb, 0)) }); return "NOTICE\r\n"; }, small);
  await w.write(link("https://a/1"), "output");
  await w.write(link("https://a/2"), "output");
  ok(r.writes.find(([g]) => g === 1)?.[1].startsWith("NOTICE\r\n"), "the new generation's notice comes first, on the new screen, through the writer");
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

// ---- r4 invariant pins (the 13-line contract, ENGINE/PERF/SEC; daybreak3's and astra's r3 probes)
const turn = () => new Promise((s) => setTimeout(s, 0));
const flush = async (r) => { while (r.pending.length) { r.pending.shift()(); await turn(); } };
const u8 = (s) => new TextEncoder().encode(s).length;
/** a rig whose every put's text (its pieces joined) is recorded, to check each against SLICE */
function putRig(budget = BUDGET, opts) {
  const x = rig(budget, opts);
  x.puts = () => {
    const out = [];
    let cur = "";
    // (pieces of one put are written back to back; its callback is on the last: the recorded order joins them)
    for (const p of x.r.writes) cur += p.data, (p.data.length < PIECE && (out.push(cur), (cur = "")));
    if (cur) out.push(cur);
    return out;
  };
  return x;
}

// 2, 9: one ledger, items and bytes, whatever the mix; released exactly once, back to empty
{
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("first", "ui");
  await turn();
  const id = w.tryStartCommand();
  let maxItems = 0, maxBytes = 0;
  const look = () => ((maxItems = Math.max(maxItems, w.ledger.items)), (maxBytes = Math.max(maxBytes, w.ledger.bytes)));
  for (let i = 0; i < 2000; i++) {
    void w.write("o".repeat(i % 50000) + i, "output"), look();
    void w.write("u" + i, "ui"), look();
    void w.writeLazy(() => "L" + i), look();
    void w.writeLazy(() => "R", i % 2 ? "redraw" : "replace"), look();
    void w.idle(), look();
    void w.endOutput(id), look();
  }
  ok(maxItems <= MAX_ITEMS && maxBytes <= MAX_QUEUED && w.queueMax <= MAX_ITEMS && w.bytesMax <= MAX_QUEUED, `mixed kinds, keys, lazies, idles and ends: the ledger stays within ${MAX_ITEMS} items (${maxItems}) and ${MAX_QUEUED} bytes (${maxBytes})`);
  await flush(r);
  await w.idle();
  ok(w.ledger.items === 0 && w.ledger.bytes === HEADROOM, `drained: every reservation released once (${JSON.stringify(w.ledger)})`);
}

// 3: write splits first; a merge never makes an item past ITEM_MAX (so no write past SLICE), at the caps too (E3 r3)
{
  const { w, r, puts } = putRig(BUDGET, { auto: false });
  void w.write("first", "ui");
  await turn();
  for (let i = 0; i < 63; i++) void w.writeLazy(() => "");
  for (let i = 0; i < 40; i++) void w.write("z".repeat(SLICE), "output");
  ok(w.ledger.items <= MAX_ITEMS, "full ledger: output past it is dropped, never merged into a larger item");
  await flush(r);
  const big = puts().reduce((m, p) => Math.max(m, u8(p)), 0);
  ok(w.stats.maxWrite <= SLICE && big <= SLICE, `every write within SLICE (${w.stats.maxWrite} units, ${big} bytes)`);
  const { w: w2, r: r2, puts: puts2 } = putRig();
  await w2.write("€".repeat(100000) + "😀".repeat(20000), "output");
  const big2 = puts2().reduce((m, p) => Math.max(m, u8(p)), 0);
  ok(big2 <= ITEM_MAX && r2.text() === "€".repeat(100000) + "😀".repeat(20000), `3- and 4-byte text: each write within ITEM_MAX bytes (${big2}), all of it in order`);
}

// 4, 5: a lazy write reserves an item and SLICE, made late, cut to ITEM_MAX bytes, the rest refunded; a command's
// output cut there is counted in its marker
{
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("first", "ui");
  await turn();
  const before = w.ledger.bytes;
  const huge = "h".repeat(4 << 20);
  const id = w.tryStartCommand();
  const p = w.writeLazy(() => huge, "replace", true, huge.length);
  ok(w.ledger.bytes === before + END_MAX + SLICE, `a lazy write reserves SLICE before it is made (${w.ledger.bytes - before - END_MAX})`);
  void w.endOutput(id);
  await flush(r);
  await p;
  const t = r.text();
  const cut = t.indexOf("\x18") - "first".length;
  ok(cut > 0 && cut <= ITEM_MAX && w.stats.maxWrite <= SLICE, `a 4 MiB lazy text is cut within ITEM_MAX (${cut}), CAN after the cut`);
  ok(t.includes(`[… ${huge.length - (ITEM_MAX - 1)} more bytes not shown]`), "its rest is counted exactly in the command's marker");
  ok(w.ledger.items === 0 && w.ledger.bytes === HEADROOM, "and its reservation released");
  // the panel's lazy writes capture nothing: pinned in test-panel-page.mjs (leave, exitLine, replace read panel fields)
}

// 6: keys are a closed set
{
  const { w } = rig(BUDGET, { auto: false });
  let thrown = 0;
  for (let i = 0; i < 1000; i++) try { w.writeLazy(() => "", "k" + i); } catch { thrown++; }
  ok(thrown === 1000 && w.ledger.items === 0, `1 000 unknown keys: each a programming error, no slot made (${thrown}, ${w.ledger.items} items)`);
  void w.write("in flight", "ui");
  const a = w.writeLazy(() => "1", "redraw"), b = w.writeLazy(() => "2", "redraw"), c = w.writeLazy(() => "3", "replace");
  ok(a === b && a !== c && w.ledger.items === 3, "redraw and replace: one slot each, replacement reuses it");
}

// 7: ends belong to the one admitted command: repeats share it, stale and foreign ids are refused, nothing kept after
{
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("first", "ui");
  await turn();
  const id = w.tryStartCommand();
  ok(id !== null && w.tryStartCommand() === null, "one command at a time");
  const n0 = w.ledger.items;
  const ends = new Set();
  for (let i = 0; i < 1000; i++) ends.add(w.endOutput(id));
  ok(ends.size === 1 && w.ledger.items === n0, `1 000 ends for it: one item (reserved at its start), one completion (${ends.size}, ${w.ledger.items - n0} more items)`);
  let foreign = false;
  await w.endOutput(id + 1).catch(() => (foreign = true));
  ok(foreign, "a foreign id is refused");
  await flush(r);
  await [...ends][0];
  let stale = false;
  await w.endOutput(id).catch(() => (stale = true));
  ok(stale && w.ledger.items === 0, "after its end, its id is stale: refused, nothing kept");
  const id2 = w.tryStartCommand();
  ok(id2 !== null && id2 !== id, "and the next command may start");
}

// 8: idle adds no item; its callers share one completion; dispose settles it
{
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("first", "ui");
  await turn();
  const n0 = w.ledger.items;
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(w.idle());
  ok(ids.size === 1 && w.ledger.items === n0, `1 000 idles: no item (${w.ledger.items - n0}), one completion (${ids.size})`);
  await flush(r);
  await [...ids][0];
  ok(w.idle() === w.idle(), "an idle writer: settled at once");
  const { w: wd } = rig(BUDGET, { auto: false });
  void wd.write("x", "ui");
  const pd = wd.idle();
  wd.dispose();
  await pd;
  ok(wd.ledger.items === 0, "dispose settles it and releases the ledger");
}

// 9: held sequences within HOLD: no write past SLICE from a long OSC, CSI or style run
{
  const { w } = rig();
  await w.write("\x1b]8;;https://x/" + "u".repeat(HOLD.osc * 4) + "\x1b\\x\x1b]8;;\x1b\\", "output");
  await w.write("\x1b[" + "1;".repeat(HOLD.csi * 40) + "m" + "y", "output");
  await w.write("\x1b[31m".repeat(50000) + "z", "output");
  ok(w.stats.maxWrite <= SLICE && w.charges.links === 0, `a long OSC or CSI is left out whole, held style changes stay bounded (${w.stats.maxWrite})`);
  const { w: wn, r: rn } = rig({ ...BUDGET, links: 1 });
  const wn2 = new TermWriter(() => ({ write: (d, cb) => (rn.writes.push({ g: 9, data: d }), setTimeout(cb, 0)) }), zw, () => "N".repeat(100000), { ...BUDGET, links: 1 });
  const link = (u) => `\x1b]8;;${u}\x1b\\x\x1b]8;;\x1b\\`;
  await wn2.write(link("https://a/1"), "output");
  await wn2.write(link("https://a/2"), "output");
  ok(wn2.stats.maxWrite <= SLICE && !rn.text(9).includes("N".repeat(100)), "a generation's notice is held to its share of HEADROOM");
  void wn;
}

// 10: at a cap, drop whole and count; a command's dropped output is in its one marker, exactly
{
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("first", "ui");
  await turn();
  const id = w.tryStartCommand();
  let sent = 0;
  for (let i = 0; i < 60; i++) void w.write("d".repeat(ITEM_MAX), "output"), (sent += ITEM_MAX);
  const dropped = w.stats.dropped;
  void w.endOutput(id, 1234);
  await flush(r);
  const shown = (r.text().match(/d/g) || []).length;
  ok(dropped > 0 && r.text().includes(`[… ${sent - shown + 1234} more bytes not shown]`), `dropped output and the panel's own omitted bytes: one marker, exact (${sent - shown} + 1234)`);
  ok((r.text().match(/more bytes not shown/g) || []).length === 1, "one marker for the command");
}

// 11: the start reserves the end; a pressed ledger starts nothing
{
  const { w } = rig(BUDGET, { auto: false });
  void w.write("first", "ui");
  for (let i = 0; i < MAX_ITEMS - 8; i++) void w.writeLazy(() => "");
  ok(w.pressed && w.tryStartCommand() === null, "pressed: no command starts, nothing reserved for it");
  const { w: w2 } = rig(BUDGET, { auto: false });
  const n = w2.ledger;
  const id = w2.tryStartCommand();
  ok(w2.ledger.items === n.items + 1 && w2.ledger.bytes === n.bytes + END_MAX, "a start reserves its end's item and END_MAX bytes");
  for (let i = 0; i < 200; i++) void w2.write("q".repeat(ITEM_MAX), "output");
  ok(w2.endOutput(id) instanceof Promise && w2.ledger.items <= MAX_ITEMS, "a full ledger still has its end");
}

// grader's r3 survivors (#854 TESTS interim): each pinned against its mutant
{
  // W25: no mark passes directly after an escape sequence (no BS before it)
  const { w, r } = rig();
  await w.write("a" + M.repeat(8) + "b\x1b[1D" + M.repeat(8), "output");
  ok((r.text().match(/\u0301/g) || []).length === 8, `W25: marks right after a CSI never reach a cell (${(r.text().match(/\u0301/g) || []).length})`);
  // W21: 8-bit CSI SGRs count toward S2; 8-bit erases coalesce
  const { w: w2, r: r2 } = rig({ ...BUDGET, styleRuns: 3 });
  await w2.write("\x9b31ma\x9b32mb\x9b33mc\x9b34md\x9b35me\x9b36mf", "output");
  ok(w2.colourCut && (r2.text().match(/\x1b\[3\dm/g) || []).length === 2, `W21: 8-bit SGRs are runs for S2's cap (${JSON.stringify(r2.text())})`);
  const { w: w3, r: r3 } = rig();
  await w3.write("\x9b2J\x9b2J\x9b2J", "output");
  ok((r3.text().match(/\x1b\[2J/g) || []).length === 1 && !r3.text().includes("\x9b"), "W21: 8-bit erases coalesce, written in the 7-bit form");
  // W12: a sequence open across a new generation: none of it reaches the new screen
  const { w: w4, r: r4 } = rig({ ...BUDGET, links: 1 });
  await w4.write("\x1b]8;;https://a/1\x1b\\x\x1b]8;;\x1b\\", "output");
  await w4.write("\x1b]8;;https://a/", "output");
  await w4.write("2-long\x1b\\y\x1b]8;;\x1b\\", "output");
  ok(r4.gens === 1 && !r4.text(1).includes("2-long") && !r4.text(1).includes("a/") && r4.text(1).includes("y"), `W12: the rest of an OSC open across the change is dropped (${JSON.stringify(r4.text(1))})`);
  // W33: unkeyed lazy writes past the cap are dropped
  const { w: w5 } = rig(BUDGET, { auto: false });
  void w5.write("first", "ui");
  await turn();
  for (let i = 0; i < 100; i++) void w5.writeLazy(() => "l" + i);
  ok(w5.backlog <= MAX_ITEMS && w5.stats.dropped > 0, `W33: 100 unkeyed lazy writes on a blocked sink: at most ${MAX_ITEMS} (${w5.backlog})`);
  w5.dispose();
  // W40: the shipped literals
  ok(MAX_ITEMS === 64 && MAX_QUEUED === 2 << 20 && SLICE === 65536 && PIECE === 8192 && HEADROOM === 8192 && ITEM_MAX === 57344 && END_MAX === 256 && HOLD.osc === 2048 && HOLD.csi === 64 && HOLD.pend === 256,
    "W40: the shipped bounds: 64 items, 2 MiB, 64 KiB writes in 8 KiB pieces, 8 KiB headroom, 256-byte ends, HOLD 2048/64/256");
  // W27: the combining budget's exact boundary
  const { w: w6, r: r6 } = rig({ marksPerBase: 8, combining: 20, links: 10, linkUnits: 1000 });
  await w6.write("e" + M.repeat(8) + "e" + M.repeat(8) + "e" + M.repeat(4), "output");
  ok(w6.charges.combining === 20 && r6.gens === 0, `W27: a budget of 20 admits 20 (${w6.charges.combining}, ${r6.gens})`);
  await w6.write("e" + M, "output");
  ok(r6.gens === 1, "W27: and the 21st starts a new generation");
  // W1: only a write's last piece's callback lets the next write start
  const { w: w7, r: r7 } = rig(BUDGET, { auto: false });
  void w7.write("p".repeat(PIECE * 3), "ui");
  void w7.write("q".repeat(ITEM_MAX), "output");
  await turn();
  ok(r7.pending.length === 3, "(three pieces handed to xterm)");
  r7.pending.shift()();
  r7.pending.shift()();
  await turn();
  ok(r7.writes.length === 3, `W1: the earlier pieces' callbacks release nothing (${r7.writes.length} pieces written)`);
  r7.pending.shift()();
  await turn();
  ok(r7.writes.length > 3 && r7.writes[3].data[0] === "q", "W1: the last piece's callback starts the next write");
  w7.dispose();
  // W22: 8-bit DCS content is a string, not ground text
  const { w: w8, r: r8 } = rig();
  await w8.write("\x90a" + M.repeat(10) + "\x9c", "output");
  ok(r8.text() === "\x90a" + M.repeat(10) + "\x9c", "W22: an 8-bit DCS passes whole");
}

// r4 (SEC, PERF on e8153082): a throw anywhere (a lazy callback, the generation's start, the sink) drops that item:
// released and settled once, counted, and the writer goes on; dispose after it leaves nothing held
{
  const { w, r } = rig();
  const p1 = w.writeLazy(() => { throw new Error("make"); });
  const p2 = w.write("after", "ui");
  await Promise.all([p1, p2]);
  ok(w.stats.failed === 1 && r.text() === "after" && w.ledger.items === 0 && w.ledger.bytes === HEADROOM, `a lazy callback that throws: dropped, its reservation released, its promise settled, the next write drawn (${JSON.stringify(w.ledger)})`);
  const wg = new TermWriter(() => ({ write: (d, cb) => setTimeout(cb, 0) }), zw, () => { throw new Error("gen"); }, { ...BUDGET, links: 1 });
  const link = (u) => `\x1b]8;;${u}\x1b\\x\x1b]8;;\x1b\\`;
  await wg.write(link("https://a/1"), "output");
  await wg.write(link("https://a/2"), "output");
  await wg.write("z", "ui");
  ok(wg.stats.failed === 1 && wg.ledger.items === 0 && wg.ledger.bytes === HEADROOM, "a generation's start that throws: that item dropped, the ledger back to empty");
  let n = 0;
  const ws = new TermWriter(() => ({ write: (d, cb) => { if (n++ === 0) throw new Error("sink"); setTimeout(cb, 0); } }), zw, () => {});
  const id = ws.tryStartCommand();
  await ws.write("one", "output");
  await ws.write("two", "output");
  await ws.endOutput(id);
  ok(ws.stats.failed === 1 && ws.ledger.items === 0 && ws.tryStartCommand() !== null, "a sink that throws: that write failed and released; the command's end still settles and frees it");
  const { w: wd, r: rd } = rig(BUDGET, { auto: false });
  const pd = wd.writeLazy(() => "held");
  await turn();
  wd.dispose();
  rd.pending.forEach((f) => f());
  await pd;
  ok(wd.ledger.items === 0 && wd.ledger.bytes === HEADROOM, "dispose with a write in flight, then its late callback: released once, nothing held");
}

// r5 (ENGINE E2, PERF): idle() waits for its own frontier only; a later write never extends it
{
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("before", "ui");
  await turn();
  let done = false;
  const p = w.idle().then(() => (done = true));
  void w.write("after", "ui");
  r.pending.shift()();
  await turn();
  await turn();
  ok(done && r.writes.some((x) => x.data === "after") && r.pending.length === 1, "E2: idle() at an in-flight write settles at its callback, a later write still pending");
  await p;
  const { w: w2, r: r2 } = rig(BUDGET, { auto: false });
  void w2.write("x", "ui");
  await turn();
  void w2.write("b", "output");
  let done2 = false;
  const p2 = w2.idle().then(() => (done2 = true));
  void w2.write("c", "output");
  r2.pending.shift()();
  await turn();
  r2.pending.shift()();
  await turn();
  await turn();
  ok(done2 && r2.writes.map((x) => x.data).join("|") === "x|b|c", `E2: a later write never merges into an idle() frontier (${r2.writes.map((x) => x.data).join("|")})`);
  await p2;
}

// r5 (ENGINE E5): a repeated end before its marker is made joins it; after, more omitted bytes are refused
{
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("first", "ui");
  await turn();
  const id = w.tryStartCommand();
  void w.endOutput(id, 7);
  void w.endOutput(id, 100);
  r.pending.shift()();
  await turn();
  ok(r.writes.at(-1).data.includes("[\u2026 107 more bytes not shown]"), "E5: repeats while the end waits: one marker, their counts added (107)");
  let refused = false;
  await w.endOutput(id, 5).catch(() => (refused = true));
  const same = w.endOutput(id, 0);
  r.pending.shift()();
  await same;
  ok(refused && (r.text().match(/more bytes not shown/g) || []).length === 1 && w.ledger.items === 0, "E5: once the marker is made, more omitted bytes are refused (never lost silently); a plain repeat shares the end");
  const { w: w2, r: r2 } = rig(BUDGET, { auto: false });
  void w2.write("first", "ui");
  await turn();
  const id2 = w2.tryStartCommand();
  void w2.endOutput(id2, 7);
  r2.pending.shift()();
  await turn();
  let lost = false;
  await w2.endOutput(id2, 100).catch(() => (lost = true));
  r2.pending.shift()();
  await turn();
  ok(lost && r2.text().includes("[\u2026 7 more bytes not shown]") && !r2.text().includes("107"), "E5: daybreak3's probe: 7, the end made, then +100: refused, the marker exact at 7");
}

// r6 (ENGINE E2 residual): a keyed write never replaces an item sealed as an idle() frontier
{
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("held", "ui");
  await turn();
  const p0 = w.writeLazy(() => "before", "redraw");
  const p1 = w.idle();
  const p2 = w.writeLazy(() => "after", "redraw");
  ok(p0 === p1 && p2 !== p1 && w.ledger.items === 3, "the frontier redraw keeps its slot; the later one takes its own");
  while (r.pending.length) { r.pending.shift()(); await turn(); }
  await Promise.all([p1, p2]);
  ok(r.text() === "heldbeforeafter", `both drawn, in order: ${JSON.stringify(r.text())}`);
}

// grader's TESTS pins on ba2182e1 (blocking items 5-8, 10-12, 15; items 3-4 are the drift fixes above)
{
  // 5 (W28b): a merge never takes the ledger past MAX_QUEUED
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("held", "ui");
  await turn();
  void w.write("u".repeat(MAX_QUEUED - HEADROOM - 4 - 10 - 1), "ui");
  void w.write("x", "output");
  const before = w.ledger.bytes;
  void w.write("y".repeat(100), "output");
  ok(before === MAX_QUEUED - 10 && w.bytesMax <= MAX_QUEUED && w.ledger.bytes === before && w.stats.dropped === 1, `W28b: a merge that would pass MAX_QUEUED is dropped, not merged (${before}, max ${w.bytesMax})`);
  w.dispose();
  void r;
}
{
  // 6 (W34b): idle's frontier is the last item waiting, not the first
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("held", "ui");
  await turn();
  void w.write("a", "ui");
  void w.write("b", "output");
  let done = false;
  const p = w.idle().then(() => (done = true));
  r.pending.shift()();
  await turn();
  r.pending.shift()();
  await turn();
  await turn();
  ok(!done && r.writes.at(-1).data === "b", "W34b: idle() waits past the first queued item");
  r.pending.shift()();
  await p;
  ok(done, "W34b: and settles after the last");
}
{
  // 7 (W41): a queued write's promise settles on dispose too
  const { w } = rig(BUDGET, { auto: false });
  void w.write("held", "ui");
  await turn();
  const q = w.write("queued", "output");
  w.dispose();
  const settled = await Promise.race([q.then(() => true), new Promise((s) => setTimeout(() => s(false), 500))]);
  ok(settled, "W41: dispose settles a queued (not in-flight) write's promise");
}
{
  // 8 (N4): a lazy write cut at ITEM_MAX ends with CAN, on its own write
  const { w, r } = rig();
  await w.writeLazy(() => "h".repeat(ITEM_MAX + 10));
  const lazyText = r.writes.map((x) => x.data).join("");
  ok(lazyText.length === ITEM_MAX && lazyText.endsWith("\x18") && lazyText.indexOf("\x18") === ITEM_MAX - 1, `N4: the cut lazy write ends with CAN (${lazyText.length} units)`);
}
{
  // 10 (N10): pressed at exactly MAX_ITEMS - 8 items
  const { w } = rig(BUDGET, { auto: false });
  let k = 0;
  while (w.ledger.items < MAX_ITEMS - 9) void w.write("i" + k, k++ % 2 ? "ui" : "output");
  ok(w.ledger.items === MAX_ITEMS - 9 && !w.pressed, `N10: ${MAX_ITEMS - 9} items: not pressed`);
  void w.write("i" + k, k % 2 ? "ui" : "output");
  ok(w.ledger.items === MAX_ITEMS - 8 && w.pressed, `N10: ${MAX_ITEMS - 8} items: pressed`);
  w.dispose();
}
{
  // 11 (N15): dispose with an active command (started, never ended) leaves nothing held
  const { w } = rig(BUDGET, { auto: false });
  void w.write("held", "ui");
  ok(w.tryStartCommand() !== null && w.ledger.items === 2, "(a command started: its end reserved)");
  w.dispose();
  ok(w.ledger.items === 0 && w.ledger.bytes === HEADROOM, `N15: dispose with an active command: the ledger back to empty (${JSON.stringify(w.ledger)})`);
}
{
  // 12 (N18, N21): HOLD.csi's exact edge: a 64-unit sequence is written, a 65-unit one left out whole, text after kept
  const seq = (n) => "\x1b[" + "1;".repeat((n - 2) / 2) + "1H";
  ok(seq(64).length - 2 === HOLD.csi, "(a sequence of exactly HOLD.csi units after its CSI)");
  const { w, r } = rig();
  await w.write(seq(64) + "after", "output");
  ok(r.text() === seq(64) + "after", "N18: a CSI of exactly HOLD.csi units is written whole");
  const { w: w2, r: r2 } = rig();
  await w2.write("\x1b[" + "1;".repeat(31) + "12H" + "after", "output");
  ok(r2.text() === "after", `N21: one unit more: left out whole, the text after kept (${JSON.stringify(r2.text().slice(0, 20))})`);
}
{
  // 15 (R13): dispose while an item is in admission (a generation's start awaited): nothing is written after
  let go;
  const writes = [];
  const w = new TermWriter(() => ({ write: (d, cb) => (writes.push(d), setTimeout(cb, 0)) }), zw, () => new Promise((r) => (go = r)), { ...BUDGET, links: 1 });
  const link = (u) => `\x1b]8;;${u}\x1b\\x\x1b]8;;\x1b\\`;
  await w.write(link("https://a/1"), "output");
  const p = w.write(link("https://a/2"), "output");
  await turn();
  const n = writes.length;
  w.dispose();
  go("NOTICE\r\n");
  await p;
  await turn();
  ok(typeof go === "function" && writes.length === n, `R13: dispose during admission: no sink write after it (${writes.length - n})`);
}

// r8 (#854 r7's A4 race, CI job 128669533449): a command whose end was asked for no longer blocks the next start,
// even while that end still waits to be drawn; each end keeps its own exact count
{
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("first", "ui");
  await turn();
  const id1 = w.tryStartCommand();
  const e1 = w.endOutput(id1, 5);
  const id2 = w.tryStartCommand();
  ok(id1 !== null && id2 !== null && id2 !== id1, `the next command starts while the last one's end waits (${id1}, ${id2})`);
  ok(w.tryStartCommand() === null, "and still one active command at a time");
  const st = await Promise.race([w.endOutput(id1, 1).then(() => "shared", () => "stale"), turn().then(() => "waiting")]);
  ok(st === "stale", `the earlier command's id is stale once the next has started (${st})`);
  const e2 = id2 === null ? Promise.resolve() : w.endOutput(id2, 9);
  while (r.pending.length) { r.pending.shift()(); await turn(); }
  await Promise.all([e1, e2]);
  const t = r.text();
  ok(t.includes("[\u2026 5 more bytes not shown]") && t.includes("[\u2026 9 more bytes not shown]") && t.indexOf("5 more") < t.indexOf("9 more"), "each end writes its own marker, exact, in order");
  ok(w.ledger.items === 0 && w.ledger.bytes === HEADROOM && w.tryStartCommand() !== null, "and every reservation is released");
}

// r8 (grader R8d): r8's own race window: command 1's end drawn while command 2 runs, its end not yet asked for.
// Command 2 stays the active one: no third command starts, and its own end still writes its marker
{
  const { w, r } = rig(BUDGET, { auto: false });
  void w.write("first", "ui");
  await turn();
  const id1 = w.tryStartCommand();
  const e1 = w.endOutput(id1, 5);
  const id2 = w.tryStartCommand();
  // (command 1's end drawn; command 2 still running)
  while (r.pending.length) { r.pending.shift()(); await turn(); }
  await e1;
  const id3 = w.tryStartCommand();
  ok(id2 !== null && id3 === null, `command 1's end drawn while command 2 runs: no third command starts (${id2}, ${id3})`);
  const e2 = w.endOutput(id2, 9).then(() => "resolved", () => "rejected");
  while (r.pending.length) { r.pending.shift()(); await turn(); }
  const st = await e2;
  ok(st === "resolved" && r.text().includes("[\u2026 9 more bytes not shown]"), `and command 2's end still resolves with its own marker (${st})`);
}

console.log(`${checks - fails}/${checks} checks passed`);
if (fails) process.exit(1);
