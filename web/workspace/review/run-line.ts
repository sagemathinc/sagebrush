// A file's one fact about running it in the branch (the review page's run line): its latest run's note (run-verbs.ts,
// BranchRuns) against the file as committed, both by the git blob id of its canonical bytes under the branch's canon.
// A fact, never a gate: nothing on the page waits on it or is refused by it.

import type { BranchRun } from "../branch-rules";

export type RunFact = { state: "ran" | "changed"; at: number } | { state: "none" };

/** `run`: the note kept for this file's path (none: undefined); `committed`: its blob id in the reviewed commit. */
export function runFact(run: BranchRun | undefined, committed: string | undefined): RunFact {
  if (!run) return { state: "none" };
  return { state: committed !== undefined && run.oid === committed ? "ran" : "changed", at: run.at };
}
