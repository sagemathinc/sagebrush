# Git projects: a GitHub repository as a Sagebrush folder, and changes proposed back as pull requests

*Status: design, docs only, nothing built. Author: @sagebrush (who built the `/git` prototype, branch `git-proto`), with @sagebrush-sync-client advising on how it sits on tiered files and fs-sync. Reviews: astra (correctness and security), daybreak2 (limits and costs), grader (tests), board (the words people see). Commissioned by William, Nov 8 2026, about 2:50 PM PST: "(a) Recommended: yes, a short design note now (no code), by the /git prototype's author with sync-client advising; usual reviewers".*

*William's direction, Nov 8 2026: "we would not even try to do something like that [a real `git clone`]. The functionality won't exist at all, since real git doesn't. However, we may at least consider having a lightweight 'we own it' git command in our terminal and/or UI, where we own what 'git clone' does… What we really want is to just support what is needed for a agent/human lightweight PR workflow like we prototyped under `/git`."*

*Built on design/tiered-files.md (files "in the cloud"), design/sync-server.md (the account object, ops, reservations, R2 blobs by SHA-256), design/agent-endpoint.md (server-side writers with their own identity), design/fs-sync.md (its three-way rules, its ignores, its name rules) and web/gitpush (the branch rules, the notebook export).*

## In plain words

- **A public GitHub repository can become a Sagebrush folder.** Sagebrush's servers copy the repository's current files, not its history, straight from GitHub into the cloud. Every device lists every file at once, "in the cloud", and downloads a file only when it's opened.
- **There is no `.git` folder, and no real git.** Sagebrush keeps a record of which GitHub commit the folder came from. That is enough to show what changed and to propose those changes.
- **Changes go back as a pull request.** "Propose changes" shows exactly what will be sent, and after you confirm, sends it to a new branch named `sagebrush/…` and opens a pull request. It never pushes to `main`, and your GitHub token never leaves your device.
- **Agents work the way the `/git` prototype showed.** You review an agent's changes file by file before they are proposed.
- **Some files aren't copied, and are listed with why:** links, submodules, files over the membership's one-file allowance, and files whose bytes GitHub changes when it makes the archive. Repository-entry and archive allowances also come from the membership; a refusal names the first membership that raises one. Private repositories come later.

For scale, William's example: cloning the sagebrush repository with real git transfers 76,406 objects (404.86 MiB) and leaves 8,573 files. A git project copies only the 8,573 current files. Their bytes are stored once in the cloud, and a device downloads only the files it opens.

---

## 1. What a git project is

An ordinary synced folder, plus rows in the account object:

```
git_projects
  account, folder_fid   the folder (design/sync-server.md §3's entry id); a rename or move keeps the link
  owner, repo           GitHub names, checked by web/gitpush/rules.ts's parseRepo and SEGMENT
  ref                   the branch it follows (GIT_BRANCH)
  base_commit           the GitHub commit the folder last matched (a 40-hex sha, never a branch name)
git_base                one row per path in base_commit's tree
  path, kind            kind: file | excluded
  sha256, gitid         for a file: its SHA-256 and git blob id
  reason                for excluded: link, submodule, too_large, differs, ignored, invalid_name
  conflict_of           set on a conflict copy made by §4 (the path it is a copy of)
```

- **What changed is a comparison with `git_base`,** with no download: a `file` row whose current SHA-256 differs is changed; a `file` row with no file is removed; a file with no row is added. An `excluded` row is never compared: its path is neither proposed nor deleted (§3).
- `git_base` is fixed for a given `base_commit`, so devices read it once, by a paged GET, and keep it.
- SHA-1 is only git's id here; SHA-256 stays the file's identity.
- "Stop following GitHub" (Settings) deletes the rows and leaves the files as an ordinary folder.

## 2. Copying a repository in (the server)

**v1 copies public repositories only.** No token is involved at any step. Private repositories need their own short addendum (§7).

1. **Ask, from the page.** The person ("Copy from GitHub" on the Files page, or the terminal's `git clone`, §5, which runs in the page) names a repository, a branch and a new folder name. The page, not the server, calls `api.github.com`: it resolves the branch to a commit sha, and reads that commit's tree (`/git/trees/{sha}?recursive=1`). GitHub's limits for those calls are then the person's own (60 an hour without a token, or their token's, which stays on the device), not a limit shared by every Sagebrush server. If GitHub answers `truncated`: `Can't copy owner/repo: GitHub lists it in parts (it has too many files for one listing).` If GitHub refuses for its rate limit: `Can't copy owner/repo right now: GitHub is limiting requests. Nothing was added. Try again in a few minutes.` (or `Try again after 3:40 PM.` when GitHub's answer gives its reset time).
   The page sends the server the sha and the tree (paths, modes and blob ids), on the person's signed-in session, from Sagebrush's own origin. An agent grant can't start, cancel or finish an import. The tree is the person's claim, used only to sort their own import's entries (step 3): every entry still passes §2.1, and `git_base`'s ids are computed from the bytes, never copied from the claim. A false tree can only make the person's own files listed as `differs` or missing. The server creates the import's row (below), and takes reservations (§2.2).
2. **Fetch once.** The server downloads `https://codeload.github.com/{owner}/{repo}/zip/{sha}` (GitHub's archive host, which isn't the rate-limited API) into one R2 staging object. It follows no redirect: any answer but 200 is refused and its body cancelled. A zip archive, not a tar one, so later batches can read their files by range.
3. **Import in batches,** from a durable cursor. Each batch reads one contiguous byte range of the zip (entries are stored in order) and, per entry:
   - validates its path (§2.1) and matches it to the tree;
   - inflates it as a stream, computing its SHA-256 and git blob id;
   - imports it only if its git blob id equals the tree's (otherwise `differs`: GitHub's archive applies `.gitattributes`, which can drop, rewrite or re-end lines in files, and those bytes must never be proposed back as edits);
   - stores bytes not already held as a blob (up to the membership's `max_file_bytes`, using the chunked route when needed), under the import's reservation;
   - writes a row to the import's staging table (path, sha256, gitid, size, or excluded and why).
4. **Appear at once.** The account object builds a hidden import generation in bounded transactions. Every slice checks the import, account generation, destination reservation, staged blobs and the current membership populations. It fills the new entries, ops, `git_projects` and `git_base` rows without putting the generation in the visible index. After its counts and hashes match staging, one transaction converts reservations to holdings, flips the destination's generation pointer and marks the import done. Devices then see the whole folder, every file "in the cloud", through the index's existing paging. If any check fails, the hidden generation is collected and nothing appears. A finish that arrives twice finds the import done and changes nothing.
5. **Report.** Every path not imported is listed with its reason (fs-sync §4.5's skip-and-list form), for example `· docs/build.sh   differs from the repository's copy (a .gitattributes rule changed it)`.

**The import's row** holds: an import id; the account and the account's generation when it began; owner, repo and the commit sha; the destination name; the staging object's key; the cursor; its reservations; a deadline (24 hours). Every batch and the final transaction check the row, the account generation and that the import isn't cancelled, after every await. A cancel, an account reset or the deadline marks the import cancelled first, then at once releases every reservation it holds, deletes the staging object and table, and queues the blobs it stored that nothing else references for deletion. A batch still running finds the import cancelled at its next check, so it can't commit, re-reserve or restore anything, and nothing late can appear. Ops written by an import carry the device `github:<import id>`, set by the server.

### 2.1 Archive entries are input, not paths

Before an entry can be staged:
- the archive's one top folder (GitHub's `owner-repo-sha/`) is removed; an entry outside it is refused;
- the rest must pass the workspace's own path rules (normPath, as #882's `workspace_refuses` implements them): no absolute path, no `.` or `..` component, no control character or forbidden separator, at most 32 folders deep, 1,024 UTF-16 units for the path and 255 for a name;
- two entries with the same NFC name, or a file where another entry needs a folder: both are excluded as `invalid_name`, listed as `· a/…/name   a name or path the workspace can't hold`. Names that differ only by case are both kept, as the workspace allows (fs-sync handles them on a case-insensitive disk);
- links (tree mode 120000) and submodules (160000) are known from the tree, not the zip, and are never written: `link`, `submodule`;
- fs-sync's mandatory ignores (§4.4) give `ignored`; a tree path missing from the archive is listed;
- a malformed or truncated zip (a bad entry header, a CRC or length mismatch, an entry outside the staged object) stops the import, and nothing appears.

### 2.2 Limits

Each product value is from the required membership record (design/fs-sync-scale.md §1), with at-limit and one-over tests in PR 2:
- **The tree the page sends:** read only through `git_project_tree_bytes` + 1 byte, whatever `Content-Length` says, before parsing. Its fixed shape stays `{"sha": <40 hex>, "rows": [[mode, id, path], …]}`; folder rows and malformed fields are refused. Rows are counted before path checks against `git_project_entries`.
- **Entries:** at most `git_project_entries`, counted as each is read from the zip directory before ignores or skips.
- **Staging:** the download reads at most `git_project_archive_bytes` + 1 byte, whatever `Content-Length` says. Past it, the staging object and reservations are released before the upgrade-bearing refusal.
- **A file:** at most `max_file_bytes`; inflation stops at the declared size + 1 byte or that membership value + 1 byte, whichever comes first, so compression cannot bypass it.
- **Concurrent imports:** at most `git_project_concurrency` per account.
- **The batch work slice:** the cursor yields after at most 500 files, 64 MiB compressed or 64 MiB inflated, but always handles at least one admitted file. These are operational fairness slices, not product refusals; another slice is scheduled. The nightly gate may lower a slice to fit Worker CPU/memory, never lower the membership's repository or file allowance.
- **Quota:** each batch takes sync-server's existing reservations (design/sync-server.md §6.1) for its new bytes before storing them, re-checked after each await. When room can't be reserved, the import stops and is cancelled: `Stopped copying owner/repo: your storage is full. Nothing was added. Free some space and copy again.`
- **At concurrency:** a further copy or update gets the structured membership refusal and COPY's upgrade sentence; progress for the admitted imports remains visible.
- **Deadline:** `Copying owner/repo was cancelled: it didn't finish within a day. Nothing was added.`
- **Publication is sliced when needed.** The final logical publication may contain `git_project_entries` entries, but no Durable Object transaction is allowed to grow with an arbitrary membership value. It builds a hidden generation in bounded transactions and flips one generation pointer after counts/hashes hold; devices see none or all. The nightly fixtures measure the 10,000- and 100,000-entry cases rather than lowering the product value to fit one transaction.

## 3. Proposing changes (the device, not the server)

1. **What changed** is §1's comparison, with each file's diff shown in its own terms, as in the `/git` prototype. A change that is "in the cloud" on this device is fetched and checked by hash first, as opening does.
2. **One export, used everywhere.** A notebook is compared, shown and sent as web/gitpush's `stripOutputs` text, without outputs; boards and chats as their files. The same bytes are used for the diff and for the commit.
3. **The proposal is frozen.** The person sees a list: repository, `base_commit`, and each path with the SHA-256 of the exact bytes to send. Nothing is sent until they confirm that list. If any listed file changes before the send, the proposal is withdrawn and shown again.
4. **Refusals, before anything is sent:**
   - while a conflict copy exists (`conflict_of`): `Propose changes is waiting: resolve or delete notes (conflict, GitHub).tex first, then try again.`;
   - a file over 50 MiB (gitpush's MAX_FILE) is listed and left out.
5. **The send** runs in the person's page, with their token, against `api.github.com` (it allows browser requests): one blob per changed file, one tree on `base_commit`'s tree (removals as deletions; `excluded` paths untouched), one commit, then **creating** a new ref `sagebrush/<name>` (BRANCH). Creating fails if the ref exists: then a new name is chosen (`sagebrush/<name>-2`, …), never an existing branch updated. Then the pull request.
6. **Never automatic.** No timer pushes (unlike gitpush's M3). Agent grants and the terminal can't reach this path; `git push` only opens step 3's list.

## 4. Updating from GitHub

"Update from GitHub" stages the branch's newest commit as §2 does, and then plans and applies in the final transaction, as one SQL join of the folder (L), the staged commit (R) and `git_base` (B), so nothing changes between plan and apply. fs-sync §2.2's rules, applied per path:
- changed on GitHub only: replaced (and "in the cloud" unless kept or open);
- changed here only: kept;
- changed in both: the folder's version keeps the name; GitHub's version is added as `name (conflict, GitHub).ext`, with `conflict_of` set (a conflict name already taken gets ` (2)`, ` (3)`, …, as fs-sync §2.3 does; nothing is overwritten). This matches fs-sync §2.3: the workspace's copy keeps the name;
- deleted on GitHub, unchanged here: removed (GitHub keeps it, so no confirmation). Deleted on GitHub, changed here: kept, and its `git_base` row is removed, so it shows as added;
- a path that becomes `excluded` (too large, a link, `differs`…): the folder's file is kept untouched, and its row becomes `excluded`, so it is never proposed as a deletion;
- the folder's own state is checked against what L read, by entry id and hash, in the same transaction;
- `base_commit` and `git_base` move to the new commit.

### 4.1 Switching branches, and more than one branch

William, Nov 8 2026 (about 3:05 PM PST): "for really everything else I do, it would be via api calls to the remote git server… `git checkout branch`, worktree stuff too… all uses this 'kung fu' approach of not even doing the work."

- **`git checkout <branch>`** is §4 against another branch's commit, refused while the folder has changes not yet proposed (`git checkout: this folder has changes not yet proposed. Propose or discard them first, or use git worktree add to put the branch in another folder.`). It is §2's zip of the other commit, then §4's join: one path, nothing new. Bytes already held are never stored again (blobs are by SHA-256), so a checkout pays only the download, and stores only the files that differ. Then `ref` changes.
- **A worktree** is another folder following another branch: `git clone` again, or `git worktree add <folder> <branch>`. Bytes the two share are stored once (blobs are by SHA-256), so a second folder costs little more than its rows.
- **Other hosts:** everything here is a few calls (resolve a branch, list a tree, fetch an archive, create a ref and a pull request). GitLab and Gitea have the same calls, so a second host is a second implementation of that small list. v1 is GitHub only.

## 5. A small `git` we own, in the terminal

| Command | Does |
|---|---|
| `git clone <github url> [folder]` | §2, with progress |
| `git status`, `git diff [path]` | §3's list and diffs |
| `git log [path]` | the branch's history, read from GitHub's API in the page |
| `git pull` | §4 |
| `git checkout <branch>`, `git worktree add <folder> <branch>` | §4.1 |
| `git push` | opens §3's list in the page, and prints `Opened Propose changes in the page: review and confirm it there.` |

Anything else: `git <command>: not supported. This is Sagebrush's git: it supports clone, status, diff, log, pull, checkout, worktree add and push. There is no .git folder here.`

## 6. Agents

The `/git` prototype's flow:
- an agent works in its own copy (`/Branches/<agent>/…`), through the workspace verbs and its grant (design/agent-endpoint.md);
- the person reviews its changes file by file, with a note, and accepts some, all or none; accepted files are copied into the git project, and the agent sees the decision through `git_status`;
- an agent never proposes to GitHub, and never sees the token.

## 7. Open questions

- **Private repositories,** after v1, in a short addendum covering: where metadata calls are authorized, the token's single in-memory use on the server or a GitHub App's short-lived tokens, the signed archive link as a credential (never logged or stored), and the redirect rules. Proposal: decide after PR 3, when there's use to learn from.

## 8. The PR sequence

| # | PR | Visible? | Owner | Tests it must carry, besides at-limit and one-over |
|---|---|---|---|---|
| 1 | This design (docs only) | no | sagebrush | |
| 2 | Server: tables, the public import (§2), behind a DEV flag | no (flag) | sync-client | §2.1's malformed, collision, link and type cases; `differs` and a missing tree path; an answer other than 200 refused; a false tree only lists the person's own files as `differs`; GitHub's rate-limit refusal shown; cancel, reset and deadline during the fetch, between batches and before the final transaction, with nothing visible; quota declined mid-import; a finish twice; garbage collection during an import leaves its bytes |
| 3 | Device: what changed, diffs, the frozen proposal, the send (§3) | yes: screenshots to William first | sagebrush + board (UI) | an edit after review withdraws the proposal; a cloud-only change fetched and checked; notebook outputs never sent; a branch name taken; a conflict copy refuses; an agent grant and `git push` can't send |
| 4 | "Update from GitHub" (§4) | yes: screenshots first | sync-client | each §4 row, including a file that becomes `excluded`, and an edit landing between staging and the final transaction |
| 5 | The terminal's `git` (§5), and the agent review flow from `git-proto` (§6) | yes | sagebrush | each command, and an unsupported one |
| 6 | `git checkout` and `git worktree add` (§4.1) | yes | sync-client | bytes already held not stored again; checkout refused with changes |

**More tests each PR must carry (grader):**
- **How races are driven:** cancel, reset and the deadline (during the fetch, between batches, before the final transaction), and an edit between staging and the final transaction, are driven through named test gates (as tiered files' `gateOn`), never by timing; the deadline by a test clock.
- **PR 2:** one refusal per tree-claim rule (a mode outside the four, an id not 40 hex, a folder row, an extra key, a path not a string, a body larger than its `Content-Length` says; and the same lying header at injected `git_project_archive_bytes`); any 3xx from codeload, even to codeload, refused and not followed; an entry inflating past its declared size stops at declared size + 1 byte with nothing visible; a work slice that dies after staging rows and retries from the cursor duplicates neither rows nor reservations; bytes already held are not stored again; cancel returns usage exactly; hidden publication interrupted at every slice exposes nothing and is collected; destination taken, blob lost, membership population at and one past, and changed generation all refuse without visibility; agent grants cannot start/cancel/finish imports; ops carry `github:<import id>`. PR evidence records the maximum one-file slice and hidden-publication load; nightly owns the real 10,000/100,000/repository times and backend envelope (design/fs-sync-scale.md §5).
- **PR 3:** against a fake GitHub with `sagebrush/<name>` and `-2` taken, no update or force call is made and `-3` is created; excluded and unchanged paths are absent from the new tree, a removal is a deletion and nothing else is deleted; no request to Sagebrush's origin carries the token (a network log).
- **PR 4:** a conflict copy whose name is taken gets ` (2)` and overwrites nothing; deleted on GitHub and changed here is kept and shows as added.
- **PR 5:** `git push` makes no GitHub write from the terminal path.
- **PR 6:** stored bytes grow by exactly the differing files (holdings and bytes before and after).

**Not before tiered-files PR 4.** Until fetch-on-open ships, every device downloads every file, so an 8,573-file import would download everywhere. PRs 2 and 3 stay behind the DEV flag until then.
