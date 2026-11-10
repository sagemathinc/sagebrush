# Where you were in a document (per-file view state)

Status: r2 (astra's SEC review of #964: the shape checked on read and write; many tabs best effort), r1 approved by @sagebrush on 2026-11-10 (William's H7, generalized: "this is a general problem for other editors too, e.g., notebook, maybe the whiteboard position and scroll and page, the pdf preview").

When you go from a document to another one and back, reload it, or open it in a new tab, you are where you were.

## One mechanism: `web/workspace/view-state.ts`

Opening another document loads a new page (`location.assign`), so memory can't carry the view. It is kept in localStorage instead, under the document's key.

- **Per browser, never synced, never sent anywhere.** A scroll position depends on the window, so another device's would be wrong. Nothing goes in the workspace: no IndexedDB, Web Lock or sync row.
- **Ids and numbers only, never content, checked on every write and every read.** The key is `<kind>:<id>`; a rename keeps the id (a notebook's or board's ref, a tex file's fid).
  - The kind is notebook, board or tex.
  - An id matches `[\w.:-]{1,64}`.
  - A view is an object of at most 16 fields, named `[A-Za-z][A-Za-z0-9_]{0,31}`. Each field is a finite number, an id, or such an object again, at most 3 deep.
- **Bounded.**
  - At most 200 documents; the least recently kept is dropped first.
  - Each view's JSON is at most 512 characters.
  - A view or key outside these limits isn't kept. An entry already there that breaks them (malformed, oversize, misnamed: another version's, or written by hand) is dropped on read. It is never returned, and a save doesn't keep it.
- **Many tabs: best effort.** Each save reads what's there, changes one document's view and writes it back, so a view another tab wrote earlier is kept. localStorage has no transactions, though: two tabs saving at the same moment aren't coordinated, and one tab's change can be lost. The result is a view not kept, never a wrong one. That is acceptable for a scroll position, so there's no Web Lock and no sync.

```ts
savedView(key): View | null
saveView(key, view)
keepView(key, read) -> { changed(), stop() }   // a save 500 ms after changed(), at pagehide or when hidden, and at stop()
viewToRestore(key, el, skip) -> () => View | null
```

## Each editor owns its fields; the shell owns none

| Editor | Fields |
|---|---|
| notebook | `cell` (the top cell's id) + `dy` (the offset in it), so reflowing output can't drift it; `frac` as a fallback |
| tex | `src` {line, sel}, `preview` {anchor, frac}, `pdf` {page, zoom} |
| board | `x`, `y`, `zoom`, `page` |

## The restore rules, the same for every editor

1. **Once,** after the editor's first layout of the document's content.
2. **The person wins.** A scroll, key, click or touch in the editor before the restore cancels it, so the page never jumps.
3. **A target in the URL wins** (a cell anchor, a page): the kept view isn't applied.
4. **Something gone** (a deleted cell, a page): the editor falls back to `frac`, else the top. Never an error.
5. **Agents: nothing.** Not in the API, MCP or llms.txt. Agents see documents, not viewports.

## Tests

- **`web/workspace/test-view-state.mjs`:** the module alone (the bounds and the shape on write and read, another tab's earlier save kept, when it saves, the restore rules).
- **`web/workspace/view-state-check.mjs`:** the rows every adopting editor runs on its own page. Back from another document, a reload, a new tab, the view never given to another document, a URL target winning.
- **`web/workspace/test-view-state-page.mjs`:** those rows in Chrome on a stand-in editor, plus the person winning over a late restore.

## Adoption

One small PR each: the board, the notebook, and the LaTeX editor (tex and the PDF preview). The LaTeX editor's PR waits for the PR that makes room in the LaTeX page's eager bundle. An editor that adopts pays the module's bytes in its own bundle, measured in its PR.
