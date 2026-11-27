# Remote r3: the native app's backend, headless on your computer

The approved design (r3.3, reviewed for security, limits and sync), kept here as the reference the implementation steps name. One wording correction since its review: the example of a refused cloud-save replace (Save to cloud, Quota). Examples name the connected computer "mybox".

Status: frozen (r3.3). It supersedes r3.2 (8c446b72) and answers its reviews, marked **(r3.3)**:
- SEC: H4 and H5 CLEAR; the HOLD on save to cloud (S1 a pinned plaintext identity for commit and resume, S2 safe fetch and replace, and the agent grant verbs);
- sync: C1 CLEAR with a failed status read counted as transient; S1 the sync-before-start position (own writes, namespace, conflict copies), S2 a save holds its chunks, S3 the ignore file's direction and locality;
- LIMITS: DESIGN CLEAR on r3.2, with implementation acceptance terms for save to cloud and fetch, added as a contract; and a correction: there is no daily upload field in the plan today, so the daily upload budget is new plan, quota and meter work.

r3.2 superseded r3.1 (8835e6ba) and added, marked **(r3.2)**:
- sync's condition C1 on H5, with SEC's choice (option b): the relay re-reads sync status every 5 s while legs are open, which is the maximum sync-revocation window; and sync's wording fix (the host's `sagebrush remote status`);
- William's refinement of D1 (Nov 26, about 8:48 AM PST): one kernel entry per engine language plus Native (Python), with K per entry and H4 binding the entry;
- William's two acceptance stories (a Magma notebook on a big machine; PyTorch on a GPU machine), with sync-before-start, a "this computer only" ignore file with defaults, "Save to cloud", and the warning before deleting a machine;
- missing items 7 (the native engine subprocess, past WebAssembly's 4 GiB) and 8.

r3.1 superseded r3 (38c286ee) and answered the reviews of r3:
- sync's REVISE: R1, the disk-to-sync direction, and R2, the churn rule, plus its notes;
- SEC's HOLD: H4, the kernel kind bound everywhere, and H5, the sync gate held for the whole connection, plus its D2 condition;
- LIMITS' DESIGN CLEAR: its acceptance terms are added as the implementation contract. The K and ledger text is unchanged.

r3 superseded r2 (f74fd3c3) and answered its SEC hold (H1–H3, the socket conditions) and its LIMITS hold (H1). William's decisions D1 and D2 are taken (Nov 26, about 8:24 AM PST: "yes definitely. this seems ideal."). Nothing here is built.

Changes from r3 are marked **(r3.1)**.

## The model

William (Nov 26, 09:03Z): "sagebrush on a remote should appear to the user nearly exactly like if they were running the sagebrush native app literally on that remote machine. That's the model." And earlier (09:00Z): "run sagebrush on that computer instead of in your browser", with pros and cons.

So:

- `sagebrush remote` runs **the native app's backend, headless**, on that machine. The browser page is its window.
- A workspace runs in **"This browser"** or on **"mybox: ~/project"**. The header says which, one switch changes it for the whole workspace, and every editor follows. There are no per-notebook pickers.
- Whatever the native app does locally, the remote workspace does the same way, with the **same code paths**: kernels labelled "Native" (not a separate Remote kind), the workspace's real files, and the same engine and protocol. Behaviour matches the app by construction, because it is the app's code.
- Behind the header, a pros and cons panel:
  - **On mybox:** mybox's files, CPU and memory and, with the "Native (Python)" kernel (r3.2's name), its GPU and installed software. It needs mybox online and `sagebrush remote` running there, and code runs as your account on mybox.
  - **(r3.1) Files your code writes on mybox:** "Files your code rewrites constantly sync their latest version at most every 1 min (change this in the workspace settings), and each synced version is kept. Notebooks, boards and chats on mybox are written by Sagebrush: edit them here, not with another program on mybox."
  - **This browser:** works offline, needs nothing installed, and nothing leaves the browser; the browser's limits apply.

## D1, decided: both kernels, in the app and on remotes

The native app's kernel today is **the Sagebrush engine in a Node process** (`app/engine`): the same pyjs-plus-WebAssembly interpreter as the browser, faster and with the machine's memory. It does **not** run the machine's own CPython, so it can't import installed packages or use a GPU. Today's remote runner, by contrast, runs the machine's CPython (`child.py`), which is why William saw his GPU in the terminal and could expect `import torch` to work.

"Exactly like the native app" and "the computer's GPU and installed software" pull apart here. The native-app design (design/native-desktop.md §4.3) already plans both: "Your computer" offers **the engine and the CPython runner**. r3 proposes the same for the app and the remote host, so they stay identical:

- **"Native (Sagebrush)"**: the engine. Sagebrush's Sage, Magma, MATLAB and Python modes, exactly as in the app.
- **"Native (this computer's Python)"**: the machine's CPython: installed packages and GPU.
- The workspace picks a default, and a notebook's kernel menu offers the two, as kernels and not as places.

**Decided (William, Nov 26): both.** Every "Native" workspace, whether in the desktop app or on a remote, offers the two kernels: "Native (Sagebrush)" (the engine, exactly as in the app) and "Native (this computer's Python)" (the machine's CPython: installed packages and GPU). The workspace picks the default, and a notebook's kernel menu offers the two as kernels, not as places. The app and remotes stay identical by construction.

**(r3.2) Refined (William, Nov 26, about 8:48 AM PST): one entry per engine language, plus the machine's Python.** "Native (Sagebrush)" is not one kernel. The kernel menu offers five entries, in the app and on remotes alike:

| Entry | What runs |
|---|---|
| Native (Sagebrush Python) | the engine in its Python mode |
| Native (Sagebrush Sage) | the engine in its Sage mode |
| Native (Sagebrush Magma) | the engine in its Magma mode |
| Native (Sagebrush MATLAB) | the engine in its MATLAB mode |
| Native (Python) | the machine's own CPython: its installed packages and GPU |

- Each Sagebrush entry is the same engine language mode as in the browser, run on the machine with its cores and memory.
- The notebook's language picks the natural default: a Magma notebook defaults to Native (Sagebrush Magma), and so on. A Python notebook defaults to Native (Sagebrush Python). Native (Python) is chosen by the person, or by the workspace's default.
- Below, "the kernel entry" means one of these five. Everywhere r3.1 said "kernel kind", r3.2 means the entry (H4, Limits).
- **Cores and memory, honestly.** Today's `app/engine` runs the engine as WebAssembly in Node (its hello says `native: false`). So it has threads, but each session has WebAssembly's 32-bit memory (4 GiB at most), whatever the machine has. Using a 256 GB machine's memory, and native speed (about 2 to 2.6 times on the measured cells, native-desktop.md), needs the engine subprocess with native Rust engines that native-desktop.md already plans. r3.2 lists it as missing item 7. Until it lands, the kernel menu says "up to 4 GiB" beside each Sagebrush entry on a remote, and a computation that needs more fails with that reason, never silently elsewhere.

## What is reused from the native app, and what's missing

Reused as is:

- **The engine** (`app/engine/main.mjs --stdio --root web/dist`): standalone, no Tauri. Its protocol is versioned (hello `{protocol:{min,max}}`, sessions `{open:sid}` / `{to:sid,m}` / `{close:sid}`, length-framed with binary values). Each session is the page's unchanged worker.
- **The page's engine client** (`web/notebook/native-worker.js`): a Worker-shaped client over `core.invoke` and `core.Channel`. Remote supplies a `core` whose transport is the relay instead of Tauri IPC. That's a shim, not a second client.
- **The disk workspace logic** (`app/src-tauri/src/disk_fs.rs`, `folder_fs.rs`): link-refusing paths, expected-state checks (CONFLICT), atomic writes, grants beside a file. It's pure Rust, behind Tauri commands.
- **The page's file backend object** (readText, writeText, list, read, write) and the disk mirror (`web/workspace/disk-mirror.ts`, injected `invoke`).

Missing, to run it headless behind the relay:

1. **A host process** that starts the engine, serves the disk and folder commands outside Tauri (a small server over `disk_fs.rs` / `folder_fs.rs`, or their logic in the host's language), and multiplexes engine sessions onto the relay. One kernel per notebook, as the app's sessions already are.
2. **A relay channel for the engine protocol**: frames carried as they are, per session, under the bindings in H1. The relay's per-channel page cap gives way to the per-notebook rule.
3. **The `core` shim in the page**: `invoke("engine_start")` and the rest over the relay, with the same ack window `engine.rs` uses.
4. **Terminals:** the app has none. The remote host keeps today's PTY terminals (`terminal.py`, already over the relay), and the app later gains the same (native-desktop.md N5). Until then this is the one place remote does more than the app.
5. **The CPython kernel in the app (D1).** Remotes have it today (the runner's child.py); the app gains the same kernel, through the same code, so both offer "Native (Python)" (r3.2's name for it).
6. The page's single run-target abstraction (native-desktop.md N2: one client for the subprocess, wasm and relay transports). r3 needs it for the header switch.
7. **(r3.2) The native engine subprocess** (native-desktop.md §2: native Rust engines, native threads, 64-bit memory), so the Sagebrush entries can use the machine's memory past 4 GiB. Story A needs it at full scale.
8. **(r3.2) Sync-before-start, the local-only rule and "Save to cloud"**, from the stories below. (r3.3) For save to cloud this includes chunked upload out of DEV, the save's holder in the account object, the pinned staging copy, the four agent grant verbs, and the new daily upload plan field and meter (LIMITS).

## Where it can't be identical, and how it's shown

- **Latency:** every run and file save crosses the network. The header shows a small connection indicator; a run slower than a moment shows "on mybox" beside its spinner.
- **The machine offline, or `sagebrush remote` stopped:** the header says "mybox: offline". Nothing runs anywhere until the person chooses: retry, or switch the workspace to this browser. Nothing switches silently. Kernels on mybox keep running while it's up, and the page reattaches when it comes back.
- **What the browser keeps locally:** the browser's copy of the workspace (sync) and the page itself. Unsaved edits in an editor stay in the page until saved through. If the page closes first, they follow the existing unsaved-work rules.
- **Another person's machine:** never. A workspace connects only to computers enrolled to the same account.
- **No windows, menus or dialogs on mybox:** the page's own file dialogs replace the app's OS dialogs. Grants for files outside the workspace folder are given in the page and checked by the host.

## Files: file sync, not a file transport over the relay

William (09:05Z): "you only have [remote] I think if you have our sync proxy. If you have our sync proxy you also have filesystem sync." These are the facts as they are on master today, from the sync owner.

- **The gate.** "The sync proxy" is the sync service (web/sync/: a Worker plus Durable Objects).
  - Its deployment gate: every route is 404 without the sync bindings, which are on DEV only today.
  - Its account gate: `allowed(env, account)`, then the plan's `Limits.sync.enabled`.
  - Remote is offered exactly to accounts whose sync is **on**. The check already exists on master; the relay reads it from site state and never takes the page's word for it.
    - **The page** asks GET /api/sync/v1/status (web/sync/server.ts), read-only, as sync-panel.ts already does.
    - **The relay** (the cloud Worker) calls the sync account object's `status({account})`, as share/server.ts already calls `usage()`, before the challenge and before each page open. The answer is {available, reason?, state, generation?, retry_after?}.
    - No SYNC_ACCOUNT binding (production today) means unavailable.
    - Only state "active" lets a workspace run on a computer:
      - "off" (available, not turned on) offers "turn on sync" instead;
      - "readonly" (a plan that dropped sync) refuses, since a read-only workspace can't take the machine's writes;
      - "cocalc_unreachable" is transient: the page says try again, and it is never taken as a no.
    - **(r3.1, SEC H5)** The gate holds for the whole connection, not only at open. See H5 under Security.
  - Without sync, the header shows only "This browser", and the pros and cons panel says what a plan with sync adds.
- **The remote machine is an enrolled sync device.** It runs the shared sync client (web/workspace/sync-client.ts) headless, over a disk-backed workspace in its folder. The real files are on mybox's disk, and sync carries them to the browser and to other devices. The relay carries kernels, terminals and control, never file contents.
- **E2E (the one mode before customers).** Only enrolled devices hold workspace keys, and William decided (Nov 23) that "agents and Autonomous VMs are full trusted devices".
  - So mybox enrolls through the enrollment mailbox, approved from another device, as any device does.
  - It holds all of that account's workspace keys, with no per-folder keys. The pros and cons panel says so.
  - Removing the computer rotates the epoch.
  - The relay to your own computers is end to end too (e2e-encryption §6.2).
- **Disagreement.**
  - **Data files** are never last writer wins. Each write names the version it replaces. When the browser and a kernel on mybox change `data.csv` from the same version, the first is kept and the second becomes `data (conflict, mybox).csv` beside it, exactly as between any two devices (sync-server §7.2).
  - **On mybox's disk**, the disk-mirror rule also applies: a file another program changed is never overwritten. Sagebrush's version goes beside it as `name (from Sagebrush)`.
    - (r3.1) That rule comes from the app's disk.rs check, which the headless host doesn't have. The host implements the same expected size, time and sha check before each write, rename or delete (part of item 1 below).
  - **(r3.1) Notebooks, boards and chats on disk** (`.ipynb`, `.board.json`, `.chat`) are written from their sync documents and are **not read back** while the host runs. Edit them in Sagebrush, not with another program on mybox. An outside edit to one is kept beside it, as today, and the pros and cons panel says so.
  - **Notebooks, boards and chats** are sync documents, merged per record (merge3). A clash keeps a conflict document (§4.6).
  - The page shows conflicts the way sync already does.
- **Latency.** Sync pushes a notice on the account socket when the log grows, and the client pulls at once. A kernel's write shows in the browser after about one round trip plus the upload. An idle safety pull runs every 5 min.
- **Needed from sync (new work; the sync owner reviews this section):**
  1. the headless client host: the sync client run by the remote host over a disk-backed Workspace;
  2. a device credential for the sync socket. A runner key isn't a session, and an agent grant reaches only the agent verbs. (r3.1, SEC's D2 condition) It is scoped to the enrolled account and device. A runner, page or agent credential can never stand in for it, and it can't stand in for them;
  3. **(r3.1, sync R1) the disk watcher: disk to sync.** Today the app's disk mirror (web/workspace/disk-mirror.ts) is one way: it writes the workspace to disk, and re-reads it at launch and when another app window says so. It watches the workspace, never the disk. So without this item, a kernel's write to `~/Sagebrush/<workspace>/data.csv` stays on mybox.
     - The host watches the workspace folder (inotify on Linux, FSEvents on macOS), with a full rescan at start and after a watcher overflow.
     - Each settled change becomes an index op (create, write or remove) whose base is the sha last synced for that file. So a kernel's write and a browser edit of the same version end in a conflict copy, never a silent overwrite.
     - A rename or move is a remove plus a create, unless the watcher can pair the two.
     - Notebooks, boards and chats are not read back (above).
  4. **(r3.1, sync R2) the settle rule, against churn.** Launch keeps every synced version (keep-all retention; sealing a release frees nothing). A kernel rewriting a log or a checkpoint every few seconds would otherwise make a kept version on every write and fill the plan's storage.
     - A changed file is synced once it has been unchanged for 5 s.
     - While it keeps changing, it is synced **at most once per interval**, with its latest contents (earlier unsynced contents are never sent).
     - The interval is a **workspace setting** the person sees and changes, like the idle stop: default 1 min, validated as a duration from 5 s to 1 d; anything else is refused in words. It is time-based only; there is no size cap beyond the plan's own sync limits.
     - The host's own `sagebrush remote status` command and the pros and cons panel show it (sync's status endpoint doesn't), and the page lists files held back by it ("data.log: changing; next sync in 40 s").
  (The entitlement read already exists: `status`, above.)
- **(r3.1) Notes from sync:**
  - **Over-cap files.** A file over the plan's `max_file_bytes` (chunked files are DEV only) stays on mybox. It is listed, not synced, with a reason the page shows ("data.bin: 6 GB, over this plan's 2 GB per file; it stays on mybox"). The client doesn't retry it until the file or the plan changes.
  - **One workspace per account.** Sync holds one workspace per account today, so there is one folder per account on mybox.
  - **Sync resets.** The folder belongs to one server generation. After a sync reset, the folder is never silently re-uploaded into the new generation. The host stops syncing it and asks the person, in the page, what to do.
  - **Device keys on mybox.** Where mybox keeps its sync device private keys (file modes, an OS keyring) is in SEC's lane; see Security.

## D2, decided: the workspace is a folder on the machine (option A)

William (09:07Z): "the remote (and possibly native app) could have: the local files on the remote machine, AND the sync'd files." So on mybox there are two trees:

- **the machine's own files:** everything the user account can reach, such as ~/data, /scratch, mounted disks and repositories. They are big, many, and not synced, often by design (datasets, models, other people's code);
- **the synced workspace:** the files and documents that live in the account, on every device and in this browser.

The questions are how a user sees both, and which one is a kernel's working directory.

**Option A (recommended): the workspace is a folder on the machine, like Dropbox.**

- The synced workspace is materialised as a real folder on mybox, ~/Sagebrush/<workspace>, kept in sync by the headless sync client, exactly as the native app's disk folder would be once the app syncs.
- A kernel's working directory is that folder. `open("data.csv")` reads the synced file, and a result written there syncs to the browser.
- The machine's other files are reachable the way any program on mybox reaches them: by path, from kernels and terminals, with the user's full authority (`np.load("/data/big.npy")`, `cd ~/repo`). They aren't synced, and nothing copies them.
- The header says "mybox: ~/Sagebrush/project", and the file browser shows the workspace, as it does in the browser today.
- To bring a machine file into the workspace, copy it into the folder (from a terminal or a cell). It then syncs like any other file.
- **Cost:**
  - the least new UI;
  - the same model in the native app and on remote;
  - a huge dataset copied into the folder would start syncing; the plan's sync limits (max file size, storage) apply and refuse what's too big, said in words;
  - the machine's files aren't browsable in the page in r3, only reachable from code and terminals.

**Option B: two roots in the file browser.**

- The file browser shows two roots: "Workspace (synced)" and "mybox: ~ (this computer, not synced)". The second is listed, read and written over the relay on demand.
- The kernel's working directory is chosen per workspace: the synced folder (as in A) or a folder on mybox.
- **Cost:**
  - the most direct ("I see everything");
  - a second file transport over the relay, which r2 avoided, with its own limits, conflicts (none: one writer) and security review (path confinement or not, symlinks, large listings);
  - two kinds of file in every dialog, and a notebook that refers to a mybox-only path fails when the workspace runs in the browser.

**Option C: synced only.**

- Only the synced workspace exists for Sagebrush. The kernel's working directory is the synced folder, and no other machine path is shown or offered. Code can still reach other paths with the user's authority; nothing can prevent that.
- **Cost:** the simplest, but it hides what people connect a big machine for (its data and disks). It is the same as A minus A's "reach by path", which can't really be removed anyway.

**Decided (William, Nov 26): A.** The synced workspace is an ordinary folder on the machine, ~/Sagebrush/<workspace>. Kernels start there. Code and terminals reach the machine's other files by path. There is no separate file channel over the relay, and r3 doesn't browse the machine's other files in the page. B's read-only second root stays a possible later addition. The options as they were put to him are kept above for the record.

- A is what the native-app model gives by construction: the app's folder is a real folder; kernels run in it and can see the machine.
- It needs no file transport over the relay.
- B's read-only "mybox: ~" browser root can be added after r3 without changing A.

**In scope for r3 (with A):**

- the synced workspace materialised as a folder on mybox, and the kernel's working directory there;
- the machine's files reachable from kernels and terminals by path;
- the pros and cons panel saying both ("mybox's files are reachable from your code; only the workspace folder syncs").

**(r3.1, SEC's D2 condition) How the folder is bound:**

- **By id, not by name.** The host maps the workspace's stable, authenticated id (from site state, never from the page) to its local folder. The display name is only a label: renaming a workspace never moves its folder or points another workspace at it.
- **The root's identity.** At first use, the host creates `~/Sagebrush/<workspace>` or validates it without following links (no symlink at any component of the path; the owner is the user; it's a directory). It records the root's identity (device and inode) and revalidates it, again without following links, at every start and before each watcher rescan. If it changed (moved, replaced, became a link), the host stops syncing and kernel starts for that workspace and says why.
- **The sync credential** is scoped to the enrolled account and device (item 2 above).
- **Disclosure.** Kernels and terminals run as the full OS user; the pros and cons panel already says so, and that is enough for the folder too.

**Out of r3:** browsing mybox's other files in the page, and moving files between the two trees from the page.

## Limits (answering LIMITS H1)

- **Admission of a new kernel:** a measured startup envelope K for each kernel kind: the engine's observed peak at start, and the CPython kernel's, each recorded per release, since the two differ, plus a separate system reserve R.
  - **(r3.2)** K is measured per kernel entry: each of the four engine language modes (whose startup differs, for example Sage's library load) and the machine's CPython. All five share the one ledger. Everything else in this section is unchanged.
  - Admission is serialized: one decision at a time. A start is admitted only if F − R − (sum of pending reservations) ≥ K.
  - It holds a pending reservation of K until its startup memory is observed (the kernel ready, its RSS read) and reconciled to the actual.
  - With F = 3 GiB, R = 2 GiB and K = 0.5 GiB, two starts are admitted and the third is refused.
  - No fixed count of kernels.
- **F:** the minimum of the host figure (MemAvailable on Linux, the VM statistics on macOS) and any finite cgroup headroom (v2 memory.max − memory.current; the v1 equivalents).
  - An unavailable or stale figure (older than one admission tick) refuses **new** starts, in words with the numbers. Reconnecting to existing kernels is always allowed.
  - Free memory decides run or refuse only; it never changes how anything runs.
- **Idle:**
  - `--idle` (default 24 h; validated as a duration from 10m to 30d, or `never`; anything else refuses to start) stops only a **quiescent** kernel: no cell executing and no page attached.
  - A kernel running a long cell is never stopped by idle.
  - The clock is monotonic, reset by a page attach, a cell start or finish, and any input.
  - `status` shows the setting and each kernel's idle time.
- **Refunds:** a stopped kernel's reservation is refunded only after its process tree's teardown completes (the tree rule's census empty).
- **(r3.1) The implementation contract (LIMITS' acceptance terms).** The text above is unchanged from r3. The implementation is accepted only if:
  - it **reserves before launch**: the pending charge is taken under the admission lock before the process is spawned. Both kernel kinds share **one host-wide ledger**;
  - it **reconciles** a pending reservation only against a memory reading taken **after** the started process tree is counted in it. A recent snapshot from before the start is not enough;
  - the measured envelope K **includes** helper processes and startup buffers (the relay session's queues, the engine's or child's startup work), or those get a separate budget in the same ledger;
  - its tests include, with controls that must fail when the rule is removed:
    - mixed engine and CPython opens released together over a startup barrier;
    - the exact boundary and one byte short;
    - a stale or unknown memory figure, and a lower cgroup limit;
    - reconciliation against a deliberately pre-ready snapshot (must be refused as a basis);
    - startup failure, before and after the tree is reaped (no refund before the reap);
    - reconnect (no new charge), and idle racing an attach or an active cell;
    - controls that drop the pending charge, drop the serialization, or refund early.
  - There is no fixed kernel count and no automatic fallback to a different way of running.

## Security (answering SEC H1–H3 and the socket conditions)

- **What a kernel can do:** kernels run with the OS user's full authority on that machine. `--dir` chooses the folder; it is **not a sandbox**.
- **H1, binding:** every open and every reconnect is bound to the full current authority:
  - the authenticated principal, the enrolled host, the workspace, the channel kind, the notebook or terminal id and its generation, a single-use attempt id, and a short expiry;
  - the relay derives these from current site state (the page can't assert them), and the host verifies them;
  - kernels are keyed by the full identity, so a reused or copied id can't cross a host or workspace boundary;
  - replayed or stale proofs are refused.
- **H2, atomic revocation:**
  - Switching a workspace's target, disconnecting it, revoking the host or its key, losing permission, or revoking an agent grant bumps the connection generation. That closes the old relay legs, and late frames and reconnects at an old generation are refused.
  - Kernels may keep running on the host but become unreachable.
  - Agent grants are bound to a stable agent identity plus the full session generation, checked against current state on every request, and never carried across a recreated session.
  - Code already submitted before a revocation can't be undone. This is said in the revoke UI.
- **(r3.1) H4, the kernel kind is part of the identity.** "Native (Sagebrush)" and "Native (this computer's Python)" are different kernels, never interchangeable:
  - the kind is bound into the relay's proof (with the H1 fields), verified by the host, part of the host's process key, and part of the reconnect identity;
  - a generic kernel channel plus a notebook id never attaches to, or reuses, the other kind's process;
  - changing a notebook's kind advances its session generation. The old leg is closed, and late frames and reconnects for the old kind are refused. The old kind's kernel is then stopped by the tree rule, and its reservation refunded after the reap, as for any stop.
  - **(r3.2)** The kind is the kernel entry (one of five, D1 refined): the engine language mode is bound too, so a Native (Sagebrush Magma) open never reaches a Native (Sagebrush Sage) process for the same notebook, and switching between two engine modes advances the generation like any other change of entry.
- **(r3.1) H5, the sync gate holds for the whole connection.**
  - **(r3.2, sync C1; SEC chose option b; replaces r3.1's "the account object pushes changes")** There is no push: the sync account object can't notify the cloud Worker's relay, and r3.2 adds no new sync work for it. Instead:
    - the relay re-reads the sync account's `status({account})` **every 5 s** while any leg for that account is open (one read per account per period, not per leg), and also on every open and every reconnect;
    - so **5 s is the maximum sync-revocation window**: an account whose sync becomes off, readonly or unavailable, or whose sync generation changes, has its open legs closed within 5 s of the change being visible to the relay;
    - a read that fails or answers "cocalc_unreachable" is not definitive: existing legs stay up and new opens are refused, until a definitive answer comes.
    - **(r3.3, sync)** A failed or timed-out status RPC (the sync Worker unreachable) is treated exactly like "cocalc_unreachable": new opens fail closed, legs stay up, no generation advance. A sync outage never reads as a revocation.
  - A definitive move to "off", "readonly" or unavailable, or a change of the account's sync generation, **advances the connection generation** (as in H2): existing legs close, and late frames and reconnects at the old generation are refused. Kernels may keep running on the host but are unreachable, as in H2. The page says why ("sync is off for this account").
  - A transient "cocalc_unreachable" **fails closed for new opens** (try again later), and existing legs stay up until a definitive result. It is never recorded as a revocation and never advances a generation.
- **(r3.1) The device's sync keys on mybox** (from sync's notes): kept in a file under the key's 0700 directory, mode 0600, validated with no-follow like the socket, never printed. An OS keyring may hold them instead where one is available headless. SEC decides the rule.
- **H3, updates:**
  - The target is an exact X.Y.Z from an authenticated site answer (the challenge response).
  - No downgrade: a target lower than the running version is refused and reported.
  - Install is `sagebrush==X.Y.Z` from PyPI only, with uv's config files, sources, extra indexes, find-links and environment overrides disabled. The installed version is verified before re-exec.
  - The old installation stays runnable if anything fails. Retries are bounded (3, with backoff), and failures are reported in `status` and the page.
  - Without `--service`, the host only tells the person.
- **The user service unit:** an absolute argv and a minimal fixed environment (HOME, PATH, and XDG_* set to fixed values). It never snapshots or prints the login environment. `--service remove` undoes it.
- **The local control socket:**
  - in the key's 0700 directory, validated with no-follow for its owner and mode, and created safely (no TOCTOU: bind in the validated directory);
  - a lifetime singleton lock;
  - peer credentials checked on each connection;
  - bounded framing;
  - only its own validated socket is ever unlinked;
  - no network listener.

## (r3.2) Acceptance stories (William, Nov 26)

These two must work end to end. William's issue list is added to them.

### Story A: a Magma notebook on a big machine

1. In the browser, the person writes a Magma notebook in their workspace.
2. They connect a 64-core, 256 GB VM (`sagebrush remote` on it, enrolled as above) and switch the workspace to it in the header.
3. The notebook's kernel menu offers Native (Sagebrush Magma) as its default. They choose it and run.

**Files still syncing when the kernel starts.** A kernel starts only once the notebook and its folder are synced to the machine:
- The page sends, with the open, the workspace's sync position as the page knows it (its log head) and the notebook's id.
  - **(r3.3, sync S1a) The position covers the page's own writes.** A file the person just saved may still be in the page's outbox, or sent and not yet echoed. So the page sends the position only after its outbox has drained for the workspace, and the position is max(the confirmed cursor, the highest seq the server gave the page's own sent ops: the outbox's confirmed top). While the outbox drains, the page already shows the waiting message.
  - **(r3.3, sync S1b) The position names its namespace:** the account and the sync server generation. The host refuses a position from another generation ("Sync was reset; reopen the notebook"), never waiting forever and never taking a small seq as already reached.
- The host admits the start (Limits) and then holds it until its sync client has applied the log up to that position, and the notebook's document and every non-ignored file in the notebook's folder are on disk, at the versions in that log. Ignored, local-only and over-cap files don't count (they were never going to arrive).
  - **(r3.3, sync S1)** A file counts as ready once the log's version is on disk **or** its conflict copy has been made. So a change of mybox's own that the settle rule is still holding back never blocks the start; the kernel sees the log's version and the conflict copy beside it, as any device would.
  - (r3.3) Ignored files are those mybox never uploads; they still download (S3 below), so a file already in the workspace counts like any other.
- Meanwhile the page says so, in the cell's place: "Waiting for files to sync to mybox: 12 of 40 files, 3.1 MB left". Stop cancels the wait, and nothing has run.
- While it waits, the kernel's reservation is held (the start was admitted), and the wait has no fixed cutoff. (r3.3, LIMITS) The process is not spawned before the wait ends, the charge is never dropped while waiting, and a start after the wait never runs without it. Stop refunds the reservation only once nothing of the pending start (process or buffer) remains. If sync stops making progress (the machine offline, sync not "active"), the page says why, as for any other connection problem (H5).
- Files changed after the start sync as usual. The wait is only at start, so a long run never stalls on later edits.

**Acceptance:** the run's result appears in the browser; the notebook is saved through sync as in the browser; a cell started while a file is still arriving waits with the message above and then sees the file.

### Story B: PyTorch on a GPU machine

A notebook with `import torch` and a Hugging Face dataset download can't run in the browser (no CPython, no GPU).

1. The person connects a GPU VM, switches the workspace to it, chooses Native (Python) and runs.
2. **The notebook** is a sync document. It syncs as it is edited, and its outputs are saved to the cloud with it, periodically, like any notebook.
3. **Data and weights stay on the machine by default.**
   - **Caches outside the folder.** Hugging Face's caches (`~/.cache/huggingface`, or wherever `HF_HOME` points) are outside `~/Sagebrush/<workspace>`, so they never sync. The host doesn't move them.
   - **A "this computer only" rule inside the folder.** The workspace folder on a remote has a `.sagebrushignore` (the same file and syntax fs-sync uses, design/fs-sync.md) with defaults written on first use, so the person can see and edit them:
     ```
     # This computer only: files matching these lines stay on this computer and never sync.
     *.pt
     *.pth
     *.safetensors
     *.ckpt
     *.onnx
     *.gguf
     checkpoints/
     runs/
     wandb/
     .cache/
     .sagebrushignore
     ```
     (r3.3, sync S3) `*.bin` was dropped from r3.2's defaults: people keep ordinary data in .bin files, and the over-cap rule already keeps huge files local. The defaults are the model-weight forms and the folders.
     The page's file browser shows such files with a "this computer only" mark, and the pros and cons panel says so.
   - **(r3.3, sync S3) Direction and locality of the ignore file.**
     - It governs only mybox's **disk to sync** direction (fs-sync's rule is "ignored, both ways"; this is the remote's deliberate difference). A matching file that is already in the synced workspace, for example a `.pt` uploaded in the browser, still downloads to mybox, so a notebook on mybox sees what the browser sees.
     - `.sagebrushignore` itself is **local to the machine and never synced** (it is in its own defaults), so a GPU machine's defaults never reach other devices or the desktop app.
   - **Over-cap files** (above the plan's `max_file_bytes`) also stay local, listed with the reason (r3.1's note).
4. **Saving chosen weights to the cloud, explicitly** (see "Save to cloud" below). Later the person saves `checkpoints/final.safetensors` with `sagebrush remote save checkpoints/final.safetensors`, or "Save to cloud…" in the file browser. It goes to cloud storage, not through normal sync.
5. **Deleting the machine.** When the person deletes the VM (in Sagebrush for a machine Sagebrush started, or by removing the computer from their account for one they started themselves), the page first lists what will be lost and asks:
   - "On mybox only, and lost when it's deleted: 14 files, 38.2 GB (checkpoints/ 31.0 GB, runs/ 7.2 GB), plus caches outside the workspace folder (Hugging Face 61 GB). Saved to cloud: final.safetensors (2.1 GB). Synced: everything else."
   - The list comes from the host while it's online: local-only files (ignored or over cap) inside the folder, and the size of the known caches outside it (Hugging Face, pip, torch). If the host is offline, the page says it can't list them and that anything not synced or saved to cloud is lost.
   - Delete needs the machine's name typed. Kernels running there are named too ("1 kernel is running a cell").
   - Synced files and cloud saves are not affected.

**Acceptance:** the notebook runs on the GPU; the notebook and its outputs are in the browser; the dataset and weights are on the VM only; one chosen weights file is saved to cloud storage and fetched on another machine; deleting the VM shows the list above first.

### Save to cloud (from Story B)

An explicit copy of a chosen file into the account's cloud storage, separate from sync.

- **How:** `sagebrush remote save PATH [--as NAME]` on the machine, and "Save to cloud…" on a file in the page's file browser (it asks the host to do the same). `sagebrush remote saves` lists them, `sagebrush remote fetch NAME [PATH]` copies one down to a machine, and the page lists them under "Saved to cloud" with size and date, with Download and Delete.
- **What it is:** a named, versionless object: saving again under the same name replaces it (after the new one is complete), and deleting it frees its storage. It never appears in the synced workspace and is never written to devices unless fetched. So the 5 s/1 min settle rule and keep-all retention don't apply.
- **Storage:** R2, sealed end to end with the workspace's keys as sync files are (only enrolled devices can read it; the server stores ciphertext), uploaded in chunks with a resumable upload.
  - Large weights exceed one-file sync limits; chunked upload is DEV only today, so this needs chunked upload for cloud saves (new work, listed under missing item 8).
  - **(r3.3, sync S2) A save holds its bytes.** Its chunks and manifest are held by the save itself: a holder in the account object, like a document's pin, which raises the holdings and files counts. It lowers them only when the save is deleted, or replaced after the new one completes. Without it, nothing would refer to them, and the day-old idle sweep (holdings refs <= 0) and the chunked files' retire pass (files refs <= 0 past hold_until) would delete them. This holder is part of missing item 8, beside chunked upload.
  - **(r3.3, sync S2) Pacing.** Chunked upload is DEV only today (SYNC_TIERED), and its server-side verification draws on the plan's `verify_bytes_per_day` meter, so a large save is paced by that meter as well as the daily upload budget (new work, LIMITS contract below). The page and `saves` say when a save is paused by either, and when it resumes.
- **Quota:** it counts against the account's one `storage_bytes` (sharing and sync together, sync-server §6.1). Before an upload starts, the account object reserves its full size with one conditional write (as sync-server §420 does for a file), so a save that doesn't fit is refused before any byte is sent: "final.safetensors is 2.1 GB; your plan has 1.3 GB left. Delete a cloud save or a synced file, or upgrade." A reservation that isn't completed expires and is released.
  - **(r3.3, sync S2)** Sizes are counted in **ciphertext bytes** (the sealed chunks, slightly more than the file). **A replace counts both copies** until the new one completes, so a replace near the quota is refused up front, and says so: "Replacing final.safetensors (2.1 GB) needs room for the new copy while the old one is still kept; your plan has 1.3 GB left." (The old copy is already charged, so the check is the new copy's size against what is left; the old one is never charged twice.) The page and `saves` show what cloud saves use, beside sharing and sync.
- **LIMITS notes:** the upload streams from disk in chunks with bounded memory (one chunk in flight per save, the host's ledger counts its buffer); it obeys the plan's per-day upload budget and says when it's paused by it; one save per file at a time, others queued.
  - **(r3.3, LIMITS correction)** The plan has **no daily upload field today**: master's sync limits have `read_bytes_per_day` and no upload counterpart. So "the plan's per-day upload budget" is **new plan, quota and meter work** (missing item 8), not an existing field. It is never replaced by a fixed local bytes-per-day number, and never by reusing the read budget. Before implementation acceptance, its design states: the plan field and its validation; byte units; the window, its reset and `retry_after`; what happens when the plan or the field is absent or unavailable (new saves refused in words, never unmetered); and how every chunk, retry and resume is charged by one account-wide authoritative meter across devices (an automatic retry never bypasses the meter, and a lost acknowledgement is never refunded). Fetch is charged to the plan's existing read accounting (`read_bytes_per_day`), never through an unmetered new read path.
- **(r3.3) The save and fetch implementation contract (LIMITS' acceptance terms).** The implementation is accepted only if:
  - **Host memory:** each save and fetch reserves its buffer envelope **before allocating**, on the same host-wide ledger as kernels. The envelope covers plaintext, ciphertext and authentication, SDK and retry buffers, and manifest state. Different files and kernels compete through that one ledger (one chunk in flight per save is not, alone, a host bound). Queued saves keep bounded metadata, not file contents. Fetch streams with a bounded buffer. A cancel keeps the charge until the buffers are gone.
  - **Storage:** the reservation is the **chargeable sealed size** (chunks, AEAD and manifest overhead), or a safe upper bound reconciled before commit. It is admitted by one account-wide conditional write that counts other devices, sharing, sync and pending saves. On replace, the old object stays charged until the new one is published atomically and the old and staging objects are disposed of through the storage ledger.
  - **Lifecycle:** a resume reuses its identified reservation, never a second uncharged upload. An expired or cancelled upload can never publish late: finalization is fenced, multipart work is cancelled, and staging is cleaned through the existing cleanup accounting. Commit, retry and cleanup are idempotent. A save paused by the daily budget can't resume under an expired storage reservation; it reserves again first.
  - **Tests**, with controls that must fail when the rule is removed: mixed five-entry kernel starts together with concurrent saves at the host boundary; the account quota exact and one over, including sealed overhead; two devices racing for one remaining quota; a same-name replace with a lost commit acknowledgement; partial upload expiry, cancel and a late finalize; the daily window's boundary; retry, resume and pause across several devices; cancellation and failed startup before and after buffer and tree cleanup. Controls: dropping a reservation, checking only per-save buffering, admitting an expired upload.
  - No fixed file or kernel count, and no silent fallback.
- **SEC notes:**
  - The CLI takes any path the OS user can read (it runs with their authority anyway). The page's "Save to cloud…" offers only files inside the workspace folder, and the host resolves the path inside the folder's validated root without following links (D2 condition).
  - (r3.3) r3.2's "checks before and after the upload" is replaced by S1 below: such checks don't prove the bytes streamed in between were one stable copy.
  - **(r3.3, SEC S1) One pinned plaintext, bound to what is committed.**
    - **Pin first.** The host opens the source by handle without following links (for the page's action, inside the validated root, D2 condition), and makes a private staging copy in the host's 0700 state directory: a reflink where the filesystem supports one, otherwise a full copy. Disk space for it is checked first and the save is refused in words if it doesn't fit. Only the host writes the staging copy, so its bytes can't change underneath.
    - **The pinned identity** is the staging copy's (device, inode, size) and its full plaintext SHA-256 $D$, computed over the staging copy before any upload. If the source changed while it was being copied (its size, mtime or ctime differ before and after the copy), the copy is discarded and the save refused: "final.safetensors changed while it was being saved; try again when it's finished writing."
    - **The manifest binds it.** Each chunk is read from the staging copy and sealed; the manifest records, per chunk, the plaintext chunk hash and the ciphertext hash, plus $D$ and the total size, and is itself sealed. Commit (the account object's) accepts the manifest only if every chunk named is present with that ciphertext hash; the host commits only if the SHA-256 of the plaintext it actually streamed, chunk by chunk, equals $D$.
    - **Resume** reopens the staging copy without following links and refuses unless its (device, inode, size) match the pinned identity and its digest is $D$ again (re-hashed before continuing). Chunks already uploaded are kept only if their ciphertext hashes match the manifest. Anything else starts the save over from a fresh pin.
    - The staging copy is deleted when the save commits, fails or is cancelled, and at host start for saves no longer pending. It is counted in `sagebrush remote status`.
  - Saving needs a page open with the full H1 binding (or the person at the machine's CLI); agents can't save to cloud without an explicit grant for it, as for any other host verb.
  - **(r3.3, SEC) Agent grant verbs.** Save, fetch, list and delete are **four separate grant verbs**. Each grant is scoped to the account, the enrolled host, the workspace and the session generation (H2), and checked against current state on every request. A save grant is also scoped to the granted source path (one file, or one folder inside the workspace folder, never wider); a fetch grant to a destination inside the workspace folder. No verb implies another.
  - Fetching writes only into the workspace folder (or a path given on the CLI), never over an existing file without `--replace`.
  - **(r3.3, SEC S2) How fetch writes.**
    - The destination is resolved inside the validated workspace root (for the page's fetch and for `--replace`), opening each path component without following links, and refusing if any component is a link or not what it should be.
    - The named object is downloaded into a staging file in the destination's directory (created exclusively, owner-only), and **fully authenticated and decrypted** first: every chunk's AEAD tag, the manifest's ciphertext hashes, and the plaintext digest $D$. Only then is it fsynced.
    - It then **atomically replaces the leaf itself** (rename within the same directory, relative to the directory handle), never a link's target. The directory is fsynced after the rename.
    - If anything fails (authentication, decryption, disk full, a component changed), the staging file is removed and the old file is left exactly as it was.

## Out of r3

- Starting Claude or Codex on the machine (a later, per-machine opt-in).
- Windows (WSL works as Linux).

## Order of work

1. Small fixes (#2215, under review).
2. (Decided Nov 26: D1 both kernels, D2 the workspace as a folder on the machine.)
3. The host: the engine headless plus the disk and folder server; the relay engine channel with H1 bindings, the kernel kind (H4) and H2 generations, and the sync gate held for the connection (H5); one kernel per notebook and kind. With this alone, the "second notebook breaks it" problem is gone.
4. The page: the `core` shim, the header switch, the pros and cons panel; the workspace choice in settings, surviving refresh.
5. Files over sync: mybox as an enrolled sync device (the headless client host, the device credential, the disk watcher and its settle rule, with the sync owner; the status gate already exists). The folder bound by workspace id with its root identity checked.
6. The background daemon, `stop`/`status`, then `--service` and updates (H3).
7. Agent grants.

William's issue list (Nov 27) becomes the acceptance checklist, each item mapped to a step.
