//! A signature-based F4 over GF(p), p < 2^31, for homogeneous ideals: the
//! S-pairs that would reduce to zero are recognized from their signatures
//! and never built (Faugère's F5 criterion, in the matrix form of
//! Faugère's MatrixF5 and of the rewrite bases surveyed by Eder and
//! Faugère, "A survey on signature-based algorithms for computing Gröbner
//! bases", 2017).
//!
//! An element is a polynomial f with a signature u e_i: f = sum c_j f_j
//! with u e_i the leading module monomial (orders: degree, then the index
//! i, then u).  Degree by degree (homogeneous input):
//!
//! - the signatures T of the degree come from the generators and the S-pairs
//!   (the larger signature of the two halves; singular pairs, of equal
//!   signatures, are useless); T is dropped if a known syzygy signature
//!   divides it (Koszul syzygies lt(g) e_j of elements g of smaller index,
//!   and the signatures of earlier reductions to zero);
//! - the row of signature T is the multiple of its canonical rewriter, the
//!   last element added whose signature divides T;
//! - symbolic preprocessing adds, for every monomial, the multiple of
//!   smallest signature of an element whose leading monomial divides it;
//! - the rows are reduced in increasing signature, each by the rows before
//!   it only (regular reductions); a row whose leading monomial changes
//!   (or a generator) gives a new element, a row that vanishes a syzygy.
//!
//! The polynomials of the result form a Gröbner basis (Lemma 4.6 there).
//!
//! Status (Oct 2026): correct (random ideals against Singular, the
//! benchmarks), almost no reductions to zero, but slower than F4: the
//! basis is not interreduced between degrees (F5C) and the pairs, without
//! the product and chain criteria, are many (they also reach higher
//! degrees); the elimination is sequential.  Experimental (SB_SIGF4).

use crate::order::{Order, Packing};
use crate::sparse::Overflow;
use sagebrush_arith::spelim::Row;
use sagebrush_bigint::nmod::Modulus;
use std::collections::{HashMap, HashSet};

type P = Vec<(u64, u64)>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Sig {
    idx: u32,
    mono: u64,
}

struct Elem {
    sig: Sig,
    poly: P,
    lead: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Kind {
    // a generator or the row of an S-pair signature: reduced, and new
    // information if its leading monomial changes
    Pair,
    // a reducer from symbolic preprocessing
    Red,
}

struct Ctx {
    pk: Packing,
    o: Order,
    guard: u64,
    elems: Vec<Elem>,
    // per index: monomials m with m e_i a syzygy signature
    syz: Vec<Vec<u64>>,
}

impl Ctx {
    #[inline]
    fn divides(&self, a: u64, b: u64) -> bool {
        ((b | self.guard) - a) & self.guard == self.guard
    }

    /// The order of signatures (of equal degree): index, then monomial.
    fn sig_key(&self, s: Sig) -> (u32, u128) {
        (s.idx, self.pk.key(self.o, s.mono))
    }

    fn is_syzygy(&self, s: Sig) -> bool {
        self.syz[s.idx as usize].iter().any(|&m| self.divides(m, s.mono))
    }

    /// The canonical rewriter of T: the last element whose signature
    /// divides T.
    fn rewriter(&self, t: Sig) -> Option<usize> {
        (0..self.elems.len()).rev().find(|&k| {
            let s = self.elems[k].sig;
            s.idx == t.idx && self.divides(s.mono, t.mono)
        })
    }

    fn add_elem(&mut self, sig: Sig, poly: P) {
        let lead = poly[0].0;
        // Koszul syzygies: lt(g) e_j for the larger indices j
        for j in sig.idx as usize + 1..self.syz.len() {
            add_minimal(&mut self.syz[j], lead, self.guard);
        }
        self.elems.push(Elem { sig, poly, lead });
    }
}

/// m added to a list of monomials kept minimal for divisibility.
fn add_minimal(list: &mut Vec<u64>, m: u64, guard: u64) {
    let div = |a: u64, b: u64| ((b | guard) - a) & guard == guard;
    if list.iter().any(|&x| div(x, m)) {
        return;
    }
    list.retain(|&x| !div(m, x));
    list.push(m);
}

/// The polynomials of a signature Gröbner basis of the homogeneous fs
/// (monic; not reduced), over GF(p) for p < 2^31.
pub fn sig_basis(pk: Packing, o: Order, md: &Modulus, fs: &[P]) -> Result<Vec<P>, Overflow> {
    let p = md.n as u32;
    let guard = pk.guard();
    // the generators: monic, by increasing degree
    let mut gens: Vec<P> = fs.iter().filter(|f| !f.is_empty()).map(|f| {
        let mut t: Vec<(u128, u64, u64)> = f.iter().filter(|x| x.1 != 0).map(|&(w, c)| (pk.key(o, w), w, c)).collect();
        t.sort_unstable_by(|a, b| b.0.cmp(&a.0));
        let inv = md.inv(t[0].2).unwrap();
        t.into_iter().map(|(_, w, c)| (w, md.mul(c, inv))).collect()
    }).filter(|f: &P| !f.is_empty()).collect();
    gens.sort_by_key(|f| pk.degree(f[0].0));
    if gens.iter().flatten().any(|x| x.0 & guard != 0) {
        return Err(Overflow);
    }
    let m = gens.len();
    let mut cx = Ctx { pk, o, guard, elems: vec![], syz: vec![vec![]; m] };
    // pairs (a, b) of elements, by degree of their lcm
    let mut pairs: Vec<(u64, usize, usize)> = vec![];
    let mut next_gen = 0usize;
    loop {
        sagebrush_interrupt::check();
        let dg = gens.get(next_gen).map(|f| pk.degree(f[0].0));
        let dp = pairs.iter().map(|q| q.0).min();
        let d = match (dg, dp) {
            (None, None) => break,
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
        };
        // the signatures of this degree and their rows
        let mut rows: Vec<(Sig, Kind, u64, usize, bool)> = vec![]; // (sig, kind, multiplier, element or generator, is generator)
        let mut seen: HashSet<(u32, u64)> = HashSet::new();
        while next_gen < m && pk.degree(gens[next_gen][0].0) == d {
            let s = Sig { idx: next_gen as u32, mono: 0 };
            seen.insert((s.idx, s.mono));
            rows.push((s, Kind::Pair, 0, next_gen, true));
            next_gen += 1;
        }
        let tpairs = std::env::var("SB_F4_DEBUG").is_ok().then(std::time::Instant::now);
        let (now, later): (Vec<_>, Vec<_>) = pairs.into_iter().partition(|q| q.0 == d);
        pairs = later;
        for (_, a, b) in now {
            let (ea, eb) = (&cx.elems[a], &cx.elems[b]);
            let l = pk.lcm(ea.lead, eb.lead);
            let sa = Sig { idx: ea.sig.idx, mono: ea.sig.mono + (l - ea.lead) };
            let sb = Sig { idx: eb.sig.idx, mono: eb.sig.mono + (l - eb.lead) };
            if sa == sb {
                continue; // singular
            }
            let t = if cx.sig_key(sa) > cx.sig_key(sb) { sa } else { sb };
            if t.mono & guard != 0 {
                return Err(Overflow);
            }
            let nosyz = std::env::var("SB_SIG_NOSYZ").is_ok();
            let norew = std::env::var("SB_SIG_NOREW").is_ok();
            if !seen.insert((t.idx, t.mono)) || (!nosyz && cx.is_syzygy(t)) {
                continue;
            }
            let g = if norew {
                if t == sa { a } else { b }
            } else {
                match cx.rewriter(t) {
                    Some(g) => g,
                    None => continue,
                }
            };
            let u = t.mono - cx.elems[g].sig.mono;
            rows.push((t, Kind::Pair, u, g, false));
        }
        if let Some(t) = tpairs {
            eprintln!("sigf4: deg {} pair selection {:.3}s ({} pairs left)", d, t.elapsed().as_secs_f64(), pairs.len());
        }
        if rows.is_empty() {
            continue;
        }
        // the polynomial of a row
        let row_terms = |cx: &Ctx, r: &(Sig, Kind, u64, usize, bool)| -> Vec<(u64, u64)> {
            let poly = if r.4 { &gens[r.3] } else { &cx.elems[r.3].poly };
            poly.iter().map(|&(w, c)| (w + r.2, c)).collect()
        };
        let tdbg = std::env::var("SB_F4_DEBUG").is_ok().then(std::time::Instant::now);
        // symbolic preprocessing: a reducer of smallest signature for every
        // monomial divisible by a leading monomial
        let mut monos: HashSet<u64> = HashSet::new();
        let mut queue: Vec<u64> = vec![];
        for r in &rows {
            for (w, _) in row_terms(&cx, r) {
                if w & guard != 0 {
                    return Err(Overflow);
                }
                if monos.insert(w) {
                    queue.push(w);
                }
            }
        }
        let mut reducers: Vec<(Sig, Kind, u64, usize, bool)> = vec![];
        while let Some(w) = queue.pop() {
            let mut best: Option<(Sig, u64, usize)> = None;
            for (k, e) in cx.elems.iter().enumerate() {
                if cx.divides(e.lead, w) {
                    let u = w - e.lead;
                    let s = Sig { idx: e.sig.idx, mono: e.sig.mono + u };
                    if best.is_none_or(|b| cx.sig_key(s) < cx.sig_key(b.0)) {
                        best = Some((s, u, k));
                    }
                }
            }
            let Some((s, u, k)) = best else { continue };
            if s.mono & guard != 0 {
                return Err(Overflow);
            }
            let r = (s, Kind::Red, u, k, false);
            for (x, _) in row_terms(&cx, &r) {
                if x & guard != 0 {
                    return Err(Overflow);
                }
                if monos.insert(x) {
                    queue.push(x);
                }
            }
            reducers.push(r);
        }
        rows.extend(reducers);
        let tpre = tdbg.map(|t| t.elapsed().as_secs_f64());
        // columns: the monomials, decreasing
        let mut cols: Vec<(u128, u64)> = monos.iter().map(|&w| (pk.key(o, w), w)).collect();
        cols.sort_unstable_by(|a, b| b.0.cmp(&a.0));
        let col: HashMap<u64, u32> = cols.iter().enumerate().map(|(i, &(_, w))| (w, i as u32)).collect();
        let nc = cols.len();
        // rows by increasing signature (a reducer after the pair row of the
        // same signature)
        rows.sort_by(|a, b| cx.sig_key(a.0).cmp(&cx.sig_key(b.0)).then(a.1.cmp(&b.1)));
        let mut piv: Vec<u32> = vec![u32::MAX; nc];
        let mut store: Vec<Row> = vec![];
        let mut acc: Vec<i64> = vec![0; nc];
        let pp = p as i64;
        let p2 = pp * pp;
        let mut new: Vec<(Sig, P)> = vec![];
        let mut zeros: Vec<Sig> = vec![];
        let mut prev: Option<Sig> = None;
        for r in &rows {
            // a row of the same signature as the one before is reduced by a
            // row of its own signature: not a regular reduction, so its
            // result tells nothing (no syzygy, no new element)
            let regular = prev != Some(r.0);
            prev = Some(r.0);
            let terms = row_terms(&cx, r);
            let mut row = Row::default();
            for (w, c) in &terms {
                row.cols.push(col[w]);
                row.vals.push(*c as u32);
            }
            let lead0 = row.cols[0] as usize;
            if r.1 == Kind::Red && piv[lead0] == u32::MAX {
                // a reducer used as it is
                piv[lead0] = store.len() as u32;
                store.push(row);
                continue;
            }
            // reduce by the rows before (smaller signatures)
            let mut last = 0usize;
            for (&c, &v) in row.cols.iter().zip(&row.vals) {
                acc[c as usize] = v as i64;
                last = last.max(c as usize);
            }
            let mut out = Row::default();
            let mut j = lead0;
            loop {
                let x = acc[j];
                if x != 0 {
                    acc[j] = 0;
                    let c = x % pp;
                    if c != 0 {
                        let k = piv[j];
                        if k != u32::MAX {
                            let pr = &store[k as usize];
                            for (&cc, &v) in pr.cols[1..].iter().zip(&pr.vals[1..]) {
                                let y = acc[cc as usize] - c * v as i64;
                                acc[cc as usize] = y + ((y >> 63) & p2);
                            }
                            last = last.max(*pr.cols.last().unwrap() as usize);
                        } else {
                            out.cols.push(j as u32);
                            out.vals.push(c as u32);
                        }
                    }
                }
                if j >= last {
                    break;
                }
                j += 1;
            }
            if out.is_empty() {
                if regular {
                    zeros.push(r.0);
                }
                continue;
            }
            let out = out.monic(p);
            let lead = out.cols[0] as usize;
            if regular && (lead != lead0 || r.4) {
                new.push((r.0, out.cols.iter().zip(&out.vals).map(|(&j, &c)| (cols[j as usize].1, c as u64)).collect()));
            }
            piv[lead] = store.len() as u32;
            store.push(out);
        }
        if std::env::var("SB_F4_DEBUG").is_ok() {
            eprintln!("sigf4: deg {} rows {} (pairs {}) cols {} new {} zero {} elements {} pre {:.3}s total {:.3}s", d, rows.len(), rows.iter().filter(|r| r.1 == Kind::Pair).count(), nc, new.len(), zeros.len(), cx.elems.len(), tpre.unwrap_or(0.0), tdbg.map_or(0.0, |t| t.elapsed().as_secs_f64()));
        }
        for s in zeros {
            if std::env::var("SB_SIG_NOZERO").is_ok() {
                continue;
            }
            add_minimal(&mut cx.syz[s.idx as usize], s.mono, guard);
        }
        for (s, f) in new {
            let h = cx.elems.len();
            cx.add_elem(s, f);
            for k in 0..h {
                // (no product criterion: it does not respect signatures; the
                // Koszul syzygies take its place)
                let l = pk.lcm(cx.elems[k].lead, cx.elems[h].lead);
                pairs.push((pk.degree(l), k, h));
            }
        }
    }
    Ok(cx.elems.into_iter().map(|e| e.poly).collect())
}
