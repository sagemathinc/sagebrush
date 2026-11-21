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
