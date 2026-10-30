# The terminal panel: long lines

The terminal panel (`web/shell/panel.ts`, plan-bash-shell r8c step 6) is a preview behind its host gate.

## Long lines in pages

A shown line longer than `PAGE` (4 096 UTF-16 code units) is laid out in pages. The first page is inline; each later page is an `inline-block` box of full width (`.sb-term-page`). Layout cost then grows with the number of pages, not with the line's length. Lines of 4 096 units or less have no page element.

### Where a page starts

- **Always at a scalar boundary**, never inside a surrogate pair.
- **At a grapheme-cluster boundary** (UAX #29, through `Intl.Segmenter`: combining marks, ZWJ sequences, variation selectors, emoji modifiers, flags, Hangul syllables).
  - A join moves back at most `PAGE_BACK` (64) code units to the start of the cluster that crosses the edge.
  - A cluster that already starts at the page's own start needs no move.
- **A cluster longer than 64 units is split at the edge** (or one unit before, so a surrogate pair stays whole). This is the defined behaviour; only pathological input, such as long stacks of combining marks, reaches it.
- **Slicing doesn't change the result.** The join is decided on the logical line: at a slice's end, the units near the next edge are held back, so the pages are the same at any slicing.

This is @sagebrush's ruling on DB2-LL-337-1, with board's CONCUR; it replaces B-LL-1's "never split a cluster".

### Charging

- Each page box is charged as a run.
- A styled run that crosses a join becomes two runs with the same classes, each charged.
- The line end after the last page box is charged too.

E5.4's caps are unchanged: at most 1 MiB shown per command and 4 MiB in the scrollback.

### Recorded limits (B-LL-5)

- **Copy:** select-all copies a paged line as one line, with no break at a join. This is tested in Chromium and in CI's WebKit job; Firefox is not tested.
- **Find in page:** the browser's find (Ctrl-F) does **not** match text that straddles a join. A join comes once per 4 096 units, and only on such long lines. Text within a page is found. Recorded in Chromium 149 with `window.find`.
- **Assistive technology:** the accessibility tree exposes a paged line as one text node per page, in order. The log is not a live region. No screen reader has been run.
