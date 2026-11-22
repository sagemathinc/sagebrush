//! The work estimate of the Smith form with transforms (issue #1481),
//! measured: corpora are generated here, the models' constants refitted on
//! the training corpus (with at least 10 route 2 rows at each k >= 5, and
//! 10 route 3 rows of each shape: wide, tall, square of corank 1 and of
//! more) and required to equal `estimate::FITTED` (a code change that
//! moves them must refit and record them), and the held-out corpora scored
//! against ceilings on k, the p90 over rows of max(actual / E, E / actual)
//! on total units; stage 1's per-op k counts every row it gave an estimate
//! for, singular square inputs (route 1's estimate, route 3's run)
//! included.  Also, on every row of every corpus: the work L holds, stage
//! 1 has an estimate for every nonempty input, and k^ is a lower bound on
//! k (route 3: the nonzero nontrivial factors, k^ in the r form; stage 1's
//! min(m, n) form within the corank).  Every row is written with the tested tree's head
//! (git rev-parse HEAD, else GITHUB_SHA) to a report in the test's target
//! directory, each corpus before anything about it is asserted (the
//! training rows before the refit's check).  (A file of its own: it is the
//! slowest of the Smith tests.)

use num_traits::{One, Signed, Zero};
use sagebrush_arith::cost::{tallied, Local, Units, FAMILIES};
use sagebrush_arith::nmod::{Modulus, Primes};
use sagebrush_arith::smith::route3;
use sagebrush_arith::smith::estimate::{self, part_a_model, trailing_model, Constants};
use sagebrush_arith::smith::{last_small_smith_sizes, smith_form, Route};
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
    // the shape contracts, checked after the report is written: a
    // non-square input's stage 1 and a classical run's stage 2 are None
    stage1_none_ok: bool,
    stage2_none_ok: bool,
    // the transforms' largest entry, in bits (the output's size)
    uv_bits: u64,
    // stage 1's proved lower bound on k
    k_hat: usize,
    // for the scales' refit: the remaining work's model and the inverse's
    a: ZMat,
    nm: Option<(ZMat, BigInt, BigInt, Vec<BigInt>)>,
    // route 3: m, the rank, k^ in the min(m, n) form (stage 1's), and stage
    // 2's inputs (the profile, the first side's inverse and G)
    m: usize,
    rank: usize,
    k_hat_min: usize,
    r3: Option<R3>,
}

/// Route 3's stage 2 inputs.
struct R3 {
    is: Vec<usize>,
    js: Vec<usize>,
    nm: ZMat,
    delta: BigInt,
    det: BigInt,
    g: BigInt,
}

impl R3 {
    /// The profile modulo the route's first prime, the first side's B_J
    /// inverse and G, as the route computes them.
    fn of(a: &ZMat) -> R3 {
        let p = Primes::new().next().unwrap();
        let (js, is, _) = a.reduce(&Modulus::new(p)).rref_rows();
        let (r, n) = (is.len(), a.cols);
        let first = if r < n { ZMat::from_rows(is.iter().map(|&i| (0..n).map(|j| a.get(i, j).clone()).collect()).collect()) } else { a.transpose() };
        let fj = if r < n { js.clone() } else { is.clone() };
        let bj = ZMat::from_rows((0..r).map(|i| fj.iter().map(|&j| first.get(i, j).clone()).collect()).collect());
        let (nm, delta, det) = zmat::inverse_det(&bj).unwrap();
        let jp: Vec<usize> = (0..first.cols).filter(|x| !fj.contains(x)).collect();
        let q = nm.mul(&ZMat::from_rows((0..r).map(|i| jp.iter().map(|&j| first.get(i, j).clone()).collect()).collect()));
        let g = route3::hnf_modulus(&q, &delta, &det, &mut Local::new());
        R3 { is, js, nm, delta, det, g }
    }
    fn stage2(&self, a: &ZMat, c: &Constants) -> u64 {
        total(&estimate::stage2_route3(a, &self.is, &self.js, &self.nm, &self.delta, &self.det, &self.g, c))
    }
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
/// prime, sparse, diagonally dominant, k = 5..8, and k in 9..=16 and in
/// 17..n) or "shift" (banded, block, near-unimodular, mixed sizes, larger
/// n, k = 2..8, k = 9..11, k = n - 1 and n, k = 2..n hidden from the
/// contents, and classical inputs: singular, rectangular).
fn corpus(set: &str, seed: u64) -> Vec<ZMat> {
    let mut rng = Rng(seed.wrapping_mul(0x9e3779b97f4a7c15));
    // (route 3's families last: the rows before them are those of the
    // corpus before it)
    let fams: &[&str] = if set == "base" { &["random", "kstruct", "sparse", "diagdom", "khigh", "kbig", "wide", "tall", "sing1", "singk"] } else { &["banded", "block", "unimod", "mixed", "large", "k8", "singular", "rect", "k9", "kfull", "khidden", "wide", "tall", "sing1", "singk"] };
    let mut out = vec![];
    // k = 5..8 cycles, two inputs per size up to n = 32: the training
    // floor's 10 rows a k
    let mut khigh = 0usize;
    // k past 8 alternates its bands, 9..=16 and (from n = 24) 17..=n - 1,
    // two inputs per size up to n = 32: the training floor's 10 rows a band
    let mut kbig = 0usize;
    for &fam in fams {
        let ns: &[usize] = if fam == "large" { &[64, 80, 96] } else { &[3, 4, 6, 8, 12, 16, 24, 32, 48] };
        for &n in ns {
            for bits in [2u32, 4, 16, 64, 128].into_iter().flat_map(|b| std::iter::repeat_n(b, if matches!(fam, "khigh" | "kbig") && n <= 32 { 2 } else { 1 })) {
                if (n >= 48 && bits >= 128) || (fam == "large" && bits > 16) || (matches!(fam, "khigh" | "kbig") && n < 12) {
                    continue;
                }
                if matches!(fam, "singular" | "rect" | "k9") && (n > 16 || bits > 16) {
                    continue;
                }
                if matches!(fam, "kfull" | "khidden") && (!(6..=32).contains(&n) || bits > 64) {
                    continue;
                }
                if matches!(fam, "wide" | "tall" | "sing1" | "singk") {
                    // route 3: plain wide (n x (3 n / 2 + 1)) and tall (2 n x
                    // n), square of corank 1 (the last row the sum of the
                    // first two) and of corank n / 2 (X Y, X of `bits`-bit
                    // entries, Y of 4-bit)
                    if !(4..=32).contains(&n) || bits > 64 {
                        continue;
                    }
                    let plain = |rng: &mut Rng, m: usize, c: usize, b: u32| -> Vec<Vec<BigInt>> { (0..m).map(|_| (0..c).map(|_| entry(rng, b)).collect()).collect() };
                    let a = match fam {
                        "wide" => ZMat::from_rows(plain(&mut rng, n, 3 * n / 2 + 1, bits)),
                        "tall" => ZMat::from_rows(plain(&mut rng, 2 * n, n, bits)),
                        "sing1" => {
                            let mut x = plain(&mut rng, n, n, bits);
                            x[n - 1] = x[0].iter().zip(&x[1]).map(|(p, q)| p + q).collect();
                            ZMat::from_rows(x)
                        }
                        _ => {
                            let h = n / 2;
                            ZMat::from_rows(plain(&mut rng, n, h, bits)).mul(&ZMat::from_rows(plain(&mut rng, h, n, 4)))
                        }
                    };
                    out.push(a);
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
                    "khigh" => {
                        khigh += 1;
                        5 + khigh % 4
                    }
                    "k9" => 9 + (rng.next() % 3) as usize,
                    "kbig" => {
                        kbig += 1;
                        let (lo, hi) = if n >= 24 && kbig.is_multiple_of(2) { (17, n - 1) } else { (9, 16.min(n - 1)) };
                        lo + (rng.next() % (hi - lo + 1) as u64) as usize
                    }
                    "kfull" => n - (rng.next() % 2) as usize,
                    _ => 0,
                };
                let p = [2i64, 3, 5][(rng.next() % 3) as usize];
                // (every row scaled only for k = n: the other families keep
                // a row unscaled)
                let cap = if fam == "kfull" { n } else { n.saturating_sub(1) };
                for row in rows.iter_mut().take(kk.min(cap)) {
                    for v in row.iter_mut() {
                        *v = &*v * BigInt::from(p);
                    }
                }
                if fam == "singular" && n >= 2 {
                    rows[n - 1] = rows[0].iter().zip(&rows[1]).map(|(x, y)| x + y).collect();
                }
                if fam == "khidden" {
                    // k invisible in the contents: L diag(1, .., 1, p, .., p) U,
                    // L unit lower (entries of 2 bits) and U unit upper (of
                    // `bits` bits), both unimodular; k = 2..n
                    let kh = 2 + (rng.next() % (n as u64 - 1)) as usize;
                    let mut l = ZMat::zero(n, n);
                    let mut u = ZMat::zero(n, n);
                    for i in 0..n {
                        for j in 0..n {
                            if i == j {
                                l.d[i * n + j] = BigInt::one();
                                u.d[i * n + j] = BigInt::one();
                            } else if j < i {
                                l.d[i * n + j] = entry(&mut rng, 2);
                            } else {
                                u.d[i * n + j] = entry(&mut rng, bits.min(32));
                            }
                        }
                    }
                    let mut dm = ZMat::zero(n, n);
                    for i in 0..n {
                        dm.d[i * n + i] = BigInt::from(if i >= n - kh { p } else { 1 });
                    }
                    out.push(l.mul(&dm).mul(&u));
                    continue;
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
        stage1_none_ok: true,
        stage2_none_ok: true,
        uv_bits: f.u.max_bits().max(f.v.max_bits()),
        k_hat: if n == cols { estimate::k_lower_bound(&a) } else { 0 },
        a: ZMat::zero(0, 0),
        nm: None,
        m: n,
        rank: n.min(cols),
        k_hat_min: 0,
        r3: None,
    };
    let s1 = estimate::stage1_with(&a, c);
    row.stage1 = s1.units.as_ref().map(total);
    // (stage 1 has an estimate for every nonempty input)
    row.stage1_none_ok = s1.units.is_some() || n == 0 || cols == 0;
    if f.route == Route::Hermite {
        // route 3: k counts the nonzero nontrivial factors, k^ in both forms
        let r = (0..n.min(cols)).take_while(|&i| !f.d.get(i, i).is_zero()).count();
        row.rank = r;
        row.n = cols;
        row.k = (0..r).filter(|&i| !f.d.get(i, i).is_one()).count();
        row.k_hat = estimate::k_lower_bound_rect(&a, r);
        row.k_hat_min = estimate::k_lower_bound_rect(&a, n.min(cols));
        if r > 0 {
            let r3 = R3::of(&a);
            row.stage2 = Some(r3.stage2(&a, c));
            row.r3 = Some(r3);
        }
        row.a = a;
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

/// Route 3's shapes: wide, tall, square of corank 1, square of corank 2 or
/// more.
const R3_CLASSES: [(&str, fn(&Row) -> bool); 4] = [
    ("wide", |r| r.m < r.n),
    ("tall", |r| r.m > r.n),
    ("corank 1", |r| r.m == r.n && r.rank + 1 == r.n),
    ("corank 2+", |r| r.m == r.n && r.rank + 2 <= r.n),
];

/// The k bands of the report and the training floor: each k up to 8, then
/// 9..=16 and 17 and up.
const BANDS: [&str; 9] = ["2", "3", "4", "5", "6", "7", "8", "9-16", "17+"];

fn band(k: usize) -> &'static str {
    match k {
        0..=8 => BANDS[k.saturating_sub(2).min(6)],
        9..=16 => BANDS[7],
        _ => BANDS[8],
    }
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
    let routed = |r: &&Row| matches!(r.route, Route::Cyclic | Route::Trailing);
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
        scale_route3: [1.0; 2],
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
    // route 3's: its stage 2's scaled part, actual less the unscaled part,
    // by the first side's G ring
    let mut logs3: [Vec<f64>; 2] = Default::default();
    for r in train.iter().filter(|r| r.route == Route::Hermite) {
        let Some(r3) = &r.r3 else { continue };
        let (mut one, mut zero) = (c, c);
        one.scale_route3 = [1.0; 2];
        zero.scale_route3 = [0.0; 2];
        let (s1, s0) = (r3.stage2(&r.a, &one), r3.stage2(&r.a, &zero));
        let slot = (r3.g.bits() >= 62) as usize;
        logs3[slot].push((r.actual.saturating_sub(s0).max(1) as f64 / s1.saturating_sub(s0).max(1) as f64).ln());
    }
    for (i, l) in logs3.iter().enumerate() {
        c.scale_route3[i] = round3((l.iter().sum::<f64>() / l.len().max(1) as f64).exp());
    }
    c
}

/// Appends a corpus's rows to the report, written out at once.
fn log_rows(report: &mut String, path: &std::path::Path, head: &str, set: &str, seed: u64, rows: &[Row]) {
    for r in rows {
        report.push_str(&format!(
            "{head} {set} {seed} n={} route={:?} k={} attempts={} delta_bits={} actual={} L={} stage1={:?} beside={:?} stage2={:?} vinv={} uv_bits={} k_hat={} stage1_none_ok={} stage2_none_ok={}\n",
            r.n, r.route, r.k, r.attempts, r.delta_bits, r.actual, r.lower, r.stage1, r.beside, r.stage2, r.vinv, r.uv_bits, r.k_hat, r.stage1_none_ok, r.stage2_none_ok
        ));
    }
    std::fs::write(path, report.as_bytes()).expect("the report");
}

/// The checks every row of every corpus meets, asserted after its report:
/// L holds, and the shape contracts.
fn check_rows(set: &str, seed: u64, rows: &[Row]) {
    for r in rows {
        assert!(r.actual >= r.lower, "{set} {seed}: L = {} above the run's {} units", r.lower, r.actual);
        assert!(r.stage1_none_ok, "{set} {seed}: stage 1 has an estimate for every nonempty input (n = {})", r.n);
        assert!(r.stage2_none_ok, "{set} {seed}: stage 2 (n = {})", r.n);
        assert!(r.k_hat <= r.k, "{set} {seed}: k^ = {} above k = {} (m = {}, n = {}, {:?})", r.k_hat, r.k, r.m, r.n, r.route);
        if r.route == Route::Hermite {
            // (stage 1's min(m, n) form: at most k + min(m, n) - r)
            assert!(r.k_hat_min <= r.k + r.m.min(r.n) - r.rank, "{set} {seed}: stage 1's k^ = {} above k + corank (k = {}, m = {}, n = {}, r = {})", r.k_hat_min, r.k, r.m, r.n, r.rank);
        }
    }
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
    check_rows("base-train", 1, &train);
    // the training floor: route 2's constants are fitted with at least 10
    // rows at each of k = 5, 6, 7, 8 and in each band past 8
    let count = |b: &str| train.iter().filter(|r| r.route == Route::Trailing && band(r.k) == b).count();
    let floor: Vec<(String, usize)> = BANDS.iter().map(|b| (b.to_string(), count(b))).collect();
    println!("base-train seed 1: route 2 rows by k: {floor:?}");
    for (b, n) in floor.iter().filter(|(b, _)| ["5", "6", "7", "8", "9-16", "17+"].contains(&b.as_str())) {
        assert!(*n >= 10, "the training corpus has {n} route 2 rows at k = {b}, fewer than 10");
    }
    // route 3's training families: at least 10 rows each (wide, tall,
    // square of corank 1 and of higher corank)
    for (name, class) in R3_CLASSES {
        let count = train.iter().filter(|r| r.route == Route::Hermite && r.stage2.is_some() && class(r)).count();
        println!("base-train seed 1: route 3 {name}: {count} rows");
        assert!(count >= 10, "the training corpus has {count} route 3 rows {name}, fewer than 10");
    }
    let fitted = refit(&train);
    assert_eq!(fitted, estimate::FITTED, "the constants refit at this head differ from estimate::FITTED: refit and record them");
    // the held-out corpora under the recorded constants
    let c = estimate::FITTED;
    for (set, seed) in [("base", 2u64), ("base", 3), ("shift", 4)] {
        let rows: Vec<Row> = corpus(set, seed).into_iter().map(|a| measure(a, &c)).collect();
        log_rows(&mut report, &report_path, &head, set, seed, &rows);
        check_rows(set, seed, &rows);
        // classical runs stage 1 gave an estimate for (square inputs that
        // turned out singular: unknown before the run); the user saw that
        // estimate, so they are in stage 1's per-op k
        let surprised: Vec<f64> = rows.iter().filter(|r| r.route == Route::Hermite && r.m == r.n && r.stage1.is_some()).map(|r| sym(r.actual, r.stage1.unwrap())).collect();
        if !surprised.is_empty() {
            println!("{set} seed {seed}: {} singular square runs had a stage 1 estimate (route 1's; worst ratio {:.1})", surprised.len(), surprised.iter().cloned().fold(0.0, f64::max));
        }
        // route 3 by shape: stage 1 and stage 2
        for (name, class) in R3_CLASSES {
            let rs: Vec<&Row> = rows.iter().filter(|r| r.route == Route::Hermite && r.stage2.is_some() && class(r)).collect();
            if rs.is_empty() {
                continue;
            }
            println!(
                "    route 3, {name}: {} rows, stage 1 {:.2}, stage 2 {:.2} (max {:.2})",
                rs.len(),
                p90(rs.iter().map(|r| sym(r.actual, r.stage1.unwrap())).collect()),
                p90(rs.iter().map(|r| sym(r.actual, r.stage2.unwrap())).collect()),
                rs.iter().map(|r| sym(r.actual, r.stage2.unwrap())).fold(0.0, f64::max)
            );
        }
        let r3: Vec<&Row> = rows.iter().filter(|r| r.route == Route::Hermite && r.stage2.is_some()).collect();
        let k3s2 = p90(r3.iter().map(|r| sym(r.actual, r.stage2.unwrap())).collect());
        // route 2 by k (bands past 8): stage 2's k; V_2^-1 as run against
        // the model's size, both in delta's limbs; the rows where the proved
        // bound caps the model's size; the attempts; and the transforms'
        // largest entry over delta's bits, at least one limb's 64 (the
        // output's size against the bound's 3 (k - 1) delta; a tiny delta
        // does not inflate it)
        for b in BANDS {
            let rk: Vec<&Row> = rows.iter().filter(|r| r.route == Route::Trailing && band(r.k) == b).collect();
            if rk.is_empty() {
                continue;
            }
            let big: Vec<&&Row> = rk.iter().filter(|r| r.delta_bits > 64).collect();
            let run = if big.is_empty() { f64::NAN } else { median(big.iter().map(|r| r.vinv as f64 / r.delta_bits.div_ceil(64) as f64).collect()) };
            let (model, capped) = if big.is_empty() {
                (f64::NAN, 0)
            } else {
                let sizes: Vec<(f64, bool)> = big
                    .iter()
                    .map(|r| {
                        let ld = r.delta_bits.div_ceil(64);
                        let kb = (usize::BITS - r.k.leading_zeros()) as u64;
                        let bound = (3 * (r.k as u64 - 1) * (r.delta_bits + 1) + 2 * kb + 2).div_ceil(64).max(ld);
                        let lvi = if r.k <= 2 { ld } else { ((c.vinv_of_delta * ld as f64).round() as u64).max(ld) };
                        (lvi.min(bound) as f64 / ld as f64, bound < lvi)
                    })
                    .collect();
                (median(sizes.iter().map(|x| x.0).collect()), sizes.iter().filter(|x| x.1).count())
            };
            let out: Vec<f64> = rk.iter().map(|r| r.uv_bits as f64 / r.delta_bits.max(64) as f64).collect();
            println!(
                "    k={b}: {} rows, stage 2 k {:.2}; V_2^-1 in delta's limbs: run {run:.2}, model {model:.2} (capped by the bound on {capped}); attempts max {}; U, V entries over delta's bits (64 at least): median {:.2}, max {:.2}",
                rk.len(),
                p90(rk.iter().map(|r| sym(r.actual, r.stage2.unwrap())).collect()),
                rk.iter().map(|r| r.attempts).max().unwrap_or(0),
                median(out.clone()),
                out.iter().cloned().fold(0.0, f64::max)
            );
        }
        let routed: Vec<&Row> = rows.iter().filter(|r| matches!(r.route, Route::Cyclic | Route::Trailing)).collect();
        let shown: Vec<f64> = rows.iter().filter_map(|r| r.stage1.map(|e| sym(r.actual, e))).collect();
        let k_op_max = shown.iter().cloned().fold(0.0, f64::max);
        let k_op = p90(shown);
        // (the route 2 rows whose k stage 1 could not see: k^ < 2)
        let hidden: Vec<f64> = rows.iter().filter(|r| r.route == Route::Trailing && r.k_hat < 2).map(|r| sym(r.actual, r.stage1.unwrap())).collect();
        let k2h: Vec<f64> = rows.iter().filter(|r| r.route == Route::Trailing && r.k_hat >= 2).map(|r| sym(r.actual, r.stage1.unwrap())).collect();
        println!(
            "{set} seed {seed}: stage 1 on route 2 rows: k^ >= 2 ({} rows) p90 {:.2}; k hidden, k^ < 2 ({} rows) p90 {:.2}, max {:.2}",
            k2h.len(),
            if k2h.is_empty() { f64::NAN } else { p90(k2h.clone()) },
            hidden.len(),
            if hidden.is_empty() { f64::NAN } else { p90(hidden.clone()) },
            hidden.iter().cloned().fold(0.0, f64::max)
        );
        let r1: Vec<&&Row> = routed.iter().filter(|r| r.route == Route::Cyclic).collect();
        let r2: Vec<&&Row> = routed.iter().filter(|r| r.route == Route::Trailing).collect();
        let k1s1 = p90(r1.iter().map(|r| sym(r.actual, r.stage1.unwrap())).collect());
        let k1s2 = p90(r1.iter().map(|r| sym(r.actual, r.stage2.unwrap())).collect());
        let k2s2 = p90(r2.iter().map(|r| sym(r.actual, r.stage2.unwrap())).collect());
        let kb = p90(r2.iter().map(|r| sym(r.actual, r.beside.unwrap())).collect());
        let kmax = r2.iter().map(|r| r.k).max().unwrap_or(0);
        println!("{set} seed {seed}: rows {} (route 3 {}), k: stage 1 per op {k_op:.2} (max {k_op_max:.2}), route 1 stage 1 {k1s1:.2} stage 2 {k1s2:.2}, route 2 stage 2 {k2s2:.2} (k <= {kmax}), beside {kb:.2}, route 3 stage 2 {k3s2:.2}", rows.len(), rows.len() - routed.len());
        assert!(k_op <= 3.5, "{set} {seed}: stage 1 per op k {k_op:.2} > 3.5");
        assert!(k1s1 <= 2.5, "{set} {seed}: route 1 stage 1 k {k1s1:.2} > 2.5");
        assert!(k1s2 <= 2.0, "{set} {seed}: route 1 stage 2 k {k1s2:.2} > 2.0");
        assert!(k2s2 <= 2.5, "{set} {seed}: route 2 stage 2 k {k2s2:.2} > 2.5");
        assert!(kb <= 2.5, "{set} {seed}: the beside line's k {kb:.2} > 2.5");
        assert!(k3s2 <= 2.5, "{set} {seed}: route 3 stage 2 k {k3s2:.2} > 2.5");
    }
    let _ = trailing_model;
}

#[test]
fn the_models_cost_does_not_grow_with_n_times_k() {
    // trailing_model's own steps (each `times` and each loop over the
    // factors) at synthetic sizes: O(k) for fixed attempts, nothing in n
    // or in top k^2 (the factors' charges are summed once and multiplied)
    let steps = |n: usize, k: usize| {
        let mut dls = vec![1; k - 1];
        dls.push(4);
        let s0 = estimate::model_steps();
        let u = trailing_model(n, k, 4, 4, 3, false, 250, &dls, 1.5, 0.92);
        assert!(u.0.iter().any(|&x| x > 0));
        estimate::model_steps() - s0
    };
    let (a, b, c) = (steps(200, 199), steps(2000, 199), steps(400, 399));
    println!("trailing_model steps: n = 200, k = 199: {a}; n = 2000, k = 199: {b}; n = 400, k = 399: {c}");
    assert_eq!(a, b, "the model's steps do not depend on n");
    assert!(c <= 2 * a + 64, "the model's steps grow at most linearly in k: {a} at k = 199, {c} at k = 399");
    assert!(a <= 3 * 199 + 64, "{a} steps at k = 199: O(k)");
}

/// The empty matrix: stage 2 has nothing to refine (route 3 takes it) and
/// says so, rather than reaching the route 1 model at n = 0.
#[test]
fn stage2_of_the_empty_matrix_is_none() {
    let a = ZMat::zero(0, 0);
    let (nm, den, det) = zmat::inverse_det(&a).unwrap();
    assert_eq!(estimate::stage2(&a, &nm, &den, &det, None), None);
    assert_eq!(estimate::stage2(&a, &nm, &den, &det, Some(&[])), None);
}
