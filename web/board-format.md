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

## Fields

### The document

| field | meaning |
|---|---|
| `format`, `version` | `"sagebrush-board"`, `1` (write them first) |
| `title` | the board's title (plain text) |
| `mode` | `python` (default), `sage`, `magma`, `matlab` |
| `intro` | Markdown shown before the tour starts |
| `layout`, `columns`, `direction` | how the top-level items are laid out (defaults: `graph`, square, `TB`) |
| `nodes`, `edges`, `steps` | the items, the edges, the tour (a one-page board) |
| `pages` | several pages (below); a document with pages has no `nodes`, `edges` or `steps` of its own |
| `images` | pictures by name: `{w, h, src}` (pixels; `src` a `data:` or `https:` URL) |
| `refBase` | the base URL for `ref` links that are paths (e.g. a repository's blob URL) |
| `seed` | 64 hex digits: the seed of the code's random numbers; without it a fixed default is used, so a board's random numbers are always repeatable |
| `slide`, `background` | as for a page |
| `engine` | `"latest"` only, in a downloaded file: run with the newest engine when online (written by Sagebrush) |
| `tools` | the toolbar's tools in Edit mode, in order (written by Sagebrush) |

### A page (in `pages`)

| field | meaning |
|---|---|
| `id` | needed by templates; unique among the pages |
| `title` | the page's title (plain text) |
| `intro` | Markdown shown before the page's tour |
| `layout`, `columns`, `direction` | as for the document |
| `nodes`, `edges`, `steps` | the page's items, edges and tour |
| `slide` | `{x, y, w, h}`: the card the page is arranged on (board coordinates); Present shows it |
| `background` | `{color, image}`: a color, or a picture's name in `images` (on a slide's card) |
| `template` | `true`: other pages can be made from this one (it needs an `id`) |
| `uses` | the id of a template page: its card, background and items appear under this page's own |

### A note (the default item)

| field | meaning |
|---|---|
| `id` | required |
| `title` | a heading (math allowed) |
| `text` | Markdown with math, shown at every zoom |
| `code` | code in the board's language; makes the note a code item |
| `hideCode` | show only the output |
| `detail` | Markdown shown only when zoomed in |
| `ref` | a link: a URL, a paper, or a path (`src/file.py#L10`) resolved against `refBase` |
| `image` | a picture's name in `images` |
| `color` | a color |
| `shape` | `rect`, `round`, `stadium`, `circle`, `diamond`, `hexagon`, `cylinder`, `subroutine`, `lean-right`, `lean-left`, `trapezoid`, `inv-trapezoid`, `flag` |
| `fit` | as wide as its text needs, up to `w` |
| `w`, `h` | its width (default 260, or 440 for a code item) and height |
| `x`, `y` | its position, kept once a person moves it; leave them out |
| `preview` | a slow item's saved output, shown before it runs (written by Sagebrush) |

### A group

| field | meaning |
|---|---|
| `id`, `kind: "group"` | required |
| `title`, `text` | a heading (math allowed) and Markdown |
| `layout`, `columns`, `direction` | how its children are laid out |
| `children` | its items (groups nest) |
| `color` | a color |
| `x`, `y` | its position, kept once a person moves it |

An edge may join any two items on a page, in any groups.

### An edge

`{"from": id, "to": id, "label", "arrow": "none" | "both", "line": "dotted" | "thick", "hidden"}`.
The arrowhead is at the end unless `arrow` says otherwise. A `hidden` edge
only guides the layout.

### A tour step

`{"focus": id or [ids], "say": "Markdown"}`. The camera shows the items while
the caption explains them.

### Stickers and ink

- A sticker: `{"id", "kind": "sticker", "emoji"}` (one emoji) or `"icon"` (one
  of CoCalc's icons, by name) with `color`; `w` (default 64), `x`, `y`.
- Ink: `{"id", "kind": "ink", "points", "size", "color", "opacity", "x", "y"}`,
  pen strokes drawn by people. Don't write these.

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
