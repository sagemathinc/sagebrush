// Turning sync on starts every one of this device's notebooks' synced histories (sync-docs, #1 (a) of William's first
// DEV sync try, Oct 30): a notebook's history starts only at a writer's load with DOC_SYNC on (journal/store.js load,
// then startSynced), so one nobody opens after sync is turned on never goes up, and the other device lists it with
// no content ever.  This walks them, each loaded as its writer and let go, exactly as opening it would: recovery and
// startSynced run as they always do, through no other write path.
//   startAll(seams) -> { total, started, held, tooLarge: [path], noRoom: [path], failed: [path], stopped }
// Seams (the page's; a test's fakes):
//   list()          this device's own notebooks: [{ ref, path }] (not listed from the server, not missing, not in Trash)
//   startOf(ref)    the notebook's synced history's start, or null if it hasn't started here (readJournal's)
//   sizeOf(ref)     the UTF-8 bytes of what its history keeps (versionedOf), or null if it has no record here
//   storeFor(ref)   a journal store for it (the page's storeFor), or one that isn't journaled
//   current()       the notebook the page has open (its own load already started it), or null
//   idle()          a pause between notebooks (the page's idle time), resolved when the next may go
//   stopped()       true once the page is leaving: the walk ends where it is, and the next load goes on from there
//   progress(done, total)
// A notebook another tab writes is left (its load here is read-only): that tab starts it at its next load as writer,
// or a later walk does.  One whose root patch couldn't be sent (over the batch bound, LIMITS.batchBytes: doc-sync
// stops a patch over 1 MiB) is never started, only counted: started, it would be stopped for good.  A start refused
// for room (the history's quota, the sync debt's caps) ends the walk: the rest would be refused the same way.
export async function startAll(s) {
  const out = { total: 0, started: 0, held: 0, tooLarge: [], noRoom: [], failed: [], stopped: false };
  const cur = s.current();
  const todo = [];
  for (const n of await s.list()) {
    if (n.ref === cur) continue;
    if ((await s.startOf(n.ref)) === null) todo.push(n);
  }
  out.total = todo.length;
  for (let i = 0; i < todo.length; i++) {
    if (s.stopped()) { out.stopped = true; break; }
    const { ref, path } = todo[i];
    s.progress(i, todo.length);
    // (checked again: another tab may have started it since the list was read)
    if ((await s.startOf(ref)) !== null) continue;
    const size = await s.sizeOf(ref);
    if (size === null) continue;
    if (size > s.maxBytes) { out.tooLarge.push(path); continue; }
    let st = null;
    try {
      st = await s.storeFor(ref);
      if (!st?.journaled) continue;
      await st.load();
      if (!st.writer) out.held++;
      else if (st.synced) out.started++;
      else {
        // (the load's start refused: for room (it said so, and stays local until a later load), so the rest are too)
        out.noRoom.push(path);
        break;
      }
    } catch (e) {
      out.failed.push(path);
      console.warn("sync: a notebook's synced history not started:", path, e);
    } finally {
      try { await st?.release?.(); } catch {}
    }
    await s.idle();
  }
  s.progress(todo.length, todo.length);
  return out;
}

/** What the person is told of a walk: null when there is nothing to say. */
export function startAllSummary(r) {
  const parts = [];
  if (r.tooLarge.length) parts.push(`${r.tooLarge.length} notebook${r.tooLarge.length === 1 ? " is" : "s are"} too large to sync yet (${names(r.tooLarge)})`);
  if (r.noRoom.length) parts.push(`starting the rest stopped at ${names(r.noRoom)}: this browser's storage for sync is full`);
  if (r.failed.length) parts.push(`${r.failed.length} couldn't start syncing (${names(r.failed)})`);
  return parts.length ? `Sync: ${parts.join("; ")}` : null;
}
const names = (paths) => paths.slice(0, 3).map((p) => p.split("/").pop()).join(", ") + (paths.length > 3 ? `, and ${paths.length - 3} more` : "");
