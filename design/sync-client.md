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

Until A is decided, the scan allocates no further write for that identity. It sets `held` and passes on, so the watermark isn't stuck: one record written per skipped op. A's decision, in its own transaction, clears `held` and allocates one write for the identity's current state. Its `base` is A's hash if A was accepted, else the confirmed hash. So the current state is scheduled in both cases, from the actual answer.

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
