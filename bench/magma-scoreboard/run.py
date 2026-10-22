#!/usr/bin/env python3
"""Run the Sagebrush/Magma scoreboard sequentially and write results.md."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import resource
import socket
import subprocess
import sys
import time


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FLINT_RUST_BINARY = ROOT / "engine/target/release/magma-scoreboard-flint"
RESULT_RE = re.compile(r"^RESULT\|([0-9.]+)\|(.+)$", re.MULTILINE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("local", "vm"), default="local")
    parser.add_argument("--only", action="append", default=[], metavar="CASE_ID")
    parser.add_argument("--output", type=Path, default=HERE / "results.md")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--host-label", default=socket.gethostname())
    return parser.parse_args()


def child_cpu() -> float:
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return usage.ru_utime + usage.ru_stime


def command(engine: str, case_id: str, n: int, repeats: int) -> list[str]:
    if engine == "sagebrush":
        if case_id.startswith("bigint_"):
            return [
                "node",
                str(ROOT / "build/cli/pyjs.cjs"),
                str(HERE / "sagebrush_bigint.py"),
                case_id,
                str(n),
                str(repeats),
            ]
        return [
            str(ROOT / "engine/.venv/bin/python"),
            str(HERE / "sagebrush_case.py"),
            case_id,
            str(n),
            str(repeats),
        ]
    if engine == "flint":
        if flint_rust_supported(case_id):
            return [str(FLINT_RUST_BINARY), case_id, str(n), str(repeats)]
        return [
            str(ROOT / "engine/.venv/bin/python"),
            str(HERE / "flint_case.py"),
            case_id,
            str(n),
            str(repeats),
        ]
    return [
        "/usr/local/bin/magma",
        "-b",
        f"case_id:={case_id}",
        f"n:={n}",
        f"repeats:={repeats}",
        str(HERE / "magma_case.m"),
    ]


def flint_supported(case_id: str) -> bool:
    return case_id.startswith(
        ("bigint_", "poly_z_", "poly_fp_", "mat_z_", "mat_fp_", "mat_q_")
    )


def flint_rust_supported(case_id: str) -> bool:
    return case_id.startswith("poly_z_") or case_id in {
        "mat_z_det",
        "mat_z_rank",
        "mat_z_charpoly",
    }


def build_flint_rust() -> None:
    env = os.environ.copy()
    env["CARGO_TARGET_DIR"] = str(ROOT / "engine/target")
    subprocess.run(
        [
            "cargo",
            "build",
            "--quiet",
            "--release",
            "--manifest-path",
            str(HERE / "flint-rust/Cargo.toml"),
        ],
        cwd=ROOT,
        env=env,
        timeout=300,
        check=True,
    )


def invoke(engine: str, case_id: str, n: int, repeats: int, timeout: float) -> dict:
    env = os.environ.copy()
    env.update(
        {
            "SAGEBRUSH_THREADS": "1",
            "RAYON_NUM_THREADS": "1",
            "OMP_NUM_THREADS": "1",
            "OPENBLAS_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
        }
    )
    cmd = command(engine, case_id, n, repeats)
    cpu0, wall0 = child_cpu(), time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            cwd=ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as err:
        output = err.stdout or ""
        if isinstance(output, bytes):
            output = output.decode(errors="replace")
        return {
            "status": "timeout",
            "wall": time.monotonic() - wall0,
            "cpu": child_cpu() - cpu0,
            "detail": output[-1200:],
        }
    wall, cpu = time.monotonic() - wall0, child_cpu() - cpu0
    # Magma 2.18 wraps long output lines as backslash-newline continuations.
    normalized = proc.stdout.replace("\\\n", "")
    matches = list(RESULT_RE.finditer(normalized))
    if proc.returncode != 0 or not matches:
        return {
            "status": "error",
            "wall": wall,
            "cpu": cpu,
            "detail": proc.stdout[-1200:],
        }
    match = matches[-1]
    return {
        "status": "ok",
        "seconds": float(match.group(1)),
        "signature": match.group(2).strip(),
        "wall": wall,
        "cpu": cpu,
    }


def fmt_seconds(value: float | None) -> str:
    if value is None:
        return "—"
    if value == 0:
        return "<0.01"
    if value < 0.001:
        return f"{value:.3g}"
    if value < 1:
        return f"{value:.4f}"
    return f"{value:.3f}"


def best_reference(row: dict) -> tuple[str, float] | None:
    candidates = [
        ("Magma", row.get("magma_seconds")),
        ("FLINT", row.get("flint_seconds")),
    ]
    candidates = [
        (name, value) for name, value in candidates if value is not None and value > 0
    ]
    return min(candidates, key=lambda item: item[1]) if candidates else None


def ratio_value(row: dict) -> float | None:
    a, reference = row.get("sagebrush_seconds"), best_reference(row)
    if a is None or reference is None:
        return None
    return a / reference[1]


def verdict(row: dict) -> str:
    if row["status"] == "pending VM":
        return "pending VM"
    if row["status"] != "ok":
        return row["status"]
    ratio = ratio_value(row)
    if ratio is None:
        return "reference timer resolution"
    factor = max(1.0, ratio)
    if ratio <= 1:
        return "within 1x of best reference"
    if ratio <= 3:
        return f"within {factor:.2f}x of best reference"
    if ratio <= 10:
        return f"within {factor:.1f}x of best reference"
    return f"{factor:.1f}x gap"


def escape(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def write_results(path: Path, rows: list[dict], meta: dict) -> None:
    measured = [r for r in rows if r["status"] == "ok"]
    mismatches = [r for r in rows if r["status"] == "mismatch"]
    failures = [r for r in rows if r["status"] not in ("ok", "pending VM", "mismatch")]
    gaps = [r for r in measured if (ratio_value(r) or 0) > 10]
    gaps.sort(
        key=lambda r: (r["importance"], -(ratio_value(r) or 0), r["case"], r["n"])
    )
    within = sum(
        1 for r in measured if ratio_value(r) is not None and ratio_value(r) <= 10
    )
    comparable = sum(1 for r in measured if ratio_value(r) is not None)

    out = [
        "# Sagebrush–Magma/FLINT speed scoreboard",
        "",
        "## Verdict",
        "",
    ]
    if mismatches:
        out.append(
            f"**Correctness finding:** {len(mismatches)} measured point(s) disagreed; their timings were suppressed."
        )
    else:
        out.append(f"All {len(measured)} measured answer signatures agreed.")
    if comparable:
        out.append(
            f"Sagebrush is within 10x of the faster available Magma/FLINT reference on {within}/{comparable} comparable points; "
            f"{len(gaps)} point(s) exceed that gap."
        )
    unresolved = len([r for r in measured if ratio_value(r) is None])
    if unresolved:
        out.append(
            f"{unresolved} point(s) have no resolved reference time and therefore no numeric ratio."
        )
    if failures:
        out.append(
            f"{len(failures)} point(s) failed or timed out and are listed before the timing table."
        )

    out += ["", "## Correctness findings", ""]
    if not mismatches:
        out.append(
            "None. Every measured Sagebrush signature matched each available Magma/FLINT signature."
        )
    else:
        for r in mismatches:
            out.append(
                f"- **{r['case']} n={r['n']}:** Sagebrush `{escape(r.get('sagebrush_signature'))}`, "
                f"Magma `{escape(r.get('magma_signature'))}`, "
                f"FLINT `{escape(r.get('flint_signature', 'N/A'))}`."
            )

    out += ["", "## User-important gaps above 10x", ""]
    if not gaps:
        out.append("None among points with a numeric ratio.")
    else:
        for r in gaps:
            reference = best_reference(r)
            out.append(
                f"- **{r['category']} — {r['label']} (n={r['n']}):** "
                f"{ratio_value(r):.1f}x gap; Sagebrush {fmt_seconds(r['sagebrush_seconds'])} s, "
                f"best reference {reference[0]} {fmt_seconds(reference[1])} s."
            )

    if failures:
        out += ["", "## Failures and timeouts", ""]
        for r in failures:
            detail = escape(r.get("detail", ""))[-500:]
            out.append(f"- **{r['case']} n={r['n']} ({r['status']}):** `{detail}`")

    out += [
        "",
        "## Raw named numbers",
        "",
        "Ratio is Sagebrush time divided by the faster available Magma/FLINT time. Each time is the arithmetic mean of the named repeat count.",
        "",
        "| Category | Case | Size | Repeats | Sagebrush (s) | Magma (s) | FLINT 3.6 (s) | Best | Ratio | Verdict |",
        "|---|---|---:|---:|---:|---:|---:|---|---:|---|",
    ]
    for r in rows:
        ratio = ratio_value(r)
        ratio_text = "—" if ratio is None else f"{ratio:.3f}x"
        out.append(
            "| {category} | {case} — {label} | {n} | {repeats} | {sage} | {magma} | {flint} | {best} | {ratio} | {verdict} |".format(
                category=escape(r["category"]),
                case=escape(r["case"]),
                label=escape(r["label"]),
                n=r["n"],
                repeats=r["repeats"],
                sage=fmt_seconds(r.get("sagebrush_seconds")),
                magma=fmt_seconds(r.get("magma_seconds")),
                flint="N/A"
                if not r.get("flint_applicable")
                else fmt_seconds(r.get("flint_seconds")),
                best=(best_reference(r) or ("—", None))[0],
                ratio=ratio_text,
                verdict=escape(verdict(r)),
            )
        )

    out += [
        "",
        "## Method",
        "",
        "- Each point ran alone; no benchmark subprocesses overlapped.",
        "- Before timing a point, Sagebrush, Magma, and (where it exposes the operation) FLINT evaluated it once and compact deterministic answer signatures were compared. A mismatch suppresses timing.",
        f"- Each subprocess had a {meta['timeout']} s timeout. Thread-related environment variables were fixed at 1.",
        f"- Total child CPU used by this run: {meta['cpu']:.1f} s; elapsed wall time: {meta['wall']:.1f} s.",
        f"- Host: `{meta['host']}`. Sagebrush git revision: `{meta['git']}`.",
        "- Magma was used only through `/usr/local/bin/magma` (V2.18-5). FLINT uses the existing bench-only `sagebrush-flint` Rust oracle where it exposes the operation and the public `python-flint` 0.9.0 binding for the remaining FLINT 3.6.0 operations. Neither oracle is linked into shipped Sagebrush.",
        "- Timings exclude input construction, answer-signature conversion, and process startup: each engine reports elapsed time around only the operation loop. Magma 2.18-5 reports hundredths of a second.",
        "- The large size in every family is deliberately marked `pending VM` in the local profile.",
        "",
        "Inputs and exact commands are documented in [README.md](README.md); structured case sizes are in [cases.json](cases.json).",
        "",
    ]
    path.write_text("\n".join(out))


def main() -> int:
    args = parse_args()
    manifest = json.loads((HERE / "cases.json").read_text())
    timeout = min(60, int(manifest["timeout_seconds"]))
    selected = set(args.only)
    known = {case["id"] for case in manifest["cases"]}
    unknown = selected - known
    if unknown:
        raise SystemExit("unknown case(s): " + ", ".join(sorted(unknown)))

    points = []
    for case in manifest["cases"]:
        if selected and case["id"] not in selected:
            continue
        for size in case["sizes"]:
            pending = bool(size.get("pending_vm"))
            if args.profile == "local":
                points.append((case, size, pending))
            elif pending:
                points.append((case, size, False))
    if args.dry_run:
        runnable = sum(not pending for _, _, pending in points)
        print(
            f"profile={args.profile} runnable={runnable} listed={len(points)} sequential=true timeout={timeout}s"
        )
        for case, size, pending in points:
            print(
                case["id"],
                size["n"],
                "pending VM" if pending else f"repeats={size['repeats']}",
            )
        return 0

    if any(
        not pending and flint_rust_supported(case["id"]) for case, _, pending in points
    ):
        build_flint_rust()

    rows = []
    cpu0, wall0 = child_cpu(), time.monotonic()
    budget = float(manifest["budget_seconds"])
    for index, (case, size, pending) in enumerate(points, 1):
        row = {
            "category": case["category"],
            "case": case["id"],
            "label": case["label"],
            "importance": case["importance"],
            "n": size["n"],
            "repeats": size["repeats"],
            "flint_applicable": flint_supported(case["id"]),
        }
        if pending:
            row["status"] = "pending VM"
            rows.append(row)
            continue
        if child_cpu() - cpu0 >= budget:
            row.update(status="CPU budget exhausted", detail=f"limit {budget:.0f} s")
            rows.append(row)
            continue
        print(f"[{index}/{len(points)}] check {case['id']} n={size['n']}", flush=True)
        engines = ["sagebrush", "magma"] + (
            ["flint"] if row["flint_applicable"] else []
        )

        def run_engines(run_repeats: int) -> dict:
            results = {}
            for engine in engines:
                remaining = budget - (child_cpu() - cpu0)
                if remaining <= 0:
                    results[engine] = {
                        "status": "CPU budget exhausted",
                        "detail": f"limit {budget:.0f} s",
                    }
                    break
                results[engine] = invoke(
                    engine,
                    case["id"],
                    size["n"],
                    run_repeats,
                    min(timeout, remaining),
                )
            return results

        checks = run_engines(1)
        bad = [
            f"{name} {result['status']}"
            for name, result in checks.items()
            if result["status"] != "ok"
        ]
        if bad:
            row.update(status="check failed", detail="; ".join(bad))
            rows.append(row)
            continue
        row["sagebrush_signature"] = checks["sagebrush"]["signature"]
        row["magma_signature"] = checks["magma"]["signature"]
        if row["flint_applicable"]:
            row["flint_signature"] = checks["flint"]["signature"]
        signatures = [checks[engine]["signature"] for engine in engines]
        if len(set(signatures)) != 1:
            row["status"] = "mismatch"
            rows.append(row)
            continue
        print(f"[{index}/{len(points)}] time  {case['id']} n={size['n']}", flush=True)
        timed = run_engines(size["repeats"])
        bad = [
            f"{name} {result['status']}"
            for name, result in timed.items()
            if result["status"] != "ok"
        ]
        if bad:
            row.update(status="timing failed", detail="; ".join(bad))
        else:
            row.update(
                status="ok",
                sagebrush_seconds=timed["sagebrush"]["seconds"],
                magma_seconds=timed["magma"]["seconds"],
                flint_seconds=timed.get("flint", {}).get("seconds"),
            )
        rows.append(row)

    git = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()
    meta = {
        "timeout": timeout,
        "cpu": child_cpu() - cpu0,
        "wall": time.monotonic() - wall0,
        "git": git,
        "host": args.host_label,
    }
    write_results(args.output, rows, meta)
    print(
        f"wrote {args.output} ({meta['cpu']:.1f}s child CPU, {meta['wall']:.1f}s wall)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
