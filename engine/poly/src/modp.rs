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
/// the irreducible factors of degree d, d).
pub(crate) fn ddf(fp: &Fp, f: &[u64]) -> FResult<Vec<(FPoly, usize)>> {
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

/// Cantor-Zassenhaus: the irreducible factors (of degree d each) of a
/// monic g, with the trace map a + a^2 + ... + a^(2^(d-1)) in
/// characteristic 2.  The pending pieces are kept on a stack: they
/// partition g.  Every candidate, also a rejected one, is debited before
/// it is drawn.
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
    let _phase = sagebrush_interrupt::enter("edf");
    let (m, p) = (&fp.m, fp.m.n);
    // (p^d - 1) / 2 as words: d bitlen(p) bits, reserved with its
    // transients; its computation, by squarings, debited
    let ebits = (d as u64).saturating_mul(64 - p.leading_zeros() as u64);
    let _e = b.reserve(big_bytes(ebits).and_then(|x| x.checked_mul(4)))?;
    let e: Vec<u64> = if p == 2 {
        vec![]
    } else {
        let l = limbs(ebits);
        b.debit(l.checked_mul(l).and_then(|x| x.checked_mul(clog2(d as u64) + 1)))?;
        ((BigUint::from(p).pow(d as u32) - 1u32) / 2u32).to_u64_digits()
    };
    let mut stack: Vec<FPoly> = vec![g.to_vec()];
    while let Some(g) = stack.pop() {
        let n = g.len() - 1;
        if n == d {
            out.push(g);
            continue;
        }
        let pm = fp.modulus(&g)?;
        loop {
            sagebrush_interrupt::check_coarse();
            fp.linear(n)?;
            let a: FPoly = tight(np::trim((0..n).map(|_| rng.next() % p).collect()));
            if a.len() < 2 {
                continue;
            }
            let s = if p == 2 {
                let mut t = a.clone();
                let mut s = a;
                for _ in 1..d {
                    t = fp.mulmod(&pm, &t, &t)?;
                    fp.linear(n)?;
                    s = tight(np::add(&s, &t, m));
                }
                s
            } else {
                let s = fp.powmod(&pm, &a, &e)?;
                fp.linear(n)?;
                tight(np::sub(&s, &[1], m))
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
