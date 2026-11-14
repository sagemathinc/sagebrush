// The notebook page's session functions, moved out of web/index.html as they were (no behaviour changed): starting a
// notebook's TimeTravel history, a read-only tab's takeover as the writer, and DEV's switch (reopening through the
// journal, the read-only it leaves, a session's recreation, the switch's ownership and its reload).  What they use of
// the page, and the page's state they set, is `p`: index.html gives its own variables through getters and setters, the
// tests (web/notebook/test-journal.page.js) a plain object.

/** The page, as these functions see it: its notebook, interpreters, journal helpers, TimeTravel, storage, and the
 * state they read and set (nbHistory, historyQueue, ttUnavailable, textHashFn, writerBarTimer, replaying, replayEnded,
 * docSwitch, docSyncNeedsReload). */
export type PageContext = Record<string, any>;

export function pageSession(p: PageContext) {
  // (a journal's store keeps its own history, T1 of its every save (notebook/journal.js): shown here, never recorded
  // from the page's changes, and let go, not closed, when another notebook opens: its saves still running finish first)
  let nbJournal: any = null, nbHistoryOff: any = null;
  async function startHistory(id: string) {
    // (the journal's store let go only if the page now shows another: the same store reattached (a takeover's reload)
    // keeps its lock and its history (astra's CORR-215-1); notebook/journal.js switchJournal)
    if (!nbJournal) p.nbHistory?.close();
    nbJournal = p.journalPage.switchJournal(nbJournal, p.nb.store);
    nbHistoryOff?.();
    nbHistoryOff = null;
    p.nbHistory = null;
    if (nbJournal) {
      p.nbHistory = nbJournal.history;
      p.historyQueue = [];
      p.kernels.get(id)?.journal?.flushPending(id);
      nbHistoryOff = p.nbHistory.on(() => { if (!p.ttEl.hidden) p.ttRefresh(false); });
      if (!p.ttEl.hidden) p.ttRefresh(true);
      return;
    }
    // (the notebook as it opened: the history caught up to the store's document, from the history's own head, the one
    // version made from the head (this browser's local history, which no other device writes); every later one from
    // the page's base (index.html's "change"))
    p.historyQueue = [{ doc: p.nb.snapshot(), base: "head" }];
    const hdb = await p.historyDbReady;
    if (!hdb) {
      p.ttUnavailable = "TimeTravel needs this browser's storage, which is not available here (a private window of some browsers?).";
      if (!p.ttEl.hidden) p.ttRefresh(true);
      return;
    }
    let NotebookHistory: any;
    try { ({ NotebookHistory, textHash: p.textHashFn } = await p.loadHistory()); } catch (e) { return console.warn("history:", e); }
    if (p.current.id !== id) return;
    const h = new NotebookHistory(new p.IdbPatchStore(hdb, id));
    await h.init();
    if (p.current.id !== id) return h.close(); // another notebook opened meanwhile
    p.nbHistory = h;
    // (nothing for one that is the last version; one with no base is not recorded: said, never guessed)
    for (const { doc, base } of p.historyQueue.splice(0)) {
      if (base) h.record(doc, base === "head" ? h.docOfHead() : base);
      else console.warn("history: a change with no base, not recorded");
    }
    p.kernels.get(id)?.journal?.flushPending(id);
    h.on(() => { if (!p.ttEl.hidden) p.ttRefresh(false); });
    if (!p.ttEl.hidden) p.ttRefresh(true); // opened while the history was loading
  }
  // (a read-only tab that became the writer: reopened as it, said, the reader's place kept: the scroll, and the cell
  // that had the focus (board's 2))
  async function takeOver(store: any, id: string) {
    if (p.current.id !== id || p.nb.store !== store) return;
    const at = p.anchorOf(p.nb), focused = (document.activeElement?.closest?.("#cells .cell") as any)?.cell?.id ?? null;
    try { await p.open(store, id); } catch (e) {
      // (it couldn't be reopened as the writer here: the lock let go at once, so another tab (or this one, reloaded) can
      // take it, rather than held by a tab that never writes; and said (board's C))
      console.warn("notebook:", e);
      await store.release();
      p.writerBar.hidden = false;
      p.writerBar.textContent = p.journalPage.TAKEOVER_FAILED;
      p.writerBarHeight();
      return;
    }
    p.restoreAnchor(p.nb, at);
    if (focused) ([...document.querySelectorAll("#cells .cell")].find((el: any) => el.cell?.id === focused) as any)?.cell?.ta?.focus({ preventScroll: true });
    // (said in the bar itself for a few seconds, where the reason was (the status line is also the interpreter's))
    p.writerBar.hidden = false;
    p.writerBar.textContent = p.journalPage.TAKEOVER;
    p.writerBarHeight();
    p.writerBarTimer = setTimeout(() => { if (!p.nb.store?.viewOnly) { p.writerBar.hidden = true; p.writerBar.textContent = ""; p.writerBarHeight(); } }, 6000);
  }
  // (DEV's switch, after the journal's activation: the notebook shown, if one was opened before it, opened again through
  // the journal, its synced history started (DOC_SYNC is on by then).  Whether it is: a failure lets go of the new store
  // and the old one (their writer locks: another tab, or this page reloaded, can take them), and leaves no store attached,
  // so nothing is editable with nowhere to save it (astra's DEVSW-2))
  async function reopenJournaled() {
    // (one navigation lease over all of it, its cleanup (a detach, the writer locks let go) included: #447 r5c,
    // R5-NAV-2 (2))
    const end = await p.navLease();
    try {
    if (!p.current.id || p.current.kind !== "browser" || (p.nb.store?.journaled && p.nb.store.synced)) return true;
    const id = p.current.id, prev = p.nb.store;
    let st: any = null;
    try {
      st = await p.storeFor(id);
      await p.open(st, id);
      if (p.nb.store === st && st.journaled) return true;
      throw new Error("the notebook isn't open through the journal");
    } catch (e) {
      if (p.trashTest.pause) await p.trashTest.pause("recovering");
      console.warn("sync: the notebook not reopened through the journal:", e);
      if (p.nb.store && (p.nb.store === st || p.nb.store === prev)) p.nb.detach();
      for (const x of new Set([st, prev])) if (x?.journaled) try { await x.release(); } catch {}
      return false;
    }
    } finally {
      end();
    }
  }
  // (what holds for the notebook shown, the switch's read-only set back from it: read-only with no store attached (nowhere
  // to save), one another tab writes, a quarantined workspace, or a session being recreated)
  function shownReadOnly() {
    return !p.nb.store || !!p.nb.store.viewOnly || !!p.ws?.quarantined || p.replaying || p.docSyncNeedsReload;
  }
  // (a session's recreation (TimeTravel's replay, the reactive recompute): `run` with the notebook owned and read-only,
  // after DEV's switch if it holds it (checked with no await before replaying is set), and never once the switch ended in
  // reload (astra's DEVSW-2-R3: a recreation queued behind it doesn't run, and can't unlock the notebook); the read-only
  // then set back from what holds (shownReadOnly: no store, another tab, quarantine, reload).  Resolves run's result, or
  // null if it didn't run)
  async function recreating(run: () => Promise<any>) {
    while (p.docSwitch) await p.docSwitch;
    if (p.docSyncNeedsReload) {
      p.statusEl.textContent = p.DOC_SYNC_RELOAD;
      return null;
    }
    let endReplay: any;
    p.replayEnded = new Promise((r) => { endReplay = r; });
    p.replaying = true;
    p.nb.setReadOnly(true);
    try {
      return await run();
    } finally {
      p.replaying = false;
      endReplay();
      p.nb.setReadOnly(shownReadOnly());
      if (p.journal.session) p.journal.session.replay = false;
    }
  }
  // (the notebook owned by DEV's switch from its read-only to its last restore (astra's DEVSW-2-R2): it waits for a
  // session's recreation to end, and a recreation asked meanwhile waits for the switch (before it sets `replaying`);
  // returns the release)
  async function ownNotebook() {
    while (p.replaying || p.docSwitch) await (p.replaying ? p.replayEnded : p.docSwitch);
    let end: any;
    p.docSwitch = new Promise((r) => { end = r; });
    return () => { p.docSwitch = null; end(); };
  }
  // (the switch's `reload`: the journal's activation began and this page couldn't go on with it: the notebook and the
  // page's controls for it read-only, and said, until a reload)
  function docSyncReload() {
    p.docSyncNeedsReload = true;
    clearTimeout(p.writerBarTimer);
    p.nb.setReadOnly(true);
    p.writerBar.hidden = false;
    p.writerBar.textContent = p.DOC_SYNC_RELOAD;
    p.writerBarHeight();
    p.nbName.readOnly = true;
    p.modeEl.disabled = true;
    p.$("#ttrepro").disabled = true;
    p.$("#ttclear").disabled = true;
    p.$("#ttrevert").disabled = true;
  }
  return { startHistory, takeOver, reopenJournaled, shownReadOnly, recreating, ownNotebook, docSyncReload };
}
