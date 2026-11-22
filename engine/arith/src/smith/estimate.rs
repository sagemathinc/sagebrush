//! The work estimate $E$ of the Smith form with transforms (issue #1481;
//! the cost policy: $L$ refuses, $E$ estimates, $U$ promises).
//!
//! $E$ is in meter units per [`Family`], from models that walk each part's
//! own charges at given sizes: the inverse
//! ([`crate::zmat::inverse_model`]: an exact count on dense input), part A
//! ([`part_a_model`]), route 1 ([`cyclic_model`]) and route 2
//! ([`trailing_model`], whose small Smith form's transform sizes are as
//! measured on route 2's runs, capped by its proved bound).
//!
//! Stage 1 ([`stage1`]) is before the run, from the input: the inverse
//! plus the cheaper plausible route (the E route rule) at delta^, which is
//! route 1 unless the rows' and columns' contents prove k >= 2
//! ([`k_lower_bound`]), then route 2 at that bound; route 2 at the bound
//! (at least 2) is beside it; none where it sees the classical
//! elimination follows (a non-square input, a zero row or column), while a
//! square input that turns out singular gets one, since stage 1 cannot
//! know.  Stage 2 ([`stage2`]) is after the inverse and part
//! A, at the actual sizes, and has none for the classical route.
//!
//! The constants ([`FITTED`]) are units-model constants, the same on every
//! target (meter units are integers): fitted on a training corpus, and
//! refitted by the CI test
//! (`tests/smith_estimate.rs`), which also scores held-out corpora against
//! ceilings.  `cost()` reports `work_estimate = None` until the
//! calibration's $k_{\text{machine}}$ lands.

use crate::cost::{bigdiv_units, biggcd_units, bigmul_units, size_product, Cost, Family, Units, FAMILIES};
use crate::zmat::{self, limbs, ZMat};
use num_traits::{One, Signed, Zero};
use sagebrush_bigint::BigInt;

/// The fitted constants of the models.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Constants {
    /// Route 1's mean attempt count.
    pub attempts_cyclic: f64,
    /// Route 2's mean attempt count.
    pub attempts_trailing: f64,
    /// log2 of the Hadamard bound over log2 delta, per row (delta^ = h -
    /// gap n before the run).
    pub hadamard_gap: f64,
    /// Part A's `smith_mod` elimination steps over n^3.
    pub part_a_cubic: f64,
    /// Route 2's elimination multipliers, in sqrt(ld) limbs.
    pub multiplier: f64,
    /// Route 2's V_2^-1 for k >= 3, in multiples of delta's limbs (at k = 2
    /// it is delta's size; the small Smith form's proved bound caps both).
    pub vinv_of_delta: f64,
    /// The remaining work's scale (actual over model, the geometric mean):
    /// route 1 word delta, route 1 big, route 2 word, route 2 big.
    pub scale: [f64; 4],
    /// The head of the run path the constants model (40 characters): the
    /// routes as landed; the models are this file's.
    pub fit_head: &'static str,
    /// Where they were fitted.
    pub fit_from: &'static str,
}

/// The constants in use (the CI test refits them and must match).
/// `fit_head` is the head of the run path whose charges they model (the
/// routes as landed); the models are this file's, and the test refits the
/// values at each head, so a change to either fails it until they are
/// recorded again.
pub const FITTED: Constants = Constants {
    attempts_cyclic: 2.255,
    attempts_trailing: 2.137,
    hadamard_gap: 0.648,
    part_a_cubic: 0.927,
    multiplier: 0.92,
    vinv_of_delta: 1.5,
    scale: [0.548, 0.717, 0.837, 0.436],
    fit_head: "f7c3c93cd71f4d73df5e30851e2d30feb71226bc",
    fit_from: "the estimate test's training corpus (seed 1); the multiplier from route 2's phase data",
};

/// An estimate before the run.
#[derive(Clone, Debug, PartialEq)]
pub struct Estimate {
    /// E: the route 1 estimate (the cheaper plausible route), or None where
    /// stage 1 sees the classical elimination follows (no estimate).
    pub units: Option<Units>,
    /// Route 2's own estimate at the proved lower bound on k (at least 2),
    /// reported beside E.
    pub beside_route2: Option<Units>,
}

fn add_scaled(u: &mut Units, v: &Units, s: f64) {
    for (x, y) in u.0.iter_mut().zip(&v.0) {
        *x = x.saturating_add((*y as f64 * s).round() as u64);
    }
}

thread_local! {
    static STEPS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Counts the models' own work: every `times` and every iteration of a
/// loop over the factors (read by the test that the models' cost does
/// not grow with the matrix's size times k).
fn steps(s: u64) {
    STEPS.with(|c| c.set(c.get().saturating_add(s)));
}

/// The models' steps so far on this thread (see `steps`).
#[doc(hidden)]
pub fn model_steps() -> u64 {
    STEPS.with(|c| c.get())
}

/// u += count times one.
fn times(u: &mut Units, count: u64, one: &Units) {
    steps(1);
    for (x, y) in u.0.iter_mut().zip(&one.0) {
        *x = x.saturating_add(y.saturating_mul(count));
    }
}

/// A model at a fractional attempt count: linear between the whole counts.
fn at_attempts(a: f64, f: impl Fn(u64) -> Units) -> Units {
    let lo = a.floor().max(1.0) as u64;
    let t = (a - lo as f64).clamp(0.0, 1.0);
    let (x, y) = (f(lo), f(lo + 1));
    let mut u = Units::default();
    for i in 0..FAMILIES {
        u.0[i] = ((1.0 - t) * x.0[i] as f64 + t * y.0[i] as f64).round() as u64;
    }
    u
}

fn mean_limbs(m: &ZMat) -> usize {
    if m.d.is_empty() {
        return 1;
    }
    ((m.d.iter().map(limbs).sum::<usize>() as f64) / m.d.len() as f64).round().max(1.0) as usize
}

/// Stage 1: before the run, from the input alone.  None where the
/// classical route visibly follows (non-square input, a zero row or column).
pub fn stage1(a: &ZMat) -> Estimate {
    stage1_with(a, &FITTED)
}

/// [`stage1`] with given constants (the CI test's refit).
#[doc(hidden)]
pub fn stage1_with(a: &ZMat, c: &Constants) -> Estimate {
    let n = a.rows;
    let none = Estimate { units: None, beside_route2: None };
    if a.rows != a.cols || n == 0 {
        return none;
    }
    // (a zero row or column sends the inverse to the classical route)
    let h = zmat::hadamard_bits(a);
    if !h.is_finite() {
        return none;
    }
    let dh = (h - c.hadamard_gap * n as f64).max(1.0).ceil() as u64;
    let lh = (dh as usize).div_ceil(64).max(1);
    let word = dh < 62;
    // route 2 at kk factors: kk - 1 small ones (a word each, and e taken
    // as one word) and delta^
    let route2 = |kk: usize, scale: f64| {
        let mut dls = vec![1; kk - 1];
        dls.push(lh);
        let mut b = zmat::inverse_model(a, lh, 2, Some(1));
        let mut rest = at_attempts(c.attempts_trailing, |t| trailing_model(n, kk, lh, lh, t, word, dh, &dls, c.vinv_of_delta, c.multiplier));
        rest.add_saturating(&part_a_model(n, 1, lh, lh, lh, 1, true, c.part_a_cubic));
        add_scaled(&mut b, &rest, scale);
        b
    };
    // (k >= k^, proved from the rows' and columns' contents: with k^ >= 2
    // route 1 cannot follow, and route 2 at k^ is the cheaper plausible
    // route)
    let kh = k_lower_bound(a);
    let scale2 = c.scale[if word { 2 } else { 3 }];
    let beside = (n > 2 || kh >= 2).then(|| route2(kh.max(2), scale2));
    let e = match &beside {
        Some(b) if kh >= 2 => *b,
        _ => {
            let mut e = zmat::inverse_model(a, lh, 2, None);
            let route = at_attempts(c.attempts_cyclic, |t| cyclic_model(n, lh, lh, t, 2, word, dh));
            add_scaled(&mut e, &route, c.scale[if word { 0 } else { 1 }]);
            e
        }
    };
    let beside = beside.filter(|_| n > 2);
    Estimate { units: Some(e), beside_route2: beside }
}

/// The primes the contents are tested by (k^'s lower bound).
const SMALL_PRIMES: [u64; 25] = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97];

/// A proved lower bound on k, the number of nontrivial invariant factors
/// of a square a, from the input alone in O(n^2) gcds: a = D_c a' with D_c
/// the diagonal of the rows' contents, so a's rank modulo a prime p is at
/// most D_c's, and at least as many invariant factors as rows with p
/// dividing their content are divisible by p; the same for the columns.
/// k^ = the largest such count over the primes below 100.
#[doc(hidden)]
pub fn k_lower_bound(a: &ZMat) -> usize {
    use num_integer::Integer;
    let n = a.rows;
    let mut row = vec![BigInt::zero(); n];
    let mut col = vec![BigInt::zero(); a.cols];
    for (i, ri) in row.iter_mut().enumerate() {
        for (j, cj) in col.iter_mut().enumerate() {
            // (a content of 1 stays 1: its gcds stop there, so random
            // rows cost little past their first few entries)
            let x = a.get(i, j);
            if !x.is_zero() {
                if !ri.is_one() {
                    *ri = ri.gcd(x);
                }
                if !cj.is_one() {
                    *cj = cj.gcd(x);
                }
            }
        }
    }
    steps(1);
    SMALL_PRIMES
        .iter()
        .map(|&p| {
            let p = BigInt::from(p);
            let count = |cs: &[BigInt]| cs.iter().filter(|c| !c.is_zero() && (*c % &p).is_zero()).count();
            count(&row).max(count(&col))
        })
        .max()
        .unwrap_or(0)
}

/// Stage 2: after the inverse (N / delta, det) and, for route 2, part A's
/// invariant factors; at the actual sizes, for any k (route 2 has no
/// threshold).  None without the invariant factors when det a != delta.
/// (The classical route, singular or rectangular input, has no inverse to
/// call this with.)
pub fn stage2(a: &ZMat, nm: &ZMat, delta: &BigInt, det: &BigInt, invariants: Option<&[BigInt]>) -> Option<Units> {
    stage2_with(a, nm, delta, det, invariants, &FITTED)
}

/// [`stage2`] with given constants (the CI test's refit).
#[doc(hidden)]
pub fn stage2_with(a: &ZMat, nm: &ZMat, delta: &BigInt, det: &BigInt, invariants: Option<&[BigInt]>, c: &Constants) -> Option<Units> {
    let n = a.rows;
    let ld = limbs(delta);
    let ln = mean_limbs(nm);
    let word = delta.bits() < 62;
    let dabs = det.abs();
    if &dabs == delta {
        let mut u = zmat::inverse_model(a, ld, 2, None);
        let rest = at_attempts(c.attempts_cyclic, |t| cyclic_model(n, ld, ln, t, 2, word, delta.bits()));
        add_scaled(&mut u, &rest, c.scale[if word { 0 } else { 1 }]);
        return Some(u);
    }
    let inv = invariants?;
    let nontrivial: Vec<&BigInt> = inv.iter().filter(|x| !x.is_one()).collect();
    let k = nontrivial.len();
    if k < 2 || delta.is_zero() {
        return None;
    }
    let e = &dabs / delta;
    let dls: Vec<usize> = nontrivial.iter().map(|x| limbs(x)).collect();
    let mut u = zmat::inverse_model(a, ld, 2, (!e.is_one()).then(|| limbs(&e)));
    let mut rest = part_a_model(n, mean_limbs(a), ln, ld, limbs(&dabs), limbs(&e), e.bits() < 62, c.part_a_cubic);
    rest.add_saturating(&at_attempts(c.attempts_trailing, |t| trailing_model(n, k, ld, ln, t, word, delta.bits(), &dls, c.vinv_of_delta, c.multiplier)));
    add_scaled(&mut u, &rest, c.scale[if word { 2 } else { 3 }]);
    Some(u)
}

/// What is known about the Smith form with transforms' cost before it runs:
/// L (memory: the output's floor; work: m n + m^2 + n^2 Move units, the
/// least any route charges, proved in the design note), E None until the
/// calibration lands ([`stage1`] holds the model), U None.
pub fn cost(a: &ZMat) -> Cost {
    let (m, n) = (a.rows as u64, a.cols as u64);
    let work_lower = m.saturating_mul(n).saturating_add(m.saturating_mul(m)).saturating_add(n.saturating_mul(n));
    Cost { mem_lower: super::floor_bytes(a.rows, a.cols).unwrap_or(u64::MAX), work_lower, work_estimate: None, work_upper: None }
}

/// The units route 1 charges, walked from its loops at given sizes (the
/// work estimate's model): n x n, delta of `ld` limbs, N's entries of `ln`
/// limbs, `attempts` attempts (the last one generates; a failed one folds
/// all n entries of y, the successful one `fold` of them), `word` for
/// delta below 2^62.  Assumes dense rows and the generator's combination of
/// one entry.
#[doc(hidden)]
pub fn cyclic_model(n: usize, ld: usize, ln: usize, attempts: u64, fold: usize, word: bool, delta_bits: u64) -> Units {
    let mut u = Units::default();
    let ma = Family::ModArith as usize;
    // the residues of N
    if word {
        u.0[ma] = u.0[ma].saturating_add(size_product(&[n, n, ln]));
    } else {
        {
            let mut one1 = Units::default();
            one1.add_saturating(&bigdiv_units(ln, ld));
            times(&mut u, size_product(&[n, n]), &one1);
        }
    }
    let lin_big = |u: &mut Units, la: usize, lb: usize, lc: usize, ld2: usize| {
        u.add_saturating(&bigmul_units(1, la));
        u.add_saturating(&bigmul_units(lb, lc));
        u.add_saturating(&bigdiv_units(2 * ld2 + 1, ld2));
    };
    let full = delta_bits.saturating_sub(1);
    let mut lr = 0usize;
    for t in 0..attempts {
        // the entries of r
        if t > 0 {
            for _ in 0..n - 1 {
                if t < full {
                    u.0[Family::Move as usize] = u.0[Family::Move as usize].saturating_add(t.div_ceil(64));
                    lr = t.div_ceil(64) as usize;
                } else {
                    u.0[Family::Move as usize] = u.0[Family::Move as usize].saturating_add((delta_bits + 64).div_ceil(64));
                    u.add_saturating(&bigdiv_units(ld + 1, ld));
                    lr = ld;
                }
            }
            // y += r_i N_i: n - 1 rows of n operations
            if word {
                u.0[ma] = u.0[ma].saturating_add(size_product(&[n - 1, n + 1]));
            } else {
                for _ in 0..n - 1 {
                    u.add_saturating(&bigdiv_units(lr, ld));
                    {
                        let mut one2 = Units::default();
                        lin_big(&mut one2, ld, ld.min(lr.max(1)), ld, ld);
                        times(&mut u, n as u64, &one2);
                    }
                }
            }
        }
        // the fold
        let entries = if t + 1 == attempts { fold } else { n };
        // (the first entry's Euclid runs from delta; the running gcd is
        // then small, so the later ones take a few steps each)
        if word {
            if entries > 0 {
                u.0[ma] = u.0[ma].saturating_add((delta_bits.saturating_mul(6) / 10 + 1).saturating_add(size_product(&[entries - 1, 3])).saturating_add(size_product(&[entries, entries.saturating_sub(1)]) / 2));
            }
        } else {
            for e in 0..entries {
                u.add_saturating(&biggcd_units(if e == 0 { ld } else { 1 }, ld));
                if e + 1 == entries && t + 1 == attempts {
                    {
                        let mut one3 = Units::default();
                        one3.add_saturating(&bigmul_units(ld, ld));
                        one3.add_saturating(&bigdiv_units(2 * ld, ld));
                        times(&mut u, (e) as u64, &one3);
                    }
                }
                u.add_saturating(&bigdiv_units(1, ld));
            }
        }
    }
    // h: n - 1 combinations of one term
    if word {
        u.0[ma] = u.0[ma].saturating_add(size_product(&[n - 1, 2]));
    } else {
        {
            let mut one4 = Units::default();
            lin_big(&mut one4, ld, ld, ld, ld);
            times(&mut u, (n - 1) as u64, &one4);
        }
    }
    // the last row over Z, W and V
    let ly = if lr > 0 { lr + ln } else { ln };
    if lr > 0 {
        {
            let mut one5 = Units::default();
            one5.add_saturating(&bigmul_units(lr, ln));
            times(&mut u, size_product(&[n - 1, n]), &one5);
        }
    }
    {
        let mut one6 = Units::default();
        one6.add_saturating(&bigmul_units(ld, ly));
        one6.add_saturating(&bigdiv_units(ld + ly, ld));
        times(&mut u, size_product(&[n - 1, n]), &one6);
    }
    u.0[Family::Move as usize] = u.0[Family::Move as usize].saturating_add(size_product(&[n, ly]));
    if lr > 0 {
        {
            let mut one7 = Units::default();
            one7.add_saturating(&bigmul_units(lr, ld));
            times(&mut u, (n - 1) as u64, &one7);
        }
    }
    u.0[Family::Move as usize] = u.0[Family::Move as usize].saturating_add(size_product(&[n - 1, ld + lr]));
    u
}

/// The units route 2 charges, walked from its loops at given sizes (the
/// work estimate's model): n x n, k trailing invariant factors, delta of
/// `ld` limbs, N's entries of `ln` limbs, `attempts` attempts (the last
/// generates; failed ones fail at the order test), `word` for delta below
/// 2^62, `d_limbs` the limbs of the k invariant factors (stage 2 knows them
/// from part A; delta / g_j = d_j sizes q).  Assumes dense rows, one
/// elimination pass per pivot with mostly one-term steps, and the small
/// Smith form at its O(k^3) count.
#[doc(hidden)]
pub fn trailing_model(n: usize, k: usize, ld: usize, ln: usize, attempts: u64, word: bool, delta_bits: u64, d_limbs: &[usize], f_vinv: f64, multiplier: f64) -> Units {
    let mut u = Units::default();
    let top = n - k;
    let ma = Family::ModArith as usize;
    // (the elimination's multipliers, quotients and Bezout cofactors, run
    // about `multiplier` sqrt(ld) limbs: a fitted term, from the phase data)
    let lc = ((multiplier * (ld as f64).sqrt()).round() as usize).clamp(1, ld.max(1));
    let op_c = |u: &mut Units, count: u64, lco: usize| {
        if word {
            u.0[ma] = u.0[ma].saturating_add(count);
        } else {
            {
                let mut one8 = Units::default();
                one8.add_saturating(&bigmul_units(lco, ld));
                one8.add_saturating(&bigmul_units(lco, ld));
                one8.add_saturating(&bigdiv_units(2 * ld + 1, ld));
                times(u, count, &one8);
            }
        }
    };
    let op = |u: &mut Units, count: u64| op_c(u, count, lc);
    let gcd = |u: &mut Units| {
        if word {
            u.0[ma] = u.0[ma].saturating_add(delta_bits.saturating_mul(6) / 10 + 1);
        } else {
            u.add_saturating(&biggcd_units(ld, ld));
        }
    };
    // the residues of N
    if word {
        u.0[ma] = u.0[ma].saturating_add(size_product(&[n, n, ln]));
    } else {
        {
            let mut one9 = Units::default();
            one9.add_saturating(&bigdiv_units(ln, ld));
            times(&mut u, size_product(&[n, n]), &one9);
        }
    }
    let full = delta_bits.saturating_sub(1);
    let mut lr = 0usize;
    // the column operations of one elimination of Y (k x n)
    // (sum over r < k of n - r - 1, and of k - r - 1)
    let pairs = size_product(&[k, k.saturating_sub(1)]) / 2;
    let colops = size_product(&[k, n.saturating_sub(1)]).saturating_sub(pairs);
    let rowops = pairs;
    for t in 0..attempts {
        steps(1);
        if t > 0 {
            // R's k top entries per row: the same charge each, multiplied
            let entries = size_product(&[k, top]);
            if entries > 0 {
                if t < full {
                    u.0[Family::Move as usize] = u.0[Family::Move as usize].saturating_add(entries.saturating_mul(t.div_ceil(64)));
                    lr = t.div_ceil(64) as usize;
                } else {
                    u.0[Family::Move as usize] = u.0[Family::Move as usize].saturating_add(entries.saturating_mul((delta_bits + 64).div_ceil(64)));
                    times(&mut u, entries, &bigdiv_units(ld + 1, ld));
                    lr = ld;
                }
            }
            // (y += r N: one product by a word, one by r's entry)
            if word {
                u.0[ma] = u.0[ma].saturating_add(size_product(&[k, top, n + 1]));
            } else {
                {
                    let mut one10 = Units::default();
                    one10.add_saturating(&bigmul_units(1, ld));
                    one10.add_saturating(&bigmul_units(lr.max(1), ld));
                    one10.add_saturating(&bigdiv_units(2 * ld + 1, ld));
                    times(&mut u, size_product(&[k, top, n]), &one10);
                }
            }
        }
        // the elimination: column steps on k rows, row steps on n + k
        // (mostly single-term steps once the pivot divides: one operation
        // per row touched)
        op(&mut u, colops.saturating_mul(1 + k as u64).saturating_add(rowops.saturating_mul(1 + (n + k) as u64)));
        {
            let mut one11 = Units::default();
            gcd(&mut one11);
            times(&mut u, k as u64, &one11);
        }
        // the order test
        {
            let mut one12 = Units::default();
            one12.add_saturating(&bigdiv_units(ld, 1));
            one12.add_saturating(&bigmul_units(ld, ld));
            times(&mut u, k as u64, &one12);
        }
        if t + 1 == attempts {
            // X Q by the recorded column operations, and the divisibility
            // tests
            op(&mut u, colops.saturating_mul(top as u64).saturating_add(size_product(&[top, n])));
            if !word {
                {
                    let mut one13 = Units::default();
                    one13.add_saturating(&bigdiv_units(ld, 1));
                    times(&mut u, size_product(&[top, k]), &one13);
                }
            }
        }
    }
    // q, c (top x k by k), the relations and the small Smith form
    {
        let mut one14 = Units::default();
        gcd(&mut one14);
        times(&mut u, k as u64, &one14);
    }
    // (q_ij lives modulo delta / g_j, which is the invariant factor d_j:
    // usually a small factor, one limb, for all but one j)
    // (the per-factor charges are summed once over j, O(k), then
    // multiplied by their row counts: the model's own cost stays O(n + k))
    let dl = |j: usize| d_limbs.get(j).copied().unwrap_or(ld).clamp(1, ld.max(1));
    let (mut q_row, mut c_entry) = (Units::default(), Units::default());
    for j in 0..k {
        steps(1);
        if word {
            q_row.0[ma] = q_row.0[ma].saturating_add(3);
        } else {
            q_row.add_saturating(&bigdiv_units(ld, ld.saturating_sub(dl(j)).max(1)));
            q_row.add_saturating(&bigmul_units(dl(j), dl(j)));
            q_row.add_saturating(&bigdiv_units(2 * dl(j), dl(j)));
        }
        c_entry.add_saturating(&bigmul_units(dl(j), ld));
    }
    if word {
        c_entry.0[ma] = c_entry.0[ma].saturating_add(1);
    } else {
        c_entry.add_saturating(&bigdiv_units(2 * ld, ld));
    }
    times(&mut u, top as u64, &q_row);
    times(&mut u, size_product(&[top, k]), &c_entry);
    op(&mut u, size_product(&[k, k, k, 4]));
    // the small Smith form's transforms, as measured on route 2's own runs:
    // V_2 at delta's size; V_2^-1 at delta's size for k = 2 (and for a
    // one-limb delta) and f_vinv times it for k >= 3; each capped by the
    // proved bound (the route's bound as a model term, never in L; on the
    // estimate test's corpora, k up to n, it caps no row: the bound grows
    // as 3 (k - 1) delta, the measured size stays about 1 to 2 delta; the
    // test prints the count); B = D V_2^-1 at ld + lvi
    let kb = (usize::BITS - k.leading_zeros()) as u64;
    let bound = usize::try_from((3 * (k as u64 - 1)).saturating_mul(delta_bits.saturating_add(1)).saturating_add(2 * kb + 2).div_ceil(64)).unwrap_or(usize::MAX).max(1);
    let lv = ld.max(1);
    // (one-limb delta stays at its size: the factor was measured above 64
    // bits)
    let lvi = if k <= 2 || ld <= 1 { lv } else { ((f_vinv * ld as f64).round() as usize).max(lv) }.min(bound.max(lv));
    {
        let mut one15 = Units::default();
        one15.add_saturating(&bigmul_units(ld, lvi));
        times(&mut u, size_product(&[k, k]), &one15);
    }
    // the integer rows: N_bottom + R N_top, W and V
    let ly = if lr > 0 { lr + ln } else { ln };
    if lr > 0 {
        {
            let mut one16 = Units::default();
            one16.add_saturating(&bigmul_units(lr, ln));
            times(&mut u, size_product(&[k, top, n]), &one16);
        }
    }
    {
        let mut one17 = Units::default();
        one17.add_saturating(&bigmul_units(ld, ly));
        times(&mut u, size_product(&[top, n, k]), &one17);
    }
    {
        let mut one18 = Units::default();
        one18.add_saturating(&bigmul_units(ld + lvi, ly));
        times(&mut u, size_product(&[k, n, k]), &one18);
    }
    // (W's exact divisions by delta: the top rows' numerators N_i - c_i Y
    // are about ld + ly limbs; only the bottom k rows carry B)
    {
        let mut one19 = Units::default();
        one19.add_saturating(&bigdiv_units(ld + ly, ld));
        times(&mut u, size_product(&[top, n]), &one19);
    }
    {
        let mut one20 = Units::default();
        one20.add_saturating(&bigdiv_units(ld + lvi + ly, ld));
        times(&mut u, size_product(&[k, n]), &one20);
    }
    // V: c V_2 (top x k by k), I - R c (k x k by top), and (I - R c) V_2
    {
        let mut one21 = Units::default();
        one21.add_saturating(&bigmul_units(ld, lv));
        times(&mut u, size_product(&[top, k, k]), &one21);
    }
    if lr > 0 {
        {
            let mut one22 = Units::default();
            one22.add_saturating(&bigmul_units(lr, ld));
            times(&mut u, size_product(&[k, top, k]), &one22);
        }
    }
    {
        let mut one23 = Units::default();
        one23.add_saturating(&bigmul_units(lr + ld, lv));
        times(&mut u, size_product(&[k, k, k]), &one23);
    }
    u.0[Family::Move as usize] = u.0[Family::Move as usize].saturating_add(size_product(&[n, n]));
    u
}

/// The units part A charges (route 2's invariants from d = |det a| and
/// the inverse's solve), walked at given sizes: the content fold (two
/// entries), the solve x = N b (n^2 products by one-limb entries), the
/// lowest-terms fold and divisions of `modulus_from` when d passes 62 bits,
/// `smith_mod` at e (n^2 residues, then `c_a` n^3 elimination steps: a
/// fitted coefficient), and the invariants' product and division.
#[doc(hidden)]
pub fn part_a_model(n: usize, la: usize, ln: usize, ld: usize, ldet: usize, le: usize, e_word: bool, c_a: f64) -> Units {
    let mut u = Units::default();
    let n2 = size_product(&[n, n]);
    u.add_saturating(&biggcd_units(la, 1));
    u.add_saturating(&biggcd_units(la, la));
    {
        let mut one24 = Units::default();
        one24.add_saturating(&bigmul_units(ln, 1));
        times(&mut u, size_product(&[n, n]), &one24);
    }
    if ldet > 1 {
        u.add_saturating(&biggcd_units(ln, ld));
        u.add_saturating(&biggcd_units(ln, 1));
        u.add_saturating(&bigdiv_units(ld, 1));
        u.add_saturating(&bigdiv_units(ldet, ld));
        u.add_saturating(&bigdiv_units(ldet, ld));
    }
    let steps = (c_a * (n as f64).powi(3)).round() as u64;
    if e_word {
        u.0[Family::ModArith as usize] = u.0[Family::ModArith as usize].saturating_add(n2.saturating_mul(la as u64).saturating_add(steps));
    } else {
        {
            let mut one25 = Units::default();
            one25.add_saturating(&bigdiv_units(la, le));
            times(&mut u, size_product(&[n, n]), &one25);
        }
        {
            let mut one26 = Units::default();
            one26.add_saturating(&bigmul_units(le, le));
            one26.add_saturating(&bigmul_units(le, le));
            one26.add_saturating(&bigdiv_units(2 * le + 1, le));
            times(&mut u, (steps) as u64, &one26);
        }
    }
    {
        let mut one27 = Units::default();
        one27.add_saturating(&bigmul_units(le, le));
        times(&mut u, n as u64, &one27);
    }
    u.add_saturating(&bigdiv_units(ldet, le));
    u
}
