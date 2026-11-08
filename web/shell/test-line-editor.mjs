// ci: web-browser/terminal.1 order=30 runner=bun
// The terminal's line editor (web/shell/line-editor.ts, plan-term-xterm r2.7 §3), as a pure state machine: keys in;
// the line, the cursor, history and a submission out.  Its bounds (a line within maxBytes, refused whole; history 500
// entries and 4 MiB, oldest out first; an entry over 256 KiB not kept) and its work: each operation's copied or
// scanned characters, at 4 KiB and at the bound, with doubling controls (no quadratic redraw or whole-history scan
// per key: daybreak4 P2).
//   bun web/shell/test-line-editor.mjs
import { LineEditor, History, HISTORY, utf8Len } from "./line-editor.ts";

let checks = 0, fails = 0;
const ok = (c, what) => { checks++; if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${what}`); };
const keys = (ed, ...ks) => ks.map((k) => ed.key(typeof k === "string" ? { key: k } : k));
const type = (ed, s) => { for (const c of s) ed.key({ key: c }); };
const fresh = (max = 1 << 20, hist = new History()) => new LineEditor(max, hist);

// typing, the cursor, deletion
{
  const ed = fresh();
  type(ed, "echo hi");
  ok(ed.buf === "echo hi" && ed.cur === 7, "typing builds the line, the cursor at its end");
  keys(ed, "ArrowLeft", "ArrowLeft", "Backspace");
  ok(ed.buf === "echohi" && ed.cur === 4, `Left, Left, Backspace deletes before the cursor (${JSON.stringify(ed.buf)}, ${ed.cur})`);
  keys(ed, "Delete");
  ok(ed.buf === "echoi" && ed.cur === 4, `Delete deletes under the cursor (${JSON.stringify(ed.buf)})`);
  ed.reset("abc def ghi");
  keys(ed, { key: "a", ctrl: true });
  ok(ed.cur === 0, "Ctrl-A: the line's start");
  keys(ed, { key: "e", ctrl: true });
  ok(ed.cur === 11, "Ctrl-E: the line's end");
  keys(ed, { key: "w", ctrl: true });
  ok(ed.buf === "abc def " && ed.cur === 8, `Ctrl-W kills the word before the cursor (${JSON.stringify(ed.buf)})`);
  keys(ed, "Home", { key: "k", ctrl: true });
  ok(ed.buf === "" && ed.cur === 0, "Home, Ctrl-K kills to the end");
  ed.reset("abc def");
  keys(ed, "ArrowLeft", "ArrowLeft", "ArrowLeft", { key: "u", ctrl: true });
  ok(ed.buf === "def" && ed.cur === 0, "Ctrl-U kills to the line's start");
  ed.reset("x😀y");
  keys(ed, "ArrowLeft", "ArrowLeft");
  ok(ed.cur === 1, "an astral character is one step for the cursor");
  keys(ed, "Delete");
  ok(ed.buf === "xy", "and one for Delete");
  type(ed, "😀");
  ok(ed.buf === "x😀y", "an astral character typed is inserted whole");
}

// Enter, Shift+Enter, Tab, Ctrl-C, Ctrl-L, Ctrl-D
{
  const ed = fresh();
  type(ed, "cat <<EOF");
  ok(keys(ed, { key: "Enter", shift: true })[0].t === "redraw" && ed.buf === "cat <<EOF\n", "Shift+Enter: a continuation line");
  type(ed, "x");
  keys(ed, { key: "Enter", shift: true });
  type(ed, "EOF");
  const a = keys(ed, "Enter")[0];
  ok(a.t === "submit" && a.line === "cat <<EOF\nx\nEOF", "Enter submits the whole script as one");
  ok(ed.buf === "" && ed.cur === 0, "and the line is fresh after it");
  ok(keys(ed, "Tab")[0].t === "tab" && keys(ed, { key: "Tab", shift: true })[0].t === "pass", "Tab is the completion's; Shift-Tab the browser's");
  ok(keys(ed, { key: "c", ctrl: true })[0].t === "interrupt", "Ctrl-C is the panel's (copy, Stop or ^C)");
  ok(keys(ed, { key: "l", ctrl: true })[0].t === "clear", "Ctrl-L clears");
  ok(keys(ed, { key: "d", ctrl: true })[0].t === "eof", "Ctrl-D on an empty line: eof (the bash prompt ignores it)");
  type(ed, "ab");
  keys(ed, "Home", { key: "d", ctrl: true });
  ok(ed.buf === "b", "Ctrl-D on a line deletes under the cursor");
  ok(keys(ed, { key: "x", meta: true })[0].t === "pass" && keys(ed, "F5")[0].t === "pass", "a key the editor doesn't use is passed on");
}

// many-line scripts: Up and Down move between lines first
{
  const ed = fresh();
  ed.reset("one\ntwo\nthree");
  keys(ed, "ArrowUp");
  ok(ed.cur === "one\ntwo".length, `Up from the last line goes to the line above (${ed.cur})`);
  keys(ed, "ArrowDown");
  ok(ed.cur === "one\ntwo\nthr".length, `Down goes back, the column kept within the line (${ed.cur})`);
}

// history
{
  const h = new History();
  const ed = fresh(1 << 20, h);
  for (const s of ["ls", "pwd", "pwd", " ", "date"]) { ed.reset(s); keys(ed, "Enter"); }
  ok(JSON.stringify(h.entries) === JSON.stringify(["ls", "pwd", "date"]), `history: blanks and repeats not kept (${JSON.stringify(h.entries)})`);
  type(ed, "dra");
  keys(ed, "ArrowUp");
  ok(ed.buf === "date", "Up: the newest entry");
  keys(ed, "ArrowUp", "ArrowUp", "ArrowUp");
  ok(ed.buf === "ls", "Up stops at the oldest");
  keys(ed, "ArrowDown", "ArrowDown", "ArrowDown");
  ok(ed.buf === "dra", "Down past the newest: the draft back");
  const hb = new History({ entries: 3, bytes: 10, entryMax: 6 });
  for (const s of ["aaaa", "bbbb", "toolong!", "cc", "dddd"]) hb.push(s);
  ok(JSON.stringify(hb.entries) === JSON.stringify(["bbbb", "cc", "dddd"]) && hb.bytes === 10, `history bounds: an entry over entryMax not kept; oldest out until both bounds hold (${JSON.stringify(hb.entries)}, ${hb.bytes} B)`);
  ok(HISTORY.entries === 500 && HISTORY.bytes === 4 << 20 && HISTORY.entryMax === 256 << 10, "the shipped bounds: 500 entries, 4 MiB, 256 KiB an entry");
  const h5 = new History();
  for (let i = 0; i < 600; i++) h5.push("cmd " + i);
  ok(h5.entries.length === 500 && h5.entries[0] === "cmd 100", "500 entries at most, oldest out first");
}

// Ctrl-R
{
  const h = new History(HISTORY, ["make test", "git status", "make build", "ls"]);
  const ed = fresh(1 << 20, h);
  type(ed, "draft");
  keys(ed, { key: "r", ctrl: true });
  type(ed, "make");
  ok(ed.search && h.entries[ed.search.at] === "make build", "Ctrl-R: the newest match as you type");
  keys(ed, { key: "r", ctrl: true });
  ok(h.entries[ed.search.at] === "make test", "Ctrl-R again: the next older match");
  keys(ed, { key: "r", ctrl: true });
  ok(ed.search.failed && h.entries[ed.search.at] === "make test", "no older match: failed, the last match kept");
  keys(ed, { key: "g", ctrl: true });
  ok(!ed.search && ed.buf === "draft", "Ctrl-G cancels: the line as it was");
  keys(ed, { key: "r", ctrl: true });
  type(ed, "stat");
  keys(ed, "Escape");
  ok(!ed.search && ed.buf === "git status", "Escape: the match stays in the line for editing");
  keys(ed, { key: "r", ctrl: true });
  type(ed, "ls");
  const a = keys(ed, "Enter")[0];
  ok(a.t === "submit" && a.line === "ls", "Enter in a search runs the match");
}

// the line's bound: refused whole
{
  const ed = fresh(10);
  type(ed, "12345678");
  ok(ed.insert("abc", "pasted").t === "refused" && ed.buf === "12345678", "a paste past maxBytes is refused whole");
  ok(ed.insert("ab", "pasted").t === "redraw" && ed.buf === "12345678ab", "one that fits goes in");
  ok(ed.key({ key: "x" }).t === "refused" && ed.buf === "12345678ab", "a key past it is refused too");
  const e2 = fresh(4);
  ok(e2.insert("é€", "pasted").t === "refused" && utf8Len("é€") === 5, "the bound is UTF-8 bytes, not characters");
}

// every way the line can change is bounded (ENGINE E2, SEC T854-2): a completion's replacement, the search query, history
{
  const ed = fresh(10, new History(HISTORY, ["short", "much longer than ten"]));
  ok(ed.load("0123456789").t === "redraw" && ed.load("0123456789x").t === "refused" && ed.buf === "0123456789", "a replacement (a Tab completion) past maxBytes is refused whole, the line kept");
  ed.reset("");
  keys(ed, { key: "r", ctrl: true });
  for (const c of "abcdefghij") ed.key({ key: c });
  ok(ed.key({ key: "k" }).t === "refused" && ed.search.q === "abcdefghij", "the search query is bounded as the line is");
  keys(ed, { key: "g", ctrl: true });
  ok(ed.key({ key: "ArrowUp" }).t === "refused" && ed.buf === "", "a history entry past the bound isn't loaded");
}

// Ctrl-R's accept is bounded too (SEC T854-2 residual, ENGINE E2): a match past the line's bound is never accepted or
// submitted, by Enter, Escape or an arrow; and submission itself refuses a line past the bound
{
  const h = new History(HISTORY, ["x".repeat(40)]);
  const ed = fresh(8, h);
  for (const k of [{ key: "Enter" }, { key: "Escape" }, { key: "ArrowLeft" }]) {
    ed.reset("");
    keys(ed, { key: "r", ctrl: true }, "x");
    const a = keys(ed, k)[0];
    ok(a.t === "refused" && ed.buf === "", `Ctrl-R, then ${k.key}: a 40-byte match on an 8-byte line is refused, nothing submitted or loaded`);
  }
  const e2 = fresh(8);
  e2.buf = "y".repeat(40);
  ok(keys(e2, "Enter")[0].t === "refused", "the central guard: a line past the bound is never submitted, however it was filled");
}

// work: linear per operation, no whole-history scan per key
{
  const measure = (n) => {
    const big = "x".repeat(n);
    const ed = fresh(1 << 24, new History({ entries: 500, bytes: 1 << 24, entryMax: 1 << 24 }));
    ed.reset(big);
    const w0 = ed.work;
    ed.key({ key: "Home" });
    ed.key({ key: "a" });
    ed.key({ key: "End" });
    ed.key({ key: "b" });
    ed.key({ key: "ArrowLeft" });
    ed.key({ key: "Backspace" });
    return ed.work - w0;
  };
  const w1 = measure(4096), w2 = measure(8192), wM = measure(1 << 20), wM2 = measure(2 << 20);
  ok(w2 <= 2.1 * w1 && wM2 <= 2.1 * wM, `edits: work doubles with the line, no more (4 KiB ${w1}, 8 KiB ${w2}; 1 MiB ${wM}, 2 MiB ${wM2})`);
  ok(wM <= 8 * (1 << 20), `an edit at 1 MiB copies the line a bounded number of times (${wM} for 6 keys)`);
  // (cursor moves copy nothing)
  const ed = fresh();
  ed.reset("y".repeat(100000));
  const w0 = ed.work;
  for (let i = 0; i < 50; i++) ed.key({ key: "ArrowLeft" });
  ok(ed.work === w0, "cursor moves copy nothing");
  // Ctrl-R: at most one history scan per key
  const hs = (n) => {
    const h = new History({ entries: 500, bytes: 1 << 26, entryMax: 1 << 26 });
    for (let i = 0; i < 400; i++) h.push("q".repeat(n) + i);
    const e = fresh(1 << 20, h);
    e.key({ key: "r", ctrl: true });
    const before = e.work;
    for (const c of "zzzz") e.key({ key: c });
    return { per: (e.work - before) / 4, total: h.entries.reduce((t, s) => t + s.length, 0) };
  };
  const s1 = hs(100), s2 = hs(200);
  ok(s1.per <= s1.total && s2.per <= s2.total, `Ctrl-R scans the history at most once per key (${s1.per} <= ${s1.total}; ${s2.per} <= ${s2.total})`);
  ok(s2.per <= 2.1 * s1.per, "and its work doubles with the history, no more");
}

// grader's r3 survivors (#854 TESTS interim): each pinned against its mutant
{
  // L17: a paste in a search whose match is past the bound: refused, the line unchanged
  const e1 = fresh(8, new History(HISTORY, ["x".repeat(40)]));
  e1.reset("ab");
  keys(e1, { key: "r", ctrl: true }, "x");
  ok(e1.insert("zz", "pasted").t === "refused" && e1.buf === "ab", "L17: a paste under a search with an over-bound match is refused, the line unchanged");
  // L15: Alt is the browser's
  ok(fresh().key({ key: "x", alt: true }).t === "pass", "L15: an Alt key passes to the browser");
  // L7, L20, L21, L22: in a many-line script, line-wise kills and Home stop at the line's edge
  const m = fresh();
  m.reset("one\ntwo");
  keys(m, { key: "w", ctrl: true });
  ok(m.buf === "one\n", `L7: Ctrl-W kills the word on line 2 (${JSON.stringify(m.buf)})`);
  keys(m, { key: "w", ctrl: true });
  ok(m.buf === "one\n", "L7: and never crosses the newline");
  m.reset("one\ntwo");
  keys(m, "ArrowLeft", { key: "u", ctrl: true });
  ok(m.buf === "one\no" && m.cur === 4, `L20: Ctrl-U kills to line 2's start, not the script's (${JSON.stringify(m.buf)})`);
  m.reset("one\ntwo");
  keys(m, "ArrowUp", "ArrowLeft", { key: "k", ctrl: true });
  ok(m.buf === "on\ntwo", `L21: Ctrl-K kills to line 1's end, not the script's (${JSON.stringify(m.buf)})`);
  m.reset("one\ntwo");
  keys(m, "Home");
  ok(m.cur === 4, `L22: Home goes to line 2's start (${m.cur})`);
  // L11: Down clamps at a shorter middle line
  const d = fresh();
  d.reset("aaaa\nb\ncccc");
  d.cur = 3;
  keys(d, "ArrowDown");
  ok(d.cur === 6, `L11: Down from column 3 to the one-character line: its end (${d.cur})`);
  // L13, L14: in a search, Backspace searches again for the shorter query; a longer query keeps a match that still fits
  const h = new History(HISTORY, ["make test", "git status", "make tags", "make build"]);
  const r = fresh(1 << 20, h);
  keys(r, { key: "r", ctrl: true });
  type(r, "make");
  keys(r, { key: "r", ctrl: true }, { key: "r", ctrl: true });
  ok(h.entries[r.search.at] === "make test", "(two older matches back)");
  type(r, " t");
  ok(h.entries[r.search.at] === "make test" && !r.search.failed, "L14: a longer query that still matches keeps the current match (not the newer \"make tags\", which matches too)");
  keys(r, "Backspace", "Backspace");
  ok(r.search.q === "make" && h.entries[r.search.at] === "make build", `L13: Backspace shortens the query and searches again from the newest (${r.search.q}, ${h.entries[r.search.at]})`);
  // L6: Ctrl-G restores the cursor too
  const g = fresh(1 << 20, h);
  type(g, "draft");
  keys(g, "ArrowLeft", "ArrowLeft", { key: "r", ctrl: true });
  type(g, "git");
  keys(g, { key: "g", ctrl: true });
  ok(g.buf === "draft" && g.cur === 3, `L6: Ctrl-G restores the line and its cursor (${g.cur})`);
  // L2: an entry of exactly entryMax bytes is kept
  const hb = new History({ entries: 3, bytes: 100, entryMax: 6 });
  hb.push("abcdef");
  hb.push("abcdefg");
  ok(JSON.stringify(hb.entries) === JSON.stringify(["abcdef"]), "L2: an entry of exactly entryMax is kept, one byte more isn't");
  // L16: an astral character is 4 bytes at the bound
  const a4 = fresh(4);
  ok(a4.insert("😀").t === "redraw" && a4.insert("x").t === "refused", "L16: an astral character counts 4 bytes: it fills a 4-byte line exactly");
  const a5 = fresh(4);
  a5.insert("a");
  ok(a5.insert("😀").t === "refused" && utf8Len("a😀") === 5, "L16: and one byte more is refused");
}

// r4 (SEC T854-5, ENGINE E4): a submission the panel refuses is taken back: the line restored, its history entry gone
{
  const h = new History();
  const ed = fresh(1 << 20, h);
  type(ed, "echo again");
  const a = keys(ed, "Enter")[0];
  ed.unsubmit(a.line);
  ok(ed.buf === "echo again" && h.entries.length === 0 && h.bytes === 0, "unsubmit: the line back, the history as it was");
}

// #854 follow-up (grader E2): unsubmit removes only an entry its own submission added
{
  const h = new History(HISTORY, ["echo a"]);
  const ed = fresh(1 << 20, h);
  type(ed, "echo a");
  const a = keys(ed, "Enter")[0];
  ed.unsubmit(a.line);
  ok(ed.buf === "echo a" && JSON.stringify(h.entries) === JSON.stringify(["echo a"]) && h.bytes === 6, `E2: after a repeat (no entry added), the earlier entry stays (${JSON.stringify(h.entries)})`);
  type(ed, "x");
  const b = keys(ed, "Enter")[0];
  ed.unsubmit(b.line);
  ok(JSON.stringify(h.entries) === JSON.stringify(["echo a"]) && h.bytes === 6, "E2: a new line's own entry is removed");
  ok(h.push("echo a") === false && h.push(" ") === false && h.push("new") === true, "push says whether it kept the entry");
}

console.log(`${checks - fails}/${checks} checks passed`);
if (fails) process.exit(1);
