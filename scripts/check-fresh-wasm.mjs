// The committed engine module against a fresh build of engine/ (the engine-wasm job, after
// scripts/build-engine.mjs installed the fresh one over it): any difference in wasm/, bytes or
// mode, means the committed artifact is stale.  On a master push, a dispatch (a train's gate,
// before it lands) or the schedule that is an error: master must never carry a stale engine.  On
// a pull request it is a warning: the flow is that the PR's own ci builds the fresh module and its
// author commits it (the fresh-wasm-<sha> artifact), so a mismatch mid-review is expected; the
// train's dispatch catches it before landing.
//   node scripts/check-fresh-wasm.mjs        (in the engine-wasm job; GITHUB_EVENT_NAME decides)
import { spawnSync } from "node:child_process";

export function checkFreshWasm({ cwd = process.cwd(), event = process.env.GITHUB_EVENT_NAME ?? "local" } = {}) {
  const diff = spawnSync("git", ["-C", cwd, "diff", "--quiet", "wasm/"]);
  if (diff.status === 0) return { status: 0, message: "wasm/: the committed engine equals a fresh build" };
  if (diff.status !== 1) return { status: 2, message: `::error::git diff wasm/ failed (${diff.status}): ${String(diff.stderr).trim()}` };
  const stat = spawnSync("git", ["-C", cwd, "diff", "--stat", "--summary", "wasm/"], { encoding: "utf8" }).stdout.trim();
  const what = "wasm/sagebrush-engine.wasm differs from a fresh build of engine/ (commit the fresh-wasm artifact)";
  const strict = event === "push" || event === "workflow_dispatch" || event === "schedule";
  return strict ? { status: 1, message: `::error::${what}\n${stat}` } : { status: 0, message: `::warning::${what}\n${stat}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkFreshWasm();
  console.log(r.message);
  process.exit(r.status);
}
