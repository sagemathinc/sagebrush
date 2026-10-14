# Outputs: what is kept, where, and for how long

*Status: decided (William, October 14 2026); being built in the steps below.*

A code item's output (or a reactive notebook cell's) is a function of its
code and its inputs. So an output is something to recompute, not to store.
Outputs are kept only to save waiting, so they are stored in two bounded
places, with one owner each and no reference counts:

1. **Previews in the document.** For a cell that is slow to recompute from
   scratch, a small preview of its output.
2. **A cache beside the document.** Full outputs, keyed by what produced them,
   capped, least recently used first out.

A published version freezes its outputs with it.

## What other tools do

| Tool | In the file | Elsewhere |
| --- | --- | --- |
| Excel, Numbers | every formula's last value | none |
| Jupyter, Mathematica | every output, in full | none |
| marimo | none (the `.py` is code only) | an optional session cache beside the file (`__marimo__/`) |
| Pluto, Observable | none | an HTML export carries them |

Excel can keep every value because a value is one number or string. An
output is a plot, a table or a 3D scene. Jupyter keeps everything in the
file, so the file and its history grow with every run, and a changed plot
is a conflict between two people. The plan here is closest to marimo's:
code in the document, outputs beside it. It adds one thing: bounded previews
in the document, so a reader of a slow notebook sees something before
running it.

## 1. Previews in the document

- **Only for slow cells.** A cell gets a preview when its *time from root*
  is over 10 s: its own last run time plus that of every cell it depends
  on, directly or not (each counted once). That is how long a reader with
  a fresh interpreter waits to see it. Every other cell reruns on open well
  within the budget, so it needs no preview.
- **Bounded:**
  - per cell, at most 32 KB: text cut to its first 4 KB and last 1 KB with
    "… n lines …" between, and at most one picture, re-encoded as WebP or
    PNG at most 640 pixels wide;
  - no 3D scenes and no widgets (the picture of a 3D scene is kept);
  - per document, at most 512 KB of previews. Past that, the cells closest
    to the 10 s line lose theirs first.
- **A preview is written only when its cell finishes running** and its
  output differs from the preview already kept. So the document's history
  (TimeTravel, CoCalc's patches) grows with slow reruns, not with every run.
- **Shown as a preview,** greyed like a stale output, with when it was
  computed and how long it took: "computed October 13, 42 s. Run to
  update". Running the cell replaces it.
- **In the file:** a node's `preview: {at, ms, outputs}`, where `outputs` is
  a list of Jupyter outputs (`stream`, `display_data`), as everywhere else in
  Sagebrush. Canonical JSON puts it last in the node.

## 2. The cache beside the document

- **The key is what produced the output.** For a cell:

  $$\mathrm{key}(c) = \mathrm{SHA256}\big(\mathrm{mode},\ \mathrm{code}(c),\ \mathrm{seed}(c),\ \mathrm{key}(p_1), \dots, \mathrm{key}(p_k)\big)$$

  Here $p_1, \dots, p_k$ are the cells $c$ reads from, sorted by key, and
  $\mathrm{seed}(c)$ is the cell's random seed (from the document's seed and
  the cell's id). The key changes when the code changes, or when anything
  upstream does, as a Merkle tree.
- **Files are checked, not keyed.** An entry records the SHA-256 of each file
  its run read, and is used only if those files are unchanged. Widget values
  a cell reads are part of its key.
- **What is cached:** the full outputs of the cells whose time from root is
  over the document's budget (2 s by default). These are the cells that would
  not rerun by themselves on open.
  - An output over 16 MB is not cached (a big 3D mesh). As now, its picture
    is.
- **On open:** a cell whose key and files match an entry shows the entry's
  outputs as up to date, marked "cached" with its date. It is not run. Its
  values are not in the interpreter, so running a cell that reads it runs
  it first, as for any stale ancestor.
- **The engine's version is recorded, not keyed.** A new engine (every
  deploy) would otherwise empty every cache. `verify()` recomputes from
  scratch and compares, as it does for shown outputs.
- **A cell that reads the clock or the network** gets its cached output like
  any other. Anyone who minds can mark it manual or rerun it. A per-cell "never cache" flag
  can come later if needed.

### Where the cache lives, and how it is collected

- **One cache per document, never shared between documents.** The same
  output in two documents is stored twice. That is the price of having no
  reference counts: deleting a document deletes its cache, and nothing else
  can need it.
- **Mark and sweep, per document, when it is saved:**
  - the mark is the set of keys of the document's current cells;
  - the sweep removes unmarked entries, oldest use first, while the cache is
    over its cap;
  - marked entries are removed only if the marked ones alone are over the
    cap.
- **Caps:** 64 MB per document, and 512 MB per browser, across all of its
  documents. Past the browser cap, the caches of the documents opened least
  recently go first, whole.
- **In the browser (sagebrush.space):** an IndexedDB store, records
  `{doc, key, outputs, files, engine, bytes, used}` indexed by document and
  by last use.
- **In CoCalc:** a hidden file beside the document, renamed, copied and
  deleted with it. Its exact form comes with the CoCalc integration step
  (board-in-cocalc). CoCalc's own Jupyter files are unchanged.

## 3. Freezing on publish

- **A shared or published version carries its outputs:** for each board or
  notebook in it, the cached outputs for its current cells. Each is a file of
  the version, so it is in the version's manifest and counted against the
  publisher's storage.
- **No new collection:** a version already references its files, and
  holdings no version references are already removed (design/sharing.md).
  Deleting a share link or a version removes its outputs with it.
- **A reader sees them at once,** marked "computed when published", and can
  rerun anything.
- **A downloaded board (Download as HTML)** carries its previews (they are in
  the document) and, unless the person opts out, its cached outputs up to
  the document's cap.

## 4. Jupyter files

`.ipynb` keeps all of its outputs inline: that is the format, and Jupyter
and CoCalc read it. Nothing here changes it. A board's code items converted
to a notebook (or downloaded as one) carry every output there is: computed,
cached, or a preview.

## Steps, each tested before the next

1. **Keys and time from root,** in the reactive notebook: a document seed
   for boards (`seed`, made once, kept in the file, as notebooks have),
   each cell's key and time from root, exposed to the board and to agents.
   Tests: the key changes exactly when code, seed, mode or anything upstream
   changes. Time from root counts a shared ancestor once.
2. **Previews in boards:** written, bounded, shown, canonical. Tests: the
   bounds, history growth only with slow reruns, and a board opened in a
   fresh browser shows its slow cells' previews without running them.
3. **The browser cache:** IndexedDB, the "cached" state in the scheduler,
   mark and sweep, both caps. Tests: reopen shows cached outputs without
   running; editing upstream invalidates; a changed file invalidates; sweep
   order; a deleted board's cache goes with it.
4. **Publish and download:** outputs in shared versions and in Download as
   HTML. Tests through the share API's Miniflare suite and the export test.
5. **Notebooks (later):** Sagebrush's own notebook documents keep every
   output inline today, as `.ipynb` does. Whether they move to previews and
   the cache will be decided once boards have used it for a while.
   `.ipynb` stays as in section 4.
6. **CoCalc:** the sidecar file, with the board-in-CoCalc integration.
