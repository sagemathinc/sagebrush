//! Work and allocation limits are checked before the work they bound
//! (@sagebrush-daybreak's review of 3ae9456): each reproducer of the
//! report, which must now be answered or refused at once.

use sagebrush_hmf::defnew::Newspaces;
use sagebrush_hmf::definite::{divisors, new_charpoly, DefiniteSpace};
use sagebrush_hmf::field::{factor_u64, factor_u64_steps};
use sagebrush_hmf::quatalg::{MaximalOrder, QuatAlg};
use sagebrush_hmf::rqf::{QElt, QuadField};
use std::time::Instant;

fn order(d: i64) -> (QuadField, MaximalOrder) {
    let f = QuadField::new(d).unwrap();
    (f, MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap())
}

/// HARD-3AE-1: the range of d is checked before its squarefree test, which
/// uses the bounded factorization (no overflow near i64::MAX).
#[test]
fn field_range_before_factoring() {
    let t = Instant::now();
    for d in [i64::MAX, i64::MAX - 1, (1 << 40) + 1] {
        assert_eq!(QuadField::new(d).unwrap_err(), "d must be below 2^40");
    }
    // a prime below 2^40 and a product of two primes near 2^20
    assert!(QuadField::new(1099511627689).is_ok());
    assert!(QuadField::new(1048573 * 1048571).is_ok());
    assert!(QuadField::new(1048573 * 1048573).is_err());
    assert!(t.elapsed().as_secs_f64() < 2.0, "{:?}", t.elapsed());
}

/// HARD-3AE-2: factorization of norms below 2^64 by Pollard-Brent within a
/// step limit (an Err when it runs out), with interrupt checks.
#[test]
fn factorization_is_fast_and_bounded() {
    let t = Instant::now();
    // the report's norm: 1073741789^2, the norm of the inert prime (1073741789) of Q(sqrt 5)
    assert_eq!(factor_u64(1152921429444920521).unwrap(), vec![(1073741789, 2)]);
    // a product of two primes near 2^31, and a prime near 2^64
    assert_eq!(factor_u64(2147483647 * 2147483629).unwrap(), vec![(2147483629, 1), (2147483647, 1)]);
    assert_eq!(factor_u64(18446744073709551557).unwrap(), vec![(18446744073709551557, 1)]);
    assert_eq!(factor_u64(1 << 63).unwrap(), vec![(2, 63)]);
    assert_eq!(factor_u64(2 * 3 * 3 * 1021 * 1031 * 1031).unwrap(), vec![(2, 1), (3, 2), (1021, 1), (1031, 2)]);
    assert!(factor_u64(0).is_err());
    // the limit: too few steps for the semiprime is an error, not a loop
    assert!(factor_u64_steps(2147483647 * 2147483629, 10).unwrap_err().contains("work limit"));
    // and the ideal of the report (1073741789 splits in Q(sqrt 5))
    let f = QuadField::new(5).unwrap();
    let i = f.principal(&QElt::int(1073741789)).unwrap();
    assert_eq!(f.factor(&i).unwrap().iter().map(|(p, e)| (p.norm(), *e)).collect::<Vec<_>>(), vec![(1073741789, 1), (1073741789, 1)]);
    assert!(t.elapsed().as_secs_f64() < 2.0, "{:?}", t.elapsed());
}

/// HARD-3AE-3: #P^1(O_F/N) is computed from the factorization and checked
/// before any point is built: level (2)^14 over Q(sqrt 5) (2 inert, 2^28 +
/// 2^26 points).
#[test]
fn p1_size_before_allocation() {
    let (f, o) = order(5);
    let t = Instant::now();
    let n = f.principal(&QElt::int(16384)).unwrap();
    assert_eq!(DefiniteSpace::new(&o, &n).err().unwrap(), "P^1(O_F/N) is too large (unsupported)");
    assert!(t.elapsed().as_secs_f64() < 2.0, "{:?}", t.elapsed());
}

/// HARD-3AE-4: the divisors of a level are counted, and the points of all
/// their spaces summed, before the class set: the report's level of
/// Q(sqrt 5) with 384 divisors.
#[test]
fn divisor_spaces_are_bounded_first() {
    let (f, o) = order(5);
    let n = f.ideal(&[QElt::new(363660, 0), QElt::new(230736, 2508)]).unwrap();
    assert_eq!(n.norm(), 912059280);
    let t = Instant::now();
    assert!(divisors(&f, &n).unwrap_err().contains("more than 256 divisors"));
    // (the points of all the divisor spaces exceed the limit first here)
    assert!(Newspaces::new(&o, &n).err().unwrap().contains("(unsupported)"));
    let p = f.primes_above(7).unwrap()[0];
    assert!(new_charpoly(&o, &n, &p).unwrap_err().contains("(unsupported)"));
    // few divisors but too many points in all: (2)^7 (3)^3 (7)^3, 128
    // divisors
    let m = f.principal(&QElt::int(128 * 27 * 343)).unwrap();
    assert!(Newspaces::new(&o, &m).err().unwrap().contains("too large"));
    assert!(t.elapsed().as_secs_f64() < 2.0, "{:?}", t.elapsed());
}

/// HARD-3AE-4: a Hecke operator on all the divisor spaces is refused before
/// its neighbour search when its terms exceed the limit, and the neighbour
/// elements are found once and shared (the new characteristic polynomial
/// is unchanged).
#[test]
fn hecke_terms_are_bounded_and_shared() {
    // S_2((210)) over Q(sqrt 5): 16 divisor spaces
    let (f, o) = order(5);
    let n = f.principal(&QElt::int(210)).unwrap();
    let ns = Newspaces::new(&o, &n).unwrap();
    let total: i128 = divisors(&f, &n).unwrap().iter().map(|m| ns.space(m).unwrap().dimension() as i128).sum();
    // a prime whose T_P on the top space alone is within the limit, but not
    // on all the divisor spaces together
    let top = ns.top().dimension() as i128;
    let p = f.primes_of_bounded_norm(100_000).unwrap().into_iter().find(|p| p.norm() + 1 > (1 << 21) / total && (p.norm() + 1) * top <= 1 << 21).unwrap();
    let t = Instant::now();
    let e = ns.hecke(&ns.level, &p).err().unwrap();
    assert!(e.contains("too large a computation"), "{}", e);
    assert!(t.elapsed().as_secs_f64() < 2.0, "{:?}", t.elapsed());
    // and the characteristic polynomials of the divisor spaces modulo the
    // primes the recovery needs (degree 368, about 50 primes, each needing
    // a 1252-dimensional characteristic polynomial) are refused before any
    let p11 = f.primes_above(11).unwrap()[0];
    let t = Instant::now();
    let e = ns.new_charpoly(&vec![(p11, 1)]).unwrap_err();
    assert!(e.contains("operations, above the limit"), "{}", e);
    assert!(t.elapsed().as_secs_f64() < 2.0, "{:?}", t.elapsed());
    // the neighbour elements are shared: CORR-6F0-1's Q(sqrt 10) newspace,
    // (x^2 + 1)^2 for U_P at P = (5, sqrt 10), is unchanged
    let (f, o) = order(10);
    let n = f.ideal(&[QElt::new(5, 0), QElt::new(0, 1)]).unwrap();
    let ns = Newspaces::new(&o, &n).unwrap();
    let p3 = f.primes_above(3).unwrap()[0];
    assert_eq!(ns.new_charpoly(&vec![(p3, 1)]).unwrap().len(), ns.new_dimension().unwrap() + 1);
}
