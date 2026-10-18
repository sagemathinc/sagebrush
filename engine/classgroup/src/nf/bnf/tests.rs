use super::*;

#[test]
fn explicit_configuration_keeps_result_and_marks_uncertified_search() {
    let polynomial: Vec<BigInt> = [-11, 0, 0, 1].into_iter().map(BigInt::from).collect();
    let (ordinary, _) = bnfinit(&polynomial).unwrap();
    let config = BnfConfig {
        minimum_factor_base_bound: 100.0,
        uniform_factor_base: true,
        analytic_certificate: false,
        log_weight_spread: Some(2.0),
        ..BnfConfig::default()
    };
    let (configured, _, relations) = bnfinit_configured(&polynomial, &[199], &config).unwrap();
    assert!(ordinary.certified);
    assert!(!configured.certified);
    assert_eq!(ordinary.group.h, configured.group.h);
    assert_eq!(ordinary.group.cyc, configured.group.cyc);
    assert!((ordinary.regulator - configured.regulator).abs() < 1e-12);
    assert!(relations.bound >= 100);
    assert!(relations.fb.iter().any(|prime| prime.p == 199));
}

#[test]
fn unit_lattice_recovers_covolume() {
    let prec = 200u32;
    let fx = |x: f64| BigInt::from((x * 2f64.powi(50)) as i64) << (prec as usize - 50);
    // a skewed rank-2 lattice
    let b1 = [fx(1013.25), fx(-7.5)];
    let b2 = [fx(3.125), fx(911.0625)];
    let mut rng = 12345u64;
    let mut vs = vec![];
    for _ in 0..40 {
        rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
        let a = (rng % 2001) as i64 - 1000;
        let b = ((rng >> 20) % 2001) as i64 - 1000;
        vs.push(vec![&b1[0] * a + &b2[0] * b, &b1[1] * a + &b2[1] * b]);
    }
    let (_, cov) = unit_lattice(&vs, 2, &BigInt::from(1u64 << 20), prec).unwrap();
    let want = 1013.25 * 911.0625 + 7.5 * 3.125;
    let got = to_f64(&(cov >> prec as usize), prec);
    assert!((got - want).abs() < 1e-6 * want, "{} vs {}", got, want);
}

#[test]
fn square_core_uses_its_determinant() {
    // x^3 - 688422267 x - 6952331593386 (from the elliptic curve 1990d2),
    // with the primes above 199 in the factor base: (199) = P Q^2, and
    // the core after elimination was Q alone with the row [2].  Taking
    // det 1 there (no extra rows) gave h* = 1 from an index-2 lattice;
    // now the relations found must include Q to an odd power.
    let f: Vec<BigInt> = ["-6952331593386", "-688422267", "0", "1"].iter().map(|c| c.parse().unwrap()).collect();
    let (b, _, r) = bnfinit_with(&f, &[2, 3, 5, 199]).unwrap();
    assert_eq!(b.group.h, BigInt::one());
    let q = r.fb.iter().position(|q| q.p == 199 && q.e == 2).unwrap();
    assert!(r.rels.iter().any(|rel| rel.iter().any(|&(i, e)| i == q && e % 2 != 0)));
}

#[test]
fn large_roots() {
    // a root near -87473: its fixed-point start used to overflow
    let f: Vec<BigInt> = [-95282, 82258, 87473, 1].iter().map(|&c| BigInt::from(c)).collect();
    let (order, _) = maximal_order(&f).unwrap();
    let e = Embeddings::new(&order).unwrap();
    let prec = 200;
    let hp = e.roots_hp(&order.f, prec).unwrap();
    for (z, _) in &hp {
        // f(z) ~ 0 relative to the size of the terms
        let fz: BigInt = f.iter().rev().fold(BigInt::zero(), |acc, c| ((acc * z) >> prec as usize) + (c << prec as usize));
        let size = to_f64(z, prec).abs().max(1.0).powi(3);
        assert!(to_f64(&fz, prec).abs() < 1e-30 * size, "f(z) = {}", to_f64(&fz, prec));
    }
}

#[test]
fn against_pari() {
    // bnfinit(f): disc, cyc, reg, number of roots of unity (PARI 2.17.4,
    // used as an oracle only)
    let cases: &[(&[i64], i64, &[u64], f64, u32)] = &[
        (&[23, 0, 1], -23, &[3], 1.0, 2),
        (&[-10, 0, 1], 40, &[2], 1.8184464592320668, 2),
        (&[-2, 0, 0, 1], -108, &[], 1.3473773483293841, 2),
        (&[-11, 0, 0, 1], -3267, &[2], 5.5872066260609078, 2),
        (&[1, 0, 0, 0, 1], 256, &[], 1.7627471740390861, 8),
        (&[-1, -1, 0, 1], -23, &[], 0.28119957432296185, 2),
        (&[1, 0, -10, 0, 1], 2304, &[], 2.6608985801903705, 2),
    ];
    for &(f, d, cyc, reg, w) in cases {
        let f: Vec<BigInt> = f.iter().map(|&c| BigInt::from(c)).collect();
        let (b, _) = bnfinit(&f).unwrap();
        assert_eq!(b.disc, BigInt::from(d));
        assert_eq!(b.group.cyc, cyc.iter().map(|&c| BigInt::from(c)).collect::<Vec<_>>(), "{:?}", f);
        assert!((b.regulator - reg).abs() < 1e-9 * reg, "{:?}: {} vs {}", f, b.regulator, reg);
        assert_eq!(b.w, w);
        assert!(b.certified, "{:?} not certified", f);
    }
}

/// The certificate's pieces against PARI's h R (oracle only): the
/// Belabas-Friedman lower bound is below log h R and within about
/// E(X); a sublattice of index 2 (R* = 2R) or h* = 2h fails the test.
#[test]
fn certificate_bounds() {
    // (f, h, R)
    let cases: &[(&[i64], u64, f64)] = &[
        (&[-11, 0, 0, 1], 2, 5.5872066260609078),
        (&[-10, 0, 1], 2, 1.8184464592320668),
        (&[23, 0, 1], 3, 1.0),
        (&[1, 0, -10, 0, 1], 1, 2.6608985801903705),
    ];
    for &(f, h, reg) in cases {
        let f: Vec<BigInt> = f.iter().map(|&c| BigInt::from(c)).collect();
        let (order, _) = maximal_order(&f).unwrap();
        let discriminant = order.disc();
        let index = num_integer::Roots::sqrt(&(Order::equation_order(&f).disc() / &discriminant).abs());
        let embeddings = Embeddings::new(&order).unwrap();
        let (w, _) = crate::api::roots_of_unity(&order, &embeddings);
        let log_discriminant = discriminant.to_f64().unwrap().abs().ln();
        let x = super::super::certify::choose_x(order.n, log_discriminant).unwrap();
        let split = splitting(&order, &discriminant, &index, x);
        let lo = super::super::certify::log_hr_lower_ball(&split, x, order.n, embeddings.r1, embeddings.r2, w, &discriminant, CERTIFICATE_BITS).unwrap();
        let lof = lower_f64(&lo);
        let truth = (h as f64 * reg).ln();
        assert!(lof < truth && truth - lof < 0.25, "{:?}: {} vs {}", f, lof, truth);
        let rb = |x: f64| sagebrush_ball::Ball::from_f64_exact(x).unwrap();
        let bh = |k: u64| BigInt::from(k);
        assert!(super::super::certify::below_twice_ball(&bh(h), &rb(reg * (1.0 + 1e-12)), &lo, 96));
        assert!(!super::super::certify::below_twice_ball(&bh(2 * h), &rb(reg), &lo, 96));
        assert!(!super::super::certify::below_twice_ball(&bh(h), &rb(2.0 * reg), &lo, 96));
    }
}

/// log_embedding_err's bounds hold: at 80 bits against 400 bits, and at
/// 1100 bits (beyond a double's 2^1024: to_f64 made every value below
/// 2^1000 zero there) against 2000,
/// with a root near 10^-40.
#[test]
fn log_embedding_error_bounds_hold() {
    // (x^2 + 10^40 x - 1 has a root near 10^-40, below 2^-100)
    for (f, lo_p, hi_p) in [(vec!["-95282", "82258", "87473", "1"], 80u32, 400u32), (vec!["-1", "10000000000000000000000000000000000000000", "1"], 1100, 2000)] {
        check_log_embedding_bounds(&f, lo_p, hi_p);
    }
}

/// Root isolation verified with integer
/// brackets): f = x^3 + (2^25 + 1) x - 1, x = 1 + a^2 t^2; at 1024 bits
/// the bound was 308 units against an actual error of 2 10^7.
#[test]
fn log_embedding_bound_beyond_1024_bits() {
    let a = (BigInt::one() << 25usize) + 1u32;
    let f = vec![BigInt::from(-1), a.clone(), BigInt::zero(), BigInt::one()];
    let order = Order::equation_order(&f);
    let e = Embeddings::new(&order).unwrap();
    let x = vec![BigInt::one(), BigInt::zero(), &a * &a];
    for p in [1023u32, 1024, 1025, 1100] {
        let (roots, rho) = e.roots_hp_rad(&f, p).unwrap();
        let (v, err) = e.log_embedding_err(&order, &x, &roots, &rho, p).unwrap();
        let hi = e.log_embedding(&order, &x, &e.roots_hp(&f, p + 800).unwrap(), p + 800);
        for (a, b) in v.iter().zip(&hi) {
            // the actual error (rounded up) against the bound
            let d = sagebrush_ball::Mag::from_bigint_up(&((a << 800usize) - b), -800);
            assert!(d <= err, "at {} bits: error {:?} units, bound {:?}", p, d, err);
        }
    }
}

fn check_log_embedding_bounds(f: &[&str], lo_p: u32, hi_p: u32) {
    let f: Vec<BigInt> = f.iter().map(|c| c.parse().unwrap()).collect();
    let (order, _) = maximal_order(&f).unwrap();
    let e = Embeddings::new(&order).unwrap();
    let (lo_roots, rho) = e.roots_hp_rad(&order.f, lo_p).unwrap();
    let hi_roots = e.roots_hp(&order.f, hi_p).unwrap();
    let mut rng = 7u64;
    for _ in 0..50 {
        let x: Vec<BigInt> = (0..order.n).map(|_| {
            rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
            BigInt::from((rng % 2001) as i64 - 1000)
        }).collect();
        if x.iter().all(|c| c.is_zero()) {
            continue;
        }
        let (l, err) = e.log_embedding_err(&order, &x, &lo_roots, &rho, lo_p).unwrap();
        let h = e.log_embedding(&order, &x, &hi_roots, hi_p);
        for (a, b) in l.iter().zip(&h) {
            // the difference in units of 2^-lo_p (rounded up)
            let d = sagebrush_ball::Mag::from_bigint_up(&((a << (hi_p - lo_p) as usize) - b), -((hi_p - lo_p) as i64));
            assert!(d <= err, "error {:?} units, bound {:?}", d, err);
        }
    }
}

/// regulator_bounds on a lattice of known covolume, and on the units of
/// an index-2 sublattice (its covolume doubles: the certificate fails).
#[test]
fn regulator_bounds_from_integer_combinations() {
    let prec = 200u32;
    let fx = |x: f64| BigInt::from((x * 2f64.powi(50)) as i64) << (prec as usize - 50);
    let b1 = vec![fx(1013.25), fx(-7.5)];
    let b2 = vec![fx(3.125), fx(911.0625)];
    let want = 1013.25 * 911.0625 + 7.5 * 3.125;
    let comb = |a: i64, b: i64| vec![&b1[0] * a + &b2[0] * b, &b1[1] * a + &b2[1] * b];
    let lams = vec![comb(3, 1), comb(2, 1), comb(5, -7)];
    let errs = vec![sagebrush_ball::Mag::from_u64(16); 3];
    let basis = vec![b1.clone(), b2.clone()];
    let (lo, hi, _, _) = super::super::certify::regulator_bounds(&lams, &errs, &basis, prec).unwrap();
    let w = sagebrush_ball::Ball::from_f64_exact(want).unwrap();
    assert!(lo.cmp(&w) == Some(std::cmp::Ordering::Less) && hi.cmp(&w) == Some(std::cmp::Ordering::Greater), "{} {} {}", lo, hi, want);
    assert!(hi.to_f64_approx() - lo.to_f64_approx() < 1e-12 * want);
    // only even first coordinates: index 2, whatever basis is claimed
    let lams2 = vec![comb(2, 1), comb(4, 3), comb(2, -1)];
    let (lo2, _, _, _) = super::super::certify::regulator_bounds(&lams2, &errs, &basis, prec).unwrap();
    assert!(lo2.to_f64_approx() > 1.99 * want, "{}", lo2);
}

/// Grenie and Molteni's example (arXiv:1507.00602, Section 4): T(K) =
/// 19162 by Belabas, Diaz y Diaz and Friedman's one step, T_1(K) = 11071.
#[test]
fn generator_bound_paper_example() {
    let f: Vec<BigInt> = [55137512477462689i64, 559752270111028720, 0, 1].iter().map(|&c| BigInt::from(c)).collect();
    let one = one_step_generator_bound(&f).unwrap();
    let (t, unif) = class_group_generator_bound(&f).unwrap();
    eprintln!("one step {} steps {} uniform {}", one, t, unif);
    assert!((19000.0..19400.0).contains(&one), "{}", one);
    assert!((11000.0..11100.0).contains(&t), "{}", t);
}
