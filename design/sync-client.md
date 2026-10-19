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
  - **Notebooks and boards are listed, but their content is slice 2.** Until then, opening one that this device doesn't have says "This notebook's content is synced in the next step: open it on the device that made it".
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

## 4. Who builds what, in order, and the size of each

| # | Step | Who | Size |
|---|---|---|---|
| 0 | Before: capabilities 1a and 1b merged (fileBytes, folder ids, provenance) | board, in review | — |
| 1 | `sync-reduce.ts` and its JSON vectors (§7.2's rules, rebuild, `name (2)`, conflict copies) | board | 1 day |
| 2 | The ops' identity fields (`ref`, `fid`, `sha256`, `size`, `base`) recorded with each op; the outgoing queue | board | 0.5 day |
| 3 | `sync-client.ts`: the socket, hello/welcome/index/pull_index, ops and acks, refusals and rebuild, blobs check/PUT/GET, reconnects; tested against Miniflare (web/sync/test-entry.ts, as test-sync.mjs runs it) | board | 2 days |
| 4 | Applying what comes down to the workspace: remote entries, background fetches, `remote` marks | board | 1 day |
| 5 | The switch, enable's refusals, the foot status, row icons, "Delete my synced data" | board | 1 day |
| 6 | The two-browser test: two Chrome profiles, one Miniflare, the site; then the same against dev once lite4b's limits answer carries `sync` | board, with auth | 1 day |
| — | The session and allowlist (done: the cookie, SYNC_ACCOUNTS plus `sync.enabled`), enable's refusal wording (in progress), lite4b's `sync` limits block (a cocalc-ai PR; lite4 deploys it), the dev deploy, the server importing `sync-reduce.ts` (later, for compaction) | auth | — |

That is about 6½ working days for board. Each step is its own branch, reviewed and CI'd as usual. Steps 1 and 2 can start as soon as 1b is in review. Step 6 on dev waits on lite4b's limits; until then everything is tested against Miniflare.

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
2. **The switch's visibility:**
   - hidden when the server says the account isn't on the allowlist (403 "sync isn't enabled for this account");
   - shown, with the server's refusal text, when the account is allowed but its plan has sync off, or CoCalc can't be reached.
   - No pricing or upsell wording: that framing is William's, and stays out of the repository.
3. **Process:** astra and daybreak2 review this plan. Building starts after both CLEAR, and after capabilities 1a and 1b, each step its own PR.
