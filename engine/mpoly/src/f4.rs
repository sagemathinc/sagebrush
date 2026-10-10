//! Groebner bases: Faugere's F4 over GF(p), and over Q by multi-modular
//! reconstruction.
//!
//! F4 over GF(p): the pairs of minimal degree (normal strategy) are reduced
//! together.  Their halves m_i g_i, m_j g_j and, by symbolic preprocessing,
//! a reducer m g for every monomial divisible by a leading monomial become
//! the rows of a matrix with the monomials (decreasing) as columns; the
//! rows to reduce are reduced by the pivot rows and echelonized among
//! themselves, and the rows with new leading monomials join the basis.
//! Pairs are pruned by the Gebauer-Moeller criteria.  The result is the
//! reduced basis (minimal, tails reduced by the same matrix normal form).
//!
//! Over Q: reduced bases modulo primes near 2^62 (unique, so they line up),
//! primes voted lucky by their leading monomials, coefficients combined by
//! CRT and recovered by rational reconstruction until one more prime
//! confirms them; then the candidate is checked over Q (the generators
//! reduce to 0 and so do the S-polynomials, with Buchberger's criteria):
//! with the modular basis having the same leading monomials, that proves
//! it is the reduced basis of the ideal (Arnold; Idrees, Pfister, Steidel).

use crate::order::{Order, Packing};
use crate::sparse::{Overflow, Poly, QQ};
use crate::{QPoly, ZPoly};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::nmod::Modulus;
use sagebrush_bigint::{BigInt, BigRational};
use std::collections::{HashMap, HashSet};

/// A polynomial over GF(p): (word, coefficient) by decreasing key, monic
/// in the basis.
pub(crate) type P = Vec<(u64, u64)>;

thread_local! {
    static LASTCOLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static T0: std::time::Instant = std::time::Instant::now();
    // seconds in symbolic preprocessing, matrix building, reduction (debug)
    static PHASES: std::cell::Cell<[f64; 3]> = const { std::cell::Cell::new([0.0; 3]) };
}

fn phase_add(i: usize, t: Option<std::time::Instant>) {
    if let Some(t) = t {
        PHASES.with(|p| {
            let mut a = p.get();
            a[i] += t.elapsed().as_secs_f64();
            p.set(a);
        });
    }
}

pub(crate) struct Pair {
    i: usize,
    j: usize,
    lcm: u64,
    deg: u64,
}

pub(crate) struct F4<'a> {
    pub(crate) pk: Packing,
    pub(crate) o: Order,
    pub(crate) md: &'a Modulus,
    pub(crate) guard: u64,
    pub(crate) g: Vec<P>,
    pub(crate) lead: Vec<u64>,
    pub(crate) active: Vec<bool>,
    // the sugar degree of each element (the selection strategy)
    pub(crate) sugar: Vec<u64>,
    pub(crate) pairs: Vec<Pair>,
    // probabilistic linear algebra (random combinations of row blocks):
    // for the modular images of a computation checked at the end
    pub(crate) prob: bool,
}

impl<'a> F4<'a> {
    #[inline]
    pub(crate) fn divides(&self, a: u64, b: u64) -> bool {
        // fieldwise a <= b: no borrow into the guard bits
        ((b | self.guard) - a) & self.guard == self.guard
    }

    pub(crate) fn key(&self, w: u64) -> u128 {
        self.pk.key(self.o, w)
    }

    /// A basis element whose leading monomial divides m (an active one if
    /// possible, the one with the fewest terms).
    fn reducer(&self, m: u64) -> Option<usize> {
        let mut best: Option<usize> = None;
        for (i, &l) in self.lead.iter().enumerate() {
            if self.divides(l, m) {
                best = match best {
                    None => Some(i),
                    Some(b) => {
                        let better = (self.active[i], usize::MAX - self.g[i].len()) > (self.active[b], usize::MAX - self.g[b].len());
                        Some(if better { i } else { b })
                    }
                };
            }
        }
        best
    }

    /// Gebauer-Moeller: the pairs of the new element h, and the old pairs
    /// and basis elements it makes useless.
    fn update(&mut self, h: usize) {
        let lh = self.lead[h];
        let pk = self.pk;
        let mut c: Vec<usize> = (0..h).filter(|&i| self.active[i]).collect();
        let mut d: Vec<usize> = vec![];
        while !c.is_empty() {
            let i = c.remove(0);
            let li = pk.lcm(self.lead[i], lh);
            let keep = pk.coprime(self.lead[i], lh) || !c.iter().chain(d.iter()).any(|&j| self.divides(pk.lcm(self.lead[j], lh), li));
            if keep {
                d.push(i);
            }
        }
        let new: Vec<Pair> = d.into_iter().filter(|&i| !pk.coprime(self.lead[i], lh)).map(|i| {
            let l = pk.lcm(self.lead[i], lh);
            let dl = pk.degree(l);
            let s = (self.sugar[i] + dl - pk.degree(self.lead[i])).max(self.sugar[h] + dl - pk.degree(lh));
            Pair { i, j: h, lcm: l, deg: s }
        }).collect();
        let lead = &self.lead;
        self.pairs.retain(|q| {
            !(pk.divides(lh, q.lcm) && pk.lcm(lead[q.i], lh) != q.lcm && pk.lcm(lead[q.j], lh) != q.lcm)
        });
        self.pairs.extend(new);
        for i in 0..h {
            if self.active[i] && self.divides(lh, self.lead[i]) {
                self.active[i] = false;
            }
        }
    }

    pub(crate) fn add(&mut self, f: P, sugar: u64) {
        let s = f.iter().map(|x| self.pk.degree(x.0)).max().unwrap().max(sugar);
        self.sugar.push(s);
        self.lead.push(f[0].0);
        self.g.push(f);
        self.active.push(true);
        let h = self.g.len() - 1;
        self.update(h);
    }

    /// The rows (multiplier, element) to reduce, with the pivot rows given
    /// for some monomials: symbolic preprocessing, then the reduction.
    /// Returns the reduced rows with new leading monomials (monic, as
    /// polynomials) when `echelon`, else every reduced row in order.
    /// Symbolic preprocessing: a pivot (multiplier, element) for every
    /// monomial of the rows (given by their words), and of the pivots'
    /// rows recursively, that a leading monomial divides; the monomials of
    /// all rows, decreasing, as the columns.
    pub(crate) fn preprocess(&self, pivots: &mut HashMap<u64, (u64, usize)>, words: &mut dyn Iterator<Item = u64>) -> Result<Vec<(u128, u64)>, Overflow> {
        let mut monos: HashSet<u64> = HashSet::new();
        let mut queue: Vec<u64> = vec![];
        let see = |m: u64, monos: &mut HashSet<u64>, queue: &mut Vec<u64>| {
            if monos.insert(m) {
                queue.push(m);
            }
        };
        for w in words {
            see(w, &mut monos, &mut queue);
        }
        for &(m, i) in pivots.values() {
            for &(w, _) in &self.g[i] {
                let x = w + m;
                if x & self.guard != 0 {
                    return Err(Overflow);
                }
                see(x, &mut monos, &mut queue);
            }
        }
        while let Some(m) = queue.pop() {
            if pivots.contains_key(&m) {
                continue;
            }
            if let Some(i) = self.reducer(m) {
                let mult = m - self.lead[i];
                pivots.insert(m, (mult, i));
                for &(w, _) in &self.g[i][1..] {
                    let x = w + mult;
                    if x & self.guard != 0 {
                        return Err(Overflow);
                    }
                    see(x, &mut monos, &mut queue);
                }
            }
        }
        if std::env::var("SB_F4_DEBUG").is_ok() {
            eprintln!("f4: preprocessed {} monomials {} reducers t {:.3}", monos.len(), pivots.len(), T0.with(|t| t.elapsed().as_secs_f64()));
        }
        // columns: the monomials, decreasing
        let mut cols: Vec<(u128, u64)> = monos.iter().map(|&w| (self.key(w), w)).collect();
        cols.sort_unstable_by(|a, b| b.0.cmp(&a.0));
        Ok(cols)
    }

    /// The rows (multiplier, element) to reduce, with the pivot rows given
    /// for some monomials: symbolic preprocessing, then the reduction.
    /// Returns the reduced rows with new leading monomials (monic, as
    /// polynomials) when `echelon`, else every reduced row in order.
    fn reduce_rows(&self, mut pivots: HashMap<u64, (u64, usize)>, todo: Vec<P>, echelon: bool) -> Result<Vec<P>, Overflow> {
        let md = self.md;
        let tdbg = std::env::var("SB_F4_DEBUG").is_ok();
        let tp = tdbg.then(std::time::Instant::now);
        let cols = self.preprocess(&mut pivots, &mut todo.iter().flat_map(|r| r.iter().map(|x| x.0)))?;
        phase_add(0, tp);
        let tp = tdbg.then(std::time::Instant::now);
        let col: HashMap<u64, u32> = cols.iter().enumerate().map(|(i, &(_, w))| (w, i as u32)).collect();
        let nc = cols.len();
        LASTCOLS.with(|c| c.set(nc));
        if md.n < 1 << 31 {
            return Ok(self.eliminate31(&pivots, &todo, &cols, &col, echelon, tdbg, tp));
        }
        // pivot rows by their leading column
        let mut prow: Vec<Option<Vec<(u32, u64)>>> = vec![None; nc];
        for (&lm, &(m, i)) in &pivots {
            let r: Vec<(u32, u64)> = self.g[i].iter().map(|&(w, c)| (col[&(w + m)], c)).collect();
            debug_assert_eq!(r[0].0, col[&lm]);
            prow[col[&lm] as usize] = Some(r);
        }
        phase_add(1, tp);
        let tp = tdbg.then(std::time::Instant::now);
        let mut out = vec![];
        let mut dense = vec![0u64; nc];
        for (k, r) in todo.iter().enumerate() {
            if k & 15 == 0 {
                sagebrush_interrupt::check();
            }
            let mut first = nc;
            for &(w, c) in r {
                let j = col[&w] as usize;
                dense[j] = c;
                first = first.min(j);
            }
            let mut lead: Option<usize> = None;
            let mut j = first;
            while j < nc {
                let c = dense[j];
                if c != 0 {
                    if let Some(pr) = &prow[j] {
                        // the pivot rows are monic
                        let f = md.neg(c);
                        for &(cj, pc) in pr {
                            let t = &mut dense[cj as usize];
                            *t = md.add(*t, md.mul(f, pc));
                        }
                    } else if lead.is_none() {
                        lead = Some(j);
                    }
                }
                j += 1;
            }
            let mut row: Vec<(u32, u64)> = vec![];
            for (j, x) in dense.iter_mut().enumerate().skip(first) {
                if *x != 0 {
                    row.push((j as u32, std::mem::replace(x, 0)));
                }
            }
            if echelon {
                if let Some(l) = lead {
                    let inv = md.inv(row[0].1).unwrap();
                    let row: Vec<(u32, u64)> = row.into_iter().map(|(j, c)| (j, md.mul(c, inv))).collect();
                    debug_assert_eq!(row[0].0 as usize, l);
                    out.push(row.iter().map(|&(j, c)| (cols[j as usize].1, c)).collect());
                    prow[l] = Some(row);
                }
            } else {
                out.push(row.iter().map(|&(j, c)| (cols[j as usize].1, c)).collect());
            }
        }
        phase_add(2, tp);
        Ok(out)
    }

    /// The reduction for p < 2^31 by the structured sparse elimination of
    /// sagebrush_arith::spelim: the rows reduced by the known pivots (in
    /// parallel natively), then echelonized among themselves.
    #[allow(clippy::too_many_arguments)]
    fn eliminate31(&self, pivots: &HashMap<u64, (u64, usize)>, todo: &[P], cols: &[(u128, u64)], col: &HashMap<u64, u32>, echelon: bool, tdbg: bool, tp: Option<std::time::Instant>) -> Vec<P> {
        use sagebrush_arith::spelim::{back_reduce, echelonize, Pivots, Row};
        let p = self.md.n as u32;
        let nc = cols.len();
        let to_row = |r: &mut dyn Iterator<Item = (u32, u64)>| -> Row {
            let mut row = Row::default();
            for (c, v) in r {
                row.cols.push(c);
                row.vals.push(v as u32);
            }
            row
        };
        let mut store: Vec<Row> = Vec::with_capacity(pivots.len());
        let mut at: Vec<u32> = vec![u32::MAX; nc];
        for (&lm, &(m, i)) in pivots {
            let r = to_row(&mut self.g[i].iter().map(|&(w, c)| (col[&(w + m)], c)));
            at[col[&lm] as usize] = store.len() as u32;
            store.push(r);
        }
        let rows: Vec<Row> = todo.iter().map(|r| to_row(&mut r.iter().map(|&(w, c)| (col[&w], c)))).collect();
        phase_add(1, tp);
        let tp = tdbg.then(std::time::Instant::now);
        let piv = Pivots { p, rows: at.iter().map(|&k| (k != u32::MAX).then(|| &store[k as usize])).collect() };
        if std::env::var("SB_F4_SHAPE").is_ok() {
            let npiv = store.len();
            let plen: usize = store.iter().map(|r| r.len()).sum();
            let pa: usize = store.iter().map(|r| r.cols[1..].iter().filter(|&&c| at[c as usize] != u32::MAX).count()).sum();
            let ca: usize = rows.iter().map(|r| r.cols.iter().filter(|&&c| at[c as usize] != u32::MAX).count()).sum();
            eprintln!("shape: deg? cols {} pivots {} B-cols {} rows {} | pivot len {:.1} (A part {:.1}) | row A-entries {:.1}", nc, npiv, nc - npiv, rows.len(), plen as f64 / npiv.max(1) as f64, pa as f64 / npiv.max(1) as f64, ca as f64 / rows.len().max(1) as f64);
        }
        let threads = if rows.len() >= 32 { crate::threads() } else { 1 };
        let red = if echelon && self.prob {
            let seed = 0x2545F4914F6CDD1D ^ (self.g.len() as u64) << 20 ^ nc as u64;
            back_reduce(echelonize(piv.reduce_random(&rows, nc, threads, 16, seed), nc, p), nc, p)
        } else {
            let red = match std::env::var("SB_F4_FL").as_deref() {
                Ok("1") => sagebrush_arith::spelim::reduce_fl(&piv, &rows, nc, threads),
                Ok("0") => piv.reduce(&rows, nc, threads),
                _ => sagebrush_arith::spelim::reduce_auto(&piv, &rows, nc, threads),
            };
            if echelon { back_reduce(echelonize(red, nc, p), nc, p) } else { red }
        };
        phase_add(2, tp);
        red.into_iter().map(|r| r.cols.iter().zip(&r.vals).map(|(&j, &c)| (cols[j as usize].1, c as u64)).collect()).collect()
    }

    /// The pairs of minimal degree taken off the queue: their degree, the
    /// pivots (one half of each pair, by lcm) and the rows to reduce (the
    /// other halves), as (multiplier, element).
    pub(crate) fn select(&mut self) -> Result<(u64, HashMap<u64, (u64, usize)>, Vec<(u64, usize)>), Overflow> {
        let dmin = self.pairs.iter().map(|q| q.deg).min().unwrap();
        // degree orders: every pair of the least sugar; otherwise (lex
        // orders, where the reductions of one sugar degree can blow up)
        // only those of the smallest lcm among them, as Buchberger would
        let lmin = match self.o {
            Order::DegRevLex | Order::DegLex => None,
            _ => self.pairs.iter().filter(|q| q.deg == dmin).map(|q| self.key(q.lcm)).min(),
        };
        let (sel, rest): (Vec<Pair>, Vec<Pair>) = std::mem::take(&mut self.pairs).into_iter().partition(|q| q.deg == dmin && lmin.is_none_or(|l| self.pk.key(self.o, q.lcm) == l));
        self.pairs = rest;
        let mut pivots: HashMap<u64, (u64, usize)> = HashMap::new();
        let mut seen: HashSet<(u64, usize)> = HashSet::new();
        let mut todo: Vec<(u64, usize)> = vec![];
        for q in &sel {
            for (idx, other) in [(q.i, false), (q.j, true)] {
                let m = q.lcm - self.lead[idx];
                if !seen.insert((m, idx)) {
                    continue;
                }
                if !other && !pivots.contains_key(&q.lcm) {
                    pivots.insert(q.lcm, (m, idx));
                } else {
                    if self.g[idx].iter().any(|&(w, _)| (w + m) & self.guard != 0) {
                        return Err(Overflow);
                    }
                    todo.push((m, idx));
                }
            }
        }
        Ok((dmin, pivots, todo))
    }

    /// One F4 step on the pairs of minimal degree.
    fn step(&mut self) -> Result<(), Overflow> {
        let (dmin, pivots, sel) = self.select()?;
        let todo: Vec<P> = sel.iter().map(|&(m, idx)| self.g[idx].iter().map(|&(w, c)| (w + m, c)).collect()).collect();
        let npairs = sel.len();
        let ntodo = todo.len();
        let new = self.reduce_rows(pivots, todo, true)?;
        if std::env::var("SB_F4_DEBUG").is_ok() {
            eprintln!("f4: deg {} pairs {} rows {} new {} basis {} left {} cols {} t {:.3}", dmin, npairs, ntodo, new.len(), self.g.len(), self.pairs.len(), LASTCOLS.with(|c| c.get()), T0.with(|t| t.elapsed().as_secs_f64()));
        }
        if std::env::var("SB_F4_DEBUG").is_ok() {
            for f in &new {
                if let Some(i) = self.reducer(f[0].0) {
                    eprintln!("f4: BUG new lead {:?} divisible by lead {:?} of element {}", self.pk.unpack(f[0].0), self.pk.unpack(self.lead[i]), i);
                }
            }
        }
        for f in new {
            self.add(f, dmin);
        }
        Ok(())
    }

    /// The reduced basis: minimal, tails reduced, by decreasing leading
    /// monomial.
    pub(crate) fn reduced(&self) -> Result<Vec<P>, Overflow> {
        let mut idx: Vec<usize> = (0..self.g.len()).filter(|&i| self.active[i]).collect();
        // minimal: no leading monomial divisible by another's
        idx.sort_by_key(|&i| self.key(self.lead[i]));
        let mut minimal: Vec<usize> = vec![];
        for &i in &idx {
            if !minimal.iter().any(|&j| self.divides(self.lead[j], self.lead[i])) {
                minimal.push(i);
            }
        }
        let sub = F4 {
            pk: self.pk,
            o: self.o,
            md: self.md,
            guard: self.guard,
            g: minimal.iter().map(|&i| self.g[i].clone()).collect(),
            lead: minimal.iter().map(|&i| self.lead[i]).collect(),
            active: vec![true; minimal.len()],
            sugar: vec![0; minimal.len()],
            pairs: vec![],
            prob: self.prob,
        };
        if matches!(self.o, Order::Lex | Order::InvLex) {
            return self.interreduce_seq(sub.g);
        }
        let tails: Vec<P> = sub.g.iter().map(|f| f[1..].to_vec()).collect();
        if std::env::var("SB_F4_DEBUG").is_ok() {
            eprintln!("f4: reducing {} of {} (terms {})", minimal.len(), idx.len(), tails.iter().map(|t| t.len()).sum::<usize>());
        }
        let red = sub.reduce_rows(HashMap::new(), tails, false)?;
        let mut out: Vec<P> = sub.g.iter().zip(red).map(|(f, t)| {
            let mut r = vec![f[0]];
            r.extend(t);
            r
        }).collect();
        out.sort_by_key(|f| std::cmp::Reverse(self.key(f[0].0)));
        Ok(out)
    }
}

impl F4<'_> {
    /// Interreduction one element at a time, by increasing leading
    /// monomial, each tail reduced by the reduced smaller elements (with
    /// the cancellations as they come: in lex orders the monomials a
    /// matrix reduction would gather can be far too many).
    fn interreduce_seq(&self, mut g: Vec<P>) -> Result<Vec<P>, Overflow> {
        use crate::sparse::Fp;
        let fl = Fp { p: self.md.n };
        g.sort_by_key(|f| self.key(f[0].0));
        let mut done: Vec<Poly<Fp>> = vec![];
        for f in g {
            let lead = f[0];
            let tail = Poly::from_terms(&fl, self.pk, self.o, f[1..].to_vec());
            let refs: Vec<&Poly<Fp>> = done.iter().collect();
            let r = if refs.is_empty() { tail } else { tail.divrem(&fl, &refs, false, true)?.1 };
            if std::env::var("SB_F4_DEBUG").is_ok() {
                eprintln!("f4: interreduced lead {:?}: {} -> {} terms, t {:.3}", self.pk.unpack(lead.0), f.len(), r.len() + 1, T0.with(|t| t.elapsed().as_secs_f64()));
            }
            let mut t = vec![crate::sparse::Term { key: self.key(lead.0), w: lead.0, c: lead.1 }];
            t.extend(r.t);
            done.push(Poly { pk: self.pk, o: self.o, t });
        }
        let mut out: Vec<P> = done.into_iter().map(|f| f.t.into_iter().map(|x| (x.w, x.c)).collect()).collect();
        out.sort_by_key(|f: &P| std::cmp::Reverse(self.key(f[0].0)));
        Ok(out)
    }
}

/// The reduced Groebner basis over GF(p) of the polynomials fs (words in
/// the packing pk, any order of terms).  Lex orders go through the
/// homogenization: by degree, then the order, h last, its basis
/// dehomogenizes to a basis in the order (degree by degree, without the
/// swell of lex reductions), which is then reduced.
pub fn f4_p(pk: Packing, o: Order, md: &Modulus, fs: &[Vec<(u64, u64)>]) -> Result<(Packing, Vec<P>), Overflow> {
    f4_p_opt(pk, o, md, fs, false)
}

/// f4_p, with probabilistic linear algebra if prob (correct but for a
/// probability about the number of row blocks over p).
pub fn f4_p_opt(pk: Packing, o: Order, md: &Modulus, fs: &[Vec<(u64, u64)>], prob: bool) -> Result<(Packing, Vec<P>), Overflow> {
    // the signature-based F4 (sigf4.rs): correct, almost no reductions to
    // zero, but slower than F4 so far (a larger, unreduced basis and many
    // more pairs); experimental, on with SB_SIGF4
    if matches!(o, Order::DegRevLex | Order::DegLex) && md.n < 1 << 31 && std::env::var("SB_SIGF4").is_ok() {
        if let Ok(Some(r)) = sig_path(pk, o, md, fs) {
            return Ok((pk, r));
        }
    }
    match o {
        Order::DegRevLex | Order::DegLex => Ok((pk, f4_direct(pk, o, md, fs, prob)?)),
        Order::Lex | Order::InvLex => {
            let n = pk.n;
            if (n as u32 + 1) * pk.bits > 64 {
                return Err(Overflow);
            }
            let ph = Packing { n: n + 1, bits: pk.bits };
            // lex on the variables (reversed for invlex), then h
            let perm: Vec<usize> = if o == Order::Lex { (0..n).collect() } else { (0..n).rev().collect() };
            let mut hs = vec![];
            for f in fs {
                let d = f.iter().map(|&(w, _)| pk.degree(w)).max().unwrap_or(0);
                hs.push(f.iter().map(|&(w, c)| {
                    let e = pk.unpack(w);
                    let mut e2: Vec<u64> = perm.iter().map(|&i| e[i]).collect();
                    e2.push(d - pk.degree(w));
                    (ph.pack(&e2), c)
                }).collect::<Vec<_>>());
            }
            if hs.iter().flatten().any(|x| x.0 & ph.guard() != 0) {
                return Err(Overflow);
            }
            let gh = f4_direct(ph, Order::DegLex, md, &hs, prob)?;
            if std::env::var("SB_F4_DEBUG").is_ok() {
                eprintln!("f4: homogenized basis {} elements, t {:.3}", gh.len(), T0.with(|t| t.elapsed().as_secs_f64()));
            }
            // dehomogenized, back to the variables, in the widest packing:
            // lex reductions can pass through exponents far above the
            // basis's
            let pk = Packing { n, bits: (64 / n as u32).min(32) };
            let g: Vec<P> = gh.iter().map(|f| {
                let mut t: Vec<(u128, u64, u64)> = f.iter().map(|&(w, c)| {
                    let e2 = ph.unpack(w);
                    let mut e = vec![0u64; n];
                    for (k, &i) in perm.iter().enumerate() {
                        e[i] = e2[k];
                    }
                    let w = pk.pack(&e);
                    (pk.key(o, w), w, c)
                }).collect();
                t.sort_unstable_by(|a, b| b.0.cmp(&a.0));
                let inv = md.inv(t[0].2).unwrap();
                t.into_iter().map(|(_, w, c)| (w, md.mul(c, inv))).collect()
            }).collect();
            let st = F4 {
                pk,
                o,
                md,
                guard: pk.guard(),
                lead: g.iter().map(|f| f[0].0).collect(),
                active: vec![true; g.len()],
                sugar: vec![0; g.len()],
                g,
                pairs: vec![],
                prob,
            };
            Ok((pk, st.reduced()?))
        }
    }
}

/// The reduced basis by the signature-based F4 (sigf4.rs), homogenizing
/// (degrevlex with h last: its leading monomials survive dehomogenization)
/// when the input is not homogeneous; None when that is not possible.
fn sig_path(pk: Packing, o: Order, md: &Modulus, fs: &[Vec<(u64, u64)>]) -> Result<Option<Vec<P>>, Overflow> {
    let n = pk.n;
    let t0 = std::env::var("SB_F4_DEBUG").is_ok().then(std::time::Instant::now);
    let homog = fs.iter().all(|f| f.iter().all(|&(w, _)| pk.degree(w) == pk.degree(f[0].0)));
    let polys: Vec<P> = if homog {
        crate::sigf4::sig_basis(pk, o, md, fs)?
    } else {
        // (deglex on (x, h) does not restrict to deglex on x: a homogenized
        // deglex needs h's degree before the lex comparison, an order not
        // here yet; degrevlex with h last restricts to degrevlex)
        if (n as u32 + 1) * pk.bits > 64 || o != Order::DegRevLex {
            return Ok(None);
        }
        let ph = Packing { n: n + 1, bits: pk.bits };
        let hs: Vec<P> = fs.iter().filter(|f| !f.is_empty()).map(|f| {
            let d = f.iter().map(|&(w, _)| pk.degree(w)).max().unwrap();
            f.iter().map(|&(w, c)| {
                let mut e = pk.unpack(w);
                e.push(d - pk.degree(w));
                (ph.pack(&e), c)
            }).collect()
        }).collect();
        if hs.iter().flatten().any(|x| x.0 & ph.guard() != 0) {
            return Err(Overflow);
        }
        let gh = crate::sigf4::sig_basis(ph, o, md, &hs)?;
        gh.iter().map(|f| {
            let mut t: Vec<(u128, u64, u64)> = vec![];
            for &(w, c) in f {
                let e = ph.unpack(w);
                let w2 = pk.pack(&e[..n]);
                t.push((pk.key(o, w2), w2, c));
            }
            t.sort_unstable_by(|a, b| b.0.cmp(&a.0));
            let inv = md.inv(t[0].2).unwrap();
            t.into_iter().map(|(_, w, c)| (w, md.mul(c, inv))).collect()
        }).collect()
    };
    if std::env::var("SB_F4_DEBUG").is_ok() {
        eprintln!("sig_path: signature basis of {} elements in {:.3}s", polys.len(), t0.map_or(0.0, |t| t.elapsed().as_secs_f64()));
    }
    let st = F4 {
        pk,
        o,
        md,
        guard: pk.guard(),
        lead: polys.iter().map(|f| f[0].0).collect(),
        active: vec![true; polys.len()],
        sugar: vec![0; polys.len()],
        g: polys,
        pairs: vec![],
        prob: false,
    };
    let r = st.reduced()?;
    if let Some(t) = t0 {
        eprintln!("sig_path: reduced in total {:.3}s", t.elapsed().as_secs_f64());
    }
    Ok(Some(r))
}

fn f4_direct(pk: Packing, o: Order, md: &Modulus, fs: &[Vec<(u64, u64)>], prob: bool) -> Result<Vec<P>, Overflow> {
    let mut st = F4 { pk, o, md, guard: pk.guard(), g: vec![], lead: vec![], active: vec![], sugar: vec![], pairs: vec![], prob };
    // the generators: sorted, merged, then echelonized together
    let mut rows: Vec<P> = vec![];
    for f in fs {
        let mut t: Vec<(u128, u64, u64)> = f.iter().filter(|x| x.1 != 0).map(|&(w, c)| (pk.key(o, w), w, c)).collect();
        if t.iter().any(|x| x.1 & st.guard != 0) {
            return Err(Overflow);
        }
        t.sort_unstable_by(|a, b| b.0.cmp(&a.0));
        let mut r: P = vec![];
        for (_, w, c) in t {
            match r.last_mut() {
                Some(l) if l.0 == w => l.1 = md.add(l.1, c),
                _ => r.push((w, c)),
            }
        }
        r.retain(|x| x.1 != 0);
        if !r.is_empty() {
            rows.push(r);
        }
    }
    // by increasing leading monomial, so the echelon keeps small leads
    rows.sort_by_key(|r| st.key(r[0].0));
    for f in st.reduce_rows(HashMap::new(), rows, true)? {
        st.add(f, 0);
    }
    let mut steps = 0;
    while !st.pairs.is_empty() {
        sagebrush_interrupt::check();
        st.step()?;
        steps += 1;
        let _ = steps;
    }
    if std::env::var("SB_F4_DEBUG").is_ok() {
        let a = PHASES.with(|p| p.get());
        eprintln!("f4: phases: preprocessing {:.3}s, matrix {:.3}s, reduction {:.3}s, total {:.3}s", a[0], a[1], a[2], T0.with(|t| t.elapsed().as_secs_f64()));
    }
    st.reduced()
}

// ------------------------------------------------------------------ over Q

/// The bits per variable to start with (room for the generators' degrees
/// and the guard bit, 8 if the words allow) and the most the words allow
/// (lex orders compute with one more variable).
pub(crate) fn bits_range(fs: &[QPoly], o: Order) -> (u32, u32) {
    let n = fs.first().map(|f| f.num.n).unwrap_or(1) as u32;
    let d = fs.iter().map(|f| f.num.degrees().into_iter().max().unwrap_or(0)).max().unwrap_or(0);
    let extra = matches!(o, Order::Lex | Order::InvLex) as u32;
    let max = 64 / (n + extra);
    ((crate::bits_for(d) + 2).max(8.min(max)), max)
}

/// The reduced Groebner basis over GF(p) of QPolys with p > 0 (or over Q
/// reduced mod p), by decreasing leading monomial, widening the packing on
/// overflow.
pub fn groebner_p(fs: &[QPoly], o: Order, p: u64) -> Result<Vec<QPoly>, String> {
    groebner_p_opt(fs, o, p, false)
}

fn groebner_p_opt(fs: &[QPoly], o: Order, p: u64, prob: bool) -> Result<Vec<QPoly>, String> {
    let n = fs.first().map(|f| f.num.n).unwrap_or(1);
    let md = Modulus::new(p);
    let (mut bits, maxb) = bits_range(fs, o);
    loop {
        if bits > maxb {
            return Err("exponents too large to pack".into());
        }
        let pk = Packing { n, bits };
        let input: Vec<Vec<(u64, u64)>> = fs.iter().map(|f| crate::gcd::reduce(&f.num.repack(bits), p)).collect();
        match f4_p_opt(pk, o, &md, &input, prob) {
            Ok((pko, g)) => {
                return Ok(g.into_iter().map(|f| {
                    let mut t: Vec<(u64, i64)> = f.iter().map(|&(w, c)| (w, c as i64)).collect();
                    t.sort_by(|a, b| b.0.cmp(&a.0));
                    let num = ZPoly { n, bits: pko.bits, exps: t.iter().map(|x| x.0).collect(), coeffs: crate::Coeffs::Small(t.iter().map(|x| x.1).collect()) };
                    QPoly { num, den: BigInt::one(), p }
                }).collect())
            }
            Err(Overflow) => {
                if std::env::var("SB_F4_DEBUG").is_ok() {
                    eprintln!("f4: overflow at {} bits", bits);
                }
                if bits == maxb {
                    return Err("exponents too large to pack".into());
                }
                bits = (bits * 2).min(maxb)
            }
        }
    }
}

/// a / b with |a|, |b| <= sqrt(m / 2) and a = b c mod m, if any.
pub(crate) fn ratrecon(c: &BigInt, m: &BigInt) -> Option<BigRational> {
    let bound = (m / BigInt::from(2)).sqrt();
    let (mut r0, mut r1) = (m.clone(), c.mod_floor(m));
    let (mut t0, mut t1) = (BigInt::zero(), BigInt::one());
    while r1 > bound {
        let q = &r0 / &r1;
        (r0, r1) = (r1.clone(), &r0 - &q * &r1);
        (t0, t1) = (t1.clone(), &t0 - &q * &t1);
    }
    if t1.is_zero() || t1.abs() > bound || !r1.gcd(&t1).is_one() {
        return None;
    }
    Some(BigRational::new(r1, t1))
}

/// The reduced Groebner basis over Q (monic, by decreasing leading
/// monomial).
pub fn groebner_q(fs: &[QPoly], o: Order) -> Result<Vec<QPoly>, String> {
    groebner_q_opt(fs, o, true)
}

/// groebner_q; without proof, in degree orders, the basis of one F4 over Q
/// (f4q.rs), which could only be wrong if a reconstruction there was
/// accepted too early (each with two primes to spare).
pub fn groebner_q_opt(fs: &[QPoly], o: Order, proof: bool) -> Result<Vec<QPoly>, String> {
    let fs: Vec<QPoly> = fs.iter().filter(|f| !f.num.is_zero()).cloned().collect();
    if fs.is_empty() {
        return Ok(vec![]);
    }
    if matches!(o, Order::DegRevLex | Order::DegLex) && std::env::var("SB_F4Q").as_deref() != Ok("0") {
        if let Some(g) = crate::f4q::groebner_q_f4(&fs, o, proof)? {
            return Ok(g);
        }
        if std::env::var("SB_F4_DEBUG").is_ok() {
            eprintln!("groebner_q: the F4 over Q failed its check; multi-modular");
        }
    }
    groebner_q_multimodular(&fs, o, proof)
}

/// The basis from bases modulo many primes (unlucky ones dropped by their
/// leading monomials), rationally reconstructed and verified (fs nonzero).
pub(crate) fn groebner_q_multimodular(fs: &[QPoly], o: Order, proof: bool) -> Result<Vec<QPoly>, String> {
    let fs: Vec<QPoly> = fs.to_vec();
    let n = fs[0].num.n;
    let bits = bits_range(&fs, o).0;
    // leading coefficients and denominators: primes dividing them are skipped
    let mut bad = BigInt::one();
    for f in &fs {
        let q = crate::sparse::to_q(f, o);
        bad = bad * q.lead().c.numer().abs() * q.lead().c.denom() * &f.den;
    }
    // (leading words, CRT coefficients per element, modulus)
    let mut cur: Option<(Vec<u64>, Vec<Vec<(u64, BigInt)>>, BigInt)> = None;
    // the packing of the words (widened if some prime needed more)
    let mut wb = bits;
    let mut last: Option<Vec<Vec<(u64, BigRational)>>> = None;
    let mut rejected = 0usize;
    // the images modulo good primes, computed in parallel batches
    // primes below 2^31: the fast elimination (more of them, each cheaper)
    let mut primes = crate::gcd::Primes::below(1 << 31).filter(|&p| !(&bad % BigInt::from(p)).is_zero());
    let mut pending: std::collections::VecDeque<(u64, Result<Vec<QPoly>, String>)> = Default::default();
    let mut batch = 1usize;
    let mut used = 0usize;
    loop {
        sagebrush_interrupt::check();
        if pending.is_empty() {
            if used > 5000 {
                break;
            }
            batch = (batch * 2).min(crate::threads().max(1));
            let ps: Vec<u64> = (&mut primes).take(batch).collect();
            let image = |&p: &u64| -> Result<Vec<QPoly>, String> {
                let bp = BigInt::from(p);
                let modp: Vec<QPoly> = fs.iter().map(|f| {
                    // num / den mod p
                    let dinv = BigInt::from(Modulus::new(p).inv(f.den.mod_floor(&bp).to_u64().unwrap()).unwrap());
                    QPoly { num: f.num.scale(&dinv).reduce_mod(p), den: BigInt::one(), p }
                }).collect();
                // (probabilistic linear algebra, random combinations of row
                // blocks, saves nothing here: a combination of sparse rows
                // cascades through the pivots of all of them)
                groebner_p_opt(&modp, o, p, false)
            };
            pending.extend(ps.iter().copied().zip(crate::run_parallel(ps.len(), &ps, image)));
        }
        let (p, g) = pending.pop_front().unwrap();
        used += 1;
        let bp = BigInt::from(p);
        let g = g?;
        if g.iter().any(|f| f.num.bits > wb) {
            // wider exponents than expected: start over in that packing
            wb = g.iter().map(|f| f.num.bits).max().unwrap();
            cur = None;
            last = None;
        }
        // repacked words, comparable across primes
        let gw: Vec<Vec<(u64, u64)>> = g.iter().map(|f| {
            let r = f.num.repack(wb);
            (0..r.len()).map(|i| (r.exps[i], r.coeffs.big(i).to_u64().unwrap())).collect()
        }).collect();
        let leads2: Vec<u64> = gw.iter().map(|f| f[0].0).collect();
        match &mut cur {
            Some((l, coeffs, m)) if *l == leads2 && gw.iter().zip(coeffs.iter()).all(|(a, b)| a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x.0 == y.0)) => {
                // CRT
                let md = Modulus::new(p);
                let minv = BigInt::from(md.inv((&*m % &bp).to_u64().unwrap()).unwrap());
                for (cf, im) in coeffs.iter_mut().zip(&gw) {
                    for (x, &(_, r)) in cf.iter_mut().zip(im) {
                        let t = ((BigInt::from(r) - &x.1) * &minv).mod_floor(&bp);
                        x.1 = &x.1 + t * &*m;
                    }
                }
                *m = &*m * &bp;
            }
            Some(_) => {
                // a different support: an unlucky prime (or the earlier ones were)
                rejected += 1;
                if rejected > 2 {
                    cur = None;
                    last = None;
                    rejected = 0;
                }
                if cur.is_some() {
                    continue;
                }
                cur = Some((leads2, gw.iter().map(|f| f.iter().map(|&(w, c)| (w, BigInt::from(c))).collect()).collect(), bp.clone()));
                continue;
            }
            None => {
                cur = Some((leads2, gw.iter().map(|f| f.iter().map(|&(w, c)| (w, BigInt::from(c))).collect()).collect(), bp.clone()));
                continue;
            }
        }
        // rational reconstruction
        let (_, coeffs, m) = cur.as_ref().unwrap();
        let rec: Option<Vec<Vec<(u64, BigRational)>>> = coeffs.iter().map(|f| f.iter().map(|(w, c)| ratrecon(c, m).map(|r| (*w, r))).collect()).collect();
        let Some(rec) = rec else { continue };
        if last.as_ref() != Some(&rec) {
            last = Some(rec);
            continue;
        }
        // stable: check over Q
        let dbg = std::env::var("SB_F4_DEBUG").is_ok();
        if dbg {
            eprintln!("groebner_q: stable after modulus of {} bits", m.bits());
        }
        let t0 = dbg.then(std::time::Instant::now);
        let pk = Packing { n, bits: wb };
        let cand: Vec<Poly<QQ>> = rec.iter().map(|f| Poly::from_terms(&QQ, pk, o, f.clone())).collect();
        // (leading monomials from the images make it the basis only for a
        // homogeneous ideal: otherwise the candidate must be proven to lie
        // in the ideal, f4q::in_ideal, the systematic review's G1)
        let ok = verify_q(&fs, &cand, o, pk)? && (!proof || crate::f4q::homogeneous(&fs) || crate::f4q::in_ideal(&fs, &cand, None)?);
        if dbg {
            eprintln!("groebner_q: verified {} in {:.3}s", ok, t0.map_or(0.0, |t| t.elapsed().as_secs_f64()));
        }
        if ok {
            return Ok(cand.iter().map(|g| crate::sparse::from_q(g, n)).collect());
        }
        // not a basis: an unlucky or wrong image is in the CRT; start over
        cur = None;
        last = None;
    }
    Err("groebner: too many primes".into())
}

/// An integer polynomial in the order: (key, word, coefficient), keys
/// decreasing.
pub(crate) type ZT = Vec<(u128, u64, BigInt)>;

/// The primitive integer multiple of f (positive leading coefficient).
pub(crate) fn to_zt(f: &Poly<QQ>) -> ZT {
    let mut den = BigInt::one();
    for x in &f.t {
        den = den.lcm(x.c.denom());
    }
    let mut t: ZT = f.t.iter().map(|x| (x.key, x.w, x.c.numer() * (&den / x.c.denom()))).collect();
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

/// Whether f reduces to 0 modulo g (fraction-free top reductions: f is
/// replaced by a f - b m g with the leading terms cancelling, the content
/// removed now and then).
pub(crate) fn reduces_to_zero_z(f: ZT, g: &[ZT], pk: &Packing, o: Order) -> Result<bool, Overflow> {
    use std::collections::BTreeMap;
    let guard = pk.guard();
    let mut cur: BTreeMap<u128, (u64, BigInt)> = f.into_iter().map(|(k, w, c)| (k, (w, c))).collect();
    let mut steps = 0u64;
    while let Some((_, (w, c))) = cur.pop_last() {
        steps += 1;
        if steps & 63 == 0 {
            sagebrush_interrupt::check();
        }
        // the reducer with the smallest leading coefficient (the remainder
        // is multiplied by it), then the shortest
        let Some(r) = g.iter().filter(|h| pk.divides(h[0].1, w)).min_by_key(|h| (h[0].2.bits(), h.len())) else { return Ok(false) };
        let m = w - r[0].1;
        let lg = &r[0].2;
        let d = c.gcd(lg);
        let (a, b) = (lg / &d, &c / &d);
        if !a.is_one() {
            for v in cur.values_mut() {
                v.1 = &v.1 * &a;
            }
        }
        for (_, rw, rc) in &r[1..] {
            let x = rw + m;
            if x & guard != 0 {
                return Err(Overflow);
            }
            let k = pk.key(o, x);
            let t = &b * rc;
            match cur.get_mut(&k) {
                Some(e) => {
                    e.1 = &e.1 - &t;
                    if e.1.is_zero() {
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
    Ok(true)
}

/// The S-pairs of a basis with these leading monomials that survive the
/// Gebauer-Moeller installation (the elements inserted by increasing
/// leading monomial; pairs with coprime leads dropped, chains and equal
/// lcms pruned): (i, j, lcm).
fn gm_pairs(pk: &Packing, o: Order, lead: &[u64]) -> Vec<(usize, usize, u64)> {
    let mut idx: Vec<usize> = (0..lead.len()).collect();
    idx.sort_by_key(|&i| pk.key(o, lead[i]));
    let mut pairs: Vec<(usize, usize, u64)> = vec![];
    let mut done: Vec<usize> = vec![];
    for &h in &idx {
        let lh = lead[h];
        let mut c: Vec<usize> = done.clone();
        let mut d: Vec<usize> = vec![];
        while !c.is_empty() {
            let i = c.remove(0);
            let li = pk.lcm(lead[i], lh);
            if pk.coprime(lead[i], lh) || !c.iter().chain(d.iter()).any(|&j| pk.divides(pk.lcm(lead[j], lh), li)) {
                d.push(i);
            }
        }
        pairs.retain(|&(a, b, l)| !(pk.divides(lh, l) && pk.lcm(lead[a], lh) != l && pk.lcm(lead[b], lh) != l));
        for i in d {
            if !pk.coprime(lead[i], lh) {
                pairs.push((i, h, pk.lcm(lead[i], lh)));
            }
        }
        done.push(h);
    }
    pairs
}

/// Whether G is a Groebner basis containing the generators fs in its ideal
/// (each reduces to 0): Buchberger's criterion with the product and chain
/// criteria, in integer arithmetic.
pub(crate) fn verify_q(fs: &[QPoly], g: &[Poly<QQ>], o: Order, pk: Packing) -> Result<bool, String> {
    let gz: Vec<ZT> = g.iter().map(to_zt).collect();
    let red = |f: ZT| -> Result<bool, String> { reduces_to_zero_z(f, &gz, &pk, o).map_err(|_| "exponents too large to pack".to_string()) };
    for f in fs {
        let q = crate::sparse::to_q(f, o).repack(pk.bits);
        if !red(to_zt(&q))? {
            return Ok(false);
        }
    }
    let lead: Vec<u64> = gz.iter().map(|f| f[0].1).collect();
    // the pairs left by the Gebauer-Moeller criteria (as in F4): G is a
    // Groebner basis if these reduce to 0
    let pairs = gm_pairs(&pk, o, &lead);
    if std::env::var("SB_F4_DEBUG").is_ok() {
        eprintln!("verify_q: {} elements, {} pairs to check", lead.len(), pairs.len());
    }
    // a certificate from eliminations modulo primes (certify.rs), else the
    // reductions over Z
    if std::env::var("SB_VQ_CERT").as_deref() != Ok("0") {
        if let Some(b) = crate::certify::certify_spairs(&gz, &pairs, pk, o).map_err(|_| "exponents too large to pack".to_string())? {
            return Ok(b);
        }
    }
    if std::env::var("SB_VQ_OLD").is_err() {
        return spairs_reduce_to_zero(&gz, &pairs, pk, o).map_err(|_| "exponents too large to pack".to_string());
    }
    let check = |&(i, j, l): &(usize, usize, u64)| -> Result<bool, String> {
        {
            // S = (c_j / d) (l / l_i) g_i - (c_i / d) (l / l_j) g_j
            let (ci, cj) = (&gz[i][0].2, &gz[j][0].2);
            let d = ci.gcd(cj);
            let (a, b) = (cj / &d, ci / &d);
            let (mi, mj) = (l - lead[i], l - lead[j]);
            let mut t: std::collections::BTreeMap<u128, (u64, BigInt)> = std::collections::BTreeMap::new();
            for (_, w, c) in &gz[i][1..] {
                let x = w + mi;
                t.insert(pk.key(o, x), (x, &a * c));
            }
            for (_, w, c) in &gz[j][1..] {
                let x = w + mj;
                let kk = pk.key(o, x);
                let v = &b * c;
                match t.get_mut(&kk) {
                    Some(e) => {
                        e.1 = &e.1 - &v;
                        if e.1.is_zero() {
                            t.remove(&kk);
                        }
                    }
                    None => {
                        t.insert(kk, (x, -v));
                    }
                }
            }
            if t.values().any(|v| v.0 & pk.guard() != 0) {
                return Err("exponents too large to pack".into());
            }
            let sp: ZT = t.into_iter().rev().map(|(k, (w, c))| (k, w, c)).collect();
            red(sp)
        }
    };
    for r in crate::run_parallel(crate::threads(), &pairs, check) {
        if !r? {
            return Ok(false);
        }
    }
    Ok(true)
}

thread_local! {
    // the dense accumulators of spairs_reduce_to_zero, zero between uses
    static ACC: std::cell::RefCell<Vec<BigInt>> = const { std::cell::RefCell::new(vec![]) };
}

/// Whether the S-polynomials of these pairs of g (primitive integer
/// polynomials) reduce to 0 by g.  The reducers are chosen once for all of
/// them by F4's symbolic preprocessing, so each S-polynomial is reduced
/// fraction-free in a dense accumulator over the columns (the monomials,
/// decreasing), without ordered maps or hashing, stopping at the first
/// entry no leading monomial divides.  Natively the pairs are spread over
/// threads.
fn spairs_reduce_to_zero(g: &[ZT], pairs: &[(usize, usize, u64)], pk: Packing, o: Order) -> Result<bool, Overflow> {
    let md = Modulus::new(3);
    let guard = pk.guard();
    let sym = F4 {
        pk,
        o,
        md: &md,
        guard,
        lead: g.iter().map(|f| f[0].1).collect(),
        active: vec![true; g.len()],
        sugar: vec![0; g.len()],
        g: g.iter().map(|f| f.iter().map(|x| (x.1, 0)).collect()).collect(),
        pairs: vec![],
        prob: false,
    };
    let lead = &sym.lead;
    for &(i, j, l) in pairs {
        for k in [i, j] {
            let m = l - lead[k];
            if g[k].iter().any(|x| (x.1 + m) & guard != 0) {
                return Err(Overflow);
            }
        }
    }
    let mut pivots = HashMap::new();
    let cols = sym.preprocess(&mut pivots, &mut pairs.iter().flat_map(|&(i, j, l)| {
        let (mi, mj) = (l - lead[i], l - lead[j]);
        g[i][1..].iter().map(move |x| x.1 + mi).chain(g[j][1..].iter().map(move |x| x.1 + mj))
    }))?;
    let col: HashMap<u64, u32> = cols.iter().enumerate().map(|(i, &(_, w))| (w, i as u32)).collect();
    let nc = cols.len();
    // the reducer of each column: its columns and element
    let mut prow: Vec<Option<(Vec<u32>, usize)>> = vec![None; nc];
    for (&lm, &(m, k)) in &pivots {
        prow[col[&lm] as usize] = Some((g[k].iter().map(|x| col[&(x.1 + m)]).collect(), k));
    }
    if std::env::var("SB_F4_DEBUG").is_ok() {
        eprintln!("verify_q: {} columns, {} reducers", nc, pivots.len());
    }
    let check = |&(i, j, l): &(usize, usize, u64)| -> bool {
        ACC.with(|acc| {
            let mut acc = acc.borrow_mut();
            if acc.len() < nc {
                acc.resize(nc, BigInt::zero());
            }
            // S = (c_j / d) (l / l_i) g_i - (c_i / d) (l / l_j) g_j
            let (ci, cj) = (&g[i][0].2, &g[j][0].2);
            let d = ci.gcd(cj);
            let (a, b) = (cj / &d, ci / &d);
            let (mut first, mut last) = (nc, 0usize);
            for (k, s, neg) in [(i, &a, false), (j, &b, true)] {
                let m = l - lead[k];
                for x in &g[k][1..] {
                    let t = col[&(x.1 + m)] as usize;
                    let v = s * &x.2;
                    if neg {
                        acc[t] -= v;
                    } else {
                        acc[t] += v;
                    }
                    first = first.min(t);
                    last = last.max(t);
                }
            }
            let mut steps = 0u32;
            let mut j = first;
            while j <= last && j < nc {
                if acc[j].is_zero() {
                    j += 1;
                    continue;
                }
                let Some((pc, k)) = &prow[j] else {
                    // a monomial no leading monomial divides: not 0
                    for x in acc[j..=last].iter_mut() {
                        *x = BigInt::zero();
                    }
                    return false;
                };
                steps += 1;
                if steps & 63 == 0 {
                    sagebrush_interrupt::check();
                }
                let c = std::mem::take(&mut acc[j]);
                let lg = &g[*k][0].2;
                let h = c.gcd(lg);
                let (sa, sb) = (lg / &h, c / &h);
                if !sa.is_one() {
                    for x in acc[j + 1..=last].iter_mut() {
                        if !x.is_zero() {
                            *x *= &sa;
                        }
                    }
                }
                for (&t, x) in pc[1..].iter().zip(&g[*k][1..]) {
                    acc[t as usize] -= &sb * &x.2;
                }
                last = last.max(*pc.last().unwrap() as usize);
                if steps % 8 == 0 {
                    // the content of the rest, removed
                    let mut ct = BigInt::zero();
                    for x in acc[j + 1..=last].iter() {
                        if !x.is_zero() {
                            ct = ct.gcd(x);
                            if ct.is_one() {
                                break;
                            }
                        }
                    }
                    if !ct.is_zero() && !ct.is_one() {
                        for x in acc[j + 1..=last].iter_mut() {
                            if !x.is_zero() {
                                *x = &*x / &ct;
                            }
                        }
                    }
                }
                j += 1;
            }
            true
        })
    };
    Ok(crate::run_parallel(crate::threads(), pairs, check).into_iter().all(|ok| ok))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(n: usize, s: &str) -> QPoly {
        QPoly::from_text(n, s).unwrap()
    }

    #[test]
    fn small_q() {
        // x^2 - y, x*y - 1 in degrevlex: [x^2 - y, x*y - 1, y^2 - x]
        let g = groebner_q(&[q(2, "2,0:1;0,1:-1"), q(2, "1,1:1;0,0:-1")], Order::DegRevLex).unwrap();
        let t: Vec<String> = g.iter().map(|f| f.to_text()).collect();
        assert_eq!(t, vec!["2,0:1;0,1:-1", "1,1:1;0,0:-1", "0,2:1;1,0:-1"].iter().map(|s| q(2, s).to_text()).collect::<Vec<_>>());
    }

    #[test]
    fn lex_elimination() {
        // a^2 - b^2 - 3, a - 2b in lex: [a - 2b, b^2 - 1]
        let g = groebner_q(&[q(2, "2,0:1;0,2:-1;0,0:-3"), q(2, "1,0:1;0,1:-2")], Order::Lex).unwrap();
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].to_text(), q(2, "1,0:1;0,1:-2").to_text());
        assert_eq!(g[1].to_text(), q(2, "0,2:1;0,0:-1").to_text());
    }

    #[test]
    fn signature_path_matches() {
        // cyclic-4 and katsura-3 (homogeneous and not) mod 32003: the
        // signature-based F4 against F4
        let systems = [
            vec!["1,0,0,0:1;0,1,0,0:1;0,0,1,0:1;0,0,0,1:1", "1,1,0,0:1;0,1,1,0:1;0,0,1,1:1;1,0,0,1:1", "1,1,1,0:1;0,1,1,1:1;1,0,1,1:1;1,1,0,1:1", "1,1,1,1:1;0,0,0,0:-1"],
            vec!["1,0,0,0:1;0,1,0,0:2;0,0,1,0:2;0,0,0,1:2;0,0,0,0:-1", "2,0,0,0:1;0,2,0,0:2;0,0,2,0:2;0,0,0,2:2;1,0,0,0:-1", "1,1,0,0:2;0,1,1,0:2;0,0,1,1:2;0,1,0,0:-1", "0,2,0,0:1;1,0,1,0:2;0,1,0,1:2;0,0,1,0:-1"],
        ];
        for fs in systems {
            let input: Vec<QPoly> = fs.iter().map(|s| { let f = q(4, s); QPoly { num: f.num.reduce_mod(32003), den: BigInt::one(), p: 32003 } }).collect();
            let md = Modulus::new(32003);
            let pk = Packing { n: 4, bits: 8 };
            let words: Vec<Vec<(u64, u64)>> = input.iter().map(|f| crate::gcd::reduce(&f.num.repack(8), 32003)).collect();
            let a = f4_direct(pk, Order::DegRevLex, &md, &words, false).unwrap();
            let b = sig_path(pk, Order::DegRevLex, &md, &words).unwrap().unwrap();
            assert_eq!(a, b);
        }
    }

    #[test]
    fn f4_over_q() {
        // katsura-3 (inhomogeneous: homogenized) and cyclic-4 over Q: the
        // F4 over Q without the check, the checked one and the multi-modular
        // reconstruction agree
        let systems = [
            vec!["1,0,0,0:1;0,1,0,0:2;0,0,1,0:2;0,0,0,1:2;0,0,0,0:-1", "2,0,0,0:1;0,2,0,0:2;0,0,2,0:2;0,0,0,2:2;1,0,0,0:-1", "1,1,0,0:2;0,1,1,0:2;0,0,1,1:2;0,1,0,0:-1", "0,2,0,0:1;1,0,1,0:2;0,1,0,1:2;0,0,1,0:-1"],
            vec!["1,0,0,0:1;0,1,0,0:1;0,0,1,0:1;0,0,0,1:1", "1,1,0,0:1;0,1,1,0:1;0,0,1,1:1;1,0,0,1:1", "1,1,1,0:1;0,1,1,1:1;1,0,1,1:1;1,1,0,1:1", "1,1,1,1:1;0,0,0,0:-1"],
        ];
        for fs in systems {
            let fs: Vec<QPoly> = fs.iter().map(|s| q(4, s)).collect();
            let text = |g: Vec<QPoly>| g.iter().map(|f| f.to_text()).collect::<Vec<_>>();
            let a = text(groebner_q_opt(&fs, Order::DegRevLex, false).unwrap());
            let b = text(groebner_q_opt(&fs, Order::DegRevLex, true).unwrap());
            let c = text(crate::f4q::groebner_q_f4(&fs, Order::DegLex, false).unwrap().unwrap());
            std::env::set_var("SB_F4Q", "0");
            let d = text(groebner_q(&fs, Order::DegRevLex).unwrap());
            let e = text(groebner_q(&fs, Order::DegLex).unwrap());
            std::env::remove_var("SB_F4Q");
            assert_eq!(a, b);
            assert_eq!(a, d);
            assert_eq!(c, e);
        }
    }

    #[test]
    fn verify_rejects() {
        // the check over Q (the certificate, then the reductions over Z)
        // accepts the reduced basis of katsura-3 and rejects it perturbed,
        // short of an element, and the generators (not a basis)
        let fs: Vec<QPoly> = ["1,0,0,0:1;0,1,0,0:2;0,0,1,0:2;0,0,0,1:2;0,0,0,0:-1", "2,0,0,0:1;0,2,0,0:2;0,0,2,0:2;0,0,0,2:2;1,0,0,0:-1", "1,1,0,0:2;0,1,1,0:2;0,0,1,1:2;0,1,0,0:-1", "0,2,0,0:1;1,0,1,0:2;0,1,0,1:2;0,0,1,0:-1"].iter().map(|s| q(4, s)).collect();
        let o = Order::DegRevLex;
        let g = groebner_q(&fs, o).unwrap();
        let pk = Packing { n: 4, bits: 8 };
        let polys = |v: &[QPoly]| -> Vec<Poly<QQ>> { v.iter().map(|f| crate::sparse::to_q(f, o).repack(8)).collect() };
        for cert in ["1", "0"] {
            std::env::set_var("SB_VQ_CERT", cert);
            assert!(verify_q(&fs, &polys(&g), o, pk).unwrap());
            // a coefficient changed (the last term of the longest element)
            let mut bad = polys(&g);
            let k = (0..bad.len()).max_by_key(|&i| bad[i].t.len()).unwrap();
            let last = bad[k].t.len() - 1;
            bad[k].t[last].c = &bad[k].t[last].c + BigRational::one();
            assert!(!verify_q(&fs, &bad, o, pk).unwrap());
            // the certificate alone on its S-pairs
            let gz: Vec<ZT> = bad.iter().map(to_zt).collect();
            let pairs = gm_pairs(&pk, o, &gz.iter().map(|f| f[0].1).collect::<Vec<_>>());
            assert_eq!(crate::certify::certify_spairs(&gz, &pairs, pk, o).unwrap(), Some(false));
            let gz: Vec<ZT> = polys(&g).iter().map(to_zt).collect();
            assert_eq!(crate::certify::certify_spairs(&gz, &pairs, pk, o).unwrap(), Some(true));
            let mut short = polys(&g);
            short.remove(1);
            assert!(!verify_q(&fs, &short, o, pk).unwrap());
            let gens: Vec<Poly<QQ>> = polys(&fs).into_iter().map(|f| f.monic(&QQ)).collect();
            assert!(!verify_q(&fs, &gens, o, pk).unwrap());
        }
        std::env::remove_var("SB_VQ_CERT");
    }

    #[test]
    fn cyclic4_p() {
        // cyclic-4 mod 32003 in degrevlex: 7 elements
        let fs = [
            "1,0,0,0:1;0,1,0,0:1;0,0,1,0:1;0,0,0,1:1",
            "1,1,0,0:1;0,1,1,0:1;0,0,1,1:1;1,0,0,1:1",
            "1,1,1,0:1;0,1,1,1:1;1,0,1,1:1;1,1,0,1:1",
            "1,1,1,1:1;0,0,0,0:-1",
        ];
        let input: Vec<QPoly> = fs.iter().map(|s| { let f = q(4, s); QPoly { num: f.num.reduce_mod(32003), den: BigInt::one(), p: 32003 } }).collect();
        let g = groebner_p(&input, Order::DegRevLex, 32003).unwrap();
        assert_eq!(g.len(), 7);
        let gq = groebner_q(&fs.iter().map(|s| q(4, s)).collect::<Vec<_>>(), Order::DegRevLex).unwrap();
        assert_eq!(gq.len(), 7);
    }
}
