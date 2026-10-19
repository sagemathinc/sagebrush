# Capabilities: what a board's code may touch

*Status: design, for review (astra audits the gate inventory, §4, against the code in all four modes; daybreak2 the limits). William, Oct 19 2026, 11:48 PDT: "Being able to do this at all is AMAZING ... Let's lean into it!" Nothing here is built yet.*

## 1. The model

**Every board's code runs when the board opens, whatever its source:** made here, uploaded, opened from a link, dropped. This replaces the interim rule that a board brought in from a file opens with its code paused (workspace step 3b), once the gate below is built and only where it holds (§2).

**Always allowed, with no prompt:**
- computation of any kind;
- plots and other output, drawn by the page through its sanitiser (design/security.md);
- the board's own inputs (its ask items, sliders, the person's answers);
- files bundled in the board itself (its pictures), and the files of a shared collection the person opened (design/sharing.md), which are read-only and already arrive through the runner's broker.

**Never available:**
- **the network.** The interpreter has no network API. The runner's policy has `connect-src 'none'` (design/runner.md), so an escape from the interpreter can't reach one either;
- **JavaScript and the page.** There is no `js` module, the worker has no DOM, and the runner's frame has an opaque origin, with no storage and no parent document;
- **remote resources through output.** Output is sanitised, and the page's own CSP refuses remote images and scripts in it.

**Gated: the person's files.** The first time a board reads or writes a file of the person's workspace outside itself, the page asks, naming the file or folder, and read or write (§5). The answer is remembered for that board, scoped by folder, and can be revoked (§6).

**Future capabilities** (the agent API of design/agent-endpoint.md, sync, a project's kernel, any network a board might one day be allowed) are each a named capability, granted through the same gate and listed in the same place. None is implied by another.

## 2. Where the boundary is

**The page is trusted; the runner is not.** The interpreter, its library and everything a board's code imports run in a worker inside the runner, a sandboxed frame with an opaque origin and no network (design/runner.md). Everything that worker can read arrives from the page by message, and everything it writes reaches storage only if the page keeps it.

**So the gate is on the page, at the two places bytes cross:**
- **the read gate:** the page sends a file's bytes into a worker only under a grant;
- **the write gate:** the page keeps a change a worker reports only under a grant.

Neither is in interpreter or library code. A board that subverts its interpreter entirely can still only *ask* for a file. It never receives one the page didn't decide to send.

**Today** (what changes):
- **notebooks:** a notebook's interpreter gets **all** of the person's data files when it starts (index.html `sendFiles`) and every change after (`fsPut`). Every write it makes (`fsChanged`) is kept;
- **boards:** a board's interpreter gets none of them.

**With the gate,** a worker starts with:
- the document's own bundled files;
- the files of granted scopes, as a listing only;
- nothing else of the person's.

Every byte of a person's file then comes through one page-side call:
1. **Reading.** The worker's file system (web/shims/fs.ts) asks the page for the bytes, synchronously. It reuses the broker the runner already has for a shared collection's files: two SharedArrayBuffers, the worker waiting on `Atomics.wait` (design/runner.md, step 4).
2. **The page decides in that same call.** It resolves the path to a workspace entry, checks the grant on the entry's identity, and asks the person if there is none (§5). It then sends the bytes, or an error that becomes `PermissionError` in Python.
3. **Writing, renaming, deleting, making a folder.** The worker asks before it acts, through the same synchronous call. Then, when the bytes come back (`fsChanged`), the page checks the grant again before keeping them, on the entry's identity at that moment (§7, TOCTOU).

**Where the runner isn't there, the gate can't hold.** The page then falls back to a plain worker with the page's own origin:
- the desktop app;
- offline, where a service worker doesn't serve a sandboxed frame;
- a runner that doesn't answer;
- `?runner=0` on a loopback host, for tests.

Such a worker could open the browser's storage itself. So there:
- **a board brought in from elsewhere keeps the interim rule:** its code waits for "Run this board's code";
- **a board made here runs as it does today,** since its code is the person's own.

The page says which applies ("This board's code is paused: files can't be protected here"). "Every board runs on open" holds only where the gate does.

## 3. Lessons from Deno's permission model, and how each is handled

@sagebrush checked Deno's tracker and advisories; each lesson below is designed against.

| Deno's lesson | How it's handled here |
|---|---|
| **Symlinks and path traversal.** A grant scoped to a folder escaped through a symlink inside it (deno #4437; PR #12554 then required full read and write to create symlinks; scoped symlinks are still open in #35031). | The workspace's file system has **no links** of any kind (web/workspace/api.ts; web/shims/fs.ts has no symlink, link or readlink). Paths are normalised before anything (`normPath`; the worker's `resolve` folds `..` within `/`). A grant names an **entry's identity** (a file's `fid`, a folder's entry), never a path string, and is checked after resolving. **If links are ever added:** a link is followed before the check, the grant needed is its target's, and making a link needs write on both its folder and its target. |
| **TOCTOU.** NDSS 2025 found symlink check-then-use races that make fine-grained control ineffective. | The check is **at the use**, inside the same page-side call that reads the bytes or keeps the write, on the entry's identity at that moment. No path is checked in one call and used in another. The worker never holds a token it could replay: a grant lives on the page, keyed by the board and the entry. |
| **Unicode normalisation mismatch** (a Deno advisory on APFS: the check and the use saw different forms of one name). | **One normalisation for all three:** check, display and use go through the workspace's `normPath` (NFC), so the name shown, the name checked and the entry used are the same string. The worker's paths are normalised by the page before lookup, never trusted as given. |
| **Prompt spoofing** (CVE-2024-27936, after CVE-2023-28446: the prompt showed a stripped string but granted the raw one). | The prompt is **drawn by the host page, outside the runner's frame**, so code can't draw a fake one or draw over it. It shows the entry's **canonical path from the workspace index** at decision time (never the string the code passed), set as text (escaped by construction), with its kind and size. It grants **exactly that identity**. |
| **Exemptions and pre-prompt loading.** Deno's URL imports bypassed the checks, and dependencies resolved before the permission system applied. | **No exemption:** imports of workspace modules, data files and images all go through the gate (§4). A worker starts with nothing of the person's, so nothing is resolved before the gate exists. |
| **Coarse grants and prompt fatigue.** "allow-all" hollows the model out, and frequent prompts train people to say yes. | **Ask rarely, grant narrowly:** scope by folder, remember per board, batch a run's requests into one prompt, and remember a denial for the rest of the page's life without asking again. There is **no "allow everything"**: the workspace's top can't be granted, only a folder in it or a file. A revoke list (§8) shows every grant. |

## 4. The gate inventory: every path to the person's files

**One claim to audit:** every way code reaches a file goes through the worker's file system (web/shims/fs.ts), whose reads and writes of the person's files go through the page (§2). The table lists the paths known; astra audits it against the code in all four modes, and anything that reaches bytes another way is a hole to close before step 1 ships.

| Mode | Paths | How they reach the gate |
|---|---|---|
| Python | `open`, `io`, `os` (stat, listdir, scandir, walk, remove, rename, mkdir, …), `pathlib`, `shutil`, `glob`, `fileinput`, `csv`, `json.load` on a file | the runtime's `fs` shim (web/shims/fs.ts: `readFileSync`, `statSync`, `readdirSync`, `writeFileSync`, `renameSync`, …) |
| Python | `import` of a module in the workspace (`import mymodule` from a `.py` file there) | the import system reads the file through the same shim, so it is a read under the gate like any other |
| Python libraries | NumPy `load`, `save`, `loadtxt`, `savetxt`, `genfromtxt`, `fromfile`, `tofile`; pandas `read_*` and `to_*`; PIL `Image.open` and `save`; matplotlib `savefig`; `pickle` on a file | through Python file objects, so through the shim; to verify per library that none keeps a file system of its own |
| Sage | `load`, `attach`, `save`, `load` of `.sobj`, `open` (lib/sage_all.py) | Python file calls, so through the shim |
| Magma | `Read`, `Write`, `PrintFile`, `load`, `Open` and the file-stream intrinsics | at master 0668b306, none of these is implemented in lib/_magma.py (`PrintFile` is only in the list of Magma's names, lib/_magma_names.py); to confirm in the audit. When they are, through Python file calls, so through the shim |
| MATLAB | `load`, `save`, `fopen`, `fread`, `fwrite`, `fprintf` to a file, `fgetl`, `readmatrix`, `writematrix`, `csvread`, `dlmread`, `imread`, `imwrite`, `exist`, `dir`, `run` of a script (lib/_matlab.py, lib/_matlab_files.py) | Python file calls, so through the shim |
| The page, for the code | a notebook's `.sbreplay` resume reading its recorded files; output that names a file of the person's (a picture written by code, then shown) | the page reads the workspace itself, so these calls go through the same check, with the board as the asker |
| Wasm modules | the PNG module (src/runtime/raster.ts) and any module with its own file system | **to audit:** a module given bytes by Python is fine; one with its own file access must go through the shim |

**Not the person's files, and not gated:**
- the worker's scratch folder (`/tmp`), which is the board's own. Today's `fsChanged` keeps any path outside `/$pyjs`; with the gate, writes under `/tmp` stay in the worker and are never kept;
- the runtime's own library under `/$pyjs`;
- the board's bundled pictures;
- a shared collection the person opened, which is read-only.

## 5. The prompt

- **Drawn by the page**, in its own layer above the board, outside the runner's frame. It is modal for the board, not the page, so the person can still read the board while deciding.
- **What it says:**
  - "**This board wants to read** `/Data/survey.csv` (12 KB)", or "…**read and change** the folder `/Data/` (34 files)";
  - the board's name, so it's clear which board asks;
  - the path is the workspace's canonical path at that moment, set as text.
- **Choices:**
  - **Allow for this board** (remembered);
  - **Allow once** (until the page closes);
  - **Don't allow** (remembered for this page's life, without asking again).
  - Write includes read.
- **Batched.** While a prompt is open, further requests from the same run are added to it ("…and 2 more files"), so one run asks once.
- **The worker waits** while the prompt is open (`Atomics.wait`). Stop still works: the interrupt flag is separate. Closing the prompt counts as "Don't allow".
- **Scope offered:** the file asked for, or its folder (a checkbox, "the whole folder `/Data/`"), never wider. A request for the workspace's top offers only its files one by one.

## 6. Grants

- **What a grant is:** `{board, capability, scope, mode}`.
  - **board:** the board's identity in the workspace (its ref), never its path. A notebook's is likewise its ref.
  - **capability:** `files` for now; later `agent`, `sync`, …
  - **scope:** a file's identity (`fid`) or a folder entry's.
  - **mode:** read, or read and write.
- **A folder grant follows the folder.** It covers whatever is inside the folder at the moment of use: renaming the folder moves the grant with it, and moving a file out of it ends the grant for that file.
- **Kept in the workspace's own store** (its `meta`), not localStorage, so that clearing a site's storage clears both together. Grants are not in an export (design/workspace-files.md §7.11) or a copy of the board: Duplicate, Save a copy and uploading the board elsewhere all start with none.
- **Revoked** from the list (§8). A revocation applies at the next use: a run already reading keeps the bytes it has, and is refused the next one.
- **Bounded:** at most 100 grants per board and 10,000 in all. Past that, the oldest unused ones go, and the person is told.

## 7. Defence in depth

- **The worker's network.** The runner's policy already has `connect-src 'none'` (design/runner.md). The downloaded-file runner (web/notebook/files-runner.js) allows `blob:` for its own chunks, which is not a network, and nothing else. Both are kept so: an interpreter escape still reaches no server.
- **Hard limits on the worker:**
  - **heap:** the engine's memory is capped (a maximum on the WebAssembly memory and the interpreter's own collector limit). Past it a run fails with MemoryError, never the page;
  - **CPU:** Stop, always (§8), and the page terminates a worker that doesn't answer Stop within a few seconds. A board that isn't in view gets no new runs started by itself.
- **Every message from the runner is untrusted:** paths, sizes and data are checked on the page before use (design/runner.md, "Next", 1).

## 8. The resource pill

**A small pill at the top of the board and notebook pages, with three indicators.** It replaces the per-cell running mark as the primary signal; cells keep their own marks.

- **CPU:** "running" while any code runs, and quiet otherwise. Clicking it lists what is running (the cell or item, across pages), each with a link to it, and **Stop**.
- **RAM:** the worker's heap in use, as a small bar. Its menu has **Stop and reset**, which clears memory and every variable and **doesn't** run anything again; the board shows its code as not yet run, until the person runs it.
- **Files:** a count of reads and writes of the person's files since the page opened ("3 read · 1 written"). Clicking it shows:
  - those files, each with read or written;
  - this board's grants, each with **Revoke**;
  - a link to every board's grants (the workspace's Storage panel).

  With no grants and no file activity, it shows nothing.

The pill is quiet when nothing happens, and never covers the board's content. On a phone it is a single dot that opens the same panel.

## 9. Steps

1. **The gate, and the worker's policy:**
   - the read gate through the broker, and the write gate on keeping;
   - notebooks and boards started with only their own files and granted scopes;
   - `/tmp` writes never kept;
   - the policy checked by a test that fails without it.

   Until step 2 lands, there are no prompts: everything ungranted is refused, and notebooks made here keep their own folder (§10).
2. **The prompt and grants:** the host-drawn prompt, batching, the grant store and revocation.
3. **The pill.**
4. **Removing the interim** (3b's paused boards) where the gate holds (§2).

Each step is a branch of its own with its tests, and a test-only check and mutants, as usual.

## 10. Questions

1. **Notebooks.** Today a notebook sees all of the person's files. Under this model, a notebook brought in from elsewhere is someone else's code, as a board is. My proposal:
   - a notebook *made here* gets read and write on its own folder without asking, and asks for anything else;
   - an uploaded notebook asks like a board.

   That changes what notebooks people have now can do, so it needs William's decision before step 1.
2. **Files written by a board into its own folder.** Should a board made here likewise get its own folder without asking? My proposal: yes, the same as notebooks.
3. **The desktop app.** The gate needs the runner (§2). The desktop app could host the runner too, as a local sandboxed frame; until then, it keeps the paused rule for boards from elsewhere.
