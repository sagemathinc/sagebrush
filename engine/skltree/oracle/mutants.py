"""engine/skltree's primitive mutation controls (run: python3 -I engine/skltree/oracle/mutants.py): each mutant must make `cargo test -p sagebrush-skltree` fail; the file is restored after."""
import subprocess, sys

import os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
MUTANTS = [
    ("insertion below 17, not 16 (2-way)", "skltree/src/sort.rs", "fn introsort_2way<T: Value>(values: &mut [T], indices: &mut [usize], mut lo: usize, mut n: usize, mut maxd: i64) {\n    while n > 15 {", "fn introsort_2way<T: Value>(values: &mut [T], indices: &mut [usize], mut lo: usize, mut n: usize, mut maxd: i64) {\n    while n > 16 {"),
    ("insertion below 17, not 16 (3-way)", "skltree/src/sort.rs", "fn introsort_3way<T: Value>(values: &mut [T], indices: &mut [usize], mut lo: usize, mut n: usize, mut maxd: i64) {\n    while n > 15 {", "fn introsort_3way<T: Value>(values: &mut [T], indices: &mut [usize], mut lo: usize, mut n: usize, mut maxd: i64) {\n    while n > 16 {"),
    ("2-way where 3-way is asked", "skltree/src/sort.rs", "    if use_three_way_partition {\n        introsort_3way", "    if !use_three_way_partition {\n        introsort_3way"),
    ("a stable sort", "skltree/src/sort.rs", "    if n == 0 {\n        return;\n    }\n    // (`maxd", "    if n == 0 {\n        return;\n    }\n    if use_three_way_partition {\n        let mut p: Vec<(T, usize)> = values[..n].iter().copied().zip(indices[..n].iter().copied()).collect();\n        p.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());\n        for (k, (v, i)) in p.into_iter().enumerate() {\n            values[k] = v;\n            indices[k] = i;\n        }\n        return;\n    }\n    // (`maxd"),
    ("depth limit one deeper", "skltree/src/sort.rs", "let maxd = 2 * i64::from(", "let maxd = 1 + 2 * i64::from("),
    ("median3 at (n - 1) / 2", "skltree/src/sort.rs", "let (a, b, c) = (values[lo], values[lo + n / 2], values[lo + n - 1]);", "let (a, b, c) = (values[lo], values[lo + (n - 1) / 2], values[lo + n - 1]);"),
    ("inplace_median3's last swap skipped", "skltree/src/sort.rs", "        swap(values, indices, lo + n - 1, lo + pivot_idx);\n        if values[lo] > values[lo + n - 1] {\n            swap(values, indices, lo, lo + n - 1);\n        }", "        swap(values, indices, lo + n - 1, lo + pivot_idx);"),
    ("heapsort's sift with <= (ties move)", "skltree/src/sort.rs", "if child < end && values[lo + maxind] < values[lo + child] {", "if child < end && values[lo + maxind] <= values[lo + child] {"),
    ("XorShift >> 16", "skltree/src/rng.rs", "*seed ^= *seed >> 17;", "*seed ^= *seed >> 16;"),
    ("no DEFAULT_SEED for 0", "skltree/src/rng.rs", "    if *seed == 0 {\n        *seed = DEFAULT_SEED;\n    }\n    *seed ^=", "    *seed ^="),
    ("modulo 2^31 - 1", "skltree/src/rng.rs", "*seed % (RAND_R_MAX + 1)", "*seed % RAND_R_MAX"),
    ("FEATURE_THRESHOLD = 0", "skltree/src/partition.rs", "pub const FEATURE_THRESHOLD: f32 = 1e-7;", "pub const FEATURE_THRESHOLD: f32 = 0.0;"),
    ("FEATURE_THRESHOLD added in float64", "skltree/src/partition.rs", "while p < end_non_missing && self.feature_values[p] <= self.feature_values[p - 1] + FEATURE_THRESHOLD {", "while p < end_non_missing && f64::from(self.feature_values[p]) <= f64::from(self.feature_values[p - 1]) + 1e-7 {"),
    ("the final partition compared in float32", "skltree/src/partition.rs", "f64::from(current_value) <= threshold }", "current_value <= threshold as f32 }"),
    ("the missing tail reversed", "skltree/src/partition.rs", "        t.finish();\n        let n = self.end - self.start - n_missing;", "        t.finish();\n        self.samples[self.end - n_missing..self.end].reverse();\n        let n = self.end - self.start - n_missing;"),
    ("swap_array_slices as rotate_right", "skltree/src/partition.rs", "    let n_rev = end - start - n;\n", "    let n_rev = end - start - n;\n    if n_rev > 0 && n > 0 { array[start..end].rotate_right(n); return; }\n"),
]


def run():
    r = subprocess.run(["cargo", "test", "-q", "-p", "sagebrush-skltree"], cwd=ROOT, capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


rc, _ = run()
assert rc == 0, "the unmutated tests must pass first"
fails = 0
for name, path, old, new in MUTANTS:
    p = f"{ROOT}/{path}"
    src = open(p).read()
    if src.count(old) != 1:
        print(f"SETUP {name}: the text to mutate occurs {src.count(old)} times")
        fails += 1
        continue
    open(p, "w").write(src.replace(old, new))
    try:
        rc, out = run()
    finally:
        open(p, "w").write(src)
    # (a kill is a failed test: the built tests ran, `test result: FAILED.` and at least one `<name> --- FAILED`;
    # any other nonzero exit, a compile error with or without a code, a link or setup failure, kills nothing)
    red = [l for l in out.splitlines() if l.endswith(" --- FAILED")]
    if rc == 0:
        fails += 1
        print(f"SURVIVED {name}")
    elif not red or not any(l.startswith("test result: FAILED.") for l in out.splitlines()):
        fails += 1
        print(f"NO-TEST-FAILURE {name} (exit {rc}): {[l for l in out.splitlines() if 'error' in l][:2]}")
    else:
        print(f"killed   {name}: {', '.join(sorted(set(l.split()[0] for l in red)))[:200]}")
rc, _ = run()
assert rc == 0, "restored tests must pass"
print("all killed" if fails == 0 else f"{fails} not killed")
sys.exit(1 if fails else 0)
