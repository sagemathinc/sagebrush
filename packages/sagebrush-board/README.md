# @sagemathinc/sagebrush-board

Sagebrush's boards as a package: a whiteboard for agents and people, mounted in
an element of a page by its **host**.
- Notes with Markdown and math, edited where they are, their text as blocks.
- Live code items, run reactively as a notebook's cells are.
- Groups, edges routed around boxes, pages, a tour, printing, TimeTravel.

sagebrush.space's board page ([web/board/page.ts](../../web/board/page.ts)) is
one host, and CoCalc is to be another. The design is in
[design/board.md](../../design/board.md).

Not published yet (`"private": true`).

## Use

```js
import { mountBoard, Images } from "@sagemathinc/sagebrush-board";

const { board, agent, destroy } = mountBoard(element, {
  store: {
    load: async () => ({ doc }),        // the document to show
    save: (doc) => keep(doc),           // after every change kept
  },
  images: new Images(),                 // pictures' bytes (this browser's IndexedDB), or your own
});
```

The element is placed and sized by the host; the board fills it. `agent`
is the board's API for agents and tests (`load`, `snapshot`, `edit`,
`run`, `outputs`, `print`, ...). `destroy()` takes the board off the
element, and its listeners off the page.

The board's parts carry no ids, so several boards can share a page with
each other and with the host's own elements. Each part is marked with
`data-sbb`, for example `[data-sbb=edit]` (the Edit button),
`[data-sbb=menu]` (the ⋯ menu) and `[data-sbb=tour]` (the tour's
caption). The stylesheet goes into the page once, as
`<style data-sbb-css>`.

## What the host gives (mount.ts `BoardHost`)

Each is optional, except `images`. What a host does not give is not offered.

| | What it is | Without it |
|---|---|---|
| `store` | where the document comes from (`load`), where edits go (`save`), and `revert` | nothing is shown until `agent.load(doc)` |
| `images` | where pictures' bytes are kept, by the SHA-256 of their content | (required) |
| `code` | the code items' engine, given the document: `(doc) => new BoardCode(base, { runner })` | code shows as text, not run |
| `math` | KaTeX: `() => import(...)`, a module with `typeset(el)` | math shows as its TeX |
| `history` | TimeTravel's versions (`BoardHistory` on a patchflow PatchStore) | no TimeTravel |
| `address` | where the page and step shown are kept (`#p2-3`) | not kept |
| `title`, `home` | the page's title; where "Sagebrush" in the top bar goes | |
| `examples` | the example boards | no Examples… |
| `exportHtml` | the board as one HTML file; with `{ python: true }`, carrying the code's engine | no Download as HTML |
| `exportPython` | whether `exportHtml` can carry the engine, and about how much more that is (`"5 MB"`) | Download as HTML doesn't offer it |

`BoardCode` is given where the notebook's files are (`sagebrush-notebook.js`, the
worker, `runner/`), or an engine's parts (`EngineParts`: how a downloaded
board gets its engine, engine.ts). Python runs in the runner (`runner: true`):
a sandboxed frame with an opaque origin, on a domain of its own. A host must
not run it anywhere that can reach the host's own credentials
(design/security.md). If the engine can't start, the board says why in its
caption.

## Also exported

- **The document:** `cleanDoc`, `canonical` (its file, `foo.board.json`), `formatError`, `layout`, and the types.
- **TimeTravel's records:** `toRecords` and `fromRecords` (a board as records
  keyed by type, page and id), `BoardHistory`, `SCHEMA`.
- **Other formats:** `boardFromText` and `fromMermaid` (JSON, Mermaid);
  `fromCocalcBoard` (a CoCalc whiteboard, one way); `fromCanvas` and
  `toCanvas` (JSON Canvas, Obsidian's `.canvas`, both ways).
- **The block Markdown editor:** `BlockEditor` (also used by the notebook's
  Markdown cells).

## For a host: `sagebrush-board/submission`

What a host needs without the board itself (web/board-host-protocol.md):

- `checkSubmission` and `decideRequest`: a reader's answers, and a request to
  decide what their own words show.
- `editState(postedText)`: a host's side of editing in its frame. It merges
  each `edit` into the board as it is now (`apply`), field by field as
  CoCalc's dbMerge3 does, and checks the result before anything is kept:
  pages, parents, cycles, orphans, edges and size. It also limits the rate
  and the work. `remote` and `reset` take the host's own changes. Its cost
  is linear in the edit and the records it touches, not in the board.
  `recordProblems` holds a whole board to the same rules.

Both entry points load with `import`, and with `require()` from CommonJS
(Node 22.12 or later: no top-level await in either).

## Versions

The board package has versions of its own. `sagebrush-board/submission`
checks what the `sagebrush` CLI's `board answers --apply` writes, so each
version names the CLI it pairs with as an optional peer dependency: 0.2.x
and 0.3.x pair with `sagebrush` 0.5.x. 0.3.0 adds `editState` and
`require()` from CommonJS.

## Build and test

```sh
bun build.mjs   # dist/index.js (one ES module, its stylesheets inside) and dist/index.d.ts
node test.mjs   # two boards mounted side by side with a host of its own, in headless Chromium
```

Bundled in `dist/index.js`:
- [marked](https://github.com/markedjs/marked) (MIT);
- [@preact/signals-core](https://github.com/preactjs/signals) (MIT).
