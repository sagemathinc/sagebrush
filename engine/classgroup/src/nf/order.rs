//! Orders of a number field K = Q[x]/(f), f monic integral irreducible:
//! a Z-basis w_i = (b_i . (1, t, ..., t^(n-1))) / den over the power basis
//! of t = x mod f, with the multiplication table w_i w_j = sum c_ijk w_k.
//! The maximal order by Round 2 (Pohst-Zassenhaus; Cohen, A Course in
//! Computational Algebraic Number Theory, 6.1).

use super::factor::{factor_typed, FactorError};
use super::mem::{big, bigs, lg, max_bits, poll, rat, scratch, vec, zmat, Held};
use super::zlin::*;
use crate::linalg::det;
use sagebrush_bigint::BigInt;
use num_integer::Integer;
use sagebrush_bigint::BigRational;
use num_traits::{One, Signed, Zero};

#[derive(Debug)]
pub struct Order {
    pub n: usize,
    /// the defining polynomial, monic, constant term first (n + 1 terms)
    pub f: Vec<BigInt>,
    /// rows: numerators of the basis over the power basis
    pub basis: ZMat,
    pub den: BigInt,
    /// inverse of basis / den (power coordinates -> order coordinates)
    pub to_order: QMat,
    /// mult[i][j] = coordinates of w_i w_j
    pub mult: Vec<Vec<Vec<BigInt>>>,
    /// the most bits of an entry of mult
    tbits: u64,
    /// this order's memory, reserved before it was allocated and released
    /// with it (super::mem); no cheap Clone copies it uncharged: try_clone
    mem: Held,
}

/// a b mod f (f monic), coefficient vectors of length n.
pub fn polmulmod(a: &[BigInt], b: &[BigInt], f: &[BigInt]) -> Vec<BigInt> {
    let n = f.len() - 1;
    let mut c = vec![BigInt::zero(); 2 * n];
    for (i, x) in a.iter().enumerate() {
        if x.is_zero() {
            continue;
        }
        for (j, y) in b.iter().enumerate() {
            c[i + j] += x * y;
        }
    }
    for k in (n..2 * n).rev() {
        if c[k].is_zero() {
            continue;
        }
        let t = std::mem::take(&mut c[k]);
        for i in 0..n {
            c[k - n + i] -= &t * &f[i];
        }
    }
    c.truncate(n);
    c
}

/// The bits a product's coefficients reach: polmulmod of coefficient vectors
/// of at most la and lb bits gives 2n - 1 coefficients of at most
/// la + lb + lg(n) bits, then n - 1 reductions by f each multiply their
/// largest by at most 1 + H <= 2^bits(H) (H the largest |f_i|).
fn product_bits(la: u64, lb: u64, n: usize, hb: u64) -> u64 {
    la + lb + lg(n) + 1 + (n.saturating_sub(1)) as u64 * hb
}

/// The most bits of a numerator and of a denominator in a matrix of rationals.
fn rat_bits(m: &QMat) -> (u64, u64) {
    m.iter().flatten().fold((0, 0), |(a, b), x| (a.max(x.numer().bits()), b.max(x.denom().bits())))
}

impl Order {
    /// Z[t].
    pub fn equation_order(f: &[BigInt]) -> Result<Order, FactorError> {
        let n = f.len() - 1;
        let s = scratch(n as u64 * vec(n as u64, big(1)) + vec(n as u64, 24))?;
        let id: ZMat = {
            let _s = s.scope();
            (0..n).map(|i| (0..n).map(|j| BigInt::from((i == j) as i32)).collect()).collect()
        };
        let o = Order::new(f, id, BigInt::one());
        drop(s);
        o
    }

    /// The order of basis (rows of numerators over the power basis) / den,
    /// with its multiplication table.  Its memory is reserved before it is
    /// allocated (super::mem): up front what is known exactly (the table's
    /// n + n^2 vector headers, f, the basis and den moved in); the inverse
    /// basis by its own rolling reservation, then charged as measured; and
    /// each row of products by a scratch reservation bounding one product's
    /// working storage from its operands' measured sizes, each product's
    /// coordinates charged as measured before they are stored.  Stop is
    /// checked at every product and polled at every row (A16-F1).
    pub fn new(f: &[BigInt], basis: ZMat, den: BigInt) -> Result<Order, FactorError> {
        let n = f.len() - 1;
        assert!(f[n].is_one(), "f must be monic");
        let _p = sagebrush_interrupt::enter("nf order");
        // (each coarse poll in a site of its own, so that tests/nf_order_stop.rs sees it)
        poll("nf order poll");
        let vb = std::mem::size_of::<Vec<BigInt>>() as u64;
        let fixed = vec(n as u64, vb) + n as u64 * vec(n as u64, vb) + bigs(f) + vec(n as u64, vb) + basis.iter().map(|r| bigs(r)).sum::<u64>() + big(den.bits());
        let mut mem = Held::new(fixed)?;
        let f_own = {
            let _s = mem.scope();
            f.to_vec()
        };
        // the inverse basis: (basis / den)^-1
        let bden = den.bits();
        let bq_bytes = vec(n as u64, 24) + basis.iter().map(|r| vec(n as u64, 0) + r.iter().map(|x| rat(x.bits(), bden)).sum::<u64>()).sum::<u64>();
        let s = scratch(bq_bytes)?;
        let bq: QMat = {
            let _s = s.scope();
            basis.iter().map(|r| r.iter().map(|x| BigRational::new(x.clone(), den.clone())).collect()).collect()
        };
        let to_order = inverse_charged(&bq, &mut mem)?;
        drop(bq);
        drop(s);
        let mut mult: Vec<Vec<Vec<BigInt>>> = {
            let _s = mem.scope();
            (0..n).map(|_| (0..n).map(|_| Vec::new()).collect()).collect()
        };
        let hb = max_bits(&f[..n]);
        let d2b = 2 * bden + 1;
        // (the denominators of a sum of v_i T_ik divide lcm(den^2, the
        // denominators of to_order), whose bits are bounded by measuring it)
        let (tn, _) = rat_bits(&to_order);
        let ls = scratch(2 * big(n as u64 * rat_bits(&to_order).1 + 1) + 2 * big(0))?;
        let lb = {
            let _s = ls.scope();
            to_order.iter().flatten().fold(BigInt::one(), |l, x| l.lcm(x.denom())).bits()
        };
        drop(ls);
        let db = d2b + lb;
        let mut tbits = 0;
        for i in 0..n {
            let _p = sagebrush_interrupt::enter("nf order table");
            poll("nf order table poll");
            let bi = max_bits(&basis[i]);
            // one product's working storage at a time: polmulmod's 2n
            // coefficients, the n rationals over den^2, vec_mat's n sums and
            // its unreduced intermediates, and the n coordinates
            let worst = (i..n).map(|j| {
                let pb = product_bits(bi, max_bits(&basis[j]), n, hb);
                let nb = lg(n) + 1 + pb + tn + db;
                vec(2 * n as u64, big(pb)) + 2 * vec(n as u64, rat(pb, d2b)) + vec(n as u64, rat(nb, db)) + 4 * rat(2 * nb, 2 * db) + vec(n as u64, big(nb))
            }).max().unwrap_or(0);
            let row = scratch(worst)?;
            for j in i..n {
                sagebrush_interrupt::check();
                let c: Vec<BigInt> = {
                    let _s = row.scope();
                    let p = polmulmod(&basis[i], &basis[j], f);
                    let d2 = &den * &den;
                    let v: Vec<BigRational> = p.into_iter().map(|x| BigRational::new(x, d2.clone())).collect();
                    let c = vec_mat(&v, &to_order);
                    let mut c: Vec<BigInt> = c.into_iter().map(|x| {
                        assert!(x.is_integer(), "not a ring");
                        x.to_integer()
                    }).collect();
                    // (collected in place, it would keep the rationals'
                    // larger buffer: exact, so that what is charged is it)
                    c.shrink_to_fit();
                    c
                };
                tbits = tbits.max(max_bits(&c));
                mem.take(if i == j { bigs(&c) } else { 2 * bigs(&c) })?;
                let _s = mem.scope();
                if i != j {
                    mult[j][i] = c.clone();
                }
                mult[i][j] = c;
            }
        }
        Ok(Order { n, f: f_own, basis, den, to_order, mult, tbits, mem })
    }

    /// A copy, with its own reservation of the same bytes.
    pub fn try_clone(&self) -> Result<Order, FactorError> {
        let mem = Held::new(self.mem.charged())?;
        let _s = mem.scope();
        let (f, basis, den, to_order, mult) = (self.f.clone(), self.basis.clone(), self.den.clone(), self.to_order.clone(), self.mult.clone());
        drop(_s);
        Ok(Order { n: self.n, f, basis, den, to_order, mult, tbits: self.tbits, mem })
    }

    /// The bytes this order has reserved (its tests' measure).
    pub fn charged(&self) -> u64 {
        self.mem.charged()
    }

    /// Order coordinates of an element given in the power basis.
    pub fn from_power(&self, v: &[BigRational]) -> Vec<BigRational> {
        vec_mat(v, &self.to_order)
    }

    /// Power-basis coordinates of an element given in order coordinates.
    pub fn to_power(&self, x: &[BigInt]) -> Vec<BigRational> {
        let num = vec_mat(x, &self.basis);
        num.into_iter().map(|c| BigRational::new(c, self.den.clone())).collect()
    }

    pub fn one(&self) -> Vec<BigInt> {
        let v: Vec<BigRational> = (0..self.n).map(|i| BigRational::from_integer(BigInt::from((i == 0) as i32))).collect();
        self.from_power(&v).into_iter().map(|x| x.to_integer()).collect()
    }

    pub fn mul(&self, x: &[BigInt], y: &[BigInt]) -> Vec<BigInt> {
        let n = self.n;
        let mut out = vec![BigInt::zero(); n];
        for i in 0..n {
            if x[i].is_zero() {
                continue;
            }
            for j in 0..n {
                if y[j].is_zero() {
                    continue;
                }
                let xy = &x[i] * &y[j];
                for (o, c) in out.iter_mut().zip(&self.mult[i][j]) {
                    if !c.is_zero() {
                        *o += &xy * c;
                    }
                }
            }
        }
        out
    }

    /// A bound on the bytes of one mul of entries of at most xb and yb bits:
    /// the n sums (each at most xb + yb + tbits + 2 lg n bits) and a product
    /// in flight.
    fn mul_bytes(&self, xb: u64, yb: u64) -> u64 {
        let e = xb + yb + self.tbits + 2 * lg(self.n) + 2;
        vec(self.n as u64, big(e)) + 3 * big(e)
    }

    pub fn mul_mod(&self, x: &[BigInt], y: &[BigInt], m: &BigInt) -> Vec<BigInt> {
        self.mul(x, y).into_iter().map(|c| c.mod_floor(m)).collect()
    }

    /// The matrix of multiplication by x (rows: x w_i).
    pub fn mul_matrix(&self, x: &[BigInt]) -> ZMat {
        (0..self.n).map(|i| {
            let e: Vec<BigInt> = (0..self.n).map(|j| BigInt::from((i == j) as i32)).collect();
            self.mul(x, &e)
        }).collect()
    }

    pub fn trace(&self, x: &[BigInt]) -> BigInt {
        (0..self.n).map(|i| &x[i] * (0..self.n).map(|k| &self.mult[i][k][k]).sum::<BigInt>()).sum()
    }

    pub fn norm(&self, x: &[BigInt]) -> BigInt {
        det(&self.mul_matrix(x))
    }

    /// The discriminant det(Tr(w_i w_j)), its memory reserved first: the
    /// traces and the trace form by their entries' bounds (tbits), the
    /// determinant by its rolling reservation (det_charged).
    pub fn disc(&self) -> Result<BigInt, FactorError> {
        let n = self.n;
        let trb = self.tbits + lg(n) + 1;
        let mb = self.tbits + trb + lg(n) + 1;
        let s = scratch(vec(n as u64, big(trb)) + vec(n as u64, 24) + n as u64 * vec(n as u64, big(mb)) + 4 * big(2 * mb))?;
        let m: ZMat = {
            let _s = s.scope();
            let tr: Vec<BigInt> = (0..n).map(|i| (0..n).map(|k| self.mult[i][k][k].clone()).sum()).collect();
            (0..n).map(|i| (0..n).map(|j| self.mult[i][j].iter().zip(&tr).map(|(c, t)| c * t).sum()).collect()).collect()
        };
        let d = det_charged(&m);
        drop(m);
        drop(s);
        d
    }

    /// The order with basis rows `rows` (order coordinates, a full-rank
    /// lattice containing a multiple of this order) divided by `div`.  The
    /// numerators' Hermite form is the modular one, mod |det|: the lattice
    /// contains |det| Z^n, so it is the same matrix with every entry bounded
    /// before it starts.
    fn sub_order(&self, rows: &ZMat, div: &BigInt) -> Result<Order, FactorError> {
        let n = self.n;
        let pb = max_bits(rows.iter().flatten()) + max_bits(self.basis.iter().flatten()) + lg(n) + 1;
        let s = scratch(vec(n as u64, 24) + n as u64 * vec(n as u64, big(pb)) + 4 * big(2 * pb) + 2 * big(n as u64 * pb + 1))?;
        let pow: ZMat = {
            let _s = s.scope();
            rows.iter().map(|r| vec_mat(r, &self.basis)).collect()
        };
        let d = det_charged(&pow)?.abs();
        let h = scratch(hnf_mod_bytes(n, n, &d, pb) + vec(n as u64, 24) + n as u64 * vec(n as u64, big(d.bits() + 1)) + 4 * big(d.bits() + self.den.bits() + div.bits() + 1))?;
        let (hnf, den) = {
            let _s = h.scope();
            let hnf = hnf_mod(&pow, &d);
            let mut den = &self.den * div;
            let g = hnf.iter().flatten().fold(den.clone(), |g, x| g.gcd(x));
            let hnf: ZMat = hnf.iter().map(|r| r.iter().map(|x| x / &g).collect()).collect();
            den /= &g;
            (hnf, den)
        };
        drop(pow);
        // (the new basis kept by its measured size, the rest released; the
        // order charges it again for itself)
        let ps = scratch(zmat(&hnf) + big(den.bits()))?;
        drop(h);
        drop(s);
        let o = Order::new(&self.f, hnf, den);
        drop(ps);
        o
    }

    /// A bound on the bytes of radical(p): the Frobenius matrix and each
    /// pow_mod's working vectors (entries below p, products below p^2 times
    /// the table's entries), the kernel's row reduction mod p, and the
    /// generators' modular Hermite form.
    pub(crate) fn radical_bytes(&self, p: &BigInt) -> u64 {
        let n = self.n as u64;
        let bp = p.bits();
        vec(n, 24) + n * vec(n, big(bp)) + 6 * vec(n, big(bp)) + 2 * self.mul_bytes(bp, bp) + kernel_mod_bytes(self.n, self.n, p) + vec(2 * n, 24) + 2 * n * vec(n, big(bp)) + hnf_mod_bytes(2 * self.n, self.n, p, bp)
    }

    /// The p-radical {x : x^q in pO for some q} as an HNF basis (it contains
    /// pO): the kernel of x -> x^q on O/pO, q = p^j >= n.  Its memory is the
    /// caller's to reserve (radical_bytes).
    pub fn radical(&self, p: &BigInt) -> ZMat {
        let n = self.n;
        let mut q = p.clone();
        while q < BigInt::from(n) {
            q *= p;
        }
        let frob: ZMat = (0..n).map(|i| {
            poll("nf radical poll");
            let e: Vec<BigInt> = (0..n).map(|j| BigInt::from((i == j) as i32)).collect();
            self.pow_mod(&e, &q, p)
        }).collect();
        let ker = left_kernel_mod(&frob, p);
        let mut gens = ker;
        for i in 0..n {
            gens.push((0..n).map(|j| if i == j { p.clone() } else { BigInt::zero() }).collect());
        }
        hnf_mod(&gens, p)
    }

    /// One Round 2 step at p: the ring of multipliers of the p-radical, if
    /// it is bigger than this order (None: the order is p-maximal).  Its
    /// working storage is reserved first, from bounds: the radical's
    /// (radical_bytes); the radical's inverse by its own rolling reservation,
    /// kept charged while it is used; the matrix of the map, n x n^2 entries
    /// below p, and one row's products and coordinates at a time; the
    /// kernel's row reduction and the modular Hermite form.  Stop is polled
    /// at every row.
    pub fn enlarge_at(&self, p: &BigInt) -> Result<Option<Order>, FactorError> {
        let n = self.n;
        let bp = p.bits();
        let _p = sagebrush_interrupt::enter("nf round 2");
        poll("nf round 2 poll");
        let s = scratch(self.radical_bytes(p))?;
        let ip = {
            let _s = s.scope();
            self.radical(p)
        };
        // (the radical kept by its measured size, the rest of its work released)
        let ips = scratch(zmat(&ip))?;
        drop(s);
        // (ip's entries are at most p, its pivots p or 1)
        let mut keep = Held::new(vec(n as u64, 24) + n as u64 * vec(n as u64, big(bp)))?;
        let ipq_bytes = vec(n as u64, 24) + n as u64 * vec(n as u64, rat(bp, 1));
        let qs = scratch(ipq_bytes)?;
        let ipq = {
            let _s = qs.scope();
            to_q(&ip)
        };
        let ip_inv = inverse_charged(&ipq, &mut keep)?;
        drop(ipq);
        drop(qs);
        let (inb, idb) = rat_bits(&ip_inv);
        // (ip_inv's denominators divide det(ip), at most n bits(p) bits)
        let ld = n as u64 * bp + 1;
        let yb = bp + self.tbits + lg(n) + 1;
        let zn = lg(n) + 1 + yb + inb + ld;
        let row_bytes = vec(n as u64, 24) + 2 * self.mul_bytes(1, bp) + 2 * vec(n as u64, rat(yb, 1)) + vec(n as u64, rat(zn, ld)) + 4 * rat(2 * zn, 2 * ld + idb) + vec((n * n) as u64, big(bp));
        let a_bytes = vec(n as u64, 24) + n as u64 * vec((n * n) as u64, big(bp));
        let w = scratch(a_bytes + row_bytes + kernel_mod_bytes(n, n * n, p) + vec(2 * n as u64, 24) + 2 * n as u64 * vec(n as u64, big(bp)) + hnf_mod_bytes(2 * n, n, p, bp))?;
        // {x in O : x I subset p I}: kernel of x -> (x b_k in I-coordinates) mod p
        let mut a: ZMat = {
            let _s = w.scope();
            Vec::with_capacity(n)
        };
        for i in 0..n {
            let _p = sagebrush_interrupt::enter("nf round 2 map");
            poll("nf round 2 map poll");
            let _s = w.scope();
            let e: Vec<BigInt> = (0..n).map(|j| BigInt::from((i == j) as i32)).collect();
            let mut row = Vec::with_capacity(n * n);
            for b in &ip {
                sagebrush_interrupt::check();
                let y = self.mul(&e, b);
                let yq: Vec<BigRational> = y.into_iter().map(BigRational::from_integer).collect();
                let z = vec_mat(&yq, &ip_inv);
                row.extend(z.into_iter().map(|c| c.to_integer().mod_floor(p)));
            }
            a.push(row);
        }
        let k = {
            let _s = w.scope();
            let ker = left_kernel_mod(&a, p);
            if ker.is_empty() {
                None
            } else {
                let mut gens = ker;
                for i in 0..n {
                    gens.push((0..n).map(|j| if i == j { p.clone() } else { BigInt::zero() }).collect());
                }
                Some(hnf_mod(&gens, p))
            }
        };
        drop(a);
        drop(ip_inv);
        drop(ip);
        // (the kernel's basis kept by its measured size; the step's other
        // reservations released before the new order is built)
        let ks = match &k {
            Some(k) => Some(scratch(zmat(k))?),
            None => None,
        };
        drop(keep);
        drop(w);
        drop(ips);
        let out = match k {
            None => None,
            Some(k) => {
                let o = self.sub_order(&k, p);
                drop(k);
                Some(o?)
            }
        };
        drop(ks);
        Ok(out)
    }

    /// x^e mod p (order coordinates).
    pub fn pow_mod(&self, x: &[BigInt], e: &BigInt, p: &BigInt) -> Vec<BigInt> {
        let mut r = self.one();
        let mut b: Vec<BigInt> = x.iter().map(|c| c.mod_floor(p)).collect();
        let bits = e.bits();
        for k in 0..bits {
            poll("nf pow poll");
            if e.bit(k) {
                r = self.mul_mod(&r, &b, p);
            }
            if k + 1 < bits {
                b = self.mul_mod(&b, &b, p);
            }
        }
        r
    }
}

/// A bound on the bytes of left_kernel_mod of an r x c matrix mod p: its
/// augmented rows (c + r entries below p, a difference below p^2 in flight)
/// and the pivot row's copy, and the kernel.
pub fn kernel_mod_bytes(r: usize, c: usize, p: &BigInt) -> u64 {
    let e = big(2 * p.bits() + 2);
    vec(r as u64, 24) + (r as u64 + 1) * vec((c + r) as u64, e) + vec(r as u64, 24) + r as u64 * vec(r as u64, e) + 4 * e + big(p.bits() + 2)
}

/// The discriminant of Z[t] = det(Tr(t^(i+j))): the Hankel matrix of the
/// power sums s_k = Tr(t^k), from f by Newton's identities, which is the
/// trace form Order::equation_order(f).disc() computes from the table, so the
/// same matrix and the same determinant, without building the table.  The
/// roots of f are at most 1 + H <= 2^bits(H) (Cauchy), so |s_k| <= n 2^(k
/// bits(H)), and every partial sum of Newton's identities too.
pub fn equation_disc(f: &[BigInt]) -> Result<BigInt, FactorError> {
    let n = f.len() - 1;
    assert!(f[n].is_one(), "f must be monic");
    if n == 0 {
        return Ok(BigInt::one());
    }
    let hb = max_bits(&f[..n]).max(1);
    let sb = lg(n) + 2 + (2 * n as u64) * hb;
    let s = scratch(vec(2 * n as u64, big(sb)) + 6 * big(2 * sb) + vec(n as u64, 24) + n as u64 * vec(n as u64, big(sb)))?;
    let m: ZMat = {
        let _s = s.scope();
        // f = t^n + a_{n-1} t^(n-1) + ... + a_0, a_i = f[i]
        let coeff = |i: usize| -> BigInt { if i < n { f[i].clone() } else { BigInt::zero() } };
        let mut ps: Vec<BigInt> = Vec::with_capacity(2 * n - 1);
        ps.push(BigInt::from(n as u64));
        for k in 1..2 * n - 1 {
            if k % 64 == 0 {
                sagebrush_interrupt::check();
            }
            let mut v = if k <= n { -(BigInt::from(k as u64) * coeff(n - k)) } else { BigInt::zero() };
            for i in 1..=k.min(n) {
                if i == k {
                    break;
                }
                v -= coeff(n - i) * &ps[k - i];
            }
            ps.push(v);
        }
        (0..n).map(|i| (0..n).map(|j| ps[i + j].clone()).collect()).collect()
    };
    let d = det_charged(&m);
    drop(m);
    drop(s);
    d
}

/// The maximal order of Q[x]/(f), f monic irreducible, by Round 2; also
/// returns the factorization of the field discriminant.  An error if the
/// discriminant cannot be factored completely (Round 2 needs every prime
/// whose square divides it).
pub fn maximal_order(f: &[BigInt]) -> Result<(Order, Vec<(BigInt, u32)>), FactorError> {
    maximal_order_assuming(f).map(|(o, fac, _)| (o, fac))
}

/// maximal_order, and the factors of the discriminant it relied on that are
/// only probable primes (Baillie-PSW, above 2^64): maximality assumes they
/// are prime (the systematic review's NFD-F4).  That includes factors to
/// the first power: a composite one could hide a square, at whose prime
/// the order was never enlarged (R2-NFD-F1).
/// A memory refusal while factoring the discriminants is kept typed.
pub fn maximal_order_assuming(f: &[BigInt]) -> Result<(Order, Vec<(BigInt, u32)>, Vec<BigInt>), FactorError> {
    let mut o = Order::equation_order(f)?;
    let d = equation_disc(f)?;
    let mut assumed = vec![];
    for (p, e) in factor_typed(&d)? {
        if p.bits() > 64 {
            assumed.push(p.clone());
        }
        if e < 2 {
            continue;
        }
        while let Some(o2) = o.enlarge_at(&p)? {
            sagebrush_interrupt::check();
            o = o2;
        }
    }
    let dk = o.disc()?;
    let fac = factor_typed(&dk)?;
    Ok((o, fac, assumed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poly(c: &[i64]) -> Vec<BigInt> {
        c.iter().map(|&x| BigInt::from(x)).collect()
    }

    #[test]
    fn maximal_orders() {
        // (f, field discriminant), from PARI's nfdisc (oracle)
        let cases: &[(&[i64], i64)] = &[
            (&[3, 0, 1], -3),               // x^2 + 3
            (&[8, -2, 1, 1], -503),         // Dedekind: x^3 + x^2 - 2x + 8
            (&[-1, -1, 0, 1], -23),         // x^3 - x - 1
            (&[1, 0, 0, 0, 1], 256),        // x^4 + 1
            (&[-2, 0, 0, 0, 0, 1], 50000),  // x^5 - 2
            (&[1, 0, 0, 1, 0, 0, 1], -19683), // x^6 + x^3 + 1
            (&[-5, 0, 0, 0, 1], -2000),     // x^4 - 5
        ];
        for &(f, dk) in cases {
            let (o, _) = maximal_order(&poly(f)).unwrap();
            assert_eq!(o.disc().unwrap(), BigInt::from(dk), "{:?}", f);
        }
    }
}
