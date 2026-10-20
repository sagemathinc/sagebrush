# The workspace's recovery copy (part B of design/workspace-durability.md)

*Status: design note, for astra and daybreak2, then William. Docs only. @sagebrush-board, Oct 20.*

- This is part B of the browser durability design, moved out of design/workspace-durability.md (revision 2, 7b167969) so that part A, detection, can clear and be built on its own.
- **Revision 3** answers astra's points on 7b167969:
  - capture staged in the commit (B.2);
  - checkpoints, a paged snapshot with its tail (B.3);
  - pending groups as GC roots (B.5);
  - explicit document checkpoints and ages (B.4);
  - the manifest pinned through a restore, and slot verification and retention (B.3, B.7).
- It also answers daybreak2's LIMIT-DUR-4: whole-group admission, all or none (B.3a).
- **Revisions 5 and 6** answer daybreak2's LIMIT-A54-1: saves' actual contract (B.3), and a blob written and verified outside the workspace's lock, with only the handoff inside it (B.5).
- **Revision 4** answers astra's CORR-A54-1 (a checkpoint crossed by an over-size group, B.3b) and CORR-A54-2 (a blob's handoff to the commit that names it; what startup cleanup may delete, B.5, B.3a).
- The finding and the promise are design/workspace-durability.md §1 and §2.


### B.1 The commit point

**The primary store is IndexedDB.** A save is acknowledged when its IndexedDB transaction commits, as now.

**The recovery copy is a second copy in OPFS that follows it.**
- It is written by **one writer**: the tab holding the Web Lock `sagebrush-recovery`, as the sync sender is one tab.
- It covers a committed prefix of the workspace's transactions. Its **authoritative point** is the last transaction group whose every frame and every referenced byte is published under the current manifest (B.3).
- **Documents' content has points of its own** (B.4). A restore reports the index's point and each document's separately.
- It normally lags by the writer's interval (10 s). That isn't a hard bound: a checkpoint, a pause or a stale copy lags longer. The Storage panel shows the copy's actual age: the commit time of its authoritative point, recorded in its last group.

### B.2 What it holds

The copy holds resulting records, never ops (astra: local ops aren't reducer inputs):
- **Transaction groups.** Each group is the after-images, or the tombstones, of every record one committed IndexedDB transaction changed.
- **Captured in the commit (astra, on 7b167969).** The transaction itself writes its group into an IndexedDB store, `rcStage`, keyed by its seq. That is the after-image of every index record it changed, keyed by the record's key (a path, so a move is the old keys' tombstones and the new keys' records), made by a per-store adapter.
  - So a group is exactly that transaction's result. A later transaction can't change what it says, which reading the records again afterwards couldn't promise.
  - The writer moves staged groups into OPFS frames in order, and deletes each from `rcStage` only once its frames are published under a manifest.
  - Data files' bytes and documents' content are named by hash, not copied into `rcStage` (B.4, B.5).
  - So a folder move, an emptied Trash or a discard is covered like any other change.
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

**Checkpoints.** One is taken every 10,000 transactions or every 8 MiB of segments, whichever comes first, or when B.3a asks for one.

A checkpoint is a snapshot plus its tail:
- **Its start, S0.** The snapshot begins at seq S0, read from the workspace's counter inside one read transaction.
- **Its pages.** It reads IndexedDB in pages of 500 records into a temporary file, flushed. A page read later may hold a later state, such as folder /a from before a move with /b/x from after it.
- **Its end, S1.** It ends at seq S1, the counter when the last page was read.
- **Its tail.** The checkpoint is the snapshot plus the staged groups (S0, S1]. Groups are per-key assignments, so applying the tail over any mix of states between S0 and S1 gives exactly the state at S1.
- **Keeping the tail.** `rcStage` keeps the groups from S0 until the checkpoint is published.
- **Bounds.** At most one page is in memory, with no whole-tree `JSON.stringify`.
- **Publication.** A checkpoint is published by a manifest slot naming the snapshot, its S0 and S1, and the tail's frames. Then the segments it covers are deleted.

**The manifest.**
- **Two slots,** `manifest-a.json` and `manifest-b.json`. Each records the snapshot's file, its seq and checksum, the segments after it, and the blob set it needs.
- **Writing.** Each slot is written whole and flushed; the newer valid slot wins.
- **Deletion.** Nothing a valid slot names is deleted until the other slot is newer and verified.

**When snapshots keep failing.** If a snapshot can't be made (quota, a failure, an interruption):
- retries back off from 1 minute, doubling to 1 hour;
- the segments keep growing only to a ceiling of 64 MiB;
- past that, the writer stops appending and the copy is shown **stale** ("the recovery copy is from <time>: there isn't room to update it").

**The person's saves and the copy:**
- **Never refused** by it.
- **Normally not slowed:** the copy is written asynchronously, after the commit.
- **One exception (B.3b):** after two invalidated checkpoints in a row, the third reads its pages holding the workspace's lock, and saves made meanwhile wait for it. That wait is at most 3 s at 100,000 entries, tested.

### B.3a A group too big for the journal (LIMIT-DUR-4)

**Admission.** A group is admitted whole or not at all. In the committing transaction, its encoded size is counted as its records are staged; a record is at most about 2 KiB, since a path is at most 1,024 characters.

**Small groups.** A group that would take more than 4 MiB, or more than the journal's room left under its 64 MiB ceiling, isn't staged record by record. The transaction stages one constant-size record instead, `{seq, checkpoint: needed}`. The writer then makes a checkpoint (B.3) whose S1 is at or past that seq, instead of appending the group. A 100,000-entry folder move is that case.

**Checkpoints without room.** The checkpoint needs room for a whole snapshot. Without that room, reserved first (B.6), nothing is appended, and the copy stays at its prior point, shown **stale**. Its later groups aren't kept either: once stale, `rcStage` holds only the `checkpoint: needed` record, so it can't grow.

**Unpublished parts.** When the writer starts, it deletes, in pages, only its own temporary journal files: temporary snapshot files (`tmp-*`), and segments' frames past the published point. It never deletes a blob or a document snapshot at startup: those go only by B.5's deletion, which honours every root and pin.

### B.3b A checkpoint crossed by an over-size group (CORR-A54-1)

A checkpoint's pages can't be repaired by a group staged only as `{checkpoint: needed}`: it has no assignments to replay. So:
- **Restarted.** A checkpoint under way is invalidated and started again when any such marker is staged with a seq after its S0. The same holds for a group suppressed because the copy is stale. The writer checks before reading each page, and before publication.
- **Bounded.** The third attempt in a row holds the workspace's lock while it reads its pages: at most 3 s at 100,000 entries (the test's bound, with about 1 s measured). Saves wait meanwhile, and are never refused; the page shows "saving…". Restarts are therefore bounded without needing a quiet interval.
- **While stale.** A checkpoint that will bring a stale copy back starts staging groups again from its S0. It has its tail like any other.
- **Never across a gap.** A slot is published only if its tail's seq runs continuously from S0 to S1. Otherwise the checkpoint is started again.

**Before building on OPFS:** feature tests in the writer's worker for OPFS, sync access handles, `flush()` and, where used, `move()`. Without them, the copy is "not available in this browser", shown, and part A still works.

### B.4 Documents' latest content

**When.** When a document's save settles: at most once a minute per document, and one document at a time.

**What.** Its content goes to `/sagebrush/docs/<sha256>.json`: serialized and hashed in bounded chunks, within the document's own size cap (a board's 64 MiB). The transaction group names the snapshot by its hash.

**When it is deleted.** An old document snapshot is deleted only when no manifest-retained snapshot or segment names it.

**Its own checkpoint (astra).** A document's snapshot records its own point: the document's revision and the time it was taken. The manifest lists each document's latest snapshot with that point.
- A restore brings each document back as of its own point, which may be up to a minute (or, while paused, more) older than the index's point. It names each document whose snapshot is older than its last save in the restored index.
- A document's snapshot never stands for the global point.

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
- **Deletion:** a blob goes only when no root names it. The roots are:
  - the index's entries and the versions;
  - every group still in `rcStage`, staged but not yet published (astra: a file's index and version references can go before its group is published);
  - both valid manifest slots and everything they retain;
  - an in-progress checkpoint.

  Deletion runs in pages, holding the workspace's lock and the recovery lock, so no new reference appears while a page is decided.
- **The handoff (CORR-A54-2, LIMIT-A54-1).** A new blob is written and checked before the workspace's lock is taken, and the lock is held only for the short handoff.
  - **Outside the lock:**
    - a temporary file, `/sagebrush/tmp/<tab>-<n>`, written while the tab holds the Web Lock `sagebrush-tmp-<tab>`;
    - flushed, and verified by its hash.
    - Temporary files are never deletion candidates.
  - **Inside the lock**, in one hold:
    - the temporary file is given its final name `/sagebrush/blobs/<sha256>` (if a blob of that hash is already there, the temporary file is dropped instead);
    - then the IndexedDB commit that names it, which makes it a root.
    - Deletion needs the same lock, so it can never fall between the name and the commit. The hold is a rename and one commit, whatever the file's size.
  - **The startup cleanup** deletes a temporary file only when its tab's `sagebrush-tmp-<tab>` lock isn't held (`navigator.locks.query`), so no live tab's file is taken.
  - A blob orphaned by a kill between the two is named by nothing, and goes at the next deletion, correctly.
  - A pending restore's `restore.json` pins its slot's blobs too.
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

**A restore** runs in pages of 500 records and yields between them, showing progress ("restoring 41,000 of 100,000 entries"). It writes into a new IndexedDB generation, verifies it against the manifest's counts and hashes, and only then makes it the workspace (part A's reset protocol, A.3a). The copy is kept until the person has the workspace back.

**The manifest is pinned through a restore.**
- The restore holds the recovery lock for its whole length, and writes `/sagebrush/restore.json` naming the slot it reads from. No writer, checkpoint or deletion runs meanwhile; the workspace is quarantined anyway (A.3).
- A restore interrupted by a kill finds that file at the next start and goes on, or starts again, from the same slot.

**Verified slots.** A slot is valid if its checksum holds and every file it names exists with its recorded size and checksum: the snapshot's pages, the tail's and segments' frames, the documents' snapshots, and the blobs. A slot that fails is never used and never deleted. The other slot is used, and the failure is reported.

### B.8 The export reminder

**When it is checked.** One persisted next-reminder time, checked only when the Storage panel or the workspace is active. There is no timer, and no per-tab schedule.

**When it shows.** At most once in seven days, when there's no sync and the workspace holds more than 10 files (from the usage counts already kept, without walking the tree).

`navigator.storage.persist()` is asked once the workspace holds anything the person made. It guards against eviction, not corruption or clearing. The panel says whether it was granted.

### B.9 Tests

**Capture at commit.** A transaction T1, then T2 overwriting, deleting and renaming T1's records before the writer runs. The copy still restores T1's state at T1's point.

**Checkpoint consistency.** Moves and writes during a checkpoint's pages (folder /a before, child /b/x after). The restored state is exactly S1's.

**Over-size groups.** A 100,000-entry move with near-limit paths:
- with an empty journal and with a nearly full one, a checkpoint is made instead, all or none;
- without room for the checkpoint, the copy goes stale at its prior point, appends nothing, and `rcStage` holds one record.

A kill during that checkpoint leaves unpublished parts, which are reclaimed at the next start.

**A checkpoint crossed (CORR-A54-1).** An over-size move during a checkpoint's pages restarts the checkpoint. Another during the restart restarts it again. The third attempt holds the lock and publishes. At 100,000 entries, its lock hold, and the end-to-end time of a save made during it (from the save's call to its commit), are each under 3 s. While stale, a move suppressed during the checkpoint restarts it. No slot is ever published with a gap. The age shown is the authoritative point's commit time.

**The blob handoff (CORR-A54-2, LIMIT-A54-1).** Deletion attempted between a blob's naming and the commit naming it waits for the lock, and the blob stays.
- **A maximum-size blob (200 MB) with slow I/O injected** (each write and flush delayed). The workspace's lock is held only for the handoff, at most 200 ms. A save queued meanwhile commits within 200 ms of the lock being free, measured from its call. The pre-publication time isn't the bound.
- **A temporary file:** one being written by a live tab is never deleted at another tab's startup. One from a tab that's gone is. A restart finds blobs named only by the primary store, only by a staged group, or only by `restore.json`. None is deleted by the startup cleanup or by deletion.

**GC with pending groups.** A file deleted, and its version dropped, while its group is still staged. Its blob stays until the group is published and nothing retains it.

**Restore.** A kill during a restore: it resumes from the same slot. A corrupt newer slot: the older valid one is used.

**Documents.** A document's snapshot older than the index's point: reported as such, by name.

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

## Order of work

| # | Step | Size |
|---|---|---|
| B1 | The recovery copy's writer: capture in the commit (`rcStage`), framing, segments, checkpoints with their tails, whole-group admission, the manifest, room, paused and stale (B.1 to B.3a, B.6) | 5 days |
| B2 | Documents' latest content (B.4) | 1 day |
| B3 | Restore: paged, pinned, verified, sync left off (B.7) | 2.5 days |
| B4 | Bytes in OPFS, content-addressed, with deletion by reference and the migration (B.5) | 4 days |
| B5 | The reminder and `persist()` (B.8) | 0.5 days |
