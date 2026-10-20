# The workspace's durability in a browser

*Status: design note, for astra and daybreak2, then William. Docs only. @sagebrush-board, Oct 20.*

- **Revision 2** answers astra's CORR-045-1 to 4 and daybreak2's LIMIT-DUR-1 to 3.
- **It is in two parts:**
  - **Part A, detection,** is small and precise, and is built first.
  - **Part B, the recovery copy,** is its own architecture, with the promise it can keep.

## 1. The finding

A browser killed at the wrong moment can make Chrome **delete everything the site keeps in IndexedDB** on its next start: the workspace index, data files' bytes, boards, notebooks and their histories, and the old store. The page is told only by a non-standard flag.

**How it was reproduced:** on Chrome 155.0.8059.84 (Linux), by the workspace-crash test, which SIGKILLs the browser while the migrator writes. Chrome's log on the next start:

```
backing_store.cc:237]  Failed to open LevelDB database from …/http_127.0.0.1_35697.indexeddb.leveldb, Corruption: checksum mismatch
backing_store.cc:1642] Got corruption for { origin: http://127.0.0.1:35697 … }, checksum mismatch
backing_store.cc:1502] IndexedDB recovering from a corrupted (and deleted) database.
```

- **On disk:** before the restart, `indexeddb.blob` held 125 files (13 MB) and `leveldb` 6 files. After it, only a new, empty `leveldb`.
- **Frequency in that experiment:** 1 kill in about 290, with 24 concurrent browsers beside 40 CPU hogs; none in about 280 kills under lighter loads. This is evidence of one process-kill failure, not a measured rate of loss for people.
- **Deterministic reproduction:** flipping bytes at the tail of the LevelDB `.log` before a restart gives the same deletion every time.
- Details, and what was ruled out: /home/user/notes/workspace-crash-empty-origin.md.

**Chrome does this by design.** It deletes all of an origin's IndexedDB when the backing store is corrupt at open, and tells the page through `dataLoss: "total"` and `dataLossMessage` on the `upgradeneeded` event. These fields are non-standard, but in Blink's current IDL.

**In other browsers** (desk research only, no measurement):
- **Firefox:** bug reports show a database that stays unopenable until the site's data is cleared (Mozilla 1230737, 1849842).
- **Safari:** WebKit reports show databases dropped to version 0 on iOS (WebKit 200078).
- **Safari's cap:** WebKit deletes a site's script-writable storage after seven days of Safari use without user interaction with the site, and treats Home Screen web apps separately (webkit.org/blog/10218).
- **What we don't know:** the relative rates of these failures.

## 2. What we promise, honestly

**In a browser:**
- **Detection (part A):**
  - when a record that survived says this browser held a workspace, or the browser itself says it deleted one, and it's gone or older, the person is told at once, and nothing writes until they decide;
  - a complete clearing of the site's data (by the person, a private session ending, Safari's cap, or eviction) removes every local record with it, and looks exactly like a first visit; we can't tell those apart without a record off the device (a synced account);
  - storage we can't read is reported as unknown, never as empty.
- **Recovery (part B):**
  - this browser keeps a second copy of the workspace, at most some seconds behind, and the Storage panel shows how old it is;
  - a restore brings the workspace back as of that copy's last committed point, and says what that point was;
  - changes made after it are lost: normally under 10 s, and longer while the copy is paused (it says so);
  - the copy shares the browser's fate where the browser clears or loses everything of the site.
- **Off this device:** sync, and an export the person keeps.

**In the desktop app**, the workspace is files in a folder the app owns, plus SQLite (WAL) for the index:
- every change writes its bytes first (a temporary file, fsync, rename, then the directory's fsync), and then commits the index;
- so an acknowledged change survives a crash or a power cut, as far as the disk keeps what it said it wrote;
- it doesn't survive the disk's loss or the files' deletion;
- that is a stronger promise than a browser allows, not an absolute one.

## Part A. Detection (build first)

### A.1 The witnesses

Two markers outside IndexedDB, each `{v: 1, workspace: id, generation: g, seq, entries, sampled: t}` (about 200 bytes):
- **`seq`** is the workspace's committed counter, `Workspace.generation()`: the latest op seq or the floor of the dropped ops, whichever is larger. It never goes down: deletes, pruning and dropping ops don't lower it.
- **`workspace`** is the workspace's id. **`generation`** is bumped by a deliberate reset: "Start a new workspace", an import that replaces, or "Delete this browser's workspace".

**Where they live and when they're written:**
- **localStorage `sagebrush-workspace-marker`:** written in the same Web Lock hold (`sagebrush-workspace`) as each commit, right after the commit's transaction completes. That covers the first save: the marker exists before the save is reported.
- **OPFS `/sagebrush/marker.json`:** written by the same lock holder, at most every 10 s and on `visibilitychange` to hidden.
- **No regressions:** a marker is replaced only by one with the same workspace and a higher (generation, seq), compared inside the lock. Tabs hold the lock in turn, so an older tab can't publish an older seq.
- **The first-save window:** the time between a commit and its marker write, inside one lock hold. A clearing of IndexedDB alone in that window is the case not covered.

### A.2 What the page decides at open

| State | When | What the person sees |
|---|---|---|
| **Confirmed loss** | `upgradeneeded` with `dataLoss: "total"` (Chrome), or the open made the database new (`oldVersion` 0) while a witness has this browser's workspace | "This browser's copy of your workspace was lost. The browser reported it damaged, or it's gone. It had 312 entries when last recorded, <time>." The marker's sample time is its last record, not the time of the loss. |
| **Suspected loss** | the workspace's `generation()` is below a witness's `seq`, with the same workspace and generation: changes it had are missing | "Some recent changes to your workspace are missing from this browser (it has up to change 1,204; it had 1,250)." |
| **Unknown** | IndexedDB won't open (Firefox's failure), or a witness can't be read (private browsing, storage denied) | It says so, and that loss can't be detected here. It never treats this as a first visit. |
| **First use, or cleared** | no workspace and no witness | Nothing, as now. Indistinguishable from a complete clearing (§2). |

- **Deliberate changes are never taken for loss:**
  - a reset or a replacing import bumps the generation in both witnesses first;
  - a mass delete or pruning doesn't lower `seq`;
  - there's no entry-count heuristic.
- **Missing or corrupt markers:**
  - one marker missing or corrupt: the other is used;
  - both missing: first use or cleared;
  - both present and disagreeing: the higher (generation, seq) counts.
- **Other workspaces:** a witness with another workspace id is kept and reported as "a different workspace this browser had", never compared as this one's.

### A.3 Quarantine

In **confirmed** or **suspected** loss, the workspace opens **quarantined**. Every writer stops until the person decides:
- the workspace's verbs (they refuse with "quarantined", the agents' too);
- autosave and the board's and notebook's saves (the editors open read-only, saying why);
- the migrator, reconcile, the sync sender and adoption, the recovery copy's writer (part B), and the markers themselves.

**The choices:** restore (part B, when there is a copy), restore from sync, import an export, or "Start a new workspace here". Starting new bumps the generation in both witnesses, then lifts the quarantine. In the **unknown** state, the workspace works as far as storage allows, with the notice.

### A.4 Tests

- **The real fault:** the crash harness's flipped-bytes restart (Chrome deletes the origin and sets `dataLoss`) gives confirmed loss, with the witness's numbers, and every writer quarantined, each one tried.
- **First visit vs. full clearing:** a true first visit, and the same with every local store removed. Both show nothing, which is the honest indeterminate result, said in this note.
- **The first save:** a first save, then IndexedDB removed before any OPFS tick. The localStorage witness gives confirmed loss.
- **Witnesses:** one witness missing; one corrupt; both disagreeing.
- **Private or denied storage:** localStorage and OPFS made to throw gives unknown, never first use.
- **Two tabs:** committing alternately, with the OPFS writes delayed out of order. The markers never regress.
- **Deliberate changes:** a mass delete, then op pruning, then a generation reset: no false loss.
- **Partial loss:** IndexedDB restored to an older copy of itself gives suspected loss.

**Size:** 2 days.

## Part B. The recovery copy

### B.1 The commit point

**The primary store is IndexedDB.** A save is acknowledged when its IndexedDB transaction commits, as now.

**The recovery copy is a second copy in OPFS that follows it.**
- It is written by **one writer**: the tab holding the Web Lock `sagebrush-recovery`, as the sync sender is one tab.
- It covers a committed prefix of the workspace's transactions. Its **authoritative point** is the last transaction group whose every frame and every referenced byte is published under the current manifest (B.3).
- It lags by at most the writer's interval (10 s) while it runs, and the Storage panel shows its point and age.

### B.2 What it holds

The copy holds resulting records, never ops (astra: local ops aren't reducer inputs):
- **Transaction groups.** Each group is the after-images, or the tombstones, of every record one committed IndexedDB transaction changed.
- **Read from the committed state.** The writer reads each transaction's changed records from IndexedDB, after it committed. A per-store adapter turns each record into its frame, so a folder move, an emptied Trash or a discard is covered like any other change.
- **What a frame records.** Each record's full fields: path, kind, ref, fid, sha256, size, trashed, made, mode, nkey, created, updated and rev.

**Covered:**
- the index (entries, Trash);
- documents' latest content: one content-addressed snapshot per document (B.4);
- data files' bytes: content-addressed (B.5).

**Not covered, and reset on a restore (deliberately):**
- TimeTravel histories;
- data files' earlier versions;
- grants (a document asks again);
- migration state (a restored workspace is new-style throughout);
- sync's state: the outbox, pins, the confirmed index and its cursor.

**Restoring never sends anything.** After a restore, sync is off for that workspace. Turning it on is the first sync's adoption (design/sync-client.md C3), which asks first. A restore never allocates a `dseq` or makes a conflict copy. It writes records as they were, into a new IndexedDB generation, and never goes through the sync reducer.

### B.3 Format and publication

**Framing.** A frame is one line:

```
{v, ws, gen, tg, part, parts, seqFrom, seqTo, records: [...], crc32}
```

- A frame is at most 64 KiB encoded.
- A transaction group larger than one frame, such as a 100,000-entry folder move, is split into parts. It counts only when every part is present and every checksum holds.

**Segments.** Segments are files of at most 4 MiB.

**Reading.** Recovery reads at most 64 KiB per line. The committed prefix ends at the first frame that is torn, fails its checksum, is oversized, or has a gap in `seq`. Everything after it is ignored and reported, never applied in part.

**Snapshots.** One is taken every 10,000 transactions or every 8 MiB of segments, whichever comes first.
- It is built in pages of 500 records into a temporary file, then flushed. There is never a whole-tree `JSON.stringify`, and at most one page is in memory.
- It is published by the manifest, then the segments it covers are deleted.

**The manifest.**
- **Two slots,** `manifest-a.json` and `manifest-b.json`. Each records the snapshot's file, its seq and checksum, the segments after it, and the blob set it needs.
- **Writing.** Each slot is written whole and flushed; the newer valid slot wins.
- **Deletion.** Nothing a valid slot names is deleted until the other slot is newer and verified.

**When snapshots keep failing.** If a snapshot can't be made (quota, a failure, an interruption):
- retries back off from 1 minute, doubling to 1 hour;
- the segments keep growing only to a ceiling of 64 MiB;
- past that, the writer stops appending and the copy is shown **stale** ("the recovery copy is from <time>: there isn't room to update it").

The person's saves are never refused or slowed by the copy.

**Before building on OPFS:** feature tests in the writer's worker for OPFS, sync access handles, `flush()` and, where used, `move()`. Without them, the copy is "not available in this browser", shown, and part A still works.

### B.4 Documents' latest content

**When.** When a document's save settles: at most once a minute per document, and one document at a time.

**What.** Its content goes to `/sagebrush/docs/<sha256>.json`: serialized and hashed in bounded chunks, within the document's own size cap (a board's 64 MiB). The transaction group names the snapshot by its hash.

**When it is deleted.** An old document snapshot is deleted only when no manifest-retained snapshot or segment names it.

### B.5 Data files' bytes, content-addressed and immutable

Bytes move from IndexedDB's `fileBytes` to `/sagebrush/blobs/<sha256>` in OPFS.

**Writing a new blob:**
1. a temporary file, flushed;
2. then its name;
3. then it is verified by its hash;
4. only then is the IndexedDB transaction that names it committed.

**The rules:**
- **Never changed:** a blob is never overwritten, so an older recovery point's bytes stay as long as it does (astra's A-then-B case).
- **Stored once:** these are the workspace's own bytes, not a duplicate.
- **Deletion:** by reference count, over the index's entries, the versions and every manifest-retained snapshot and segment. A blob goes only when nothing retained names it.
- **The migration:** 1a's, again: batched, reserved, crash-tested, and the old copy dropped after the hash check.

**Until this step is built,** the copy covers the index and documents only. A restore then lists data files whose bytes it doesn't have, with "restore from sync or an export".

**Not claimed (CORR-045-3).** OPFS keeps its own metadata. A browser fault there, or a clearing of the site, can lose the copy and the blobs together. No salvage beyond what OPFS's own API returns is assumed. The copy guards against the measured IndexedDB failure, not every failure.

### B.6 Room and accounting (LIMIT-DUR-1)

The copy counts in "Storage in this browser" as its own line, **recovery copy**: overhead, not the person's content, and never against an account's plan storage.

**Reserve before materializing:**
- **Each operation reserves its peak** through the page's byte reservation (reserve.ts) before it writes:
  - a snapshot: the new snapshot while the old one and its segments remain;
  - a document snapshot: the new one beside the old, plus a temporary file;
  - the bytes' migration: the source, the temporary file and the target;
  - a restore: the rebuilt IndexedDB data while the copy stays whole.
- **Without room:** the copy is **paused**, shown with its last point, retried with the backoff above, and never blocks a save.

### B.7 Startup and restore cost

**Startup** reads the two markers and the two manifest slots (four small files) and IndexedDB's metadata. It never scans segments.

**A restore** runs in pages of 500 records and yields between them, showing progress ("restoring 41,000 of 100,000 entries"). It writes into a new IndexedDB generation, verifies it against the manifest's counts and hashes, and only then makes it the workspace. The copy is kept until the person has the workspace back.

### B.8 The export reminder

**When it is checked.** One persisted next-reminder time, checked only when the Storage panel or the workspace is active. There is no timer, and no per-tab schedule.

**When it shows.** At most once in seven days, when there's no sync and the workspace holds more than 10 files (from the usage counts already kept, without walking the tree).

`navigator.storage.persist()` is asked once the workspace holds anything the person made. It guards against eviction, not corruption or clearing. The panel says whether it was granted.

### B.9 Tests

**Interruption at every boundary.** Each boundary is interrupted by a kill:
- after a blob's flush, its name, or its verification;
- after a frame's write;
- after the IndexedDB commit;
- between the two markers;
- during a snapshot, a slot's write and segment deletion;
- during a restore.

**Then:**
- the committed prefix is coherent;
- no blob that a retained manifest names is missing;
- an older recovery point still restores after newer overwrites.

**Several saves inside one writer interval.** A restore then reports the copy's point, and loses only what came after.

**Two writer tabs.** Only one writes.

**Quota.**
- Exhausted at each reservation: the copy pauses, and saves go on.
- The 64 MiB ceiling: the copy goes stale, not growing.

**Bad frames.** Corrupt, oversized and torn frames each end the prefix and are reported.

**A full restore.** A workspace with folders, data bytes, boards, notebooks, Trash, restore, emptied Trash, discard, provenance, and pending sync state. Hashes and fields match the copy's point. Sync comes back off, and nothing is sent. This is run offline, and with sync on.

**Bounds.** 100,000 entries: snapshot and restore within page, memory and longest-task bounds, with progress.

## 3. Order of work

| # | Step | Size |
|---|---|---|
| A | Detection: the witnesses, the states, quarantine (part A) | 2 days |
| B1 | The recovery copy's writer: transaction groups, framing, segments, snapshots, the manifest, room, paused and stale (B.1 to B.3, B.6) | 4 days |
| B2 | Documents' latest content (B.4) | 1 day |
| B3 | Restore: paged, verified, sync left off (B.7) | 2 days |
| B4 | Bytes in OPFS, content-addressed, with deletion by reference and the migration (B.5) | 4 days |
| B5 | The reminder and `persist()` (B.8) | 0.5 days |

That is about 13½ days. A goes first, before more workspace code; each step is its own branch.

## 4. Open questions

1. **For William:** in the browser, is the promise "told when a surviving record shows loss, restored from a copy at most seconds old, saying how old" the right one, with the stronger one kept for the desktop app?
2. **For William:** should sync be suggested more strongly (the switch offered once the workspace holds more than N files), since only sync survives a complete clearing?
3. (Answered by daybreak2) The recovery copy counts in this browser's storage, as overhead, not against plan storage.
