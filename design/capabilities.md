# Capabilities: what a board's code may touch

*Status: design, for review (astra audits the gate inventory, §4, against the code in all four modes; daybreak2 the limits). William, Oct 19 2026, 11:48 PDT: "Being able to do this at all is AMAZING ... Let's lean into it!" His answers to the questions are in §11 (Oct 19, 20:04 UTC): "we should always do the work to make sagebrush safer than normal cocalc… Where a choice comes up later, choose the safer one." Nothing here is built yet, except the fallback's rule in §2, built in workspace step 3b.*

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
- **remote resources through output.** Code's output (HTML, Markdown, SVG) is rendered by the page's sanitiser with remote resources off (`safeHtml` and `renderMarkdown` with `remote: false`), which drops any remote URL. That sanitiser is the enforcement, not the page's CSP: the page's policy (and the frame policy) allows `http:` and `https:` images, for the page's own content. Every route by which output reaches the page keeps `remote: false`, and a test checks each route.

**Gated: the person's files.** The first time a board reads or writes a file of the person's workspace outside itself, the page asks, naming the file or folder, and read or write (§5). The answer is remembered for that board, scoped by folder, and can be revoked (§6).

**Notebooks too** (William, §11). A notebook is gated as a board is: notebooks lose their blanket access to all the person's files. A notebook or board **the person made here**, in this site's own UI, gets read and write on its own folder without asking (§6, "Provenance" and "Its own folder") and asks for anything else. Any other document (uploaded, dropped, opened from a link, made by an agent, copied from one of these, or made before this is built) asks for everything.

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

Every byte of a person's file then comes through one page-side call, and every call is made by a **principal**:
- **The principal is bound by the page, never claimed by the worker.** It is the document whose interpreter the worker is (its ref) and that worker's start, fixed when the page makes the worker and its broker channel. Every request on that channel is that principal's. Nothing in a request names who is asking.

The calls:
1. **Reading.** The worker's file system (web/shims/fs.ts) asks the page for the bytes, synchronously. It reuses the broker the runner already has for a shared collection's files: two SharedArrayBuffers, the worker waiting on `Atomics.wait` (design/runner.md, step 4).
2. **The page decides in that same call.** It resolves the path to a workspace entry, checks the principal's grant on the entry's identity, and asks the person if there is none (§5). It then sends the bytes, or an error that becomes `PermissionError` in Python.
3. **Changing: writing, creating, renaming, removing, making or removing a folder.** Each is **one structured call that commits or fails as a whole, and answers before the worker goes on** (§2a). No change is kept from a one-way message: today's `fsChanged` no longer carries the person's files.

### 2a. Changes: identity at use, atomic, acknowledged

One page call isn't atomic by itself: another tab, the file browser or an agent can change the workspace between the call's steps. So each change is made like this:
- **Under the workspace's lock.** The whole call (resolve, check the grant, change, record) holds the workspace's lock (`locked()`, a Web Lock, so one change at a time in all of this browser's tabs). Nothing is checked in one call and used in another. The lock stops interleaving, but not a partial commit on a crash or a quota error: that is the next point.
- **In one database, in one transaction** (astra's CORR-CAP-2). Today a data file's bytes are in the `sagebrush` database (`files`), while the index, versions and Trash are in `sagebrush-workspace`. A change spanning both can't commit or fail as one, whatever lock is held. So:
  - **the bytes move:** data files' bytes go into `sagebrush-workspace`, in a store of their own (`fileBytes`, keyed by the entry's content key), beside the index. Every change the gate makes (bytes, index entry, version, Trash, ops record) is then **one IndexedDB transaction** of one database. A crash, a closed tab or a quota error aborts it whole: nothing of it is visible, and the answer to the worker is the error;
  - **what code may change is only what lives there.** Code may create, write, rename, move and remove **data files** and **folders**. A board or a notebook is read-only to code: writing over one, removing one, or renaming one is refused (`PermissionError`). Removing or renaming a folder that holds a document is refused for code (the person does that in the file browser). So no change by code touches the `sagebrush` database's notebooks;
  - **staged bytes stay in the page** until the commit: chunks crossing from the worker are held in page memory (bounded, §8), never written to the database before the commit's transaction, so there is no partial durable state to recover;
  - **the migration** (§2b) moves existing bytes incrementally, after the workspace opens, never inside the upgrade.
  - **Crash tests:** the browser killed (the process, not the page closing politely) before the commit and during the commit transaction, then reopened: each change is there whole or not at all, and the index and bytes agree. A quota error injected into the commit transaction: nothing visible, and the worker's call fails with it.

### 2b. The migration: incremental, budgeted, resumable

Existing workspaces can hold many files and many bytes, so moving them is bounded work, done a little at a time (daybreak2's LIMIT-A9F-1).
- **The upgrade changes the schema only.** The database's version upgrade creates `fileBytes`, the index on `lastUsed` for grants, and the migration's checkpoint in `meta`. It copies no bytes and walks no entries, so opening the workspace takes as long as it does today. Folders' `fid`s (§6) are given by the migrator too, in the same batches, before any folder grant can exist (step 3).
- **Reads work throughout.** An entry marked `migrated` is read from `fileBytes`; any other from `sagebrush`/`files`, as today. A write to a file not yet migrated writes the new bytes to `fileBytes` and marks it migrated, in the change's one transaction (§2a); its old copy is then stale, and the migrator deletes it.
- **One migrator per workspace.** It runs in one tab at a time, under a Web Lock of its own (`sagebrush-workspace-migrate`, taken with `ifAvailable`, so other tabs don't wait for it). Each batch also holds the workspace's lock, so it never interleaves with a change, and releases it between batches.
- **Batches are bounded:** at most 32 files and 64 MiB of source bytes per batch (a single larger file is a batch of its own), and at most 2 seconds of wall time: the batch ends after the file in progress. Between batches the migrator yields (`setTimeout`, then a wait for idle), and a broker request or a person's change waiting for the workspace's lock goes first.
- **Its memory is the page's read reservation's** (§8). Before reading a file's old bytes, the migrator reserves its indexed size, times the transient-copy multiple step 2 measures, against the same page-wide reservation the broker's reads use. **It takes the reservation before the workspace's lock, never while holding it** (astra): a reader holding reserved memory may be waiting for that lock, so waiting for memory with the lock held could wait for good. Holding the lock, it rechecks the entry's size against what it reserved, and if the file grew, releases both and starts the file again. It waits behind broker reads, never beside them, so the page's ceiling stays one stated figure: the reservation (256 MiB, or one file's reserved size if that is larger, held then by that file alone), plus the brokers' 32 MiB of buffers. The reservation is released in a `finally`.
- **Quota first.** Before each file, the migrator checks the browser's estimate (`navigator.storage.estimate()`) for headroom of the file's size plus 16 MiB. Without it, or on a quota error in the target transaction:
  - the migration pauses; the old copy stays authoritative and the workspace works as before;
  - the Storage panel says "Moving your files' storage is paused: storage is full";
  - it tries again only after something frees space (emptying Trash, removing files or versions, in this page) or at the next open. It never loops.
- **Each file, one step at a time.** IndexedDB has no transaction across the two databases, so:
  1. under the workspace's lock, read the entry (its size and revision) and its old bytes;
  2. check the bytes' `byteLength` equals the indexed size. If not, the entry is marked to repair, skipped, and listed in the Storage panel: the old copy stays authoritative;
  3. in **one** transaction of `sagebrush-workspace`: put the bytes in `fileBytes`, and mark the entry `migrated`, with its size and the bytes' SHA-256 (computed from the same buffer). The entry's revision must still be the one read in 1, or the transaction is abandoned and the file comes up again later;
  4. after that commits, verify it: the entry's marker and the `fileBytes` key are there (`getKey`, which reads no bytes). IndexedDB's commit is atomic, so the marker and the bytes stand or fall together;
  5. only then delete the old copy from `sagebrush`/`files`, in a transaction of that database.

  A crash before 3 changes nothing. A crash between 3 and 5 leaves both copies, with the new one authoritative, and the next batch finishes it from step 4. A failed step 3 leaves the old copy authoritative.
- **Its bookkeeping is bounded, and it finishes in spite of renames** (astra's CORR-CAP-46A-1). The checkpoint is the last path done (`meta`, written with each batch's step 3). The migrator walks the index with an IndexedDB cursor from it and never holds a list of all files. But a path isn't an identity: a file or a folder renamed or moved meanwhile to a path behind the cursor would be passed over. So:
  - **a pass is one walk of the whole index**, from the first path to the last, doing what each entry still needs: a data file not `migrated`, its stale old copy after it is, a folder without its `fid`, a lookalike name not yet listed. "What it needs" is read from the entry itself under the lock, never from the checkpoint;
  - **the migration is complete only when a whole pass, from the start, found nothing to do.** Until then, the migrator starts another pass from the first path (batches and budgets as above). Only that marks it done in `meta`, and only then does the Storage panel stop showing it;
  - **after it is done, nothing new needs it.** New data files are written to `fileBytes` and new folders get a `fid` when made, so a renamed entry can't fall behind a finished migration;
  - **each pass makes progress or ends it.** A pass does every entry it sees that needs work; only an entry moved behind the cursor during the pass waits for the next one. With nobody renaming, the second pass at most finds nothing. A person renaming the same file behind the cursor over and over delays only that file, and only while they do;
  - a reopened page resumes the pass in progress at its checkpoint, and the rule above still applies: done only after a whole pass found nothing.
- **Tests:**
  - the largest workspace (100,000 entries, files up to the cap, a total near a test quota set with `Storage.overrideQuotaForOrigin`);
  - quota exhausted mid-migration, then space freed;
  - the process killed at each step of the per-file protocol, and repeatedly killed and reopened;
  - two tabs: one migrator, the other reading and writing throughout;
  - the browser closed during each phase;
  - two tabs, deterministically: the migrator paused after a batch; the other tab renames a file not yet migrated, and moves a folder without its `fid`, to paths behind the checkpoint; the migrator resumed, and killed and reopened: the migration completes, the file migrated and its old copy deleted, the folder given its `fid`;
  - daybreak2's: the event loop's longest task and delay recorded while the largest single file migrates (its SHA-256 included); the reservation taken before the old bytes are read; a migrator queued behind another holding only its checkpoint.

  Each asserts bounded open time (the page usable as fast as without a migration), bounded memory (the page's heap within the reservation plus its baseline), and progress (each batch commits at least one file, unless paused for quota).
- **On the identity the worker saw.** When code opens a file, the page answers with the entry's identity (`fid`) and revision. Its change then names them:
  - **writing an existing file** carries the expected `fid` and revision. If the file is now another one (replaced, removed and remade) or has changed since, the write fails with an error (Python `OSError`, "changed since it was opened"). It never writes over a file it didn't open;
  - **creating** names the parent folder's identity and the new name, and fails if that name now exists (`FileExistsError`). There is no silent overwrite. `open(path, "w")` on a name that didn't exist when it was opened creates; on one that did, it writes that `fid`;
  - **renaming and moving** are one call (`from` identity, `to` parent identity and name). It doesn't replace an existing name unless the code asked to (`os.replace`), and then only with write on what it replaces. It is not a remove and a write;
  - **making and removing a folder** are calls of their own, with the same check and the same answer. (Today `mkdir` and `rmdir` report no change at all.)
- **All or none.** A change touching several entries (renaming or removing a folder, which changes every path under it) is one transaction: every entry changes, or none does.
- **Acknowledged.** The worker's file system reports success to Python only after the page's answer says the change is committed. A refusal (no grant, the identity changed, the storage full, a bound in §8) reaches the code as the error of the very call that made it: `close()`, `flush()`, `os.rename()`, `os.mkdir()`. Bytes being written cross to the page in the broker's chunks before that answer, and count against the write queue's bound (§8) while they wait.
- **Told to the others, under their own grants.** After a change commits, other interpreters on the page hear of it only if they may read that entry (§4, the page's own paths).

**Where the runner isn't there, the gate can't hold.** The page then falls back to a plain worker with the page's own origin:
- offline, where a service worker doesn't serve a sandboxed frame;
- a runner that doesn't answer (its frame times out, fails, or its interpreter says nothing);
- `?runner=0` on a loopback host, for tests;
- the desktop app, **for now**. William: the desktop app should be "faster and more memory than running in browser, but still safe", so it will host the sandboxed runner and get the same gate (§10, step 5). Until then it is a fallback like the others.

Such a worker could open the browser's storage itself. So there:
- **a document brought in from elsewhere keeps the interim rule:** its code waits for "Run this board's code" (below);
- **a document the person made here runs** (provenance `"person"`, §6), since its code is the person's own. The page still gives it only what the rules above give it, but that isn't a boundary there. Any other document, unknown provenance included, waits for "Run";
- **no grant is used** by a fallback worker. A grant is for a principal in the runner, so the page doesn't act on one for a worker that could read storage itself.

**Giving up the runner never runs what was waiting for it** (astra's CORR-CAP-4). When the page gives up the runner, a run or a question already sent to it is not replayed into the fallback. A run is answered as not run, saying why and to run it again. A question is answered as skipped. Only what isn't code (the files) is given to the fallback. What runs there after that is what the person runs again. This is built in workspace step 3b (web/notebook/runner-worker.js, tested by test-runner-fallback.mjs).

The page says which applies ("This board's code is paused: files can't be protected here"). "Every board runs on open" holds only where the gate does.

## 3. Lessons from Deno's permission model, and how each is handled

@sagebrush checked Deno's tracker and advisories; each lesson below is designed against.

| Deno's lesson | How it's handled here |
|---|---|
| **Symlinks and path traversal.** A grant scoped to a folder escaped through a symlink inside it (deno #4437; PR #12554 then required full read and write to create symlinks; scoped symlinks are still open in #35031). | The workspace's file system has **no links** of any kind (web/workspace/api.ts; web/shims/fs.ts has no symlink, link or readlink). Paths are normalised before anything (`normPath`; the worker's `resolve` folds `..` within `/`). A grant names an **entry's identity** (a file's `fid`, a folder's `fid`, §6), never a path string, and is checked after resolving. **If links are ever added:** a link is followed before the check, the grant needed is its target's, and making a link needs write on both its folder and its target. |
| **TOCTOU.** NDSS 2025 found symlink check-then-use races that make fine-grained control ineffective. | The check is **at the use**, inside the same page-side call that reads the bytes or makes the change, under the workspace's lock and on the entry's identity at that moment (§2a). No path is checked in one call and used in another, and a change names the identity the code opened. The worker never holds a token it could replay: a grant lives on the page, keyed by the principal's document and the entry. |
| **Unicode normalisation mismatch** (a Deno advisory on APFS: the check and the use saw different forms of one name). | **Names are kept exactly, and lookalikes can't be made.** The workspace's `normPath` folds slashes and `..` but doesn't normalise Unicode (astra checked: a composed and a decomposed "é" are two names). So:<br>• **exact names everywhere:** the check, the display and the use all take the entry the index has under the exact string. The page resolves the worker's path once, to an identity, and everything after uses the identity;<br>• **no new lookalike:** making or renaming an entry is refused when its name's NFC form equals a sibling's NFC form ("a name that looks the same is already here");<br>• **existing lookalikes** (made before this rule) are found by the migrator's pass (§2b), folder by folder. They are listed in the Storage panel, and the prompt marks such a name, showing its code points, so the person can tell them apart. Both entries keep working. |
| **Prompt spoofing** (CVE-2024-27936, after CVE-2023-28446: the prompt showed a stripped string but granted the raw one). | The prompt is **drawn by the host page, outside the runner's frame**, so code can't draw a fake one or draw over it. It shows the entry's **canonical path from the workspace index** at decision time (never the string the code passed), set as text (escaped by construction), with its kind and size. It grants **exactly that identity**. |
| **Exemptions and pre-prompt loading.** Deno's URL imports bypassed the checks, and dependencies resolved before the permission system applied. | **No exemption:** imports of workspace modules, data files and images all go through the gate (§4). A worker starts with nothing of the person's, so nothing is resolved before the gate exists. |
| **Coarse grants and prompt fatigue.** "allow-all" hollows the model out, and frequent prompts train people to say yes. | **Ask rarely, grant narrowly:** scope by folder, remember per document, batch a run's requests into one prompt, and remember a denial for the rest of the page's life without asking again. There is **no "allow everything"**: the workspace's top can't be granted, only a folder in it or a file. A revoke list (§9) shows every grant. |

## 4. The gate inventory: every path to the person's files

**One claim to audit:** every way code reaches a file goes through the worker's file system (web/shims/fs.ts), whose reads and writes of the person's files go through the page (§2). The table lists the paths known; astra audits it against the code in all four modes, and anything that reaches bytes another way is a hole to close before step 1 ships.

| Mode | Paths | How they reach the gate |
|---|---|---|
| Python | `open`, `io`, `os` (stat, listdir, scandir, walk, remove, rename, mkdir, …), `pathlib`, `shutil`, `glob`, `fileinput`, `csv`, `json.load` on a file | the runtime's `fs` shim (web/shims/fs.ts: `readFileSync`, `statSync`, `readdirSync`, `writeFileSync`, `renameSync`, …) |
| Python | `import` of a module in the workspace (`import mymodule` from a `.py` file there) | the import system reads the file through the same shim, so it is a read under the gate like any other |
| Python libraries | NumPy `load`, `save`, `loadtxt`, `savetxt`, `genfromtxt`, `fromfile`, `tofile`; matplotlib `savefig` (and its PNG writer); `pickle` on a file | through Python file objects (`open`, `io`: `_fs` in src/runtime/modules.ts, which calls the shim), so through the shim. Imports read through the same `fs` (src/compile.ts; the browser bundle resolves it to the shim). Confirmed by astra's audit |
| Python libraries, not present | pandas and PIL | **no implementation at this baseline**, so nothing to certify. When one is added, it must reach files only through Python file objects, and the audit of that addition checks it |
| Sage | `open`; `load`, `attach`, `save` (lib/sage_all.py) | `open` is Python's, so through the shim. `load` and `attach` check that the file exists, then raise `NotImplementedError`; `save` always raises. So today they read nothing (the existence check is a `stat`, through the shim). When implemented, through Python file calls |
| Magma | `Read`, `Write`, `PrintFile`, `load`, `Open` and the file-stream intrinsics | **absent at this baseline**: the names are only in Magma's list of names (lib/_magma_names.py), with no implementation, and src/magma.ts rejects `load` explicitly (astra confirmed). When implemented, through Python file calls |
| MATLAB | `load`, `save`, `fopen`, `fread`, `fwrite`, `fprintf` to a file, `fgetl`, `readmatrix`, `writematrix`, `csvread`, `dlmread`, `imread`, `imwrite`, `exist`, `dir`, a function file's lookup and `run` of a script (lib/_matlab.py, `_matlab_files.load`) | Python file calls, so through the shim |
| Wasm modules | the PNG module (src/runtime/raster.ts) | made with no imports (`{}`): it has no file system of its own and is given bytes by Python or JavaScript. Confirmed. Any later module with imports is audited the same way |

**The page's own paths.** The shim isn't the only way bytes reach a worker: the page sends some itself. Each is gated **per principal**, with the same check as the broker's:

| Page path (today) | With the gate |
|---|---|
| **Startup** (`sendFiles`, index.html): every data file sent to a notebook's interpreter when it starts | removed. A worker starts with only its own document's files and its granted scopes' listings (§2); bytes come through the broker on demand |
| **A file put** (`filePut`): a file changed by the page (an upload, the file browser) sent to **every** live interpreter (`fsPut` broadcast) | sent only to the interpreters whose principal may read that entry. The others hear nothing |
| **A worker's change, told to the others** (`fsChanged` fan-out in `makeKernel`: one interpreter's write sent to the page's other interpreters) | A's change to F reaches B only if B may read F. **An A-only grant never feeds B**, by this fan-out or any other broadcast |
| **TimeTravel's journal** (`replayFiles`, `filesSent`, `fileEvent`): the files a run read, recorded and given again when it is replayed | a replay gives a worker only what its own document's journal recorded, and only while the principal can still read those entries. Otherwise the replay says the file is no longer available to it |
| **The desktop app's disk** (`diskFiles`, `writeDisk`): files from the person's disk folder sent in, and changes written back | the same gate, on the desktop app's own index, once it hosts the runner (§10, step 5). Until then, a fallback (§2) |
| **A shared collection's files** (the broker's `brokerFetch`, RunnerWorker's `fetchFor`): fetched for the worker by URL | unchanged, and listed for the audit: the page fetches only the engine's own files (a fixed pattern under the site's base) and the collection's files it was told to mount, per worker. No other URL |
| **Output and file loaders**: a picture that code wrote, shown by the page; a notebook's `.sbreplay` resume reading its recorded files | the page reads the workspace for them under the principal's grant, as the broker does |

Each page path gets a test, per principal: B is refused what only A may read.

**Not the person's files, and not gated:**
- the worker's scratch folder (`/tmp`), which is the board's own. Today's `fsChanged` keeps any path outside `/$pyjs`; with the gate, writes under `/tmp` stay in the worker and are never kept;
- the runtime's own library under `/$pyjs`;
- the board's bundled pictures;
- a shared collection the person opened, which is read-only.

## 5. The prompt

- **Drawn by the page**, in its own layer above the board, outside the runner's frame. It is modal for the board, not the page, so the person can still read the board while deciding.
- **What it says:**
  - "**This board wants to read** `/Data/survey.csv` (12 KB)", or "…**read and change** the folder `/Data/` (34 files)";
  - the document's name, so it's clear which board or notebook asks;
  - the path is the workspace's canonical path at that moment, set as text.
- **Choices:**
  - **Allow for this board** (remembered);
  - **Allow once** (until the page closes);
  - **Don't allow** (remembered for this page's life, without asking again).
  - Write includes read.
- **Batched, but never merged across documents.** While a prompt is open, further requests are added to it ("…and 2 more files"), so one run asks once. Requests are grouped by the document asking (its name above its rows), and each document's rows have **their own choices**: allowing board A's request never allows board B's, even for the same file. A row is `(principal, entry, capability)`: A reading F and B writing F are two rows (CORR-CAP-1).
- **The worker waits** while the prompt is open (`Atomics.wait`). Stop still works: the interrupt flag is separate. Closing the prompt counts as "Don't allow".
- **Scope offered:** the file asked for, or its folder (a checkbox, "the whole folder `/Data/`"), never wider. A request for the workspace's top offers only its files one by one.

## 6. Grants

- **What a grant is:** `{document, capability, scope, mode}`.
  - **document:** the board's or notebook's identity in the workspace (its ref), never its path: the principal's document (§2).
  - **capability:** `files` for now; later `agent`, `sync`, …
  - **scope:** a file's `fid` or a folder's `fid`.
  - **mode:** read, or read and write.
- **Folders get an identity** (CORR-CAP-3). Today only files have a `fid`. Folders get one too: random, 64 bits like a file's, checked against the index when made, and never reused. Existing folders get theirs from the migrator (§2b), in its bounded batches, before any folder grant can exist. A tab still open on the old version is closed by the upgrade (`versionchange`) and says so, as for any version.
  - **Renaming or moving** a folder keeps its `fid`, so its grants follow it.
  - **Removing a folder** (to Trash) ends its grants: they are deleted with it, and restoring it from Trash doesn't bring them back.
  - **Removing a folder, then making one with the same name** makes a new `fid`: the old grants don't apply to it.
- **Provenance: who made a document** (astra's CORR-CAP-5). "Made here" can't be inferred from a missing `origin`: an upload creates its documents with none today. So the index keeps a **host-owned provenance** on each document's entry, `made`:
  - **`"person"`**: made by the person in this site's own UI, with File ▸ New board or New notebook (and the blank board a first visit makes). Only those paths set it, through a workspace call the page uses and nothing else: not the agent API (`forAgent`), not an upload, an import, a drop, Open as…, an example, a link or a conversion;
  - **`"elsewhere"`**: everything else. That includes documents an agent makes (the safer choice: the person's agent still gets whatever it asks for, through the same prompt), examples, and converted copies of a file;
  - **absent: unknown.** Every document that exists when this is built, the Welcome notebook included. Unknown is treated as elsewhere: it asks.
  - Provenance is never read from a document's fields, a file's contents or a URL. It is not in an export or a download, and an import or upload never sets `"person"`.
  - **Copies inherit it.** Duplicate, Save a copy, a conflict copy ("your changes, made while it changed elsewhere"), a version restored as a copy: each gets its source's provenance. A copy of an imported board is still elsewhere, so a copy can't launder imported code into an automatic grant.
- **Its own folder** (William, §11). A document whose provenance is `"person"` gets read and write on **the folder it is in**, without asking. It is an ordinary grant, made when the document is made, shown in the list and revocable. Moving the document later doesn't move or widen it.
  - **Grants are still never copied** (above). A copy gets its own-folder grant only because of its own provenance, at its own creation, for the folder the copy is in. So a copy of a `"person"` board in `/A`, made in `/B`, gets `/B`, not the source's grants. A copy of an `"elsewhere"` board gets nothing.
  - **At the workspace's top**, which can't be granted (§3), it gets instead what it **creates** there: making a new file at the top is allowed without asking, and the file it made is granted to it. Other files at the top it asks for. This is the safer of the two readings (William: "choose the safer one"), and new notebooks are made at the top today.
  - **A file a document creates** in a granted folder is covered by the folder's grant. One it creates with a file grant alone isn't possible: creating needs write on the parent.
- **A folder grant follows the folder.** It covers whatever is inside the folder at the moment of use: renaming the folder moves the grant with it, and moving a file out of it ends the grant for that file.
- **Kept in the workspace's own store** (its `meta`), not localStorage, so that clearing a site's storage clears both together. Grants are not in an export (design/workspace-files.md §7.11) or a copy of the board: Duplicate, Save a copy and uploading the board elsewhere all start with none.
- **Revoked** from the list (§9). A revocation applies at the next use: a run already reading keeps the bytes it has, and is refused the next one.
- **Bounded:** at most 100 grants per board and 10,000 in all. Past that, the oldest unused ones go, and the person is told.

## 7. Defence in depth

- **The worker's network.** The runner's policy already has `connect-src 'none'` (design/runner.md). The downloaded-file runner (web/notebook/files-runner.js) allows `blob:` for its own chunks, which is not a network, and nothing else. Both are kept so: an interpreter escape still reaches no server.
- **Hard limits on the worker:**
  - **heap:** the engine's memory is capped (a maximum on the WebAssembly memory and the interpreter's own collector limit). Past it a run fails with MemoryError, never the page;
  - **CPU:** Stop, always (§9), and the page terminates a worker that doesn't answer Stop within a few seconds. A board that isn't in view gets no new runs started by itself.
- **Every message from the runner is untrusted:** paths, sizes and data are checked on the page before use (design/runner.md, "Next", 1).

## 8. Bounds

The broker, the prompt and the record of activity are part of the boundary: what a worker asks for is untrusted, so each is bounded **before** anything is allocated, copied or kept (daybreak2's LIMIT-CAP-1 and LIMIT-CAP-2).

**The broker:**
- **A request** from the worker (`{op, path}`, and for a write its size) is at most 4 KiB. Its `op` is one of a fixed few, and its path at most 1,024 characters (the workspace's `MAX_PATH`). Anything else is refused before it is read further.
- **One request at a time per worker, enforced by the page.** The page keeps each broker's state (idle, or the one request it is answering) and answers only from idle. A request that arrives while one is being answered is misuse (below): the page doesn't rely on the worker waiting on `Atomics.wait`, since a worker that subverted its interpreter needn't.
- **At most 8 workers per page** have a broker: a page's interpreters (a notebook's kernel, a board's language, and those of the documents shown in it). A ninth interpreter starts without one: it is told "too many interpreters running on this page" for any file it asks for, until another stops. Each broker's buffer is one SharedArrayBuffer of 4 MiB plus a 64-byte header, made when the worker starts and freed when it ends. So the brokers' buffers are at most 8 × 4 MiB = 32 MiB per page.
- **A read:**
  - **Size first.** The size comes from the workspace's index (the entry's `size`) before any byte is read. A file over the workspace's file cap (200 MB, `maxFileBytes`) is refused unread; with the cap at 200 MB, that never happens to a stored file.
  - **Reserved before it is read.** The workspace keeps a file's bytes as one value, so reading it from IndexedDB materializes the whole file in the page. Before that read, the page reserves the file's indexed size against **one page-wide read reservation of 256 MiB**. While the reservation can't hold it, the request waits, first come first served: this is backpressure, since the worker is already waiting. A single file (at most 200 MB) always fits once the others are done. The reservation is released when the last chunk has crossed, in a `finally`, and when the worker is terminated or the page stops it. A worker that stops asking for the rest of a file for 30 seconds loses the file's bytes and its reservation; it is told the read was abandoned.
  - **Chunked.** The bytes cross in the broker's chunks (4 MiB, the SharedArrayBuffer's size), never the whole file at once.
  - **So reads hold at most 288 MiB on the page:** 256 MiB of reserved file bytes, plus 32 MiB of broker buffers. The interpreter's own copy of what it read is in its own memory, bounded by its WebAssembly memory, as it is today.
  - **Later, one chunk per worker.** If the workspace comes to store large files in chunks (one row per 4 MiB), a read reserves one chunk per worker instead, and the page then holds at most 8 × 4 MiB. That change is to storage, so it isn't part of this design.
  - **Rate.** The page has one read budget for all its workers: 512 MB, refilled at 128 MB a second. Each worker also gets at most 64 MB a second of it, so one worker can't take the whole page's rate. Past either limit, the page waits before answering, which is backpressure.
- **A change** (§2a):
  - a write's size is declared first and checked against the file cap before any byte crosses;
  - its bytes cross in the broker's chunks and are staged on the page against the page's write queue, bounded at 256 MiB of bytes waiting (`FILE_QUEUE_MAX`, LIMIT-12C-2), reserved before the first chunk. Past either bound, the change is refused with that answer, and the call fails in the worker. Nothing is held past the bound, and staged bytes are released when the change commits or fails, in a `finally`, and when the worker ends;
  - a folder's rename or removal touches at most a folder's cap of entries (10,000) per level and is one transaction.
- **A listing** (`readdir`, a folder's `stat`) returns at most 10,000 entries (a folder's cap, `maxFolderEntries`) and 1 MiB of names. Past that it is cut, and says so.
- **Misuse ends the worker.** More than 1,000 requests a second, or more than 1,000 refused requests in a minute, terminates it. The board says why and is shown as stopped. Each request is small and synchronous, so a run that asks within these limits never meets them.

**The prompt:**
- **One open prompt per page.** While it is open, further requests from any board are added to it, never to a new prompt.
- **What a prompt holds is capped:**
  - at most 100 requests, coalesced by `(principal, entry identity, capability)`, keeping the widest mode that principal asked (write over read). Requests of different documents are never coalesced (§5);
  - each path at most 1,024 characters;
  - at most 1 GB of requested bytes in all, counted from the index's sizes.

  Past any cap, further requests are refused at once ("too many files asked for at once"), without a prompt. The run can ask again after the person has answered.
- **A folder's size and count** in a prompt come from the index's entries (metadata, no bytes read), counted up to the folder cap: "10,000+ files" past it.

**The Files pill:**
- **A summary, not a log.** It keeps at most 1,000 entries, each `(entry identity, reads, writes, last time)`. Past that it keeps a count ("and 312 more files").
- **Display.** It lists at most 100 rows, the most recent first, each path cut to 200 characters (the whole path in its tooltip). The summary goes when the page closes.

**The grant store:**
- **Admission and eviction are atomic.** A new grant, and the eviction it causes, are one transaction of the workspace's store, under its lock.
- **Bounded:** at most 100 grants per board, and 10,000 in all.
- **"Oldest unused"** is the grant with the earliest `lastUsed`. That time is written when the grant is made, and at most once a minute while it is used, so using a grant writes almost nothing. An index on it finds the oldest in one step.
- **Told.** An eviction is said in the Files pill: "a grant this board hadn't used since … was removed: there were too many".

## 9. The resource pill

**A small pill at the top of the board and notebook pages, with three indicators.** It replaces the per-cell running mark as the primary signal; cells keep their own marks.

- **CPU:** "running" while any code runs, and quiet otherwise. Clicking it lists what is running (the cell or item, across pages), each with a link to it, and **Stop**.
- **RAM:** the worker's heap in use, as a small bar. Its menu has **Stop and reset**, which clears memory and every variable and **doesn't** run anything again; the board shows its code as not yet run, until the person runs it.
- **Files:** a count of reads and writes of the person's files since the page opened ("3 read · 1 written"). Clicking it shows:
  - those files, each with read or written;
  - this board's grants, each with **Revoke**;
  - a link to every board's grants (the workspace's Storage panel).

  With no grants and no file activity, it shows nothing.

The pill is quiet when nothing happens, and never covers the board's content. On a phone it is a single dot that opens the same panel.

## 10. Steps

0. **Done in workspace step 3b:** the fallback never runs what was waiting for the runner (§2).
1. **Identities and storage:** one database upgrade (schema only) for `fileBytes` and the migration's checkpoint; the migrator (§2b, with its tests), which also gives folders their `fid` (§6); documents' provenance (`made`, §6); the refusal of lookalike names, and the list of existing ones (§3).
2. **The gate, and the worker's policy:**
   - the read gate through the broker, with the principal bound by the page;
   - changes as structured, locked, acknowledged calls (§2a), replacing `fsChanged` for the person's files;
   - the page's own paths gated per principal (§4): startup, the file-put broadcast, the change fan-out, TimeTravel's journal, output loaders;
   - notebooks and boards started with only their own files and granted scopes; documents the person made given their own folder (§6, by provenance);
   - `/tmp` writes never kept;
   - the policy checked by a test that fails without it;
   - daybreak2's requirements for the bounds (§8):
     - every workspace write updates the entry's indexed size in the same transaction as its bytes. After an IndexedDB read, the page checks the bytes' actual `byteLength` equals the size it reserved and is within the file cap, before any chunk crosses, so a stale or corrupt index can't take more than its reservation;
     - a write delivers no more than its declared, reserved size: a chunk that would cross it is refused, and the worker ended, before it is accepted. Staging never grows to be reconciled afterwards;
     - on a timeout or the worker's end, the transfer's generation is invalidated **before** its reservation is released, so a late chunk can't run on released credit. Release is idempotent: the `finally`, the timeout and the termination may each call it;
     - measured: whether reading from IndexedDB, or transferring to the worker, makes a second full-size copy for a while. If one does, the reservation charges that multiple of the file's size, and §8's 288 MiB is restated from the measured figure.

   Until step 3 lands, there are no prompts: everything ungranted is refused.
3. **The prompt and grants:** the host-drawn prompt, batching per principal, the grant store and revocation.
4. **The pill.**
5. **The desktop app hosts the runner** (William, §11): a sandboxed frame with an opaque origin and no network, served by the app, cross-origin isolated, with the same broker and gate on the app's own index and disk files. Until it does, the desktop app is a fallback (§2), with the paused rule for documents from elsewhere.
6. **Removing the interim** (3b's paused boards) where the gate holds (§2).

Each step is a branch of its own with its tests, and a test-only check and mutants, as usual.

## 11. Decisions (William, Oct 19, 20:04 UTC)

1. **Notebooks:** "we should always do the work to make sagebrush safer than normal cocalc, thus leaning into the unique advantages we get from our approach." So:
   - a notebook made here gets read and write on its own folder without asking, and asks for anything else;
   - an uploaded notebook asks like a board;
   - notebooks lose their blanket access to all files.

   Where a choice comes up later, the safer one is chosen. One such choice is already made in §6: at the workspace's top, a document gets only what it creates there.
2. **Boards made here:** "Yes, same as notebooks."
3. **The desktop app:** "host the runner: my vision for the desktop app is: faster and more memory than running in browser, but still safe." So it hosts the sandboxed runner and gets the same gate (§10, step 5). The paused rule there is only interim, until it does.
