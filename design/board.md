# Boards: a reactive whiteboard for agents and people

**Status:** proposal (October 11, 2026). Nothing is implemented yet.
William's decisions so far are under "Decisions" at the end.

A **board** is an infinite canvas holding notes (Markdown and math), live
code, ink, shapes, images and the connections between them. Frames on the
canvas double as slides. Code on a board runs reactively, with the
notebook's engine (design/reactive-notebook.md). Agents read and edit boards
through an API as easily as notebooks.

Boards should eventually replace CoCalc's whiteboard and slides, in both
sagebrush.space and cocalc-ai.

## What it is for, in order

1. **Brainstorming and research with agents.** People and agents share one
   canvas while working on a problem: a conjecture in one corner, a
   computation testing it next to it, a sketch of the argument, links to
   papers. An agent adds a computation; a person moves it next to the claim
   it supports; both see the result update when an input changes. This is
   the direction William most wants to go.
2. **Agents explaining things to people.** An agent asked "how does this
   system work?" should be able to answer with a board rather than a Mermaid
   diagram: real layout, math, live code, links into the source, and detail
   that appears as you zoom in. The person can then rearrange it, annotate
   it in ink, or ask follow-up questions about a specific box.
3. **Teaching and presentations** (the business case for CoCalc): frames as
   slides, presenter mode, ink over slides, and code on slides that reruns
   when a slider moves.

Not goals, at least at first: a general vector illustration tool, PDF
annotation, video.

## Why build it again

CoCalc's whiteboard and slides get little use. Three reasons stand out:

- **Speed.** A canvas that stutters when panning, or takes seconds to open,
  is not used for thinking. Making it fast takes many specific techniques
  (below), which are hard to retrofit.
- **Code without dependency tracking.** CoCalc's boards ran code along
  explicit edges, with no analysis and no automatic rerun, so a board's
  outputs drifted from its code. The reactive engine fixes exactly this.
- **Agents could not author them well.** Placing things by pixel
  coordinates is hard for an agent and produces ugly results. Boards need
  layout an agent can express as structure.

## Principles

1. **One package, two hosts.** The board is a framework-free TypeScript
   package with a small host interface for storage and sync, the
   interpreter, files and identity. sagebrush.space is one host and
   cocalc-ai another. Nothing in the package knows which one it runs in.
2. **Speed is a requirement with numbers.** Performance budgets (below) are
   checked by a benchmark in CI from the first commit, in Chromium and in
   WebKit (the Tauri app's web view on macOS and Linux).
3. **Structure first, coordinates second.** An agent says "these five boxes,
   connected like this, grouped like that"; the board lays them out. When a
   person drags an item, its position becomes explicit and stays where they
   put it.
4. **Same semantics as the notebook.** A code item is a notebook cell: same
   analysis, same scheduler, same stale marking, same per-cell seeds, same
   page-order scoping (with a board's reading order as the page order).
5. **Everything is an edit.** People, agents, sync and undo all produce the
   same item-level edits, so they merge the same way.

## The document

A board is a list of items plus document metadata (title, language mode,
seed, the autorun budget). Every item has an `id`, a `kind`, a position and
size in world coordinates, a stacking order, an optional parent (a frame or
group), a style, and optionally `detail` (content shown only when zoomed in).

| Kind | Holds |
|---|---|
| `note` | Markdown with math (KaTeX, as in the notebook) |
| `code` | a notebook cell: code, outputs, last run time |
| `ink` | a freehand stroke: points, pressure, color, width |
| `shape` | rectangle, ellipse, line, arrow, with optional text |
| `edge` | a connection between two items (or ports on them), with a label; stays attached when they move |
| `image` | a stored image (a blob, as notebook attachments) |
| `frame` | a region with a title; frames in order are the slides |
| `group` | items moved and laid out together |
| `ref` | a link to a file and line, a paper, or a notebook cell |

Edges are items, not drawings, so they survive moves and can be queried
("what depends on this?"). **Dataflow arrows are not stored.** They are
derived from the reactive graph and can be shown or hidden: from the code
item defining `x` to each code item reading it.

**Layout hints.** A group can carry a layout (`row`, `column`, `grid`, or
`graph` for layered graph layout of the edges among its items). Items in a
laid-out group have computed positions until a person moves one; then it
gets explicit coordinates and the rest of the layout adjusts around it. The
graph layout is a layered (Sugiyama-style) layout written for this, not a
dependency on ELK, which is about a megabyte.

**Semantic zoom.** Far out, an item shows its title. Closer, its summary.
Closest, its `detail`: the code, the full text, the links. An architecture
board can be a readable overview and a reference at once.

**Files.** The format is JSON: items keyed by id, plus metadata, saved like
a notebook (local storage, files, TimeTravel). The notebook's three-way
merge carries over unchanged in spirit, at the granularity of an item's
field rather than a cell's.

## Running code

A board is one namespace, with one interpreter, as a notebook is. The
reactive engine needs a page order for page-order scoping and for deciding
which definition a read sees. On a board:

- frames in their order come first;
- within a frame, and for items outside any frame, reading order: by rows
  from top to bottom, then left to right.

Moving a code item can change the order, exactly as moving a notebook cell
can, and the cells that now see a different definition rerun. The order can
be shown as small numbers on the code items, so it is never a mystery. The
time budget, Run stale, the stale marks and their time estimates, `verify()`
and per-cell seeds all apply unchanged. Widgets on a board are two-way, as
planned for the notebook: one model, any number of views.

## Fast

The budgets, measured in CI with synthetic boards in headless Chromium and
WebKit:

- Pan and zoom at 60 frames per second with 2,000 items and 20,000 ink
  strokes, on a mid-range laptop.
- First paint of a 2,000-item board in under 300 ms; fully interactive
  under 1 s.
- Dragging a selection of 100 items at 60 frames per second.
- Memory proportional to what is on screen, not to the board.

How:

- **One transform for the camera.** All DOM items live in one container
  whose CSS transform is the camera. Panning and zooming change one
  property and cause no layout. While the camera moves, nothing else does;
  text is re-rasterized for sharpness only after it stops.
- **Virtualization.** A spatial index (an R-tree) finds the items near the
  viewport. Only those are mounted in the DOM; others are unmounted, keeping
  their rendered content cached.
- **Levels of detail.** Far out, items are drawn on a canvas as colored
  rectangles with titles, with no DOM at all. In the middle, rendered cards
  can be cached as bitmaps. Close in, the full live DOM.
- **Canvas for ink and edges.** Strokes are smoothed when drawn, simplified
  (Ramer–Douglas–Peucker) when stored, cached as `Path2D` objects, and drawn
  into tiles cached per zoom level.
- **Input.** Coalesced pointer events, one update per animation frame;
  hit-testing through the spatial index; drags move transforms and commit to
  the document only when released.
- **Content.** KaTeX and Markdown render once per content change and are
  cached. Outputs (SVG plots, widgets) reuse the notebook's renderers.

## Agents

The board has the notebook's kind of API (`window.sagebrush.board` on
sagebrush.space, a CLI command in cocalc-ai):

- `snapshot()` and `applyEdits({ insert, set, remove })`, including layout
  hints, so an agent can write a whole board in one call;
- `render({ region | frame | item, scale }) -> PNG`, so a multimodal agent
  can look at what it made, and at what the person drew;
- `graph()`, `runAll()`, `verify()`, as for notebooks;
- `find({ text, near, kind })` to locate items.

An agent editing a live board has a visible cursor and a name, and its edits
animate into place. A person can "follow" an agent's view. Edits by agents
are ordinary edits: undoable, merged, recorded in TimeTravel.

An agent should be able to explain a codebase on a board in a few minutes:
groups for components with a `graph` layout, edges for calls and data,
`ref` items into the source, and `detail` holding the explanation for each
box.

## Teaching

- **Presenter mode:** full screen on the current frame; speaker notes and
  the next frame on a second screen; a laser pointer; ink over the slide.
- **Live slides:** code and widgets on a slide run reactively during the
  talk.
- **Export** to PDF (one page per frame) and **import** of CoCalc boards and
  slides through CoCalc's existing export (`cocalc export board` gives
  `document.json` and `pages/*/page.json`). CoCalc's code cells become
  reactive code items; their explicit edges become ordinary edges.

## Plan

0. **Spike and measure** (a few days). The renderer core: camera,
   virtualization, levels of detail, ink layer, and the CI benchmark with
   synthetic boards. Proves the budgets in Chromium and WebKit before
   anything else is built on it.
1. **Agents explain.** Notes, shapes, edges, groups with layouts, frames,
   semantic zoom, `ref` items; viewing, moving and simple editing; the agent
   API. First real test: an agent explaining Sagebrush's architecture to
   William on a board.
2. **Brainstorming.** Live code items on the reactive engine, ink, images,
   collaboration through sync, agents' presence.
3. **Teaching and cocalc-ai.** Presenter mode, PDF export, import of CoCalc
   boards and slides, the cocalc-ai host, replacing the old whiteboard and
   slides.

Before step 0, the notebook work in progress finishes: differential fuzzing
of the reactive notebook, then two-way widgets.

## Open questions

- The editor for code items: the notebook uses plain text areas; a board may
  want the same, for speed and consistency.
- Whether reading order should ever be overridden explicitly (numbered code
  items), or only by moving items.
- Sync in cocalc-ai: through its own collaborative documents or through the
  board's merge.
- The file extension (`.board`?).

## Decisions

- **Both hosts** (William, October 11): boards ultimately ship in both
  sagebrush.space and cocalc-ai, replacing CoCalc's whiteboard and slides.
- **First use case** (William, October 11): brainstorming, meaning research
  and collaboration with agents, together with agents explaining things to
  people. Teaching and presentations are the business case and come next.
