# Stateless per-change size check

The `size-gate` job is a backstop, not a per-PR approval lane. Before each merge,
the merger reads every row of the PR's own CI size table and questions any large
single-PR jump, even below the backstop. A green CI result stands when master or
a track advances: do not merge the target into a PR just to remeasure size.
Resolve actual overlapping changes or conflicts normally.

## Rule

For each existing bundle, CI compares base and tested-merge bytes. It fails when growth
exceeds **both 2% of that bundle's base and 50,000 bytes**:

```js
delta > Math.max(Math.floor(base / 50), 50_000)
```

The exact boundary passes. These are decimal KB, not KiB. The absolute allowance
avoids noisy percentage failures on small bundles; the percentage allowance
scales with large bundles. This deliberately permissive check catches big
regressions while the merger's row-by-row checklist catches smaller ones.
Bundles are checked individually: a shrink never offsets another bundle's
growth. Bundles absent from the base are listed as `new`, with base zero, but
do not fail the backstop: extracting a lazy chunk must not count its entire
size as growth. New bundles still require review in the merger's checklist.
An existing bundle with zero bytes is still gated. Removed bundles use merge zero.

### The examples gallery's content

The backstop above is for code. The examples gallery's content has its own
per-change limit: growth over **256,000 bytes** fails, whatever the base, and
the exact boundary passes. That content is in three bundles:

- `examples/corpus`, the corpus under `examples/`;
- `site/examples`, what the site serves of it under `/examples/`;
- `examples/index.json`, the catalog.

The site fetches it only when someone opens the gallery
(`web/examples/open.ts`). It's in neither of the service worker's lists, nor
the CLI. Holding a gallery to a code allowance would only push it into split PRs.

Two notes on the bundles:

- **The first-visit notebooks are the exception.** `web/build.ts` inlines the
  notebooks `web/examples/welcome.ts` names into every bundle, so they're in the
  initial download. They're measured as their own bundle, `examples/welcome`, and
  keep the code backstop. The measurement reads the list from `welcome.ts`, and
  fails if it can't.
- **The desktop app** builds the gallery into its installer
  (`app/build-examples.ts`). This gate doesn't measure the installer, so the
  content limit lets the installer grow by up to the same 256,000 bytes per change.
  For an installer of tens of MB, that was accepted.

### Track pulls

A track's pull into master (`track/math`, `track/numeric`, ...) sums every pull
request that landed on the track, and each of those already passed this
backstop against the track. So a pull request with the **`track-pull`** label
is measured and reported as usual, but growth over the backstop doesn't fail
it: the step prints a warning, and the merger reads every row of the table
before merging. Only growth is excused: missing or mismatched records, another
recipe or toolchain still fail closed. In the merge
queue the label is read from the queued pull request (`gh-readonly-queue/.../pr-N-...`),
so a track pull goes into the queue alone. Only the merger applies the label,
only to a track's pull into master (decided by William, Nov 22 2026).

### Master merges into a track

The other direction: a change into a track (a pull request, a queue entry or a
push onto `track/*`) that merges master in brings every master pull request
since the track's last sync, and each of those already passed this backstop on
master. So such a change is also measured against the master commit it merges
(its "side": the merge-base of the tested commit and `origin/master`, when the
track's base doesn't already contain it), and a bundle fails only when its
growth is over the limit against **both** the track's base and that master
commit. A byte present in either parent was gated where it landed. A bundle the
master side doesn't have is the track's own, gated against the base alone.
The size-base job builds and records the side (`side-record.json`) beside the
base, under the same recipe and pins; a missing or mismatched side record fails
closed, as a base record does. A change into a track that brings no new master
commits has no side and is gated as before. (Ruling by @sagebrush, Nov 26 2026,
after a master sync into `track/numeric` carried 85 master pull requests' growth
as one transition.)

There are no stored budgets, growth markers, tightness rules, epochs, or
old-toolchain migration builds. No allowance is carried forward or refilled.

## Measurement and CI

CI builds the event's base and tested merge with pinned Bun 1.4.4 and Node
24.21.0. Both records use the current run's measurement script. It preserves
the existing bundle census and normalization: checkout paths and the known
VERSION/BUILD_ID assignments only. Each expected assignment count is checked.
Records bind the repository, commit, tree, recipe hash, toolchain, event, run,
attempt and producer job. Missing, malformed, oversized or mismatched records
fail closed. The job summary contains every bundle's base, merge, delta and
limit; the JSON records and result remain downloadable CI artifacts.

For a PR, the base is the tested merge's first parent, and the second parent
must be the PR head. Merge queues use their tested base; pushes use the event's
`before` commit. A manual branch run compares with its merge-base with master,
without requiring an update from master. Runs without a base report absolute
sizes only. The classifier can skip builds only for changes with no measured
or gate inputs; failed or skipped required measurement jobs fail closed.

The independent browser/LaTeX caps, heap checks, offline caps, and optional
package-leak checks are unchanged. The legacy `size-budget.json` total census
remains report-only; it is not this gate's baseline.

## Merger checklist

1. Verify the PR's own CI is green, including `size-gate`.
2. Read every bundle row, including added and removed bundles.
3. Question a large or surprising single-PR jump, even if the backstop passes.
4. Do not request a size remeasure merely because master or a track moved.

## Local tests

```sh
node scripts/test-size-measure.mjs
node scripts/test-size-advice.mjs
node scripts/test-npm-pack-metrics.mjs
```
