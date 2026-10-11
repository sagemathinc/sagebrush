<!-- description: The exact rules of Sagebrush's reactive notebook: what a cell defines and reads, which cells run when, page-order scoping for redefinitions, the time budget, errors, and what stays consistent. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code and design notes of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# How cells run

This page states the rules of Sagebrush's reactive notebook as they are
implemented. It is the notebook's specification: if the notebook does
something these rules do not say, that is a bug.

The rules are [marimo](https://marimo.io)'s where marimo has one, with the
differences listed at the end. One guarantee follows from them:

> **What you see is what the cells compute.** Every output is the result of
> the cells as they are now, or it is visibly marked stale.

## 1. What a cell defines and reads

The notebook reads each cell's code (without running it) and finds:

- **The names it defines**: names bound at the top level of the cell, by an
  assignment (`a = 5`, `a, b = ...`, `a += 1`, `a: int = 5`), `def`,
  `class`, `import` (`import numpy as np` defines `np`), a `for` or `with`
  target, `except ... as e`, `:=`, or `global a` in a function that
  assigns `a`.
- **The names it reads**: names it uses that it has not defined above that
  use in the same cell. Builtins such as `print` are read too, but no cell
  defines them, so they connect nothing.
- **The names it deletes** (`del x` of a name another cell defines).
- **The objects it changes in place**: `v[0] = 1`, `z.x = 2`, `del v[0]`,
  augmented assignment to those, `v.append(...)` and other in-place methods
  (`extend`, `sort`, `update`, `add`, ...), `random.shuffle(v)` and
  `heapq.heappush(v, ...)`, at the top level of the cell, where `v` is a
  name another cell defines. Such a cell is an **updater** of `v`.

Names local to a function, a lambda, a class body or a comprehension are not
the notebook's. A cell that defines a function which reads `x` reads `x`.

**Names starting with one underscore are private to their cell.** `_t`,
`_i` or `_tmp` in two cells are two different variables, and no other cell
sees them. (`__x` and `__` are not private.)

Sage cells are read after Sage's preparser (so `R.<x> = QQ[]` defines `R`
and `x`), and a top-level `var('x y')` defines `x` and `y`. Magma cells are
read after their translation to Python. A line `obj?` (help) reads `obj`.
`from m import *` is an error: what it defines cannot be known.

## 2. The dependency graph

Cell B **depends on** cell A when:

1. B reads a name that A defines (the definition that B sees: see
   section 3);
2. A changes in place an object that B reads (A runs `v.append(...)`, B
   reads `v`); the updaters of the same name depend on each other in page
   order, and each depends on the cell defining the name;
3. B deletes a name that A reads (so A runs before the name is gone);
4. A wrote a file that B read, the last time each ran (cells reading and
   writing files are connected automatically; a file connection that would
   make a cycle is left out).

Cells **run in dependency order**: a cell runs after every cell it depends
on. When that does not decide, the cell higher on the page runs first. A
definition may be below the cell that uses it.

**A cycle** (A depends on B and B on A, directly or through other cells) is
an error on every cell in it.

## 3. A name defined in several cells: the nearest definition above

A name may be defined by several cells. Each cell then reads **the nearest
definition above it on the page**, as when a paper says "let $K$ be ..."
and later redefines $K$, or as a Jupyter notebook does when it is run from
the top:

```
R.<x> = QQ[]                  # cell 1: x is a polynomial variable
print((x^2 - 1).factor())     # cell 2: reads cell 1's x
x = var('x')                  # cell 3: a new x
print(diff(sin(x), x))        # cell 4: reads cell 3's x
```

- Each definition is its own variable. Editing cell 1 reruns cell 2, not
  cell 4.
- Within a cell, a use before the cell's own definition reads the
  definition above (`x = x + 1` reads the previous `x`).
- A cell above every definition of a name reads the first one below it.
- Moving a cell, inserting one, or deleting one can change which definition
  a cell sees. The cells that now see a different definition run again.
- The page shows your code as you wrote it. Inside the interpreter, the
  later definitions have other names (`xʹ2`, `xʹ3`, ...: the character is
  U+02B9, a modifier letter). Error messages and the graph show `x`.

If a name is defined by several cells and **no cell reads it** (a loop
variable `i`, a scratch figure `fig`), nothing is renamed: each cell simply
sets it. The same `import` in several cells is one definition.

When renaming is not possible (Magma cells; a class body where a read of
`x` gets either the class's own `x` or the notebook's depending on how the
body runs, as after `if c: x = 1`), marimo's rule applies: a name
read by other cells may be defined by only one cell, and the cells
involved show an error with a button that renames the later definitions in
the code itself.

## 4. What runs, and when

**Running a cell submits its code.** Until you run it, an edited cell keeps
its previous code in the graph, and is marked with `*`. Shift+Enter, the ▶
button, Run all, Run stale and an agent's `applyEdits` all run cells.

When you run cells, the notebook runs, in dependency order:

1. **The cells you ran**, and **the stale cells they depend on** (so that
   they compute from current values). These always run.
2. **Automatically, the cells that depend on them**, and the cells whose
   meaning changed with this action: a cell that now sees another
   definition (section 3), a cell whose error went away, and the definer
   and updaters of an object whose updater changed or was deleted
   (section 5).

**The time budget** limits the automatic runs (the "Auto-run" control at
the top: 2 seconds by default, 10 seconds, always, or never; kept in the
notebook). In dependency order, each automatic cell runs if the time it
took last time still fits in what is left of the budget (a cell never run
counts as 0). A cell that does not fit is not run: it is marked **stale**,
with how long it takes, and so is every cell that depends on it. The cells
beside it go on. "Run stale" runs the stale cells, whatever the budget.

**Manual cells** (the cell menu: "Run only by hand") never run
automatically, nor do the cells depending on them; they are marked stale.

**Deleting a cell** deletes the names it defined from the interpreter, and
the cells that read them run again (and fail, unless another definition
takes over by section 3).

## 5. What the interpreter keeps

There is one interpreter per notebook (the console has its own).

- **Before a cell runs, the names it defined last time are deleted**, and
  so are its private `_` names. A definition you removed from a cell is
  gone once the cell runs.
- **An updater runs with its family.** Running a cell that changes `v` in
  place reruns the cell defining `v` first, then every updater of `v` in
  page order, then the cells reading `v`. A change is never applied twice.
  Deleting an updater, or editing it so that it no longer changes `v`,
  reruns the family the same way.
- **Random numbers are the same on every run of a cell.** Each cell's
  random seed is derived from the notebook's seed (kept in the notebook)
  and the cell's id: Python's `random`, `numpy.random` (including
  `default_rng()` without a seed) and Sage's random functions give the same
  values however often, and in whatever order, the cell runs (so do
  generators made or reseeded without a seed: `random.Random()`,
  `np.random.RandomState()`, `random.seed()`). `os.urandom` is truly
  random: a key made from it in a notebook cannot be reproduced from the
  notebook.
- **Files**: a cell that writes a file runs before the cells that read it
  (section 2), and they run again when it does. A file uploaded in the
  Files panel reruns the cells that read it.
- **Widgets are inputs.** Moving a widget (ipywidgets, or marimo's `mo.ui`
  controls) reruns the cells that read the variable holding it, within the
  budget, but not the cell that shows it. An `@interact` control reruns its
  own function.

## 6. Errors

- **An exception** in a cell stops the cells that depend on it in that run:
  they show "Not run: cell N, which this cell depends on, raised an
  error", and keep waiting for cell N until it runs without one.
- **Stop** interrupts the running cell and ends the run: the cells after it
  are stale. The cells that read what the interrupted cell defines wait
  for it to run again. (The interpreter keeps the variables.)
- **A cycle**, **`import *`**, and (when renaming is impossible) **a name
  defined by several cells and read** are errors in the graph: those cells
  do not run until the error is fixed. The error is shown on the cells you
  just ran, and on cells that were working only if they depend on those:
  adding a cell never breaks a cell that worked before.
- **A syntax error** is shown by the interpreter, in the cell, when you run
  it.

## 7. Outputs from elsewhere

Outputs that this interpreter did not compute are shown dimmed and marked
stale: after Restart, after reloading the page or opening a saved notebook,
and after changing the notebook's language (Python, Sage, Magma), which
also reads every cell again in the new language. Running a cell first runs
the stale cells it depends on.

**TimeTravel's "Revert to this version"** makes an old version the
notebook (as a new version: nothing is lost) and computes it from scratch:
a fresh interpreter, the files as they were then, and the same random
numbers.

## 8. For AI agents

The page offers agents (WebMCP) and scripts (`sagebrush.notebook`):

- `applyEdits({set, insert, remove})` (tool `edit_notebook`): several
  changes, then one run, with a report of what ran, what is stale, what
  failed, what waited, and the errors;
- `graph()` (`notebook_graph`): each cell's names, the cells it depends on
  and that depend on it, its state, and its last run time;
- `verify()` (`verify_notebook`): recompute everything in a fresh
  interpreter and list the cells whose output differs from what was shown.
  A difference means an output depended on something these rules do not
  see (see the limits below).

## 9. Limits

What the notebook cannot see from the code:

- **Changes through another name** (`w = v; w.append(1)` changes `v`),
  changes inside functions called later, and deeper changes (an object
  inside a list) are not tracked. `verify()` finds what they leave behind.
- **Names used through strings** (`globals()["x"]`, `exec`, `eval`) and
  **definitions that depend on a condition** (`if c: x = 1`) are read as
  written: a cell that defines `x` only sometimes still counts as defining
  it.
- **The outside world**: the clock, the network, and `input()` are not
  inputs of the graph.

## Differences from marimo

| | marimo | Sagebrush |
|---|---|---|
| A name defined in several cells | an error | each cell reads the nearest definition above |
| The same import in several cells | an error | one definition |
| Changing an object from another cell (`v.append`) | not tracked | the cell is an updater: it runs with the definer, before the readers |
| Files | `mo.watch.file` | tracked automatically |
| Automatic reruns | all (autorun) or none (lazy) | a time budget per action (always and never are its two ends), and manual cells |
| Random numbers | as Python gives them | the same on every run of a cell |
| A cycle | the cells on the cycles marimo records | every cell on a cycle |

The analysis of what a cell defines and reads is a port of marimo's, checked
against marimo itself on thousands of cells; so is the dependency graph
(see the [design notes](https://github.com/sagemathinc/sagebrush/blob/master/design/reactive-notebook.md)).
