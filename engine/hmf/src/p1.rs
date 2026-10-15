//! The projective line P^1(O_F/N) = prod over P^e || N of P^1(O_F/P^e),
//! ported from PSAGE's ProjectiveLineModN (sqrt5_fast.pyx; Bober et al.
//! 2012, section 2.2).
//!
//! Over the local ring O_F/P^e every point has exactly one representative
//! (a : 1) with a in O_F/P^e, or (1 : b) with b in P/P^e. The local index
//! is index(a) for (a : 1) and #(O_F/P^e) + index_in_P(b) for (1 : b); the
//! global index is the mixed-radix number with the local indices as digits
//! (the first factor least significant).

use crate::residue::{LocalRing, Res};

/// A 2x2 matrix [a, b; c, d] over a local ring.
pub type Mat = [Res; 4];

#[derive(Clone, Debug)]
pub struct LocalP1 {
    pub ring: LocalRing,
    /// card(O_F/P^e) + card(P/P^e).
    pub size: u64,
}

impl LocalP1 {
    pub fn new(ring: LocalRing) -> LocalP1 {
        let size = ring.card + ring.card_p();
        LocalP1 { ring, size }
    }
    /// The index of (u : v), or None if u, v are not coprime (both in P).
    #[inline]
    pub fn index_of(&self, u: Res, v: Res) -> Option<u64> {
        let r = &self.ring;
        if let Some(vi) = r.inv(v) {
            Some(r.index(r.mul(u, vi)))
        } else {
            let ui = r.inv(u)?;
            Some(r.card + r.index_in_p(r.mul(v, ui)))
        }
    }
    /// The normalized representative of the point with index i.
    #[inline]
    pub fn point(&self, i: u64) -> (Res, Res) {
        let r = &self.ring;
        if i < r.card {
            (r.element(i), r.one())
        } else {
            (r.one(), r.element_in_p(i - r.card))
        }
    }
    /// The image of the point i under the matrix m (acting on columns).
    #[inline]
    pub fn act(&self, m: &Mat, i: u64) -> Option<u64> {
        let r = &self.ring;
        let (u, v) = self.point(i);
        let x = r.add(r.mul(m[0], u), r.mul(m[1], v));
        let y = r.add(r.mul(m[2], u), r.mul(m[3], v));
        self.index_of(x, y)
    }
}

#[derive(Clone, Debug)]
pub struct P1 {
    pub locals: Vec<LocalP1>,
    /// radix[i] = prod of the sizes of the factors before i.
    pub radix: Vec<u64>,
    pub size: u64,
}

pub const MAX_P1: u64 = 1 << 32;

impl P1 {
    pub fn new(rings: Vec<LocalRing>) -> Result<P1, String> {
        let locals: Vec<LocalP1> = rings.into_iter().map(LocalP1::new).collect();
        let mut radix = vec![];
        let mut size: u128 = 1;
        for l in &locals {
            radix.push(size as u64);
            size *= l.size as u128;
            if size > MAX_P1 as u128 {
                return Err(format!("P^1(O_F/N) has more than 2^32 points"));
            }
        }
        Ok(P1 { locals, radix, size: size as u64 })
    }
    #[inline]
    pub fn digits(&self, mut i: u64, out: &mut [u64]) {
        for (k, l) in self.locals.iter().enumerate() {
            out[k] = i % l.size;
            i /= l.size;
        }
    }
    #[inline]
    pub fn combine(&self, d: &[u64]) -> u64 {
        d.iter().zip(&self.radix).map(|(x, r)| x * r).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::{primes_above, rational_primes};

    #[test]
    fn local_p1_bijection() {
        for p in rational_primes(20) {
            for pr in primes_above(p) {
                for e in 1..=3u32 {
                    if (pr.norm as u128).pow(e) > 5000 {
                        continue;
                    }
                    let l = LocalP1::new(LocalRing::new(pr, e).unwrap());
                    assert_eq!(l.size, l.ring.card + l.ring.card / l.ring.q);
                    for i in 0..l.size {
                        let (u, v) = l.point(i);
                        assert_eq!(l.index_of(u, v), Some(i));
                        // scaling by a unit gives the same point
                        let t = l.ring.reduce(2, 1);
                        if l.ring.is_unit(t) {
                            assert_eq!(l.index_of(l.ring.mul(t, u), l.ring.mul(t, v)), Some(i));
                        }
                    }
                }
            }
        }
    }
}
