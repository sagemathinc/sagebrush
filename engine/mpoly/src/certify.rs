//! A proof, from computations modulo primes, that S-polynomials reduce to 0
//! over Q.
//!
//! The S-polynomials of the pairs (integer rows T) and, by F4's symbolic
//! preprocessing, a reducer m g for each monomial some leading monomial
//! divides (integer pivot rows P with distinct leading columns, the set L)
//! make a matrix.  Let X be the pivot rows reduced by one another over Q,
//! restricted to the other columns N (Faugère and Lachartre's B' = A^-1 B:
//! for u in L, x^u - X_u is the normal form of x^u).  Then
//!
//!   (i)  P_k|N = sum over u in L of P_k[u] X_u, for every pivot row, and
//!   (ii) T_t|N = sum over u in L of T_t[u] X_u, for every S-polynomial,
//!
//! say that X is A^-1 B (A, the pivots on L, is triangular with nonzero
//! diagonal) and that each T_t is in the span of the pivots: it reduces to
//! 0, a representation by multiples of the basis with leading monomials
//! below the lcm (Buchberger's criterion).  Modulo a prime p not dividing a
//! leading coefficient, spelim::fl_parts computes X mod p and reduces T,
//! which must give 0.  X is reconstructed from the images (CRT and rational
//! reconstruction, numerators X'_u over denominators d_u), so (i) and (ii),
//! denominators cleared, hold modulo M, the product of the primes: both
//! sides are integers, bounded through the sizes of X', the d_u and the
//! rows, so once M exceeds twice the bound they are equal (Storjohann's
//! criterion for an echelon form, as f4ncgb uses it).  Nothing is
//! multiplied out over Z.  The cost: eliminations modulo primes and the
//! reconstruction of X, whose entries (normal forms) are 1.5 to 2 times the
//! basis's size, where the quotients of the reductions over Z are about 3.5
//! times (katsura-7).

use crate::f4::{F4, ZT};
use crate::f4q::{modp, reconstruct_rows, QRow};
use crate::order::{Order, Packing};
use crate::sparse::Overflow;
use num_integer::Integer;
use num_traits::{One, Zero};
use sagebrush_arith::spelim::{self, Pivots, Row};
use sagebrush_bigint::nmod::Modulus;
use sagebrush_bigint::BigInt;
use std::collections::{BTreeMap, HashMap};

/// Some(true) if the S-polynomials of the pairs (i, j, lcm) of g (primitive
/// integer polynomials, positive leading coefficients, terms (key, word,
/// coefficient) by decreasing key) provably reduce to 0 by g; Some(false)
/// if one does not (modulo a prime, so not over Q either); None if the
/// certificate would take too much memory (the caller reduces over Z).
pub(crate) fn certify_spairs(g: &[ZT], pairs: &[(usize, usize, u64)], pk: Packing, o: Order) -> Result<Option<bool>, Overflow> {
    let dbg = std::env::var("SB_F4_DEBUG").is_ok();
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
    // the pivot rows by leading column: (columns, element)
    let mut prow: Vec<Option<(Vec<u32>, usize)>> = vec![None; nc];
    for (&lm, &(m, k)) in &pivots {
        prow[col[&lm] as usize] = Some((g[k].iter().map(|x| col[&(x.1 + m)]).collect(), k));
    }
    let npiv = pivots.len();
    if npiv * (nc - npiv) > 4_000_000 {
        return Ok(None);
    }
    // the S-polynomials (c_j / d) (l / l_i) g_i - (c_i / d) (l / l_j) g_j
    // as integer rows, by increasing column
    let trows: Vec<Vec<(u32, BigInt)>> = pairs.iter().map(|&(i, j, l)| {
        let (ci, cj) = (&g[i][0].2, &g[j][0].2);
        let d = ci.gcd(cj);
        let (a, b) = (cj / &d, ci / &d);
        let mut t: BTreeMap<u32, BigInt> = BTreeMap::new();
        for (k, s, neg) in [(i, &a, false), (j, &b, true)] {
            let m = l - lead[k];
            for x in &g[k][1..] {
                let e = t.entry(col[&(x.1 + m)]).or_insert_with(BigInt::zero);
                let v = s * &x.2;
                if neg {
                    *e -= v;
                } else {
                    *e += v;
                }
            }
        }
        t.into_iter().filter(|x| !x.1.is_zero()).collect()
    }).collect();
    // the eliminations modulo p: the reduced pivots over N as sparse rows
    // (columns numbered within N), aligned with the needed pivots; None
    // for a prime dividing a leading coefficient
    let image = |&p: &u64| -> Option<(Vec<u32>, Vec<Row>, bool)> {
        let mdp = Modulus::new(p);
        let mut res: Vec<Vec<u32>> = Vec::with_capacity(g.len());
        for f in g {
            let r: Vec<u64> = f.iter().map(|x| modp(&x.2, p)).collect();
            let inv = mdp.inv(r[0])?;
            res.push(r.iter().map(|&x| mdp.mul(x, inv) as u32).collect());
        }
        let store: Vec<(usize, Row)> = prow.iter().enumerate().filter_map(|(c, x)| x.as_ref().map(|(pc, k)| (c, Row { cols: pc.clone(), vals: res[*k].clone() }))).collect();
        let mut at: Vec<Option<&Row>> = vec![None; nc];
        for (c, r) in &store {
            at[*c] = Some(r);
        }
        let rows: Vec<Row> = trows.iter().map(|t| Row { cols: t.iter().map(|x| x.0).collect(), vals: t.iter().map(|x| modp(&x.1, p) as u32).collect() }).collect();
        let f = spelim::fl_parts(&Pivots { p: p as u32, rows: at }, &rows, nc);
        let zero = f.rows.iter().all(|r| r.is_empty());
        let x: Vec<Row> = f.bp.into_iter().map(|b| {
            let mut r = Row::default();
            if let Some(v) = b {
                for (i, &x) in v.iter().enumerate() {
                    if x != 0 {
                        r.cols.push(i as u32);
                        r.vals.push(x);
                    }
                }
            }
            r
        }).collect();
        Some((f.needed, x, zero))
    };
    let threads = crate::threads();
    let mut primes = crate::gcd::Primes::below(1 << 31);
    let mut imgs: Vec<(u64, Vec<Row>)> = vec![];
    let mut needed: Option<Vec<u32>> = None;
    let (mut hard, mut done): ((usize, usize), Vec<Option<(QRow, usize)>>) = ((0, 0), vec![]);
    let mut tries = 0;
    loop {
        sagebrush_interrupt::check();
        let batch: Vec<u64> = (&mut primes).take(threads.max(1)).collect();
        for (p, r) in batch.iter().zip(crate::run_parallel(threads, &batch, image)) {
            let Some((nd, x, zero)) = r else { continue };
            if !zero {
                if dbg {
                    eprintln!("certify: an S-polynomial does not reduce to 0 modulo {}", p);
                }
                return Ok(Some(false));
            }
            match &needed {
                None => needed = Some(nd),
                Some(n0) if *n0 != nd => return Ok(None),
                _ => {}
            }
            imgs.push((*p, x));
        }
        if imgs.is_empty() {
            continue;
        }
        let v: Vec<(u64, &[Row])> = imgs.iter().map(|(p, r)| (*p, r.as_slice())).collect();
        let tr = dbg.then(std::time::Instant::now);
        let rec = reconstruct_rows(&v, 30, false, &mut hard, &mut done);
        if dbg {
            eprintln!("certify: {} primes, reconstruction {} in {:.3}s (hard {:?}, rows done {})", imgs.len(), rec.is_some(), tr.map_or(0.0, |t| t.elapsed().as_secs_f64()), hard, done.iter().filter(|d| d.is_some()).count());
        }
        let Some(x) = rec else { continue };
        let mut m = BigInt::one();
        for (p, _) in &imgs {
            m = m * BigInt::from(*p);
        }
        let need = needed.as_ref().unwrap();
        let (b, ok) = bound(&x, need, &prow, g, &trows, nc, m.bits());
        if dbg {
            eprintln!("certify: {} columns, {} pivots needed, {} primes ({} bits), bound {} bits", nc, need.len(), imgs.len(), m.bits(), b);
        }
        if ok {
            return Ok(Some(true));
        }
        tries += 1;
        if tries > 200 {
            return Ok(None);
        }
    }
}

/// The largest bound (bits) of the two sides of the identities (i) and (ii)
/// with denominators cleared, and whether 2^mbits exceeds twice it.
fn bound(x: &[QRow], needed: &[u32], prow: &[Option<(Vec<u32>, usize)>], g: &[ZT], trows: &[Vec<(u32, BigInt)>], nc: usize, mbits: u64) -> (u64, bool) {
    // the row of X of each needed pivot column
    let mut xi: Vec<u32> = vec![u32::MAX; nc];
    for (i, &c) in needed.iter().enumerate() {
        xi[c as usize] = i as u32;
    }
    // the denominators, interned
    let mut dens: Vec<BigInt> = vec![];
    let mut did: HashMap<BigInt, u32> = HashMap::new();
    let xd: Vec<u32> = x.iter().map(|(d, _)| *did.entry(d.clone()).or_insert_with(|| {
        dens.push(d.clone());
        dens.len() as u32 - 1
    })).collect();
    let xb: Vec<u64> = x.iter().map(|(_, e)| e.iter().map(|y| y.1.bits()).max().unwrap_or(0)).collect();
    let db: Vec<u64> = x.iter().map(|(d, _)| d.bits()).collect();
    let mut lcm_bits: HashMap<Vec<u32>, u64> = HashMap::new();
    let mut worst = 0u64;
    // one identity: coefficients on L (by column) and the N part's sizes
    let mut one = |lc: &mut dyn Iterator<Item = (u32, u64)>, ybits: u64| {
        let mut ids: Vec<u32> = vec![];
        let mut terms: Vec<(usize, u64)> = vec![];
        for (c, cb) in lc {
            let i = xi[c as usize];
            debug_assert!(i != u32::MAX);
            if i == u32::MAX || x[i as usize].1.is_empty() {
                continue;
            }
            ids.push(xd[i as usize]);
            terms.push((i as usize, cb));
        }
        ids.sort_unstable();
        ids.dedup();
        let dbits = *lcm_bits.entry(ids.clone()).or_insert_with(|| {
            let mut l = BigInt::one();
            for &k in &ids {
                l = l.lcm(&dens[k as usize]);
            }
            l.bits()
        });
        let mut b = if ybits > 0 { dbits + ybits } else { 0 };
        for &(i, cb) in &terms {
            b = b.max(cb + dbits + 1 - db[i].min(dbits) + xb[i]);
        }
        let n = terms.len() as u64 + 1;
        b += 64 - n.leading_zeros() as u64 + 1;
        worst = worst.max(b);
    };
    for &c in needed {
        let (pc, k) = prow[c as usize].as_ref().unwrap();
        let mut ybits = 0;
        let mut lcs = vec![];
        for (&cc, t) in pc.iter().zip(&g[*k]) {
            if prow[cc as usize].is_some() {
                lcs.push((cc, t.2.bits()));
            } else {
                ybits = ybits.max(t.2.bits());
            }
        }
        one(&mut lcs.into_iter(), ybits);
    }
    for t in trows {
        let mut ybits = 0;
        let mut lcs = vec![];
        for (c, v) in t {
            if prow[*c as usize].is_some() {
                lcs.push((*c, v.bits()));
            } else {
                ybits = ybits.max(v.bits());
            }
        }
        one(&mut lcs.into_iter(), ybits);
    }
    (worst, worst + 2 <= mbits)
}
