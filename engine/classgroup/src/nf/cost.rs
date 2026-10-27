//! The cost model of integer factorization, for estimates (plan
//! estimates-agent-api-impl r3, PR 2; design-estimates-progress r4 §4 and
//! §5.1).  Information only: nothing here limits, grants or refuses work.
//!
//! The work unit is one 64 x 64-bit word product, or an operation no more
//! costly than one (a byte stored or scanned by the sieve).  The closed
//! forms are those of the paused budget branch (plan-factor-budget r5
//! §2.1), each an upper bound of its phase's work; the estimate labels them
//! "known" where the step's size is fixed before it runs (an attempt, a
//! curve, a level) and "bound" where it is not (trial division from n's size
//! alone).  Time is not computed here: the host multiplies the units by its
//! calibrated rate for the phase and the limb count (E4 §7).
//!
//! The estimator reads only n's size in bits (no division of n), and its
//! own cost is a few thousand floating-point operations.

use super::ecm::{fixed_b2, DOUBLING_B1, DOUBLING_B2_MAX, DOUBLING_CURVES, DOUBLING_TABLE_MAX, MAXL, SCHEDULE, STAGE2_D};
use super::factor::{RHO_ITERS, SPLIT_BITS_MAX, TRIAL_BOUND};
use std::sync::OnceLock;

// ---- the closed forms (plan-factor-budget r5 §2.1; units)

/// Limbs of an integer of `bits` bits (at least 1).
pub fn limbs(bits: u64) -> u64 {
    bits.div_ceil(64).max(1)
}

fn sat(x: u128) -> u64 {
    x.min(u64::MAX as u128) as u64
}

/// One Montgomery product modulo k limbs: the CIOS word products and a
/// per-call constant.
pub fn c_mont(k: u64) -> u64 {
    2 * k * k + k + 8
}

/// One schoolbook BigInt product of k-limb operands and its reduction.
pub fn m_big(k: u64) -> u64 {
    4 * k * k + 8 * k
}

/// One gcd of k-limb integers (binary gcd: at most 2 * 64 k shift and
/// subtract passes over k words).
pub fn gcd_cost(k: u64) -> u64 {
    128 * k * k + 64 * k
}

/// One remainder of a k-limb integer by a word.
pub fn div_word_cost(k: u64) -> u64 {
    64 * k
}

fn ceil_log2(x: u64) -> u64 {
    if x <= 1 {
        0
    } else {
        64 - (x - 1).leading_zeros() as u64
    }
}

/// The Baillie-PSW probable-prime test of an integer of `bits` bits:
/// setup, then 20 Miller-Rabin and 6 Lucas products per bit.
pub fn prp_cost(bits: u64) -> u64 {
    let k = limbs(bits);
    sat((4 + 26 * (bits as u128 + 1)) * m_big(k) as u128)
}

/// The perfect-power roots of an integer of `bits` bits, exponents 2 to
/// bits / 16: Newton iterations of products and divisions.
pub fn roots_cost(bits: u64) -> u64 {
    let k = limbs(bits);
    let mut total: u128 = 0;
    for e in 2..=(bits / 16).max(1) {
        total += ((ceil_log2(bits) + 4) * (2 * ceil_log2(e) + 2)) as u128 * m_big(k) as u128;
    }
    sat(total)
}

/// Pollard-Brent rho for `iters` iterations modulo k limbs: at most 2 iters
/// steps of 3 products, a gcd every 128 and a backtrack of at most 128.
pub fn rho_cost(k: u64, iters: u64) -> u64 {
    let blocks = (2 * iters) / 128 + 64;
    sat(6 * iters as u128 * c_mont(k) as u128 + blocks as u128 * gcd_cost(k) as u128 + 128 * (c_mont(k) + gcd_cost(k)) as u128)
}

/// An upper bound on the number of primes up to x (Rosser and Schoenfeld:
/// pi(x) < 1.25506 x / ln x for x > 1).
pub fn pi_plus(x: u64) -> u64 {
    if x < 17 {
        return 7;
    }
    let xf = x as f64;
    (1.25506 * xf / xf.ln()).ceil() as u64 + 1
}

/// One ECM curve with bounds B1, B2 modulo k limbs:
/// - setup: a few BigInt products and an extended gcd;
/// - stage 1: a ladder (11 products a bit) over every prime power up to
///   B1, at most log2 lcm(1..B1) + pi(B1) < 1.4988 B1 + pi(B1) bits
///   (psi(x) < 1.03883 x);
/// - stage 2: 240 baby steps, three ladders of at most 64 bits, a giant
///   step (6 products) per 2310 and 3 products per prime up to B2;
/// - two gcds.
pub fn curve_cost(k: u64, b1: u64, b2: u64) -> u64 {
    let stage1 = 11 * ((1.4988 * b1 as f64).ceil() as u64 + pi_plus(b1));
    let stage2 = 3500 + 3 * 11 * 64 + 6 * (b2.div_ceil(STAGE2_D) + 2) + 3 * pi_plus(b2);
    sat((stage1 + stage2) as u128 * c_mont(k) as u128 + 2 * gcd_cost(k) as u128 + 64 * m_big(k) as u128)
}

/// The sieve of Eratosthenes up to x (arith::primes_up_to): one byte per
/// integer, marked about ln ln x times, and scanned once.
pub fn sieve_cost(x: u64) -> u64 {
    let lnln = (x.max(16) as f64).ln().ln();
    (x as f64 * (lnln + 2.0)).ceil() as u64
}

/// The peak bytes of arith::primes_up_to(x): its byte array of x + 1 flags,
/// and the primes found (u64 each, in a vector that may double once while
/// growing, so twice its final size at most).
pub fn table_peak(x: u64) -> u64 {
    (x + 1) + 16 * pi_plus(x) + 64
}

/// Stage 2's buffers: the 240 baby-step points (x and z, MAXL limbs each).
pub fn stage2_buffers() -> u64 {
    let babies = (1..STAGE2_D / 2).step_by(2).filter(|&j| gcd_u64(j, STAGE2_D) == 1).count() as u64;
    babies * 2 * MAXL as u64 * 8
}

fn gcd_u64(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

// ---- Dickman's rho, and ECM's success model (a heuristic model)

const RHO_STEPS: usize = 256; // per unit of u
const RHO_UMAX: usize = 64;

/// Dickman's rho on [0, RHO_UMAX] at steps of 1/RHO_STEPS: rho = 1 on
/// [0, 1], rho'(u) = -rho(u - 1) / u, integrated by the trapezoid rule.
fn rho_table() -> &'static [f64] {
    static T: OnceLock<Vec<f64>> = OnceLock::new();
    T.get_or_init(|| {
        let n = RHO_UMAX * RHO_STEPS;
        let h = 1.0 / RHO_STEPS as f64;
        let mut t = vec![1.0f64; n + 1];
        for i in RHO_STEPS + 1..=n {
            let (u0, u1) = ((i - 1) as f64 * h, i as f64 * h);
            let d0 = t[i - 1 - RHO_STEPS] / u0;
            let d1 = t[i - RHO_STEPS] / u1;
            t[i] = (t[i - 1] - h * (d0 + d1) / 2.0).max(0.0);
        }
        t
    })
}

/// Dickman's rho(u), interpolated linearly (0 beyond the table).
pub fn dickman_rho(u: f64) -> f64 {
    if !(u > 1.0) {
        return 1.0;
    }
    let t = rho_table();
    let x = u * RHO_STEPS as f64;
    let i = x.floor() as usize;
    if i + 1 >= t.len() {
        return 0.0;
    }
    let f = x - i as f64;
    t[i] * (1.0 - f) + t[i + 1] * f
}

/// The modelled chance that a random integer of size `order` (natural log
/// `ln_order`) is B1-smooth but for at most one prime in (B1, B2]:
/// rho(1/a) + the integral over t in (a, b] of rho((1 - t)/a) dt / t, with
/// a = ln B1 / ln order and b = min(ln B2 / ln order, 1).
pub fn smooth_chance(ln_order: f64, b1: u64, b2: u64) -> f64 {
    if !(ln_order > 0.0) {
        return 1.0;
    }
    let a = (b1 as f64).ln() / ln_order;
    if a >= 1.0 {
        return 1.0;
    }
    let b = ((b2.max(b1) as f64).ln() / ln_order).min(1.0);
    let mut p = dickman_rho(1.0 / a);
    if b > a {
        let n = 200;
        let h = (b - a) / n as f64;
        let f = |t: f64| dickman_rho((1.0 - t) / a) / t;
        let mut s = (f(a) + f(b)) / 2.0;
        for i in 1..n {
            s += f(a + i as f64 * h);
        }
        p += s * h;
    }
    p.clamp(0.0, 1.0)
}

// ---- the estimate

/// One level of ECM's schedule, as run by ecm::ecm then ecm::ecm_until_found.
#[derive(Clone, Debug)]
pub struct Level {
    pub b1: u64,
    pub b2: u64,
    pub curves: u64,
    /// the prime table's bound for this level
    pub table: u64,
    /// fixed (ecm::ecm) or doubling (ecm::ecm_until_found)
    pub fixed: bool,
}

/// The levels modelled: the fixed schedule, then the doubling levels while
/// B1 <= last_b1 (the engine keeps doubling until it finds a factor; the
/// model stops there).
pub fn levels(last_b1: u64) -> Vec<Level> {
    let mut out: Vec<Level> = SCHEDULE.iter().map(|&(b1, c)| {
        let b2 = fixed_b2(b1);
        Level { b1, b2, curves: c as u64, table: b2 + STAGE2_D, fixed: true }
    }).collect();
    let mut b1 = DOUBLING_B1;
    while b1 <= last_b1 {
        let b2 = (50 * b1).min(DOUBLING_B2_MAX).min(DOUBLING_TABLE_MAX);
        out.push(Level { b1, b2, curves: DOUBLING_CURVES as u64, table: b2 + STAGE2_D, fixed: false });
        b1 = b1.saturating_mul(2);
    }
    out
}

/// The largest B1 modelled after the fixed schedule (2e6 doubled 9 times).
pub const MODEL_LAST_B1: u64 = DOUBLING_B1 << 9;

#[derive(Clone, Debug, PartialEq)]
pub enum Label {
    Known,
    Bound,
}

impl Label {
    pub fn as_str(&self) -> &'static str {
        match self {
            Label::Known => "known",
            Label::Bound => "bound",
        }
    }
}

/// A stage of the estimate: its work in units (for the host's rate of
/// `phase` at `limbs` limbs) and its memory, both with labels.
#[derive(Clone, Debug)]
pub struct Stage {
    pub name: String,
    pub phase: &'static str,
    pub limbs: u64,
    pub units: u64,
    pub label: Label,
    /// total live bytes above the input while this stage runs
    pub memory: u64,
    pub memory_label: Label,
    pub condition: Option<String>,
}

/// The chance milestones reported for each target size (the estimates
/// ruling of Oct 27: p_typical = p_high = q, each with its own work).
pub const MILESTONES: [f64; 2] = [0.5, 0.95];

/// ECM's modelled chances for a factor of at most `digits` digits (a
/// heuristic model: each curve's group order is taken as a random integer
/// near the factor p, with no credit for the parametrization's torsion; the
/// curves are independent): the cumulative chance by the end of each level,
/// and the work (units) at which the cumulative chance first reaches each of
/// MILESTONES, or None where the modelled schedule ends first.  The
/// milestones overlap (the 95% work includes the 50% work): never sum them.
#[derive(Clone, Debug)]
pub struct EcmTarget {
    pub digits: u32,
    pub cumulative: Vec<f64>,
    pub milestone_units: Vec<(f64, Option<u64>)>,
    /// the chance by the end of the modelled schedule, and its work
    pub end_chance: f64,
    pub units_total: u64,
}

#[derive(Clone, Debug)]
pub struct FactorEstimate {
    pub bits: u64,
    pub stages: Vec<Stage>,
    pub levels: Vec<Level>,
    pub ecm: Vec<EcmTarget>,
    /// rho's modelled chance (one attempt) for a factor of 10, 12 and 14 digits
    pub rho_chances: Vec<(u32, f64)>,
    /// the total time is known (n is small enough that trial division alone
    /// factors it); otherwise unknown
    pub total_known: bool,
    pub notes: Vec<String>,
}

/// The work (units) at which the cumulative chance first reaches q, walking
/// the levels curve by curve (each level's per-curve chance p_l), or None.
fn units_to(levels: &[Level], per_curve: &[f64], unit_cost: &[u64], q: f64) -> Option<u64> {
    let mut miss = 1.0f64; // the chance that every curve so far missed
    let mut units: u128 = 0;
    for ((lv, &p), &c) in levels.iter().zip(per_curve).zip(unit_cost) {
        if p > 0.0 {
            let after = miss * (1.0 - p).powf(lv.curves as f64);
            if 1.0 - after >= q {
                // curves needed in this level: (1 - p)^m <= (1 - q) / miss
                let m = if p >= 1.0 { 1.0 } else { (((1.0 - q) / miss).ln() / (1.0 - p).ln()).ceil().max(1.0) };
                return Some(sat(units + m as u128 * c as u128));
            }
            miss = after;
        }
        units += lv.curves as u128 * c as u128;
    }
    None
}

/// The estimate of factoring a positive integer of `bits` bits by
/// factor::factor (engine), from its size alone.
pub fn factor_estimate(bits: u64) -> FactorEstimate {
    let bits = bits.max(1);
    let k = limbs(bits);
    let mut stages = vec![];
    let mut notes = vec![];
    // trial division by the primes below 2^16 (stopping once p^2 > n): the
    // sieve, then at most pi(min(2^16, sqrt n)) remainders
    let sqrt_bound = if bits / 2 + 1 >= 64 { u64::MAX } else { 1u64 << (bits / 2 + 1) };
    let trial_primes = pi_plus(TRIAL_BOUND.min(sqrt_bound));
    stages.push(Stage {
        name: "trial division below 2^16".into(),
        phase: "trial",
        limbs: k,
        units: sat(sieve_cost(TRIAL_BOUND) as u128 + trial_primes as u128 * div_word_cost(k) as u128 * 2),
        label: Label::Bound,
        memory: table_peak(TRIAL_BOUND),
        memory_label: Label::Bound,
        condition: None,
    });
    let total_known = bits <= 32;
    if total_known {
        notes.push("n is below 2^32: trial division by the primes below 2^16 factors it completely".into());
    }
    // the cofactor's tests, at most at n's size (known at the stage's start,
    // from the cofactor's actual size; a bound before then)
    stages.push(Stage {
        name: "probable-prime test (Baillie-PSW) of the cofactor".into(),
        phase: "prp",
        limbs: k,
        units: prp_cost(bits),
        label: Label::Bound,
        memory: 16 * 8 * k,
        memory_label: Label::Bound,
        condition: Some("if a cofactor remains after trial division".into()),
    });
    let mut ecm = vec![];
    let mut levels_out = vec![];
    let mut rho_chances = vec![];
    if bits > SPLIT_BITS_MAX {
        notes.push(format!(
            "a composite cofactor above {} bits is not split (rho and ECM work on at most {} bits): the factorization then ends with an error",
            SPLIT_BITS_MAX, SPLIT_BITS_MAX
        ));
    } else if !total_known {
        stages.push(Stage {
            name: "perfect-power test".into(),
            phase: "roots",
            limbs: k,
            units: roots_cost(bits),
            label: Label::Bound,
            memory: 16 * 8 * k,
            memory_label: Label::Bound,
            condition: Some("if the cofactor is composite".into()),
        });
        stages.push(Stage {
            name: format!("Pollard-Brent rho, one attempt of 2^{} iterations", RHO_ITERS.trailing_zeros()),
            phase: "rho",
            limbs: k,
            units: rho_cost(k, RHO_ITERS),
            label: Label::Known,
            memory: 32 * 8 * MAXL as u64,
            memory_label: Label::Known,
            condition: Some("if the cofactor is composite and not a perfect power".into()),
        });
        for d in [10u32, 12, 14] {
            let p = 10f64.powi(d as i32);
            let t = RHO_ITERS as f64;
            rho_chances.push((d, 1.0 - (-(t * t) / (2.0 * p)).exp()));
        }
        let lv = levels(MODEL_LAST_B1);
        let costs: Vec<u64> = lv.iter().map(|l| curve_cost(k, l.b1, l.b2)).collect();
        let buffers = stage2_buffers();
        for (l, &c) in lv.iter().zip(&costs) {
            let tag = if l.fixed { "" } else { ", after the fixed schedule" };
            stages.push(Stage {
                name: format!("ECM level B1 = {}, B2 = {}: {} curves{}", l.b1, l.b2, l.curves, tag),
                phase: "ecm",
                limbs: k,
                units: sat(l.curves as u128 * c as u128),
                label: Label::Known,
                memory: table_peak(l.table) + buffers,
                memory_label: Label::Bound,
                condition: Some("if rho found no factor, and no earlier level did".into()),
            });
        }
        let units_total = sat(lv.iter().zip(&costs).map(|(l, &c)| l.curves as u128 * c as u128).sum());
        // targets: factors of at most d digits, beyond trial division, up to
        // the size of the smaller factor of n
        let max_digits = ((bits as f64 / 2.0) * 2f64.log10()).ceil() as u32;
        for d in [15u32, 20, 25, 30, 35, 40, 45, 50] {
            if d > max_digits.max(15) {
                break;
            }
            let ln_p = d as f64 * 10f64.ln();
            let per: Vec<f64> = lv.iter().map(|l| smooth_chance(ln_p, l.b1, l.b2)).collect();
            let mut miss = 1.0f64;
            let cumulative: Vec<f64> = lv.iter().zip(&per).map(|(l, &p)| {
                miss *= (1.0 - p).powf(l.curves as f64);
                1.0 - miss
            }).collect();
            ecm.push(EcmTarget {
                digits: d,
                end_chance: *cumulative.last().unwrap_or(&0.0),
                cumulative,
                milestone_units: MILESTONES.iter().map(|&q| (q, units_to(&lv, &per, &costs, q))).collect(),
                units_total,
            });
        }
        levels_out = lv;
    }
    FactorEstimate { bits, stages, levels: levels_out, ecm, rho_chances, total_known, notes }
}

// ---- calibration probes (E4 §7): fixed small runs of the real code, timed
// by the host, whose units are the closed forms above

/// A prime of about `limbs` limbs for the probes: Mersenne and
/// pseudo-Mersenne primes, so no factor is ever found and every run does
/// its full work.
fn probe_prime(limbs: u64) -> sagebrush_bigint::BigUint {
    use sagebrush_bigint::BigUint;
    let one = BigUint::from(1u32);
    match limbs {
        0 | 1 => (&one << 61usize) - &one,
        2 | 3 => (&one << 127usize) - &one,
        4..=9 => (&one << 255usize) - BigUint::from(19u32),
        _ => (&one << 607usize) - &one,
    }
}

/// One probe: rho (2^12 iterations on a prime of about `size` limbs), one ECM
/// curve at B1 = 2000 (its prime table included), or the probable-prime
/// test of 2^1279 - 1.  Returns (units, bits).
pub fn probe(kind: &str, size: u64) -> Result<(u64, u64), String> {
    use sagebrush_bigint::BigUint;
    match kind {
        "rho" => {
            let n = probe_prime(size);
            let bits = n.bits() as u64;
            let iters = 1u64 << 12;
            let _ = super::ecm::rho(&n, iters, 0x9E37_79B9);
            Ok((rho_cost(limbs(bits), iters), bits))
        }
        "ecm" => {
            let n = probe_prime(size);
            let bits = n.bits() as u64;
            let (b1, b2) = (2000u64, fixed_b2(2000));
            let primes = crate::arith::primes_up_to(b2 + STAGE2_D);
            let _ = super::ecm::ecm_curve(&n, 7, b1, b2, &primes);
            Ok((curve_cost(limbs(bits), b1, b2) + sieve_cost(b2 + STAGE2_D), bits))
        }
        "prp" => {
            let one = BigUint::from(1u32);
            let n = sagebrush_bigint::BigInt::from((&one << 1279usize) - &one);
            let _ = super::factor::is_probable_prime(&n);
            Ok((prp_cost(1279), 1279))
        }
        _ => Err(format!("cost_probe: unknown kind {}", kind)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dickman_rho_values() {
        // rho(2) = 1 - ln 2; rho(3) ~ 0.0486083883; rho(5) ~ 3.5472470e-4
        assert!((dickman_rho(2.0) - (1.0 - 2f64.ln())).abs() < 1e-5);
        assert!((dickman_rho(3.0) - 0.048608388).abs() < 1e-4);
        assert!((dickman_rho(5.0) / 3.5472470e-4 - 1.0).abs() < 0.01);
        assert_eq!(dickman_rho(0.5), 1.0);
    }

    #[test]
    fn chances_are_monotone_and_bounded() {
        let e = factor_estimate(400);
        assert!(!e.ecm.is_empty());
        for t in &e.ecm {
            assert!(t.cumulative.iter().all(|c| (0.0..=1.0).contains(c)), "{}", t.digits);
            assert!(t.cumulative.windows(2).all(|w| w[0] <= w[1]));
            // a milestone is reached only if the schedule's end chance reaches it
            for &(q, u) in &t.milestone_units {
                assert_eq!(u.is_some(), t.end_chance >= q, "{} {}", t.digits, q);
                assert!(u.map_or(true, |u| u <= t.units_total));
            }
            // the milestones overlap: the 95% work includes the 50% work
            if let [(_, Some(a)), (_, Some(b))] = t.milestone_units[..] {
                assert!(a <= b);
            }
        }
        // a larger factor is never likelier
        for w in e.ecm.windows(2) {
            assert!(w[1].end_chance <= w[0].end_chance);
        }
        // small factors are found by the fixed schedule with near certainty
        assert!(e.ecm[0].milestone_units[1].1.is_some());
    }

    #[test]
    fn sizes_and_limits() {
        let small = factor_estimate(30);
        assert!(small.total_known && small.ecm.is_empty());
        let big = factor_estimate(1100);
        assert!(big.ecm.is_empty() && big.notes.iter().any(|n| n.contains("1024 bits")));
        // the stage list follows the pipeline's order
        let e = factor_estimate(200);
        let phases: Vec<&str> = e.stages.iter().map(|s| s.phase).collect();
        assert_eq!(&phases[..4], &["trial", "prp", "roots", "rho"]);
        assert!(phases[4..].iter().all(|&p| p == "ecm"));
        // the fixed levels are ecm.rs's schedule
        assert_eq!(e.levels.iter().filter(|l| l.fixed).map(|l| (l.b1, l.curves as usize)).collect::<Vec<_>>(), SCHEDULE.to_vec());
    }

    #[test]
    fn probes_run() {
        for (k, l) in [("rho", 1), ("rho", 4), ("ecm", 4), ("prp", 20)] {
            let (u, b) = probe(k, l).unwrap();
            assert!(u > 0 && b > 0, "{} {}", k, l);
        }
        assert!(probe("nope", 1).is_err());
    }

    #[test]
    fn fast_enough() {
        let t = std::time::Instant::now();
        for bits in [64u64, 200, 512, 1024] {
            let _ = factor_estimate(bits);
        }
        // E4 §3: under 10 ms each (debug builds are slower; the release
        // bound is checked by the host's test)
        assert!(t.elapsed().as_millis() < 4 * 200, "{:?}", t.elapsed());
    }
}
