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

### Painting (E5.5)

The output is painted in slices, and the browser lays out only what is new and on screen:

- **The first slice is small** (8 KiB, 200 runs, 4 ms), and a frame is painted right after it. So a command's first output shows within a frame.
- **Frames are paced.** Up to 12 ms of slices run, then a frame is painted.
- **No slice forces a layout.** The view follows the output once per frame, inside the frame, as long as the person hasn't scrolled away from where it last put it.
- **An empty slice paints nothing.** While stderr's reservation is scanned in slices, the first output keeps the first slice's budget and its first-paint measure (DB2-LL-337-4).
- **A hidden tab paints no frames.** Its slices only yield, and a frame awaited when the tab hides ends after 100 ms.
- **Chunks:** once more than the first slice's 8 KiB of input has been read before a line is flushed, a slice's lines go in chunks (`.sb-term-chunk`, the same inline-block box as a page), each started at a line start every 8 Ki units, with a run counting 16. Output of at most 8 KiB never gets a chunk, so ordinary output is laid out and exposed as plain lines (board's R4-1). Each chunk is charged as a run, and a line not yet paged is held to the next slice, so slices start at line starts.
- **Run limit per page:** a page holds at most 512 runs, so a page of one-character styled runs lays out quickly. The join still goes through the same cluster rules.
- **Off-screen layout is skipped:** pages and chunks have `content-visibility: auto`. Their text stays in the DOM, so selection, copy and find still see it (Chromium 149: `window.find` and select-all copy reach an off-screen page). Without it, C2's last paint goes back to about 1 s and C2 and C3 show Long Tasks.

### Size

E5.6's limit for the panel's code is 9 728 B gzipped, measured with bun 1.4.4 (CI's pin). daybreak2 raised it three times:

- **From 9 216 B to 9 344 B on #337 r3** (DB2-LL-337-3), for one reason: "DB2-LL-337-2 exact UAX regional-indicator parity across retained windows, plus scalar-safe slice hold."
- **To 9 600 B on #337 r4**, for the E5.5 batching: the first slice and frame pacing, chunk runs, PAGE_RUNS and content-visibility. bun 1.4.4 measured 9 585 B, +304 over r3b.
- **To 9 728 B on #358** (DB2-T358-3), for the first-open notice: the static, non-live line, named by the input's `aria-describedby`, that says what commands do to your files. It is required safety context for the terminal on every host. bun 1.4.4 measured 9 667 B, +68; the notice's text is in `terminal.ts`, outside E5.6's inputs.

### Caps

E5.4's caps are unchanged: at most 1 MiB shown per command and 4 MiB in the scrollback.

### Recorded limits (B-LL-5)

- **Copy:** select-all copies a paged line as one line, with no break at a join. This is tested in Chromium and in CI's WebKit job; Firefox is not tested.
- **Find in page:** the browser's find (Ctrl-F) does **not** match text that straddles a join. A join comes once per 4 096 units, and only on such long lines. Text within a page is found. Recorded in Chromium 149 with `window.find`.
- **Assistive technology:** the accessibility tree exposes a paged line as one text node per page, in order, for the pages and chunks on screen. Off-screen pages and chunks (`content-visibility: auto`) are **not** in Chromium 149's accessibility tree until they are scrolled near the view. That affects only long lines and output past its first 8 KiB; ordinary output has neither. The log is not a live region (each command's status is announced). No screen reader has been run.
