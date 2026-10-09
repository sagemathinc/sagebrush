# Sagebrush's notebook component

`web/notebook` is the notebook of [sagebrush.space](https://sagebrush.space) as a component. Its parts:

- cells as in Jupyter: prompts `[n]:`, command and edit modes, Jupyter's keys, dragging to reorder, `+ Code` / `+ Text` between cells;
- outputs: text, SVG and PNG pictures, typeset math, interactive 3D views, animations and `@interact` controls;
- Markdown cells with math, and Tab completion;
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

A document is `{mode: "python" | "sage" | "magma", cells: [{id, type?, code, outputs?, n?, attachments?}], ...}`:
- `outputs` are Jupyter's output records, as in `.ipynb`;
- other fields (name, ...) are kept as they are;
- [ipynb.js](ipynb.js) converts to and from `.ipynb` (nbformat 4.5, with cell ids) and `# %%` scripts.

## The notebook's methods

| Group | Methods |
|---|---|
| Cells | `cells()`, `addCell(code, where, focus, type)`, `setInput(cell, text)`, `setType(cell, type)`, `select(cell)` (command mode), `edit(cell)` |
| Running | `run(cell)`, `runAll()`, `interrupt()`, `restart()` |
| The document | `load(doc)`, `snapshot()`, `applyRemote(doc)`, `attach(store)`, `detach()`, `flush()`, `setMeta(patch)`, `setMode(mode)` |
| Events | `on("change" \| "remote" \| "saved" \| "dirty" \| "mode", f)` |
| For agents | `outputText(box)` (an output as text, pictures by their descriptions); `pictures(box)` (as PNGs); `setInteract(id, values)` |
| Other | `setReadOnly(bool)`, `showKeys()`, `destroy()` |

## Embedding notes

- **The worker must be same-origin.** Host `sagebrush-worker.js` and `sagebrush-engine.wasm` with your page, or build them from this repository.
- **`assetBase`** is where the notebook finds `sagebrush-math.js` (KaTeX, loaded on first use) and `sagebrush-viewer3d.js`.
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
