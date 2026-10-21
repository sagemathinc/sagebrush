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
import { EditChannel, EDIT_BOUNDS, diff, diffWithin, utf8Length, inlinePictures, jsonBytes, sameJson } from "./edit-channel.ts";
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
  }, () => t, opts.pictures ? { pictures: opts.pictures } : {});
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

// A picture store whose reads can be held (the browser reading a picture's bytes, slow), as page.ts gives inlinePictures.
const PNG2 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
function heldPictures() {
  let release, fail = null;
  const gate = new Promise((r) => (release = r));
  const store = {
    sizeOf: (n) => (n === "inew" ? { size: atob(PNG2.split(",")[1]).length, type: "image/png" } : undefined),
    dataUrl: async (n) => { await gate; if (fail) throw new Error(fail); return n === "inew" ? PNG2 : undefined; },
  };
  return { prep: inlinePictures(store), release: () => release(), failWith: (m) => { fail = m; } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
// (the board, and an action on it adding a picture "inew" (bytes not in it yet) and changing a)
const B0 = { nodes: [{ id: "a", text: "a0" }, { id: "b", text: "b0" }] };
const actOn = (v, text = "user edit") => { const d = JSON.parse(J(v)); d.images = { ...(d.images ?? {}), inew: { w: 1, h: 1 } }; d.nodes[0].text = text; d.nodes[0].image = "inew"; return d; };

// 15. astra's CORR-FRAMEEDIT-1 (1): keepUnsaved while the action's picture is being read: the action kept
{
  const p = heldPictures();
  const h = harness(B0, { manual: true, pictures: p.prep });
  h.ch.save(actOn(board(B0)));
  check(h.ch.pending === 1 && h.ch.totals().changes >= 1, "the action taken at once, before its picture is read: " + J(h.ch.totals()));
  h.ch.receive({ sagebrush: "editing", version: 1, allowed: false, keepUnsaved: true, message: "history full" });
  p.release();
  await tick(); await tick();
  const k = h.kept();
  const dl = JSON.parse(await h.ch.download(k[0].id).blob.text());
  const tx = dl.transactions[0] ?? [];
  const a = tx.find((c) => c.key.id === "a"), docc = tx.find((c) => c.key.type === "doc");
  check(k.length === 1 && dl.transactions.length === 1 && a?.fields.text === "user edit" && a?.was.text === "a0" && dl.view.nodes[0].text === "user edit", "keepUnsaved during the read: the action in the download, with its was, and in the view: " + J({ n: dl.transactions.length, a, view: dl.view.nodes[0].text }));
  check(docc?.fields.images?.inew?.src === PNG2, "...its picture's bytes filled in once read: " + J(docc?.fields.images?.inew?.src?.slice(0, 30)));
}

// 16. astra's CORR-FRAMEEDIT-1 (2): a remote change to b while a's picture is read: only the user's changes sent,
// and the host keeps both
{
  const p = heldPictures();
  const h = harness(B0, { manual: true, pictures: p.prep });
  h.ch.save(actOn(board(B0)));
  h.remote([{ op: "set", key: { type: "item", page: "", id: "b" }, fields: { text: "remote edit" } }]);
  p.release();
  await tick(); await tick();
  h.ch.flush();
  const e = h.sent.find((m) => m.sagebrush === "edit");
  check(e && !e.changes.some((c) => c.key.id === "b") && e.changes.some((c) => c.key.id === "a" && c.was.text === "a0"), "a remote change during the read: the edit holds only the user's changes, a's was as the user saw it: " + J(e?.changes.map((c) => [c.key.type, c.key.id])));
  h.answer(e);
  const b = h.st.board();
  check(b.nodes.find((n) => n.id === "b").text === "remote edit" && b.nodes.find((n) => n.id === "a").text === "user edit" && b.images?.inew?.src === PNG2, "the host keeps both edits, and the picture's bytes: " + J(b.nodes));
}

// 17. a picture that can't be read: the action and those after it kept for download (not dropped, not sent), counted
{
  const p = heldPictures();
  const h = harness(B0, { manual: true, pictures: p.prep });
  let v = actOn(board(B0));
  h.ch.save(v);
  v = JSON.parse(J(v)); v.nodes[1].text = "b after";
  h.ch.save(v);
  const t0 = h.ch.totals();
  h.ch.flush();
  check(!h.sent.some((m) => m.sagebrush === "edit"), "while the first action's picture is read, nothing is sent (the second doesn't overtake it)");
  p.failWith("the disk went away");
  p.release();
  await tick(); await tick();
  const k = h.kept();
  check(k.length === 1 && k[0].txs.length === 2 && h.ch.pending === 0 && J(h.ch.totals()) === J(t0) && h.said.some((x) => /kept for you to download/.test(x) && /disk went away/.test(x)), "a read that fails: both actions kept for download, moved without the totals changing, said: " + J({ copies: k.length, txs: k[0]?.txs.length, t0, t: h.ch.totals() }));
}

// 18. a preparation that takes the action out (a picture the host refused, by reference): released, said; the next sent
{
  const take = { inline: false, needs: (e) => Object.keys(e ?? {}).filter((n) => n === "inew"), extraBytes: () => 0, prepare: async () => ({ ok: false, keep: false, why: "Your picture quota is spent." }) };
  const h = harness(B0, { manual: true, pictures: take });
  let v = actOn(board(B0));
  h.ch.save(v);
  const w = JSON.parse(J(board(B0))); w.nodes[1].text = "b2";
  await tick(); await tick();
  check(h.ch.pending === 0 && h.ch.totals().bytes === 0 && h.said.some((x) => /quota/.test(x)) && h.shown.at(-1)?.nodes[0].text === "a0", "taken out: released, the view without it, said: " + J({ p: h.ch.pending, t: h.ch.totals() }));
}

// 19. the bytes counted at the action are the bytes sent: predicted exactly, for an inline picture
{
  const p = heldPictures();
  const h = harness(B0, { manual: true, pictures: p.prep });
  h.ch.save(actOn(board(B0)));
  const predicted = h.ch.totals().bytes;
  p.release();
  await tick(); await tick();
  const after = h.ch.totals().bytes, recount = h.ch["unsaved"].reduce((s, x) => s + utf8Length(J(x.changes)) + 1, 0);
  check(predicted === after && after === recount, "counted at the action as it is sent: " + J({ predicted, after, recount }));
  // (a picture whose size isn't at hand: counted as it turns out, once read)
  const q = heldPictures(), prep = { ...q.prep, extraBytes: () => 0 };
  const h2 = harness(B0, { manual: true, pictures: prep });
  h2.ch.save(actOn(board(B0)));
  const under = h2.ch.totals().bytes;
  q.release();
  await tick(); await tick();
  const recount2 = h2.ch["unsaved"].reduce((s, x) => s + utf8Length(J(x.changes)) + 1, 0);
  check(under < recount2 && h2.ch.totals().bytes === recount2, "its size not at hand: recounted once read: " + J({ under, after: h2.ch.totals().bytes, recount2 }));
}

// 20. jsonBytes: JSON.stringify's UTF-8 bytes exactly, without writing them; stopped at its cap and its depth.  sameJson.
{
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const chars = ["a", "\"", "\\", "\n", "\t", "\u0001", "\u001f", "é", "€", "😀", "\ud800", "\udc00", "\u2028", " "];
  const val = (d) => {
    const k = rnd(d > 3 ? 4 : 8);
    if (k === 0) return Array.from({ length: rnd(6) }, () => chars[rnd(chars.length)]).join("");
    if (k === 1) return [0, -0, 1.5, -2e-7, 1e21, 123456789, NaN, Infinity][rnd(8)];
    if (k === 2) return [true, false, null][rnd(3)];
    if (k === 3) return undefined;
    if (k < 6) return Array.from({ length: rnd(4) }, () => val(d + 1));
    const o = {};
    for (let i = rnd(4); i > 0; i--) o[Array.from({ length: rnd(3) + 1 }, () => chars[rnd(chars.length)]).join("")] = val(d + 1);
    return o;
  };
  let exact = 0, wrong = [];
  for (let i = 0; i < 2000; i++) {
    const v = [val(0), { x: val(0) }];
    const want = utf8Length(JSON.stringify(v)), got = jsonBytes(v, Infinity);
    if (want === got) exact++;
    else if (wrong.length < 3) wrong.push({ v: JSON.stringify(v), want, got });
  }
  check(exact === 2000, "jsonBytes equals JSON.stringify's UTF-8 length on 2,000 values (escapes, surrogates, undefined, NaN): " + J(wrong));
  const big = "x".repeat(10_000_000);
  let t0 = performance.now();
  const capped = jsonBytes({ a: [1, 2, { b: big }] }, 2 ** 20);
  check(capped === -1 && performance.now() - t0 < 5, "past its cap: -1 at once, the string never scanned: " + (performance.now() - t0).toFixed(2) + " ms");
  let deep = 0; for (let i = 0; i < 100_000; i++) deep = [deep];
  check(jsonBytes(deep, Infinity) === -1 && jsonBytes(deep, Infinity, 200_000) > 0, "past its depth: -1, no recursion (100,000 levels walked when allowed)");
  check(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }) && !sameJson({ a: 1 }, { a: 1, b: 2 }) && !sameJson([1, 2], [2, 1]) && sameJson({ a: 1, u: undefined }, { a: 1 }) && sameJson(deep, deep), "sameJson: keys in any order, arrays in order, undefined as absent, deep without recursion");
}

// 21. LIMIT-BFE-1: a huge single-field paste refused early, nothing large serialized
{
  const realStringify = JSON.stringify;
  let largest = 0;
  const watch = () => { largest = 0; JSON.stringify = (...a) => { const r = realStringify(...a); if (r && r.length > largest) largest = r.length; return r; }; };
  const unwatch = () => { JSON.stringify = realStringify; };
  const h = harness({ nodes: [{ id: "a", text: "" }] }, { manual: true });
  const d = board({ nodes: [{ id: "a", text: "p".repeat(50 * 2 ** 20) }] });
  Bun.gc(true);
  const heap0 = process.memoryUsage().heapUsed;
  watch();
  const t0 = performance.now();
  h.ch.save(d);
  const ms = performance.now() - t0;
  unwatch();
  Bun.gc(true);
  const heap1 = process.memoryUsage().heapUsed;
  check(h.ch.pending === 0 && /too large/.test(h.said.at(-1) ?? "") && largest < 2 ** 20 && ms < 50 && heap1 - heap0 < 4 * 2 ** 20, "a 50 MiB paste: undone at once, nothing over 1 MiB serialized, little work and heap: " + J({ ms: Math.round(ms), largest, heapMB: ((heap1 - heap0) / 2 ** 20).toFixed(1) }));
  // (a value with many keys: 100,000 pictures in the map, the board within an editable one's size)
  const h2 = harness({ nodes: [{ id: "a", text: "" }] }, { manual: true });
  const many = board({ nodes: [{ id: "a", text: "" }] });
  many.images = {};
  for (let i = 0; i < 100_000; i++) many.images["p" + i] = { w: 1, h: 1 };
  watch();
  const t1 = performance.now();
  h2.ch.save(many);
  const ms2 = performance.now() - t1;
  unwatch();
  check(h2.ch.pending === 0 && /too large/.test(h2.said.at(-1) ?? "") && largest <= EDIT_BOUNDS.boardBytes + EDIT_BOUNDS.messageBytes, "100,000 keys in one value: refused, its changes counted only to the bound, nothing past a board serialized: " + J({ ms: Math.round(ms2), largest }));
  // (a deep value: refused before it is copied, no recursion)
  const h3 = harness({ nodes: [{ id: "a", text: "" }] }, { manual: true });
  let deep = 0; for (let i = 0; i < 100_000; i++) deep = { d: deep };
  const dd = board({ nodes: [{ id: "a", text: "x", preview: deep }] });
  let threw = null;
  try { h3.ch.save(dd); } catch (e) { threw = String(e); }
  check(!threw && h3.ch.pending === 0 && /too large/.test(h3.said.at(-1) ?? ""), "a value 100,000 levels deep: refused, nothing thrown: " + J({ threw }));
}

// 21b. diffWithin stops where the bound is passed: the records past it never looked at
{
  class Counting extends Map { n = 0; *[Symbol.iterator]() { for (const e of super.entries()) { this.n++; yield e; } } }
  const from = new Counting(), to = new Counting();
  for (let i = 0; i < 100_000; i++) to.set(J(["item", "", "n" + i]), { type: "item", page: "", id: "n" + i, text: "t", parent: "", pos: i });
  const r1 = diffWithin(from, to, EDIT_BOUNDS.messageBytes, EDIT_BOUNDS.messageChanges);
  check(r1 === null && to.n <= EDIT_BOUNDS.messageChanges + 1, "100,000 records made: refused after 1,001 looked at: " + to.n);
  const to2 = new Counting();
  for (let i = 0; i < 1000; i++) to2.set(J(["item", "", "m" + i]), { type: "item", page: "", id: "m" + i, text: "x".repeat(5000), parent: "", pos: i });
  const r2 = diffWithin(new Map(), to2, EDIT_BOUNDS.messageBytes, EDIT_BOUNDS.messageChanges);
  check(r2 === null && to2.n < 300, "past 1 MiB: refused at the record that passes it: " + to2.n);
}

// 23. LIMIT-BFE-1b: the walks' own work and memory bounded: one shared work budget (keys left out of JSON count too),
// one frame a level, keys one at a time, a huge key refused unread; sameJson bounded the same way
{
  const time = (f) => { const t = performance.now(); const r = f(); return [r, performance.now() - t]; };
  // (an object of only keys JSON leaves out: 1.5 million of them, no bytes at all)
  const om = {};
  for (let i = 0; i < 1_500_000; i++) om["k" + i] = undefined;
  let st = { work: 0, maxStack: 0 };
  const [r1, ms1] = time(() => jsonBytes(om, 2 ** 20, 64, undefined, st));
  check(r1 === -1 && ms1 < 1000, "an object of 1.5 million omitted keys: refused once its budget (1 MiB of steps) is spent: " + J({ r1, ms: Math.round(ms1) }));
  // (a wide array, dense and sparse: one frame however wide)
  const dense = new Array(5_000_000).fill(0);
  st = { work: 0, maxStack: 0 };
  const [r2, ms2] = time(() => jsonBytes(dense, 2 ** 20, 64, undefined, st));
  check(r2 === -1 && st.maxStack <= 2 && ms2 < 200, "a dense array of 5 million: refused at its cap, one frame held: " + J({ r2, maxStack: st.maxStack, ms: Math.round(ms2) }));
  const sparse = new Array(1_000_000_000);
  st = { work: 0, maxStack: 0 };
  const [r3, ms3] = time(() => jsonBytes(sparse, 2 ** 20, 64, undefined, st));
  check(r3 === -1 && st.maxStack <= 2 && ms3 < 200, "a sparse array of a billion: refused, one frame held: " + J({ r3, maxStack: st.maxStack, ms: Math.round(ms3) }));
  // (within its bounds, a wide array still counted exactly, with one frame)
  const fine = new Array(100_000).fill(7);
  st = { work: 0, maxStack: 0 };
  check(jsonBytes(fine, Infinity, 64, Infinity, st) === utf8Length(J(fine)) && st.maxStack === 1 && st.work === 100_000, "a wide array within bounds: exact, one frame, a step an entry: " + J(st));
  // (a huge key, refused before it is read)
  const hk = { ["k".repeat(10_000_000)]: 1 };
  const [r4, ms4] = time(() => jsonBytes(hk, 2 ** 20));
  check(r4 === -1 && ms4 < 5, "a 10-million-character key: refused unread: " + J({ r4, ms: ms4.toFixed(2) }));
  // (sameJson: wide omitted-only objects past its budget: not the same, at once; deep: not the same, nothing thrown;
  // equal wide arrays: the same, one frame)
  const om2 = {};
  for (let i = 0; i < 1_500_000; i++) om2["k" + i] = undefined;
  const [r5, ms5] = time(() => sameJson({ a: om }, { a: om2 }, 64, 1_000_000));
  check(r5 === false && ms5 < 1000, "sameJson past its budget: not the same (fails closed): " + J({ r5, ms: Math.round(ms5) }));
  let deep = 0, deep2 = 0; for (let i = 0; i < 100_000; i++) { deep = [deep]; deep2 = [deep2]; }
  let threw = null, r6;
  try { r6 = sameJson(deep, deep2); } catch (e) { threw = String(e); }
  check(!threw && r6 === false, "sameJson past its depth: not the same, nothing thrown");
  st = { work: 0, maxStack: 0 };
  check(sameJson(fine, fine.slice(), 64, 1 << 24, st) && st.maxStack === 1, "equal wide arrays: the same, one frame: " + J(st));
  // (its contract: JSON values, as records are; it doesn't take NaN for null, nor undefined for null in an array)
  check(!sameJson(NaN, null) && !sameJson([undefined], [null]) && sameJson({ a: undefined, b: 1 }, { b: 1 }), "sameJson's contract is JSON values (records are a JSON round trip): NaN isn't null, [undefined] isn't [null]");
  // (through save: an action whose document holds such an object, past the document walk's step budget (half its
  // byte bound: here lowered to an editable board of 1 MiB, so 1 MiB of steps): refused at once)
  const was = EDIT_BOUNDS.boardBytes;
  EDIT_BOUNDS.boardBytes = 2 ** 20;
  const h = harness({ nodes: [{ id: "a", text: "" }] }, { manual: true });
  const d = board({ nodes: [{ id: "a", text: "x", preview: om }] });
  const [, ms7] = time(() => h.ch.save(d));
  EDIT_BOUNDS.boardBytes = was;
  check(h.ch.pending === 0 && /too large/.test(h.said.at(-1) ?? "") && ms7 < 2000, "a document holding 1.5 million omitted keys: the action refused, its walk bounded: " + J({ ms: Math.round(ms7) }));
}

// 22. the envelope, exactly: a 200-character revision, and edits filled to the bound, each message within 1 MiB;
// a revision past 200 characters refused (resync)
{
  const h = harness({ nodes: [{ id: "a", text: "" }] }, { manual: true });
  const long = "r".repeat(200);
  h.ch.receive({ sagebrush: "replace", version: 1, revision: long, text: J(board({ nodes: [{ id: "a", text: "" }] })), answered: [] });
  check(h.ch.revision === long, "a 200-character revision taken");
  let v = board({ nodes: [{ id: "a", text: "" }] });
  for (let i = 0; i < 8; i++) { v = JSON.parse(J(v)); v.nodes.push({ id: "n" + i, text: String(i).repeat(250_000) }); h.ch.save(v); }
  let biggest = 0, sent = 0;
  for (let k = 0; k < 10 && h.ch.pending; k++) {
    h.ch.flush();
    const e = h.sent.at(-1);
    if (e?.sagebrush !== "edit" || h.ch.inFlightId !== e.id) break;
    biggest = Math.max(biggest, utf8Length(J(e)));
    sent++;
    h.ch.receive({ sagebrush: "saved", version: 1, id: e.id, base: h.ch.revision, revision: long, changes: [], dropped: [] });
  }
  check(sent >= 2 && biggest <= EDIT_BOUNDS.messageBytes && biggest > EDIT_BOUNDS.messageBytes - 300_000, "edits filled to the bound with a 200-character base: each within 1 MiB exactly: " + J({ sent, biggest }));
  // (two actions whose changes fit in one message only were its envelope left out: two messages, each within 1 MiB)
  {
    const g = harness({ nodes: [{ id: "a", text: "" }] }, { manual: true });
    g.ch.receive({ sagebrush: "replace", version: 1, revision: long, text: J(board({ nodes: [{ id: "a", text: "" }] })), answered: [] });
    const mapOf = (d) => new Map(toRecords(d).map((r) => [J([r.type, r.page, r.id]), r]));
    const base = board({ nodes: [{ id: "a", text: "" }] });
    const withA = JSON.parse(J(base)); withA.nodes.push({ id: "x", text: "a".repeat(200_000) });
    const aBytes = diffWithin(mapOf(base), mapOf(withA), Infinity, Infinity).bytes;
    // (b's bytes for a text of length L: c + L, a record made, its text once)
    const bOf = (L) => { const w = JSON.parse(J(withA)); w.nodes.push({ id: "y", text: "b".repeat(L) }); return [w, diffWithin(mapOf(withA), mapOf(w), Infinity, Infinity).bytes]; };
    const c = bOf(0)[1];
    // (the two arrays' contents and a comma, in one array: just under 1 MiB, but over it with the envelope)
    const target = EDIT_BOUNDS.messageBytes - 100;
    const L = target - 2 - (aBytes - 2) - 1 - (c - 2);
    const [withB] = bOf(L);
    g.ch.save(withA);
    g.ch.save(withB);
    g.ch.flush();
    const first = g.sent.filter((m) => m.sagebrush === "edit").at(-1);
    check(first && utf8Length(J(first)) <= EDIT_BOUNDS.messageBytes && first.changes.length === 1, "two actions that fit only without the envelope: sent apart, each within 1 MiB: " + J({ size: utf8Length(J(first ?? {})), n: first?.changes.length }));
  }
  const r0 = h.ch.revision;
  h.ch.receive({ sagebrush: "remote", version: 1, base: r0, revision: "r".repeat(201), changes: [] });
  check(h.ch.revision === r0 && h.sent.at(-1)?.sagebrush === "resync", "a revision past 200 characters: not taken, resync");
}

// 24. CORR-PICREF-2: the view moves only once the editor shows a refresh; an action meanwhile is taken against the
// board shown, and the refresh shown again with it
{
  let release;
  const h = harness({ nodes: [{ id: "a", text: "a0" }, { id: "b", text: "b0" }] }, { manual: true });
  const realShow = h.ch["ui"].show;
  h.ch["ui"].show = (d, note) => { realShow(d, note); return new Promise((r) => (release = r)); };
  h.remote([{ op: "set", key: { type: "item", page: "", id: "b" }, fields: { text: "remote edit" } }]);
  // (the user, on the board still shown, changes only a)
  const visible = board({ nodes: [{ id: "a", text: "user edit" }, { id: "b", text: "b0" }] });
  h.ch.save(visible);
  h.ch.flush();
  const e = h.sent.find((m) => m.sagebrush === "edit");
  check(e && e.changes.length === 1 && e.changes[0].key.id === "a" && e.changes[0].was.text === "a0", "an action while a refresh is being shown: taken against the board shown, only its own change: " + J(e?.changes.map((c) => c.key.id)));
  h.answer(e);
  release();
  await tick(); await tick();
  const b = h.st.board();
  check(b.nodes.find((n) => n.id === "b").text === "remote edit" && b.nodes.find((n) => n.id === "a").text === "user edit", "the host keeps both edits");
  const last = h.shown.at(-1);
  check(last.nodes.find((n) => n.id === "a").text === "user edit" && last.nodes.find((n) => n.id === "b").text === "remote edit", "then shown again with both: " + J(last.nodes));
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
