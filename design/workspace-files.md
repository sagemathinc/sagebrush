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
- Install as an app… moves to the site menu (the Sagebrush logo), since it isn't about the file.

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
- **When the account may no longer sync:**
  - nothing is deleted;
  - sync pauses and the server copy becomes read-only, so it can still be downloaded (Download all, as a zip);
  - the person is always told before anything is removed.
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

---

## 8. Agents

**William (Oct 18): "We must have an agent strategy."** Agents use the workspace the way people do, by the same rules, through one API. The starting points came from @sagebrush; this section develops them.

### 8.1 Principles

1. **One API, three surfaces.** The verbs of the File menu are the API. The same verbs, with the same meaning and the same tests, are available:
   - in the page;
   - to agents on the person's own computer;
   - to remote agents, once sync exists.
2. **Agents are collaborators** (§7.9, §7.10).
   - They show where they are.
   - Everything they change is a patch credited to them, which TimeTravel shows and the person can undo.
   - Code they write doesn't run until the person says so.
3. **Precise, fine-grained permissions are a goal in themselves.** CoCalc has to enforce access at the level of Linux users and processes. Sagebrush runs everything in the browser, so it can say exactly which agent or person may read, write or run what, in which file. (William noted this on Oct 18.)
4. **Access is granted, not assumed.**
   - An agent sees only what it was given: by default read-only, for a stated time, and taken back at once.
   - Nothing leaves the device without sync turned on *and* a grant made.

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
| `remove(path)`, `restore(path)` | To Trash, and back out (§2.4). There is no verb that empties Trash: only a person can. |
| `history(path)`, `version(path, i)` | TimeTravel's versions, and any one of them |
| `watch(path, cb)` | Changes made elsewhere: another tab, device, person or agent |

- **One description of the verbs,** written as TypeScript types and a generated JSON Schema, serves all three surfaces. The MCP tools and the remote endpoint are generated from it, so they can't drift apart.
- **Fine-grained edits stay with the editors' own APIs:** `window.sagebrush.board` (load, focus, step, snapshot, run, outputs, versions; page.ts:24) and `window.sagebrush.notebook` (index.html:732). An agent edits one cell or note there, and uses the workspace API to find, open and organise files.

**The three surfaces:**

1. **In the page:** `window.sagebrush.workspace`, next to `window.sagebrush.board` and `.notebook`.
   - It is for agents that drive a browser: the shared browser, CDP, Playwright.
   - An agent in the page acts with the page's own authority, so the grant is the person handing over their browser.
   - This comes in step 1.
2. **On the person's computer:** the same verbs as MCP tools and a CLI, in the existing `sagebrush-mcp` package (engine/py-mcp), for Claude Code, Codex and others.
   - **Before sync,** the workspace exists only inside a browser. These tools then reach it through a browser page they drive (CDP), and the person sees that page.
   - **With sync,** they talk to the sync service directly (surface 3).
3. **Anywhere, with sync:** an authenticated agent endpoint on the sync service (§7.3).
   - Each verb becomes an operation on the account object or patches on a document object, credited to the agent.
   - This lets cocalc.ai agents, or Claude Code and Codex running anywhere, work in a person's workspace while every device of theirs is closed.

### 8.3 Agents as collaborators

- **Presence:**
  - an agent appears like a person in §7.9: a name (`agent:<name>`), a colour, and its cursor or selected cell or note;
  - a person can **follow** it, and the view moves with its edits;
  - the file browser shows which files an agent has open.
- **Attribution:**
  - every edit an agent makes is a patch credited to `agent:<name>`, and TimeTravel shows it;
  - "Undo this agent's changes" reverts them as one step, leaving other people's edits in place.
- **Running code: a setting on each grant, "may run code"** (William, Oct 18: "they definitely need to be able to run code. But … we can make it explicit whether or not it is allowed").
  - **The unit is the grant** (§8.4). An Ask conversation is a grant of its own, so the setting is per conversation there, and per agent and scope elsewhere.
  - The setting is shown plainly at the point of grant and in the Agents with access panel. It can be turned off at any moment, mid-session. A run already going is stopped, and nothing more runs.
  - **Defaults:**
    - **on** for the person's own Ask agent in the page. Its purpose is computing at the person's request, it runs in the person's own sandbox, and the person sees each run as it happens;
    - **off** for every other grant: local MCP agents, remote agents, cocalc.ai, which are turned on only by choice.
  - **Without it,** code an agent writes is marked "written by agent:<name>, not run", and nothing runs it until a person does.
  - **With it,** the agent runs code it wrote, and a running indicator names the agent, with Stop.
  - **Every run, either way:**
    - it happens **in the runner** (design/runner.md): no storage, no network, no cookies, never on the page's origin;
    - it is credited to the agent and logged: time, agent, document, cell or note, and the hash of the code.
  - **A remote agent's runs** happen only in an open page of the person's, which shows them. The sync service has no compute. With no page open, a remote agent can't run code; cocalc.ai is the place for that (§8.6).
- **The hard rule: code from other people never runs by itself.** This covers edits by collaborators, shared collections and Inbox items. There is no setting to change it (§7.10). An agent's "may run code" covers only code that agent wrote in that session. It never covers code that came from someone else, even when the agent passes it on.

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

- **What it is:** an "Ask" panel in the one page (§5). It talks to an agent through the person's linked cocalc.ai account, using the path built for deciding board questions (cocalc-ai PR #1134).
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

### 8.7 Phases

| With | Agents get |
|---|---|
| Step 1 (the index) | `window.sagebrush.workspace`, its schema and tests |
| The file browser and File menu | The same verbs in the page's agent API, documented in the page's llms.txt |
| `sagebrush-mcp` | The verbs as MCP tools, through a driven page (before sync) |
| Collaboration (§7.9) | Presence, crediting edits to agents, "not run" marking, undo by agent |
| Sync, phase 2 (§7.7) | Grants, the agent endpoint, the access log, the Agents with access panel |
| After that | The Ask panel, Send to Sagebrush, Open in cocalc.ai |

### 8.8 Questions for design/security.md

1. How are agent tokens issued? Through the cocalc.ai sign-in, which a person approves, or by the person on sagebrush.space? How is the token stored, and how is it rotated?
2. What does an in-page agent's grant look like, given that the page holds the person's whole authority? Can a page restrict itself (an "agent mode" with only the granted paths), and is that worth it?
3. **"May run code"** (decided: configurable per grant, §8.3). The questions for review:
   - An agent with that permission may be steered by injected text, and then run code that reads every file its grant covers and writes its outputs back where the agent reads them, so the agent can carry data away. What should bound that? Possibilities: a run sees only the files of its own document's folder; outputs read by the agent are capped; one grant can't be both "may run code" and wider than one folder without saying so.
   - Is the "code that agent wrote" boundary enforceable? Code pasted from a shared document into the agent's own edit would count as the agent's.
   - How does revoking it reach a run already started in another tab?
4. Rate limits and sizes per verb, and what an over-limit agent sees.
5. How long the access log is kept, and who may read it.
6. Inbox: who may send to whom, spam and size limits, and what accepting does.
7. When a shared document is shared on with an agent: does a collaborator's grant reach the owner's files? *(Proposed: no. A grant covers only what the granting person owns or may edit, and the owner sees it.)*

---

## 9. How the work is split up

Each step is a branch of its own, reviewed as usual, with pictures for William for any visible step. Each step's tests fail without it.

1. **The `sagebrush-workspace` database, the index, reconcile and migration.** No UI. Tests: every kind of item in today's stores comes out as an entry, the localStorage copies are untouched, a write from an older tab is brought in as a copy, and a key that won't parse is kept.
2. **The file browser** (sidebar, dialog and phone sheet), shared by both pages, written once in `web/workspace/`.
3. **The one File menu** in both editors, and Upload's rule.
4. **`/w/` routing** in the server, the service worker and both pages, plus the redirects from the old addresses. Then the board page in the shell.
5. **One page hosting both editors** (§5).
   - The board bundle loads into the notebook's page when the first board opens.
   - The file browser, the File menu and the runner are shared.
   - Each open document keeps its own interpreter, as each notebook does now (`kernels`).
   - `/frame/board/` and exported boards stay pages of their own.
6. **Shared collections as a read-only root.** This waits for the sharing pages.
7. **Backup (§7.7, phase 1).** Server and protocol design go first, in their own design note, with security review (design/security.md) before any upload of private data.
8. **Sync (§7.7, phase 2),** with agent grants and the agent endpoint (§8.4, §8.2).
9. **Collaboration (§7.9),** with presence and attribution for agents (§8.3). It needs two things first: the runner as the only way code runs, in every browser (§7.10), and "remote edits never run by themselves" in the reactive notebook and on boards.
10. **The Ask panel and the handoffs with cocalc.ai** (§8.5, §8.6).

Steps 1 to 5 don't depend on sync. Step 1 includes `window.sagebrush.workspace` (§8.2). The index's operation log (§7.2) is designed in step 1, so sync can later be added without migrating again.

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
