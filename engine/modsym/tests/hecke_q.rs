//! cusp_hecke_matrix against Sage's CuspForms(N, k).hecke_polynomial(p)
//! (tests/fixtures/make_sage_cusp_charpolys.sage, run as an oracle): the
//! charpoly of T_p's matrix, compared mod a prime, at levels with square
//! factors (whose Eisenstein series take roots of unity of order above 1)
//! and at 389 (weights 2 and 4); its units pinned on fixed inputs; its
//! admission's bounds at extreme inputs.

use sagebrush_bigint::BigInt;
use sagebrush_modsym::hecke_q::{cusp_hecke_matrix, sturm_bound, Admit};
use sagebrush_modsym::linalg::charpoly;

const FIXTURE: &str = include_str!("fixtures/sage_cusp_charpolys.txt");
const ELL: u64 = 1_000_000_007;

struct Free;
impl Admit for Free {
    fn admit(&mut self, _work: u64, _bytes: u64) -> Result<(), String> {
        Ok(())
    }
}

fn red(x: &BigInt) -> u64 {
    let r = x % BigInt::from(ELL);
    let r = if r < BigInt::from(0) { r + BigInt::from(ELL) } else { r };
    r.try_into().unwrap()
}

fn powmod(mut b: u64, mut e: u64) -> u64 {
    let mut r = 1u64;
    while e > 0 {
        if e & 1 == 1 {
            r = (r as u128 * b as u128 % ELL as u128) as u64;
        }
        b = (b as u128 * b as u128 % ELL as u128) as u64;
        e >>= 1;
    }
    r
}

#[test]
fn charpolys_match_sage() {
    let factor = |f: &[BigInt]| sagebrush_poly::factor(f).1;
    for line in FIXTURE.lines() {
        let v: Vec<&str> = line.split_whitespace().collect();
        let (n, k, p): (u64, usize, u64) = (v[0].parse().unwrap(), v[1].parse().unwrap(), v[2].parse().unwrap());
        let want: Vec<BigInt> = v[3..].iter().map(|c| c.parse().unwrap()).collect();
        let prec = sturm_bound(n, k).unwrap() as usize + 2;
        let h = cusp_hecke_matrix(n, k, p, prec, false, &factor, &mut Free).unwrap();
        assert_eq!(h.dim + 1, want.len(), "N={} k={}: dimension", n, k);
        assert_eq!(h.stats.rejected_total(), 0, "N={} k={}: primes set aside", n, k);
        // charpoly of matrix / den: scale back, den^-d charpoly(matrix)(den x)
        let m: Vec<Vec<u64>> = h.matrix.iter().map(|r| r.iter().map(red).collect()).collect();
        let f = charpoly(m, ELL);
        let dinv = powmod(red(&h.den), ELL - 2);
        let got: Vec<u64> = f.iter().enumerate().map(|(i, &c)| (c as u128 * powmod(dinv, (h.dim - i) as u64) as u128 % ELL as u128) as u64).collect();
        let want: Vec<u64> = want.iter().map(red).collect();
        assert_eq!(got, want, "N={} k={} p={}", n, k, p);
    }
}

/// The largest e the goldens reach: N = 361 = 19^2, e = lambda(19) = 18
/// (charpoly checked above), and the supply figures traces.rs's doc
/// comment on HECKE_PRIMES_BELOW states, where a count is cheap.
#[test]
fn largest_e_and_the_supply() {
    use sagebrush_modsym::newspace::eisenstein_exponent;
    use sagebrush_modsym::traces::{hecke_primes, HECKE_PRIMES_BELOW, HECKE_PRIMES_FROM};
    assert_eq!(eisenstein_exponent(361), 18);
    assert_eq!(eisenstein_exponent(289), 16);
    assert_eq!(eisenstein_exponent(2 * 3 * 5 * 7 * 11), 1);
    let factor = |f: &[BigInt]| sagebrush_poly::factor(f).1;
    let h = cusp_hecke_matrix(361, 2, 3, sturm_bound(361, 2).unwrap() as usize + 2, false, &factor, &mut Free).unwrap();
    assert_eq!(h.stats.e, 18);
    assert_eq!(h.stats.rejected_total(), 0);
    assert!(h.stats.primes >= 1);
    let first: Vec<u64> = hecke_primes(18).take(3).collect();
    assert!(first.iter().all(|&l| l % 18 == 1 && (HECKE_PRIMES_FROM..HECKE_PRIMES_BELOW).contains(&l)));
    assert!(first.windows(2).all(|w| w[0] < w[1]), "ascending");
    // the doc comment's S(65536)
    assert_eq!(hecke_primes(65536).count(), 4550);
}

fn units_of<T>(f: impl FnOnce() -> T) -> [u64; sagebrush_arith::cost::FAMILIES] {
    use sagebrush_arith::cost::tallied;
    let before = tallied();
    let _ = f();
    let after = tallied();
    let mut d = [0; sagebrush_arith::cost::FAMILIES];
    for (i, x) in d.iter_mut().enumerate() {
        *x = after.0[i].wrapping_sub(before.0[i]);
    }
    d
}

/// The op's units per family on fixed inputs (the whole op: the newspaces'
/// metered parts, the twisted traces' kernels, the CRT, W's assembly and
/// zmat's rref and solve), pinned: a site that changes what it counts, or
/// counts a callee's work again, fails here.  60.4 at p = 5 takes U_5's
/// fourth rule (AddSub).  The units don't depend on the threads
/// (traces::tests).
#[test]
fn the_units_are_pinned() {
    use sagebrush_arith::cost::Family::*;
    let factor = |f: &[BigInt]| sagebrush_poly::factor(f).1;
    let fam = [MulSchool, MulNtt, Div, DivNewton, Gcd, Move, ModArith, AddSub, Walk, Other];
    assert!(fam.iter().enumerate().all(|(i, &f)| f as usize == i));
    for (n, k, p, want) in [
        (11u64, 2usize, 2u64, [96u64, 0, 47, 0, 12, 146, 1194, 0, 0, 0]),
        (37, 2, 3, [598, 0, 82, 0, 114, 761, 3922, 0, 0, 0]),
        (60, 4, 5, [934952, 0, 11825, 0, 17745, 104380, 438616, 294, 0, 0]),
    ] {
        let prec = sturm_bound(n, k).unwrap() as usize + 2;
        let got = units_of(|| cusp_hecke_matrix(n, k, p, prec, false, &factor, &mut Free).unwrap());
        assert_eq!(got, want, "{}.{} p={}", n, k, p);
    }
}

/// The admission's bounds at extreme inputs: computed without overflow
/// (saturating), and a refusal comes before any work.
#[test]
fn the_bounds_at_extreme_inputs() {
    use sagebrush_modsym::hecke_q::{cusp_hecke_cost, cusp_hecke_lower};
    let big_k = (1usize << 31) - 2;
    // (2^40 where usize holds it, else the widest a 32-bit usize has)
    let wide = usize::try_from(1u64 << 40).unwrap_or(usize::MAX);
    for (n, k, prec, new_only) in [(1u64 << 31, big_k, usize::MAX, false), (2147483647, big_k, usize::MAX, true), (1, 2, 0, false), (1u64 << 31, 2, wide, true)] {
        let (work, bytes) = cusp_hecke_lower(n, k, prec, new_only);
        assert!(bytes >= work.min(u64::MAX / 16), "{} {}", n, k);
        let c = cusp_hecke_cost(n, k, prec, new_only);
        assert_eq!((c.work_lower, c.mem_lower, c.work_estimate, c.work_upper), (work, bytes, None, None));
    }
    assert_eq!(cusp_hecke_lower(1u64 << 31, big_k, usize::MAX, false).1, u64::MAX, "saturated");
    // a refusal: the admission's error, before the newspaces
    struct Refuse(u64);
    impl Admit for Refuse {
        fn admit(&mut self, _work: u64, bytes: u64) -> Result<(), String> {
            self.0 = bytes;
            Err("refused".into())
        }
    }
    let factor = |f: &[BigInt]| sagebrush_poly::factor(f).1;
    let (n, k) = (1_000_003u64, 2usize);
    let prec = sturm_bound(n, k).unwrap() as usize + 2;
    let mut r = Refuse(0);
    #[cfg(not(target_family = "wasm"))]
    let t = std::time::Instant::now();
    assert_eq!(cusp_hecke_matrix(n, k, 2, prec, false, &factor, &mut r).err().unwrap(), "refused");
    // (the timing natively only: wasm32-wasip1's clock is the host's)
    #[cfg(not(target_family = "wasm"))]
    assert!(t.elapsed().as_secs_f64() < 1.0);
    assert_eq!(r.0, cusp_hecke_lower(n, k, prec, false).1);
}

/// The admission's closed-form dimension against the Cohen-Oesterle one
/// (dims::dim_cusp_forms, which walks the residues mod n).
#[test]
fn the_closed_form_dimension_agrees() {
    use sagebrush_modsym::dims::dim_cusp_forms;
    use sagebrush_modsym::general::Character;
    use sagebrush_modsym::hecke_q::gamma0_cusp_dim;
    for n in 1..=400u64 {
        let eps = Character::trivial(n);
        for k in 2..=14usize {
            assert_eq!(gamma0_cusp_dim(n, k), Some(dim_cusp_forms(&eps, k)), "N={} k={}", n, k);
        }
    }
    assert_eq!(gamma0_cusp_dim(389, 2), Some(32));
    assert!(gamma0_cusp_dim(1 << 31, (1 << 31) - 2).is_some(), "no table of size n, no overflow");
}

/// The units do not depend on the threads: the parallel jobs' units are
/// added at their joins, on the caller's thread.  (Native only: wasm32 has
/// no thread pools; the WebAssembly test pins the same units.)
#[cfg(not(target_family = "wasm"))]
#[test]
fn the_units_are_the_same_on_one_thread_and_many() {
    use sagebrush_modsym::general::Character;
    use sagebrush_modsym::newspace::newspace_orbits;
    use sagebrush_modsym::traces::orbit_hecke_traces;
    let factor = |f: &[BigInt]| sagebrush_poly::factor(f).1;
    let (n, k) = (43u64, 2usize);
    let res = newspace_orbits(n, k, &Character::trivial(n), &factor).unwrap();
    let len = sturm_bound(n, k).unwrap() as usize + 1;
    let eps = Character::trivial(n);
    let measure = |threads: usize| {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
        pool.install(|| {
            let mut stats = None;
            let u = units_of(|| stats = Some(orbit_hecke_traces(n, k, &eps, &res, len, 2).unwrap().1));
            (u, stats.unwrap())
        })
    };
    let (one, s1) = measure(1);
    let (four, s4) = measure(4);
    assert_eq!(one, four);
    assert_eq!(s1, s4);
    assert!(one.iter().sum::<u64>() > 0);
}

/// The new subspace's dimension (the admission's closed form, through the
/// old forms' multiplicities beta) against the newspace computation's.
#[test]
fn the_new_dimension_agrees_with_the_newspace() {
    use sagebrush_modsym::general::Character;
    use sagebrush_modsym::hecke_q::cusp_dim;
    use sagebrush_modsym::newspace::newspace_orbits;
    let factor = |f: &[BigInt]| sagebrush_poly::factor(f).1;
    for n in 1..=72u64 {
        for k in [2usize, 4, 6] {
            let res = newspace_orbits(n, k, &Character::trivial(n), &factor).unwrap();
            assert_eq!(cusp_dim(n, k, true), res.dim as u64, "N={} k={}", n, k);
        }
    }
}

/// L from its definition at known dimensions: work d^2, bytes 16 d^2 (C's
/// rationals, two integers of 8 bytes) + 8 d prec (W).
#[test]
fn the_lower_bound_is_its_definition() {
    use sagebrush_modsym::hecke_q::cusp_hecke_lower;
    // 389.2: d = 32, the Sturm bound 65, prec 67; S_2(389) is all new
    assert_eq!(cusp_hecke_lower(389, 2, 67, false), (32 * 32, 16 * 32 * 32 + 8 * 32 * 67));
    assert_eq!(cusp_hecke_lower(389, 2, 67, true), (32 * 32, 16 * 32 * 32 + 8 * 32 * 67));
    // 60.4: d = 30, of which 2 new
    assert_eq!(cusp_hecke_lower(60, 4, 50, false), (30 * 30, 16 * 30 * 30 + 8 * 30 * 50));
    assert_eq!(cusp_hecke_lower(60, 4, 50, true), (2 * 2, 16 * 2 * 2 + 8 * 2 * 50));
    // 11.2: d = 1
    assert_eq!(cusp_hecke_lower(11, 2, 4, false), (1, 16 + 8 * 4));
}
