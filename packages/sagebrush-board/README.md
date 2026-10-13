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

## What the host gives (mount.ts `BoardHost`)

Each is optional, except `images`. What a host does not give is not offered.

| | What it is | Without it |
|---|---|---|
| `store` | where the document comes from (`load`), where edits go (`save`), and `revert` | nothing is shown until `agent.load(doc)` |
| `images` | where pictures' bytes are kept, by the SHA-256 of their content | (required) |
| `code` | the code items' engine: `() => new BoardCode(base, { runner })` | code shows as text, not run |
| `math` | KaTeX: `() => import(...)`, a module with `typeset(el)` | math shows as its TeX |
| `history` | TimeTravel's versions (`BoardHistory` on a patchflow PatchStore) | no TimeTravel |
| `address` | where the page and step shown are kept (`#p2-3`) | not kept |
| `title`, `home` | the page's title; where "Sagebrush" in the top bar goes | |
| `examples` | the example boards | no Examples… |
| `exportHtml` | the board as one HTML file | no Download as HTML |

`BoardCode` is given where the notebook's files are (`sagebrush-notebook.js`, the
worker, `runner/`). Python runs in the runner (`runner: true`): a sandboxed
frame with an opaque origin, on a domain of its own. A host must not run it
anywhere that can reach the host's own credentials (design/security.md).

## Also exported

- **The document:** `cleanDoc`, `formatError`, `layout`, and the types.
- **TimeTravel's records:** `toRecords` and `fromRecords` (a board as records
  keyed by type, page and id), `BoardHistory`, `SCHEMA`.
- **Other formats:** `boardFromText` and `fromMermaid` (JSON, Mermaid);
  `fromCocalcBoard` (a CoCalc whiteboard, one way).
- **The block Markdown editor:** `BlockEditor` (also used by the notebook's
  Markdown cells).

## Build and test

```sh
bun build.mjs   # dist/index.js (one ES module, its stylesheets inside) and dist/index.d.ts
node test.mjs   # two boards mounted side by side with a host of its own, in headless Chromium
```

Bundled in `dist/index.js`:
- [marked](https://github.com/markedjs/marked) (MIT);
- [@preact/signals-core](https://github.com/preactjs/signals) (MIT).
