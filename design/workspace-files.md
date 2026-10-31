# One workspace: notebooks, boards and files

*Status: approved by William (Oct 18, 11:31 PM PDT), with the answers in §10; step 1 is starting. Any visible UI goes to William with pictures before it merges. Mockups are in `design/workspace-files/` (`proto.html` and its screenshots).*

**Who's involved**
- Notebook page: no dedicated agent owner. William owns the product decisions; @sagebrush coordinates.
- Boards: @sagebrush-board, who wrote this doc.
- The Python runtime and kernel (what Python's `open()` sees): @sagebrush-python.
- Service-worker caching: through @sagebrush.
- Reviews: @sagebrush-astra for correctness and UI, @sagebrush-daybreak2 for limits and input.

**William's request (Oct 18):** today a notebook has File → Upload and File → Open, and a person can keep many notebooks. A whiteboard works completely differently: its File → Open is a long, cluttered menu item that really means *upload*, and boards seem not to be kept at all. The notebook's Files panel shows data files but not notebooks. He wants one real, consistent UI for notebooks, files and whiteboards.

**In short:**
- There is one **workspace**: a tree of named files in this browser. A notebook is `name.ipynb`, a board is `name.board.json`, and a data file is whatever it's called.
- One index lists them all, and one **file browser** shows them (a sidebar on the computer, a full-screen sheet on a phone).
- Both editors get **one identical File menu**.
- The URL names the file being edited: `/w/<path>`.
- Boards move out of `localStorage` into IndexedDB, as notebooks already are.
- The existing formats don't change. Every board and notebook a person has today shows up in the workspace. Nothing is deleted on the way.
- For a signed-in account, the workspace is **backed up and synced across devices** (§7), building on the patch history that TimeTravel already keeps.

**The mockups** (`design/workspace-files/`, 1280×800, or 390×844 for the phone ones; open `proto.html?s=<name>` to see them live):

| Screenshot | What it shows | Section |
|---|---|---|
| `nb.png` | The notebook with the file browser, and File ▸ New open | §3, §4 |
| `board.png` | A board with the same browser and the same File menu, with Download ▸ open | §3, §4 |
| `open.png` | File → Open… while files are dragged onto the `data` folder | §4 |
| `preview.png` | A data file's preview, and Upload's "Open as a board / notebook" | §3, §4 |
| `shared.png` | A shared collection as a read-only root | §5 |
| `quota.png` | A save refused because storage is full, and the storage panel | §6.3 |
| `phone.png`, `phonemenu.png` | The phone's file sheet, and File as a bottom sheet | §6.1 |
| `sync.png`, `phonesync.png` | Back up and sync: the laptop's panel, and the same folder on a phone | §7 |

---

## 1. Today

### 1.1 Where things are kept

| What | Where | Key | Reference |
|---|---|---|---|
| Notebooks | IndexedDB `sagebrush`, store `notebooks` | random id; the record's `name` is only a title, so two notebooks can share one | web/notebook/stores.js:45, :70; `IdbStore` :122-160 (compare-and-swap revisions, BroadcastChannel `sagebrush-notebooks`) |
| Data files (what Python's `open()` reads) | IndexedDB `sagebrush`, store `files` | path such as `/data.csv`; the value is the bytes | web/index.html:1590-1649; each interpreter is sent every file (`sendFiles` :1594, `filePut` :1603) |
| A notebook's TimeTravel | IndexedDB `sagebrush-history` | [notebook id, time] | stores.js:71, :173 |
| File contents a session read | IndexedDB `sagebrush-blobs` | SHA-256 | stores.js:77 |
| **Boards made here** | **localStorage** `sagebrush-board:local:<12 hex>`, listed in `sagebrush-boards` (at most 200) | random id | web/board/page.ts:43-125 |
| This browser's edits of a board opened from a URL or an example | localStorage `sagebrush-board:<source>` | the source URL | page.ts:145-146, :250-267 |
| A board's outputs and history id | localStorage `<saveKey>#outputs` | (a random 32-hex id) | page.ts:284-293 |
| A board's TimeTravel | IndexedDB `sagebrush-board-history` | `board:<source>:<id>` | stores.js:73; page.ts:149, :320 |
| A board's pictures | IndexedDB `sagebrush-board-images` | the picture's name | web/board/images.ts:28 |
| Slow code outputs (a cache) | IndexedDB `sagebrush-outputs` | | web/board/outcache.ts:164 |
| Remote and CoCalc boards (a cache) | IndexedDB, `IdbDocCache` | | web/board/cached.ts:82-95; bounded open in web/board/idb-open.ts |
| The last notebook, its language | localStorage `sagebrush-current`, `sagebrush-mode` | | web/index.html:1950-2049 |
| Shared collections | R2 and D1 on the server; served from `files.cocalcusercontent.com` at `/c/<collection>/<sha256>` | collection id and version hash | design/sharing.md; web/share/, web/files/ |

**One rule from stores.js:47-52 carries over:** an existing database is never upgraded, because an older tab or the installed app would block the upgrade. Every new store therefore goes in a **new database**.

### 1.2 Why boards don't seem to be kept

Boards *are* kept, but:
- **Nothing lists them.** The board page has no Open dialog for kept boards. Its "Open…" is a file picker (mount.ts:184-212). The only way back to a board is `?recent=MODE` from the notebook's ⋯ → Whiteboard, which opens the latest board in that language and no other (page.ts:107-123).
- **They live in `localStorage`.** That is about 5 MB per site, shared with everything else, and limited to 200 boards (page.ts:51).
- **An edited example is kept under the example's URL,** not as a board of its own, so it never appears in any list.
- **The board page isn't in the service worker's shell** (web/build.ts:365), so boards don't open offline at all.

### 1.3 The two File menus today

| Notebook (web/index.html:308-328) | Board (web/board/mount.ts:184-212) |
|---|---|
| New notebook | New board |
| New whiteboard | — |
| Open… (a dialog listing the notebooks in this browser, :368, `showOpen` :1563) | Open… (JSON, a board as HTML, JSON Canvas, Mermaid, a CoCalc board): a file *upload* |
| Examples… | Examples… |
| Open file…, Save as… (desktop app only) | Import Mermaid… |
| Duplicate | Duplicate (hidden) |
| Download .ipynb, .py, as marimo (.py), with history (.sbreplay) | Download as HTML (one file), Download JSON, Download JSON Canvas, Copy JSON |
| Upload .ipynb, .py or .sbreplay… | (this is what Open… does) |
| Print or save as PDF… | Print or save as PDF… |
| Copy share link / Share… (:1310-1363) | — |
| Install as an app… | — |
| Delete notebook | — (no way to delete a board) |
| | Revert to the original (hidden) |

**Data files** are in a separate panel, ⋯ → Files (index.html:241, :333), with Upload, Download and ✕ for each file. A file dropped anywhere on the notebook page is added there (:1645-1648).

---

## 2. One document model

### 2.1 The workspace

- The **workspace** is a tree of paths, `/` at the root, with folders.
- A path's **kind** comes from its extension:
  - `.ipynb` is a notebook;
  - `.board.json` is a board;
  - anything else is a data file.
- A document's **language** (Python, Sage, Magma, MATLAB) belongs to the document, as it does today. It isn't part of the name.
- Every entry can be listed, opened, renamed or moved, duplicated, downloaded and deleted, and appears in Recent.

### 2.2 Storage: one index, with the contents where they are now

A new database, **`sagebrush-workspace`** (new, because of the rule in §1.1), holds two stores:

- **`entries`**, keyed by `path`:
  - fields: `{path, kind, ref, mode, size, created, updated, opened}`;
  - `ref` points at the contents.
- **`boards`**, keyed by board id: the board documents, with the same compare-and-swap revisions and BroadcastChannel that `IdbStore` gives notebooks.

**Where the contents stay:**
- A notebook stays in `sagebrush/notebooks` under its id (`ref` is the id). `IdbStore`, TimeTravel and the sharing code are unchanged.
- A data file stays in `sagebrush/files` under its path (`ref` is that path). Python sees exactly what it sees today. Renaming a data file renames it in both stores, and posts `fsPut` and the delete to the running interpreters, which are told about uploads today.
- A board moves to `sagebrush-workspace/boards` under **the id it has today**. Because the id is kept, its history (`board:local:<id>:…`), its outputs and its pictures stay attached without being copied.

**Why not one store of bytes for everything?**
- A notebook's record is its live document. It has revisions, other tabs subscribe to it, and TimeTravel is keyed by its id. Turning it into `.ipynb` bytes on every keystroke would cost a great deal and gain nothing.
- `.ipynb` is the *name* and the *download*. It isn't the storage.
- This keeps the existing formats, as asked: a notebook downloads as the same `.ipynb`, and a board as the same JSON.

**Do boards keep a store of their own?**
- Yes, a document store beside the notebooks' store, under the one index.
- But they **leave localStorage.** localStorage is about 5 MB for the whole site, it blocks the page while it's written, and it set the 200-board limit.
- Pictures stay in `sagebrush-board-images`.

**The index and the contents are in different databases,** so one transaction can't cover both. The design never relies on one:
- **Creating something:** write the contents first, then the entry.
- **Deleting something:** see §2.4.
- **At startup,** a reconcile pass does three things:
  - contents with no entry get one under `/Recovered/`;
  - an entry whose contents are gone is shown greyed, "missing", and isn't removed;
  - a path that two entries claim is resolved by renaming the newer one `name (2)`.

### 2.3 Migration: everything there today appears, and nothing is deleted

The migration runs once per browser, on the first visit after the change, on either page. It is idempotent and goes item by item:

1. **Notebooks:**
   - each record in `sagebrush/notebooks` gets an entry `/<name>.ipynb`;
   - an untitled notebook becomes `Untitled.ipynb`;
   - names that clash get ` (2)`, ` (3)` and so on;
   - characters a path can't have (`/`, control characters) become `-`;
   - the record itself isn't touched.
2. **Data files:** each key in `sagebrush/files` gets an entry at the same path.
3. **Boards made here:**
   - for each `sagebrush-board:local:<id>` that parses as a board, the document is written to `sagebrush-workspace/boards` and read back;
   - only then is the entry `/<title>.board.json` added;
   - the `#outputs` id is copied into the record;
   - the localStorage copy is **left in place,** and a marker `sagebrush-board-moved:<id>` records when it was moved.
4. **Edits of examples and URL boards** (`sagebrush-board:<url>`):
   - each becomes a board of its own, `/Edited examples/<title>.board.json`;
   - it remembers its source, so Revert to the original still works.
5. **A key that doesn't parse** is reported once in the file browser ("2 old items couldn't be read: Download them"). It is never removed.

**An old tab can keep writing the old copy:** an older tab, or an installed app that hasn't updated, still writes `localStorage`. So on every startup the migration compares each moved board's localStorage `at` with its marker. If the old copy changed after the move, it is brought in as `<title> (from an older tab).board.json`. It is never merged and never overwritten.

**The old copies are removed only by the person:**
- the file browser's ⋯ offers "Free space used by old copies (1.2 MB)";
- this is only offered once every moved board has opened from its new copy;
- it is never automatic.

**What the migration does if it fails:**
- If IndexedDB can't be opened (some private windows), nothing moves.
- Boards then open from localStorage as they do today.
- The browser shows them read from there, with a notice.

### 2.4 Delete and Trash

- **Delete moves an entry to `/Trash/`.** The contents stay where they are.
- The status line offers **Undo.**
- **Empty Trash** (in the browser's ⋯, with a confirmation) is the only thing that removes contents: the notebook, board or file, together with its history and outputs.
- Nothing is removed from Trash by time or by quota pressure (see §6.3).

### 2.5 Versions of data files

Notebooks and boards keep every change (TimeTravel). Data files have had no history, so an overwrite or a delete lost the old bytes. That was the one gap in "nothing can lose your work" (§8.3), and versions close it.

- **When a version is kept:** before a data file is overwritten or deleted, by Python, an agent, the API or a person, the bytes it had become a version. They go in the store `versions` of "sagebrush-workspace", keyed by the file's own id, which a rename keeps.
- **Each version records:** when, by whom (the device, and the person or `agent:<name>`), its size and its SHA-256.
- **Retention is bounded, and counts against storage:**
  - the latest 20 versions of each file are kept, and none older than 30 days;
  - all versions together take at most 1 GB, and less if the browser's quota is tighter;
  - beyond that, the oldest versions go first, which removes nothing current;
  - the storage meter shows versions as their own part (§6.3).
- **If storage is too full to keep even the previous version,** the overwrite is refused and says so. Old bytes are never dropped silently.
- **Reading versions:** `history(path)` and `version(path, i)` list and read them (§8.2). TimeTravel shows them for a file, and "Undo this agent's changes" restores them.
- **Deleting old versions is easy, and only a person does it** (William, Oct 18: "make it easy for the user to explicitly delete old versions"). There are three places:
  - **per file:** "Delete older versions" in its history;
  - **per folder:** "Delete older versions in this folder" in the file browser's ⋯;
  - **in the Storage panel:** "Free N MB of old versions".
- Each says what it will free and asks to confirm, and each is logged.
- **Agents can't do it.** The API's `dropVersions` refuses a workspace acting for an agent, and the agent surfaces (§8.2) don't offer it.

### 2.6 Long histories: local snapshots (proposed, Oct 19)

**Today, opening a document replays its whole history.** `IdbPatchStore.loadInitial` reads every patch the document ever had (`hasMore: false`). A notebook used for months, whose runs also write the execution journal, gets slower to open with every session.

**A local snapshot bounds that,** with the same rule as the server's (design/sync-server.md §4.7). patchflow 0.12 already reads snapshot envelopes (`isSnapshot`, `snapshot`, `stopAtSnapshots`, and `loadInitial`'s `hasMore`), so the sync protocol is unchanged.
- **When:** after 500 patches, or 4 MB of patches, since the last snapshot. It is taken by the tab that commits, at its head, only when the head is a clean cut (`isCut`) and its value checks out (`verifyValue` isn't "mismatch"). Otherwise it waits for the next commit.
- **Where:** a `snapshots` store beside `history` in both history databases, keyed `[doc, time]`. The latest 3 are kept, and older snapshots are removed (patches never are).
- **Opening:** `loadInitial` returns the latest snapshot and the patches from its time on, with `hasMore` true when older patches exist. When patchflow says the loaded part isn't enough (`needsMoreHistory`, e.g. a patch from another tab made just before the snapshot), older patches are loaded until it is.
- **A snapshot never replaces history.** Every patch stays in IndexedDB, and Clear, delete and forget remove the snapshots with the patches.
- **Its cost is bounded and counted** (LIMIT-775-3):
  - **Size:** the snapshot's encoded value is measured before anything is written. If it passes the document limit (64 MiB, `maxBoardBytes`), no snapshot is written, and the next attempt waits for the next threshold.
  - **One transaction, best effort:** the new snapshot is written, and the oldest beyond 3 removed, in one readwrite transaction of the `snapshots` store, separate from the patch's own write. So a document never has more than 3, and the committing patch never waits on the snapshot or fails with it.
  - **When it is refused** (`QuotaExceededError`, or any error): nothing is retried on the following commits. The next attempt is at the next threshold (another 500 patches or 4 MB), and after 3 refusals in a row none is tried again until the page is reloaded. Nothing of the person's is lost, because the patches are kept, so this isn't a "Not saved".
  - **Counted:** the snapshots' bytes are in the meter's history share (§6.3), and the Storage panel shows them under history ("snapshots: 12 MB"). At most 3 values of each document are kept, and a document's snapshots go when its history is cleared.
  - **Time:** encoding the value once per 500 patches, after the commit, off the path of typing.
- **A deep replay is shown, not hidden.** Opening reads at most the latest snapshot and the patches after it, unless patchflow's `needsMoreHistory` asks for older ones. That is rare, but it may go back to the start. When more than 2,000 older patches are loaded, the status line says "Loading full history…", with a count, until the document is ready.
- **TimeTravel pages older history in:** the slider covers what is loaded, and its left end offers "Older versions…", which loads the previous 500 patches (a reverse cursor) until the start, when the history is marked full. Versions are named by patch id, never by index, because indexes shift as older history loads.
- **What needs the whole history loads it first:** sending a board's history to CoCalc (`patches()`), the export with histories (§7.11), and "Rebuild from history". The `.sbreplay` download reads IndexedDB directly, so it is unaffected.
- **Backup (step 8)** can upload a local snapshot as the server's (§4.7), when its patch is a batch boundary.

---

## 3. One File menu, identical in both editors

The same items are in the same order, with the same keys. An item that means nothing for this document is shown disabled; it isn't hidden. The menu's own labels stay short. What a file type means is said in the dialogs.

```
New                     ▸  Notebook         (Ctrl+Alt+N)
                           Board
                           Folder
                           From an example…
Open…                      Ctrl+O   (the file browser as a dialog)
Recent                  ▸  the last 8 opened, both kinds
Upload…                    (any files, from this computer)
────────────
Save a copy…               (a name, a folder)
Rename…
Download                ▸  notebook: .ipynb · .py · marimo .py · with history (.sbreplay)
                           board:    .board.json · HTML (one file) · JSON Canvas · Copy JSON
Print or save as PDF…
Share…
────────────
Delete                     (to Trash)
```

**What moves where:**
- "New whiteboard" becomes New ▸ Board. It is made in the current notebook's language, as today.
- Examples… becomes New ▸ From an example…; the example opens as a new file of its own.
- **The board's "Open… (JSON, a board as HTML, …)" goes away.** Opening a file from the computer is Upload…, the same as in the notebook.
- Import Mermaid… (pasted text) goes to the board's ⋯ menu, where the board's other editing tools are.
- Revert to the original moves to the board's ⋯ menu as well, and is shown only for boards that have an original.
- Duplicate becomes Save a copy…, which asks for the name.
- Open file… and Save as… stay in the desktop app, under Upload… and Save a copy…, where they act on disk files.
- Install as an app… moves out of File, since it isn't about the file. The notebook page has no site menu yet, so it goes in ⋯ (step 3a); the one page (step 5) can give it a site menu.

**Upload…** takes any files, by picker or by drop. The rule is that **Upload never converts behind the user's back:**
- `.ipynb`, `.board.json` and `.sbreplay` become documents (an `.sbreplay` keeps its history, as today).
- Everything else is kept as a data file, under its own name.
- The browser then offers a file whose kind it recognises, opened as what it can be:
  - `.py`: Open as a notebook;
  - `.json`, `.canvas`, `.mmd`, `.md`, a board `.html`, a CoCalc `.board`: Open as a board.
- Opening one of those makes a converted copy beside it, `name.board.json` or `name.ipynb`, and the original stays.
- Today the board page converts whatever it opens. In the new design, opening a recognised file asks first.

**Share…** opens one dialog for:
- the link with the cells in it, as today's Copy share link (notebooks only);
- sharing a file or folder as a collection (design/sharing.md), once sign-in is open.

---

## 4. The file browser

**Where it is:**
- A left sidebar in both editors, opened by a **Files** button at the left of the top bar, or with Ctrl+B.
- It is 260 px wide and can be resized.
- Whether it's open is remembered for each kind of page.
- File → Open… shows the same browser as a dialog.

**What it shows:**
- The workspace tree, with folders that open and close.
- An icon for each type:
  - notebook ▤;
  - board ◫;
  - table ▦ (csv, tsv, xlsx);
  - picture;
  - text or code;
  - other.
- The name, then the date modified and size in smaller type.
- The current document is highlighted.
- A **Recent** group at the top, with the 5 newest.
- A search box that filters by name.
- At the foot:
  - a storage meter, "34 MB of 2.1 GB used";
  - Trash;
  - a **Shared** group: the collections opened from links, read-only.

**What each row does:**
- Clicking a document opens it **in place**:
  - a notebook from a notebook, or a board from a board, swaps without reloading the page;
  - otherwise the page changes to the other editor (§5).
- Clicking a data file shows a preview pane (text, a table's first rows, a picture) with Download and "Open as…".
- Rows are real links, so middle-click or Ctrl+click opens a new tab.
- Each row has a ⋯ menu (also by right-click, or a long press on a phone) with Open, Open in a new tab, Rename (F2), Duplicate, Download, Move to…, Copy path, and Delete.
- Folders can be dragged onto each other to move things.

**Drag and drop:**
- A file dropped on the **browser** is uploaded to the folder under the pointer. That folder is highlighted, with the hint "Drop to upload to /data".
- A file dropped on the **notebook** is uploaded to the current folder, as it is today.
- A picture or board file dropped on the **board canvas** keeps today's behaviour: it goes into the board. The browser is the way to upload to the workspace instead.

**What Python sees** is unchanged: the data files, at their paths. Notebooks and boards are listed in the browser but aren't in Python's filesystem (William kept this default, §10).

---

## 5. Routing and URLs

**The URL names the file:** `https://sagebrush.space/w/<path>`, for example `/w/Algebra/groups.ipynb` or `/w/Algebra/groups.board.json`.
- **One page hosts both editors** (William, Oct 18: "one page to avoid confusion").
  - `/w/<path>` always loads that page, from the server, or from the service worker when offline.
  - The page shows the notebook editor or the board editor according to the file's extension.
  - Switching between a notebook and a board never reloads.
- **Until the one page lands** (step 5 in §9), the server serves the notebook page or the board page according to the extension, and switching between them reloads.
- `/w/` and `/w/<folder>/` show the browser full-size: an empty editor isn't a useful start page.
- Plain `/` keeps opening the last notebook, as today, and puts its path in the address.

**Back and forward:**
- Opening a file pushes a history entry (`pushState`). With the one page, there is never a page load; before it lands, changing editor loads the other page.
- Back and forward go through the files opened, as in any site.
- A rename replaces the current entry (`replaceState`).
- Unsaved work is saved before leaving, as Open… does now (`saveNow()`, index.html:1565).

**Deep links:**
- A `/w/` link names a file **in this browser.**
- On another browser, or after a delete, it opens the browser at the nearest existing folder and says: "/Algebra/groups.ipynb isn't in this browser."
- Links to share with other people are made with Share… (cells in the link, or a collection). `/w/` paths are never published.

**The old addresses keep working:**
- `?doc=local:<id>` finds the entry for that board id and replaces the address with its `/w/` path.
- `?new=MODE` and `?recent=MODE` (the notebook's ⋯ → Whiteboard) do too.
- `?open=URL`, `?file=URL`, `?resume=` and `#share` links are unchanged. What they produce is now saved into the workspace as a new file (for example `/Downloads/<name>.ipynb`) instead of an anonymous record.
- `/board/?doc=<url>` (an example, or a board on the web) still opens the original read-only, with "Save a copy" as the way to edit it. Today those edits are kept under the URL; they become a file at the first edit.
- Embedded and framed boards (`/frame/board/`, design/frame.md) don't touch the workspace.

**Shared collections** (design/sharing.md):
- A collection's link, `/s/<id>` (or a frozen `/s/<id>@<hash>`), opens the same browser with that collection as a **read-only root** above the workspace. Its title and owner are shown, along with "Shared · read-only".
- Its files open in the normal editors from `/s/<id>/<path>`.
  - Their bytes come from `files.cocalcusercontent.com/c/<collection>/<sha256>`.
  - Opening a file never runs its code by itself, as sharing.md requires.
- Editing a shared file asks first: "Save a copy to your workspace". The copy goes to `/From <title>/<path>`.
- "Copy all to my workspace" copies the whole collection.
- Opened collections are listed under **Shared** until removed from the list. Removing one deletes nothing on the server.
- Sharing from the workspace is Share… on a file or folder. Its manifest paths are the workspace paths relative to that folder.

---

## 6. Phones, offline, and storage

### 6.1 Phones (under 640 px)

- The **Files** button opens the browser as a full-screen sheet: rows 48 px tall, a top bar with ← and the folder's name, and search.
- Tapping a document closes the sheet and opens it. A long press opens the row menu.
- The **File menu** becomes a bottom sheet with the same items. Its submenus are pages within the sheet, not fly-outs.
- **Upload** uses the system picker. There is no drag and drop.
- The top bar shows the document's name, which opens Rename when tapped. The board keeps its own compact toolbar (board.css:113, :136).

### 6.2 Offline (the installed app), and the desktop app

**The desktop app** (Tauri) uses the same workspace storage as the browser (William, Oct 18).
- Upload and Save a copy are its way to disk files, as Open file… and Save as… are today.
- **Medium term:** the desktop app is about more RAM, more CPU and native code.
- **Later, optionally:** a special path for reading and writing outside the sandbox, for large outputs and data.

- Everything in the workspace is in the browser, so it all works offline: browse, open, rename, delete and upload.
- **The board page joins the service worker's shell** (build.ts:365, routed through @sagebrush). Today it's missing, so boards don't open offline.
- `/w/<path>` is served from the cached page. The service worker's navigation rule (sw.js:77-78) grows to cover `/w/`.
- Shared collections work offline only for files that were opened or copied (the files Worker's responses are `private`, so the browser may cache them).
- The browser says "Offline: shared files you haven't opened can't be shown."
- Share… is disabled offline, with the reason given.

### 6.3 Storage limits

- **Persistent storage:** the first time the person saves something of their own (not on the first visit), the page calls `navigator.storage.persist()`, so the browser doesn't clear the workspace when space is short. The browser's ⋯ shows whether storage is "kept" or "may be cleared by the browser".
- **The meter** shows `navigator.storage.estimate()`, split into documents, files, history, and caches.
- **When a save is refused** (`QuotaExceededError`, or no storage at all):
  - the document stays open, marked "**Not saved:** this browser's storage is full";
  - Download is right there;
  - the browser lists the largest items.
  - This is today's `STORAGE_REFUSED` behaviour (page.ts:53, HARD-7F9-1), now the same in both editors.
- **What may be dropped without asking:** only caches (`sagebrush-outputs` and the remote-board cache), which can always be refetched or recomputed. User documents, files, history and Trash are never dropped without asking.
- **Limits:**
  - One upload is limited to 200 MB for now, said before it is read. That's well under what browsers allow, and keeps an interpreter that is sent every file from running out of memory.
  - A folder holds at most 10,000 entries, the same as a collection version.
  - The old limit of 200 boards goes away.

---

## 7. Backup and sync across devices

**William's addition (Oct 19):** "My laptop can die with no backups, and I don't lose all the valuable private notebooks and whiteboards I have. And: I forgot my laptop at home, and I can still look at the same notebooks on my phone or work computer." Sagebrush is already linked to cocalc.ai for sign-in and limits (design/sharing.md "Accounts"). Today that link is used only to upload shared collections.

**The goal, from the person's side:**
- Sign in with CoCalc once on each device, then turn on **Back up and sync**.
- Everything in the workspace is kept on the server too: notebooks, boards, files, and history.
- On another device that is signed in, the same tree appears. Opening a file there shows its latest version.
- A device that dies loses nothing that had synced. When it last synced is always visible.
- **The local-first parts don't change.** Everything still works offline. A device keeps editing its own copy and catches up when it's back online.
- Sync is never required, and a workspace without it works exactly as in §2-§6.

### 7.1 What already fits

- **Document history is already a log of patches** (patchflow), for notebooks (web/notebook/history.js) and boards (web/board/history.ts).
  - Each patch has its parents, so two devices' concurrent edits merge as CoCalc's documents do.
  - Notebook patches are in the record format of CoCalc's Jupyter documents (history.js:1-13).
- **Files are content-addressed,** and the server side for them exists: sharing's R2 objects per account, D1 holdings, quota reservation and purge (design/sharing.md).
- **The account and the membership limits exist:** OAuth with PKCE, `account_id` keys, and `{storage_bytes, …}` from the membership tier, cached, with an outage never read as zero.

### 7.2 What is synced

| What | How it syncs | Conflicts |
|---|---|---|
| The workspace index (§2.2: paths, folders, Trash) | A small log of operations (create, rename or move, delete, restore), each with the device and time | Two renames of one file: the later one wins, and the other device's name is shown in that file's history. A delete on one device and an edit on another: the edit wins and the file comes back out of Trash. Two new files at one path: the second becomes `name (2)`. |
| A notebook's or board's content | Its patch log, as TimeTravel keeps it now, sent and fetched patch by patch (idempotent by patch id) | Merged by patchflow: concurrent typing in a cell or a note merges by character. Nothing is lost, and every version from both devices is in TimeTravel. |
| A notebook's outputs | Not in the history (history.js:8). They are sent as a snapshot of the latest outputs per cell, by hash | The latest run wins. Outputs can be recomputed. |
| Data files and board pictures | By SHA-256, once each, as sharing's blobs | One path changed on two devices: the later one wins, and the other is kept as `name (conflict, <device>).ext`. Never dropped. |
| Caches (outputs cache, remote boards) | Not synced | — |

**Snapshots** bound the replay for a new device:
- The server keeps a compacted snapshot of each document every so often. A phone opens a document from its snapshot plus the patches since.
- **"Clear history"** (IdbPatchStore.clear, stores.js:197) becomes a server operation when sync is on. Otherwise another device would send the history back.

### 7.3 The server

There were two possible shapes. William chose A (Oct 18).

**A. Sagebrush's own sync service on Cloudflare,** next to sharing. *This is the recommendation, and William's choice on Oct 18 was that it be all Cloudflare and built to scale.*

It is made of objects that each serve one account or one document, so it grows by adding objects. No single database is in the path of edits.

| Part | What it holds | Why it scales |
|---|---|---|
| **An account object** (one Durable Object per account, SQLite inside) | The workspace index and its operation log, the account's file holdings (path to SHA-256), devices and their cursors, and the documents shared with the account | Everything one person does goes here. Nothing crosses accounts, so there is no global table that grows with every user's files. |
| **A document object** (one Durable Object per synced notebook or board) | That document's patch log, its snapshots' R2 keys, and who may read or write it | Edits to a document are ordered in one place, which collaboration needs (§7.9). It is awake only while someone edits, so a million idle documents cost only their storage. |
| **R2** | File bytes, pictures, snapshots and outputs, by SHA-256 under the account's prefix | Unbounded, and serving is free (no egress fees). |
| **D1** (one database, as sharing has now) | Accounts, sessions, cached account limits, collections, purge records | Only small, per-account rows, written at sign-in, on a plan change or when sharing, never on an edit. |
| **Workers** | The HTTP API, uploads, sign-in | Stateless. |

**What follows for sharing** (design/sharing.md): its per-account file *holdings* move from D1 into the account object over time, so D1 stays small at any number of users. Collections keep their D1 rows: there are few of them, and they are public.

**How devices talk to it:**
- A device holds one WebSocket to its account object, and one more to each document it has open while another device or person also has it open.
- **Otherwise it sends batches.** Patches made while nobody else is watching go up every ~30 seconds, and at once when the page is hidden or closed. A batch is one request and one stored row. Most of the time objects then hibernate (asleep and not billed) between batches.
- **Every WebSocket uses Cloudflare's hibernation API.** A socket accepted without it keeps its object awake and billed for as long as it is open.

**Account limits** come from cocalc.ai as now, but are cached for hours, not 10 minutes. cocalc.ai also sends a signed notice when a plan changes, using the same HMAC scheme as the purge request. With 100,000 people online, a 10-minute cache alone would mean about 170 requests a second to cocalc.ai.
- **Why recommend it:**
  - sagebrush.space alone is enough: no project has to start before a phone can show a notebook;
  - accounts, limits, quota reservation, deletion and purge are already built and tested for sharing;
  - it fails like the rest of the site.
- Because the patches are already CoCalc's format, a later "Open in cocalc.ai" can copy a notebook into a project with its whole history.

**B. A cocalc.ai project as the store.**
- The workspace is a folder in a project the person chooses (for example `~/sagebrush/`), synced through CoCalc's own document sync.
- **Gains:**
  - CoCalc's backups and TimeTravel;
  - the same notebooks open in cocalc.ai's Jupyter.
- **Costs:**
  - a page on sagebrush.space has to reach a project's sync across origins, with a scoped token;
  - a phone waits for the project to start;
  - boards are a format CoCalc doesn't edit yet;
  - sagebrush.space then depends on the project hosts being up.

### 7.4 Privacy and accounts

- **Private by default.** Synced data is never served on the user-content domain or to anyone else. Sharing remains a separate, explicit act.
- **Encryption: (a), decided** (William, Oct 18). The two choices were:
  - **(a)** Encrypted at rest by Cloudflare, as R2 is today. Account recovery is simple.
  - **(b)** End-to-end, with a key only the person's devices hold. The server can't read anything, but a lost key means lost data unless the person kept a recovery code.
  - **What keeps (b) possible later,** without building it now:
    - the server treats patches, snapshots and file bytes as opaque payloads in an envelope (ids, sizes, parents, author), and never parses them;
    - names for blobs are made in one function, which could later key them with the account's secret instead of a plain SHA-256.
- **Deleting:**
  - **"Delete my synced data"** removes everything of the account's from the server, by the same path as the purge in design/sharing.md "Deleting".
  - Turning sync off on one device leaves the server copy and the device's copy each in place.
  - Signing out on a shared computer offers to remove this device's local copy, as a separate choice.
- **When the account may no longer sync** (its plan no longer includes sync; decided Oct 19, wording Oct 25: a membership ending to a tier that still includes sync, such as free, doesn't end sync):
  - sync pauses and the server copy becomes **read-only for 90 days**. It can still be opened and downloaded: Download all, and the export (§7.11);
  - after the 90 days, the server copy is **deleted**, by the same path as "Delete my synced data";
  - the person gets an email when the plan stops including sync, and another about 14 days before the deletion. A plan with sync again within the 90 days turns sync back on, with nothing lost;
  - **each device's own copy is never touched:** it stays in that browser, as a workspace that doesn't sync;
  - the timer and the emails are the server's (auth's). The FAQ's wording is on the Sagebrush site, and business terms aren't in this repo.
- **Limits** come from the account's limits, as sharing's do (`storage_bytes`).
  - Over the limit, new files stop uploading and say so. Document edits (small patches) keep syncing.
  - Nothing already synced is removed.

### 7.5 What each device keeps

- **A computer keeps everything,** as now.
- **A phone in the browser keeps the index, recent documents and anything opened or pinned** (William, Oct 18). A native phone app, planned for later, can fetch everything.
  - A large data file shows in the browser as "In the cloud", and is fetched when opened.
  - "Keep on this device" pins a file or folder.
  - This is also how a phone with little storage avoids the limits in §6.3.

### 7.6 What the person sees

- **The file browser's foot:** "Synced · 2 min ago", or "Syncing 3 files…", or "Offline: 5 changes wait to sync", or "Paused: sync isn't available for this account". It is next to the storage meter, and opens a Sync panel.
- **An icon on a row, only when it isn't simply synced:**
  - ↑ waiting to upload;
  - ☁ in the cloud only (not on this device);
  - ⚠ a conflict copy.
- **The title bar's status** says "Saved in this browser · synced" or "Saved in this browser · not synced yet".
- **Turning it on:** Settings, or the first Sign in with CoCalc (Share…), offers "Back up and sync this workspace". It shows what will be uploaded (34 MB, 62 files) and the account's limit.
- **First sync on a second device that already has its own local workspace:** the two trees are merged, never replaced. Same-path clashes become conflict copies, and a summary says what came in.
- **TimeTravel** shows which device made each version.

### 7.7 Phases

- **Phase 1: backup.** One device uploads continuously and any device can restore. This covers "my laptop can die".
- **Phase 2: sync.** Several devices edit, with live pushes and merges. This covers "my laptop is at home".
- **Phase 3: collaboration** (§7.9). Other people can be given access to a document or folder.
- All three phases use the same objects and logs. Phase 1 is phase 2 with only one writing device, and phase 2 is phase 3 with only one person, so nothing is thrown away.

### 7.8 Scale

The service scales by adding objects. Its limits per object, from Cloudflare's published limits:

- **One Durable Object** takes a soft limit of 1,000 requests a second and holds up to 10 GB of SQLite, in rows of at most 2 MB. One account, or a document a few people edit together, needs a tiny fraction of either. File bytes and snapshots go to R2, not the object.
- **Many people online at once** means many hibernating sockets spread over as many objects. This is the use Durable Objects are built for.
- **D1** holds only small per-account rows (§7.3), so its single writer and size limit are never on the path of an edit.
- **Workers** can't take a request body over 100 MB, so larger files go up in parts (as design/sharing.md notes).
- **What must hold in the implementation:**
  - batching when nobody else is watching (§7.3);
  - one stored row per batch;
  - sockets that use the hibernation API.

  Without them, objects stay awake and write a row per patch, which costs several times more.

### 7.9 Collaboration: two people, one document

**What William asked for (Oct 18):** two people edit the same notebook or board, and several seconds of lag is fine. Each person keeps their own runtime state, though a reactive notebook will often bring the two into agreement.

**This fits the model with no new mechanism:**
- A shared document is a **document object** (§7.3) that more than one account may write.
- Each person's devices send patches to it, and it orders them and passes them on.
- patchflow merges concurrent edits, the same way two devices of one person are merged. This is also how CoCalc's documents are edited together.
- **Lag:**
  - when both people have the document open, both hold its socket, and edits arrive in about a second;
  - when one of them isn't watching, the batching of §7.3 means up to ~30 seconds;
  - either is within "several seconds".

**Who may do what:**
- A document or folder has an **owner** (the account whose workspace and quota it is in), plus **editors** and **viewers**.
- The owner invites people by their CoCalc account or email, or with a link that grants access only once signed in.
- The document object checks the access list on every connection and request.
- Revoking someone's access closes their sockets at once. Their devices keep the copy they already had, as with any download.

**In the other person's workspace,** a shared document appears under **Shared with you**, alongside read-only collections (§5).
- **Save a copy** forks it into their own workspace, with its history up to that point.
- A shared *folder* also shares its data files, so `open("data/primes.csv")` reads the same bytes for both people.

**Runtime state is each person's own,** as William asked:
- Each browser runs its own interpreter.
- **What is shared:** the document, meaning inputs, cell order, and a board's notes and layout.
- **What is not shared:** variables, and running work.
- **Outputs** are shown per person. Each person sees the outputs of their own runs. A cell they haven't run shows the latest output anyone saved, marked with who ran it and when. One person's run never overwrites the other's.
- The reactive notebook brings the two together naturally: the same inputs give the same outputs. Where they don't (randomness, different files, timing), each person sees their own result.

**Presence** (who else is here, and their cursor or selected cell) rides on the same socket. It is never stored, and costs nothing when the document is used alone.

**Not in scope:** shared running state, meaning one interpreter that two people drive. This needs a server-side or relayed kernel, which is what cocalc.ai projects provide.

### 7.10 Security

**What is protected, and from whom:**

| Threat | Defence |
|---|---|
| Another account reading or writing my data | Every request names an account object or document object, and the object checks the session's `account_id` against its owner or access list. There is no endpoint that lists or reads by hash alone (as with sharing's `/c/<collection>/<sha256>`). File bytes are fetched through an object that has checked access, then streamed from R2. |
| A stolen or replayed session | Sharing's session: a random token in a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax), stored only as its SHA-256. WebSocket upgrades check `Origin`, as state-changing requests already must. Devices can be listed and forgotten (§7.6), which ends their sessions. |
| **A collaborator's code running in my browser.** This is the new risk. Today a person runs only their own code. With collaboration, another person's edit becomes code that my browser can run. | **Code always runs in the runner** (design/runner.md): an opaque-origin, sandboxed frame with no storage, no network and no cookies. Python that escapes into JavaScript there reaches nothing: not my workspace, not my session, not the network. This is already the default on the notebook page and boards. **Before collaboration ships,** it must be the only way code runs, and that is not yet true in Firefox and Safari (runner.md, remaining steps 4-5). |
| A collaborator's edit running **without my say-so** | Autorun is the reactive notebook's default (design/reactive-notebook.md). **An edit from someone else never triggers a run.** The cells it changes are marked "changed by Ana, not run" until I run them, as a shared collection already behaves ("Opening a shared link never runs its code by itself"). The same rule applies to a board's code notes. |
| A malicious or malformed patch, or a whole document | The server checks sizes, rates and the shape of each patch, and never runs anything. Every client treats remote documents as untrusted input. This is the class of the Oct 18 `__proto__` fixes (board-proto-ids, board-own-names): ids are only ever own-property keys. Outputs are already bounded and sanitized (design/security.md rules 1-4). |
| Using storage as free file hosting | Synced files are served only to accounts with access, as `private` attachments with `nosniff` and a `sandbox` CSP, the same as files.cocalcusercontent.com. Public sharing stays the separate, explicit act it is now. Quota is per membership. |
| Cloudflare or an insider reading data | Encrypted at rest by Cloudflare. End-to-end encryption is not built now; the design keeps it possible (§7.4). With collaboration, it would mean per-document keys shared with each invitee, which is possible but means a lot more to get right, so it is not proposed for the first version. |
| Losing data (a bug, a bad deploy) | 30-day point-in-time recovery of every Durable Object's SQLite. Copies off Cloudflare, encrypted, as in sharing.md's Backups section. Trash. Nothing removed by quota pressure. |

**The server's attack surface is small:** it stores, orders and relays, and never runs user code. All compute stays in each person's browser, inside the runner.

### 7.11 Export and import (William, Oct 19)

**Built so far: the browser's Files-mode export (E1, Oct 30).** It follows the reviewed export plan
(E1 r2c, Oct 30), which rules where it is narrower or stricter than this section:
- it is in the Storage panel only, as "Export all current files (.zip)", not in the File menu (William, Oct 30);
- the file is named `sagebrush-YYYY-MM-DD.zip` (`-partial` for an explicit partial export), and the importer
  recognizes a bundle by its `manifest.json`, never by its name;
- `manifest.json` is the bundle's last member, written from what was written, so its sizes and hashes are those of
  the bundle's bytes; each entry also records `captured`, when its member was read;
- the caps below are checked in preflight and again on the actual output, so a file that grows during an export
  stops it cleanly: unlike the sentence below about never stopping partway, an export can stop at a cap, but it
  never produces a bundle the importer would refuse;
- files that aren't on this device are listed, and an export leaves them out only when asked to, recording them in
  `manifest.omitted`.


**One click exports the whole workspace as one file, and Import takes such a file back.** This is how a person keeps a copy off Sagebrush, and how they move from one Sagebrush site to another.

**Two modes:**
- **Files:** every document and data file as it is now. A notebook is its `.ipynb` and a board its `.board.json`, exactly as Download gives them, so the bundle is useful without Sagebrush.
- **Files and histories:** the same files, plus each document's patchflow history (TimeTravel), the files its sessions read (as `.sbreplay` keeps them), and the data files' versions (§2.5).

**Where an export is made:**
- **In the browser,** from this device's workspace. It needs no account and works offline; it is the File menu's "Export workspace…" and the Storage panel's.
- **On the server** (auth's half), for a synced account. It is a rate-limited export job that builds the same bundle from the account's objects and R2, then offers a private, time-limited download.
  - This is what a phone (§7.5, which holds only part of the workspace) and an account in its read-only 90 days (§7.4) use.
  - auth's design note sets the limits: one running export per account, and a few a day.

**The browser's export streams; it never builds the bundle in memory** (LIMIT-775-1):
- **The writer** is a streaming zip writer:
  - it takes one entry at a time: it reads the entry's bytes from IndexedDB, writes them, and lets them go;
  - data files are stored as they are, and text is deflated through `CompressionStream`;
  - it writes Zip64 records when the bundle passes 4 GiB or 65,535 members;
  - a history is written as it is read, one envelope per line from an IndexedDB cursor, never as one array;
  - peak memory is one entry (at most 200 MB, the upload limit) plus the compressor's window.
- **Where it writes, in order of preference:**
  1. **`showSaveFilePicker`** (Chromium and the desktop app). The chosen file's `FileSystemWritableFileStream` takes the chunks as they come, with no size limit beyond the disk.
  2. **Elsewhere (Firefox, Safari):** a file in the origin-private file system (OPFS), written by a worker through a sync access handle, then downloaded from its disk-backed `File`. It needs the preflight's upper bound (below) free in the storage quota, checked before starting, and the OPFS file is deleted when the download has started or the export is cancelled.
  3. **A Blob in memory, only when neither is available,** and only for a bundle whose preflight upper bound is at most **256 MiB**. Anything larger is refused before anything is read, saying to use the server's export (for a synced account) or a browser that can save files.
- **A preflight pass comes first, and writes nothing to the sink.** It builds and serializes `manifest.json` in memory, measures its exact UTF-8 size, and checks it against its 64 MiB cap. It then enumerates the exact member set:
  - `manifest.json`;
  - each entry's file;
  - each history and each versions file;
  - the blobs, deduplicated by `sha256`.

  It sums two separate numbers:
  - the **uncompressed bytes** of all members, the manifest included. These are checked against the importer's 20 GiB total.
  - an **upper bound of the bundle's size**, not an estimate, for choosing the sink:
    - **each member's zip records,** at their largest. A local header (30 bytes), a central header (46), a data descriptor (24) and Zip64 extra fields in both headers (20 and 28) come to at most 148 bytes, plus twice the member's UTF-8 name length;
    - **the end records:** 22 + 56 + 20 bytes (end of central directory, Zip64 end record and locator);
    - **each member's data:**
      - a stored member's exact size;
      - for a deflated one, the deflate bound of its size `n`: `n + (n >> 12) + (n >> 14) + (n >> 25) + 13`, as zlib's `deflateBound`;
      - a history's size is measured by serializing its envelopes once, from a cursor, one at a time.
- **The caps are checked on that set before writing:** at most 400,000 members (the manifest counted), at most 20 GiB of uncompressed bytes, and each member, the manifest included, within its cap (the table under Import). The sink is then chosen from the bound: the 256 MiB Blob path only when the bound is at most 256 MiB, and OPFS only when the bound is free in the quota.
- Progress shows bytes and entries, and the export can be cancelled at any entry.

**The bundle format** is documented and versioned like the board format. It is a zip, `<name>.sagebrush-workspace.zip`:

```
manifest.json            {format: "sagebrush-workspace-bundle", version: 1, mode: "files" | "history",
                          created, site, app, entries: [...], totals: {files, bytes}}
files/<path>             each entry's current contents (an .ipynb, a .board.json, a data file's bytes)
history/<ref>.jsonl      one document's envelopes, oldest first, one JSON envelope per line (JSON Lines);
                         line 1 is a header {codec, schema}; the same envelopes as .sbreplay's "history";
                         snapshot envelopes are not exported
blobs/<sha256>           the bytes a history's sessions read, and data files' versions' bytes, once each
versions/<fid>.json      a data file's versions: [{id, at, size, sha256, author, reason}], at most 20
```

- **Each manifest entry** has `{path, kind, ref?, fid, created, modified, size, sha256, mode?}`. **The manifest is authoritative:** the zip's own names are only where the bytes are, and are never used as paths.
- **Trash isn't exported,** and neither are the device's settings or anything in localStorage.
- **Versions:** a reader accepts its own `version` and older ones. A later version is refused with a message saying so, as a board of a later format is. Fields a reader doesn't know are ignored, and their names are listed in the import's summary.

**Import:**
- **Into an empty workspace** (a new site, a new browser), the paths are kept. Into one with documents, everything goes under `/Imported <date>/`, so nothing is replaced or merged by surprise.
- **Every document and file gets a new identity** (fid and ref), so an import can never overwrite or join a document that is already here. The patch ids in the histories are kept, because they don't depend on the ref.
- **Each file's bytes are checked** against the manifest's `sha256` and `size`. A file that doesn't match isn't imported, and the summary lists it; the rest go on.
- **The file wins over its history** when they disagree, as a crafted or damaged bundle can make them do. What opens is always the file the person exported:
  - the history is imported, and if its head value differs from `files/<path>`, the file's value is committed on top as one more version, labelled "imported";
  - a history that doesn't decode, or fails `verifyValue`, is dropped, and the summary says so. The document is then the file alone, with no history.
- **A snapshot envelope in an imported history isn't trusted for the value.** The exporter writes none, and import drops any it finds, replaying from the patches. After import, the local snapshot writer (§2.6) makes fresh ones from the verified value.
- **It is bounded before anything is written** (LIMIT-775-2). The caps are one table of constants, shared by the exporter and the importer:

  | What | Cap |
  |---|---|
  | `manifest.json` | at most 64 MiB, parsed whole, with nesting depth at most 8 and at most 100,000 entries (the workspace's `maxEntries`) |
  | archive members | at most 400,000 (each entry's file, plus its history or versions, plus blobs), and only the names the layout above allows |
  | one `files/` member | its kind's limit: 200 MB for a data file (the upload limit), 64 MiB for a notebook or board (`maxBoardBytes`) |
  | one `history/` file | streamed line by line; one line at most 64 MiB (a document's limit); at most 200,000 envelopes and 256 MiB per document (patchflow holds a replayed history in memory) |
  | one `versions/` file | at most 64 KiB and 20 records (`maxVersions`), with nesting depth at most 4 |
  | one blob | at most 200 MB |
  | total uncompressed | at most 20 GiB, and at most the storage left (`navigator.storage.estimate()`) less 10% |
  | inflated bytes | counted as they are inflated, for each member and in total. There is no ratio rule: legitimate text or zero-filled data compresses far beyond any fixed ratio, so a ratio would refuse Sagebrush's own bundles. The member, history and total caps on bytes actually inflated bound a zip bomb instead. |

  - The manifest's totals are checked first, against the caps and the storage left. Nothing is written if they fail.
  - Each member is then read as a stream. The bytes actually inflated are counted, and a member is stopped as soon as it passes its declared size or its cap, and the import is stopped when the total passes its cap. A stopped member skips that entry, and the summary says why.
  - A history over its cap is dropped, and its file is imported alone.
  - Histories, blobs and versions count toward the total, as files do.
  - The manifest's JSON is the only document parsed whole; histories are JSON Lines parsed one line at a time, and versions are small by their cap.
  - Names go through the workspace's own path rules (`safeName`). An absolute path, `..`, or a name that collides after normalization is refused or renamed, never followed.
- **Everything the exporter makes can be imported.** The exporter's preflight checks the same caps on the whole member set before it writes anything (above), so an export never stops partway at a cap. Before it starts, it lists what can't be exported in full: a document whose history passes the cap is exported without its history, and the export says so, so the person can cancel. A bundle over 20 GiB is refused before starting; such a workspace is exported in parts, one top-level folder at a time.
- **Nothing imported runs by itself.** The documents are other people's code as far as this browser knows, even when the person made the bundle, so they open as an Upload's do (§3) and run only when the person runs them.
- **Import is the person's action.** It isn't in the agents' workspace API (§8.2) in its first version.
- **A summary at the end** says what came in, where, and what was refused and why.

**Moving between sites:** export on one, import on the other. If the new site syncs, its sync uploads the imported workspace like any other. The histories keep TimeTravel intact across the move.

---

## 8. Agents

**William (Oct 18): "We must have an agent strategy."** Agents use the workspace the way people do, by the same rules, through one API. The starting points came from @sagebrush; this section develops them.

### 8.1 Principles

1. **One API, three surfaces.** The verbs of the File menu are the API. The same verbs, with the same meaning and the same tests, are available:
   - in the page;
   - to agents on the person's own computer;
   - to remote agents, once sync exists.
2. **A person can drive everything through their own agents, including running code** (William, Oct 18: "any model with agents that doesn't imagine the user being able to 100% drive something via agents is not sufficient").
   - Safety comes from knowing exactly what can go wrong, and closing each of those (§8.3). Holding agents back is not the method.
3. **Agents are collaborators** (§7.9, §7.10).
   - They show where they are.
   - Everything they change is credited to them, appears in TimeTravel, and can be undone, data files included (§2.5).
4. **Outward actions are gated; local, reversible ones aren't.**
   - **Gated:** anything that leaves the person's workspace or spends something needs a confirmation, or a scope granted beforehand (§8.3, danger 3).
   - **Not gated:** what stays inside it and can be undone needs neither.
5. **Precise, fine-grained permissions are a goal in themselves.** CoCalc has to enforce access at the level of Linux users and processes. Sagebrush runs everything in the browser, so it can say exactly which agent or person may read, write or run what, in which file. (William noted this on Oct 18.)
6. **Access is granted, not assumed.**
   - An agent sees only what it was given, for a stated time, and the grant can be taken back at once.
   - Nothing leaves the device without sync turned on *and* a grant made.
7. **The one hard rule: code from other people never runs by itself.** This covers collaborators, shared collections and Inbox items. No setting changes it.

### 8.2 The workspace API

The index of step 1 (§2.2) is this API. It is written once (`web/workspace/api.ts`), and tested from the first commit.

| Verb | What it does |
|---|---|
| `list(folder, {recursive?})` | Entries: path, kind, language, size, created, updated, revision |
| `stat(path)` | One entry |
| `read(path)` | A notebook's document, a board's JSON (the existing formats), or a file's bytes; with its revision |
| `write(path, content, {base})` | Replace the contents, only if the revision is still `base` (compare-and-swap, as `IdbStore` does). On a conflict, it returns the current version. A document written whole is stored as the diff from `base`, so TimeTravel shows the change and who made it. |
| `create(path, kind, content?)`, `mkdir(path)` | A new notebook, board, file or folder. A taken path is refused, never overwritten. |
| `rename(from, to)`, `duplicate(path, to)` | As the File menu does them |
| `remove(path)`, `restore(path)` | To Trash, and back out (§2.4). No verb empties Trash, forgets a history or drops a file's versions: only a person can. |
| `history(path)`, `version(path, i)` | TimeTravel's versions, and any one of them; for a data file, its kept versions (§2.5) |
| `watch(path, cb)` | Changes made elsewhere: another tab, device, person or agent |

- **One description of the verbs,** written as TypeScript types and a generated JSON Schema, serves all three surfaces. The MCP tools and the remote endpoint are generated from it, so they can't drift apart.
- **Fine-grained edits stay with the editors' own APIs:** `window.sagebrush.board` (load, focus, step, snapshot, run, outputs, versions; page.ts:24) and `window.sagebrush.notebook` (index.html:732). An agent edits one cell or note there, and uses the workspace API to find, open and organise files.

**The three surfaces:**

1. **In the page:** `window.sagebrush.workspace`, next to `window.sagebrush.board` and `.notebook`.
   - It is for agents that drive a browser: the shared browser, CDP, Playwright.
   - An agent in the page acts with the page's own authority, so the grant is the person handing over their browser.
   - This comes in step 1.
2. **On the person's computer:** the same verbs as MCP tools and a CLI, in the existing `sagebrush-mcp` package (engine/py-mcp), for Claude Code, Codex and others.
   - **Before sync,** the workspace exists only inside a browser, in the person's own profile. The tools reach it through the person's **paired page** (§8.7):
     - the MCP server listens on 127.0.0.1 and checks the Origin;
     - the open page connects with a single-use code;
     - the page runs only allowlisted verbs, with arguments checked against the schema, under the grant the person gave, credited to the agent. It never evaluates anything it receives.
   - Driving a page by CDP stays for headless automation only: it would need the person's profile run with a debugging port, which is itself an attack surface. (Proposed by @sagebrush-python, Oct 19.)
   - The wire protocol is `design/workspace-agent-protocol.md`.
   - **With sync,** they talk to the sync service directly (surface 3).
3. **Anywhere, with sync:** an authenticated agent endpoint on the sync service (§7.3).
   - Each verb becomes an operation on the account object or patches on a document object, credited to the agent.
   - This lets cocalc.ai agents, or Claude Code and Codex running anywhere, work in a person's workspace while every device of theirs is closed.

### 8.3 What can actually go wrong, and what closes it

Below are the four real dangers when agents act in a workspace, whether they run code or not. Each comes with what closes it.

**1. Loss or corruption of work.**
- Notebooks and boards are safe already. Every change is a patch in an immutable history (TimeTravel), and deleting goes to Trash.
- **Data files are the only thing without versions today:** an overwrite or a delete by Python, by an agent or by a person loses the old bytes.
- **Closed by versioning data files** (§2.5): the bytes a file had before each overwrite or delete are kept as a version, within bounded retention, and on top of that there is Trash.
- Then, for everything in the workspace:
  - **nothing an agent does can lose your work;**
  - TimeTravel and "Undo this agent's changes" cover files too.
- **What agents can't do,** because only a person can, from the UI: empty Trash, forget a document's history, or drop file versions. No verb of the API does any of these (§8.2).

**2. Data leaving: privacy, mainly through prompt injection.**
The real risk here isn't loss. It's private files being read and sent somewhere. The channels:
- **Code, through the network.** The runner (design/runner.md) has **no network at all**: its CSP is `connect-src 'none'`. It has no storage and no cookies either. It sees only the files the page hands it.
  - **The gap today:** where the runner isn't available, the page falls back to a plain worker with the page's origin, which has network and storage. That happens when the frame doesn't answer within a few seconds, offline, in Firefox and Safari until runner.md step 4, and in the desktop app.
  - **The fix:** a run asked for by an agent never takes that fallback. It waits for the runner or is refused, with the reason given. A person running code themselves keeps the fallback as now.
- **Outputs.** They are bounded and sanitized when shown (design/security.md rules 1-4), so an output can't load anything from the network.
- **The agent itself.** Whatever an agent reads (files, outputs) goes to its model provider and to anywhere the agent can send. This is in the nature of using an agent, and the person chose that agent.
  - What bounds it is **the grant's scope:** which folders an agent can read at all.
  - It is also bounded by the gates on outward actions (danger 3), which apply to agents as much as to people.

**3. Outward actions.** These leave the workspace, or spend something, and can't simply be undone:
- publishing or sharing, or making something public (a collection, a link);
- sending to someone else (Send to Sagebrush, the Inbox, email);
- granting access to another agent or person;
- turning on sync for a folder;
- spending: AI calls beyond a budget the person set.

Each needs **either an explicit confirmation from the person at the time, or a scope granted beforehand** ("this agent may share in /Public/", "may spend up to N"). Everything local and reversible (create, edit, run, rename, delete to Trash) needs neither.

**4. Resource use:** CPU, memory, battery and quota.
- These are bounded by the runner's limits (interpreter heap limits, Stop) and the quota meter (§6.3).
- An agent's run shows a running indicator naming the agent, with Stop.
- A run past its time or memory bounds is stopped like any other.

**"May run code", and its defaults.** This is a setting on each grant (§8.4), shown at the point of grant and in the Agents with access panel, and it can be turned off mid-session.
- **The person's own agents** (the Ask panel, and their own MCP or CLI agent with a grant): **on.** With dangers 1-4 closed as above, holding back the person's own agent only gets in their way.
- **Third-party or remote grants:** the person chooses when granting, and is asked plainly.
- **Every run:**
  - happens in the runner, never on the page's origin;
  - is credited to the agent;
  - is logged: time, agent, document, cell or note, and the hash of the code.
- **A remote agent's runs** happen only in an open page of the person's, which shows them. The sync service has no compute; with no page open, cocalc.ai is the place for that (§8.6).
- **The hard rule stands:** code from other *people* (collaborators, shared collections, Inbox items) never runs by itself. An agent's permission to run code covers only code that agent wrote. It never covers code someone else wrote, even when the agent passes it on.

### 8.4 Access: granted, scoped, visible

- **A grant** is made by a person to one agent. It states:
  - which folders or files;
  - read, or read and write;
  - **may run code**, or not (§8.3);
  - an expiry, and a rate limit.
- **The token** is held by the account object, which stores only its hash. Revoking it takes effect immediately and closes the agent's sockets.
- **Every request** is checked against the grant, and logged in the account object: time, agent, verb, path.
- **An "Agents with access" panel,** in the Sync panel and in the file browser's ⋯, lists every grant with its scope and last use, its log, and Revoke.
- A file an agent can see shows a small marker in the browser.
- **The rule from the start of §8 holds here:** nothing leaves the device unless sync is on and a grant exists. An in-page agent (surface 1) is the exception only because it *is* the person's own page.
- **Prompt injection:**
  - a shared notebook or board may contain text written to steer an agent that reads it;
  - **what limits the damage:**
    - scoped and read-only grants;
    - no running code unless the person allows it;
    - the runner's sandbox;
    - undo by agent, and the access log;
    - Trash, which only a person can empty.
  - Agents treat workspace contents as data, never as instructions.

### 8.5 The Ask panel

- **What it is:** the built-in agent of the chat panel (§8.7), in the one page (§5). It talks to an agent through the person's linked cocalc.ai account, using the path built for deciding board questions (cocalc-ai PR #1134).
- **It acts only through the workspace API and the editors' APIs.**
  - The page carries out each tool call and checks it against the grant the person gave the conversation.
  - What it makes lands as ordinary files and boards in the workspace, credited to it.
- **Without sync,** its tool calls are relayed through the page that has the panel open.
- **With sync,** it can use the agent endpoint and keep working on a long task while the page is closed. It still can't run code then (§8.3).

### 8.6 Handing off to and from cocalc.ai

- **Send to Sagebrush:**
  - a cocalc.ai agent or person sends a board, notebook or file to a Sagebrush account;
  - it lands in that person's `/Inbox/`, read-only until they accept it;
  - this needs sync and a grant to cocalc.ai for `/Inbox/`.
- **Open in cocalc.ai:**
  - hands a notebook, with its history (already CoCalc's document format, §7.1), to a cocalc.ai project, and to an agent there;
  - results come back by Send to Sagebrush.
- **Later, perhaps:** a cocalc.ai project could join the sync service as one more device of the account, so work done there appears in the workspace directly.

### 8.7 Chat with any agent, beside the document

**William (Oct 18):** "a user connects their claude code desktop app to sagebrush; instead of only chatting inside claude code about a whiteboard, they could just chat in a panel on the left next to the whiteboard in their browser. It's still chatting with the same agent session. (the agent could be anywhere - cocalc, etc.)"

**One chat panel for every agent.**
- **Who it talks to:**
  - the built-in Ask agent (§8.5);
  - a Claude Code or Codex session on the person's computer;
  - an agent in a cocalc.ai project;
  - later, any remote agent with a grant.
- **It's the same panel for all of them.** What differs is only the adapter that carries messages to and from the agent (below), so Ask is one case of this panel, not a UI of its own.
- **Where it sits:** on the left, as a tab beside Files ("Files | Chat"), in both editors. On a phone it's a full-screen sheet, like the file browser.
- **Talking to the same session:** it continues that agent session. The agent keeps its own context, and the panel doesn't start a new conversation behind the person's back.

**The conversation is a workspace document.**
- **What it is:** a chat file beside the document it is about. For `/Algebra/Sylow.board.json` that is `/Algebra/Sylow.chat`, recorded as attached to the board by the board's entry, so a rename or move keeps the two together.
- **What it inherits, like any document:**
  - history in TimeTravel (one record per message, patchflow, as boards are);
  - versions, sync (§7) and search;
  - Trash.
- **Each message is credited:** to the person, to `agent:<name>`, or to a collaborator. Reopening the board reopens its conversation.
- **Several conversations about one document**, one per agent, are tabs in the panel.
- **Format:** the records follow CoCalc's chat records where they can, so a conversation can go to cocalc.ai with the document (§8.6).

**Context goes with each message**, so "make this bigger" means something:
- **Attached automatically:** the document's path and kind, its revision, the selection (cell ids, or board item and edge ids), the page and viewport, and the cursor.
- **Shown before sending:** as a small chip ("about: note 'Sylow p-subgroups', page 2"), which the person can remove.
- **Kept small:** these are ids, not contents. The agent reads contents through the workspace API (§8.2), within its grant.
- **Shown as it acts:** what the agent does appears inline in the conversation ("edited note 'Sylow'", "ran cell 3"). Each entry links to that version in TimeTravel, and "Undo this" undoes it.

**Adapters: one per kind of agent.** The panel doesn't care which one is in use.

1. **A local agent, through `sagebrush-mcp`.**
   - **How the page reaches it:**
     - the agent's MCP server listens on `127.0.0.1`, and the page connects with a one-time pairing code;
     - Chrome then asks the person to allow access to the local network;
     - the pairing code is the sender check. Only a page that paired can speak, and only as that person.
   - **How messages get into the session:**
     - **Claude Code (verified Oct 19, 2026)** has *channels*: an MCP server that declares the `claude/channel` capability can push `notifications/claude/channel` events into a running session. Claude replies through a tool the server exposes (`reply`). A channel can also relay tool-approval prompts (`claude/channel/permission`), so the panel can show "Claude wants to run …: Allow or Deny".
       - Channels are a **research preview**: a custom channel runs with `--dangerously-load-development-channels` until it is on Anthropic's allowlist, and Team and Enterprise organizations must enable channels.
       - Events arrive only while the session is open. While the agent is busy they queue, and arrive together on its next turn.
       - Sources: [Channels reference](https://code.claude.com/docs/en/channels-reference), [MCP in Claude Code](https://code.claude.com/docs/en/mcp).
     - **Codex:** its MCP client gained elicitation for custom servers (openai/codex PR #17043, April 2026). Elicitation asks the *person* a question; it is not a way to give the agent a message. **I found no Codex equivalent of channels.** So for Codex, and for any client without push, the adapter falls back to tools the agent calls:
       - `chat.next(timeout)` waits for the next message (a long poll);
       - `chat.reply(text)` answers.

       The person starts the agent in "listen to Sagebrush" mode, and it keeps calling `chat.next`. This works with any MCP client, but only while the agent is in that loop. This is unverified beyond the sources named here; recheck when building.
2. **A cocalc.ai agent, through CoCalc's Agent Network.**
   - The page acts as a client of the person's cocalc.ai account (the sign-in that sharing already has, §7.3, with a new scope for messaging agents) and addresses an agent by name.
   - Replies come back to the panel.
   - **This needs work on the CoCalc side:** a person's page as a sender that can receive replies, not just another agent. That gets its own short design with the cocalc.ai agent team.
3. **A remote agent, through the sync service's agent endpoint** (§8.2, surface 3), once sync exists. The conversation is then a synced document. The agent writes its messages into it as patches credited to it, and the person sees them on every device.

**What the panel shows about the agent:**
- its name, where it runs ("Claude Code on this computer", "cocalc.ai: project Number theory", "remote"), and whether it's connected;
- what its grant allows: which folders, read or write, may run code (§8.4);
- the Agents with access panel, one click away.
- **When the agent isn't connected,** messages queue in the conversation, marked "waiting: <agent> isn't connected". They go when it connects, and the person can delete them before then.
- **While it acts:** a running indicator with Stop. Its cursor shows on the board or notebook (presence, §8.3).

**Security:**
- **Only the person can instruct as the person.**
  - The author of a message is set by the page from the person's signed-in session and the adapter's pairing, never from anything in the text.
  - An adapter accepts instructions only from its paired page (Claude Code's docs require the same: gate on the sender).
- **Everything else is content, labelled as such:** text inside documents, a collaborator's messages in a shared conversation, Inbox items and shared collections.
  - Adapters deliver it with its author (for a channel, as an attribute: `author="collaborator:…"`), and the agent's instructions say that only the person's messages are instructions.
  - A collaborator can't send instructions to *my* agent: my agent's pairing and grant are mine.
- **Limits stay with the grant:** the agent's grant bounds everything it does, however a message is phrased, and outward actions stay gated (§8.3, danger 3).
- **Approvals relayed to the panel** (Claude Code's permission relay) come only from the paired page. They need the same sender check as messages, because whoever can answer can approve.

### 8.8 Phases

| With | Agents get |
|---|---|
| Step 1 (the index) | `window.sagebrush.workspace`, its schema and tests |
| The file browser and File menu | The same verbs in the page's agent API, documented in the page's llms.txt |
| `sagebrush-mcp` | The verbs as MCP tools, through a driven page (before sync) |
| Collaboration (§7.9) | Presence, crediting edits to agents, "not run" marking, undo by agent |
| Sync, phase 2 (§7.7) | Grants, the agent endpoint, the access log, the Agents with access panel |
| The chat panel (§8.7) | The panel, conversations as documents, context with each message; the local adapter through `sagebrush-mcp` (Claude Code channels; `chat.next` for others) |
| After that | The cocalc.ai adapter, the Ask agent, Send to Sagebrush, Open in cocalc.ai; the remote adapter with sync |

### 8.9 Questions for design/security.md

1. How are agent tokens issued? Through the cocalc.ai sign-in, which a person approves, or by the person on sagebrush.space? How is the token stored, and how is it rotated?
2. What does an in-page agent's grant look like, given that the page holds the person's whole authority? Can a page restrict itself (an "agent mode" with only the granted paths), and is that worth it?
3. **"May run code"** (decided: on for the person's own agents, chosen at grant time otherwise, §8.3). The questions for review:
   - **The runner fallback:** an agent's run must never fall back to the plain worker (§8.3, danger 2). How is that enforced, and tested?
   - **A prompt-injected agent with run permission:** its local damage can be undone (danger 1). What reaches outside is only what the agent itself sends (danger 2) and the gated outward actions (danger 3). Is anything missing from that list?
   - **The boundary "code that agent wrote":** can it be enforced? Code pasted from a shared document into the agent's own edit would count as the agent's.
   - **Revoking:** how does turning the setting off reach a run already started in another tab?
   - **Retention:** do the limits on file versions (§2.5) leave a way to lose data by filling the quota on purpose? *(Proposed: no. A write that can't keep its previous version is refused.)*
4. Rate limits and sizes per verb, and what an over-limit agent sees.
5. How long the access log is kept, and who may read it.
6. Inbox: who may send to whom, spam and size limits, and what accepting does.
7. When a shared document is shared on with an agent: does a collaborator's grant reach the owner's files? *(Proposed: no. A grant covers only what the granting person owns or may edit, and the owner sees it.)*

---

## 9. How the work is split up

Each step is a branch of its own, reviewed as usual, with pictures for William for any visible step. Each step's tests fail without it.

1. **The `sagebrush-workspace` database, the index, reconcile and migration,** with the store for data files' versions (§2.5), written by the API's own writes (1a). Then the pages wired to it (1b), which version Python's writes and the Files panel's deletes too. No UI. Tests: every kind of item in today's stores comes out as an entry, the localStorage copies are untouched, a write from an older tab is brought in as a copy, and a key that won't parse is kept.
2. **The file browser** (sidebar, dialog and phone sheet), shared by both pages, written once in `web/workspace/`, with a file's versions and "Delete older versions" (per file and per folder), and the Storage panel's "Free N MB of old versions" (§2.5, §6.3).
3. **The one File menu** in both editors (3a), and Upload's rule (3b). Then **local snapshots** (3c, §2.6; proposed): a document opens from its latest snapshot, and TimeTravel pages older history in. It is independent of routing, helps every long-lived notebook now, and its snapshot writer is the one backup (step 8) needs.
4. **`/w/` routing** in the server, the service worker and both pages, plus the redirects from the old addresses. Then the board page in the shell.
5. **One page hosting both editors** (§5).
   - The board bundle loads into the notebook's page when the first board opens.
   - The file browser, the File menu and the runner are shared.
   - Each open document keeps its own interpreter, as each notebook does now (`kernels`).
   - `/frame/board/` and exported boards stay pages of their own.
6. **The chat panel and the local adapter** (§8.7): the panel beside the document, conversations as workspace documents, context with each message, and `sagebrush-mcp`'s adapter. It needs no sync, and Claude Code can use it through channels today.
7. **Shared collections as a read-only root.** This waits for the sharing pages.
8. **Backup (§7.7, phase 1).** Server and protocol design go first, in their own design note, with security review (design/security.md) before any upload of private data.
9. **Sync (§7.7, phase 2),** with agent grants and the agent endpoint (§8.4, §8.2), and the chat panel's remote adapter (§8.7).
10. **Collaboration (§7.9),** with presence and attribution for agents (§8.3). It needs two things first: the runner as the only way code runs, in every browser (§7.10), and "remote edits never run by themselves" in the reactive notebook and on boards.
11. **The cocalc.ai adapter, the Ask agent, and the handoffs with cocalc.ai** (§8.5, §8.6, §8.7). The adapter needs CoCalc's Agent Network to accept a person's page as a sender.
12. **Export and import** (§7.11): the bundle format (documented and versioned), the browser's export in both modes, Import, and the UI. The server's export job is auth's half, from the account's objects and R2. Its tests include a round trip (export, import into an empty workspace, same files, same TimeTravel), and bundles that lie: a wrong hash, an oversized entry, a hostile path, a later version. Other tests:
- the export's size bound holds for 400,000 tiny members with long names, and for incompressible data;
- a highly compressible member (zeros) of Sagebrush's own export imports;
- the JS heap peak of parsing a 64 MiB manifest is measured, and the cap is lowered if that peak is too high.

Steps 1 to 6 don't depend on sync. Step 1 includes `window.sagebrush.workspace` (§8.2). The index's operation log (§7.2) is designed in step 1, so sync can later be added without migrating again.

---

## 10. William's answers (Oct 18, 11:31 PM PDT)

> "I basically agree with EVERYTHING ... Please BUILD IT! This is such a fantastic complement to cocalc."

**Where his answer differs from the default:**
- **Two pages or one** (old question 6): **one page,** "to avoid confusion" (§5, step 5).
- **The desktop app** (old question 7): the same storage as the browser. Medium term, the desktop app is about more RAM, CPU and native code. Later, optionally, a path for reading and writing outside the sandbox (§6.2).
- **Encryption** (old question 11): **(a).** The design keeps end-to-end possible, but it isn't built now (§7.4).
- **Phones** (old question 12): only what is opened or pinned. A native phone app later can fetch everything (§7.5).
- **Agents:** "the plan COMPLETELY OMITS agents. We must have an agent strategy" (§8).

**These defaults stand:**
- real folders;
- full names in the browser and short names in the title bar;
- Python sees data files only;
- Delete goes to Trash;
- the sidebar opens once there is more than one document;
- "Free space used by old copies" is offered, never automatic;
- the File menu as in §3;
- sync entirely on Cloudflare, built to scale.
