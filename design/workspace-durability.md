# The workspace's durability in a browser

*Status: design note, for astra and daybreak2, then William. Docs only. @sagebrush-board, Oct 20.*

- **Revision 2** answers astra's CORR-045-1 to 4 and daybreak2's LIMIT-DUR-1 to 3.
- **Revision 3** adds part A's reset protocol (astra, on 7b167969) and moves part B to design/workspace-recovery-copy.md.
- **It is in two parts:**
  - **Part A, detection,** is small and precise, and is built first.
  - **Part B, the recovery copy,** is its own architecture, with the promise it can keep, in design/workspace-recovery-copy.md.

## 1. The finding

A browser killed at the wrong moment can make Chrome **delete everything the site keeps in IndexedDB** on its next start: the workspace index, data files' bytes, boards, notebooks and their histories, and the old store. The page is told only by a non-standard flag.

**How it was reproduced:** on Chrome 155.0.8059.84 (Linux), by the workspace-crash test, which SIGKILLs the browser while the migrator writes. Chrome's log on the next start:

```
backing_store.cc:237]  Failed to open LevelDB database from …/http_127.0.0.1_35697.indexeddb.leveldb, Corruption: checksum mismatch
backing_store.cc:1642] Got corruption for { origin: http://127.0.0.1:35697 … }, checksum mismatch
backing_store.cc:1502] IndexedDB recovering from a corrupted (and deleted) database.
```

- **On disk:** before the restart, `indexeddb.blob` held 125 files (13 MB) and `leveldb` 6 files. After it, only a new, empty `leveldb`.
- **Frequency in that experiment:** 1 kill in about 290, with 24 concurrent browsers beside 40 CPU hogs; none in about 280 kills under lighter loads. This is evidence of one process-kill failure, not a measured rate of loss for people.
- **Deterministic reproduction:** flipping bytes at the tail of the LevelDB `.log` before a restart gives the same deletion every time.
- Details, and what was ruled out: /home/user/notes/workspace-crash-empty-origin.md.

**Chrome does this by design.** It deletes all of an origin's IndexedDB when the backing store is corrupt at open, and tells the page through `dataLoss: "total"` and `dataLossMessage` on the `upgradeneeded` event. These fields are non-standard, but in Blink's current IDL.

**In other browsers** (desk research only, no measurement):
- **Firefox:** bug reports show a database that stays unopenable until the site's data is cleared (Mozilla 1230737, 1849842).
- **Safari:** WebKit reports show databases dropped to version 0 on iOS (WebKit 200078).
- **Safari's cap:** WebKit deletes a site's script-writable storage after seven days of Safari use without user interaction with the site, and treats Home Screen web apps separately (webkit.org/blog/10218).
- **What we don't know:** the relative rates of these failures.

## 2. What we promise, honestly

**In a browser:**
- **Detection (part A):**
  - when a record that survived says this browser held a workspace, or the browser itself says it deleted one, and it's gone or older, the person is told at once, and nothing writes until they decide;
  - a complete clearing of the site's data (by the person, a private session ending, Safari's cap, or eviction) removes every local record with it, and looks exactly like a first visit; we can't tell those apart without a record off the device (a synced account);
  - storage we can't read is reported as unknown, never as empty.
- **Recovery (part B):**
  - this browser keeps a second copy of the workspace, at most some seconds behind, and the Storage panel shows how old it is;
  - a restore brings the workspace back as of that copy's last committed point, and says what that point was;
  - changes made after it are lost: normally under 10 s, and longer while the copy is paused (it says so);
  - the copy shares the browser's fate where the browser clears or loses everything of the site.
- **Off this device:** sync, and an export the person keeps.

**In the desktop app**, the workspace is files in a folder the app owns, plus SQLite (WAL) for the index:
- every change writes its bytes first (a temporary file, fsync, rename, then the directory's fsync), and then commits the index;
- so an acknowledged change survives a crash or a power cut, as far as the disk keeps what it said it wrote;
- it doesn't survive the disk's loss or the files' deletion;
- that is a stronger promise than a browser allows, not an absolute one.

## Part A. Detection (build first)

### A.1 The witnesses

Two markers outside IndexedDB, each `{v: 1, workspace: id, generation: g, seq, entries, sampled: t, reset?: {to, kind, at}}` (about 250 bytes):
- **`seq`** is the workspace's committed counter, `Workspace.generation()`: the latest op seq or the floor of the dropped ops, whichever is larger. It never goes down: deletes, pruning and dropping ops don't lower it.
- **`workspace`** is the workspace's id. **`generation`** is bumped by a deliberate reset: "Start a new workspace", an import that replaces, or "Delete this browser's workspace" (A.3a).
- **IndexedDB keeps its own `(workspace, generation)`** in `meta`, written in the transaction that creates or resets the workspace. That's what the witnesses are compared with.
- **`reset`** is a prepared reset (A.3a): the generation it goes to, and why.

**Where they live and when they're written:**
- **localStorage `sagebrush-workspace-marker`:** written in the same Web Lock hold (`sagebrush-workspace`) as each commit, right after the commit's transaction completes. That covers the first save: the marker exists before the save is reported.
- **OPFS `/sagebrush/marker.json`:** written by the same lock holder, at most every 10 s and on `visibilitychange` to hidden.
- **No regressions:** a marker is replaced only by one with the same workspace and a higher (generation, seq), compared inside the lock. Tabs hold the lock in turn, so an older tab can't publish an older seq.
- **The first-save window:** the time between a commit and its marker write, inside one lock hold. A clearing of IndexedDB alone in that window is the case not covered.
- **A witness write that fails** (localStorage full or denied, OPFS unavailable) doesn't fail the save. That witness is marked unavailable for the session. The Storage panel says "loss can't be detected in this browser now", and the next commit tries again. A witness behind IndexedDB is harmless: only IndexedDB behind a witness means loss.
- **A stale tab** (one opened before a reset) can't write the witnesses or the workspace. Inside the lock, each commit checks that IndexedDB's `(workspace, generation)` is its own, and otherwise reloads, as the existing old-tab prompt does.

### A.2 What the page decides at open

| State | When | What the person sees |
|---|---|---|
| **Confirmed loss** | `upgradeneeded` with `dataLoss: "total"` (Chrome), or the open made the database new (`oldVersion` 0) while a witness has this browser's workspace | "This browser's copy of your workspace was lost. The browser reported it damaged, or it's gone. It had 312 entries when last recorded, <time>." The marker's sample time is its last record, not the time of the loss. |
| **Suspected loss** | with the same workspace and generation, the workspace's `generation()` is below a witness's `seq`: changes it had are missing. Or IndexedDB's generation is below a committed witness generation (no prepared reset explains it): the newer workspace is gone | "Some recent changes to your workspace are missing from this browser (it has up to change 1,204; it had 1,250)." |
| **A reset in progress** | a witness holds a prepared `reset` (A.3a) | It is finished or rolled back first (A.3a); then the table is read again |
| **Unknown** | IndexedDB won't open (Firefox's failure), or a witness can't be read (private browsing, storage denied) | It says so, and that loss can't be detected here. It never treats this as a first visit. |
| **First use, or cleared** | no workspace and no witness | Nothing, as now. Indistinguishable from a complete clearing (§2). |

- **Deliberate changes are never taken for loss:**
  - a reset or a replacing import goes through A.3a's prepared and committed steps;
  - IndexedDB at a higher generation than the witnesses (its witness write failed or was cut off after a committed reset) is IndexedDB being ahead. The witnesses are written again to match, and it isn't loss;
  - a mass delete or pruning doesn't lower `seq`;
  - there's no entry-count heuristic.
- **Missing or corrupt markers:**
  - one marker missing or corrupt: the other is used;
  - both missing: first use or cleared;
  - both present and disagreeing: the higher (generation, seq) counts.
- **Other workspaces:** a witness with another workspace id is kept and reported as "a different workspace this browser had", never compared as this one's.

### A.3 Quarantine

In **confirmed** or **suspected** loss, the workspace opens **quarantined**. Every writer stops until the person decides:
- the workspace's verbs (they refuse with "quarantined", the agents' too);
- autosave and the board's and notebook's saves (the editors open read-only, saying why);
- the migrator, reconcile, the sync sender and adoption, the recovery copy's writer (part B), and the markers themselves.

**The choices:** restore (part B, when there is a copy), restore from sync, import an export, or "Start a new workspace here". Starting new is a reset (A.3a), which then lifts the quarantine. In the **unknown** state, the workspace works as far as storage allows, with the notice.

### A.3b The stores outside the workspace's lock: a fence

**Every store a page writes, and whose it is** (the ownership list: `ownedByWorkspace` in web/notebook/stores.js decides what the workspace governs, never whether a fence happens to be there):

| Store | What it holds | Owned by the workspace | Governed by |
|---|---|---|---|
| IndexedDB `"sagebrush-workspace"` | the workspace: entries, bytes, versions, trash, ops, meta | yes | its lock (A.2) |
| IndexedDB `"sagebrush"` / `notebooks` | the notebooks the editors save | yes, every record | the fence |
| IndexedDB `"sagebrush"` / `files` | the store before the workspace | yes (read only through the workspace's verbs, or with no workspace at all) | migrate, and the purge after a reset |
| IndexedDB `"sagebrush-history"` | the notebooks' TimeTravel | yes, every record | the fence |
| IndexedDB `"sagebrush-board-history"` | the boards' TimeTravel | only the workspace's own boards' (`board:local:` and a 12-hex ref); an example's, an unsaved board's, a board in the address's or in another site's frame are not, and keep their history whatever the workspace's state, deliberately | the fence, for those it owns |
| IndexedDB `"sagebrush-blobs"`, `"sagebrush-board-images"`, `"sagebrush-board-docs-2"`, `"sagebrush-outputs"` | content by its hash, and caches | no: they hold nothing a lost workspace could be confused with | none |
| localStorage `sagebrush-board:local:`, `sagebrush-workspace-pending:`, `sagebrush-workspace-pending-unread:` | boards before the workspace (`sagebrush-board:local:ID`); a workspace board's marks (`sagebrush-board:local:REF#here`, `#outputs`) and the board page's pending copies of its unsaved edits | yes: the old ones the old generation's, those naming a board the workspace has now the current one's | the board page's save (refused while quarantined, resetting, purging or closed), migrate, and the purge, which removes a key only if the board it names isn't the workspace's now |
| localStorage `sagebrush-boards` | the list of those boards | yes, read by migrate only | harmless once the boards it lists are purged: migrate finds nothing under it |
| other localStorage keys | preferences (theme, mode, panels, tools, recent files, console history), the migrator's progress, the witness | no | none |

The workspace keeps a **fence** (which also names the workspace's own database) in each IndexedDB store the editors write without its lock (`"sagebrush"`/`notebooks`, `"sagebrush-history"`, `"sagebrush-board-history"`): a record of its own, `{workspace, generation, step, phase}`. Its phase is one of:
- `ok`;
- `quarantined`;
- `resetting`;
- `purging`: a reset's old-store purge not yet finished.

**Writing the fence:**
- It is written holding the workspace's lock, at every open and every change of state, by compare-and-set in one transaction.
- It is never replaced by an earlier generation's, so a tab left over from before a reset can't put its fence back.
- **It is never deleted** (astra's CORR-2A4-2 on 28f6511b): a fence's absence reads as a store the workspace never had. A fence that can't be written marks its database **blocked** in meta (`fenceBlocked`); meta refusing that mark fails the open. So does a fence of a **later generation** found there (the workspace's database rolled back behind the editors' stores: astra's CORR-56C-1): it is never taken for the fence written. The next open writes the fence again; when that succeeds the database is unblocked. A reset goes to a generation past every fence left in those stores, so a rolled-back workspace's choice ("keep" or "new") writes them again.
- A tab whose identity meta no longer holds writes no fence.

**Checked by every write to an owned record** (astra's CORR-2A4-2 on 0eefec71), whatever the page did or didn't wire:
- **Binding:** a store is bound to the fence it found when it loaded, read in the same transaction as the document.
- **Checking:** each write (a save, a history append, clear or drop) reads the fence in the write's own transaction. It is allowed only if the fence is that same workspace and generation, in phase `ok`.
- **Confirming with the workspace** (astra's CORR-2A4-2 on 56c60932): before each write to an owned record, the store reads the workspace's own meta, in the database the fence names. The write goes only if meta positively says so: its identity the fence's, no quarantine, no reset or purge under way, and this database not blocked. An error, a denial or a missing database refuses. This is what holds a store in another copy of the module, another tab, or a page with nothing wired, without localStorage and with the broadcasts missed.
- **Ordered by the workspace's lock** (astra's CORR-2A4-2 on 51106cb6): a read of meta, however positive, says nothing of a quarantine decided just after it, whose fences could then fail to be written. So each owned write holds the workspace's Web Lock, shared, from its reading of meta until its own transaction has ended. What decides a quarantine or a reset, and what writes the fences, holds it exclusively. A quarantine is decided either before the read (which refuses) or after the write (which it then covers). The workspace's own verbs, which save notebooks holding the lock already, say so (`lockHeld`), so they don't wait on themselves. A clear or a drop is checked first without the lock, then again inside it with its deletion. Cost on sagebrush-2, 100 saves: a median of 0.8 ms (p95 0.9) against 0.5 ms (0.6) for a database the workspace doesn't own.
- **One queue per history store** (astra's CORR-511-1): appends, clears and drops run in the order they were asked for, and each tells the other tabs at its turn.
- **Never frozen by a stuck tab.** Another tab can hold the lock for a long time, or for good.
  - A save, a clear or a drop waits for the lock at most LOCK_WAIT (10 s), counted from when it is asked for, its time queued behind a store's appends included (daybreak2's LIMIT-9D7-1, astra's CORR-9D7-2). Then it is refused, saying the files are busy. Its lock request is withdrawn with an AbortSignal, and its turn in the queue, if it hadn't come yet, does nothing. So it can never take the lock later and write after it said "not saved".
  - A refused save is a rejection, never a "saved". The notebook editor keeps the change as not saved, says so in its status line, and sends it again: the shown notebook's with its next flush, a notebook already left by the next `saved()`, which counts it as outstanding until then (at most MAX_LEFT of them, as before). A document's saves are numbered, so only its newest busy refusal is kept, and a later save that succeeds supersedes it: an older edit is never sent again over a newer one (astra's CORR-9D7-1).
  - A history append waits in its queue, holding up nothing. The appends waiting in a page are bounded, all history stores together: HISTORY_BACKLOG, 1,000 entries and 8 MiB, each append held while it waits as its JSON text alone, made when it is asked for, and charged twice that text's length (UTF-16 code units, two bytes each) and ENTRY_OVERHEAD (256 bytes): what is charged is all that is held, whatever the envelope's shape, and parsed only at its turn, one at a time in a store (daybreak2's LIMIT-9D7-2 and LIMIT-5B7-1). An envelope that isn't plain JSON data (a buffer, a typed array, a Map, a Set, a Date, undefined in an array) is refused; an undefined property, which JSON leaves out, is not (patchflow's envelopes have one). It is read through property descriptors alone, into an inert copy that is what is measured and written: no getter or serialization hook ever runs, and a getter, a setter, a function among an object's own values (a toJSON, enumerable or not), a hole in an array, or a toJSON on Object.prototype or Array.prototype is refused, without throwing (astra's CORR-C05-2). Its text's exact length is known before any of it is written, by a walk that meets each object once: a cycle (an object met again on the path being walked) is refused, a child shared in a DAG counts its remembered size without being walked again, and an entry whose text would pass what the backlog can still take is refused there (daybreak2's LIMIT-7865-1, astra's CORR-786-1). The 8 MiB bound is unconditional, one entry alone included (daybreak2's LIMIT-C05-1): an entry whose charge would pass it (its text past about 4M characters, more than any board, which is at most 5 MiB) is never kept in TimeTravel, and the page says "this version is too large to keep in TimeTravel". Its document is saved all the same: the save is a separate write, which a history refusal never touches. One past the bound is refused, not queued. Both pages say so in a notice that TimeTravel can't keep up while the files are busy: some of the latest history isn't kept.
  - The OPFS witness's background flush takes the lock only if it is free now (`ifAvailable`), and otherwise tries again 10 s later, so it never waits behind another tab's hold.
- **Failing closed:** a fence that appeared since a store found none, or went since it found one, refuses the write. A store that found none writes only into a database the workspace has never fenced (before its first open), which can't hold the workspace's records yet.

**The page:**
- The notebook page opens the workspace (at most a few seconds) before it loads any notebook.
- The board page's save keeps nothing, not even its pending copy in localStorage, while the workspace is quarantined, resetting, purging, or closed; its local board's history is refused by the fence.

**One reset at a time** (astra's CORR-28F-1): a reset's cleanup lets go of the lock between pages, so admission is checked holding it:
- A reset to a new workspace asked while another is admitted (meta's `resetting`, from this tab or another, its broadcast seen or not) **joins** it: it carries the same cleanup on to the target the first chose, and reports that target. It never chooses its own.
- Any other reset meanwhile ("keep", or anything during the purge) is refused as busy.
- A reset from a tab whose workspace was reset elsewhere is refused (its identity is stale).
- Completion is checked against the primary: the witnesses and fences are published only if meta's identity is still the target.

**A purge after a reset to a new workspace:**
- The old store's notebooks and files go first, a page at a time; until they are gone the workspace is "purging" and every write is refused.
- Then localStorage's boards and pending copies, LOCAL_PAGE keys a step from one listing (daybreak2's LIMIT-28F-1), marked pending (`purgeLocal`) in the same transaction that ends the first part. Storage that can't be had, listed or emptied is **unknown, never empty** (astra's CORR-2A4-3 on 28f6511b): the marker stays, `migrate` brings nothing in, and every open tries again.
- Writers aren't held up by it, so the new workspace's boards write their marks and pending copies under the same prefixes meanwhile. A key is removed only if the board it names (its 12-hex ref) isn't one of the workspace's now, read just before its removal (astra's CORR-2A4-3 on 56c60932). The old generation's boards are all gone from the workspace by then, and a new board's ref is new.
- Both go a page at a time, as does the reset's cleanup, an open resuming them for at most 250 ms and then in the background.

### A.3a Reset and replacing import: prepared, then committed

Every deliberate reset follows four steps, holding the workspace's lock throughout:
1. **Prepare:** both witnesses get `reset: {to: g+1, kind, at}`, keeping generation g. If a witness write fails, the reset is refused, saying why, and nothing changes.
2. **Reset IndexedDB:** one transaction writes the new workspace, empty or imported, with `meta` at `(workspace', g+1)`. A large import is written into a staging generation and switched to g+1 by that one final transaction.
3. **Commit:** both witnesses get generation g+1, its seq, and no `reset`.
4. **Report:** only now is the reset reported done.

**At open, a witness holding a prepared reset to g+1 is resolved first:**

| IndexedDB is at | Meaning | Done |
|---|---|---|
| g, readable | stopped before step 2: the reset never happened | rolled back: the witnesses' `reset` is cleared; the workspace stays at g, and no loss is claimed |
| g+1 | stopped after step 2 | finished: the witnesses are committed at g+1 |
| new or empty (no generation) | the database was deleted or lost during step 2 | for "Start new" or "Delete": finished at g+1, since that was asked for. For an import: "the import was interrupted", with a retry |
| g, unreadable | unknown | the unknown state, with the reset still prepared |

A generation in IndexedDB that matches neither g nor g+1 is suspected loss. A tab that finds its own generation stale reloads.

### A.4 Tests

- **The real fault:** the crash harness's flipped-bytes restart (Chrome deletes the origin and sets `dataLoss`) gives confirmed loss, with the witness's numbers, and every writer quarantined, each one tried.
- **First visit vs. full clearing:** a true first visit, and the same with every local store removed. Both show nothing, which is the honest indeterminate result, said in this note.
- **The first save:** a first save, then IndexedDB removed before any OPFS tick. The localStorage witness gives confirmed loss.
- **Witnesses:** one witness missing; one corrupt; both disagreeing.
- **Private or denied storage:** localStorage and OPFS made to throw gives unknown, never first use.
- **Two tabs:** committing alternately, with the OPFS writes delayed out of order. The markers never regress.
- **Deliberate changes:** a mass delete, then op pruning, then a reset: no false loss.
- **Reset boundaries:** a kill after prepare, after the IndexedDB reset, and after one witness's commit; each resolves as in A.3a's table, for "Start new" and for an import. A failed witness write at prepare refuses the reset. A failed witness write after a committed save doesn't fail the save. A stale tab opened before a reset can't write afterwards.
- **Partial loss:** IndexedDB restored to an older copy of itself gives suspected loss.

**Size:** 2.5 days.

## 3. Order of work

| # | Step | Size |
|---|---|---|
| A | Detection: the witnesses, the states, the reset protocol, quarantine (part A) | 2.5 days |
| B | The recovery copy: design/workspace-recovery-copy.md | about 11½ days |

A goes first, before more workspace code. It doesn't depend on B. Each step is its own branch.

## 4. Open questions

1. **For William:** in the browser, is the promise "told when a surviving record shows loss, restored from a copy at most seconds old, saying how old" the right one, with the stronger one kept for the desktop app?
2. **For William:** should sync be suggested more strongly (the switch offered once the workspace holds more than N files), since only sync survives a complete clearing?
3. (Answered by daybreak2) The recovery copy counts in this browser's storage, as overhead, not against plan storage.
