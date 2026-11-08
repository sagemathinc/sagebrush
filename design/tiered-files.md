# Tiered files: "in the cloud" files, keeping files on a device, and large files in chunks

*Status: design, docs only, nothing built. Authors: @sagebrush-board (the person's view, the UI, the words, the PR sequence) and @sagebrush-sync-client (the protocol, both sides, the chunker, packs, accounting, garbage collection). Reviews: astra (correctness), daybreak2 (limits and costs), William (the pictures, before anything visible merges). Commissioned by William, Nov 8 2026: "lazy 'in the cloud' files, eviction/pinning with a local-vs-cloud indicator, and chunked large files on the existing sync server. No code yet."*

*Built on design/sync-server.md (SyncAccount, SyncDoc, R2 blobs by SHA-256) and design/sync-client.md (the confirmed index, the outbox, C2's pins, L1/L2's budgets). Out of scope here: branches and snapshots of the whole workspace, and a synced real folder for `sagebrush remote` and agents. Those come later, on top of this.*

## In plain words

- **Files can live in the cloud only.** Every device lists every file, but a device downloads a file's bytes only when it's opened, or when the person asks to keep it. A phone with little space can still see a large workspace.
- **"Keep on this device"** keeps a file's bytes on this device, so it opens offline. Other files may be removed from this device to make room, but only once the cloud has accepted every byte of them.
- **Each file shows where it is:** on this device, in the cloud only, downloading, or waiting to go up. The Storage panel shows how much is on this device and how much is in the cloud.
- **Large files sync in pieces.** Today a file over 95 MiB can't sync. In pieces, files up to the workspace's 200 MiB limit sync, an interrupted upload resumes where it stopped, and repeated data is stored once.
- **Nothing that hasn't reached the cloud is ever removed from a device.** A file with changes still waiting to go up stays, whatever the space.

---

## 1. The person's view

### 1.1 Where a file is: five states, and how each looks

| State | Means | File browser row | Opens offline? |
|---|---|---|---|
| **On this device** | every byte is here and checked against its hash | no mark (the normal case) | yes |
| **Kept on this device** | as above, and the person asked to keep it: it is never removed to make room | ● (filled dot), title "Kept on this device" | yes |
| **In the cloud** | listed here; its bytes are only in the cloud | ☁ (cloud), title "In the cloud: downloads when opened" | no |
| **Downloading** | being fetched (opened, or asked to keep) | ☁ with a progress ring, title "Downloading: 12 of 140 MB" | not yet |
| **Waiting to go up** | changed here, not yet in the cloud (today's ↑) | ↑, title "Waiting to go up" | yes (it's here) |

Plus today's ⚠ marks (conflict copy, an error). "Too large to sync yet" goes away for files up to 200 MiB (§4). Over 200 MiB a file can't be stored in the workspace at all, as today.

"Kept" is the person's wish, not a promise: a file asked to be kept but still downloading shows as Downloading, with "will be kept" in its title, until every byte is here (daybreak2, point 6).

### 1.2 Mockups (for William: pictures before anything visible merges)

The file browser, on a phone, with a workspace bigger than the phone keeps:

```
┌ Files ─────────────────────────────── ⋯ ┐
│  📁 data                                 │
│  📁 notes                                │
│  📓 elliptic-curves.ipynb          ●     │   kept on this device
│  📓 modular-forms.ipynb                  │   on this device
│  📄 lmfdb-dump-2026.csv     140 MB  ☁    │   in the cloud
│  📄 lattice-points.sage             ↑    │   waiting to go up
│  📄 big-matrix.sobj          88 MB  ◔☁   │   downloading (a third done)
├──────────────────────────────────────────┤
│ Synced · 2 min ago · 1.2 GB in the cloud │
└──────────────────────────────────────────┘
```

A row's ⋯ menu gains one item, which reads as what it will do:

```
  Open
  Rename…
  Download
  ✓ Keep on this device        (a check when kept; choose again to stop keeping)
  Remove from this device      (only when the file is fully in the cloud)
  Move to Trash
```

- "Remove from this device" is shown greyed, with its reason, when it can't be done (§3.4's checks): "Has changes not yet in the cloud", "Is being downloaded", "Is a conflict copy", "Is open in another tab", "Is kept on this device: stop keeping it first". It never removes bytes the cloud doesn't have.
- On a folder, "Keep on this device" keeps everything in it, including what's added later.

The Storage panel, with the new block on top of today's:

```
┌ Storage ─────────────────────────────────────────┐
│ On this device                                    │
│   ▓▓▓▓▓▓▓▓▓░░░░░░░░░░  410 MB of 1 GB             │
│   kept: 120 MB · other cached: 250 MB             │
│   versions on this device: 40 MB                  │
│   [ Free up space ]   Keep up to: [ 1 GB ▾ ]      │
│                                                   │
│ In the cloud (your account)                       │
│   1.2 GB of 10 GB, for sharing and sync together  │
│   files 1.4 GB, stored as 1.1 GB · notebooks and  │
│   boards 90 MB                                    │
│                                                   │
│ Sync this workspace: on · Synced · 2 min ago      │
└───────────────────────────────────────────────────┘
```

- **"Free up space"** removes cached files that are fully in the cloud and not kept, oldest-opened first, down to the low mark (§3.2). It says what it did: "Removed 31 files (250 MB) from this device. They're still in the cloud."
- **"Keep up to"** is this device's cache budget (§3.2). The default differs on a phone.
- "Your account" figures are the server's one storage budget (sync-server §6.1). "On this device" is this browser's storage only, so the two are shown apart and never added up (daybreak2, point 5).

Opening a file that's in the cloud, while offline:

```
  lmfdb-dump-2026.csv is in the cloud, and this device is offline.
  It will open when you're back online.   [ Keep on this device ]
```

(To be drawn as real screenshots in the UI PR, §7. These boxes fix the words and the layout for review now.)

### 1.3 The words people see (COPY)

- **The names:** "On this device", "Kept on this device", "In the cloud", "Downloading", "Waiting to go up". Used the same way in the row titles, the ⋯ menu, the Storage panel and help.
- **Never** a word that promises more than is true: not "safe", "secure", "backed up" or "unlimited", and none of the house's other banned words. Say what is true: "fully in the cloud" means the server has accepted every byte (§3.4's test), and nothing more.
- **Refusals name their reason** (daybreak2, point 7): "Can't remove lattice-points.sage from this device: it has changes not yet in the cloud."
- **Numbers are this device's or the account's,** and labelled so.
- **The messages, word for word** (each used where its section says):
  - opening a file in the cloud while offline: "<name> is in the cloud, and this device is offline. It will open when you're back online." (§1.2, §2);
  - while it downloads, in place of the content: "Downloading: 12 of 140 MB" (§2);
  - no room for it on this device: "There isn't room on this device for <name> (140 MB). Free up space in the Storage panel." (§2);
  - the daily read budget spent: "Daily download limit: resumes at 14:00" (as today, L1);
  - a download whose bytes didn't match: ⚠ "The download didn't match the file in the cloud, so it wasn't saved on this device. It will download again when the file changes." (§4.1: a single damaged piece is simply fetched again, unseen; this message is for a whole file that doesn't match);
  - kept files over the budget: "Kept files use more than this device's limit" (§3.2);
  - what holds the space: "120 MB here haven't reached the cloud yet; 300 MB are kept on this device." (§5.3);
  - persistent storage refused: "This browser hasn't agreed to keep Sagebrush's storage. If it clears it to free space, changes not yet in the cloud go with it." (§3.3);
  - "Free up space" done: "Removed 31 files (250 MB) from this device. They're still in the cloud." (§1.2).

## 2. Step 1: "in the cloud" files

**What already exists:** a synced data file arriving from another device is listed at once, marked `remote` until its bytes are fetched (sync-client §3, "What comes down"; sync-view.ts). The fetch queue is durable, checked by hash and installed by compare-and-swap (C5), and debits the daily read budget (L1). Today every device fetches every file in the background. "In the cloud" mostly means **not** fetching in the background, and fetching on open instead.

**Client changes:**
- A per-device rule decides what is fetched in the background (the prefetch rule, §2.1). Everything else stays `remote` (shown "In the cloud") until opened.
- Opening a `remote` file fetches it first, through the existing queue, ahead of background work.

**The one rule that changes.** An entry is in the durable fetch queue when its `fetch` field is set (the hash to fetch, read through the sparse `byFetch` index: web/workspace/sync-fetch.ts). Today the view sets `fetch` on every remote file (sync-view.ts), and that one line is what makes every device download everything. In step 1, `fetch` is set only:
1. **when the file is opened** (below);
2. **when it is kept** (§3.1), on the file, or on every file under a kept folder, 500 entries a transaction, from a durable cursor;
3. **by the prefetch rule** (§2.1).

A remote op that replaces a file's hash moves `fetch` to the new hash only if the file was local or kept. Otherwise it stays "In the cloud", with its new hash.

**The open path.** A read of a `remote` file (open in an editor, export, a notebook's `open()`, a local agent's read through the workspace):
- sets `fetch` if it isn't set, and puts the file at the front: an in-memory priority list (at most 8 files) that the fetch loop serves before the durable queue;
- waits on the install, a promise keyed by `fid` and hash, with progress (bytes received of `size`). The editor shows "Downloading: 12 of 140 MB" in place of the content (§1.3);
- closing the view doesn't cancel the download: the file was asked for, and it will be on this device.

**Everything below the open is the existing path:** the reservation and quota preflight (L2), then the signed URL, which debits the read budget (L1), then the fetch, the hash check and the compare-and-swap install (C5). If the file changes on another device meanwhile, that is C5's case: the stale bytes are discarded, and the newer hash is fetched and waited for.

**An open that can't be served is refused with its reason,** never hangs:
- `offline`: §1.3's offline message. Its `fetch` stays set, so it downloads at the next connection.
- `rate`: the daily read budget is spent; worded as L1 ("Daily download limit: resumes at 14:00").
- `storage_full`: it doesn't fit in this browser's free space (§1.3's "There isn't room…"), refused before the URL is asked for, so nothing is debited.

**Server changes:** none for step 1. `GET /blob/<sha256>` already serves any held hash. (The endpoint's agent reads files on the server, so it is unaffected.)

### 2.1 Prefetch rule

*(Proposal, settled by board and sync-client; daybreak2 to review the numbers.)*
- On a computer (default cache budget large): fetch everything, as today, until the budget's high mark.
- On a phone: fetch only what's kept, plus files under a size (proposal 1 MiB) in folders opened recently, until the budget's high mark.
- Never prefetch past the daily read budget (L1): background fetches stop before the budget's last 20%, which is left for opens.
- (sync-client) Prefetch stops at the cache's high mark (§3.2). Once the removal pass has run, prefetch waits until the cache is back under the low mark, so the two can't take turns in a loop. A file prefetched and then removed isn't prefetched again until it changes or is opened: an `unwanted:<fid>` mark in meta, cleared by either.
- (sync-client) Whether a device is a phone is chosen in the Storage panel's "Keep up to", with a default from the screen width and `navigator.deviceMemory`. Nothing is detected silently beyond that default.

### 2.2 Offline

- A file "In the cloud" can't open offline; the message in §1.2 says so and offers "Keep on this device" for next time.
- Everything else works offline exactly as today.
- (sync-client) **A fetch that fails mid-way** (the connection drops, a wrong length or hash) is aborted unread and installs nothing. The item stays queued, and retries under L3's backoff with its kept signed URL while that is valid (L1), so a retry doesn't debit the budget again.
- **A fetch that resumes after reconnect:** the queue is durable (`fetch` on the entry), so a reload or a reconnect resumes it. An open still waiting is resumed too, while its tab is open.
- **Range resume:** not in step 1. A single blob is at most 95 MiB and is fetched again whole. Step 3's chunks make a large file resume chunk by chunk (§4.1).

## 3. Step 2: keeping files, and removing them from a device

### 3.1 States, as stored

daybreak2's requirement: cloud-only, downloading, local, kept, waiting to go up, and error must be distinct, and "local" only when every byte (or every chunk) is present and hash-checked. As stored, per device (sync-client):

| State (§1.1) | Stored as |
|---|---|
| In the cloud | entry `remote: true`, no `fetch` |
| Downloading | entry `remote: true`, `fetch` set |
| On this device | entry without `remote`: its bytes were installed by C5, hash-checked |
| Kept on this device | as above, and the file or a folder above it in `keep` |
| Waiting to go up | a C2 pin, an outbox record or the C2 summary (`allocated`) names the identity |
| ⚠ error | `fetchFailed` (as today) |

- **An evicted file is an "In the cloud" file, exactly:** `remote: true` again, with its name, hash and size. Nothing else is recorded, so there is no third kind of absence to get wrong.
- **`keep` is per device and never synced:** a meta record `keep:<fid>`, for a file or a folder. A file is kept if it or any folder above it is in `keep`. The walk up is bounded by the path's depth (a path is at most 1,024 bytes). A file added later to a kept folder is kept, by the same walk, with no extra record.
- **"Recently opened"** is `opened:<fid>` in meta, written at most once an hour per file. A file never opened sorts by its `updated` time.
- **The cache total** (the bytes of local data files, kept and not) is a meta counter kept in the same transaction as each install, removal and write, and recounted daily, never a scan.

### 3.2 The cache budget

- **One budget per device:** "Keep up to", with a **high mark** (start removing) and a **low mark** (stop), and a **free-space floor** always left for the browser (hysteresis, so removal doesn't loop: daybreak2, point 6).
- **Admission, against the whole site's storage** (daybreak2, LIMIT-TF-1). The browser's quota covers everything the site keeps (versions, notebooks, the index, IndexedDB's own overhead), not only cached files. So before any install, whether for an open, a keep or a prefetch, the client requires
  $$u + r \le q - f,$$
  where $u$ is the site's estimated usage and $q$ its estimated quota (`navigator.storage.estimate()`), $r$ is this transfer's reserved install bytes (L2), and $f$ is the free-space floor. The estimate is taken at most 60 s before, and again after each install.
  - The person's "Keep up to" is clamped to what is left for the cache: at most $q - f - (u - c)$, where $c$ is the cache total (§3.1). The panel shows the clamped figure.
  - **If the estimate is unavailable or older than 60 s,** background caching (prefetch, keeping a folder) stops until a fresh one is taken. An open is checked against the last estimate, and refused with "There isn't room…" (§1.3) if it doesn't fit.
- Kept files count against the budget, but are never removed for it. If kept files alone pass the budget, nothing more is cached, and the panel says "Kept files use more than this device's limit".
- **What is removed first:** not kept, fully in the cloud, oldest opened first.
- Defaults are in the limits table (§6).

### 3.3 What "removing from this device" does

(sync-client) Removing one file is the reverse of an install: **one transaction, under the workspace's lock,** in which §3.4's checks are made and then:
- `fileBytes[fid]` is deleted;
- the entry gets `remote: true`, with no `fetch`. Its name, identity, hash, size and versions stay;
- the cache total goes down by its size.

If any check fails, nothing changes, and the reason is returned.

- **Versions are never removed by this.** In phase 1 a device's own versions of a file aren't uploaded (sync-server §3), so they may be the only copy. They count in "On this device", shown apart ("Versions on this device: 40 MB"), and are dropped only by the person's own `dropVersions`.
- **C2's pins need nothing new:** a file whose bytes are pinned is waiting to go up, which §3.4 already refuses.
- **The automatic pass** (§3.2) removes at most 100 files a transaction, at most once every 10 minutes. It doesn't remove a file within an hour of an install for an open (`min_resident`). Kept, unsynced, open and conflict files are never candidates, so a cache full of them stops the pass rather than looping.
- **The browser's own eviction** is a different thing: under pressure a browser may drop a whole site's storage. When sync is turned on, the page asks for persistent storage (`navigator.storage.persist()`). Where that is refused (Safari, some phones), the Storage panel says so, since a whole-site eviction would also take files waiting to go up.

### 3.4 Never removing the only copy (the hardest invariant)

A file's bytes may be removed from a device only if **all** of these hold, checked in the same transaction that removes them:
1. **the confirmed index has this identity at this `sha256`** (C3): the server accepted the op that made these bytes this file's current ones, so its holding is referenced by this very entry. The same hash under some other identity, or in an older confirmed state, doesn't count;
2. no outbox record, C2 summary (`allocated`), pin (`sync:cur:<fid>` and `pins` by identity) or reissue-journal record names this identity. Each of these is an O(1) lookup by identity, never a scan;
3. it isn't a conflict copy waiting for the person;
4. no download or upload of it is in flight;
5. (sync-client) it isn't kept, by itself or a folder above it;
6. (sync-client) it isn't open in an editor or a notebook in any tab (the open-file lease the page already holds);
7. (sync-client) its revision is the one the removal was decided on: a compare-and-swap, as C5 does for an install, so a write that lands between the decision and the transaction stops it.

If any fails, the removal is refused with its reason (§1.3), and the cache budget simply goes over until it can proceed. A local save is never refused for the cache's sake: the device's copy stays authoritative, and the panel says the cache is blocked (daybreak2, point 7).

(sync-client) **Tests**, each against a held step (a removal held between its decision and its transaction, as C5's tests hold a GET):
- a local write lands meanwhile (check 7);
- the op that made the bytes is still in the outbox, then acked but not echoed, then echoed (checks 1 and 2: refused, refused, allowed);
- the server refuses the op (`missing`): the record is removed and the bytes stay local (check 2, then check 1 still fails);
- a remote write to the same file arrives meanwhile (check 1: the confirmed hash moved);
- a conflict copy (3), a kept folder above (5), the file open in another tab (6), a fetch of a newer hash in flight (4);
- a crash in the middle: the removal is one transaction, so after a reload the file is either local with its bytes, or "In the cloud" without them, never a local entry with no bytes;
- the scale: 100,000 entries, a pass over a full cache, every transaction within PINS.slice's request bound.

## 4. Step 3: large files in chunks, and small files in packs

*(sync-client's section; board's outline points kept as the first bullets of each part.)*

**What it lifts:** the server's single-PUT limit of 95 MiB. The workspace's own file limit, 200 MiB (`LIMITS.maxFileBytes`), stays. So step 3 makes files from 95 MiB to 200 MiB syncable, makes every large upload resumable, and stores repeated data once. Raising 200 MiB is a separate decision, not this note's, and every cap below is named either way (daybreak2, point 1).

### 4.1 Chunks

- Content-defined chunking: the algorithm and its parameters are **named and versioned in the manifest**, and a client's output is deterministic (daybreak2, point 3). Proposal to evaluate: minimum / target / maximum 1 / 4 / 8 MiB.
- A file's identity stays its whole-file SHA-256 (the op's `sha256`). Its **manifest** lists its chunks (hash, size), in order. It is kept in the account object's SQLite, not as a blob (below).
- **Upload and resume:** `blobs/check` for the missing chunks, idempotent PUTs, then the manifest, then the op. The op is accepted only when every chunk is held. No rechunking on the server.
- **Read:** the manifest, then each chunk (or a Range of it).
(sync-client)

**Which files are chunked:** every data file over 8 MiB (the largest chunk). Smaller files stay single blobs, exactly as today.

**The chunker** is FastCDC with a gear hash (Xia et al., "FastCDC: a Fast and Efficient Content-Defined Chunking Approach for Data Deduplication", USENIX ATC 2016), implemented from the paper:
- normalized chunking at level 2, with minimum, average and maximum of 1, 4 and 8 MiB;
- the gear table is 256 64-bit values generated from a fixed seed, written into the code and into the test vectors;
- the manifest names it as `"cdc": "fastcdc-gear-v1/1M/4M/8M"`. Any change of parameters is a new name, and old names are still read;
- a device never re-chunks a file whose manifest it has;
- test vectors (inputs and their boundaries) are JSON, run by the client and the reference server alike, as the reducer's are.

An insertion in the middle of a file typically moves one or two chunk boundaries, so an edit typically re-uploads one or two chunks. That is FastCDC's usual locality, not a bound: the bound is the manifest's 256 chunks (§6a).

**The manifest:**
```
{ "v": 1, "cdc": "fastcdc-gear-v1/1M/4M/8M", "sha256": "<the whole file>", "size": 157286400,
  "chunks": [["<sha256>", 4194304], ["<sha256>", 3871202], …] }
```
- **It is not a blob** (a correction to the outline above). It is kept in the account object's SQLite, in a `files` row, so a cold open needs no extra R2 read, and its size is bounded.
- At most 256 chunks, which covers 200 MiB at the 1 MiB minimum, and at most 32 KiB of JSON. These rise only with the file limit.
- The chunks' sizes add up to `size`. Each is within the minimum and maximum, except the last, which may be shorter.
- **The file's identity stays its whole SHA-256:** the entry, the op, `base`, conflict copies and versions are all unchanged. A chunked file and an unchunked one with the same bytes are the same file.

**Uploading, resumable at every step, nothing charged twice:**
1. The client chunks and hashes the file. It holds one chunk and the gear state at a time, reading the file's bytes from fileBytes once, under the reservation (L2). On a phone this runs in a Worker, one file at a time.
2. `POST /blobs/check` with the chunks' hashes, at most 1,000 a request.
3. `PUT /blob/<chunk sha256>` for each missing chunk. This is today's endpoint and its reservation, at most 8 MiB each. The client sends at most 2 at once (L2's uploads); the server's own limit of 4 PUTs at once per account (sync-server §8) is a separate ceiling above it. A retry of a stored chunk is idempotent (sync-server §5.4, step 3).
4. **`POST /api/sync/v1/manifest`** (new). In one transaction, the account object:
   - checks the manifest's form and limits;
   - checks that every chunk is held, and refuses with `missing` naming the absent hashes otherwise;
   - records the `files` row with `refs = 0`;
   - adds one reference to each distinct chunk.

   The same manifest again changes nothing. A different manifest for the same `sha256` is refused with `conflict`, so a hash has one manifest.
5. Then the op, as today. Its check "a referenced blob is held" becomes "held as a blob, a packed member, or a `files` row".

**C2's pins cover a chunked file unchanged:** they pin the file's bytes on the device (by `sha256`), and the chunks are cut from those bytes at upload. Nothing per chunk is pinned on the device.

**What the server can't check, and who does:** the server doesn't read the chunks back, so it can't check that they concatenate to `sha256`. The downloading device does: after assembling, it checks the whole SHA-256 before the C5 install. On a mismatch it installs nothing, marks the file `fetchFailed: corrupt` (shown), and logs it. A wrong manifest can only come from the account's own client and spoil only that account's file. (For astra: acceptable, or refuse the commit until a Worker has streamed the chunks once, at one R2 read per chunk?)

**Reading:** `GET /api/sync/v1/manifest/<sha256>` (new) answers the manifest from SQLite. The client then fetches each chunk by `GET /blob/<chunk>`, each with its own signed URL and its own debit, a few at a time. It copies, rather than fetches, any chunk it already holds in an earlier version of the file. Then it assembles, checks the whole hash, and installs. An interrupted download resumes chunk by chunk.

**Two checks, two outcomes:**
- **Each chunk is checked against its own hash as it arrives.** A chunk that doesn't match is a transfer error: it is dropped and fetched again, like any failed fetch (L3's backoff, with its kept signed URL).
- **The whole file is checked once every chunk has passed.** A mismatch then means the manifest itself is wrong, and fetching again would get the same bytes. So it is final: `fetchFailed: corrupt`, with no retry, until the file's hash changes (a new write from another device clears it, as any new hash does).

**Assembly memory, honestly:** fileBytes stores a file as one value, so a 200 MiB file is assembled whole in memory under its reservation (`size × COPIES`, L2), as a 200 MiB download would be today. Storing files by chunk on the device (so a phone never holds 200 MiB at once, and local versions share chunks) is a later change, outside this note.

### 4.2 Packs

- Only small immutable blobs (proposal: ≤ 64 KiB) go into packs (proposal: target 8 MiB, hard maximum 16 MiB). A pack is immutable, with a bounded index of offset and length, read by Range (daybreak2, point 4).
- A pack is never rewritten when one member changes. A partly dead pack is compacted by GC, one pack per step, when its live share falls below a threshold.
- Small files may still go up as single blobs, under pressure or failure.
(sync-client)

**Who builds packs: the client,** at upload. The server never repacks a member, and only compacts (below).

**What goes in:** blobs of at most 64 KiB. A pack targets 8 MiB, with at most 16 MiB and 4,096 members.

**The format:** a length-prefixed JSON index `[[member sha256, offset, length], …]`, then the members back to back. It goes up with `PUT /api/sync/v1/pack/<pack sha256>` (new). The Worker hashes each member as it streams to R2, and keeps nothing unless every member's hash and the pack's own match. On success, in one transaction, the pack is a holding (its key, its whole size), and each member gets a row `packed(sha256, pack, offset, length)` and counts as held.

**Reading a member:** `GET /blob/<member>` answers with a signed URL for exactly its byte range of the pack. The URL carries the range, and the files Worker serves only that, so a retry within the URL's 5 minutes can't read more of the pack. **The debit is the member's length,** the bytes served (daybreak2, point 8).

**A member that changes isn't rewritten in place.** Its new bytes go up as a new blob, or in a new pack, and the old member loses its reference.

**Compaction,** by the account object's alarm, one pack a step:
1. A pack whose live bytes fall under 50% of its size is read.
2. Its live members are written to a new pack.
3. In one transaction, their `packed` rows move to the new pack, and the old pack goes to the outbox.

At most one compaction runs per account, so the extra storage at any time is at most 16 MiB.

**Direct small blobs stay allowed** under pressure or failure: packing is an optimization the client may skip, and the server accepts either.

### 4.3 Accounting

- **Charged once, physically:** unique chunk and pack bytes per account, not logical references. Missing bytes are reserved before upload; the manifest's commit turns reservations into references in one step; retries don't charge twice. A packed member can't claim a saving the pack doesn't make (daybreak2, point 5).
(sync-client)

**New tables in the account object:**
```
files(sha256 PRIMARY KEY, size, manifest TEXT, chunks, refs, created)   a chunked file and its manifest
packed(sha256 PRIMARY KEY, pack, offset, length)                         a member and where it is
```
Chunks and packs are ordinary `holdings` rows: one per R2 object, with `refs`.

**The references:**
- an entry, version or pin refers to a blob holding, a packed member, or a `files` row;
- a `files` row refers once to each distinct chunk holding;
- a pack holding's `refs` is its count of live members.

**Usage** (`used_bytes`, sync-server §3) is physical:
- each chunk, pack and blob holding counts once while something refers to it, never once per reference;
- a `files` row adds its manifest's bytes;
- a pack counts whole while any member is live, so packing never claims a saving the pack doesn't make. Compaction is what gives the space back.

**Fitting sync-server §6.1** (one budget for sharing and sync): nothing changes in the claim or the caps.
- Uploads reserve physical bytes per PUT, chunk or pack, exactly as a blob's PUT does, against `blob_cap` and `max_file_bytes`. A chunk is at most 8 MiB, under any `max_file_bytes`. The whole file is checked against `max_file_bytes` at the manifest's commit.
- The commit takes no reservation of its own: it only adds references to holdings that are already counted.

## 5. The hard parts, named

*(Questions by board; answers by sync-client; astra and daybreak2 review.)*

### 5.1 Garbage collection of unreferenced chunks

- References run file op → manifest → chunks or pack members. A file deleted or replaced loses its references only once the new op is decided.
- Zero-reference objects go through the existing outbox, with a grace period for lost answers and late commits (sync-server §3, §9).
- Questions: how a chunk shared by two files, or two versions, is counted; how a pack's dead members are found; the bounded pages and the alarm's pace; the most extra storage compaction may use at once. Quota must not depend on GC finishing promptly (daybreak2, point 9).

**Answers (sync-client):**
- **A shared chunk** has one holding, with one reference per `files` row that lists it. Two versions of a 150 MiB file that differ in one chunk cost about 154 MiB, not 300.
- **A reference moves only in the decided op's transaction.** A write that replaces a chunked file keeps the old one as a server version, in the same transaction (sync-server §3). The old `files` row loses its reference only when that version is dropped.
- **A `files` row at 0 references** releases its chunks in the same transaction: at most 256 rows, so the transaction is bounded. A chunk at 0 goes to the outbox, as a blob does today. The alarm empties the outbox as now (bounded steps, sync-server §6.2's LIMIT-445-1).
- **A pack's dead members** are found without a scan: a pack's `refs` counts its live members, and its live bytes are a column kept with it. A pack under 50% live is put on a small `compact` queue in the transaction that crosses the line. The alarm takes one pack a step, so at most 16 MiB is extra at a time.
- **The new ordering rule (for astra).** The alarm deletes a holding's R2 object first, then its row. So a manifest commit that names a chunk in the outbox must not revive it if its delete may already be in flight.
  - A holding being deleted carries `deleting`, set before the R2 call.
  - A commit that meets `deleting` refuses with `missing`, so the client uploads that chunk again.
  - A commit that meets a holding merely queued in the outbox (not yet `deleting`) takes it back out, in the same transaction.
- **Grace:** an unreferenced holding goes after a day (sync-server §3). That already covers chunks whose manifest commit was lost. A client that comes back later is told `missing` and uploads them again.
- **Quota doesn't wait for GC:** usage drops in the transaction where a holding's last reference goes, not when R2 deletes it. The outbox and the daily inventory (sync-server §9) only clean up.

### 5.2 Quota accounting

- Questions: physical vs logical bytes in `used_bytes`; a manifest whose chunks are partly held; how the breakdown (sync-server §6.1) shows them; how a downgrade interacts with packed bytes.

**Answers (sync-client):**
- **`used_bytes` is physical** (§4.3). The logical total (the files' sizes) is shown beside it, never charged.
- **A manifest whose chunks are partly held** is refused with `missing` and the absent hashes, and changes nothing. The held chunks stay as they are: referenced if something else refers to them, otherwise unused and gone after a day.
- **The breakdown** gains one line: "Files: 2.1 GB, stored as 1.4 GB" (repeated data stored once), beside sharing's bytes and documents' bytes. "On this device" is a separate block and never added in (§1.2).
- **A downgrade** (sync-server §6.2) works on holdings as today. A pack is one holding, so a read-only account keeps whole packs until purge. Compaction keeps running on a read-only account, since it only gives space back.

### 5.3 Removing a file that has unsynced edits

- The rule is §3.4: it isn't removed. Open questions: a device whose kept and unsynced files alone exceed its storage; how long a blocked cache may stay blocked before the panel says more; a conflict copy that the person never resolves.

**Answers (sync-client):**
- **Kept and unsynced files alone over the storage:** nothing more is cached or prefetched. A save that doesn't fit is refused as today (`storage_full`), and never makes room by removing something unsynced. The panel says what is holding the space: "120 MB here haven't reached the cloud yet; 300 MB are kept on this device."
- **A blocked cache** shows its reason at once, and stays blocked exactly as long as the reason does. Nothing is escalated by time: when the confirmed index catches up (C3), the files become removable with no extra step. If sync itself is paused (offline, a rate, `storage_full` on the server), the panel names that pause, since it is the real cause.
- **A conflict copy never resolved** stays on this device as a file of its own. Once its op is confirmed, the cloud has its bytes too, so it is removable like any other file. Until the person opens it, it is never removed automatically: it carries ⚠, and the pass skips ⚠ files.

## 6. Limits (one table: daybreak2, point 10)

| Limit | Owner | Default (first value) | Hard ceiling | Over it | Remotely set? |
|---|---|---|---|---|---|
| Single blob PUT | server | 95 MiB (today) | 95 MiB | 413 | no |
| Workspace file size | client | 200 MiB (today) | 200 MiB until decided otherwise | refused at save | no |
| Chunk size, min / target / max | client (in the manifest) | 1 / 4 / 8 MiB (to evaluate) | 8 MiB | — | no |
| Chunked above | client | 8 MiB (the largest chunk) | 8 MiB | sent as one blob | no |
| Chunks per manifest | server | 256 | 256, raised only with the file limit | `limit` | no |
| Manifest encoded size | server | 32 KiB | 32 KiB | `limit` | no |
| Packed member size | client | 64 KiB | 64 KiB | sent unpacked | no |
| Pack size, target / max | client builds, server checks | 8 / 16 MiB, at most 4,096 members | 16 MiB | `limit` | no |
| Pack compaction | server | under 50% live, one pack a step | 16 MiB extra at once | — | no |
| Index entries | both | 100,000 per account, 10,000 per folder | same | `limit` | no |
| Device cache budget, computer | client | 25% of the estimated quota, at most 10 GiB (sync-client proposal) | clamped to $q - f - (u - c)$ (§3.2) | removal | person |
| Device cache budget, phone | client | 25% of the estimated quota, at most 2 GiB (sync-client proposal) | clamped to $q - f - (u - c)$ (§3.2) | removal | person |
| Cache high / low marks | client | 100% / 85% of budget | — | — | no |
| Free-space floor $f$ | client | 500 MiB on a computer, 200 MiB on a phone (sync-client proposal) | — | no install unless $u + r \le q - f$ (§3.2) | no |
| Storage estimate age | client | 60 s | 60 s | background caching stops; an open is checked against the last estimate | no |
| Removal pass | client | 100 files a transaction; at most every 10 minutes; not within 1 hour of an install for an open | — | — | no |
| Prefetch share of the read budget | client | stops at 80% used (§2.1) | 80% | prefetch pauses | no |
| Concurrent chunk uploads / downloads | client | 2 / 4 (as L2) | — | queued | no |
| Blob PUTs at once | server | 4 per account (sync-server §8) | 4 | 429 | no |
| Daily read budget | server | `sync.read_bytes_per_day` (CoCalc) | CoCalc's | `rate` | yes (CoCalc) |
| Account storage | server | `storage_bytes` (CoCalc) | CoCalc's | `storage_full` | yes (CoCalc) |

Every list, check and GC endpoint stays paged. The index's bounds don't depend on cached bytes.

## 6a. Costs, as operations (daybreak2, point 8)

(sync-client) In operations, not dollars, which change:
- **A cold open of a chunked file** of $n$ chunks: one manifest read (SQLite, no R2), $n$ signed URLs and $n$ R2 reads, $n \le 256$. For example, 150 MiB at about 4 MiB a chunk is about 38 of each.
- **Uploading it:** $\lceil n/1000 \rceil$ checks, $m$ PUTs for its $m$ missing chunks, one commit, then the op.
- **A random edit of a few bytes in a 200 MiB file, typically:** one or two chunks change (about 4 to 16 MiB), so that is uploaded and stored. Without chunks it would be 200 MiB, and today it can't sync at all.
- **Repeated data** (a copy, or a version differing at the end): only the new chunks are uploaded and stored. The first chunk-identical file costs one commit and no PUTs.
- **Many tiny files:** 20,000 files of 4 KiB cost 20,000 PUTs and 20,000 reads singly, but about 10 PUTs in packs targeting 8 MiB (fewer bytes than 10 full packs once the indexes and partly filled packs are counted; the exact count depends on how packs fill). Each is still one ranged read when opened, since reads are per file.
- **The worst case for packs:** members deleted one at a time cost nothing until the pack is under 50% live. Then one compaction runs: one read and one write, at most 16 MiB.
- **The worst case for chunking:** a 200 MiB file that changes completely. Every chunk is new, so 200 MiB is uploaded (no more bytes than the file itself), in up to 200 PUTs at the 1 MiB minimum chunk (the manifest's 256 is the format's ceiling). A single blob would be one PUT, but couldn't sync at all above 95 MiB.
- **The read budget** keeps sync-server §5.4's policy unchanged (astra, TF5): what is metered is the bytes **authorized when a URL is issued**: a whole blob, a chunk, or a member's range. A device's URL is for exactly one object or range, and is reusable for its 5 minutes. Fetches within that time are outside the budget, bounded by the URL's expiry and the files Worker's per-IP rate, not by the budget. A grant's URL stays single-use. A hard limit on bytes delivered would be a separate protocol change, not something this note provides.

## 7. The PR sequence

| # | PR | Visible? | Owner |
|---|---|---|---|
| 1 | This design (docs only) | no | board + sync-client |
| 2 | Schema and protocol: manifests, chunk holdings, inert limits, with at-limit and one-over tests | no | sync-client |
| 3 | Chunked upload and read behind a flag (lifts 95 MiB to 200 MiB) | no (flag) | sync-client |
| 4 | Fetch on open, and the prefetch rule; the states in the file browser (§1.1) | yes: screenshots to William first | sync-client + board (UI) |
| 5 | Keep on this device, Remove from this device, the cache budget, "Free up space" (§3) | yes: screenshots first | sync-client + board (UI) |
| 6 | Packs and their compaction (§4.2) | no | sync-client |

Each PR carries its at-limit and one-over tests, and operation-count assertions (daybreak2, point 10).

## 8. Open questions

- The cache budget defaults (computer, phone): §6 has sync-client's proposal. A phone is chosen in the Storage panel, with a default from the screen (§2.1).
- Does "Keep on this device" on a folder include files added to it later? (Proposed: yes.)
- Notebooks and boards: their content is patches (sync-server §4), not blobs. Do they stay always local in these steps? (Proposed: yes; they're small.)
- Should the Storage panel show the cloud's breakdown per folder? (Not in these steps.)
- (sync-client, for astra) Accepting the client's whole-file hash unchecked at a manifest's commit, given that the downloading device checks it (§4.1).
- (sync-client, for astra) The `deleting` mark against a commit racing the outbox (§5.1).
- (sync-client, for astra) The pack's streaming check, member by member (§4.2).
- (sync-client, for daybreak2) The proposed cache budgets and floor (§6), and the compaction pace.
