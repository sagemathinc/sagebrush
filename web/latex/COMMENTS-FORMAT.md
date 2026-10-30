# Comments on a LaTeX document: the file format

The comments of `paper.tex` are kept beside it, in the same folder, in **`paper.tex.comments.json`**. People write
them in the LaTeX editor; agents read and write them with the command-line tool (`scripts/latex-comments.mjs`) or,
paired with a person's page, with the `latex_comments_*` MCP tools. All of them use one module,
`web/latex/comments-core.mjs`, so they agree on the format, the merge, the anchors and the limits.

## For an agent

1. `list` the comments (open ones; `--all` adds the resolved). Each has an `id`, a `status`, the quoted text, its
   `range` (line and column, 1-based) and the lines around it.
2. Edit the `.tex` with ordinary writes.
3. `reply` with what you changed, then `resolve`.
4. Never rewrite the comments file yourself: use the commands. They merge with anyone writing at the same time.

A thread whose status is `ambiguous` has its `candidates` (the places its text now occurs): `reattach` it with
`--occurrence n`, or with a `--quote` or `--range`. One whose status is `orphaned` is on text that was removed.

## Version 1

```json
{
  "format": "sagebrush-latex-comments",
  "version": 1,
  "file": { "fid": "…", "path": "/papers/paper.tex" },
  "threads": [
    {
      "id": "t_…",
      "created": "2026-10-29T20:00:00.000Z",
      "anchor":   { "value": { "start": 120, "end": 151, "textSha": "…", "quote": "…", "prefix": "…", "suffix": "…" }, "rev": 0, "time": "…", "by": "person:me", "op": "o_…" },
      "resolved": { "value": false, "rev": 0, "time": "…", "by": "person:me", "op": "o_…" },
      "deleted":  { "value": false, "rev": 0, "time": "…", "by": "person:me", "op": "o_…" },
      "messages": [
        { "id": "m_…", "author": "person:me", "time": "…",
          "text":    { "value": "Why is this obvious?", "rev": 0, "time": "…", "by": "person:me", "op": "o_…" },
          "deleted": { "value": false, "rev": 0, "time": "…", "by": "person:me", "op": "o_…" } }
      ]
    }
  ]
}
```

- A reader must refuse a `version` it doesn't know.
- Offsets are JavaScript string indices (UTF-16 code units) into the `.tex` text.
- Authors are `person:<name>` or `agent:<name>`; an agent's messages are shown with an "agent" label.

**Anchors.** `start` and `end` are offsets in the text whose SHA-256 (of its UTF-8 bytes) is `textSha`. `quote` is the
span (up to 600 units), or for a longer one its first 300 units with `tail` (its last 300), `length` and `sha` (the
span's SHA-256). `prefix` and `suffix` are up to 32 units on either side. `shown` (optional) is what was selected in the
preview when that differs from the source (rendered math).

Re-finding an anchor in the text as it is now:

| Status | When |
|---|---|
| `exact` | `textSha` is the text's: the offsets as they are |
| `moved` | the quote occurs once, or once with its prefix and suffix as well |
| `changed` | the quote is gone, and exactly one prefix … suffix pair, less than 2,000 units apart, has text between them: that text ("the commented text was rewritten") |
| `ambiguous` | more than one occurrence or pair fits (listed as `candidates`, attached to none), or over 64 |
| `orphaned` | none of the above, or only white space left between prefix and suffix: the text was removed |
| `unresolved` | the work budget (64 Mi units per operation) ran out first |

**Registers and the merge.** Every field that changes is a register `{value, rev, time, by, op}`; `op` is a fresh
random id for each write. Two copies merge record by record (threads and messages by `id`: their union) and register by
register: the greatest `(rev, time, by, op)` wins, then the value's JSON, so every copy agrees whatever the order. A
write sets `rev` to one more than the register it read. Deleting writes a tombstone (`deleted: true`) and blanks the
texts with a higher `rev`, so a stale copy can't bring them back; records are never removed.

**Limits.** At most 2 MiB a file; a new thread only while the file is at most 1.75 MiB; 2,000 live threads and 4,000
in all; 200 messages and 256 KiB (encoded) a thread; 8,000 units a message; 100 an author. A write over a limit is
refused and nothing is written.

## Who arbitrates writes

There are two stores, and each has one arbitrator:

- **A Sagebrush workspace** (the files in a person's browser: the editor, and the MCP tools through the paired page):
  every write is a compare-and-swap on the file's revision (`write` with `base`); a writer that loses re-reads, merges
  and tries again (conflicts only, 5 attempts within 10 s).
- **A folder on disk** (the command-line tool on a checkout): writers take the lock file
  `paper.tex.comments.json.lock` (exclusive create, never broken automatically), write a temporary file, check that the
  comments file didn't change, and rename it into place.

The two stores are separate: nothing writes the same physical file through both. Copying a comments file from one to
the other is an ordinary copy, not a concurrent writer; the merge rules above are what make two copies combinable.
