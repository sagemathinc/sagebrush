// Focus takeover: the tab of this browser a person is using takes its document's writer lock at once, and the tab that
// had it follows (read-only, still showing every change, saying nothing) until it is used again (web/journal/store.js:
// writerLock's enqueue and passOn, the store's yieldLock).  One channel per document, named as its lock is:
//   want {tab, at, q?}: this tab was used (`at`: when) and doesn't write the document: the writer hands it over, once
//     the want answers its question (`q`, below);
//   writer {tab}: this tab writes it now (its want answered);
//   who-wants {q?}: a writer back from being frozen or hidden, or about to let go (`q`: its question's id): a used tab
//     still waiting asks again, with that id (a want sent while it was frozen may never have reached it; the lock is
//     let go only for a want that answers the writer's current question);
//   bye {tab}: this tab is gone, or shows another document now.
// A tab granted the lock while another was used more recently and wants it passes it on at once (passOn), so the lock
// goes to the tab in use, not to whichever was first in the lock's queue.  What is typed into the tab in use before it
// writes is kept, and typed again into the same place once it does: up to 5000 input actions, and of a paste its text only.
// No input is dropped without a word: what is kept is typed in once its field can take it (the cell still read-only, or
// not shown yet, as the takeover settles: typed in as soon as it can be); what never can be (its cell gone from the
// document, another document shown, the takeover failed, no field to type it into, or past the 5000 kept) is counted,
// and the page says how many input actions weren't applied.

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
};

// (what the person typed before this tab could write: text, a deletion, a cursor move or another key, kept in order,
// each with where it was typed: the field's place and the selection in its text as typed so far)
type Where = { k: string; s: number; e: number };
type Op = ({ text: string } | { del: -1 | 1 } | { move: -1 | 1 } | { key: KeyboardEventInit }) & { at?: Where };
// (a field typed into while this tab can't write: the selection in its text as it will be once the kept keys are typed
// in, that text's length, the field's own selection when last read (a click or a cursor key moves it), and the edits so
// far at their places in the field's own text, to place a moved selection among them)
type Shadow = { s: number; e: number; len: number; real: [number, number]; edits: { o: number; d: number }[] };

export function writerHandover(page: HandoverPage) {
  const tab = Math.random().toString(36).slice(2);
  let store: any = null, ch: BroadcastChannel | null = null, lastUse = 0, wanting = false, handing = false, composing = false;
  // (while this tab wants it: asked again every second until a tab says it writes (a writer still loading, or one that
  // missed the message, answers then).  Always with when this tab was really last used: the last tab used wins, so a
  // want another tab's use overtook never takes the lock from the tab being typed in; it waits, its keys kept, until
  // this tab is used again (a later `at`) or the writer lets go)
  let reask: ReturnType<typeof setInterval> | null = null, lastPost = 0;
  const want = (q?: string) => { lastPost = Date.now(); post({ t: "want", tab, at: lastUse, ...(q ? { q } : {}) }); };
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
  // (`q`: the question the want answered, if it answered one)
  const wants = new Map<string, { at: number; heard: number; q: string | null }>(), passed = new Set<string>();
  // (each want heard, told to whoever waits for the answer to a question: asked again before letting go, below)
  const onWant = new Set<() => void>();
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
    // (leaving this document: asks its writer to drop this tab's want, as for a tab gone; a writer paused or frozen
    // meanwhile may not hear it, and its question below is what keeps the lock then)
    post({ t: "bye", tab });
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
    if (!m || typeof m.tab !== "string" && m.t !== "who-wants") return;
    if (m.t === "want" && typeof m.at === "number") { wants.set(m.tab, { at: m.at, heard: Date.now(), q: typeof m.q === "string" ? m.q : null }); for (const f of [...onWant]) f(); void handOver(); }
    else if (m.t === "writer" || m.t === "bye") wants.delete(m.tab);
    else if (m.t === "who-wants" && wanting) want(typeof m.q === "string" ? m.q : undefined);
  }
  // (a want asked again before the lock is let go for it: who-wants posted with a new question id, and a want that
  // answers it (the same id) within 500 ms, from a tab used later than this one.  A tab still waiting answers at once; a
  // tab that moved on (another document shown) or is gone doesn't, and a want sent before the question (one queued
  // while this writer was paused or frozen, delivered late) carries no answer to it: for wants answered by id, a tab
  // that moved on never gets the lock.  The wants that didn't answer are dropped)
  let confirming = false;
  const confirmed = () => new Promise<boolean>((done) => {
    const q = Array.from(crypto.getRandomValues(new Uint32Array(2)), (x) => x.toString(16).padStart(8, "0")).join("");
    const again = () => [...wants.values()].some((w) => w.q === q && later(w) && fresh(w));
    const finish = (ok: boolean) => {
      clearTimeout(timer); onWant.delete(check);
      if (!ok) for (const [t, w] of wants) if (w.q !== q) wants.delete(t);
      done(ok);
    };
    const check = () => { if (again()) finish(true); };
    const timer = setTimeout(() => finish(again()), 500);
    onWant.add(check);
    post({ t: "who-wants", q });
  });
  // (another tab wants it: the want asked again, everything typed here saved, then the lock let go; a want heard while
  // this tab is still taking over is answered once it has (taken))
  async function handOver() {
    const st = store;
    if (!st || !writes() || handing || confirming || !standing()) return;
    confirming = true;
    let ok = false;
    try { ok = await confirmed(); } finally { confirming = false; }
    if (!ok || store !== st || !writes() || handing || !standing()) return;
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
