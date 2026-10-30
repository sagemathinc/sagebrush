# Sagebrush's notebook component

`web/notebook` is the notebook of [sagebrush.space](https://sagebrush.space) as a component. Its parts:

- cells as in Jupyter: prompts `[n]:`, command and edit modes, Jupyter's keys, dragging to reorder, `+ Code` / `+ Text` between cells;
- outputs: text, SVG and PNG pictures, typeset math, interactive 3D views, animations, `@interact` controls and ipywidgets' widgets (a slider, dropdown, button, ... or a `VBox` of them, as a cell's value or with `display()`: `.observe`, `Button.on_click` and `interactive_output` work);
- Markdown cells with math, written as blocks as in Notion (web/board/blocks.ts), and Tab completion;
- `input()`: a field under the cell takes the line, as in Jupyter (Enter sends it; Stop raises KeyboardInterrupt). It needs a cross-origin-isolated page, as Stop does: elsewhere `input()` reads end of input (EOFError). The kernel's sink gets `input(prompt, reply)` (types.ts);
- printing to PDF.

It is plain DOM with no framework, MIT or Apache-2.0, and `web/build.ts` bundles it as `sagebrush-notebook.js` (about 110 kB minified, Markdown rendering included). [sagebrush.space/embed](https://sagebrush.space/embed/) is a whole page made with it.

```js
import { createNotebook, WorkerKernel, MemoryStore } from "/sagebrush-notebook.js";

const kernel = new WorkerKernel({ createWorker: () => new Worker("/sagebrush-worker.js", { type: "module" }) });
kernel.start();
const nb = createNotebook(document.querySelector("#nb"), { kernel, mode: "sage", assetBase: "/" });
await nb.attach(new MemoryStore({ mode: "sage", cells: [{ id: "a", code: "factor(2^64 + 1)" }] }));
```

## Two plug-in points

The interfaces are in [types.ts](types.ts).

**A kernel runs code.**
- `execute(code, {mode}, sink)` streams what happens to the sink: `start`, `out(text, isError)`, `display(mimeBundle)`, `interact(spec)`, `done(ms)`, `stopped(message)`.
- `ask` answers completion questions; `interrupt` and `restart` do what they say.
- [WorkerKernel](worker-kernel.js) is Sagebrush in a Web Worker in the page. Running a simple cell takes under 2 ms, and @interact sliders redraw as you drag.
- Any object with a Worker's interface can replace the worker. The full page uses one to talk to native Python behind `sagebrush notebook`'s local server.

**A store keeps the document.**
- `load()` returns it.
- `save(doc)` is called half a second after the last change, and only if the document changed.
- `subscribe(f)` reports changes made elsewhere, which the notebook applies in place: cells are matched by id, the cell being edited keeps its caret, and a running cell keeps its output.
- [stores.js](stores.js) has two:
  - `MemoryStore`;
  - `IdbStore`: this browser's IndexedDB. The same notebook open in two tabs stays in step.

A document is `{mode: "python" | "sage" | "magma" | "matlab", cells: [{id, type?, code, outputs?, n?, attachments?}], ...}`:
- `outputs` are Jupyter's output records, as in `.ipynb`;
- other fields (name, ...) are kept as they are;
- [ipynb.js](ipynb.js) converts to and from `.ipynb` (nbformat 4.5, with cell ids) and `# %%` scripts.

## The notebook's methods

| Group | Methods |
|---|---|
| Cells | `cells()`, `addCell(code, where, focus, type)`, `setInput(cell, text)`, `setType(cell, type)`, `select(cell)` (command mode), `edit(cell)` |
| Running | `run(cell)`, `runAll()`, `interrupt()`, `restart()` (a fresh interpreter; the outputs stay, marked stale), `setKernel(kernel)` (another interpreter: the full page gives each notebook its own) |
| The document | `load(doc)`, `snapshot()`, `applyRemote(doc)`, `attach(store)`, `detach()`, `flush()`, `setMeta(patch)`, `setMode(mode)` |
| Events | `on("change" \| "remote" \| "saved" \| "dirty" \| "mode", f)` |
| For agents | `outputText(box)` (an output as text, pictures by their descriptions); `pictures(box)` (as PNGs); `setInteract(id, values)` |
| Other | `setReadOnly(bool)`, `showKeys()`, `destroy()` |

## Stale outputs

An output is **stale** when the current interpreter did not compute it:
after Restart, after switching to another interpreter, or when it was loaded
from storage or from another tab (the option `staleOnLoad: true`, which the
full page uses). It stays visible, dimmed and labeled "stale", until its
cell runs again. On the full page each notebook has its own interpreter (the
four most recently used stay alive). The console is a scratchpad with its
own interpreter, apart from every notebook (design/reactive-notebook.md).

## The reactive notebook

With the options `reactive: true` and `analyzer` (`{analyze(code, mode)}`
resolving to the names a cell defines and reads: web/analyze-worker.ts,
src/dataflow.ts), cells form a dependency graph, as in marimo
(design/reactive-notebook.md):

- Running a cell first runs its stale ancestors, then reruns what depends on
  it, in graph order with ties in page order.
- Cells run automatically only within the budget (`setBudget(ms)`, default
  2 s; `Infinity` is marimo's autorun, 0 its lazy mode). The rest are left
  stale and say why.
- A name read by other cells has one defining cell. Second definitions and
  cycles are errors on the cells (#1477's relaxation: names nobody reads may
  be defined by several cells). An exception cancels the cells below it.
  Deleting a cell, or a definition from its code, deletes the names.
- Cells whose code changed since they ran are marked `edited`.
- For agents: `applyEdits({set, insert, remove}, {budget})` changes several
  cells and then runs once; `graph()` gives each cell's names, edges, state
  and errors; `verify()` recomputes everything in a fresh interpreter and
  lists the outputs that differ (hidden state). The full page offers them as
  WebMCP tools (edit_notebook, notebook_graph, verify_notebook).
  `runCells(ids, {remove, budget})` runs cells as one action. The scheduler
  is src/notebook-reactive.ts (`notebook.reactive`).

The full page is reactive (`?reactive=0` in its address turns that off in
the browser, for now); web/test-reactive.mjs tests it.

## Embedding notes

- **The worker must be same-origin.** Host `sagebrush-worker.js` and `sagebrush-engine.wasm` with your page, or build them from this repository.
- **`assetBase`** is where the notebook finds `sagebrush-math.js` (KaTeX, loaded on first use) and `sagebrush-viewer3d.js`. **`assetUrl(name)`**, if given, can return another URL for one of them, such as a `blob:` in a page that carries its files itself.
- **Stop interrupts only in a cross-origin-isolated page.** With the headers `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`), Stop raises KeyboardInterrupt and keeps the variables. Without them, Stop restarts the interpreter.
- **Colors** are CSS variables (`--fg`, `--bg`, `--line`, `--accent`, ...) that a page can set; the defaults are light. Everything is scoped to `.sbnb`, plus `.sbnb-pop` for menus and dialogs.

## In CoCalc

CoCalc's Jupyter documents are a syncdb with primary keys `type`, `id` and the string column `input`. Each cell is a record `{type: "cell", id, pos, input, cell_type, output, exec_count}`. Two adapters plug the component into CoCalc:

- **A syncdb store:**
  - `load()` maps the cell records, sorted by `pos`, to `cells`;
  - `save(doc)` writes the records whose input, type, position or output changed;
  - `subscribe()` listens to the syncdb's changes and returns the new document.
- **A project kernel:** `execute` sends the cell to the project's kernel (`JupyterClient.run` in cocalc-ai) and turns its Jupyter messages into the sink's calls.
  - `stream` messages call `out`;
  - `display_data` and `execute_result` call `display`;
  - `error` calls `out(traceback, true)`.

With both adapters the same component is all of these:
- a light `.ipynb` editor;
- an editable notebook next to an agent's chat;
- a kernel picker choice between "in this browser" (`WorkerKernel`) and "in the project".

## TimeTravel

[history.js](history.js) (built as `sagebrush-history.js`, with [patchflow](https://github.com/sagemathinc/patchflow)) records a notebook's edit history.
- **What a version is:** a patch on records in the format of CoCalc's Jupyter documents:
  - `{type: "settings", kernel}`
  - `{type: "cell", id, pos, input, cell_type}`
- **Outputs are not kept.** Text changes are stored as diff-match-patch diffs.
- **Recording:** `new NotebookHistory(patchStore)`, then `.init()`, then `.record(doc)` on each `change` event.
- **Reading:** `.versions()` lists them, and `.docAt(time)` rebuilds the document at a version. `.patches()` returns the patches for sending elsewhere, such as CoCalc.
- **Storage:** `IdbPatchStore(db, id)` ([stores.js](stores.js)) keeps the patches in IndexedDB and passes them to other tabs.
- **Reverting:** the full page's TimeTravel panel shows any version read-only and reverts with `notebook.replace(doc)`.

### Resume from here: the session at any version

The history also keeps an **execution journal**, so TimeTravel can recreate the live session (the variables, not just the text) as it was at a version. The design and its measurements are in [design/timetravel-replay.md](../../design/timetravel-replay.md).

- **What is journaled** (records in the same history, in patches that are not versions):
  - each interpreter session: its id and the seed of its entropy;
  - each run of a cell, of the console, or of an `@interact`, including the runs the tab's interpreter made for the other notebooks opened in it (it is shared by them; these "foreign" runs keep their code inline, and a replay reruns them with their output hidden): which code ran (a cell's input at the version when the run was asked for, so a cell edited afterwards still replays as it ran), how long it took, a hash of its output, and the clock values it read;
  - the files the session read: their SHA-256 only. The bytes are kept in this browser (IndexedDB `sagebrush-blobs`).
- **Determinism** comes from the worker ([web/replay-env.ts](../replay-env.ts)):
  - its entropy (`random`, numpy's generators, `os.urandom`) is a ChaCha20 stream from the session's seed;
  - the clock is real, and each run's reads are recorded and given back to the replay.
  - The page's **Reproducible randomness** switch (per notebook, on by default) turns the seed off. Anyone with a history can reproduce its random values.
- **Resume from here** (on the TimeTravel panel; marks under the slider show the versions where code ran):
  - It opens a new tab with a new notebook: the version, and the history up to it.
  - There it replays the runs of the session that was running then, which were asked for at that version or before. Each output is shown in its cell.
  - The estimate is the session's start plus the runs' recorded times.
  - Each replayed run is checked against the journal. The status line says the session is identical, or which run differs and how.
  - Python's writes to files during a replay do not go to the browser's files.
- **What cannot be resumed** says why:
  - a run that was interrupted;
  - an interpreter outside the browser (`sagebrush notebook`);
  - a history cleared while the interpreter ran.
- **The portable bundle:**
  - `File > Download with history (.sbreplay)` saves gzipped JSON: the notebook, its history patches (journal included), and the bytes of the files its sessions read. A typical one is a few KB.
  - `Upload` opens one as a new notebook with its history, in any browser, so its versions can be resumed there. Files are checked against their hashes.
- **The kernel's side:** `WorkerKernel` reports `execute` (a run is asked for) and `run` (it finished: `{kind, code | iid, values, ms, out, clock, ...}`) events. `execute(code, {mode, cell, clock})` replays a run's clock.
- **Tests:** [web/test-replay.mjs](../test-replay.mjs) records a session in headless Chromium (random numbers, the clock, numpy, `os.urandom`, a file, an `@interact`, the console) and resumes it in a new tab. It also checks that a replay whose output differs says where.
