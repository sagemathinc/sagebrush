// ci: web-runner order=177 runner=bun
// A Delegate proposal's Merge (delegate-merge.ts) over a workspace kept in memory, as the page's workspaceIO speaks to
// it: a three-way merge of each file (notebooks by cell, text by line, a whole file deleted on one side), picks kept for
// the session and dropped against another preimage, the outputs taken from the proposal sanitized (the person's kept,
// Markdown and attachments byte for byte), the decision's record kept before any write, each write by revision to the
// same entry, recovery after a crash at each file, and tasks.merged's request built from the record alone.
//   bun web/agents/test-delegate-merge.mjs
import { MergeError, canonical, closeRest, isDone, loadPicks, mergedParams, MERGED_BYTES, newRecord, prepare, recordOf, revise, run, savePicks, unpicked, unresolved } from "./delegate-merge.ts";
import { fromFile, toIpynb } from "../notebook/ipynb.js";

let failures = 0;
const ok = (c, msg, extra) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && extra !== undefined ? " " + JSON.stringify(extra).slice(0, 500) : "")); if (!c) failures++; };
const why = async (p) => { try { await p; return "resolved"; } catch (e) { return e?.code ?? e?.message ?? String(e); } };
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- a workspace in memory: entries with their identity and revision; a notebook kept as its document (its text read
//      back as the page reads it, toIpynb), as the real one keeps it
function memIO() {
  const files = new Map(), kept = new Map(), sent = [];
  let n = 0;
  const W = {
    files, kept, sent, writes: [], crashAfter: null,
    put(path, text, kind = path.endsWith(".ipynb") ? "notebook" : "file") {
      const e = { kind, fid: kind === "file" ? "f" + ++n : undefined, created: ++n, ref: kind === "file" ? null : "r" + n, rev: 1, doc: kind === "notebook" ? fromFile(path.split("/").pop(), text) : null, text: kind === "notebook" ? null : text };
      files.set(path, e);
      return e;
    },
    textOf: (path) => { const e = files.get(path); return !e ? null : e.kind === "notebook" ? toIpynb(e.doc) : e.text; },
    edit(path, text) { const e = files.get(path); if (e.kind === "notebook") e.doc = fromFile(path.split("/").pop(), text); else e.text = text; e.rev++; },
  };
  const id = (e) => ({ kind: e.kind, ...(e.fid ? { fid: e.fid } : {}), created: e.created, ref: e.ref });
  const same = (e, at) => e.kind === at.kind && e.fid === at.fid && e.created === at.created && (e.ref ?? null) === (at.ref ?? null);
  W.io = {
    async mine(path, kind) {
      const e = files.get(path);
      if (!e) return null;
      if (e.kind !== kind) throw new MergeError("kind", "kind");
      return { id: id(e), rev: e.rev, text: W.textOf(path) };
    },
    async write(path, kind, text, at) {
      const e = files.get(path);
      if (!e || !same(e, at.id) || e.rev !== at.rev) { const err = new Error(`${path} was changed elsewhere`); err.code = "conflict"; throw err; }
      W.writes.push(path);
      if (kind === "notebook") e.doc = fromFile(path.split("/").pop(), text); else e.text = text;
      e.rev++;
      return id(e);
    },
    async create(path, kind, text) {
      if (files.has(path)) throw Object.assign(new Error("taken"), { code: "exists" });
      W.writes.push(path);
      return id(W.put(path, text, kind));
    },
    async remove(path, at) {
      const e = files.get(path);
      if (!e || !same(e, at.id)) throw Object.assign(new Error("another"), { code: "conflict" });
      W.writes.push(path);
      files.delete(path);
    },
    async load(task) { return kept.has(task) ? clone(kept.get(task)) : undefined; },
    async save(task, rec) {
      // (a crash: the page goes after a write, before the record says so)
      if (W.crashAfter !== null && W.writes.length >= W.crashAfter) { W.crashAfter = null; throw new Error("crash"); }
      if (rec === null) kept.delete(task); else kept.set(task, clone(rec));
    },
    async merged(task, params) { sent.push(params); return { recorded: "merge", commit: "c".repeat(40) }; },
  };
  return W;
}
// (a proposal's files as the agent gives them: path -> text at base and at the proposal, null for none)
function proposal(files) {
  const blob = (t) => (t === null ? null : "b".repeat(40));
  const diff = Object.entries(files).map(([path, [b, t]]) => ({ path, kind: path.endsWith(".ipynb") ? "notebook" : "file", change: b === null ? "added" : t === null ? "deleted" : "modified", base_blob: blob(b), blob: t === null ? null : "p" + path.length.toString(16).padStart(39, "0") }));
  const pin = { task: "t".repeat(32), base: "1".repeat(40), proposal: "2".repeat(40), seq: 7, files: diff };
  const src = { reads: [], async file(path, commit) { this.reads.push(path + "@" + (commit === pin.base ? "base" : "proposal")); const [b, t] = files[path]; return commit === pin.base ? b : t; } };
  return { pin, src };
}
const session = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const nbText = (cells, metadata = {}) => JSON.stringify({ cells, metadata, nbformat: 4, nbformat_minor: 5 });
const code = (id, src, outputs = []) => ({ cell_type: "code", id, metadata: {}, source: src, execution_count: null, outputs });
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ---- text, by line: both sides' changes in, the person's file written by its revision
{
  const W = memIO();
  W.put("notes.txt", "one\ntwo\nthree\nmine\n");
  const { pin, src } = proposal({ "notes.txt": ["one\ntwo\nthree\n", "ONE\ntwo\nthree\n"] });
  const plans = await prepare(W.io, src, pin);
  ok(plans.length === 1 && plans[0].conflicts.length === 0 && plans[0].mine.hash.length === 64 && src.reads.join() === "notes.txt@base,notes.txt@proposal", "a text file: base and proposal read, the person's pinned with its hash; no conflict", plans[0]);
  const rec = newRecord(pin, plans, {});
  ok(/^[0-9a-f]{32}$/.test(rec.merge_id) && rec.files[0].state === "pending" && rec.files[0].pre === "one\ntwo\nthree\nmine\n" && rec.files[0].merged === "ONE\ntwo\nthree\nmine\n", "the decision's record: a new merge_id, the preimage's full text and the merged text, pending", rec.files[0]);
  await W.io.save(pin.task, rec);
  const after = await run(W.io, rec);
  ok(isDone(after) && W.textOf("notes.txt") === "ONE\ntwo\nthree\nmine\n" && W.files.get("notes.txt").rev === 2, "run: written by its revision, both sides' changes in", W.textOf("notes.txt"));
  ok(W.kept.get(pin.task).files[0].state === "written", "the record kept says written after the write");
  const p1 = await mergedParams(after), p2 = await mergedParams(recordOf(clone(after), pin.task));
  ok(JSON.stringify(p1) === JSON.stringify(p2) && p1.merge_id === rec.merge_id && p1.seq === 7 && p1.files[0].mine.content === "one\ntwo\nthree\nmine\n" && p1.files[0].merged.content === "ONE\ntwo\nthree\nmine\n" && /^[0-9a-f]{40}$/.test(p1.files[0].merged.blob), "tasks.merged's request from the record alone: the same bytes on a retry, mine and merged in full with their blob ids", p1);
}

// ---- a conflict: Merge waits for a pick; picks kept for the session, dropped against another preimage
{
  const W = memIO();
  W.put("a.txt", "x\nmine\nz\n");
  const { pin, src } = proposal({ "a.txt": ["x\ny\nz\n", "x\ntheirs\nz\n"] });
  const S = session();
  let plans = await prepare(W.io, src, pin);
  ok(plans[0].conflicts.length === 1 && unpicked(plans, {}).length === 1 && plans[0].conflicts[0].mine === "mine\n" && plans[0].conflicts[0].theirs === "theirs\n", "both changed one line differently: one conflict, unpicked", plans[0].conflicts);
  savePicks(S, pin, plans, { "a.txt": { [plans[0].conflicts[0].id]: "theirs" } });
  let k = loadPicks(S, pin, plans);
  ok(unpicked(plans, k.picks).length === 0 && k.dropped.length === 0, "a pick kept for the session, against the same preimage: kept");
  ok(plans[0].result(k.picks["a.txt"]) === "x\ntheirs\nz\n", "the pick taken: the proposal's line");
  W.edit("a.txt", "x\nmine, edited\nz\n");
  plans = await prepare(W.io, src, pin);
  k = loadPicks(S, pin, plans);
  ok(k.dropped.join() === "a.txt" && unpicked(plans, k.picks).length === 1, "the person's file changed since the pick: the pick dropped, said, picked again", k);
  savePicks(S, pin, plans, { "a.txt": { "text:0": "mine" } });
  k = loadPicks(S, { ...pin, proposal: "3".repeat(40) }, plans);
  ok(k.dropped.join() === "a.txt" && !k.picks["a.txt"], "a pick against another proposal (a new round): dropped");
}

// ---- notebooks: the proposal's outputs sanitized, the person's kept; Markdown and attachments as they are
{
  const W = memIO();
  const att = { "p.png": { "image/png": PNG } };
  const md = { cell_type: "markdown", id: "m1", metadata: {}, source: "![x](attachment:p.png) **bold** <b>html</b>", attachments: att };
  const mineOut = [{ output_type: "display_data", data: { "text/html": "<i>my own</i>", "text/plain": "mine" }, metadata: {} }];
  const base = nbText([md, code("c1", "1+1"), code("c2", "plot()")]);
  W.put("a.ipynb", nbText([md, code("c1", "1+1", mineOut), code("c2", "plot()")]));
  const rich = [{ output_type: "display_data", data: { "text/html": "<script>x()</script>", "application/javascript": "x()", "image/png": PNG, "text/plain": "fig" }, metadata: { foo: 1 } }, { output_type: "display_data", data: { "image/svg+xml": "<svg/>" }, metadata: {} }];
  const theirsMd = { ...md, source: md.source + " more" };
  const { pin, src } = proposal({ "a.ipynb": [base, nbText([theirsMd, code("c1", "1+1"), code("c2", "plot(cos)", rich), code("c3", "new()")])] });
  const plans = await prepare(W.io, src, pin);
  ok(plans[0].conflicts.length === 0, "a notebook: cells changed on one side only, no conflict");
  const out = JSON.parse(plans[0].result({}));
  const c1 = out.cells.find((c) => c.id === "c1"), c2 = out.cells.find((c) => c.id === "c2"), m1 = out.cells.find((c) => c.id === "m1");
  ok(out.cells.map((c) => c.id).join() === "m1,c1,c2,c3", "the merged cells, in the person's order, the proposal's new cell after its neighbour", out.cells.map((c) => c.id));
  ok(JSON.stringify(c1.outputs) === JSON.stringify(mineOut), "the person's own outputs kept as they were (their HTML too)", c1.outputs);
  ok(JSON.stringify(c2.outputs[0].data) === JSON.stringify({ "image/png": PNG, "text/plain": "fig" }) && JSON.stringify(c2.outputs[0].metadata) === "{}", "a proposal's rich output: HTML and JavaScript taken out, the sized picture and the text kept", c2.outputs);
  ok(c2.outputs[1].data["text/plain"].startsWith("[An output not taken") && !JSON.stringify(c2.outputs).includes("svg"), "a proposal's output with nothing kept: the one line instead", c2.outputs[1]);
  ok(m1.cell_type === "markdown" && m1.source.join("") === theirsMd.source && JSON.stringify(m1.attachments) === JSON.stringify(att), "Markdown stays Markdown, its attachments byte for byte (not the preview's raw text)", m1);
  // (a conflict in a cell: both changed it)
  W.edit("a.ipynb", nbText([md, code("c1", "1+1"), code("c2", "plot(sin)")]));
  const p2 = await prepare(W.io, src, pin);
  ok(p2[0].conflicts.length === 1 && p2[0].conflicts[0].label === "Cell 3" && p2[0].conflicts[0].mine === "plot(sin)" && p2[0].conflicts[0].theirs === "plot(cos)", "both changed one cell: one conflict, the cell named by its place, both codes", p2[0].conflicts);
  const kept = JSON.parse(p2[0].result({ [p2[0].conflicts[0].id]: "mine" }));
  ok(kept.cells.find((c) => c.id === "c2").source.join("") === "plot(sin)", "Keep mine: the person's cell");
  // (canonical: the same document read and written again is the same text)
  ok(canonical("a.ipynb", "notebook", plans[0].result({})) === plans[0].result({}), "a merged notebook's text is canonical (written, then read back, the same)");
}

// ---- a file deleted on one side
{
  const W = memIO();
  W.put("gone.txt", "changed by me\n");
  W.put("same.txt", "base\n");
  const { pin, src } = proposal({ "gone.txt": ["base\n", null], "same.txt": ["base\n", null], "back.txt": ["base\n", "theirs\n"], "new.txt": [null, "new\n"] });
  const plans = await prepare(W.io, src, pin);
  const by = Object.fromEntries(plans.map((f) => [f.path, f]));
  ok(by["gone.txt"].conflicts[0]?.mineLabel === "Keep mine" && by["gone.txt"].conflicts[0]?.theirsLabel === "Delete it", "the proposal deletes a file the person changed: one conflict, Keep mine or Delete it", by["gone.txt"].conflicts);
  ok(by["same.txt"].conflicts.length === 0 && by["same.txt"].result({}) === null, "the proposal deletes a file the person didn't change: removed");
  ok(by["back.txt"].conflicts[0]?.mineLabel === "Skip" && by["back.txt"].conflicts[0]?.theirsLabel === "Merge recreates it", "the person deleted a file the proposal changed: Skip or recreate it", by["back.txt"].conflicts);
  ok(by["new.txt"].conflicts.length === 0 && by["new.txt"].result({}) === "new\n", "a file the proposal adds: made");
  const picks = { "gone.txt": { file: "mine" }, "back.txt": { file: "mine" } };
  let rec = newRecord(pin, plans, picks);
  ok(rec.files.find((f) => f.path === "back.txt").state === "skipped", "Skip: nothing to write, skipped");
  rec = await run(W.io, rec);
  ok(isDone(rec) && W.textOf("gone.txt") === "changed by me\n" && !W.files.has("same.txt") && !W.files.has("back.txt") && W.textOf("new.txt") === "new\n", "run: kept, removed, skipped and made, as picked", [...W.files.keys()]);
  const p = await mergedParams(rec), f = Object.fromEntries(p.files.map((x) => [x.path, x]));
  ok(f["back.txt"].mine.absent && f["back.txt"].merged.absent && f["same.txt"].merged.absent && f["new.txt"].mine.absent && f["new.txt"].merged.content === "new\n" && f["gone.txt"].merged.content === "changed by me\n", "tasks.merged: absent where a side has no file, full bytes elsewhere", p.files);
}

// ---- refused: a board; a file that isn't the kind the agent says
{
  const W = memIO();
  const { pin, src } = proposal({ "plan.board.json": ["{}", "{\"x\":1}"] });
  pin.files[0].kind = "file";
  ok((await why(prepare(W.io, src, pin))) === "kind", "a board: Can't merge this kind yet, nothing read of the person's");
  W.put("odd.txt", "x", "board");
  const b = proposal({ "odd.txt": ["x", "y"] });
  ok((await why(prepare(W.io, b.src, b.pin))) === "kind", "the person's file is another kind now: refused");
  // (a proposal's file whose bytes aren't its blob's: the source refuses it, and nothing is written)
  const c = proposal({ "a.txt": ["x", "y"] });
  c.src.file = async () => { throw Object.assign(new Error("The proposal changed while you were reading it"), { code: "stale" }); };
  ok((await why(prepare(W.io, c.src, c.pin))) === "stale" && W.writes.length === 0, "a blob mismatch: refused (stale), nothing written");
}

// ---- compare-and-swap: a file changed between the pin and its write is unresolved, never retried silently
{
  const W = memIO();
  W.put("a.txt", "a\n");
  W.put("b.txt", "b\n");
  const { pin, src } = proposal({ "a.txt": ["a\n", "A\n"], "b.txt": ["b\n", "B\n"] });
  const rec = newRecord(pin, await prepare(W.io, src, pin), {});
  W.edit("b.txt", "b, typed in another tab\n");
  const after = await run(W.io, rec);
  ok(!isDone(after) && unresolved(after).map((f) => f.path).join() === "b.txt" && W.textOf("a.txt") === "A\n" && W.textOf("b.txt") === "b, typed in another tab\n", "B changed after the pin: A written, B unresolved and left as the person left it", after.files.map((f) => f.state));
  ok(W.writes.join() === "a.txt", "no write tried on B");
  // (merged again, under the same merge_id: B against the person's version now)
  const pb = await prepare(W.io, src, pin, ["b.txt"]);
  ok(pb.length === 1 && pb[0].conflicts.length === 1, "merged again: only the unresolved file, its new conflict to pick");
  const again = revise(after, pb, { "b.txt": { [pb[0].conflicts[0].id]: "theirs" } });
  ok(again.merge_id === rec.merge_id && again.files.find((f) => f.path === "b.txt").state === "pending" && again.files.find((f) => f.path === "a.txt").state === "written", "Merge again: the unresolved file merged against the person's version now, the same merge_id, A still written");
  const done = await run(W.io, again);
  ok(isDone(done) && W.textOf("b.txt") === "B\n", "…and written", W.textOf("b.txt"));
  // (or what's left closed: its content not sent, a receipt)
  const W2 = memIO();
  W2.put("a.txt", "a\n");
  const q = proposal({ "a.txt": ["a\n", "A\n"] });
  const r2 = newRecord(q.pin, await prepare(W2.io, q.src, q.pin), {});
  W2.edit("a.txt", "changed\n");
  const closed = closeRest(await run(W2.io, r2));
  const pc = await mergedParams(closed);
  ok(isDone(closed) && pc.files[0].mine === null && pc.files[0].merged === null, "Close what's left: skipped, its content not sent (a receipt)", pc.files[0]);
}

// ---- recovery after a crash at each file (the record kept says pending; the file may already hold the merge)
for (let at = 1; at <= 3; at++) {
  const W = memIO();
  for (const n of ["a", "b", "c"]) W.put(n + ".txt", n + "\n");
  const { pin, src } = proposal({ "a.txt": ["a\n", "A\n"], "b.txt": ["b\n", "B\n"], "c.txt": ["c\n", "C\n"] });
  const rec = newRecord(pin, await prepare(W.io, src, pin), {});
  await W.io.save(pin.task, rec);
  W.crashAfter = at;
  ok((await why(run(W.io, rec))) === "crash", `a crash after file ${at} is written, before the record says so`);
  const back = recordOf(await W.io.load(pin.task), pin.task);
  ok(back && back.files[at - 1].state === "pending", `the record kept: file ${at} still pending`, back?.files.map((f) => f.state));
  const writes = W.writes.length;
  const after = await run(W.io, back);
  ok(isDone(after) && ["a", "b", "c"].every((n) => W.textOf(n + ".txt") === n.toUpperCase() + "\n") && W.writes.length === writes + (3 - at), `reload after the crash at file ${at}: the file holding the merge marked written (not written again), the rest written`, { states: after.files.map((f) => f.state), writes: W.writes });
}
{
  // (SEC's row: A applied, B changed in another tab, crash, reload: B kept as the person left it and unresolved, A
  //  written, nothing sent)
  const W = memIO();
  W.put("a.txt", "a\n");
  W.put("b.txt", "b\n");
  const { pin, src } = proposal({ "a.txt": ["a\n", "A\n"], "b.txt": ["b\n", "B\n"] });
  const rec = newRecord(pin, await prepare(W.io, src, pin), {});
  await W.io.save(pin.task, rec);
  W.crashAfter = 1;
  await why(run(W.io, rec));
  W.edit("b.txt", "b from the other tab\n");
  const after = await run(W.io, recordOf(await W.io.load(pin.task), pin.task));
  ok(!isDone(after) && after.files[0].state === "written" && after.files[1].state === "unresolved" && W.textOf("b.txt") === "b from the other tab\n" && W.sent.length === 0, "A applied, B changed in another tab, crash, reload: A written, B unresolved as the person left it, no tasks.merged", after.files.map((f) => [f.path, f.state]));
  // (a written file now another entry: unresolved)
  W.files.delete("a.txt");
  W.put("a.txt", "A\n");
  const again = await run(W.io, after);
  ok(again.files[0].state === "unresolved", "a file written, then replaced by another entry at its path: unresolved");
}

// ---- the request's bound; a kept record checked
{
  const big = "x".repeat(MERGED_BYTES / 2 + 10);
  const rec = { v: 1, merge_id: "a".repeat(32), task: "t".repeat(32), proposal: "2".repeat(40), base: "1".repeat(40), seq: 3, files: [{ path: "a.txt", kind: "file", proposal_blob: "b".repeat(40), id: { kind: "file", fid: "f1", created: 1, ref: null }, rev: 1, pre: big, hash: "h", merged: big + "y", state: "written" }] };
  const p = await mergedParams(rec);
  ok(p.files[0].mine === null && p.files[0].merged === null, "a request past the connection's frame: a receipt, the content not sent");
  ok(recordOf(rec, rec.task) !== null, "a kept record read back");
  ok(recordOf({ ...rec, task: "u".repeat(32) }, rec.task) === null && recordOf({ ...rec, merge_id: "x" }, rec.task) === null && recordOf({ ...rec, files: [{ ...rec.files[0], state: "done" }] }, rec.task) === null && recordOf("junk", rec.task) === null, "a record of another task, a bad merge_id, an unknown state, junk: none");
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
