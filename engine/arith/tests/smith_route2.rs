//! Route 2's small Smith form on the inputs where the classical
//! elimination it replaced grew its transforms: 32 x 32 and 48 x 48
//! matrices of 64-bit entries with k = 2 or 3 small nontrivial invariant
//! factors.  There the classical small Smith form gave transforms of 172 to
//! 332 times bits(delta) and 0.94e9 to 5.4e9 units, the route alone 0.7 s
//! to 3.9 s.  Pinned here: the route, U a V = D, the transforms' size
//! relative to delta (a regression bound the old elimination fails by a
//! factor of 20 or more), a units bound in place of a wall-clock guard, and
//! the units by family.  (A file of its own: the tally is per thread, and
//! these are the slowest Smith inputs of the suite.)

use num_traits::{One, Signed};
use sagebrush_arith::cost::{tallied, FAMILIES};
use sagebrush_arith::smith::{self, Route};
use sagebrush_arith::snf;
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_bigint::BigInt;

/// n x n entries of `bits` bits and random signs from a xorshift seeded by
/// `seed`, the first `kk` rows scaled by 6, 10, 15 (k = kk small invariant
/// factors, usually).
fn structured(seed: u64, n: usize, bits: u32, kk: usize) -> ZMat {
    let mut s = seed.wrapping_mul(0x9e3779b97f4a7c15) | 1;
    let mut next = move || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    let mut rows: Vec<Vec<BigInt>> = (0..n)
        .map(|_| {
            (0..n)
                .map(|_| {
                    let mut x = BigInt::from(0);
                    let mut left = bits;
                    while left > 0 {
                        let t = left.min(60);
                        x = (x << t as usize) + BigInt::from(next() >> (64 - t));
                        left -= t;
                    }
                    if next() & 1 == 1 {
                        -x
                    } else {
                        x
                    }
                })
                .collect()
        })
        .collect();
    for (i, f) in [6i64, 10, 15].iter().enumerate().take(kk) {
        for v in rows[i].iter_mut() {
            *v = &*v * BigInt::from(*f);
        }
    }
    ZMat::from_rows(rows)
}

#[test]
fn route_two_transforms_and_units_are_bounded() {
    let print = std::env::var("PRINT_PINS").is_ok();
    // (seed, n, bits, kk): the old elimination's ratio and units at each
    // were 238.8 and 0.94e9, 245.8 and 1.22e9, 331.6 and 5.35e9
    let cases: [(u64, usize, u32, usize); 3] = [(10, 32, 64, 2), (20, 32, 64, 3), (12, 48, 64, 3)];
    let pins: [([u64; FAMILIES], u64); 3] = [
        ([4613972, 0, 3665159, 0, 30564, 1058, 0, 565, 0, 0], 1),
        ([2840960, 0, 2607677, 0, 8056, 1165, 0, 475, 0, 0], 1),
        ([20824256, 0, 23243399, 0, 158964, 2520, 0, 1523, 0, 0], 2),
    ];
    for (c, &(seed, n, bits, kk)) in cases.iter().enumerate() {
        let a = structured(seed, n, bits, kk);
        let (nm, den, det) = zmat::inverse_det(&a).unwrap();
        assert_ne!(den, det.abs(), "case {c}: route 2 (delta != |det|)");
        let inv = snf::invariants_nonsingular(&a, &det.abs(), Some((nm.mul(&zmat::det_rhs(n)), den.clone())));
        let k = inv.iter().filter(|x| !x.is_one()).count();
        assert_eq!(k, kk, "case {c}: k");
        let before = tallied();
        let s = smith::trailing_route(&nm, &den, &det.abs(), k).unwrap();
        let after = tallied();
        let mut u = [0u64; FAMILIES];
        for (i, x) in u.iter_mut().enumerate() {
            *x = after.0[i].wrapping_sub(before.0[i]);
        }
        assert_eq!(s.route, Route::Trailing);
        // U a V = D, with D = diag(1, .., 1, the invariants)
        assert_eq!(s.u.mul(&a).mul(&s.v).d, s.d.d, "case {c}: U a V = D");
        for i in 0..n {
            let want = if i < n - k { BigInt::one() } else { inv[i].clone() };
            assert_eq!(s.d.get(i, i), &want, "case {c}: D's diagonal");
        }
        assert!(zmat::det(&s.u).abs().is_one() && zmat::det(&s.v).abs().is_one(), "case {c}: unimodular");
        // the transforms: at most 8 bits(delta) (the old elimination: 172 to 332)
        let top = s.u.max_bits().max(s.v.max_bits());
        assert!(top <= 8 * den.bits(), "case {c}: transforms of {top} bits for delta of {} bits", den.bits());
        // the units: at most 16 n^2 L^2 (attempts + 1), L = delta's limbs (the
        // old elimination: 20 to 50 times this)
        let l = den.bits().div_ceil(64);
        let total: u64 = u.iter().sum();
        let bound = 16 * (n as u64).pow(2) * l * l * (s.attempts + 1);
        assert!(total <= bound, "case {c}: {total} units > {bound}");
        if print {
            println!("        ({u:?}, {}),", s.attempts);
        } else {
            assert_eq!((u, s.attempts), pins[c], "case {c}: units by family and attempts");
        }
    }
}
