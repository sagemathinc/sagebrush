//! Permutations of {0, ..., n-1}, acting on the right as in GAP, Magma and
//! Sage: x^(pq) = (x^p)^q, so `p.mul(&q)` applies p first.

use sagebrush_bigint::BigInt;
use num_integer::Integer;
use num_traits::One;

#[derive(Clone, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct Perm(pub Vec<u32>);

impl Perm {
    pub fn identity(n: usize) -> Perm {
        Perm((0..n as u32).collect())
    }

    /// From images: `images[x]` is the image of x; checked to be a bijection.
    pub fn from_images(images: Vec<u32>) -> Result<Perm, String> {
        let n = images.len();
        let mut seen = vec![false; n];
        for &y in &images {
            if y as usize >= n || seen[y as usize] {
                return Err(format!("not a permutation of 0..{}: {:?}", n, images));
            }
            seen[y as usize] = true;
        }
        Ok(Perm(images))
    }

    /// From disjoint cycles on {0..n-1}.
    pub fn from_cycles(n: usize, cycles: &[Vec<u32>]) -> Result<Perm, String> {
        let mut p: Vec<u32> = (0..n as u32).collect();
        let mut used = vec![false; n];
        for c in cycles {
            for (i, &x) in c.iter().enumerate() {
                if x as usize >= n {
                    return Err(format!("point {} is outside 0..{}", x, n));
                }
                if used[x as usize] {
                    return Err(format!("the cycles are not disjoint (point {})", x));
                }
                used[x as usize] = true;
                p[x as usize] = c[(i + 1) % c.len()];
            }
        }
        Ok(Perm(p))
    }

    #[inline]
    pub fn degree(&self) -> usize {
        self.0.len()
    }

    #[inline]
    pub fn image(&self, x: u32) -> u32 {
        self.0[x as usize]
    }

    /// self then other: x -> other(self(x)).
    pub fn mul(&self, other: &Perm) -> Perm {
        Perm(self.0.iter().map(|&y| other.0[y as usize]).collect())
    }

    pub fn inv(&self) -> Perm {
        let mut r = vec![0u32; self.0.len()];
        for (x, &y) in self.0.iter().enumerate() {
            r[y as usize] = x as u32;
        }
        Perm(r)
    }

    /// g^-1 self g
    pub fn conj(&self, g: &Perm) -> Perm {
        g.inv().mul(self).mul(g)
    }

    /// [a, b] = a^-1 b^-1 a b
    pub fn comm(&self, other: &Perm) -> Perm {
        self.inv().mul(&other.inv()).mul(self).mul(other)
    }

    pub fn pow(&self, k: i64) -> Perm {
        let n = self.0.len();
        let (mut b, mut e) = if k < 0 { (self.inv(), (-(k as i128)) as u128) } else { (self.clone(), k as u128) };
        let mut r = Perm::identity(n);
        while e > 0 {
            if e & 1 == 1 {
                r = r.mul(&b);
            }
            b = b.mul(&b);
            e >>= 1;
        }
        r
    }

    pub fn is_identity(&self) -> bool {
        self.0.iter().enumerate().all(|(x, &y)| x as u32 == y)
    }

    /// The nontrivial cycles, each starting at its smallest point, in order of that point.
    pub fn cycles(&self) -> Vec<Vec<u32>> {
        let n = self.0.len();
        let mut seen = vec![false; n];
        let mut out = vec![];
        for s in 0..n {
            if seen[s] || self.0[s] as usize == s {
                seen[s] = true;
                continue;
            }
            let mut c = vec![];
            let mut x = s;
            while !seen[x] {
                seen[x] = true;
                c.push(x as u32);
                x = self.0[x] as usize;
            }
            out.push(c);
        }
        out
    }

    /// Cycle lengths, fixed points included, largest first (a partition of n).
    pub fn cycle_type(&self) -> Vec<usize> {
        let n = self.0.len();
        let mut seen = vec![false; n];
        let mut t = vec![];
        for s in 0..n {
            if seen[s] {
                continue;
            }
            let mut len = 0;
            let mut x = s;
            while !seen[x] {
                seen[x] = true;
                len += 1;
                x = self.0[x] as usize;
            }
            t.push(len);
        }
        t.sort_unstable_by(|a, b| b.cmp(a));
        t
    }

    pub fn order(&self) -> BigInt {
        let mut r = BigInt::one();
        let mut done = std::collections::BTreeSet::new();
        for l in self.cycle_type() {
            if done.insert(l) {
                r = r.lcm(&BigInt::from(l as u64));
            }
        }
        r
    }

    /// +1 or -1
    pub fn sign(&self) -> i32 {
        let t = self.cycle_type();
        let even_cycles = t.iter().filter(|&&l| l % 2 == 0).count();
        if even_cycles % 2 == 0 {
            1
        } else {
            -1
        }
    }

    /// The smallest moved point, if any.
    pub fn first_moved(&self) -> Option<u32> {
        self.0.iter().enumerate().find(|(x, &y)| *x as u32 != y).map(|(x, _)| x as u32)
    }
}

/// A small, fast, seedable generator (xorshift64*), for reproducible randomness.
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// uniform in 0..m (m > 0)
    pub fn below(&mut self, m: usize) -> usize {
        (((self.next() >> 11) as u128 * m as u128) >> 53) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basics() {
        let p = Perm::from_cycles(5, &[vec![0, 1, 2]]).unwrap();
        let q = Perm::from_cycles(5, &[vec![2, 3]]).unwrap();
        // p first: 1 -> 2, then q: 2 -> 3
        assert_eq!(p.mul(&q).image(1), 3);
        assert_eq!(p.mul(&p.inv()), Perm::identity(5));
        assert_eq!(p.cycle_type(), vec![3, 1, 1]);
        assert_eq!(p.order(), BigInt::from(3));
        assert_eq!(p.pow(3), Perm::identity(5));
        assert_eq!(p.pow(-1), p.inv());
        assert_eq!(q.sign(), -1);
        assert_eq!(p.mul(&q).cycles(), vec![vec![0, 1, 3, 2]]);
    }
}
