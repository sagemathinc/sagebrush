# A reactive notebook for sagebrush.space

**Status:** proposal (October 11, 2026). Nothing is implemented. It follows
William's "there's no rule that this has to be exactly a Jupyter notebook",
and Astra's repeated review suggestion: reactive like marimo, with bounds on
recompute time.

## The goal

The notebook is mainly for agents and people working together, often with
an agent writing content for a person to read. That needs one guarantee:

> **What you see is what the notebook computes.** Every output shown is the
> result of the cells as they are now, or it is visibly marked stale. There
> is no hidden state: the state is a function of the document.

Jupyter's model breaks this, through run order, edited-but-not-rerun cells,
deleted cells, and one interpreter shared by every notebook in a tab. The
TimeTravel journal (design/timetravel-replay.md) needs foreign runs and
recorded clocks precisely because it doesn't hold.

## The model

1. **Each notebook has its own interpreter** (a Web Worker: about 120 ms to
   start, 1.5 s more for Sage's first import). Switching notebooks switches
   interpreters, and the few most recent stay alive.
2. **Cells form a dependency graph.**
   - Each cell's defined and used top-level names come from our own parser
     and scope analysis (the same AST as CPython's). Sage code is analyzed
     after preparsing, Magma after translation.
   - Cell B depends on cell A when B uses a name A defines.
   - Cells are shown in the author's order but run in graph order, so a name
     may be defined below its use, as in marimo and Observable.
3. **Rules that make the graph well defined:**
   - **One definition per name:** a name is defined in exactly one cell. A
     second definition is an error on both cells, with a clear message.
   - **No cycles:** a cycle is an error on the cells in it.
   - **Deleting a cell deletes its names.** The cells using them show
     `NameError`, with a pointer to the deleted cell.
   - **Mutation is not tracked:** `L.append(5)` in a cell that did not define
     `L` is flagged with a warning ("mutates L, defined in cell 3: changes
     made here are not tracked"). marimo has the same limit. Sage's objects
     are mostly immutable, so it matters less here.
4. **Running.**
   - Running (or editing and running) a cell reruns it and every cell
     downstream, in graph order.
   - **Bounded recompute:** each cell's last run time is known. If the
     downstream rerun is predicted under a budget (1 s by default; per
     notebook, and agents can set it), it happens at once. Otherwise the
     cells downstream are marked **stale** with "run (about 12 s)".
   - Stale outputs stay visible, greyed and labeled, never silently wrong.
   - Errors stop their dependents: a dependent shows "waiting for cell 4
     (error)", not a cascade of NameErrors.
5. **Restart** starts a new interpreter and keeps every output, marked stale;
   "Run all" recomputes in graph order. Nothing is lost by restarting.
6. **Randomness is per cell.** The seed is derived from the notebook's seed
   and the cell's id, so a cell gives the same random numbers however often,
   and in whatever order, it reruns. The clock is real.
   (`design/timetravel-replay.md`'s deterministic math library is what makes
   recompute bit-exact across browsers.)
7. **Widgets are inputs.** A widget defined in one cell and read (`n.value`)
   in another is an edge. Moving it reruns the reading cells within the
   budget: marimo's UI model, which subsumes `@interact`. `@interact` keeps
   working as today.
8. **The console is a scratchpad.** It reads the notebook's state, but what
   it defines is not part of the graph. It cannot create hidden state that
   cells depend on.
9. **Caching (later):** a cell's outputs and values keyed by its code and
   its inputs' hashes, so reopening or resuming a notebook does not
   recompute everything.

## What becomes simpler

- **TimeTravel:**
  - Resuming a version means opening it and recomputing it, since the state
    is a function of the document.
  - The execution journal, foreign runs and clock recordings go away. Run
    times stay, for estimates.
  - The `.sbreplay` bundle becomes the notebook, its history and the files
    it reads.
- **Agents:**
  - `run(cell)` returns which cells reran, which are stale, and the errors.
  - `graph()` returns the dependencies.
  - `verify()` recomputes from scratch and compares output hashes with the
    shown outputs.
  - An agent can never leave a person looking at outputs that disagree with
    the code.
- **Reading a notebook:** the order of cells is the author's narrative. The
  order of execution is the graph's, which is not the reader's job.

## Compatibility

- `.ipynb` import and export are unchanged: cells, outputs and metadata.
- A Jupyter notebook that redefines names (`x = 1` … `x = x + 1`) opens with
  those cells flagged. A one-click fix renames the later definitions (`x_2`)
  or merges the cells. Most notebooks written top to bottom satisfy the rules
  already.
- `sagebrush notebook` (native Python) and the Jupyter kernel keep their
  models. This is the browser notebook's model.

## Size

| Step | Work |
|---|---|
| One interpreter per notebook; Restart keeps outputs (stale) | 1–2 days |
| Def/use analysis, graph, rules and their errors | 2 days |
| Scheduler (graph order, budget, stale, errors stop dependents), UI | 2–3 days |
| Per-cell seeds; widgets as inputs; console as scratch | 1–2 days |
| TimeTravel simplified to recompute; agent API (run/graph/verify) | 1–2 days |

Each step has its own browser tests.

## Open questions

1. **Strict one-definition rule (marimo), or allow redefinition with a
   warning?** Strict makes the graph and agents' reasoning exact.
   Recommended: strict.
2. **Run on edit, or on Shift+Enter?** Recommended: on Shift+Enter for the
   edited cell, then automatic downstream within the budget. Typing never
   runs code.
3. **Budget default:** 1 s?
4. **Keep a classic, Jupyter-order mode at all?** Recommended: no.
