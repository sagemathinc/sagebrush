# Git projects: a GitHub repository as a Sagebrush folder, and changes proposed back as pull requests

*Status: design, docs only, nothing built. Author: @sagebrush (who built the `/git` prototype, branch `git-proto`), with @sagebrush-sync-client advising on how it sits on tiered files and fs-sync. Reviews: astra (correctness and security), daybreak2 (limits and costs), grader (tests), board (the words people see). Commissioned by William, Nov 8 2026, about 2:50 PM PST: "(a) Recommended: yes, a short design note now (no code), by the /git prototype's author with sync-client advising; usual reviewers".*

*William's direction, Nov 8 2026: "we would not even try to do something like that [a real `git clone`]. The functionality won't exist at all, since real git doesn't. However, we may at least consider having a lightweight 'we own it' git command in our terminal and/or UI, where we own what 'git clone' does… What we really want is to just support what is needed for a agent/human lightweight PR workflow like we prototyped under `/git`."*

*Built on design/tiered-files.md (files "in the cloud", chunks, manifests), design/sync-server.md (the account object, ops, R2 blobs by SHA-256), design/agent-endpoint.md (server-side writes as ops, grants), design/fs-sync.md (its three-way rules and its ignores) and web/gitpush (the branch rules, the token handling).*

## In plain words

- **A GitHub repository can become a Sagebrush folder.** Sagebrush's servers copy the repository's current files, not its history, straight from GitHub into the cloud. Every device then lists every file at once, "in the cloud", and downloads a file only when it's opened.
- **There is no `.git` folder, and no real git.** Sagebrush keeps a small record of which GitHub commit the folder came from. That is enough to show what changed and to propose those changes.
- **Changes go back as a pull request.** "Propose changes" sends the changed files to a new branch named `sagebrush/…` and opens a pull request. It never pushes to `main`, and never force-pushes. Your GitHub token stays on your device.
- **Agents work the way the `/git` prototype showed.** An agent edits files in the folder, and you review its changes file by file before they are proposed.
- **History comes from GitHub when asked.** A file's history, or an older version, is read from GitHub on demand. Nothing about history is stored in Sagebrush.

For scale, William's example: cloning the sagebrush repository with real git transfers 76,406 objects (404.86 MiB) and leaves 8,573 files. A git project copies only the 8,573 current files. Their bytes are stored once in the cloud, and a device downloads only the files it opens.

---

## 1. What a git project is

A git project is an ordinary synced folder plus one row on the server:

```
git_projects
  account       the owning account
  folder_fid    the folder (design/sync-server.md §3's entry id); a rename or move keeps the link
  owner, repo   GitHub names, checked by web/gitpush/rules.ts's parseRepo and SEGMENT
  ref           the branch it follows (GIT_BRANCH)
  base_commit   the GitHub commit the folder's files last matched
  base          per path: the SHA-256 and git blob id of the file at base_commit (a side table, one row per file)
```

- **The base is what makes everything else cheap.** A file changed since `base_commit` is one whose current SHA-256 differs from its `base` row. A device can list every change without downloading anything, because it already holds every file's SHA-256 (the index).
- Removing the row (Settings, "Stop following GitHub") leaves the files as an ordinary folder.

## 2. Copying a repository in (the server)

1. **Ask.** The person (the Files page, "Copy from GitHub", or the terminal's `git clone`, §5) names a repository and a branch. The server reads the branch's commit and the repository's size from GitHub's API. If the size is over the account's free storage quota (design/sync-server.md), it refuses before anything is copied. GitHub's size is an estimate, so each batch checks the quota again and stops the import at it.
2. **Fetch once.** The server downloads GitHub's zip archive of that commit (`/repos/{owner}/{repo}/zipball/{commit}`) into one R2 staging object. A zip archive, not a tar one: its directory at the end lets each later batch read its own files by range, so the work splits into batches with a cursor and resumes after an interruption.
3. **Import in batches.** Each batch (at most 500 files, from a durable cursor) reads its files from the staging object, applies the mandatory ignores (§2.1), computes each file's SHA-256 and git blob id, and stores bytes that aren't already held (blobs by SHA-256; a file over 95 MiB as chunks with a verified manifest, design/tiered-files.md §4.1).
4. **Appear at once.** When every batch is done, one transaction in the account object creates the folder and all its entries, and writes the `git_projects` row and its `base`. Devices see the whole folder at once, every file "in the cloud". If the import fails or is cancelled, nothing appears. The staged bytes are unreferenced, and design/tiered-files.md §5.1's garbage collection removes them.
5. **Report.** Files not copied are listed with a reason, the same skip-and-list rule as design/fs-sync.md §4.5.

### 2.1 What is not copied, and why

- Anything fs-sync's mandatory ignores exclude (design/fs-sync.md §4.4). There is no `.git` in GitHub's archive anyway.
- Symbolic links, and submodules (the archive holds an empty folder for each): listed.
- A file over the workspace's 200 MiB limit: listed. Until tiered-files PR 3 (chunks) has shipped, a file over 95 MiB too.
- Git LFS files arrive as GitHub's pointer files, not their contents: listed with that reason.

### 2.2 The token for a private repository

A public repository needs no token. For a private one, the person's GitHub token is sent with the "Copy from GitHub" request and used for exactly one call, step 2's download. It is never stored and never logged, the same rule as web/gitpush/worker.mjs. Whether a GitHub App would be better than a personal token is open (§7).

## 3. Proposing changes (the device, not the server)

- **What changed** is §1's comparison: added, changed and removed files since `base_commit`, listed with no download. Each file's diff is shown in its own terms, as in the `/git` prototype (notebooks cell by cell, without outputs; boards item by item; LaTeX as source or marked rendering).
- **"Propose changes"** runs in the person's page, with their token, straight against GitHub's REST API (it allows browser requests, so no proxy is needed):
  - one blob per changed file (a changed file is on the device, since it was edited there or arrived from another device that did);
  - one tree on `base_commit`'s tree, removals as deletions;
  - one commit, a new branch `sagebrush/<name>` (web/gitpush/rules.ts's BRANCH: never `main`, never an existing branch it didn't make), and a pull request.
- Files over GitHub's 100 MB limit are listed and left out (gitpush's MAX_FILE rule).
- The token never reaches Sagebrush's servers for this.

**After the pull request merges,** "Update from GitHub" (§4) brings the folder to the new commit.

## 4. Updating from GitHub

"Update from GitHub" copies the branch's newest commit in as §2 does, into staging, and then applies design/fs-sync.md §2.2's three-way rules, with `base` as the base:

- changed on GitHub only: replaced (and stays "in the cloud" unless kept or open);
- changed here only: kept;
- changed in both: both kept, the GitHub one under fs-sync §2.3's conflict name;
- then `base_commit` and `base` move to the new commit, in the same transaction.

## 5. A small `git` we own, in the terminal

The terminal's just-bash gets a `git` command that does only what Sagebrush supports:

| Command | Does |
|---|---|
| `git clone <github url> [folder]` | §2, and waits with progress |
| `git status`, `git diff [path]` | §3's list and diffs |
| `git log [path]` | the branch's history, read from GitHub's API |
| `git pull` | §4 |
| `git push` | opens §3's "Propose changes" in the page (it needs the person's token and review) |

Anything else prints one line: `This is Sagebrush's git: it supports clone, status, diff, log, pull and push. There is no .git folder here.` It never pretends to be real git.

## 6. Agents

The `/git` prototype's flow, kept as it was:

- An agent works in its own copy of the folder (`/Branches/<agent>/…`), through the workspace verbs and its grant (design/agent-endpoint.md).
- The person reviews its changes file by file, with a note, and accepts some, all or none. Accepted files are copied into the git project, and the agent sees the decision through its `git_status` tool.
- An agent never proposes to GitHub itself. Only the person's page holds the token.

## 7. Open questions

- **Private repositories:** the person's token for one request (§2.2), or a GitHub App installation, whose short-lived tokens are GitHub's recommended way for a server? The token is simpler to build now; the App is a better long-term fit if many people use this. Proposal: the token now, the App later if needed.
- **Limits,** for daybreak2: the file count (proposal: 10,000, matching gitpush's COPY_FILES), the staging object's size (proposal: 1 GiB), and the Workers limits on one batch, measured before PR 2 merges.
- **Branches:** v1 follows one branch per folder. Switching branches is copying again into another folder.

## 8. The PR sequence

| # | PR | Visible? | Owner |
|---|---|---|---|
| 1 | This design (docs only) | no | sagebrush |
| 2 | Server: `git_projects`, the import (§2) from public repositories, behind a DEV flag | no (flag) | sync-client |
| 3 | Device: what changed, diffs, "Propose changes" (§3) | yes: screenshots to William first | sagebrush + board (UI) |
| 4 | "Update from GitHub" (§4), and private repositories (after §7's answer) | yes: screenshots first | sync-client |
| 5 | The terminal's `git` (§5), and the agent review flow from `git-proto` (§6) | yes | sagebrush |

**Not before tiered-files PR 4.** Until fetch-on-open ships, every device downloads every file, so an 8,573-file import would download everywhere. PRs 2 and 3 stay behind the DEV flag until then. Each PR carries at-limit and one-over tests, and operation counts.
