//! Factoring modulo a word prime p < 2^32: the square-free decomposition,
//! the distinct-degree factorization and Cantor-Zassenhaus' equal-degree
//! splitting (von zur Gathen and Gerhard, Modern Computer Algebra,
//! sections 14.2, 14.3 and 14.6), on arith's polynomials over Z/p: NTT
//! products, Newton division, the half-gcd, and powers modulo a fixed
//! polynomial with its inverse precomputed.
//!
//! Every product uses this computation's own transform tables
//! (ntt::LocalTables), never the shared cache.  The work of each operation
//! is debited before it runs (arith's closed forms, nmod_poly::*_work),
//! and the tables and every buffer the arithmetic allocates are reserved
//! before the tables are built ([`fp_bytes`]).
//!
//! The results are those of the schoolbook arithmetic this replaced, bit
//! for bit: the factorization is unique, and the random candidates of the
//! equal-degree splitting are drawn in the same number and order, since
//! each split depends only on exact values.
//!
//! # Liveness: every vector of the phase, and what accounts for it
//!
//! Let n + 1 be the coefficients of the input f mod p and len = n + 1 the
//! length of the [`Fp`]: no operand is longer ([`Fp::fits`]), except the
//! input of [`Fp::reduce`], a product shorter than 2 len
//! (`Fp::fits_product`).  Memory is counted as the bytes requested from
//! the allocator, the unit of every reservation (and of the tests'
//! allocator spy); what an allocator rounds up beyond a request is
//! outside the model, for every allocation alike.  Two
//! reservations cover the phase, both taken before anything is allocated:
//!
//! 1. `modular_bytes(n)` (lib.rs), the caller's working polynomials: the
//!    pieces (a partition of f: at most n + 1 coefficients plus one word
//!    per piece), the factors found (the same), and at most 16 working
//!    slots.  Each slot is charged 2 (n + 1) words (words_bytes charges
//!    16 bytes per word).  A working polynomial is the result of one
//!    operation below, which `tight` returns in an allocation requested
//!    for exactly its length (a copy when the arithmetic's buffer had
//!    spare capacity: Vec guarantees that with_capacity(n), which to_vec
//!    uses, requests exactly n elements from the allocator; shrink_to_fit
//!    makes no such promise and is not used).  No working polynomial grows
//!    afterwards, so the pieces' requests are exactly their coefficients,
//!    and a working polynomial (at most len) fits a slot; even before
//!    `tight`, an operation's buffer has at most 2 len - 1 words (the
//!    longest product of two reduced residues).  The partition's other
//!    words (one per piece: its multiplicity and its vector's descriptor,
//!    in its parent's list) are the "one word per piece" above.  The live
//!    working polynomials are, at most: sqf: f, f', c, w, y, z and the
//!    p-th root r (7, per frame; its recursion on r, which has at most
//!    n/p + 1 coefficients, keeps only the caller's r and list of pieces,
//!    so the retained roots shrink geometrically, by p >= 2, and all
//!    frames together hold under 2 (n + 1) words besides the pieces); ddf: f, x, h, h - x, g and the quotient (6); edf:
//!    the piece g, a, s, h and the quotient q (5), the exponent words being
//!    reserved by edf itself.
//! 2. [`fp_bytes`]`(len)`, everything the arithmetic holds while one
//!    operation runs, beyond those slots, with N = 2 len padded to a power
//!    of two:
//!    - the tables: at most three primes of 32 N bytes, and TABLES_FIXED;
//!    - one product's transform buffers and residues: 32 N (the products
//!      of one operation run one after another);
//!    - the operation's own vectors, the larger of: the half-gcd's frames
//!      (nmod_poly::gcd_frame_bytes, proved there); a modular power's 3 N
//!      + 6 len words: its base and running power (len each), the product
//!      being reduced (2 len - 1, capacity at most N), the reduction's
//!      reversed copy (2 len), quotient (len) and remainder product (len),
//!      and the previous power while the next one is formed (len).  The
//!      Newton inverse of a modulus (k <= len terms: g, the truncated
//!      product of capacity at most N, and the next g, capacity at most N)
//!      and a division (the same vectors as a power's reduction, plus its
//!      quotient) stay within the same 3 N + 6 len words;
//!    - the gcd's inputs, copies it owns: 2 len words;
//!    - two moduli (the old one while its replacement is built, in ddf),
//!      each its polynomial (len) and inverse series (capacity at most
//!      N): 2 (len + N) words;
//!    - a result's exact copy in `tight`: at most 2 len words.
//!
//! The tests measure the allocator against both: the peak during a call
//! is at most the budget's peak reservation, also with the memory limit
//! set exactly to that reservation, where one byte less refuses before
//! the tables and leaves the allocator where it was
//! (`modp_memory_at_its_exact_reservation`).

use crate::budget::{big_bytes, limbs, FResult, Reservation};
use crate::{clog2, Budget, FPoly, Rng};
use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_poly::{self as np, PolyModulus};
use sagebrush_arith::ntt::LocalTables;
use sagebrush_bigint::BigUint;

/// The longest product of a computation on polynomials of at most `len`
/// coefficients: the tables to build.  Every operation below stays within
/// it: a product of two reduced residues has fewer than 2 len
/// coefficients, a division or a gcd of inputs of at most len
/// coefficients needs at most 2 len (nmod_poly::divrem_table_len and
/// gcd_table_len), and the inverse series of a modulus of len
/// coefficients has products shorter than 2 len.
pub(crate) fn table_len(len: usize) -> Option<usize> {
    len.max(1).checked_mul(2)
}

/// N: the table length (in points) for polynomials of at most `len`
/// coefficients, table_len(len) padded to a power of two.
fn points(len: usize) -> Option<u64> {
    (table_len(len)? as u64).checked_next_power_of_two()
}

/// The bytes of the tables beyond their 32 N per prime (the vector of
/// tables and its headers).
const TABLES_FIXED: u64 = 512;

/// The bytes one computation on polynomials of at most `len` coefficients
/// allocates inside the arithmetic, beyond the working polynomials of its
/// caller (each accounted by its slot in `modular_bytes`, whatever its
/// capacity; see the module's liveness section), with N =
/// [`points`]`(len)`:
/// - the tables: at most three primes of 32 N bytes each, and
///   TABLES_FIXED;
/// - one product's transform buffers and residues at a time: 32 N;
/// - the most any one operation holds besides them, its result included
///   before its exact copy: the half-gcd's frames
///   (nmod_poly::gcd_frame_bytes), or 8 (3 N + 6 len) for a modular power
///   (its base and running power, the previous power while the next is
///   formed, the product of 2 len - 3 coefficients at its capacity <= N,
///   and the reduction's reversed copy, quotient and remainder product);
/// - the gcd's inputs, copies it owns: 16 len;
/// - two moduli (the old one while its replacement is built), each its
///   polynomial and its inverse series (capacity <= N): 16 (len + N);
/// - a result's exact copy in [`tight`]: at most 2 len words: 16 len.
pub(crate) fn fp_bytes(len: usize) -> Option<u64> {
    let n = points(len)?;
    let l = len as u64;
    let tables = n.checked_mul(96)?.checked_add(TABLES_FIXED)?;
    let buffers = n.checked_mul(32)?;
    let power = n.checked_mul(3)?.checked_add(l.checked_mul(6)?)?.checked_mul(8)?;
    let inside = np::gcd_frame_bytes(len, len)?.max(power);
    let moduli = l.checked_add(n)?.checked_mul(16)?;
    tables.checked_add(buffers)?.checked_add(inside)?.checked_add(l.checked_mul(32)?)?.checked_add(moduli)
}

/// The work of building the tables: per prime (at most three) the
/// twiddle factors, their Shoup companions and inverses (at most 8 N),
/// and the roots of unity (512).
fn tables_work(len: usize) -> Option<u64> {
    points(len)?.checked_mul(8)?.checked_add(512)?.checked_mul(3)
}

/// The arithmetic of one modular computation on polynomials of at most
/// `len` coefficients: the modulus, the tables, and their reservation
/// (held until it drops).
pub(crate) struct Fp<'b> {
    b: &'b Budget,
    pub m: Modulus,
    len: usize,
    lt: LocalTables,
    _r: Reservation<'b>,
}

/// v in an allocation requested for exactly its length: a copy when it
/// has spare capacity (Vec guarantees that with_capacity(n), which to_vec
/// uses, requests exactly n elements; the allocator may round up, which
/// the accounting, in requested bytes, leaves out for every allocation).
/// Not shrink_to_fit, which need not release spare capacity.  The copy,
/// at most 2 len words, is the "result's copy" term of [`fp_bytes`].
fn tight(v: FPoly) -> FPoly {
    if v.capacity() > v.len() {
        v.to_vec()
    } else {
        v
    }
}

impl<'b> Fp<'b> {
    /// Reserve [`fp_bytes`] and debit the tables' work, then build them
    /// (nothing is allocated before both pass).
    pub fn new(b: &'b Budget, p: u64, len: usize) -> FResult<Fp<'b>> {
        let r = b.reserve(fp_bytes(len))?;
        b.debit(tables_work(len))?;
        let tl = table_len(len).ok_or_else(|| b.refuse("memory (overflow)", u64::MAX, 0))?;
        let m = Modulus::new(p);
        let lt = {
            let _phase = sagebrush_interrupt::enter("tables");
            LocalTables::new(&m, tl)
        };
        Ok(Fp { b, m, len, lt, _r: r })
    }

    /// The operands' lengths are within the computation's (a broken
    /// invariant is an internal error, never an overrun of the tables).
    fn fits(&self, l: usize) -> FResult<()> {
        if l > self.len {
            return Err(self.b.internal("modular arithmetic: an operand longer than the computation's"));
        }
        Ok(())
    }

    pub fn divrem(&self, x: &[u64], y: &[u64]) -> FResult<(FPoly, FPoly)> {
        if y.last().is_none_or(|&c| c == 0) {
            // (the factoring divides only by trimmed nonzero polynomials,
            // whose leading coefficient is a unit as p is prime: anything
            // else is a bug, not a limit)
            return Err(self.b.internal("modular arithmetic: a division by a zero or untrimmed polynomial"));
        }
        self.fits(x.len().max(y.len()))?;
        self.b.debit(np::divrem_work(x.len(), y.len()))?;
        let (q, r) = np::divrem_in(x, y, &self.m, &self.lt);
        Ok((tight(q), tight(r)))
    }

    pub fn quo(&self, x: &[u64], y: &[u64]) -> FResult<FPoly> {
        Ok(self.divrem(x, y)?.0)
    }

    /// The monic gcd (of copies: the gcd owns its inputs).
    pub fn gcd(&self, x: &[u64], y: &[u64]) -> FResult<FPoly> {
        self.fits(x.len().max(y.len()))?;
        self.b.debit(np::gcd_work(x.len(), y.len()))?;
        Ok(tight(np::gcd_in(x.to_vec(), y.to_vec(), &self.m, &self.lt)))
    }

    /// The modulus f (with its inverse series).
    pub fn modulus(&self, f: &[u64]) -> FResult<PolyModulus> {
        if f.last().is_none_or(|&c| c == 0) {
            // (the factoring reduces only modulo trimmed nonzero
            // polynomials: anything else is a bug, not a limit)
            return Err(self.b.internal("modular arithmetic: a zero or untrimmed polynomial as a modulus"));
        }
        self.fits(f.len())?;
        self.b.debit(np::polymod_new_work(f.len()))?;
        Ok(PolyModulus::new_in(f, &self.m, &self.lt))
    }

    /// A product's length (operands of at most len coefficients each) is
    /// within the computation's tables: at most 2 len - 1.
    fn fits_product(&self, l: usize) -> FResult<()> {
        if l >= self.len.max(1).saturating_mul(2) {
            return Err(self.b.internal("modular arithmetic: a product longer than the computation's"));
        }
        Ok(())
    }

    /// x mod f, for x shorter than 2 f.
    pub fn reduce(&self, pm: &PolyModulus, x: &[u64]) -> FResult<FPoly> {
        self.fits(pm.f.len())?;
        self.fits_product(x.len())?;
        self.b.debit(np::reduce_work(pm.f.len(), x.len()))?;
        Ok(tight(pm.reduce_in(x, &self.lt)))
    }

    pub fn mulmod(&self, pm: &PolyModulus, x: &[u64], y: &[u64]) -> FResult<FPoly> {
        self.fits(pm.f.len().max(x.len()).max(y.len()))?;
        self.b.debit(np::mulmod_work(pm.f.len(), x.len(), y.len()))?;
        Ok(tight(pm.mulmod_in(x, y, &self.lt)))
    }

    /// a^e mod f (e as little-endian words), a shorter than f.
    pub fn powmod(&self, pm: &PolyModulus, a: &[u64], e: &[u64]) -> FResult<FPoly> {
        self.fits(pm.f.len().max(a.len()))?;
        let ebits = match e.iter().rposition(|&w| w != 0) {
            Some(i) => 64 * i as u64 + 64 - e[i].leading_zeros() as u64,
            None => 0,
        };
        self.b.debit(np::powmod_work(pm.f.len(), a.len(), e.len(), ebits))?;
        Ok(tight(pm.powmod_in(a, e, &self.lt)))
    }

    /// g(h) mod f (Brent and Kung), h shorter than f: its matrix reserved,
    /// its work debited.
    pub fn compose(&self, pm: &PolyModulus, g: &[u64], h: &[u64]) -> FResult<FPoly> {
        self.fits(pm.f.len().max(g.len()).max(h.len()))?;
        let route = np::compose_route_for(pm.f.len(), g.len());
        let _w = self.b.reserve(np::compose_words(pm.f.len(), g.len(), route).and_then(|w| w.checked_mul(8)))?;
        self.b.debit(np::compose_work(pm.f.len(), g.len(), h.len()))?;
        Ok(tight(pm.compose_in(g, h, &self.lt)))
    }

    /// Reserve `count` polynomials of at most `len` coefficients held at
    /// once (beyond the operations' own transients).
    pub fn reserve_polys(&self, count: usize, len: usize) -> FResult<Reservation<'b>> {
        self.b.reserve((count as u64).checked_mul(len as u64).and_then(|w| w.checked_mul(8)))
    }

    /// The linear passes (copies, sums, differences, scalings, the
    /// derivative) of polynomials of these lengths.
    pub fn linear(&self, l: usize) -> FResult<()> {
        self.b.debit((l as u64).checked_add(1))
    }
}

/// Square-free decomposition of a monic f over F_p (Musser, with p-th
/// roots in characteristic p): (g, e) with f = prod g^e, g square-free
/// and monic.
pub(crate) fn sqf(fp: &Fp, f: &[u64]) -> FResult<Vec<(FPoly, u32)>> {
    let _phase = sagebrush_interrupt::enter("sqf");
    let (m, p) = (&fp.m, fp.m.n);
    let mut out = vec![];
    fp.linear(f.len())?;
    let df = tight(np::derivative(f, m));
    let c = fp.gcd(f, &df)?;
    drop(df);
    let mut w = fp.quo(f, &c)?;
    let mut c = c;
    let mut i = 1;
    while w.len() > 1 {
        sagebrush_interrupt::check_coarse();
        let y = fp.gcd(&w, &c)?;
        let z = fp.quo(&w, &y)?;
        if z.len() > 1 {
            fp.linear(z.len())?;
            out.push((tight(np::monic(&z, m)), i));
        }
        i += 1;
        w = y;
        c = fp.quo(&c, &w)?;
    }
    if c.len() > 1 {
        // c is a p-th power: c(x) = r(x^p)
        fp.linear(c.len())?;
        let r: FPoly = c.iter().step_by(p as usize).copied().collect();
        drop(c);
        let r = tight(np::monic(&r, m));
        for (g, e) in sqf(fp, &r)? {
            out.push((g, e * p as u32));
        }
    }
    Ok(out)
}

/// Distinct-degree factorization of a monic square-free f: (product of
/// the irreducible factors of degree d, d), by increasing d.  Two routes,
/// by their predicted cost ([`DdfRoute::for_degree`]):
/// - one degree at a time: x^(p^d) by a power to p per d, and a gcd with
///   x^(p^d) - x;
/// - baby steps and giant steps (Kaltofen and Shoup, Subquadratic-time
///   factoring of polynomials over finite fields, Math. Comp. 67, 1998;
///   von zur Gathen and Shoup 1992): the baby steps h_j = x^(p^j), j < l,
///   and the giant steps H_i = x^(p^(l i)) (by modular composition), and
///   per giant step one gcd with the interval polynomial prod_j (H_i -
///   h_j) mod f, which collects the factors of degree in ((i - 1) l, i l];
///   then those are separated by degree, by gcds with H_i - h_j.
pub(crate) fn ddf(fp: &Fp, f: &[u64]) -> FResult<Vec<(FPoly, usize)>> {
    let n = f.len().saturating_sub(1);
    ddf_by(fp, f, DdfRoute::for_degree(n, fp.m.n))
}

/// The route of [`ddf`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DdfRoute {
    /// One degree at a time.
    Linear,
    /// Baby steps of this many, and giant steps.
    BabyGiant(usize),
}

impl DdfRoute {
    /// The cheaper route for f of degree n over F_p, by predicted costs
    /// in products mod f over the D = n / 2 degrees to test (fitted to
    /// timings at p from 2 to 2^31 and n from 20 to 1500):
    /// - one degree at a time: D (pow + G), with a power to p per degree
    ///   ([`pow_cost`]) and a gcd, G = 0.3 (n / 300)^2 (the gcds' share
    ///   grows with n);
    /// - baby steps and giant steps: l (sigma + 2) for the baby steps (a
    ///   Frobenius map, sigma, the cheaper of a power and a composition,
    ///   plus their bookkeeping), D / l (C + G) for the giant steps (a
    ///   composition, [`compose_cost`], and a gcd), and D for the interval
    ///   polynomials; l = sqrt(D C / (sigma + 2)) minimizes it.
    pub(crate) fn for_degree(n: usize, p: u64) -> DdfRoute {
        if n < 4 {
            return DdfRoute::Linear;
        }
        let c = compose_cost(n);
        let pow = pow_cost(p);
        let sigma = c.min(pow);
        let d = (n / 2) as f64;
        let g = 0.3 * (n as f64 / 300.0).powi(2);
        let l = ((d * c / (sigma + 2.0)).sqrt().round() as usize).clamp(1, n / 2);
        let bsgs = l as f64 * (sigma + 2.0) + d / l as f64 * (c + g) + d;
        let linear = d * (pow + g);
        if bsgs < linear {
            DdfRoute::BabyGiant(l)
        } else {
            DdfRoute::Linear
        }
    }
}

/// The products mod f of a power to e by squarings: bitlen(e) - 1
/// squarings and popcount(e) - 1 multiplications (at least one product).
fn pow_cost(e: u64) -> f64 {
    let bits = 64 - e.leading_zeros();
    ((bits - 1 + e.count_ones() - 1) as f64).max(1.0)
}

/// A modular composition mod f of degree n, in products mod f: about 1.25
/// (k + r - 1) + 1 (measured, [`np::compose_shape`]).
fn compose_cost(n: usize) -> f64 {
    let (k, r) = np::compose_shape(n);
    1.25 * (k + r - 1) as f64 + 1.0
}

/// [`ddf`] by the given route (tests: the routes give the same pieces).
pub(crate) fn ddf_by(fp: &Fp, f: &[u64], route: DdfRoute) -> FResult<Vec<(FPoly, usize)>> {
    match route {
        DdfRoute::Linear => ddf_linear(fp, f),
        DdfRoute::BabyGiant(l) => ddf_baby_giant(fp, f, l),
    }
}

/// [`ddf`] one degree at a time.
fn ddf_linear(fp: &Fp, f: &[u64]) -> FResult<Vec<(FPoly, usize)>> {
    let _phase = sagebrush_interrupt::enter("ddf");
    let m = &fp.m;
    let mut out = vec![];
    let mut f = f.to_vec();
    let x: FPoly = vec![0, 1 % m.n];
    if f.len() < 3 {
        // (degree at most 1: irreducible, or the constant 1)
        if f.len() > 1 {
            out.push((f, 1));
        }
        return Ok(out);
    }
    let mut pm = fp.modulus(&f)?;
    let mut h = fp.reduce(&pm, &x)?;
    let e = [m.n];
    let mut d = 1;
    while 2 * d < f.len() {
        sagebrush_interrupt::check_coarse();
        h = fp.powmod(&pm, &h, &e)?;
        fp.linear(h.len())?;
        let hx = tight(np::sub(&h, &x, m));
        let g = fp.gcd(&f, &hx)?;
        drop(hx);
        if g.len() > 1 {
            f = fp.quo(&f, &g)?;
            pm = fp.modulus(&f)?;
            h = fp.reduce(&pm, &h)?;
            out.push((g, d));
        }
        d += 1;
    }
    if f.len() > 1 {
        let n = f.len() - 1;
        out.push((f, n));
    }
    Ok(out)
}

/// [`ddf`] by baby steps (l of them) and giant steps.
fn ddf_baby_giant(fp: &Fp, f: &[u64], l: usize) -> FResult<Vec<(FPoly, usize)>> {
    let _phase = sagebrush_interrupt::enter("ddf");
    let m = &fp.m;
    let p = m.n;
    let mut out = vec![];
    if f.len() < 3 {
        if f.len() > 1 {
            out.push((f.to_vec(), 1));
        }
        return Ok(out);
    }
    let n = f.len() - 1;
    // (held: the l baby steps, and x, x^p, H_1, H_i, the rest, the interval
    // polynomial, a difference, a gcd and its cofactor)
    let _held = fp.reserve_polys(l + 9, n + 1)?;
    let pm = fp.modulus(f)?;
    let x = fp.reduce(&pm, &[0, 1 % p])?;
    // y -> y^p mod f: a power to p, or a composition with x^p, the cheaper
    let xp = fp.powmod(&pm, &x, &[p])?;
    let by_power = pow_cost(p) <= compose_cost(n);
    let sigma = |y: &[u64]| -> FResult<FPoly> {
        if by_power {
            fp.powmod(&pm, y, &[p])
        } else {
            fp.compose(&pm, y, &xp)
        }
    };
    // the baby steps h_j = x^(p^j), j < l, and h_l = x^(p^l) = H_1
    let mut baby: Vec<FPoly> = Vec::with_capacity(l);
    baby.push(x.clone());
    let mut h = xp.clone();
    for _ in 1..l {
        sagebrush_interrupt::check_coarse();
        baby.push(h.clone());
        h = sigma(&h)?;
    }
    let big1 = h;
    // the giant steps, while the rest can still split: a factor of degree
    // at most (i - 1) l has been removed by giant step i, so the rest is
    // irreducible once its degree is below 2 ((i - 1) l + 1)
    let mut rest: FPoly = f.to_vec();
    let mut big = big1.clone();
    let mut i = 1;
    while rest.len() > 2 * ((i - 1) * l + 1) {
        sagebrush_interrupt::check_coarse();
        if i > 1 {
            big = fp.compose(&pm, &big, &big1)?;
        }
        // prod_j (H_i - h_j) mod f
        let mut iv: FPoly = vec![1 % p];
        for hj in &baby {
            fp.linear(n)?;
            let d = tight(np::sub(&big, hj, m));
            iv = fp.mulmod(&pm, &iv, &d)?;
        }
        let mut g = fp.gcd(&rest, &iv)?;
        drop(iv);
        if g.len() > 1 {
            rest = fp.quo(&rest, &g)?;
            // separate by degree, ascending: d = i l - j for j = l - 1 .. 0
            for j in (0..l).rev() {
                if g.len() < 2 {
                    break;
                }
                let d = i * l - j;
                if g.len() - 1 == d {
                    // (the rest of g is one factor of this degree)
                    out.push((g, d));
                    break;
                }
                fp.linear(n)?;
                let diff = tight(np::sub(&big, &baby[j], m));
                let e = fp.gcd(&g, &diff)?;
                if e.len() > 1 {
                    g = fp.quo(&g, &e)?;
                    out.push((e, d));
                }
            }
        }
        i += 1;
    }
    if rest.len() > 1 {
        let d = rest.len() - 1;
        out.push((rest, d));
    }
    Ok(out)
}

/// Cantor-Zassenhaus: the irreducible factors (of degree d each) of a
/// monic g, splitting with s = a^((p^d - 1) / 2) - 1, or in characteristic
/// 2 with the trace a + a^2 + ... + a^(2^(d-1)).  The pending pieces are
/// kept on a stack: they partition g.  Every candidate, also a rejected
/// one, is debited before it is drawn.
///
/// Two routes to the same s, chosen per piece by their predicted cost
/// ([`EdfRoute::for_piece`]):
/// - direct: the power of a by squarings (d log2 p of them), or the d - 1
///   squarings of the trace;
/// - by the norm (von zur Gathen and Shoup, Computing Frobenius maps and
///   factoring polynomials, Comput. Complexity 2, 1992): a^(1 + p + ... +
///   p^(d-1)) = N(a) built by doubling over d's bits, N_2t = N_t N_t(x^(p^t))
///   and N_(t+1) = a N_t^p, with the Frobenius powers x^(p^t) mod the piece
///   by modular composition (once per piece, for all its candidates); then
///   s = N(a)^((p - 1) / 2) - 1.  The trace likewise: T_2t = T_t + T_t(x^(2^t)),
///   T_(t+1) = a + T_t^2.
///
/// The splitting is randomized: each candidate splits a piece of two or
/// more factors with probability bounded below by a positive constant
/// (von zur Gathen and Gerhard, section 14.3), so it terminates with
/// probability 1, not after a bounded number of candidates.  That is not a work cap:
/// under a finite work limit the debits refuse it once the limit is
/// reached (the error, never a partial result); under
/// Budget::unlimited() (factor_mod's) nothing caps it, as with the
/// schoolbook splitting it replaced.
pub(crate) fn edf(b: &Budget, fp: &Fp, g: &[u64], d: usize, rng: &mut Rng, out: &mut Vec<FPoly>) -> FResult<()> {
    edf_by(b, fp, g, d, rng, out, None)
}

/// [`edf`], with every piece by the given route (tests: the two routes
/// give the same factors from the same candidates).
pub(crate) fn edf_by(b: &Budget, fp: &Fp, g: &[u64], d: usize, rng: &mut Rng, out: &mut Vec<FPoly>, force: Option<EdfRoute>) -> FResult<()> {
    let _phase = sagebrush_interrupt::enter("edf");
    let (m, p) = (&fp.m, fp.m.n);
    // (p^d - 1) / 2 as words, for the direct route (computed on its first
    // use): d bitlen(p) bits, reserved with its transients; its
    // computation, by squarings, debited
    let ebits = (d as u64).saturating_mul(64 - p.leading_zeros() as u64);
    let mut direct_e: Option<(Vec<u64>, Reservation)> = None;
    let mut stack: Vec<FPoly> = vec![g.to_vec()];
    while let Some(g) = stack.pop() {
        let n = g.len() - 1;
        if n == d {
            out.push(g);
            continue;
        }
        let pm = fp.modulus(&g)?;
        let route = force.unwrap_or_else(|| EdfRoute::for_piece(n, d, p));
        let chain = match route {
            EdfRoute::Norm => Some(Frobenius::new(fp, &pm, d)?),
            EdfRoute::Direct => {
                if p != 2 && direct_e.is_none() {
                    let r = b.reserve(big_bytes(ebits).and_then(|x| x.checked_mul(4)))?;
                    let l = limbs(ebits);
                    b.debit(l.checked_mul(l).and_then(|x| x.checked_mul(clog2(d as u64) + 1)))?;
                    direct_e = Some((((BigUint::from(p).pow(d as u32) - 1u32) / 2u32).to_u64_digits(), r));
                }
                None
            }
        };
        loop {
            sagebrush_interrupt::check_coarse();
            fp.linear(n)?;
            let a: FPoly = tight(np::trim((0..n).map(|_| rng.next() % p).collect()));
            if a.len() < 2 {
                continue;
            }
            let s = match &chain {
                Some(chain) => chain.split_value(fp, &pm, &a)?,
                None if p == 2 => {
                    let mut t = a.clone();
                    let mut s = a;
                    for _ in 1..d {
                        t = fp.mulmod(&pm, &t, &t)?;
                        fp.linear(n)?;
                        s = tight(np::add(&s, &t, m));
                    }
                    s
                }
                None => {
                    let e = &direct_e.as_ref().expect("the direct route's exponent").0;
                    let s = fp.powmod(&pm, &a, e)?;
                    fp.linear(n)?;
                    tight(np::sub(&s, &[1], m))
                }
            };
            let h = fp.gcd(&g, &s)?;
            if h.len() > 1 && h.len() < g.len() {
                let q = fp.quo(&g, &h)?;
                fp.linear(q.len())?;
                stack.push(tight(np::monic(&q, m)));
                stack.push(h);
                break;
            }
        }
    }
    Ok(())
}

/// The route of [`edf`] for a piece.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EdfRoute {
    Direct,
    Norm,
}

impl EdfRoute {
    /// The cheaper route for a piece of degree n splitting into factors of
    /// degree d over F_p, by their counts of products mod the piece
    /// ([`compose_cost`], [`pow_cost`]).  The norm's chain (built once) is
    /// charged half against each of the about two candidates a piece takes.
    pub(crate) fn for_piece(n: usize, d: usize, p: u64) -> EdfRoute {
        if d < 2 {
            return EdfRoute::Direct;
        }
        let c = compose_cost(n);
        let pow_p = pow_cost(p);
        let sigma = c.min(pow_p);
        let doublings = (usize::BITS - 1 - d.leading_zeros()) as f64;
        let incs = (d.count_ones() - 1) as f64;
        let (direct, norm_each) = if p == 2 {
            ((d - 1) as f64, doublings * (c + 1.0) + incs * (sigma + 1.0))
        } else {
            // ((p^d - 1) / 2 has about d log2 p bits, half of them set)
            (1.5 * d as f64 * (p as f64).log2(), doublings * (c + 1.0) + incs * (sigma + 1.0) + pow_cost((p - 1) / 2))
        };
        let setup = pow_p + doublings * c + incs * sigma;
        if norm_each + setup / 2.0 < direct {
            EdfRoute::Norm
        } else {
            EdfRoute::Direct
        }
    }
}

/// The Frobenius powers of a piece for [`edf`]'s norm route: x^p mod the
/// piece, and x^(p^t) mod the piece at each doubling of the chain over
/// d's bits (from the highest down: t -> 2t, then t -> t + 1 where the bit
/// is set).
struct Frobenius<'b> {
    p: u64,
    /// x^p mod the piece.
    xi1: FPoly,
    /// The chain: Some(x^(p^t)) for a doubling at t, None for t -> t + 1.
    steps: Vec<Option<FPoly>>,
    /// Whether y -> y^p is cheaper as a power than as a composition.
    pow_sigma: bool,
    /// The chain's polynomials and a candidate's running values.
    _held: Reservation<'b>,
}

impl<'b> Frobenius<'b> {
    fn new(fp: &Fp<'b>, pm: &PolyModulus, d: usize) -> FResult<Frobenius<'b>> {
        let p = fp.m.n;
        let n = pm.f.len() - 1;
        let top = usize::BITS - 1 - d.leading_zeros();
        // (x^p, one power per doubling, the running x^(p^t), and a
        // candidate's value, its image and their product)
        let held = fp.reserve_polys(top as usize + 6, n + 1)?;
        let x: FPoly = vec![0, 1 % p];
        let xi1 = fp.powmod(pm, &fp.reduce(pm, &x)?, &[p])?;
        let pow_sigma = pow_cost(p) <= compose_cost(n);
        let mut fr = Frobenius { p, xi1, steps: vec![], pow_sigma, _held: held };
        let mut xi_t = fr.xi1.clone();
        for i in (0..top).rev() {
            let last = i == 0;
            fr.steps.push(Some(xi_t.clone()));
            // (x^(p^2t) = x^(p^t) composed with itself, needed by a later step)
            if !last {
                xi_t = fp.compose(pm, &xi_t, &xi_t)?;
            }
            if (d >> i) & 1 == 1 {
                fr.steps.push(None);
                if !last {
                    xi_t = fr.sigma(fp, pm, &xi_t)?;
                }
            }
        }
        Ok(fr)
    }

    /// y^p mod the piece: a power or a composition with x^p.
    fn sigma(&self, fp: &Fp, pm: &PolyModulus, y: &[u64]) -> FResult<FPoly> {
        if self.pow_sigma {
            fp.powmod(pm, y, &[self.p])
        } else {
            fp.compose(pm, y, &self.xi1)
        }
    }

    /// s for the candidate a: N(a)^((p - 1) / 2) - 1, or the trace for p = 2.
    fn split_value(&self, fp: &Fp, pm: &PolyModulus, a: &[u64]) -> FResult<FPoly> {
        let m = &fp.m;
        let mut v: FPoly = a.to_vec();
        for step in &self.steps {
            let n = pm.f.len();
            v = match step {
                Some(xi_t) => {
                    let w = fp.compose(pm, &v, xi_t)?;
                    if self.p == 2 {
                        fp.linear(n)?;
                        tight(np::add(&v, &w, m))
                    } else {
                        fp.mulmod(pm, &v, &w)?
                    }
                }
                None => {
                    let w = self.sigma(fp, pm, &v)?;
                    if self.p == 2 {
                        fp.linear(n)?;
                        tight(np::add(a, &w, m))
                    } else {
                        fp.mulmod(pm, a, &w)?
                    }
                }
            };
        }
        if self.p == 2 {
            return Ok(v);
        }
        let s = fp.powmod(pm, &v, &[(self.p - 1) / 2])?;
        fp.linear(pm.f.len())?;
        Ok(tight(np::sub(&s, &[1], m)))
    }
}
