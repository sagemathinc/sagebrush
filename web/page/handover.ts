// Focus takeover: the tab of this browser a person is using takes its document's writer lock at once, and the tab that
// had it follows (read-only, still showing every change, saying nothing) until it is used again (web/journal/store.js:
// writerLock's enqueue and passOn, the store's yieldLock).  One channel per document, named as its lock is:
//   want {tab, at}: this tab was used (`at`: when) and doesn't write the document: the writer hands it over;
//   writer {tab}: this tab writes it now (its want answered);
//   who-wants: a writer back from being frozen or hidden: a used tab still waiting asks again (a want sent while it
//     was frozen may never have reached it);
//   bye {tab}: this tab is gone.
// A tab granted the lock while another was used more recently and wants it passes it on at once (passOn), so the lock
// goes to the tab in use, not to whichever was first in the lock's queue.  What is typed into the tab in use before it
// writes is kept, and typed again into the same place once it does: up to 5000 input actions, and of a paste its text only.
// No input is dropped without a word: what is kept is typed in once its field can take it (the cell still read-only, or
// not shown yet, as the takeover settles: typed in as soon as it can be); what never can be (its cell gone from the
// document, another document shown, the takeover failed, no field to type it into, or past the 5000 kept) is counted,
// and the page says how many input actions weren't applied.

import { docValue, ENVELOPE } from "../workspace/notebook-form";
/** What the page says of input made while this tab was taking over that wasn't applied (`n` input actions: a key, a
 * paste, a cursor move): not replayed into the document, not a storage failure. */
export const inputNotApplied = (n: number) => `${n} input action${n === 1 ? "" : "s"} made here while this tab was taking over ${n === 1 ? "wasn't" : "weren't"} applied: enter that input again.`;

/** What the page gives: where its document is used, and how it saves, follows and takes over. */
export type HandoverPage = {
  /** Where the document's use is noticed (its cells). */
  view: HTMLElement;
  /** Everything typed here so far saved (the page's pending save made, and waited for); rejects if a save failed. */
  quiesce(): Promise<void>;
  /** Read-only now, at once (before the handover's first wait). */
  hold(): void;
  /** This tab follows another now: read-only, quiet, and told when it is granted the lock again. */
  follow(): void;
  /** The place a field is in (a cell's id), or null; and the field at that place once the document is shown again: what
   * is typed while this tab can't write goes back where it was typed. */
  keyOf(field: Element): string | null;
  fieldFor(key: string): HTMLTextAreaElement | HTMLInputElement | null;
  /** Whether the document (as this page holds it) still has the place `key`: a place it no longer has can never take
   * what was typed there. Without it, a missing field is waited for. */
  hasKey?(key: string): boolean;
  /** `n` more input actions couldn't be applied here: said by the page. */
  notApplied?(n: number): void;
  /** The document shown, and the document `doc` shown in its place as a change made here (saved, recorded): what a
   * whole write asked of this tab while it writes the document is made with (Workspace.write under sync's journal).
   * Without them, this tab answers no such write. */
  shownDoc?(): any;
  replaceDoc?(doc: any): void;
};

// (what the person typed before this tab could write: text, a deletion, a cursor move or another key, kept in order,
// each with where it was typed: the field's place and the selection in its text as typed so far)
type Where = { k: string; s: number; e: number };
type Op = ({ text: string } | { del: -1 | 1 } | { move: -1 | 1 } | { key: KeyboardEventInit }) & { at?: Where };
// (a field typed into while this tab can't write: the selection in its text as it will be once the kept keys are typed
// in, that text's length, the field's own selection when last read (a click or a cursor key moves it), and the edits so
// far at their places in the field's own text, to place a moved selection among them)
type Shadow = { s: number; e: number; len: number; real: [number, number]; edits: { o: number; d: number }[] };

/** The bounds of the whole writes a tab answers: requests kept (answered ones for WRITE_KEEP_MS), how long a `ready`
 * waits for its commit, and a document's cells and size. */
const WRITE_MAX = 64, WRITE_KEEP_MS = 60_000, READY_MS = 5000, DOC_CELLS = 10_000, DOC_CHARS = 32 * 2 ** 20;
/** A document as a whole write gives it: {cells: [...]} of cells each {type?, code?, ...}, bounded. */
function docOk(d: any): boolean {
  if (!d || typeof d !== "object" || Array.isArray(d) || !Array.isArray(d.cells) || d.cells.length > DOC_CELLS) return false;
  if (!d.cells.every((c: any) => c && typeof c === "object" && !Array.isArray(c) && (c.code === undefined || typeof c.code === "string") && (c.type === undefined || c.type === "code" || c.type === "markdown" || c.type === "raw"))) return false;
  if (d.mode !== undefined && typeof d.mode !== "string") return false;
  try { return JSON.stringify(d).length <= DOC_CHARS; } catch { return false; }
}
// (two documents equal as whole documents: every field but the store's envelope, each cell whole)
const sameDoc = (a: any, b: any) => docValue(a) === docValue(b);
// (a record as a document: the store's own fields left out)
const plainDoc = (r: any) => { if (!r) return null; const { j: _j, hash: _h, unjournaled: _u, rev: _r, updated: _d, baseRev: _b, at: _a, from: _f, proof: _p, ...doc } = r; return doc; };

export function writerHandover(page: HandoverPage) {
  const tab = Math.random().toString(36).slice(2);
  let store: any = null, ch: BroadcastChannel | null = null, lastUse = 0, wanting = false, handing = false, composing = false;
  // (while this tab wants it: asked again every second until a tab says it writes (a writer still loading, or one that
  // missed the message, answers then).  Always with when this tab was really last used: the last tab used wins, so a
  // want another tab's use overtook never takes the lock from the tab being typed in; it waits, its keys kept, until
  // this tab is used again (a later `at`) or the writer lets go)
  let reask: ReturnType<typeof setInterval> | null = null, lastPost = 0;
  const want = () => { lastPost = Date.now(); post({ t: "want", tab, at: lastUse }); };
  const startWanting = () => {
    if (wanting) return;
    wanting = true;
    want();
    // (still wanting while its own takeover reloads: keys typed then are kept too; asked again only while it follows)
    reask ??= setInterval(() => { if (!wanting) return stopWanting(); if (follows()) want(); }, 1000);
  };
  const stopWanting = () => { wanting = false; if (reask) clearInterval(reask); reask = null; };
  // (other tabs' wants not yet answered: tab -> when it was used (`at`) and when its want was last heard; and those this
  // tab already passed the lock on for)
  const wants = new Map<string, { at: number; heard: number }>(), passed = new Set<string>();
  // (a want used later than this tab's own last use: only that one takes the lock from this tab; and only while it is
  // still being asked (heard in the last 2.5 s: one is asked again every second): a tab that died with a want left
  // can't hold the lock away for ever)
  const later = (w: { at: number }) => w.at > lastUse;
  const fresh = (w: { heard: number }) => Date.now() - w.heard < 2500;
  const standing = () => [...wants.values()].some((w) => later(w) && fresh(w));
  let buffer: Op[] = [];
  const shadows = new Map<string, Shadow>();
  const post = (m: object) => { try { ch?.postMessage(m); } catch {} };
  const writes = () => !!store?.writer && !!store.ready;
  const follows = () => !!store?.journaled && store.readOnly === "other";

  // (the store shown, from showWriter: a new channel for a new document.  Returns how many keys kept for the one before
  // are given up with it, never typed in: the page says so)
  function bind(st: any): number {
    // (the same store shown again (showWriter after a load): a want heard while it was still loading answered now)
    if (st === store) { void handOver(); return 0; }
    if (store) store.passOn = null;
    ch?.close();
    const lost = buffer.length;
    ch = null; store = st; stopWanting(); stopWaiting(); buffer = []; shadows.clear(); wants.clear(); passed.clear();
    if (!st?.journaled || typeof BroadcastChannel !== "function") return lost;
    ch = new BroadcastChannel(st.kind.lockPrefix + st.id);
    ch.onmessage = (ev) => heard(ev.data);
    st.passOn = () => {
      // (a want is passed on for once)
      for (const [t, w] of wants) if (later(w) && fresh(w) && !passed.has(t + w.at)) { passed.add(t + w.at); return true; }
      return false;
    };
    return lost;
  }
  function heard(m: any) {
    if (m && (m.t === "write" || m.t === "commit")) return void onWrite(m);
    if (!m || typeof m.tab !== "string" && m.t !== "who-wants") return;
    if (m.t === "want" && typeof m.at === "number") { wants.set(m.tab, { at: m.at, heard: Date.now() }); void handOver(); }
    else if (m.t === "writer" || m.t === "bye") wants.delete(m.tab);
    else if (m.t === "who-wants" && wanting) want();
  }
  // (another tab wants it: everything typed here saved, then the lock let go; a want heard while this tab is still
  // taking over is answered once it has (taken))
  async function handOver() {
    const st = store;
    if (!st || !writes() || handing || !standing()) return;
    handing = true;
    page.hold();
    let done = false;
    try {
      // (asked again just before letting go, with nothing in between: this tab used meanwhile, later than every want,
      // keeps the lock)
      done = await st.yieldLock(async () => {
        // (an unfinished composition (IME) ended first, so its text is in the cell: leaving the field commits it)
        if (composing) (document.activeElement as HTMLElement | null)?.blur?.();
        await page.quiesce();
      }, standing);
    } finally {
      handing = false;
    }
    if (store !== st) return;
    page.follow();
    // (keys typed here while it was letting go: kept here if it didn't (typed in now), else asked for as any use)
    if (!done && buffer.length) { const ops = buffer; buffer = []; replay(ops); }
    else if (done && buffer.length) startWanting();
    else if (done) stopWanting();
  }
  // (a person's use of this tab: only real input (isTrusted) while this window has the focus; a page's own focus, a
  // tab opened in the background or one just shown isn't a use)
  function used(ev: Event) {
    if (!ev.isTrusted || !document.hasFocus()) return false;
    lastUse = Date.now();
    // (letting go: the key kept, and typed in where it was typed once this tab keeps the lock or has it again)
    if (handing) return true;
    // (writing, nothing kept: typed in as usual; keys still kept, waiting for their field: this one kept after them)
    if (!follows() && writes()) return buffer.length > 0;
    // (used again while it still wants it: asked again now with the new time, at most every quarter second)
    if (follows()) { if (!wanting) startWanting(); else if (Date.now() - lastPost > 250) want(); }
    return wanting;
  }
  const opOf = (e: KeyboardEvent): Op | null => {
    if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta" || e.key === "CapsLock" || e.isComposing) return null;
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (!mod && e.key.length === 1) return { text: e.key };
    if (!mod && !e.shiftKey && e.key === "Enter") return { text: "\n" };
    if (!mod && e.key === "Backspace") return { del: -1 };
    if (!mod && e.key === "Delete") return { del: 1 };
    if (!mod && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return { move: e.key === "ArrowLeft" ? -1 : 1 };
    return { key: { key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey } };
  };
  page.view.addEventListener("pointerdown", (ev) => { used(ev); }, true);
  page.view.addEventListener("keydown", (ev) => {
    if (!used(ev)) return;
    // (a cursor key before anything is typed moves the cursor where it is, read-only as the cell still is)
    const op = opOf(ev);
    if (!op || ("move" in op && !buffer.length)) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    keep(op);
  }, true);
  page.view.addEventListener("paste", (ev) => {
    if (!used(ev)) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    if (text) keep({ text });
  }, true);
  page.view.addEventListener("compositionstart", () => { composing = true; });
  page.view.addEventListener("compositionend", () => { composing = false; });
  // (back from being frozen, or shown again: a want sent meanwhile may not have arrived)
  const again = () => { if (writes()) post({ t: "who-wants" }); };
  document.addEventListener("resume", again);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") again(); });
  addEventListener("pagehide", () => post({ t: "bye", tab }));

  const fieldIn = (el: Element | null) => (el && page.view.contains(el) && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") ? (el as HTMLTextAreaElement) : null);
  // (a selection in the field's own text, placed among the edits kept so far, and back)
  const toShadow = (sh: Shadow, r: number) => r + sh.edits.reduce((n, x) => n + (x.o < r || (x.o === r && x.d > 0) ? x.d : 0), 0);
  const toField = (sh: Shadow, v: number) => v - sh.edits.reduce((n, x) => n + (x.o < v ? x.d : 0), 0);
  // (a key kept, with where it was typed: the field's place, and its selection in the text as typed so far; the
  // field's own selection moved since (a click, a cursor key) read again first)
  function keep(op: Op) {
    // (past 5000 kept: not kept, and said)
    if (buffer.length >= 5000) return void page.notApplied?.(1);
    const f = fieldIn(document.activeElement), k = f ? page.keyOf(f) : null;
    if (!f || !k) return void buffer.push(op);
    const rs = f.selectionStart ?? 0, re = f.selectionEnd ?? rs;
    let sh = shadows.get(k);
    if (!sh) shadows.set(k, (sh = { s: rs, e: re, len: f.value.length, real: [rs, re], edits: [] }));
    else if (sh.real[0] !== rs || sh.real[1] !== re) { sh.s = toShadow(sh, rs); sh.e = toShadow(sh, re); sh.real = [rs, re]; }
    buffer.push({ ...op, at: { k, s: sh.s, e: sh.e } });
    const { s, e } = sh;
    if ("text" in op) {
      sh.edits.push({ o: toField(sh, s), d: op.text.length - (e - s) });
      sh.len += op.text.length - (e - s);
      sh.s = sh.e = s + op.text.length;
    } else if ("del" in op) {
      let a = s, b = e;
      if (a === b) { if (op.del < 0 ? a === 0 : b >= sh.len) return; if (op.del < 0) a--; else b++; }
      sh.edits.push({ o: toField(sh, a), d: a - b });
      sh.len -= b - a;
      sh.s = sh.e = a;
    } else if ("move" in op) {
      sh.s = sh.e = s !== e ? (op.move < 0 ? s : e) : Math.max(0, Math.min(sh.len, s + op.move));
    }
  }
  // (keys whose field can't take them yet (still read-only, or not shown yet, as the takeover settles): kept, before any
  // typed since, and typed in as soon as a field's read-only state changes and this tab writes: told by the page's own
  // change to its cells, nothing polled)
  let waiting: MutationObserver | null = null;
  function stopWaiting() { waiting?.disconnect(); waiting = null; }
  function waitFor(rest: Op[]) {
    buffer = rest.concat(buffer);
    if (waiting || typeof MutationObserver !== "function") return;
    waiting = new MutationObserver(() => {
      if (!buffer.length) return stopWaiting();
      if (!writes()) return;
      const ops = buffer;
      buffer = [];
      stopWaiting();
      replay(ops);
    });
    waiting.observe(page.view, { subtree: true, childList: true, attributes: true, attributeFilter: ["readonly"] });
  }
  // (typed again, in order, each where it was typed (its field, at its selection), else into the field that has the
  // focus: as the person typed it, through the field's own input events, so the page saves it as any typing)
  function replay(ops: Op[]) {
    // (where the kept keys put each field's selection: given back for the fields whose keys still wait, so a key typed
    // there meanwhile is placed after them, as it was typed)
    const kept = new Map(shadows);
    shadows.clear();
    let lost = 0;
    const said = () => { if (lost) page.notApplied?.(lost); };
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      let ta = op.at ? (page.fieldFor(op.at.k) as HTMLTextAreaElement | null) : null;
      // (its place gone from the document, this tab writing it: it never can be typed in; counted, and the rest go on)
      if (op.at && !ta && writes() && page.hasKey && !page.hasKey(op.at.k)) { lost++; continue; }
      // (its field not shown yet, or still read-only: this key and every one after it kept, never dropped)
      if (op.at && (!ta || ta.readOnly)) {
        for (const o of ops.slice(i)) if (o.at && kept.has(o.at.k)) shadows.set(o.at.k, kept.get(o.at.k)!);
        said();
        return waitFor(ops.slice(i));
      }
      if (ta && op.at) {
        if (document.activeElement !== ta) ta.focus({ preventScroll: true });
        const n = ta.value.length;
        try { ta.setSelectionRange(Math.min(op.at.s, n), Math.min(op.at.e, n)); } catch {}
      } else ta = document.activeElement as HTMLTextAreaElement | null;
      const field = !!ta && (ta.tagName === "TEXTAREA" || ta.tagName === "INPUT") && !ta.readOnly;
      if ("key" in op) { (ta ?? page.view).dispatchEvent(new KeyboardEvent("keydown", { ...op.key, bubbles: true, cancelable: true })); continue; }
      // (no field to type it into: counted)
      if (!field || !ta) { lost++; continue; }
      const s = ta.selectionStart ?? 0, e = ta.selectionEnd ?? s;
      if ("move" in op) { const at = Math.max(0, Math.min(ta.value.length, (s === e ? s : op.move < 0 ? s : e) + (s === e ? op.move : 0))); ta.setSelectionRange(at, at); continue; }
      if ("del" in op && s === e) {
        if (op.del < 0 ? s === 0 : s >= ta.value.length) continue;
        ta.setSelectionRange(op.del < 0 ? s - 1 : s, op.del < 0 ? s : s + 1);
      }
      const text = "text" in op ? op.text : "";
      if (!document.execCommand?.("insertText", false, text)) {
        ta.setRangeText(text, ta.selectionStart ?? 0, ta.selectionEnd ?? 0, "end");
        ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: text ? "insertText" : "deleteContent", data: text || null }));
      }
    }
    said();
  }
  // A whole write of the document asked by a page of this browser (Workspace.write under sync's journal, design r3),
  // made here while this tab writes it: one at a time, in two phases.  `write {req, ref, doc, base}`: what was typed
  // here saved first, then the base checked against the record, and `ready` (nothing changed yet); `commit {req, ref}`
  // (sent by the asking page once it checked the path and the grant again): the document shown and saved, and `wrote`.
  // Every message is untrusted input, checked whole (its exact shape, sizes, this document); this tab's own checks as
  // the writer (the lock held, loaded, no hand-over begun) made after every wait and right before the change; each
  // request answered by one outcome, kept a while (bounded) and given again to a request asked again.  The asking page
  // trusts no answer for an ok: it reads the record.
  type Asked = { at: number; state: "preparing" | "ready" | "committing" | "done"; base: number | null; doc: any; rec?: any; readyAt?: number; outcome?: any };
  const asked = new Map<string, Asked>();
  let writing: Promise<unknown> = Promise.resolve();
  const prune = () => {
    const now = Date.now();
    for (const [k, w] of asked) if (w.state === "done" && now - w.at > WRITE_KEEP_MS) asked.delete(k);
    for (const [k, w] of asked) { if (asked.size <= WRITE_MAX) break; if (w.state === "done") asked.delete(k); }
  };
  const reqOk = (r: unknown) => typeof r === "string" && r.length > 0 && r.length <= 64;
  const shape = (m: any, keys: string) => !!m && typeof m === "object" && !Array.isArray(m) && Object.keys(m).sort().join(",") === keys;
  const holds = (st: any) => !!st && store === st && writes() && !st.yielding && !st.released && !handing;

  // (tests: the holder held at `stage`, loopback pages only, test-notebook-write-journal.mjs)
  const pause = async (stage: string, req: string) => {
    const f = (globalThis as any).__sbTestWritePause;
    if (typeof f === "function" && /^(127\.0\.0\.1|localhost)$/.test(location.hostname)) await f(stage, req);
  };
  function onWrite(m: any) {
    const st = store;
    if (!st || !page.shownDoc || !page.replaceDoc) return;
    prune();
    if (m.t === "write") {
      if (!shape(m, "base,doc,ref,req,t") || !reqOk(m.req) || m.ref !== st.id || !(m.base === null || (Number.isSafeInteger(m.base) && m.base >= 0)) || !docOk(m.doc)) return;
      const had = asked.get(m.req);
      if (had) {
        if (had.state === "done") post(had.outcome);
        else if (had.state === "ready") post({ t: "ready", req: m.req });
        return;
      }
      // (only the writer answers: a tab that follows leaves it to the one that writes)
      if (!holds(st) || asked.size >= WRITE_MAX) return;
      const w: Asked = { at: Date.now(), state: "preparing", base: m.base, doc: m.doc };
      asked.set(m.req, w);
      writing = writing.then(() => prepare(m.req, w, st), () => prepare(m.req, w, st));
    } else {
      if (!shape(m, "ref,req,t") || !reqOk(m.req) || m.ref !== st.id) return;
      const w = asked.get(m.req);
      if (!w) return;
      if (w.state === "done") return void post(w.outcome);
      if (w.state !== "ready" || Date.now() - (w.readyAt ?? 0) > READY_MS) return;
      w.state = "committing";
      writing = writing.then(() => commit(m.req, w, st), () => commit(m.req, w, st));
    }
  }
  function end(req: string, w: Asked, outcome: any) {
    w.state = "done"; w.outcome = outcome; w.doc = null; w.rec = null; w.at = Date.now();
    post(outcome);
    // ("lost": this tab no longer writes the document and did nothing: not kept, so the request asked again goes to the
    // tab that writes it now, never answered "lost" again from here)
    if (outcome.t === "lost") asked.delete(req);
  }
  async function prepare(req: string, w: Asked, st: any) {
    if (!holds(st)) return end(req, w, { t: "lost", req });
    try {
      await page.quiesce();
    } catch (e) {
      return end(req, w, { t: "failed", req, why: `what was typed there couldn't be saved first (${String((e as Error)?.message ?? e).slice(0, 200)})` });
    }
    await pause("prepare", req);
    if (!holds(st)) return end(req, w, { t: "lost", req });
    const rec = await st.loadRecord().catch(() => null);
    if (!holds(st)) return end(req, w, { t: "lost", req });
    if (!rec) return end(req, w, { t: "failed", req, why: "its record couldn't be read" });
    // (typed here since that save, or a base that isn't the record's revision: a conflict, with what is there now)
    const shown = page.shownDoc!();
    if (!sameDoc(shown, rec) || (w.base !== null && rec.rev !== w.base)) return end(req, w, { t: "conflict", req, current: plainDoc(rec) });
    w.rec = rec; w.state = "ready"; w.readyAt = Date.now();
    post({ t: "ready", req });
    // (a commit that never comes: let go after READY_MS, nothing changed)
    setTimeout(() => { if (w.state === "ready") end(req, w, { t: "lost", req }); }, READY_MS + 100);
  }
  async function commit(req: string, w: Asked, st: any) {
    await pause("commit", req);
    // (right before the change, with no wait in between: still this tab's to write, and nothing typed since `ready`)
    if (!holds(st)) return end(req, w, { t: "lost", req });
    // (the whole document shown still the record it got ready on: an output, a count, metadata changed since is a change)
    const shown = page.shownDoc!();
    if (!sameDoc(shown, w.rec)) return end(req, w, { t: "conflict", req, current: plainDoc(w.rec) });
    // (a whole write: the notebook-level fields it doesn't name go, as a write with no holder leaves the record)
    const gone = Object.fromEntries(Object.keys(shown).filter((k) => k !== "cells" && k !== "mode" && !ENVELOPE.includes(k) && !(k in w.doc)).map((k) => [k, undefined]));
    page.replaceDoc!({ ...gone, ...w.doc, mode: w.doc.mode ?? w.rec.mode, rev: w.rec.rev });
    // (the replacement's save, asked for by the notebook once its own loading step is done (two microtasks), then
    // waited for: a hand-over that begins meanwhile waits for it too (its quiesce))
    await Promise.resolve();
    await Promise.resolve();
    try {
      await page.quiesce();
    } catch (e) {
      return end(req, w, { t: "failed", req, why: `the change couldn't be saved there (${String((e as Error)?.message ?? e).slice(0, 200)})` });
    }
    const rec = await st.loadRecord().catch(() => null);
    await pause("wrote", req);
    end(req, w, { t: "wrote", req, rev: rec?.rev ?? null });
  }

  return {
    bind,
    /** This tab writes the document now (the takeover's reload done, the focus back where it was): said to the other
     * tabs, what was typed meanwhile typed again, and a want heard meanwhile answered. */
    taken(st: any) {
      if (st !== store) return;
      stopWanting();
      post({ t: "writer", tab });
      const ops = buffer;
      buffer = [];
      if (ops.length) replay(ops);
      void handOver();
    },
    /** This tab's takeover failed (it couldn't be opened as the writer): the keys kept for it can never be typed in
     * here; how many, for the page to say. */
    failed(): number {
      const n = buffer.length;
      buffer = []; shadows.clear(); stopWaiting(); stopWanting();
      return n;
    },
  };
}
