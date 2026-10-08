//! Exact division over Z (and so over Q, by Gauss's lemma): a heap
//! division in the packed lex order (Monagan and Pearce), which stops as
//! soon as a quotient term is impossible (a remainder term, or an exponent
//! beyond deg(a) - deg(b) in some variable).

use crate::{Coeffs, ZPoly};
use num_integer::Integer;
use num_traits::Zero;
use sagebrush_bigint::BigInt;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// a / b if b divides a exactly over Z.
pub fn divexact(a: &ZPoly, b: &ZPoly) -> Option<ZPoly> {
    if b.is_zero() {
        return None;
    }
    if a.is_zero() {
        return Some(ZPoly::zero(a.n));
    }
    let n = a.n;
    let (da, db) = (a.degrees(), b.degrees());
    if (0..n).any(|i| db[i] > da[i]) {
        return None;
    }
    let bits = a.bits.max(b.bits);
    let (a, b) = (a.repack(bits), b.repack(bits));
    let pk = crate::order::Packing { n, bits };
    let bound: Vec<u64> = (0..n).map(|i| da[i] - db[i]).collect();
    if let (Coeffs::Small(x), Coeffs::Small(y)) = (&a.coeffs, &b.coeffs) {
        match divexact_small(&pk, &a.exps, x, &b.exps, y, &bound) {
            Small::Done(q) => return q,
            Small::Big => {}
        }
    }
    let (ac, bc) = (a.coeffs.to_big_vec(), b.coeffs.to_big_vec());
    let (lw, lc) = (b.exps[0], bc[0].clone());
    let mut qw: Vec<u64> = vec![];
    let mut qc: Vec<BigInt> = vec![];
    // products q_i * b_j (j >= 1), by their words
    let mut heap: BinaryHeap<(u64, Reverse<u32>, u32)> = BinaryHeap::new();
    let mut ai = 0usize;
    let mut steps = 0u64;
    loop {
        let top = heap.peek().map(|x| x.0);
        let w = match (ai < a.len(), top) {
            (false, None) => break,
            (true, None) => a.exps[ai],
            (false, Some(t)) => t,
            (true, Some(t)) => a.exps[ai].max(t),
        };
        let mut c = BigInt::zero();
        if ai < a.len() && a.exps[ai] == w {
            c = ac[ai].clone();
            ai += 1;
        }
        while let Some(&(t, Reverse(i), j)) = heap.peek() {
            if t != w {
                break;
            }
            heap.pop();
            let (i, j) = (i as usize, j as usize);
            c -= &qc[i] * &bc[j];
            if j + 1 < b.len() {
                heap.push((qw[i] + b.exps[j + 1], Reverse(i as u32), j as u32 + 1));
            }
            steps += 1;
            if steps & 0xffff == 0 {
                sagebrush_interrupt::check();
            }
        }
        if c.is_zero() {
            continue;
        }
        if !pk.divides(lw, w) {
            return None;
        }
        let m = w - lw;
        if (0..n).any(|i| pk.exp(m, i) > bound[i]) {
            return None;
        }
        let (q, r) = c.div_rem(&lc);
        if !r.is_zero() {
            return None;
        }
        qw.push(m);
        qc.push(q);
        if b.len() > 1 {
            let i = qw.len() - 1;
            heap.push((m + b.exps[1], Reverse(i as u32), 1));
        }
    }
    Some(ZPoly { n, bits, exps: qw, coeffs: Coeffs::Big(qc) }.shrunk())
}

enum Small {
    Done(Option<ZPoly>),
    /// a quotient coefficient outgrew a word: redo with big integers
    Big,
}

/// The heap division with word coefficients (192-bit accumulators).
fn divexact_small(pk: &crate::order::Packing, ae: &[u64], ac: &[i64], be: &[u64], bc: &[i64], bound: &[u64]) -> Small {
    let n = pk.n;
    let (lw, lc) = (be[0], bc[0] as i128);
    let mut qw: Vec<u64> = vec![];
    let mut qc: Vec<i64> = vec![];
    let mut heap: BinaryHeap<(u64, Reverse<u32>, u32)> = BinaryHeap::new();
    let mut ai = 0usize;
    let mut steps = 0u64;
    loop {
        let top = heap.peek().map(|x| x.0);
        let w = match (ai < ae.len(), top) {
            (false, None) => break,
            (true, None) => ae[ai],
            (false, Some(t)) => t,
            (true, Some(t)) => ae[ai].max(t),
        };
        // c = a_w - sum q_i b_j: v + h 2^128
        let (mut v, mut h) = (0i128, 0i64);
        if ai < ae.len() && ae[ai] == w {
            v = ac[ai] as i128;
            ai += 1;
        }
        while let Some(&(t, Reverse(i), j)) = heap.peek() {
            if t != w {
                break;
            }
            heap.pop();
            let (i, j) = (i as usize, j as usize);
            let p = qc[i] as i128 * bc[j] as i128;
            let (r, o) = v.overflowing_sub(p);
            v = r;
            if o {
                h += if p > 0 { -1 } else { 1 };
            }
            if j + 1 < be.len() {
                heap.push((qw[i] + be[j + 1], Reverse(i as u32), j as u32 + 1));
            }
            steps += 1;
            if steps & 0xffff == 0 {
                sagebrush_interrupt::check();
            }
        }
        if v == 0 && h == 0 {
            continue;
        }
        if h != 0 {
            return Small::Big;
        }
        if !pk.divides(lw, w) {
            return Small::Done(None);
        }
        let m = w - lw;
        if (0..n).any(|i| pk.exp(m, i) > bound[i]) {
            return Small::Done(None);
        }
        if v % lc != 0 {
            return Small::Done(None);
        }
        let q = v / lc;
        let Ok(q) = i64::try_from(q) else { return Small::Big };
        qw.push(m);
        qc.push(q);
        if be.len() > 1 {
            let i = qw.len() - 1;
            heap.push((m + be[1], Reverse(i as u32), 1));
        }
    }
    Small::Done(Some(ZPoly { n, bits: pk.bits, exps: qw, coeffs: Coeffs::Small(qc) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_traits::One;

    fn lin(n: usize) -> ZPoly {
        let mut t = vec![(vec![0u64; n], BigInt::one())];
        for i in 0..n {
            let mut e = vec![0u64; n];
            e[i] = 1;
            t.push((e, BigInt::from(i as i64 + 2)));
        }
        ZPoly::from_terms(n, t).unwrap()
    }

    #[test]
    fn exact() {
        let f = lin(3).pow(5).unwrap();
        let g = lin(3).add_signed(&ZPoly::from_terms(3, vec![(vec![1, 1, 0], BigInt::from(-3))]).unwrap(), false).pow(3).unwrap();
        let p = f.mul(&g).unwrap();
        assert!(divexact(&p, &f).unwrap().equals(&g));
        assert!(divexact(&p, &g).unwrap().equals(&f));
        // not divisible
        let h = p.add_signed(&ZPoly::from_terms(3, vec![(vec![0, 0, 1], BigInt::one())]).unwrap(), false);
        assert!(divexact(&h, &f).is_none());
        assert!(divexact(&f, &p).is_none());
    }
}
