//! Recursive dense polynomials over GF(p) (any prime p): a polynomial in
//! the variables k..n-1 is a vector of coefficients in variable k (constant
//! first), each a polynomial in k+1..n-1, down to field elements.  The
//! setting of the primitive-PRS gcd, which needs no evaluation points (so
//! it works over the smallest fields, where Brown's algorithm runs out of
//! them), and of the exact divisions of multivariate factorization over
//! GF(p).

use crate::order::Packing;
use sagebrush_bigint::nmod::Modulus;

/// A polynomial at some level: C at level 0 (no variables left), P above.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum D {
    C(u64),
    P(Vec<D>),
}

pub struct Ring<'a> {
    pub md: &'a Modulus,
}

fn zero(level: usize) -> D {
    if level == 0 {
        D::C(0)
    } else {
        D::P(vec![])
    }
}

fn one(level: usize) -> D {
    if level == 0 {
        D::C(1)
    } else {
        D::P(vec![one(level - 1)])
    }
}

pub fn is_zero(a: &D) -> bool {
    match a {
        D::C(c) => *c == 0,
        D::P(v) => v.is_empty(),
    }
}

fn coeffs(a: &D) -> &[D] {
    match a {
        D::P(v) => v,
        D::C(_) => unreachable!("a constant at a positive level"),
    }
}

fn trim(mut v: Vec<D>) -> D {
    while v.last().is_some_and(is_zero) {
        v.pop();
    }
    D::P(v)
}

/// The degree in the outer variable (-1 for 0).
pub fn deg(a: &D) -> isize {
    coeffs(a).len() as isize - 1
}

impl Ring<'_> {
    pub fn add(&self, a: &D, b: &D) -> D {
        let mut r = a.clone();
        self.add_scaled(&mut r, b, 1);
        r
    }

    fn zero_like(&self, a: &D) -> D {
        match a {
            D::C(_) => D::C(0),
            D::P(_) => D::P(vec![]),
        }
    }

    pub fn neg(&self, a: &D) -> D {
        match a {
            D::C(x) => D::C(self.md.neg(*x)),
            D::P(v) => D::P(v.iter().map(|t| self.neg(t)).collect()),
        }
    }

    pub fn sub(&self, a: &D, b: &D) -> D {
        let mut r = a.clone();
        self.add_scaled(&mut r, b, self.md.neg(1));
        r
    }

    pub fn scale(&self, a: &D, c: u64) -> D {
        match a {
            D::C(x) => D::C(self.md.mul(*x, c)),
            D::P(v) => trim(v.iter().map(|t| self.scale(t, c)).collect()),
        }
    }

    pub fn mul(&self, a: &D, b: &D) -> D {
        match (a, b) {
            (D::C(x), D::C(y)) => D::C(self.md.mul(*x, *y)),
            (D::P(x), D::P(y)) => {
                if x.is_empty() || y.is_empty() {
                    return D::P(vec![]);
                }
                let z = self.zero_like(x.last().unwrap());
                let mut out = vec![z; x.len() + y.len() - 1];
                for (i, p) in x.iter().enumerate() {
                    if is_zero(p) {
                        continue;
                    }
                    for (j, q) in y.iter().enumerate() {
                        if is_zero(q) {
                            continue;
                        }
                        self.addmul(&mut out[i + j], p, q);
                    }
                }
                trim(out)
            }
            _ => unreachable!("levels differ"),
        }
    }

    /// acc += p * q, in place.
    fn addmul(&self, acc: &mut D, p: &D, q: &D) {
        match (acc, p, q) {
            (D::C(a), D::C(x), D::C(y)) => *a = self.md.add(*a, self.md.mul(*x, *y)),
            (D::P(a), D::P(x), D::P(y)) => {
                if x.is_empty() || y.is_empty() {
                    return;
                }
                let need = x.len() + y.len() - 1;
                if a.len() < need {
                    let z = self.zero_like(x.last().unwrap());
                    a.resize(need, z);
                }
                for (i, u) in x.iter().enumerate() {
                    if is_zero(u) {
                        continue;
                    }
                    for (j, w) in y.iter().enumerate() {
                        if is_zero(w) {
                            continue;
                        }
                        self.addmul(&mut a[i + j], u, w);
                    }
                }
                while a.last().is_some_and(is_zero) {
                    a.pop();
                }
            }
            _ => unreachable!("levels differ"),
        }
    }

    /// acc += c * b (c a field element), in place.
    fn add_scaled(&self, acc: &mut D, b: &D, c: u64) {
        match (acc, b) {
            (D::C(a), D::C(x)) => *a = self.md.add(*a, self.md.mul(*x, c)),
            (D::P(a), D::P(y)) => {
                if a.len() < y.len() {
                    if let Some(l) = y.last() {
                        let z = self.zero_like(l);
                        a.resize(y.len(), z);
                    }
                }
                for (i, w) in y.iter().enumerate() {
                    if !is_zero(w) {
                        self.add_scaled(&mut a[i], w, c);
                    }
                }
                while a.last().is_some_and(is_zero) {
                    a.pop();
                }
            }
            _ => unreachable!("levels differ"),
        }
    }

    /// a * x^k (x the outer variable).
    fn shift(&self, a: &D, k: usize) -> D {
        let v = coeffs(a);
        if v.is_empty() {
            return a.clone();
        }
        let z = self.zero_like(&v[0]);
        let mut out = vec![z; k];
        out.extend(v.iter().cloned());
        D::P(out)
    }

    /// a / b when b divides a exactly, else None.
    pub fn divexact(&self, a: &D, b: &D) -> Option<D> {
        match (a, b) {
            (D::C(x), D::C(y)) => {
                if *y == 0 {
                    return None;
                }
                Some(D::C(self.md.mul(*x, self.md.inv(*y)?)))
            }
            (D::P(_), D::P(y)) => {
                if y.is_empty() {
                    return None;
                }
                let db = y.len() - 1;
                let lb = &y[db];
                let mut r = a.clone();
                let z = self.zero_like(lb);
                let mut q: Vec<D> = vec![];
                while !is_zero(&r) {
                    let rv = coeffs(&r);
                    if rv.len() < y.len() {
                        return None;
                    }
                    let k = rv.len() - 1 - db;
                    let c = self.divexact(&rv[rv.len() - 1], lb)?;
                    if q.len() <= k {
                        q.resize(k + 1, z.clone());
                    }
                    q[k] = c.clone();
                    let t = self.shift(&self.mul(&D::P(vec![c]), b), k);
                    r = self.sub(&r, &t);
                }
                Some(trim(q))
            }
            _ => unreachable!("levels differ"),
        }
    }

    /// The pseudo-remainder of a by b (outer variable): lc(b)^(da-db+1) a
    /// mod b exactly (the subresultant sequence depends on the power).
    fn prem(&self, a: &D, b: &D) -> D {
        let y = coeffs(b);
        let db = y.len() - 1;
        let lb = D::P(vec![y[db].clone()]);
        let mut r = a.clone();
        let mut steps = 0isize;
        let want = deg(a) - db as isize + 1;
        while !is_zero(&r) && deg(&r) >= db as isize {
            let rv = coeffs(&r);
            let k = rv.len() - 1 - db;
            let lr = D::P(vec![rv[rv.len() - 1].clone()]);
            // r = lb * r - lr * x^k * b
            r = self.sub(&self.mul(&lb, &r), &self.shift(&self.mul(&lr, b), k));
            steps += 1;
        }
        for _ in steps..want.max(0) {
            r = self.mul(&lb, &r);
        }
        r
    }

    fn pow(&self, a: &D, e: usize) -> D {
        let mut r = one_like(a);
        for _ in 0..e {
            r = self.mul(&r, a);
        }
        r
    }

    /// The gcd of the coefficients (outer variable), at the level below.
    pub fn content(&self, a: &D) -> D {
        let v = coeffs(a);
        let mut g: Option<D> = None;
        for c in v {
            if is_zero(c) {
                continue;
            }
            g = Some(match g {
                None => self.normal(c),
                Some(h) => self.gcd(&h, c),
            });
            if g.as_ref().is_some_and(|h| self.is_unit(h)) {
                break;
            }
        }
        g.unwrap_or_else(|| match v.first() {
            Some(t) => self.zero_like(t),
            None => D::C(0),
        })
    }

    fn is_unit(&self, a: &D) -> bool {
        match a {
            D::C(c) => *c != 0,
            D::P(v) => v.len() == 1 && self.is_unit(&v[0]),
        }
    }

    /// The leading field coefficient (innermost).
    pub fn lead_const(&self, a: &D) -> u64 {
        match a {
            D::C(c) => *c,
            D::P(v) => v.last().map_or(0, |t| self.lead_const(t)),
        }
    }

    /// a with leading field coefficient 1.
    pub fn normal(&self, a: &D) -> D {
        let l = self.lead_const(a);
        if l == 0 || l == 1 {
            return a.clone();
        }
        self.scale(a, self.md.inv(l).unwrap())
    }

    /// The primitive part (outer variable), normalized.
    fn pp(&self, a: &D) -> D {
        let c = self.content(a);
        let lifted = D::P(vec![c]);
        self.normal(&self.divexact(a, &lifted).expect("content divides"))
    }

    /// gcd(a, b), normalized (leading field coefficient 1).
    pub fn gcd(&self, a: &D, b: &D) -> D {
        if is_zero(a) {
            return self.normal(b);
        }
        if is_zero(b) {
            return self.normal(a);
        }
        match (a, b) {
            (D::C(_), D::C(_)) => D::C(1),
            (D::P(_), D::P(_)) => {
                sagebrush_interrupt::check();
                let (ca, cb) = (self.content(a), self.content(b));
                let c = self.gcd(&ca, &cb);
                let (mut x, mut y) = (self.pp(a), self.pp(b));
                if deg(&x) < deg(&y) {
                    std::mem::swap(&mut x, &mut y);
                }
                // the subresultant sequence: the remainders divided by
                // known factors, so their coefficients stay small
                let lvl1 = one_like(coeffs(&x).last().unwrap());
                let (mut g, mut h) = (lvl1.clone(), lvl1);
                let gcd = loop {
                    if deg(&y) == 0 {
                        break one_like(&x);
                    }
                    let delta = (deg(&x) - deg(&y)) as usize;
                    let r = self.prem(&x, &y);
                    if is_zero(&r) {
                        break self.pp(&y);
                    }
                    let den = self.mul(&g, &self.pow(&h, delta));
                    let r = self.divexact(&r, &D::P(vec![den])).expect("subresultant division");
                    x = y;
                    y = r;
                    g = coeffs(&x).last().unwrap().clone();
                    h = if delta == 0 {
                        h
                    } else {
                        self.divexact(&self.pow(&g, delta), &self.pow(&h, delta - 1)).expect("subresultant h")
                    };
                };
                self.normal(&self.mul(&gcd, &D::P(vec![c])))
            }
            _ => unreachable!("levels differ"),
        }
    }
}

fn one_like(a: &D) -> D {
    fn level(a: &D) -> usize {
        match a {
            D::C(_) => 0,
            // the last coefficient is nonzero (trimmed): a zero one would
            // not tell its level
            D::P(v) => 1 + v.last().map_or(0, level),
        }
    }
    one(level(a))
}

// ------------------------------------------------- conversions with words

/// The polynomial (words in pk, coefficients mod p) as a dense recursive
/// polynomial in all n variables.
pub fn from_words(pk: &Packing, f: &[(u64, u64)]) -> D {
    fn build(pk: &Packing, terms: &[(Vec<u64>, u64)], k: usize) -> D {
        if k == pk.n {
            return D::C(terms.iter().map(|t| t.1).fold(0, |a, b| a.wrapping_add(b)));
        }
        let d = terms.iter().map(|t| t.0[k]).max();
        let Some(d) = d else { return zero(pk.n - k) };
        let mut out = vec![];
        for e in 0..=d {
            let sub: Vec<(Vec<u64>, u64)> = terms.iter().filter(|t| t.0[k] == e).cloned().collect();
            out.push(if sub.is_empty() { zero(pk.n - k - 1) } else { build(pk, &sub, k + 1) });
        }
        trim(out)
    }
    let terms: Vec<(Vec<u64>, u64)> = f.iter().filter(|x| x.1 != 0).map(|&(w, c)| (pk.unpack(w), c)).collect();
    if pk.n == 0 {
        return D::C(terms.first().map_or(0, |t| t.1));
    }
    build(pk, &terms, 0)
}

/// Back to (word, coefficient) pairs, decreasing words.
pub fn to_words(pk: &Packing, a: &D) -> Vec<(u64, u64)> {
    fn walk(pk: &Packing, a: &D, k: usize, e: &mut Vec<u64>, out: &mut Vec<(u64, u64)>) {
        match a {
            D::C(c) => {
                if *c != 0 {
                    out.push((pk.pack(e), *c));
                }
            }
            D::P(v) => {
                for (i, t) in v.iter().enumerate() {
                    e[k] = i as u64;
                    walk(pk, t, k + 1, e, out);
                }
                e[k] = 0;
            }
        }
    }
    let mut out = vec![];
    let mut e = vec![0u64; pk.n];
    walk(pk, a, 0, &mut e, &mut out);
    out.sort_unstable_by(|x, y| y.0.cmp(&x.0));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gcd_small_field() {
        // over GF(2): gcd((x + y + 1)^2 (x y + 1), (x + y + 1) (x + y^2)) = x + y + 1
        let md = Modulus::new(2);
        let r = Ring { md: &md };
        let pk = Packing { n: 2, bits: 8 };
        let w = |a: u64, b: u64| pk.pack(&[a, b]);
        let l = from_words(&pk, &[(w(1, 0), 1), (w(0, 1), 1), (w(0, 0), 1)]);
        let u = from_words(&pk, &[(w(1, 1), 1), (w(0, 0), 1)]);
        let v = from_words(&pk, &[(w(1, 0), 1), (w(0, 2), 1)]);
        let a = r.mul(&r.mul(&l, &l), &u);
        let b = r.mul(&l, &v);
        let g = r.gcd(&a, &b);
        assert_eq!(g, l);
        assert_eq!(r.divexact(&a, &g).unwrap(), r.mul(&l, &u));
        assert_eq!(to_words(&pk, &from_words(&pk, &[(w(1, 0), 1), (w(0, 1), 1)])), vec![(w(1, 0), 1), (w(0, 1), 1)]);
    }
}
