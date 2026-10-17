# The Sagebrush board format

A board is a JSON file (`*.board.json`): notes with Markdown and math, live
code, groups laid out for you, edges between items, pages or slides, and a
guided tour. You describe structure; the board does the layout. Open a board at
https://sagebrush.space/board/ (its ⋯ menu > Open…, or drop the file on the
page). A page that embeds a board uses https://sagebrush.space/frame/board/.

This page is for people and agents writing boards. Its fields are those of the
format's definition, `web/board/doc.ts` in the repository, which is
authoritative.

## A complete small board

```json
{"format": "sagebrush-board", "version": 1,
 "title": "Primes that are sums of two squares",
 "layout": "graph",
 "nodes": [
  {"id": "q", "title": "Question",
   "text": "Which primes $p < 60$ have $p \\equiv 1 \\pmod 4$?"},
  {"id": "c", "title": "Compute",
   "code": "[p for p in range(3, 60) if all(p % d for d in range(2, p)) and p % 4 == 1]"},
  {"id": "g", "kind": "group", "title": "Why", "layout": "column", "children": [
    {"id": "f", "text": "**Fermat:** an odd prime is $a^2 + b^2$ exactly when $p \\equiv 1 \\pmod 4$."},
    {"id": "e", "text": "For example $13 = 2^2 + 3^2$.", "detail": "Zoom in to see details like this one."}]}],
 "edges": [{"from": "q", "to": "c"}, {"from": "c", "to": "g", "label": "Fermat"}],
 "steps": [{"focus": "q", "say": "The question."},
           {"focus": "c", "say": "The code runs in the reader's browser."},
           {"focus": ["f", "e"], "say": "And the reason."}]}
```

## The rules that matter

- **The header.** Start with `"format": "sagebrush-board", "version": 1`.
  A board from a later version is refused with a message, never misread.
- **Ids.** Every item has an `id`, unique on its page (the same id may occur on
  different pages). Pages that have ids have distinct ones. Edges and tour
  steps refer to item ids on the same page.
- **Structure, not coordinates.** Leave out `x`, `y`, `w` and `h`: the board
  lays items out by `layout` (`graph` by default, which places the edges'
  layers top to bottom, or left to right with `"direction": "LR"`; or `row`,
  `column`, or `grid`, as square as can be unless `columns` says). An item keeps
  `x`/`y` only once a person moves it.
- **One language per board, usually.** `"mode"` is `"python"` (the default),
  `"sage"`, `"magma"` or `"matlab"`, and every code item uses it, unless the
  item sets its own `"mode"`. Each language runs in its own interpreter, so
  **languages share no values**: a name defined in a Python item is
  undefined in a Sage item. To use data from one language in another, copy
  it in as a literal. Run order and reruns work within each language. See
  "Languages" in https://sagebrush.space/llms.txt.
- **Code is reactive.** A note with `code` is a code item. Its output is shown
  under it, and items that use a name it defines rerun when it changes, as in
  a reactive notebook. Code runs in the reader's browser, in a sandbox with no
  network, so keep each item quick.
- **Math** is `$...$` and `$$...$$` (KaTeX) in `text`, `detail`, `intro` and
  `say`, and in the titles of notes and groups (not in the board's or a page's
  `title`, which are plain text). In JSON, write a backslash as `\\`.
- **Pictures** live in the top-level `images` object:
  `"images": {"fig1": {"w": 800, "h": 600, "src": "data:image/png;base64,..."}}`,
  and a note shows one with `"image": "fig1"`. A name is letters, digits, `_`
  and `-` (no spaces or dots), up to 100 characters. `src` may be a raster `data:` URL
  or an `https:` address; a board you hand to someone else should use `data:`
  URLs, so it is complete in one file. Keep a board under 16 MiB.
- **Pages and slides.** For several pages, put `nodes`, `edges` and `steps` in
  each entry of `"pages": [...]` instead of the top level. A page with a
  `slide` rectangle (16:9, say) is a slide, and Present shows it.

## Laying out a big board

The board places what you don't. These choices decide whether a page reads
well.

**Choose each container's `layout` by what links its items.**

- **`graph` (the default).** Use it for items joined by edges: a flow, a
  derivation, a dependency tree. It puts items in layers along the edges,
  each edge's `to` in a later layer than its `from`.
  - **Every edge counts**, dotted, labeled or thick alike. One summary note
    with an edge to each of five groups puts all five a layer below it,
    side by side.
  - **To place without drawing**, use `"hidden": true`: the edge orders the
    layers but isn't shown.
  - **To draw without placing**, put the two items in containers that are
    laid out another way (the dashboard pattern below).
- **`grid`.** Use it for items with few or no edges between them: cards,
  releases, pull requests. Set `columns`; the default is as square as
  can be. Edges between grid items are drawn, but they run through the gaps
  between columns, so use them sparingly there.
- **`row` and `column`.** Use them for a sequence read in one direction, and
  for arranging groups on a page.

**Nest groups to shape a page.** A group lays out its own `children` by its
own `layout`. The page lays out its top-level items, groups included, by
the page's `layout`. A page of several areas reads best as a *dashboard*:
a `column` of `row` groups (a header row, then a row of areas), each area a
group with the layout its contents need.

```json
{"format": "sagebrush-board", "version": 1, "title": "A week of work",
 "layout": "column",
 "nodes": [
  {"id": "head", "kind": "group", "layout": "row", "children": [
    {"id": "sum", "title": "This week", "text": "Three areas, 14 changes."},
    {"id": "next", "title": "Next week", "text": "What comes after."}]},
  {"id": "areas", "kind": "group", "layout": "row", "children": [
    {"id": "nb", "kind": "group", "title": "Notebook (4)", "layout": "grid", "columns": 2, "children": [
      {"id": "nb1", "title": "#101", "text": "Faster cells."},
      {"id": "nb2", "title": "#102", "text": "Tab completion."}]},
    {"id": "bd", "kind": "group", "title": "Boards (3)", "layout": "graph", "children": [
      {"id": "bd1", "title": "Format", "text": "The header."},
      {"id": "bd2", "title": "Check", "text": "`board check`."}]}]}],
 "edges": [{"from": "bd1", "to": "bd2"}]}
```

**Sizes.**

- A note is 260 wide and a code item 440. Give `w` only to make a note
  wider (a table, a long formula) or narrower (a label).
- Its height follows its text, so keep each note to a title and a few
  lines, and put the rest in `detail`, which the reader zooms in to see.
- Group titles are one line; a long one is cut with "…", so keep them short
  (for example "Sensors (6)").

**How much fits on a page.** A page's text stays legible on a laptop
screen up to about 20 to 30 short notes, 5 or 6 across. Beyond that the
reader sees the overview and zooms or scrolls to read. For more, use
`pages`, one theme each with its own `intro`, rather than one page that
holds everything.

**Check it before you hand it over.** Open it at
https://sagebrush.space/board/ and look at it as it first opens, fitted to
the window, before zooming in.

## Asking the reader

A board can ask the person reading it, and keep the answers. The reader
answers on the board, with its controls; a host's submission or
`sagebrush board answers --apply` writes answers too. An item of
`"kind": "ask"` is a question: its `text` asks (Markdown with math), and
its `input` says how it is answered:

- `check`: any of its `options` (checkboxes), or, without options, one
  yes/no box;
- `radio`: one of its `options`;
- `choice`: one of its `options`, from a list (for many);
- `text`: a text field (`lines` for more than one line);
- `number`: a number, within `min` and `max`, on `step`;
- `scale`: a whole number from `min` to `max` (default 1 to 5), with words
  at its ends in `low` and `high`.

An option is a text, or `{"value": "b", "label": "Plan **B**"}`: the answer
names the value, so the words can change. `"required": true` marks a
question that must be answered before the answers are sent. The answer is
kept in the item, as `answer`: for `check` a list of values (or `true` or
`false`), for `radio` and `choice` one value, for `text` a string, for
`number` and `scale` a number.

**Every question can also be answered in words.** Beside the controls, the
reader can always write an answer of their own, in English or any
language. It is kept as the question's `note`. A question with a note and
no `answer` counts as answered, and `required` is met. So ask with the
controls that fit, and expect the reader to say something else when the
options don't fit. Read the note as the answer whenever it is there.

```json
{
  "format": "sagebrush-board",
  "version": 1,
  "title": "Decisions",
  "layout": "column",
  "nodes": [
    { "id": "plan", "kind": "ask", "text": "Which plan should I follow?", "input": "radio", "required": true,
      "options": [{ "value": "a", "label": "Plan A: fix it now" }, { "value": "b", "label": "Plan B: document it" }] },
    { "id": "areas", "kind": "ask", "text": "Which modes should it cover?", "input": "check", "options": ["Python", "Sage", "MATLAB"] },
    { "id": "sure", "kind": "ask", "text": "How sure are you?", "input": "scale", "low": "not at all", "high": "very" },
    { "id": "why", "kind": "ask", "text": "Anything else?", "input": "text", "lines": 3 },
    { "id": "when", "kind": "ask", "text": "When should it ship?", "input": "radio", "options": ["Tonight", "Next week"],
      "note": "Not before the docs are reviewed." }
  ]
}
```

### Teaching: a check, hints and where to go next

A question can also check its answer, for a reader learning something. Its
`check` is code in the board's language (Python and Sage boards, for now),
run in the page when the reader presses **Check**. It sees the board's
names (what its code items made), with the answer as `answer`. Every check
and every computed hint runs on the board's code freshly re-run, in a new
interpreter, so what one changes never reaches another; nothing is
certified as preserved. The value of its last line is the
verdict: `True` (right), `False` (wrong), or a string (wrong, and the
string, Markdown with math, is shown to say why). A check that fails or
runs past `checkMs` milliseconds (default 2000, at most 10000) decides
nothing and isn't counted as an attempt.

`hints` are shown in order, one more after each wrong attempt. A hint is
Markdown, or `{"code": "..."}`, code whose last line is the hint's text,
computed with the reader's answer like the check. `next` sends the reader
on: `{"right": "id", "wrong": "id"}` names an item of the question's page
for each verdict. `example` is an answer for trying the check
(`sagebrush board try`). The board keeps the verdict in `result` and the
number of checked attempts in `attempts`, of them wrong in `wrongAttempts`
(one hint shown for each); a check that fails or runs out of time isn't
an attempt, and a new answer clears `result`.

```json
{
  "format": "sagebrush-board",
  "version": 1,
  "title": "Orbits",
  "mode": "sage",
  "layout": "column",
  "nodes": [
    { "id": "c0", "code": "G = SymmetricGroup(4)" },
    { "id": "orbit", "kind": "ask", "input": "number", "title": "An orbit",
      "text": "To how many points can $G$ move the point $1$?",
      "check": "answer == len(G.orbit(1)) or ('Each of $1, 2, 3, 4$ is one: count them' if answer < 4 else False)",
      "hints": ["$G$ is every permutation of $\\{1, 2, 3, 4\\}$.", { "code": "'Is there a permutation taking $1$ to $%d$?' % (answer % 4 + 1)" }],
      "next": { "right": "transitive", "wrong": "orbits" }, "example": 4 },
    { "id": "transitive", "title": "Transitive", "text": "One orbit: $G$ is transitive." },
    { "id": "orbits", "title": "Orbits", "text": "The orbit of $1$ is every point $g(1)$." }
  ]
}
```

A question can also say what the reader's own words may show: its
`decide` lists up to 32 things, each with a name that says what it means
(words joined by hyphens, at least three, such as
`confuses-transitive-with-two-transitive`), an optional `about` (Markdown
that makes the name clearer) and an optional `next`. A host that shows the
board can ask a model which of them the reader's words show, and the board
sends the reader to that one's `next` (https://sagebrush.space/board-host-protocol.md,
"Deciding"). The name carries the meaning, so write it for a reader who
sees nothing else.

```json
{
  "format": "sagebrush-board",
  "version": 1,
  "title": "Transitive",
  "nodes": [
    { "id": "mean", "kind": "ask", "input": "text", "title": "Transitive",
      "text": "In your words: what does it mean for $G$ to act transitively?",
      "decide": [
        { "name": "confuses-transitive-with-two-transitive", "about": "Says any ordered pair of distinct points can be sent to any other, the two moved simultaneously by one group element.", "next": "pairs" },
        { "name": "thinks-transitive-means-abelian", "next": "abelian" }
      ] },
    { "id": "pairs", "title": "2-transitive is more" },
    { "id": "abelian", "title": "Transitive is not abelian" }
  ]
}
```

`sagebrush board check FILE` lints these (a check in another language, an
empty one, `next` naming no item of the page). `sagebrush board try FILE
--json` runs every question's check, with its `example` or with `--case
'id=JSON'`, and its computed hints, and reports what a reader would see.

`sagebrush board answers FILE` lists the questions and the answers kept in
the board, with each one's note; with `--json`, for a program. A host that shows the board
passes the reader's answers back as a submission
(https://sagebrush.space/board-host-protocol.md), and
`sagebrush board answers FILE --apply SUBMISSION.json` writes them into
the file. A reader that doesn't know questions yet shows each as a note,
with its title and text.

<!-- fields: written by scripts/board-format-fields.mjs from the doc comments of web/board/doc.ts; edit those, not this -->
## Fields

Each kind of thing in a board, its fields, their types and what they mean. A type in words (note, edge, page, ...) is the section of that name, and `item` is any of note, group, ink, sticker or question; `[x]` is a list of them, `{name: x}` an object of them by name; `object` is one Sagebrush writes, whose fields this page doesn't list.

### The document

A board: one page (its own `nodes`, `edges` and `steps`), or several (`pages`).

| field | type | meaning |
|---|---|---|
| `format` | `"sagebrush-board"` | `"sagebrush-board"`: write it first |
| `version` | number | `1`: write it second |
| `title` | string | the board's title (plain text) |
| `mode` | `"python"` \| `"sage"` \| `"magma"` \| `"matlab"` | the language of its code items, one per board (default `python`) |
| `engine` | `"latest"` | `"latest"`, in a downloaded file: run with the newest engine when online (written by Sagebrush) |
| `seed` | string | 64 hex digits: the seed of its code's random numbers; without it a fixed default is used, so a board's random numbers are always repeatable |
| `tools` | [string] | the toolbar's tools in Edit mode, in order (written by Sagebrush) |
| `images` | {name: picture} | pictures by name: `{w, h, src}` (pixels; `src` a `data:` or `https:` URL). A name is letters, digits, `_` and `-`, at most 100 characters (`plot-1`, not `plot 1` or `figure.png`): a picture by another name is left out, and so is a note's or a background's use of it |
| `pages` | [page] | several pages; a document with pages has no `nodes`, `edges` or `steps` of its own |
| `intro` | string | Markdown shown before the tour starts (with pages: on the first page, if it has no `intro` of its own) |
| `refBase` | string | the base URL for `ref` links that are paths (e.g. a repository's blob URL) |
| `layout` | `"row"` \| `"column"` \| `"grid"` \| `"graph"` | how the top-level items are laid out (default `graph`) |
| `columns` | number | as for a group |
| `direction` | `"TB"` \| `"LR"` | as for a group |
| `slide` | card | as for a page |
| `background` | background | as for a page |
| `nodes` | [item] | the items of a one-page board |
| `edges` | [edge] | the edges among them |
| `steps` | [step] | its tour |

### A page (in `pages`)

A page of a board: its own items, edges and tour.

| field | type | meaning |
|---|---|---|
| `id` | string | needed by templates; unique among the pages |
| `title` | string | the page's title (plain text) |
| `intro` | string | Markdown shown before the page's tour (without it, the page's title is shown; on the first page, the document's `intro`) |
| `layout` | `"row"` \| `"column"` \| `"grid"` \| `"graph"` | how the page's items are laid out (default `graph`) |
| `columns` | number | as for a group |
| `direction` | `"TB"` \| `"LR"` | as for a group |
| `slide` | card | the card the page is arranged on, a slide, which Present shows |
| `background` | background | the page's background |
| `template` | boolean | `true`: other pages can be made from it (it needs an `id`) |
| `uses` | string | a template page's id: its card, background and items appear under this page's own |
| `nodes` | [item] | required: the page's items |
| `edges` | [edge] | the edges among them |
| `steps` | [step] | its tour |

### A note (the default item)

A note: the default item. Every part is optional; a note with `code` is a code item.

| field | type | meaning |
|---|---|---|
| `id` | string | required: unique on its page (an edge names it) |
| `kind` | `"note"` | `"note"`, or left out |
| `title` | string | a heading (plain text, math allowed) |
| `image` | string | a picture: its name in the document's `images` (letters, digits, `_` and `-`, at most 100 characters) |
| `text` | string | Markdown with math (`$...$`), shown at every zoom |
| `code` | string | code in the board's language (`mode`), run in the reader's browser, its output under it; it makes the note a code item |
| `hideCode` | boolean | `true`: show only the code's output, not the code |
| `mode` | `"python"` \| `"sage"` \| `"magma"` \| `"matlab"` | a code item's language, when it is not the board's (`"python"`, `"sage"`, `"magma"` or `"matlab"`; default: the board's `mode`). Each language runs in its own interpreter: languages share no values, so copy data from one to another as literals |
| `preview` | object | a slow code item's output, kept to show before it runs (written by Sagebrush) |
| `detail` | string | Markdown shown only when zoomed in |
| `ref` | string | a link: a URL, a paper, or a path (`src/file.py#L10`) resolved against `refBase`; or a place on the board: `#p2` (page 2), `#p2-3` (its step 3), `#3` (this page's step 3), `#id` (the page with that id, or the item), `#page-id/item-id` (an item on a page); in Markdown text too, as `[see Boards](#boards)` |
| `color` | string | a color (`#e8f0fb`, a CSS color name, `rgb(...)`, `hsl(...)`) |
| `shape` | `"rect"` \| `"round"` \| `"stadium"` \| `"circle"` \| `"diamond"` \| `"hexagon"` \| `"cylinder"` \| `"subroutine"` \| `"lean-right"` \| `"lean-left"` \| `"trapezoid"` \| `"inv-trapezoid"` \| `"flag"` | its outline (a flowchart's); its text is then centered. `diamond` (a decision) is pointed at its left and right and flat at its top and bottom, so that its text fits a note's width, not a true rhombus (which would need twice its text's width and height); `hexagon` is the same, less pointed |
| `fit` | boolean | `true`: as wide as its text needs, up to `w` |
| `x` | number | its position, kept once a person moves it: leave it out, and the board places it |
| `y` | number | as `x` |
| `w` | number | its width (default 260; 440 for a code item; for a note with only a picture, the picture's width, up to 480, its height then from the picture's shape) |
| `h` | number | its height (default: as tall as what it shows) |

### A group

A group: items laid out together, under a title. Groups nest; an edge may join any two items on a page, in any groups.

| field | type | meaning |
|---|---|---|
| `id` | string | required: unique on its page |
| `kind` | `"group"` | required: `"group"` |
| `title` | string | a heading (plain text, math allowed) |
| `text` | string | Markdown with math, under the title |
| `layout` | `"row"` \| `"column"` \| `"grid"` \| `"graph"` | how its items are laid out (default `graph`: in layers along the edges among them) |
| `columns` | number | `grid` layout: how many columns (default: as square as can be) |
| `direction` | `"TB"` \| `"LR"` | `graph` layout: layers top to bottom (`TB`, the default) or left to right (`LR`) |
| `children` | [item] | required: its items (notes, groups, stickers) |
| `color` | string | a color |
| `x` | number | its position, kept once a person moves it: leave it out |
| `y` | number | as `x` |
| `w` | number | its width at least, as a person made it by its corner (it is as wide as this, or as its items need, whichever is more) |
| `h` | number | its height at least, as `w` |

### An edge

An edge between two items on a page, drawn as an arrow from `from` to `to`.

| field | type | meaning |
|---|---|---|
| `from` | string | required: an item's id |
| `to` | string | required: an item's id |
| `label` | string | a label on it (plain text) |
| `hidden` | boolean | `true`: not drawn, only used to lay out (to place one box below another) |
| `arrow` | `"none"` \| `"both"` | arrowheads: at the end (when left out), `none`, or `both` ends |
| `line` | `"dotted"` \| `"thick"` | `dotted` or `thick` (default: a thin line) |

### A tour step

A step of a tour: the camera shows these items while the caption explains them.

| field | type | meaning |
|---|---|---|
| `focus` | string \| [string] | required: an item's id, or several |
| `say` | string | the caption (Markdown with math) |

### A sticker

A sticker: one emoji, or one of CoCalc's icons, shown without a frame.

| field | type | meaning |
|---|---|---|
| `id` | string | required: unique on its page |
| `kind` | `"sticker"` | required: `"sticker"` |
| `emoji` | string | one emoji |
| `icon` | string | one of CoCalc's icons, by name (a converted CoCalc board), with `color` |
| `color` | string | an icon's color |
| `x` | number | its position: leave it out, and the board places it |
| `y` | number | as `x` |
| `w` | number | its width (default 64) |

### Ink

A pen stroke, drawn by a person. Don't write these.

| field | type | meaning |
|---|---|---|
| `id` | string | required: unique on its page |
| `kind` | `"ink"` | required: `"ink"` |
| `points` | [number] | required: x, y and pressure (0 to 1) of each point, from the corner (`x`, `y`) |
| `size` | number | the pen's width |
| `color` | string | its color |
| `opacity` | number | below 1: a highlighter's, which what is under it shows through |
| `x` | number | required: the corner of its box |
| `y` | number | required: as `x` |

### A question (`kind: "ask"`)

A question for the person reading the board: checkboxes, radio buttons, a list to choose from, a text, a number or a scale. Its answer is kept in it, as `answer`: given on the board with its controls, or written by a host's submission or `sagebrush board answers --apply`.

| field | type | meaning |
|---|---|---|
| `id` | string | required: unique on its page (an answer names it) |
| `kind` | `"ask"` | required: `"ask"` |
| `title` | string | a heading (plain text, math allowed) |
| `text` | string | the question: Markdown with math (`$...$`) |
| `input` | `"check"` \| `"radio"` \| `"choice"` \| `"text"` \| `"number"` \| `"scale"` | required: how it is answered: `check` (any of `options`, or without them one yes/no box), `radio` (one of `options`), `choice` (one of `options`, from a list: for many), `text`, `number` or `scale` (a whole number from `min` to `max`) |
| `options` | [string \| option] | `check`, `radio` and `choice`: what may be chosen; each a text, or `{ "value": ..., "label": ... }` to keep its answers when its words change |
| `required` | boolean | `true`: it must be answered before the answers are sent |
| `min` | number | `number`: the least it takes; `scale`: its first value (default 1) |
| `max` | number | `number`: the most it takes; `scale`: its last value (default 5) |
| `step` | number | `number`: the step between the values it takes |
| `low` | string | `scale`: the words at its low end ("disagree") |
| `high` | string | `scale`: the words at its high end ("agree") |
| `lines` | number | `text`: how many lines its field shows (default 1) |
| `note` | string | the reader's answer in their own words (plain text, English or any language): beside the answer, or in place of it. A question with a note that is not only spaces counts as answered |
| `answer` | string \| number \| boolean \| [string] | the answer given: for `check` the values chosen (a list; `true` or `false` without options), for `radio` and `choice` the value chosen, for `text` a string, for `number` and `scale` a number |
| `check` | string | code in the board's language that decides whether an answer is right (Python and Sage boards): the answer is bound to `answer`, in a scope of its own that sees the board's names (the board's code runs again after it, so what it changes doesn't last); the value of its last expression is the verdict: `True` (right), `False` (wrong), or a string (wrong, and the string, Markdown with math, is shown). Run when the reader presses Check, within `checkMs` |
| `checkMs` | number | the most milliseconds its check, or a computed hint, may run (a whole number, 1 to 10000; default 2000) |
| `hints` | [string \| computed hint] | hints, one more shown after each wrong attempt: Markdown, or `{ "code": ... }`, run as the check is, its value a string (Markdown) |
| `next` | next | where to go after an attempt: the id of a note on this page, for `right` and for `wrong` |
| `decide` | [decision] | what the reader's own words (`note`) may show, for the host to decide among (at most 32): each a self-describing name, such as a misconception, and where to go if it is the one (web/board-host-protocol.md, "Deciding") |
| `example` | string \| number \| boolean \| [string] | an answer to try its check with (`sagebrush board try` runs it) |
| `attempts` | number | how many times its answer was checked (written by Sagebrush) |
| `wrongAttempts` | number | how many of those were wrong: one more hint is shown after each (written by Sagebrush) |
| `result` | `"right"` \| `"wrong"` \| `"error"` | the last check's verdict: `right`, `wrong` or `error` (written by Sagebrush) |
| `detail` | string | Markdown shown only when zoomed in |
| `color` | string | a color |
| `x` | number | its position: leave it out, and the board places it |
| `y` | number | as `x` |
| `w` | number | its width (default 320) |
| `h` | number | its height (default: as tall as what it shows) |

### An option (in a question's `options`)

One of a question's options, whose `value` its answer names: its `label` (default: the value) is what the reader sees.

| field | type | meaning |
|---|---|---|
| `value` | string | required: what an answer says when this is chosen |
| `label` | string | what the reader sees (Markdown with math; default: `value`) |

### A computed hint (in a question's `hints`)

A hint computed from the reader's answer.

| field | type | meaning |
|---|---|---|
| `code` | string | required: code run as the question's check is, `answer` bound; its value, a string, is the hint (Markdown) |

### Where a question leads (its `next`)

Where a question leads after an attempt: notes on its page, by id.

| field | type | meaning |
|---|---|---|
| `right` | string | the note to go to after a right answer |
| `wrong` | string | the note to go to after a wrong one |

### What a reader's words may show (in a question's `decide`)

One of the things a reader's own words may show, which the host decides among.

| field | type | meaning |
|---|---|---|
| `name` | string | required: what it is, in words joined by hyphens, at least three (`confuses-transitive-with-2-transitive`): the name says what it means |
| `about` | string | Markdown that makes the name clearer (a rubric), if it needs that |
| `next` | string | the id of an item on this page to go to when it is the one |

### A slide's card (`slide`)

A slide's card on its page, in board coordinates.

| field | type | meaning |
|---|---|---|
| `x` | number | required: its left edge |
| `y` | number | required: its top edge |
| `w` | number | required: its width |
| `h` | number | required: its height (16:9 with `w`, say) |

### A background (`background`)

A page's background.

| field | type | meaning |
|---|---|---|
| `color` | string | a color: on a slide's card, or behind the whole board |
| `image` | string | a picture's name in `images` (letters, digits, `_` and `-`, at most 100 characters), on a slide's card |

### A picture (in `images`)

A picture a note shows, by its name in the document's `images`.

| field | type | meaning |
|---|---|---|
| `w` | number | required: its width in pixels |
| `h` | number | required: its height in pixels |
| `src` | string | its bytes, which a file needs to show the picture: a `data:` URL (PNG, JPEG, GIF or WebP), or an `https:` address |

<!-- /fields -->

## Checking a board before you hand it over

1. Run every code item with the command line, in the board's language, for
   example `npx sagebrush@0.3.2 --sage -c 'factor(2^32+1)'`. An unimplemented
   function raises an error, so code that runs is supported. (0.3.2 has no
   MATLAB yet.)
2. Search before you guess: `npx sagebrush@0.3.2 --search "elliptic curve rank"`.
3. Open the board at https://sagebrush.space/board/ to see the layout.

## What's new

- **2026-10-16:** questions for the reader (`"kind": "ask"`), their answers
  (and the reader's own words, `note`) kept in the board, and
  `sagebrush board answers`.
- **2026-10-14:**
  - `"mode": "magma"` and `"mode": "matlab"`;
  - template pages (`template`, `uses`) and stickers;
  - the board can be embedded at `/frame/board/` (sent by `postMessage`).
- **2026-10-13:**
  - the `format`/`version` header;
  - any note can have `code` (`kind: "code"` is still read) and `hideCode`;
  - pictures (`images`).
- **2026-10-12:** pages and slides (`pages`, `slide`), and shapes for flowcharts (`shape`).
