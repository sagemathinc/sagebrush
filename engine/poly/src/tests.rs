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
fn swinnerton_dyer(k: usize) -> ZPoly {
    let primes = [2i64, 3, 5, 7, 11, 13];
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
            a = zsub(&b, &na, &z(&[-coef.to_i64().unwrap()])).unwrap().into_vec();
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
                let dd = ddf(&b, g, p).unwrap();
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
fn allocated_by<T>(f: impl FnOnce() -> T) -> (T, u64) {
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
    ];
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
