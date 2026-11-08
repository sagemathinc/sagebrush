# fs-sync: syncing a local folder with a Sagebrush folder, once, when asked

*Status: design, docs only, nothing built. Authors: @sagebrush-remote-compute (§1, the CLI) and @sagebrush-sync-client (§2–§6). Reviews: astra (correctness), daybreak2 (limits), grader (tests), board (COPY). Commissioned by William, Nov 8 2026 (~1:24 PM PST): "you run `sagebrush fs-sync ...` ... scan the local files and the state in sagebrush for a folder, compare them, make a plan, get confirmation, etc. It's basically what reflect-sync does periodically."*

*Built on design/agent-endpoint.md (grants, pairing, the verbs and their limits) and design/sync-server.md (the index, ops with a base hash, blobs by SHA-256). It needs the agent endpoint to be built and on; until then this note is a plan only. Out of scope: anything automatic or periodic (a watcher, a daemon), and the lazy "in the cloud" files of design/tiered-files.md.*

## In plain words

- **You run it; it never runs by itself.** `sagebrush fs-sync ~/thesis /Thesis` compares a folder on this computer with a folder in your workspace, shows what it would do, and does it only when you say yes.
- **It remembers the last sync.** So it can tell a file you changed here from one changed in the workspace, and a file you deleted from one that was never there.
- **It never overwrites a change.** When both sides changed the same file, you get both: the workspace's copy keeps the name, and yours is kept beside it as a conflict copy, on both sides.
- **It deletes only what it knows you deleted.** The first sync of a folder pair never deletes anything. Later, a file is deleted on one side only if it was there at the last sync and you deleted it on the other. Deleted workspace files go to the workspace's Trash; deleted local files go to a holding folder you can restore from.
- **Stopping halfway is safe.** Run it again and it picks up from what is actually on both sides.

---

## 1. The command (remote-compute)

*Proposal, to be rewritten by @sagebrush-remote-compute.*

```
sagebrush fs-sync LOCAL_DIR WORKSPACE_PATH [--yes] [--dry-run] [--up-only | --down-only] [--delete-many]
```

- **Default:** scan, compare, print the plan, and ask "Apply? [y/N]". Nothing changes before the answer.
- `--dry-run`: print the plan and exit, never asking. Exit 0 if the plan is empty, 1 if not (so a script can tell).
- `--yes`: apply without asking, except a plan that deletes many files (§2.4) still needs `--delete-many`.
- `--up-only`: only local → workspace actions; `--down-only`: only workspace → local. Each still detects conflicts and refuses to overwrite.
- **Signing in:** the first run pairs, as the agent endpoint's pairing (design/agent-endpoint.md §2): the CLI prints a URL and a code, the person approves a grant scoped to `WORKSPACE_PATH` with write access, and the token is kept on this computer (§3.1).
- Runs through `uvx sagebrush fs-sync …`, like every `sagebrush` command.

## 2. The plan: a three-way comparison (sync-client)

### 2.1 The three states

For each relative path $p$ under the folder pair, fs-sync knows up to three hashes:
- $L(p)$: the local file's SHA-256 now (or absent);
- $R(p)$: the workspace entry's `sha256` now (or absent), from the agent endpoint's `list`;
- $B(p)$: its SHA-256 at the end of the last successful sync of this pair (or absent): **the base**.

The base is a file on this computer, one per folder pair (§2.5). Without a base (the first sync), $B(p)$ is absent for every $p$.

### 2.2 The rules

| Here $L$ vs $B$ | There $R$ vs $B$ | Action |
|---|---|---|
| $L = R$ (any $B$) | | nothing; the base takes $L$ |
| changed or new | unchanged ($R = B$) | **upload**: write $p$ with base $R$ |
| unchanged ($L = B$) | changed or new | **download**: replace the local file with $R$ |
| changed | changed, $L \ne R$ | **conflict** (§2.3) |
| deleted ($B$ present, $L$ absent) | unchanged | **delete there**: `remove` $p$ (to the workspace's Trash) |
| unchanged | deleted ($B$ present, $R$ absent) | **delete here**: move the local file to the holding folder (§2.4) |
| deleted | changed | **download**: an edit beats a delete, as the reducer's rule (design/sync-server.md §7.2) |
| changed | deleted | **upload**: the same rule, the other way |
| deleted | deleted | nothing; the base forgets $p$ |
| new (no $B$), $R$ absent | | **upload** |
| | new (no $B$), $L$ absent | **download** |

- **No base, no deletes:** with $B$ absent, "deleted" can't be told from "never there", so the first sync only uploads, downloads and reports conflicts.
- **Comparing by hash, not time:** $L$ is recomputed only when a file's size, `mtime_ns` or inode differ from what the base recorded for it, so a second run of a large, unchanged folder reads no file contents.
- **Folders:** made on the side that lacks them. A folder is removed only when the plan removes every file in it and it was in the base, and it is then empty.
- `--up-only` drops the download and delete-here rows; `--down-only` drops the upload and delete-there rows. Conflicts are still detected and still never overwrite.

### 2.3 Conflicts: keep both, never overwrite

When both sides changed $p$ differently, the result matches the reducer's convention for two devices' writes (design/sync-server.md §7.2), on both sides:
1. the local file is renamed to `name (conflict, <computer>).ext` (the computer's name, as `sagebrush remote login --name`, or the hostname), in the same folder;
2. that copy is uploaded as a new file of that name, so the workspace has it too;
3. the workspace's version is downloaded to $p$.

So the workspace's copy keeps the name, the local change survives under the conflict name on both sides, and both sides end the same. Nothing is lost at any step: step 1 is a rename, and step 3 writes a file whose name is now free. A conflict name already taken gets ` 2`, ` 3`, … as the reducer does.

### 2.4 Deletions

- **There:** `remove`, which the agent endpoint makes a move to the workspace's Trash, restorable by the person (design/agent-endpoint.md §1).
- **Here:** never `unlink`. The file is moved to `<data dir>/sagebrush/fs-sync/trash/<run id>/<relative path>` on the same filesystem when possible (a rename), else copied there and then removed. The holding folder keeps a run's files for 30 days. `sagebrush fs-sync --restore <run id>` puts them back.
- **Many deletions need a second word:** a plan that deletes more than 50 files, or more than 25% of the files in the base, on either side, is refused under `--yes` unless `--delete-many` is given too, and asks twice without `--yes`. It is the usual sign of a wrong folder pair.

### 2.5 The base, and where it lives

- **One file per folder pair,** in the CLI's data directory (`~/.local/share/sagebrush/fs-sync/` on Linux, the platform's equivalent elsewhere), named by the SHA-256 of `(account hash, grant id, absolute LOCAL_DIR, WORKSPACE_PATH)`. Never inside `LOCAL_DIR`, so it can't itself be synced, committed to git or deleted with the folder's contents.
- **Contents:** for each path, `{sha256, size, mtime_ns, inode, fid}`, where `fid` is the workspace entry's identity, and the workspace path and account it belongs to.
- **It advances per action, not per run:** each action that succeeds updates its path in the base, written atomically (a temporary file, `fsync`, rename). So an interrupted run leaves a base that is true for what was done and old for the rest, which the next run's plan handles by the same rules (§4).
- **A base for another account or folder** is never used: the account hash and paths are in its name and checked inside it.

## 3. The protocol: what it calls, and as whom (sync-client)

### 3.1 As whom: an agent grant, not a device session

fs-sync acts with an **agent grant** of the agent endpoint (design/agent-endpoint.md), scoped to `WORKSPACE_PATH` with write access, made by pairing:
- **It exists already, in the design:** pairing is a device-code flow approved by the signed-in person on sagebrush.space (§2 there), the token is scoped, expires (30 days by default, 90 at most), and is revocable from the Agents panel.
- **It limits the damage of a mistake** to the folder the person chose. A device session can change the whole workspace, and nothing in a CLI needs that.
- **Every change is credited** to `agent:fs-sync on <computer>` in the workspace's history, so the person can see and undo what a sync did.
- **Not the remote-compute key:** `sagebrush remote login` enrolls this computer for the remote relay only. Teaching the sync service to accept it would be a new kind of credential for the account object; a grant needs none.

The token is kept in the CLI's config directory, in a file readable only by the person (mode 0600), one per account. It is never printed or logged; `sagebrush fs-sync --forget` deletes it, and the person can revoke it on the site at any time. A revoked or expired token answers 401, and the next run pairs again.

### 3.2 What it calls

All through the agent endpoint's verbs (design/agent-endpoint.md §4), nothing new on the server:
- **The remote state:** `list(WORKSPACE_PATH, recursive)`, paged (1,000 entries a page, at most 10,000 a call), giving each entry's path, kind, `fid`, `sha256` and `size`.
- **Download:** `read`, which for a data file answers a signed URL (single use for a grant), then a GET of the bytes, checked against the SHA-256 before anything is written.
- **Upload:** `write(path, content, {base})`, with `base` the `sha256` the plan saw in the workspace (absent for a new file). It is a compare-and-swap: if the entry moved meanwhile, it answers 409 `conflict` and changes nothing (§4.2).
- **Create, folders, delete, rename:** `create`, `mkdir`, `remove`, `rename`, each an op with the grant's credit.

Only data files are synced. Notebooks, boards and chats are documents (patch logs, design/sync-server.md §4), not files; the plan lists them as skipped, both ways, in this first version. Syncing a notebook as an `.ipynb` file is a later question (§7).

### 3.3 Limits it lives within

fs-sync adds no limit of its own on the server; it is bounded by the grant's and the account's (design/agent-endpoint.md §7, design/sync-server.md §8):
- **Per grant:** 60 requests a minute and 1,000 an hour; 200 MB a day read (authorized at URL issue); 100 MB a day written; each write at most 32 MB inline, larger as a blob up to `max_file_bytes`.
- **Per file:** at most 95 MiB (the single-PUT limit) until a grant may upload chunked files. design/tiered-files.md §4 lifts it to 200 MiB for a person's device sessions only, so larger files are skipped and listed, not split.
- **The index:** 100,000 entries per account and 10,000 per folder.

**The plan states its cost before it runs:** its requests, bytes up and bytes down, against what the grant has left today. If it doesn't fit, the plan says how much fits now and that a rerun tomorrow continues; under `--yes` it applies what fits and exits with a distinct code (§1). A 429 mid-run stops the run cleanly (§4.1) with the `retry_after`.

## 4. Running the plan safely (sync-client)

### 4.1 Every action checks before it acts

The plan is a list of actions, each with the state it was planned from: the local file's `(size, mtime_ns, inode, sha256)` and the workspace entry's `sha256`. Applying an action first checks that state again:
- **Upload:** the local file is re-hashed as it is read; if it isn't the planned hash, the action is skipped as "changed here during the sync". The write's `base` is the planned remote hash, so a workspace change meanwhile is refused by the server (409).
- **Download:** the bytes go to a temporary file in the same folder, are checked against the hash, and then replace the target by rename, only if the target still has its planned `(size, mtime_ns, inode)`, re-hashed if any differ. A local edit meanwhile skips the action.
- **Delete here / there:** the same checks, and `remove` names the planned `sha256`.

A skipped action leaves both sides and its base entry as they were. The run finishes the other actions, reports the skipped ones, and exits with a code that says "run again" (§1). The next run plans from what is there then.

### 4.2 A change in the browser during a sync

The person may edit a file in the browser while fs-sync runs. That edit is an op in the workspace's log; fs-sync's upload of the same file then fails its compare-and-swap (409 `conflict`) and changes nothing. The action is skipped, the run says the file changed in the workspace during the sync, and the next run sees it as "changed there" (or as a conflict, if it changed here too). No interleaving overwrites either change.

### 4.3 Interrupted runs

A crash, Ctrl-C or a lost connection at any point leaves:
- each finished action recorded in the base (§2.5), and each unfinished one not;
- at most one temporary download file per action, named `.<name>.sagebrush-tmp-<run id>`, which the next run deletes first;
- a run journal (`<data dir>/sagebrush/fs-sync/runs/<run id>.json`, appended and flushed per action) for the report, never needed for correctness.

The next run plans afresh. A finished action is now "equal" or already in the base; an unfinished one is planned again. There is no resume of an old plan, so a plan is never applied to a state it wasn't made from. Only one run per folder pair at a time: a lock file next to the base (`flock`), refused with "another fs-sync of this folder is running".

### 4.4 Names, links and filesystems

- **Ignored, both ways, and never deleted:** `.git/`, `node_modules/`, `__pycache__/`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*.swp`, `*~`, `~$*`, `.sagebrush-tmp-*`, and whatever `LOCAL_DIR/.sagebrushignore` lists, in `.gitignore` syntax (its patterns, `!` negations and `/` anchoring). The ignore file itself is synced like any file, so both sides agree. An ignored path is neither uploaded, downloaded nor deleted.
- **Symlinks:** never followed and never synced; listed as skipped. So a link can't make fs-sync read or write outside `LOCAL_DIR`. Other special files (sockets, devices, FIFOs) are skipped too.
- **Permissions:** not synced. Downloads are made with the person's default mode (umask); an existing file keeps its mode when replaced.
- **Names the workspace refuses** (its `normPath` rules: length, characters, reserved names) are skipped and listed, never renamed silently.
- **Unicode:** names are compared in NFC, as the workspace stores them, so macOS's NFD names match.
- **Case-insensitive filesystems** (macOS and Windows by default): fs-sync detects it once per run (it creates and stats a probe name in `LOCAL_DIR`). Two workspace names that differ only in case can't both exist here: both are listed as a conflict and neither is downloaded. A local rename that only changes case is seen as a delete and a create.

### 4.5 Plan bounds

- **The scan:** at most 100,000 local files (the account's index maximum). Over it, fs-sync stops before planning and says so.
- **The plan:** at most 100,000 actions. Shown summarized (counts and bytes per kind, and the first 20 of each), with `--dry-run --verbose` for all of it.
- **Memory:** the base and the two listings are held as maps of path to a few fields, about 200 bytes an entry, so at most about 60 MB at 100,000 files on each side.
- **Hashing:** one pass over a file to hash it, at most 4 files at a time.

## 5. Tests (sync-client; grader to review)

Against the agent endpoint on the reference server (Miniflare), a real local folder, and the real CLI:
- **Each row of §2.2's table,** with and without a base, and with `--up-only` and `--down-only`: the plan, then the result on both sides, then a second run's plan is empty.
- **The first run never deletes:** a folder pair with files only here, only there, and different on both; no delete in the plan.
- **Conflicts:** both changed; the conflict name already taken; the result is the same on both sides, and both versions exist.
- **Deletions:** each way, the Trash and the holding folder contents, `--restore`; the many-deletions guard at 50 and 51 files and at 25%.
- **Crash mid-apply:** the CLI killed after each action kind, and between a download's temporary file and its rename; the next run cleans up, plans only what's left, and the end state is what an uninterrupted run gives.
- **A browser edit during apply:** a write to the same file through the page between the plan and the upload: the upload is refused (409), nothing is overwritten, and the next run plans it as changed there (or a conflict).
- **A local edit during apply:** between the plan and a download or upload: skipped, and planned again next run.
- **Names:** a symlink pointing outside the folder (skipped, nothing read through it), ignored paths on both sides, a name the workspace refuses, NFD vs NFC names, and two workspace names differing only in case on a case-insensitive filesystem.
- **Limits:** a plan larger than the grant's daily write budget (partial apply, the right exit code, the rest the next day); a 429 mid-run; a file over 95 MiB (skipped and listed); a revoked token (401, pairs again).
- **The base:** a base for another account, grant or folder is never used; two runs of the same pair at once (the second refused).

## 6. What it costs

- **A run with nothing to do:** one local scan (`stat` only, no hashing), $\lceil n/1000 \rceil$ `list` requests for $n$ workspace entries, and no writes.
- **A change of $k$ files:** about $k$ requests plus one blob URL per download, and the bytes of those files, within the grant's daily budgets (§3.3).

## 7. Open questions

- **Larger syncs:** the grant's 100 MB a day written makes a first upload of a large folder take days. Is that acceptable for now, or should a person be able to make a grant with a larger write budget for fs-sync? (Proposed: acceptable for the first version; the plan says how long it will take.)
- **Notebooks as `.ipynb`:** sync documents as their file form, read-only or both ways? (Proposed: later; skipped and listed for now.)
- **Files over 95 MiB:** let a grant upload chunked files (design/tiered-files.md §4.4 limits that to device sessions today)? (Proposed: later, with its own review.)
