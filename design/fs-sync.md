# fs-sync: syncing a local folder with a Sagebrush folder, once, when asked

*Status: design, docs only, nothing built. Authors: @sagebrush-remote-compute (§1, the CLI) and @sagebrush-sync-client (§2–§7). Reviews: astra (correctness), daybreak2 (limits), grader (tests), board (COPY). Commissioned by William, Nov 8 2026 (~1:24 PM PST): "you run `sagebrush fs-sync ...` ... scan the local files and the state in sagebrush for a folder, compare them, make a plan, get confirmation, etc. It's basically what reflect-sync does periodically."*

*Built on design/agent-endpoint.md (grants, pairing, the verbs and their limits) and design/sync-server.md (the index, ops with a base hash, blobs by SHA-256). It needs the agent endpoint to be built and on; until then this note is a plan only. Out of scope: anything automatic or periodic (a watcher, a daemon), and the lazy "in the cloud" files of design/tiered-files.md.*

## In plain words

- **You run it; it never runs by itself.** `sagebrush fs-sync ~/thesis /Thesis` compares a folder on this computer with a folder in your workspace, shows what it would do, and does it only when you say yes.
- **It remembers the last sync.** So it can tell a file you changed here from one changed in the workspace, and a file you deleted from one that was never there.
- **It never overwrites a change.** When both sides changed the same file, you get both: the workspace's copy keeps the name, and this computer's copy is kept beside it as a conflict copy, on both sides.
- **It deletes only what it knows you deleted.** The first sync of a folder pair never deletes anything. Later, a file is deleted on one side only if it was there at the last sync and you deleted it on the other. Deleted workspace files go to the workspace's Trash; deleted local files go to a holding folder you can restore from for 30 days.
- **Stopping halfway loses nothing.** Run it again and it picks up from what is actually on both sides.
- **Not on native Windows yet** (it runs in WSL). And for a folder on another disk, such as a USB drive, fs-sync deletes or replaces files there only once its holding folder is on that disk too; until then it says so and leaves them.
- **Notebooks, boards and chats come down as files, but don't go up yet:** fs-sync writes each one's current version to this computer (a `.ipynb`, `.board.json` or `.chat` file). If you edit one here, fs-sync says so and leaves your edit alone; it doesn't upload it. Two-way sync for them comes later.
- **Some things are listed, not synced:** files over 95 MiB (until chunked uploads exist), and symlinks.
- **Each workspace folder is paired once:** the first run for a folder asks you to approve it on sagebrush.space, and it can then change only that folder.

---

## 1. The command (remote-compute)

`fs-sync` is a subcommand of the `sagebrush` CLI on PyPI, run with `uvx` like `sagebrush remote`. There is no separate program.

```sh
uvx sagebrush@latest fs-sync LOCAL_DIR WORKSPACE_PATH [--up | --down] [--dry-run [--verbose] | --yes [--allow-deletes N]] [--origin URL]
uvx sagebrush@latest fs-sync --restore RUN_ID
uvx sagebrush@latest fs-sync --forget [--origin URL]
```

- **The arguments:**
  - `LOCAL_DIR` is a folder on this computer. It must exist; fs-sync never creates it.
    - It may not overlap fs-sync's own folders, the config folder (§1.1) and the state folder (§1.4).
    - In every mode (a sync, `--dry-run`, `--restore`), fs-sync resolves `LOCAL_DIR` and both of those to real paths, through any symlinks. If `LOCAL_DIR` is one of them, contains one, or is inside one, it exits 2 before pairing or reading any file, with one of two messages: "~ can't be synced: it contains fs-sync's own files (~/.config/sagebrush/fs-sync). Choose a folder that doesn't." or "~/.local/state/sagebrush/fs-sync/trash can't be synced: it is inside fs-sync's own files. Choose a folder outside ~/.local/state/sagebrush/fs-sync."
    - So the token, the bases, the journals and the holding folder are never scanned, uploaded or deleted. That holds even for `fs-sync ~ /Home`.
  - `WORKSPACE_PATH` is a folder in the person's workspace, such as `/Thesis`. If it doesn't exist, the plan says it will be made.
- **Direction:**
  - With no direction flag, changes go both ways.
  - `--up` applies only the actions that change the workspace and nothing on this computer: §2.2's upload and delete-there rows. `--down` applies only those that change this computer and nothing in the workspace.
  - **A conflict needs both sides changed** (§2.3), so a one-direction run doesn't apply it. It is listed under "Conflicts, not applied (`--up`)", with "run fs-sync without --up to keep both".
  - The other direction's actions are listed under "Pending, not applied (`--up`)" (or `--down`), so nothing is skipped silently.
  - **The base** of a path advances only when an action leaves both sides equal. A pending or unapplied conflict path keeps its old base, so the next run in both directions sees it exactly as before.
  - A run that leaves anything pending exits 1 (§1.3). A one-direction run reports "not in sync" whenever it is.
- **The default is: show the plan, then ask.** Nothing changes before the answer.
  - `--dry-run` shows the plan and exits, never asking; nothing changes and the base isn't touched. It shows the first 20 lines of each kind; `--verbose` shows them all.
  - `--yes` applies without asking, for scripts.
  - `--dry-run` with `--yes` is refused (exit 2).
- `--origin URL` names the Sagebrush site, as `sagebrush remote login --origin` does. The default is https://sagebrush.space.
- **Other flags:**
  - `--restore RUN_ID` puts back the local files a run deleted (§2.4), into that run's `LOCAL_DIR`.
    - It applies the same overlap refusal first (above), and restores only paths that resolve inside `LOCAL_DIR`.
    - **It never overwrites:** a path that is occupied now is left as it is. Its file stays in the holding folder and is listed ("not restored: notes/a.tex exists"), and the run exits 1.
    - It changes nothing in the workspace. The next sync sees restored files as "new here" or "changed here".
  - `--forget` deletes this computer's token for that site (§3.1).
- `--help` (or `-h`) prints the usage on stdout and exits 0. Like `sagebrush remote --help` since #862, it doesn't sign in, read a folder or send anything.

**It runs once and exits.** No watcher, no daemon and no schedule. To sync again, run it again.

**Windows is not supported in v1** (§4.4). On native Windows, fs-sync refuses at once, before pairing or reading anything (exit 2), as `sagebrush remote` does: "fs-sync doesn't run on native Windows yet. Use it from WSL (Windows Subsystem for Linux)." It runs inside WSL as on Linux.

### 1.1 Signing in

The first run for a site pairs, by the agent endpoint's pairing (§3.1, design/agent-endpoint.md §2):
- It prints a URL and a code, and waits:
  ```
  This computer isn't signed in to sagebrush.space for /Thesis yet.
  Open https://sagebrush.space/agents/pair and enter the code WXYZ-1234
  to let fs-sync on laptop read and write /Thesis. Waiting… (the code expires in 10 minutes; Ctrl+C to stop)
  ```
- The person opens the URL signed in, enters the code, and approves a grant scoped to `WORKSPACE_PATH` with write access. The page names it `fs-sync on <computer>`.
- The CLI receives the token once, saves it, and goes on to the plan.

Where the token lives:
- **The file:** `$XDG_CONFIG_HOME/sagebrush/fs-sync/grant-<origin hash>.json` (default `~/.config/…`), one per site. Its account is recorded inside.
- **Its rules:** the same as the remote key's (`remote/keys.py`): mode 0600 in a 0700 folder, and a file that is a symlink, not the person's, or readable by others is refused, not used or repaired. The token is never printed or logged.
- **Another folder:** a later run naming a `WORKSPACE_PATH` outside the grant's scope pairs again for that folder. A grant is per folder, by design.
- **Revoked or expired** (401): the run pairs again. Under `--yes` with no terminal it can't, so it exits 3: "This computer isn't signed in to sagebrush.space for /Thesis. Run fs-sync once in a terminal to pair it."

`<computer>` is the name given to `sagebrush remote login --name` if this computer is enrolled, else the hostname. The remote key itself isn't used (§3.1).

### 1.2 The plan, as shown

One line per action, grouped by kind, with sizes; then the totals and the cost against the grant's budget for today (§3.3). Paths are relative to the two folders.

```
sagebrush fs-sync ~/thesis → /Thesis   (both ways; last synced Nov 8, 13:40)

Upload (3 files, 1.2 MB)
  + notes/intro.tex                     4.1 KB   new here
  ~ hecke.sage                         12.0 KB   changed here
  ~ data/table.csv                      1.2 MB   changed here
Download (1 file, 8.0 KB)
  ~ refs.bib                            8.0 KB   changed in the workspace
Delete in the workspace, to its Trash (1 file)
  - old/draft1.tex                               deleted here since the last sync
Delete on this computer, to the holding folder (1 file; restore with fs-sync --restore 20261108-1402 for 30 days)
  - figures/old.png                    210 KB   deleted in the workspace since the last sync
Conflicts, both kept (1 file)
  ! main.tex    changed on both sides: this computer's copy becomes "main (conflict, laptop).tex", on both sides
Download only: notebooks, boards and chats as files (2 files, 64 KB)
  ↓ Notes.ipynb                        58 KB   the notebook as it is now in the workspace
  ↓ plan.board.json                     6 KB   the board as it is now
Not uploaded: edited here (1 file)
  · Seminar.ipynb       changed here since fs-sync wrote it; left as it is, not uploaded and not replaced
Skipped (2)
  · build/                ignored (.sagebrushignore)
  · lecture.mp4           624 MiB, over the 95 MiB limit for one file (until large uploads are available)

Cost: 9 requests, 1.2 MB up, 72 KB down (left today: 98.8 MB up, 192 MB down)
Apply? [y/N]
```

- **Notebooks, boards and chats** (§3.2) are written here as files, the way the workspace saves them when downloaded: `.ipynb`, `.board.json`, and the chat's file. They go only one way, from the workspace to this computer (William, Nov 8: "download only; a local edit to one is reported, not uploaded").
  - Each run writes a snapshot again when the document changed in the workspace.
  - If the person edited that file here since fs-sync wrote it, fs-sync leaves it as it is: it doesn't replace it, delete it or upload it. It lists it under "Not uploaded: edited here", every run, until the person deletes or renames their edited copy. Then the next run writes a fresh snapshot.
  - A notebook, board or chat file made here, such as a new `.ipynb`, isn't uploaded either (§3.4). It's listed under the same heading: "Draft.ipynb  made here; notebooks, boards and chats go only from the workspace to this computer for now".
  - A listed edited snapshot alone doesn't make the run exit 1. Snapshots are download-only by design, so "in sync" (exit 0) means every file other than these matches.
- **A first run** (no base) has no delete section, and says why: "First sync of this pair: nothing will be deleted."
- **The answer must be `y` or `yes`.** Anything else, including Enter, end of input or Ctrl+C, applies nothing (exit 1).
- **No terminal:** if standard input isn't a terminal and `--yes` isn't given, fs-sync prints the plan and exits 1 without applying, rather than wait for an answer that can't come.
- **Many deletions** (§2.4: more than 50 files, or more than 25% of the base, on either side):
  - Without `--yes`, after `y` it asks: "This deletes 63 files (31% of the last sync). Type 63 to delete them, or anything else to stop:". Anything but the number applies nothing (exit 1).
  - `--yes` alone refuses such a plan (exit 1): "Not applied: this plan deletes 63 files (31% of the last sync). If that's intended, run again with --yes --allow-deletes 63."
  - `--yes --allow-deletes N` applies the plan only if it has exactly N deletions, so a script can't delete more than it was written for.
- **Over today's budget** (§3.3): the plan's last line before the question says "Today's budget covers 41 of these 120 files (98 MB of 310 MB up); run fs-sync again tomorrow for the rest. Apply those 41? [y/N]".
- **Other outcomes, word for word:**
  - A damaged base (§2.5) is treated as no base, and the run goes on: "The last-sync record for this folder pair is damaged, so this run is treated as a first sync: nothing will be deleted."
  - Over a scan limit (§4.5), it stops before planning (exit 1): "Stopped before planning: ~/thesis has more than 200,000 entries (the limit for one sync)." The other limits use the same form ("… is more than 64 folders deep", "… has a path longer than 1,024 bytes").
  - Not enough room for fs-sync's own records: the pair's database is capped at 1 GiB, and the state folder's filesystem needs 2.1 GiB free before scanning (the database and its log together stay within 2 GiB) (§4.5). Otherwise it exits 1 having read nothing: "Not enough free space for fs-sync's records: it needs 2.1 GiB free in ~/.local/state, and 300 MiB is free. Free some space and run it again."
  - A download that doesn't fit stays pending, and nothing of it is written. Its target filesystem needs the file's bytes plus 256 MiB free. The plan lists it under "Not applied: not enough free space on /home (needs 2.1 GiB, 900 MiB free)", and the run exits 1.
  - Before each action that deletes or replaces a file (on either side), the state folder's filesystem must have 64 MiB free, and the pair's database must be at least 64 MiB under its 1 GiB cap, so the base can be committed (§2.5). Otherwise the action stays pending and nothing of it is done, and the run exits 1. The message is "Not applied: fs-sync needs 64 MiB free in ~/.local/state to record each deletion before making it, and only 20 MiB is free.", or, at the cap, "Not applied: fs-sync's record for this folder pair is nearly full (1 GiB). Sync its subfolders as separate pairs instead."
  - **The holding folder must be on the same filesystem as `LOCAL_DIR`** (§2.4). When it isn't (for example, `LOCAL_DIR` on a USB disk), actions that would replace or delete a file here aren't applied, and the plan says why: "Not applied: deleting or replacing files on /media/usb needs fs-sync's holding folder on the same disk, and it is on /home. Set XDG_STATE_HOME to a folder on /media/usb outside the synced folder to allow it. The next run is then a first sync: nothing is deleted until the one after." Uploads and new downloads still go ahead.
  - Over the hour's request budget (§3.3): "This hour's requests cover 41 of these 120 files; run fs-sync again in an hour for the rest. Apply those 41? [y/N]". The day's budget uses the over-budget line below.
- **While it applies,** each action prints one line when done.
- **A skipped action** (the file changed here, or the workspace refused the write because the file changed there, §4.1–4.2) is listed, and the run goes on with the rest. At the end it prints what was done and what was skipped, and "Run it again to sync the rest."

### 1.3 Exit codes

| Code | Meaning |
|---|---|
| 0 | in sync: the whole plan was applied, or there was nothing to do (with `--dry-run`: the plan is empty). Edited snapshots of notebooks, boards and chats, which are never uploaded, don't count |
| 1 | not all applied: declined, no terminal, a refused many-deletions plan, `--dry-run` with a non-empty plan, actions skipped, actions or conflicts pending in a `--up`/`--down` run, or stopped by the daily budget or a 429. The output says which; running it again continues |
| 2 | usage: an unknown argument, `LOCAL_DIR` missing or overlapping fs-sync's own folders, `--dry-run` with `--yes`, or native Windows |
| 3 | not signed in and can't pair (no terminal), or the grant was refused |
| 4 | the site couldn't be reached, or answered with an error that isn't about one action |

So a script can run `fs-sync --dry-run` to ask "is anything out of sync?" (0 or 1), and `fs-sync --yes` exits 0 only when both sides match.

### 1.4 What it touches on this computer

- **Files:** only under `LOCAL_DIR`. It follows no symlink (§4.4).
- **Network:** HTTPS to the site's origin, and the signed download URLs it hands out.
- **Its own state:** under `$XDG_STATE_HOME/sagebrush/fs-sync/` (default `~/.local/state/sagebrush/fs-sync/`), mode 0700. That holds one SQLite database per folder pair (the base, §2.5), the lock files, the run journals and the holding folder (§2.4, at most 20 GiB). Deleting a pair's database makes its next run a first run, with no deletions.
- **The token:** in the config folder (§1.1).
- **Downloads:** written to a temporary file in the target's folder, then renamed into place without replacing anything (§4.1), so no file is left half written. A file a download replaces is first moved to the holding folder, restorable with `--restore` for 30 days.

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
- **Comparing by hash, not time:** for planning, $L$ is recomputed only when a file's `(size, mtime_ns, ctime_ns, inode, device)` differ from what the base recorded, so a second run of a large, unchanged folder reads no file contents. Any write changes `ctime_ns`, which ordinary programs can't set back, so a changed file is very rarely taken for unchanged. And this shortcut is never what allows a local file to be replaced or deleted: those actions hash the file itself at apply time (§4.1). At worst a missed change isn't uploaded this run; it is never lost.
- **Folders:** made on the side that lacks them. A folder is removed only when the plan removes every file in it and it was in the base, and it is then empty.
- **One direction** (§1): `--up` applies only the upload and delete-there rows, `--down` only the download and delete-here rows. A conflict needs both sides changed, so a one-direction run applies **no** step of it, on either side: it is listed as not applied. The other direction's rows are listed as pending. Neither advances the base, and either makes the run exit 1.

### 2.3 Conflicts: keep both, never overwrite

When both sides changed $p$ differently, the result matches the reducer's convention for two devices' writes (design/sync-server.md §7.2), on both sides:
1. the local file is renamed to `name (conflict, <computer>).ext` (the computer's name, as `sagebrush remote login --name`, or the hostname), in the same folder;
2. that copy is uploaded as a new file of that name, so the workspace has it too;
3. the workspace's version is downloaded to $p$.

So the workspace's copy keeps the name, the local change survives under the conflict name on both sides, and both sides end the same. Nothing is lost at any step: step 1 is a rename, and step 3 writes a file whose name is now free. A conflict name already taken gets ` 2`, ` 3`, … as the reducer does.

### 2.4 Deletions

- **There:** `remove`, which the agent endpoint makes a move to the workspace's Trash, restorable by the person (design/agent-endpoint.md §1).
- **Here:** never `unlink`. The file is moved by a rename to `$XDG_STATE_HOME/sagebrush/fs-sync/trash/<run id>/<relative path>`. **The holding folder must be on the same filesystem as `LOCAL_DIR`** (astra, @sagebrush), so that this move is one rename and can be reversed; there is no copy-then-remove path. If it isn't, every action that would move a local file there (a delete here, a download that replaces a file) is refused, left pending, and the run exits 1 with §1.2's message ("Not applied: deleting or replacing files on … needs fs-sync's holding folder on the same disk …"). Uploads, new downloads and deletes in the workspace still run. The holding folder keeps a run's files for 30 days. `sagebrush fs-sync --restore <run id>` puts them back, each by a no-replace rename, only inside that run's `LOCAL_DIR`: an occupied path is left as it is and its file stays in the holding folder, listed (§1).
- **The holding folder is bounded** (daybreak2): at most 20 GiB and 200,000 files in all, and 10 GiB and 100,000 files from one run.
  - **Cleanup:** at the start of every run, runs older than 30 days are removed, oldest first. Nothing younger is ever removed to make room.
  - **Admission:** before applying, fs-sync adds up the bytes the run would move there (delete-here files, and files replaced by downloads, §4.1). If they don't fit under those bounds, those actions are left pending. The source files stay where they are, and the run exits 1 saying why.
- **Many deletions need a second word:** a plan that deletes more than 50 files, or more than 25% of the files in the base, on either side, needs the number confirmed (§1): typed after "y", or given as `--yes --allow-deletes N`, which applies only if the plan has exactly $N$ deletions. It is the usual sign of a wrong folder pair.

### 2.5 The base, and where it lives

- **One SQLite database per folder pair,** under `$XDG_STATE_HOME/sagebrush/fs-sync/` (default `~/.local/state/…`, mode 0700), with the locks, run journals and holding folder (§1), named by the SHA-256 of `(account hash, grant id, absolute LOCAL_DIR, WORKSPACE_PATH)`. It can't be inside `LOCAL_DIR`, because §1 refuses a `LOCAL_DIR` that overlaps fs-sync's own folders, before pairing or reading anything.
- **Contents:** for each path, `{sha256, size, mtime_ns, ctime_ns, inode, device, fid}`, where `fid` is the workspace entry's identity, and the workspace path and account it belongs to.
- **It advances per action:** each action that succeeds updates its path's row.
  - **Non-destructive actions** (an upload, a download to a path with no local file, a folder made) are committed in batches: every 1,000 actions, and once when the run ends or stops (done, a 429, a 401, Ctrl+C). There is no time-based commit. A lagging row here is harmless: such an action left both sides equal, and the next run's first rule ($L = R$: nothing, the base takes $L$) records it.
  - **Destructive actions** (a delete here, a delete there, a download that replaces a local file) are bracketed by two commits of their own (astra, @sagebrush): **before** acting, the path's base row is removed and committed; **after** it succeeds, the new row is committed. So if the run dies in between, the next run finds that path with no base, and with no base nothing is ever deleted (§2.2): a deleted file comes back from the other side, and a replaced one becomes a conflict that keeps both. A file recreated by the person meanwhile is never deleted on the strength of an old row. An action that is skipped at its check puts its old row back, in a third commit. Before each destructive action, the state filesystem must have a 64 MiB reserve free and the database at least 64 MiB below its cap (@sagebrush); if not, that action stays pending and the run exits 1. If a bracketing commit fails anyway, the run stops at once (exit 1, "run again"). **How the next run treats that path:** if the pre-action commit failed, nothing was done and the old row stands; if the post-action commit failed, the row is already cleared, so the path has no base, is re-observed on both sides, and is never deleted: it is uploaded, downloaded or kept both as a conflict.
  - **The bound:** a run of $a$ actions, $d$ of them destructive, makes at most $3d + \lceil a/1000 \rceil + 1$ commits, each one `fsync`, however slowly the actions go, and never rewrites the whole base.
- **A damaged base** (SQLite's integrity check fails, or the version is unknown) is treated as no base: the run is a first run, with no deletions, and says so.
- **A base for another account or folder** is never used: the account hash and paths are in its name and checked inside it.

## 3. The protocol: what it calls, and as whom (sync-client)

### 3.1 As whom: an agent grant, not a device session

fs-sync acts with an **agent grant** of the agent endpoint (design/agent-endpoint.md), scoped to `WORKSPACE_PATH` with write access, made by pairing:
- **It exists already, in the design:** pairing is a device-code flow approved by the signed-in person on sagebrush.space (§2 there), the token is scoped, expires (30 days by default, 90 at most), and is revocable from the Agents panel.
- **It limits the damage of a mistake** to the folder the person chose. A device session can change the whole workspace, and nothing in a CLI needs that.
- **Every change is credited** to `agent:fs-sync on <computer>` in the workspace's history, so the person can see and undo what a sync did.
- **Not the remote-compute key:** `sagebrush remote login` enrolls this computer for the remote relay only. Teaching the sync service to accept it would be a new kind of credential for the account object; a grant needs none.

The token is kept in the CLI's config directory, in `$XDG_CONFIG_HOME/sagebrush/fs-sync/grant-<origin hash>.json`, readable only by the person (mode 0600), one per site, with the account recorded inside (§1). A `WORKSPACE_PATH` outside the grant's scope pairs again. It is never printed or logged; `sagebrush fs-sync --forget` deletes it, and the person can revoke it on the site at any time. A revoked or expired token answers 401, and the next run pairs again.

### 3.2 What it calls

Through the agent endpoint's verbs (design/agent-endpoint.md §4), with the two small additions below:
- **The remote state:** `list(WORKSPACE_PATH, recursive)`, paged (1,000 entries a page, at most 10,000 a call), giving each entry's path, kind, `fid`, `sha256` and `size`. Every page must arrive; a listing that fails part way plans nothing. The pages aren't one consistent snapshot, so the listing is only a plan: every action re-checks the workspace at apply time (§4.1), and an absence in the listing never authorizes a delete by itself.
- **Download:** `read`, which for a data file answers a signed URL (single use for a grant), then a GET of the bytes, checked against the SHA-256 before anything is written.
- **Upload:** `write(path, content, {base, fid})`, with `base` the `sha256` and `fid` the identity the plan saw in the workspace. It is a compare-and-swap: if the entry at `path` isn't that data file with that hash, it answers 409 `conflict` and changes nothing (§4.2).
- **Create, folders, delete:** `mkdir` and `remove`, each an op with the grant's credit.
- **The two additions** fs-sync needs from the agent endpoint, proposed here for that design's review (each a precondition checked in the op's own transaction, as `write`'s `base` already is):
  - `write(path, content, {base: null})` means **create only**: refused with 409 `conflict` if anything is at `path`, so a new upload can't replace a file that appeared meanwhile;
  - `remove(path, {fid, sha256})` removes only if the entry at `path` is still that data file with that hash, else 409 `conflict`. So a delete-there can't remove a file changed or replaced since the plan.
- **Checking an absence:** `stat(path)`, answering the entry or "none", is called at apply time before a delete here (§4.1).

Data files sync both ways. Notebooks, boards and chats are documents (patch logs, design/sync-server.md §4), not files: they come down as download-only snapshots (§3.4), and never go up in this version.

### 3.3 Limits it lives within

fs-sync adds no limit of its own on the server; it is bounded by the grant's and the account's (design/agent-endpoint.md §7, design/sync-server.md §8):
- **Per grant:** 60 requests a minute and 1,000 an hour; each write at most 32 MB inline, larger as a blob up to `max_file_bytes`.
- **A grant's daily bytes come from the membership tier** (William, Nov 8: "This should be a function of the membership tier. 100MB was a parameter we probably chose when our AMBITION was much less about what we might store on R2."). Normative in design/sync-server.md §6 and design/agent-endpoint.md §7, changed in this PR:
  - **one read meter and one write meter for the whole account,** shared atomically by all its grants, so they also bound the churn of many grants together;
  - each is CoCalc's tier value (`sync.grant_read_bytes_per_day`, `sync.grant_write_bytes_per_day`), clamped: read to at most the account's `sync.read_bytes_per_day` and 64 GiB, write to at most `storage_bytes` and 64 GiB;
  - 200 MB / 100 MB only when a limits object CoCalc sent omits the field; an outage keeps the last good limits; zero means zero.
- **Per file:** at most 95 MiB (the single-PUT limit) until chunked upload exists. Then fs-sync uses it, up to 200 MiB (William, Nov 8: "(a) Recommended: yes, as soon as chunked upload exists (tiered-files PR 3), with no extra design"): design/tiered-files.md §4.4's "manifests and packs come from a person's device session only" then includes an agent grant's chunked upload, under the same verification (§4.1 there) and the grant's write budget. Until then, larger files are skipped and listed, not split.
- **The index:** 100,000 entries per account and 10,000 per folder.

**The plan states its cost before it runs** (daybreak2), counted from the protocol, with an exact upper bound per action:

| Step | Grant requests (at most) | Also |
|---|---|---|
| listing $n$ workspace entries | $\lceil n/1000 \rceil$ (one page of at most 1,000 entries per request; the endpoint's "10,000 a call" is not used) | |
| upload, at most 32 MB | 1 (`write`) | the bytes, against the grant's daily write budget |
| upload, over 32 MB | 3 (the blob's upload step, its PUT, then the `write`), as the agent endpoint's blob write | the bytes |
| download | 1 (`read`, which issues the single-use URL and debits the grant's daily read budget) | 1 GET to the files Worker, outside the grant's request meter (the files Worker's 600 a minute per IP applies) |
| folder made in the workspace | 1 (`mkdir`) | |
| delete there | 1 (`remove`) | |
| delete here | 1 (`stat`) | |
| conflict | 1 or 3 (the conflict copy's upload) + 1 (the download) | the bytes of both |
| a failed request (a transport error, not a 409 or 429) | retried at most twice, each attempt counted | |

The plan shows the total and the bound with retries. fs-sync paces itself to 60 requests a minute, so that limit only slows it. Before applying, it checks the plan against what is left of the 1,000 an hour and of the day's bytes up and down, and applies only the prefix of the plan that fits all three. If it doesn't fit, the plan says how much fits now and when a rerun continues (in an hour, or tomorrow); under `--yes` it applies what fits and exits 1, "not all applied; run again", saying why (§1). A 429 mid-run stops the run cleanly (§4.1) with the `retry_after`.

### 3.4 Notebooks, boards and chats: download-only snapshots

William, Nov 8: "(a) Recommended: v1 writes a current .ipynb / .board.json / chat file to your computer (download only; a local edit to one is reported, not uploaded). Two-way sync comes next as its own PR."
- **How a snapshot is made:** the agent endpoint's `read` of a document (design/agent-endpoint.md §4) answers its current value, computed in the Worker from its latest snapshot and the batches since. fs-sync writes that value as the file's bytes: a notebook as `.ipynb` JSON, a board as `.board.json`, a chat as its `.chat` file. A document over the endpoint's 8 MB of value is skipped and listed. Each read debits the value's size from the grant read budget (§3.3) and counts as one request.
- **Where it lands:** at the document's own path under `LOCAL_DIR`, like any downloaded file, by the same move-aside and no-replace install (§4.1).
- **What the base records:** the snapshot's SHA-256 (of the bytes written) and the document's head (`head_seq`), marked as a snapshot.
- **The rules,** which in §2.2's terms are: a snapshot row never uploads, and never deletes or replaces a file whose hash isn't its row's. **The next run:**
  - **the document changed** (another head) **and the local file is the snapshot as written** (its hash is the base's): a new snapshot replaces it, as a download that replaces a file (§4.1, so the old one goes to the holding folder);
  - **the local file was edited** (its hash isn't the base's): it is **never overwritten, deleted or uploaded**. "Edited here" means its hash differs from the snapshot hash in its base row. The plan lists it under §1.2's "Not uploaded: edited here", every run, and the base is unchanged. That alone doesn't make the run exit 1 (§1.3), since this version can never upload it. A newer version in the workspace isn't written either, until the person deletes or renames their edited copy; the next run then writes a fresh one;
  - **the document was deleted in the workspace** and the local snapshot is unedited: a delete here, to the holding folder, as for a data file; if edited, it is kept and listed;
  - **the local snapshot was deleted:** nothing happens in the workspace. The base forgets it, and the next run writes it again, saying so; to stop that, list it in `.sagebrushignore`;
  - **a new local `.ipynb`, `.board.json` or `.chat` file** with no document at that path is listed as "not uploaded (fs-sync doesn't upload notebooks yet)".
- **Under `--up`:** snapshots are neither written nor checked. Under `--down`: as above.

## 4. Running the plan: every action checks first (sync-client)

### 4.1 Every action checks before it acts

The plan is a list of actions, each with the state it was planned from: on this computer the file's stat key and `sha256` (or its absence), and in the workspace the entry's path, kind, `fid` and `sha256` (or its absence). Applying an action checks that state again, on both sides, and acts only if it still holds:
- **Upload:** the local file is hashed as it is read; if it isn't the planned hash, the action is skipped ("changed here during the sync"). The write carries the planned `base` and `fid`, or `base: null` for a new file, so the server refuses any workspace change meanwhile (409).
- **Download:** the bytes go to a temporary file in the same folder and are checked against the planned hash. Then the existing file is replaced in three steps, so that no write to it can be lost:
  1. it is **moved aside** by rename into the holding folder (§2.4), and hashed there. If that isn't the planned hash, it is moved back (without replacing anything that appeared meanwhile) and the action is skipped;
  2. the new file is renamed into place **without replacing**: if anything has appeared at that name meanwhile, the new file is kept beside it as a conflict copy and the action is skipped;
  3. the moved-aside copy stays in the holding folder, restorable for 30 days.
  A new file (nothing there before) is installed by the same no-replace rename.
- **Delete here:** first `stat` in the workspace confirms that nothing at all is at that path now (any entry, of any `fid` or kind, means the action is skipped and planned again next run); then the file is moved aside into the holding folder and hashed, and moved back if it isn't the planned hash. So the delete rests on a fresh answer from the workspace and on the file's own bytes, never on the listing or the stat cache.
- **Delete there:** `remove` with the planned `fid` and `sha256` (§3.2).

**What fs-sync promises other programs writing in `LOCAL_DIR` meanwhile:** it doesn't stop them, and it never loses their bytes. A file it replaces or deletes is first moved aside and checked; a write that lands after that check goes either into a new file at the original name, which the no-replace rename never overwrites, or (through a handle opened earlier) into the moved-aside copy in the holding folder, which is kept 30 days.

**No path outside `LOCAL_DIR`:** `LOCAL_DIR` is resolved once to its real path and opened as a directory. Every later file operation is relative to an open directory handle (`openat`, `renameat`, `fstatat`) with no-follow (`O_NOFOLLOW`, `AT_SYMLINK_NOFOLLOW`), one path component at a time. So a folder replaced by a symlink during the run makes that operation fail, never escape. The no-replace rename is `renameat2(RENAME_NOREPLACE)` on Linux and `renameatx_np(RENAME_EXCL)` on macOS. **Windows is not supported in the first version** (@sagebrush): it has no handle-relative, no-follow equivalent of these calls, so the promise above couldn't be kept there. fs-sync refuses to run on Windows at once (exit 2), pointing to WSL (§1).

A skipped action leaves both sides and its base entry as they were. The run finishes the other actions, reports the skipped ones, and exits with a code that says "run again" (§1). The next run plans from what is there then.

### 4.2 A change in the browser during a sync

The person may edit a file in the browser while fs-sync runs. That edit is an op in the workspace's log; fs-sync's upload of the same file then fails its compare-and-swap (409 `conflict`) and changes nothing. The action is skipped, the run says the file changed in the workspace during the sync, and the next run sees it as "changed there" (or as a conflict, if it changed here too). No interleaving overwrites either change.

### 4.3 Interrupted runs

A crash, Ctrl+C or a lost connection at any point leaves:
- each finished action recorded in the base (§2.5), and each unfinished one not;
- at most one temporary download file per action, named `.<name>.sagebrush-tmp-<run id>`, which the next run deletes first;
- a run journal (`$XDG_STATE_HOME/sagebrush/fs-sync/runs/<run id>.json`, appended and flushed per action) for the report. Correctness never depends on it: the base's bracketing commits (§2.5) are what keep an interrupted destructive action from deleting anything.

The next run plans afresh. A finished action is now "equal" or already in the base; an unfinished one is planned again. There is no resume of an old plan, so a plan is never applied to a state it wasn't made from. Only one run per folder pair at a time: a lock file next to the base (`flock`), refused with "another fs-sync of this folder is running".

### 4.4 Names, links and filesystems

- **Ignored, both ways, and never deleted:** `.git/`, `node_modules/`, `__pycache__/`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*.swp`, `*~`, `~$*`, `.sagebrush-tmp-*`, and whatever `LOCAL_DIR/.sagebrushignore` lists, in `.gitignore` syntax (its patterns, `!` negations and `/` anchoring). The ignore file itself is synced like any file, so both sides agree. An ignored path is neither uploaded, downloaded nor deleted.
- **Symlinks:** never followed and never synced; listed as skipped. So a link can't make fs-sync read or write outside `LOCAL_DIR`. Other special files (sockets, devices, FIFOs) are skipped too.
- **Permissions:** not synced. Downloads are made with the person's default mode (umask); an existing file keeps its mode when replaced.
- **Names the workspace refuses** (its `normPath` rules: length, characters, reserved names) are skipped and listed, never renamed silently.
- **Unicode:** names are compared in NFC, as the workspace stores them, so macOS's NFD names match.
- **Case-insensitive filesystems** (macOS by default): fs-sync detects it once per run (it creates and stats a probe name in `LOCAL_DIR`). Two workspace names that differ only in case can't both exist here: both are listed as a conflict and neither is downloaded. A local rename that only changes case is seen as a delete and a create.

### 4.5 Plan bounds

- **The scan:** visits at most 200,000 directory entries of any kind (files, folders, links, special files; an ignored folder counts once and isn't entered), at most 64 folders deep, with paths of at most 1,024 bytes in UTF-8 (the workspace's own limit). It keeps at most 100,000 files (the account's index maximum). Over any of these, fs-sync stops before planning and says which. A deeper or longer path is skipped and listed.
- **The plan:** at most 100,000 actions. Shown summarized (counts and bytes per kind, and the first 20 of each), with `--dry-run --verbose` for all of it.
- **Memory, by streaming rather than maps** (daybreak2): the scan and the workspace listing are written as rows into two scratch tables of the pair's SQLite database (ordinary tables in that one file, emptied at the start and end of each run) as they arrive, and the plan is a join of those tables with the base, read in path order. So memory is SQLite's page cache, set to 64 MiB, plus the hashing buffers below.
- **Disk for its own state, a hard ceiling:** the pair's database file, base and scratch tables and indexes together, is capped at 1 GiB by SQLite's `max_page_count`. Its write-ahead log is checkpointed with `TRUNCATE` after every transaction, and the pair's lock (§4.3) excludes any other reader, so nothing can hold a checkpoint back. Transactions are small (at most 5,000 scratch rows, at most 1,000 base rows), but the conservative bound used here (daybreak2) is that one transaction's log can hold at most a whole database's pages: so the database and its log together never exceed 2 GiB.
- **When the cap is hit:** a write past it fails (`SQLITE_FULL`). While the scan and listing are being stored, that is before anything is applied, and fs-sync stops there. During apply, it can come from a base update after an action already happened. Then fs-sync stops at once, applies nothing more, and exits 1: the base is left lagging, which loses nothing (§2.5: a non-destructive row is recorded by the next run's first rule, and a destructive action's row was already cleared), and the next run plans again. Before scanning, the state folder's filesystem must have at least 2.1 GiB free (the 1 GiB cap, a log as large as the database, and a margin), else fs-sync stops before reading `LOCAL_DIR`.
- **Disk for downloads:** before applying, for each filesystem that downloads land on, fs-sync checks that its free space is at least the bytes downloaded there plus 256 MiB. That holds even when the holding folder is on the same filesystem, where a replaced file's old bytes stay for 30 days while the new ones are written. Downloads that don't fit are left pending, the source and target files untouched; nothing is applied for those actions, and the run exits 1 saying why.
- **Hashing:** a file over the 95 MiB limit is skipped based on its `stat`, never opened. Others are hashed streaming, in 1 MiB reads, at most 4 at a time. Open files are at most the 4 being hashed plus one directory handle per level of the current path (at most 64).

## 5. Tests (sync-client; grader to review)

Against the agent endpoint on the reference server (Miniflare), a real local folder, and the real CLI:
- **Each row of §2.2's table,** with and without a base, and with `--up` and `--down`: the plan, then the result on both sides, then a second run's plan is empty.
- **The first run never deletes:** a folder pair with files only here, only there, and different on both; no delete in the plan.
- **Conflicts:** both changed; the conflict name already taken; the result is the same on both sides, and both versions exist.
- **Deletions:** each way, the Trash and the holding folder contents, `--restore`; the many-deletions guard at 50 and 51 files and at 25%.
- **Crash mid-apply:** the CLI killed after each action kind, after a move-aside, and between a download's temporary file and its rename; the next run cleans up, plans only what's left, and the end state is what an uninterrupted run gives.
- **A browser edit during apply:** a write to the same file through the page between the plan and the upload: the upload is refused (409), nothing is overwritten, and the next run plans it as changed there (or a conflict).
- **A local edit during apply:** between the plan and a download or upload, and between the move-aside's check and the no-replace rename (a new file at the name): skipped, nothing overwritten, and planned again next run.
- **(astra) Recreated before the commit:** with the hook `after_action(action)` before the bracketing commit: a delete here, then the person recreates the file with the same bytes, then a crash: the next run uploads it, never deletes it. The same for a delete there (the workspace file recreated) and for a replacing download (a conflict, both kept).
- **(astra) Genuine absence:** an entry of another `fid`, or a folder, appears at a delete-here path between plan and apply: skipped, nothing moved.
- **(astra) The stat cache:** a local write that keeps size and mtime: never overwritten or deleted (the apply-time hash catches it).
- **(astra) The remote listing:** an entry missing from a listing (a page served before a concurrent rename): no delete here (the apply-time `stat` finds it); a file created or replaced in the workspace between plan and apply: the create-only write and the `remove` precondition refuse (409).
- **(astra) Links:** a folder inside `LOCAL_DIR` replaced by a symlink to outside during apply: the operation fails, nothing outside is read or written.
- **(astra) One direction:** a conflict under `--up` and under `--down`: neither side changes, the base doesn't advance, exit 1.
- **Names:** a symlink pointing outside the folder (skipped, nothing read through it), ignored paths on both sides, a name the workspace refuses, NFD vs NFC names, and two workspace names differing only in case on a case-insensitive filesystem.
- **Snapshots (§3.4):** a notebook, a board and a chat written as files; the document changed and the snapshot unedited (replaced, the old one held); the snapshot edited here (never overwritten, deleted or uploaded; listed; exit 0 if nothing else is left), and then the document changed too (still not written); the document deleted (unedited: held; edited: kept); the snapshot deleted here (written again, and not again once ignored); a new local `.ipynb` (listed, not uploaded); a document over 8 MB of value (skipped); `--up` (snapshots untouched).
- **The tier budgets (daybreak2):** the grant read and write meters at the limit and one byte over; a field omitted (200 MB / 100 MB), an explicit 0 (nothing read or written), a negative, fractional or overflowing value (the whole limits object malformed: the last good one kept); a CoCalc outage and a stale cache (the last good value, never the fallback); a plan notice that lowers a tier mid-day; the clamp to the account's read budget, `storage_bytes` and 64 GiB; two grants at once at the shared boundary (one fits, the other gets `rate`).
- **Limits:** a plan larger than the grant's daily write budget (partial apply, the right exit code, the rest the next day); a 429 mid-run; a file over 95 MiB (skipped and listed); a revoked token (401, pairs again).
- **The base:** a base for another account, grant or folder is never used; two runs of the same pair at once (the second refused); a run killed while holding the lock (the OS releases a `flock`, so the next run isn't blocked); a damaged base (treated as no base: no deletes); a crash between batch commits (the lagging rows are recorded by the next run, with no extra action).
- **Bounds (daybreak2):** the holding folder at its bounds and one byte or one file over (those actions pending, sources untouched, exit 1); a holding folder on another filesystem than `LOCAL_DIR` (deletes here and replacing downloads refused and pending, everything else applied); the scan's 200,000 entries, 64 levels and 1,024-byte paths, each at the limit and one over; a 96 MiB file never opened; the request bound of a plan checked against the hour's remaining requests (only the fitting prefix applied); the commit count with slow, paced actions, at most $3d + \lceil a/1000 \rceil + 1$, including a plan of only destructive actions; the state database at its 1 GiB cap and one page over, while storing the scan (stops before applying) and at a base update during apply (a seam that fails the next commit with `SQLITE_FULL`: stops at once, exit 1, and the next run's plan is right); the state folder's filesystem with 2.1 GiB free and one byte less (stops before scanning); the log's size after the largest transaction, against the 2 GiB total; download admission at exactly enough free space and one byte short (those downloads pending, nothing written). Every bound is a constant the tests can lower, so these run on small folders.

**Seams, not timing** (grader). The apply loop has named test hooks, each a point where a test can change a side and then let the run continue: `before_check(action)`, `after_tmp_written(action)`, `after_move_aside(action)`, `before_install(action)`, `after_action(action)`, `after_base_commit(batch)`. The browser-edit, local-edit and crash tests use these, never sleeps or timed signals.

**More cases** (grader):
- the stat key: an edit that keeps size and restores mtime (`touch -r`): `ctime_ns` changes, so it is hashed and planned; an inode reused by a new file;
- the deletion guard per side, at 50 and 51 files and at 25% and 33% of small bases; `--allow-deletes` with $N - 1$, $N$ and $N + 1$;
- folder removal, and a folder still holding an ignored file (kept, and listed);
- conflict names with no extension, a dotfile, several dots, and a name `normPath` refuses (the conflict copy is named by the reducer's own function, run on its own test vectors);
- a download whose bytes don't match the hash (discarded, skipped, exit 1);
- a 401 mid-run (stops; the next run pairs again); every exit code of §1.3;
- a second run of an unchanged folder reads no file contents (a read counter);
- the case-insensitive rows run on a macOS CI runner (case-insensitive by default), and on Linux as unit tests of the plan with the filesystem's case rule injected;
- `--restore` onto an occupied path (left as it is, the file kept in the holding folder, exit 1).
- **At implementation,** the table of §2.2 is a pure function `plan(L, R, B, mode)` with a unit test per row and mode, for the grader's mutation tests.

**The overlap refusal (astra's F1, §1):** `LOCAL_DIR` equal to the home folder, to an XDG parent, and to the exact state and config folders, each refused with exit 2 before pairing; XDG overrides that put fs-sync's files under the chosen folder (refused the same way); every mode including `--restore`; and, with a synthetic token, no token bytes in any upload.

## 6. What it costs

- **A run with nothing to do:** one local scan (`stat` only, no hashing), $\lceil n/1000 \rceil$ `list` requests for $n$ workspace entries, and no writes.
- **A change of $k$ files:** at most the sum of §3.3's per-step bounds, and the bytes of those files, within the grant's hourly request and daily byte budgets (§3.3).

## 7. Open questions

- **Larger syncs: decided** (William, Nov 8, ~1:49 PM PST): "This should be a function of the membership tier. 100MB was a parameter we probably chose when our AMBITION was much less about what we might store on R2." A grant's daily read and write budgets come from the tier, with today's 200 MB / 100 MB only as the fallback when CoCalc sends none, under a hard ceiling (§3.3). The plan still says how long a large first sync will take at the tier's rate.
- **Notebooks, boards and chats: decided** (William, Nov 8, ~1:52 PM PST): "(a) Recommended: v1 writes a current .ipynb / .board.json / chat file to your computer (download only; a local edit to one is reported, not uploaded). Two-way sync comes next as its own PR." (§3.4).
- **Files over 95 MiB: decided** (William, Nov 8, ~1:52 PM PST): "(a) Recommended: yes, as soon as chunked upload exists (tiered-files PR 3), with no extra design" (§3.3).
