//! Sparse multivariate polynomials over Z (and Q, as an integer polynomial
//! over a positive denominator) for Sagebrush.
//!
//! A polynomial is a list of terms in decreasing lex order of the exponent
//! vectors (the first variable most significant).  Each exponent vector is
//! packed into one 64-bit word, `bits` bits per variable, the first variable
//! in the highest field; the words compare as the monomials do, and the
//! word of a product is the sum of the words.  Coefficients are machine
//! words while they fit, else big integers.
//!
//! Multiplication (the heart of the matter, cf. Fateman's benchmark
//! f*(f + 1) with f = (1 + x + y + z + t)^n):
//! - dense chunks: the terms are grouped by their exponents in the leading
//!   variables; every pair of groups is multiplied into a small dense array
//!   indexed by the exponents of the trailing variables (sized to stay in
//!   cache), with 192-bit accumulators (i128 plus a carry word) when the
//!   coefficients are words.  Output comes out sorted: no hashing, heap or
//!   sorting in the inner loop.
//! - otherwise, a heap merge of the rows (Johnson; Monagan and Pearce's
//!   order of row insertions).
//!
//! The front end (lib/_sage_mpoly.py) keeps a polynomial as the bytes of
//! [`QPoly::to_bytes`] and calls [`call`] for each operation: the engine
//! keeps no state, so a trapped WebAssembly instance loses nothing.

use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

/// The coefficients of a polynomial: words while they fit.
#[derive(Clone, Debug, PartialEq)]
pub enum Coeffs {
    Small(Vec<i64>),
    Big(Vec<BigInt>),
}

impl Coeffs {
    pub fn len(&self) -> usize {
        match self {
            Coeffs::Small(v) => v.len(),
            Coeffs::Big(v) => v.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn big(&self, i: usize) -> BigInt {
        match self {
            Coeffs::Small(v) => BigInt::from(v[i]),
            Coeffs::Big(v) => v[i].clone(),
        }
    }

    fn to_big(&self) -> Vec<BigInt> {
        match self {
            Coeffs::Small(v) => v.iter().map(|&c| BigInt::from(c)).collect(),
            Coeffs::Big(v) => v.clone(),
        }
    }

    /// Words if every coefficient fits in one.
    fn shrink(v: Vec<BigInt>) -> Coeffs {
        let mut s = Vec::with_capacity(v.len());
        for c in &v {
            match c.to_i64() {
                Some(x) => s.push(x),
                None => return Coeffs::Big(v),
            }
        }
        Coeffs::Small(s)
    }
}

/// A polynomial over Z in n variables.
#[derive(Clone, Debug)]
pub struct ZPoly {
    pub n: usize,
    /// bits per variable in the packed exponent words (n * bits <= 64)
    pub bits: u32,
    pub exps: Vec<u64>,
    pub coeffs: Coeffs,
}

/// The number of bits for exponents up to d.
pub fn bits_for(d: u64) -> u32 {
    (64 - d.leading_zeros()).max(1)
}

impl ZPoly {
    pub fn zero(n: usize) -> ZPoly {
        ZPoly { n, bits: 1, exps: vec![], coeffs: Coeffs::Small(vec![]) }
    }

    pub fn len(&self) -> usize {
        self.exps.len()
    }

    pub fn is_zero(&self) -> bool {
        self.exps.is_empty()
    }

    fn shift(&self, i: usize) -> u32 {
        (self.n - 1 - i) as u32 * self.bits
    }

    fn mask(&self) -> u64 {
        if self.bits >= 64 {
            !0
        } else {
            (1u64 << self.bits) - 1
        }
    }

    /// The exponent of variable i in a packed word.
    pub fn exp(&self, w: u64, i: usize) -> u64 {
        (w >> self.shift(i)) & self.mask()
    }

    pub fn unpack(&self, w: u64) -> Vec<u64> {
        (0..self.n).map(|i| self.exp(w, i)).collect()
    }

    /// The largest exponent of each variable.
    pub fn degrees(&self) -> Vec<u64> {
        let mut d = vec![0u64; self.n];
        for &w in &self.exps {
            for (i, di) in d.iter_mut().enumerate() {
                let e = self.exp(w, i);
                if e > *di {
                    *di = e;
                }
            }
        }
        d
    }

    /// The same polynomial with b bits per variable (the order is kept).
    pub fn repack(&self, b: u32) -> ZPoly {
        if b == self.bits {
            return self.clone();
        }
        let exps = self
            .exps
            .iter()
            .map(|&w| {
                let mut r = 0u64;
                for i in 0..self.n {
                    r |= self.exp(w, i) << ((self.n - 1 - i) as u32 * b);
                }
                r
            })
            .collect();
        ZPoly { n: self.n, bits: b, exps, coeffs: self.coeffs.clone() }
    }

    /// From (exponents, coefficient) terms in any order (repeated monomials
    /// are added, zeros dropped).
    pub fn from_terms(n: usize, terms: Vec<(Vec<u64>, BigInt)>) -> Result<ZPoly, String> {
        let maxd = terms.iter().flat_map(|(e, _)| e.iter().copied()).max().unwrap_or(0);
        let b = bits_for(maxd);
        if n == 0 {
            let c: BigInt = terms.into_iter().map(|t| t.1).sum();
            let mut p = ZPoly::zero(0);
            if !c.is_zero() {
                p.exps.push(0);
                p.coeffs = Coeffs::shrink(vec![c]);
            }
            return Ok(p);
        }
        if (n as u64) * (b as u64) > 64 {
            return Err(format!("exponents too large to pack ({} variables of {} bits)", n, b));
        }
        let mut t: Vec<(u64, BigInt)> = terms
            .into_iter()
            .map(|(e, c)| {
                let mut w = 0u64;
                for (i, x) in e.iter().enumerate() {
                    w |= x << ((n - 1 - i) as u32 * b);
                }
                (w, c)
            })
            .collect();
        t.sort_by(|a, b| b.0.cmp(&a.0));
        let mut exps: Vec<u64> = Vec::with_capacity(t.len());
        let mut cs: Vec<BigInt> = Vec::with_capacity(t.len());
        for (w, c) in t {
            if exps.last() == Some(&w) {
                let l = cs.len() - 1;
                cs[l] += c;
            } else {
                exps.push(w);
                cs.push(c);
            }
        }
        let mut p = ZPoly { n, bits: b, exps, coeffs: Coeffs::Big(cs) };
        p.drop_zeros();
        Ok(p)
    }

    fn drop_zeros(&mut self) {
        let cs = self.coeffs.to_big();
        let mut exps = Vec::with_capacity(cs.len());
        let mut out = Vec::with_capacity(cs.len());
        for (w, c) in self.exps.iter().zip(cs) {
            if !c.is_zero() {
                exps.push(*w);
                out.push(c);
            }
        }
        self.exps = exps;
        self.coeffs = Coeffs::shrink(out);
    }

    pub fn neg(&self) -> ZPoly {
        let coeffs = match &self.coeffs {
            Coeffs::Small(v) if v.iter().all(|&c| c != i64::MIN) => Coeffs::Small(v.iter().map(|&c| -c).collect()),
            _ => Coeffs::shrink(self.coeffs.to_big().into_iter().map(|c| -c).collect()),
        };
        ZPoly { n: self.n, bits: self.bits, exps: self.exps.clone(), coeffs }
    }

    /// c * self.
    pub fn scale(&self, c: &BigInt) -> ZPoly {
        if c.is_zero() {
            return ZPoly::zero(self.n);
        }
        if let (Coeffs::Small(v), Some(k)) = (&self.coeffs, c.to_i64()) {
            let out: Option<Vec<i64>> = v.iter().map(|&x| x.checked_mul(k)).collect();
            if let Some(out) = out {
                return ZPoly { n: self.n, bits: self.bits, exps: self.exps.clone(), coeffs: Coeffs::Small(out) };
            }
        }
        let out = self.coeffs.to_big().into_iter().map(|x| x * c).collect();
        ZPoly { n: self.n, bits: self.bits, exps: self.exps.clone(), coeffs: Coeffs::shrink(out) }
    }

    /// The gcd of the coefficients (0 for the zero polynomial).
    pub fn content(&self) -> BigInt {
        match &self.coeffs {
            Coeffs::Small(v) => {
                let mut s: u64 = 0;
                for &c in v {
                    s = s.gcd(&c.unsigned_abs());
                    if s == 1 {
                        break;
                    }
                }
                BigInt::from(s)
            }
            Coeffs::Big(v) => {
                let mut g = BigInt::zero();
                for c in v {
                    g = g.gcd(c);
                    if g.is_one() {
                        break;
                    }
                }
                g
            }
        }
    }

    /// self / c, for c dividing every coefficient.
    pub fn divexact_scalar(&self, c: &BigInt) -> ZPoly {
        let out = self.coeffs.to_big().into_iter().map(|x| x / c).collect();
        ZPoly { n: self.n, bits: self.bits, exps: self.exps.clone(), coeffs: Coeffs::shrink(out) }
    }

    pub fn equals(&self, o: &ZPoly) -> bool {
        if self.len() != o.len() || self.n != o.n {
            return false;
        }
        let b = self.bits.max(o.bits);
        let (a, c) = (self.repack(b), o.repack(b));
        a.exps == c.exps && a.coeffs.to_big() == c.coeffs.to_big()
    }

    /// self + o, or self - o.
    pub fn add_signed(&self, o: &ZPoly, sub: bool) -> ZPoly {
        let b = self.bits.max(o.bits);
        let (a, c) = (self.repack(b), o.repack(b));
        if let (Coeffs::Small(x), Coeffs::Small(y)) = (&a.coeffs, &c.coeffs) {
            if let Some(p) = merge_small(&a.exps, x, &c.exps, y, sub) {
                return ZPoly { n: a.n, bits: b, exps: p.0, coeffs: Coeffs::Small(p.1) };
            }
        }
        let (x, y) = (a.coeffs.to_big(), c.coeffs.to_big());
        let (mut i, mut j) = (0, 0);
        let mut exps = Vec::with_capacity(x.len() + y.len());
        let mut cs: Vec<BigInt> = Vec::with_capacity(x.len() + y.len());
        while i < x.len() || j < y.len() {
            let ord = if i == x.len() {
                Ordering::Less
            } else if j == y.len() {
                Ordering::Greater
            } else {
                a.exps[i].cmp(&c.exps[j])
            };
            match ord {
                Ordering::Greater => {
                    exps.push(a.exps[i]);
                    cs.push(x[i].clone());
                    i += 1;
                }
                Ordering::Less => {
                    exps.push(c.exps[j]);
                    cs.push(if sub { -y[j].clone() } else { y[j].clone() });
                    j += 1;
                }
                Ordering::Equal => {
                    let s = if sub { &x[i] - &y[j] } else { &x[i] + &y[j] };
                    if !s.is_zero() {
                        exps.push(a.exps[i]);
                        cs.push(s);
                    }
                    i += 1;
                    j += 1;
                }
            }
        }
        ZPoly { n: a.n, bits: b, exps, coeffs: Coeffs::shrink(cs) }
    }

    pub fn mul(&self, o: &ZPoly) -> Result<ZPoly, String> {
        mul(self, o)
    }

    pub fn pow(&self, e: u64) -> Result<ZPoly, String> {
        let mut r = ZPoly { n: self.n, bits: 1, exps: vec![0], coeffs: Coeffs::Small(vec![1]) };
        if e == 0 {
            return Ok(r);
        }
        if self.is_zero() {
            return Ok(ZPoly::zero(self.n));
        }
        if self.len() == 1 {
            // a monomial: directly
            let d = self.degrees();
            let c = num_traits::Pow::pow(self.coeffs.big(0), e as u32);
            return ZPoly::from_terms(self.n, vec![(d.iter().map(|x| x * e).collect(), c)]);
        }
        let mut b = self.clone();
        let mut k = e;
        loop {
            if k & 1 == 1 {
                r = mul(&r, &b)?;
            }
            k >>= 1;
            if k == 0 {
                break;
            }
            b = mul(&b, &b)?;
        }
        Ok(r)
    }
}

fn merge_small(ae: &[u64], a: &[i64], be: &[u64], b: &[i64], sub: bool) -> Option<(Vec<u64>, Vec<i64>)> {
    let (mut i, mut j) = (0, 0);
    let mut exps = Vec::with_capacity(a.len() + b.len());
    let mut cs = Vec::with_capacity(a.len() + b.len());
    while i < a.len() || j < b.len() {
        let ord = if i == a.len() {
            Ordering::Less
        } else if j == b.len() {
            Ordering::Greater
        } else {
            ae[i].cmp(&be[j])
        };
        match ord {
            Ordering::Greater => {
                exps.push(ae[i]);
                cs.push(a[i]);
                i += 1;
            }
            Ordering::Less => {
                exps.push(be[j]);
                cs.push(if sub { b[j].checked_neg()? } else { b[j] });
                j += 1;
            }
            Ordering::Equal => {
                let s = if sub { a[i].checked_sub(b[j])? } else { a[i].checked_add(b[j])? };
                if s != 0 {
                    exps.push(ae[i]);
                    cs.push(s);
                }
                i += 1;
                j += 1;
            }
        }
    }
    Some((exps, cs))
}

// ------------------------------------------------------------ multiplication

/// The size of the dense accumulator (slots of 32 bytes).
const BOX: u64 = 1 << 13;

/// A 192-bit accumulator: v + h * 2^128.
#[derive(Clone, Copy, Default)]
struct Acc {
    v: i128,
    h: i64,
}

impl Acc {
    #[inline(always)]
    fn add(&mut self, p: i128) {
        let (r, o) = self.v.overflowing_add(p);
        self.v = r;
        if o {
            self.h += if p < 0 { -1 } else { 1 };
        }
    }

    fn is_zero(&self) -> bool {
        self.v == 0 && self.h == 0
    }

    fn to_big(self) -> BigInt {
        let v = BigInt::from(self.v);
        if self.h == 0 {
            v
        } else {
            (BigInt::from(self.h) << 128usize) + v
        }
    }

    fn small(&self) -> Option<i64> {
        if self.h == 0 {
            i64::try_from(self.v).ok()
        } else {
            None
        }
    }
}

/// Output terms, word coefficients until one does not fit.
struct Out {
    exps: Vec<u64>,
    small: Vec<i64>,
    big: Option<Vec<BigInt>>,
}

impl Out {
    fn new(cap: usize) -> Out {
        Out { exps: Vec::with_capacity(cap), small: Vec::with_capacity(cap), big: None }
    }

    fn push(&mut self, w: u64, a: Acc) {
        self.exps.push(w);
        match (&mut self.big, a.small()) {
            (None, Some(s)) => self.small.push(s),
            (None, None) => {
                let mut b: Vec<BigInt> = self.small.drain(..).map(BigInt::from).collect();
                b.push(a.to_big());
                self.big = Some(b);
            }
            (Some(b), _) => b.push(a.to_big()),
        }
    }

    fn push_big(&mut self, w: u64, c: BigInt) {
        self.exps.push(w);
        if self.big.is_none() {
            self.big = Some(self.small.drain(..).map(BigInt::from).collect());
        }
        self.big.as_mut().unwrap().push(c);
    }

    fn finish(self, n: usize, bits: u32) -> ZPoly {
        let coeffs = match self.big {
            None => Coeffs::Small(self.small),
            Some(b) => Coeffs::shrink(b),
        };
        ZPoly { n, bits, exps: self.exps, coeffs }
    }
}

pub fn mul(a: &ZPoly, b: &ZPoly) -> Result<ZPoly, String> {
    let n = a.n;
    if a.is_zero() || b.is_zero() {
        return Ok(ZPoly::zero(n));
    }
    if n == 0 {
        return ZPoly::from_terms(0, vec![(vec![], a.coeffs.big(0) * b.coeffs.big(0))]);
    }
    let (da, db) = (a.degrees(), b.degrees());
    let dims: Vec<u64> = (0..n).map(|i| da[i] + db[i] + 1).collect();
    let bits = bits_for(*dims.iter().max().unwrap() - 1);
    if (n as u64) * (bits as u64) > 64 {
        return Err(format!("exponents too large to pack ({} variables of {} bits)", n, bits));
    }
    let (a, b) = (a.repack(bits), b.repack(bits));
    // the longer polynomial in the inner loop
    let (a, b) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    // the trailing variables of the dense box
    let mut k = 0;
    let mut boxsize = 1u64;
    while k < n && boxsize * dims[n - 1 - k] <= BOX {
        boxsize *= dims[n - 1 - k];
        k += 1;
    }
    let small = matches!((&a.coeffs, &b.coeffs), (Coeffs::Small(_), Coeffs::Small(_)));
    if k > 0 {
        if let Some(p) = mul_dense(&a, &b, &dims, k, small) {
            return Ok(p);
        }
    }
    Ok(mul_heap(&a, &b, small))
}

struct Chunk {
    lead: u64,
    start: usize,
    end: usize,
    lo: u32,
    hi: u32,
}

fn chunks(p: &ZPoly, lead_mask: u64, idx: &[u32]) -> Vec<Chunk> {
    let mut out: Vec<Chunk> = vec![];
    for (i, &w) in p.exps.iter().enumerate() {
        let l = w & lead_mask;
        match out.last_mut() {
            Some(c) if c.lead == l => {
                c.end = i + 1;
                c.lo = c.lo.min(idx[i]);
                c.hi = c.hi.max(idx[i]);
            }
            _ => out.push(Chunk { lead: l, start: i, end: i + 1, lo: idx[i], hi: idx[i] }),
        }
    }
    out
}

/// The product by dense chunks; None if the boxes would be too empty.
fn mul_dense(a: &ZPoly, b: &ZPoly, dims: &[u64], k: usize, small: bool) -> Option<ZPoly> {
    let n = a.n;
    let bits = a.bits;
    let lead = n - k;
    let total_bits = n as u32 * bits;
    let all = if total_bits >= 64 { !0u64 } else { (1u64 << total_bits) - 1 };
    let lead_mask = if lead == 0 { 0 } else { all & (!0u64 << (k as u32 * bits)) };
    // mixed-radix strides of the trailing variables (last variable fastest)
    let mut strides = vec![0u64; n];
    let mut s = 1u64;
    for i in (lead..n).rev() {
        strides[i] = s;
        s *= dims[i];
    }
    let boxsize = s as usize;
    let index = |p: &ZPoly| -> Vec<u32> {
        p.exps.iter().map(|&w| (lead..n).map(|i| p.exp(w, i) * strides[i]).sum::<u64>() as u32).collect()
    };
    let (ia, ib) = (index(a), index(b));
    let (ca, cb) = (chunks(a, lead_mask, &ia), chunks(b, lead_mask, &ib));
    let npairs = ca.len() * cb.len();
    if npairs > 50_000_000 {
        return None;
    }
    let mut pairs: Vec<(u64, u32, u32)> = Vec::with_capacity(npairs);
    for (x, p) in ca.iter().enumerate() {
        for (y, q) in cb.iter().enumerate() {
            pairs.push((p.lead + q.lead, x as u32, y as u32));
        }
    }
    pairs.sort_unstable_by(|u, v| v.0.cmp(&u.0));
    // worth it: the box space scanned against the products
    let ops = a.len() as u64 * b.len() as u64;
    let mut scan = 0u64;
    {
        let mut i = 0;
        while i < pairs.len() {
            let key = pairs[i].0;
            let (mut lo, mut hi) = (u32::MAX, 0u32);
            while i < pairs.len() && pairs[i].0 == key {
                let (p, q) = (&ca[pairs[i].1 as usize], &cb[pairs[i].2 as usize]);
                lo = lo.min(p.lo + q.lo);
                hi = hi.max(p.hi + q.hi);
                i += 1;
            }
            scan += (hi - lo + 1) as u64;
        }
    }
    if scan > 4 * ops + (1 << 16) {
        return None;
    }
    // a box index as the packed trailing exponents
    let tail = |mut idx: u64| -> u64 {
        let mut w = 0u64;
        for i in (lead..n).rev() {
            w |= (idx % dims[i]) << ((n - 1 - i) as u32 * bits);
            idx /= dims[i];
        }
        w
    };
    let mut out = Out::new(a.len() + b.len());
    let mut i = 0;
    if small {
        let (Coeffs::Small(xa), Coeffs::Small(xb)) = (&a.coeffs, &b.coeffs) else { unreachable!() };
        let mut acc = vec![Acc::default(); boxsize];
        while i < pairs.len() {
            sagebrush_interrupt::check();
            let key = pairs[i].0;
            let (mut lo, mut hi) = (u32::MAX, 0u32);
            while i < pairs.len() && pairs[i].0 == key {
                let (p, q) = (&ca[pairs[i].1 as usize], &cb[pairs[i].2 as usize]);
                lo = lo.min(p.lo + q.lo);
                hi = hi.max(p.hi + q.hi);
                let bi = &ib[q.start..q.end];
                let bc = &xb[q.start..q.end];
                for t in p.start..p.end {
                    let c = xa[t] as i128;
                    let row = &mut acc[ia[t] as usize..];
                    for (j, &x) in bi.iter().enumerate() {
                        // SAFETY: ia[t] + ib[j] < boxsize by the choice of the strides
                        unsafe {
                            row.get_unchecked_mut(x as usize).add(c * *bc.get_unchecked(j) as i128);
                        }
                    }
                }
                i += 1;
            }
            for idx in (lo..=hi).rev() {
                let s = &mut acc[idx as usize];
                if !s.is_zero() {
                    out.push(key | tail(idx as u64), *s);
                    *s = Acc::default();
                }
            }
        }
    } else {
        let (xa, xb) = (a.coeffs.to_big(), b.coeffs.to_big());
        let mut acc: Vec<BigInt> = vec![BigInt::zero(); boxsize];
        while i < pairs.len() {
            sagebrush_interrupt::check();
            let key = pairs[i].0;
            let (mut lo, mut hi) = (u32::MAX, 0u32);
            while i < pairs.len() && pairs[i].0 == key {
                let (p, q) = (&ca[pairs[i].1 as usize], &cb[pairs[i].2 as usize]);
                lo = lo.min(p.lo + q.lo);
                hi = hi.max(p.hi + q.hi);
                for t in p.start..p.end {
                    let base = ia[t] as usize;
                    for j in q.start..q.end {
                        acc[base + ib[j] as usize] += &xa[t] * &xb[j];
                    }
                }
                i += 1;
            }
            for idx in (lo..=hi).rev() {
                let s = &mut acc[idx as usize];
                if !s.is_zero() {
                    out.push_big(key | tail(idx as u64), std::mem::take(s));
                }
            }
        }
    }
    Some(out.finish(n, bits))
}

/// The product by a heap merge of the rows a[i]*b (a the shorter).
fn mul_heap(a: &ZPoly, b: &ZPoly, small: bool) -> ZPoly {
    #[derive(PartialEq, Eq, PartialOrd, Ord)]
    struct Item(u64, std::cmp::Reverse<u32>);
    let (la, lb) = (a.len(), b.len());
    let mut cur = vec![0u32; la];
    let mut heap: BinaryHeap<Item> = BinaryHeap::with_capacity(la);
    heap.push(Item(a.exps[0] + b.exps[0], std::cmp::Reverse(0)));
    let mut out = Out::new(la + lb);
    let words = match (&a.coeffs, &b.coeffs) {
        (Coeffs::Small(x), Coeffs::Small(y)) if small => Some((x, y)),
        _ => None,
    };
    let (ba, bb) = if words.is_none() { (a.coeffs.to_big(), b.coeffs.to_big()) } else { (vec![], vec![]) };
    let mut steps = 0u64;
    while let Some(top) = heap.peek() {
        let w = top.0;
        let mut acc = Acc::default();
        let mut bacc = BigInt::zero();
        while let Some(t) = heap.peek() {
            if t.0 != w {
                break;
            }
            let Item(_, std::cmp::Reverse(i)) = heap.pop().unwrap();
            let i = i as usize;
            let j = cur[i] as usize;
            match words {
                Some((x, y)) => acc.add(x[i] as i128 * y[j] as i128),
                None => bacc += &ba[i] * &bb[j],
            }
            cur[i] += 1;
            if j + 1 < lb {
                heap.push(Item(a.exps[i] + b.exps[j + 1], std::cmp::Reverse(i as u32)));
            }
            if j == 0 && i + 1 < la {
                heap.push(Item(a.exps[i + 1] + b.exps[0], std::cmp::Reverse(i as u32 + 1)));
            }
            steps += 1;
            if steps & 0xffff == 0 {
                sagebrush_interrupt::check();
            }
        }
        if words.is_some() {
            if !acc.is_zero() {
                out.push(w, acc);
            }
        } else if !bacc.is_zero() {
            out.push_big(w, bacc);
        }
    }
    out.finish(a.n, a.bits)
}

// ------------------------------------------------------------- over Q

/// A polynomial over Q: num / den with den > 0 and gcd(content, den) = 1.
#[derive(Clone, Debug)]
pub struct QPoly {
    pub num: ZPoly,
    pub den: BigInt,
}

impl QPoly {
    pub fn from_z(num: ZPoly) -> QPoly {
        QPoly { num, den: BigInt::one() }
    }

    fn normalize(mut self) -> QPoly {
        if self.den.is_negative() {
            self.num = self.num.neg();
            self.den = -self.den;
        }
        if self.num.is_zero() {
            self.den = BigInt::one();
            return self;
        }
        if !self.den.is_one() {
            let g = self.num.content().gcd(&self.den);
            if !g.is_one() {
                self.num = self.num.divexact_scalar(&g);
                self.den = &self.den / &g;
            }
        }
        self
    }

    pub fn add_signed(&self, o: &QPoly, sub: bool) -> QPoly {
        if self.den == o.den {
            return QPoly { num: self.num.add_signed(&o.num, sub), den: self.den.clone() }.normalize();
        }
        let num = self.num.scale(&o.den).add_signed(&o.num.scale(&self.den), sub);
        QPoly { num, den: &self.den * &o.den }.normalize()
    }

    pub fn mul(&self, o: &QPoly) -> Result<QPoly, String> {
        Ok(QPoly { num: mul(&self.num, &o.num)?, den: &self.den * &o.den }.normalize())
    }

    pub fn pow(&self, e: u64) -> Result<QPoly, String> {
        Ok(QPoly { num: self.num.pow(e)?, den: num_traits::Pow::pow(self.den.clone(), e as u32) })
    }

    pub fn equals(&self, o: &QPoly) -> bool {
        self.den == o.den && self.num.equals(&o.num)
    }

    // ---- the bytes the front end keeps (little endian):
    //   "MP1" kind(u8: 0 word coefficients, 1 big) n(u32) bits(u32) len(u64)
    //   den(big) exps(len u64) coefficients(len i64 | len big)
    //   big: u32 (number of u64 words << 1 | sign), then the words
    pub fn to_bytes(&self) -> Vec<u8> {
        let p = &self.num;
        let mut v = Vec::with_capacity(32 + 16 * p.len());
        v.extend_from_slice(b"MP1");
        v.push(matches!(p.coeffs, Coeffs::Big(_)) as u8);
        v.extend_from_slice(&(p.n as u32).to_le_bytes());
        v.extend_from_slice(&p.bits.to_le_bytes());
        v.extend_from_slice(&(p.len() as u64).to_le_bytes());
        put_big(&mut v, &self.den);
        for w in &p.exps {
            v.extend_from_slice(&w.to_le_bytes());
        }
        match &p.coeffs {
            Coeffs::Small(c) => {
                for x in c {
                    v.extend_from_slice(&x.to_le_bytes());
                }
            }
            Coeffs::Big(c) => {
                for x in c {
                    put_big(&mut v, x);
                }
            }
        }
        v
    }

    pub fn from_bytes(b: &[u8]) -> Result<QPoly, String> {
        let mut r = Reader { b, i: 0 };
        if r.take(3)? != b"MP1" {
            return Err("not a Sagebrush polynomial".into());
        }
        let kind = r.take(1)?[0];
        let n = r.u32()? as usize;
        let bits = r.u32()?;
        let len = r.u64()? as usize;
        let den = r.big()?;
        let mut exps = Vec::with_capacity(len);
        for _ in 0..len {
            exps.push(r.u64()?);
        }
        let coeffs = if kind == 0 {
            let mut c = Vec::with_capacity(len);
            for _ in 0..len {
                c.push(r.u64()? as i64);
            }
            Coeffs::Small(c)
        } else {
            let mut c = Vec::with_capacity(len);
            for _ in 0..len {
                c.push(r.big()?);
            }
            Coeffs::Big(c)
        };
        Ok(QPoly { num: ZPoly { n, bits, exps, coeffs }, den })
    }

    /// The terms as text: "e0,e1,...:c;..." with c an integer or p/q
    /// (decreasing lex order).
    pub fn to_text(&self) -> String {
        let p = &self.num;
        let mut s = String::with_capacity(24 * p.len());
        for (t, &w) in p.exps.iter().enumerate() {
            if t > 0 {
                s.push(';');
            }
            for i in 0..p.n {
                if i > 0 {
                    s.push(',');
                }
                s.push_str(&p.exp(w, i).to_string());
            }
            s.push(':');
            let c = p.coeffs.big(t);
            if self.den.is_one() {
                s.push_str(&c.to_string());
            } else {
                let g = c.gcd(&self.den);
                s.push_str(&(&c / &g).to_string());
                let d = &self.den / &g;
                if !d.is_one() {
                    s.push('/');
                    s.push_str(&d.to_string());
                }
            }
        }
        s
    }

    pub fn from_text(n: usize, s: &str) -> Result<QPoly, String> {
        let mut terms: Vec<(Vec<u64>, BigInt, BigInt)> = vec![];
        for t in s.split(';') {
            if t.is_empty() {
                continue;
            }
            let (e, c) = t.split_once(':').ok_or("bad term")?;
            let exps: Vec<u64> = if e.is_empty() {
                vec![]
            } else {
                e.split(',').map(|x| x.parse::<u64>().map_err(|_| "bad exponent".to_string())).collect::<Result<_, _>>()?
            };
            if exps.len() != n {
                return Err("wrong number of exponents".into());
            }
            let (p, q) = c.split_once('/').unwrap_or((c, "1"));
            let p: BigInt = p.parse().map_err(|_| "bad coefficient".to_string())?;
            let q: BigInt = q.parse().map_err(|_| "bad coefficient".to_string())?;
            if q.is_zero() {
                return Err("zero denominator".into());
            }
            terms.push((exps, p, q));
        }
        let mut den = BigInt::one();
        for (_, _, q) in &terms {
            den = den.lcm(q);
        }
        let zt = terms.into_iter().map(|(e, p, q)| (e, p * (&den / &q))).collect();
        Ok(QPoly { num: ZPoly::from_terms(n, zt)?, den }.normalize())
    }
}

fn put_big(v: &mut Vec<u8>, x: &BigInt) {
    let (sign, words) = x.to_u64_digits();
    let neg = sign == sagebrush_bigint::Sign::Minus;
    v.extend_from_slice(&(((words.len() as u32) << 1) | neg as u32).to_le_bytes());
    for w in words {
        v.extend_from_slice(&w.to_le_bytes());
    }
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, k: usize) -> Result<&'a [u8], String> {
        if self.i + k > self.b.len() {
            return Err("truncated polynomial".into());
        }
        let s = &self.b[self.i..self.i + k];
        self.i += k;
        Ok(s)
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn big(&mut self) -> Result<BigInt, String> {
        let h = self.u32()?;
        let (k, neg) = ((h >> 1) as usize, h & 1 == 1);
        let mut words = Vec::with_capacity(k);
        for _ in 0..k {
            words.push(self.u64()?);
        }
        let m = sagebrush_bigint::BigUint::from_slice_u64(&words).to_bigint();
        Ok(if neg { -m } else { m })
    }
}

// ------------------------------------------------------------- the calls

/// One call from the front end: an operation on polynomials given as bytes
/// (and text arguments); the results as bytes.
///   new n text -> p        text p -> text        add/sub/mul p q -> p
///   neg p -> p             pow p e -> p          eq p q -> "1"/"0"
///   scale p c -> p (c an integer or p/q)         len p -> number of terms
pub fn call(op: &str, args: &[&[u8]]) -> Result<Vec<Vec<u8>>, String> {
    let arg = |i: usize| -> Result<&[u8], String> { args.get(i).copied().ok_or_else(|| format!("{}: missing argument", op)) };
    let text = |i: usize| -> Result<&str, String> { std::str::from_utf8(arg(i)?).map_err(|_| "bad text".to_string()) };
    let poly = |i: usize| -> Result<QPoly, String> { QPoly::from_bytes(arg(i)?) };
    let one = |p: QPoly| -> Result<Vec<Vec<u8>>, String> { Ok(vec![p.to_bytes()]) };
    match op {
        "new" => {
            let n: usize = text(0)?.parse().map_err(|_| "bad n")?;
            one(QPoly::from_text(n, text(1)?)?)
        }
        "text" => Ok(vec![poly(0)?.to_text().into_bytes()]),
        "add" => one(poly(0)?.add_signed(&poly(1)?, false)),
        "sub" => one(poly(0)?.add_signed(&poly(1)?, true)),
        "mul" => one(poly(0)?.mul(&poly(1)?)?),
        "neg" => {
            let p = poly(0)?;
            one(QPoly { num: p.num.neg(), den: p.den })
        }
        "pow" => {
            let e: u64 = text(1)?.parse().map_err(|_| "bad exponent")?;
            one(poly(0)?.pow(e)?)
        }
        "eq" => Ok(vec![if poly(0)?.equals(&poly(1)?) { b"1".to_vec() } else { b"0".to_vec() }]),
        "len" => Ok(vec![poly(0)?.num.len().to_string().into_bytes()]),
        "scale" => {
            let p = poly(0)?;
            let s = text(1)?;
            let (a, b) = s.split_once('/').unwrap_or((s, "1"));
            let a: BigInt = a.parse().map_err(|_| "bad scalar")?;
            let b: BigInt = b.parse().map_err(|_| "bad scalar")?;
            if b.is_zero() {
                return Err("division by zero".into());
            }
            one(QPoly { num: p.num.scale(&a), den: p.den * b }.normalize())
        }
        _ => Err(format!("unknown polynomial operation {}", op)),
    }
}

/// The framing of [`call`] over one byte buffer (the WebAssembly and Python
/// entry points): request = op (u32 length + bytes), the number of
/// arguments (u32), each (u32 length + bytes); reply = "ok" + the same
/// framing of the results, or "er" + the message.
pub fn call_framed(req: &[u8]) -> Vec<u8> {
    fn parse(req: &[u8]) -> Result<(String, Vec<&[u8]>), String> {
        let mut r = Reader { b: req, i: 0 };
        let k = r.u32()? as usize;
        let op = std::str::from_utf8(r.take(k)?).map_err(|_| "bad op")?.to_string();
        let m = r.u32()? as usize;
        let mut args = Vec::with_capacity(m);
        for _ in 0..m {
            let l = r.u32()? as usize;
            args.push(r.take(l)?);
        }
        Ok((op, args))
    }
    let res = parse(req).and_then(|(op, args)| call(&op, &args));
    let mut out = Vec::new();
    match res {
        Ok(parts) => {
            out.extend_from_slice(b"ok");
            out.extend_from_slice(&(parts.len() as u32).to_le_bytes());
            for p in parts {
                out.extend_from_slice(&(p.len() as u32).to_le_bytes());
                out.extend_from_slice(&p);
            }
        }
        Err(e) => {
            out.extend_from_slice(b"er");
            out.extend_from_slice(e.as_bytes());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lin(n: usize) -> ZPoly {
        // 1 + x1 + ... + xn
        let mut t = vec![(vec![0u64; n], BigInt::one())];
        for i in 0..n {
            let mut e = vec![0u64; n];
            e[i] = 1;
            t.push((e, BigInt::one()));
        }
        ZPoly::from_terms(n, t).unwrap()
    }

    fn naive(a: &ZPoly, b: &ZPoly) -> ZPoly {
        let mut t = vec![];
        for i in 0..a.len() {
            for j in 0..b.len() {
                let e: Vec<u64> = a.unpack(a.exps[i]).iter().zip(b.unpack(b.exps[j])).map(|(x, y)| x + y).collect();
                t.push((e, a.coeffs.big(i) * b.coeffs.big(j)));
            }
        }
        ZPoly::from_terms(a.n, t).unwrap()
    }

    #[test]
    fn fateman_small() {
        let f = lin(4).pow(8).unwrap();
        assert_eq!(f.len(), 495);
        let one = ZPoly::from_terms(4, vec![(vec![0; 4], BigInt::one())]).unwrap();
        let g = f.add_signed(&one, false);
        let p = mul(&f, &g).unwrap();
        assert!(p.equals(&naive(&f, &g)));
        assert_eq!(p.len(), 4845);
    }

    #[test]
    fn heap_and_big() {
        // sparse: the heap
        let a = ZPoly::from_terms(2, vec![(vec![0, 1000], BigInt::from(3)), (vec![500, 7], BigInt::from(-2)), (vec![1, 1], BigInt::from(5))]).unwrap();
        let b = ZPoly::from_terms(2, vec![(vec![999, 0], BigInt::from(7)), (vec![3, 2], BigInt::from(1) << 80usize), (vec![0, 0], BigInt::from(-1))]).unwrap();
        assert!(mul(&a, &b).unwrap().equals(&naive(&a, &b)));
        // big coefficients in the dense path
        let f = lin(3).scale(&(BigInt::from(1) << 70usize)).pow(3).unwrap();
        assert!(mul(&f, &f).unwrap().equals(&naive(&f, &f)));
    }

    #[test]
    fn overflow_192() {
        // coefficients near 2^63: sums past 2^127
        let c = BigInt::from(i64::MAX);
        let a = ZPoly::from_terms(2, (0..200u64).map(|i| (vec![i, 199 - i], c.clone())).collect()).unwrap();
        let b = ZPoly::from_terms(2, (0..200u64).map(|i| (vec![199 - i, i], c.clone())).collect()).unwrap();
        assert!(mul(&a, &b).unwrap().equals(&naive(&a, &b)));
        let nb = b.neg();
        assert!(mul(&a, &nb).unwrap().equals(&naive(&a, &nb)));
    }

    #[test]
    fn bytes_and_text() {
        let q = QPoly::from_text(3, "1,0,2:3/4;0,0,0:-5;0,1,0:1/2").unwrap();
        let r = QPoly::from_bytes(&q.to_bytes()).unwrap();
        assert!(q.equals(&r));
        assert_eq!(r.to_text(), "1,0,2:3/4;0,1,0:1/2;0,0,0:-5");
        let s = r.mul(&r).unwrap();
        assert_eq!(s.den, BigInt::from(16));
    }
}
