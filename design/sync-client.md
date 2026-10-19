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
- for a write, `base` (the `sha256` it replaced).

This is the "client's log plus identity" of sync-server §3. Hashing new bytes happens before their transaction, as the 1a migration already does.

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

**The reducer:** `web/workspace/sync-reduce.ts`, a pure `reduce(entries, op) → entries'` with no DOM or IndexedDB imports, so the Worker can bundle it. It implements §7.2's rules:
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

**Storage** (one more schema-only upgrade: no data moved):
- `outbox`, keyed by `[ns, dseq]`;
- `syncIndex`, the confirmed index, per `ns`;
- `adoptJournal`, the first sync's captured tree (C3);
- `pins`, by `sha256`: the bytes committed here and not yet decided (C2), with their total.

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
- **A `dseq` is never skipped locally.** A record whose bytes this device no longer has is still sent. The server decides it (`missing`), and the current state then goes as a new write (C2).

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

**Tests:**
- a crash after a local change, before the scan;
- a crash mid-scan;
- two tabs of one device (only one connects; the lock handed over on close);
- a lost ack, then a reload (the same `dseq` resent with the same payload; the server's decision adopted);
- account switch, and generation change after a delete;
- outbox full: more edits, crash, reload, drain, and every local edit represented exactly once;
- each scan page within its count and byte bounds.

### C2. Committed bytes are pinned until decided (CORR-8E7-2, LIMIT-SC1-R2)

**Pinned at the local commit, not at the scan.**
- While sync is on, every local change that commits new bytes adds their `sha256` to `pins`, in the same transaction, with the file's `fid`.
- A later write that replaces bytes still in `pins` keeps them as a version, in its own transaction. It does so even where it otherwise wouldn't keep one (empty bytes, `keepEmpty: false`).
- The version is then exempt from pruning, from `dropVersions`, and from emptying Trash (which removes the entry; the bytes stay until decided).
- The scan hands the pin to the outbox record that names the hash.
- A decision releases it: accepted once the `seq` is confirmed (C3), even when the ack came before the echo; refused at once. After that, ordinary retention applies.

**An upload reads exactly the bytes its record names:** the current file if its hash matches, else the pinned version. Current bytes are never sent under an older hash.

**A cap on pinned bytes, without ever refusing a local save** (LIMIT-SC1-R2). A pin on bytes that are still the file's current ones costs nothing extra; only pinned bytes kept apart, as versions, count. That total is kept in the same transactions, and capped (1 GiB, or less when the browser's quota is smaller: half the estimated free space at the time). A change that would pass the cap:
1. **collapses unscanned intermediate writes** to the same file: they never become records. The scan sends the latest write, with `base` the last hash the server knows. Their pins go.
2. then, if still over, **doesn't pin** the bytes it replaces. The local save always succeeds. A record already made for those bytes is still sent (C1). The server refuses it `missing`, the scan sends the file's current state as a new write, and the device and the server converge on the current bytes.
- The Sync panel says "some intermediate versions weren't uploaded", and lists their files.

**Tests:**
- offline A then B writes to one file, then reconnect (A and B both uploaded, in order);
- the same with the outbox full, and with the sender closed;
- pruning, `dropVersions` and emptying Trash while A is pinned;
- an ack accepted before the echo (still pinned until the echo);
- overwrites with a tiny cap: saves never fail, the server converges on the current bytes;
- a crash mid-way: no pin leaked, every pin owned by a record or a pending change.

### C3. The confirmed index and the optimistic view (CORR-8E7-3)

**The confirmed index (`syncIndex`).** It is the reducer applied to the server's log in `seq` order, own ops included. Its cursor `sync:<ns>:cursor` is written in the same transaction as each page applied to it.

**What the person sees** is the workspace's own index. It equals the confirmed index plus every local op not yet confirmed, reduced on top in order:
- the outbox's records, undecided or awaiting their echo, in `dseq` order;
- then the local ops not yet scanned, in their `seq` order (astra: an unscanned B is part of the view, so a remote page or a rebuild never overwrites it). After each confirmed page, the affected identities' views are recomputed, and the difference is applied to the workspace's entries. That happens in the same transaction as the page and the cursor: entries, `syncIndex` and meta are all in the workspace's database. A crash leaves all of it or none.

**This device's own echo,** an `index` op with this `device` and a `dseq` in the outbox, is applied to the confirmed index like any other op.
- The outbox record is marked confirmed and removed. Nothing is applied to the view twice, since the view already had it.
- The order doesn't matter: an ack before the echo leaves the record "accepted, awaiting echo"; an echo before the ack confirms it at once.

**First sync: the adoption journal** (CORR-8E7-3, LIMIT-SC1-R1). A device's existing tree is captured into `adoptJournal`, then sent as `adopt` records through the bounded outbox:
1. **Start**, in one transaction: the boundary `W0`, the latest local op seq, is recorded.
2. **Capture by path,** in pages of 500, each page one transaction with its progress key: each entry's identity, metadata and hash, its bytes pinned (C2).
3. **Close the capture.** A path walk alone isn't a snapshot: a file renamed from behind the cursor to ahead of it, or the other way, is missed or caught twice. So, after the walk, every identity that an op with seq above `W0` touched is read again, in pages. If it exists, its current state replaces or adds its journal record; if it doesn't, its record goes. Ops are read up to `W1`, the latest seq when this step began. Repeat until a pass finds no op past the last `W1`.
   - The journal is then exactly the tree as of `W1`.
   - The scan watermark is set to `W1`: those ops' effects are already in the journal, so they aren't sent twice.
4. **Connect.** The account socket is opened only now. So the `index` the server sends right after `welcome` (it doesn't wait to be asked) is applied to the confirmed index as usual. The journal is not yet sent, so nothing collides with it locally.
5. **Drain:** the journal goes into the outbox a page at a time, as the outbox has room. It is bounded by the outbox's caps, never the tree's size, so the 100,000-entry maximum fills and drains repeatedly rather than waiting at the cap.
   - Then ops after `W1` follow, through the scan.
   - In the server's order, the cloud's entries come first, so this device's colliding adopts become `name (2)`.

A crash anywhere resumes from the journal's progress keys. A capture interrupted mid-walk resumes the walk, and step 3 covers whatever changed meanwhile.

**An op that can't be applied** to the view (it fails a local check, such as a path rule or a limit) is still in the confirmed index, and the cursor passes it. The view leaves it out and lists it in the Sync panel. Nothing redefines the server's log.

**Tests:**
- a local create, then its echo (no `x (2)`);
- an ack lost, then the echo;
- the echo before the ack;
- a crash between a page and its cursor (impossible by construction; tested as a crash mid-page);
- a reload mid-adoption;
- a file renamed from behind the capture's cursor to ahead of it, and the other way, and deleted, during the capture (each captured exactly once, as of `W1`);
- the `index` after `welcome` arriving while the journal drains;
- 100,000 entries through repeated outbox fill and drain, with a crash and reload in each phase;
- a remote create at the same path before this device's queued create (the confirmed order gives the remote one `/x` and this one `/x (2)`, on both devices).

### C4. The reducer: identity, order, copies (CORR-8E7-4)

- **Targets are identities, never paths:** a data file's or folder's `fid`, a document's `ref`. A rename, write, remove or restore applies to its identity wherever it is now. Path reuse can't misdirect it.
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
  - creates colliding three ways.

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
  - adoption: captured 500 entries per transaction, by path; drained from the journal into the outbox as it has room (C3);
  - rebuild: the server's log at 1,000 ops or 1 MiB per page, reduced into `syncIndex` page by page, its cursor durable.
- Neither ever holds the whole tree in memory.
- **Tests:** 100,000 entries, with the pages' counts and bytes bounded, and a crash and reload mid-way.

## 4. Who builds what, in order, and the size of each

| # | Step | Who | Size |
|---|---|---|---|
| 0 | Before: capabilities 1a and 1b merged (fileBytes, folder ids, provenance) | board, in review | — |
| 1 | `sync-reduce.ts` and its JSON vectors (C4: identity, order, derived conflict copies, two-device replay) | board | 1.5 days |
| 2 | The ops' identity fields (`ref`, `fid`, `sha256`, `size`, `base`) recorded with each op; version 3's stores; the outbox, the scan watermark and pins (C1, C2) | board | 1.5 days |
| 3 | `sync-client.ts`: the sender lock, the socket, hello/welcome/index/pull_index, ops and acks, lost acks, refusals and rebuild, pace and backoff (L3), blobs check/PUT with the reservation (L2, L4); tested against Miniflare (web/sync/test-entry.ts, as test-sync.mjs runs it) | board | 2.5 days |
| 4 | The confirmed index and the view (C3), the first sync's adoption, the durable fetch queue against the read budget (L1), downloads by compare-and-swap (C5) | board | 2 days |
| 5 | The switch, enable's refusals, the foot status, row icons, "Delete my synced data" | board | 1 day |
| 6 | The two-browser test: two Chrome profiles, one Miniflare, the site; then the same against dev once lite4b's limits answer carries `sync` | board, with auth | 1 day |
| — | The session and allowlist (done: the cookie, SYNC_ACCOUNTS plus `sync.enabled`), enable's refusal wording (in progress), lite4b's `sync` limits block (a cocalc-ai PR; lite4 deploys it), the dev deploy, the server importing `sync-reduce.ts` (later, for compaction) | auth | — |

That is about 9½ working days for board, three more than the first draft, for the contracts in §3a. Each step is its own branch, reviewed and CI'd as usual. Steps 1 and 2 can start as soon as 1b is in review. Step 6 on dev waits on lite4b's limits; until then everything is tested against Miniflare.

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
