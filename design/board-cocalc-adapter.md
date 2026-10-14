# A board in CoCalc: the store adapter

**Status:** prototype (October 14, 2026). `web/board/syncdb.ts` and its
tests (`web/board/test-syncdb.mjs`) are in this repo; nothing in the page
uses them, and nothing in cocalc-ai has changed. A recommendation for
William is at the end.

In CoCalc a board's live document is a syncdb holding the records of
`web/board/history.ts` (keyed by `type`, `page`, `id`; the text fields are
string columns), as a notebook's is. The project loads `foo.board.json`
into it and writes it back (`~/notes/board-plan/board-in-cocalc.md`). This
note is about the browser's side: how the board's edits reach that syncdb,
and how its changes reach the board.

## The mismatch

`cached.ts`'s `cachedStore` was written for a remote that keeps **whole
documents**: it reads one, and saves one over it only if it is still the
version it read (compare-and-swap). When the save is refused, the store
merges (its own `merge3`) and tries again.

A syncdb does not swap documents. It **merges patches**: each replica
commits patches, and concurrent ones are merged record by record by
CoCalc's `dbMerge3` (`@cocalc/sync/editor/db/merge3.ts`):

- a field changed on one side takes that change; changed on both, string
  columns merge as text (both people's typing kept), maps key by key, and
  any other value takes the later side;
- a record deleted on one side and edited on the other stays deleted,
  unless the edit changed its text: then the edited record is kept whole
  (never a partial record).

Put `cachedStore` on a syncdb and there are **two merges with different
rules**:

| | between browsers | between this board and its own replica |
|---|---|---|
| who merges | the syncdb (`dbMerge3`) | the store (`cached.ts merge3`), when a compare-and-swap is refused |
| both changed one text field | both typings kept | ours kept whole, theirs dropped |
| deleted there, moved here | deleted | brought back, moved |

Which rule applies depends on timing: whether the other person's patch
reached this browser's replica before or after the board's edit was
written. The tests show both outcomes (`bun web/board/test-syncdb.mjs`
prints them):

- two browsers typing in one note at once: both kept, by either design,
  when each edit reaches its replica first;
- the same, but the other's typing arrives just as this board types (it
  was not yet shown): with `cachedStore`, **the other's typing is lost**
  (`"hello brave world"`; the syncdb alone gives `"hello brave world!"`);
- a delete from elsewhere arriving just as this board moves the note: with
  `cachedStore`, **the note comes back**; the syncdb alone keeps it deleted.

**Double merging.** Running both does not apply a change twice: the store
writes whole states, so what reaches the syncdb is the difference between
the replica as it is and the store's merged document. But that difference
is computed from the store's merge, so wherever the two rules disagree,
the store's result is written over the syncdb's: deleted records come
back, and text the syncdb had merged is replaced. That is the
resurrection the table shows; it is not rare, it is any edit made in the
moment between a patch arriving and the board showing it.

## The two designs, as built

Both are in `web/board/syncdb.ts`, written against `SyncDbLike`: the five
SyncDB methods the board needs, by CoCalc's names (`to_str`,
`from_str(value, {base})`, `commit`, `on("change")`, `wait_until_ready`).

**A. The syncdb as `cachedStore`'s remote** (`syncdbRemote(db)`).
`save(doc, expected)` reads this browser's replica, hashes it and, if it is
`expected`, sets the document and commits, with no other step in between,
so it is a true compare-and-swap on the replica. Everything in `cached.ts`
applies unchanged: the copy, the merge, backoff, busy, page-id migration.
The cost is the table above.

**B. The syncdb as the merge** (`syncdbStore(db, key, cache)`). Each edit
is written as what it changed: `from_str(edited, {base: the document it
was made from})` and `commit()`. That is CoCalc's own way for an editor
to write into a syncdb (`SyncDoc.from_str` with a base, rebased by
`dbMerge3` onto whatever the replica has). So there is **one merge, the
syncdb's**, for every case. A change from elsewhere is shown as the syncdb
has it. No hashes, no compare-and-swap, no retries, no busy state.

This browser's IndexedDB copy stays, for two things only:

- **the first paint**: `load()` returns the copy at once, before the
  syncdb is open; once it is, its document is shown if it differs (once);
- **edits made before the syncdb is open**: kept in the copy with the
  syncdb's document they were made from (`base`), and written with
  `from_str(copy, {base})` once it opens, merged like any edit.

Page ids: in B, the project gives pages ids (`identified()`) when it loads
the file into the syncdb, before any browser sees it. The project is the
only writer at that moment, so there is no race and no compare-and-swap.

## Tests

`web/board/test-syncdb.mjs` (bun, deterministic). The syncdb is real
patchflow (`Session`, the records codec) with a records `merge3` written
from `dbMerge3`'s documented rules (not its code). Each browser's replica
is joined to the others by an in-memory transport whose delivery to it
can be held.

- Both designs:
  - two browsers editing different notes at once;
  - two browsers typing in one note at once;
  - one deleting a note as the other moves it (deleted), and as the other
    types in it (kept whole, with the typing);
  - the two arriving cases above (strict for B; for A, convergence, with
    the outcome reported).
- B only:
  - the copy shown before the syncdb is open, then the syncdb's document,
    once;
  - an edit made before it opens, with a change elsewhere meanwhile: both;
  - the same field changed both ways: the change elsewhere (the later
    side, CoCalc's rule);
  - an agent rewriting the file while a browser moves another note: both.

The fake `merge3` is an approximation of `dbMerge3`. The final check
belongs in cocalc-ai, against the real SyncDB.

## Recommendation, for William

**B: in CoCalc, the syncdb is the merge, and this browser's copy is only
for the first paint and for edits made before the syncdb opens.**

- One set of rules everywhere: what two people see when they edit at once
  is the same as in a notebook, a task list or a chat, and the same
  however the timing falls.
- Concurrent typing is never lost, and a deleted note never comes back
  because of a move.
- Less to run: no compare-and-swap, backoff or busy state in the CoCalc
  path, and the page-id migration happens once, in the project.

`cachedStore` (A) stays for hosts whose remote keeps whole documents
(a plain file or object store, perhaps sagebrush.space later). There,
compare-and-swap plus `merge3` is the only option.

What B gives up, for William to accept or not:

- No "changed elsewhere, merged" caption on the board: the syncdb merges
  without saying so.
- An edit made offline and a change made elsewhere to the same non-text
  field (both moved one note): the change elsewhere wins (CoCalc's "later
  side"), where `cachedStore` keeps ours and says so.
- A host-side requirement: CoCalc's adapter must expose `from_str` with a
  base. SyncDoc already has it; the board's frame editor just has to use it.
