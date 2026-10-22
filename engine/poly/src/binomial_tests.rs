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

/// A coefficient above BINOMIAL_MAX_BITS takes today's path (Sage:
/// (2^2100 x - 1)(2^2100 x + 1)).
#[test]
fn above_the_bits_cap_takes_the_general_path() {
    let big = BigInt::one() << 4200u32;
    let f = vec![-BigInt::one(), BigInt::zero(), big.clone()];
    let b = Budget::default();
    let (c, fs) = try_factor_with(&f, &b).unwrap();
    let h = BigInt::one() << 2100u32;
    assert_eq!((c, fs), (BigInt::one(), vec![(vec![-BigInt::one(), h.clone()], 1), (vec![BigInt::one(), h], 1)]));
    assert!(!b.debited(Phase::PerfectPower) && b.debited(Phase::Modular));
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
    for input in [xn(5040, -1), xn(9240, 1), f16, xn(8, -16)] {
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
