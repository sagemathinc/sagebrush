//! Subquadratic gcd: the half-gcd ("HGCD", Schonhage; Thull-Yap; Moller),
//! on dashu's integers, O(M(n) log n) instead of dashu's quadratic Lehmer
//! gcd for large inputs.
//!
//! `half(a, b)` returns a 2 x 2 integer matrix M of determinant +-1 with
//! (a, b) = M (a', b'), where a' >= b' >= 0 have about half the bits of a.
//! It works on the top bits: the matrix that halves the top half of (a, b)
//! takes (a, b) a quarter of the way, and a second recursion on the top
//! bits of the result takes it to half.
//!
//! Correctness does not depend on how good the matrices are: any integer
//! matrix of determinant +-1 preserves the gcd, and the reduced pair is
//! computed exactly from it.  A matrix found from truncated numbers can
//! only reduce less well (its results' signs and order are fixed by
//! negating or swapping columns), and the outer loop then takes a plain
//! division step, so the result is always right and progress is assured.

use dashu_base::{BitTest, DivRem, Gcd, UnsignedAbs};
use dashu_int::{IBig, UBig};

/// Below this many bits, `half` takes Euclidean steps in u128 arithmetic.
const BASE_BITS: usize = 126;
/// From this many bits on (the smaller operand), `gcd` uses the half-gcd;
/// below, dashu's Lehmer gcd is faster (crossover measured with bench/bigint:
/// about 800K bits).
pub const GCD_THRESHOLD_BITS: usize = 1 << 20;

/// (a; b) = M (a'; b'), M = [[m11, m12], [m21, m22]], det M = +-1.
struct Mat {
    m: [IBig; 4],
}

impl Mat {
    fn identity() -> Mat {
        Mat { m: [IBig::ONE, IBig::ZERO, IBig::ZERO, IBig::ONE] }
    }

    fn mul(&self, o: &Mat) -> Mat {
        let [a, b, c, d] = &self.m;
        let [e, f, g, h] = &o.m;
        Mat { m: [a * e + b * g, a * f + b * h, c * e + d * g, c * f + d * h] }
    }

    fn det_is_one(&self) -> bool {
        let [a, b, c, d] = &self.m;
        a * d - b * c == IBig::ONE
    }

    /// (a', b') = M^-1 (a, b) = det [[m22, -m12], [-m21, m11]] (a, b).
    fn apply_inv(&self, a: &UBig, b: &UBig) -> (IBig, IBig) {
        let (a, b) = (IBig::from(a.clone()), IBig::from(b.clone()));
        let [m11, m12, m21, m22] = &self.m;
        let x = m22 * &a - m12 * &b;
        let y = m11 * &b - m21 * &a;
        if self.det_is_one() {
            (x, y)
        } else {
            (-x, -y)
        }
    }

    /// Make (x, y) = M^-1 (a, b) satisfy x >= y >= 0, adjusting M's columns
    /// (negating a column negates that coordinate; swapping swaps them).
    fn normalize(&mut self, x: IBig, y: IBig) -> (UBig, UBig) {
        let (mut x, mut y) = (x, y);
        if x < IBig::ZERO {
            x = -x;
            self.m[0] = -std::mem::take(&mut self.m[0]);
            self.m[2] = -std::mem::take(&mut self.m[2]);
        }
        if y < IBig::ZERO {
            y = -y;
            self.m[1] = -std::mem::take(&mut self.m[1]);
            self.m[3] = -std::mem::take(&mut self.m[3]);
        }
        if x < y {
            std::mem::swap(&mut x, &mut y);
            self.m.swap(0, 1);
            self.m.swap(2, 3);
        }
        (x.unsigned_abs(), y.unsigned_abs())
    }
}

fn bits(x: &UBig) -> usize {
    x.bit_len()
}

/// Euclidean steps on a >= b (both below 2^127) until b < 2^s, in machine
/// arithmetic: the matrix of the quotients.
fn euclid_small(a: &UBig, b: &UBig, s: usize) -> Mat {
    let (mut a, mut b) = (u128::try_from(a).unwrap(), u128::try_from(b).unwrap());
    // the entries stay below a's size, so they fit in i128
    let (mut m11, mut m12, mut m21, mut m22) = (1i128, 0i128, 0i128, 1i128);
    while 128 - b.leading_zeros() as usize > s {
        let q = a / b;
        let r = a - q * b;
        let qi = q as i128;
        (m11, m12) = (qi * m11 + m12, m11);
        (m21, m22) = (qi * m21 + m22, m21);
        a = b;
        b = r;
    }
    Mat { m: [IBig::from(m11), IBig::from(m12), IBig::from(m21), IBig::from(m22)] }
}

/// M with (a, b) = M (a', b'), a' >= b' >= 0 of about half the bits of a
/// (a >= b).
fn half(a: &UBig, b: &UBig) -> Mat {
    let n = bits(a);
    let s = n / 2 + 1;
    if bits(b) <= s {
        return Mat::identity();
    }
    if n <= BASE_BITS {
        return euclid_small(a, b, s);
    }
    // the top half, halved, takes (a, b) to about 3n/4 bits
    let k1 = n / 2;
    let mut m1 = half(&(a >> k1), &(b >> k1));
    let (x, y) = m1.apply_inv(a, b);
    let (a1, b1) = m1.normalize(x, y);
    if bits(&b1) <= s {
        return m1;
    }
    // one division step, then the top of (b1, r), halved, takes it to n/2
    let (q, r) = (&a1).div_rem(&b1);
    let q = IBig::from(q);
    let step = Mat { m: [q, IBig::ONE, IBig::ONE, IBig::ZERO] };
    let mut m = m1.mul(&step);
    let (a2, b2) = (b1, r);
    if bits(&b2) <= s {
        return m;
    }
    let n2 = bits(&a2);
    let k2 = (2 * s).saturating_sub(n2).min(n2.saturating_sub(1));
    let m2 = half(&(&a2 >> k2), &(&b2 >> k2));
    m = m.mul(&m2);
    m
}

/// gcd(a, b) by half-gcd reductions down to GCD_THRESHOLD_BITS, then dashu's.
pub fn gcd(a: &UBig, b: &UBig) -> UBig {
    gcd_from(a, b, GCD_THRESHOLD_BITS)
}

/// gcd with half-gcd reductions while the smaller operand has `threshold`
/// bits or more (tests use small thresholds to exercise the reductions).
fn gcd_from(a: &UBig, b: &UBig, threshold: usize) -> UBig {
    let (mut a, mut b) = if a >= b { (a.clone(), b.clone()) } else { (b.clone(), a.clone()) };
    loop {
        if b.is_zero() {
            return a;
        }
        if bits(&b) < threshold {
            return (&a).gcd(&b);
        }
        let n = bits(&a);
        if n - bits(&b) > 64 {
            // a large quotient: one division
            let r = &a % &b;
            (a, b) = (b, r);
            continue;
        }
        let mut m = half(&a, &b);
        let (x, y) = m.apply_inv(&a, &b);
        let (x, y) = m.normalize(x, y);
        if bits(&x) > n - n / 8 {
            // too little progress (cannot happen for exact matrices; a
            // safeguard): one division
            let r = &a % &b;
            (a, b) = (b, r);
        } else {
            (a, b) = (x, y);
        }
        crate::check_interrupt();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rand_ubig(bits: usize, seed: &mut u64) -> UBig {
        let words = bits.div_ceil(64);
        let mut bytes = Vec::with_capacity(words * 8);
        for _ in 0..words {
            *seed ^= *seed << 13;
            *seed ^= *seed >> 7;
            *seed ^= *seed << 17;
            bytes.extend_from_slice(&seed.to_le_bytes());
        }
        UBig::from_le_bytes(&bytes) >> (words * 64 - bits)
    }

    /// Against dashu's gcd: random pairs, pairs with a large common factor,
    /// unequal sizes, consecutive Fibonacci numbers (all quotients 1); the
    /// half-gcd path from 200 bits on, and at the production threshold.
    #[test]
    fn half_gcd_agrees_with_lehmer() {
        let mut seed = 0x1234_5678_9abc_def1u64;
        for &bits in &[130usize, 200, 1000, 4097, 30_000, 100_003, GCD_THRESHOLD_BITS + 777] {
            for &t in &[128usize, 1000, GCD_THRESHOLD_BITS] {
                for _ in 0..3 {
                    let a = rand_ubig(bits, &mut seed);
                    let b = rand_ubig(bits - 3, &mut seed);
                    assert_eq!(gcd_from(&a, &b, t), (&a).gcd(&b), "random, {} bits, threshold {}", bits, t);
                    let g = rand_ubig(bits / 3 + 1, &mut seed);
                    let (ga, gb) = (&a * &g, &b * &g);
                    assert_eq!(gcd_from(&ga, &gb, t), (&ga).gcd(&gb), "common factor, {} bits", bits);
                    let c = rand_ubig(bits / 2 + 1, &mut seed);
                    assert_eq!(gcd_from(&a, &c, t), (&a).gcd(&c), "unequal, {} bits", bits);
                }
                if bits > 50_000 {
                    break;
                }
            }
        }
        // Fibonacci numbers F_k, F_{k+1}: gcd 1 after k steps of quotient 1
        let (mut f0, mut f1) = (UBig::ZERO, UBig::ONE);
        for _ in 0..200_000 {
            let f2 = &f0 + &f1;
            f0 = f1;
            f1 = f2;
        }
        assert_eq!(gcd_from(&f1, &f0, 128), UBig::ONE);
        let g = rand_ubig(5000, &mut seed);
        assert_eq!(gcd_from(&(&f1 * &g), &(&f0 * &g), 1000), g);
    }
}
