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
type P = Vec<(u64, u64)>;

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

struct Pair {
    i: usize,
    j: usize,
    lcm: u64,
    deg: u64,
}

struct F4<'a> {
    pk: Packing,
    o: Order,
    md: &'a Modulus,
    guard: u64,
    g: Vec<P>,
    lead: Vec<u64>,
    active: Vec<bool>,
    // the sugar degree of each element (the selection strategy)
    sugar: Vec<u64>,
    pairs: Vec<Pair>,
}

impl<'a> F4<'a> {
    #[inline]
    fn divides(&self, a: u64, b: u64) -> bool {
        // fieldwise a <= b: no borrow into the guard bits
        ((b | self.guard) - a) & self.guard == self.guard
    }

    fn key(&self, w: u64) -> u128 {
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

    fn add(&mut self, f: P, sugar: u64) {
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
    fn reduce_rows(&self, mut pivots: HashMap<u64, (u64, usize)>, todo: Vec<P>, echelon: bool) -> Result<Vec<P>, Overflow> {
        let md = self.md;
        let tdbg = std::env::var("SB_F4_DEBUG").is_ok();
        let tp = tdbg.then(std::time::Instant::now);
        // the monomials of all rows
        let mut monos: HashSet<u64> = HashSet::new();
        let mut queue: Vec<u64> = vec![];
        let see = |m: u64, monos: &mut HashSet<u64>, queue: &mut Vec<u64>| {
            if monos.insert(m) {
                queue.push(m);
            }
        };
        for r in &todo {
            for &(w, _) in r {
                see(w, &mut monos, &mut queue);
            }
        }
        for (&lm, &(m, i)) in &pivots {
            for &(w, _) in &self.g[i] {
                let x = w + m;
                if x & self.guard != 0 {
                    return Err(Overflow);
                }
                see(x, &mut monos, &mut queue);
            }
            let _ = lm;
        }
        let dbg = std::env::var("SB_F4_DEBUG").is_ok();
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
        if dbg {
            eprintln!("f4: preprocessed {} monomials {} reducers {} rows t {:.3}", monos.len(), pivots.len(), todo.len(), T0.with(|t| t.elapsed().as_secs_f64()));
        }
        phase_add(0, tp);
        let tp = tdbg.then(std::time::Instant::now);
        // columns: the monomials, decreasing
        let mut cols: Vec<(u128, u64)> = monos.iter().map(|&w| (self.key(w), w)).collect();
        cols.sort_unstable_by(|a, b| b.0.cmp(&a.0));
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
        let threads = if rows.len() >= 32 { crate::threads() } else { 1 };
        let red = piv.reduce(&rows, nc, threads);
        let red = if echelon { back_reduce(echelonize(red, nc, p), nc, p) } else { red };
        phase_add(2, tp);
        red.into_iter().map(|r| r.cols.iter().zip(&r.vals).map(|(&j, &c)| (cols[j as usize].1, c as u64)).collect()).collect()
    }

    /// One F4 step on the pairs of minimal degree.
    fn step(&mut self) -> Result<(), Overflow> {
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
        let mut todo: Vec<P> = vec![];
        for q in &sel {
            for (idx, other) in [(q.i, false), (q.j, true)] {
                let m = q.lcm - self.lead[idx];
                if !seen.insert((m, idx)) {
                    continue;
                }
                if !other && !pivots.contains_key(&q.lcm) {
                    pivots.insert(q.lcm, (m, idx));
                } else {
                    let mut r = Vec::with_capacity(self.g[idx].len());
                    for &(w, c) in &self.g[idx] {
                        let x = w + m;
                        if x & self.guard != 0 {
                            return Err(Overflow);
                        }
                        r.push((x, c));
                    }
                    todo.push(r);
                }
            }
        }
        let ntodo = todo.len();
        let new = self.reduce_rows(pivots, todo, true)?;
        if std::env::var("SB_F4_DEBUG").is_ok() {
            eprintln!("f4: deg {} pairs {} rows {} new {} basis {} left {} cols {} t {:.3}", dmin, sel.len(), ntodo, new.len(), self.g.len(), self.pairs.len(), LASTCOLS.with(|c| c.get()), T0.with(|t| t.elapsed().as_secs_f64()));
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
    fn reduced(&self) -> Result<Vec<P>, Overflow> {
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
    match o {
        Order::DegRevLex | Order::DegLex => Ok((pk, f4_direct(pk, o, md, fs)?)),
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
            let gh = f4_direct(ph, Order::DegLex, md, &hs)?;
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
            };
            Ok((pk, st.reduced()?))
        }
    }
}

fn f4_direct(pk: Packing, o: Order, md: &Modulus, fs: &[Vec<(u64, u64)>]) -> Result<Vec<P>, Overflow> {
    let mut st = F4 { pk, o, md, guard: pk.guard(), g: vec![], lead: vec![], active: vec![], sugar: vec![], pairs: vec![] };
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
fn bits_range(fs: &[QPoly], o: Order) -> (u32, u32) {
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
    let n = fs.first().map(|f| f.num.n).unwrap_or(1);
    let md = Modulus::new(p);
    let (mut bits, maxb) = bits_range(fs, o);
    loop {
        if bits > maxb {
            return Err("exponents too large to pack".into());
        }
        let pk = Packing { n, bits };
        let input: Vec<Vec<(u64, u64)>> = fs.iter().map(|f| crate::gcd::reduce(&f.num.repack(bits), p)).collect();
        match f4_p(pk, o, &md, &input) {
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
fn ratrecon(c: &BigInt, m: &BigInt) -> Option<BigRational> {
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
    let fs: Vec<QPoly> = fs.iter().filter(|f| !f.num.is_zero()).cloned().collect();
    if fs.is_empty() {
        return Ok(vec![]);
    }
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
                groebner_p(&modp, o, p)
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
        let ok = verify_q(&fs, &cand, o, pk)?;
        if dbg {
            eprintln!("groebner_q: verified {} in {:.3}s", ok, t0.map_or(0.0, |t| t.elapsed().as_secs_f64()));
        }
        if ok {
            return Ok(cand.iter().map(|g| crate::sparse::from_q(g, n)).collect());
        }
        // not a basis yet (or of a different ideal): go on with more primes
        last = None;
    }
    Err("groebner: too many primes".into())
}

/// An integer polynomial in the order: (key, word, coefficient), keys
/// decreasing.
type ZT = Vec<(u128, u64, BigInt)>;

/// The primitive integer multiple of f (positive leading coefficient).
fn to_zt(f: &Poly<QQ>) -> ZT {
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
fn reduces_to_zero_z(f: ZT, g: &[ZT], pk: &Packing, o: Order) -> Result<bool, Overflow> {
    use std::collections::BTreeMap;
    let guard = pk.guard();
    let mut cur: BTreeMap<u128, (u64, BigInt)> = f.into_iter().map(|(k, w, c)| (k, (w, c))).collect();
    let mut steps = 0u64;
    while let Some((_, (w, c))) = cur.pop_last() {
        steps += 1;
        if steps & 63 == 0 {
            sagebrush_interrupt::check();
        }
        // the shortest reducer
        let Some(r) = g.iter().filter(|h| pk.divides(h[0].1, w)).min_by_key(|h| h.len()) else { return Ok(false) };
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

/// Whether G is a Groebner basis containing the generators fs in its ideal
/// (each reduces to 0): Buchberger's criterion with the product and chain
/// criteria, in integer arithmetic.
fn verify_q(fs: &[QPoly], g: &[Poly<QQ>], o: Order, pk: Packing) -> Result<bool, String> {
    let gz: Vec<ZT> = g.iter().map(to_zt).collect();
    let red = |f: ZT| -> Result<bool, String> { reduces_to_zero_z(f, &gz, &pk, o).map_err(|_| "exponents too large to pack".to_string()) };
    for f in fs {
        let q = crate::sparse::to_q(f, o).repack(pk.bits);
        if !red(to_zt(&q))? {
            return Ok(false);
        }
    }
    let k = g.len();
    let lead: Vec<u64> = gz.iter().map(|f| f[0].1).collect();
    let mut pairs = vec![];
    for i in 0..k {
        for j in i + 1..k {
            if pk.coprime(lead[i], lead[j]) {
                continue;
            }
            let l = pk.lcm(lead[i], lead[j]);
            // chain: some g_m with lead dividing l, whose pairs with i and j
            // have strictly smaller lcms (an induction on the lcm)
            let chain = (0..k).any(|m| m != i && m != j && pk.divides(lead[m], l) && pk.lcm(lead[i], lead[m]) != l && pk.lcm(lead[j], lead[m]) != l);
            if !chain {
                pairs.push((i, j, l));
            }
        }
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
