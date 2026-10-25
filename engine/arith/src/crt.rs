//! Chinese remaindering for many values over one fixed list of word-size
//! primes: residues of big integers (one reduction per word), and Garner's
//! mixed-radix reconstruction with precomputed constants, assembled in
//! 64-bit limbs (von zur Gathen and Gerhard, section 5.6).

use crate::nmod::Modulus;
use sagebrush_bigint::{BigInt, BigUint, Sign};

pub struct MultiCrt {
    pub mods: Vec<Modulus>,
    /// Q_j = P / p_j as limbs (all the same length), w_j = 1 / Q_j mod p_j
    q: Vec<Vec<u64>>,
    w: Vec<u64>,
    finv: Vec<f64>,
    /// pm[j][i] = p_i mod p_j (i < j)
    pm: Vec<Vec<u64>>,
    /// c[j] = 1 / (p_0 ... p_{j-1}) mod p_j
    c: Vec<u64>,
    /// the product of the primes, and half of it, as limbs
    prod: Vec<u64>,
    half: Vec<u64>,
}

fn mul_small_add(x: &mut Vec<u64>, m: u64, a: u64) {
    let mut carry = a as u128;
    for w in x.iter_mut() {
        let t = *w as u128 * m as u128 + carry;
        *w = t as u64;
        carry = t >> 64;
    }
    if carry > 0 {
        x.push(carry as u64);
    }
}

fn cmp(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    let la = a.iter().rposition(|&w| w != 0).map_or(0, |i| i + 1);
    let lb = b.iter().rposition(|&w| w != 0).map_or(0, |i| i + 1);
    if la != lb {
        return la.cmp(&lb);
    }
    for i in (0..la).rev() {
        if a[i] != b[i] {
            return a[i].cmp(&b[i]);
        }
    }
    std::cmp::Ordering::Equal
}

/// a - b for a >= b.
fn sub(a: &[u64], b: &[u64]) -> Vec<u64> {
    let mut out = a.to_vec();
    let mut borrow = 0u64;
    for (i, o) in out.iter_mut().enumerate() {
        let bi = b.get(i).copied().unwrap_or(0);
        let (d1, b1) = o.overflowing_sub(bi);
        let (d2, b2) = d1.overflowing_sub(borrow);
        *o = d2;
        borrow = (b1 || b2) as u64;
    }
    out
}

/// a -= b in place, for a >= b (a keeps its length).
fn sub_in_place(a: &mut [u64], b: &[u64]) {
    let mut borrow = 0u64;
    for (i, o) in a.iter_mut().enumerate() {
        let bi = b.get(i).copied().unwrap_or(0);
        if bi == 0 && borrow == 0 && i >= b.len() {
            break;
        }
        let (d1, b1) = o.overflowing_sub(bi);
        let (d2, b2) = d1.overflowing_sub(borrow);
        *o = d2;
        borrow = (b1 || b2) as u64;
    }
    debug_assert!(borrow == 0, "sub_in_place needs a >= b");
}

/// The memory of a [`MultiCrt`] over primes whose bit lengths sum to
/// `prime_bits` (the actual primes' sum, or the envelope 62 k for primes
/// below 2^62 when they are not yet known), in bytes: what a caller
/// reserves before building one and before each reconstruct (plan C r4 §3,
/// r5 §2.3).  Vec terms are headers plus capacities; capacities that
/// depend on growth are upper envelopes (2x the length).  None on overflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CrtBytes {
    /// the tables a built MultiCrt keeps (mods, q, w, finv, pm, c, prod, half)
    pub resident: u64,
    /// the extra peak while `new` builds them (the growing qj and prod)
    pub construction: u64,
    /// one reconstruct's temporaries, excluding the caller's residue column
    pub reconstruct: u64,
}

pub fn crt_bytes(k: usize, prime_bits: u64) -> Option<CrtBytes> {
    const VEC: u64 = 24;
    let k = u64::try_from(k).ok()?;
    let lp = prime_bits.div_ceil(64).max(1); // limbs of the product
    let vec_of = |n: u64, size: u64| n.checked_mul(size)?.checked_add(VEC);
    let times = |n: u64, x: u64| n.checked_mul(x);
    let modulus = std::mem::size_of::<Modulus>() as u64;
    // (a Vec grown by pushes has capacity at most max(4, 2 n): Rust's
    // smallest nonzero capacity for these element sizes is 4)
    let grown = |n: u64| Some(times(2, n)?.max(4));
    // qj is pushed to about lp words, then resized to lp + 1
    let q_row = grown(lp.checked_add(1)?)?;
    let q = vec_of(k, VEC)?.checked_add(times(k, vec_of(q_row, 8)?)?)?;
    let triangle = times(k, k.saturating_sub(1))? / 2;
    let pm = vec_of(k, VEC)?.checked_add(times(k, VEC)?)?.checked_add(times(triangle, 8)?)?;
    // mods, finv and c have exact capacities; w is pushed
    let small = vec_of(k, modulus)?.checked_add(times(2, vec_of(k, 8)?)?)?.checked_add(vec_of(grown(k)?, 8)?)?;
    let prod_half = times(2, vec_of(q_row, 8)?)?;
    let resident = q.checked_add(pm)?.checked_add(small)?.checked_add(prod_half)?;
    let construction = vec_of(q_row, 8)?.checked_add(vec_of(grown(lp)?, 8)?)?;
    // lo, hi (u128); x, t, sub's output; to_big's bytes; the result (a
    // BigInt of lp + 1 words with dashu's default capacity n + n/8 + 2)
    let n2 = lp.checked_add(2)?;
    let words = lp.checked_add(1)?;
    let result = times(words.checked_add(words / 8)?.checked_add(2)?, 8)?.checked_add(32)?;
    let reconstruct = times(2, vec_of(n2, 16)?)?
        .checked_add(times(3, vec_of(n2, 8)?)?)?
        .checked_add(vec_of(times(8, n2)?, 1)?)?
        .checked_add(result)?;
    Some(CrtBytes { resident, construction, reconstruct })
}

fn to_big(w: &[u64], neg: bool) -> BigInt {
    let bytes: Vec<u8> = w.iter().flat_map(|x| x.to_le_bytes()).collect();
    BigInt::from_biguint(if neg { Sign::Minus } else { Sign::Plus }, BigUint::from_bytes_le(&bytes))
}

impl MultiCrt {
    pub fn new(primes: &[u64]) -> MultiCrt {
        let mods: Vec<Modulus> = primes.iter().map(|&p| Modulus::new(p)).collect();
        let k = primes.len();
        let mut pm = vec![vec![]; k];
        let mut c = vec![0u64; k];
        for j in 0..k {
            let mj = &mods[j];
            pm[j] = primes[..j].iter().map(|&p| mj.reduce(p)).collect();
            let mut prod = 1 % mj.n;
            for &x in &pm[j] {
                prod = mj.mul(prod, x);
            }
            c[j] = mj.inv(prod).expect("primes not distinct");
        }
        let mut prod = vec![1u64];
        for &p in primes {
            mul_small_add(&mut prod, p, 0);
        }
        // half = floor(prod / 2)
        let mut half = prod.clone();
        let mut carry = 0u64;
        for w in half.iter_mut().rev() {
            let nw = (*w >> 1) | (carry << 63);
            carry = *w & 1;
            *w = nw;
        }
        let qlen = prod.len() + 1;
        let mut q = vec![];
        let mut w = vec![];
        for j in 0..k {
            let mut qj = vec![1u64];
            for (i, &p) in primes.iter().enumerate() {
                if i != j {
                    mul_small_add(&mut qj, p, 0);
                }
            }
            let mj = &mods[j];
            let mut r = 0u64;
            for &d in qj.iter().rev() {
                r = mj.reduce_wide(r, d);
            }
            w.push(mj.inv(r).unwrap());
            qj.resize(qlen, 0);
            q.push(qj);
        }
        let finv = primes.iter().map(|&p| 1.0 / p as f64).collect();
        MultiCrt { mods, q, w, finv, pm, c, prod, half }
    }

    /// pw[j][i] = 2^(64 i) mod p_j for i < words: residues as dot products.
    pub fn word_powers(&self, words: usize) -> Vec<Vec<u64>> {
        self.mods
            .iter()
            .map(|m| {
                let base = m.reduce_wide(1 % m.n, 0); // 2^64 mod p
                let mut v = Vec::with_capacity(words);
                let mut x = 1 % m.n;
                for _ in 0..words {
                    v.push(x);
                    x = m.mul(x, base);
                }
                v
            })
            .collect()
    }

    /// x mod p_j for every j, given word_powers for at least x's length:
    /// sum_i x_i (2^(64 i) mod p_j), summed in u128.
    pub fn residues_with(&self, x: &BigInt, pw: &[Vec<u64>]) -> Vec<u64> {
        let (s, w) = x.to_u64_digits();
        self.mods
            .iter()
            .zip(pw)
            .map(|(m, p)| {
                // one u128 sum, counting its wraps: value = acc + wraps 2^128
                let mut acc = 0u128;
                let mut wraps = 0u64;
                for (&d, &q) in w.iter().zip(p) {
                    let (t, o) = acc.overflowing_add(d as u128 * q as u128);
                    acc = t;
                    wraps += o as u64;
                }
                let mut r = m.reduce_u128(acc);
                if wraps > 0 {
                    let b = m.reduce_wide(1 % m.n, 0); // 2^64 mod p
                    r = m.add(r, m.mul(m.mul(b, b), m.reduce(wraps)));
                }
                if s == Sign::Minus {
                    m.neg(r)
                } else {
                    r
                }
            })
            .collect()
    }

    /// x mod p_j for every j (word by word, all primes at once, so the
    /// reductions for different primes overlap).
    pub fn residues(&self, x: &BigInt) -> Vec<u64> {
        let (s, w) = x.to_u64_digits();
        let mut r = vec![0u64; self.mods.len()];
        for &d in w.iter().rev() {
            for (rj, m) in r.iter_mut().zip(&self.mods) {
                *rj = m.reduce_wide(*rj, d);
            }
        }
        if s == Sign::Minus {
            for (rj, m) in r.iter_mut().zip(&self.mods) {
                *rj = m.neg(*rj);
            }
        }
        r
    }

    /// The integer in (-P/2, P/2] with the given residues: the explicit
    /// formula x = sum_j y_j Q_j - q P, y_j = r_j w_j mod p_j, with the
    /// quotient q = floor(sum_j y_j / p_j) from floating point and an exact
    /// correction.
    pub fn reconstruct(&self, r: &[u64]) -> BigInt {
        self.reconstruct_with(r, None)
    }

    /// reconstruct, with the quotient estimate replaced by `q_estimate`
    /// when given (the tests inject estimates that are wrong by more than
    /// one, which the correction must absorb).
    fn reconstruct_with(&self, r: &[u64], q_estimate: Option<u64>) -> BigInt {
        let k = self.mods.len();
        let n = self.q[0].len();
        let mut lo = vec![0u128; n + 1];
        let mut hi = vec![0u128; n + 1];
        let mut f = 0.0f64;
        for j in 0..k {
            let m = &self.mods[j];
            let y = m.mul(m.reduce(r[j]), self.w[j]);
            f += y as f64 * self.finv[j];
            for (i, &qw) in self.q[j].iter().enumerate() {
                let t = y as u128 * qw as u128;
                lo[i] += t as u64 as u128;
                hi[i + 1] += t >> 64;
            }
        }
        // carry propagation into limbs
        let mut x = vec![0u64; n + 1];
        let mut carry = 0u128;
        for i in 0..=n {
            let t = lo[i] + hi[i] + carry;
            x[i] = t as u64;
            carry = t >> 64;
        }
        // subtract q P.  The estimate is within (k + 3) k 2^-53 of the true
        // quotient (both u64 -> f64 casts, the reciprocal, the product and
        // the sum each round once): below one for every k under ~9.5e7, but
        // correctness does not rest on that.  q P is decreased by P while it
        // exceeds x (q too large, by any amount), then x is decreased by P
        // while it is at least P (q too small): exact for any estimate, and
        // one product-sized buffer t, reused in place, instead of a second
        // clone.  f < k + 1 < 2^53, so the cast is exact.
        let q = q_estimate.unwrap_or(f.floor() as u64);
        let mut t = self.prod.clone();
        mul_small_add(&mut t, q, 0);
        let mut steps = 0u64;
        while cmp(&x, &t) == std::cmp::Ordering::Less {
            // t > x >= 0 and t is a multiple of P, so t >= P
            sub_in_place(&mut t, &self.prod);
            steps += 1;
            if steps % 1024 == 0 {
                sagebrush_interrupt::check();
            }
        }
        let mut x = sub(&x, &t);
        drop(t);
        while cmp(&x, &self.prod) != std::cmp::Ordering::Less {
            x = sub(&x, &self.prod);
            steps += 1;
            if steps % 1024 == 0 {
                sagebrush_interrupt::check();
            }
        }
        if cmp(&x, &self.half) == std::cmp::Ordering::Greater {
            to_big(&sub(&self.prod, &x), true)
        } else {
            to_big(&x, false)
        }
    }

    /// Garner's mixed-radix reconstruction (reference for the tests).
    pub fn reconstruct_garner(&self, r: &[u64]) -> BigInt {
        let k = self.mods.len();
        let mut t = vec![0u64; k];
        for j in 0..k {
            let m = &self.mods[j];
            // (t_0 + t_1 p_0 + ... + t_{j-1} p_0 ... p_{j-2}) mod p_j
            let mut acc = 0u64;
            for i in (0..j).rev() {
                acc = m.add(m.mul(acc, self.pm[j][i]), m.reduce(t[i]));
            }
            t[j] = m.mul(m.sub(m.reduce(r[j]), acc), self.c[j]);
        }
        let mut x = vec![t[k - 1]];
        for i in (0..k - 1).rev() {
            mul_small_add(&mut x, self.mods[i].n, t[i]);
        }
        if cmp(&x, &self.half) == std::cmp::Ordering::Greater {
            to_big(&sub(&self.prod, &x), true)
        } else {
            to_big(&x, false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nmod::Primes;

    #[test]
    fn round_trip() {
        // residues near multiples of P stress the quotient estimate
        let primes: Vec<u64> = Primes::ntt().take(9).collect();
        let crt9 = MultiCrt::new(&primes);
        let all_max: Vec<u64> = primes.iter().map(|&p| p - 1).collect();
        assert_eq!(crt9.reconstruct(&all_max), BigInt::from(-1));
        assert_eq!(crt9.reconstruct(&vec![0; 9]), BigInt::from(0));
        let crt = MultiCrt::new(&primes);
        let mut x = BigInt::from(1);
        for i in 0..200 {
            x = &x * 1_000_000_007u64 + i;
            for v in [x.clone(), -x.clone(), BigInt::from(0), BigInt::from(-1)] {
                if v.bits() < 9 * 61 {
                    assert_eq!(crt.reconstruct(&crt.residues(&v)), v);
                    assert_eq!(crt.reconstruct_garner(&crt.residues(&v)), v);
                    let pw = crt.word_powers(v.bits().div_ceil(64) as usize + 1);
                    assert_eq!(crt.residues_with(&v, &pw), crt.residues(&v));
                }
            }
        }
    }

    /// The floating quotient estimate, as reconstruct computes it.
    fn estimate(crt: &MultiCrt, r: &[u64]) -> u64 {
        let mut f = 0.0f64;
        for (j, m) in crt.mods.iter().enumerate() {
            f += m.mul(m.reduce(r[j]), crt.w[j]) as f64 * crt.finv[j];
        }
        f.floor() as u64
    }

    #[test]
    fn any_quotient_estimate_is_corrected_exactly() {
        // plan C r5 section 2.2: the old code tried q - 1 once, then called
        // sub(a, b) assuming a >= b; an estimate too large by 2 or more broke
        // that.  Estimates off by -3 .. +5 must all give the exact value.
        let primes: Vec<u64> = Primes::ntt().take(7).collect();
        let crt = MultiCrt::new(&primes);
        let mut x = BigInt::from(3);
        for i in 0..60 {
            x = &x * 998_244_353u64 + i;
            for v in [x.clone(), -x.clone(), BigInt::from(0), BigInt::from(-1), BigInt::from(1)] {
                if v.bits() >= 7 * 61 {
                    continue;
                }
                let r = crt.residues(&v);
                let q0 = estimate(&crt, &r);
                for d in [-3i64, -1, 0, 1, 2, 5] {
                    let q = (q0 as i64 + d).max(0) as u64;
                    assert_eq!(crt.reconstruct_with(&r, Some(q)), v, "estimate off by {}", d);
                }
            }
        }
    }

    #[test]
    fn sub_in_place_subtracts() {
        let mut a = vec![0u64, 0, 1]; // 2^128
        sub_in_place(&mut a, &[1]);
        assert_eq!(a, vec![!0u64, !0u64, 0]);
        let mut b = vec![5u64, 7];
        sub_in_place(&mut b, &[5, 7]);
        assert_eq!(b, vec![0, 0]);
    }

    #[test]
    fn crt_bytes_bounds_the_built_tables() {
        // the resident figure is at least what a built MultiCrt holds
        // (headers plus actual capacities), for every prime count tried
        for k in [1usize, 2, 3, 8, 33, 120] {
            let primes: Vec<u64> = Primes::ntt().take(k).collect();
            let bits: u64 = primes.iter().map(|&p| 64 - p.leading_zeros() as u64).sum();
            let crt = MultiCrt::new(&primes);
            let v = |n: usize, size: usize| (24 + n * size) as u64;
            let actual = v(crt.mods.capacity(), std::mem::size_of::<Modulus>())
                + v(crt.q.capacity(), 24) + crt.q.iter().map(|r| v(r.capacity(), 8)).sum::<u64>()
                + v(crt.w.capacity(), 8) + v(crt.finv.capacity(), 8) + v(crt.c.capacity(), 8)
                + v(crt.pm.capacity(), 24) + crt.pm.iter().map(|r| v(r.capacity(), 8)).sum::<u64>()
                + v(crt.prod.capacity(), 8) + v(crt.half.capacity(), 8);
            let b = crt_bytes(k, bits).unwrap();
            assert!(actual <= b.resident, "k = {}: actual {} > bound {}", k, actual, b.resident);
            // and the envelope for unknown primes (62 bits each) is at least the actual-bits figure
            assert!(crt_bytes(k, 62 * k as u64).unwrap().resident >= b.resident);
        }
        assert_eq!(crt_bytes(!0usize, !0u64), None);
    }
}
