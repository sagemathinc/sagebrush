//! Integral LLL (H. Cohen, A Course in Computational Algebraic Number
//! Theory, Algorithm 2.6.7, after de Weger): exact integers only, with
//! delta = 99/100.  The basis rows must be linearly independent.
//!
//! Within the call's budget (plan r3, section 5.3): every step debits its
//! work first; every product is preflighted from its operands' bit lengths
//! (more than 2L + 64 bits refuses before it is computed); every stored
//! value is checked against the cap L after each step.  The caller
//! reserves the memory of the basis and of this state ([`lattice_bytes`])
//! before building the basis.

use crate::budget::{big_bytes, limbs, Budget, FResult};
use crate::clog2;
use num_integer::Integer;
use num_traits::{Signed, Zero};
use sagebrush_bigint::BigInt;

/// The stored-value cap L for a d-row basis whose entries have at most
/// `e` bits: d (2e + ceil(log2 d) + 4) + 64.
pub fn cap_bits(d: usize, e: u64) -> Option<u64> {
    let per = e.checked_mul(2)?.checked_add(clog2(d as u64))?.checked_add(4)?;
    (d as u64).checked_mul(per)?.checked_add(64)
}

/// Bytes for a d-row basis of length-`w` rows plus the LLL state (the d_i
/// and the lambda_ij), every value at most L bits, and two rows of
/// transients of 2L + 64 bits.
pub fn lattice_bytes(d: usize, w: usize, l: u64) -> Option<u64> {
    let d64 = d as u64;
    let values = d64.checked_mul(w as u64)?.checked_add(d64.checked_mul(d64 + 1)? / 2)?.checked_add(d64 + 1)?;
    let stored = values.checked_mul(big_bytes(l)?)?;
    let transient = (2 * d64.max(w as u64)).checked_mul(big_bytes(l.checked_mul(2)?.checked_add(64)?)?)?;
    stored.checked_add(transient)
}

/// The reduced state: the basis and the Gram determinants d_0 = 1, d_1,
/// ..., d_n (d_i = prod_{j <= i} |b_j*|^2).
pub struct Reduced {
    pub basis: Vec<Vec<BigInt>>,
    pub d: Vec<BigInt>,
}

struct State<'a> {
    b: &'a Budget,
    cap: u64,
    basis: Vec<Vec<BigInt>>,
    d: Vec<BigInt>,
    lam: Vec<Vec<BigInt>>,
}

impl State<'_> {
    /// x * y, refused before it is computed when it could exceed 2L + 64
    /// bits.
    fn mul(&self, x: &BigInt, y: &BigInt) -> FResult<BigInt> {
        let bits = x.bits() + y.bits();
        let lim = 2 * self.cap + 64;
        if bits > lim {
            return Err(self.b.refuse("lll bits (transient)", bits, lim));
        }
        Ok(x * y)
    }

    fn check(&self, x: &BigInt) -> FResult<()> {
        if x.bits() > self.cap {
            return Err(self.b.refuse("lll bits", x.bits(), self.cap));
        }
        Ok(())
    }

    fn dot(&self, x: &[BigInt], y: &[BigInt]) -> FResult<BigInt> {
        let mut s = BigInt::zero();
        for (u, w) in x.iter().zip(y) {
            s += self.mul(u, w)?;
        }
        Ok(s)
    }

    /// Charge `count` products of `x`- and `y`-bit operands, plus as many
    /// additions of the result (schoolbook limb operations, from the actual
    /// operands about to be used).
    fn debit_ops(&self, count: usize, x: u64, y: u64) -> FResult<()> {
        let (lx, ly) = (limbs(x), limbs(y));
        self.b.debit(lx.checked_mul(ly).and_then(|p| p.checked_add(lx + ly)).and_then(|p| p.checked_mul(count.max(1) as u64)))
    }

    /// Size-reduce row k against row l (Cohen's REDI, 0-based rows; d is
    /// shifted: d[i + 1] belongs to row i).
    fn redi(&mut self, k: usize, l: usize) -> FResult<()> {
        let dl = &self.d[l + 1];
        let lam = &self.lam[k][l];
        if (lam.abs() * 2u32) <= *dl {
            return Ok(());
        }
        // q = round(lambda / d_l)
        let q = (lam * 2u32 + dl).div_floor(&(dl * 2u32));
        let row_bits = crate::maxbits(&self.basis[l]);
        let lam_bits = crate::maxbits(&self.lam[l]).max(self.d[l + 1].bits());
        self.debit_ops(self.basis[k].len(), q.bits(), row_bits)?;
        self.debit_ops(l + 1, q.bits(), lam_bits)?;
        let row_l = self.basis[l].clone();
        for (x, y) in self.basis[k].iter_mut().zip(&row_l) {
            let t = if q.bits() + y.bits() > 2 * self.cap + 64 {
                return Err(self.b.refuse("lll bits (transient)", q.bits() + y.bits(), 2 * self.cap + 64));
            } else {
                &q * y
            };
            *x -= t;
        }
        let qd = self.mul(&q, &self.d[l + 1])?;
        self.lam[k][l] -= qd;
        for i in 0..l {
            let t = self.mul(&q, &self.lam[l][i])?;
            self.lam[k][i] -= t;
        }
        for x in &self.basis[k] {
            self.check(x)?;
        }
        for x in &self.lam[k][..=l] {
            self.check(x)?;
        }
        Ok(())
    }

    /// Exchange rows k - 1 and k (Cohen's SWAPI, 0-based).
    fn swapi(&mut self, k: usize, kmax: usize) -> FResult<()> {
        let dbits = self.d[k - 1].bits().max(self.d[k].bits()).max(self.d[k + 1].bits());
        let lbits = (k + 1..=kmax).map(|i| self.lam[i][k].bits().max(self.lam[i][k - 1].bits())).max().unwrap_or(0).max(self.lam[k][k - 1].bits());
        // B, then four products and two divisions per later row
        self.debit_ops(2 + 6 * (kmax - k), dbits.max(lbits), dbits.max(lbits) + dbits)?;
        self.basis.swap(k, k - 1);
        for j in 0..k - 1 {
            let t = std::mem::take(&mut self.lam[k][j]);
            self.lam[k][j] = std::mem::replace(&mut self.lam[k - 1][j], t);
        }
        let lam = self.lam[k][k - 1].clone();
        // B = (d_{k-2} d_k + lambda^2) / d_{k-1}  (1-based); here d[k-1], d[k+1], d[k]
        let nb = (self.mul(&self.d[k - 1], &self.d[k + 1])? + self.mul(&lam, &lam)?) / &self.d[k];
        self.check(&nb)?;
        for i in k + 1..=kmax {
            let t = self.lam[i][k].clone();
            let a = (self.mul(&self.d[k + 1], &self.lam[i][k - 1])? - self.mul(&lam, &t)?) / &self.d[k];
            let c = (self.mul(&nb, &t)? + self.mul(&lam, &a)?) / &self.d[k + 1];
            self.check(&a)?;
            self.check(&c)?;
            self.lam[i][k] = a;
            self.lam[i][k - 1] = c;
        }
        self.d[k] = nb;
        Ok(())
    }
}

/// LLL-reduce the rows (independent), with values capped at `cap` bits.
pub fn lll(b: &Budget, basis: Vec<Vec<BigInt>>, cap: u64) -> FResult<Reduced> {
    let n = basis.len();
    let mut s = State { b, cap, basis, d: vec![BigInt::zero(); n + 1], lam: vec![vec![]; n] };
    s.d[0] = BigInt::from(1);
    if n == 0 {
        return Ok(Reduced { basis: s.basis, d: s.d });
    }
    for i in 0..n {
        s.lam[i] = vec![BigInt::zero(); i];
    }
    let b0 = crate::maxbits(&s.basis[0]);
    s.debit_ops(s.basis[0].len(), b0, b0)?;
    s.d[1] = s.dot(&s.basis[0], &s.basis[0])?;
    s.check(&s.d[1])?;
    let mut k = 1usize;
    let mut kmax = 0usize;
    while k < n {
        if k > kmax {
            // incremental Gram-Schmidt
            kmax = k;
            for j in 0..=k {
                let (bk, bj) = (crate::maxbits(&s.basis[k]), crate::maxbits(&s.basis[j]));
                s.debit_ops(s.basis[k].len(), bk, bj)?;
                let mut u = s.dot(&s.basis[k], &s.basis[j])?;
                let gbits = s.d[..=j].iter().map(|x| x.bits()).max().unwrap_or(0).max(crate::maxbits(&s.lam[k][..j.min(k)])).max(crate::maxbits(&s.lam[j]));
                s.debit_ops(2 * j, gbits.max(u.bits()), gbits.max(u.bits()) + gbits)?;
                for i in 0..j {
                    u = (s.mul(&s.d[i + 1], &u)? - s.mul(&s.lam[k][i], &s.lam[j][i])?) / &s.d[i];
                }
                s.check(&u)?;
                if j < k {
                    s.lam[k][j] = u;
                } else {
                    assert!(!u.is_zero(), "lll: dependent rows");
                    s.d[k + 1] = u;
                }
            }
        }
        // Lovasz test with delta = 99/100: 100 d_k d_{k-2} < 99 d_{k-1}^2 - 100 lambda^2
        s.redi(k, k - 1)?;
        let tb = s.d[k - 1].bits().max(s.d[k].bits()).max(s.d[k + 1].bits()).max(s.lam[k][k - 1].bits());
        s.debit_ops(3, tb, tb)?;
        let lhs = s.mul(&s.d[k + 1], &s.d[k - 1])? * 100u32;
        let rhs = s.mul(&s.d[k], &s.d[k])? * 99u32 - s.mul(&s.lam[k][k - 1], &s.lam[k][k - 1])? * 100u32;
        if lhs < rhs {
            s.swapi(k, kmax)?;
            k = if k > 1 { k - 1 } else { 1 };
        } else {
            for l in (0..k - 1).rev() {
                s.redi(k, l)?;
            }
            k += 1;
        }
    }
    Ok(Reduced { basis: s.basis, d: s.d })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::{Budget, Limits};

    fn z(rows: &[&[i64]]) -> Vec<Vec<BigInt>> {
        rows.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect()
    }

    fn sq(v: &[BigInt]) -> BigInt {
        v.iter().map(|x| x * x).sum()
    }

    #[test]
    fn reduces_and_keeps_the_lattice() {
        let b = Budget::default();
        // a knapsack-like basis: the short vector (1, 1, -1, 0) * stuff
        let m = z(&[&[1, 0, 0, 1000], &[0, 1, 0, 1031], &[0, 0, 1, 2031], &[0, 0, 0, 100003]]);
        let r = lll(&b, m.clone(), cap_bits(4, 20).unwrap()).unwrap();
        // the first vector is short: (1, 1, -1, 0) up to sign
        assert_eq!(sq(&r.basis[0]), BigInt::from(3));
        // same determinant (the d_n is the Gram determinant)
        assert_eq!(r.d[4], BigInt::from(100003i64 * 100003));
        // the d_i match the Gram-Schmidt norms recomputed exactly: d_1 = |b_1|^2
        assert_eq!(r.d[1], sq(&r.basis[0]));
        assert!(b.debited(crate::budget::Phase::Admission));
    }

    #[test]
    fn refuses_when_values_exceed_the_cap() {
        let b = Budget::default();
        let m = z(&[&[1, 0, 1 << 40], &[0, 1, (1 << 40) + 7], &[0, 0, 1 << 45]]);
        let e = lll(&b, m.clone(), 30).err().unwrap();
        assert!(e.what.starts_with("lll bits"), "{e}");
        // and works with room, the next call unaffected
        assert!(lll(&b, m, cap_bits(3, 46).unwrap()).is_ok());
    }

    #[test]
    fn refuses_when_work_runs_out() {
        let b = Budget::new(Limits { work: 10, ..Limits::DEFAULT });
        let m = z(&[&[1, 0, 1 << 20], &[0, 1, (1 << 20) + 7], &[0, 0, 1 << 25]]);
        assert_eq!(lll(&b, m, cap_bits(3, 26).unwrap()).err().unwrap().what, "work");
    }

    /// The leading principal minors of the Gram matrix, by fraction-free
    /// elimination: d_1, ..., d_n.
    fn gram_dets(m: &[Vec<BigInt>]) -> Vec<BigInt> {
        let n = m.len();
        let mut g: Vec<Vec<BigInt>> = (0..n).map(|i| (0..n).map(|j| m[i].iter().zip(&m[j]).map(|(x, y)| x * y).sum()).collect()).collect();
        let mut out = vec![];
        let mut prev = BigInt::from(1);
        for k in 0..n {
            out.push(g[k][k].clone());
            for i in k + 1..n {
                for j in k + 1..n {
                    g[i][j] = (&g[k][k] * &g[i][j] - &g[i][k] * &g[k][j]) / &prev;
                }
            }
            prev = g[k][k].clone();
        }
        out
    }

    #[test]
    fn gram_determinants_are_exact() {
        // knapsack-shaped random lattices: identity plus large columns
        let mut seed = 12345u64;
        let mut rnd = |m: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % m
        };
        for trial in 0..20 {
            let r = 4 + trial % 9;
            let cols = 1 + trial % 3;
            let mut m: Vec<Vec<BigInt>> = vec![];
            for i in 0..r {
                let mut row: Vec<BigInt> = (0..r).map(|j| BigInt::from((i == j) as u32)).collect();
                for _ in 0..cols {
                    row.push(BigInt::from(rnd(1 << 40)));
                }
                m.push(row);
            }
            for c in 0..cols {
                let mut row = vec![BigInt::zero(); r + cols];
                row[r + c] = BigInt::from((1u64 << 40) + 15);
                m.push(row);
            }
            let b = Budget::default();
            let red = lll(&b, m.clone(), cap_bits(m.len(), 42).unwrap()).unwrap();
            let want = gram_dets(&red.basis);
            assert_eq!(&red.d[1..], &want[..], "trial {}", trial);
            // same lattice volume
            assert_eq!(red.d.last(), gram_dets(&m).last());
        }
    }
}
