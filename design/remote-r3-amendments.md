# Remote r3.7: an amendment to r3.3 (data gravity; the remote engine)

The approved amendments to design/remote-r3.md (r3.4 to r3.7, reviewed for security, limits, sync and the engine), kept here as the reference the implementation steps name. Where they differ from remote-r3.md, these win.

Status: frozen (r3.7). It supersedes r3.6 (0910328d) and answers its reviews, marked **(r3.7)**: sync's C3 (the evict journal checked first) and LIMITS' H2 (the volume's accounting without double counting).

r3.6 superseded r3.5 (fb5213a7) and answered its reviews, marked **(r3.6)**: sync's C2 (a crash's leftover copy), SEC's A1 (the listing version held across the publish) and B1 (every loadable member of the runtime bound through activation and at every launch).

r3.5 superseded r3.4 (182378f1) and answered its reviews, marked **(r3.5)**: ENGINE's conditions on A.4; LIMITS' H1 (the listing's memory) and H2 (the disk budget); sync's P1 (absence across crashes) and P2 (a local write at an in-cloud path); SEC's A1 (a fetch's publish race) and B1 (Node's extraction), and its conditions on the audit hook.

r3.4: It amends the approved r3.3 (DESIGN-r3.3.md, 6d81d583; in the repo as design/remote-r3.md). Everything in r3.3 stands except what this amendment changes, which it names section by section. It records two decisions by William on Nov 26:
- **A, data gravity (about 9:30 AM PST):** no FUSE, and the workspace's file listing arrives in full while only a keep set's contents do.
- **B, the remote engine (about 9:35 AM PST):** the native engine is the remote's engine, and the bar is correct results, not identity with the browser.

Nothing here is built.

## A. Data gravity: the whole listing, the contents of a keep set

### A.1 The decision

- **No FUSE, now or later.** William: "Let's avoid FUSE if at all possible and keep things simpler and more portable."
  - FUSE rules out hosts such as RunPod's containers and makes containment harder.
  - So there is no placeholder or virtual filesystem, and no File Provider round, on any platform.
- **Stage 1** (approved):
  - The machine gets the whole file listing (metadata) at once.
  - File contents arrive at once only for a **keep set**.
  - Everything else shows in the page as "in the cloud", one click or one command away.

### A.2 What is on the machine's disk

This replaces r3.3 D2's "the synced workspace is materialised as a real folder": the folder is still real, but holds only the keep set.

- **The listing, always whole.** The host's sync client applies the workspace's whole index: every path, its size, kind and version. The page and `sagebrush remote status` show every file, kept or not.
- **(r3.5, LIMITS H1) The listing's memory is bounded, whatever the workspace's size.**
  - The host keeps the listing in an on-disk index (SQLite, in its 0700 state folder), never as a whole in memory. Its page cache is a fixed setting (default 8 MiB), charged on the host's ledger as a buffer before the index opens.
  - Index updates are applied in batches of bounded decoded size (at most 4 MiB a batch), each batch's buffer reserved on the ledger before it is decoded. No step sorts or copies the whole listing in memory; the database's own indexes do the ordering.
  - The index's file counts on the volume's accounting (below), not in memory.
- **The keep set: contents on disk, kept current.** By default:
  1. the notebooks, boards and chats (sync documents), always;
  2. files and folders the person marked "Keep on this machine", in the page or with `sagebrush remote keep PATH...`;
  3. code and text: `.py .sage .m .mag .g .gp .jl .R .tex .md .txt .ipynb .json .yaml .yml .toml .cfg .ini .sh`;
  4. small files: up to 1 MiB each by default. The threshold is a workspace setting the person sees and changes (0 turns it off).
- **(r3.5, LIMITS H2) The disk budget: a stable baseline, and the volume's own accounting.**
  - **The baseline:** C = the volume's free space plus the bytes the keep set already holds on it (its kept files, staged downloads and the index; (r3.7) and every other file of ours on that volume: the workspace folder's local-only and conflict files, each kernel's in-cloud table). The budget is a fraction of C, by default one half, so the keep set's own downloads never shrink it: with 100 GB free and nothing kept, the budget is 50 GB, and stays 50 GB as those 50 GB arrive. It is read when the host starts and before each sync pass, shown, and changeable as a fraction or a size.
  - **Admission of a download** (by the keep set's defaults, a mark, or a fetch) needs both:
    - the budget: kept + pending + staging + the overlap of replacements in flight (old and new copies both on disk until the rename) + its size <= the budget. Documents and marked files are exempt from this test only;
    - the volume: ~~free space - (pending + staging + overlap) - its size >= the volume reserve~~ **(r3.7, LIMITS H2)** free - unwritten - its size >= the volume reserve (a setting, default the larger of 1 GiB and 2% of the volume). Every download, documents and marked files included, must pass this physical test.
      - `free` is a fresh reading of the volume (statvfs). It already excludes every byte written so far: staged bytes, both copies of a replacement, the index. So none of those is subtracted again.
      - `unwritten` is the sum, over the downloads admitted and not finished, of the bytes each has reserved and not yet written (its size minus what it has written and fsynced so far). It is kept by **one serialized, volume-wide ledger** (the same decision rule as the memory ledger: synchronous, no await between the reading and the reservation).
      - **Reconciling:** as a download writes, its reservation shrinks only against a reading taken after the write's fsync, so a byte is counted once, either as unwritten or in the reading, never both and never neither. A finished or failed download's remaining reservation is released once its staging file is gone.
      - Example (LIMITS'): a staged 40 already written, free 60, a new 30, reserve 1 GiB: 60 - 0 - 30 >= 1 GiB, so it fits with 30 left. The staged 40 is not subtracted again.
  - **Refusal keeps what is there.** A download that fails either test isn't started. Its path stays in the cloud (or keeps its current local version), listed with the reason in words. Nothing already on disk is evicted to make room. An unknown or failed reading of the volume starts no download.
  - **ENOSPC during a download:** the staged file is removed, the destination is left exactly as it was, and the download is listed as failed with the reason. It is tried again only once the volume's free space has grown since, never in a loop.
  - When the defaults ask for more than the budget, the most recently changed files are kept first. The rest stay "in the cloud", listed with the reason ("over this machine's keep budget: 18.3 GB kept of 18.4 GB").
  - Documents and marked files are never left out by the budget. If they don't fit the volume, the page says so in words, and nothing is evicted to make room.
- **Everything else is not on disk at all:** no placeholder, stub or zero-length file at its path. The page's file browser shows it as "in the cloud" with Fetch.
- **Fetching.**
  - Fetch, `sagebrush remote fetch PATH...` or a folder's "Keep on this machine" brings the contents down. A fetched file joins the keep set as marked, until the person un-keeps it.
  - A fetch writes by r3.3's S2 rules: staged in the destination's directory, fully authenticated and decrypted, fsynced, then atomically renamed. It never follows links, and the file is never visible half-written.
  - **(r3.5, SEC A1) The publish is conditional on the leaf.** A workspace fetch publishes only if, at the moment of publishing, the destination leaf is still absent and the listing's version of that file is still the one fetched.
    - The publish is a no-replace link of the staged file into place (`linkat`, or `renameat2` with RENAME_NOREPLACE where available; on macOS `renamex_np` with RENAME_EXCL), relative to the held directory handle. It is never a replacing rename.
    - ~~Then the listing version is checked again~~ **(r3.6, SEC A1) The listing version is held across the publish, not rechecked after it.** Each fetch holds its file's per-fid guard from its final check to its commit:
      1. take the fid's guard: while it is held, no listing update for that fid is applied on the host; one that arrives waits in order behind it;
      2. check, under the guard, that the leaf is absent and the listing's version is the one fetched;
      3. publish with the no-replace link;
      4. record the file as kept at that version;
      5. release the guard.
      A newer version that arrived meanwhile is then applied to a kept file of the older version, which is the ordinary update of a kept file: re-fetched, never taken as current.
    - **Crash recovery never takes stale bytes as current.** A kept-pending row records the version and sha being fetched. On rescan, a file at a pending path is handled by its sha:
      - the pending row's sha, and equal to the listing's current version: adopted as kept (C2);
      - the pending row's sha, but the listing has moved on: an interrupted publish of an older version. It is unlinked, never kept and never uploaded, and the current version is fetched;
      - any other sha: P2's path (a local write).
    - **A file created at the destination during the download** (by a kernel, a terminal, anything) is never overwritten. The no-replace publish fails; the staged copy is removed; and the local file goes through A.3's no-base transition (renamed to the conflict copy's name and uploaded under it). The fetch is then retried at the original name, now free.
    - If the conflict rename can't be made, the fetch refuses and leaves both the local file and the cloud version untouched, saying so in words.
    - **A newer listing version during the download:** the staged copy is discarded and the newer one fetched, never published over by the older one.
    - **Acceptance rows (create at every seam):** a file created before staging, during the download, between authentication and fsync, just before the publish, and just after; a listing change at the same seams; a crash at each.
    - **(r3.6) And the seam SEC named:** a listing change between the final check and the link. With the guard it waits and is applied after the commit; the published bytes are recorded at their own (older) version and then updated. Also a crash just before and just after the link, each recovered by the sha rule above, with no stale bytes adopted as current. The control: the guard removed, which fails the row.
  - It is charged to the plan's `read_bytes_per_day`, as r3.3 already says for fetch.
- **Freeing space.** "Free up space" in the page, or `sagebrush remote evict PATH...`, removes a kept file's local copy and leaves it in the cloud.
  - It applies only when the file on disk is exactly the version last synced (same sha). A file with changes not yet synced is never evicted, and the page says why.
- **Renamed command (r3.3's "Save to cloud"):** cloud saves' fetch becomes `sagebrush remote saves fetch NAME [PATH]`, beside `saves list` and `saves delete`. `sagebrush remote fetch PATH` is now the workspace's own files.

### A.3 Sync correctness with files absent by design

These rules sit beside r3.3's "Needed from sync" items 3 and 4 (the disk watcher and the settle rule).

- **(r3.5, sync P1) The host keeps a durable state per file, by fid (the file's sync identity), not by path:**
  - **kept:** its contents are on disk at the version recorded;
  - **kept-pending:** it is to be on disk but isn't yet: queued, downloading, failed or paused (with the reason);
  - **in the cloud:** no row. A file with no row is in the cloud, so a lost or new state database never turns into deletes.
  - Absence is never a delete unless the file is "kept": the watcher and every rescan, including after a crash, read the absence of an in-cloud or kept-pending file as expected.
  - **Ordering:** a file becomes "in the cloud" (its row removed) BEFORE its local copy is unlinked (evict, budget drop). It becomes "kept" only AFTER its staged download is renamed into place. A crash between the two leaves an extra local copy or a pending row, never a delete.
  - **A budget drop** (a file leaving the keep set because the budget changed) obeys evict's rule: only a file exactly at its last synced sha is removed.
  - **(r3.6, sync C2) A crash's leftover copy is never a new local write.**
    - A file found on disk (at start, a rescan, or by the watcher) at an in-cloud or kept-pending path whose sha **equals** the listing's current version for that path is a leftover, not a write.
    - Whether to adopt or remove it is decided by a small durable **evict journal**: an evict (or budget drop) writes {fid, sha} to it before removing the row, and clears it after the unlink.
      - **(r3.7, sync C3) The journal is checked first, before any comparison with the listing.** If it names this fid with this sha, the interrupted evict is finished (unlinked again), whatever the listing now says. So an evict of v1 that crashed before its unlink, followed by the listing moving to v2, removes the v1 leftover, never uploading it as a conflict.
      - Otherwise (an interrupted fetch: renamed into place, "kept" not yet recorded), it is adopted as kept if equal to the listing's current version, by the A1 recovery rule otherwise.
    - Only a file whose sha **differs** from the listing's current version takes P2's path (the conflict-copy rename and upload).
    - **Rows:** (r3.7) an evict of v1 crashed before its unlink, then the listing moved to v2 before the restart: the leftover is unlinked, with no conflict copy and no upload; a crash between the journal write and the row's removal, between the removal and the unlink, and after the unlink (evict); a crash between the rename and "kept" (fetch). Each ends with no conflict copy and no upload, and the file adopted or removed as above. The control: a differing sha at the same path takes P2's path.
- **(r3.5, sync P2) A local write at an in-cloud path** (a kernel writing `results.csv` where the workspace has a `results.csv` the machine never fetched) is a write with no base. It never replaces the workspace's version.
  - **On disk:** the host renames the local file to the conflict copy's name, `results (conflict, mybox).csv` (no-follow, in the same directory, refusing if that name is taken, then trying the numbered names sync uses), and records it as kept.
  - **In sync:** the host uploads it under that name itself (a create at a free path), never a create at the occupied one. So the disk matches the listing: `results.csv` is in the cloud, and the conflict copy is local and synced.
  - The page shows the conflict as any other.
  - **If the local file matches `.sagebrushignore`**, it is never uploaded and never renamed. It stays at its path as a local-only file shadowing the cloud version. The page shows both ("results.pt: in the cloud; a different local copy on mybox, not synced"). A Fetch of that path refuses without `--replace`, which keeps the local copy aside first (as `(from Sagebrush)` does).
- **Moves and deletes made elsewhere** of in-cloud paths change only the listing, with nothing to do on disk. Of kept files, they change the disk as before (with the host's disk.rs-style expected-state checks).
- **Sync-before-start** (r3.3, Story A) waits only for the notebook's document and the keep set's files in the notebook's folder, at the page's position, not for in-cloud files. So start-up time doesn't grow with the workspace's size.
- **Needed from sync (new, item 5): partial materialization in the headless client.**
  - The whole index is applied, and contents are fetched for the keep set and on demand.
  - It needs the per-path state, the budget's ordering, eviction against the last synced sha, and conflict copies for writes at in-cloud paths.
  - This is the sync owner's lane, with the host hookup paired.

### A.4 Missing-file errors

- **The Sagebrush entries (the engine).** The engine's file layer on the host knows the listing. Opening an in-cloud path in the workspace fails with the engine's FileNotFoundError, naming how to get it: "data.bin is in the cloud, not on mybox: fetch it with `sagebrush remote fetch data.bin`, or Fetch in the file browser". It never fetches by itself.
- **(r3.5, ENGINE's conditions, for both paths; SEC accepts the hook as a disclosed advisory only):**
  1. **The listing changes only the error's words, never whether a read succeeds.** The disk is tried first; the listing is consulted only after ENOENT. A file fetched while the listing is stale opens normally. A test covers that race.
  2. **The error is a real FileNotFoundError:** errno ENOENT, `.filename` the person's own path, and the hint only in the message.
  3. **No automatic fetch on either path.** Opening an in-cloud path leaves the disk and the listing unchanged, kept in tests.
- **Native (Python), the machine's CPython.**
  - Open calls can't be intercepted in general. An in-cloud file simply isn't on disk, so code gets the ordinary FileNotFoundError.
  - **The audit hook (ENGINE CLEAR with conditions; SEC's view at freeze):** the sagebrush_kernel bootstrap installs `sys.addaudithook` for the `open` event.
    - **Only `open` in read modes** (no `w`, `x`, `a` or `+`). Never `open_code`, imports or any other event.
    - **The hot path:** a cheap prefix check against the workspace root first. For a path under it, one lookup in the in-cloud table. For a hit, `os.path.exists` (so a file fetched since passes: condition 1). Only then does it raise FileNotFoundError (ENOENT, `.filename` the path, the hint in the message).
    - **The in-cloud table, bounded memory (LIMITS H1):** the host writes, into the kernel's private directory (owner-only, replaced atomically), a read-only open-addressing hash table of the in-cloud paths' 16-byte hashes, in fixed-size records. The hook maps it read-only. A lookup is O(1) expected and reads one record, and the memory is the operating system's page cache, not the kernel's heap. The file's size counts on the volume's accounting.
      - (r3.7, LIMITS) A mapping is not zero physical memory: the table's pages a kernel touches are resident, in its resident set. The table's size is known (a header plus 16 bytes per in-cloud file, at a load factor of at most one half), and the host charges it per kernel on the memory ledger, as a buffer, before it starts the kernel or replaces the table.
    - **Refreshing:** the hook checks the table file's mtime at most once a second. That is the only I/O on the hot path besides the lookup.
    - **(r3.5, SEC's conditions)** The table file is written by the host with an atomic replace into the kernel's private directory, and the hook opens it with no-follow. Its parse is strict and bounded: a fixed header (magic, version, record count within the file's size), fixed-size records, and a hash of normalized relative paths, never a path from outside the workspace. A table that fails any check is ignored, and the hook falls back to the plain ENOENT. The hook never fetches, never grants anything, and has no effect on any path outside the workspace's in-cloud set. Same-UID Native Python can rewrite or remove the hook and its table, so it is integrity-advisory only.
    - **What it covers:** Python-level opens (`open`, `io`, `pathlib`, and libraries that open through them), not C-level ones (a C extension's own `fopen`, `mmap` of a descriptor opened elsewhere). It is documented as a convenience, **not a security boundary**, and the pros and cons panel says so.
- **The Python `sagebrush://` reader (fsspec)** is not part of this amendment. It goes to the Python lane separately.

### A.5 What the person sees

- **File browser:** a kept file shows normally. An in-cloud file shows a cloud mark, its size and Fetch. A folder shows "Keep on this machine" and "Free up space".
- **Pros and cons panel (the "On mybox" side), added:** "Your notebooks, code and small files are on mybox. Other files stay in the cloud until you fetch them, so large workspaces start fast. Code that opens a file still in the cloud gets 'file not found'; Sagebrush kernels name the fetch command."
- **`sagebrush remote status`:** the keep budget and how much of it is used, the number of files in the cloud and their total size, and fetches under way.
- **Deleting the machine (r3.3, Story B):** the warning adds "Nothing in the cloud is lost: in-cloud files were never only on mybox." It still lists the local-only files (ignored, over cap, unsynced changes).

### A.6 Story updates

- **Story A (Magma on a big machine):** the kernel waits only for the notebook and its folder's keep set. A 40 GB workspace starts as fast as a 40 MB one, and a data file the notebook reads is fetched with one click (or is already kept, if marked).
- **Story B (PyTorch on a GPU machine):** unchanged in substance. Datasets and weights are created on the machine and live there. Inputs that live in the workspace are fetched once, or marked "Keep on this machine".

### A.7 Notes for the lanes

- **SEC:**
  - Eviction never removes unsynced bytes, checked against the last synced sha immediately before the unlink.
  - Fetch and evict act inside the validated root with no-follow (r3.3's D2 condition and S2).
  - The audit-hook listing, if adopted, is owner-only and holds only paths.
  - Agents fetch only with a grant for it (r3.3's grant verbs: fetching a workspace file is the `fetch` verb).
- **LIMITS:**
  - The keep budget is derived from free space, visible and changeable, and never a fixed number.
  - Fetch is metered by `read_bytes_per_day`.
  - (r3.5) The listing's memory: the host's on-disk index with a fixed, ledger-charged page cache and bounded update batches. The hook's table is a mapped file in the page cache, not heap (A.2, A.4).
  - (r3.5) The disk budget's stable baseline and the volume's own accounting (A.2). Acceptance rows: a stable pass (the budget unchanged by its own downloads); a fetch racing the budget pass; a replacement's overlap counted; a large index and a large hook table with memory flat; (r3.7) a written stage against an unwritten reservation (the written bytes counted once, in the reading); a reservation shrinking only after an fsynced write; ENOSPC mid-download (the destination unchanged); and an unknown volume reading (no download).
  - The small-file threshold is a visible, changeable default.
- **Sync:** item 5 above. The per-path state and the conflict rule for writes at in-cloud paths are the review points.

## B. The remote engine (William, Nov 26, about 9:35 AM PST)

This replaces r3.3 D1's "Cores and memory, honestly" paragraph and recasts missing item 7.

- William: "We do NOT want to guarantee results identical to the browser!! In fact, the reason for using remote compute is so that things are possibly different to the browser: faster; actually works at all." And: "the remote machine can easily be a completely different architecture (arm versus x86)"; "the approach involves our rust kernels and using js instead. But to a user it's no different. They should just run a 'sagebrush' command to configure and start their remote daemon."
- **The four Sagebrush entries run the same TypeScript/JS runtime under Node, with the Rust engines loaded natively** (an N-API addon, missing item 7). That is the remote's primary engine.
  - The WebAssembly bundle under Node is a bridge only, until the addon ships for the platform.
  - The choice is made from the installation, never from free memory: a native addon whose build matches the bundle means native; otherwise wasm, said once. A memory refusal is a clear MemoryError. William's no-silent-fallback rule stands.
- **The bar is correct results**, checked against the oracles (Sage, Magma, MATLAB Online, NumPy) and the project's corpora, not identity with the browser. A native-versus-wasm diff stays as a diagnostic, not a gate.
- **Platforms:** linux-x64-gnu, linux-arm64-gnu, darwin-arm64 and darwin-x64. Each platform's pieces are listed in the per-version manifest with their sha256:
  - a pinned Node runtime (the official build of CI's major version): its archive, checked at fetch, and its extracted executable, checked at every launch;
  - the engine bundle, one for all platforms, with its build id;
  - the addon, with its build id and the N-API level it needs. The launcher refuses in words if the fetched Node's level is lower.

  The wheel pins the manifest's canonical bytes.
- **Linux with musl** (such as Alpine) is detected and refused in words ("this machine's C library (musl) isn't supported yet"), never given a download that fails at load.
- **No manual installs.** One `sagebrush` command (by uvx) configures and starts the remote daemon. It fetches and verifies its platform's pieces itself, under SEC's bundle conditions: a compiled-in HTTPS origin; staging with no-follow and exclusive creates; verify before use and at every launch; fsync and an atomic activate; the prior verified version kept; no downgrade; Node's environment minimal.
- **(r3.5, SEC B1) Node's archive is extracted safely.**
  - It is extracted only into a new owner-only staging directory, made for this extraction.
  - The member list is checked against an expected-member allowlist for that Node version (the files and directories the runtime needs, with their kinds), named in the manifest as part of the node entry. Anything else is refused before any byte is written: absolute paths, `..` components, duplicate members, special files (devices, FIFOs, sockets), and any symlink or hardlink member whose target would leave the staging tree.
  - **(r3.6, SEC B1) Only what runs is extracted, and every piece of it is bound.**
    - The allowlist names the members the runtime loads, each a regular file with its sha256: for Node's official build, `bin/node` alone, since it is one self-contained executable. The other members of the archive (headers, npm, docs) are skipped, never written, so there is nothing else in the tree to load.
    - The **bound set** of a version is every executable or loadable regular file it runs: `bin/node`, every file of the engine bundle (JavaScript, WebAssembly, data), and the addon where there is one. Each has its sha256, size and mode in the manifest.
    - **Through activation:** after extraction and before the activate, every member of the bound set is re-read under the held handles (opened no-follow, regular file, owner the person, not group- or world-writable) and its sha256 and size checked. The activate is the atomic rename of that exact tree. Any difference refuses the version, and the prior one stays.
    - **At every launch:** the whole bound set is checked again the same way, under handles held from the version's root, before Node is started. A version whose set doesn't check is refused in words, never used, never replaced by another version silently.
    - What remains is the window between the launch's check and Node's own reads: same-UID code could change a file in it. That is the same threat model as the tool checker (owner-only folders); it is stated, not hidden.
  - Members are created with no-follow and exclusive creates, relative to held directory handles, never by path through the tree being built.
  - After extraction, the executable's sha256 (the manifest's node.bin) and its mode (owner-executable, not group- or world-writable) are verified, and every directory's owner and mode.
  - The exact verified tree is activated through the held handles (an atomic rename of the staging directory into the version's place). The prior verified version stays active until then; a crash at any point leaves the prior version, and an unfinished staging tree is removed at the next start.
  - **Acceptance rows:** traversal (`../x`, absolute), links escaping (symlink and hardlink), duplicates, a special file, a member not on the allowlist, a wrong executable hash or mode, a crash before and after the activate, and a replacement of a staged member between verify and activate: (r3.6) `bin/node`, and also a loadable file other than it (a bundle JavaScript file, the addon), each refusing the version; and at launch, any bound member changed after activation, refused.
- **Consequences in r3.3:**
  - The "up to 4 GiB" label beside the Sagebrush entries applies only while a platform runs the wasm bridge.
  - Missing item 7 is the primary path, not an add-on for more than 4 GiB.

## Order of work (the changes only)

- **P2c** builds the fetcher, manifest, verification and pinned Node on the bridge. The addon's entries are added by the engine lane's N2.
- **Files over sync (r3.3 step 5)** gains item 5 (partial materialization) and A.4's engine error. The audit hook follows only if ENGINE and SEC accept it.
