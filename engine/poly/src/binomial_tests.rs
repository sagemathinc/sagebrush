//! Tests of binomials (plan factor-binomial r3, section 6).

use super::*;
use crate::budget::Limits;
use std::collections::HashMap;

fn z(v: &[i64]) -> ZPoly {
    v.iter().map(|&x| BigInt::from(x)).collect()
}

/// x^n + c
fn xn(n: usize, c: i64) -> ZPoly {
    let mut v = vec![BigInt::zero(); n + 1];
    v[0] = BigInt::from(c);
    v[n] = BigInt::one();
    v
}

fn sort(fs: &mut [(ZPoly, u32)]) {
    fs.sort_by(|x, y| x.0.len().cmp(&y.0.len()).then_with(|| x.0.iter().rev().cmp(y.0.iter().rev())));
}

/// Phi_n by dense exact division of x^n - 1 by the Phi_d, d | n, d < n: an
/// independent construction (lib.rs's divexact, memoized).
fn cyclotomic(n: usize, memo: &mut HashMap<usize, ZPoly>) -> ZPoly {
    if let Some(f) = memo.get(&n) {
        return f.clone();
    }
    let b = Budget::unlimited();
    let mut f = xn(n, -1);
    for d in 1..n {
        if n % d == 0 {
            let g = cyclotomic(d, memo);
            f = divexact(&b, &f, &g).unwrap().unwrap().into_vec();
        }
    }
    memo.insert(n, f.clone());
    f
}

/// The value at x of v (Horner).
fn eval(v: &[BigInt], x: i64) -> BigInt {
    v.iter().rev().fold(BigInt::zero(), |acc, c| acc * x + c)
}

/// Phi_d(x) for an integer x >= 2, by the Moebius product over e | d of
/// (x^e - 1)^mu(d/e) (a rational identity, evaluated exactly).
fn cyclotomic_value(d: u64, x: i64) -> BigInt {
    let mu = |mut n: u64| -> i32 {
        let mut s = 1;
        let mut p = 2;
        while p * p <= n {
            if n % p == 0 {
                n /= p;
                if n % p == 0 {
                    return 0;
                }
                s = -s;
            }
            p += 1;
        }
        if n > 1 {
            s = -s;
        }
        s
    };
    let (mut num, mut den) = (BigInt::one(), BigInt::one());
    for e in 1..=d {
        if d % e == 0 {
            let t = BigInt::from(x).pow(e as u32) - 1;
            match mu(d / e) {
                1 => num *= t,
                -1 => den *= t,
                _ => {}
            }
        }
    }
    assert!((&num % &den).is_zero());
    num / den
}

/// x^n - 1 and x^n + 1 for every n <= 300: the factor lists, factor by
/// factor, against the independent dense construction; through the
/// cyclotomic stage only (no modular phase).
#[test]
fn stage_a_matches_independent_cyclotomics() {
    let mut memo = HashMap::new();
    for n in 1..=300usize {
        for plus in [false, true] {
            let f = xn(n, if plus { 1 } else { -1 });
            let b = Budget::default();
            let (c, fs) = try_factor_with(&f, &b).unwrap();
            assert!(c.is_one());
            let mut want: Vec<(ZPoly, u32)> = (1..=2 * n)
                .filter(|&d| if plus { (2 * n) % d == 0 && n % d != 0 } else { n % d == 0 })
                .map(|d| (cyclotomic(d, &mut memo), 1))
                .collect();
            sort(&mut want);
            assert_eq!(fs, want, "x^{} {} 1", n, if plus { "+" } else { "-" });
            assert!(b.debited(Phase::Cyclotomic) && !b.debited(Phase::Modular) && !b.debited(Phase::Hensel), "n = {}", n);
            assert_eq!(b.live(), 0);
        }
    }
}

/// Large n, refused or out of reach before (x^240 - 1 took more than 300 s
/// on master in wasm; #46 refused it): each factor's values at 2 and 3
/// against the Moebius product, the degrees, and the work used.
#[test]
fn stage_a_large() {
    for n in [240u64, 360, 1000, 5040, 8645, 9240, 10000] {
        for plus in [false, true] {
            let f = xn(n as usize, if plus { 1 } else { -1 });
            let b = Budget::default();
            let (c, fs) = try_factor_with(&f, &b).unwrap();
            assert!(c.is_one());
            let mut ds: Vec<u64> = (1..=2 * n).filter(|&d| if plus { (2 * n) % d == 0 && n % d != 0 } else { n % d == 0 }).collect();
            assert_eq!(fs.len(), ds.len());
            assert_eq!(fs.iter().map(|x| x.0.len() as u64 - 1).sum::<u64>(), n);
            // match each factor to its index by degree and value at 2
            for (g, e) in &fs {
                assert_eq!(*e, 1);
                let v2 = eval(g, 2);
                let i = ds.iter().position(|&d| cyclotomic_value(d, 2) == v2).expect("a cyclotomic value at 2");
                let d = ds.remove(i);
                assert_eq!(eval(g, 3), cyclotomic_value(d, 3), "Phi_{} at 3", d);
            }
            assert!(ds.is_empty());
            // the ledger: well under 1/1000 of W (plan r3, 4.2: <= 3.9e6)
            let used = Limits::DEFAULT.work - b.work_left();
            assert!(used < 4_000_000, "x^{} {} 1: {} units", n, if plus { "+" } else { "-" }, used);
        }
    }
}

/// Stage B and its neighbours, against Sage 10.10 (2026-09-28): content
/// and factor lists (plan r3, section 6 item 2).
#[test]
fn stage_b_against_sage() {
    let x7 = {
        let mut v = xn(37, 0);
        v[7] = -BigInt::one();
        v
    };
    let poly = |s: &str| -> ZPoly {
        match s {
            "x^4-64" => z(&[-64, 0, 0, 0, 1]),
            "9*x^4-4" => z(&[-4, 0, 0, 0, 9]),
            "8*x^6+27" => z(&[27, 0, 0, 0, 0, 0, 8]),
            "16*x^12-81" => {
                let mut v = xn(12, -81);
                v[12] = BigInt::from(16);
                v
            }
            "2*x^6-128" => z(&[-128, 0, 0, 0, 0, 0, 2]),
            "27*x^9+8" => {
                let mut v = xn(9, 8);
                v[9] = BigInt::from(27);
                v
            }
            "-x^5+32" => z(&[32, 0, 0, 0, 0, -1]),
            "x^4+4" => z(&[4, 0, 0, 0, 1]),
            "x^5-2" => z(&[-2, 0, 0, 0, 0, 1]),
            "3*x^10-3" => {
                let mut v = xn(10, -3);
                v[10] = BigInt::from(3);
                v
            }
            "x^7*(x^30-1)" => x7.clone(),
            "9*x^2-4" => z(&[-4, 0, 9]),
            "27*x^3+8" => z(&[8, 0, 0, 27]),
            "x^4-16" => z(&[-16, 0, 0, 0, 1]),
            "x^8-16" => xn(8, -16),
            "4*x^20-9" => {
                let mut v = xn(20, -9);
                v[20] = BigInt::from(4);
                v
            }
            "x^6+8" => xn(6, 8),
            "-8*x^6-27" => z(&[-27, 0, 0, 0, 0, 0, -8]),
            _ => unreachable!(),
        }
    };
    #[rustfmt::skip]
    let cases: Vec<(&str, i64, Vec<(ZPoly, u32)>)> = vec![
        ("x^4-64", 1, vec![(z(&[-8, 0, 1]), 1), (z(&[8, 0, 1]), 1)]),
        ("9*x^4-4", 1, vec![(z(&[-2, 0, 3]), 1), (z(&[2, 0, 3]), 1)]),
        ("8*x^6+27", 1, vec![(z(&[3, 0, 2]), 1), (z(&[9, 0, -6, 0, 4]), 1)]),
        ("16*x^12-81", 1, vec![(z(&[-3, 0, 0, 2]), 1), (z(&[3, 0, 0, 2]), 1), (z(&[9, 0, 0, 0, 0, 0, 4]), 1)]),
        ("2*x^6-128", 2, vec![(z(&[-2, 1]), 1), (z(&[2, 1]), 1), (z(&[4, -2, 1]), 1), (z(&[4, 2, 1]), 1)]),
        ("27*x^9+8", 1, vec![(z(&[2, 0, 0, 3]), 1), (z(&[4, 0, 0, -6, 0, 0, 9]), 1)]),
        ("-x^5+32", -1, vec![(z(&[-2, 1]), 1), (z(&[16, 8, 4, 2, 1]), 1)]),
        ("x^4+4", 1, vec![(z(&[2, -2, 1]), 1), (z(&[2, 2, 1]), 1)]),
        ("x^5-2", 1, vec![(z(&[-2, 0, 0, 0, 0, 1]), 1)]),
        ("3*x^10-3", 3, vec![(z(&[-1, 1]), 1), (z(&[1, 1]), 1), (z(&[1, -1, 1, -1, 1]), 1), (z(&[1, 1, 1, 1, 1]), 1)]),
        ("x^7*(x^30-1)", 1, vec![(z(&[-1, 1]), 1), (z(&[0, 1]), 7), (z(&[1, 1]), 1), (z(&[1, -1, 1]), 1), (z(&[1, 1, 1]), 1), (z(&[1, -1, 1, -1, 1]), 1), (z(&[1, 1, 1, 1, 1]), 1), (z(&[1, -1, 0, 1, -1, 1, 0, -1, 1]), 1), (z(&[1, 1, 0, -1, -1, -1, 0, 1, 1]), 1)]),
        ("9*x^2-4", 1, vec![(z(&[-2, 3]), 1), (z(&[2, 3]), 1)]),
        ("27*x^3+8", 1, vec![(z(&[2, 3]), 1), (z(&[4, -6, 9]), 1)]),
        ("x^4-16", 1, vec![(z(&[-2, 1]), 1), (z(&[2, 1]), 1), (z(&[4, 0, 1]), 1)]),
        ("x^8-16", 1, vec![(z(&[2, -2, 1]), 1), (z(&[-2, 0, 1]), 1), (z(&[2, 0, 1]), 1), (z(&[2, 2, 1]), 1)]),
        ("4*x^20-9", 1, vec![(z(&[-3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]), 1), (z(&[3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]), 1)]),
        ("x^6+8", 1, vec![(z(&[2, 0, 1]), 1), (z(&[4, 0, -2, 0, 1]), 1)]),
        ("-8*x^6-27", -1, vec![(z(&[3, 0, 2]), 1), (z(&[9, 0, -6, 0, 4]), 1)]),
    ];
    for (s, c, want) in cases {
        let f = poly(s);
        let b = Budget::default();
        let got = try_factor_with(&f, &b).unwrap();
        assert_eq!(got, (BigInt::from(c), want), "{}", s);
        assert_eq!(b.live(), 0);
        // which path: binomials with g > 1 take Stage B
        let stage_b = ["x^4-64", "9*x^4-4", "8*x^6+27", "16*x^12-81", "2*x^6-128", "27*x^9+8", "-x^5+32", "9*x^2-4", "27*x^3+8", "x^4-16", "x^8-16", "4*x^20-9", "x^6+8", "-8*x^6-27"];
        assert_eq!(b.debited(Phase::Homogenize), stage_b.contains(&s), "{}", s);
    }
    // h = 1 returns the pieces directly; h > 1 sends them to the general
    // path (x^8 - 16: x^4 + 4 splits there)
    let b = Budget::default();
    try_factor_with(&poly("9*x^2-4"), &b).unwrap();
    assert!(!b.debited(Phase::Modular));
    let b = Budget::default();
    try_factor_with(&poly("27*x^3+8"), &b).unwrap();
    assert!(!b.debited(Phase::Modular));
    let b = Budget::default();
    try_factor_with(&poly("x^8-16"), &b).unwrap();
    assert!(b.debited(Phase::Modular));
}

/// A 4200-bit binomial takes Stage B (no bits cap: plan rank 3 r3, 3.8),
/// with the same answer as before (Sage: (2^2100 x - 1)(2^2100 x + 1)).
#[test]
fn a_4200_bit_binomial_takes_stage_b() {
    let big = BigInt::one() << 4200u32;
    let f = vec![-BigInt::one(), BigInt::zero(), big.clone()];
    let b = Budget::default();
    let (c, fs) = try_factor_with(&f, &b).unwrap();
    let h = BigInt::one() << 2100u32;
    assert_eq!((c, fs), (BigInt::one(), vec![(vec![-BigInt::one(), h.clone()], 1), (vec![BigInt::one(), h], 1)]));
    assert!(b.debited(Phase::PerfectPower) && !b.debited(Phase::Modular));
}

/// q^2 x^2 - 49 with a leading coefficient of exactly `bits` bits:
/// q = 2^(bits/2) - 1 for even bits, 2^((bits-1)/2) + 1 for odd (7 divides
/// neither at these sizes: the content is 1).
fn square_binomial(bits: u64) -> (Vec<BigInt>, BigInt) {
    let q: BigInt = if bits.is_multiple_of(2) { (BigInt::one() << (bits / 2) as u32) - 1 } else { (BigInt::one() << ((bits - 1) / 2) as u32) + 1 };
    let a: BigInt = &q * &q;
    assert_eq!(a.bits(), bits);
    (vec![BigInt::from(-49), BigInt::zero(), a], q)
}

/// Stage B's executable ledger at a size: the factors (q x - 7)(q x + 7),
/// and each section's preflight at least the units it actually debited
/// (the perfect-power search, then the build and certificate), for one
/// call on an unlimited budget.
fn ledger_audit_at(bits: u64) {
    let (f, q) = square_binomial(bits);
    let b = Budget::unlimited();
    let (r, a) = audit::during(|| try_factor_with(&f, &b));
    let (c, fs) = r.unwrap();
    assert_eq!((c, fs), (BigInt::one(), vec![(vec![BigInt::from(-7), q.clone()], 1), (vec![BigInt::from(7), q], 1)]), "{bits} bits");
    assert!(b.debited(Phase::PerfectPower) && !b.debited(Phase::Modular), "{bits} bits: Stage B");
    assert!(a.pp_used > 0 && a.hom_used > 0, "{bits} bits: {a:?}");
    assert!(a.bisections >= 1 && a.prefilter_rejects == 0, "{bits} bits: a true power must reach the exact search: {a:?}");
    assert!(a.pp_preflight >= a.pp_used, "{bits} bits: perfect-power preflight below its debits: {a:?}");
    assert!(a.hom_preflight >= a.hom_used, "{bits} bits: homogenization preflight below its debits: {a:?}");
    assert_eq!(b.live(), 0);
    eprintln!("ledger audit at {bits} bits: {a:?}");
}

#[test]
fn the_stage_b_ledger_holds_at_2_12_and_2_12_plus_1_bits() {
    ledger_audit_at(1 << 12);
    ledger_audit_at((1 << 12) + 1);
}

#[test]
fn the_stage_b_ledger_holds_at_2_16_bits() {
    ledger_audit_at(1 << 16);
}

/// 2^20 bits: the root search is cubic in the size, so this row runs on the
/// VM (`cargo test --release -- --ignored`).
#[test]
#[ignore]
fn vm_the_stage_b_ledger_holds_at_2_20_bits() {
    ledger_audit_at(1 << 20);
}

/// The ledger's arithmetic is checked: a size whose costs overflow u64 is
/// None (a refusal), never a wrapped, smaller figure.
#[test]
fn the_piece_ledger_overflow_is_none() {
    assert!(piece_cost(1 << 40, 64, 1 << 30, 1).is_none());
    assert!(piece_cost(u64::MAX, 1, 1, 1).is_none());
    assert!(piece_cost(1, 1, 1, u64::MAX).is_none());
    assert!(plan_powers(u64::MAX, 2, &[2]).is_none());
}

/// Every PieceCost field against an independent scalar oracle (astra2's
/// values for (4, 3, 4096, 1); the second by hand): a term dropped inside
/// piece_cost changes the preflight and the debits together, which the
/// preflight >= used audit cannot see, but this can.
#[test]
fn the_piece_costs_match_an_independent_oracle() {
    let k = piece_cost(4, 3, 4096, 1).unwrap();
    assert_eq!((k.fb, k.bh, k.len, k.pw, k.build, k.cert), (16384, 16388, 5, 393216, 49601, 165121));
    // ph 2, c 1, beta 64, h 2: fb 128 (2 limbs), bh 130 (3 limbs), len 5;
    // pw = 2 clog2(3) 2^2 = 16; build = (1 + 3) 3 = 12;
    // cert = 2*1*2 + 3*2 + 1*2 + limbs(129)*2 + limbs(257) = 4 + 6 + 2 + 6 + 5
    let k = piece_cost(2, 1, 64, 2).unwrap();
    assert_eq!((k.fb, k.bh, k.len, k.pw, k.build, k.cert), (128, 130, 5, 16, 12, 23));
}

/// p^phi has no u32 cutoff on the Stage B route (plan rank 3 r3, 3.6): an
/// exponent above u32::MAX is computed, never refused or narrowed.
#[test]
fn the_piece_power_has_no_u32_cutoff() {
    let e = u32::MAX as u64 + 1;
    assert_eq!(phi_power(&BigInt::one(), e), BigInt::one());
    assert_eq!(phi_power(&-BigInt::one(), e + 1), -BigInt::one());
    assert_eq!(phi_power(&BigInt::from(3), 5), BigInt::from(243));
}

/// The product of a factorization, multiplicities included.
fn expand(c: &BigInt, fs: &[(ZPoly, u32)]) -> ZPoly {
    let mut acc = vec![c.clone()];
    for (f, e) in fs {
        for _ in 0..*e {
            let mut r = vec![BigInt::zero(); acc.len() + f.len() - 1];
            for (i, x) in acc.iter().enumerate() {
                for (j, y) in f.iter().enumerate() {
                    r[i + j] += x * y;
                }
            }
            acc = r;
        }
    }
    acc
}

/// a x^m - b with a = q^m, b = p^m: Stage B with g = m.
fn power_binomial(m: usize, q: u32, p: u32) -> ZPoly {
    let mut f = vec![BigInt::zero(); m + 1];
    f[0] = -BigInt::from(p).pow(m as u32);
    f[m] = BigInt::from(q).pow(m as u32);
    f
}

/// The piece costs' metadata (CORR-R3-BIN5-1) is charged before it is
/// allocated and for its whole life: under the allocation audit, the
/// "piece costs" tag never holds more than its reservation, on many pieces
/// (2^5040 x^5040 - 3^5040: 60 pieces, h = 1) and on a heterogeneous g with
/// h > 1 (64 x^12 - 729: g = 6, 4 pieces through the general path); both
/// ledgers hold, the factorization multiplies back, nothing stays reserved.
#[test]
fn the_piece_costs_are_charged_for_their_whole_life() {
    let mut h2 = vec![BigInt::zero(); 13];
    h2[0] = BigInt::from(-729);
    h2[12] = BigInt::from(64);
    for (f, pieces) in [(power_binomial(5040, 2, 3), Some(60usize)), (h2, None)] {
        let b = Budget::default();
        let ((r, a), rep) = crate::alloc_spy::audit(|| audit::during(|| try_factor_with(&f, &b)));
        let (c, fs) = r.unwrap();
        assert_eq!(expand(&c, &fs), f);
        if let Some(n) = pieces {
            assert_eq!(fs.len(), n);
        }
        assert!(b.debited(Phase::PerfectPower));
        assert_eq!(rep.tag_breaches, 0, "{:?}", rep.first_breach);
        assert!(a.pp_preflight >= a.pp_used && a.hom_preflight >= a.hom_used && a.hom_used > 0, "{a:?}");
        assert_eq!(b.live(), 0);
    }
}

/// The tier-1 witnesses are exactly the prime factors of 2^64 - 1 and
/// 2^64 + 1, and the one-pass fold gives |n| mod each of them (against an
/// independent reduction), for signs and sizes around limb boundaries.
#[test]
fn the_fold_residues_are_exact() {
    assert_eq!(FOLD_MINUS.iter().map(|&p| p as u128).product::<u128>(), (1u128 << 64) - 1);
    assert_eq!(FOLD_PLUS.iter().map(|&p| p as u128).product::<u128>(), (1u128 << 64) + 1);
    assert!(FOLD_MINUS.iter().chain(FOLD_PLUS.iter()).all(|&p| is_prime_trial(p)));
    for bits in [1u32, 63, 64, 65, 127, 128, 129, 1000, 4097] {
        for n in [(BigInt::one() << bits) - 1, (BigInt::one() << bits) + 12345, BigInt::from(3).pow(bits / 2 + 1)] {
            for n in [n.clone(), -n] {
                let (rm, rp) = fold_residues(&n);
                for &p in FOLD_MINUS.iter() {
                    assert_eq!((rm % p as u128) as u64, n.abs().mod_floor(&BigInt::from(p)).to_u64().unwrap(), "{bits} bits mod {p}");
                }
                for &p in FOLD_PLUS.iter() {
                    assert_eq!((rp % p as u128) as u64, n.abs().mod_floor(&BigInt::from(p)).to_u64().unwrap(), "{bits} bits mod {p}");
                }
            }
        }
    }
}

/// The residue prefilter never rejects a true l-th power: r^l (and -r^l for
/// odd l) for r up to 3000 (multiples of every witness included) and a few
/// large r, for each small prime l, through both tiers.
#[test]
fn the_residue_prefilter_never_rejects_a_power() {
    let b = Budget::unlimited();
    for l in [2u64, 3, 5, 7, 11, 13] {
        let big = [BigInt::from(12345u32), (BigInt::one() << 300u32) + 7, (BigInt::one() << 2100u32) - 1, BigInt::from(6700417u32), BigInt::from(274177u32)];
        for r in (1u32..3000).map(BigInt::from).chain(big) {
            let n = r.pow(l as u32);
            assert!(!not_a_power(&b, &n, l).unwrap(), "{r}^{l} rejected");
            if l % 2 == 1 {
                assert!(!not_a_power(&b, &-n, l).unwrap(), "-{r}^{l} rejected");
            }
        }
    }
}

/// Exhaustively on small n: whenever the prefilter rejects n, exact_root
/// finds no l-th root (soundness), and it rejects most non-powers.
#[test]
fn the_residue_prefilter_agrees_with_exact_root() {
    let b = Budget::unlimited();
    for l in [2u64, 3, 5, 7] {
        let (mut rejected, mut non_powers) = (0, 0);
        for n in 1u32..20000 {
            let n = BigInt::from(n);
            let is_power = exact_root(&b, &n, l).unwrap().is_some();
            let rej = not_a_power(&b, &n, l).unwrap();
            assert!(!(rej && is_power), "{n} is an {l}-th power but was rejected");
            non_powers += !is_power as u32;
            rejected += rej as u32;
        }
        assert!(rejected * 10 >= non_powers * 9, "l {l}: only {rejected} of {non_powers} non-powers rejected");
    }
}

/// a x^12 - b with a = 2^(bits-1) + 1 and b = a + 2: perf_bench's binom
/// fixture, a generic non-perfect-power binomial.
fn binom(bits: u32) -> ZPoly {
    let a: BigInt = (BigInt::one() << (bits - 1)) + 1;
    let mut f = vec![BigInt::zero(); 13];
    f[0] = -(a.clone() + BigInt::from(2));
    f[12] = a;
    f
}

/// The generic binom4097 fixture (the 89.8x regression of the r3 perf run)
/// and its larger siblings are rejected by the residue prefilter before any
/// bisection, with every witness evaluation debited; they then factor as
/// before (the general path).
#[test]
fn a_generic_binomial_is_rejected_before_any_bisection() {
    for bits in [4097u32, 8192, 16384] {
        let f = binom(bits);
        let b = Budget::unlimited();
        let (r, a) = audit::during(|| try_factor_with(&f, &b));
        let (c, fs) = r.unwrap();
        assert_eq!(expand(&c, &fs), f, "{bits} bits");
        assert_eq!(a.bisections, 0, "{bits} bits: {a:?}");
        assert!(a.prefilter_rejects >= 1 && a.prefilter_evals >= a.prefilter_rejects, "{bits} bits: {a:?}");
        // each call debits its fold (limbs + 1), each witness at least 130
        assert!(a.pp_used >= a.prefilter_calls * (limbs(bits as u64) + 1) + a.prefilter_evals * 130, "{bits} bits: the prefilter's work not debited: {a:?}");
        assert!(a.proof_preflight >= a.pp_used && a.pp_preflight == 0, "{bits} bits: the proof alone is admitted: {a:?}");
        assert_eq!(b.live(), 0);
    }
}

/// The early proof allocates nothing coefficient-sized: not_a_power streams
/// borrowed limbs (zero bytes allocated, through both tiers), and stage_b
/// proves g = 1 before any copy, reservation or conversion buffer (its live
/// peak stays below one coefficient's size) (CORR-R3-BIN5-R3-1/2, PREF-MEM-1).
#[test]
fn the_early_proof_allocates_nothing_coefficient_sized() {
    let b = Budget::unlimited();
    for bits in [4097u32, 16384, 65536] {
        let f = binom(bits);
        for (n, l) in [(&f[0], 2u64), (&f[12], 3), (&(BigInt::from(3).pow(bits / 2)), 2), (&(BigInt::from(5).pow(bits / 3)), 7)] {
            let before = crate::alloc_spy::allocated();
            not_a_power(&b, n, l).unwrap();
            assert_eq!(crate::alloc_spy::allocated(), before, "{bits} bits, l {l}: the prefilter allocated");
        }
    }
    for bits in [16384u32, 65536] {
        let f = binom(bits);
        let b = Budget::unlimited();
        let (r, peak) = crate::alloc_spy::peak_during(|| stage_b(&b, 12, &f[12], &f[0]).map(|o| o.is_none()));
        assert!(r.unwrap(), "{bits} bits: g = 1 proved");
        assert!(peak < (bits / 8) as i64, "{bits} bits: live peak {peak} B, a coefficient is {} B", bits / 8);
        assert_eq!(b.live(), 0);
    }
}

/// The residue proof is admitted on its own (PREF-WORK-1): a generic
/// non-power needs only the proof's work, never the bisection plan's.  Less
/// work than that plan alone factors it (the old order refused there); at the
/// least work that does, it makes no bisection and multiplies back; one unit
/// less is refused.  And stage_b
/// alone: the divisor scan plus exactly the proof's preflight returns g = 1,
/// one unit less refuses for that preflight, before any work or copy.
#[test]
fn a_generic_binomial_needs_only_the_proofs_work() {
    for bits in [4097u32, 8192, 16384] {
        let f = binom(bits);
        let ok = |w: u64| {
            let b = Budget::new(Limits { work: w, ..Limits::DEFAULT });
            try_factor_with(&f, &b).is_ok()
        };
        let probe = Budget::unlimited();
        let (r, a) = audit::during(|| try_factor_with(&f, &probe));
        r.unwrap();
        // less work than the bisection plan alone suffices (the old order
        // refused below it); then the least that does
        let plan = plan_powers(bits as u64, 12, &[2, 3]).unwrap();
        let (mut lo, mut hi) = (0u64, plan - 1);
        assert!(ok(hi), "{bits} bits: refused below the bisection plan ({plan}) it never runs");
        while lo + 1 < hi {
            let mid = lo + (hi - lo) / 2;
            if ok(mid) {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        assert!(hi >= a.proof_preflight, "{bits} bits: least work {hi} below the proof's preflight");
        let b = Budget::new(Limits { work: hi, ..Limits::DEFAULT });
        let (r, a2) = audit::during(|| try_factor_with(&f, &b));
        let (c, fs) = r.unwrap();
        assert_eq!(expand(&c, &fs), f);
        assert_eq!(a2.bisections, 0, "{bits} bits: {a2:?}");
        assert!(!ok(hi - 1));
        // stage_b alone, at the proof's exact admission
        let ub = Budget::unlimited();
        let before = ub.work_left();
        divisors_and_primes(&ub, 12).unwrap();
        let scan = before - ub.work_left();
        let need = a.proof_preflight;
        let b = Budget::new(Limits { work: scan + need, ..Limits::DEFAULT });
        assert!(stage_b(&b, 12, &f[12], &f[0]).unwrap().is_none(), "{bits} bits");
        let b = Budget::new(Limits { work: scan + need - 1, ..Limits::DEFAULT });
        let start = crate::alloc_spy::allocated();
        let e = stage_b(&b, 12, &f[12], &f[0]).err().unwrap();
        assert_eq!((e.what, e.need, e.phase), ("work", need, Phase::PerfectPower), "{bits} bits: {e}");
        assert!(crate::alloc_spy::allocated() - start < 1024, "{bits} bits: allocated before the refusal");
        assert_eq!(b.live(), 0);
    }
}

/// Exact roots: powers and non-powers, signs, the quick rejections.
#[test]
fn exact_roots() {
    let b = Budget::unlimited();
    for l in [2u64, 3, 5, 7, 11, 13] {
        for t in [1i64, 2, 3, 10, 12345, 999_999_937] {
            let n = BigInt::from(t).pow(l as u32);
            assert_eq!(exact_root(&b, &n, l).unwrap(), Some(BigInt::from(t)));
            if t > 1 {
                assert_eq!(exact_root(&b, &(&n + 1), l).unwrap(), None);
                assert_eq!(exact_root(&b, &(&n - 1), l).unwrap(), None);
            }
        }
    }
    let big: BigInt = (BigInt::from(3) << 1000u32) + 7;
    assert_eq!(exact_root(&b, &big.pow(3), 3).unwrap(), Some(big.clone()));
    assert_eq!(exact_root(&b, &BigInt::from(2), 5).unwrap(), None);
}

/// The descending division by x^e - 1 against lib.rs's dense exact
/// division, on random dividends (exact and not), and the review's example
/// (x^2 + 1)/(x - 1): R_0 = 2 (CORR-BINOM-PLAN-2).
#[test]
fn sparse_division_matches_dense() {
    assert_eq!(div_binom(&z(&[1, 0, 1]), 1), None);
    let b = Budget::unlimited();
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for _ in 0..2000 {
        let e = 1 + (next() % 7) as usize;
        let n = (next() % 12) as usize;
        let q: ZPoly = (0..=n).map(|_| BigInt::from((next() % 21) as i64 - 10)).collect();
        let mut a = zmul(&b, &q, &xn(e, -1)).unwrap().into_vec();
        if a.is_empty() {
            continue;
        }
        if next() % 2 == 0 {
            let i = (next() as usize) % a.len();
            a[i] += 1 + (next() % 3) as i64;
        }
        let a = trim(a);
        if a.is_empty() {
            continue;
        }
        let dense = divexact(&b, &a, &xn(e, -1)).unwrap().map(|h| h.into_vec());
        let sparse = div_binom(&a, e).map(trim);
        assert_eq!(sparse, dense, "{:?} / (x^{} - 1)", a, e);
    }
}

/// Each injected fault fails the call, with no result (plan r3, section 6
/// item 3).
#[test]
fn every_verification_refuses_its_fault() {
    let cases: Vec<(u8, ZPoly, &str)> = vec![
        (fault::KERNEL_COEFF, xn(60, -1), "cyclotomic verification (chain)"),
        (fault::NOT_EXACT, xn(60, -1), "cyclotomic verification (division)"),
        (fault::DUPLICATE_INDEX, xn(60, -1), "cyclotomic verification (index set)"),
        (fault::MISSING_INDEX, xn(60, 1), "cyclotomic verification (index set)"),
        (fault::OUTPUT_POSITION, xn(4, -1), "cyclotomic verification (output)"),
        // the review's example: x^4 - 16, H_4 = x^2 + 4 corrupted to x^2 + x + 4
        (fault::PIECE_COEFF, xn(4, -16), "binomial verification"),
        (fault::PIECE_POSITION, xn(8, -16), "binomial verification"),
    ];
    for (f, input, what) in cases {
        let b = Budget::default();
        let r = fault::with(f, || try_factor_with(&input, &b));
        let e = r.expect_err("a fault must fail the call");
        assert_eq!(e.what, what, "fault {}", f);
        assert_eq!(b.live(), 0);
        // and without the fault the same input factors
        assert!(try_factor(&input).is_ok());
    }
}

/// Each preflight refuses a budget just under its ledger, before the
/// stage allocates (plan r3, 4.1-4.4 and section 6 item 4).
#[test]
fn preflights_refuse_before_allocating() {
    // Stage A: the cyclotomic preflight of x^5040 - 1
    let n = 5040u64;
    let ub = Budget::unlimited();
    let (all, primes) = divisors_and_primes(&ub, n).unwrap();
    let mut ks: Vec<u64> = vec![];
    for &d in &all {
        let mut r = rad(d, &primes);
        loop {
            if let Err(i) = ks.binary_search(&r) {
                ks.insert(i, r);
            }
            if r == 1 {
                break;
            }
            r /= primes_of(r, &primes).last().unwrap();
        }
    }
    let plan = plan_cyclotomics(&all, &ks, &primes).unwrap();
    let m0 = plan.memory().unwrap();
    // the enumeration's own debits: sqrt n + 1, then one per closure step
    let probe = Budget::unlimited();
    let before = probe.work_left();
    stage_a(&probe, n, false).unwrap();
    let used = before - probe.work_left();
    assert!(used <= plan.work + n.sqrt() + 1 + (all.len() * ks.len()) as u64, "Stage A ledger: used {} > plan {}", used, plan.work);
    // find the smallest work that succeeds: one less refuses at a preflight
    let ok = |w: u64| {
        let b = Budget::new(Limits { work: w, ..Limits::DEFAULT });
        let r = stage_a(&b, n, false).is_ok();
        r
    };
    let (mut lo, mut hi) = (0u64, used);
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        if ok(mid) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    let b = Budget::new(Limits { work: hi - 1, ..Limits::DEFAULT });
    let (r, bytes) = crate::tests::allocated_by(|| stage_a(&b, n, false).map(|v| v.len()));
    let e = r.unwrap_err();
    assert_eq!((e.phase, e.what), (Phase::Cyclotomic, "work"));
    assert_eq!(e.need, plan.work, "refused by the preflight, for the whole ledger");
    assert!(bytes < 64 << 10 && bytes * 8 < m0, "{} bytes allocated before the refusal", bytes);
    // memory: one byte under the aggregate refuses at a reservation, before
    // the kernels exist; the aggregate itself suffices
    let m = plan.memory().unwrap();
    let b = Budget::new(Limits { memory: m - 1, ..Limits::DEFAULT });
    let (r, bytes) = crate::tests::allocated_by(|| stage_a(&b, n, false).map(|v| v.len()));
    assert_eq!(r.unwrap_err().what, "memory");
    assert!(bytes < 64 << 10 && bytes * 8 < m0, "{} bytes allocated before the refusal", bytes);
    assert_eq!(b.live(), 0);
    let b = Budget::new(Limits { memory: m, ..Limits::DEFAULT });
    let (r, peak) = crate::alloc_spy::peak_during(|| stage_a(&b, n, false).map(|v| v.len()));
    r.unwrap();
    assert!(peak as u64 <= m + (16 << 10), "peak {} above the aggregate {}", peak, m);

    // Stage B: the perfect-power preflight U, then the homogenization's
    let (a, c0) = (BigInt::from(16), BigInt::from(-81));
    let m = 12u64;
    let (_, mprimes) = divisors_and_primes(&ub, m).unwrap();
    let u = plan_powers(7, m, &mprimes).unwrap();
    let b = Budget::new(Limits { work: m.sqrt() + 1 + u - 1, ..Limits::DEFAULT });
    let e = stage_b(&b, m, &a, &c0).err().unwrap();
    assert_eq!((e.phase, e.what, e.need), (Phase::PerfectPower, "work", u));
    assert_eq!(b.live(), 0);
    // work just under success: refused at a preflight (homogenization or
    // cyclotomic), never mid-stage
    let probe = Budget::unlimited();
    let before = probe.work_left();
    stage_b(&probe, m, &a, &c0).unwrap().unwrap();
    let used = before - probe.work_left();
    let ok = |w: u64| {
        let b = Budget::new(Limits { work: w, ..Limits::DEFAULT });
        let r = stage_b(&b, m, &a, &c0).is_ok();
        r
    };
    let (mut lo, mut hi) = (0u64, used);
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        if ok(mid) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    let b = Budget::new(Limits { work: hi - 1, ..Limits::DEFAULT });
    let e = stage_b(&b, m, &a, &c0).err().unwrap();
    assert_eq!(e.what, "work");
    assert!(e.need > 1, "refused by a preflight's total, not a single step: {}", e);
    assert_eq!(b.live(), 0);
}

/// The live memory never exceeds the limit, refusing or not, for Stage A
/// and Stage B (the #46 sweep, extended).
#[test]
fn live_memory_stays_within_the_budget() {
    let mut f16 = xn(12, -81);
    f16[12] = BigInt::from(16);
    for input in [xn(5040, -1), xn(9240, 1), f16, xn(8, -16), power_binomial(5040, 2, 3)] {
        let mut limit: u64 = 1 << 10;
        while limit <= 64 << 20 {
            let b = Budget::new(Limits { memory: limit, ..Limits::DEFAULT });
            let (r, peak) = crate::alloc_spy::peak_during(|| try_factor_with(&input, &b).map(|x| x.1.len()));
            assert!(peak <= limit as i64 + (32 << 10), "limit {}: peak {} ({:?})", limit, peak, r);
            if let Err(e) = &r {
                assert!(e.what == "memory" || e.what == "work", "limit {}: {}", limit, e);
            }
            assert_eq!(b.live(), 0);
            limit *= 4;
        }
    }
}
