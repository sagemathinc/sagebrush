// Which runs are a track's (track/*): a push or dispatch on track/*, a pull request into track/*, and a merge queue
// group into a track.  ci-paths.mjs always builds the modules there, and wasm-fetch-or-build.mjs always builds a
// track's size base: a track's engine runs ahead of its pins.  Whether a build that differs from the pins is an error
// isn't decided here any more: wasm-artifact.mjs's policy decides by the pins' source (design/wasm-artifacts.md
// section 13).
const PULL_EVENTS = new Set(["pull_request", "pull_request_target"]);
const isTrack = (branch) => typeof branch === "string" && branch.startsWith("track/");
// (a branch name from GITHUB_REF_NAME, or a full ref from GITHUB_REF)
const branchOf = (ref) => (typeof ref === "string" && ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref ?? "");

// The event and refs of a run, from GitHub's environment
export function runRefs(env = process.env) {
  return {
    event: env.GITHUB_EVENT_NAME ?? "local",
    ref: env.GITHUB_REF_NAME || branchOf(env.GITHUB_REF),
    baseRef: env.GITHUB_BASE_REF ?? "",
    headRef: env.GITHUB_HEAD_REF ?? "",
  };
}

// (a merge queue group's target branch, from its gh-readonly-queue/<target>/pr-<n>-<sha> ref, or null)
const QUEUE_REF = /^gh-readonly-queue\/(.+)\/pr-\d+-[0-9a-f]{40}$/;
export const queueTarget = (ref) => QUEUE_REF.exec(branchOf(ref))?.[1] ?? null;

export function onTrack({ event, ref = "", baseRef = "" }) {
  if (event === "push" || event === "workflow_dispatch") return isTrack(branchOf(ref));
  if (event === "merge_group") return isTrack(queueTarget(ref));
  if (PULL_EVENTS.has(event)) return isTrack(baseRef);
  return false;
}
