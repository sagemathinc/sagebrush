# Git in Sagebrush: a prototype (branch `git-proto`, not for merge)

William's direction (Nov 3, 2026): a git workflow instead of real-time co-editing. Commits are **explicit**: the
person commits `main` when their files are in a meaningful state; an agent commits its own branch once its work is
verified. TimeTravel stays the local insurance; git is what's shared.

## What's here

- `repo.ts`: one git repository in this browser (isomorphic-git on lightning-fs, IndexedDB `sagebrush-git`).
  - `main` is the person's files: everything in the workspace except `/Branches`, `/Trash` and `/Proposals`.
  - `agent/<name>` is an agent's branch. Its worktree is the real folder `/Branches/<name>/`.
  - Documents are committed in a canonical text form, so diffs work by line:
    - notebooks keep cells and their source only, never outputs;
    - boards are their JSON, pretty-printed;
    - files are their bytes.
- `agent.ts`: the agent's three verbs, `workspace.git_branch`, `workspace.git_commit` and `workspace.git_status`.
  - They become sagebrush-mcp tools via `web/workspace/schema.json`, copied to the Python package.
  - They run in the paired page, with the agent's own workspace verbs and grant.
- `page.ts` / `index.html`: the Git page at `/git/`.
  - **main**: your changes since the last commit, Commit (with a message), and History.
  - **agent/<name>**: what the agent changed since it branched, shown in each file's own terms:
    - LaTeX: marked rendered changes or source;
    - notebook: cell by cell;
    - board: item by item.
  - Tick the files you want, then **Accept** (copies the agent's live files into yours and commits main) or
    **Reject**. Either way you can leave a note, and the agent sees your decision and note through `git_status`.

## Try it

1. Build with the LaTeX editor allowed on localhost (`SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts`; a plain build
   offers it only on sagebrush.space), serve it (`python3 web/serve.py 8765`), and open `http://localhost:8765/git/`.
   - Commit your files once: an agent can only branch from a commit.
2. Give your agent this checkout's tools: `web/git/mcp.py` runs the installed sagebrush-mcp (for its compiled
   engine) with this checkout's Python MCP layer, so the three git tools appear without building anything:

   ```
   claude mcp add sagebrush-git -e SAGEBRUSH_MCP_DEV_ORIGIN=http://localhost:8765 \
     -- <the python that has sagebrush-mcp> <checkout>/web/git/mcp.py
   ```

   Then pair your agent on `http://localhost:8765/board/`.
3. Paste the agent text under "For your agent" on the Git page (or just ask the agent to work on its own branch).
4. The agent then:
   - branches;
   - works and verifies under `/Branches/<name>/`;
   - commits with `review: true`.

   The branch shows up on the Git page as "asks for review".

`node /scratch/ux/git-e2e.mjs <port>` drives the whole flow in headless Chromium: commit, branch, edit, commit for
review, accept 2 of 3 files.

## Pairing follows you between pages

Pair once ("Remember this agent" is ticked by default here). Leaving a page lets go of the agent at once, and the
next Sagebrush page (board, Git page, LaTeX editor) reconnects with the remembered session; sagebrush-mcp lets a page
holding that session take over. `node /scratch/ux/pair-nav-e2e.mjs 8766` checks it with the real sagebrush-mcp: pair
on the board, then the Git page, the LaTeX editor, the board, and Back, each with the agent's calls working.

## Not yet

- Line comments that the agent answers.
- Accepting individual cells or hunks.
- Rebasing a stale branch.
- Syncing the repository to the server or to GitHub.
- Merge by cell id: accepting a file replaces yours. Yours stays in TimeTravel, and files changed on both sides are
  flagged.
