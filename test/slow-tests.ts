// The tests too slow for every pull request (William, Nov 4 2026: pull-request CI within 10 minutes; his pick of
// the grader's option B): each still runs nightly (the schedule), on a dispatch, and wherever
// SAGEBRUSH_SLOW_TESTS=1, which CI sets for the full-ci label and for a change scripts/ci-paths.mjs's slow_tests
// matches.  They are skipped in place, never left out of the file list: node's --test-shard assigns files by their
// index in the sorted list, so dropping one would move every later file to another shard.  (each one's use names
// its time on a green master run)
export const SLOW = ["schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? "") || process.env.SAGEBRUSH_SLOW_TESTS === "1";

/** The `skip` option of a slow test: false where slow tests run, else the reason. */
export const slowSkip: false | string = SLOW ? false : "slow: runs nightly, on a dispatch, with the full-ci label or SAGEBRUSH_SLOW_TESTS=1";
