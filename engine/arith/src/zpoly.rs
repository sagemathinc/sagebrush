//! Polynomials over Z, as coefficient vectors with the constant term
//! first and no trailing zeros.
//!
//! - [`mul`]: schoolbook for short factors, otherwise Kronecker
//!   substitution (pack the coefficients into one integer at 2^b, multiply
//!   the integers, unpack with signed digits), so long products run at the
//!   speed of big-integer multiplication.
//! - [`gcd`]: modular (Brown, "On Euclid's algorithm and the computation of
//!   polynomial greatest common divisors", JACM 18 (1971); von zur Gathen
//!   and Gerhard, section 6.7): monic gcds modulo primes scaled by the gcd
//!   of the leading coefficients, combined by Chinese remaindering until
//!   stable, then certified by exact division.  Inputs with small
//!   coefficients try the heuristic gcd first (Char, Geddes and Gonnet,
//!   "GCDHEU: Heuristic polynomial GCD algorithm based on integer GCD
//!   computation", J. Symbolic Comput. 7 (1989)): evaluate at xi = 2^k,
//!   take one integer gcd, read off its balanced digits; for
//!   xi >= 2 min(|a|, |b|) + 2 a candidate dividing both inputs is the gcd.

use crate::nmod::{Modulus, Primes};
use crate::nmod_poly;
use crate::zmat::{mod_u64, Crt};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::{BigInt, BigUint, Sign};

pub type ZPoly = Vec<BigInt>;

pub fn trim(mut v: ZPoly) -> ZPoly {
    while v.last().map_or(false, |c| c.is_zero()) {
        v.pop();
    }
    v
}

pub fn max_bits(a: &[BigInt]) -> u64 {
    a.iter().map(|c| c.bits()).max().unwrap_or(0)
}

fn log2_ceil(n: usize) -> u64 {
    (usize::BITS - n.saturating_sub(1).leading_zeros()) as u64
}

fn mul_classical(a: &[BigInt], b: &[BigInt]) -> ZPoly {
    let mut c = vec![BigInt::zero(); a.len() + b.len() - 1];
    if max_bits(a) + max_bits(b) + log2_ceil(a.len().min(b.len())) < 126 {
        if let (Some(x), Some(y)) = (
            a.iter().map(|c| c.to_i64()).collect::<Option<Vec<i64>>>(),
            b.iter().map(|c| c.to_i64()).collect::<Option<Vec<i64>>>(),
        ) {
            let mut acc = vec![0i128; c.len()];
            for (i, &u) in x.iter().enumerate() {
                for (j, &v) in y.iter().enumerate() {
                    acc[i + j] += u as i128 * v as i128;
                }
            }
            return trim(acc.into_iter().map(BigInt::from).collect());
        }
    }
    for (i, u) in a.iter().enumerate() {
        if u.is_zero() {
            continue;
        }
        for (j, v) in b.iter().enumerate() {
            c[i + j] += u * v;
        }
    }
    trim(c)
}

fn or_shifted(dst: &mut [u64], w: &[u64], bit: usize) {
    let (q, r) = (bit / 64, bit % 64);
    for (k, &x) in w.iter().enumerate() {
        dst[q + k] |= x << r;
        if r > 0 {
            dst[q + k + 1] |= x >> (64 - r);
        }
    }
}

fn from_words(w: &[u64]) -> BigInt {
    let bytes: Vec<u8> = w.iter().flat_map(|x| x.to_le_bytes()).collect();
    BigInt::from_biguint(Sign::Plus, BigUint::from_bytes_le(&bytes))
}

/// sum a_i 2^(i b), for |a_i| < 2^(b-1).
fn pack(a: &[BigInt], b: usize) -> BigInt {
    let words = (a.len() * b) / 64 + 2;
    let mut pos = vec![0u64; words];
    let mut neg = vec![0u64; words];
    let mut any_neg = false;
    for (i, c) in a.iter().enumerate() {
        let (s, w) = c.to_u64_digits();
        if s == Sign::Minus {
            any_neg = true;
            or_shifted(&mut neg, &w, i * b);
        } else {
            or_shifted(&mut pos, &w, i * b);
        }
    }
    let p = from_words(&pos);
    if any_neg {
        p - from_words(&neg)
    } else {
        p
    }
}

/// Bits [start, start + len) of a little-endian word array, as words.
fn extract(w: &[u64], start: usize, len: usize) -> Vec<u64> {
    let n = len.div_ceil(64);
    let (q, r) = (start / 64, start % 64);
    let mut out = vec![0u64; n];
    for (k, o) in out.iter_mut().enumerate() {
        let lo = w.get(q + k).copied().unwrap_or(0);
        let hi = w.get(q + k + 1).copied().unwrap_or(0);
        *o = if r == 0 { lo } else { (lo >> r) | (hi << (64 - r)) };
    }
    let extra = n * 64 - len;
    if extra > 0 {
        out[n - 1] &= u64::MAX >> extra;
    }
    out
}

/// The n balanced digits c_i in (-2^(b-1), 2^(b-1)] of z = sum c_i 2^(i b).
fn unpack(z: &BigInt, n: usize, b: usize) -> ZPoly {
    let (s, w) = z.to_u64_digits();
    let negate = s == Sign::Minus;
    let mut out = Vec::with_capacity(n);
    if b <= 126 {
        let half = 1u128 << (b - 1);
        let mut carry = 0u128;
        for i in 0..n {
            let e = extract(&w, i * b, b);
            let d = e[0] as u128 | (e.get(1).copied().unwrap_or(0) as u128) << 64;
            let t = d + carry;
            let c: i128 = if t >= half {
                carry = 1;
                -(((1u128 << b) - t) as i128)
            } else {
                carry = 0;
                t as i128
            };
            out.push(if negate { -BigInt::from(c) } else { BigInt::from(c) });
        }
    } else {
        let full = BigInt::one() << b;
        let half = BigInt::one() << (b - 1);
        let mut carry = BigInt::zero();
        for i in 0..n {
            let t = from_words(&extract(&w, i * b, b)) + &carry;
            let c = if t >= half {
                carry = BigInt::one();
                t - &full
            } else {
                carry = BigInt::zero();
                t
            };
            out.push(if negate { -c } else { c });
        }
    }
    trim(out)
}

/// a * b with every |a_i|, |b_i| < 2^63 and the product's coefficients
/// below 2^bound in absolute value (bound <= 185), by NTT over one, two
/// or three primes chosen from the bound.
fn mul_small(a: &[i64], b: &[i64], bound: u64) -> ZPoly {
    use crate::ntt::{conv_prime, crt, PRIMES};
    let square = std::ptr::eq(a, b);
    let conv = |i: usize| {
        let m = Modulus::new(PRIMES[i].0);
        let x: Vec<u64> = a.iter().map(|&c| m.from_i64(c)).collect();
        if square {
            conv_prime(&x, &x, i)
        } else {
            let y: Vec<u64> = b.iter().map(|&c| m.from_i64(c)).collect();
            conv_prime(&x, &y, i)
        }
    };
    let (p0, p1) = (PRIMES[0].0, PRIMES[1].0);
    // coefficients lie in (-P/2, P/2) for P the product of the primes used
    let out: Vec<BigInt> = if bound < 61 {
        let m = Modulus::new(p0);
        conv(0).into_iter().map(|r| BigInt::from(m.to_signed(r))).collect()
    } else if bound < 123 {
        let (r0, r1) = (conv(0), conv(1));
        let m1 = Modulus::new(p1);
        let c01 = m1.inv(p0 % p1).unwrap();
        let p01 = p0 as u128 * p1 as u128;
        r0.iter()
            .zip(&r1)
            .map(|(&x, &y)| {
                let t1 = m1.mul(m1.sub(y, m1.reduce(x)), c01);
                let v = x as u128 + p0 as u128 * t1 as u128;
                BigInt::from(if v > p01 / 2 { -((p01 - v) as i128) } else { v as i128 })
            })
            .collect()
    } else {
        let (r0, r1, r2) = (conv(0), conv(1), conv(2));
        let c = crt();
        let p012 = BigInt::from(c.p01) * BigInt::from(PRIMES[2].0);
        let half = &p012 / 2u32;
        let p01 = BigInt::from(c.p01);
        (0..r0.len())
            .map(|i| {
                let (v, t2) = c.garner(r0[i], r1[i], r2[i]);
                let x = BigInt::from(v) + &p01 * BigInt::from(t2);
                if x > half {
                    x - &p012
                } else {
                    x
                }
            })
            .collect()
    };
    trim(out)
}

/// a * b.
pub fn mul(a: &[BigInt], b: &[BigInt]) -> ZPoly {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    if a.len().min(b.len()) <= 8 {
        return mul_classical(a, b);
    }
    let bound = max_bits(a) + max_bits(b) + log2_ceil(a.len().min(b.len())) + 1;
    if bound <= 184 && max_bits(a) <= 62 && max_bits(b) <= 62 {
        let x: Vec<i64> = a.iter().map(|c| c.to_i64().unwrap()).collect();
        if std::ptr::eq(a, b) {
            return mul_small(&x, &x, bound);
        }
        let y: Vec<i64> = b.iter().map(|c| c.to_i64().unwrap()).collect();
        return mul_small(&x, &y, bound);
    }
    // |c_i| <= min(len) 2^(bits a + bits b) < 2^(slot - 1)
    let slot = (max_bits(a) + max_bits(b) + log2_ceil(a.len().min(b.len())) + 2) as usize;
    let z = if std::ptr::eq(a, b) {
        let x = pack(a, slot);
        &x * &x
    } else {
        pack(a, slot) * pack(b, slot)
    };
    unpack(&z, a.len() + b.len() - 1, slot)
}

pub fn add(a: &[BigInt], b: &[BigInt]) -> ZPoly {
    let (long, short) = if a.len() >= b.len() { (a, b) } else { (b, a) };
    let mut c = long.to_vec();
    for (x, y) in c.iter_mut().zip(short) {
        *x += y;
    }
    trim(c)
}

pub fn sub(a: &[BigInt], b: &[BigInt]) -> ZPoly {
    let mut c = a.to_vec();
    if c.len() < b.len() {
        c.resize(b.len(), BigInt::zero());
    }
    for (x, y) in c.iter_mut().zip(b) {
        *x -= y;
    }
    trim(c)
}

/// The gcd of the coefficients (nonnegative; 0 for the zero polynomial).
pub fn content(a: &[BigInt]) -> BigInt {
    let mut g = BigInt::zero();
    for c in a {
        g = g.gcd(c);
        if g.is_one() {
            break;
        }
    }
    g
}

/// a / content(a), with positive leading coefficient.
pub fn primitive_part(a: &[BigInt]) -> ZPoly {
    let mut c = content(a);
    if c.is_zero() {
        return vec![];
    }
    if a.last().unwrap().is_negative() {
        c = -c;
    }
    a.iter().map(|x| x / &c).collect()
}

/// a / b if b divides a exactly in Z[x], else None.
pub fn divexact(a: &[BigInt], b: &[BigInt]) -> Option<ZPoly> {
    if b.len() > 32 && a.len() >= b.len() + 32 {
        return divexact_modular(a, b);
    }
    divexact_classical(a, b)
}

/// Exact division by quotients modulo primes: a nonzero remainder modulo
/// any prime not dividing lc(b) proves b does not divide a; otherwise the
/// quotients are combined until stable and the candidate is checked by
/// one multiplication.  Since content(b) | content(a) is checked first,
/// b | a over Q implies the quotient is integral (Gauss), so this ends.
fn divexact_modular(a: &[BigInt], b: &[BigInt]) -> Option<ZPoly> {
    let lb = b.last().unwrap();
    if !(a.last().unwrap() % lb).is_zero() || (!b[0].is_zero() && !(&a[0] % &b[0]).is_zero()) {
        return None;
    }
    if !(content(a) % content(b)).is_zero() {
        return None;
    }
    let ql = a.len() - b.len() + 1;
    let mut crts: Vec<Crt> = (0..ql).map(|_| Crt::new()).collect();
    let mut last: Option<ZPoly> = None;
    for p in Primes::ntt() {
        let m = Modulus::new(p);
        if mod_u64(lb, &m) == 0 {
            continue;
        }
        let (q, r) = nmod_poly::divrem(&reduce(a, &m), &reduce(b, &m), &m);
        if !r.is_empty() {
            return None;
        }
        for (i, cr) in crts.iter_mut().enumerate() {
            cr.add(q.get(i).copied().unwrap_or(0), &m);
        }
        let cand: ZPoly = trim(crts.iter().map(|c| c.signed()).collect());
        if last.as_ref() == Some(&cand) {
            if mul(b, &cand) == a {
                return Some(cand);
            }
        }
        last = Some(cand);
        sagebrush_interrupt::check();
    }
    unreachable!()
}

fn divexact_classical(a: &[BigInt], b: &[BigInt]) -> Option<ZPoly> {
    assert!(!b.is_empty(), "division by zero polynomial");
    if a.is_empty() {
        return Some(vec![]);
    }
    if a.len() < b.len() {
        return None;
    }
    let lb = b.last().unwrap();
    // cheap necessary conditions: the constant and leading terms
    if !(a.last().unwrap() % lb).is_zero() {
        return None;
    }
    if !b[0].is_zero() && !(&a[0] % &b[0]).is_zero() {
        return None;
    }
    let db = b.len() - 1;
    let mut r = a.to_vec();
    let mut q = vec![BigInt::zero(); a.len() - db];
    for i in (0..q.len()).rev() {
        let (c, rem) = r[i + db].div_rem(lb);
        if !rem.is_zero() {
            return None;
        }
        if !c.is_zero() {
            for j in 0..db {
                r[i + j] -= &c * &b[j];
            }
        }
        q[i] = c;
        if i % 32 == 0 {
            sagebrush_interrupt::check();
        }
    }
    if r[..db].iter().all(|x| x.is_zero()) {
        Some(trim(q))
    } else {
        None
    }
}

fn reduce(a: &[BigInt], m: &Modulus) -> Vec<u64> {
    nmod_poly::trim(a.iter().map(|c| mod_u64(c, m)).collect())
}

/// The greatest common divisor, with positive leading coefficient (zero
/// if both are zero).
pub fn gcd(a: &[BigInt], b: &[BigInt]) -> ZPoly {
    let (a, b) = (trim(a.to_vec()), trim(b.to_vec()));
    if a.is_empty() {
        return primitive_sign(b);
    }
    if b.is_empty() {
        return primitive_sign(a);
    }
    let c = content(&a).gcd(&content(&b));
    let (mut pa, mut pb) = (primitive_part(&a), primitive_part(&b));
    if pa.len() < pb.len() {
        std::mem::swap(&mut pa, &mut pb);
    }
    if pb.len() == 1 {
        return vec![c];
    }
    if let Some(h) = gcd_heuristic(&pa, &pb) {
        return h.into_iter().map(|x| x * &c).collect();
    }
    let g = pa.last().unwrap().gcd(pb.last().unwrap());
    let mut deg = usize::MAX;
    let mut crts: Vec<Crt> = vec![];
    let mut last: Option<ZPoly> = None;
    for p in Primes::ntt() {
        let m = Modulus::new(p);
        if mod_u64(pa.last().unwrap(), &m) == 0 || mod_u64(pb.last().unwrap(), &m) == 0 {
            continue;
        }
        let gp = nmod_poly::gcd(&reduce(&pa, &m), &reduce(&pb, &m), &m);
        let d = gp.len() - 1;
        if d == 0 {
            return vec![c];
        }
        if d > deg {
            continue; // unlucky prime
        }
        if d < deg {
            deg = d;
            crts = (0..=d).map(|_| Crt::new()).collect();
            last = None;
        }
        let gm = mod_u64(&g, &m);
        for (cr, &x) in crts.iter_mut().zip(&gp) {
            cr.add(m.mul(x, gm), &m);
        }
        let cand: ZPoly = crts.iter().map(|c| c.signed()).collect();
        if last.as_ref() == Some(&cand) {
            let h = primitive_part(&cand);
            if divexact(&pa, &h).is_some() && divexact(&pb, &h).is_some() {
                return h.into_iter().map(|x| x * &c).collect();
            }
        }
        last = Some(cand);
        sagebrush_interrupt::check();
    }
    unreachable!()
}

/// GCDHEU for primitive a, b with deg a >= deg b > 0; None if it fails
/// (then the modular algorithm runs) or the integers would be large.
fn gcd_heuristic(a: &[BigInt], b: &[BigInt]) -> Option<ZPoly> {
    let bound = max_bits(a).min(max_bits(b)) as usize + 2;
    if bound > 128 {
        return None;
    }
    let mut k = bound + 1; // 2^k >= 2 min(|a|, |b|) + 2 with room
    for _ in 0..4 {
        if a.len() * k > 1 << 18 {
            return None;
        }
        let x = pack(a, k).abs();
        let y = pack(b, k).abs();
        let g = x.gcd(&y);
        if g.is_zero() {
            return None;
        }
        let n = (g.bits() as usize) / k + 2;
        let h = primitive_part(&unpack(&g, n, k));
        if h.len() > 1 && divexact(a, &h).is_some() && divexact(b, &h).is_some() {
            return Some(h);
        }
        if h.len() == 1 {
            // a constant gcd candidate: the inputs are coprime only if the
            // candidate's content is 1 and it divides; let the modular
            // algorithm decide
            return None;
        }
        k = k * 3 / 2 + 1;
    }
    None
}

fn primitive_sign(a: ZPoly) -> ZPoly {
    if a.last().map_or(false, |c| c.is_negative()) {
        a.into_iter().map(|x| -x).collect()
    } else {
        a
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rng(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    fn rand_poly(len: usize, bits: u32, s: &mut u64) -> ZPoly {
        let mut v: ZPoly = (0..len)
            .map(|_| {
                let mut x = BigInt::from(rng(s) >> (64 - bits.min(63)));
                let mut b = bits.min(63);
                while b < bits {
                    x = (x << 63) + BigInt::from(rng(s) >> 1);
                    b += 63;
                }
                if rng(s) & 1 == 1 {
                    -x
                } else {
                    x
                }
            })
            .collect();
        if v.last().map_or(false, |c| c.is_zero()) {
            *v.last_mut().unwrap() = BigInt::one();
        }
        v
    }

    #[test]
    fn kronecker_matches_classical() {
        let mut s = 4u64;
        for (la, lb, bits) in [(9, 9, 5), (20, 13, 60), (50, 50, 64), (100, 30, 1), (64, 64, 200), (300, 300, 30), (40, 40, 1000)] {
            let a = rand_poly(la, bits, &mut s);
            let b = rand_poly(lb, bits, &mut s);
            assert_eq!(mul(&a, &b), mul_classical(&a, &b), "{la}x{lb} {bits} bits");
            assert_eq!(mul(&a, &a), mul_classical(&a, &a));
        }
        // extreme digits: all coefficients -(2^k) or 2^k - 1
        for k in [1u32, 61, 62, 63, 64, 120, 130] {
            let a: ZPoly = (0..30).map(|i| if i % 3 == 0 { -(BigInt::one() << k) } else { (BigInt::one() << k) - 1 }).collect();
            assert_eq!(mul(&a, &a), mul_classical(&a, &a), "k={k}");
        }
    }

    #[test]
    fn gcd_of_products() {
        let mut s = 17u64;
        for (lg, la, bits) in [(1, 5, 10), (3, 10, 20), (10, 30, 40), (40, 40, 64), (25, 60, 150)] {
            let g = primitive_part(&rand_poly(lg, bits, &mut s));
            let a = rand_poly(la, bits, &mut s);
            let b = rand_poly(la + 3, bits, &mut s);
            let (ga, gb) = (mul(&g, &a), mul(&g, &b));
            let h = gcd(&ga, &gb);
            // g divides h, and h / g = gcd(a, b) which is almost always 1
            divexact(&h, &g).expect("g divides the gcd");
            let (ca, cb) = (divexact(&ga, &h).unwrap(), divexact(&gb, &h).unwrap());
            assert_eq!(gcd(&ca, &cb), vec![BigInt::one()], "cofactors coprime");
        }
        // content and coprime cases
        let a: ZPoly = [6, 12, 18].iter().map(|&x| BigInt::from(x)).collect();
        let b: ZPoly = [4, 8].iter().map(|&x| BigInt::from(x)).collect();
        assert_eq!(gcd(&a, &b), vec![BigInt::from(2)]);
        let x2m1: ZPoly = [-1, 0, 1].iter().map(|&x| BigInt::from(x)).collect();
        let xm1: ZPoly = [-1, 1].iter().map(|&x| BigInt::from(x)).collect();
        assert_eq!(gcd(&x2m1, &mul(&xm1, &xm1)), xm1);
    }
}
