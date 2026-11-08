# Tiered files: "in the cloud" files, keeping files on a device, and large files in chunks

*Status: design, docs only, nothing built. Authors: @sagebrush-board (the person's view, the UI, the words, the PR sequence) and @sagebrush-sync-client (the protocol, both sides, the chunker, packs, accounting, garbage collection). Reviews: astra (correctness), daybreak2 (limits and costs), William (the pictures, before anything visible merges). Commissioned by William, Nov 8 2026: "lazy 'in the cloud' files, eviction/pinning with a local-vs-cloud indicator, and chunked large files on the existing sync server. No code yet."*

*Built on design/sync-server.md (SyncAccount, SyncDoc, R2 blobs by SHA-256) and design/sync-client.md (the confirmed index, the outbox, C2's pins, L1/L2's budgets). Out of scope here: branches and snapshots of the whole workspace, and a synced real folder for `sagebrush remote` and agents. Those come later, on top of this.*

## In plain words

- **Files can live in the cloud only.** Every device lists every file, but a device downloads a file's bytes only when it's opened, or when the person asks to keep it. A phone with little space can still see a large workspace.
- **"Keep on this device"** keeps a file's bytes on this device, so it opens offline. Other files may be removed from this device to make room, but only once the cloud has every byte of them and has checked that its copy is complete and correct.
- **Each file shows where it is:** on this device, in the cloud only, downloading, or waiting to go up. The Storage panel shows how much is on this device and how much is in the cloud.
- **Large files sync in pieces.** Today a file over 95 MiB can't sync. In pieces, files up to the workspace's 200 MiB limit sync, an interrupted upload resumes where it stopped, and repeated data is stored once.
- **Nothing that hasn't reached the cloud is ever removed from a device.** A file with changes still waiting to go up stays, whatever the space.
- **Notebook outputs aren't saved by default.** They show while you work. A notebook's "Keep outputs" switch saves them with it, and notebooks that already have saved outputs keep them.

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

- "Remove from this device" is shown greyed, with its reason, when it can't be done (§3.4's checks): "Has changes not yet in the cloud", "Is being downloaded", "Is a conflict copy", "Is open in a tab", "Is kept on this device: stop keeping it first", "Sync isn't running", "Is needed to repair the copy in the cloud". It never removes bytes the cloud doesn't have.
- On a folder, "Keep on this device" keeps everything in it, including what's added later: files saved into it on this device (offline too), moved or copied into it, or added from another device (William: "like OneDrive"; the rule and its tests are in §3.1).

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
- **Never** a word that promises more than is true: not "safe", "secure", "backed up" or "unlimited", and none of the house's other banned words. Say what is true: "fully in the cloud" means the server holds every byte and has checked the whole file against its hash (§4.1's verification; §3.4's check 1), and nothing more.
- **Refusals name their reason** (daybreak2, point 7): "Can't remove lattice-points.sage from this device: it has changes not yet in the cloud." With sync off, signed out, between accounts or while sync rebuilds its index (§3.4's check 0): "Can't remove lattice-points.sage from this device: sync isn't running, so it can't be checked against the cloud."
- **Numbers are this device's or the account's,** and labelled so.
- **The messages, word for word** (each used where its section says):
  - opening a file in the cloud while offline: "<name> is in the cloud, and this device is offline. It will open when you're back online." (§1.2, §2);
  - while it downloads, in place of the content: "Downloading: 12 of 140 MB" (§2);
  - no room for it on this device: "There isn't room on this device for <name> (140 MB). Free up space in the Storage panel." (§2);
  - the daily read budget spent: "Daily download limit: resumes at 14:00" (as today, L1);
  - a download whose bytes didn't match: ⚠ "The download didn't match the file in the cloud, so it wasn't saved on this device. It will download again once the copy in the cloud has been checked, and replaced if needed from a device that has the file." (§4.1's repair: a single damaged piece is simply fetched again, unseen; this message is for a whole file that doesn't match);
  - no device can repair it: ⚠ "The copy of <name> in the cloud is damaged, and none of your devices has a good copy, so it can't be downloaded." (§4.1);
  - a removal refused while a repair may need this device's copy: "Is needed to repair the copy in the cloud" (§3.4 check 2);
  - kept files over the budget: "Kept files use more than this device's limit" (§3.2);
  - what holds the space: "120 MB here haven't reached the cloud yet; 300 MB are kept on this device." (§5.3);
  - persistent storage refused: "This browser hasn't agreed to keep Sagebrush's storage. If it clears it to free space, changes not yet in the cloud go with it." (§3.3);
  - "Free up space" done: "Removed 31 files (250 MB) from this device. They're still in the cloud." (§1.2).
  - the notebook switch: "Keep outputs", and when it's turned off: "Outputs won't be saved with this notebook. They still show while you work." (§1.4).

### 1.4 Notebook outputs: not saved by default (William's decision, Nov 8)

William: "outputs aren't saved into the synced notebook by default. They show while you work, and each notebook has a 'Keep outputs' switch". This is why notebooks and boards can stay on every device in these steps (§8): without outputs they're small.

**What a person sees:**
- While you work, outputs show as they do today.
- What is saved, and so synced, is the code and text. Opened on another device, a notebook shows no outputs until its cells are run there.
- Each notebook's ⋯ menu has **"Keep outputs"**, off for a new notebook. Turned on, the outputs are saved with the notebook and sync like the rest of it.

```
  ⋯ (notebook)
  ✓ Keep outputs        saved with the notebook, on every device
```

**Notebooks that already have saved outputs** (confirmed by @sagebrush, Nov 8): they start with "Keep outputs" on, so nothing already saved is dropped, whether or not the notebook is edited again. Turning the switch off removes the saved outputs at the next save, and the page says so once: "Outputs won't be saved with this notebook. They still show while you work." Nothing already saved is ever dropped without the person turning the switch off.

**Where it's built:** a separate notebook PR, not one of the six storage PRs in §7. It changes what the notebook saves, not how files are stored.

## 2. Step 1: "in the cloud" files

**What already exists:** a synced data file arriving from another device is listed at once, marked `remote` until its bytes are fetched (sync-client §3, "What comes down"; sync-view.ts). The fetch queue is durable, checked by hash and installed by compare-and-swap (C5), and debits the daily read budget (L1). Today every device fetches every file in the background. "In the cloud" mostly means **not** fetching in the background, and fetching on open instead.

**Client changes:**
- A per-device rule decides what is fetched in the background (the prefetch rule, §2.1). Everything else stays `remote` (shown "In the cloud") until opened.
- Opening a `remote` file fetches it first, through the existing queue, ahead of background work.

**The one rule that changes.** An entry is in the durable fetch queue when its `fetch` field is set (the hash to fetch, read through the sparse `byFetch` index: web/workspace/sync-fetch.ts). Today the view sets `fetch` on every remote file (sync-view.ts), and that one line is what makes every device download everything. In step 1, `fetch` is set only:
1. **when the file is opened** (below);
2. **when it is kept** (§3.1), on the file, or on every file under a kept folder, 500 entries a transaction, from a durable cursor;
3. **by the prefetch rule** (§2.1).

A remote op that replaces a file's hash moves `fetch` to the new hash only if the file was local or kept. Otherwise it stays "In the cloud", with its new hash. A remote op that creates a file under a kept folder, or moves one there, sets `fetch` too (§3.1).

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
- **Every way a file can arrive in a kept folder is kept** (William, Nov 8: "yes, like OneDrive. This includes files saved on this device into the folder"). Because "kept" is decided by walking up from the file's current place each time it's asked, never recorded per file when it arrives, there is no arrival path that can miss it:
  - **saved on this device** into the folder, as a new file, including an editor's save by a temporary name then a rename into place, and a save made offline;
  - **moved or copied** into the folder, or into a folder below it, on this device;
  - **arriving from another device** (a remote create, move or write under the folder): the same walk sets `fetch`, so the bytes come down as for any kept file (§2's rule 2, the rule for remote ops extended from "local or kept" files to files under a kept folder);
  - a new folder made inside a kept folder, and everything later saved in it.

  A file moved **out** of every kept folder stops being kept by the same walk, and becomes an ordinary cached file. Renaming or moving the kept folder itself keeps its `keep:<fid>`, since the record is by the folder's identity, not its path.
- Tests (William's OneDrive case): a new file saved offline into a kept folder, then synced, then a removal pass run with the cache over its high mark: it is never removed. The same for a save by temporary name and rename; a file moved into a kept subfolder; a subfolder made inside a kept folder; a kept folder renamed; a file from another device created in a kept folder (fetched, then kept). And the converse: a file moved out of the kept folder becomes removable.
- **"Recently opened"** is `opened:<fid>` in meta, written at most once an hour per file. A file never opened sorts by its `updated` time.
- **The cache total** (the bytes of local data files, kept and not) is a meta counter kept in the same transaction as each install, removal and write, and recounted daily, never a scan.

### 3.2 The cache budget

- **One budget per device:** "Keep up to", with a **high mark** (start removing) and a **low mark** (stop), and a **free-space floor** always left for the browser (hysteresis, so removal doesn't loop: daybreak2, point 6).
- **Admission, against the whole site's storage** (daybreak2, LIMIT-TF-1). The browser's quota covers everything the site keeps (versions, notebooks, the index, IndexedDB's own overhead), not only cached files. So before any install, whether for an open, a keep or a prefetch, the client requires
  $$u + R + r \le q - f,$$
  where $u$ is the site's estimated usage and $q$ its estimated quota (`navigator.storage.estimate()`), $r$ is this transfer's reserved install bytes (L2), $R$ is the sum of every install already admitted whose bytes aren't yet reflected in $u$, and $f$ is the free-space floor.
  - **Admission is one step:** the check and the addition of $r$ to $R$ are made together, so four downloads starting at once can't all pass on the same $u$. $R$ loses $r$ when the install finishes (and a fresh estimate is taken) or fails. Test: four simultaneous opens at the edge admit only the prefix that fits.
  - **The estimate must be at most 60 s old.** If none that fresh can be had, nothing is admitted: background caching (prefetch, keeping a folder) stops, and an open is refused with "There isn't room…" (§1.3) before any URL is asked for. An older estimate may be shown in the panel, but never admits anything.
  - The person's "Keep up to" is clamped to what is left for the cache: at most $\max(0,\ q - f - (u - c))$, where $c$ is the cache total (§3.1), so the panel never shows a negative limit. The panel shows the clamped figure.
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
- **The automatic pass** (§3.2) removes at most 100 files and at most 64 MiB a transaction (daybreak2's LIMIT-TF-2), at most once every 10 minutes. A file over 64 MiB (up to the 200 MiB file limit) is removed in a transaction of its own. Each transaction also stays within PINS.slice's request bound (400). Tests: 100 files totalling exactly 64 MiB in one transaction; a 101st file, or one byte more, goes to the next; one 200 MiB file alone. It doesn't remove a file within an hour of an install for an open (`min_resident`). Kept, unsynced, open and conflict files are never candidates, so a cache full of them stops the pass rather than looping.
- **The browser's own eviction** is a different thing: under pressure a browser may drop a whole site's storage. When sync is turned on, the page asks for persistent storage (`navigator.storage.persist()`). Where that is refused (Safari, some phones), the Storage panel says so, since a whole-site eviction would also take files waiting to go up.

### 3.4 Never removing the only copy (the hardest invariant)

A file's bytes may be removed from a device only if **all** of these hold, checked in the same transaction that removes them:
0. (sync-client, astra's TF3) **the lifecycle is the one the decision was made in, and is synced now.** The transaction reads, and compares with what the decision recorded:
   - the lease `sync:current`: on (not `off`), the same namespace `ns` (account hash, server generation, device) and the same lease generation;
   - the lifecycle epoch `sync:epoch` (C2: it moves on turning sync off, sign-out and a namespace switch);
   - the active confirmed-index generation `sync:<ns>:indexGen`, with no rebuild staged or flagged (`sync:<ns>:rebuild` absent; sync-client step 4's `stage`…`done` not running).

   Old confirmed data (an earlier namespace's, an index being rebuilt, or one kept after sign-out) is never proof that the current account has the bytes. So with sync off, signed out, between accounts or during a rebuild, nothing is removed: the reason is "Sync isn't running". These are C2's and step 4's own fences, not a new notion of synced;
1. **the active confirmed index has this identity at this `sha256`** (C3): the server accepted the op that made these bytes this file's current ones, so its holding is referenced by this very entry. The same hash under some other identity, in an older confirmed state, or under another index generation, doesn't count. For a chunked file, the server accepts an op only for a manifest it has verified against the whole SHA-256 (§4.1), so this check also means the cloud's chunks rebuild these exact bytes;
2. **nothing about this identity is pending, at any stage.** None of these names it: an outbox record; the C2 summary's `latest` beyond the confirmed seq, or `byNs[ns]`'s `allocated`, `held`, `collapsed` or `successor` not yet settled; a pin (`sync:cur:<fid>` and `pins` by identity); the reissue journal; the undrained adoption journal; a local op not yet scanned (its `seq` above the scan watermark); and the server must answer `held` (not `damaged`) for the file's `sha256` just before the removal (§4.1, "Removal can't take a good copy of a damaged file"). Each is an O(1) lookup by identity or a comparison with a stored watermark, never a scan. This is the complete pending summary the view itself uses (sync-client C3, "What the person sees": the outbox, the adoption journal, held writes, unscanned local ops), so a stage the view counts can't be missed here (astra's TF3);
3. it isn't a conflict copy waiting for the person;
4. no download or upload of it is in flight;
5. (sync-client) it isn't kept, by itself or a folder above it;
6. (sync-client) **no reader holds it,** by the file's read lock (below);
7. (sync-client) its revision and bytes are the ones the removal was decided on: the entry's identity, `sha256`, revision and the presence of `fileBytes[fid]` are compared, as C5 does for an install, so a write that lands between the decision and the transaction stops it.

The transaction's scope covers every store these read (meta, `syncIndex`, the outbox, pins, the journals, entries and fileBytes), all in the workspace's one IndexedDB database, so the checks and the removal are one atomic step. A refused removal changes no bytes and no entry.

**The read lock, named (astra's TF3).** There is no open-file lease in the page today; this note adds one, and eviction and every reader share it:
- **The lock** is the Web Lock `sagebrush-file:<workspace id>:<fid>`. A reader holds it in `shared` mode for as long as it relies on the file's bytes being on this device: an editor or notebook view while it's open, an export while it reads, a notebook's `open()` stream until it's closed, a workspace agent's read until it returns.
- **A read made in a single IndexedDB transaction needs no lock.** IndexedDB orders it against the removal's readwrite transaction, so it sees either the bytes or `remote: true`, and a `remote` entry sends it down the open path (§2). Only a reader that reads across more than one transaction takes the lock, and it takes it before its first read.
- **Removal asks for it `exclusive` with `ifAvailable`,** after the workspace lock and while holding it, and runs its transaction inside. If a reader holds it, the removal is refused ("Is open in a tab"), never waits. A reader that asks after the removal began waits for the removal's transaction, then finds `remote` and fetches. So no reader slips between check 6 and the deletion. The order is always workspace lock, then file lock, and only removal takes both; with `ifAvailable` it never waits, so the two can't deadlock.
- **A suspended tab** keeps its locks, so its files aren't removed until it's closed or resumes and releases them. A tab that closes or crashes loses its locks with it, and with them the reader that needed the bytes.
- **A browser without Web Locks** can't make workspace changes today (web/workspace/api.ts refuses them), and removal is one. Where exclusion can't be proved, nothing is removed.

If any fails, the removal is refused with its reason (§1.3), and the cache budget simply goes over until it can proceed. A local save is never refused for the cache's sake: the device's copy stays authoritative, and the panel says the cache is blocked (daybreak2, point 7).

(sync-client) **Tests**, each against a held step (a removal held between its decision and its transaction, as C5's tests hold a GET):
- a local write lands meanwhile (check 7);
- the op that made the bytes is still in the outbox, then acked but not echoed, then echoed (checks 1 and 2: refused, refused, allowed);
- the server refuses the op (`missing`): the record is removed and the bytes stay local (check 2, then check 1 still fails);
- a remote write to the same file arrives meanwhile (check 1: the confirmed hash moved);
- a conflict copy (3), a kept folder above (5), the file open in another tab (6), a fetch of a newer hash in flight (4);
- (astra's TF3) held across: sign-out, turning sync off, a namespace switch, a generation change after "Delete my synced data", a rebuild staged and then published (check 0); an unscanned local save, a held or collapsed write, an adoption still in the journal (check 2); a folder made kept, and a move into a kept folder (check 5); a second tab's open, export and `open()` stream starting just before and just after the decision (check 6). Each is refused, and changes no bytes and no entry state;
- a removal and a new reader racing for the file's lock, in both orders: the reader gets the bytes, or waits and then fetches; never a missing file;
- a crash in the middle: the removal is one transaction, so after a reload the file is either local with its bytes, or "In the cloud" without them, never a local entry with no bytes;
- the scale: 100,000 entries, a pass over a full cache, every transaction within PINS.slice's request bound.

(sync-client) **The randomized state-machine test** (@sagebrush, from William's outside review). The tests above each hold one step. This one runs many seeded random interleavings of every action that can touch a file's copies:
- **Actions:** a local write (new file, overwrite, save into a kept folder, delete, move); a remote write from a second simulated device; a sync step (send, ack, echo, refusal); a download; a removal by hand and by the automatic pass; keeping and un-keeping a file or folder; a second tab opening and closing a file; sign-out, account switch, sync off and on, and a rebuild; a network failure at any request; a crash (the database kept as of its last committed transaction, everything in memory lost).
- **Against:** the real client code over a real IndexedDB (fake-indexeddb in Node), and the reference server (Miniflare) with its R2, through a network that can drop, delay or duplicate any request.
- **The invariant, checked after every step:** for every file version that the person has written on any device and not since replaced or deleted on purpose, at least one recoverable copy exists: bytes on some device (with its pending record or pin), or a held, verified holding on the server that a confirmed op points at. A removal never takes the last such copy. Also checked each step: §3.1's states are consistent (no local entry without bytes, no `remote` entry with bytes), and the cache total equals the sum of local bytes.
- **Size:** 10,000 sequences of 200 steps on each PR that touches §3 or §4, and many more nightly. A failure prints its seed and its shortest failing sequence (by removing steps while it still fails), and that sequence becomes a fixed test.

## 4. Step 3: large files in chunks, and small files in packs

*(sync-client's section; board's outline points kept as the first bullets of each part.)*

**What it lifts:** the server's single-PUT limit of 95 MiB. The workspace's own file limit, 200 MiB (`LIMITS.maxFileBytes`), stays. So step 3 makes files from 95 MiB to 200 MiB syncable, makes every large upload resumable, and stores repeated data once. Raising 200 MiB is a separate decision, not this note's, and every cap below is named either way (daybreak2, point 1).

### 4.1 Chunks

- Content-defined chunking: the algorithm and its parameters are **named and versioned in the manifest**, and a client's output is deterministic (daybreak2, point 3). Proposal to evaluate: minimum / target / maximum 1 / 4 / 8 MiB.
- A file's identity stays its whole-file SHA-256 (the op's `sha256`). Its **manifest** lists its chunks (hash, size), in order. It is kept in the account object's SQLite, not as a blob (below).
- **Upload and resume:** `blobs/check` for the missing chunks, idempotent PUTs, then the manifest, which the server verifies against the whole-file hash, then the op. The op is accepted only for a verified manifest. No rechunking on the server.
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

**First, is the whole file already there?** (@sagebrush, item 5.) Before chunking, the client sends the file's whole `sha256` in `POST /blobs/check`, which now answers for a whole file too: `held` (a blob, a packed member, or a `files` row `verified` or `live`), `verifying` (a row for it is being verified), `damaged` (its stored bytes are marked damaged: send them as a replacement, step 3 of "Repairing a corrupt file" below), or `missing`.
- `held`: the client skips every step below and sends the op. The bytes are the same whatever chunker made them, so a client never registers a second manifest for a hash already verified, and never needs to: a manifest under another `cdc` name for the same bytes is simply not made.
- `verifying`: the client doesn't register its own manifest (it would get `conflict`). It drives the existing row's verification with the verify call below, which works the same whoever registered it, then sends the op.
- `missing`: the steps below.

Tests: two clients with different `cdc` names upload the same bytes, one after the other (the second makes no PUT and no manifest) and at once (one registers, the other gets `verifying` or `conflict`, drives the same row, and both ops are accepted); an old client reads a file whose manifest was made by a newer `cdc`, and the reverse (reads never re-chunk, so both work).

1. The client chunks and hashes the file. It holds one chunk and the gear state at a time, reading the file's bytes from fileBytes once, under the reservation (L2). On a phone this runs in a Worker, one file at a time.
2. `POST /blobs/check` with the chunks' hashes, at most 1,000 a request.
3. `PUT /blob/<chunk sha256>` for each missing chunk. This is today's endpoint and its reservation, at most 8 MiB each. The client sends at most 2 at once (L2's uploads); the server's own limit of 4 PUTs at once per account (sync-server §8) is a separate ceiling above it. A retry of a stored chunk is idempotent (sync-server §5.4, step 3).
4. **`POST /api/sync/v1/manifest`** (new): registers it. In one transaction, the account object:
   - checks the manifest's form and limits, and that `size` is at most `max_file_bytes`;
   - checks that every chunk is held as its own holding (a chunk is never a packed member), and that each listed size equals its holding's stored size. Otherwise it refuses with `missing` (naming the absent hashes) or `invalid` (naming the wrong sizes);
   - records the `files` row in state `verifying`, with a registration id `reg` (random 128 bits, never reused), the SHA-256 of the manifest's canonical JSON (`mdigest`), the chunks' R2 keys as they are now, a verification position of 0, and `hold_until` a day away;
   - adds one reference to each distinct chunk holding, owned by this row (so none of them can be released or deleted while it verifies).

   The same manifest again changes nothing but `hold_until` (a day from now), and answers the row's state and position, so a lost answer is simply asked again, with no second reference. A different manifest for the same `sha256` is refused with `conflict` while a row for it exists, in any state, so a hash has one manifest at a time.
5. **The server verifies it** (astra's TF1): `POST /api/sync/v1/manifest/<sha256>/verify`, repeated until it answers `verified`. Each call:
   - reads the row's `reg`, `mdigest`, position, saved SHA-256 state and the next chunks' keys (and debits the meter, below);
   - streams at most 8 chunks (at most 64 MiB) from R2 by those exact keys, in the manifest's order, through a SHA-256 whose state can be saved (FIPS 180-4, implemented from the standard: eight 32-bit words, the length, and at most 63 bytes not yet in a block). Each chunk's streamed length must equal its listed size;
   - then, in one transaction: rechecks the account's generation and `state = 'active'`, the row's `reg`, `mdigest`, state and position, all as captured (a compare-and-swap: of two calls racing, one wins, and the other's work is discarded; and a call that began on a row since retired and registered again, even at the same hash and position, finds another `reg` and changes nothing), and that each chunk's holding still has the captured key. It saves the new position and SHA-256 state. **If a captured key changed** (a repair elsewhere rekeyed a shared chunk, §4.1 "Repairing"), the transaction instead restarts this row's verification: position 0, the SHA-256 state cleared, the chunks' keys captured afresh and a new verification incarnation `vinc` drawn, keeping `reg`, `mdigest`, `hold_until` and every reference. Each call also captures `vinc` and compares it, so a stale call can't checkpoint into the restarted verification;
   - after the last chunk, the transaction compares the total length with `size` and the digest with `sha256`. If both match, the row becomes `verified`. If not, the row is retired at once, in that transaction and only if its `reg` is still the captured one (its chunk references released, as in §5.1). This is the one exception to `hold_until`: a row proved wrong is retired immediately, not kept for its day and the answer is `invalid` with the reason (`order or hash`, `size`). A client that gets `invalid` never sends the op, and its upload pin isn't released: the file stays "Waiting to go up", with ⚠ and the error logged.

   Verification reads each chunk once inside Cloudflare (one R2 read per chunk, no egress to the person), and debits nothing from the person's read budget. It is bounded per account: one verification call at a time, and `sync.verify_bytes_per_day` (§6: set by CoCalc, 16 GiB when CoCalc sends none). **Each call debits the byte total of the chunks it captured before its R2 stream begins,** in the transaction that hands it the keys, so a call that fails, loses the compare-and-swap or is discarded has still been counted, and retries can't exceed the meter (daybreak2's LIMIT-TF-8). Over it: `rate`, with `retry_after`, and nothing is streamed. A verified row is never verified again: the same manifest registered again is a no-op.
6. Then the op, as today. Its check "a referenced blob is held" becomes "held as a blob, a packed member, or a `files` row in state `verified` or `live`". An op naming a row still `verifying` is refused `missing`, like an unheld blob. So no op can make an unverified file this entry's current bytes, and the file can't be confirmed (C3) or removed from a device (§3.4, check 1) on an unverified manifest.

**C2's pins cover a chunked file unchanged:** they pin the file's bytes on the device (by `sha256`), and the chunks are cut from those bytes at upload. Nothing per chunk is pinned on the device. A pin is released only when the op is confirmed (C3), which step 6 makes impossible before verification.

**Why the server verifies, rather than the downloading device only** (astra's TF1): a faulty client could upload valid chunks and commit them in the wrong order, or under a wrong whole-file hash. If only the downloading device checked, the device that wrote the file could already have removed its correct copy (§3.4) before anyone found out. A blob's PUT already has its hash checked by R2 (sync-server §5.4); verification gives a chunked file the same property before any op can use it.

Tests (astra's TF1): correct chunks in the wrong order; a wrong whole-file hash; a listed size that differs from the held chunk's; a second, competing manifest for the same hash during verification; verification interrupted after each chunk and resumed, and two verify calls racing; a verify call held mid-stream while its row expires and the same manifest (and, separately, another manifest for the same hash) is registered again: the held call neither checkpoints into nor retires the new row; the generation switched between the stream and its transaction. In none of them is the file usable by an op, or its upload pin released as a completed upload.

**Reading:** `GET /api/sync/v1/manifest/<sha256>` (new) answers the manifest from SQLite, only for a row `verified` or `live` (§4.4 says who may ask). The client then fetches each chunk by `GET /blob/<chunk>`, each with its own signed URL and its own debit, a few at a time. It copies, rather than fetches, any chunk it already holds in an earlier version of the file. Then it assembles, checks the whole hash, and installs. An interrupted download resumes chunk by chunk.

**Two checks, two outcomes:**
- **Each chunk is checked against its own hash as it arrives.** A chunk that doesn't match is a transfer error: it is dropped and fetched again, like any failed fetch (L3's backoff, with its kept signed URL).
- **The whole file is checked once every chunk has passed.** Since the server verified the manifest before any op could use it, a mismatch here means stored bytes went bad (or a server defect), not a client's wrong manifest, and fetching again would get the same bytes. So the device doesn't retry: it marks the file `fetchFailed: corrupt` and reports it. The same holds for a chunk that fails its own hash again from a fresh URL, and for a single blob.

**Repairing a corrupt file** (@sagebrush, item 6), instead of leaving it broken until the file changes. This is the least complex form (@sagebrush, astra): a repair never patches stored pieces in place. A device with good bytes uploads the whole file again as a **fresh replacement**, through the normal upload path. The server verifies it and then swaps it in, in one transaction. Entries, versions and pins keep pointing at the same `sha256` throughout; only the stored bytes behind it change.

1. **The report:** `POST /api/sync/v1/repair/<sha256>` from the device that saw the mismatch. The `repairs` row for the hash records the **representation** it is about, `rep`: the blob holding's key, the `packed` row's place, or the `files` row's `reg`, as they are now.
   - **A duplicate:** a report about the same `rep` while a check of it is running, or within an hour of that `rep` checking out healthy.
   - **Over the rate** (§6).

   Either uses up only its request and starts nothing. Any other report starts a new check, so a healthy result never hides a later real corruption: after an hour, or once `rep` has changed, a report checks again.
2. **The check:** the account object re-reads that representation and checks the whole hash. It uses the verify step's streaming and metering, with its own random, never-reused check id `cid`, and captures the physical keys it streams. It checkpoints by compare-and-swap on `cid`, `rep` and those keys together. If any key changed (another file's repair rekeyed a chunk they share, without changing this `rep`), the check restarts from zero with the keys captured afresh and a new `cid`, so the stale stream can't checkpoint, mark or bump. A check held across a replacement finds `rep` changed and does nothing: it never marks, clears or bumps anything for a representation it didn't read. It never retires a row or releases a reference.
   - **The bytes check out:** the fault was on the reporting device's side. The hash's `repair_gen` goes up, and that device fetches once more. If that fails too, it stays `fetchFailed: corrupt` and logs both.
   - **They don't:** the representation is marked **damaged**, with a new repair incarnation `rid`, durably, on the record that stores it: the blob's holding, the member's `packed` row, or the `files` row. The mark is by `sha256`, so it covers every entry, version and pin with that hash, current or not. The account's log gets a `damage {sha256}` op, so every device learns of it in order through its confirmed cursor (C3); the log is never truncated, so no notice is dropped.
3. **The replacement, from any device whose local bytes have that `sha256`** (its fileBytes, a version or a pin). It uploads the whole file again, cut by its own `cdc` (any version will do, since only the whole hash counts), into **fresh staging keys that dedup against nothing** (astra's A). A repair never uses `blobs/check` or an existing holding, so it can't reuse the bad bytes it is replacing, even with the same `cdc`.
   - **Staging:** `POST /api/sync/v1/repair/<sha256>/stage {rid, manifest?}` makes a `repair_files` row with its own random `reg`, the `rid` it repairs, and `hold_until` a day away. It is a separate staging identity, not in `files`, so the one-manifest-per-hash rule and its `conflict` stay as they are.
   - **Uploading:** each piece goes with `PUT /api/sync/v1/repair/<reg>/piece/<i>`: the whole file if it is 8 MiB or less, else each chunk in the manifest's order. Each piece gets a new random key and its own reservation, as any PUT, and R2 checks its hash. The key belongs to the staging row only; no holding is made or touched.
   - **Verifying:** a chunked replacement is verified exactly as §4.1, step 5, over the staging row's own keys. A single piece is checked by R2 at its PUT.
   - **Cleanup:** a staging row that fails, is superseded (its `rid` no longer current) or passes `hold_until` is deleted, its keys go to the outbox and its reservations are released, all in one transaction. Doing that twice is harmless.
4. **The swap, in one transaction,** only after that verification:
   - compare-and-swap on the `repairs` row's `rid` and `rep`, and that the representation is still marked damaged;
   - **adoption of the staged keys:** for each distinct piece hash, if a holding for it exists, its key becomes the staged key and the old key goes to the outbox with the 10-minute `not_before` (§4.2), with its `refs` and their owners unchanged; if none exists, a holding is made with the staged key. A packed member's replacement becomes a blob holding, its `packed` row going and its references moving over. Staged keys left over (a hash listed twice) go to the outbox. Existing outbox rows aren't touched;
   - a `files` row takes the new manifest and a new `reg`, adds references to the new chunk set, and keeps its own `refs` and every owner of them;
   - only then, in the same transaction, are the old pieces' references released (to the outbox as usual, §5.1), the mark cleared, a `repaired {sha256}` op logged, and `repair_gen` bumped.

   A stale or second replacement finds the capture changed and is discarded like any unused upload.
5. **Devices with `fetchFailed: corrupt` retry only when `repair_gen` changes,** never on a timer. So there is still no retry loop: one fetch per repair, and none while nothing has changed.
6. **No device has the bytes:** the mark stays, the file shows §1.3's "The copy of <name> in the cloud is damaged, and none of your devices has a good copy, so it can't be downloaded.", and nothing retries. A device that later gets the bytes repairs it as in step 3. That loss would be the storage's, not sync's.

**Removal can't take a good copy of a damaged file** (astra's R1). §3.4 removes a file only when the server says, fresh, that its hash is `held`:
- the removal's decision sends its hashes in one `POST /blobs/check` (at most 1,000, one request per removal transaction, bound to the account and generation like every sync request);
- `blobs/check` answers `damaged` for a marked hash, never `held`, so a damaged file isn't removed, whatever this device has or hasn't received yet;
- the transaction then runs §3.4's checks as usual (check 0's fences included).

A file damaged after its removal was decided is the same case as one damaged after removal: the damage didn't exist when the check was made.

Tests:
- more than 100 damaged hashes, then a removal pass on a device holding all of them (none removed);
- a damage mark landing between a removal's `blobs/check` and its transaction;
- a repair of a live, referenced chunked file interrupted at each step, and raced with a second replacement and with GC (references unchanged, one swap wins);
- replacements made by an older and a newer `cdc`;
- a damaged single blob, and a damaged packed member;
- every chunk intact but the whole hash wrong;
- no device holding the bytes (no loop);
- a report when the server's bytes are fine (one more fetch);
- duplicate and over-rate reports (no check started);
- (astra) a same-`cdc` repair while the bad chunk is still held (the staged fresh key is adopted; the bad key goes to the outbox);
- a healthy report, then real storage corruption and a new report an hour later (checked again, and marked);
- a report's check held across a successful replacement (it finds `rep` changed and does nothing);
- (astra) a first verification held mid-stream while an unrelated repair rekeys a chunk it shares (it restarts with the new keys and a new `vinc`, and the stale call changes nothing); a report's check held while another file's repair rekeys a shared chunk (it restarts with a new `cid`).

**Assembly memory, honestly:** fileBytes stores a file as one value, so a 200 MiB file is assembled whole in memory under its reservation (`size × COPIES`, L2), as a 200 MiB download would be today. Storing files by chunk on the device (so a phone never holds 200 MiB at once, and local versions share chunks) is a later change, outside this note.

**Later: chunked storage on the device, and streaming reads** (no design yet). Today the device keeps each file whole (fileBytes), so a 200 MiB file is assembled, installed and read as one value. Storing files on the device by chunk, keyed by the chunk's hash as the server's are, would let a phone avoid holding a large file at once, let local versions and copies share chunks, let removal (§3.3) free space chunk by chunk, and let a reader stream a file instead of waiting for all of it. It needs its own design note: a migration of fileBytes, a count of references per local chunk, and C2's pins and C5's install restated for chunks. Nothing in steps 1–3 depends on it, and the manifest (§4.1) already carries what it would need.

### 4.2 Packs

**After a benchmark, not part of the core plan** (@sagebrush, item 4). Packs only help with the first upload of many small files; R2's per-operation cost there is small, so the case for them is latency. They are built only if this measurement says so:
- **The measurement:** the first sync of a workspace of 20,000 files of 4 KiB, single blobs, with the client's 2 uploads at once (L2), from a computer and a phone, on a connection with about 50 ms and about 150 ms round trips. Recorded: the wall time to "Synced", the requests made, and the server's per-account rates hit. Each upload is a reservation, a PUT and a finalize, so at 2 at once and 150 ms a round trip this could take tens of minutes.
- **First, the cheaper fix:** the same run with the client sending small files 4 at once, the server's existing ceiling of 4 PUTs per account (no limit changes), and `blobs/check` batching. If the slower of the computer and phone runs finishes under 10 minutes on the 150 ms connection, packs aren't built.
- **Otherwise,** packs as below, and the same measurement repeated with them, to show the gain before PR 6 merges.

- Only small immutable blobs (proposal: ≤ 64 KiB) go into packs (proposal: target 8 MiB, hard maximum 16 MiB). A pack is immutable, with a bounded index of offset and length, read by Range (daybreak2, point 4).
- A pack is never rewritten when one member changes. A partly dead pack is compacted by GC, one pack per step, when its live share falls below a threshold.
- Small files may still go up as single blobs, under pressure or failure.
(sync-client)

**Who builds packs: the client,** at upload. The server never repacks a member, and only compacts (below).

**What goes in:** whole small files of at most 64 KiB, never chunks. A pack targets 8 MiB, with at most 16 MiB and 4,096 members.

**The format:** a 4-byte big-endian length $L$, then a JSON index of $L$ bytes, `[[member sha256, offset, length], …]`, then the members back to back. It goes up with `PUT /api/sync/v1/pack/<pack sha256>` (new). The bounds, all checked by the server (daybreak2's LIMIT-TF-3, astra's TF4):
- **The whole pack, prefix and index included, is at most 16 MiB:** `Content-Length` is required and checked first.
- **The index is at most 512 KiB** ($L \le 524288$), checked from the prefix before a byte of the index is read. (4,096 members at about 90 bytes each is about 360 KiB.)
- **The index is canonical:** lowercase 64-hex hashes, all distinct; offsets and lengths are JSON integers (no sign, fraction or exponent); 1 to 4,096 members; each length 1 to 65,536. The first member starts at $4 + L$, each next one where the previous ends, and the last ends at `Content-Length`. So there are no gaps, overlaps or bytes outside a member.

**The order of the upload, and nothing visible before its end:**
1. Before anything: the session, `x-sync-account` and `x-sync-generation` (§4.4), `Content-Length` at most 16 MiB, then the prefix and the index, read into memory and checked whole. A refusal here (`limit`, `invalid`) reserves and stores nothing.
2. The account object reserves `Content-Length` bytes, with a random key, as a blob's PUT does (sync-server §5.4, step 1), but checked against the account's storage (`storage_bytes` minus usage, `blob_cap`) and the 16 MiB pack cap, **not** against `max_file_bytes`. `max_file_bytes` is a limit on a file, so it is checked per member: each member's length is at most `max_file_bytes` (and at most 64 KiB). So on a tier whose `max_file_bytes` is under 16 MiB, packing never refuses small files that would sync singly (daybreak2's LIMIT-TF-7).
3. The Worker streams the body to R2 under that key, with the pack's SHA-256 for R2 to check, and hashes each member as it passes; a member whose hash differs from its index entry ends the stream.
4. **Finalizing, in one transaction,** only if every member and the whole pack matched: the generation and `state = 'active'` are checked again, the reservation is released, the pack becomes a holding (its key, its whole size), and each member gets a `packed` row, except a member already held (as a blob or in another pack: two devices racing), whose copy here is dead bytes from the start.

A failed or cancelled stream, or a refused finalize, leaves no `packed` row and no holding. Its reservation is reaped and its key goes to the outbox, exactly as a blob upload that dies (sync-server §5.4, step 4), and doing that twice is harmless. A member's references are counted by the server from the ops, versions and pins that name it, never from anything the client declared about packing.

**Reading a member:** `GET /blob/<member>` answers with a signed URL for exactly its byte range of the pack. The URL carries the range, and the files Worker serves only that, so a retry within the URL's 5 minutes can't read more of the pack. **The debit is the member's length,** the bytes served (daybreak2, point 8).

**A member that changes isn't rewritten in place.** Its new bytes go up as a new blob, or in a new pack, and the old member loses its reference.

**Compaction,** by the account object's alarm, one pack at a time (astra's TF2 for the steps, daybreak2's LIMIT-TF-5 for the pace):
1. **Capture, in one transaction:** take the oldest pack on the `compact` queue (one row, never a page). Record a compaction `{id, pack, its key, every member with a `packed` row pointing at the pack (sha256, offset, length), new key}`. "Every" includes members with no reference yet (a member is kept a day after its pack's upload before it is dropped as unused, §5.1), since one may gain its first reference during the stream, add one temporary reference to the source pack (so it can't be released while it is read), and take the **compaction reservation** for the new pack, with its random key. That reservation is its own, apart from uploads' (daybreak2's LIMIT-TF-5): at most one per account and at most 16 MiB, checked in this transaction, and allowed above the account's storage cap, so compaction also runs on a full or `readonly` account (§5.2). It counts in physical usage and the inventory like any reservation, but never adds to the room ordinary uploads are checked against: an upload's check still sees usage including it.
2. **Stream:** one R2 read of the source pack, writing only the captured members, with a new index, to the new key.
3. **Swap, in one transaction:** check the generation (and that the account isn't `deleting`; `readonly` is allowed), the compaction record and that the source pack still has the captured key. Then, for each captured member, only if its `packed` row still points at the source pack at the captured offset, move it to the new pack. A member released during the stream isn't moved, and its bytes are dead in the new pack. A member that gained references meanwhile is moved with them, since references belong to the `packed` row, not to a location. A member uploaded again elsewhere meanwhile already has its own row and isn't touched. A moved row keeps its `created`, so an unreferenced member's day isn't restarted. Last, the swap counts the `packed` rows still pointing at the source; if any remain (none should, since rows for a pack are made only at its finalize, before capture), the swap is refused and the compaction fails, as below, keeping the source and its rows. So nothing is resurrected, lost or charged twice, and the source is never released with a live mapping. The new pack becomes a holding with the moved members; the temporary reference and the reservation are released; and the source pack, now without live members, goes to the outbox.
4. **The source's delete waits 10 minutes** in the outbox (`not_before`), longer than a signed URL's 5 minutes, so a URL issued for a member's range before the swap still reads the old pack until it expires.

**A failed compaction** (an R2 error, a crash, a failed swap check) drops its record, its temporary reference and its reservation, and queues only its own new key, never published, for deletion. Doing that twice is harmless. The next compaction starts only once that key's delete has finished, so the extra storage at any time stays at most 16 MiB.

**The pace:** at most one compaction every 30 minutes per account, so at most 48 a day. Each is one R2 read of at most 16 MiB, one R2 write of at most 8.5 MiB (under 50% of 16 MiB live, plus at most 512 KiB of index; members kept in their first day without a reference count as live, §4.3, so capturing them never makes the write larger than this) and, later, one R2 delete. So a day's compaction is at most 48 reads (768 MiB), 48 writes (408 MiB) and 48 deletes per account. The `compact` queue has at most one row per pack. A pack queued behind the pace keeps counting whole in usage until it's compacted (§4.3), so a slow queue costs the account space, never correctness.

Tests (daybreak2): the boundary pack, nearly 16 MiB, under 50% referenced but with unreferenced members still in their day: it isn't queued until its `packed` rows' bytes are under 50%, and its compaction's write stays under 8.5 MiB. Tests (astra's TF2): a member's last reference released during the stream; a new reference to a member during the stream; a member with no reference at capture that gains its first during the stream (moved, still readable); a `packed` row pointing at the source that wasn't captured (forced in the test: the swap is refused, the source kept); the same bytes uploaded again during the stream; a signed URL for a member issued before the swap and used after it; a crash after each step, and the retry.

**Direct small blobs stay allowed** under pressure or failure: packing is an optimization the client may skip, and the server accepts either.

### 4.3 Accounting

- **Charged once, physically:** unique chunk and pack bytes per account, not logical references. Missing bytes are reserved before upload; the manifest's commit turns reservations into references in one step; retries don't charge twice. A packed member can't claim a saving the pack doesn't make (daybreak2, point 5).
(sync-client)

**New tables in the account object:**
```
files(sha256 PRIMARY KEY, reg, mdigest, vinc, size, manifest TEXT, chunks, keys, state, position,
      sha_state, hold_until, refs, created)        a chunked file: its manifest and its verification (§4.1)
packed(sha256 PRIMARY KEY, pack, offset, length, refs, created)   a member: where it is, and its references
compactions(id PRIMARY KEY, pack, key, members, new_key, reservation)   at most one per account (§4.2)
compact(pack PRIMARY KEY, queued)                  packs under 50% live
outbox(key PRIMARY KEY, created, not_before)       gains not_before (§4.2, step 4)
repairs(sha256 PRIMARY KEY, rep, cid, rid, state, checked_at, repair_gen)   the representation, its check, its damage mark (§4.1)
repair_files(reg PRIMARY KEY, sha256, rid, manifest, keys, reservations, state, position, sha_state, hold_until)   a replacement's staging row (§4.1)
```
Chunks and packs are ordinary `holdings` rows: one per R2 object, with `refs`.

**The references:**
- an entry, version or pin refers to a blob holding, a packed member, or a `files` row;
- a `files` row refers once to each distinct chunk holding, from its registration until it is retired;
- a pack holding's `refs` is its count of `packed` rows, plus a compaction's temporary reference while it reads the pack; its **live bytes** are a column kept with it: the sum of the lengths of its `packed` rows. **A member is live while it has a `packed` row,** referenced or not (an unreferenced member keeps its row for a day after its pack's upload, §5.1). The 50% test, the capture (§4.2) and the bounds below all use this one measure, so whatever a compaction captures was counted as live when the pack was queued.

**A `files` row's states** (astra's TF2), each change in one account-object transaction:

| State | Means | Satisfies an op? | Leaves when |
|---|---|---|---|
| `verifying` | registered; its chunks referenced by it | no (`missing`) | verified → `verified`; mismatch → retired at once (the one exception to `hold_until`); `hold_until` passes → retired |
| `verified` | the chunks rebuild `sha256`; no op refers to it yet | yes | an op refers to it → `live`; `hold_until` passes with `refs = 0` → retired |
| `live` | `refs > 0`: entries, versions or pins refer to it | yes | its last reference goes → retired |
| retired | the row is deleted, and each chunk loses its one reference, in the same transaction | — | — |

- **An op that refers to a row** adds to `refs` in the op's own transaction. **Retirement** is decided in a transaction that rechecks `refs = 0` and, for a row not yet `live`, that `hold_until` has passed, except a failed verification, which retires its own row at once (by `reg`, §4.1). The Durable Object runs one transaction at a time, so an op and a retirement can't both win.
- **A lost answer:** registering again returns the row as it is, with no second reference; verifying again goes on from the saved position. A client whose row expired is told `missing` and registers again, with fresh references. An expired row never stays behind pointing at released chunks, since its deletion and their release are one transaction.
- The same chunk listed twice in a manifest is referenced once by that row; a chunk in two manifests has one reference from each.

**Usage** (`used_bytes`, sync-server §3) is physical:
- each chunk, pack and blob holding counts once while something refers to it, never once per reference;
- a `files` row adds its manifest's bytes, in every state, so registering and verifying are charged from the start;
- chunks referenced only by a `verifying` row count too: a staged upload holds quota until it's used or retired;
- a pack counts whole while any member is live, so packing never claims a saving the pack doesn't make. Compaction is what gives the space back.

**Fitting sync-server §6.1** (one budget for sharing and sync): nothing changes in the claim or the caps.
- Uploads reserve physical bytes per PUT, chunk or pack, as a blob's PUT does, against `blob_cap` and the account's storage. A blob or chunk is also checked against `max_file_bytes`; a pack is checked against the 16 MiB pack cap, and each of its members against `max_file_bytes` (§4.2, daybreak2's LIMIT-TF-7). A chunk is at most 8 MiB, and only files over 8 MiB are chunked, so a chunk never exceeds a `max_file_bytes` its file fits in. Compaction's reservation is apart from these (§4.2). The whole file is checked against `max_file_bytes` at the manifest's commit.
- The commit takes no reservation of its own: it only adds references to holdings that are already counted.

### 4.4 Who may call the new endpoints (astra's TF4)

(sync-client) Every new endpoint inherits sync-server §2 and §5.4 unchanged, in this order, and nothing new is taken on the client's word:
- **At the Worker, before any object:** the per-IP pre-authentication limit (`SYNC_PREAUTH`), then the session cookie (a person's device) or the grant token's tag (an agent). State-changing requests (manifest `POST`, verify, pack `PUT`) must carry `Origin` equal to the site.
- **The binding:** a device's requests carry `x-sync-account` and `x-sync-generation`. If either isn't the account object's, the request is refused (403 `forbidden`, 409 `conflict`) before anything is reserved, read or answered (CORR-PR58-1).
- **The account's state:** `readonly` refuses manifest registration, verification and pack uploads with `readonly`, and still allows manifest reads, as every read is allowed then. `deleting` refuses everything but the purge.
- **After every await,** the transaction that acts checks again that the account is the same generation and `active` (a verification step, a pack's finalize), or, for a compaction's swap, the same generation and not `deleting`, since compaction only gives space back and runs on a `readonly` account too. A generation retired during a stream finalizes nothing.
- **Rates:** the per-account limits of sync-server §8 apply: a pack `PUT` counts as one blob upload (4 at once), a manifest registration and a verify call each count as a request, and each signed URL counts against 600 a minute.
- **Who may write:** in step 3, manifests and packs come from a person's device session only. An agent's grant writes data files as today (design/agent-endpoint.md), as single blobs.
- **Repairs** (`POST /repair/<sha256>`, `POST /repair/<sha256>/stage`, `PUT /repair/<reg>/piece/<i>`) are writes under every rule above: a person's device session only, never a grant; `Origin`; the account and generation headers; refused on a `readonly` or `deleting` account; the generation and `active` checked again in each transaction after an await (the check's checkpoints, the staging row's verification, the swap).
- **Who may read, as a device:** a person's session may read any manifest and any member of its own account, as it may read any of its blobs today.
- **Who may read, as an agent:** a grant never names a hash. It asks for a file by path. The account object checks the path against the grant's scope, with read access, in the index as it is now, and only then looks up that entry's `sha256` and its manifest. Each chunk URL is asked for by the path and the chunk's index in that manifest, so a grant can't reach a chunk or member outside a file it may read. The URLs are the grant's as today: single use, with a nonce redeemed by the files Worker, the same response headers, and each debiting the grant's daily budget by its bytes (sync-server §5.4).

Tests: the account or generation switched during an upload, a verification and a finalize; a grant asking for an unrelated file's manifest or chunk; a grant asking for a chunk index past the manifest's end; a pack index malformed at each bound (the prefix, the length, an offset, a duplicate, a gap, an overlap, past the end); a failure after the last member but before the whole-pack check, and after the whole-pack check but before the finalize.

## 5. The hard parts, named

*(Questions by board; answers by sync-client; astra and daybreak2 review.)*

### 5.1 Garbage collection of unreferenced chunks

- References run file op → manifest → chunks or pack members. A file deleted or replaced loses its references only once the new op is decided.
- Zero-reference objects go through the existing outbox, with a grace period for lost answers and late commits (sync-server §3, §9).
- Questions: how a chunk shared by two files, or two versions, is counted; how a pack's dead members are found; the bounded pages and the alarm's pace; the most extra storage compaction may use at once. Quota must not depend on GC finishing promptly (daybreak2, point 9).

**Answers (sync-client):**
- **A shared chunk** has one holding, with one reference per `files` row that lists it. Two versions of a 150 MiB file that differ in one chunk cost about 154 MiB, not 300.
- **A reference moves only in the decided op's transaction.** A write that replaces a chunked file keeps the old one as a server version, in the same transaction (sync-server §3). The old `files` row loses its reference only when that version is dropped.
- **A `files` row is retired** by the state machine in §4.3: a `live` row when its last reference goes; a `verifying` or `verified` row only once `hold_until` has passed with no reference, or a `verifying` row at once when its verification proves it wrong (§4.1) (so a manifest awaiting its op isn't released the moment it's registered). Retirement releases its chunks in the same transaction: at most 256 rows, so the transaction is bounded. A chunk at 0 goes to the outbox, as a blob does today. The alarm empties the outbox as now (bounded steps, sync-server §6.2's LIMIT-445-1), and retires expired rows a page of 16 at a time.
- **A pack's dead members** are found without a scan: a pack's `refs` counts its live members (those with a `packed` row, §4.3), and its live bytes are a column kept with it. A pack under 50% live is put on a small `compact` queue in the transaction that crosses the line. The alarm takes one pack at a time, at most one every 30 minutes, so at most 16 MiB is extra at a time (§4.2).
- **A delete in flight can't be revived (astra's TF2).** The first draft's `deleting` mark is replaced by a simpler rule, an amendment to sync-server §3's order ("deletes the R2 object, and only then the row"):
  - **Queued:** a holding at `refs = 0` with its key in the outbox still has its row. Anything that refers to it (below) takes it back: `refs` goes up and its outbox row goes, in the same transaction.
  - **Begun:** the alarm's step that begins a delete deletes the holding's row, in a transaction that checks again that `refs = 0` and the key is the holding's. Only the outbox row, keyed by the R2 key, remains. Then the R2 delete, then the outbox row, by that key.
  - So once a delete has begun, there is no holding for that hash. Every path that creates a reference looks the hash up in `holdings` (or `packed`, or `files`) in its own transaction, finds nothing, and answers `missing`: an op, a version kept by a write, a document's pin, a manifest's registration, and a pack member's `packed` row. No path can refer to a key being deleted.
  - **A new upload of the same bytes** gets a new random key (sync-server §1) and a new holding row. The old delete's completion removes only its own outbox row and R2 object, by the old key, and can never touch the new holding.
  - A crash between the steps leaves the outbox row, so the delete is retried; deleting an R2 key twice is harmless.
- **Grace:** an unreferenced holding goes after a day (sync-server §3), and a packed member with no reference a day after its pack's upload loses its `packed` row the same way. That already covers chunks whose manifest registration was lost. A client that comes back later is told `missing` and uploads them again.
- Tests (astra's TF2): a delete begun, then a reupload and its finalize, then the delete's completion; a delete begun during a manifest's registration and during an op; a crash at every registration, verification, reference and retirement step; the same chunk twice in one manifest, and in two manifests; a lost registration answer, then the same manifest again.
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
| Pack size, target / max | client builds, server checks | 8 / 16 MiB, prefix and index included; at most 4,096 members | 16 MiB | `limit`, before anything is reserved | no |
| Pack index encoded size | server | 512 KiB | 512 KiB | `limit`, from the prefix, before the index is read | no |
| Manifest verification | server | one call at a time per account; at most 8 chunks (64 MiB) a call; `sync.verify_bytes_per_day` 16 GiB per account, debited before each call's stream (§4.1) | CoCalc's; 16 GiB if CoCalc sends none | `rate`, with `retry_after` | yes (CoCalc) |
| Repair reports | server | 60 an hour per account, at most one per hash per device a day; a duplicate or over-rate report uses only its request and starts no check; one check per hash at a time, sharing the one-verification-at-a-time slot; checks metered by `sync.verify_bytes_per_day`; a healthy result suppresses reports about the same representation for 1 hour; a repair's staging row is held at most 1 day, its pieces reserved like any upload | 60 an hour | 429, with `retry_after` | no |
| Unused manifest hold | server | `hold_until` a day after registration or its renewal | renewable 1-day TTL; — | retired (§4.3) | no |
| Compaction reservation | server | one per account, at most 16 MiB, allowed above the storage cap; not usable by uploads | 16 MiB | waits its turn | no |
| Pack compaction | server | under 50% live; one at a time; at most one every 30 minutes (48 a day: 48 reads ≤ 768 MiB, 48 writes ≤ 408 MiB, 48 deletes) | 16 MiB extra at once, a failed compaction's object included | waits its turn | no |
| A compacted pack's delete | server | 10 minutes after the swap | — | — | no |
| Index entries | both | 100,000 per account, 10,000 per folder | same | `limit` | no |
| Device cache budget, computer | client | 25% of the estimated quota, at most 10 GiB (sync-client proposal) | clamped to $\max(0, q - f - (u - c))$ (§3.2) | removal | person |
| Device cache budget, phone | client | 25% of the estimated quota, at most 2 GiB (sync-client proposal) | clamped to $\max(0, q - f - (u - c))$ (§3.2) | removal | person |
| Cache high / low marks | client | 100% / 85% of budget | — | — | no |
| Free-space floor $f$ | client | 500 MiB on a computer, 200 MiB on a phone (sync-client proposal) | — | no install unless $u + R + r \le q - f$ (§3.2) | no |
| Storage estimate age | client | 60 s | 60 s | nothing admitted: background caching stops, an open is refused ("There isn't room…") | no |
| Removal pass | client | 100 files and 64 MiB a transaction (one larger file alone), within PINS.slice's 400 requests; at most every 10 minutes; not within 1 hour of an install for an open | 100 files, 64 MiB (200 MiB for one file) | the next transaction | no |
| Prefetch share of the read budget | client | stops at 80% used (§2.1) | 80% | prefetch pauses | no |
| Concurrent chunk uploads / downloads | client | 2 / 4 (as L2) | — | queued | no |
| Blob PUTs at once | server | 4 per account (sync-server §8) | 4 | 429 | no |
| Daily read budget | server | `sync.read_bytes_per_day` (CoCalc) | CoCalc's | `rate` | yes (CoCalc) |
| Account storage | server | `storage_bytes` (CoCalc) | CoCalc's | `storage_full` | yes (CoCalc) |

Every list, check and GC endpoint stays paged. The index's bounds don't depend on cached bytes.

## 6a. Costs, as operations (daybreak2, point 8)

(sync-client) In operations, not dollars, which change:
- **A cold open of a chunked file** of $n$ chunks: one manifest read (SQLite, no R2), $n$ signed URLs and $n$ R2 reads, $n \le 256$. For example, 150 MiB at about 4 MiB a chunk is about 38 of each.
- **Uploading it:** $\lceil n/1000 \rceil$ checks, $m$ PUTs for its $m$ missing chunks, one registration, $\lceil n/8 \rceil$ verify calls (together $n$ R2 reads of the whole file inside Cloudflare, no egress, nothing debited from the read budget), then the op.
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
| 6 | Packs and their compaction (§4.2), **only after a benchmark shows they're needed** (§4.2 states the measurement) | no | sync-client |
| — | Separate from the six: notebook outputs not saved by default, the "Keep outputs" switch (§1.4) | yes: screenshots first | @sagebrush-sync-docs |

Each PR carries its at-limit and one-over tests, and operation-count assertions (daybreak2, point 10).

## 8. Decisions and open questions

**Decided by William (Nov 8, about 1:05 PM PST):**
- **The cache defaults** in §6: "(a) Recommended: yes, ship these as first values and tune later". A phone is chosen in the Storage panel, with a default from the screen (§2.1).
- **Notebooks and boards stay on every device** in these steps: "(a) yes, but with the caveat that we enforce 'do not store outputs by default'". And: "(a) outputs aren't saved into the synced notebook by default. They show while you work, and each notebook has a 'Keep outputs' switch" (§1.4).
- **"Keep on this device" on a folder covers files added later:** "(a) yes, like OneDrive. This includes files saved on this device into the folder" (§1.2, §3.1).

**Still open:**
- Should the Storage panel show the cloud's breakdown per folder? (Not in these steps.)
- (sync-client, for daybreak2) The proposed cache budgets and floor (§6).
- Answered by the reviews, and now in the text: the client's whole-file hash is no longer taken on its word: the server verifies each manifest before an op can use it (§4.1, astra's TF1). The `deleting` mark is replaced by deleting the holding's row when its delete begins (§5.1, TF2). The pack's streaming check stays, with its bounds and nothing visible before the finalize (§4.2, TF4). The compaction pace is one every 30 minutes (§4.2, daybreak2's LIMIT-TF-5).
