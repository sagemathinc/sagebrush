# The sync client, slice 1: the workspace index and its files

*Status: plan, for @sagebrush, before anything is built. @sagebrush-board wrote it with @sagebrush-auth, who checked the server-facing facts against master bf21f6e4. The server is design/sync-server.md; the workspace is design/workspace-files.md §7.*

## 1. What slice 1 does, as the person sees it

- **A "Sync this workspace" switch,** in the Storage panel. It shows only when the person has signed in with CoCalc (Share…), and works only for accounts that may sync.
  - It calls `POST /api/sync/v1/enable`. A refusal is shown as the server words it: "sync isn't enabled for this account", "sync isn't available for this account" (plan off) or "CoCalc can't be reached".
  - Before it turns on, it says what will be uploaded (for example "62 files, 34 MB") and the account's limit.
- **Once on, on this device:**
  - the workspace index (folders, names, renames, Trash) goes up as it changes;
  - data files' bytes go up by SHA-256, once each.
- **On a second browser or device signed in to the same account,** with the switch on, the same tree appears.
  - Data files arrive, are listed, and open.
  - **Notebooks and boards are listed, but their content is slice 2.** Until then, opening one that this device doesn't have shows it read-only, empty, with "This notebook's content is synced in the next step: open it on the device that made it". It can't be typed into (§6).
- **The file browser's foot** says "Synced · 2 min ago", "Syncing 3 files…", "Offline: 5 changes wait" or "Paused: …".
  - A row shows ↑ while it is waiting to go up, and ⚠ on a conflict copy.
- **"Delete my synced data"** is in the Storage panel, and is confirmed first. This device's own copy stays.
- **Everything still works offline and without sync.** The switch off means the workspace is exactly as today.

## 2. What it leaves for later

- **Slice 2: documents' content.** Each notebook's and board's patch log goes up and comes down in batches over the account socket (§5.3's `batch` and `pull`), merged by patchflow. A document socket for live co-editing comes after that.
- **Phones' "in the cloud" files:** fetched only when opened, with "Keep on this device". In slice 1 every device fetches every file, as a computer would.
- **Files over 95 MiB** (the server's single-PUT limit) stay on their device, with ⚠ "too large to sync yet", until multipart uploads exist.
- **Uploading versions:** the server keeps its own versions of overwrites (sync-server §3).
- **End-to-end encryption.**

## 3. How it works

**The device** is the workspace's own device id (meta "device", 16 hex), which the server accepts as is.

**What goes up: the operation log.** Every change to the workspace already records an op in its own transaction (`ops`), and slice 1 adds the contents' identity to each op:
- `ref`;
- for a data file, its `fid`, `sha256` and `size`;
- for a write, `base` (the `sha256` it replaced);
- `parent`: on an op that puts something in a folder (create, mkdir, adopt, a write that makes its file, rename, restore), that folder's `fid`. Absent for the root, or to go by the path. It is optional on the wire; the server stores and echoes it, and refuses it on other ops (@sagebrush-auth). See C4;
- `after`: the identity's resulting state, `{id, parent, name, kind, sha256, size, trashed}`, with `parent` the parent folder's identity (C3's replay and C2's summary use it).

This is the "client's log plus identity" of sync-server §3. Hashing new bytes happens before their transaction, as the 1a migration already does.

As built (step 2a):
- A data file's entry keeps its `sha256` (a write no longer drops it). The migrator gives it to a file written before, and gives every entry its identity key `ident`, the entries' `byIdent` index key. Both are filled in, a batch at a time, after the version 4 upgrade drops the migration's state.
- `after.parent` is `null` for the root, and for something put in Trash itself, which carries `trashed: true`. Trash's own folder is the workspace's, and has no identity, as the root has none.
- `parent` on the op is absent for the root and for anything in Trash.
- `after: null` means the op removed its identity: `forget`, `discard`, and `emptyTrash`, which records one op for each identity removed whole. What was in a folder goes with it, as the reducer's forget has it.
- An op that changes no entry (`dropVersions`) carries no identity and no `after`. An entry or folder with no identity yet (from before ids were kept, until the migrator gives one) has no `after`.
- In the stores, a key can't hold `null`, so the root's parent is `""` there.
- **Hashing:** bytes the caller gives are copied once, at the call, before anything is awaited. The hash and the bytes kept are then the same, whatever the caller does with its buffer meanwhile (astra's CORR-9C2-1).
  - The copy is the engine's own: buffer, offset and length come from %TypedArray%.prototype's getters, and %TypedArray%.prototype.set copies into a new Uint8Array. No method, getter or species of a caller's subclass runs.
  - Views of other kinds (DataView, Int16Array) are refused, as before.
  - Peak cost: that copy, plus one transient copy while hashing (WebCrypto copies its input). That is two copies of the new bytes beyond what a write held before this step, each at most the 200 MiB file limit.
  - Time: one more pass over the new bytes, off the main thread.
  - The old bytes are hashed only when no hash of them is already at hand: a file written before this step, once.
- **Every data-file op carries its hash: none is ever logged without it** (astra's CORR-9C2-2; @sagebrush's decision: no deferral).
  - Create and write compute the hash.
  - A move of a file written before its hash was kept hashes it first, under the lock, reserved before it as a migration is.
  - **An adopt moves the bytes it hashes** (astra's CORR-12E-1). In the one transaction that makes the entry and its op, the snapshot read is put in fileBytes, the entry is marked migrated, and the old copy is marked stale with that snapshot's size and hash. The entry, its bytes, and its op's hash and `after` then all name the same bytes.
    - The old copy then goes as the migrator's does (dropStale): deleted if it still holds those bytes. If an older tab wrote there since the read, it is kept as a file of its own, adopted and moved in turn with its own hash.
    - The read is reserved. Reconcile's old-way bytes are adopted after its locked pass: each one reserves LEGACY_MAX × COPIES before the lock, then reads and adopts holding it (adoptOld).
    - Any other adopt not given the bytes reads them itself, holding the caller's lock, under a reservation taken without waiting. If that reservation isn't free, the adopt is refused, nothing is made, and reconcile asks again on its next run.
    - The move's copy is the one IndexedDB gave on read, put back once. That is within the same LEGACY_MAX × COPIES as the migrator's move.
    - Every caller that gives an adopt bytes holds LEGACY_MAX × COPIES, taken before the lock, until the adopt and its old copy are done. adopt() fails loudly otherwise (daybreak2's LIMIT-6B7-1). Trash's bytes with no entry are therefore recovered after reconcile's locked pass, each reserved first, as adoptOld's are.
    - Old copies are compared and kept one pair at a time: at most 8 rounds per call, with no recursion. Their marks are durable and win over a migration marked done: each migrator start first cleans them up, paged and bounded, whatever the migration's state (astra's CORR-6B7-1).
      - Each start goes on from a durable cursor and wraps round, so marks that keep failing can't hide those after them (CORR-AC1-1).
      - A mark a cleanup leaves is counted on the mark itself (`fails`, at most 1,000) with why: `folder-full` (the folder its copy would be kept in), `limit` (another of the workspace's limits), `storage` (an error each time), `rounds` (it kept changing). Writing the count is best effort: one that can't be written is logged and the lap goes on. A lap that looked at every mark stores how many have been left three times or more (`staleStuck`: the count, at most 20 paths of at most 256 characters, a count per reason); a lap cut short keeps the last figure. The board page shows it as a closable notice whose words are true of each reason (nothing is ever deleted by a failed cleanup; only a full folder is named). Closed, it stays closed until the count rises or a new reason appears; with none left, it goes.
      - Old copies are the start's cleanup alone, never a batch's work: marks that can't go don't hold the passes over the index, nor keep a migration from being done (daybreak2's LIMIT-1F3-1).
      - Ownership is checked first: a key an entry already names as its bytes is that file's, its mark dropped, nothing re-adopted (astra's CORR-1F3-1).
      - An old copy is deleted only after a move of exactly those bytes. One kept unmoved is that file's storage and is never deleted. Nor is any key an entry still names as its bytes (CORR-AC1-2).
    - A reservation is a token: whoever reads bytes whole is given it and checks that it is live and large enough. The page's total isn't enough (daybreak2).
    - Trash recovery hashes the Trash bytes and lets them go before it checks the destination, then reads them again: at most two copies at once (LIMIT-AC1-1).
  - Bytes larger than LEGACY_MAX are adopted unmoved, with their hash, as the migrator marks them. They are over the 200 MiB file limit, so they are never synced.
  - Should any path reach an op without the hash, the change is refused whole.
  - A removal (forget, discard, emptyTrash) needs no hash: its identity is gone (`after: null`).
- **Emptying Trash records at most 10,000 ops** (maxFolderEntries, Trash's own entries), whatever is in them: a bounded burst.

**The queue: `dseq`.** The server decides a device's ops in `dseq` order, with no gaps.
- The local `seq` can't serve as `dseq`: ops from before sync was on, and remote ops applied here, are in the same store.
- So the client keeps its own outgoing queue, in `meta`, as `sync:out:<dseq>`. Each item points at a local op, with its identity filled in. The queue is bounded by the queue limits below.
- `ops` messages carry at most 500 items, with at most 8 requests unanswered.
- An `ack` removes accepted items. A refusal is final: the item is removed, and the index is rebuilt (below).

**The first sync** of a device that already has files merges, and never replaces (§7.6):
1. pull the server's index;
2. upload this device's tree as `adopt` ops (they sync as `create`). A path the server already has becomes `name (2)`, by the reducer;
3. then follow live.

**Files' bytes.** Before a data file's op is sent:
1. `blobs/check` lists the hashes the server is missing;
2. `PUT /blob/<sha256>` uploads them. The bytes are read from fileBytes under the page's reservation (reserve.ts), one file at a time.

Without the bytes, the server refuses the op with `missing`. `limit`, `storage_full` and `rate` pause the upload and say so; `busy` retries after `retry_after`.

**What comes down.**
- `welcome`, then `index` messages (and `pull_index` when `more`), give the server's ops after this device's cursor.
- Each is applied through **the shared reducer**, then to the local workspace in one transaction per message:
  - entries made, renamed, trashed or restored;
  - a data file listed with its `fid`, `sha256` and `size`, marked `remote` until its bytes are fetched;
  - and the op recorded locally, by its own device, so it is never sent back.
- Bytes come with `GET /blob/<sha256>`, which answers 303 to a signed URL (5 minutes) that the page fetches.
  - Each fetch is checked against the `sha256` and put in fileBytes. This uses the same reservation and quota preflight as the migrator.
  - Fetches run in the background, a few at a time.

**The reducer:** `web/workspace/sync-reduce.ts`, a deterministic `reduce(index, op)` that changes the index whole or not at all (with `clone()`, O(entries), never called per op), with no DOM or IndexedDB imports, so the Worker can bundle it. It implements §7.2's rules:
- the later rename wins;
- an edit after a delete brings the file back out of Trash;
- a second new file at a path becomes `name (2)`;
- a write whose `base` isn't the current `sha256` becomes `name (conflict, <device>).ext`.

Its test vectors are JSON, so the server's adoption of it (@sagebrush-auth, later) runs the same ones.

**After a refusal, or the server's `invalid "rebuild"`:** the local index is rebuilt as the reducer applied to the server's log, then this device's queued ops (sync-server §5.2).
- The difference is applied as above.
- A local entry that disappears from the result is never deleted silently: it is kept as a conflict copy, or listed in the Sync panel.

**Emptying Trash:** the server has no such op, so each entry emptied goes as `forget`, which is person-only.

**The connection:**
- one same-origin WebSocket to `/api/sync/v1/account`, authenticated by sharing's session cookie (`__Host-sb_session`);
- reconnects back off, and a 429 from the per-IP limit backs off too;
- with the page hidden, the queue keeps going while the socket is open.

**Reads and writes on the workspace go through its own verbs,** under its lock, so 1a's guarantees hold: one transaction per change, identity at use, the old-store fallback.

## 3a. Contracts (astra's CORR-8E7-1 to 5, daybreak2's LIMIT-SC1-1 to 4)

Each is an invariant the code must keep, and the schedules its tests must run. **Confirmed by @sagebrush-auth** (bf21f6e4):
- every op in an `index` message carries its `seq`, `device` and `dseq`;
- an ack maps each `dseq` to its `seq`;
- `fid` (16 hex) is accepted and echoed on any op of any kind, folders included. Its uniqueness and stability are the reducer's to check.

**Storage** (one more schema-only upgrade: no data moved. As in 1b's fix for CORR-D01-1, it drops the migration's state, so the migrator gives older entries their identity key):
- `outbox`, keyed by `[ns, dseq]`;
- `syncIndex`, the confirmed index, per `ns`;
- `adoptJournal`, the first sync's captured tree, keyed by identity, with a `byParent` index (C3);
- `pins`, keyed `[id, seq]`: the bytes committed here and not yet decided (C2), with their total;
- `pending`, by identity: what is waiting to go up for it (C2);
- the outbox's index `byIdent`, and the entries' index `byIdent` (on each entry's identity, written when it is made, and by the migrator for older entries, as 1b does for `nkey`).

`ns` is the namespace: `account_hash : generation : device`, from `welcome`.

### C1. The outbox: durable, immutable, one sender (CORR-8E7-1, LIMIT-SC1-4)

**Immutable items.** An outgoing op is an `outbox` record `{ns, dseq, op}`.
- Its `op` (with `ref`, `fid`, `sha256`, `size`, `base`) is fixed when the record is made, and never changes.
- A `dseq` is never reused in its `ns`.

**One mechanism for enqueueing and for overflow: the scan watermark.**
- Every local change already records its op in `ops`, in the change's own transaction, with the contents' identity added there (step 2: the hash is computed before the transaction).
- The sender turns ops after the watermark `sync:<ns>:scanned` into outbox records, a page at a time. In one transaction, a page:
  - reads at most 500 ops past the watermark;
  - makes records with the next `dseq`s;
  - pins their bytes (C2);
  - and advances the watermark.
- The outbox is bounded by count (10,000) and by actual encoded bytes (1 MiB, measured as each record's JSON with its keys), checked in that transaction. When it is full, the scan stops and the watermark stays: that is the overflow checkpoint.
- A crash leaves either the whole page or none. Ops made while the outbox is full are found by the next scan, from the watermark, in pages.
- **Ops this device applied from the server** (C3) are recorded with `origin: "server"`, an explicit field. The scan skips them. The device id is not an origin: this device's own echo carries its own device, and is never recorded as a new op (C3).
- **Ops not yet scanned are kept:** dropping op records (`dropOps`) never goes past the watermark.
- **A `dseq` is never skipped locally.** A record whose bytes this device no longer has is still sent. The server decides it: accepted if it holds those bytes already, else `missing`. Either way, the current state then goes as a new write based on that answer (C2).

**One sender per device.**
- The tab holding the Web Lock `sagebrush-sync:<ns>` is the only one with the account socket, the only allocator of `dseq`, and the only sender.
- Other tabs see the workspace change through its BroadcastChannel, as today.
- The lock passes on when the tab closes, and the new holder resumes from the durable state.

**Lost acks.**
- After a reconnect, `welcome.next_dseq` says how far the server has decided. Records below it are resent unchanged, and the server answers with its stored decision (§5.2).
- A record is removed only when its decision is known:
  - accepted: removed once its `seq` is in the confirmed index (C3);
  - refused (a per-op code): removed at once, and the index rebuilt from the confirmed state.
- **A top-level** `order`, `rate`, `busy`, `invalid "rebuild"` or a transport failure never removes an undecided record.

**Namespaces.**
- Signing in as another account, or a `welcome` with another generation (after "Delete my synced data" and enabling again), starts a new `ns`. The old one's outbox is never sent into it.
- Local changes still reach the new `ns` through its first sync (C3), which records the whole local tree.
- Turning sync off keeps the `ns` state; turning it on again resumes it if `welcome` says the same generation.

**As built (step 2b-1, web/workspace/sync-outbox.ts):**
- **One transaction per scan page.** The lease is checked, records are made with the next dseqs, the watermark is advanced past every op looked at, and the next dseq and the totals are written, all in one transaction. A cut at any of its awaits leaves all of it or none.
- **The bound** counts each record as the workspace's inert JSON writer writes it, two bytes a character (as TimeTravel's backlog counts an entry).
  - Each record is admitted at its charge: its size accepted with the largest seq acked() takes (a non-negative safe integer, sixteen digits at most, checked at the boundary).
  - The bound is kept on the sum of charges, so `bytes` (what is held now, an accepted record with its seq) $\le$ `charged` $\le$ 1 MiB always (daybreak2's LIMIT-855-1).
- **A full outbox is said, never silent.** `status().full` holds when, and at what totals, a scan last stopped at a bound, until a page goes on. The foot and the Sync panel show it (step 5).
- **Not sent:**
  - ops applied from the server (`origin: "server"`);
  - ops with no `after` (dropVersions: versions stay local);
  - ops from before ids were kept.
- **Sent as `forget`:** emptyTrash and discard.
- **A lease.** Each namespace is used under a lease: `sync:current`, `{ns, gen}`.
  - `switchTo(ns)` starts the next generation, for another account, another generation, or a reconnect.
  - Every change to an outbox, and every read of what to send, checks the lease in its own transaction. So nothing taken under an older lease is sent, or changes anything, across a switch mid-flight (`Fenced`).
  - The sender sends records only on the connection made under their lease (step 3).
- **dropOps** never passes the lowest scan watermark of any namespace.
- **Known, for a later lifecycle step:** each namespace's state (watermark, sequence, outbox, at most 1 MiB) is kept on purpose, so turning sync on again resumes it. Its total across many namespaces has no global cap yet. A later step garbage-collects old namespaces' outboxes after an account or generation change, with a cap (daybreak2).

**Tests:**
- a crash after a local change, before the scan;
- a crash mid-scan;
- two tabs of one device (only one connects; the lock handed over on close);
- a lost ack, then a reload (the same `dseq` resent with the same payload; the server's decision adopted);
- account switch, and generation change after a delete;
- outbox full: more edits, crash, reload, drain, and every local edit represented exactly once;
- each scan page within its count and byte bounds.

### C2. Committed bytes are pinned until decided (CORR-8E7-2, LIMIT-SC1-R2, LIMIT-SC1-R4)

**Pinned at the local commit, not at the scan.**
- While sync is on, every local change that commits new bytes records a pin, `pins` keyed `[id, seq]` (the identity and the committing op), with its `sha256` and size, in the same transaction.
- A later write that replaces bytes still pinned keeps them as a version, in its own transaction. It does so even where it otherwise wouldn't keep one (empty bytes, `keepEmpty: false`).
- The version is then exempt from pruning, from `dropVersions`, and from emptying Trash (which removes the entry; the bytes stay until decided).
- The scan hands the pin to the outbox record that names the hash. The adoption journal owns its records' pins until they drain (C3).
- A decision releases it: accepted once the `seq` is confirmed (C3), even when the ack came before the echo; refused at once. After that, ordinary retention applies.

**An upload reads exactly the bytes its record names:** the current file if its hash matches, else the pinned version. Current bytes are never sent under an older hash.

**The pending summary** (LIMIT-SC1-R4). Per identity, `pending` holds one record, written in the same transaction as each change, scan page or decision that touches the identity:
- `latest`: the seq and resulting state (`after`, §3) of its newest local op;
- `allocated`: its newest write record not refused (`dseq`, `sha256`, whether its bytes are still pinned, decided or not);
- `collapsed`: a seq at or below which its unscanned writes are not sent;
- `held`: set when a write was passed over by the scan and waits for a decision (below).

The record goes when nothing is pending for the identity. Every rule below reads and writes this one record, plus a bounded number of pins. None of them walks the `ops` tail.

**A write's `base`** is the `sha256` of the identity's `allocated` record if it has one, else its hash in the confirmed index. A write that follows an allocated A is therefore based on A, never on an older confirmed Z: A and its successor reach the reducer in that order, and no spurious conflict copy is made (astra).

**A cap on pinned bytes, without ever refusing a local save** (LIMIT-SC1-R2). A pin on bytes that are still the file's current ones costs nothing extra; only pinned bytes kept apart, as versions, count. That total is kept in the same transactions as the pins, and capped (1 GiB, or less when the browser's quota is smaller: half the estimated free space at the time). A save that would pass the cap does the following, all in its own transaction and all bounded:
1. **Collapses the identity's unscanned writes:** `collapsed` is set to the previous `latest` seq. That is one record written, whatever the length of the tail. The scan then skips those writes (no records), and sends only the newest, with its `base` as above. At most 32 of their pins are released now, through the pins' `[id, seq]` key range, each one taking its size off the total in the same transaction. The rest are released later, by a cleanup task in pages of 500, one transaction each.
2. **If still over, it doesn't pin the bytes it replaces.** The local save always succeeds. If those bytes belong to a record already allocated (A), A is still sent, unchanged (C1), and is now *unpinned*.
- The Sync panel says "some intermediate versions weren't uploaded", and lists their files.

**An unpinned record's decision is the server's, not presumed** (astra). The server checks its own holdings, not this device's, so A may be:
- **accepted:** the blob was uploaded before (an ack lost), or another device uploaded the same bytes. A takes effect like any accepted op. If the view later needs A's bytes (say, after a refusal of what followed), they are fetched like any remote content (C5).
- **refused `missing`:** A is removed (C1), and `allocated` falls back to the identity's confirmed hash.

Until A is decided, the scan allocates no further write for that identity. It sets `held` and passes on, so the watermark isn't stuck: one record written per skipped op. A's decision, in its own transaction, clears `held` and allocates one write for the identity's current state. Its `base` is A's hash if A was accepted; else the newest accepted record's not yet confirmed (`acceptedTip`), else the confirmed hash (see As built below). So the current state is scheduled in both cases, from the actual answer.

A held write is part of the view (C3). Its bytes are the file's current ones, so it adds nothing to the cap.

**Tests:**
- offline A then B writes to one file, then reconnect (A and B both uploaded, in order; B's `base` is A);
- the same with the outbox full, and with the sender closed;
- pruning, `dropVersions` and emptying Trash while A is pinned;
- an ack accepted before the echo (still pinned until the echo);
- overwrites with a tiny cap: saves never fail, and the server converges on the current bytes, with no conflict copy, in three vectors:
  - the server lacks A (refused `missing`; the successor's base is the confirmed hash);
  - A was uploaded before and its ack lost (accepted; the successor's base is A);
  - another device had uploaded A's bytes (accepted; likewise);
- **a long offline tail** (50,000 ops across 1,000 files), then 200 overwrites of one file at a 1 MiB cap. Each save reads and writes at most 40 records, counted by an instrumented store, and its longest task stays under 50 ms. The cleanup then drains in pages of 500;
- a crash mid-way, including part-way through the paged cleanup: no pin leaked, every pin owned by an op, a record or the journal, and the byte total equal to the sum of the retained pins.

**As built (step 2b-2):** settled with @sagebrush, astra and daybreak2 before the code, then amended by astra's P1 and P2, and by the review of e5c5993b (astra's CORR-E5C-1 to 3, daybreak2's LIMIT-E5C-1 and 2). The code is web/workspace/sync-pins.ts, with the outbox's scan and decisions in sync-outbox.ts. The workspace database is at v5. Its upgrade is schema only, as every upgrade is: the versions kept before are made prunable afterwards by the cleanup, a bounded slice at a time (daybreak2's LIMIT-563-2).
- **The lease's lifecycle.** Sync is on while `sync:current` is a lease that isn't off.
  - Off (turning sync off, signing out) writes `{ns, gen + 1, off: true}`. A switch writes `{ns', gen + 1}`. A reconnect takes a new generation of the same namespace.
  - Generations only ever increase. `sync:current` is never deleted, so no old lease can come back. A generation only fences stale writers.
  - **The lifecycle epoch** (`sync:epoch`) moves only on off, sign-out or a namespace switch, never on a reconnect (P1). It records a purge (`sync:purge` `{epoch, cursor}`) of every pin of an older epoch, done a page at a time by cleanPins. A reconnect keeps every pin.
  - The namespace's resume state (watermark, sequence, outbox, its pending fields) is kept: re-enabling resumes it.
- **Pins.** A pin is `pins[id, seq] = {path, sha256, size, epoch, storage, skey, orphan?, owner?}`.
  - `storage` says where its bytes are: `{fileBytes: fid}` while they are the file's present bytes or orphaned (`orphan`), `{version: id}` once kept apart. `skey` (`f:<fid>`, `v:<id>`) is indexed (`byStorage`).
  - `owner` is `{ns, dseq}`, the record a scan handed it to (P1: no generation in it, so a reconnect keeps it owned).
  - One pin per storage: a write of the same bytes again takes no pin.
  - `sync:pinBytes` totals the bytes pins keep of their own, apart or orphaned, against the cap: min(1 GiB, half the estimated free space). Charging past the cap releases the pin instead.
  - Pinned versions are exempt from pruning, dropVersions and emptyTrash's version drops. They have no record in the store `prunable` (database v5: one `{fid, id, t, size}` per version not kept for sync, by `[fid, id]`, with an index `byId`); a release puts one, if the file is still there. Every drop reads only that store, so only droppable ones.
- **Release** is one transaction with everything it implies:
  - the total goes down;
  - a version kept apart loses its exemption once no pin names it;
  - orphaned bytes go with the last reference to them: no pin naming that storage, no entry, and, from step 4, no journal record;
  - an owned pin marks its record unpinned (`allocated.pinned = false`) and notes `sync:skipped` `{count, files}`. No owned pin is ever deleted silently.
- **Orphans.** Emptying Trash while a file's present bytes are pinned keeps fileBytes[fid], charged as the pin's own (or released and noted if past the cap), and marks it (`sync:orphan:<fid>`). bytesFor reads them through the pin's `storage`, verifying the hash, under the read token. cleanPins sweeps only marked fids that no pin and no entry names; a file's own bytes are never candidates (an entry not yet given its identity would look unnamed).
- **Pending.** A pending record is `{id, latest, byNs}`.
  - `latest` {seq, by, after} is local and kept across namespaces.
  - `byNs[ns]` holds that namespace's `allocated` {dseq, sha256, pinned, state}, `acceptedTip`, `held`, `collapsed`, `cutoff` and `successor`. A new namespace's first write inherits no base, held bit or cutoff. A settled state is dropped once its identity's latest op is scanned.
- **Decisions.** An echo before the ack counts as acceptance. `acceptedTip` goes by dseq, so a late answer for an older record never moves it back.
- **The base.** A successor's base is:
  - `allocated.sha256` while that record is undecided or accepted;
  - else `acceptedTip` (the newest accepted, not yet confirmed);
  - else the confirmed index's (and, until C3 keeps syncIndex, the op's local base).
  - So with Z confirmed, A accepted but not echoed, B unpinned and refused `missing`, and C held, C's base is A, never Z.
  - A write whose bytes equal its base is skipped.
- **Held successors as durable intents** (astra's schedules 1, 2 and 5; P2).
  - A's decision (accepted, or refused `missing`) clears `held`. In the same transaction it records `successor: {base}`, the base from A's actual answer, and the identity in `sync:<ns>:successors`. It allocates nothing there, so an ack never needs room and the cap is never overrun.
  - A recorded successor gates allocation: no later write of that identity is allocated before it.
  - The scan drains successors only once a page has read every op logged (caught up, in that transaction), while there is room (astra's CORR-E5C-1). Every op before the successor, of the identity and of the folders it is in (a mkdir, a rename, a move, a removal), then already has its record, so the successor comes after all of them. Each becomes one write record of the identity's current state, read then: the entry by `byIdent`, its present sha and size, its path and parent. It is re-pinned on the present bytes, with `lseq` = latest.seq.
  - An identity in Trash (itself, or a folder it is in) keeps its successor waiting: a write would bring it back, and the removal stands (no resurrection, CORR-E5C-2). It goes once the identity is restored, after the restore's record, with its bytes; it ends as gone if the identity is deleted for good. Until then the server's Trash holds the identity's last accepted bytes. One the server never had (its create refused) is in this device's Trash only, until it is restored (then it goes) or emptied.
  - In that same transaction `cutoff` = latest.seq is recorded, so the scan later skips this identity's writes with seq ≤ cutoff (already represented). It does not skip its renames, removes or forgets.
  - If the current state is gone (no entry, or latest.after null: a forget or emptyTrash came first), no write is made and no identity is resurrected. The successor and held clear, its pins are released, and the deletion op goes as usual.
  - A renamed or moved current identity is allocated at its present path and parent.
- **Collapse** (a save past the cap):
  - `collapsed` is set to the previous latest seq, and at most PINS.collapseRelease (2) unowned pins with seq ≤ collapsed are released in that save's transaction. cleanPins releases the rest, begun after the save returns.
  - That cleanup is tagged with the save's namespace and lifecycle epoch (P1). In each slice's transaction it releases only unowned pins of that epoch or older, collapsed in that namespace. A run that starts after a later save, a reconnect, or sync turned off and on never takes an owned pin or one of a newer epoch.
  - If still over, the replaced bytes aren't kept apart: their pin is released (its record unpinned) and `sync:skipped` is noted.
  - A save that then fails for quota refuses the change whole: nothing is half-pinned.
  - Versions released together fall due for pruning together. A save drops at most PRUNE_STEP (1) of its file's versions past the count or the age, reading at most maxVersions + PRUNE_STEP (21) of its prunable records; past the bytes, at most 2 of everyone's, by `byId` (daybreak2's LIMIT-E5C-2). One version is kept a save, so without sync at most one is ever due past the count. Each drop is three requests: the version, its bytes, its prunable record. What is left is marked due (`versions:due:<fid>`, `versions:over`), and the cleanup drops it.
  - Count and age pruning happen on a file's saves and on the cleanup they leave due, not while a file sits unchanged. Should idle pruning be added, it goes through the same bounded cleanup.
- **The scan, for a data file's write** (create, write, adopt):
  - seq ≤ collapsed or ≤ cutoff: no record, its pin released, noted skipped.
  - held, a successor recorded, or the allocated record unpinned and undecided: `held`, no record, its pin released.
  - Otherwise: the record with the base above, its pin handed over (`owner`), `allocated` updated.
- **Ownership in one lookup each** (daybreak2):
  - "the last reference" is one count on the `byStorage` index (database v5);
  - each file's pin on its present bytes is pointed to by `sync:cur:<fid>`;
  - the sweep's candidates are the orphan markers.
  - So no ownership question scans pins.
  - A save reads the lease, the pin total and the epoch once per transaction. Every write of one goes through `metaWrite`, so a read after it in that transaction sees it. The cache is dropped when its transaction completes or aborts, so it never outlives it.
  - The cleanup goes a slice at a time, each slice one transaction, until nothing durable is left (daybreak2's LIMIT-E5C-1). Its steps, each from a durable cursor: the versions kept before v5 made prunable (`versions:backfill`, the last id done), the purge, collapsed pins, the orphan markers, then versions left due.
  - The upgrade makes `prunable` empty, so it builds no index over the versions already kept: its time doesn't grow with them (daybreak2's LIMIT-563-2; indexes on the versions store itself took 3.3 s over 50,000).
  - Until that backfill ends, a version kept before v5 has no prunable record, so it is kept, never wrongly dropped; none of them is pinned. A save meanwhile drops only what it can see and marks `versions:over` if it is past the bytes; the backfill marks it again at its end if the total is still past them, and the cleanup then drops the rest. The open never waits for it.
  - The backfill's end is fixed when it begins (`through`, the newest version's id then): versions saved since have prunable records of their own and are never its to walk, so however fast they come it ends, and the steps behind it (the purge, the version cleanup) run (daybreak2's round 4).
  - A deletion the person asks for never waits for the backfill (@sagebrush's round 5). Emptying Trash and dropVersions("/") delete straight from the versions store: a file's versions by the index byFile, everyone's by id, a page a transaction going on from the last one looked at, those kept for sync passed over, each with its prunable record if it has one. A file emptied from Trash has its whole prunable range deleted in one request on its last page. Each reports done only when every matching version not kept for sync is gone, and says its own progress as it goes (onDeleting: the board page shows "Deleting old versions… N%"). Measured: emptying Trash of one file with 50,000 versions kept before v5, none backfilled, takes 9.7 s.
  - Emptying Trash marks each file's versions to go (`versions:gone:<fid>`) in the transaction that removes its entry; a reload part way through leaves the cleanup to finish them, and the backfill deletes, never makes prunable, a version so marked. A backfill page racing a deletion reads only versions still there, so it leaves no prunable record without its version.
  - A drop of a file's that needs its versions in the order kept (its newest `keep`, a fence) first puts that file's versions kept before v5 in the prunable store (finishBackfillFor), bounded by that file's versions, not the whole store's.
  - The backfill makes no version of a file deleted for good prunable: it deletes it, as the deletion would have, once the migrator has given every entry its identity (until then absence can't be told).
  - A file's due versions: the newest maxVersions stay, found by a key cursor from the newest advanced over them (maxVersions keys at most), never a count of the file's whole list (daybreak2's LIMIT-563-1). Each slice then drops a bounded page from the oldest end.
  - A slice reads at most PINS.slice.examine (100) records a step and makes at most PINS.slice.requests (400) IndexedDB requests. An item is begun only while its costliest outcome still fits (a release, RELEASE_COST = 13 requests). A timer comes between slices, and a new one is scheduled while work remains, so a run never stops with work left and none to follow it.
  - It begins first at each start (whichever tab holds the migration, so the backfill after the upgrade starts at once), after a collapse, after a lifecycle change (turning sync off, a namespace switch), after a change that released a pin, and after a save that left versions due. One runs at a time; the same one asked for again while it waits isn't queued twice.
  - Every release that makes a version prunable (by confirmation, refusal, purge or collapse) marks its file due from its oldest, and the bytes bound to be checked again, in the same transaction, so the cleanup's cursor for that file never passes it by, and a file pushed past its count by releases after its due mark has gone is due again (astra's CORR-FB0-2). The backfill rewinds the cursor of a file already due; a file not due stays so (an idle file's versions are pruned on its next save, as before v5). A released version of a file deleted for good is deleted, never made prunable.
  - dropVersions and emptyTrash's version drops go from the last id they looked at, a key range, at most 400 requests a transaction, so they never read a page again (astra's CORR-E5C-3). One that has reached a finite upper bound (the fence, or a file's newest kept) stops there, before making a range from it (astra's round 2).
- **CI assertions, not a bench** (decided with @sagebrush):
  - In the 50,000-op tail, each plain save makes at most 40 IndexedDB calls, counted by an instrumented store, and one that collapses at most 64 (measured exactly: 38 and 60, so a change shows at once; PINS.collapseRelease 2 keeps the collapsing save four under its bound, with D11's read of the large-move record in each of a save's five transactions on entries). Each kind's figures are the same as on a workspace with no tail.
  - Each slice of the cleanup makes at most 400 requests, with the tail and without. More than 32,000 pins of collapsed writes drain in one cleanup, each slice under 50 ms, with no reload or save, and a newer epoch's pins are kept.
  - The longest task stays under 50 ms, as the browser's long-task observer reports it (the check requires the observer).
  - A cleanup page and a decision on an identity with many pins stay bounded too.
  - A backlog of 50 versions past the age: 1 dropped in the save, the rest by the cleanup after it. Past the bytes: a few in the save, the rest by the cleanup, the total exact.
  - One file with 1,000, 10,000 and 50,000 pinned versions, or 50,000 of another file: a save reads the same records and makes the same requests. With 50,000 prunable ones of its own: at most the window of 21 more records and 4 more requests. Counts are asserted exactly; times are reported, not asserted; the longest task is asserted under 50 ms.
  - A due file with 1,000, 10,000 and 50,000 prunable versions drains in the cleanup, every slice within its requests and records, the same at every size; slice times reported.
  - The upgrade to v5 over 1,000, 10,000 and 50,000 versions kept before writes no record and stays under 1 s. The backfill, cut at every page and reloaded, goes on from its marker and ends as v5 makes them; a save meanwhile drops none it hasn't reached; the bytes bound, past during it, is kept after it.
  - Drops at 189, 190, 191 and 380 versions, fenced at the last id, everyone's and one file's (keep 1 too): no exception, the exact survivors (astra's round 2).
  - dropVersions("/") past 1,000 pinned versions ends, keeps them, drops every other one, and keeps the total exact, each transaction within its requests.
  - One pin per storage key, after every way pins move or are orphaned.
  - astra's schedules (a move into a new folder; removal before either decision; a file in a trashed folder; a folder renamed after the decision; a move into a new folder that is then trashed), each with a reload in the middle: the local tree and the one the actual reducer makes from the records match, path for path and identity for identity.

### C3. The confirmed index and the optimistic view (CORR-8E7-3)

**The confirmed index (`syncIndex`).** It is the reducer applied to the server's log in `seq` order, own ops included. Its cursor `sync:<ns>:cursor` is written in the same transaction as each page applied to it.

**What the person sees** is the workspace's own index. It equals the confirmed index with every local intent not yet confirmed reduced on top, in this order:
1. the outbox's records, undecided or awaiting their echo, in `dseq` order;
2. the undrained adoption journal, as adopts, in its drain order (below; astra: the journal is part of the view, so the `index` after `welcome`, or a rebuild, never erases captured entries);
3. held writes (C2);
4. the local ops not yet scanned, in `seq` order (an unscanned B is part of the view, so a remote page or a rebuild never overwrites it).

After each confirmed page, the affected identities' views are recomputed, and the difference is applied to the workspace's entries. Each identity's layers are found by key, not by a scan: the outbox's `byIdent` index, the journal by `id`, and `pending` (whose `latest.after` stands for its unscanned ops). That happens in the same transaction as the page and the cursor: entries, `syncIndex` and meta are all in the workspace's database. A crash leaves all of it or none.

**This device's own echo,** an `index` op with this `device` and a `dseq` in the outbox, is applied to the confirmed index like any other op.
- The outbox record is marked confirmed and removed. Nothing is applied to the view twice, since the view already had it.
- The order doesn't matter: an ack before the echo leaves the record "accepted, awaiting echo"; an echo before the ack confirms it at once.

**First sync: the adoption journal** (CORR-8E7-3, LIMIT-SC1-R1, LIMIT-SC1-R3). A device's existing tree is captured into `adoptJournal`, then sent as `adopt` records through the bounded outbox. It starts once the 1a/1b migration is done, so every entry has its identity and its hash.

The journal is keyed by identity. Each record holds `{id, parent, name, kind, sha256, size, trashed}`, where `parent` is the parent folder's identity (or the root), never a path. A folder's move is then one record changed, and its descendants follow it by construction, captured before the move or after it (astra's descendant point). Paths are derived only when a record drains.

Every local op records `after`: its identity's resulting state, in the same form (§3). For a folder op, that is the folder's own record.

1. **Start**, in one transaction: `W0`, the latest local op seq, is recorded, and the scan watermark is set to `W0`. Ops after it are kept (C1's retention), and the scanner is idle until the journal has drained.
2. **Walk by identity,** through the entries' `byIdent` index (`fid` for files and folders, `ref` for documents), in pages of 500, each page one transaction with its progress key. Each record holds the entry's state and the pin on its bytes (C2). An identity's place in this order doesn't change when it is renamed or moved, so a move during the walk can't hide an entry or show it twice.
3. **Close at a finite boundary** (LIMIT-SC1-R3, astra's atomic closure). When the walk ends, one short transaction, under the workspace's lock, reads the latest op seq as `W1` and records it with the journal's state, `closing`. Every local change records its op inside the lock and in a transaction of its own, so each op is either at most `W1` or after it: never both, never neither.
   - Then the ops in `(W0, W1]`, and only those, are replayed into the journal in pages of 500, each one transaction with its progress key. Each op's `after` replaces its identity's record (or removes it, for a forget). That is an assignment, so an op whose effect the walk already saw is harmless when replayed.
   - Ops after `W1` are left to the scanner.
   - The work is fixed when `W1` is chosen: at most the ops made during the walk. Continuous edits can't extend it, and no quiet interval is needed.
   - The last replay page, in the same transaction, sets the scan watermark to `W1` and marks the journal `captured`. The journal is then exactly the tree as of `W1`.
4. **Connect.** The account socket is opened only now. So the `index` the server sends right after `welcome` (it doesn't wait to be asked) is applied to the confirmed index as usual, and the journal stays in the view (layer 2).
5. **Drain**, top-down from the root through the journal's `byParent` index: parents before their children; a record under a trashed or forgotten ancestor is not adopted. Each page is one transaction, as the outbox has room:
   - it marks its journal records sent;
   - makes their outbox records, with the next `dseq`s and paths derived from their parents';
   - and hands their pins to those records.
   - The drained records sit at the outbox's end, in the same order as the journal's head, which comes right after the outbox in the view. So a drain changes nothing visible: no gap, no double application.
   - Each record is then retired once, by its echo or its refusal (C1).
   - This is bounded by the outbox's caps, never the tree's size, so the 100,000-entry maximum fills and drains repeatedly rather than waiting at the cap.
   - When the journal is drained, it is deleted in pages, and the scanner starts from `W1`.
   - In the server's order, the cloud's entries come first, so this device's colliding adopts become `name (2)`, in the view as well.

A crash anywhere resumes from the journal's state and progress keys: a walk mid-way resumes the walk; a closing resumes the replay at its page; a drain resumes its pages.

**An op that can't be applied** to the view (it fails a local check, such as a path rule or a limit) is still in the confirmed index, and the cursor passes it. The view leaves it out and lists it in the Sync panel. Nothing redefines the server's log.

**Tests:**
- a local create, then its echo (no `x (2)`);
- an ack lost, then the echo;
- the echo before the ack;
- a crash between a page and its cursor (impossible by construction; tested as a crash mid-page);
- a reload mid-adoption: in the walk, in the replay, and in the drain;
- during the walk:
  - a file renamed, moved between folders, and deleted;
  - a folder containing already captured children moved, and another moved before its children were captured. Each identity is captured exactly once, at its `W1` path;
- **a final local write racing the closing transaction:** it is in the journal or sent by the scan, exactly once;
- **continuous edits throughout the capture** (an autosave every 100 ms on a 10,000-entry tree): the socket opens within the quiet capture time ×1.5 + 2 s, and the journal begins draining. The replay reads only `(W0, W1]`, and the edits after `W1` are sent after the journal, each once;
- the `index` after `welcome`, and a rebuild, while most of a large journal is undrained, with colliding paths and later local edits to undrained entries: none of them disappears from the view, and the colliding ones become `name (2)`;
- 100,000 entries through repeated outbox fill and drain, with a crash and reload in each phase;
- a remote create at the same path before this device's queued create (the confirmed order gives the remote one `/x` and this one `/x (2)`, on both devices).

### C4. The reducer: identity, order, copies (CORR-8E7-4)

- **Targets are identities, never paths:** a data file's or folder's `fid`, a document's `ref`. A rename, write, remove or restore applies to its identity wherever it is now. Path reuse can't misdirect it.
- **Where an op puts something is a folder's identity too** (astra, on step 1; @sagebrush's decision): `parent` names the folder by its `fid`. If another device renamed that folder meanwhile, the entry goes into it where it is now; a new folder at its old path doesn't take it. A folder in Trash is brought back first (the edit wins). Without `parent`, or when it names no folder the index has (never seen, forgotten, or a file), the op goes by its path, and a missing folder on it is made, with an identity derived from the op.
- **Every op applies whole or not at all.** That covers the folders it would make and the entries it would move. Every path it produces is checked against the workspace's bounds (a name at most 255 characters, a path at most 1,024, a depth at most 32) before anything is kept. A `(2)` or a conflict copy's name is shortened to fit; a move whose descendants wouldn't fit is skipped.
- **The client never sends `duplicate`:** a copy goes as a `create`, with its own new `fid` (and its folder's `parent`). The server accepts `duplicate` (with `parent`, @sagebrush-auth's branch), but the reducer skips it like any op that doesn't change the index. It is implemented there first, with vectors, before the client uses it (astra, on sync-op-parent).
- **A derived identity** (a made folder's, a conflict copy's) is never one the index has, has forgotten, or that the op names: the next of a deterministic series is taken.
- **Order is the server's `seq` only.** `t` is shown, never ordered by.
- **Writes:**
  - `base` equal to the current hash: applied;
  - the same hash as the current one: nothing;
  - another `base` (a concurrent write): the later write by `seq` becomes a conflict copy;
  - a write to an identity in Trash brings it back (the edit wins);
  - a write to an identity forgotten for good makes a conflict copy at its last path.
- **A conflict copy's identity** is derived, so every device gets the same:
  - fid' = the first 16 hex of SHA-256(`fid`, `device`, `dseq`) of the op that made it;
  - its name is `name (conflict, <device's first 8>).ext`; if that is taken in the confirmed index at that point, ` (2)`, ` (3)`, …;
  - later ops that target it (made on a device after it saw the copy) name fid'.
- **Two creates at one path:** the later by `seq` becomes `name (2)` (the first free one in the confirmed index at that point), keeping its own identity.
- **Vectors** (JSON, shared with the server later), each replayed from empty state on two simulated devices and checked for identical entries, identities and hashes:
  - rename and a write across devices;
  - two renames of one file;
  - a path reused after a rename;
  - write after Trash, and after forget;
  - two writes from one base;
  - a copy of a copy;
  - creates colliding three ways;
  - and (step 1's review) derived identities that are taken, long names and paths at the bounds, unseen writes at the root or in Trash, and `parent` with its folder renamed, its old path reused, forgotten, or in Trash.

### C5. A download is installed only if it is still wanted (CORR-8E7-5)

- A fetched blob is installed under the workspace's lock, by compare-and-swap in one transaction, only if:
  - the entry's identity is the one the fetch was for;
  - it is still `remote`;
  - its `sha256` is the fetched one;
  - its revision is the one the fetch began with.
- Otherwise it is discarded (or kept as a pinned version, if an undecided record wants that hash). It never replaces newer bytes or clears a newer `remote` state.
- **Tests, each with a GET held open:**
  - a local overwrite;
  - a newer remote write;
  - a rename;
  - Trash;
  - a remove and a new file at the same path.

### L1. Downloads against the daily read budget (LIMIT-SC1-1)

**The fetch queue is durable** (`sync:<ns>:fetch:*`, one per wanted hash), so a reload resumes it.

**For each item, in order:**
1. the reservation (L2) and the quota preflight;
2. then the signed URL is asked for. That debits the budget.

A signed URL is kept, with its expiry, in memory and in meta, and reused for retries while it is valid. A reload never asks for a new one for a hash whose URL hasn't expired.

**Running out of budget:** a `rate` refusal or 429 on asking for a URL pauses the whole queue, durably, until `retry_after`, or else the next daily reset.
- The foot then says "Daily download limit: resumes at 14:00", and the files stay `remote`, listed and fetchable later.
- Reconnects and reloads honor that pause.

**Tests** (Miniflare with a small budget):
- files totalling more than the budget: only the admitted prefix authorized, no URL asked twice for one hash, deterministic resume after the reset (a fake clock);
- a reload mid-queue.

### L2. One memory rule for every transfer (LIMIT-SC1-2)

**What is reserved:** every transfer reserves `size × COPIES` from the page's reservation (reserve.ts) before anything is materialized:
- for an upload: before reading its bytes from IndexedDB;
- for a download: before asking for the URL.

It holds that reservation until its last large reference is dropped. The same holds for hashing a write's bytes for its op when sync is on: the write's caller holds them, and `crypto.subtle` copies them.

**Concurrency** (2 uploads, 4 downloads) is a secondary cap. The reservation decides, so two 95 MiB uploads wait for each other when the reservation can't hold both.

**Checks on a download:** its `Content-Length` must be present and equal the expected size, or the download is aborted unread. The received length and SHA-256 are checked before it is installed (C5).

**Tests:** peak memory and longest task with a 95 MiB upload and download, and with the nominal 2 + 4 schedule. The longest task must stay under 1 s, as the migrator's does.

### L3. Pace and backoff (LIMIT-SC1-3)

- **Pace.** The sender paces itself: at most 1,500 ops a minute (under the server's 2,000), a token bucket counting resends too, and at most 8 requests unanswered.
- **Backoff, per kind of work:** ops, blob checks, uploads, URL requests, fetches, enable, and reconnect. Each has one retry timer.
  - It honors `retry_after` when given; else exponential from 1 s to 60 s, with ±20% jitter.
  - The timer is persisted in meta, so reconnects and reloads don't reset it.
  - A whole message refused for `rate` is never resent before its timer.
- **Permanent and transient are kept apart:**
  - `limit` on an item is final for that item: "too large to sync";
  - `storage_full` pauses uploads until the limits change (a new `welcome`) or the person acts;
  - `rate`, `busy` and 429 are transient, under the timer.
- **Tests (a fake clock):** a prolonged `rate` refusal, with request counts bounded and recovery without starvation; reconnect storms.

### L4. Paging (LIMIT-SC1-4)

- `blobs/check` takes at most 1,000 hashes per request.
- The first sync's adoption and a rebuild page through the 100,000-entry maximum:
  - adoption: captured 500 entries per transaction, in identity order; the ops made meanwhile replayed 500 per transaction; drained from the journal into the outbox as it has room (C3);
  - rebuild: the server's log at 1,000 ops or 1 MiB per page, reduced into `syncIndex` page by page, its cursor durable.
- Neither ever holds the whole tree in memory.
- **Tests:** 100,000 entries, with the pages' counts and bytes bounded, and a crash and reload mid-way.

### As built (step 3: web/workspace/sync-client.ts)

@sagebrush approved deltas D1 to D4 before the code (Oct 23).

- **D1. The namespace.** As built, `welcome` is `{v, state, generation, index_head, next_dseq, server_time}`. It carries no `limits`, `used_bytes` or account hash.
  - The namespace is `accountHash(account_id) : generation : device`.
    - `account_id` comes from `GET /api/share/me`, and is hashed the way the server hashes it (protocol.ts `accountHash`).
    - `generation` comes from `GET /api/sync/v1/status`, because the Web Lock is per namespace and has to be taken before the socket is opened.
    - The device is the workspace's.
  - `welcome.generation` is then checked against it. If they differ, the socket is closed with nothing sent on it, and the status is read again, so a new generation gets a new namespace and its own outbox.
  - A `storage_full` pause (`sync:<ns>:paused`) lifts on whichever comes first:
    - its `retry_after`, when the server gives one;
    - a `welcome` with another generation or state than when the pause began;
    - the person's `resume()`.
  - It doesn't wait for limits in `welcome`.
- **D2. Steps 3 and 4.** Step 3 persists no cursor and applies nothing from the server.
  - The cursor is kept in memory only, so `hello.index_after` is 0 on a page's first connection.
  - Each `index` page goes, in order, to an `onIndex` hook, which step 3 leaves unset. Step 4 gives it, with the confirmed index and the durable cursor written in one transaction (C3).
  - This device's echoes confirm their records (`Outbox.confirmed`), but only if each echo is the very op of its record.
  - Tests assert, after every case, that there is no `sync:*:cursor` key, `syncIndex` is empty, and no op of the server's is applied.
- **D3. The rebuild is asked for, not done.**
  - A per-op refusal removes its record (`Outbox.acked`). It is listed in `sync:<ns>:refused` (the last 100: dseq, code, path, time) and sets `sync:<ns>:rebuild` `{why: "refused"}`. Sending goes on, because the server applied the ops after it as if it were absent (sync-server §5.2).
  - Two cases halt sending until step 4's rebuild, the flag saying which:
    - the server's top-level `invalid` "rebuild" (`why: "invalid"`);
    - **a diverged log** (`why: "diverged"`): `welcome.next_dseq` above this namespace's next dseq, an echo that isn't its record's op, or an `order` naming a dseq this device has already decided. This is the case of a workspace restored, or reset with its device kept: step 4's rebuild must also take the server's `next_dseq` as the namespace's next dseq.
  - No top-level error and no closed socket removes an undecided record. The sender waits for what is in flight, then sends again from the lowest record not accepted, after its timer.
- **D4. Tests:** the cases (web/workspace/sync-client-cases.js) have two runners, with the same front.
  - Core's web/workspace/test-sync-client-ref.mjs runs them in headless Chrome against core's reference server (web/sync-protocol/reference-server.ts), in process. It skips by name the 2 cases that need the cloud's plan limits (storageFull, tooLarge), saying so for each.
  - The cloud repository's web/sync/test-workspace-sync-client.mjs runs all of them against its server (web/sync/test-entry.ts) in Miniflare.
  - A front in the test serves the page and proxies the site's API (the socket too) on the page's origin. It keeps the session cookie, and it can drop acks, fake the server's errors, close sockets, rewrite `welcome` and hold uploads.
  - A fake clock drives pace and backoff.
  - It runs on the VMs (ci.yml's sync block).
- **Also as built:**
  - **Where a namespace's scan starts.** Until step 4's first sync, it starts at the latest op when the namespace first connects (`Outbox.begin`), so ops from before sync was on aren't sent.
  - **Timers.** They are persisted as `sync:<ns>:retry:<kind>` `{at, n}`, one per kind: ops, index, check, upload, connect (and url, fetch, enable for later steps). Each is `retry_after` when the server gives one, else $1\,\text{s} \cdot 2^{n-1}$ capped at 60 s, $\pm 20\%$. Each is cleared by a success of its kind.
  - **Uploads before ops.** The sender sends ops only up to the first data file whose bytes the server isn't known to hold, because a `missing` refusal would be final. A file whose bytes this device no longer has, or that the server refuses for good (413, 400: too large, not these bytes), is sent all the same, and the server decides it. A file over 95 MiB isn't uploaded, and its op is refused `missing` and listed (§2).
  - **Echoes.** The server sends the log only on `hello` and `pull_index`; it pushes nothing when another device's ops are accepted. So after an ack that has accepted ops, the client pulls from its cursor to see its echoes. Live index updates for a second device need a server push (or polling): an open question for step 4.

- **After review** (daybreak3's LIMIT-PR58-1 to 3, astra's CORR-PR58-1 to 3):
  - **Bound to the account** (CORR-PR58-1).
    - `/api/share/me` is read again on every connection.
    - `hello` carries the namespace's `account` hash and `generation`, and the server refuses a socket whose session is another account's or another generation (sync-server §5.2).
    - Blob requests carry them as `x-sync-account` and `x-sync-generation` (§5.4).
    - Bytes are PUT only while the connection they were read for is still the current one. An answer that comes back after its connection ended changes nothing: no pause, timer, status or wake-up of the next connection's. Wake-ups belong to their connection.
    - The account object checks the binding again inside the transaction that allocates an upload's reservation, so a generation retired and replaced during the request's awaits is refused there (astra's second round).
    - Switching to another namespace keeps the old one's records; its pins go with the lifecycle epoch, as C2 has it.
  - **One wake-up a kind** (LIMIT-PR58-1). Any kind of work (ops, pace, check, upload, index, pull, unpause) has at most one scheduled callback. The same deadline asked for again keeps it; another one replaces it. Callbacks end with the connection, on success of their kind, and on `stop()`.
  - **Bytes checked against their record** (LIMIT-PR58-2).
    - `bytesFor` reads only when the entry's (or pin's) stored size is the record's, and the reservation covers it ($\text{size} \cdot \text{COPIES}$, checked).
    - Bytes whose length isn't the record's are let go unhashed and unsent.
    - Such a record gets its own durable mark, `sync:<ns>:mismatch:<dseq>`, so its bytes are never read twice however long it waits. Marks of records already decided are deleted as new ones are made. The record is sent as bytes gone are, and the server decides it.
    - Stored bytes longer than their metadata (daybreak3's second round):
      - Every writer of `fileBytes` and `versionBytes` stores a value in the same transaction as metadata made from that value's own length: write, create, adopt's move, the migrator's move, `putVersion`. So the reservation is sized from the metadata ($\text{size} \cdot \text{COPIES}$), as the migrator's hashing read of the same bytes is.
      - IndexedDB gives no value's length without reading it whole. So a value changed outside the workspace's verbs is found only by reading it, as the migrator's rule has it: one read past the reservation, once.
      - Upload reads go one at a time, so at most one such value is held at once.
      - The first one found marks the workspace's stored bytes untrusted, durably (`sync:bytes-untrusted`). The mark is written in the very transaction that reads the value and finds its length, together with that record's own mark (daybreak3's third round). Every upload read after that takes the largest reservation, $\text{LEGACY\_MAX} \cdot \text{COPIES}$, which has the page's reservation to itself. The flag is checked again inside the one-at-a-time section.
      - A narrow read first records itself durably (`sync:bytes-reading`); the reading transaction clears it. A page killed while it held a value leaves that record, and the next start takes the bytes as untrusted before any read. Tested with a seam (`PINS.cutAfterRead`) that aborts the reading transaction right after the value is materialized.
      - So in a workspace's whole life at most one value is ever held beyond what its reader reserved.
  - **The log is read only as far as it must be** (LIMIT-PR58-3).
    - `hello.index_after` is just before the oldest record accepted and awaiting its echo (else the in-memory cursor).
    - Each connection reads to a fixed target: the newest such record's seq, raised only by acks' accepted seqs, plus `welcome.index_head` once `onIndex` is given.
    - Pulls are one at a time and paced (a bucket: 4, then 2 a second). After at most `CLIENT.replayPages` (64) pages, a slice rests for `CLIENT.replayRestMs` (60 s), then goes on toward the target on the same connection, so it never stalls (daybreak3's question 2). That is at most 64 MiB a slice. The first rest's end stands until the slice resumes: the pulls each ack asks for meanwhile never move it later (astra's third round).
    - A `more` page that moves nothing ends the connection.
  - **Deadlines re-armed** (CORR-PR58-2, 3).
    - A blocked path schedules its own wake-up at its persisted deadline: a check timer, a storage_full pause (cleared durably once past) or the index timer.
    - A pull is asked for, whatever asks for it (a page, an ack, a reconnect), only past the index timer.
  - **Noted for step 4** (astra): a refusal's removal and its rebuild flag are two transactions. Step 4's recovery must persist the obligation with the decision, or rebuild unconditionally on start.

### Step 4 plan delta (D5 to D10, D10 r3)

@sagebrush accepted these before the code (Oct 23). They come from what step 3 and its reviews found. The rest of step 4 is built as C3, L1 and C5 say. r2 answers the design reviews of caa35d94 and 8b164277: daybreak3's CORR-PR65-1 to 3 and LIMIT-PR65-1 and 2, and astra's A1 (the same as daybreak3's CORR-PR65-2), A2, and the note on D8b. r3 ("D6 r3" below, which amends D6 r2 where they differ) answers the reviews of 198826c6: daybreak3's LIMIT-PR65-3 and CORR-PR65-4, and astra's CORR-PR65-A3. r4 ("D6 r4" below, amending D6 r2 and r3 where they differ) answers the reviews of 69ad3af2: daybreak3's CORR-PR65-5 and astra's CORR-PR65-A4. r5 ("D6 r5") answers the reviews of 4772b3a0: daybreak3's LIMIT-PR65-4, and astra's note that echo confirmations must wait for the commit. r6 ("D6 r6") answers daybreak3's narrowed LIMIT-PR65-4 on c8a94c26: the timed fixture and its exact page counts.

**D5 (r2). Two cursors** (daybreak3's CORR-PR65-1).
- `apply_after` is the durable confirmed cursor (`sync:<ns>:cursor`). Only ops with $\text{seq} > \text{apply\_after}$ are reduced into `syncIndex`, as one contiguous suffix, the suffix and the cursor committed in one transaction (C3).
- `request_after` is what `hello.index_after` and `pull_index.after` ask from. It may be lower than `apply_after`, to just before the oldest record accepted and awaiting its echo.
- Ops with $\text{seq} \le \text{apply\_after}$ in an answer are checked for order (strictly increasing) and used only to match this device's echoes (`sameOp`). They are never reduced, and they never move `apply_after`.
- Test: an old echo below the cursor, with a later rename and write of the same identity above it. The replayed prefix confirms the record and leaves the confirmed state unchanged.

**D6 (r2). The rebuild.** It runs when `sync:<ns>:rebuild` is set, before anything is sent. It is a sequence of phases recorded in `sync:<ns>:rebuild` (`{why, phase, gen, at, ...}`). Every phase is a series of transactions, each writing its own progress with its effect. Sending is halted until `done`.

*Two dseq values, never confused* (daybreak3's CORR-PR65-2), recorded once, in one transaction, at the rebuild's start:
- `server_next` = `welcome.next_dseq` of the connection that found the divergence: the server's decided prefix. Only records with $\text{dseq} < \text{server\_next}$ can have been decided by the server.
- `alloc_floor` = $\max(\text{local next dseq}, \text{server\_next})$. The namespace's next dseq is set to it, and only rises.
- Records with $\text{dseq} \ge \text{server\_next}$ keep their dseq and are sent in order, from `server_next`.
- If a dseq in $[\text{server\_next}, \text{local next})$ has no local record, the server is waiting for a dseq this device can't produce, because its record was removed on a decision the server no longer has. A client can never skip a dseq, so this is a halt the person is told about ("this device's queue can't continue here; Delete my synced data to start again"). It is never a skip. It can't happen while the server keeps its decisions. It is tested by a rewritten `welcome`.
- `why: "invalid"` (the server's 10,000-refusal limit) can't be rebuilt away: the server keeps refusing that device. It is the same person-told halt. An open question for the server (@sagebrush-auth): a way to reset a device's refusal count after a rebuild.

*Phases:*
1. **`stage`**: one transaction draws a fresh index generation `gen`. The staging confirmed index lives in `syncIndex` under the key prefix `[ns + "#" + gen]`, empty by construction because no row has ever had that prefix (daybreak3's LIMIT-PR65-1). Nothing is cleared to begin.
2. **`log`**: the server's log, from seq 0, in pages (at most 1,000 ops and 1 MiB, L4).
   - Each page is reduced into the staging index, and the rebuild's own cursor written, in one transaction.
   - Echoes met on the way are matched to their records by `sameOp`, and a match confirms its record in that page's transaction.
   - The live index and its cursor are untouched until `done`.
3. **`capture`** (only when there are records with $\text{dseq} < \text{server\_next}$ still undecided: the replaced prefix) (daybreak3's CORR-PR65-3).
   - Those records' identities, and each one's ancestors, are written to a **reissue journal**. It reuses `adoptJournal`'s store and `byParent` index under the prefix `[ns + "#reissue"]`, and records each identity's present local state: `{id, parent, name, kind, sha256, size, trashed}` or `gone`.
   - It is captured as C3's first-sync adoption captures a tree: walk by identity, close at a finite boundary `W1`, replay $(W_0, W_1]$ in pages, so an edit made during the capture is in the journal or after `W1`, exactly once. Ops after `W1` are the scanner's.
   - The capture also removes, a page at a time, each replaced record, with its pin handed to the journal record (C3: the journal owns its records' pins until they drain).
   - Pages of at most 100 records, at most 400 IndexedDB requests a transaction (as `PINS.slice`).
4. **`view`**: the union of the staging index's identities and the workspace entries' identities (`byIdent`), walked in key order, at most 100 identities and 400 requests a transaction, its position in the rebuild state. For each, the four-layer view is recomputed against the staging index and the difference applied to the entries.
   - An entry the view no longer has is never deleted. It is kept, as a conflict copy if its path is taken, and listed.
5. **`done`**, one transaction, which is a compare-and-swap on the obligation (astra's A2):
   - the rebuild flag's `n` must still be the `n0` the rebuild started from. If it isn't, a refusal (or a divergence) was recorded meanwhile: `done` does nothing but start another pass, keeping its phases' results where they still hold. A new pass always starts from `stage`, with a fresh `gen`.
   - Otherwise: the active index generation (`sync:<ns>:indexGen`) switches to `gen`; the live cursor is set to the rebuild's; the scan watermark is set to `W1` if a capture ran; and the flag is cleared.
   Sending resumes, sending the records at or above `server_next`, then draining the reissue journal.
6. **`clean`** (after `done`, not blocking sending): the old generation's rows are deleted from `syncIndex` a page at a time (at most 500 keys a transaction, by `getAllKeys` on its prefix), from a durable position.

*The reissue journal drains* through the outbox as it has room, at fresh dseqs from `alloc_floor` up, diffed against the (now active) confirmed index. For each identity, in this order:
- (a) top-down through `byParent` (parents before children):
  - present locally and absent from the index: `mkdir` for a folder; `adopt` for a data file or document, which syncs as a create. Data files go with their bytes, uploaded first.
  - present in both, but another parent or name: `rename`, its `parent` the folder's identity.
  - another hash: `write`, its `base` the index's hash.
  - trashed locally, not in the index's Trash: `remove`;
- (b) then, deepest first, identities gone locally but present in the index: `forget`, person-only, as emptying Trash already sends.
Each journal record goes once, retired by its echo or its refusal (C1). A refusal sets the flag again (D7), and the next rebuild starts from the same rules.

*D6's invariants (r2):*
- **No dseq is ever reused.**
  - `alloc_floor` is written once, before any record is touched, and the next dseq only rises from it.
  - Replaced records ($\text{dseq} < \text{server\_next}$) are removed in the transaction that moves their identities' state into the journal.
  - Records at or above `server_next` keep their dseqs and are sent in order. Nothing is sent before `done`.
- **No local edit is lost.**
  - Every replaced record's identity, and its ancestors, are captured in the journal with their present state, at `W1`; ops after `W1` stay past the watermark for the scanner.
  - Local entries are never deleted by the rebuild.
  - A capture that can't fit the journal (more than the workspace's 100,000 entries can't occur) still pages, never truncates.
- **Idempotent across a crash at every step.**
  - Each transaction writes its effect with its position: a log page with its cursor, a capture page with its walk position or replay position, a view page with its key, a clean page with its key.
  - The staging generation is never live until `done` switches to it in one transaction. A crash before then leaves the old index whole and the rebuild resumable from its recorded phase and position. A crash after then leaves only `clean` to finish.
  - `server_next`, `alloc_floor`, `gen` and `W1` are written once and read thereafter.
- **Bounds:**
  - each transaction at most 1,000 ops and 1 MiB (log), or 100 records and 400 requests (capture, view), or 500 keys (clean);
  - no array grows with the tree. The successors list isn't used by the rebuild.
- **Tests:**
  - a crash at every phase boundary and inside each phase's transaction (cut seams);
  - local ahead of the server (server_next < local next);
  - local behind (a restored older copy);
  - a reset that kept its device;
  - a stale prefix containing a folder create and move, a document create, a file write, and an emptied-Trash deletion;
  - the scale: 100,000 confirmed entries and 10,000 pending records, asserting each transaction's request and record maxima. This runs against the reference server, seeded directly, since a real server's ops rate would take 50 minutes to make that log.
  Each asserts no dseq sent twice or skipped, every local edit on the server once (or listed), and the local tree intact.

**D6 r3: one lifecycle for a pass's resources** (daybreak3's LIMIT-PR65-3, CORR-PR65-4).

- **A pass's resources are scoped to its generation `gen`:**
  - its staging confirmed index, under `[ns + "#" + gen]` in `syncIndex`;
  - its reissue journal, under `[ns + "#reissue#" + gen]` in `adoptJournal`.
  Nothing a pass writes is visible to the client's view, the scanner or the sender until its `done` succeeds.
- **`capture` no longer removes anything** (daybreak3's simpler option).
  - It reads the replaced records: undecided records with $\text{dseq} < \text{server\_next}$, plus every record of a previous committed pass's journal not yet drained (C3: the journal is local intent, so a new rebuild replaces it too).
  - It writes the pass's journal from the identities' present local state, closing at `W1` as the first-sync capture does.
  - The replaced records stay where they are, with their pins, until the pass commits. Sending is halted throughout, so they are never sent meanwhile.
- **`done`** is one transaction with the compare-and-swap (D7 r2):
  - **Success:**
    - the active index generation becomes `gen`, and the previous active generation is appended to the cleanup list `sync:<ns>:clean`;
    - the pass is marked committed, and the scan watermark is set to `W1`;
    - the live cursor is set to the rebuild's;
    - the flag is cleared;
    - the phase becomes `retire`.
  - **Failure** ($n \ne n_0$): the pass's staging index generation and journal generation are appended to `sync:<ns>:clean`, nothing else changes, and the next pass begins. A failed pass has removed nothing and moved no pin, so discarding it is pure deletion: no undo, no pin to reassign.
- **`retire`** (after a successful `done`; sending still halted): the replaced records, the undecided outbox records below `server_next` and the previous journal generations' undrained records, are removed in pages of at most 100 records and 400 requests. Each page is one transaction that hands each removed record's pin to the committed journal record of the same identity, or releases it if that record has no bytes to keep (a folder, a document, a gone identity, other bytes). Its position is in the rebuild state. When it ends, sending resumes: first the records at or above `server_next`, then the journal's drain.
- **Exactly once, at every crash point:**
  - before `done`, every local edit is represented by the old records (ops up to the old watermark `W0`) or is past `W0` (the scanner's). The pass's journal is invisible.
  - At `done`, both switch together. Edits up to `W1` are represented by the committed journal (as of `W1`), edits after `W1` by the scanner. The old records below `server_next` are dead (never sent again: sending is halted until `retire` ends) and leave in `retire`.
  - Each `retire` page is atomic, and a pin moves from the removed record to the journal record in the page's own transaction. So every pin has exactly one owner at every point.
- **Cleanup, bounded** (LIMIT-PR65-3):
  - `sync:<ns>:clean` is a list of prefixes: an index generation or a journal generation. Each is deleted a page of at most 500 keys a transaction, from a durable position.
  - A new pass's `stage` doesn't begin until the list is empty, so a pass waits for the previous one's leftovers to be deleted first.
  - So at most two index generations exist at once (the active one, and either one staging or one being cleaned), and at most two journal generations (the committed one draining, and either one staging or one being cleaned): at most 2 × 100,000 index rows and 2 × 110,000 journal rows (100,000 journal records plus up to 10,000 staged echo confirmations each, D6 r6), whatever the number of failed passes.
  - The list itself holds at most 2 entries.
- **Tests:**
  - many consecutive $n$ mismatches at the 100,000-row scale, asserting each transaction's limits and never more than two generations of each store;
  - capture done, then a late refusal increments $n$, then the retry's replaced prefix names different identities, with edits on both sides of the first `W1`. Every edit is represented exactly once, and every pin has exactly one owner, after crashes at the failed CAS, in each cleanup page and in each `retire` page.

- **What the capture covers** (astra's CORR-PR65-A3). `done` moves the global scan watermark, so the capture must represent every intent the watermark moves past, not only the replaced identities:
  - the capture's `W0` is the current scan watermark `scanned`, not the latest op;
  - the closing replay reads every op in $(\text{scanned}, W_1]$, in pages of 500 ops a transaction. Each op's identity, whichever it is (replaced or not, present or gone, its `after` or `after: null`), gets its journal record assigned from that op's `after`. A gone identity is recorded as `gone`.
  - So every op at or below `W1` is either already scanned (below the old watermark, so its record exists, or was decided, or was collapsed by C2's rules) or represented in the committed journal. Moving the watermark to `W1` at `done` skips nothing. Ops after `W1` are the scanner's, which stays idle until the journal has drained (C3, step 5).
  - Unscanned writes now represented by the journal are covered as C2's `cutoff` covers them: in each `retire` page, the identity's pending `cutoff` is set to its last op at or below `W1`, and their unowned pins (intermediate bytes) are released, as a collapse releases them. The journal record owns the pin of the identity's present bytes.
  - Test (A3): the trace scanned = 10, an unrelated rename Y logged at 11 and not yet scanned, $W_0 = W_1 = 11$. Y is in the journal and reaches the server once.
- **Tests asked by astra:** (a) after an $n$-CAS restart, the new pass's journal again holds the replaced identities' pins and their gone rows (nothing lost when the failed pass is discarded); (b) C3's order: the committed journal drains before any record the scanner makes for ops after `W1`.

**D9 (wording, nonblocking):** canonical `Content-Length` is `^(0|[1-9]\d{0,11})$`, with no leading zeroes.

**D6 r4: the view is applied only after a successful `done`** (daybreak3's CORR-PR65-5).
- The phases run in this order: `stage`, `log`, `capture`, `done` (the compare-and-swap), then `view`, then `retire`, then sending resumes. `clean` runs before the next pass's `stage`.
- Before `done` succeeds, a pass writes only its own generation-scoped staging index and journal. It touches no live entry, no outbox record, no pin, no watermark and no cursor. So a failed pass (a mismatched $n$) leaves the live workspace exactly as it was, and discarding it is pure deletion (D6 r3).
- After `done` succeeds, `view` recomputes, against the now-active index, every identity in the union of the active index's identities and the entries' identities. It walks in key order, at most 100 identities and 400 requests a transaction, its position durable, and applies the difference to the live entries (never deleting: kept, or a conflict copy, and listed). Then `retire` runs, as in r3.
- Sending stays halted through `view` and `retire`, so nothing is sent from a view that is partly applied.
- A refusal or divergence recorded during `view` or `retire` sets the flag again (D7 r2), and the next pass starts once this one has finished. A committed pass is never undone.
- Tests:
  - a mismatched $n$ during `log` and during `capture`: no live entry, record, pin, watermark or cursor changed, compared byte for byte before and after;
  - a crash inside `view`, then a reload: the view resumes from its position, and every entry ends as one uninterrupted `view` would leave it.

**D6 r4: the closing replay takes only this device's own intents** (astra's CORR-PR65-A4).
- The replay of $(\text{scanned}, W_1]$ uses C1's rule for what goes up (`wireOf`): an op applied from the server (`origin: "server"`), `dropVersions`, or an op with no `after` (no identity yet) is passed over. The watermark still moves past it, as a scan page does.
- Every eligible local intent is kept: a create, write, rename, move, remove or restore, from its `after`; a forget, discard or emptied Trash, as `gone` (its `after: null` tombstone).
- So an identity changed only by the server since `scanned` gets no journal record, and its confirmed state stands. An identity with a local intent gets its local state as of that intent, ordered after the server's ops by the seq its reissued record receives (the reducer's "later wins"), as any queued op is.
- Named test (astra's trace, from the executable evidence in sagebrush-pr65-69ad3af2-delta-astra.md):
  - scanned is 10; a remote rename /a to /b of Y is applied locally as seq 11, origin server;
  - the newer staging log has Y at /c;
  - $W_0 = 10$, $W_1 = 11$.
  The replay passes over seq 11, Y has no journal record, and nothing renames /c back to /b. Y ends at /c on both devices.

**D6 r5: how long sending stays halted, and echoes after the commit** (daybreak3's LIMIT-PR65-4; astra's note on r4).
- **Echo confirmations wait for the commit** (astra). In `log`, an echo matched to a record by `sameOp` is staged with the pass: under the pass's generation, in its journal store, as `{dseq, seq}`. It is not applied to the live outbox. `retire` applies the staged confirmations (removing the confirmed records and releasing their pins) in its own pages, after a successful `done`. A failed pass discards them with the rest of its generation, so a failed pass confirms nothing. Test: a pass that matches echoes and then fails its compare-and-swap leaves every matched record undecided and every pin where it was.
- **Elapsed time from `done` to sending again** (daybreak3's LIMIT-PR65-4). At the maxima:
  - `view` walks the union of 100,000 index identities and 100,000 entries: at most 2,000 transactions of 100;
  - `retire` removes up to 10,000 replaced records, up to 100,000 undrained records of an earlier committed journal, and the staged confirmations: at most 1,100 transactions of 100.
  So at most about 3,100 sequential transactions, each of at most 400 IndexedDB requests.
  - **Yielding:** each page is its own transaction. Between pages the work yields to the event loop (a timer), as the pins cleanup does, so no long task spans pages, and the page stays responsive.
  - **Target:** every transaction's longest task under 50 ms (C2's measured cleanup slices), and done-to-resume at most 300 s at the maxima ($3{,}100 \times 50\ \text{ms} \approx 155$ s, plus the yields). An ordinary workspace takes seconds.
  - **Measured:** the scale test (100,000 confirmed entries, 10,000 pending records and 100,000 undrained journal records, on the CI VM's Chrome) asserts done-to-resume at most 300 s, every transaction under 400 requests, and every long task under 50 ms, and reports the figures.
  - **Progress:** the foot says "Rebuilding sync… N%", computed from the phase and its durable position. A reload resumes `view` and `retire` from those positions, never from the start.
  - **The person isn't stopped:** local edits keep saving (they're past `W1`, the scanner's), and nothing waiting is lost.
  - **Why sending doesn't resume before `retire` ends** (@sagebrush's question). The replaced records (dseq below `server_next`) are still in the outbox until `retire` removes them. If sending resumed, the sender would resend them, and the server would answer each with its stored decision for a different op at that dseq: a wrong decision applied to the wrong record. A fence ("never send below `server_next`") would stop that. But the journal's drain also needs `retire`'s pin handover: until a page hands a replaced record's pin to the journal record of its identity, the drain could find that identity's bytes owned by a dead record. So sending would have to be fenced per identity as well, a second invariant for a bounded wait of about 155 s once in a rebuild's life. We keep the halt, and the bound above.

**D6 r6: the timed maximum, measured** (daybreak3's narrowed LIMIT-PR65-4).
- **The fixture is the worst case by construction:**
  - the active confirmed index holds 100,000 identities;
  - the workspace's entries hold 100,000 other identities (disjoint from the index's), so `view`'s union is 200,000;
  - 10,000 records are pending below `server_next`, 100,000 undrained records sit in an earlier committed journal, and the staged echo confirmations are present.
- **The test asserts the page counts exactly:** 2,000 `view` pages and 1,100 `retire` pages. Each transaction stays within 400 requests, and every long task stays under 50 ms (the observer's figure, for responsiveness only).
- **Elapsed time is measured, not derived.** The test takes wall-clock time from `done`'s commit to the first `ops` message the sender sends after it, and asserts at most 300 s on the CI VM's Chrome, reporting the figure. ($3{,}100 \times 50$ ms is no bound on that: long-task time isn't a transaction's wall time, which includes IndexedDB's own work off the main thread.) If the measurement passes 300 s, the target is revisited with @sagebrush before the code merges, never silently raised.
- **A journal generation's exact cap** (daybreak3, nonblocking): 100,000 journal records plus up to 10,000 staged echo confirmations, so at most 110,000 rows per journal generation, and at most two generations at once.

**D7. A refusal and its rebuild obligation are one transaction** (astra's step-4 note). `Outbox.acked`'s refusal branch writes `sync:<ns>:rebuild` (`why: "refused"`, unless a stronger reason is already set) in the transaction that removes the record. The client's separate write goes. Tested with a crash at each of `acked`'s await points: after a reload, either the record is still there and undecided, or the flag is set.

**D7 (r2). The obligation's counter** (astra's A2). Every write of `sync:<ns>:rebuild` (D7's refusal branch, a halt) increments its `n`, in the transaction that records the decision. A rebuild records `n0` when it starts. Acks for messages sent before the halt can still arrive during a rebuild, and only `done`'s compare-and-swap decides whether the flag may be cleared. So a refusal that lands at any point of a rebuild, before or after its identity's view page, is never cleared unrebuilt. Test: a refusal delivered (a held ack, released) during each phase: the rebuild runs again, and the refused identity's view is right after it.

**D8. Live updates** (plan-sync-index-changed-r1).
- With the confirmed index, the server's `index_changed` raises the target and pulls through the existing pacing.
- Until the server sends it, a second device sees changes on its own ack-pulls and reconnects.
- The paced idle poll (at most one `pull_index` a minute) is added only if the notice can't ship by step 6. @sagebrush is told early if so.

**D8b. Bounded idle recovery** (astra, on plan-sync-index-changed-r1; @sagebrush's decision).
- A notice is advisory, and the last one can be lost on a socket that stays open. Then nothing would pull until the next local edit or reconnect.
- So while connected and idle, with the confirmed index (`onIndex` given), the client makes one `pull_index` from its cursor every 5 minutes (`CLIENT.idlePullMs`). It goes through the same pacing: the bucket, one in flight, the index retry timer, and the slice cap.
- The timer is one wake-up of its own kind ("idle"), re-armed after each pull or page, and ended with the connection and on `stop()`.
- Cost: at most one small request every 5 minutes per idle device. A pull that finds nothing new is one empty page.
- Test: with a fake clock, the only notice for another device's op is dropped. The op arrives at the 5-minute pull, with no edit and no reconnect, and no other pull happens meanwhile.

**D8b (r2). Idle discovery** (astra's note). The idle pull doesn't know a target (there is no notice to say how far the log goes). So it sets the connection's `discover` flag:
- while it is set, `pull()` may ask past the target (bypassing the `cursor >= target` return);
- each page's last seq raises the target;
- a page with `more: false` clears it.
Pages still go through the bucket, one in flight, the index timer and the slices. Test: the dropped-notice case reads every page of a log longer than one page at the 5-minute pull.

**D9 (r2). Downloads** (daybreak3's LIMIT-PR65-2).
- Before any reservation or request, the record's `size` must be a non-negative safe integer with $\text{size} \le \min(\text{maxFileBytes}, \text{MAX\_PUT})$ (95 MiB: nothing larger is ever uploaded). Then $\text{size} \cdot \text{COPIES}$ is computed (at most 190 MiB, safe) and reserved, and the reservation is held across a 303 redirect until the body is installed or dropped.
- On the final response, of either path, `Content-Length` must be a canonical decimal (`^(0|[1-9]\d{0,11})$`, no leading zeroes) equal to `size` before the body is read. The body goes through a counting reader with a hard cap of `size`: one byte more aborts it. Its SHA-256 is checked before the compare-and-swap install (C5).
- Any failure fails that item under its retry timer and is never installed.
- Tests: size at the cap and cap + 1; an unsafe or overflowing size; Content-Length missing, malformed or different; a body longer than declared; a 303 whose final response fails any of these.

**D10. The reducer over the stored index** (found at the start of the code; @sagebrush routed it as a design delta).

The shared reducer (sync-reduce.ts, step 1) is synchronous, and works on a whole in-memory `SyncIndex` with four maps:
- `byId` (identity to entry);
- `byKey` (a path's NFC form to identity);
- `children` (a folder's key to its entries' identities);
- `gone` (identity to its last path).
C3 keeps the confirmed index in IndexedDB, and L4 says it is never held whole in memory. D10 runs the reducer, unchanged (no fork; the server and the JSON vectors use it as is), on a partial index loaded for each page.

- **Storage.** `syncIndex` rows are `{ns, id, path, key (NFC), parentKey, ...entry}`, or `{ns, id, gone: true, lastPath}` for an identity forgotten (no `key`, so it holds no path). There are two new indexes, `byKey [ns, key]` and `byParent [ns, parentKey]`. This is a schema-only upgrade to workspace DB v6: index creation over `syncIndex`, which nothing outside dev has written.
- **One transaction per page, reads and writes together.** A page's reads (the read sets, and any loads after a miss) and its writes (the changed rows and the cursor, C3) are all in the page's one readwrite transaction on `syncIndex` and `meta`. Between IndexedDB requests the work is synchronous (the reducer and its SHA-256 are synchronous), so the transaction stays alive throughout.
  - Why the same transaction rather than a version check: `syncIndex` is written only by these page transactions, of the one sender holding the lock (C1). IndexedDB serializes readwrite transactions over the same store, so nothing can change a loaded row between its read and the page's write. Local edits write `entries` and `ops`, never `syncIndex`. A version check would add a second failure path for no case that can occur.
- **The partial index.** For each op, before it runs, the page loads the op's read set into the page's partial `SyncIndex`, if not already there:
  - its target and `parent` (by identity);
  - the ancestors of its `path`, of `to`, and of a trashed entry's `from` (by key);
  - the Trash top;
  - the target's subtree, for a move (by `byParent`, level by level);
  - the full listing of each folder an entry may land in: at most 10,000 (the workspace's folder bound), so every "name (k)" probe has its answer.
  Each loaded key is recorded as *known*: present, or confirmed absent.
- **The miss recorder, on all four maps.** The partial index's `byId`, `byKey`, `children` and `gone` are `TrackedMap`s.
  - `get` or `has` of a key not known records a miss and answers "absent". `set` and `delete` mark the key known.
  - Every other Map member (`size`, iteration, `forEach`, `keys`, `values`, `entries`, `clear`) throws: a partial map can't answer a whole-map question. So a reducer change that starts to use one fails every test at once rather than silently reading a partial index.
  - `SyncIndex.entries()` and `clone()` are never called on a partial index.
- **Undo and retry happen in memory only.** If an op misses, it is undone by the reducer's own undo, in memory, before anything of the page is written. Then the missed keys are loaded (in the same transaction) and the op runs again: at most 8 rounds.
  - Still missing after 8: the page is cut before that op (the ops before it are written with their cursor). The op then runs alone as the next page.
  - Still failing alone, it halts sync with a person-told error. An op is never applied partially, and a retried op leaves no row written, because rows are written only once the whole page has reduced.
- **What a page writes.** The rows of every identity in the page's ops' `changed` (as each is now in the partial index: present, moved, or gone), and the cursor, in the page's transaction, at its end.
- **Bounds:**
  - a page's partial index holds at most 200,000 rows. Past that, the page is cut at the op that would pass it, and that op runs in a page of its own.
  - Per op, the rows loaded are at most the target's subtree (at most 100,000) plus at most 10,000 per landing folder. The subtree is the same as the workspace's own folder move, which reads the subtree whole and rewrites it in one transaction (api.ts `move`).
  - L4 thus reads: never the whole tree in memory, beyond the subtree an op moves.
  - The 8 rounds and the 200,000 rows are starting numbers, for daybreak3 to judge.
- **The same for the staging index** (D6), under its generation's prefix.
- **Tests:**
  - every vector in sync-vectors.json run through the paged partial-index path, compared to the in-memory reducer: identical entries, identities and hashes;
  - TrackedMap's throwing members: a test that calls the reducer with a map whose iteration is used must fail;
  - a folder move with 10,000 descendants;
  - a collision chain to "name (10000)";
  - a derived identity colliding with a gone one (a forced miss, then a retry);
  - a miss on the 9th round (the page cut and the op run alone);
  - the 100k scale fixture's per-op and per-page rows-loaded maxima.

**D10 r2: an exact overlay per op** (astra's CORR-PR65-D10-1). This supersedes r1's miss handling: "answers absent", the reducer's own undo, and the fixed 8 rounds.
- r1 was unsound, as astra's probe shows. A miss answered "absent" lets `reduce` succeed against a partial index and change memory, and the reducer's private undo runs only on a caught exception. Some of its mutations (`rawPut`) also happen before a later lookup misses.
- **Each op runs on a fresh overlay over the page's base.** The base is the page's partial index as left by the ops kept so far.
  - The overlay presents the four maps (`byId`, `byKey`, `children`, `gone`). Every read looks in the overlay, then the base. Every write (`set`, `delete`, and every change to a `children` Set) goes to the overlay only.
  - A `children` Set is copied from the base into the overlay the first time the op changes it (copy-on-write).
  - An entry (`SyncEntry`) read from the base is copied into the overlay the first time it's read. The reducer changes entries in place (a move rewrites `path`, `updated` and `seq` on each), so it only ever holds the overlay's copies, and the base's objects are never touched.
  - So nothing the op does, by any path in the reducer, reaches the base.
- **A miss throws, and marks the overlay dirty.** A read of a key that the base doesn't know (neither loaded nor confirmed absent) sets the overlay's `missed` flag and throws.
  - The reducer may catch the throw and return `skipped`. So the decision is the overlay's flag, never `reduce`'s result: a dirty overlay is discarded whole, whatever `reduce` returned.
  - The missed keys are then loaded into the base (in the page's transaction), and the op runs again on a new, empty overlay.
- **An op that ends with no miss** has its overlay merged into the base: each overlay key's value or deletion, and each copied Set and entry, replacing the base's. Its `changed` identities join the page's dirty set.
- Earlier ops' changes in the same page are in the base, and only an op that completes merges into it. So a discarded overlay can't undo, or be undone by, anything else.
- Iteration and every whole-map member still throw, as in r1. The overlay is the only object the reducer receives.
- Test: astra's executable `mkdir` probe, a miss on `gone.get` after `rawPut`. The overlay is discarded, the base is unchanged, and the retry succeeds without "already there". Plus every vector, run with a miss forced at each lookup in turn: the result equals the in-memory reducer's.

**D10 r2: work, long tasks and memory, bounded** (daybreak3's review of 124fa1c2).

- **A work meter, per op and per page** (daybreak3's 1). Every `get`, `has`, `set` and `delete` the reducer makes on the partial index's four maps counts one unit, retries included.
  - An op is run, and its units counted, before it is kept.
  - A page stops before the op that would take it past 500,000 units, and its rows and cursor are written then. That op starts the next page.
  - One op alone is bounded by the reducer's own contracts: at most its subtree (100,000) moved twice, plus at most 10,000 name probes per landing folder, plus at most 1,000 derived-identity candidates. So at most about 220,000 units, and a page always holds at least one op.
  - So 1,000 ops each probing the same 10,000-name folder are cut into pages of at most about 50 ops, each page bounded, instead of one page of 10,000,000 probes.
- **Retry rounds, isolated and bounded by the reducer's contracts** (daybreak3's 4). A retry reruns only the op that missed, on a fresh overlay, with the page's earlier ops kept in the base as they are. Each round loads only that round's misses.
  - Rounds go on while each one loads at least one key not loaded before, up to 1,001 rounds: the reducer's 1,000-candidate series for a derived identity, plus one.
  - So a valid run of more than 8 derived-identity collisions completes rather than halting. The rounds' units count in the op's work.
  - An op that misses without loading anything new (impossible by the wrapper's construction) halts sync with a person-told error. The fixed "8 rounds" of r1 is withdrawn.
- **Long tasks: a narrow, measured exception** (daybreak3's 2). A subtree move is one synchronous reducer call over the subtree; the reducer can't yield inside it without forking it.
  - For an op that moves at most 1,000 entries, the 50 ms long-task bound holds as everywhere else.
  - An op that moves more is a stated exception, bounded as the migrator's work is (L2: "the longest task must stay under 1 s"): its one long task stays under 1 s at the maximum, a 100,000-entry subtree, measured and asserted on the CI VM's Chrome.
  - The workspace's own move of that subtree (api.ts `move`) is a task of the same size, so sync adds none larger than the workspace already does.
- **Transient memory, counted** (daybreak3's 3).
  - Each op's `Outcome.changed` is merged into the page's one `dirty` set at once and dropped.
  - Rows are loaded with cursors, at most 1,000 values a request, each batch inserted into the partial index and dropped before the next request. No unbounded array is held.
  - The 200,000-row budget counts the partial index's rows, the `dirty` set and the batch in hand together.
  - The scale test asserts the page's peak JS heap growth (Chrome's `performance.memory`, the test's Chrome started with `--enable-precise-memory-info`) under 256 MiB at the maxima: a 100,000-entry subtree move, and a page of ops cut by the meter.
- **Tests added:**
  - 1,000 ops into one 10,000-name folder: the pages cut by the meter, none over 500,000 units;
  - a derived-identity series with 20 collisions completes (20 rounds);
  - a 100,000-entry subtree move: one long task under 1 s, and the heap growth asserted;
  - a 1,000-entry move: no long task over 50 ms.

**D10 r3: the bounds, exact** (daybreak3's review of df626e31).
- **Retry rounds cost what they replay** (daybreak3's 1). A round reruns the whole op, so a derived-identity series that collides $k$ times costs $\sum_{i=1}^{k} i$ candidate probes, plus $k$ times the op's other work:
  - the series alone, at the reducer's 1,000-candidate contract: $\sum_{i=1}^{1000} i = 500{,}500$ probes;
  - in general an op's cumulative units are (rounds) × (its other work) + the series' probes, all counted by the meter.
- **Per-op ceiling.** An op runs alone (in a page of its own) whenever its trial passes the page budget. Its cumulative units, retries included, are capped at 5,000,000. That covers the full 1,000-collision series on an op with up to about 4,500 units of other work, which every op but a large move has. An op that passes the ceiling halts sync with a person-told error, never applied partially. Only a log crafted to collide derived identities (SHA-256 based, so by accident with probability about $2^{-64}$ per candidate) on a large move can reach it.
- **The over-budget trial.** The meter runs an op as a trial on its overlay. If the trial would take the page past 500,000 units, its overlay is discarded, the page is written up to the op before it, and the op runs again as the first op of the next page. Its trial units count against the page that ran it, so a page's executed work is at most 500,000 plus one trial's units, and a trial is at most the per-op ceiling.
- **Memory, every object counted** (daybreak3's 2). The memory budget counts, together:
  - base rows;
  - the dirty set;
  - the batch in hand;
  - the overlay's cloned entries;
  - the overlay's copied `children` Sets (one unit per member).
  - A page holds at most 200,000 units, but a single op may exceed it alone: a maximum move counts its 100,000 base rows plus 100,000 overlay clones plus its landing folder's 10,000, about 210,000 units. That op runs in a page of its own, with a single-op memory ceiling of 250,000 units, past which it halts, person-told.
  - The heap test's fixture uses maximum-length legal rows: paths of 1,024 characters, names of 255, at depth 32, and a 100,000-entry move. It asserts the JS heap growth under 256 MiB, measured with `performance.memory` (`--enable-precise-memory-info`).
- **Tests added:**
  - a 1,000-collision derived series (a test seam makes the first 1,000 candidates collide) on a `mkdir`: it completes, and its probes equal 500,500 plus its other work, as counted;
  - the same series on a 100,000-entry move: it passes the 5,000,000-unit ceiling and halts, person-told, with no row written;
  - a page whose next op's trial passes the budget: the page is written without it, and the op starts the next page.
- **The discard is authoritative** (astra's note on r2). The call to `reduce` is wrapped: whatever escapes it, including an exception thrown by the reducer's own undo, the overlay is discarded whole if it is dirty, and the op retried. An exception escaping with a clean overlay (a reducer bug, not a miss) discards the overlay too, and halts sync with a person-told error. In no case does anything of that op reach the base.
- **On batching derived-identity misses** (daybreak3's suggestion). A landing folder's names are already loaded whole in the read set (r1), so name probes never retry. Derived identities can't be batched: they are SHA-256 values the overlay can't predict without forking the reducer. So their replay cost is bounded and counted (above) rather than removed.

### As built (step 4)

Modules (web/workspace): `sync-overlay.ts` (D10), `sync-confirmed.ts` (C3's confirmed index, D5), `sync-view.ts` (C3's view), `sync-fetch.ts` (C5, L1, D9), `sync-rebuild.ts` (D6, D7 r2), `sync-adopt.ts` (C3's first sync), `Outbox.drainJournal` (the journals' drain). The client turns them on with `onIndex: confirmedIndex(w)`; without it, step 3's behaviour is unchanged.

Where the code settles what the plan left open, or differs from it:
- **The view's layers, per identity** (C3). An identity with no local intent takes its confirmed state. An identity with one gets its placement from the reducer, run over the confirmed index with its intents on top: its outbox records, its journal record, and its unscanned op's `after` if that op placed it. Its folders' intents come first, top-down.
  - Content stays its own until its record is decided; a conflicting write comes down later as the server's conflict copy.
  - So a local write never moves a file, and a confirmed entry at its path makes it `name (2)`.
  - `pending.latest.movedAt` (the seq of the last placing op) says whether an unscanned op placed it. It is carried from op to op, so a save makes no extra request (test-workspace-sync-pins' exact counts hold).
- **Remote entries** carry `remote: true`:
  - a data file until its bytes are fetched and installed (C5's compare-and-swap);
  - a document until slice 2. Writing to it is refused with an error, never dropped silently.
- **Server-applied changes** are logged with `origin: "server"`, under the workspace's ordinary lock, so they are refused while quarantined. They note no local intent and pin nothing.
- **The rebuild's view never deletes** (D6 r4): an entry the active index names gone is kept and listed, as is one it doesn't name. The ordinary per-page view deletes on an explicit gone row.
- **`server_next` follows acks:** the server decides in dseq order, so each ack raises it. A rebuild that starts later in the same connection knows its decided prefix; welcome's value alone was stale.
- **A mismatched own echo** in a rebuild's log confirms nothing and records no divergence. That's the restored-copy case: those records are the replaced prefix, and their identities are reissued.
- **The announce** (plan-sync-rebuilt r3 §4) is sent for every obligation, not only `invalid`. A server without `rebuilt` (core's) answers `invalid` "unknown message": an obligation that needs no reset there (a refusal, a divergence) then completes by the same compare-and-swap, with no new floor; the refusal limit (`invalid`) can't be lifted without the reset, so it halts, stably and said, recorded against its counter so no reconnect rebuilds or sends again (astra's CORR-PR65-IMPL-2).
- **The journals' drain** goes in rounds over key order. A record goes once its folder has gone. Gone identities (forget) go after every present one, in key order rather than deepest-first: a forget of a folder already forgotten is a no-op on the server.
  - Its position is the journal's own: bound to its generation, and cleared in the transaction that installs a journal (rebuild's `done`, the first sync's capture), so a new journal never inherits another's traversal (astra's CORR-PR65-IMPL-1).
  - A record under a folder in Trash, gone, or not adopted itself is not adopted.
- **Downloads:** the signed URL is taken from the followed redirect's final URL (`fetch` can't read a 303's Location). A 403 from the files host drops it, and the next attempt asks for a fresh one.
- **Rebuild pages commit with `durability: "relaxed"`** (clean, capture, view, retire). Each records its own position with its effect, so a page that an OS crash loses (committed to the browser, not yet flushed) is redone from the previous position. A tab's crash loses nothing committed. `done` and the announce's ack keep the default durability.
- **Requests per transaction:**
  - a rebuild view page reads its range in five requests;
  - the confirmed index is memoized for the page, and listings take one request each;
  - room is counted once a page;
  - the op's parent folder is passed to the log;
  - the fetch queue is the entries' sparse index `byFetch` (DB v6, unreleased), so queuing a file costs no write of its own;
  - retire reads its records by range, and pending states only where they exist.
- **D10's read set is loaded before an op runs** (r1's list, plus a move's destination listings), so rounds miss only on derived-identity candidates. A derived identity's entry and gone row are one stored row, learned from one miss.
- **Memory is counted before it is allocated, every live population** (daybreak3's LIMIT-PR65-IMPL-1): base rows; overlay clones and copied `children` Set members; each changed identity twice (the reducer's Set and the array it returns); the page's dirty set; and a folder listing's 10,000 rows, reserved before it is read. An overlay that would pass the ceiling is discarded whole: a lone op halts, a page is cut before it. The single-op ceiling is 520,000 units, from that full sum at a maximum move (D10 r3 said 250,000). Short rows at a 100,000-entry move measure under 256 MiB and 1 s. Maximum-width rows (1,024-character paths at depth 32) don't fit any single-transaction move, the workspace's own included (639 MiB): D11 applies large moves in chunks (below).
- **Long write loops await a cheap read every 200 writes**, which ends the task while the transaction stays alive. A 100,000-entry move is then many short tasks, apart from the reducer's own synchronous move.
- **Page counts are exact:** view and retire read one past their page. A retire page takes 100 items across its steps (staged confirmations, replaced records, the old journal's records), so the walks end on their last full page.

Measured on VM 1 (Chrome, the timed fixture of D6 r6; see the PR for the run): the figures are in #65's description.

### As built (D11: large moves and forgets in chunks)

The plan is plan-pr65-d11-chunked-moves r7 with its r8 notes v2 (N1–N5) and N6 v2 with addendum 1 (forget). Modules (web/workspace): `sync-rewrite.ts` (the records, the read model, the fence, the bounds `D11` with `configureD11` under `D11_CEILING`), `sync-replay.ts` (the view's replay), the confirmed side in `sync-confirmed.ts` and `sync-overlay.ts`, the local move in `api.ts`.

Where the code settles what the plan left open:
- **Readers:** every reader of `entries` goes through `entriesOf(tx)`. With no record, it reads the store as before, so existing request counts change only by the record's one `get` per transaction. The pins' exact per-save counts went from 33 to 38, and from 59 to 64 for a collapsing save: five entries transactions each read the record.
- **Listings and lookalikes:** under a published record, they go through the index `byNfc` (r7 §1's sources). Unpublished, a folder's listing is the subtree's keys, as before.
- **Writers:** every writer of `entries` calls `fenceCheck` first. `FENCE_READ` is the participation test's witness. Downloads' installs and finalizations change no path; they mark participation and write by identity.
- **The confirmed side's hidden folders:** a row under one is answered afresh at every read, its path projected through its folder's present place, and never kept in the overlay unless the op writes it. A copy kept before its folder moved would keep the old path.
- **Partial listings** (r2 §2): a folder past 10,000 children has a count, adds and removes, and no members. Its name probes load the next 1,000 of their series by key, in one round.
- **The replay's pass** examines folders only (only a folder can be a large lift) and reads files in bulk. Every replay page prefetches its identities' five sources at once. Replay pages publish the durability witness once, at the end, not each page.
- **The closure and validation, after the implementation review** (r8 N8 v3; astra's CORR-D11-IMPL-1 to 3, daybreak3's LIMIT-D11-IMPL-1 and 2):
  - **Reads metered at IndexedDB, from the transaction's first request to its last** (LIMIT-D11-IMPL-3). Every request the closure and validation transactions make goes through one meter per transaction: their own, their viewer's, and their writes, which are counted.
    - **State first.** The transaction's state is read first: the marker, the record, the closure's control row, every mapping row, and the intent revision at publication. It is bounded by `PLAN_STATE`: 8 requests and `large + small + 6` rows; writes at most `large + small + 4`.
    - **Then work.** The work's requests are admitted before they are made, against what is left of the transaction's `requests` and `page`.
    - **The plan's budget.** Every read of the closure and of validation, the state's included, is also admitted against what is left of the plan's `closureRequests` and `closureRows`.
    - **The bootstrap reserved** (LIMIT-D11-IMPL-4). A transaction can't know what is left of the plan's budget until it has read its marker (and, in the closure, the record and the control row): at most `PLAN_STATE.boot`, 5 requests and 4 rows. So every transaction that leaves another to run reserves those reads, and fails stably if they wouldn't fit: the pass before the first closure transaction, each closure transaction, and each validation transaction but the publication.
    - So one such transaction reads at most `requests + 8` requests and `page + large + small + 6` rows. A read that could return more rows than are left asks for what is left, then counts the rest (a request, no row): more is over. Over the plan's budget, or over the transaction's in the transaction's first item, the plan fails, stable. Otherwise the item waits for the next transaction, its changes undone. The rows and requests it read are counted. The durable counters are every metered request and row, and tests compare them with IndexedDB's own count.
  - **A view's folder not there yet** (CORR-D11-R1-1, R2-1): the pass leaves such a large lift to placement. It resolves the folder as the closure does: the row the mapping holding it carries there (if that mapping owns it), else the row there now. Nothing there means the lift is left to placement. Placement makes a confirmed folder this device hasn't yet, and the lift comes back as a debt, replayed once the folder is there.
  - **A target whose folder won't be a folder.** The closure decides this: the folder must be brought by the mapping whose target holds it most specifically, or be there now, staying, and be a folder. Otherwise the top stays where its source's owner carries it (`t` = -1, listed `no-folder`, no op of its own), and it beats any other claim on that place. Validation checks both outcomes again over the final plan.
  - **What a settled top carries** at placement: an entry under it whose view is exactly where the top's view would carry it. Any other view is the entry's own move, as in one transaction.
- **Lateness and failure:** a replay that finishes past its deadline after publication keeps `sync:<ns>:replayLate`. A failed or late-before-publication replay is retried once by the next page load (`REPLAY.reload` in tests).
- **The client:**
  - runs pending large-move work in the connection's message chain at welcome, and before a rebuild's `stage`;
  - holds pages, with the reason said, when the work stops;
  - pauses sending while a plan is made (`SENDER_HOLD`).
- **Rebuilds:**
  - a local large move during a rebuild's `view` or `retire` is refused `busy`;
  - `stage` waits for a local move's rewrite;
  - `done` waits for a local or published entries record, and supersedes the replaced generation's replay, debts, unpublished plan and forget ledgers.

## 4. Who builds what, in order, and the size of each

| # | Step | Who | Size |
|---|---|---|---|
| 0 | Before: capabilities 1a and 1b merged (fileBytes, folder ids, provenance) | board, in review | — |
| 1 | `sync-reduce.ts` and its JSON vectors (C4: identity, order, derived conflict copies, two-device replay) | board | 1.5 days |
| 2 | The ops' identity fields (`ref`, `fid`, `sha256`, `size`, `base`, `after`) recorded with each op; the new stores and indexes; the outbox, the scan watermark, pins, the pending summary and its paged cleanup (C1, C2) | board | 2 days |
| 3 | `sync-client.ts`: the sender lock, the socket, hello/welcome/index/pull_index, ops and acks, lost acks, refusals and rebuild, pace and backoff (L3), blobs check/PUT with the reservation (L2, L4); tested against Miniflare (web/sync/test-entry.ts, as test-sync.mjs runs it) | board | 2.5 days |
| 4 | The confirmed index and the view with its four layers (C3), the first sync's adoption (walk by identity, closing replay, top-down drain), the durable fetch queue against the read budget (L1), downloads by compare-and-swap (C5) | board | 2.5 days |
| 5 | The switch, enable's refusals, the foot status, row icons, "Delete my synced data" | board | 1 day |
| 6 | The two-browser test: two Chrome profiles, one Miniflare, the site; then the same against dev once lite4b's limits answer carries `sync` | board, with auth | 1 day |
| — | The session and allowlist (done: the cookie, SYNC_ACCOUNTS plus `sync.enabled`), enable's refusal wording (in progress), lite4b's `sync` limits block (a cocalc-ai PR; lite4 deploys it), the dev deploy, the server importing `sync-reduce.ts` (later, for compaction) | auth | — |

That is about 10½ working days for board, four more than the first draft, for the contracts in §3a. Each step is its own branch, reviewed and CI'd as usual. Steps 1 and 2 can start as soon as 1b is in review. Step 6 on dev waits on lite4b's limits; until then everything is tested against Miniflare.

## 5. Limits and checks the slice keeps

- **Bytes:**
  - Uploads and fetches use the page's reservation and quota preflight (1a).
  - A fetch is checked against its `sha256` before it is kept.
  - At most 4 fetches and 2 uploads at once.
- **The queue:** at most 10,000 items and 1 MiB waiting in `meta`. Past that, new changes still save locally, and the foot says "too many changes waiting to sync". They are sent once the queue drains.
- **What comes down is untrusted until checked:**
  - paths by `normPath`'s rules and the lookalike refusal (1b);
  - sizes against the workspace's limits;
  - ids by their form.
  - An op that fails is skipped and listed, never applied.
- **The workspace's own bounds** (100,000 entries, 10,000 per folder) apply to what comes down as to anything else. Past them, the Sync panel says so, and nothing is half-applied.

## 6. Decisions (@sagebrush, Oct 19)

1. **Slice 1 may list notebooks and boards without their content** ("synced in the next step"): it is dev-only and allowlisted. **Slice 2 must land before any production flag.**
   - On the second device, such a document **opens read-only, with that notice**. It never opens as an empty document someone could type into and that would later be merged (@sagebrush-auth).
2. **The switch's visibility comes from `GET /api/sync/v1/status`** (@sagebrush-auth's sync-enable-plan). It returns `{available, reason: not_allowlisted | plan_has_no_sync | cocalc_unreachable, state: off | active | readonly | deleting, generation}` and never changes anything.
   - **The page never probes with `POST /enable`,** which turns sync on.
   - **The switch is hidden** on `not_allowlisted`, and **shown disabled, with the server's text,** on `plan_has_no_sync` or `cocalc_unreachable`.
   - No pricing or upsell wording: that framing is William's, and stays out of the repository.
3. **Process:** astra and daybreak2 review this plan. Building starts after both CLEAR, and after capabilities 1a and 1b, each step its own PR.
