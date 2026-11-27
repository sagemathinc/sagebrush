// The tests too slow for every pull request (William, Nov 4 2026: pull-request CI within 10 minutes; his pick of
// the grader's option B): each runs only where SAGEBRUSH_SLOW_TESTS=1, which CI sets in its long tier (the nightly
// schedule, and a dispatch that asks for it: scripts/ci-paths.mjs's slow_scope; the test audit's
// option (a)), and anyone can set locally.  Not on a pull request, whatever its label or paths, nor a master push.
// They are skipped in place, never left out of the file list: node's --test-shard assigns files by their index in the
// sorted list, so dropping one would move every later file to another shard.  (each one's use names its time on a
// green master run)
export const SLOW = process.env.SAGEBRUSH_SLOW_TESTS === "1";

/** The `skip` option of a slow test: false where slow tests run, else the reason. */
export const slowSkip: false | string = SLOW ? false : "slow: runs in CI's long tier, or with SAGEBRUSH_SLOW_TESTS=1";

/** A group of slow tests that can be run alone (SAGEBRUSH_SLOW_TESTS=<group>): "arraybuffer", the census's parity
 * with tsc 7 and its train-16.  SAGEBRUSH_SLOW_TESTS=1 runs every group. */
export type SlowGroup = "arraybuffer";

/** The `skip` option of a slow test in a group: false where slow tests or its group run, else the reason. */
export function slowSkipFor(group: SlowGroup): false | string {
  return SLOW || process.env.SAGEBRUSH_SLOW_TESTS === group ? false : `slow: runs in CI's long tier, or with SAGEBRUSH_SLOW_TESTS=1 or ${group}`;
}

/** The `skip` option of a slow test's pull-request sample: the sample runs where the whole set doesn't. */
export const sampleSkip: false | string = SLOW ? "the whole set runs here (slow tests on)" : false;

/** A fixed, spread sample of `n` of `xs` (in their order: index floor(i * length / n)), for a slow test's pull-request
 * companion: the same items on every run, so a sample failure reproduces, and spread over the whole sorted list. */
export function prSample<T>(xs: readonly T[], n: number): T[] {
  if (xs.length <= n) return [...xs];
  return Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]);
}
