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
- **One language per board.** `"mode"` is `"python"` (the default), `"sage"`,
  `"magma"` or `"matlab"`. Every code item uses it. See "Languages" in
  https://sagebrush.space/llms.txt.
- **Code is reactive.** A note with `code` is a code item. Its output is shown
  under it, and items that use a name it defines rerun when it changes, as in
  a reactive notebook. Code runs in the reader's browser, in a sandbox with no
  network, so keep each item quick.
- **Math** is `$...$` and `$$...$$` (KaTeX) in `text`, `detail`, `intro` and
  `say`, and in the titles of notes and groups (not in the board's or a page's
  `title`, which are plain text). In JSON, write a backslash as `\\`.
- **Pictures** live in the top-level `images` object:
  `"images": {"fig1": {"w": 800, "h": 600, "src": "data:image/png;base64,..."}}`,
  and a note shows one with `"image": "fig1"`. `src` may be a raster `data:` URL
  or an `https:` address; a board you hand to someone else should use `data:`
  URLs, so it is complete in one file. Keep a board under 16 MiB.
- **Pages and slides.** For several pages, put `nodes`, `edges` and `steps` in
  each entry of `"pages": [...]` instead of the top level. A page with a
  `slide` rectangle (16:9, say) is a slide, and Present shows it.

<!-- fields: written by scripts/board-format-fields.mjs from the doc comments of web/board/doc.ts; edit those, not this -->
## Fields

Each kind of thing in a board, its fields, their types and what they mean. A type in words (item, edge, page, ...) is the section of that name; `[x]` is a list of them, `{name: x}` an object of them by name.

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
| `images` | {name: picture} | pictures by name: `{w, h, src}` (pixels; `src` a `data:` or `https:` URL) |
| `pages` | [page] | several pages; a document with pages has no `nodes`, `edges` or `steps` of its own |
| `intro` | string | Markdown shown before the tour starts |
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
| `intro` | string | Markdown shown before the page's tour |
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
| `image` | string | a picture: its name in the document's `images` |
| `text` | string | Markdown with math (`$...$`), shown at every zoom |
| `code` | string | code in the board's language (`mode`), run in the reader's browser, its output under it; it makes the note a code item |
| `hideCode` | boolean | `true`: show only the code's output, not the code |
| `preview` | preview | a slow code item's output, kept to show before it runs (written by Sagebrush) |
| `detail` | string | Markdown shown only when zoomed in |
| `ref` | string | a link: a URL, a paper, or a path (`src/file.py#L10`) resolved against `refBase` |
| `color` | string | a color (`#e8f0fb`, a CSS color name, `rgb(...)`, `hsl(...)`) |
| `shape` | `"rect"` \| `"round"` \| `"stadium"` \| `"circle"` \| `"diamond"` \| `"hexagon"` \| `"cylinder"` \| `"subroutine"` \| `"lean-right"` \| `"lean-left"` \| `"trapezoid"` \| `"inv-trapezoid"` \| `"flag"` | its outline (a flowchart's); its text is then centered |
| `fit` | boolean | `true`: as wide as its text needs, up to `w` |
| `x` | number | its position, kept once a person moves it: leave it out, and the board places it |
| `y` | number | as `x` |
| `w` | number | its width (default 260, or 440 for a code item) |
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
| `image` | string | a picture's name in `images`, on a slide's card |

### A picture (in `images`)

A picture a note shows, by its name in the document's `images`.

| field | type | meaning |
|---|---|---|
| `w` | number | required: its width in pixels |
| `h` | number | required: its height in pixels |
| `src` | string | its bytes: a `data:` URL (PNG, JPEG, GIF or WebP), or an `https:` address |

<!-- /fields -->

## Checking a board before you hand it over

1. Run every code item with the command line, in the board's language, for
   example `npx sagebrush@0.3.2 --sage -c 'factor(2^32+1)'`. An unimplemented
   function raises an error, so code that runs is supported. (0.3.2 has no
   MATLAB yet.)
2. Search before you guess: `npx sagebrush@0.3.2 --search "elliptic curve rank"`.
3. Open the board at https://sagebrush.space/board/ to see the layout.

## What's new

- **2026-10-14:**
  - `"mode": "magma"` and `"mode": "matlab"`;
  - template pages (`template`, `uses`) and stickers;
  - the board can be embedded at `/frame/board/` (sent by `postMessage`).
- **2026-10-13:**
  - the `format`/`version` header;
  - any note can have `code` (`kind: "code"` is still read) and `hideCode`;
  - pictures (`images`).
- **2026-10-12:** pages and slides (`pages`, `slide`), and shapes for flowcharts (`shape`).
