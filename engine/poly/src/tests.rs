use super::*;
use crate::budget::{Limits, PHASES};

fn z(v: &[i64]) -> ZPoly {
    v.iter().map(|&x| BigInt::from(x)).collect()
}

fn prod(fs: &[ZPoly]) -> ZPoly {
    let b = Budget::unlimited();
    fs.iter().fold(z(&[1]), |acc, f| zmul(&b, &acc, f).unwrap().into_vec())
}

/// x^n - 1 (or + 1)
fn xn(n: usize, c: i64) -> ZPoly {
    let mut v = vec![BigInt::zero(); n + 1];
    v[0] = BigInt::from(c);
    v[n] = BigInt::one();
    v
}

/// The cyclotomic polynomial Phi_n, by exact division of x^n - 1.
fn cyclotomic(n: usize) -> ZPoly {
    let b = Budget::unlimited();
    let mut f = xn(n, -1);
    for d in 1..n {
        if n % d == 0 {
            f = divexact(&b, &f, &cyclotomic(d)).unwrap().unwrap().into_vec();
        }
    }
    f
}

/// The Swinnerton-Dyer polynomial S_k: prod (x +- sqrt2 +- sqrt3 +- ...),
/// built as a resultant-free product: S_1 = x^2 - 2, S_{k}(x) =
/// S_{k-1}(x + sqrt(p)) S_{k-1}(x - sqrt(p)) = Res_y(S_{k-1}(x - y), y^2 - p).
pub(crate) fn swinnerton_dyer(k: usize) -> ZPoly {
    let primes = [2i64, 3, 5, 7, 11, 13, 17, 19];
    // represent elements of Z[x][sqrt p] as (a, b) = a + b sqrt p
    let b = Budget::unlimited();
    let mut s = z(&[-2, 0, 1]);
    for &p in &primes[1..k] {
        // S(x + sqrt p) = A + B sqrt p, by Horner in Z[x][sqrt p]
        let (mut a, mut c): (ZPoly, ZPoly) = (vec![], vec![]);
        for coef in s.iter().rev() {
            // (a + c sqrt p)(x + sqrt p) + coef
            let na = zsub(&b, &zmul(&b, &a, &z(&[0, 1])).unwrap(), &zmul(&b, &c, &z(&[-p])).unwrap()).unwrap().into_vec();
            let nc = zsub(&b, &zmul(&b, &c, &z(&[0, 1])).unwrap(), &zmul(&b, &a, &z(&[-1])).unwrap()).unwrap().into_vec();
            a = zsub(&b, &na, &[-coef.clone()]).unwrap().into_vec();
            c = nc;
        }
        // S(x + sqrt p) S(x - sqrt p) = A^2 - p B^2
        let a2 = zmul(&b, &a, &a).unwrap();
        let c2 = zmul(&b, &zmul(&b, &c, &c).unwrap(), &z(&[p])).unwrap();
        s = zsub(&b, &a2, &c2).unwrap().into_vec();
    }
    s
}

/// Check a factorization: the product is f, the factors primitive with
/// positive leading coefficients, sorted.
fn check(f: &ZPoly, c: &BigInt, fs: &[(ZPoly, u32)]) {
    let b = Budget::unlimited();
    let mut p = vec![c.clone()];
    for (g, e) in fs {
        assert!(g.last().unwrap().is_positive());
        assert!(content(&b, g).unwrap().is_one());
        for _ in 0..*e {
            p = zmul(&b, &p, g).unwrap().into_vec();
        }
    }
    assert_eq!(&p, f);
}

#[test]
fn irreducible_over_q_ignores_content() {
    for c in [-15i64, -2, -1, 1, 2, 3, 12] {
        assert!(is_irreducible(&z(&[c, c])), "{} (x + 1)", c);
        assert!(is_irreducible(&z(&[c, 0, c])), "{} (x^2 + 1)", c);
        assert!(!is_irreducible(&z(&[-c, 0, c])), "{} (x^2 - 1)", c);
        assert!(!is_irreducible(&z(&[c])), "{}", c);
        assert!(!is_irreducible(&[]) && !is_irreducible(&z(&[0, 0])));
        assert!(!is_irreducible(&z(&[c, 2 * c, c])), "{} (x + 1)^2", c);
    }
}

#[test]
fn factoring_mod_p() {
    // products of known factors with multiplicities, in several
    // characteristics (2 and 3 exercise the p-th root step)
    let b = Budget::unlimited();
    for &p in &[2u64, 3, 5, 7, 101, 65521] {
        let mut rng = Rng(p * 7919 + 1);
        for _ in 0..30 {
            let mut f: Vec<BigInt> = z(&[1]);
            for _ in 0..1 + rng.next() % 4 {
                let d = 1 + (rng.next() % 4) as usize;
                let mut g: Vec<BigInt> = (0..d).map(|_| BigInt::from(rng.next() % p)).collect();
                g.push(BigInt::one());
                for _ in 0..1 + rng.next() % 3 {
                    f = zmul(&b, &f, &g).unwrap().into_vec();
                }
            }
            let fac = factor_mod(&f, p);
            let mut pr: Vec<u64> = vec![1];
            for (g, e) in &fac {
                // irreducible: one distinct-degree piece of full degree
                let dd = oracle::ddf(&b, g, p).unwrap();
                assert!(dd.len() == 1 && dd[0].1 == g.len() - 1, "reducible factor {:?} mod {}", g, p);
                for _ in 0..*e {
                    pr = fmul(&b, &pr, g, p).unwrap();
                }
            }
            assert_eq!(pr, fmonic(&reduce_p(&f, p), p), "f = {:?} mod {}", f, p);
        }
    }
}

#[test]
fn small() {
    assert_eq!(factor(&z(&[2, -4, 4, -4, 2])), (BigInt::from(2), vec![(z(&[-1, 1]), 2), (z(&[1, 0, 1]), 1)]));
    assert_eq!(factor(&z(&[0, -6, -1, 1])), (BigInt::one(), vec![(z(&[-3, 1]), 1), (z(&[0, 1]), 1), (z(&[2, 1]), 1)]));
    assert_eq!(factor(&z(&[-1, 0, 0, 0, 1])), (BigInt::one(), vec![(z(&[-1, 1]), 1), (z(&[1, 1]), 1), (z(&[1, 0, 1]), 1)]));
    assert_eq!(factor(&z(&[1, 0, 0, 0, 1])), (BigInt::one(), vec![(z(&[1, 0, 0, 0, 1]), 1)]));
    assert_eq!(factor(&z(&[-12, -12])), (BigInt::from(-12), vec![(z(&[1, 1]), 1)]));
    assert_eq!(factor(&z(&[5])), (BigInt::from(5), vec![]));
}

#[test]
fn swinnerton_dyer_8_builds() {
    // S_7's coefficients overflow i64: the helper keeps them as BigInt
    let f = swinnerton_dyer(8);
    assert_eq!(f.len(), 257);
    assert!(f[256].is_one());
    assert!(f.iter().any(|c| c.to_i64().is_none()));
}

#[test]
fn swinnerton_dyer_small() {
    // the minimal polynomial of sqrt2 + sqrt3 + sqrt5: irreducible, but
    // a product of linear and quadratic factors modulo every prime
    let f = z(&[576, 0, -960, 0, 352, 0, -40, 0, 1]);
    assert_eq!(swinnerton_dyer(3), f);
    assert_eq!(factor(&f).1, vec![(f.clone(), 1)]);
}

#[test]
fn swinnerton_dyer_lattice() {
    // S_4 (degree 16) and S_5 (degree 32): irreducible, 8 and 16 modular
    // factors at least: S_5 goes through the lattice
    for k in [4, 5] {
        let f = swinnerton_dyer(k);
        let b = Budget::default();
        let (c, fs) = try_factor_with(&f, &b).unwrap();
        assert_eq!((c, fs.clone()), (BigInt::one(), vec![(f.clone(), 1)]), "S_{}", k);
        if k == 5 {
            assert!(b.debited(Phase::Lll), "S_5 went through the lattice");
        }
    }
}

#[test]
fn x_n_minus_1() {
    // x^n - 1 = prod_{d | n} Phi_d: many modular factors, few over Q
    for n in [12usize, 30, 60, 105, 120] {
        let f = xn(n, -1);
        let b = Budget::default();
        let (c, fs) = try_factor_with(&f, &b).unwrap();
        check(&f, &c, &fs);
        let mut want: Vec<(ZPoly, u32)> = (1..=n).filter(|d| n % d == 0).map(|d| (cyclotomic(d), 1)).collect();
        want.sort_by(|x, y| x.0.len().cmp(&y.0.len()).then_with(|| x.0.iter().rev().cmp(y.0.iter().rev())));
        assert_eq!(fs, want, "x^{} - 1", n);
    }
}

#[test]
fn non_monic_negative_content_repeated() {
    // -6 (2x + 3)^2 (x^2 + 1) (3x^3 - 2): signed content, positive primitive factors
    let f = prod(&[z(&[-6]), z(&[3, 2]), z(&[3, 2]), z(&[1, 0, 1]), z(&[-2, 0, 0, 3])]);
    let (c, fs) = factor(&f);
    assert_eq!(c, BigInt::from(-6));
    assert_eq!(fs, vec![(z(&[3, 2]), 2), (z(&[1, 0, 1]), 1), (z(&[-2, 0, 0, 3]), 1)]);
    check(&f, &c, &fs);
}

#[test]
fn prepass_then_lattice_and_linear_factors() {
    // prod (x - k), k = 1..40: found by the pre-pass alone
    let f = prod(&(1..=40).map(|k| z(&[-k, 1])).collect::<Vec<_>>());
    let b = Budget::default();
    let (c, fs) = try_factor_with(&f, &b).unwrap();
    check(&f, &c, &fs);
    assert_eq!(fs.len(), 40);
    // x (x - 1) S_5: the pre-pass finds x and x - 1, the lattice S_5
    let s5 = swinnerton_dyer(5);
    let g = prod(&[z(&[0, 1]), z(&[-1, 1]), s5.clone()]);
    let b = Budget::default();
    let (c, fs) = try_factor_with(&g, &b).unwrap();
    check(&g, &c, &fs);
    assert_eq!(fs.len(), 3);
    assert!(b.debited(Phase::Prepass));
}

#[test]
fn limits_refuse_and_never_return_a_residual() {
    let s5 = swinnerton_dyer(5);
    // a small subset budget: the fallback path refuses (with the lattice
    // run normally this works; force refusal by starving work instead)
    let b = Budget::new(Limits { work: 1 << 16, ..Limits::DEFAULT });
    let e = try_factor_with(&s5, &b).unwrap_err();
    assert_eq!(e.what, "work");
    assert!(e.to_string().starts_with("factor: resource limit exceeded"));
    // memory: the input copy alone does not fit
    let b = Budget::new(Limits { memory: 64, ..Limits::DEFAULT });
    assert_eq!(try_factor_with(&s5, &b).unwrap_err().what, "memory");
    // admission
    let b = Budget::new(Limits { max_degree: 10, ..Limits::DEFAULT });
    assert_eq!(try_factor_with(&s5, &b).unwrap_err().what, "degree");
    let big = vec![BigInt::one() << 2000u32, BigInt::one()];
    let b = Budget::new(Limits { max_coeff_bits: 1000, ..Limits::DEFAULT });
    assert_eq!(try_factor_with(&big, &b).unwrap_err().what, "coefficient bits");
    // the live reservation is back to zero after a refusal
    assert_eq!(b.live(), 0);
}

/// Bytes this thread allocates while running `f`.
pub(crate) fn allocated_by<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let before = crate::alloc_spy::allocated();
    let r = f();
    (r, crate::alloc_spy::allocated() - before)
}

#[test]
fn refusals_come_before_allocations() {
    // a large input (degree 5000, 2000-bit coefficients: over a megabyte
    // when copied) under a 64 KiB budget: refused before its copy exists
    let mut seed = 99u64;
    let f = random_poly(&mut seed, 5000, 60).into_iter().map(|c| c << 1940u32).collect::<Vec<_>>();
    let b = Budget::new(Limits { memory: 64 << 10, ..Limits::DEFAULT });
    let (r, used) = allocated_by(|| try_factor_with(&f, &b));
    assert_eq!(r.unwrap_err().what, "memory");
    assert!(used < 8 << 10, "public copy: {} bytes before refusing", used);
    // exact division and pseudo-remainder: their working copies refused
    // before they are made
    let x = random_poly(&mut seed, 3000, 60).into_iter().map(|c| c << 900u32).collect::<Vec<_>>();
    let y = z(&[3, 1]);
    let b = Budget::new(Limits { memory: 4 << 10, ..Limits::DEFAULT });
    let (r, used) = allocated_by(|| divexact(&b, &x, &y).map(|q| q.is_some()));
    assert_eq!(r.unwrap_err().what, "memory");
    assert!(used < 1024, "divexact: {} bytes before refusing", used);
    let (r, used) = allocated_by(|| prem(&b, &x, &y).map(|q| q.len()));
    assert_eq!(r.unwrap_err().what, "memory");
    assert!(used < 1024, "prem: {} bytes before refusing", used);
    let (r, used) = allocated_by(|| prim(&b, &x).map(|q| q.len()));
    assert_eq!(r.unwrap_err().what, "memory");
    assert!(used < 1024, "prim: {} bytes before refusing", used);
    assert_eq!(b.live(), 0);
}

#[test]
fn live_memory_stays_within_the_budget() {
    // a low-degree polynomial with huge coefficients, where the p-adic
    // moduli (sized by the precision, not the degree) dominate, and a
    // lattice case: for every memory limit, whether the call refuses or
    // succeeds, the live bytes it allocates never exceed the limit (plus a
    // small slack for the bounded bookkeeping vectors)
    let c = (BigInt::one() << 1u32 << 30_000u32) + BigInt::from(12345);
    let f = prod(&[vec![-c.clone(), BigInt::one()], vec![c + 1u32, BigInt::from(3)], z(&[5, 0, 1])]);
    for input in [f, swinnerton_dyer(5)] {
        let mut limit: u64 = 16 << 10;
        while limit <= 64 << 20 {
            let b = Budget::new(Limits { memory: limit, ..Limits::DEFAULT });
            let (r, peak) = crate::alloc_spy::peak_during(|| try_factor_with(&input, &b).map(|x| x.1.len()));
            assert!(peak <= limit as i64 + (32 << 10), "limit {}: peak {} ({:?})", limit, peak, r);
            if let Err(e) = &r {
                assert!(e.what == "memory" || e.what == "work", "limit {}: {}", limit, e);
            }
            limit *= 2;
        }
        // and with room, it factors
        assert!(try_factor(&input).is_ok());
    }
    // p^k itself is refused before it exists
    let b = Budget::new(Limits { memory: 4096, ..Limits::DEFAULT });
    let (r, used) = allocated_by(|| power(&b, 13, 200_000).map(|x| x.bits()));
    assert_eq!(r.unwrap_err().what, "memory");
    assert!(used < 1024, "power: {} bytes before refusing", used);
}

#[test]
fn calibrated_work() {
    // the constant of the VM 1 calibration (budget.rs), and what it admits:
    // S_6 (about 1/126 of it) and x^120 - 1 (about 1/209) fit far below it
    assert_eq!(Limits::CALIBRATED.work, 1 << 33);
    for f in [swinnerton_dyer(6), xn(120, -1)] {
        let b = Budget::new(Limits::CALIBRATED);
        try_factor_with(&f, &b).unwrap();
        assert!(Limits::CALIBRATED.work - b.work_left() < Limits::CALIBRATED.work / 100);
    }
}

#[test]
fn default_is_unlimited_except_memory() {
    // C0's follow-up: no default work, subset, division or input-size
    // limit; the memory guard stays
    let d = Limits::DEFAULT;
    assert_eq!((d.work, d.subsets, d.divisions), (u64::MAX, u64::MAX, u64::MAX));
    assert_eq!((d.max_degree, d.max_coeff_bits, d.max_total_bits), (usize::MAX, u64::MAX, u64::MAX));
    assert_eq!(d.memory, 512 << 20);
    assert_eq!(Budget::default().limits().memory, 512 << 20);
    // degree 10001: refused at admission by the old finite default, and
    // factored by the new one (x^10001 - 1 = Phi_1 Phi_73 Phi_137 Phi_10001)
    let f = xn(10001, -1);
    let e = try_factor_with(&f, &Budget::new(Limits::CALIBRATED)).unwrap_err();
    assert!(e.to_string().contains("degree"), "{}", e);
    let (c, fs) = try_factor_with(&f, &Budget::default()).unwrap();
    check(&f, &c, &fs);
    assert_eq!(fs.iter().map(|(g, _)| g.len() - 1).collect::<Vec<_>>(), vec![1, 72, 136, 9792]);
    // an explicit finite policy still refuses exactly as before, also as
    // the thread's default
    let tight = Limits { max_degree: 10, ..Limits::CALIBRATED };
    assert!(crate::with_default_limits(tight, || try_factor(&xn(11, -1))).is_err());
    assert!(try_factor(&xn(11, -1)).is_ok());
}

#[test]
fn work_is_aggregate_across_square_free_parts() {
    // S_4^2 * S_4(x + 1): two square-free parts; find the work one part
    // needs, then give the whole call slightly more than that: refused
    let s4 = swinnerton_dyer(4);
    let b1 = Budget::default();
    try_factor_with(&s4, &b1).unwrap();
    let one = Limits::DEFAULT.work - b1.work_left();
    let f = prod(&[s4.clone(), s4.clone(), z(&[-3, 1])]);
    let b = Budget::new(Limits { work: one + one / 4, ..Limits::DEFAULT });
    assert!(try_factor_with(&f, &b).is_err());
    let b = Budget::default();
    let (c, fs) = try_factor_with(&f, &b).unwrap();
    check(&f, &c, &fs);
}

#[test]
fn every_phase_debits() {
    // a call through the lattice debits in every phase it runs
    let f = prod(&[z(&[0, 1]), z(&[-1, 1]), swinnerton_dyer(5), z(&[1, 1]), z(&[1, 1])]);
    let b = Budget::default();
    let (c, fs) = try_factor_with(&f, &b).unwrap();
    check(&f, &c, &fs);
    for p in [Phase::Squarefree, Phase::Modular, Phase::Hensel, Phase::Prepass, Phase::Cld, Phase::Lattice, Phase::Lll, Phase::Echelon, Phase::Reconstruct] {
        assert!(b.debited(p), "{:?} did not debit", p);
    }
    assert_eq!(b.debit_counts().len(), PHASES);
    assert_eq!(b.live(), 0);
}

/// A pseudo-random polynomial of degree d with coefficients below 2^bits.
fn random_poly(seed: &mut u64, d: usize, bits: u32) -> ZPoly {
    let mut v: ZPoly = (0..d)
        .map(|_| {
            *seed ^= *seed << 13;
            *seed ^= *seed >> 7;
            *seed ^= *seed << 17;
            BigInt::from(*seed % (1u64 << bits)) - BigInt::from(1u64 << (bits - 1))
        })
        .collect();
    v.push(BigInt::one());
    v
}

/// The calibration of W (plan r3, 5.1): units debited per second on cases
/// that stress each helper; W = 60 s times the slowest throughput.
#[test]
#[ignore]
fn timings() {
    let mut seed = 0x1234_5678_9abc_def1u64;
    let mut cases: Vec<(String, ZPoly)> = vec![
        ("S_5".into(), swinnerton_dyer(5)),
        ("S_6".into(), swinnerton_dyer(6)),
        ("x^60-1".into(), xn(60, -1)),
        ("x^120-1".into(), xn(120, -1)),
        ("x^240-1".into(), xn(240, -1)),
        // binomials (plan factor-binomial r3, section 6 item 5)
        ("x^1000-1".into(), xn(1000, -1)),
        ("x^5040-1".into(), xn(5040, -1)),
        ("x^10000-1".into(), xn(10000, -1)),
        ("x^9240+1".into(), xn(9240, 1)),
    ];
    // Stage B: 2^4080 x^9240 - 1 (the perfect-power search finds g = 120;
    // pieces of degree up to 32 * 77 go on to the general path)
    let mut f = xn(9240, -1);
    f[9240] = BigInt::one() << 4080u32;
    cases.push(("2^4080 x^9240 - 1".into(), f));
    for &(d, bits) in &[(100usize, 20u32), (300, 20), (600, 8), (1000, 4)] {
        let a = random_poly(&mut seed, d, bits);
        let c = random_poly(&mut seed, d, bits);
        cases.push((format!("dense {}x{} ({} bits)", d, d, bits), prod(&[a, c])));
    }
    let a = random_poly(&mut seed, 400, 4);
    cases.push(("square (deg 400)^2 * x^2+1".into(), prod(&[a.clone(), a, z(&[1, 0, 1])])));
    // the wasm comparison's case (the same polynomial in the Sage script)
    let a: ZPoly = (0..300).map(|i| BigInt::from((i * 7919) % 13 - 6)).chain([BigInt::one()]).collect();
    let c: ZPoly = (0..300).map(|i| BigInt::from((i * 104729) % 11 - 5)).chain([BigInt::one()]).collect();
    cases.push(("dense300 (wasm comparison)".into(), prod(&[a, c])));
    for (name, f) in cases {
        let b = Budget::default();
        let t = std::time::Instant::now();
        let r = try_factor_with(&f, &b);
        let dt = t.elapsed().as_secs_f64();
        let used = Limits::DEFAULT.work - b.work_left();
        let rate = used as f64 / dt.max(1e-9);
        match r {
            Ok((_, fs)) => println!("TIMING {:32} {:9.4} s {:3} factors  work {:14}  {:.3e} units/s  peak {} KiB  lll {}", name, dt, fs.len(), used, rate, b.peak() / 1024, b.debited(Phase::Lll)),
            Err(e) => println!("TIMING {:32} {:9.4} s refused ({})  work {}  {:.3e} units/s", name, dt, e, used, rate),
        }
    }
}


#[test]
fn the_global_ledger_net_holds() {
    // rank-3 plan r3, section 4.5 (A): at every debit and reservation of a
    // whole factoring, the live bytes allocated stay within the live
    // reservation plus 64 KiB, and no tagged object of the ledger outgrows
    // its own reservation (delta 1 r2 (B))
    for k in [5usize, 6] {
        let f = swinnerton_dyer(k);
        let b = Budget::default();
        let (r, rep) = crate::alloc_spy::audit(|| try_factor_with(&f, &b).map(|x| x.1.len()));
        assert_eq!(r.unwrap(), 1, "S_{k}");
        assert!(rep.excess <= 64 << 10, "S_{k}: {rep:?}");
        assert_eq!(rep.tag_breaches, 0, "S_{k}: {rep:?}");
    }
}

#[test]
fn power_takes_a_u64_exponent() {
    // rank-3 plan r3, section 3.6: x^k with k split at 2^s agrees with
    // BigInt::pow (s small here, so the split path runs: s = 32 in power)
    for x in [2i64, 3, 13, -7] {
        let x = BigInt::from(x);
        for k in (0u64..70).chain([127, 128, 129, 1000]) {
            for s in [1u32, 3, 5] {
                assert_eq!(pow_u64(&x, k, s), x.pow(k as u32), "{x}^{k} split at 2^{s}");
            }
        }
    }
    assert_eq!(power(&Budget::unlimited(), 13, 40).unwrap().v, BigInt::from(13).pow(40));
}

#[test]
fn a_huge_exponent_is_refused_by_its_reservation() {
    // section 3.6: an exponent whose p^k can't be counted in bytes is
    // refused by the reservation even with no memory limit, and one that
    // can is refused by the memory guard; both before anything is built
    let b = Budget::unlimited();
    for k in [u64::MAX, u64::MAX / 2, u64::MAX / 4, 1 << 61] {
        let (r, used) = allocated_by(|| power(&b, 13, k).map(|x| x.bits()));
        // (refused by the byte count, or, when that fits, by the work count)
        let e = r.unwrap_err();
        assert!(e.what == "memory (overflow)" || e.what == "work (overflow)", "k {k}: {e}");
        assert!(used < 1024, "k {k}: {used} bytes before refusing");
    }
    let b = Budget::new(Limits::DEFAULT);
    for k in [1u64 << 32, (1 << 32) + 1, 1 << 40] {
        let (r, used) = allocated_by(|| power(&b, 13, k).map(|x| x.bits()));
        assert_eq!(r.unwrap_err().what, "memory", "k {k}");
        assert!(used < 1024, "k {k}: {used} bytes before refusing");
    }
    assert_eq!(b.live(), 0);
}

// ------------------------------------------------------------------ the modular phase on arith (modp.rs)

/// x^n - 1
fn xn1(n: usize) -> Vec<BigInt> {
    let mut v = vec![BigInt::zero(); n + 1];
    v[0] = BigInt::from(-1);
    v[n] = BigInt::one();
    v
}

/// A monic polynomial of degree n with random coefficients mod p.
fn rand_monic(rng: &mut Rng, n: usize, p: u64) -> Vec<BigInt> {
    let mut v: Vec<BigInt> = (0..n).map(|_| BigInt::from(rng.next() % p)).collect();
    v.push(BigInt::one());
    v
}

/// prod g_i^e_i, the g_i random monic (multiplicities and p-th powers).
fn rand_powers(rng: &mut Rng, parts: &[(usize, u32)], p: u64) -> Vec<BigInt> {
    let b = Budget::unlimited();
    let mut f = z(&[1]);
    for &(d, e) in parts {
        let g = rand_monic(rng, d, p);
        for _ in 0..e {
            f = zmul(&b, &f, &g).unwrap().into_vec();
        }
    }
    f
}

const MODP_PRIMES: [u64; 7] = [2, 3, 5, 7, 65537, 2147483647, 4294967291];

/// The inputs of the equivalence test for p: degrees around the product
/// and division cutoffs (read from arith), x^n - 1, and products with
/// multiplicities and p-th powers.
fn modp_cases(p: u64) -> Vec<Vec<BigInt>> {
    use sagebrush_arith::nmod_poly::{DIV_CUTOFF, MUL_CUTOFF};
    let mut rng = Rng(p.wrapping_mul(0x9E37_79B9) ^ 0x5DEE_CE66);
    let mut out = vec![];
    let top = if p < 1 << 20 { 2 * DIV_CUTOFF } else { DIV_CUTOFF + 2 };
    let mut degs = vec![1, 2, 3, 7, MUL_CUTOFF - 2, MUL_CUTOFF - 1, MUL_CUTOFF, DIV_CUTOFF - 2, DIV_CUTOFF - 1, DIV_CUTOFF, DIV_CUTOFF + 1, top];
    degs.dedup();
    for n in degs {
        out.push(rand_monic(&mut rng, n, p));
    }
    for n in [1, 2, 12, 60, 64, if p < 1 << 20 { 120 } else { 62 }] {
        out.push(xn1(n));
    }
    out.push(rand_powers(&mut rng, &[(1, 3), (2, 2), (5, 1), (3, p.min(7) as u32)], p));
    out.push(rand_powers(&mut rng, &[(4, p.min(5) as u32), (6, 2), (20, 1)], p));
    out.push(rand_powers(&mut rng, &[(1, 2 * p.min(3) as u32), (DIV_CUTOFF / 2, 2)], p));
    out
}

#[test]
fn modp_matches_the_oracle() {
    // the factors, multiplicities and their order, and the generator's
    // state after the call (the same candidates drawn), bit for bit
    for p in MODP_PRIMES {
        for f in modp_cases(p) {
            let (want, want_rng) = oracle::factor_mod(&f, p);
            let (got, got_rng) = factor_mod_draws(&Budget::unlimited(), &f, p, &mut sagebrush_arith::cost::Meter::accounting(u64::MAX)).unwrap();
            assert_eq!(got, want, "p={} deg {}", p, f.len() - 1);
            assert_eq!(got_rng, want_rng, "draws: p={} deg {}", p, f.len() - 1);
        }
    }
}

/// The product of the factors is f mod p, and each factor is irreducible
/// (one distinct-degree piece of its full degree).
fn check_factorization(f: &[BigInt], p: u64, fac: &[(Vec<u64>, u32)]) {
    let b = Budget::unlimited();
    let mut pr: Vec<u64> = vec![1];
    for (g, e) in fac {
        let ar = modp::Fp::new(&b, p, g.len()).unwrap();
        let dd = modp::ddf(&ar, g).unwrap();
        assert!(dd.len() == 1 && dd[0].1 == g.len() - 1, "reducible factor of degree {} mod {}", g.len() - 1, p);
        for _ in 0..*e {
            pr = fmul(&b, &pr, g, p).unwrap();
        }
    }
    assert_eq!(pr, fmonic(&reduce_p(f, p), p), "product mod {}", p);
}

#[test]
fn modp_long_inputs() {
    // past the gcd cutoff (the half-gcd with the call's tables), degrees at
    // powers of two and their neighbors: x^1024 - 1 splits into linear
    // factors mod 65537 (1024 | p - 1), and its derivative has 1024
    // coefficients
    use sagebrush_arith::nmod_poly::GCD_CUTOFF;
    let f = xn1(1024);
    let fac = factor_mod(&f, 65537);
    assert_eq!(fac.len(), 1024);
    check_factorization(&f, 65537, &fac);
    let mut rng = Rng(77);
    for n in [1023, 1024, 1025] {
        let f = rand_monic(&mut rng, n, 2);
        // (both gcd operands of the square-free step past the cutoff)
        let fp = reduce_p(&f, 2);
        assert!(fderivative(&fp, 2).len() > GCD_CUTOFF);
        check_factorization(&f, 2, &factor_mod(&f, 2));
    }
    let f = rand_powers(&mut rng, &[(600, 2), (3, 1)], 3);
    check_factorization(&f, 3, &factor_mod(&f, 3));
}

#[test]
fn modp_memory_within_its_reservation() {
    // the allocator's peak during a call is at most the budget's peak
    // reservation; and the ledger audit at every debit and reservation
    let mut cases: Vec<(u64, Vec<BigInt>)> = vec![];
    for p in [65537u64, 4294967291] {
        // (one prime's tables, then two: 4294967291^2 exceeds the first)
        for f in modp_cases(p) {
            cases.push((p, f));
        }
        for n in [127, 128, 129, 255, 256, 257] {
            cases.push((p, xn1(n)));
        }
    }
    cases.push((65537, xn1(1024)));
    cases.push((65537, xn1(500)));
    let mut rng = Rng(5);
    cases.push((2, rand_monic(&mut rng, 1024, 2)));
    cases.push((3, rand_powers(&mut rng, &[(300, 3), (2, 1)], 3)));
    for (p, f) in cases {
        let b = Budget::unlimited();
        let ((r, peak), rep) = alloc_spy::audit(|| alloc_spy::peak_during(|| factor_mod_with(&b, &f, p).map(|v| v.len())));
        assert!(r.is_ok());
        assert!(peak as u64 <= b.peak(), "p={} deg {}: allocated peak {} > reserved {}", p, f.len() - 1, peak, b.peak());
        assert!(rep.excess <= 0, "p={} deg {}: {} bytes over the reservation in {}", p, f.len() - 1, rep.excess, rep.excess_phase);
        assert_eq!(b.live(), 0);
    }
}

#[test]
fn modp_every_operation_debits_before_it_allocates() {
    // an Fp whose budget has exactly the tables' work: no work is left, so
    // each charged operation must refuse as work, allocating nothing (an
    // operation that skipped its debit would run, allocate, and fail this)
    let p = 65537u64;
    let len = 200;
    let w = Budget::unlimited();
    drop(modp::Fp::new(&w, p, len).unwrap());
    let tables = u64::MAX - w.work_left();
    let b = Budget::new(Limits { work: tables, ..Limits::UNLIMITED });
    let fp = modp::Fp::new(&b, p, len).unwrap();
    assert_eq!(b.work_left(), 0);
    // operands: a modulus built on an unlimited budget, reduced residues
    let w2 = Budget::unlimited();
    let wide = modp::Fp::new(&w2, p, len).unwrap();
    let mut r = Rng(17);
    let mut f: Vec<u64> = (0..len - 1).map(|_| r.next() % p).collect();
    f.push(1);
    let pm = wide.modulus(&f).unwrap();
    let a: Vec<u64> = (0..len - 1).map(|_| r.next() % p).collect();
    let x: Vec<u64> = (0..2 * len - 3).map(|_| r.next() % p).collect();
    let ops: Vec<(&str, Box<dyn Fn() -> FResult<()> + '_>)> = vec![
        ("divrem", Box::new(|| fp.divrem(&a, &f[..60]).map(|_| ()))),
        ("quo", Box::new(|| fp.quo(&a, &f[..60]).map(|_| ()))),
        ("gcd", Box::new(|| fp.gcd(&a, &f).map(|_| ()))),
        ("modulus", Box::new(|| fp.modulus(&f).map(|_| ()))),
        ("reduce", Box::new(|| fp.reduce(&pm, &x).map(|_| ()))),
        ("mulmod", Box::new(|| fp.mulmod(&pm, &a, &a).map(|_| ()))),
        ("powmod", Box::new(|| fp.powmod(&pm, &a, &[p]).map(|_| ()))),
        ("linear", Box::new(|| fp.linear(a.len()))),
    ];
    for (name, op) in ops {
        let before = alloc_spy::allocated();
        let e = match op() {
            Err(e) => e,
            Ok(()) => panic!("{name}: ran with no work left (its debit is missing)"),
        };
        assert!(e.kind == Kind::Resource && e.what == "work", "{name}: {e}");
        assert_eq!(alloc_spy::allocated(), before, "{name}: allocated before its refusal");
    }
}

#[test]
fn modp_zero_divisor_is_an_internal_error() {
    // a zero or untrimmed divisor or modulus can only be a bug in the
    // factoring: it is reported as an internal error, before any debit or
    // allocation, never as a resource limit (or a panic)
    let b = Budget::unlimited();
    let fp = modp::Fp::new(&b, 65537, 8).unwrap();
    let work = b.work_left();
    let before = alloc_spy::allocated();
    // empty, zero, and untrimmed (a zero leading coefficient, not a unit)
    for y in [&[][..], &[0], &[1, 0], &[3, 0, 0]] {
        let e = fp.divrem(&[1, 2, 3], y).unwrap_err();
        assert!(e.kind == Kind::Internal, "{y:?}: {e}");
        let e = fp.quo(&[1, 2, 3], y).unwrap_err();
        assert!(e.kind == Kind::Internal, "{y:?}: {e}");
        let e = fp.modulus(y).map(|_| ()).unwrap_err();
        assert!(e.kind == Kind::Internal, "{y:?}: {e}");
    }
    assert_eq!(b.work_left(), work);
    assert_eq!(alloc_spy::allocated(), before);
}

#[test]
fn modp_memory_at_its_exact_reservation() {
    // the boundary: a call's measured peak reservation as the memory limit
    // admits it (the allocator's peak within it, the ledger audit clean,
    // the same factors); one byte less refuses it as memory, with nothing
    // left reserved and the allocator back where it started
    let mut rng = Rng(11);
    let cases: Vec<(u64, Vec<BigInt>)> = vec![
        (65537, xn1(120)),
        (65537, xn1(500)),
        (4294967291, xn1(256)),
        (2, rand_monic(&mut rng, 300, 2)),
        (3, rand_powers(&mut rng, &[(40, 3), (2, 1), (7, 2)], 3)),
    ];
    for (p, f) in cases {
        let w = Budget::unlimited();
        let want = factor_mod_with(&w, &f, p).unwrap();
        let need = w.peak();
        let b = Budget::new(Limits { memory: need, ..Limits::UNLIMITED });
        let ((r, peak), rep) = alloc_spy::audit(|| alloc_spy::peak_during(|| factor_mod_with(&b, &f, p)));
        assert_eq!(r.unwrap(), want, "p={} deg {}", p, f.len() - 1);
        assert!(peak as u64 <= need, "p={} deg {}: allocated peak {} > reservation {}", p, f.len() - 1, peak, need);
        assert!(rep.excess <= 0, "p={} deg {}: {} bytes over the reservation in {}", p, f.len() - 1, rep.excess, rep.excess_phase);
        assert_eq!(b.live(), 0);
        let b = Budget::new(Limits { memory: need - 1, ..Limits::UNLIMITED });
        let before = alloc_spy::live();
        let e = factor_mod_with(&b, &f, p).unwrap_err();
        assert!(e.kind == Kind::Resource && e.what == "memory", "{e}");
        assert_eq!(b.live(), 0);
        assert_eq!(alloc_spy::live(), before, "p={} deg {}: allocations left after the refusal", p, f.len() - 1);
    }
}

#[test]
fn modp_refuses_before_its_tables() {
    for (p, len) in [(65537u64, 300usize), (4294967291, 1025)] {
        let need = modp::fp_bytes(len).unwrap();
        // memory: one byte short, nothing allocated, nothing left reserved
        let b = Budget::new(Limits { memory: need - 1, ..Limits::UNLIMITED });
        let before = alloc_spy::allocated();
        let r = modp::Fp::new(&b, p, len).map(|_| ());
        assert_eq!(alloc_spy::allocated(), before, "allocated before the refusal");
        let e = r.unwrap_err();
        assert!(e.kind == Kind::Resource && e.what == "memory", "{e}");
        assert_eq!(b.live(), 0);
        // work: the tables' work one short, the same
        let b = Budget::new(Limits { memory: need, ..Limits::UNLIMITED });
        let w = Budget::unlimited();
        drop(modp::Fp::new(&w, p, len).unwrap());
        let tables = u64::MAX - w.work_left();
        let b2 = Budget::new(Limits { memory: need, work: tables - 1, ..Limits::UNLIMITED });
        let before = alloc_spy::allocated();
        let r = modp::Fp::new(&b2, p, len).map(|_| ());
        assert_eq!(alloc_spy::allocated(), before);
        assert!(r.unwrap_err().what == "work");
        assert_eq!(b2.live(), 0);
        // exactly enough: built
        let fp = modp::Fp::new(&b, p, len).unwrap();
        assert_eq!(b.live(), need);
        drop(fp);
        assert_eq!(b.live(), 0);
    }
}

#[test]
fn modp_work_refusals() {
    // sampled work limits below the measured total debit of a call (0, and
    // fractions of it up to one less) refuse it, leaving nothing reserved;
    // the measured total admits it; x^120 - 1 mod 65537 splits pieces of
    // several degrees, with retries (rejected and failed candidates)
    for (p, f) in [(65537u64, xn1(120)), (3, rand_powers(&mut Rng(9), &[(2, 1), (3, 2), (1, 4), (5, 3)], 3)), (2, xn1(63))] {
        let w = Budget::unlimited();
        let want = factor_mod_with(&w, &f, p).unwrap();
        let used = u64::MAX - w.work_left();
        for k in [0, used / 97, used / 7, used / 3, used / 2, used - used / 5, used - 1] {
            let b = Budget::new(Limits { work: k, ..Limits::UNLIMITED });
            let e = factor_mod_with(&b, &f, p).unwrap_err();
            assert!(e.kind == Kind::Resource && e.what == "work", "{e}");
            assert_eq!(b.live(), 0);
        }
        let b = Budget::new(Limits { work: used, ..Limits::UNLIMITED });
        assert_eq!(factor_mod_with(&b, &f, p).unwrap(), want);
    }
}

#[test]
fn modp_edf_is_bounded_by_its_work() {
    // the equal-degree splitting ends with probability 1, not in a bounded
    // number of candidates: its debits are what bound it.  x^1024 - 1 mod
    // 65537 is one piece of 1024 linear factors; a budget with room for the
    // tables and a hundredth of the splitting refuses as work, leaving
    // nothing reserved
    let (p, mut g) = (65537u64, vec![0u64; 1025]);
    g[0] = p - 1;
    g[1024] = 1;
    let w = Budget::unlimited();
    let fp = modp::Fp::new(&w, p, g.len()).unwrap();
    let tables = u64::MAX - w.work_left();
    let mut out = vec![];
    modp::edf(&w, &fp, &g, 1, &mut Rng(5), &mut out).unwrap();
    assert_eq!(out.len(), 1024);
    let split = u64::MAX - w.work_left() - tables;
    drop(fp);
    for k in [split / 100, split / 2, split - 1] {
        let b = Budget::new(Limits { work: tables + k, ..Limits::UNLIMITED });
        let fp = modp::Fp::new(&b, p, g.len()).unwrap();
        let e = modp::edf(&b, &fp, &g, 1, &mut Rng(5), &mut vec![]).unwrap_err();
        assert!(e.kind == Kind::Resource && e.what == "work", "{e}");
        drop(fp);
        assert_eq!(b.live(), 0);
    }
}

#[test]
fn modp_never_uses_the_shared_cache() {
    let before = sagebrush_arith::ntt::cache_stats().0;
    for (p, f) in [(65537u64, xn1(500)), (4294967291, xn1(256)), (2, rand_monic(&mut Rng(3), 1100, 2))] {
        factor_mod(&f, p);
    }
    assert_eq!(sagebrush_arith::ntt::cache_stats().0, before, "the shared transform cache was used");
}

/// The schoolbook modular phase that modp.rs replaced, kept as the oracle
/// its results must match bit for bit.
mod oracle {
    use super::*;
    use crate::{fderivative, fdivrem, fgcd, fmonic, fmul, frem, fsub, FPoly};
    use sagebrush_bigint::BigUint;

    pub fn fpowmod(b: &Budget, base: &[u64], e: &BigUint, m: &[u64], p: u64) -> FResult<FPoly> {
        let mut r: FPoly = vec![1];
        let mut x = frem(b, base, m, p)?;
        for i in 0..e.bits() {
            if e.bit(i) {
                r = frem(b, &fmul(b, &r, &x, p)?, m, p)?;
            }
            x = frem(b, &fmul(b, &x, &x, p)?, m, p)?;
        }
        Ok(r)
    }

    /// Distinct-degree factorization of a monic square-free f: (product of the
    /// irreducible factors of degree d, d).
    pub fn ddf(b: &Budget, f: &[u64], p: u64) -> FResult<Vec<(FPoly, usize)>> {
        let mut out = vec![];
        let mut f = f.to_vec();
        let x: FPoly = vec![0, 1];
        let mut h = x.clone();
        let pb = BigUint::from(p);
        let mut d = 1;
        while 2 * d <= f.len() - 1 {
            h = fpowmod(b, &h, &pb, &f, p)?;
            let g = fgcd(b, &f, &fsub(&h, &x, p), p)?;
            if g.len() > 1 {
                f = fdivrem(b, &f, &g, p)?.0;
                h = frem(b, &h, &f, p)?;
                out.push((g, d));
            }
            d += 1;
        }
        if f.len() > 1 {
            let n = f.len() - 1;
            out.push((f, n));
        }
        Ok(out)
    }

    /// Cantor-Zassenhaus: the irreducible factors (of degree d each) of g, with
    /// the trace map a + a^2 + ... + a^(2^(d-1)) in characteristic 2.  The
    /// pending pieces are kept on a stack: they partition g, so they hold at
    /// most deg(g) + (their number) words.
    pub fn edf(b: &Budget, g: &[u64], d: usize, p: u64, rng: &mut Rng, out: &mut Vec<FPoly>) -> FResult<()> {
        let mut stack: Vec<FPoly> = vec![g.to_vec()];
        while let Some(g) = stack.pop() {
            let n = g.len() - 1;
            if n == d {
                out.push(g);
                continue;
            }
            loop {
                let a: FPoly = ftrim((0..n).map(|_| rng.next() % p).collect());
                if a.len() < 2 {
                    b.debit(Some(n as u64))?;
                    continue;
                }
                let s = if p == 2 {
                    let mut t = a.clone();
                    let mut s = a.clone();
                    for _ in 1..d {
                        t = frem(b, &fmul(b, &t, &t, 2)?, &g, 2)?;
                        s = fsub(&s, &fsub(&[], &t, 2), 2); // s + t
                    }
                    s
                } else {
                    // (p^d - 1) / 2: d bitlen(p) bits, reserved with its transients
                    let _e = b.reserve(big_bytes((d as u64).saturating_mul(64 - p.leading_zeros() as u64)).and_then(|x| x.checked_mul(3)))?;
                    let e = (BigUint::from(p).pow(d as u32) - 1u32) / 2u32;
                    fsub(&fpowmod(b, &a, &e, &g, p)?, &[1], p)
                };
                let h = fgcd(b, &g, &s, p)?;
                if h.len() > 1 && h.len() < g.len() {
                    let q = fdivrem(b, &g, &h, p)?.0;
                    stack.push(fmonic(&q, p));
                    stack.push(h);
                    break;
                }
            }
        }
        Ok(())
    }

    /// Square-free decomposition of a monic f over F_p (Musser, with p-th
    /// roots in characteristic p): (g, e) with f = prod g^e, g square-free.
    pub fn sqf_mod(b: &Budget, f: &[u64], p: u64) -> FResult<Vec<(FPoly, u32)>> {
        let mut out = vec![];
        let c = fgcd(b, f, &fderivative(f, p), p)?;
        let mut w = fdivrem(b, f, &c, p)?.0;
        let mut c = c;
        let mut i = 1;
        while w.len() > 1 {
            let y = fgcd(b, &w, &c, p)?;
            let z = fdivrem(b, &w, &y, p)?.0;
            if z.len() > 1 {
                out.push((fmonic(&z, p), i));
            }
            i += 1;
            w = y;
            c = fdivrem(b, &c, &w, p)?.0;
        }
        if c.len() > 1 {
            // c is a p-th power: c(x) = r(x^p)
            let r: FPoly = c.iter().step_by(p as usize).copied().collect();
            for (g, e) in sqf_mod(b, &fmonic(&r, p), p)? {
                out.push((g, e * p as u32));
            }
        }
        Ok(out)
    }

    /// factor_mod_with on the oracle's phase, and the generator's state
    /// after it (the draws made).
    pub fn factor_mod(f: &[BigInt], p: u64) -> (Vec<(Vec<u64>, u32)>, u64) {
        let b = Budget::unlimited();
        let fp = fmonic(&reduce_p(f, p), p);
        let mut rng = Rng(0x2545_F491_4F6C_DD1D ^ p);
        let mut out = vec![];
        for (g, e) in sqf_mod(&b, &fp, p).unwrap() {
            for (h, d) in ddf(&b, &g, p).unwrap() {
                let mut fs = vec![];
                edf(&b, &h, d, p, &mut rng, &mut fs).unwrap();
                out.extend(fs.into_iter().map(|q| (fmonic(&q, p), e)));
            }
        }
        out.sort_by(|x, y| x.0.len().cmp(&y.0.len()).then(x.0.cmp(&y.0)));
        (out, rng.0)
    }
}
