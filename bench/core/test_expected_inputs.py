#!/usr/bin/env python3
"""The reference input generator (expected_inputs.py) against the drivers.

- Tier (a), runs anywhere: expected_inputs.py reproduces every point's
  input hash in expected_inputs_golden.json, the hashes every backend agreed
  on in a full VM run (the file says which). The l sizes take about a
  minute: under BENCH_CI=1 only s and m are recomputed (the same generators
  at smaller n), and l, like the calibration sizes, is checked for its
  shape; every VM run checks every point's hash.
- Tier (b): the drivers' own `inputs` mode, at the small size of every row,
  equals expected_inputs.py.
  - The Sage-mode driver needs the engine's Python package. Under
    BENCH_CI=1 (set by CI) a missing package FAILS; elsewhere it is skipped,
    with the skip printed.
  - python-flint's driver is skipped (printed) when python-flint is absent.
  The native, wasm, Magma and Rust FLINT drivers are compared on the VMs,
  where they are built.

  python3 bench/core/test_expected_inputs.py
"""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import expected_inputs  # noqa: E402
import run  # noqa: E402

CI = os.environ.get("BENCH_CI") == "1"
# (the sizes whose hashes Golden recomputes: s and m in CI, within its
# budget; every regular size elsewhere)
GOLDEN_SIZES = ("s", "m") if CI else ("s", "m", "l")
ROWS = json.loads((HERE / "items.json").read_text())["rows"]


def python_with(module: str) -> str | None:
    """A Python that imports `module`: engine/.venv's, else this one."""
    for py in (str(run.VENV_PY), sys.executable):
        if Path(py).exists():
            r = subprocess.run(
                [py, "-c", f"import {module}"], capture_output=True, timeout=120
            )
            if r.returncode == 0:
                return py
    return None


def driver_hash(py: str, driver: str, row: dict, key: str) -> str:
    n, k = row["sizes"][key]["n"], run.variants(row, key)
    r = subprocess.run(
        [py, str(HERE / "drivers" / driver), row["id"], str(n), "inputs", str(k)],
        capture_output=True,
        text=True,
        timeout=600,
        cwd=run.ROOT,
        env=dict(os.environ, **run.SINGLE_THREAD),
    )
    lines = [x for x in r.stdout.splitlines() if x.startswith("INPUTS|")]
    if r.returncode != 0 or not lines:
        raise AssertionError(
            f"{driver} {row['id']} {key}: exit {r.returncode}\n{r.stdout[-500:]}{r.stderr[-1500:]}"
        )
    return lines[-1].split("|")[1]


class Golden(unittest.TestCase):
    def test_every_golden_point(self):
        # (points every backend agreed on in a VM run, plus the pending ones
        # no VM run has confirmed yet: together exactly every point, never
        # one in both)
        g = json.loads((HERE / "expected_inputs_golden.json").read_text())
        golden, pending = g["points"], g.get("pending", {})
        self.assertFalse(set(golden) & set(pending))
        self.assertEqual(
            set(golden) | set(pending),
            {f"{r['id']}:{k}" for r in ROWS for k in r["sizes"]},
        )
        sizes = GOLDEN_SIZES
        got = expected_inputs.expected(list(sizes), [])
        for key, want in {**golden, **pending}.items():
            if key.rpartition(":")[2] not in sizes:
                # (a calibration size, or l under BENCH_CI: its hash takes
                # minutes to recompute here, so only its shape is checked;
                # every VM run checks each backend's input hash against it,
                # as for every point)
                row = next(r for r in ROWS if r["id"] == key.partition(":")[0])
                size = key.rpartition(":")[2]
                self.assertEqual(
                    (want["n"], want["variants"]),
                    (row["sizes"][size]["n"], run.variants(row, size)),
                )
                continue
            with self.subTest(point=key):
                self.assertEqual(
                    (got[key]["n"], got[key]["variants"]), (want["n"], want["variants"])
                )
                self.assertEqual(got[key]["input_hash"], want["input_hash"])


def bareiss_rank(a):
    """The exact rank over Q of an integer matrix (fraction-free)."""
    m = [list(r) for r in a]
    rank, prev = 0, 1
    for c in range(len(m[0])):
        piv = next((i for i in range(rank, len(m)) if m[i][c]), None)
        if piv is None:
            continue
        m[rank], m[piv] = m[piv], m[rank]
        for i in range(rank + 1, len(m)):
            m[i] = [
                (m[rank][c] * m[i][j] - m[i][c] * m[rank][j]) // prev
                for j in range(len(m[0]))
            ]
        prev = m[rank][c]
        rank += 1
    return rank


class RankRows(unittest.TestCase):
    """The wide, def and def_p rank rows: each variant at size s has the
    rank its construction claims, checked exactly (not by the certificate's
    own prime)."""

    def test_the_ranks_at_size_s(self):
        for row in [r for r in ROWS if "_rank_" in r["id"]]:
            kind, shape = row["id"].split("_")[1], row["id"].split("_rank_")[1]
            n = row["sizes"]["s"]["n"]
            for v in range(run.variants(row, "s")):
                with self.subTest(row=row["id"], v=v):
                    a = expected_inputs.rank_matrix(shape, kind, n, v)
                    want = {"wide": n, "def": n // 2, "def_p": n}[shape]
                    self.assertEqual(len(a), n)
                    self.assertEqual(len(a[0]), 2 * n if shape == "wide" else n)
                    self.assertEqual(bareiss_rank(a), want)
                    if shape == "def_p":
                        self.assertEqual(
                            expected_inputs.rank_mod(a, expected_inputs.RANK_P), n - 1
                        )

    def test_a_failed_certificate_refuses_the_seed(self):
        from unittest import mock

        with mock.patch.object(expected_inputs, "rank_mod", lambda a, q: -1):
            with self.assertRaisesRegex(ValueError, "refusing the seed"):
                expected_inputs.rank_matrix("def", "z", 10, 0)

    def test_the_kronecker_product_is_the_plain_one(self):
        import random

        rng = random.Random(7)
        for shape in ((3, 4, 5), (1, 1, 1), (6, 2, 9)):
            a = [
                [rng.randint(-(10**20), 10**20) for _ in range(shape[1])]
                for _ in range(shape[0])
            ]
            b = [
                [rng.randint(-(10**20), 10**20) for _ in range(shape[2])]
                for _ in range(shape[1])
            ]
            plain = [
                [
                    sum(a[i][k] * b[k][j] for k in range(shape[1]))
                    for j in range(shape[2])
                ]
                for i in range(shape[0])
            ]
            self.assertEqual(expected_inputs.matmul(a, b), plain)


class Drivers(unittest.TestCase):
    def check(self, driver: str, module: str, rows: list[dict]):
        py = python_with(module)
        if py is None:
            if CI and module not in ("flint", "numpy"):
                self.fail(
                    f"BENCH_CI=1 but no Python imports {module}: the engine wheel must be installed"
                )
            print(
                f"\nSKIPPED {driver}: no Python here imports {module}", file=sys.stderr
            )
            self.skipTest(f"no {module}")
        for row in rows:
            with self.subTest(row=row["id"]):
                n, k = row["sizes"]["s"]["n"], run.variants(row, "s")
                self.assertEqual(
                    driver_hash(py, driver, row, "s"),
                    str(expected_inputs.input_hash(row["id"], n, k)),
                )

    def test_sage_mode_driver(self):
        self.check(
            "sagebrush_case.py",
            "sagebrush",
            [r for r in ROWS if r["backends"].get("user") == "sage-mode"],
        )

    def test_numpy_driver(self):
        # (its inputs mode under any NumPy: the CLI runs the same file)
        self.check(
            "numpy_case.py",
            "numpy",
            [r for r in ROWS if r.get("pyjs_driver") == "numpy_case.py"],
        )

    def test_the_numpy_drivers_hash_covers_every_entry(self):
        # (a construction control: A with its columns reversed keeps every
        # row sum, and so every operand a summary would hash, but not the
        # product; the driver's input hash must change with it)
        import shutil
        import tempfile

        py = python_with("numpy")
        if py is None:
            self.skipTest("no numpy")
        n, k = 8, 3
        a = expected_inputs.gemm_entries(n, 0, 12345)
        self.assertEqual([sum(r) for r in a], [sum(r[::-1]) for r in a])
        src = (HERE / "drivers/numpy_case.py").read_text()
        old = "    a, b = base(n, v, 12345), base(n, v, 54321)\n"
        self.assertEqual(src.count(old), 1)
        with tempfile.TemporaryDirectory() as d:
            shutil.copy(HERE / "drivers/common.py", d)
            Path(d, "numpy_case.py").write_text(src.replace(old, "    a, b = base(n, v, 12345)[:, ::-1], base(n, v, 54321)\n"))
            for row in ("mat_f64_gemm", "mat_f64_gemm_bits"):
                with self.subTest(row=row):
                    r = subprocess.run(
                        [py, str(Path(d, "numpy_case.py")), row, str(n), "inputs", str(k)],
                        capture_output=True, text=True, timeout=120, env=dict(os.environ, **run.SINGLE_THREAD),
                    )
                    got = [x for x in r.stdout.splitlines() if x.startswith("INPUTS|")]
                    self.assertEqual(r.returncode, 0, r.stderr[-800:])
                    self.assertNotEqual(got[-1].split("|")[1], str(expected_inputs.input_hash(row, n, k)))

    def test_python_flint_driver(self):
        self.check(
            "flint_case.py", "flint", [r for r in ROWS if r["backends"]["flint"]]
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
