//! The work estimate of the Smith form with transforms (issue #1481),
//! measured: corpora are generated here, the models' constants refitted on
//! the training corpus (and required to equal `estimate::FITTED`: a code
//! change that moves them must refit and record them), and the held-out
//! corpora scored against ceilings on k, the p90 over rows of max(actual /
//! E, E / actual) on total units.  Also: the work L holds on every row, and
//! the classical route has no stage 2 estimate.  Every row is written with
//! the tested tree's head (git rev-parse HEAD, else GITHUB_SHA) to a
//! report in the test's target directory, each corpus before anything
//! about it is asserted (the training rows before the refit's check).  (A
//! file of its own: it is the slowest of the Smith tests.)

use num_traits::{One, Signed};
use sagebrush_arith::cost::{tallied, Units, FAMILIES};
use sagebrush_arith::smith::estimate::{self, part_a_model, trailing_model, Constants};
use sagebrush_arith::smith::{last_small_smith_sizes, smith_form, Route, K_MAX};
use sagebrush_arith::snf::invariants_nonsingular;
use sagebrush_arith::zmat::{self, limbs, ZMat};
use sagebrush_bigint::BigInt;

/// splitmix64 (xorshift is linear over GF(2): its entries' parities span 64
/// dimensions, so every n > 64 input would carry k >= n - 64 factors of 2).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
}

fn total(u: &Units) -> u64 {
    u.0.iter().sum()
}

fn diff(a: &Units, b: &Units) -> Units {
    let mut d = Units::default();
    for i in 0..FAMILIES {
        d.0[i] = b.0[i].wrapping_sub(a.0[i]);
    }
    d
}

/// One input's run and the quantities the fit and the scores need.
struct Row {
    route: Route,
    k: usize,
    n: usize,
    actual: u64,
    lower: u64,
    // route 1 and 2: attempts, h, log2 delta, delta's limbs, word delta
    attempts: u64,
    h: f64,
    delta_bits: u64,
    word: bool,
    // route 2: part A's units, its model's explicit terms, V_2^-1's limbs
    part_a: u64,
    part_a_base: u64,
    e_word: bool,
    vinv: usize,
    // the rest: actual and its model's unscaled part under the constants
    rest: u64,
    stage1: Option<u64>,
    beside: Option<u64>,
    stage2: Option<u64>,
    // for the scales' refit: the remaining work's model and the inverse's
    a: ZMat,
    nm: Option<(ZMat, BigInt, BigInt, Vec<BigInt>)>,
}

fn entry(rng: &mut Rng, bits: u32) -> BigInt {
    let mut x = BigInt::from(0);
    let mut left = bits;
    while left > 0 {
        let t = left.min(60);
        x = (x << t as usize) + BigInt::from(rng.next() >> (64 - t));
        left -= t;
    }
    if rng.next() & 1 == 1 {
        -x
    } else {
        x
    }
}

/// The corpus of one seed: "base" (random, k-structured with one shared
/// prime, sparse, diagonally dominant, and k = 6..8) or "shift" (banded,
/// block, near-unimodular, mixed sizes, larger n, k = 2..8, and classical
/// inputs: k >= 9, singular, rectangular).
fn corpus(set: &str, seed: u64) -> Vec<ZMat> {
    let mut rng = Rng(seed.wrapping_mul(0x9e3779b97f4a7c15));
    let fams: &[&str] = if set == "base" { &["random", "kstruct", "sparse", "diagdom", "khigh"] } else { &["banded", "block", "unimod", "mixed", "large", "k8", "singular", "rect", "k9"] };
    let mut out = vec![];
    for &fam in fams {
        let ns: &[usize] = if fam == "large" { &[64, 80, 96] } else { &[3, 4, 6, 8, 12, 16, 24, 32, 48] };
        for &n in ns {
            for &bits in &[2u32, 4, 16, 64, 128] {
                if (n >= 48 && bits >= 128) || (fam == "large" && bits > 16) || (fam == "khigh" && n < 12) {
                    continue;
                }
                if matches!(fam, "singular" | "rect" | "k9") && (n > 16 || bits > 16) {
                    continue;
                }
                let cols = if fam == "rect" { n + 2 } else { n };
                let mut rows: Vec<Vec<BigInt>> = (0..n)
                    .map(|i| {
                        (0..cols)
                            .map(|j| {
                                let b = if fam == "mixed" { 1 + (rng.next() % bits as u64) as u32 } else { bits };
                                let x = entry(&mut rng, b);
                                let zero = BigInt::from(0);
                                match fam {
                                    "sparse" if rng.next() % 3 != 0 && i != j => zero,
                                    "diagdom" if i != j => BigInt::from((rng.next() % 5) as i64 - 2),
                                    "banded" if (i as i64 - j as i64).abs() > 2 => zero,
                                    "block" if (i < n / 2) != (j < n / 2) => zero,
                                    "unimod" if j < i => zero,
                                    "unimod" if i == j => BigInt::one(),
                                    _ => x,
                                }
                            })
                            .collect()
                    })
                    .collect();
                if fam == "unimod" {
                    for _ in 0..n {
                        let (i, j) = ((rng.next() % n as u64) as usize, (rng.next() % n as u64) as usize);
                        if i != j {
                            let rj = rows[j].clone();
                            for (x, y) in rows[i].iter_mut().zip(&rj) {
                                *x += y;
                            }
                        }
                    }
                }
                let kk = match fam {
                    "kstruct" => 2 + (rng.next() % 3) as usize,
                    "k8" => 2 + (rng.next() % 7) as usize,
                    "khigh" => 6 + (rng.next() % 3) as usize,
                    "k9" => 9 + (rng.next() % 3) as usize,
                    _ => 0,
                };
                let p = [2i64, 3, 5][(rng.next() % 3) as usize];
                for row in rows.iter_mut().take(kk.min(n.saturating_sub(1))) {
                    for v in row.iter_mut() {
                        *v = &*v * BigInt::from(p);
                    }
                }
                if fam == "singular" && n >= 2 {
                    rows[n - 1] = rows[0].iter().zip(&rows[1]).map(|(x, y)| x + y).collect();
                }
                out.push(ZMat::from_rows(rows));
            }
        }
    }
    out
}

/// Runs one input and gathers its row (the estimates under `c`).
fn measure(a: ZMat, c: &Constants) -> Row {
    let (n, cols) = (a.rows, a.cols);
    let lower = estimate::cost(&a).work_lower;
    let t0 = tallied();
    let f = smith_form(&a).expect("smith_form");
    let actual = total(&diff(&t0, &tallied()));
    let (_, vinv) = last_small_smith_sizes();
    let mut row = Row {
        route: f.route,
        k: 0,
        n,
        actual,
        lower,
        attempts: f.attempts,
        h: 0.0,
        delta_bits: 0,
        word: true,
        part_a: 0,
        part_a_base: 0,
        e_word: true,
        vinv: 0,
        rest: 0,
        stage1: None,
        beside: None,
        stage2: None,
        a: ZMat::zero(0, 0),
        nm: None,
    };
    let s1 = estimate::stage1_with(&a, c);
    row.stage1 = s1.units.as_ref().map(total);
    if f.route == Route::Classical || cols != n {
        // (no estimate for the classical route: stage 1 reports none on a
        // shape it can see; stage 2 below on the rest)
        if cols != n {
            assert!(s1.units.is_none(), "a non-square input has no estimate");
        }
        if let Some((nm, den, det)) = (cols == n).then(|| zmat::inverse_det(&a)).flatten() {
            let inv = invariants_nonsingular(&a, &det.abs(), Some((nm.mul(&zmat::det_rhs(n)), den.clone())));
            assert!(estimate::stage2_with(&a, &nm, &den, &det, Some(&inv), c).is_none(), "the classical route has no stage 2 estimate");
        }
        return row;
    }
    row.beside = s1.beside_route2.as_ref().map(total);
    row.h = zmat::hadamard_bits(&a);
    let t2 = tallied();
    let (nm, den, det) = zmat::inverse_det(&a).unwrap();
    let inv_units = total(&diff(&t2, &tallied()));
    row.delta_bits = den.bits();
    row.word = den.bits() < 62;
    row.rest = actual.saturating_sub(inv_units);
    let dabs = det.abs();
    let mut invariants = vec![];
    if f.route == Route::Trailing {
        let t4 = tallied();
        invariants = invariants_nonsingular(&a, &dabs, Some((nm.mul(&zmat::det_rhs(n)), den.clone())));
        row.part_a = total(&diff(&t4, &tallied()));
        row.k = invariants.iter().filter(|x| !x.is_one()).count();
        let e = &dabs / &den;
        let la = (a.d.iter().map(limbs).sum::<usize>() as f64 / (n * n) as f64).round().max(1.0) as usize;
        let ln = (nm.d.iter().map(limbs).sum::<usize>() as f64 / (n * n) as f64).round().max(1.0) as usize;
        row.part_a_base = total(&part_a_model(n, la, ln, limbs(&den), limbs(&dabs), limbs(&e), e.bits() < 62, 0.0));
        row.e_word = e.bits() < 62;
        row.vinv = vinv;
    } else {
        row.k = 1;
    }
    row.stage2 = estimate::stage2_with(&a, &nm, &den, &det, Some(&invariants), c).map(|u| total(&u));
    row.a = a;
    row.nm = Some((nm, den, det, invariants));
    row
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = v.len();
    if m % 2 == 1 {
        v[m / 2]
    } else {
        (v[m / 2 - 1] + v[m / 2]) / 2.0
    }
}

fn p90(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let i = (9 * v.len()).div_ceil(10).max(1) - 1;
    v[i]
}

fn sym(a: u64, e: u64) -> f64 {
    let (a, e) = (a as f64, e.max(1) as f64);
    (a / e).max(e / a)
}

/// The five quantities fitted from raw measurements (attempts, the gap,
/// part A's cubic term, V_2^-1 for k >= 3 over delta's limbs), then the scales, the
/// geometric mean of the remaining work's actual over its unscaled model.
fn refit(train: &[Row]) -> Constants {
    let routed = |r: &&Row| r.route != Route::Classical;
    let mean = |v: Vec<f64>| v.iter().sum::<f64>() / v.len() as f64;
    let a1 = mean(train.iter().filter(routed).filter(|r| r.route == Route::Cyclic).map(|r| r.attempts as f64).collect());
    let a2 = mean(train.iter().filter(routed).filter(|r| r.route == Route::Trailing).map(|r| r.attempts as f64).collect());
    let gap = median(train.iter().filter(|r| r.route == Route::Cyclic && r.n >= 6).map(|r| (r.h - r.delta_bits as f64) / r.n as f64).collect());
    let ca = median(train.iter().filter(|r| r.route == Route::Trailing && r.n >= 8 && r.e_word && r.part_a > 0).map(|r| (r.part_a as f64 - r.part_a_base as f64) / (r.n as f64).powi(3)).collect()).max(0.05);
    let fv = median(train.iter().filter(|r| r.route == Route::Trailing && r.k >= 3 && r.vinv > 0 && r.delta_bits > 64).map(|r| r.vinv as f64 / r.delta_bits.div_ceil(64) as f64).collect());
    let round3 = |x: f64| (x * 1000.0).round() / 1000.0;
    let mut c = Constants {
        attempts_cyclic: round3(a1),
        attempts_trailing: round3(a2),
        hadamard_gap: round3(gap),
        part_a_cubic: round3(ca),
        multiplier: estimate::FITTED.multiplier,
        vinv_of_delta: round3(fv),
        scale: [1.0; 4],
        fit_head: estimate::FITTED.fit_head,
        fit_from: estimate::FITTED.fit_from,
    };
    // the scales: stage 2's remaining work under unit scales, actual over model
    let mut logs: [Vec<f64>; 4] = Default::default();
    for r in train.iter().filter(routed) {
        let (nm, den, det, inv) = r.nm.as_ref().unwrap();
        let with = |c: &Constants| total(&estimate::stage2_with(&r.a, nm, den, det, Some(inv), c).unwrap());
        let mut zero = c;
        zero.scale = [0.0; 4];
        let model = with(&c).saturating_sub(with(&zero));
        let slot = match (r.route, r.word) {
            (Route::Cyclic, true) => 0,
            (Route::Cyclic, false) => 1,
            (_, true) => 2,
            _ => 3,
        };
        logs[slot].push((r.rest as f64 / model.max(1) as f64).ln());
    }
    for (i, l) in logs.iter().enumerate() {
        c.scale[i] = round3((l.iter().sum::<f64>() / l.len().max(1) as f64).exp());
    }
    c
}

/// Appends a corpus's rows to the report, written out at once.
fn log_rows(report: &mut String, path: &std::path::Path, head: &str, set: &str, seed: u64, rows: &[Row]) {
    for r in rows {
        report.push_str(&format!(
            "{head} {set} {seed} n={} route={:?} k={} attempts={} delta_bits={} actual={} L={} stage1={:?} beside={:?} stage2={:?} vinv={}\n",
            r.n, r.route, r.k, r.attempts, r.delta_bits, r.actual, r.lower, r.stage1, r.beside, r.stage2, r.vinv
        ));
    }
    std::fs::write(path, report.as_bytes()).expect("the report");
}

#[test]
fn the_estimate_is_fitted_and_scores_within_its_ceilings() {
    // the tested tree's commit (on a pull request, the merge CI tests), from
    // the checkout, else GITHUB_SHA
    let head = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .or_else(|| std::env::var("GITHUB_SHA").ok())
        .unwrap_or_else(|| "unknown".into());
    let report_path = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("smith-estimate-rows.txt");
    let mut report = String::new();
    println!(
        "smith estimate test at {head}; the constants model the run path at {} ({}); rows in {}",
        estimate::FITTED.fit_head,
        estimate::FITTED.fit_from,
        report_path.display()
    );
    // the training corpus, measured under unit constants for the refit
    let mut unit = estimate::FITTED;
    unit.scale = [1.0; 4];
    let train: Vec<Row> = corpus("base", 1).into_iter().map(|a| measure(a, &unit)).collect();
    log_rows(&mut report, &report_path, &head, "base-train", 1, &train);
    let fitted = refit(&train);
    assert_eq!(fitted, estimate::FITTED, "the constants refit at this head differ from estimate::FITTED: refit and record them");
    // the held-out corpora under the recorded constants
    let c = estimate::FITTED;
    for (set, seed) in [("base", 2u64), ("base", 3), ("shift", 4)] {
        let rows: Vec<Row> = corpus(set, seed).into_iter().map(|a| measure(a, &c)).collect();
        log_rows(&mut report, &report_path, &head, set, seed, &rows);
        for r in &rows {
            assert!(r.actual >= r.lower, "{set} {seed}: L = {} above the run's {} units", r.lower, r.actual);
        }
        // classical runs stage 1 gave an estimate for (square inputs that
        // turned out singular or with k > K_MAX: unknown before the run)
        let surprised: Vec<f64> = rows.iter().filter(|r| r.route == Route::Classical && r.stage1.is_some()).map(|r| sym(r.actual, r.stage1.unwrap())).collect();
        if !surprised.is_empty() {
            println!("{set} seed {seed}: {} classical runs had a stage 1 estimate (unscored; worst ratio {:.1})", surprised.len(), surprised.iter().cloned().fold(0.0, f64::max));
        }
        // route 2 by k: V_2^-1 as run against the model's size, both in
        // delta's limbs, and stage 2's k
        for kk in 2..=K_MAX {
            let rk: Vec<&Row> = rows.iter().filter(|r| r.route == Route::Trailing && r.k == kk).collect();
            if rk.is_empty() {
                continue;
            }
            let big: Vec<&&Row> = rk.iter().filter(|r| r.delta_bits > 64).collect();
            let run = if big.is_empty() { f64::NAN } else { median(big.iter().map(|r| r.vinv as f64 / r.delta_bits.div_ceil(64) as f64).collect()) };
            let model = if big.is_empty() {
                f64::NAN
            } else {
                median(
                    big.iter()
                        .map(|r| {
                            let ld = r.delta_bits.div_ceil(64);
                            let kb = (usize::BITS - kk.leading_zeros()) as u64;
                            let bound = (3 * (kk as u64 - 1) * (r.delta_bits + 1) + 2 * kb + 2).div_ceil(64);
                            let lvi = if kk <= 2 { ld } else { ((c.vinv_of_delta * ld as f64).round() as u64).max(ld) };
                            lvi.min(bound.max(ld)) as f64 / ld as f64
                        })
                        .collect(),
                )
            };
            println!("    k={kk}: {} rows, stage 2 k {:.2}; V_2^-1 in delta's limbs: run {run:.2}, model {model:.2}", rk.len(), p90(rk.iter().map(|r| sym(r.actual, r.stage2.unwrap())).collect()));
        }
        let routed: Vec<&Row> = rows.iter().filter(|r| r.route != Route::Classical).collect();
        let k_op = p90(routed.iter().map(|r| sym(r.actual, r.stage1.unwrap())).collect());
        let k_op_max = routed.iter().map(|r| sym(r.actual, r.stage1.unwrap())).fold(0.0, f64::max);
        let r1: Vec<&&Row> = routed.iter().filter(|r| r.route == Route::Cyclic).collect();
        let r2: Vec<&&Row> = routed.iter().filter(|r| r.route == Route::Trailing).collect();
        let k1s1 = p90(r1.iter().map(|r| sym(r.actual, r.stage1.unwrap())).collect());
        let k1s2 = p90(r1.iter().map(|r| sym(r.actual, r.stage2.unwrap())).collect());
        let k2s2 = p90(r2.iter().map(|r| sym(r.actual, r.stage2.unwrap())).collect());
        let kb = p90(r2.iter().map(|r| sym(r.actual, r.beside.unwrap())).collect());
        let kmax = r2.iter().map(|r| r.k).max().unwrap_or(0);
        println!("{set} seed {seed}: rows {} (classical {}), k: stage 1 per op {k_op:.2} (max {k_op_max:.2}), route 1 stage 1 {k1s1:.2} stage 2 {k1s2:.2}, route 2 stage 2 {k2s2:.2} (k <= {kmax}), beside {kb:.2}", rows.len(), rows.len() - routed.len());
        assert!(kmax <= K_MAX);
        assert!(k_op <= 3.5, "{set} {seed}: stage 1 per op k {k_op:.2} > 3.5");
        assert!(k1s1 <= 2.5, "{set} {seed}: route 1 stage 1 k {k1s1:.2} > 2.5");
        assert!(k1s2 <= 2.0, "{set} {seed}: route 1 stage 2 k {k1s2:.2} > 2.0");
        assert!(k2s2 <= 2.5, "{set} {seed}: route 2 stage 2 k {k2s2:.2} > 2.5");
        assert!(kb <= 2.5, "{set} {seed}: the beside line's k {kb:.2} > 2.5");
    }
    let _ = trailing_model;
}
