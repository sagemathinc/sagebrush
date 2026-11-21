//! The diagonal of the Smith normal form (the invariant factors) of integer
//! matrices, with arithmetic bounded by the determinant, and usually by far
//! less.
//!
//! For a square nonsingular A with invariant factors t_1 | ... | t_n and
//! d = |det A| = t_1 ... t_n ([`invariants_nonsingular`]):
//! 1. d, exactly (`zmat::det`).
//! 2. One solve A x = b (`zmat::solve`, b = `zmat::det_rhs`), whose least
//!    common denominator delta divides t_n, since t_n A^-1 = V (t_n D^-1) U
//!    is integral.  The denominator is reduced here (delta = den /
//!    gcd(den, N)), not taken on trust: a multiple of the least one can
//!    divide d without dividing t_n.  Skipped when d fits in a word.
//! 3. e = d / delta.  For i < n, t_i divides d / t_n, which divides e.
//! 4. The Smith form of A over Z/eZ ([`smith_mod`]) is diag(gcd(t_i, e)),
//!    so its first n - 1 entries are t_1, ..., t_(n-1); then t_n = d / their
//!    product.  e = 1 needs no elimination: t_1 = ... = t_(n-1) = 1.
//!
//! The content (the gcd of the entries, which is t_1) is divided out
//! first, so a common factor of every entry never makes e large.
//!
//! The solve's right-hand side affects only how small e is, never the
//! answer: delta = 1 is the classical Smith form modulo the determinant
//! (Iliopoulos; Hafner and McCurley).  e is small when the invariants other
//! than the last are (random matrices), and large when they are not
//! (p I, repeated prime powers): e >= t_1 ... t_(n-1).

use crate::zmat::{self, ZMat};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

/// Moduli below this take [`smith_mod`]'s word path: two residues' product
/// is below 2^124, and a sum of two such below 2^125, in a u128.  (2^63
/// would still fit; 2^62 is a deliberate margin.)
const WORD_E: u64 = 1 << 62;

/// Z/eZ for [`smith_mod`]'s elimination: residues in [0, e), compared and
/// divided as the integers they are.
trait Zn {
    type T: Clone + PartialEq;
    fn residue(&self, x: &BigInt) -> Self::T;
    fn integer(x: &Self::T) -> BigInt;
    fn is_zero(x: &Self::T) -> bool;
    /// s x + u y
    fn lin(&self, s: &Self::T, x: &Self::T, u: &Self::T, y: &Self::T) -> Self::T;
    /// x - q y
    fn sub_mul(&self, x: &Self::T, q: &Self::T, y: &Self::T) -> Self::T;
    fn add(&self, x: &Self::T, y: &Self::T) -> Self::T;
    fn neg(&self, x: &Self::T) -> Self::T;
    /// x / y when y > 0 divides x as integers.
    fn quotient(x: &Self::T, y: &Self::T) -> Option<Self::T>;
    /// For p > 0 and a as integers, g = gcd(p, a) and residues s, u with
    /// s p + u a = g over Z: (s, u, a / g, p / g).  The matrix
    /// [[s, u], [-a/g, p/g]] has determinant 1.
    fn bezout(&self, p: &Self::T, a: &Self::T) -> (Self::T, Self::T, Self::T, Self::T);
    /// gcd(x, e); e for x = 0.
    fn gcd_e(&self, x: &Self::T) -> Self::T;
    fn is_one(x: &Self::T) -> bool;
    /// Whether g > 0 divides x as integers.
    fn divides(g: &Self::T, x: &Self::T) -> bool;
}

struct Word(u64);

impl Zn for Word {
    type T = u64;
    fn residue(&self, x: &BigInt) -> u64 {
        x.mod_floor(&BigInt::from(self.0)).to_u64().expect("a residue below e")
    }
    fn integer(x: &u64) -> BigInt {
        BigInt::from(*x)
    }
    fn is_zero(x: &u64) -> bool {
        *x == 0
    }
    fn lin(&self, s: &u64, x: &u64, u: &u64, y: &u64) -> u64 {
        ((*s as u128 * *x as u128 + *u as u128 * *y as u128) % self.0 as u128) as u64
    }
    fn sub_mul(&self, x: &u64, q: &u64, y: &u64) -> u64 {
        let qy = (*q as u128 * *y as u128 % self.0 as u128) as u64;
        if *x >= qy {
            x - qy
        } else {
            x + (self.0 - qy)
        }
    }
    fn add(&self, x: &u64, y: &u64) -> u64 {
        // (both below 2^62: no overflow)
        (x + y) % self.0
    }
    fn neg(&self, x: &u64) -> u64 {
        if *x == 0 {
            0
        } else {
            self.0 - x
        }
    }
    fn quotient(x: &u64, y: &u64) -> Option<u64> {
        x.is_multiple_of(y).then(|| x / y)
    }
    fn bezout(&self, p: &u64, a: &u64) -> (u64, u64, u64, u64) {
        // the extended Euclidean algorithm on i128: |cofactors| <= max(p, a) < 2^62
        let (mut r0, mut r1) = (*p as i128, *a as i128);
        let (mut s0, mut s1, mut u0, mut u1) = (1i128, 0i128, 0i128, 1i128);
        while r1 != 0 {
            let q = r0 / r1;
            (r0, r1) = (r1, r0 - q * r1);
            (s0, s1) = (s1, s0 - q * s1);
            (u0, u1) = (u1, u0 - q * u1);
        }
        let e = self.0 as i128;
        let g = r0 as u64;
        (s0.rem_euclid(e) as u64, u0.rem_euclid(e) as u64, a / g, p / g)
    }
    fn gcd_e(&self, x: &u64) -> u64 {
        x.gcd(&self.0)
    }
    fn is_one(x: &u64) -> bool {
        *x == 1
    }
    fn divides(g: &u64, x: &u64) -> bool {
        x.is_multiple_of(g)
    }
}

struct Big(BigInt);

impl Zn for Big {
    type T = BigInt;
    fn residue(&self, x: &BigInt) -> BigInt {
        x.mod_floor(&self.0)
    }
    fn integer(x: &BigInt) -> BigInt {
        x.clone()
    }
    fn is_zero(x: &BigInt) -> bool {
        x.is_zero()
    }
    fn lin(&self, s: &BigInt, x: &BigInt, u: &BigInt, y: &BigInt) -> BigInt {
        (s * x + u * y).mod_floor(&self.0)
    }
    fn sub_mul(&self, x: &BigInt, q: &BigInt, y: &BigInt) -> BigInt {
        (x - q * y).mod_floor(&self.0)
    }
    fn add(&self, x: &BigInt, y: &BigInt) -> BigInt {
        (x + y).mod_floor(&self.0)
    }
    fn neg(&self, x: &BigInt) -> BigInt {
        (-x).mod_floor(&self.0)
    }
    fn quotient(x: &BigInt, y: &BigInt) -> Option<BigInt> {
        let (q, r) = x.div_rem(y);
        r.is_zero().then_some(q)
    }
    fn bezout(&self, p: &BigInt, a: &BigInt) -> (BigInt, BigInt, BigInt, BigInt) {
        let eg = p.extended_gcd(a);
        (eg.x.mod_floor(&self.0), eg.y.mod_floor(&self.0), a / &eg.gcd, p / &eg.gcd)
    }
    fn gcd_e(&self, x: &BigInt) -> BigInt {
        x.gcd(&self.0)
    }
    fn is_one(x: &BigInt) -> bool {
        x.is_one()
    }
    fn divides(g: &BigInt, x: &BigInt) -> bool {
        (x % g).is_zero()
    }
}

/// The elimination over Z/eZ on the rows x cols residues `a` (row by row):
/// min(rows, cols) entries gcd(t_i, e), each dividing the next.
///
/// For each t: a nonzero pivot of the remaining block (column t first) is
/// moved to (t, t); the column below it and the row right of it are
/// cleared, by an exact multiple when the pivot divides the entry, else by
/// a Bezout combination of determinant 1 whose new pivot is gcd(pivot,
/// entry), a proper divisor of it as an integer (so this ends).  Then the
/// pivot's gcd with e must divide the rest of the block; when it does not,
/// the offending row is added to the pivot row and the clearing repeats,
/// with a pivot whose gcd with e is a proper divisor.  An all-zero block
/// gives e for each remaining entry (gcd(0, e)).
fn smith_in<R: Zn>(r: &R, rows: usize, cols: usize, mut a: Vec<R::T>) -> Vec<R::T> {
    let k = rows.min(cols);
    let at = |i: usize, j: usize| i * cols + j;
    let mut out = Vec::with_capacity(k);
    for t in 0..k {
        let pivot = (t..cols).flat_map(|j| (t..rows).map(move |i| (i, j))).find(|&(i, j)| !R::is_zero(&a[at(i, j)]));
        let Some((pi, pj)) = pivot else {
            let e = r.gcd_e(&r.residue(&BigInt::zero()));
            out.extend((t..k).map(|_| e.clone()));
            break;
        };
        for j in 0..cols {
            a.swap(at(t, j), at(pi, j));
        }
        for i in 0..rows {
            a.swap(at(i, t), at(i, pj));
        }
        loop {
            sagebrush_interrupt::check();
            let mut bezout = false;
            for i in t + 1..rows {
                let x = a[at(i, t)].clone();
                if R::is_zero(&x) {
                    continue;
                }
                let p = a[at(t, t)].clone();
                if let Some(q) = R::quotient(&x, &p) {
                    for j in t..cols {
                        a[at(i, j)] = r.sub_mul(&a[at(i, j)], &q, &a[at(t, j)]);
                    }
                } else {
                    let (s, u, xg, pg) = r.bezout(&p, &x);
                    let nxg = r.neg(&xg);
                    for j in t..cols {
                        let (y, z) = (a[at(t, j)].clone(), a[at(i, j)].clone());
                        a[at(t, j)] = r.lin(&s, &y, &u, &z);
                        a[at(i, j)] = r.lin(&nxg, &y, &pg, &z);
                    }
                }
            }
            for j in t + 1..cols {
                let x = a[at(t, j)].clone();
                if R::is_zero(&x) {
                    continue;
                }
                let p = a[at(t, t)].clone();
                if let Some(q) = R::quotient(&x, &p) {
                    for i in t..rows {
                        a[at(i, j)] = r.sub_mul(&a[at(i, j)], &q, &a[at(i, t)]);
                    }
                } else {
                    // (refills the column below the pivot: another pass)
                    bezout = true;
                    let (s, u, xg, pg) = r.bezout(&p, &x);
                    let nxg = r.neg(&xg);
                    for i in t..rows {
                        let (y, z) = (a[at(i, t)].clone(), a[at(i, j)].clone());
                        a[at(i, t)] = r.lin(&s, &y, &u, &z);
                        a[at(i, j)] = r.lin(&nxg, &y, &pg, &z);
                    }
                }
            }
            if bezout {
                continue;
            }
            let g = r.gcd_e(&a[at(t, t)]);
            let bad = if R::is_one(&g) {
                None
            } else {
                (t + 1..rows).find(|&i| (t + 1..cols).any(|j| !R::divides(&g, &a[at(i, j)])))
            };
            match bad {
                Some(i) => {
                    for j in t..cols {
                        a[at(t, j)] = r.add(&a[at(t, j)], &a[at(i, j)]);
                    }
                }
                None => {
                    out.push(g);
                    break;
                }
            }
        }
    }
    out
}

/// The Smith form of `a` over Z/eZ (e >= 1): min(rows, cols) entries
/// gcd(t_i, e), each dividing the next, where t_i are a's invariant factors
/// over Z (an invariant 0 modulo e, t_i = 0 among them, gives e).  Word
/// arithmetic below 2^62, big integers above.
pub fn smith_mod(a: &ZMat, e: &BigInt) -> Vec<BigInt> {
    assert!(e.is_positive(), "the modulus must be positive");
    let k = a.rows.min(a.cols);
    if e.is_one() {
        return vec![BigInt::one(); k];
    }
    match e.to_u64().filter(|&w| w < WORD_E) {
        Some(w) => {
            let r = Word(w);
            let m = a.d.iter().map(|x| r.residue(x)).collect();
            smith_in(&r, a.rows, a.cols, m).iter().map(Word::integer).collect()
        }
        None => {
            let r = Big(e.clone());
            let m = a.d.iter().map(|x| r.residue(x)).collect();
            smith_in(&r, a.rows, a.cols, m)
        }
    }
}

/// e = d / delta from a solve a x = b's (N, den), x = N / den: delta the
/// least common denominator, reduced here; d itself (the classical route)
/// if delta does not divide d, which a correct solve never gives.
fn modulus_from(d: &BigInt, n: &ZMat, den: &BigInt) -> BigInt {
    let g = n.d.iter().fold(den.clone(), |g, v| g.gcd(v));
    let delta = den / g;
    if !delta.is_zero() && (d % &delta).is_zero() {
        d / delta
    } else {
        d.clone()
    }
}

/// The invariant factors t_1 | ... | t_n of a square nonsingular `a`, given
/// d = |det a| (> 0) and, when one was made, the solve of a x = det_rhs
/// (`zmat::det_with_solve` makes it on large matrices).  Module docs.
pub fn invariants_nonsingular(a: &ZMat, d: &BigInt, solved: Option<(ZMat, BigInt)>) -> Vec<BigInt> {
    assert_eq!(a.rows, a.cols, "invariants_nonsingular needs a square matrix");
    assert!(d.is_positive(), "d = |det a| must be positive");
    let n = a.rows;
    if n == 0 {
        return vec![];
    }
    if n == 1 {
        return vec![d.clone()];
    }
    // t_1 is the content g (the gcd of the entries): the invariants are g
    // times those of a / g, whose e is smaller by g^(n-1) at least (a
    // common factor would otherwise make every invariant, and e, large:
    // p I, or p U for a unimodular U)
    let g = a.d.iter().fold(BigInt::zero(), |g, v| g.gcd(v));
    if !g.is_one() {
        let ag = ZMat { rows: n, cols: n, d: a.d.iter().map(|v| v / &g).collect() };
        let dg = d / g.pow(n as u32);
        // a x = b gives (a / g)(g x) = b: the same denominator, numerators times g
        let sg = solved.map(|(x, den)| (x.scale(&g), den));
        return invariants_nonsingular(&ag, &dg, sg).into_iter().map(|t| t * &g).collect();
    }
    let e = if d.bits() <= 62 {
        d.clone()
    } else {
        match solved.or_else(|| zmat::solve(a, &zmat::det_rhs(n))) {
            Some((x, den)) => modulus_from(d, &x, &den),
            None => d.clone(),
        }
    };
    invariants_with(a, d, &e)
}

/// Steps 3 and 4 for a given e with t_1 ... t_(n-1) | e (module docs).
/// Factors that do not multiply into d could only come from a bug: a
/// debug build stops there, a release one takes the classical route e = d
/// instead (its n entries are gcd(t_i, d) = t_i), so a bug costs time, not
/// a wrong answer or a trap.
fn invariants_with(a: &ZMat, d: &BigInt, e: &BigInt) -> Vec<BigInt> {
    let n = a.rows;
    let mut t = if e.is_one() { vec![BigInt::one(); n - 1] } else { smith_mod(a, e)[..n - 1].to_vec() };
    #[cfg(test)]
    let forced = tests::CORRUPT_STEP4.with(|c| c.borrow_mut().take()).inspect(|bad| t[0] = bad.clone()).is_some();
    // (every factor positive first: a zero one must not reach the division)
    if t.iter().all(|x| x.is_positive()) {
        let prod: BigInt = t.iter().product();
        let (last, rem) = d.div_rem(&prod);
        if rem.is_zero() {
            t.push(last);
            return t;
        }
    }
    #[cfg(test)]
    let expected = forced;
    #[cfg(not(test))]
    let expected = false;
    debug_assert!(expected, "invariant factors that do not divide the determinant (e = {e})");
    smith_mod(a, d)
}

/// The invariant factors of a square diagonal matrix, by pairs: (x, y) ->
/// (gcd, lcm) for each i < j leaves each entry dividing the next (zeros
/// last).  None if `a` is not diagonal.
fn invariants_diagonal(a: &ZMat) -> Option<Vec<BigInt>> {
    let n = a.rows;
    if (0..n).any(|i| (0..n).any(|j| i != j && !a.d[i * n + j].is_zero())) {
        return None;
    }
    let mut v: Vec<BigInt> = (0..n).map(|i| a.d[i * n + i].abs()).collect();
    for i in 0..n {
        for j in i + 1..n {
            if v[i].is_zero() || (!v[j].is_zero() && !(&v[j] % &v[i]).is_zero()) {
                let g = v[i].gcd(&v[j]);
                let l = if g.is_zero() { BigInt::zero() } else { &v[i] / &g * &v[j] };
                v[i] = g;
                v[j] = l;
            }
        }
    }
    Some(v)
}

/// The invariant factors of a square matrix, or None when it is singular
/// (the caller compresses those first).
pub fn invariants_square(a: &ZMat) -> Option<Vec<BigInt>> {
    assert_eq!(a.rows, a.cols, "invariants_square needs a square matrix");
    if a.rows == 0 {
        return Some(vec![]);
    }
    if let Some(t) = invariants_diagonal(a) {
        return (!t.iter().any(|x| x.is_zero())).then_some(t);
    }
    let (det, solved) = zmat::det_with_solve(a);
    let d = det.abs();
    (!d.is_zero()).then(|| invariants_nonsingular(a, &d, solved))
}

#[cfg(test)]
mod tests;
