#!/usr/bin/env node
// Was this exact master commit already tested by the merge queue?  The queue pushes to master the very commit its
// merge_group run tested (the CI capacity ruling's second cut, Nov 22 2026: merge_group 45098226265 and push
// 45101250283 both ran 881d80a8, 86 jobs twice).  So a master push whose head_sha has a SUCCESSFUL merge_group run
// of this workflow, in this repository, skips the tests that run repeated (scripts/ci-paths.mjs, CI_QUEUE_TESTED);
// what only a push does still runs.  Any doubt is a full run: another event or ref, no such run, a failed or
// unreadable lookup, an answer that doesn't name this commit, workflow and repository exactly.
// (The queue merges once the run's required `ci` check passed, a moment before the run itself reads completed: a
// matching run still in progress is asked again, every 30 s for at most 3 minutes, then it's a full run.)
//   queueTested({ env, fetch, sleep, tries }) -> { tested, reason }
//   node scripts/ci-queue-tested.mjs   (in ci.yml's changes job: prints queue_tested=true|false for $GITHUB_OUTPUT)
import { pathToFileURL } from "node:url";

export const WORKFLOW = ".github/workflows/ci.yml";
const SHA = /^[0-9a-f]{40}$/;

export async function queueTested({ env = process.env, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 7 } = {}) {
  const no = (reason) => ({ tested: false, reason });
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== "refs/heads/master") return no("not a master push");
  const repo = env.GITHUB_REPOSITORY ?? "", sha = env.GITHUB_SHA ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !SHA.test(sha)) return no("no repository or commit");
  if (!env.GH_TOKEN) return no("no token");
  const api = env.GITHUB_API_URL || "https://api.github.com";
  for (let attempt = 1; ; attempt++) {
    let body;
    try {
      const r = await fetch(`${api}/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=merge_group&per_page=100`, {
        headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        signal: AbortSignal.timeout(20_000),
      });
      if (r.status !== 200) return no(`the runs lookup answered ${r.status}`);
      body = await r.json();
    } catch (e) {
      return no(`the runs lookup failed: ${e?.name ?? "error"}`);
    }
    const runs = (Array.isArray(body?.workflow_runs) ? body.workflow_runs : []).filter((r) => r?.head_sha === sha && r?.event === "merge_group" &&
      r?.path === WORKFLOW && r?.repository?.full_name === repo && r?.head_repository?.full_name === repo);
    const run = runs.find((r) => r.status === "completed" && r.conclusion === "success");
    if (run) return { tested: true, reason: `merge_group run ${run.id} passed on ${sha.slice(0, 12)}` };
    if (!runs.some((r) => r.status !== "completed")) return no(`no successful merge_group run on ${sha.slice(0, 12)}`);
    if (attempt >= tries) return no(`the merge_group run on ${sha.slice(0, 12)} hadn't completed after ${tries} lookups`);
    await sleep(30_000);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { tested, reason } = await queueTested();
  console.error(`queue tested: ${tested} (${reason})`);
  console.log(`queue_tested=${tested}`);
}
