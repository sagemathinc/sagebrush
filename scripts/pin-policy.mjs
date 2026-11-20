// When a stale engine pin (wasm/pins.json against a fresh build of engine/) is an error, and when a track's run uses
// its fresh build instead.  The pin moves only with a track's pull into master (its pull request carries the pin
// commit), so pull requests into a track never edit wasm/pins.json and a track's engine runs ahead of its pin.
//
// - Strict (a stale pin fails): master's pushes, dispatches (a train's gate) and schedule, and a pull request from a
//   track (track/*) into master.  The pull must come from a track/* branch; from any other branch it is an ordinary
//   pull request into master.
// - On a track (onTrack): a push or dispatch on track/*, and a pull request into track/*.  Every reader there uses
//   this run's fresh build, labelled fresh and never recorded as pinned; nothing is published.
// - Otherwise (another pull request into master, a local run): as before, a warning, and only a pull request's
//   engine test jobs may run a fresh build.
// check-fresh-wasm.mjs, wasm-artifact.mjs (and so wasm-publish.mjs), wasm-fetch-or-build.mjs and ci-paths.mjs all
// decide by these two functions.

const PULL_EVENTS = new Set(["pull_request", "pull_request_target"]);
const RUN_EVENTS = new Set(["push", "workflow_dispatch", "schedule"]);
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

export function isStrict({ event, ref = "", baseRef = "", headRef = "" }) {
  if (RUN_EVENTS.has(event)) return !isTrack(branchOf(ref));
  if (PULL_EVENTS.has(event)) return baseRef === "master" && isTrack(headRef);
  return false;
}

export function onTrack({ event, ref = "", baseRef = "" }) {
  if (event === "push" || event === "workflow_dispatch") return isTrack(branchOf(ref));
  if (PULL_EVENTS.has(event)) return isTrack(baseRef);
  return false;
}
