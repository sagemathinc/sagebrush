# The workspace's durability in a browser

*Status: design note, for astra and daybreak2, then William. Docs only. @sagebrush-board, Oct 20.*

## 1. The finding

A browser killed at the wrong moment can make Chrome **delete everything the site keeps in IndexedDB**: the workspace index, data files' bytes, boards, notebooks and their histories, and the old store too. It does so silently, on the next start.

It was reproduced on Chrome 155.0.8059.84 (Linux) by the workspace-crash test, which SIGKILLs the browser while the migrator writes.

- **Chrome's log on the next start:**

  ```
  backing_store.cc:237]  Failed to open LevelDB database from …/http_127.0.0.1_35697.indexeddb.leveldb, Corruption: checksum mismatch
  backing_store.cc:1642] Got corruption for { origin: http://127.0.0.1:35697 … }, checksum mismatch
  backing_store.cc:1502] IndexedDB recovering from a corrupted (and deleted) database.
  ```

- **On disk:** before the restart, `indexeddb.blob` held 125 files (13 MB) and `indexeddb.leveldb` 6 files. After it, only a new, empty `leveldb` remained.
- **Rate:** about 1 kill in 290 under load (24 concurrent browsers beside 40 CPU hogs). None in about 280 kills under lighter loads.
- **Deterministic reproduction:** flipping bytes at the tail of the LevelDB `.log` before a restart gives the same deletion every time.
- The details, and what was ruled out, are in /home/user/notes/workspace-crash-empty-origin.md.

**In real life, the same kill comes from:** the OS's out-of-memory killer, a force-quit, a power cut or a kernel panic, and a browser crash. The window is any IndexedDB write. Every change to the workspace is one, and data files' bytes make the largest.

**This is Chrome's documented design, not a bug we can wait out.** When an origin's backing store is corrupt at open, Chrome deletes all of that origin's databases and treats the open as a first one. It does tell the page: the `upgradeneeded` event carries `dataLoss: "total"` and a `dataLossMessage` (Chrome-only; Chrome engineers on public-webapps, 2013 and 2015).

**Firefox and Safari** keep IndexedDB in SQLite, which survives a kill better than LevelDB without sync. Desk research found no documented delete-on-corruption there; the evidence here is Chrome's.
- **Firefox:** bug reports show the other failure, a database that stays unopenable ("UnknownError") until the site's data is cleared (Mozilla bugs 1230737, 1849842).
- **Safari:** WebKit bug reports show databases dropped to version 0 on iOS (WebKit 200078).
- **Safari's 7-day cap:** it deletes all of a site's script-writable storage after 7 days without a visit, unless the site is installed to the home screen. That is the larger risk there, and nothing below defeats it except sync or an export.

## 2. What we can and can't promise

In a browser:

| We can promise | We can't promise |
|---|---|
| Never a silent empty workspace: if this browser had one and it's gone, the person is told at once, with what was there and when | That the browser keeps what it holds. It may delete it on corruption (Chrome), on eviction under storage pressure (`navigator.storage.persist()` only guards against eviction), on the 7-day cap (Safari), or when the person clears site data |
| What was lost is restored from the best copy there is, saying which: a second local copy, sync, or the last export | That any copy is newer than the last one taken |
| A crash loses at most what was being written | |

**In the desktop app,** the workspace is ordinary files in a folder the app owns, written with fsync and rename, plus SQLite (WAL) for the index. A crash there loses at most the write in flight, and the OS's own backup tools see the files. So the desktop app is where we can make the promise that a browser can't make.

## 3. What to build

### 3.1 Detection at startup (MUST, first)

**A marker outside IndexedDB, in two places:**
- the localStorage key `sagebrush-workspace-marker`;
- an OPFS file, `/sagebrush/marker.json`.

It is `{workspace id, generation, entries N, bytes, latest op seq, t}`, about 200 bytes. It is written after a change settles: at most every 10 s, and on `visibilitychange` to hidden.

**At open,** the workspace is lost if, and only if, any of these holds:
1. the open's `upgradeneeded` has `oldVersion` 0 while a marker exists;
2. `event.dataLoss === "total"` (Chrome says so directly, and it is kept with its `dataLossMessage`);
3. the index has fewer than N/2 entries and no op since the marker explains it.

**Then:**
- **A notice, never a silent empty workspace.** "This browser's copy of your workspace was lost (Chrome reported it damaged) on <date>. It had 312 files, last changed <date>." It offers the recoveries of §3.4.
- The new, empty workspace doesn't overwrite the marker until the person has chosen.
- **A database that won't open at all** (Firefox's failure): the existing "this browser's storage can't be opened" error, now with the marker's numbers and the same recovery choices. It never resets anything itself.

**Tests:**
- the crash harness's flipped-bytes restart: the notice is shown, with the right N;
- `dataLoss` set (by a test hook on Chrome);
- a cleared localStorage but the OPFS marker present, and the other way round;
- a first visit with no marker: no notice.

**Size:** 1.5 days.

### 3.2 A second copy of the index, in OPFS

The op log is already the index's history (design/sync-client.md §3: every op records its `after`). The reducer rebuilds an index from ops (web/workspace/sync-reduce.ts).

- **Writing:** the ops are appended to `/sagebrush/ops/<n>.jsonl` in OPFS, in the same settle as the marker, through a sync access handle in the workspace's worker, with `flush()`. Each segment is at most 4 MiB. A snapshot (`/sagebrush/index-<seq>.json`) is taken every 10,000 ops, and older segments are then dropped.
- **Recovery:** the snapshot, then the segments after it, through the reducer.
- **Loss:** at most the last settle's ops (10 s).
- **Size:** about 100 bytes an op. A 100,000-entry workspace's snapshot is about 15 MB.
- **Size of the work:** 2.5 days with tests (journal, snapshot, rebuild, the torn last line ignored).

### 3.3 Data files' bytes in OPFS

**Data files' bytes move from IndexedDB's `fileBytes` to OPFS files, `/sagebrush/files/<fid>`,** written to a temporary name, flushed, then renamed.

- IndexedDB then holds only small records, so each write is small, and a torn write costs at most what §3.2 restores.
- The migration is 1a's again, with OPFS as the target: batched, reserved, crash-safe, and the old copy dropped only after a content check.

**Caveat:** in Chrome, OPFS keeps its own small LevelDB of names. A tear there loses names, not the bytes' files. Rebuilding from §3.2's index, which names every fid, covers that.

**Size:** 3.5 days (the store behind the existing verbs, the migration and its crash test, quota).

Documents (notebooks and boards) stay in IndexedDB: their patch logs are many small writes. Their latest snapshot is copied to `/sagebrush/docs/<ref>.json` when a document's save settles, at most once a minute. So a lost IndexedDB still has every document as of its last minute, but without its history.

**Size:** 1 day.

### 3.4 Recovery

The notice of §3.1 offers, in this order, whichever there are:
1. **"Restore from this browser's second copy"** (§3.2, §3.3): the index rebuilt from OPFS, files' bytes in place, documents as of their last snapshot.
2. **"Restore from sync"** (design/sync-client.md): the account's index and files come down as on a new device, and documents' contents with slice 2.
3. **"Import your last export"** (workspace-files.md §7.11).

**After each restore:**
- **What is said:** what was restored, from where, as of when, and what wasn't (histories, the last seconds of changes).
- **What is kept:** a restore never deletes the second copy until the person has the workspace back. Each restore is logged.

**Reminders:** the Storage panel shows "Last export: 23 days ago" and, without sync, reminds weekly while the workspace holds more than 10 files.

**Size:** 2 days.

### 3.5 Asking the browser to keep it

`navigator.storage.persist()` is asked for once the workspace holds anything the person made. It guards against eviction, not against corruption. The Storage panel says whether it was granted.

**Size:** 0.5 days.

## 4. Order of work

| # | Step | Size |
|---|---|---|
| 1 | Detection: the marker, the notice, `dataLoss`, the unopenable case (§3.1) | 1.5 days |
| 2 | Asking for persistence (§3.5) | 0.5 days |
| 3 | The OPFS op journal and snapshots; rebuild (§3.2) | 2.5 days |
| 4 | Documents' latest snapshots in OPFS (§3.3) | 1 day |
| 5 | Recovery: the choices, the second copy, sync, an export (§3.4) | 2 days |
| 6 | Data files' bytes in OPFS, and their migration (§3.3) | 3.5 days |

That is about 11 days. Step 1 is the MUST, and goes first, before more workspace code: it turns silent loss into a told loss. Steps 3 to 5 make it a recoverable one. Step 6 makes it rarer. Each step is its own branch, with the crash harness extended to assert it (the flipped-bytes restart makes Chrome's deletion deterministic).

## 5. Open questions

1. **For William:** is "told, and recovered from the second copy, sync or an export" the promise to make in the browser, with "never lost" kept for the desktop app?
2. **For William:** should sync be pushed harder (the switch suggested once the workspace holds more than N files), given this?
3. **For daybreak2:** the OPFS second copy roughly doubles the bytes a workspace keeps (data files' bytes excepted). Does it count against the storage budget shown?
