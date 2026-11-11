// The tests too slow for every pull request (William, Nov 4 2026: pull-request CI within 10 minutes; his pick of
// the grader's option B): each still runs nightly (the schedule), on a dispatch, and wherever
// SAGEBRUSH_SLOW_TESTS=1, which CI sets for the full-ci label and for a change scripts/ci-paths.mjs's slow_tests
// matches.  They are skipped in place, never left out of the file list: node's --test-shard assigns files by their
// index in the sorted list, so dropping one would move every later file to another shard.  (each one's use names
// its time on a green master run)
export const SLOW = ["schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? "") || process.env.SAGEBRUSH_SLOW_TESTS === "1";

/** The `skip` option of a slow test: false where slow tests run, else the reason. */
export const slowSkip: false | string = SLOW ? false : "slow: runs nightly, on a dispatch, with the full-ci label or SAGEBRUSH_SLOW_TESTS=1";

/** A group of slow tests that a narrower change turns on alone (SAGEBRUSH_SLOW_TESTS=<group>, which
 * scripts/ci-paths.mjs's slow_scope names): "arraybuffer", the census's parity with tsc 7 and its train-16, for a change
 * to the census's scripts and tables.  The schedule, a dispatch and SAGEBRUSH_SLOW_TESTS=1 run every group. */
export type SlowGroup = "arraybuffer";

/** The `skip` option of a slow test in a group: false where slow tests or its group run, else the reason. */
export function slowSkipFor(group: SlowGroup): false | string {
  return SLOW || process.env.SAGEBRUSH_SLOW_TESTS === group ? false : `slow: runs nightly, on a dispatch, with the full-ci label, or SAGEBRUSH_SLOW_TESTS=1 or ${group}`;
}

/** The `skip` option of a slow test's pull-request sample: the sample runs where the whole set doesn't. */
export const sampleSkip: false | string = SLOW ? "the whole set runs here (slow tests on)" : false;

/** A fixed, spread sample of `n` of `xs` (in their order: index floor(i * length / n)), for a slow test's pull-request
 * companion: the same items on every run, so a sample failure reproduces, and spread over the whole sorted list. */
export function prSample<T>(xs: readonly T[], n: number): T[] {
  if (xs.length <= n) return [...xs];
  return Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]);
}
