// The frame's side of editing (web/board/edit-channel.ts; web/board-host-protocol.md, "Editing"), against a
// host made of editState (the host's own merge and checks).  Run with Bun:
//   bun web/board/test-edit-channel.mjs
// - an action is one transaction, each change with its `was` (and `record` for text), and every edit passes
//   the host's checks; the frame's view and the host's board agree after each answer;
// - one edit in flight; batching never splits a transaction; a transaction past an edit's bounds is undone;
// - saved (with dropped), remote, a stale base (resync, changes ignored until replace), replace answering
//   the edit in flight, refused with retryAfter (the same changes again, as a new id, no sooner) and without
//   (kept for download, with what came after it);
// - editing ended: without keepUnsaved, dropped; with it, frozen, and the download parses back;
// - the bound on what is held (LIMIT-9B5-1): counted exactly, Edit paused before it with nothing lost,
//   resumed below half; a refusal's copy moves without the totals changing (daybreak2's check 1); copies count
//   until discarded.
import { EditChannel, EDIT_BOUNDS, diff, utf8Length } from "./edit-channel.ts";
import { editState } from "./edit-state.ts";
import { toRecords } from "./history.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const J = (x) => JSON.stringify(x);
const board = (d) => ({ format: "sagebrush-board", version: 1, ...d });
const canon = (x) => JSON.stringify(x, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const sameBoard = (a, b) => {
  const ra = toRecords(a).map(canon).sort(), rb = toRecords(b).map(canon).sort();
  return J(ra) === J(rb);
};

// A test host: editState, its revisions r0, r1, ..., and what it answers as `mode` says.
function harness(d0, opts = {}) {
  const text = J(board(d0));
  const st = editState(text);
  let rev = 0, clock = 0;
  const sent = [], shown = [], allowed = [], said = [];
  let kept = [];
  const host = {
    st, sent, shown, allowed, said, mode: "save", held: [],
    get rev() { return "r" + rev; },
    // (answer the frame's message now, as the mode says)
    answer(m) {
      if (m.sagebrush === "resync") return ch.receive({ sagebrush: "replace", version: 1, revision: "r" + ++rev, text: J(st.board()), answered: [] });
      if (m.sagebrush !== "edit") return;
      if (host.mode === "hold") return host.held.push(m);
      if (host.mode === "busy") return ch.receive({ sagebrush: "refused", version: 1, id: m.id, message: "busy", retryAfter: 500 });
      if (host.mode === "refuse") { st.answered(m.id); return ch.receive({ sagebrush: "refused", version: 1, id: m.id, message: "no" }); }
      clock += 1000;
      const a = st.apply(m, clock);
      if (!a.ok) return ch.receive({ sagebrush: "refused", version: 1, id: m.id, message: a.message, ...(a.retryAfter ? { retryAfter: a.retryAfter } : {}) });
      const base = "r" + rev;
      ch.receive({ sagebrush: "saved", version: 1, id: m.id, base, revision: "r" + ++rev, changes: a.changes, dropped: a.dropped });
    },
    // (a change made elsewhere: through editState's remote, then sent as a remote)
    remote(changes, base) {
      const r = st.remote(changes);
      if (!r.ok) throw new Error(r.message);
      const b = base ?? "r" + rev;
      ch.receive({ sagebrush: "remote", version: 1, base: b, revision: "r" + ++rev, changes });
    },
    kept: () => kept,
  };
  let t = 0;
  const ch = new EditChannel(text, "r0", (m) => { sent.push(m); if (!opts.manual) host.answer(m); }, {
    show(d, note) { shown.push(d); if (note) said.push(note); },
    allowed(on, why) { allowed.push([on, why]); },
    kept(c) { kept = [...c]; },
    say(md) { said.push(md); },
  }, () => t);
  host.ch = ch;
  host.tick = (ms) => { t += ms; };
  return host;
}
function viewOf(h) { return JSON.parse(J(h.shown.at(-1) ?? h.st.board())); }
function doAct(h, view, f) { const d = JSON.parse(J(view)); f(d); h.ch.save(d); return d; }

// 1. an action, one transaction, saved: both sides agree
{
  const h = harness({ nodes: [{ id: "a", text: "hello", x: 0, y: 0 }] });
  let v = board({ nodes: [{ id: "a", text: "hello", x: 0, y: 0 }] });
  v = doAct(h, v, (d) => { d.nodes[0].text = "hello world"; d.nodes[0].x = 10; });
  check(h.ch.pending === 1 && h.sent.length === 0, "an action: one transaction, not sent before the batch: " + J({ p: h.ch.pending, s: h.sent.length }));
  h.ch.flush();
  const e = h.sent[0];
  const c = e?.changes?.[0];
  check(e?.sagebrush === "edit" && e.base === "r0" && e.changes.length === 1 && c.op === "set" && c.fields.text === "hello world" && c.was.text === "hello" && c.fields.x === 10 && c.was.x === 0 && c.record?.text === "hello world", "the edit: each change with its was, and record for a text column: " + J(e));
  check(h.ch.revision === "r1" && h.ch.pending === 0 && h.ch.totals().bytes === 0 && h.ch.totals().changes === 0, "saved: the revision taken, nothing held: " + J({ r: h.ch.revision, t: h.ch.totals() }));
  check(sameBoard(h.st.board(), v), "the host's board is the frame's view");
}

// 2. a create and a delete; one in flight; batching keeps transactions whole
{
  const h = harness({ nodes: [{ id: "a", text: "A" }, { id: "b", text: "B" }] }, { manual: true });
  let v = board({ nodes: [{ id: "a", text: "A" }, { id: "b", text: "B" }] });
  v = doAct(h, v, (d) => { d.nodes.push({ id: "c", text: "C", x: 5, y: 5 }); });
  v = doAct(h, v, (d) => { d.nodes = d.nodes.filter((n) => n.id !== "b"); });
  h.ch.flush();
  check(h.sent.length === 1 && h.sent[0].changes.length >= 2 && h.sent[0].changes.some((c) => c.op === "set" && c.create) && h.sent[0].changes.some((c) => c.op === "delete" && c.was.text === "B"), "two actions in one batch: a create, and a delete with its text as was: " + J(h.sent[0]?.changes));
  v = doAct(h, v, (d) => { d.nodes[0].text = "A2"; });
  h.ch.flush();
  check(h.sent.length === 1, "one edit in flight: no second edit before its answer");
  h.answer(h.sent[0]);
  check(h.sent.length === 1 && h.ch.pending === 1, "answered: the next waits for its batch");
  h.ch.flush();
  h.answer(h.sent[1]);
  check(h.sent.length === 2 && h.ch.pending === 0 && sameBoard(h.st.board(), v), "then sent and saved: the boards agree: " + J(h.st.board()));
}

// 3. remote, and a stale base: resync, changes ignored until the replace
{
  const h = harness({ nodes: [{ id: "a", text: "A" }] }, { manual: true });
  const K = { type: "item", page: "", id: "a" };
  h.remote([{ op: "set", key: K, fields: { text: "A from elsewhere" } }]);
  check(h.ch.revision === "r1" && h.shown.at(-1)?.nodes?.[0]?.text === "A from elsewhere", "remote: applied, shown: " + J(h.shown.at(-1)));
  // (a remote from a revision the frame never had)
  const before = h.sent.length;
  h.ch.receive({ sagebrush: "remote", version: 1, base: "r9", revision: "r10", changes: [{ op: "set", key: K, fields: { text: "lost" } }] });
  check(h.sent.length === before + 1 && h.sent.at(-1).sagebrush === "resync" && h.ch.revision === "r1", "a stale base: resync sent, its changes not applied");
  h.ch.receive({ sagebrush: "remote", version: 1, base: "r1", revision: "r2", changes: [{ op: "set", key: K, fields: { text: "also ignored" } }] });
  check(h.ch.revision === "r1", "...and further changes ignored until the replace");
  h.answer(h.sent.at(-1));
  check(h.ch.revision === "r2" && h.shown.at(-1)?.nodes?.[0]?.text === "A from elsewhere", "the replace: taken, shown");
}

// 4. refused with retryAfter: the same changes again, a new id, no sooner
{
  const h = harness({ nodes: [{ id: "a", text: "A" }] }, { manual: true });
  let v = board({ nodes: [{ id: "a", text: "A" }] });
  v = doAct(h, v, (d) => { d.nodes[0].text = "A1"; });
  h.ch.flush();
  const first = h.sent[0];
  h.ch.receive({ sagebrush: "refused", version: 1, id: first.id, message: "busy", retryAfter: 500 });
  v = doAct(h, v, (d) => { d.nodes[0].x = 3; });
  const held = h.ch.totals();
  h.ch.flush();
  check(h.sent.length === 1, "retryAfter: nothing sent sooner");
  h.tick(500);
  h.ch.flush();
  const second = h.sent[1];
  check(second && second.id !== first.id && J(second.changes.slice(0, first.changes.length)) === J(first.changes) && second.changes.length === first.changes.length + 1, "then a new edit: a new id, the same changes, with what came since: " + J(second));
  check(J(h.ch.totals()) === J(held), "retried: what is held counted the same");
  h.answer(second);
  check(h.ch.pending === 0 && sameBoard(h.st.board(), v), "saved: the boards agree");
}

// 5. refused without retryAfter: those and the later ones kept for download, moved without the totals changing
{
  const h = harness({ nodes: [{ id: "a", text: "A" }] }, { manual: true });
  let v = board({ nodes: [{ id: "a", text: "A" }] });
  v = doAct(h, v, (d) => { d.nodes[0].text = "A1"; });
  h.ch.flush();
  const e = h.sent[0];
  v = doAct(h, v, (d) => { d.nodes[0].text = "A2"; });
  const t0 = h.ch.totals();
  // (the totals at every step of the refusal: never down then up: the copy is made from what is held)
  const seen = [];
  const keptUi = h.ch["ui"].kept;
  h.ch["ui"].kept = (c) => { seen.push(h.ch.totals()); keptUi(c); };
  h.ch.receive({ sagebrush: "refused", version: 1, id: e.id, message: "not a board" });
  const k = h.kept();
  check(k.length === 1 && k[0].txs.length === 2 && h.ch.pending === 0, "refused: it and the later change kept, one copy: " + J(k.map((c) => c.txs.length)));
  check(seen.every((s) => J(s) === J(t0)) && J(h.ch.totals()) === J(t0), "the copy made without the totals changing (check 1): " + J({ t0, seen, after: h.ch.totals() }));
  const dl = h.ch.download(k[0].id);
  const parsed = JSON.parse(await dl.blob.text());
  check(parsed.transactions.length === 2 && parsed.transactions[0][0].fields.text === "A1" && parsed.transactions[1][0].fields.text === "A2", "the download parses back to each transaction, with its was: " + J(parsed.transactions));
  h.ch.discard(k[0].id);
  check(h.ch.totals().bytes === 0 && h.ch.totals().changes === 0 && h.kept().length === 0, "discarded: released");
}

// 6. a replace answering the edit in flight; a change to a record gone kept only if it makes or restores it
{
  const h = harness({ nodes: [{ id: "a", text: "A" }, { id: "b", text: "B", x: 1 }] }, { manual: true });
  let v = board({ nodes: [{ id: "a", text: "A" }, { id: "b", text: "B", x: 1 }] });
  v = doAct(h, v, (d) => { d.nodes[0].text = "A1"; });
  h.ch.flush();
  const e = h.sent[0];
  v = doAct(h, v, (d) => { d.nodes[1].x = 2; d.nodes.push({ id: "c", text: "C" }); });
  // (b deleted elsewhere; the host merges e, then replaces)
  h.st.apply(e, 1);
  h.st.remote([{ op: "delete", key: { type: "item", page: "", id: "b" } }]);
  h.ch.receive({ sagebrush: "replace", version: 1, revision: "r5", text: J(h.st.board()), answered: [{ id: e.id, outcome: "saved" }] });
  const pend = h.ch.pending;
  check(h.ch.revision === "r5" && h.ch.inFlightId === null && pend === 1, "replace: the edit it answers settled: " + J({ r: h.ch.revision, pend }));
  const last = h.shown.at(-1);
  check(last.nodes.some((n) => n.id === "c") && !last.nodes.some((n) => n.id === "b") && h.said.some((s) => /had no effect/.test(s)), "the create kept, the change to b (gone, no record) dropped, said: " + J(last.nodes.map((n) => n.id)));
}

// 7. editing ends: without keepUnsaved dropped; with it, frozen, downloadable
{
  for (const keepUnsaved of [false, true]) {
    const h = harness({ nodes: [{ id: "a", text: "A" }] }, { manual: true });
    let v = board({ nodes: [{ id: "a", text: "A" }] });
    v = doAct(h, v, (d) => { d.nodes[0].text = "A1"; });
    h.ch.flush();
    v = doAct(h, v, (d) => { d.nodes[0].text = "A2"; });
    h.ch.receive({ sagebrush: "editing", version: 1, allowed: false, message: "history full", reason: "history-full", ...(keepUnsaved ? { keepUnsaved: true } : {}) });
    const t = h.ch.totals();
    check(h.ch.isEnded && h.allowed.at(-1)?.[0] === false && h.allowed.at(-1)?.[1] === "history full", `editing ended (keepUnsaved ${keepUnsaved}): Edit off, said`);
    if (!keepUnsaved) check(t.bytes === 0 && h.kept().length === 0, "without keepUnsaved: dropped");
    else {
      const k = h.kept();
      check(k.length === 1 && k[0].txs.length === 2 && !!k[0].view && t.changes === 2, "with keepUnsaved: kept, with the view: " + J({ t, n: k[0]?.txs.length }));
      // (frozen: an edit attempt adds nothing)
      doAct(h, v, (d) => { d.nodes[0].text = "A3"; });
      check(J(h.ch.totals()) === J(t) && h.ch.pending === 0, "frozen: a further edit adds nothing");
      const parsed = JSON.parse(await h.ch.download(k[0].id).blob.text());
      check(parsed.view.nodes[0].text === "A2" && parsed.transactions.length === 2, "the download: the view as the user saw it, every transaction: " + J(parsed.view.nodes));
    }
  }
}

// 8. the bound (LIMIT-9B5-1): a host that never answers, the same near-limit field changed over and over
{
  const big = (i) => String(i % 10).repeat(200_000);
  const h = harness({ nodes: [{ id: "a", text: "" }] }, { manual: true });
  let v = board({ nodes: [{ id: "a", text: "" }] });
  h.ch.flush();
  let taken = 0, undone = 0;
  for (let i = 0; i < 40; i++) {
    const before = h.ch.pending;
    v = doAct(h, v, (d) => { d.nodes[0].text = big(i); });
    if (h.ch.pending > before) taken++;
    else { undone++; v = viewOf(h); }
    h.ch.flush();
  }
  const t = h.ch.totals();
  // (the totals equal what is held, recounted from scratch)
  const recount = h.ch["unsaved"].reduce((s, x) => s + utf8Length(J(x.changes)) + 1, 0);
  check(h.ch.isPaused && t.bytes <= EDIT_BOUNDS.heldBytes && t.bytes > EDIT_BOUNDS.heldBytes - EDIT_BOUNDS.messageBytes && t.bytes === recount, "a silent host: paused before the bound, the totals exact: " + J({ t, recount, taken, undone }));
  check(h.allowed.at(-1)?.[0] === false && /Waiting for the host/.test(h.allowed.at(-1)?.[1]), "...and said");
  // (then keepUnsaved: frozen, every transaction taken is in the download)
  h.ch.receive({ sagebrush: "editing", version: 1, allowed: false, message: "can't take more", keepUnsaved: true });
  const k = h.kept();
  const parsed = JSON.parse(await h.ch.download(k[0].id).blob.text());
  check(k[0].txs.length === taken && parsed.transactions.length === taken, "keepUnsaved after the pause: every transaction taken kept and downloaded: " + J({ taken, kept: k[0].txs.length }));
}

// 9. retryAfter only, again and again: paused, then back once answers come and the totals fall below half
{
  const big = (i) => String(i % 10).repeat(300_000);
  const h = harness({ nodes: [{ id: "a", text: "" }] }, { manual: true });
  let v = board({ nodes: [{ id: "a", text: "" }] });
  for (let i = 0; i < 40 && !h.ch.isPaused; i++) {
    v = doAct(h, v, (d) => { d.nodes[0].text = big(i); });
    h.ch.flush();
    const e = h.sent.at(-1);
    if (e?.sagebrush === "edit" && h.ch.inFlightId === e.id) h.ch.receive({ sagebrush: "refused", version: 1, id: e.id, message: "busy", retryAfter: 100 });
    h.tick(100);
  }
  check(h.ch.isPaused, "retryAfter only: paused");
  // (the host answers now: each edit saved)
  let n = 0;
  while (h.ch.pending && n++ < 50) { h.tick(100); h.ch.flush(); const e = h.sent.at(-1); if (h.ch.inFlightId === e.id) h.answer(e); }
  check(!h.ch.isPaused && h.allowed.at(-1)?.[0] === true && h.ch.pending === 0 && sameBoard(h.st.board(), viewOf(h)), "answers come: Edit back, everything saved: " + J({ p: h.ch.isPaused, pending: h.ch.pending }));
}

// 10. a transaction past an edit's bounds: undone, never sent
{
  const h = harness({ nodes: [{ id: "a", text: "" }] }, { manual: true });
  const v = board({ nodes: [{ id: "a", text: "" }] });
  doAct(h, v, (d) => { d.nodes[0].text = "x".repeat(EDIT_BOUNDS.messageBytes + 10); });
  check(h.ch.pending === 0 && h.ch.totals().bytes === 0 && /too large/.test(h.said.at(-1) ?? ""), "a paste past 1 MiB: undone, said, nothing held");
  doAct(h, v, (d) => { for (let i = 0; i < 1001; i++) d.nodes.push({ id: "n" + i, text: "" }); });
  check(h.ch.pending === 0, "a change to more than 1,000 records: undone");
}

// 11. copies kept count toward the bound; discarding one lets editing go on
{
  const big = (i) => String(i % 10).repeat(500_000);
  const h = harness({ nodes: [{ id: "a", text: "" }] }, { manual: true });
  let v = board({ nodes: [{ id: "a", text: "" }] });
  for (let i = 0; i < 30 && !h.ch.isPaused; i++) {
    v = doAct(h, v, (d) => { d.nodes[0].text = big(i); });
    h.ch.flush();
    const e = h.sent.at(-1);
    if (e?.sagebrush === "edit" && h.ch.inFlightId === e.id) { h.ch.receive({ sagebrush: "refused", version: 1, id: e.id, message: "no" }); v = viewOf(h); }
  }
  check(h.ch.isPaused && h.kept().length > 1 && h.ch.pending === 0, "refusal copies alone reach the bound: paused: " + J({ copies: h.kept().length, t: h.ch.totals() }));
  for (const c of [...h.kept()]) h.ch.discard(c.id);
  check(!h.ch.isPaused && h.ch.totals().bytes === 0, "discarded: editing goes on");
}

// 13. an answer for an id not in flight (another's, an old one, a repeat): ignored, nothing released
{
  const h = harness({ nodes: [{ id: "a", text: "A" }] }, { manual: true });
  let v = board({ nodes: [{ id: "a", text: "A" }] });
  v = doAct(h, v, (d) => { d.nodes[0].text = "A1"; });
  h.ch.flush();
  const e = h.sent[0], t = h.ch.totals();
  for (const id of [crypto.randomUUID(), "not-a-uuid"]) h.ch.receive({ sagebrush: "saved", version: 1, id, base: "r0", revision: "r1", changes: [], dropped: [] });
  check(h.ch.inFlightId === e.id && J(h.ch.totals()) === J(t) && h.ch.revision === "r0" && h.ch.pending === 1, "a saved for another id: ignored, the edit still in flight, nothing released: " + J({ f: h.ch.inFlightId === e.id, t: h.ch.totals(), r: h.ch.revision }));
  h.answer(e);
  // (a repeat of the answer already taken)
  h.ch.receive({ sagebrush: "saved", version: 1, id: e.id, base: "r1", revision: "r2", changes: [], dropped: [] });
  check(h.ch.revision === "r1" && h.ch.totals().bytes === 0, "a repeated saved: ignored");
}

// 14. pictures: an edit never removes one from the board's map (the editor may not hold it), it only adds or changes
{
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const h = harness({ images: { pic: { w: 1, h: 1, src: PNG } }, nodes: [{ id: "a", text: "A", image: "pic" }] }, { manual: true });
  // (the editor's view: the picture renamed by its content, and the old name gone from the map)
  const v = board({ images: { ihash: { w: 1, h: 1, src: PNG } }, nodes: [{ id: "a", text: "A2", image: "ihash" }] });
  h.ch.save(v);
  h.ch.flush();
  const docCh = h.sent[0]?.changes.find((c) => c.key.type === "doc");
  check(docCh && docCh.fields.images.pic?.src === PNG && docCh.fields.images.ihash?.src === PNG, "a picture missing from the view stays in the map; the new name added: " + J(docCh?.fields));
  h.answer(h.sent[0]);
  const b = h.st.board();
  check(b.images.pic?.src === PNG && b.nodes[0].image === "ihash" && b.images.ihash?.src === PNG, "the host's board: every picture it names has its bytes: " + J(b.images && Object.keys(b.images)));
}

// 12. diff: unchanged fields not sent; a removed field sent as null with its was
{
  const a = new Map(toRecords(board({ nodes: [{ id: "a", text: "A", color: "red" }] })).map((r) => [J([r.type, r.page, r.id]), r]));
  const b = new Map(toRecords(board({ nodes: [{ id: "a", text: "A" }] })).map((r) => [J([r.type, r.page, r.id]), r]));
  const d = diff(a, b);
  check(d.length === 1 && d[0].fields.color === null && d[0].was.color === "red" && !("text" in d[0].fields) && !d[0].record, "a removed field: null, with its was; unchanged ones not sent: " + J(d));
}

console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: the frame's editing side, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
