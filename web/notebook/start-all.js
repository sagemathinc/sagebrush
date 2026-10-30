// Turning sync on starts every one of this device's notebooks' synced histories (sync-docs, #1 (a) of William's first
// DEV sync try, Oct 30): a notebook's history starts only at a writer's load with DOC_SYNC on (journal/store.js load,
// then startSynced), so one nobody opens after sync is turned on never goes up, and the other device lists it with
// no content ever.  This walks them, each loaded as its writer and let go, exactly as opening it would: recovery and
// startSynced run as they always do, through no other write path.
//   startAll(seams) -> { total, started, held, tooLarge: [path], noRoom: [path], failed: [path], stopped }
// Seams (the page's; a test's fakes):
//   list()          this device's own notebooks: [{ ref, path }] (not listed from the server, not missing, not in Trash)
//   startOf(ref)    the notebook's synced history's start, or null if it hasn't started here (readJournal's)
//   storeFor(ref)   a journal store for it (the page's storeFor), or one that isn't journaled
//   syncOn()        whether the page's notebooks' sync is (still) on (DOC_SYNC.on)
//   current()       the notebook the page has open (its own load already started it), or null
//   idle()          a pause between notebooks (the page's idle time), resolved when the next may go
//   stopped()       true once the page is leaving: the walk ends where it is, and the next load goes on from there
//   progress(done, total)
// Each load's outcome is the store's own (store.js keeps why a start was refused, `startRefused`): started; another
// tab writes it (a read-only load: held, that tab or a later walk starts it); too large (its root patch, measured under
// the writer's lock as doc-sync would send it, over the batch bound: never started, counted by name); refused for room
// (the walk ends: the rest would be refused the same way); anything else (counted by name, the walk goes on).  Sync
// turned off meanwhile ends the walk (nothing said of the rest; what was counted before may still be said).  Every
// store loaded is let go.
export async function startAll(s) {
  const out = { total: 0, started: 0, held: 0, tooLarge: [], noRoom: [], failed: [], stopped: false };
  const cur = s.current();
  const todo = [];
  for (const n of await s.list()) {
    if (n.ref === cur) continue;
    try {
      if ((await s.startOf(n.ref)) === null) todo.push(n);
    } catch (e) {
      out.failed.push(n.path);
      console.warn("sync: a notebook's synced history not read:", n.path, e);
    }
  }
  out.total = todo.length;
  for (let i = 0; i < todo.length; i++) {
    if (s.stopped() || !s.syncOn()) { out.stopped = true; break; }
    const { ref, path } = todo[i];
    s.progress(i, todo.length);
    let st = null, end = false;
    try {
      // (checked again: another tab may have started it since the list was read)
      if ((await s.startOf(ref)) !== null) continue;
      st = await s.storeFor(ref);
      if (!st?.journaled) continue;
      await st.load();
      if (!st.writer) out.held++;
      else if (st.synced) out.started++;
      else if (!s.syncOn()) { out.stopped = true; end = true; }
      else if (st.startRefused?.tooLarge) out.tooLarge.push(path);
      else if (st.startRefused?.room) { out.noRoom.push(path); end = true; }
      else out.failed.push(path);
    } catch (e) {
      out.failed.push(path);
      console.warn("sync: a notebook's synced history not started:", path, e);
    } finally {
      try { await st?.release?.(); } catch {}
    }
    if (end) break;
    await s.idle();
  }
  s.progress(todo.length, todo.length);
  return out;
}

/** The page's startOf seam over a journal read (readJournal(hdb, ref)): a read that fails rejects, so the walk counts
 * the notebook as failed rather than passing over it (astra3's N-SA-1 on #353). */
export const journalStartOf = (read) => async (ref) => (await read(ref)).start;

/** What the person is told of a walk: null when there is nothing to say. */
export function startAllSummary(r) {
  const parts = [];
  if (r.tooLarge.length) parts.push(`${r.tooLarge.length} notebook${r.tooLarge.length === 1 ? " is" : "s are"} too large to sync yet (${names(r.tooLarge)})`);
  if (r.noRoom.length) parts.push(`starting the rest stopped at ${names(r.noRoom)}: this browser's storage for sync is full`);
  if (r.failed.length) parts.push(`${r.failed.length} couldn't start syncing (${names(r.failed)}); they're tried again at the next load`);
  return parts.length ? `Sync: ${parts.join("; ")}` : null;
}
const names = (paths) => paths.slice(0, 3).map((p) => p.split("/").pop()).join(", ") + (paths.length > 3 ? `, and ${paths.length - 3} more` : "");
