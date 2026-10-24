# The core's growth gate

The design is `plan-growth-budget-r6`: r5 was approved (astra CLEAR on r5, daybreak2 CLEAR on r4), and r6 changes only the bootstrap cross-check (§1.2); astra CLEAR on r6. This page is the working summary. Where the two differ, the plan wins.

## What it guards

1. **No core growth without review.** Every byte a core artifact grows needs a reviewed marker in `.growth/`, beyond a configured jitter allowance. The jitter allowance is **0** today.
2. **An optional package never grows the core.** `cli/packages.gen.js` and the registry's package count are *exact*: they may only shrink, except through a reviewed raise of their `max`. `size-budget.mjs --check` still fails on any optional package's name in a core artifact.

## Files

| File | What it holds |
|---|---|
| `budgets.json` | Every size threshold, per bundle:<br>- an ordinary bundle: `ceiling`, `noise_bytes`, `noise_total`, `marker_slack`;<br>- an exact bundle: `max`.<br>Also the epoch, `{sizes, reset}`, and the bun pin. |
| `.growth/<name>.json` | A reviewed growth marker: `{"v":1, "reason":"…", "bytes":{"<bundle>": <bytes>}}`. |
| `scripts/size-measure.mjs` | The measurement and the rules. Its sha256 is part of every record's comparability key. |
| `heap-budget.json` | The heap thresholds and the node pin (unchanged). |

`size-measure.mjs`'s `LIMITS` caps the gate's own inputs before they are read in full or parsed:
- bytes per record, per budgets file and per marker;
- the number of markers and their total bytes;
- string and collection sizes.

These are input-envelope limits, not size thresholds.

## The rules, per integration (a PR's merge commit against its exact first parent)

- **Growth (Δ > `noise_bytes`) needs markers added by this PR,** in its diff against the tested base.
  - The markers must cover Δ, and be tight: their sum must be at most Δ + `marker_slack`, which is 1 KiB.
  - An existing marker can't be edited; add a new one.
- **The ledger:** size ≤ epoch + every marker in the tree + `noise_total`. It doesn't reset per PR. Deleting a marker only tightens it.
- **The ceiling:** size ≤ `ceiling`, a rare reviewed hard cap, at most the epoch + 10% when seeded.
- **An exact bundle:** Δ ≤ 0, unless the same PR raises its `max`.
- **An epoch reset** (a release, a bun/node or measurement move, a bundle rename or removal):
  - `node scripts/size-measure.mjs --epoch --records <this PR's CI records> --reason "…"` writes `epoch.reset`, with `prev`, the sha256 of the base's epoch block, and deletes `.growth/`;
  - its growth is one charge per group, $\max(0, \Delta^T) + \max(0, \Delta^I)$, and must be tight in the same way.

### Adding a marker

Create `.growth/<yyyy-mm-dd>-<topic>.json` with the bytes that the PR's `size-gate` job summary reports. The marker is reviewed with the PR.

## CI (ci.yml)

- **`checks`** writes the merge's size record and uploads it as `sizes-<sha>`.
- **`size-base`** gets the tested base's record:
  - its push record, if one is usable;
  - otherwise it rebuilds the base once, in its own worktree, with bounded steps;
  - for a key-moving reset, it also measures the base under its own old key.
- **`size-gate`** applies the rules. It is the single check that decides core growth, and it **fails closed**. A change touching no measured input and no gate input passes it as docs-only.

## Merging (plan §3)

- **One writer:** @sagebrush is the only writer of master.
- **Merge commits only:** every integration is a two-parent merge commit on exactly the base its `size-gate` result tested. Its tree must equal the tested tree.
- **The push:** it is pushed with `git push --force-with-lease=refs/heads/master:<base>`. A plain non-force push is not a base compare-and-swap.

## William's decisions (Oct 23 2026, about 11:50 PM PDT, relayed by @sagebrush)

1. **The policy:** "Approve, and a later PR may allow the 64 B / 1 KiB jitter for cli/pyjs.cjs."
   - This PR (PR A) ships with **zero** jitter: `noise_bytes` = `noise_total` = 0 for every bundle.
   - `noise_bytes` 64 and `noise_total` 1024, for `cli/pyjs.cjs` only, come in a separate, reviewed later PR.
2. **The single writer:** "Confirmed, no ruleset for now."
3. **The merge queue and a size-only re-check:** "Yes, as recommended."
   - No merge queue.
   - Full CI is always required; a size-only re-check never stands in for it.

## Still to come (plan §4)

**PR B** lands only when no open PR's latest CI predates PR A. It:
- deletes `size-budget.json` and `--update`;
- switches `core-api-surface.mjs` to numeric pending levels (§2.1);
- drops `heap-budget.json`'s `measured`.
