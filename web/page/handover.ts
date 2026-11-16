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
// writes is kept, and typed again into the same place once it does (no keystroke lost to the handover).

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
};

// (what the person typed before this tab could write: text, a deletion, a cursor move or another key, kept in order)
type Op = { text: string } | { del: -1 | 1 } | { move: -1 | 1 } | { key: KeyboardEventInit };

export function writerHandover(page: HandoverPage) {
  const tab = Math.random().toString(36).slice(2);
  let store: any = null, ch: BroadcastChannel | null = null, lastUse = 0, wanting = false, handing = false, composing = false;
  // (while this tab wants it: asked again every second until a tab says it writes (a writer still loading, or one that
  // missed the message, answers then), each time as used now, so a tab passing the lock on never takes it for stale)
  let reask: ReturnType<typeof setInterval> | null = null;
  const want = () => post({ t: "want", tab, at: (lastUse = Math.max(lastUse, Date.now())) });
  const startWanting = () => {
    if (wanting) return;
    wanting = true;
    want();
    // (still wanting while its own takeover reloads: keys typed then are kept too; asked again only while it follows)
    reask ??= setInterval(() => { if (!wanting) return stopWanting(); if (follows()) want(); }, 1000);
  };
  const stopWanting = () => { wanting = false; if (reask) clearInterval(reask); reask = null; };
  // (other tabs' wants not yet answered: tab -> when it was used; and those this tab already passed the lock on for)
  const wants = new Map<string, number>(), passed = new Set<string>();
  let buffer: Op[] = [];
  const post = (m: object) => { try { ch?.postMessage(m); } catch {} };
  const writes = () => !!store?.writer && !!store.ready;
  const follows = () => !!store?.journaled && store.readOnly === "other";

  // (the store shown, from showWriter: a new channel for a new document)
  function bind(st: any) {
    // (the same store shown again (showWriter after a load): a want heard while it was still loading answered now)
    if (st === store) return void handOver();
    if (store) store.passOn = null;
    ch?.close();
    ch = null; store = st; stopWanting(); buffer = []; wants.clear(); passed.clear();
    if (!st?.journaled || typeof BroadcastChannel !== "function") return;
    ch = new BroadcastChannel(st.kind.lockPrefix + st.id);
    ch.onmessage = (ev) => heard(ev.data);
    st.passOn = () => {
      const now = Date.now();
      for (const [t, at] of wants) {
        // (a want is passed on for once, and only while fresh: a tab that died with a want left can't hold it forever)
        if (at > lastUse && now - at < 5000 && !passed.has(t + at)) { passed.add(t + at); return true; }
      }
      return false;
    };
  }
  function heard(m: any) {
    if (!m || typeof m.tab !== "string" && m.t !== "who-wants") return;
    if (m.t === "want" && typeof m.at === "number") { wants.set(m.tab, m.at); void handOver(); }
    else if (m.t === "writer" || m.t === "bye") wants.delete(m.tab);
    else if (m.t === "who-wants" && wanting) want();
  }
  // (another tab wants it: everything typed here saved, then the lock let go; a want heard while this tab is still
  // taking over is answered once it has (taken))
  async function handOver() {
    const st = store;
    if (!st || !writes() || handing || !wants.size) return;
    handing = true;
    page.hold();
    try {
      const done = await st.yieldLock(async () => {
        // (an unfinished composition (IME) ended first, so its text is in the cell: leaving the field commits it)
        if (composing) (document.activeElement as HTMLElement | null)?.blur?.();
        await page.quiesce();
      });
      if (store === st) {
        if (done) stopWanting();
        page.follow();
      }
    } finally {
      handing = false;
    }
  }
  // (a person's use of this tab: only real input (isTrusted) while this window has the focus; a page's own focus, a
  // tab opened in the background or one just shown isn't a use)
  function used(ev: Event) {
    if (!ev.isTrusted || !document.hasFocus()) return false;
    lastUse = Date.now();
    if (!follows() && writes()) return false;
    if (follows()) startWanting();
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
    if (buffer.length < 5000) buffer.push(op);
  }, true);
  page.view.addEventListener("paste", (ev) => {
    if (!used(ev)) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    if (text && buffer.length < 5000) buffer.push({ text });
  }, true);
  page.view.addEventListener("compositionstart", () => { composing = true; });
  page.view.addEventListener("compositionend", () => { composing = false; });
  // (back from being frozen, or shown again: a want sent meanwhile may not have arrived)
  const again = () => { if (writes()) post({ t: "who-wants" }); };
  document.addEventListener("resume", again);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") again(); });
  addEventListener("pagehide", () => post({ t: "bye", tab }));

  // (typed again, in order, into the field that has the focus: as the person typed it, through the field's own input
  // events, so the page saves it as any typing)
  function replay(ops: Op[]) {
    for (const op of ops) {
      const ta = document.activeElement as HTMLTextAreaElement | null;
      const field = !!ta && (ta.tagName === "TEXTAREA" || ta.tagName === "INPUT") && !ta.readOnly;
      if ("key" in op) { (ta ?? page.view).dispatchEvent(new KeyboardEvent("keydown", { ...op.key, bubbles: true, cancelable: true })); continue; }
      if (!field || !ta) continue;
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
  };
}
