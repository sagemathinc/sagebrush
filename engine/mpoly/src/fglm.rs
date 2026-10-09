//! Change of order for zero-dimensional ideals: FGLM (Faugère, Gianni,
//! Lazard, Mora 1993), modulo p < 2^31.
//!
//! The quotient A = k[x]/I has a basis, the staircase B of the first
//! basis G (the monomials no leading monomial divides; D of them).  The
//! normal forms of the border monomials x_i b (b in B, x_i b not in B) come
//! from one matrix reduction (F4's symbolic preprocessing with G, then
//! spelim: unit rows reduced by the multiples of G), which gives the
//! multiplication by each x_i on A.  The monomials are then visited in
//! increasing target order, each one x_i s for an s found standard before,
//! its vector M_i v(s): if it depends on the vectors of the standard
//! monomials so far, the dependency is a new element of the target basis
//! (its leading monomial the visited one), else it is standard; multiples
//! of leading monomials found are skipped.  The result is the reduced basis
//! (tails on standard monomials).  Monomials here are exponent vectors:
//! target bases can have degrees (x_n^D) far beyond the packed words.

use crate::f4::{F4, P};
use crate::order::{Order, Packing};
use crate::sparse::Overflow;
use sagebrush_arith::spelim::{self, Pivots, Row};
use sagebrush_bigint::nmod::Modulus;
use std::cmp::Reverse;
use num_traits::ToPrimitive;
use std::collections::{BinaryHeap, HashMap, HashSet};

/// A polynomial over GF(p) with exponent vectors, by decreasing monomial.
pub type EP = Vec<(Vec<u32>, u64)>;

/// Whether the reduced basis g (monic, terms by decreasing monomial in o1)
/// is of a zero-dimensional ideal: every variable has a pure power among
/// the leading monomials.
pub fn zero_dimensional(pk: Packing, g: &[P]) -> bool {
    (0..pk.n).all(|i| {
        g.iter().any(|f| {
            let e = pk.unpack(f[0].0);
            e[i] > 0 && e.iter().enumerate().all(|(j, &x)| j == i || x == 0)
        })
    })
}

/// The comparison key of an exponent vector in a target order (lex: the
/// first variable most significant; invlex: the last; deglex and
/// degrevlex by degree first).
fn key(o: Order, e: &[u32]) -> Vec<u64> {
    let d: u64 = e.iter().map(|&x| x as u64).sum();
    match o {
        Order::Lex => e.iter().map(|&x| x as u64).collect(),
        Order::InvLex => e.iter().rev().map(|&x| x as u64).collect(),
        Order::DegLex => std::iter::once(d).chain(e.iter().map(|&x| x as u64)).collect(),
        // degree, then the smaller last exponent wins
        Order::DegRevLex => std::iter::once(d).chain(e.iter().rev().map(|&x| u64::MAX - x as u64)).collect(),
    }
}

/// The reduced Groebner basis in order o2 of the ideal whose reduced basis
/// in o1 is g (monic, terms by decreasing monomial, words in pk), modulo
/// md.n < 2^31; None if the ideal is not zero-dimensional.  The elements
/// by decreasing leading monomial in o2.
pub fn fglm_p(pk: Packing, o1: Order, g: &[P], o2: Order, md: &Modulus) -> Result<Option<Vec<EP>>, Overflow> {
    let n = pk.n;
    let p = md.n;
    if g.iter().any(|f| f[0].0 == 0) {
        // the unit ideal
        return Ok(Some(vec![vec![(vec![0; n], 1)]]));
    }
    if !zero_dimensional(pk, g) {
        return Ok(None);
    }
    let guard = pk.guard();
    let lead: Vec<u64> = g.iter().map(|f| f[0].0).collect();
    let divides = |a: u64, b: u64| ((b | guard) - a) & guard == guard;
    let standard = |w: u64| !lead.iter().any(|&l| divides(l, w));
    let unit: Vec<u64> = (0..n).map(|i| {
        let mut e = vec![0u64; n];
        e[i] = 1;
        pk.pack(&e)
    }).collect();
    // the staircase, by breadth from 1
    let mut stair: Vec<u64> = vec![0];
    let mut index: HashMap<u64, usize> = HashMap::from([(0, 0)]);
    let mut k = 0;
    while k < stair.len() {
        let b = stair[k];
        k += 1;
        for &u in &unit {
            let c = b + u;
            if c & guard != 0 {
                return Err(Overflow);
            }
            if !index.contains_key(&c) && standard(c) {
                index.insert(c, stair.len());
                stair.push(c);
            }
        }
    }
    let d = stair.len();
    // the border and its normal forms, by one reduction
    let mut border: Vec<u64> = vec![];
    let mut seen: HashSet<u64> = HashSet::new();
    for &b in &stair {
        for &u in &unit {
            let c = b + u;
            if !index.contains_key(&c) && seen.insert(c) {
                border.push(c);
            }
        }
    }
    let sym = F4 { pk, o: o1, md, guard, g: g.to_vec(), lead: lead.clone(), active: vec![true; g.len()], sugar: vec![0; g.len()], pairs: vec![], prob: false };
    let mut pivots = HashMap::new();
    let cols = sym.preprocess(&mut pivots, &mut border.iter().copied())?;
    let col: HashMap<u64, u32> = cols.iter().enumerate().map(|(i, &(_, w))| (w, i as u32)).collect();
    let nc = cols.len();
    let store: Vec<Row> = pivots.values().map(|&(m, i)| {
        let mut r = Row::default();
        for &(w, c) in &g[i] {
            r.cols.push(col[&(w + m)]);
            r.vals.push(c as u32);
        }
        r
    }).collect();
    let mut at: Vec<Option<&Row>> = vec![None; nc];
    for r in &store {
        at[r.cols[0] as usize] = Some(r);
    }
    let rows: Vec<Row> = border.iter().map(|w| Row { cols: vec![col[w]], vals: vec![1] }).collect();
    let red = spelim::reduce_auto(&Pivots { p: p as u32, rows: at }, &rows, nc, crate::threads());
    // NF(c): the unit row reduced (its leading entry cancelled), on the
    // staircase
    let mut nf: HashMap<u64, Vec<(u32, u32)>> = HashMap::new();
    for (w, r) in border.iter().zip(red) {
        let mut v = Vec::with_capacity(r.len());
        for (&c, &x) in r.cols.iter().zip(&r.vals) {
            let Some(&j) = index.get(&cols[c as usize].1) else {
                // a non-standard monomial left: g is not a reduced basis
                return Ok(None);
            };
            v.push((j as u32, x));
        }
        nf.insert(*w, v);
    }
    // the multiplication by x_i on the staircase: column b is NF(x_i b)
    let mult: Vec<Vec<Vec<(u32, u32)>>> = unit.iter().map(|&u| {
        stair.iter().map(|&b| {
            let c = b + u;
            match index.get(&c) {
                Some(&j) => vec![(j as u32, 1)],
                None => nf[&c].clone(),
            }
        }).collect()
    }).collect();
    // the walk in the target order
    let red64 = |x: u64| x % p;
    let apply = |i: usize, v: &[u32]| -> Vec<u32> {
        let mut acc = vec![0u64; d];
        for (b, &x) in v.iter().enumerate() {
            if x != 0 {
                for &(j, y) in &mult[i][b] {
                    let a = &mut acc[j as usize];
                    *a = red64(*a + x as u64 * y as u64);
                }
            }
        }
        acc.into_iter().map(|x| x as u32).collect()
    };
    // the standard monomials found, their vectors echelonized: row k has
    // its pivot at piv[k], is monic there, and equals sum_j tr[k][j] v(s_j)
    let mut smon: Vec<Vec<u32>> = vec![];
    let mut svec: Vec<Vec<u32>> = vec![];
    let mut ech: Vec<Vec<u32>> = vec![];
    let mut piv: Vec<usize> = vec![];
    let mut tr: Vec<Vec<u32>> = vec![];
    let mut leads: Vec<Vec<u32>> = vec![];
    let mut out: Vec<EP> = vec![];
    // candidates: (key, monomial, parent standard index, variable)
    let mut heap: BinaryHeap<Reverse<(Vec<u64>, Vec<u32>, usize, usize)>> = BinaryHeap::new();
    let mut visited: HashSet<Vec<u32>> = HashSet::new();
    let one: Vec<u32> = vec![0; n];
    let mut v1 = vec![0u32; d];
    v1[index[&0]] = 1;
    // the walk starts at 1, standard (not the unit ideal)
    let add_standard = |mono: Vec<u32>, v: Vec<u32>, e: Vec<u32>, pv: usize, t: Vec<u32>, heap: &mut BinaryHeap<Reverse<(Vec<u64>, Vec<u32>, usize, usize)>>, smon: &mut Vec<Vec<u32>>, svec: &mut Vec<Vec<u32>>, ech: &mut Vec<Vec<u32>>, piv: &mut Vec<usize>, tr: &mut Vec<Vec<u32>>| {
        let s = smon.len();
        for i in 0..n {
            let mut m = mono.clone();
            m[i] += 1;
            heap.push(Reverse((key(o2, &m), m, s, i)));
        }
        smon.push(mono);
        svec.push(v);
        ech.push(e);
        piv.push(pv);
        tr.push(t);
    };
    add_standard(one.clone(), v1.clone(), v1, index[&0], vec![1], &mut heap, &mut smon, &mut svec, &mut ech, &mut piv, &mut tr);
    visited.insert(one);
    while let Some(Reverse((_, m, parent, var))) = heap.pop() {
        if !visited.insert(m.clone()) {
            continue;
        }
        if leads.iter().any(|l| l.iter().zip(&m).all(|(a, b)| a <= b)) {
            continue;
        }
        sagebrush_interrupt::check();
        let v = apply(var, &svec[parent]);
        // reduce by the echelon rows, keeping the combination
        let mut w: Vec<u64> = v.iter().map(|&x| x as u64).collect();
        let mut comb: Vec<u64> = vec![0; smon.len()];
        for k in 0..ech.len() {
            let c = w[piv[k]];
            if c == 0 {
                continue;
            }
            let f = p - c;
            for (a, &b) in w.iter_mut().zip(&ech[k]) {
                if b != 0 {
                    *a = red64(*a + f * b as u64);
                }
            }
            // comb -= c tr[k]
            for (a, &b) in comb.iter_mut().zip(&tr[k]) {
                if b != 0 {
                    *a = red64(*a + f * b as u64);
                }
            }
        }
        match w.iter().position(|&x| x != 0) {
            None => {
                // m + comb (as sum over s_j) = 0 in A: m - sum c_j s_j
                let mut f: EP = vec![(m.clone(), 1)];
                let mut tail: Vec<(Vec<u64>, Vec<u32>, u64)> = vec![];
                for (j, &c) in comb.iter().enumerate() {
                    if c != 0 {
                        tail.push((key(o2, &smon[j]), smon[j].clone(), c));
                    }
                }
                tail.sort_by(|a, b| b.0.cmp(&a.0));
                f.extend(tail.into_iter().map(|(_, e, c)| (e, c)));
                out.push(f);
                leads.push(m);
            }
            Some(pv) => {
                // standard: a new echelon row, monic at pv
                let inv = md.inv(w[pv]).unwrap();
                let e: Vec<u32> = w.iter().map(|&x| md.mul(x, inv) as u32).collect();
                let mut t: Vec<u32> = comb.iter().map(|&x| md.mul(x, inv) as u32).collect();
                t.push(inv as u32);
                add_standard(m, v, e, pv, t, &mut heap, &mut smon, &mut svec, &mut ech, &mut piv, &mut tr);
            }
        }
    }
    debug_assert_eq!(smon.len(), d);
    out.sort_by(|a, b| key(o2, &b[0].0).cmp(&key(o2, &a[0].0)));
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::QPoly;

    #[test]
    fn lex_from_degrevlex() {
        // x^2 + y^2 - 5, x y - 2 over GF(32003): the lex basis is
        // [x + y^3/2 - 5y/2... ] (shape position): compare with F4 in lex
        let p = 32003u64;
        let fs: Vec<QPoly> = ["2,0:1;0,2:1;0,0:-5", "1,1:1;0,0:-2"].iter().map(|s| {
            let f = QPoly::from_text(2, s).unwrap();
            QPoly { num: f.num.reduce_mod(p), den: sagebrush_bigint::BigInt::from(1), p }
        }).collect();
        let md = Modulus::new(p);
        let pk = Packing { n: 2, bits: 8 };
        let words: Vec<Vec<(u64, u64)>> = fs.iter().map(|f| crate::gcd::reduce(&f.num.repack(8), p)).collect();
        let (_, g) = crate::f4::f4_p(pk, Order::DegRevLex, &md, &words).unwrap();
        let lex = fglm_p(pk, Order::DegRevLex, &g, Order::Lex, &md).unwrap().unwrap();
        let (pkl, want) = crate::f4::f4_p(pk, Order::Lex, &md, &words).unwrap();
        let want: Vec<Vec<(Vec<u64>, u64)>> = want.iter().map(|f| f.iter().map(|&(w, c)| (pkl.unpack(w), c)).collect()).collect();
        let got: Vec<Vec<(Vec<u64>, u64)>> = lex.iter().map(|f| f.iter().map(|(e, c)| (e.iter().map(|&x| x as u64).collect(), *c)).collect()).collect();
        assert_eq!(got, want);
    }
}

// ------------------------------------------------------------ the front

/// A polynomial with exponent vectors and rational coefficients, by
/// decreasing monomial (over GF(p): the residues as integers).
pub type QEP = Vec<(Vec<u32>, sagebrush_bigint::BigRational)>;

/// The reduced basis g (QPolys mod p, monic) as words in the packing
/// pk, terms by decreasing monomial in o.
fn words_p(g: &[crate::QPoly], pk: Packing, o: Order) -> Vec<P> {
    g.iter().map(|f| {
        let z = f.num.repack(pk.bits);
        let mut t: Vec<(u128, u64, u64)> = (0..z.len()).map(|i| (pk.key(o, z.exps[i]), z.exps[i], z.coeffs.big(i).to_u64().unwrap())).collect();
        t.sort_unstable_by(|a, b| b.0.cmp(&a.0));
        t.into_iter().map(|x| (x.1, x.2)).collect()
    }).collect()
}

/// fglm_p from a reduced basis in degrevlex given as QPolys mod p, widening
/// the packing as needed.
fn fglm_from(g: &[crate::QPoly], n: usize, o: Order, md: &Modulus) -> Result<Option<Vec<EP>>, String> {
    let d = g.iter().flat_map(|f| f.num.degrees()).max().unwrap_or(0);
    let maxb = 64 / n as u32;
    let mut bits = (crate::bits_for(2 * d + 2) + 1).min(maxb);
    loop {
        let pk = Packing { n, bits };
        match fglm_p(pk, Order::DegRevLex, &words_p(g, pk, Order::DegRevLex), o, md) {
            Ok(r) => return Ok(r),
            Err(Overflow) => {
                if bits >= maxb {
                    return Err("exponents too large to pack".into());
                }
                bits = (bits * 2).min(maxb);
            }
        }
    }
}

/// The reduced Groebner basis in order o (lex or invlex) of the ideal of fs
/// by FGLM from its degrevlex basis, if the ideal is zero-dimensional (else
/// None): over GF(p) for p > 0 (p < 2^31), else over Q from the images
/// modulo primes of the (checked) degrevlex basis, by CRT and rational
/// reconstruction.  Monic, by decreasing leading monomial.
pub fn groebner_fglm(fs: &[crate::QPoly], o: Order, p: u64, proof: bool) -> Result<Option<Vec<QEP>>, String> {
    use num_traits::One;
    use sagebrush_bigint::{BigInt, BigRational};
    let n = fs.first().map(|f| f.num.n).unwrap_or(0);
    if n == 0 || (p > 0 && p >= 1 << 31) {
        return Ok(None);
    }
    let dbg = std::env::var("SB_F4_DEBUG").is_ok();
    if p > 0 {
        let g = crate::f4::groebner_p(fs, Order::DegRevLex, p)?;
        let md = Modulus::new(p);
        let Some(b) = fglm_from(&g, n, o, &md)? else { return Ok(None) };
        return Ok(Some(b.into_iter().map(|f| f.into_iter().map(|(e, c)| (e, BigRational::from_integer(BigInt::from(c)))).collect()).collect()));
    }
    let g = crate::f4::groebner_q_opt(fs, Order::DegRevLex, proof)?;
    let t0 = dbg.then(std::time::Instant::now);
    // the primes not dividing a denominator of the degrevlex basis
    let dens: Vec<BigInt> = g.iter().map(|f| f.den.clone()).collect();
    let mut primes = crate::gcd::Primes::below(1 << 31).filter(move |&q| dens.iter().all(|d| sagebrush_bigint::rem_u64(d, q) != 0));
    let image = |&q: &u64| -> Result<Option<Vec<EP>>, String> {
        let md = Modulus::new(q);
        let gq: Vec<crate::QPoly> = g.iter().map(|f| {
            let dinv = BigInt::from(md.inv(sagebrush_bigint::rem_u64(&f.den, q)).unwrap());
            crate::QPoly { num: f.num.scale(&dinv).reduce_mod(q), den: BigInt::one(), p: q }
        }).collect();
        fglm_from(&gq, n, o, &md)
    };
    // the monomials of the images, numbered (columns of the rows)
    let mut mono: HashMap<Vec<u32>, u32> = HashMap::new();
    let mut monos: Vec<Vec<u32>> = vec![];
    let mut shape: Option<Vec<Vec<u32>>> = None;
    let mut imgs: Vec<(u64, Vec<Row>)> = vec![];
    let (mut hard, mut done) = ((0usize, 0usize), vec![]);
    let threads = crate::threads();
    let mut want = 2usize;
    let (mut trec, mut timg) = (0.0f64, 0.0f64);
    let mut last_try = 0usize;
    loop {
        sagebrush_interrupt::check();
        let ps: Vec<u64> = (&mut primes).take(want.clamp(1, threads.max(1))).collect();
        let ti = dbg.then(std::time::Instant::now);
        let res = crate::run_parallel(threads, &ps, image);
        timg += ti.map_or(0.0, |t| t.elapsed().as_secs_f64());
        for (q, r) in ps.iter().zip(res) {
            let Some(b) = r? else { return Ok(None) };
            // unlucky primes give other leading monomials: keep the most
            // common shape (the first, unless two later ones disagree)
            let leads: Vec<Vec<u32>> = b.iter().map(|f| f[0].0.clone()).collect();
            match &shape {
                None => shape = Some(leads),
                Some(s) if *s != leads => continue,
                _ => {}
            }
            let rows: Vec<Row> = b.iter().map(|f| {
                let mut t: Vec<(u32, u32)> = f.iter().map(|(e, c)| {
                    let id = *mono.entry(e.clone()).or_insert_with(|| {
                        monos.push(e.clone());
                        monos.len() as u32 - 1
                    });
                    (id, *c as u32)
                }).collect();
                t.sort_unstable();
                Row { cols: t.iter().map(|x| x.0).collect(), vals: t.iter().map(|x| x.1).collect() }
            }).collect();
            imgs.push((*q, rows));
        }
        want = imgs.len().max(2);
        if imgs.is_empty() {
            continue;
        }
        // (an attempt each time the primes grew by a quarter: each costs a
        // reconstruction of numbers as large as the modulus)
        if imgs.len() * 4 < last_try * 5 {
            continue;
        }
        last_try = imgs.len();
        let v: Vec<(u64, &[Row])> = imgs.iter().map(|(q, r)| (*q, r.as_slice())).collect();
        let tr = dbg.then(std::time::Instant::now);
        let rec = crate::f4q::reconstruct_rows_opt(&v, 60, false, true, &mut hard, &mut done);
        trec += tr.map_or(0.0, |t| t.elapsed().as_secs_f64());
        let Some(rows) = rec else { continue };
        if dbg {
            eprintln!("fglm: lex basis over Q with {} primes in {:.3}s (images {:.3}s, reconstruction {:.3}s)", imgs.len(), t0.map_or(0.0, |t| t.elapsed().as_secs_f64()), timg, trec);
        }
        let o2 = o;
        let out: Vec<QEP> = rows.into_iter().map(|(den, ents)| {
            let mut f: QEP = ents.into_iter().map(|(c, x)| (monos[c as usize].clone(), BigRational::new(x, den.clone()))).collect();
            f.sort_by(|a, b| key(o2, &b.0).cmp(&key(o2, &a.0)));
            let lc = f[0].1.clone();
            f.into_iter().map(|(e, c)| (e, c / &lc)).collect()
        }).collect();
        if proof && !check_q(fs, &out, o)? {
            if dbg {
                eprintln!("fglm: the lex basis over Q failed its check");
            }
            return Ok(None);
        }
        return Ok(Some(out));
    }
}

/// The check of a candidate basis over Q in a lex order (Arnold, Thm 7.1):
/// its leading monomials are those of the basis modulo a prime (degrevlex
/// by F4, then FGLM: a basis of the ideal of fs mod p), the generators and
/// the S-pairs reduce to 0.  In a word packing by verify_q (the
/// certificate); else by reductions over Z on exponent vectors (shape
/// position, the common case, has coprime leading monomials: no pairs).
fn check_q(fs: &[crate::QPoly], g: &[QEP], o: Order) -> Result<bool, String> {
    use sagebrush_bigint::BigInt;
    use num_traits::One;
    let dbg = std::env::var("SB_F4_DEBUG").is_ok();
    let t0 = dbg.then(std::time::Instant::now);
    let n = fs[0].num.n;
    // the leading monomials modulo a prime not dividing a denominator
    let q = crate::gcd::Primes::below(1 << 31).find(|&q| fs.iter().all(|f| sagebrush_bigint::rem_u64(&f.den, q) != 0)).unwrap();
    let md = Modulus::new(q);
    let fq: Vec<crate::QPoly> = fs.iter().map(|f| {
        let dinv = BigInt::from(md.inv(sagebrush_bigint::rem_u64(&f.den, q)).unwrap());
        crate::QPoly { num: f.num.scale(&dinv).reduce_mod(q), den: BigInt::one(), p: q }
    }).collect();
    let gq = crate::f4::groebner_p(&fq, Order::DegRevLex, q)?;
    let Some(lq) = fglm_from(&gq, n, o, &md)? else { return Ok(false) };
    if lq.len() != g.len() || lq.iter().zip(g).any(|(a, b)| a[0].0 != b[0].0) {
        return Ok(false);
    }
    let maxe = g.iter().flat_map(|f| f.iter().flat_map(|t| t.0.iter().copied())).max().unwrap_or(0) as u64;
    let bits = crate::bits_for(2 * maxe + 2) + 1;
    let ok = if (n as u32) * bits <= 64 {
        let pk = Packing { n, bits };
        let cand: Vec<crate::sparse::Poly<crate::sparse::QQ>> = g.iter().map(|f| {
            crate::sparse::Poly::from_terms(&crate::sparse::QQ, pk, o, f.iter().map(|(e, c)| (pk.pack(&e.iter().map(|&x| x as u64).collect::<Vec<_>>()), c.clone())).collect())
        }).collect();
        crate::f4::verify_q(fs, &cand, o, pk)?
    } else {
        check_ev(fs, g, o)
    };
    if dbg {
        eprintln!("fglm: lex basis checked ({}) in {:.3}s", ok, t0.map_or(0.0, |t| t.elapsed().as_secs_f64()));
    }
    Ok(ok)
}

/// An integer polynomial on exponent vectors: (key, exponents, coefficient)
/// by decreasing key.
type ZE = Vec<(Vec<u64>, Vec<u32>, sagebrush_bigint::BigInt)>;

fn to_ze(f: &QEP, o: Order) -> ZE {
    use num_integer::Integer;
    use num_traits::{One, Signed, Zero};
    use sagebrush_bigint::BigInt;
    let mut den = BigInt::one();
    for (_, c) in f {
        den = den.lcm(c.denom());
    }
    let mut t: ZE = f.iter().map(|(e, c)| (key(o, e), e.clone(), c.numer() * (&den / c.denom()))).collect();
    t.sort_by(|a, b| b.0.cmp(&a.0));
    let mut g = BigInt::zero();
    for x in &t {
        g = g.gcd(&x.2);
    }
    if t.first().is_some_and(|x| x.2.is_negative()) {
        g = -g;
    }
    for x in t.iter_mut() {
        x.2 = &x.2 / &g;
    }
    t
}

/// Whether f reduces to 0 by g (fraction-free top reductions, the content
/// removed now and then), on exponent vectors.
fn reduces_to_zero_ev(f: ZE, g: &[ZE], o: Order) -> bool {
    use num_integer::Integer;
    use num_traits::{One, Zero};
    use sagebrush_bigint::BigInt;
    use std::collections::BTreeMap;
    let mut cur: BTreeMap<Vec<u64>, (Vec<u32>, BigInt)> = f.into_iter().map(|(k, e, c)| (k, (e, c))).collect();
    let mut steps = 0u64;
    while let Some((_, (e, c))) = cur.pop_last() {
        steps += 1;
        if steps & 63 == 0 {
            sagebrush_interrupt::check();
        }
        let Some(r) = g.iter().filter(|h| h[0].1.iter().zip(&e).all(|(a, b)| a <= b)).min_by_key(|h| (h[0].2.bits(), h.len())) else { return false };
        let m: Vec<u32> = e.iter().zip(&r[0].1).map(|(a, b)| a - b).collect();
        let lg = &r[0].2;
        let d = c.gcd(lg);
        let (a, b) = (lg / &d, &c / &d);
        if !a.is_one() {
            for v in cur.values_mut() {
                v.1 = &v.1 * &a;
            }
        }
        for (_, re, rc) in &r[1..] {
            let x: Vec<u32> = re.iter().zip(&m).map(|(u, v)| u + v).collect();
            let k = key(o, &x);
            let t = &b * rc;
            match cur.get_mut(&k) {
                Some(v) => {
                    v.1 = &v.1 - &t;
                    if v.1.is_zero() {
                        cur.remove(&k);
                    }
                }
                None => {
                    cur.insert(k, (x, -t));
                }
            }
        }
        if steps % 8 == 0 && !cur.is_empty() {
            let mut ct = BigInt::zero();
            for v in cur.values() {
                ct = ct.gcd(&v.1);
                if ct.is_one() {
                    break;
                }
            }
            if !ct.is_one() {
                for v in cur.values_mut() {
                    v.1 = &v.1 / &ct;
                }
            }
        }
    }
    true
}

/// The generators and the S-pairs (Gebauer-Moeller, as gm_pairs) reduce to
/// 0 by g, on exponent vectors.
fn check_ev(fs: &[crate::QPoly], g: &[QEP], o: Order) -> bool {
    let gz: Vec<ZE> = g.iter().map(|f| to_ze(f, o)).collect();
    for f in fs {
        let pk = Packing { n: f.num.n, bits: f.num.bits };
        let q: QEP = (0..f.num.len()).map(|i| (pk.unpack(f.num.exps[i]).into_iter().map(|x| x as u32).collect(), sagebrush_bigint::BigRational::from_integer(f.num.coeffs.big(i)))).collect();
        if !reduces_to_zero_ev(to_ze(&q, o), &gz, o) {
            return false;
        }
    }
    let lead: Vec<&Vec<u32>> = gz.iter().map(|f| &f[0].1).collect();
    let lcm = |a: &[u32], b: &[u32]| -> Vec<u32> { a.iter().zip(b).map(|(x, y)| *x.max(y)).collect() };
    let divides = |a: &[u32], b: &[u32]| a.iter().zip(b).all(|(x, y)| x <= y);
    let coprime = |a: &[u32], b: &[u32]| a.iter().zip(b).all(|(x, y)| *x == 0 || *y == 0);
    let mut idx: Vec<usize> = (0..gz.len()).collect();
    idx.sort_by(|&a, &b| gz[a][0].0.cmp(&gz[b][0].0));
    let mut pairs: Vec<(usize, usize, Vec<u32>)> = vec![];
    let mut done: Vec<usize> = vec![];
    for &h in &idx {
        let lh = lead[h];
        let mut c: Vec<usize> = done.clone();
        let mut d: Vec<usize> = vec![];
        while !c.is_empty() {
            let i = c.remove(0);
            let li = lcm(lead[i], lh);
            if coprime(lead[i], lh) || !c.iter().chain(d.iter()).any(|&j| divides(&lcm(lead[j], lh), &li)) {
                d.push(i);
            }
        }
        pairs.retain(|(a, b, l)| !(divides(lh, l) && lcm(lead[*a], lh) != *l && lcm(lead[*b], lh) != *l));
        for i in d {
            if !coprime(lead[i], lh) {
                pairs.push((i, h, lcm(lead[i], lh)));
            }
        }
        done.push(h);
    }
    let check = |(i, j, l): &(usize, usize, Vec<u32>)| -> bool {
        use num_integer::Integer;
        let (ci, cj) = (&gz[*i][0].2, &gz[*j][0].2);
        let d = ci.gcd(cj);
        let (a, b) = (cj / &d, ci / &d);
        let mut t: std::collections::BTreeMap<Vec<u64>, (Vec<u32>, sagebrush_bigint::BigInt)> = Default::default();
        for (k, s, neg) in [(*i, &a, false), (*j, &b, true)] {
            let m: Vec<u32> = l.iter().zip(&gz[k][0].1).map(|(x, y)| x - y).collect();
            for (_, e, c) in &gz[k][1..] {
                let x: Vec<u32> = e.iter().zip(&m).map(|(u, v)| u + v).collect();
                let kk = key(o, &x);
                let v = if neg { -(s * c) } else { s * c };
                let ent = t.entry(kk).or_insert_with(|| (x, num_traits::Zero::zero()));
                ent.1 += v;
            }
        }
        let sp: ZE = t.into_iter().rev().filter(|(_, (_, c))| !num_traits::Zero::is_zero(c)).map(|(k, (e, c))| (k, e, c)).collect();
        reduces_to_zero_ev(sp, &gz, o)
    };
    crate::run_parallel(crate::threads(), &pairs, check).into_iter().all(|x| x)
}
