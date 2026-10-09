//! Groebner bases over Q in degree orders by one F4 computation over Q.
//!
//! The pairs, criteria and symbolic preprocessing are F4's (f4.rs), on the
//! leading monomials over Q.  Each matrix is reduced modulo primes below
//! 2^31 instead of over Q, and what F4 needs of it (the new elements: the
//! reduced echelon form of the rows modulo the pivots; in the final
//! interreduction, the reduced tails) is recovered by Chinese remaindering
//! and rational reconstruction, each row over a common denominator,
//! accepted with two primes to spare.  The first two primes reduce the
//! whole matrix; the better of them (more new rows, else smaller leading
//! columns) says which rows became pivots, and those are all the later
//! primes reduce (a tracer).  So a step costs about one elimination of its
//! matrix, plus small ones for as many primes as its coefficients need:
//! early steps few, later ones more.  The elements are kept as primitive
//! integer polynomials with their monic residues modulo the primes used.
//!
//! The result is the reduced basis unless a reconstruction was accepted too
//! early or both full primes of a step were unlucky alike.  With `proof`
//! it is checked as groebner_q checks its candidate: the generators and
//! the S-pairs reduce to 0 over Q, and its leading monomials are those of
//! a basis modulo a prime (Arnold, Thm 7.1): here the first prime, when
//! every step's images modulo it were used (they are then an F4 run
//! modulo it), else one computed for the purpose.

use crate::f4::{bits_range, groebner_p, ratrecon, verify_q, F4, P};
use crate::order::{Order, Packing};
use crate::sparse::{Overflow, Poly, QQ};
use crate::QPoly;
use num_integer::Integer;
use num_traits::{One, Signed, Zero};
use sagebrush_arith::spelim::{self, Pivots, Row};
use sagebrush_bigint::nmod::Modulus;
use sagebrush_bigint::{BigInt, BigRational};
use std::collections::HashMap;

/// Bits to spare in a reconstruction (two primes).
const MARGIN: u64 = 60;

/// A generator or basis element: words by decreasing monomial, primitive
/// integer coefficients (the leading one positive), and the monic residues
/// modulo the primes (by index), when computed.
struct Elem {
    words: Vec<u64>,
    coeffs: Vec<BigInt>,
    res: Vec<Option<Vec<u32>>>,
}

/// x mod p, in [0, p).
pub(crate) fn modp(x: &BigInt, p: u64) -> u64 {
    sagebrush_bigint::rem_u64(x, p)
}

/// One matrix: the pivot rows (columns, element; monic, leading at the
/// first column) and the rows to reduce (columns, element, first term).
struct Mat {
    nc: usize,
    piv: Vec<(Vec<u32>, usize)>,
    rows: Vec<(Vec<u32>, usize, usize)>,
}

/// Chinese remaindering for a set of primes, to the symmetric residue:
/// Garner's mixed radix for a few primes, a product tree for many (each
/// node combines its halves: O(M(k) log k) per value instead of O(k^2)).
struct Crt {
    ps: Vec<u64>,
    mds: Vec<Modulus>,
    // Garner: ps[j] mod ps[i], and 1 / (ps[0] ... ps[i-1]) mod ps[i]
    pm: Vec<Vec<u64>>,
    inv: Vec<u64>,
    // the tree: the products by level, and at each pair the inverse of the
    // left product modulo the right
    tree: Vec<Vec<BigInt>>,
    tinv: Vec<Vec<BigInt>>,
    m: BigInt,
    half: BigInt,
    bits: u64,
}

/// Garner below this many primes, the product tree from it.
const CRT_TREE: usize = 64;

impl Crt {
    fn new(ps: &[u64]) -> Crt {
        let mds: Vec<Modulus> = ps.iter().map(|&p| Modulus::new(p)).collect();
        let k = ps.len();
        let (mut pm, mut inv, mut tree, mut tinv): (Vec<Vec<u64>>, Vec<u64>, Vec<Vec<BigInt>>, Vec<Vec<BigInt>>) = (vec![], vec![], vec![], vec![]);
        if k < CRT_TREE {
            pm = ps.iter().map(|&p| ps.iter().map(|&q| q % p).collect()).collect();
            inv = (0..k).map(|i| {
                let mut t = 1u64;
                for j in 0..i {
                    t = mds[i].mul(t, pm[i][j]);
                }
                mds[i].inv(t).unwrap()
            }).collect();
        } else {
            let mut lv: Vec<BigInt> = ps.iter().map(|&p| BigInt::from(p)).collect();
            while lv.len() > 1 {
                let mut next = Vec::with_capacity(lv.len().div_ceil(2));
                let mut iv = Vec::with_capacity(lv.len() / 2);
                for c in lv.chunks(2) {
                    if c.len() == 2 {
                        iv.push(c[0].mod_floor(&c[1]).modinv(&c[1]).unwrap());
                        next.push(&c[0] * &c[1]);
                    } else {
                        next.push(c[0].clone());
                    }
                }
                tree.push(lv);
                tinv.push(iv);
                lv = next;
            }
            tree.push(lv);
        }
        let m = if k < CRT_TREE {
            let mut m = BigInt::one();
            for &p in ps {
                m = m * BigInt::from(p);
            }
            m
        } else {
            tree.last().unwrap()[0].clone()
        };
        let half = &m / BigInt::from(2);
        let bits = m.bits();
        Crt { ps: ps.to_vec(), mds, pm, inv, tree, tinv, m, half, bits }
    }

    /// The x with |x| <= m/2 and x = r[i] mod ps[i].
    fn lift(&self, r: &[u64]) -> BigInt {
        let k = r.len();
        if r.iter().all(|&x| x == 0) {
            return BigInt::zero();
        }
        if k >= CRT_TREE {
            let mut cur: Vec<BigInt> = r.iter().map(|&x| BigInt::from(x)).collect();
            for (l, iv) in self.tinv.iter().enumerate() {
                let ms = &self.tree[l];
                let mut next = Vec::with_capacity(cur.len().div_ceil(2));
                for j in 0..cur.len().div_ceil(2) {
                    if 2 * j + 1 < cur.len() {
                        let (xl, xr) = (&cur[2 * j], &cur[2 * j + 1]);
                        let (ml, mr) = (&ms[2 * j], &ms[2 * j + 1]);
                        let t = ((xr - xl).mod_floor(mr) * &iv[j]).mod_floor(mr);
                        next.push(xl + ml * t);
                    } else {
                        next.push(cur[2 * j].clone());
                    }
                }
                cur = next;
            }
            let x = cur.pop().unwrap();
            return if x > self.half { x - &self.m } else { x };
        }
        let mut v = vec![0u64; k];
        for i in 0..k {
            let md = &self.mds[i];
            let mut t = 0u64;
            for j in (0..i).rev() {
                t = md.add(md.mul(t, self.pm[i][j]), v[j] % self.ps[i]);
            }
            v[i] = md.mul(md.sub(r[i], t), self.inv[i]);
        }
        // x = v[0] + p_0 (v[1] + p_1 (v[2] + ...)), in limbs
        let mut limbs: Vec<u64> = Vec::with_capacity(k);
        limbs.push(v[k - 1]);
        for i in (0..k - 1).rev() {
            let (p, mut carry) = (self.ps[i] as u128, v[i] as u128);
            for l in limbs.iter_mut() {
                let t = *l as u128 * p + carry;
                *l = t as u64;
                carry = t >> 64;
            }
            if carry != 0 {
                limbs.push(carry as u64);
            }
        }
        let x = sagebrush_bigint::from_limbs(false, &limbs);
        if x > self.half {
            x - &self.m
        } else {
            x
        }
    }
}

/// A reconstructed row: a common denominator (positive) and the numerators
/// by column, the zeros left out.
pub(crate) type QRow = (BigInt, Vec<(u32, BigInt)>);

struct Ctx {
    primes: Vec<u64>,
    bad: Vec<bool>,
    gen: crate::gcd::Primes,
    elems: Vec<Elem>,
    threads: usize,
    // primes the last matrix needed (to size the next batches)
    last_k: usize,
    // whether every matrix so far used its images modulo the first prime
    witness: bool,
    dbg: bool,
}

impl Ctx {
    fn prime(&mut self, j: usize) -> u64 {
        while self.primes.len() <= j {
            let p = self.gen.next().unwrap();
            self.primes.push(p);
            self.bad.push(false);
        }
        self.primes[j]
    }

    /// The monic residues of element e modulo prime j (or j marked bad:
    /// it divides a leading coefficient).
    fn fill(&mut self, e: usize, j: usize) {
        if self.bad[j] {
            return;
        }
        let p = self.primes[j];
        let el = &mut self.elems[e];
        if el.res.len() <= j {
            el.res.resize(j + 1, None);
        }
        if el.res[j].is_some() {
            return;
        }
        let r: Vec<u64> = el.coeffs.iter().map(|c| modp(c, p)).collect();
        if r[0] == 0 {
            self.bad[j] = true;
            return;
        }
        let md = Modulus::new(p);
        let i = md.inv(r[0]).unwrap();
        el.res[j] = Some(r.iter().map(|&x| md.mul(x, i) as u32).collect());
    }

    /// The next k good primes from index *from on (indices), with the
    /// residues of the elements `need` modulo them.
    fn good(&mut self, from: &mut usize, k: usize, need: &[usize]) -> Vec<usize> {
        let mut out = vec![];
        while out.len() < k {
            let j = *from;
            *from += 1;
            self.prime(j);
            if self.bad[j] {
                continue;
            }
            for &e in need {
                self.fill(e, j);
                if self.bad[j] {
                    break;
                }
            }
            if !self.bad[j] {
                out.push(j);
            }
        }
        out
    }

    /// The matrix reduced modulo prime j (only the rows `sel` if given):
    /// with echelon, the reduced echelon form of the rows modulo the
    /// pivots, by leading column, with the rows each came from; otherwise
    /// every row reduced by the pivots.
    fn elim(&self, m: &Mat, j: usize, sel: Option<&[usize]>, echelon: bool, threads: usize) -> (Vec<Row>, Vec<usize>) {
        let p = self.primes[j] as u32;
        let res = |e: usize| self.elems[e].res[j].as_ref().unwrap();
        let store: Vec<Row> = m.piv.iter().map(|(c, e)| Row { cols: c.clone(), vals: res(*e).clone() }).collect();
        let mut at: Vec<Option<&Row>> = vec![None; m.nc];
        for r in &store {
            at[r.cols[0] as usize] = Some(r);
        }
        let idx: Vec<usize> = match sel {
            Some(s) => s.to_vec(),
            None => (0..m.rows.len()).collect(),
        };
        let rows: Vec<Row> = idx.iter().map(|&k| {
            let (c, e, f) = &m.rows[k];
            Row { cols: c.clone(), vals: res(*e)[*f..].to_vec() }
        }).collect();
        let piv = Pivots { p, rows: at };
        let red = spelim::reduce_auto(&piv, &rows, m.nc, threads);
        if !echelon {
            return (red, idx);
        }
        let (ech, from) = spelim::echelonize_idx(red, m.nc, p);
        let out = spelim::back_reduce(ech, m.nc, p);
        let mut ord: Vec<usize> = (0..out.len()).collect();
        ord.sort_by_key(|&i| out[i].cols[0]);
        let from: Vec<usize> = ord.iter().map(|&i| idx[from[i]]).collect();
        let mut out: Vec<Option<Row>> = out.into_iter().map(Some).collect();
        (ord.iter().map(|&i| out[i].take().unwrap()).collect(), from)
    }

    fn reconstruct(&self, imgs: &[(usize, Vec<Row>)], lead: bool, hard: &mut (usize, usize), done: &mut Vec<Option<(QRow, usize)>>) -> Option<Vec<QRow>> {
        let v: Vec<(u64, &[Row])> = imgs.iter().map(|(j, r)| (self.primes[*j], r.as_slice())).collect();
        reconstruct_rows(&v, MARGIN, lead, hard, done)
    }

    /// F4's use of a matrix over Q: the rows reconstructed (see elim) and
    /// the images they came from.
    fn solve(&mut self, m: &Mat, echelon: bool) -> (Vec<QRow>, Vec<(usize, Vec<Row>)>) {
        let mut need: Vec<usize> = m.piv.iter().map(|x| x.1).chain(m.rows.iter().map(|x| x.1)).collect();
        need.sort_unstable();
        need.dedup();
        let mut next = 0usize;
        let t = self.threads;
        // (timings only when debugging: no clock in WebAssembly)
        let dbg = self.dbg;
        let now = || dbg.then(std::time::Instant::now);
        let secs = |t: Option<std::time::Instant>| t.map_or(0.0, |t| t.elapsed().as_secs_f64());
        let t_full = now();
        let first = self.good(&mut next, 2, &need);
        let full: Vec<(Vec<Row>, Vec<usize>)> = {
            let this = &*self;
            crate::run_parallel(2.min(t), &first, |&j| this.elim(m, j, None, echelon, (t / 2).max(1)))
        };
        // (the leading columns: without echelon rows may be zero, and are aligned)
        let profile = |rows: &[Row]| -> Vec<u32> { if echelon { rows.iter().map(|r| r.cols[0]).collect() } else { vec![] } };
        // the better image: more rows, else smaller leading columns
        let better = |a: &[u32], b: &[u32]| a.len() > b.len() || (a.len() == b.len() && a < b);
        let (p0, p1) = (profile(&full[0].0), profile(&full[1].0));
        let best = if echelon && better(&p1, &p0) { p1.clone() } else { p0.clone() };
        let mut tracer: Option<Vec<usize>> = None;
        let mut imgs: Vec<(usize, Vec<Row>)> = vec![];
        for (&j, (rows, from)) in first.iter().zip(full) {
            if !echelon || profile(&rows) == best {
                if echelon && tracer.is_none() {
                    tracer = Some(from);
                }
                imgs.push((j, rows));
            }
        }
        if !(first[0] == 0 && imgs[0].0 == 0) {
            self.witness = false;
        }
        if self.dbg && echelon && p0 != p1 {
            eprintln!("f4q: primes {} and {} disagree ({} and {} rows)", self.primes[first[0]], self.primes[first[1]], p0.len(), p1.len());
        }
        let mut hard = (0usize, 0usize);
        let mut done: Vec<Option<(QRow, usize)>> = vec![];
        let (mut te, mut tr) = (0.0, 0.0);
        let tf = secs(t_full);
        loop {
            if echelon && imgs[0].1.is_empty() {
                return (vec![], imgs);
            }
            let tt = now();
            let rec = self.reconstruct(&imgs, echelon, &mut hard, &mut done);
            tr += secs(tt);
            if let Some(r) = rec {
                self.last_k = imgs.len();
                if self.dbg {
                    eprintln!("f4q: solve: full {:.3}s, traced {:.3}s, reconstruct {:.3}s", tf, te, tr);
                }
                return (r, imgs);
            }
            let tt = now();
            let want = (self.last_k + 1).saturating_sub(imgs.len()).clamp(1, t);
            let js = self.good(&mut next, want, &need);
            let res: Vec<(Vec<Row>, Vec<usize>)> = {
                let this = &*self;
                let tr = tracer.as_deref();
                crate::run_parallel(t, &js, |&j| this.elim(m, j, tr, echelon, 1))
            };
            for (j, (rows, _)) in js.into_iter().zip(res) {
                if !echelon || profile(&rows) == best {
                    imgs.push((j, rows));
                }
            }
            te += secs(tt);
        }
    }

    /// A reconstructed row as an element: the leading word (coefficient
    /// den) and the entries, primitive; its residues modulo the primes of
    /// the images (rows `t` of them), monic.
    fn element(&mut self, lead: u64, row: &QRow, cols: &[(u128, u64)], imgs: &[(usize, Vec<Row>)], t: usize, with_lead: bool) -> usize {
        let (den, ents) = row;
        let mut words = vec![lead];
        let mut coeffs = vec![den.clone()];
        for (c, x) in ents {
            words.push(cols[*c as usize].1);
            coeffs.push(x.clone());
        }
        let mut g = BigInt::zero();
        for c in &coeffs {
            g = g.gcd(c);
            if g.is_one() {
                break;
            }
        }
        if !g.is_one() {
            for c in coeffs.iter_mut() {
                *c = &*c / &g;
            }
        }
        let mut res: Vec<Option<Vec<u32>>> = vec![];
        if with_lead {
            for (j, rows) in imgs {
                let r = &rows[t];
                let mut v = vec![1u32];
                for (c, _) in ents {
                    v.push(match r.cols.binary_search(c) {
                        Ok(i) => r.vals[i],
                        Err(_) => 0,
                    });
                }
                if res.len() <= *j {
                    res.resize(j + 1, None);
                }
                res[*j] = Some(v);
            }
        }
        self.elems.push(Elem { words, coeffs, res });
        self.elems.len() - 1
    }
}

/// The reduced Groebner basis over Q of fs (nonzero) in a degree order, by
/// decreasing leading monomial; Ok(None) if proof was asked and the check
/// failed.  Inhomogeneous input in degrevlex is homogenized (h last, so
/// the basis dehomogenizes to one of the ideal): intermediate coefficients
/// are then far smaller (cyclic-7: 141 bits at degree 13 instead of 1490
/// by sugar), as Magma's verbose output shows it does over Q too.
pub fn groebner_q_f4(fs: &[QPoly], o: Order, proof: bool) -> Result<Option<Vec<QPoly>>, String> {
    let n = fs[0].num.n;
    let homog = fs.iter().all(|f| {
        let pk = Packing { n, bits: f.num.bits };
        let d = f.num.exps.iter().map(|&w| pk.degree(w));
        d.clone().min() == d.max()
    });
    let (out, witness) = if !homog && o == Order::DegRevLex && std::env::var("SB_F4Q_HOMOG").as_deref() != Ok("0") {
        let fh: Vec<QPoly> = fs.iter().map(|f| homogenize(f)).collect::<Result<_, _>>()?;
        let (gh, w1) = with_bits(&fh, o, false, false)?;
        let dh: Vec<QPoly> = gh.iter().map(|g| dehomogenize(&crate::sparse::from_q(g, n + 1))).collect::<Result<_, _>>()?;
        let (g, w2) = with_bits(&dh, o, true, true)?;
        (g, w1 && w2)
    } else {
        with_bits(fs, o, false, true)?
    };
    if proof && !check(fs, &out, o, witness)? {
        return Ok(None);
    }
    Ok(Some(out.iter().map(|g| crate::sparse::from_q(g, n)).collect()))
}

/// f(x, h) homogeneous with f(x, 1) = f.
fn homogenize(f: &QPoly) -> Result<QPoly, String> {
    let n = f.num.n;
    let pk = Packing { n, bits: f.num.bits };
    let d = f.num.exps.iter().map(|&w| pk.degree(w)).max().unwrap_or(0);
    let terms = (0..f.num.len()).map(|i| {
        let mut e = pk.unpack(f.num.exps[i]);
        e.push(d - pk.degree(f.num.exps[i]));
        (e, f.num.coeffs.big(i))
    }).collect();
    Ok(QPoly { num: crate::ZPoly::from_terms(n + 1, terms)?, den: f.den.clone(), p: 0 })
}

/// f(x, 1) for f in the variables x, h.
fn dehomogenize(f: &QPoly) -> Result<QPoly, String> {
    let n = f.num.n - 1;
    let pk = Packing { n: n + 1, bits: f.num.bits };
    let terms = (0..f.num.len()).map(|i| {
        let mut e = pk.unpack(f.num.exps[i]);
        e.pop();
        (e, f.num.coeffs.big(i))
    }).collect();
    Ok(QPoly { num: crate::ZPoly::from_terms(n, terms)?, den: f.den.clone(), p: 0 })
}

/// run, widening the packing on overflow.
fn with_bits(fs: &[QPoly], o: Order, gb_input: bool, reduce: bool) -> Result<(Vec<Poly<QQ>>, bool), String> {
    let (mut bits, maxb) = bits_range(fs, o);
    loop {
        if bits > maxb {
            return Err("exponents too large to pack".into());
        }
        match run(fs, o, bits, gb_input, reduce) {
            Ok(r) => return Ok(r),
            Err(Overflow) => {
                if bits == maxb {
                    return Err("exponents too large to pack".into());
                }
                bits = (bits * 2).min(maxb)
            }
        }
    }
}

/// The check of groebner_q: the leading monomials are those of a basis
/// modulo a prime (the first, if witness: every matrix used its images
/// modulo it), the generators and S-pairs reduce to 0 over Q.
fn check(fs: &[QPoly], out: &[Poly<QQ>], o: Order, witness: bool) -> Result<bool, String> {
    let pk = out[0].pk;
    let dbg = std::env::var("SB_F4_DEBUG").is_ok();
    let tp = dbg.then(std::time::Instant::now);
    if !witness {
        let mut ps = crate::gcd::Primes::below(1 << 31);
        let p = loop {
            let p = ps.next().unwrap();
            if fs.iter().all(|f| modp(&f.den, p) != 0) {
                break p;
            }
        };
        let modp: Vec<QPoly> = fs.iter().map(|f| {
            let dinv = BigInt::from(Modulus::new(p).inv(modp(&f.den, p)).unwrap());
            QPoly { num: f.num.scale(&dinv).reduce_mod(p), den: BigInt::one(), p }
        }).collect();
        let gp = groebner_p(&modp, o, p)?;
        let lp: Vec<Vec<u64>> = gp.iter().map(|f| {
            let q = Packing { n: pk.n, bits: f.num.bits };
            q.unpack(*f.num.exps.iter().max_by_key(|&&w| q.key(o, w)).unwrap())
        }).collect();
        let lq: Vec<Vec<u64>> = out.iter().map(|f| pk.unpack(f.t[0].w)).collect();
        if lp != lq {
            return Ok(false);
        }
    }
    let ok = verify_q(fs, out, o, pk)?;
    if dbg {
        eprintln!("f4q: verified {} in {:.3}s (witness {})", ok, tp.map_or(0.0, |t| t.elapsed().as_secs_f64()), witness);
    }
    Ok(ok)
}

/// The reduced basis by F4 over Q (or, with gb_input, the reduced basis of
/// a Groebner basis given; without reduce, only minimal), and whether every
/// matrix used its images modulo the first prime.
fn run(fs: &[QPoly], o: Order, bits: u32, gb_input: bool, reduce: bool) -> Result<(Vec<Poly<QQ>>, bool), Overflow> {
    let n = fs[0].num.n;
    let pk = Packing { n, bits };
    let dbg = std::env::var("SB_F4_DEBUG").is_ok();
    let t0 = dbg.then(std::time::Instant::now);
    let secs = |t: Option<std::time::Instant>| t.map_or(0.0, |t| t.elapsed().as_secs_f64());
    let mut cx = Ctx {
        primes: vec![],
        bad: vec![],
        gen: crate::gcd::Primes::below(1 << 31),
        elems: vec![],
        threads: crate::threads(),
        last_k: 2,
        witness: true,
        dbg,
    };
    // the generators, primitive, by decreasing monomial
    for f in fs {
        let z = f.num.repack(bits);
        let mut t: Vec<(u128, u64, BigInt)> = (0..z.len()).map(|i| (pk.key(o, z.exps[i]), z.exps[i], z.coeffs.big(i))).collect();
        if t.iter().any(|x| x.1 & pk.guard() != 0) {
            return Err(Overflow);
        }
        t.sort_unstable_by(|a, b| b.0.cmp(&a.0));
        let mut g = BigInt::zero();
        for x in &t {
            g = g.gcd(&x.2);
        }
        if t[0].2.is_negative() {
            g = -g;
        }
        cx.elems.push(Elem { words: t.iter().map(|x| x.1).collect(), coeffs: t.into_iter().map(|x| x.2 / &g).collect(), res: vec![] });
    }
    let nin = cx.elems.len();
    let md = Modulus::new(cx.prime(0));
    let mut sym = F4 { pk, o, md: &md, guard: pk.guard(), g: vec![], lead: vec![], active: vec![], sugar: vec![], pairs: vec![], prob: false };
    // the basis element i of sym is cx.elems[base[i]]
    let mut base: Vec<usize> = vec![];
    let shape = |e: &Elem| -> P { e.words.iter().map(|&w| (w, 0)).collect() };
    // a step: the matrix of these pivots and rows (multiplier, element)
    let build = |sym: &F4, base: &[usize], pivots: &HashMap<u64, (u64, usize)>, todo: &[(u64, usize)], cols: &[(u128, u64)], elems: &[Elem]| -> Mat {
        let col: HashMap<u64, u32> = cols.iter().enumerate().map(|(i, &(_, w))| (w, i as u32)).collect();
        let piv = pivots.values().map(|&(m, i)| (sym.g[i].iter().map(|x| col[&(x.0 + m)]).collect(), base[i])).collect();
        let rows = todo.iter().map(|&(m, e)| (elems[e].words.iter().map(|&w| col[&(w + m)]).collect(), e, 0)).collect();
        Mat { nc: cols.len(), piv, rows }
    };
    if gb_input {
        // a Groebner basis already: its elements as the basis
        for e in 0..nin {
            let f = shape(&cx.elems[e]);
            base.push(e);
            sym.lead.push(f[0].0);
            sym.g.push(f);
            sym.active.push(true);
            sym.sugar.push(0);
        }
    } else {
        // the generators echelonized together, by increasing leading monomial
        let mut ins: Vec<usize> = (0..nin).collect();
        ins.sort_by_key(|&e| pk.key(o, cx.elems[e].words[0]));
        let mut pivots = HashMap::new();
        let cols = sym.preprocess(&mut pivots, &mut ins.iter().flat_map(|&e| cx.elems[e].words.iter().copied()))?;
        let todo: Vec<(u64, usize)> = ins.iter().map(|&e| (0, e)).collect();
        let m = build(&sym, &base, &pivots, &todo, &cols, &cx.elems);
        let (rows, imgs) = cx.solve(&m, true);
        for (t, r) in rows.iter().enumerate() {
            let lead = cols[imgs[0].1[t].cols[0] as usize].1;
            let e = cx.element(lead, r, &cols, &imgs, t, true);
            base.push(e);
            sym.add(shape(&cx.elems[e]), 0);
        }
        while !sym.pairs.is_empty() {
            sagebrush_interrupt::check();
            let (dmin, mut pivots, sel) = sym.select()?;
            let todo: Vec<(u64, usize)> = sel.iter().map(|&(m, i)| (m, base[i])).collect();
            let cols = sym.preprocess(&mut pivots, &mut todo.iter().flat_map(|&(m, e)| cx.elems[e].words.iter().map(move |&w| w + m)))?;
            let m = build(&sym, &base, &pivots, &todo, &cols, &cx.elems);
            let (rows, imgs) = cx.solve(&m, true);
            if dbg {
                let pb = rows.iter().flat_map(|r| r.1.iter().map(|x| x.1.bits()).chain(std::iter::once(r.0.bits()))).max().unwrap_or(0);
                eprintln!("f4q: deg {} rows {} pivots {} cols {} new {} primes {} max bits {} t {:.3}", dmin, m.rows.len(), m.piv.len(), m.nc, rows.len(), imgs.len(), pb, secs(t0));
            }
            for (t, r) in rows.iter().enumerate() {
                let lead = cols[imgs[0].1[t].cols[0] as usize].1;
                let e = cx.element(lead, r, &cols, &imgs, t, true);
                base.push(e);
                sym.add(shape(&cx.elems[e]), dmin);
            }
        }
    }
    // the reduced basis: minimal, then the tails reduced by the matrix of
    // one more (non-echelon) reduction
    let mut idx: Vec<usize> = (0..sym.g.len()).filter(|&i| sym.active[i]).collect();
    idx.sort_by_key(|&i| sym.key(sym.lead[i]));
    let mut minimal: Vec<usize> = vec![];
    for &i in &idx {
        if !minimal.iter().any(|&j| sym.divides(sym.lead[j], sym.lead[i])) {
            minimal.push(i);
        }
    }
    let sub = F4 {
        pk,
        o,
        md: &md,
        guard: pk.guard(),
        g: minimal.iter().map(|&i| sym.g[i].clone()).collect(),
        lead: minimal.iter().map(|&i| sym.lead[i]).collect(),
        active: vec![true; minimal.len()],
        sugar: vec![0; minimal.len()],
        pairs: vec![],
        prob: false,
    };
    let sbase: Vec<usize> = minimal.iter().map(|&i| base[i]).collect();
    if !reduce {
        let out = sbase.iter().map(|&e| {
            let el = &cx.elems[e];
            Poly::from_terms(&QQ, pk, o, el.words.iter().zip(&el.coeffs).map(|(&w, c)| (w, BigRational::new(c.clone(), el.coeffs[0].clone()))).collect())
        }).collect();
        return Ok((out, cx.witness));
    }
    let mut pivots = HashMap::new();
    let cols = sub.preprocess(&mut pivots, &mut sbase.iter().flat_map(|&e| cx.elems[e].words[1..].iter().copied()))?;
    let col: HashMap<u64, u32> = cols.iter().enumerate().map(|(i, &(_, w))| (w, i as u32)).collect();
    let m = Mat {
        nc: cols.len(),
        piv: pivots.values().map(|&(mm, i)| (sub.g[i].iter().map(|x| col[&(x.0 + mm)]).collect(), sbase[i])).collect(),
        rows: sbase.iter().map(|&e| (cx.elems[e].words[1..].iter().map(|w| col[w]).collect(), e, 1)).collect(),
    };
    let (tails, imgs) = cx.solve(&m, false);
    if dbg {
        eprintln!("f4q: reduced {} elements with {} primes, t {:.3}", sbase.len(), imgs.len(), secs(t0));
    }
    let mut out: Vec<Poly<QQ>> = sbase.iter().zip(&tails).map(|(&e, (den, ents))| {
        let mut ts = vec![(cx.elems[e].words[0], BigRational::one())];
        for (c, x) in ents {
            ts.push((cols[*c as usize].1, BigRational::new(x.clone(), den.clone())));
        }
        Poly::from_terms(&QQ, pk, o, ts)
    }).collect();
    out.sort_by_key(|f| std::cmp::Reverse(f.t[0].key));
    let _ = nin;
    Ok((out, cx.witness))
}

/// Rows over Q from their images modulo the primes (rows aligned; with
/// lead, each has a 1 at its first column, left out), or None if more
/// primes are needed.  hard: the (row, entry) that failed last, tried
/// first; done: the rows found so far, and the images they agree with;
/// margin: the bits to spare.
pub(crate) fn reconstruct_rows(imgs: &[(u64, &[Row])], margin: u64, lead: bool, hard: &mut (usize, usize), done: &mut Vec<Option<(QRow, usize)>>) -> Option<Vec<QRow>> {
    reconstruct_rows_opt(imgs, margin, lead, true, hard, done)
}

/// reconstruct_rows; with common, each row over a common denominator found
/// as it goes (cheap when a row's entries share one, as a monic polynomial's
/// often do), else each entry by itself (entries with unrelated
/// denominators: the common one would be their product).
pub(crate) fn reconstruct_rows_opt(imgs: &[(u64, &[Row])], margin: u64, lead: bool, common: bool, hard: &mut (usize, usize), done: &mut Vec<Option<(QRow, usize)>>) -> Option<Vec<QRow>> {
    let ps: Vec<u64> = imgs.iter().map(|x| x.0).collect();
    let crt = Crt::new(&ps);
    let k = ps.len();
    let nrows = imgs[0].1.len();
    let skip = lead as usize;
    // the union of the rows' supports
    let support = |t: usize| -> Vec<u32> {
        let mut c: Vec<u32> = imgs.iter().flat_map(|x| x.1[t].cols[skip..].iter().copied()).collect();
        c.sort_unstable();
        c.dedup();
        c
    };
    let residues = |t: usize, col: u32, out: &mut Vec<u64>| {
        out.clear();
        for x in imgs {
            let r = &x.1[t];
            out.push(match r.cols.binary_search(&col) {
                Ok(i) => r.vals[i] as u64,
                Err(_) => 0,
            });
        }
    };
    let mut r = Vec::with_capacity(k);
    // the entry that failed last: if it still does, so would the rest (a
    // cheap test before the whole pass)
    if hard.0 < nrows && done.get(hard.0).is_none_or(|d| d.is_none()) {
        let sup = support(hard.0);
        if let Some(&c) = sup.get(hard.1) {
            residues(hard.0, c, &mut r);
            let x = crt.lift(&r);
            match ratrecon(&x, &crt.m) {
                Some(q) if q.numer().bits() + q.denom().bits() + margin <= crt.bits => {}
                _ => return None,
            }
        }
    }
    done.resize(nrows, None);
    let prev: Vec<Option<(QRow, usize)>> = std::mem::take(done);
    // each row on its own (natively on threads): Ok(the row, the images it
    // agrees with) or Err(the entry that failed)
    let row = |&t: &usize| -> Result<(QRow, usize), usize> {
        // a row found before: checked against the images since
        if let Some(((den, ents), from)) = &prev[t] {
            let ok = imgs[*from..].iter().all(|(j, rows)| {
                let p = *j;
                let md = Modulus::new(p);
                let dinv = match md.inv(modp(den, p)) {
                    Some(x) => x,
                    None => return false,
                };
                let r = &rows[t];
                let mut k = skip;
                for (c, x) in ents {
                    let v = md.mul(modp(x, p), dinv);
                    while k < r.cols.len() && r.cols[k] < *c {
                        if r.vals[k] != 0 {
                            return false;
                        }
                        k += 1;
                    }
                    let w = if k < r.cols.len() && r.cols[k] == *c {
                        k += 1;
                        r.vals[k - 1] as u64
                    } else {
                        0
                    };
                    if v != w {
                        return false;
                    }
                }
                r.vals[k..].iter().all(|&v| v == 0)
            });
            if ok {
                return Ok(((den.clone(), ents.clone()), k));
            }
        }
        let mut r = Vec::with_capacity(k);
        let sup = support(t);
        if !common {
            let mut qs: Vec<(u32, BigRational)> = Vec::with_capacity(sup.len());
            let mut den = BigInt::one();
            for (ci, &c) in sup.iter().enumerate() {
                residues(t, c, &mut r);
                let x = crt.lift(&r);
                if x.is_zero() {
                    continue;
                }
                match ratrecon(&x, &crt.m) {
                    Some(q) if q.numer().bits() + q.denom().bits() + margin <= crt.bits => {
                        den = den.lcm(q.denom());
                        qs.push((c, q));
                    }
                    _ => return Err(ci),
                }
            }
            let ents = qs.into_iter().map(|(c, q)| (c, q.numer() * (&den / q.denom()))).collect();
            return Ok(((den, ents), k));
        }
        let mut den = BigInt::one();
        let mut dmod: Vec<u64> = vec![1; k];
        let mut ents: Vec<(u32, BigInt)> = Vec::with_capacity(sup.len());
        for (ci, &c) in sup.iter().enumerate() {
            residues(t, c, &mut r);
            // the entry times the denominator so far
            for i in 0..k {
                r[i] = crt.mds[i].mul(r[i], dmod[i]);
            }
            let y = crt.lift(&r);
            if y.is_zero() {
                continue;
            }
            if y.bits() + den.bits() + margin <= crt.bits {
                ents.push((c, y));
                continue;
            }
            let ok = match ratrecon(&y, &crt.m) {
                Some(q) if q.numer().bits() + q.denom().bits() + den.bits() + margin <= crt.bits => Some(q),
                _ => None,
            };
            let Some(q) = ok else { return Err(ci) };
            // a new factor of the denominator
            let d = q.denom().clone();
            for e in ents.iter_mut() {
                e.1 = &e.1 * &d;
            }
            den = den * &d;
            for i in 0..k {
                dmod[i] = modp(&den, ps[i]);
            }
            ents.push((c, q.numer().clone()));
        }
        Ok(((den, ents), k))
    };
    let idx: Vec<usize> = (0..nrows).collect();
    let threads = if nrows >= 32 { crate::threads() } else { 1 };
    let res = crate::run_parallel(threads, &idx, row);
    let mut failed = None;
    *done = res.into_iter().enumerate().map(|(t, r)| match r {
        Ok(x) => Some(x),
        Err(ci) => {
            failed.get_or_insert((t, ci));
            None
        }
    }).collect();
    if let Some(h) = failed {
        *hard = h;
        return None;
    }
    Some(std::mem::take(done).into_iter().map(|x| x.unwrap().0).collect())
}
