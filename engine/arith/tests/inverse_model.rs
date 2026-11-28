//! The inverse's model (`zmat::inverse_model`, the work estimate's stage 1
//! for the inverse) against the units `inverse_det` actually charges, on
//! these dense random inputs: given the fold the run took (its entry count,
//! and e = |det| / den), every family but the fold's (Gcd and Div) is
//! exact.  The fold's are priced at the determinant's size: on the rows
//! whose determinant is a word, the adjugate's entries are words too
//! (Hadamard's bound on the minors, at these sizes) and the model is the
//! tally exactly; on the others, dense random entries have no more limbs
//! than the determinant, so the model bounds the run from above.  (Not a
//! rule for every input: an adjugate entry can be longer than the
//! determinant, e.g. [[1, 0], [2^70, 2]].)

use num_traits::{One, Signed};
use sagebrush_arith::cost::{tallied, Family, FAMILIES};
use sagebrush_arith::zmat::{self, limbs, ZMat};
use sagebrush_bigint::BigInt;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
}

#[test]
fn the_model_is_the_inverse_tally() {
    let mut rg = Rng(5);
    let (mut exact, mut bounded) = (0, 0);
    for &(n, bits) in &[(2usize, 8u32), (3, 8), (4, 16), (6, 30), (8, 60), (10, 63), (12, 40), (16, 20), (5, 63)] {
        for _ in 0..3 {
            let a = ZMat::from_rows(
                (0..n)
                    .map(|_| {
                        (0..n)
                            .map(|_| {
                                let x = BigInt::from(rg.next() >> (64 - bits));
                                if rg.next() & 1 == 1 {
                                    -x
                                } else {
                                    x
                                }
                            })
                            .collect()
                    })
                    .collect(),
            );
            let t0 = tallied();
            let (nm, den, det) = zmat::inverse_det(&a).expect("nonsingular");
            let t1 = tallied();
            let got: Vec<u64> = (0..FAMILIES).map(|i| t1.0[i].wrapping_sub(t0.0[i])).collect();
            // the fold the run took: the adjugate's entries (N e) while the
            // running gcd with det is not 1
            let e = det.abs() / &den;
            let mut g = det.clone();
            let mut fold = 0u64;
            for x in nm.d.iter().map(|x| x * &e) {
                if g.is_one() {
                    break;
                }
                fold += 1;
                g = num_integer::Integer::gcd(&g, &x);
            }
            let model = zmat::inverse_model(&a, limbs(&det), fold, (!e.is_one()).then(|| limbs(&e)));
            if limbs(&det) == 1 {
                assert_eq!(got, model.0.to_vec(), "{n} x {n}, {bits}-bit entries: the tally");
                exact += 1;
            } else {
                for f in 0..FAMILIES {
                    if f == Family::Gcd as usize || f == Family::Div as usize {
                        assert!(model.0[f] >= got[f], "{n} x {n}, {bits}-bit: the fold's family {f} bounded");
                    } else {
                        assert_eq!(model.0[f], got[f], "{n} x {n}, {bits}-bit: family {f}");
                    }
                }
                bounded += 1;
            }
        }
    }
    assert_eq!((exact, bounded), (9, 18), "the rows of each kind");
}
