#!/usr/bin/env python3
"""Run .github/workflows/ci.yml's jobs on this machine, from the workflow
itself, so the local suite follows CI's (DEVELOPMENT.md).

For each job it runs, in order, every step that has a `run:` and whose `if:`
holds here:
  - with the workflow's, the job's and the step's `env` (the step's last), its
    `working-directory`, and $GITHUB_ENV / $GITHUB_OUTPUT emulated
    (scripts/ci-cpus.sh sets SAGEBRUSH_CPUS through the first);
  - with `${{ matrix.* }}`, `${{ runner.temp }}` and `${{ github.sha }}`
    substituted; in an env value, GitHub-only contexts (vars.*, github.event.*,
    github.token, needs.*) are empty, as on a run with no such event; in a
    script any of them is an error, so a step that needs CI is never run wrongly;
  - under CI's time limits: the job's `timeout-minutes` (default 360) is one
    budget for all its steps, and a step's own `timeout-minutes` caps it within
    what's left.
Each job starts from a fresh checkout's generated state, as on CI: build/cli,
web/dist and engine/py/dist are removed before it, and it runs its own build
lines. A matrix is expanded, and its combinations run one after another. A
`uses:` step (checkout, setup-node, caches, artifacts) is skipped: the toolchains
it would install are DEVELOPMENT.md's prerequisites.

Every step runs in its own session, with this process as the subreaper of
anything it leaves (Linux). What a step leaves runs on into the job's later
steps, as on CI, and is ended at the job's end; on a step's timeout, or when this
run is interrupted, it is ended at once. Ending: found by ancestry (never by
name), sent TERM, then KILL, and checked gone before the next job or the engine
restore.

What it doesn't do, and refuses rather than guesses at: a matrix's
include/exclude, and an `if:` beyond always(), matrix.X ==/!= 'v', `&&`, and the
conditions on CI's own context (github.*, vars.*, steps.*, needs.*,
cancelled()), whose steps are skipped and named in the report. A job's own
`if:` (path selection) is ignored: every job runs.

Jobs only CI can run are skipped, and named in the report:
  - size-base, size-gate and ci: they need GitHub's API, its artifacts or
    other jobs' results;
  - webkit: it installs Playwright's WebKit with `sudo apt`. Run it with
    --webkit on a machine where that's fine.

The engine jobs come last: engine-wasm rebuilds wasm/sagebrush-engine.wasm, and
the engine-* jobs that follow test that fresh engine, as CI's do (with
--only engine-node and no engine-wasm, they test the engine already there). The
committed engine is restored at the end, if it was unmodified at the start; a
run that would rebuild an engine with local changes refuses to start.

    python3 scripts/ci-local.py                 # every job CI runs on a full (master) run
    python3 scripts/ci-local.py --list          # the jobs, their matrices and what's skipped
    python3 scripts/ci-local.py --only checks,engine-rust
    python3 scripts/ci-local.py --dry-run       # print the commands, run nothing
    python3 scripts/ci-local.py --keep-going    # don't stop at the first failing job

It needs PyYAML (scripts/test-all.sh makes a venv with it).
"""

import argparse
import ctypes
import hashlib
import itertools
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# (CI_LOCAL_WORKFLOW: another workflow file, for checking this script with fixtures; never set for a real run)
WORKFLOW = os.environ.get("CI_LOCAL_WORKFLOW") or os.path.join(ROOT, ".github", "workflows", "ci.yml")
CI_ONLY = {
    "size-base": "the base's size record: GitHub's API and artifacts",
    "size-gate": "the growth gate: other jobs' artifacts",
    "ci": "the aggregate of the other jobs' results",
}
NEEDS_SUDO = {"webkit": "installs Playwright's WebKit with sudo apt (run with --webkit)"}
# (what a fresh checkout doesn't have and the jobs build: removed before each job, as on CI)
GENERATED = ["build/cli", "web/dist", "engine/py/dist"]
# (GitHub-only contexts: empty in an env value here, as on a run with no such event)
CI_CONTEXT = re.compile(r"^(vars\.|github\.event\.|github\.token$|needs\.)")
# (engine jobs last: engine-wasm rebuilds the engine, and the jobs after it test that fresh engine)
ENGINE_ORDER = ["engine-rust", "engine-unsafe-sweep", "engine-wasm", "engine-node", "engine-language", "engine-modes", "engine-cpython"]


def load():
    with open(WORKFLOW) as f:
        return yaml.safe_load(f)


class Unsupported(Exception):
    pass


def matrix_of(job):
    m = (job.get("strategy") or {}).get("matrix") or {}
    if "include" in m or "exclude" in m:
        raise Unsupported("a matrix include/exclude")
    keys = list(m)
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
        if lenient and CI_CONTEXT.match(expr):
            return ""
        raise KeyError(expr)
    return re.sub(r"\$\{\{\s*([^}]+?)\s*\}\}", one, text)


def step_runnable(step, combo):
    """Whether a run: step runs here: (True, "") or (False, why). Its `if:` may be always(), matrix.X == / != 'v',
    or a && of those; a condition on CI's own context (github.*, vars.*, steps.*, needs.*, cancelled()) skips the
    step, named in the report; anything else is refused (Unsupported), not guessed at."""
    if "run" not in step:
        return False, "uses"
    cond = str(step.get("if", "")).strip()
    m = re.fullmatch(r"\$\{\{\s*(.*?)\s*\}\}", cond)
    if m:
        cond = m.group(1)
    if not cond:
        return True, ""
    if re.search(r"\b(github|vars|steps|needs)\.|cancelled\(\)", cond):
        return False, "a CI-only condition: " + cond
    for term in (x.strip() for x in cond.split("&&")):
        if term == "always()":
            continue
        t = re.fullmatch(r"matrix\.([A-Za-z0-9_-]+)\s*(==|!=)\s*'([^']*)'", term)
        if not t:
            raise Unsupported("an if: this can't evaluate: " + cond)
        k, op, v = t.groups()
        if k not in combo:
            raise Unsupported(f"an if: on matrix.{k}, which this job's matrix doesn't have: {cond}")
        if (str(combo[k]) == v) != (op == "=="):
            return False, f"its if: is false here ({cond})"
    return True, ""


def order(jobs):
    names = [n for n in jobs if n not in ENGINE_ORDER]
    return names + [n for n in ENGINE_ORDER if n in jobs]


# ---- owned processes: found by ancestry from this process (the subreaper of what steps leave), never by name

def descendants():
    """Every live process under this one, by ppid ancestry (orphans re-parent here: set_subreaper)."""
    kids = {}
    for p in os.listdir("/proc"):
        if not p.isdigit():
            continue
        try:
            with open(f"/proc/{p}/stat") as f:
                s = f.read()
            ppid, state = int(s[s.rindex(")") + 2:].split()[1]), s[s.rindex(")") + 2:].split()[0]
        except (OSError, ValueError, IndexError):
            continue
        if state != "Z":
            kids.setdefault(ppid, []).append(int(p))
    out, todo = [], [os.getpid()]
    while todo:
        for c in kids.get(todo.pop(), []):
            out.append(c)
            todo.append(c)
    return out


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def reap_orphans(keep):
    """Reap every exited child of this process except keep (the running step's own bash, which Popen waits for)."""
    while True:
        try:
            info = os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError:
            return
        if info is None or info.si_pid == keep:
            return
        try:
            os.waitpid(info.si_pid, os.WNOHANG)
        except ChildProcessError:
            return


class Unresolved(Exception):
    """Processes this run started that couldn't be ended: the whole run stops at once (even with --keep-going), its
    state is left as it is for inspection, and the engine isn't restored while anything may still write."""
    def __init__(self, pids, where):
        super().__init__(f"{len(pids)} process(es) could not be ended {where}: {pids}")
        self.pids = pids


def bounded_wait(p, seconds=10.0):
    """Wait for a Popen at most this long; whether it ended."""
    try:
        p.wait(timeout=seconds)
        return True
    except subprocess.TimeoutExpired:
        return False


def end_descendants(grace=10.0):
    """TERM, then (after grace) KILL, everything under this process; reaped and checked gone. Returns (found, the
    pids left: empty when all are gone)."""
    found = descendants()
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 5.0)):
        for p in descendants():
            try:
                os.kill(p, sig)
            except ProcessLookupError:
                pass
        t = time.monotonic() + wait
        while descendants() and time.monotonic() < t:
            reap()
            time.sleep(0.1)
        reap()
        if not descendants():
            break
    return len(found), descendants()


def set_subreaper():
    try:
        PR_SET_CHILD_SUBREAPER = 36
        return ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0
    except (OSError, AttributeError):
        return False


ENGINE = "wasm/sagebrush-engine.wasm"


def engine_sha():
    try:
        with open(os.path.join(ROOT, ENGINE), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None


def head_engine_sha():
    r = subprocess.run(["git", "show", "HEAD:" + ENGINE], cwd=ROOT, capture_output=True)
    return hashlib.sha256(r.stdout).hexdigest() if r.returncode == 0 else None


class Interrupted(Exception):
    pass


def run_step(script, cwd, env, limit, inject=False):
    """One step's script in its own session, bounded by limit seconds. On a timeout or an interruption everything
    under this process is ended (and checked gone) at once; otherwise what the step leaves runs on into the job's
    later steps, as on CI, and is ended at the job's end. Every wait after an ending is bounded; anything that won't
    end raises Unresolved (inject: the fixtures' CI_LOCAL_FAULT_UNRESOLVED=<job>:step, an injected leftover at the
    timeout, no real process). Returns (code, cleanup note or "")."""
    p = subprocess.Popen(["bash", "-eo", "pipefail", "-c", script], cwd=cwd, env=env, start_new_session=True)
    end = time.monotonic() + max(limit, 0.001)
    try:
        while True:
            # (orphans re-parented here are reaped as they exit, as init would: a test that kills a process and
            # waits for it to leave /proc must see it go; the step's own bash is left to Popen)
            reap_orphans(p.pid)
            code = p.poll()
            if code is not None:
                return code, ""
            if time.monotonic() >= end:
                found, left = end_descendants()
                if not bounded_wait(p) and p.pid not in left:
                    left = left + [p.pid]
                if inject:
                    left = left + ["(injected)"]
                if left:
                    raise Unresolved(left, "after a step's timeout")
                return "timeout", f"timed out: ended {found} process(es)"
            time.sleep(0.05)
    except Unresolved:
        raise
    except BaseException:
        found, left = end_descendants()
        if not bounded_wait(p) and p.pid not in left:
            left = left + [p.pid]
        if left:
            raise Unresolved(left, "after an interruption")
        raise


def run_job(name, job, combo, args, state):
    """Run one job (one matrix combination) from a fresh checkout's generated state. Returns (ok, seconds, notes)."""
    if not args.dry_run:
        for d in GENERATED:
            shutil.rmtree(os.path.join(ROOT, d), ignore_errors=True)
    temp = tempfile.mkdtemp(prefix=f"ci-local-{name}-")
    genv, gout = os.path.join(temp, "github_env"), os.path.join(temp, "github_output")
    open(genv, "w").close()
    open(gout, "w").close()
    ctx = {"matrix": combo, "temp": temp, "sha": state["sha"]}
    env = dict(os.environ)
    env.update({"RUNNER_TEMP": temp, "GITHUB_ENV": genv, "GITHUB_OUTPUT": gout, "GITHUB_SHA": state["sha"], "GITHUB_EVENT_NAME": "local", "CI": "true"})
    for scope in (state["workflow_env"], job.get("env") or {}):
        for k, v in scope.items():
            env[k] = substitute(str(v), ctx, lenient=True)
    t0 = time.time()
    # (the job's timeout-minutes is one budget for all its steps, as on CI; GitHub's default is 360)
    deadline = time.monotonic() + 60 * float(job.get("timeout-minutes", 360))
    notes, failed = [], None
    for step in job.get("steps", []):
        ok, why = step_runnable(step, combo)
        label = step.get("name") or (step.get("run", "").strip().splitlines() or [""])[0][:70]
        try:
            label = substitute(str(label), ctx, lenient=True)
        except KeyError:
            pass
        if not ok:
            if why != "uses":
                notes.append(f"skipped ({why}): {label}")
            continue
        # (after a failure only always() steps run, as on CI)
        if failed and "always()" not in str(step.get("if", "")):
            continue
        try:
            script = substitute(step["run"], ctx)
        except KeyError as e:
            failed = failed or f"FAILED (needs CI's context: {e.args[0]}): {label}"
            continue
        senv = dict(env)
        # (what earlier steps put in $GITHUB_ENV, then the step's own env over it)
        with open(genv) as f:
            for line in f:
                if "=" in line:
                    k, v = line.rstrip("\n").split("=", 1)
                    senv[k] = v
                    env[k] = v
        for k, v in (step.get("env") or {}).items():
            senv[k] = substitute(str(v), ctx, lenient=True)
        cwd = os.path.join(ROOT, substitute(step["working-directory"], ctx)) if "working-directory" in step else ROOT
        left = deadline - time.monotonic()
        limit = min(left, 60 * float(step["timeout-minutes"])) if "timeout-minutes" in step else left
        print(f"\n--- {name}{(' ' + str(combo)) if combo else ''}: {label}", flush=True)
        if args.dry_run:
            print(script)
            continue
        if limit <= 0:
            failed = failed or f"FAILED (the job's time is up): {label}"
            continue
        try:
            code, cleanup = run_step(script, cwd, senv, limit, inject=os.environ.get("CI_LOCAL_FAULT_UNRESOLVED") == f"{name}:step")
        except Unresolved:
            # (the run stops here: this job's temp dir is kept, and said, as at a job's end)
            print(f"ci-local: the job's temp dir is kept: {temp}", flush=True)
            raise
        if cleanup:
            notes.append(f"{cleanup}: {label}")
            print(f"(ci-local: {cleanup})", flush=True)
        if code != 0:
            # (the job's own budget running out always fails the job, continue-on-error or not; a step's own failure
            # or its own timeout, with job time left, is what continue-on-error lets through)
            job_out = code == "timeout" and limit < 60 * float(step.get("timeout-minutes", 1e9))
            if job_out:
                code = "timeout: the job's time ran out"
            if step.get("continue-on-error") and not job_out:
                notes.append(f"failed, continue-on-error ({code}): {label}")
                continue
            failed = failed or f"FAILED ({code}): {label}"
        elif name == "engine-wasm" and "build-engine.mjs" in script:
            # (this run's own engine build: the bytes it may restore from at the end, and only these)
            state["engine_built"] = engine_sha()
    # (the job's end: whatever its steps left running is ended and checked gone, as CI's runner does; if anything
    # won't end, the whole run stops here, its temp dir kept: CI_LOCAL_FAULT_UNRESOLVED=<job> injects that, for the
    # fixtures, without any real process)
    if not args.dry_run:
        found, left = end_descendants()
        if os.environ.get("CI_LOCAL_FAULT_UNRESOLVED") == name:
            left = left + ["(injected)"]
        if found:
            notes.append(f"ended {found} process(es) left at the job's end")
        if left:
            print(f"ci-local: the job's temp dir is kept: {temp}", flush=True)
            raise Unresolved(left, f"at the end of job {name}")
    shutil.rmtree(temp, ignore_errors=True)
    return failed is None, time.time() - t0, notes + ([failed] if failed else [])


def restore_engine(state, start, clean):
    """At the end: the committed engine back, only if this run built one and its bytes are still that build's; bytes
    this run didn't make are left as they are and reported. Returns whether that is a failure."""
    now = engine_sha()
    if now == start:
        return False  # (unchanged by this run)
    if clean and state["engine_built"] is not None and now == state["engine_built"]:
        r = subprocess.run(["git", "checkout", "--", ENGINE], cwd=ROOT)
        if r.returncode != 0 or engine_sha() != head_engine_sha():
            print(f"ci-local: RESTORING {ENGINE} FAILED: `git checkout -- {ENGINE}` by hand", flush=True)
            return True
        print(f"ci-local: {ENGINE} restored (this run's engine-wasm build replaced by the committed one)", flush=True)
        return False
    print(f"ci-local: UNEXPECTED: {ENGINE} changed, and not to this run's own engine-wasm build"
          f"{'' if state['engine_built'] else ' (this run built none)'}: left as it is for inspection", flush=True)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="comma-separated job names")
    ap.add_argument("--skip", help="comma-separated job names")
    ap.add_argument("--webkit", action="store_true", help="also run the webkit job (sudo apt)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--keep-going", action="store_true")
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
    # (refused before anything runs: a construct this doesn't model, in any planned job)
    try:
        for n in plan:
            for combo in matrix_of(jobs[n]):
                for s in jobs[n].get("steps", []):
                    step_runnable(s, combo)
    except Unsupported as e:
        sys.exit(f"ci-local: {n} has {e}; it isn't modelled here, so it isn't run (DEVELOPMENT.md)")
    sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip() or "0" * 40
    st = subprocess.run(["git", "status", "--porcelain", "wasm/sagebrush-engine.wasm"], cwd=ROOT, capture_output=True, text=True)
    if st.returncode != 0:
        sys.exit("ci-local: git status failed: " + st.stderr.strip())
    engine_clean = st.stdout.strip() == ""
    if not engine_clean and "engine-wasm" in plan and not args.dry_run:
        sys.exit("ci-local: wasm/sagebrush-engine.wasm has local changes, and engine-wasm would write over them: commit them, or `git checkout -- wasm/`, first")
    if not args.dry_run and not set_subreaper():
        sys.exit("ci-local: can't become the subreaper of the steps' processes (prctl PR_SET_CHILD_SUBREAPER, Linux): "
                 "what they leave couldn't be found by ancestry, so nothing is run")
    # (a TERM or HUP to this run ends the running step and its processes, then reports, like Ctrl-C)
    def stop(sig, _frame):
        raise Interrupted(signal.Signals(sig).name)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    state = {"sha": sha, "workflow_env": wf.get("env") or {}, "engine_built": None}
    start_engine = engine_sha()
    report = []
    failed = False
    interrupted = None
    unresolved = None
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
    except (KeyboardInterrupt, Interrupted) as e:
        interrupted, failed = (e.args[0] if e.args else "SIGINT"), True
    except Unresolved as e:
        unresolved, failed = e, True
    finally:
        # (the cleanup and the report aren't cut short by another signal: a second Ctrl-C or TERM is ignored from here)
        for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(s, signal.SIG_IGN)
        if not args.dry_run:
            found, left = end_descendants()
            if found:
                print(f"ci-local: ended {found} leftover process(es)", flush=True)
            if left and not unresolved:
                unresolved, failed = Unresolved(left, "at the run's end"), True
        if unresolved:
            print(f"\nci-local: ABORTED: {unresolved}. The engine isn't restored, and everything is left as it is for "
                  f"inspection (end those processes by number, then `git status`)", flush=True)
        elif not args.dry_run:
            failed = restore_engine(state, start_engine, engine_clean) or failed
    if interrupted:
        print(f"\nci-local: interrupted ({interrupted})", flush=True)
    print("\n==== ci-local report")
    total = 0.0
    for n, combo, ok, secs, notes in report:
        total += secs
        print(f"{'ok  ' if ok else 'FAIL'} {secs / 60:6.1f} min  {n}{(' ' + str(combo)) if combo else ''}")
        for x in notes:
            if x.startswith(("FAILED", "failed", "ended")):
                print(f"            {x}")
    for n, why in skipped:
        print(f"skip            {n}: {why}")
    print(f"total {total / 60:.1f} min")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
