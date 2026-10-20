# The workspace's recovery copy (part B of design/workspace-durability.md)

*Status: design note, for astra and daybreak2, then William. Docs only. @sagebrush-board, Oct 20.*

- This is part B of the browser durability design, moved out of design/workspace-durability.md (revision 2, 7b167969) so that part A, detection, can clear and be built on its own.
- **Its next revision is in progress.** It answers astra's points on 7b167969: immutable capture at commit, pending groups as GC roots, explicit document checkpoints, and the manifest pinned through a restore. It also answers daybreak2's LIMIT-DUR-4: whole-group admission against the ceiling.
- The finding and the promise are design/workspace-durability.md §1 and §2.


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

## Order of work

| # | Step | Size |
|---|---|---|
| B1 | The recovery copy's writer: transaction groups, framing, segments, snapshots, the manifest, room, paused and stale (B.1 to B.3, B.6) | 4 days |
| B2 | Documents' latest content (B.4) | 1 day |
| B3 | Restore: paged, verified, sync left off (B.7) | 2 days |
| B4 | Bytes in OPFS, content-addressed, with deletion by reference and the migration (B.5) | 4 days |
| B5 | The reminder and `persist()` (B.8) | 0.5 days |
