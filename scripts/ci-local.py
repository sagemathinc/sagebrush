#!/usr/bin/env python3
"""Run .github/workflows/ci.yml's jobs on this machine, from the workflow
itself, so the local suite can't drift from CI's (DEVELOPMENT.md).

For each job it runs, in order, every step that has a `run:`:
  - with the job's and the step's `env`, its `working-directory` and its
    `timeout-minutes`;
  - with `${{ matrix.* }}`, `${{ runner.temp }}` and `${{ github.sha }}`
    substituted;
  - with $GITHUB_ENV and $GITHUB_OUTPUT emulated (scripts/ci-cpus.sh sets
    SAGEBRUSH_CPUS through the first).
A matrix is expanded, and its combinations run one after another. A `uses:`
step (checkout, setup-node, caches, artifacts) is skipped: the toolchains it
would install are DEVELOPMENT.md's prerequisites.

Jobs only CI can run are skipped, and named in the report:
  - size-base, size-gate and ci: they need GitHub's API, its artifacts or
    other jobs' results;
  - webkit: it installs Playwright's WebKit with `sudo apt`. Run it with
    --webkit on a machine where that's fine.

The repeated build lines CI runs in every job (pnpm install, pnpm run build,
build-cli, bun web/build.ts) run once per invocation unless --rebuild-each.
The engine jobs come last: engine-wasm rebuilds wasm/sagebrush-engine.wasm,
and the engine-* jobs that follow test that fresh engine, as CI's do. The
committed engine is restored at the end, if it was unmodified at the start.

    python3 scripts/ci-local.py                 # every job CI runs on a full (master) run
    python3 scripts/ci-local.py --list          # the jobs, their matrices and what's skipped
    python3 scripts/ci-local.py --only checks,engine-rust
    python3 scripts/ci-local.py --dry-run       # print the commands, run nothing
    python3 scripts/ci-local.py --keep-going    # don't stop at the first failing job

It needs PyYAML (scripts/test-all.sh makes a venv with it).
"""

import argparse
import itertools
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOW = os.path.join(ROOT, ".github", "workflows", "ci.yml")
CI_ONLY = {
    "size-base": "the base's size record: GitHub's API and artifacts",
    "size-gate": "the growth gate: other jobs' artifacts",
    "ci": "the aggregate of the other jobs' results",
}
NEEDS_SUDO = {"webkit": "installs Playwright's WebKit with sudo apt (run with --webkit)"}
# (the build lines every job repeats; run once unless --rebuild-each)
BUILD_LINE = re.compile(r"^(pnpm install --frozen-lockfile|pnpm run build|node scripts/build-cli\.mjs|bun web/build\.ts)$")
# (engine jobs last: engine-wasm rebuilds the engine, and the jobs after it test that fresh engine)
ENGINE_ORDER = ["engine-rust", "engine-unsafe-sweep", "engine-wasm", "engine-node", "engine-language", "engine-modes", "engine-cpython"]


def load():
    with open(WORKFLOW) as f:
        return yaml.safe_load(f)


def matrix_of(job):
    m = (job.get("strategy") or {}).get("matrix") or {}
    keys = [k for k in m if k not in ("include", "exclude")]
    if not keys:
        return [{}]
    return [dict(zip(keys, combo)) for combo in itertools.product(*(m[k] for k in keys))]


def substitute(text, ctx, lenient=False):
    """${{ ... }}: matrix.*, runner.temp and github.sha. Anything else is GitHub's own context: in an env value
    (lenient) it's empty, as on a run with no such event; in a script it's an error, so a step that needs CI's
    context is never run wrongly."""
    def one(m):
        expr = m.group(1).strip()
        if expr.startswith("matrix."):
            return str(ctx["matrix"][expr[len("matrix."):]])
        if expr == "runner.temp":
            return ctx["temp"]
        if expr == "github.sha":
            return ctx["sha"]
        if lenient:
            return ""
        raise KeyError(expr)
    return re.sub(r"\$\{\{\s*([^}]+?)\s*\}\}", one, text)


def step_runnable(step):
    """A run: step without a CI-only condition (a step `if:` naming GitHub's context, vars or other steps)."""
    if "run" not in step:
        return False, "uses"
    cond = str(step.get("if", ""))
    if re.search(r"\b(github|vars|steps|needs)\.", cond) or "cancelled()" in cond:
        return False, "a CI-only condition: " + cond
    return True, ""


def order(jobs):
    names = [n for n in jobs if n not in ENGINE_ORDER]
    return names + [n for n in ENGINE_ORDER if n in jobs]


def run_job(name, job, combo, args, state):
    """Run one job (one matrix combination). Returns (ok, seconds, notes)."""
    temp = tempfile.mkdtemp(prefix=f"ci-local-{name}-")
    genv, gout = os.path.join(temp, "github_env"), os.path.join(temp, "github_output")
    open(genv, "w").close()
    open(gout, "w").close()
    ctx = {"matrix": combo, "temp": temp, "sha": state["sha"]}
    env = dict(os.environ)
    env.update({"RUNNER_TEMP": temp, "GITHUB_ENV": genv, "GITHUB_OUTPUT": gout, "GITHUB_SHA": state["sha"], "GITHUB_EVENT_NAME": "local", "CI": "true"})
    for scope in (state["workflow_env"], job.get("env") or {}):
        for k, v in scope.items():
            v = str(v)
            if "${{" in v:
                continue  # (CI's own variables, e.g. vars.CI_CPUS: not set locally)
            env[k] = substitute(v, ctx, lenient=True)
    t0 = time.time()
    notes = []
    for step in job.get("steps", []):
        ok, why = step_runnable(step)
        label = step.get("name") or (step.get("run", "").strip().splitlines() or [""])[0][:70]
        try:
            label = substitute(str(label), ctx, lenient=True)
        except Exception:
            pass
        if not ok:
            if why != "uses":
                notes.append(f"skipped ({why}): {label}")
            continue
        try:
            script = substitute(step["run"], ctx)
        except KeyError as e:
            shutil.rmtree(temp, ignore_errors=True)
            return False, time.time() - t0, notes + [f"FAILED (needs CI's context: {e.args[0]}): {label}"]
        lines = [l.strip() for l in script.strip().splitlines() if l.strip()]
        cmds = [p.strip() for l in lines for p in l.split("&&")]
        if not args.rebuild_each and cmds and all(BUILD_LINE.match(c) for c in cmds):
            # (a build-only step: only the commands not already done this run; a later page or TypeScript
            # build makes build-cli due again, as CI's own order does)
            todo = [c for c in cmds if c not in state["built"]]
            if not todo:
                notes.append(f"reused (built earlier this run): {label}")
                continue
            script = " && ".join(todo)
            for c in todo:
                state["built"].add(c)
                if c in ("bun web/build.ts", "pnpm run build"):
                    state["built"].discard("node scripts/build-cli.mjs")
            if "node scripts/build-cli.mjs" in todo and todo[-1] == "node scripts/build-cli.mjs":
                state["built"].add("node scripts/build-cli.mjs")
        senv = dict(env)
        for k, v in (step.get("env") or {}).items():
            senv[k] = substitute(str(v), ctx, lenient=True)
        # (what earlier steps put in $GITHUB_ENV)
        with open(genv) as f:
            for line in f:
                if "=" in line:
                    k, v = line.rstrip("\n").split("=", 1)
                    senv[k] = v
                    env[k] = v
        cwd = os.path.join(ROOT, substitute(step["working-directory"], ctx)) if "working-directory" in step else ROOT
        timeout = 60 * float(step.get("timeout-minutes", job.get("timeout-minutes", 60)))
        print(f"\n--- {name}{(' ' + str(combo)) if combo else ''}: {label}", flush=True)
        if args.dry_run:
            print(script)
            continue
        try:
            r = subprocess.run(["bash", "-eo", "pipefail", "-c", script], cwd=cwd, env=senv, timeout=timeout)
            code = r.returncode
        except subprocess.TimeoutExpired:
            code = "timeout"
        if code != 0:
            if step.get("continue-on-error"):
                notes.append(f"failed, continue-on-error ({code}): {label}")
                continue
            shutil.rmtree(temp, ignore_errors=True)
            return False, time.time() - t0, notes + [f"FAILED ({code}): {label}"]
        if name == "engine-wasm" and "build-engine.mjs" in script:
            # (the engine changed: the next job's build lines must run again, over the fresh engine)
            state["built"].clear()
    shutil.rmtree(temp, ignore_errors=True)
    return True, time.time() - t0, notes


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="comma-separated job names")
    ap.add_argument("--skip", help="comma-separated job names")
    ap.add_argument("--webkit", action="store_true", help="also run the webkit job (sudo apt)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--keep-going", action="store_true")
    ap.add_argument("--rebuild-each", action="store_true", help="run each job's own build lines, as CI does")
    args = ap.parse_args()
    wf = load()
    jobs = wf["jobs"]
    only = set(args.only.split(",")) if args.only else None
    skip = set(args.skip.split(",")) if args.skip else set()
    unknown = (only or set()) | skip
    unknown -= set(jobs)
    if unknown:
        sys.exit(f"no such job: {', '.join(sorted(unknown))}")
    plan, skipped = [], []
    for n in order(jobs):
        if n in CI_ONLY:
            skipped.append((n, CI_ONLY[n]))
        elif n in NEEDS_SUDO and not args.webkit:
            skipped.append((n, NEEDS_SUDO[n]))
        elif (only and n not in only) or n in skip:
            continue
        else:
            plan.append(n)
    if args.list:
        for n in plan:
            ms = matrix_of(jobs[n])
            print(f"{n}: {len(ms)} run(s){'  ' + str([list(m.values())[0] for m in ms]) if ms != [{}] else ''}")
        for n, why in skipped:
            print(f"(skipped) {n}: {why}")
        return
    sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip() or "0" * 40
    engine_clean = subprocess.run(["git", "status", "--porcelain", "wasm/sagebrush-engine.wasm"], cwd=ROOT, capture_output=True, text=True).stdout.strip() == ""
    state = {"sha": sha, "built": set(), "workflow_env": wf.get("env") or {}}
    report = []
    failed = False
    try:
        for n in plan:
            for combo in matrix_of(jobs[n]):
                ok, secs, notes = run_job(n, jobs[n], combo, args, state)
                report.append((n, combo, ok, secs, notes))
                if not ok:
                    failed = True
                    if not args.keep_going:
                        raise StopIteration
    except StopIteration:
        pass
    finally:
        if engine_clean and not args.dry_run:
            subprocess.run(["git", "checkout", "--", "wasm/sagebrush-engine.wasm"], cwd=ROOT)
    print("\n==== ci-local report")
    total = 0.0
    for n, combo, ok, secs, notes in report:
        total += secs
        print(f"{'ok  ' if ok else 'FAIL'} {secs / 60:6.1f} min  {n}{(' ' + str(combo)) if combo else ''}")
        for x in notes:
            if x.startswith("FAILED") or x.startswith("failed"):
                print(f"            {x}")
    for n, why in skipped:
        print(f"skip            {n}: {why}")
    print(f"total {total / 60:.1f} min")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
