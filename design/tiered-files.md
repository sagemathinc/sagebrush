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

- "Remove from this device" is shown greyed, with its reason, when it can't be done: "Has changes not yet in the cloud", "Is being downloaded", "Is a conflict copy". It never removes bytes the cloud doesn't have (§3.4).
- On a folder, "Keep on this device" keeps everything in it, including what's added later.

The Storage panel, with the new block on top of today's:

```
┌ Storage ─────────────────────────────────────────┐
│ On this device                                    │
│   ▓▓▓▓▓▓▓▓▓░░░░░░░░░░  410 MB of 1 GB             │
│   kept: 120 MB · other cached: 290 MB             │
│   [ Free up space ]   Keep up to: [ 1 GB ▾ ]      │
│                                                   │
│ In the cloud (your account)                       │
│   1.2 GB of 10 GB, for sharing and sync together  │
│   files 1.1 GB · notebooks and boards 90 MB       │
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
- **Never:** "safe", "secure", "backed up" as a promise, "trust", or "unlimited". Say what is true: "fully in the cloud" means the server has accepted every byte (§3.4's test), and nothing more.
- **Refusals name their reason** (daybreak2, point 7): "Can't remove lattice-points.sage from this device: it has changes not yet in the cloud."
- **Numbers are this device's or the account's,** and labelled so.

## 2. Step 1: "in the cloud" files

*Outline by board, from the sync designs; sync-client corrects it against the as-built code and writes the protocol details.*

**What already exists:** a synced data file arriving from another device is listed at once, marked `remote` until its bytes are fetched (sync-client §3, "What comes down"; sync-view.ts). The fetch queue is durable, checked by hash and installed by compare-and-swap (C5), and debits the daily read budget (L1). Today every device fetches every file in the background. "In the cloud" mostly means **not** fetching in the background, and fetching on open instead.

**Client changes:**
- A per-device rule decides what is fetched in the background (the prefetch rule, §2.1). Everything else stays `remote` (shown "In the cloud") until opened.
- Opening a `remote` file fetches it first, through the existing queue, ahead of background work.
- *(sync-client: the open path through the confirmed index; how the editor waits; a fetch's priority in L1's queue; C5 on an open fetch.)*

**Server changes:** none for step 1 alone. *(sync-client: confirm.)*

### 2.1 Prefetch rule

*(sync-client and board to settle; first proposal:)*
- On a computer (default cache budget large): fetch everything, as today, until the budget's high mark.
- On a phone: fetch only what's kept, plus files under a size (proposal 1 MiB) in folders opened recently, until the budget's high mark.
- Never prefetch past the daily read budget (L1): background fetches stop before the budget's last 20%, which is left for opens.

### 2.2 Offline

- A file "In the cloud" can't open offline; the message in §1.2 says so and offers "Keep on this device" for next time.
- Everything else works offline exactly as today.
- *(sync-client: a fetch that fails mid-way; a fetch that resumes after reconnect; Range resume of a large file.)*

## 3. Step 2: keeping files, and removing them from a device

### 3.1 States, as stored

*(sync-client: how "kept", "cached" and "evicted" are recorded per entry; the relation to `remote`; a folder's keep rule.)* daybreak2's requirement: cloud-only, downloading, local, kept, waiting to go up, and error must be distinct, and "local" only when every byte (or every chunk) is present and hash-checked.

### 3.2 The cache budget

- **One budget per device:** "Keep up to", with a **high mark** (start removing) and a **low mark** (stop), and a **free-space floor** always left for the browser (hysteresis, so removal doesn't loop: daybreak2, point 6).
- Kept files count against the budget, but are never removed for it. If kept files alone pass the budget, nothing more is cached, and the panel says "Kept files use more than this device's limit".
- **What is removed first:** not kept, fully in the cloud, oldest opened first.
- Defaults are in the limits table (§6).

### 3.3 What "removing from this device" does

*(sync-client: deleting fileBytes for an entry, setting it back to `remote`, in one transaction under the lock; versions on the device; C2's pins.)*

### 3.4 Never removing the only copy (the hardest invariant)

A file's bytes may be removed from a device only if **all** of these hold, checked in the same transaction that removes them:
1. the entry's current `sha256` is in the confirmed index (the server accepted the op that made it current);
2. no outbox record, pending summary or pin (C2) names this identity;
3. it isn't a conflict copy waiting for the person;
4. no download or upload of it is in flight.

If any fails, the removal is refused with its reason (§1.3), and the cache budget simply goes over until it can proceed. A local save is never refused for the cache's sake: the device's copy stays authoritative, and the panel says the cache is blocked (daybreak2, point 7).

*(sync-client: the exact checks against the as-built stores; the test schedule; astra to review.)*

## 4. Step 3: large files in chunks, and small files in packs

*(sync-client owns this section. board's outline of what it must answer:)*

### 4.1 Chunks

- Content-defined chunking: the algorithm and its parameters are **named and versioned in the manifest**, and a client's output is deterministic (daybreak2, point 3). Proposal to evaluate: minimum / target / maximum 1 / 4 / 8 MiB.
- A file's identity stays its whole-file SHA-256 (the op's `sha256`). Its **manifest** lists its chunks (hash, size), in order, and is itself a blob.
- **Upload and resume:** `blobs/check` for the missing chunks, idempotent PUTs, then the manifest, then the op. The op is accepted only when every chunk is held. No rechunking on the server.
- **Read:** the manifest, then each chunk (or a Range of it).
- *(sync-client: the manifest's format and its caps; how the server checks a manifest; how C2's pins cover chunks.)*

### 4.2 Packs

- Only small immutable blobs (proposal: ≤ 64 KiB) go into packs (proposal: target 8 MiB, hard maximum 16 MiB). A pack is immutable, with a bounded index of offset and length, read by Range (daybreak2, point 4).
- A pack is never rewritten when one member changes. A partly dead pack is compacted by GC, one pack per step, when its live share falls below a threshold.
- Small files may still go up as single blobs, under pressure or failure.
- *(sync-client: the pack format; who builds packs, client or server; accounting.)*

### 4.3 Accounting

- **Charged once, physically:** unique chunk and pack bytes per account, not logical references. Missing bytes are reserved before upload; the manifest's commit turns reservations into references in one step; retries don't charge twice. A packed member can't claim a saving the pack doesn't make (daybreak2, point 5).
- *(sync-client: the tables; how this fits sync-server §6.1's claim and caps.)*

## 5. The hard parts, named

*(Questions by board; answers by sync-client; astra and daybreak2 review.)*

### 5.1 Garbage collection of unreferenced chunks

- References run file op → manifest → chunks or pack members. A file deleted or replaced loses its references only once the new op is decided.
- Zero-reference objects go through the existing outbox, with a grace period for lost answers and late commits (sync-server §3, §9).
- Questions: how a chunk shared by two files, or two versions, is counted; how a pack's dead members are found; the bounded pages and the alarm's pace; the most extra storage compaction may use at once. Quota must not depend on GC finishing promptly (daybreak2, point 9).

### 5.2 Quota accounting

- Questions: physical vs logical bytes in `used_bytes`; a manifest whose chunks are partly held; how the breakdown (sync-server §6.1) shows them; how a downgrade interacts with packed bytes.

### 5.3 Removing a file that has unsynced edits

- The rule is §3.4: it isn't removed. Open questions: a device whose kept and unsynced files alone exceed its storage; how long a blocked cache may stay blocked before the panel says more; a conflict copy that the person never resolves.

## 6. Limits (one table: daybreak2, point 10)

| Limit | Owner | Default (first value) | Hard ceiling | Over it | Remotely set? |
|---|---|---|---|---|---|
| Single blob PUT | server | 95 MiB (today) | 95 MiB | 413 | no |
| Workspace file size | client | 200 MiB (today) | 200 MiB until decided otherwise | refused at save | no |
| Chunk size, min / target / max | client (in the manifest) | 1 / 4 / 8 MiB (to evaluate) | 8 MiB | — | no |
| Chunks per manifest | server | *(sync-client)* | 200 MiB / 1 MiB = 200 | `limit` | no |
| Manifest encoded size | server | *(sync-client)* | *(sync-client)* | `limit` | no |
| Packed member size | client | 64 KiB | 64 KiB | sent unpacked | no |
| Pack size, target / max | client or server | 8 / 16 MiB | 16 MiB | `limit` | no |
| Index entries | both | 100,000 per account, 10,000 per folder | same | `limit` | no |
| Device cache budget, computer | client | *(to set)* | browser quota minus floor | removal | person |
| Device cache budget, phone | client | *(to set, smaller)* | browser quota minus floor | removal | person |
| Cache high / low marks | client | 100% / 85% of budget | — | — | no |
| Free-space floor | client | *(to set)* | — | caching stops | no |
| Concurrent chunk uploads / downloads | client | 2 / 4 (as L2) | — | queued | no |
| Daily read budget | server | `sync.read_bytes_per_day` (CoCalc) | CoCalc's | `rate` | yes (CoCalc) |
| Account storage | server | `storage_bytes` (CoCalc) | CoCalc's | `storage_full` | yes (CoCalc) |

Every list, check and GC endpoint stays paged. The index's bounds don't depend on cached bytes.

## 6a. Costs, as operations (daybreak2, point 8)

*(sync-client to fill, with worst cases:)*
- cold open of a chunked file: one manifest read + N chunk reads or ranges;
- upload: one missing-check + M PUTs + the manifest + the op;
- a small file in a pack: amortized PUTs; one Range read;
- worst cases: many tiny files; a random edit in a large file (how many chunks change); repeated data.
- The read budget: debit the physical bytes served (proposed), and a Range retry must not escape it.

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

- The cache budget defaults (computer, phone), and whether a phone is detected or chosen.
- Does "Keep on this device" on a folder include files added to it later? (Proposed: yes.)
- Notebooks and boards: their content is patches (sync-server §4), not blobs. Do they stay always local in these steps? (Proposed: yes; they're small.)
- Should the Storage panel show the cloud's breakdown per folder? (Not in these steps.)
