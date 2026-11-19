#!/usr/bin/env python3
"""The core-algorithm harness: for each row of items.json and each size,
check that every backend builds the same input and gets the same answer,
then time each one, and write one JSON file per (row, size) and a summary.

One subprocess at a time; each in its own process group, killed as a group
at its timeout and after it exits; its peak resident memory from wait4.
See README.md for the protocol, the backends and the output.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PROTOCOL = 2
# Input variants per point (items.json may lower it for a row or a size)
DEFAULT_VARIANTS = 8
VENV_PY = ROOT / "engine/.venv/bin/python"
PYJS = ROOT / "build/cli/pyjs.cjs"
MAGMA = Path("/usr/local/bin/magma")
NATIVE = HERE / "native/target/release/bench-core-native"
FLINT_RUST = HERE / "flint-rust/target/release/bench-core-flint"
# the CPU flags worth recording (SIMD and the arithmetic extensions)
FLAGS = re.compile(r"^(avx|avx2|avx512\w*|fma|bmi2|adx|sse4_2|asimd|sve\w*|neon)$")
LINE = re.compile(r"^(RESULT|TIME|INPUTS)\|(.*)$", re.MULTILINE)
SINGLE_THREAD = {
    "SAGEBRUSH_THREADS": "1",
    "RAYON_NUM_THREADS": "1",
    "OMP_NUM_THREADS": "1",
    "OPENBLAS_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
}
GRACE = 5.0


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--sizes", default="s,m,l", help="comma-separated size keys (s, m, l)"
    )
    p.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="ROW",
        help="a row id (repeatable)",
    )
    p.add_argument(
        "--backends",
        default="user,native,magma,flint",
        help="comma-separated backends to run",
    )
    p.add_argument(
        "--out",
        type=Path,
        help="the output directory (default results/<date>/<host label>)",
    )
    p.add_argument(
        "--host-label",
        default=socket.gethostname(),
        help="the machine's name in the output, e.g. its GCP type",
    )
    p.add_argument(
        "--build",
        action="store_true",
        help="build the native driver and the Rust FLINT oracle first",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="list the points and the backends found, run nothing",
    )
    p.add_argument(
        "--summary-only",
        action="store_true",
        help="rewrite summary.md from the row files",
    )
    return p.parse_args()


def git(*args: str) -> str:
    r = subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def machine(label: str) -> dict:
    model, flags = "", set()
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            key, _, value = line.partition(":")
            key = key.strip()
            if key in ("model name", "Model name") and not model:
                model = value.strip()
            if key in ("flags", "Features") and not flags:
                flags = {f for f in value.split() if FLAGS.match(f)}
    except OSError:
        pass
    return {
        "label": label,
        "cpu": model or platform.processor(),
        "arch": platform.machine(),
        "flags": sorted(flags),
        "nproc": os.cpu_count(),
        "kernel": platform.release(),
    }


def toolchain() -> str:
    m = re.search(
        r'^channel = "(.+)"',
        (ROOT / "engine/rust-toolchain.toml").read_text(),
        re.MULTILINE,
    )
    return m.group(1) if m else ""


def build() -> None:
    # (the engine's pinned toolchain and its default flags: the native column
    # measures the code we ship)
    env = dict(os.environ, RUSTUP_TOOLCHAIN=toolchain())
    env.pop("RUSTFLAGS", None)
    for crate in ("native", "flint-rust"):
        r = subprocess.run(
            ["cargo", "build", "--quiet", "--release"], cwd=HERE / crate, env=env
        )
        print(f"build {crate}: exit {r.returncode}", flush=True)


def run_child(cmd: list[str], timeout: float) -> dict:
    """Run cmd in its own process group with single-thread settings; its
    output, exit status, wall time, CPU time and peak RSS (wait4).  At the
    timeout the group gets TERM, then KILL after GRACE seconds; after the
    child exits, KILL again for anything it left behind in the group, and
    on any other way out (an interruption, an error) KILL and a reap of
    the child before the exception propagates."""
    env = dict(os.environ, **SINGLE_THREAD)
    with tempfile.TemporaryFile() as out:
        t0 = time.monotonic()
        proc = subprocess.Popen(
            cmd,
            cwd=ROOT,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        pgid, status, rusage, timed_out, termed = proc.pid, None, None, False, None
        try:
            while status is None:
                pid, st, ru = os.wait4(proc.pid, os.WNOHANG)
                if pid:
                    status, rusage = st, ru
                    break
                now = time.monotonic()
                if now - t0 > timeout and termed is None:
                    timed_out, termed = True, now
                    _killpg(pgid, signal.SIGTERM)
                elif termed is not None and now - termed > GRACE:
                    _killpg(pgid, signal.SIGKILL)
                    termed = float("inf")
                time.sleep(0.01)
        finally:
            # on every exit, an interruption or an error in the loop
            # included: the whole group killed (whatever the child left
            # behind, after a normal exit); on an abnormal exit the direct
            # child reaped too, so nothing outlives this call
            _killpg(pgid, signal.SIGKILL)
            if status is None:
                try:
                    os.waitpid(proc.pid, 0)
                except ChildProcessError:
                    pass
                proc.returncode = -signal.SIGKILL
        proc.returncode = os.waitstatus_to_exitcode(status)
        wall = time.monotonic() - t0
        out.seek(0)
        text = out.read().decode(errors="replace")
    return {
        "status": "timeout"
        if timed_out
        else ("ok" if proc.returncode == 0 else "error"),
        "exit": proc.returncode,
        "wall": round(wall, 3),
        "cpu": round(rusage.ru_utime + rusage.ru_stime, 3),
        "peak_rss_kib": rusage.ru_maxrss,
        "output": text,
    }


def _killpg(pgid: int, sig: int) -> None:
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def variants(row: dict, key: str) -> int:
    """K, the number of input variants a point cycles through: the size's
    "variants", else the row's, else DEFAULT_VARIANTS (1 for a row with one
    named input, such as x^n - 1)."""
    return int(row["sizes"][key].get("variants", row.get("variants", DEFAULT_VARIANTS)))


def command(backend: str, row: dict, n: int, mode: str, k: int = 1) -> list[str] | None:
    """The command of one backend for one row, or None when it doesn't apply
    or isn't on this host."""
    cid, kinds = row["id"], row["backends"]
    if backend == "user":
        if kinds["user"] == "pyjs":
            return (
                [
                    "node",
                    str(PYJS),
                    str(HERE / "drivers/sagebrush_bigint.py"),
                    cid,
                    str(n),
                    mode,
                    str(k),
                ]
                if PYJS.exists()
                else None
            )
        return (
            [
                str(VENV_PY),
                str(HERE / "drivers/sagebrush_case.py"),
                cid,
                str(n),
                mode,
                str(k),
            ]
            if VENV_PY.exists()
            else None
        )
    if backend == "native":
        return (
            [str(NATIVE), cid, str(n), mode, str(k)]
            if kinds["native"] and NATIVE.exists()
            else None
        )
    if backend == "magma":
        return (
            [
                str(MAGMA),
                "-b",
                f"case_id:={cid}",
                f"n:={n}",
                f"mode:={mode}",
                f"variants:={k}",
                str(HERE / "drivers/magma_case.m"),
            ]
            if MAGMA.exists()
            else None
        )
    if backend == "flint":
        if kinds["flint"] == "rust" and FLINT_RUST.exists():
            return [str(FLINT_RUST), cid, str(n), mode, str(k)]
        if kinds["flint"] and VENV_PY.exists():
            return [
                str(VENV_PY),
                str(HERE / "drivers/flint_case.py"),
                cid,
                str(n),
                mode,
                str(k),
            ]
    return None


def adapter(backend: str, row: dict) -> str:
    if backend == "flint":
        return (
            "flint-rust"
            if row["backends"]["flint"] == "rust" and FLINT_RUST.exists()
            else "python-flint"
        )
    if backend == "user":
        return (
            "pyjs (WebAssembly)"
            if row["backends"]["user"] == "pyjs"
            else "Sage mode (engine/.venv)"
        )
    return {"native": "bench-core-native", "magma": "Magma V2.18-5"}[backend]


def invoke(
    backend: str, row: dict, n: int, mode: str, timeout: float, k: int = 1
) -> dict:
    cmd = command(backend, row, n, mode, k)
    r = run_child(cmd, timeout)
    # (Magma 2.18 wraps long lines with backslash-newline)
    text = r.pop("output").replace("\\\n", "")
    found = LINE.findall(text)
    if r["status"] == "ok" and not found:
        r["status"] = "error"
    if r["status"] != "ok":
        r["detail"] = text[-600:]
        return r
    kind, fields = found[-1]
    parts = fields.split("|")
    if kind == "INPUTS":
        r["input_hash"] = parts[0]
    elif kind == "RESULT":
        r["signature"] = parts[1]
    else:
        med, sig, lo, hi, k, count = parts
        r.update(
            seconds=float(med),
            min=float(lo),
            max=float(hi),
            reps=int(k),
            samples=int(count),
            signature=sig,
        )
    return r


def point(row: dict, key: str, backends: list[str], ident: dict) -> dict:
    size = row["sizes"][key]
    n, timeout = size["n"], float(size["timeout"])
    k = variants(row, key)
    rec = dict(
        ident,
        row=row["id"],
        item=row["item"],
        category=row["category"],
        label=row["label"],
        size=key,
        n=n,
        fresh=row["fresh"],
        variants=k,
        backends={},
    )
    present = [b for b in backends if command(b, row, n, "once")]
    for b in backends:
        if b not in present:
            rec["backends"][b] = {
                "status": "not applicable"
                if b in ("native", "flint") and not (row["backends"][b])
                else "not on host"
            }
    # 1. the inputs each backend builds
    for b in present:
        r = invoke(b, row, n, "inputs", timeout, k)
        rec["backends"][b] = {"adapter": adapter(b, row), "input": r}
    hashes = {b: rec["backends"][b]["input"].get("input_hash") for b in present}
    known = {h for h in hashes.values() if h}
    # 2. the answers
    if len(known) > 1:
        rec["status"] = "input mismatch"
    else:
        for b in present:
            rec["backends"][b]["check"] = invoke(b, row, n, "once", timeout, k)
        sigs = {b: rec["backends"][b]["check"].get("signature") for b in present}
        got = {s for s in sigs.values() if s}
        rec["input_hash"] = known.pop() if known else None
        rec["status"] = "mismatch" if len(got) > 1 else ("ok" if got else "no answer")
    # 3. the times, only when everything agreed: each backend cycles through
    # the K variants, and their combined signatures must agree too (the
    # check above covers variant 0; this covers all K)
    if rec["status"] == "ok":
        mode = "time-fresh" if row["fresh"] else "time"
        for b in present:
            if rec["backends"][b]["check"]["status"] != "ok":
                continue
            rec["backends"][b]["time"] = invoke(b, row, n, mode, timeout, k)
        timed = {
            b: rec["backends"][b]["time"]
            for b in present
            if "time" in rec["backends"][b]
        }
        combined = {t["signature"] for t in timed.values() if t["status"] == "ok"}
        if len(combined) > 1:
            rec["status"] = "mismatch"
            for t in timed.values():
                if t["status"] == "ok":
                    t["status"] = "mismatch"
    refs = {
        b: rec["backends"][b].get("time", {}).get("seconds") for b in ("magma", "flint")
    }
    refs = {b: s for b, s in refs.items() if s}
    if rec["status"] == "ok" and refs:
        best = min(refs, key=refs.get)
        rec["best_ref"] = {
            "backend": best,
            "adapter": rec["backends"][best]["adapter"],
            "seconds": refs[best],
        }
        for b in ("user", "native"):
            s = rec["backends"].get(b, {}).get("time", {}).get("seconds")
            if s:
                rec["ratio_" + b] = round(s / refs[best], 4)
    rec["complete"] = True
    return rec


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    with os.fdopen(fd, "w") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def secs(x) -> str:
    if x is None:
        return "—"
    return f"{x:.3g}" if x < 1 else f"{x:.3f}"


def summary(out: Path, items: dict) -> None:
    recs = sorted(
        (json.loads(p.read_text()) for p in (out / "rows").glob("*.json")),
        key=lambda r: (r["item"], r["row"], "sml".index(r["size"])),
    )
    if not recs:
        return
    m = recs[0]["machine"]
    lines = [
        f"# Core-algorithm harness: {m['label']}",
        "",
        f"Commit `{recs[0]['commit']}`; {m['cpu']} ({m['arch']}, {m['nproc']} CPUs; flags {' '.join(m['flags']) or 'none recorded'}). "
        "One thread everywhere. Times are medians of the samples, seconds per operation. Ratios are against the best reference on this machine.",
        "",
        "## Gaps above 2x (native engine against the best reference)",
        "",
    ]
    gaps = [r for r in recs if (r.get("ratio_native") or 0) > 2]
    gaps.sort(key=lambda r: -r["ratio_native"])
    lines += [
        f"- **{r['row']}** {r['size']} (n={r['n']}): native {r['ratio_native']:.2f}x, user {r.get('ratio_user', 0):.2f}x of {r['best_ref']['adapter']}"
        for r in gaps
    ] or ["None among the rows with a native driver."]
    lines += [
        "",
        "## Every point",
        "",
        "| item | row | size | n | user | native | Magma | FLINT | best | user ratio | native ratio | status |",
        "|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|---|",
    ]
    for r in recs:

        def t(b, r=r):
            return secs(r["backends"].get(b, {}).get("time", {}).get("seconds"))

        lines.append(
            f"| {r['item']} | {r['row']} | {r['size']} | {r['n']} | {t('user')} | {t('native')} | {t('magma')} | {t('flint')} | {r.get('best_ref', {}).get('adapter', '—')} | {r.get('ratio_user', '—')} | {r.get('ratio_native', '—')} | {r['status']} |"
        )
    uncovered = [i for i in items.values() if i["status"] != "rows"]
    lines += ["", "## Items without rows", ""] + [
        f"- {i['id']} ({i['title']}): {i['status']}" for i in uncovered
    ]
    write_atomic(out / "summary.md", "\n".join(lines) + "\n")


def main() -> int:
    args = parse_args()
    manifest = json.loads((HERE / "items.json").read_text())
    rows = [r for r in manifest["rows"] if not args.only or r["id"] in args.only]
    unknown = set(args.only) - {r["id"] for r in manifest["rows"]}
    if unknown:
        raise SystemExit("unknown row(s): " + ", ".join(sorted(unknown)))
    sizes = args.sizes.split(",")
    backends = args.backends.split(",")
    out = args.out or HERE / "results" / time.strftime("%Y-%m-%d") / args.host_label
    items = {i["id"]: i for i in manifest["items"]}
    if args.summary_only:
        summary(out, items)
        return 0
    if args.build:
        build()
    ident = {
        "protocol": PROTOCOL,
        "commit": git("rev-parse", "HEAD"),
        "dirty": bool(git("status", "--porcelain", "--", "engine", "bench/core")),
        "machine": machine(args.host_label),
        "threads": 1,
    }
    if args.dry_run:
        print(json.dumps(ident["machine"]))
        for row in rows:
            for key in sizes:
                found = [
                    b
                    for b in backends
                    if command(b, row, row["sizes"][key]["n"], "once")
                ]
                print(row["id"], key, row["sizes"][key]["n"], " ".join(found))
        return 0
    for row in rows:
        for key in sizes:
            path = out / "rows" / f"{row['id']}-{key}.json"
            if path.exists():
                old = json.loads(path.read_text())
                same = (
                    all(old.get(k) == ident[k] for k in ("protocol", "commit", "dirty"))
                    and old["machine"]["label"] == args.host_label
                )
                if same and old.get("complete"):
                    print(f"skip {row['id']} {key}: done", flush=True)
                    continue
            print(f"{row['id']} {key} n={row['sizes'][key]['n']}", flush=True)
            rec = point(row, key, backends, ident)
            write_atomic(path, json.dumps(rec, indent=1) + "\n")
            print(
                f"  {rec['status']} user {rec.get('ratio_user')} native {rec.get('ratio_native')}",
                flush=True,
            )
    summary(out, items)
    return 0


if __name__ == "__main__":
    sys.exit(main())
