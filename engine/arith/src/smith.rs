//! The Smith normal form with transforms: (D, U, V) with U A V = D, U and
//! V unimodular, D diagonal with the invariant factors t_1 | t_2 | ... in
//! order (zeros last).
//!
//! Cost (policy r4): L is [`floor_bytes`] (admitted before anything is
//! allocated); E is None, never 0 and never a partial figure: no
//! estimate until the matrix operations' calibration wires one (when a
//! cost() lands here it reports work_estimate = None until then); U is
//! None (the classical elimination's entries grow without bound, and the
//! routes' attempts are uncapped).
//!
//! Units (`cost::tally`), counted in a `cost::Local` after the work and
//! flushed at the Stop checks (coarse: an attempt or a pass each): BigInt products through
//! `bigmul_units` (a product's accumulation into its row is part of its
//! units), quotients and divisibility tests through `bigdiv_units`, the
//! pivot search's absolute values, the swaps and negations as Move.

use crate::cost::{bigdiv_units, bigmul_units, Family, Local, Units};
use crate::snf::{Big, Word, Zn, WORD_E};
use crate::zmat::{copy_units, limbs, ZMat};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

/// The route a Smith form with transforms took.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// k <= 1 nontrivial invariant factors: from one exact inverse.
    Cyclic,
    /// 2 <= k <= k_max: k trailing generators, from the same inverse.
    Trailing,
    /// The classical elimination over Z (by shape: singular or
    /// rectangular, or more than k_max nontrivial invariants).
    Classical,
}

/// A Smith form with its transforms: `u * a * v == d`, the route taken
/// and its attempts (the preconditionings tried; 0 for the classical
/// route).
#[derive(Clone, Debug)]
pub struct SmithForm {
    pub d: ZMat,
    pub u: ZMat,
    pub v: ZMat,
    pub route: Route,
    pub attempts: u64,
}

fn identity_rows(n: usize) -> Vec<Vec<BigInt>> {
    (0..n).map(|i| (0..n).map(|j| BigInt::from((i == j) as u8)).collect()).collect()
}

fn to_zmat(rows: Vec<Vec<BigInt>>, cols: usize) -> ZMat {
    let r = rows.len();
    ZMat { rows: r, cols, d: rows.into_iter().flatten().collect() }
}

/// row_i -= q row_j (i != j), counted: a product per entry.
fn row_sub(m: &mut [Vec<BigInt>], i: usize, j: usize, q: &BigInt, acc: &mut Local) {
    let lq = limbs(q);
    let (a, b) = if i < j {
        let (lo, hi) = m.split_at_mut(j);
        (&mut lo[i], &hi[0])
    } else {
        let (lo, hi) = m.split_at_mut(i);
        (&mut hi[0], &lo[j])
    };
    let mut mul = 0u64;
    for (x, y) in a.iter_mut().zip(b.iter()) {
        if !y.is_zero() {
            *x -= q * y;
            mul = mul.saturating_add(bigmul_units(lq, limbs(y)).get(Family::MulSchool));
        }
    }
    acc.n(Family::MulSchool, mul);
}

/// col_i -= q col_j (i != j), counted: a product per entry.
fn col_sub(m: &mut [Vec<BigInt>], i: usize, j: usize, q: &BigInt, acc: &mut Local) {
    let lq = limbs(q);
    let mut mul = 0u64;
    for r in m.iter_mut() {
        if !r[j].is_zero() {
            let y = r[j].clone();
            r[i] -= q * &y;
            mul = mul.saturating_add(bigmul_units(lq, limbs(&y)).get(Family::MulSchool));
        }
    }
    acc.n(Family::MulSchool, mul);
}

/// The classical Smith form with transforms of any m x n integer matrix:
/// the smallest-pivot elimination over Z, carrying U and V.  Always
/// correct, but its entries can grow without bound (r2's fallback, chosen
/// by shape: singular or rectangular input, or more than k_max nontrivial
/// invariants).  The same pivots, in the same order, as the Python
/// elimination it replaces (smallest absolute value, then row, then
/// column), so its transforms are the ones Sage mode returned before.
pub fn smith_classical(a: &ZMat) -> SmithForm {
    let (m, n) = (a.rows, a.cols);
    let mut acc = Local::new();
    let mut x: Vec<Vec<BigInt>> = (0..m).map(|i| a.d[i * n..(i + 1) * n].to_vec()).collect();
    let mut u = identity_rows(m);
    let mut v = identity_rows(n);
    acc.n(Family::Move, copy_units(&a.d).saturating_add((m * m + n * n) as u64));
    for t in 0..m.min(n) {
        loop {
            acc.flush();
            sagebrush_interrupt::check_coarse();
            // the smallest nonzero entry at or after (t, t): absolute value,
            // then row, then column
            let mut best: Option<(BigInt, usize, usize)> = None;
            let mut moved = 0u64;
            for (i, row) in x.iter().enumerate().skip(t) {
                for (j, e) in row.iter().enumerate().skip(t) {
                    if e.is_zero() {
                        continue;
                    }
                    let ab = e.abs();
                    moved = moved.saturating_add(limbs(e) as u64);
                    if best.as_ref().is_none_or(|(b, _, _)| ab < *b) {
                        best = Some((ab, i, j));
                    }
                }
            }
            acc.n(Family::Move, moved);
            let Some((_, i, j)) = best else { break };
            x.swap(t, i);
            u.swap(t, i);
            for r in x.iter_mut() {
                r.swap(t, j);
            }
            for r in v.iter_mut() {
                r.swap(t, j);
            }
            acc.n(Family::Move, (m + n) as u64);
            let mut done = true;
            for i in t + 1..m {
                let p = x[t][t].clone();
                let q = x[i][t].div_floor(&p);
                acc.add(bigdiv_units(limbs(&x[i][t]), limbs(&p)));
                if !q.is_zero() {
                    row_sub(&mut x, i, t, &q, &mut acc);
                    row_sub(&mut u, i, t, &q, &mut acc);
                }
                if !x[i][t].is_zero() {
                    done = false;
                }
            }
            for j in t + 1..n {
                let p = x[t][t].clone();
                let q = x[t][j].div_floor(&p);
                acc.add(bigdiv_units(limbs(&x[t][j]), limbs(&p)));
                if !q.is_zero() {
                    col_sub(&mut x, j, t, &q, &mut acc);
                    col_sub(&mut v, j, t, &q, &mut acc);
                }
                if !x[t][j].is_zero() {
                    done = false;
                }
            }
            if !done {
                continue;
            }
            // the first entry below and right of the pivot that it does not
            // divide: add its row to the pivot's
            let p = x[t][t].clone();
            let lp = limbs(&p);
            let mut bad = None;
            'scan: for (i, row) in x.iter().enumerate().skip(t + 1) {
                for e in row.iter().skip(t + 1) {
                    acc.add(bigdiv_units(limbs(e), lp));
                    if !e.is_multiple_of(&p) {
                        bad = Some(i);
                        break 'scan;
                    }
                }
            }
            if let Some(i) = bad {
                let (xi, ui) = (x[i].clone(), u[i].clone());
                for (a, b) in x[t].iter_mut().zip(&xi) {
                    *a += b;
                }
                for (a, b) in u[t].iter_mut().zip(&ui) {
                    *a += b;
                }
                acc.n(Family::AddSub, copy_units(&xi).saturating_add(copy_units(&ui)));
                continue;
            }
            if x[t][t].is_negative() {
                for e in x[t].iter_mut() {
                    *e = -&*e;
                }
                for e in u[t].iter_mut() {
                    *e = -&*e;
                }
                acc.n(Family::Move, copy_units(&x[t]).saturating_add(copy_units(&u[t])));
            }
            break;
        }
    }
    SmithForm { d: to_zmat(x, n), u: to_zmat(u, m), v: to_zmat(v, n), route: Route::Classical, attempts: 0 }
}

/// The preconditionings' entries: a fixed portable xorshift (the same
/// sequence on every run and target, so the transforms and the units
/// reproduce).  Attempt t >= 1 draws each entry from [0, 2^t) while 2^t <
/// m, and from then on bits(m) + 64 random bits reduced modulo m (uniform
/// up to a bias below 2^-64): a fixed small range could be covered
/// entirely by the bad residues of several primes, while such entries
/// succeed with probability at least prod_(p | m) (1 - 1/p) - 2^-64.
struct Retry {
    s: u64,
}

impl Retry {
    fn new() -> Retry {
        Retry { s: 0x9e37_79b9_7f4a_7c15 }
    }
    fn word(&mut self) -> u64 {
        self.s ^= self.s << 13;
        self.s ^= self.s >> 7;
        self.s ^= self.s << 17;
        self.s
    }
    /// `bits` random bits (words drawn low first; linear in their number).
    fn bits(&mut self, bits: u64) -> BigInt {
        let words = bits.div_ceil(64);
        let mut bytes = Vec::with_capacity(8 * usize::try_from(words).unwrap_or(0));
        for i in 0..words {
            let mut w = self.word();
            let left = bits - 64 * i;
            if left < 64 {
                w &= (1u64 << left) - 1;
            }
            bytes.extend_from_slice(&w.to_le_bytes());
        }
        BigInt::from_bytes_le(sagebrush_bigint::Sign::Plus, &bytes)
    }
    /// Attempt t's entry modulo m, and its units: the words drawn (Move)
    /// and, once uniform, the reduction modulo m (`bigdiv_units`).
    fn entry(&mut self, t: u64, m: &BigInt) -> (BigInt, Units) {
        // (2^t < m exactly when t < bits(m - 1), for m >= 1)
        let full = (m - BigInt::one()).bits();
        let mut u = Units::default();
        if t < full {
            u.0[Family::Move as usize] = t.div_ceil(64);
            (self.bits(t), u)
        } else {
            let bits = m.bits() + 64;
            u.0[Family::Move as usize] = bits.div_ceil(64);
            let lm = limbs(m);
            u.add(&bigdiv_units(lm + 1, lm));
            (self.bits(bits).mod_floor(m), u)
        }
    }
}

/// Route 1 (k <= 1: D = diag(1, .., 1, delta)), for a square nonsingular
/// matrix with a^-1 = N / delta in lowest terms and |det a| = delta.
///
/// G = Z^n a^-1 / Z^n is cyclic of order delta.  With C^-1 = [[I, 0], [r,
/// 1]], the last row of C^-1 N is y = r N_<n + N_n; when gcd(y, delta) =
/// 1 it generates G, every row N_i = c_i y (mod delta) with c_i = N_i . mu
/// for y . mu = 1, and H = [[I, h], [0, delta]], h_i = -c_i, is the row
/// Hermite form of a C.  So W = H (C^-1 N) / delta (integral) has W a C =
/// H, and with V' = [[I, -h], [0, 1]], H V' = D: U = W, V = C V' = [[I,
/// -h], [-r, 1 + r . h]], U a V = D exactly.
///
/// A generator of that form always exists: for each prime p | delta, z ->
/// z . N mod p is a nonzero functional (N / delta is in lowest terms),
/// which cannot vanish on the whole affine set z_n = 1; so the attempts
/// are not capped (each polls Stop), and [`Retry`]'s ranges grow until
/// they are uniform.
///
/// Units: the residues and the modular steps by the ring (word delta:
/// ModArith, one unit per reduced operation and per quotient step; big
/// delta: the helpers at the operands' sizes, Gcd for the fold); the
/// integer rows of W and V through `bigmul_units` and `bigdiv_units`.
// (the loops index several matrices by the same row and column at once)
#[allow(clippy::needless_range_loop)]
fn cyclic<R: Zn>(ring: &R, nm: &ZMat, delta: &BigInt, acc: &mut Local) -> Result<SmithForm, String> {
    let n = nm.rows;
    let res: Vec<R::T> = nm.d.iter().map(|x| ring.residue(x)).collect();
    acc.add(ring.residue_units(nm));
    let one = ring.residue(&BigInt::one());
    let ld = limbs(delta);
    let mut retry = Retry::new();
    let mut attempt = 0u64;
    let (r, mu) = loop {
        acc.flush();
        sagebrush_interrupt::check_coarse();
        let r: Vec<BigInt> = if attempt == 0 {
            vec![BigInt::zero(); n - 1]
        } else {
            (0..n - 1)
                .map(|_| {
                    let (x, u) = retry.entry(attempt, delta);
                    acc.add(u);
                    x
                })
                .collect()
        };
        attempt += 1;
        // y = r N_<n + N_n (mod delta)
        let mut y: Vec<R::T> = res[(n - 1) * n..].to_vec();
        let mut ops = 0u64;
        for (i, ri) in r.iter().enumerate() {
            if ri.is_zero() {
                continue;
            }
            let rr = ring.residue(ri);
            for (yj, x) in y.iter_mut().zip(&res[i * n..(i + 1) * n]) {
                *yj = ring.lin(&one, yj, &rr, x);
            }
            ops = ops.saturating_add(n as u64 + 1);
            if !R::WORD {
                acc.add(bigdiv_units(limbs(ri), ld));
            }
        }
        let mut steps = 0u64;
        let mu = ring.unit_combination(&y, &mut steps);
        if R::WORD {
            acc.n(Family::ModArith, ops.saturating_add(steps));
        }
        acc.add(Units(ring.take()));
        if let Some(mu) = mu {
            break (r, mu);
        }
    };
    // h_i = -(N_i . mu) (mod delta), as integers in [0, delta)
    let mut h = Vec::with_capacity(n - 1);
    for i in 0..n - 1 {
        let mut s = ring.residue(&BigInt::zero());
        for (j, m) in &mu {
            s = ring.lin(&one, &s, m, &res[i * n + j]);
        }
        h.push(R::integer(&ring.neg(&s)));
    }
    if R::WORD {
        acc.n(Family::ModArith, ((n - 1) * (mu.len() + 1)) as u64);
    }
    acc.add(Units(ring.take()));
    // the last row of C^-1 N over Z: y = N_n + sum r_i N_i
    let mut yfull: Vec<BigInt> = nm.d[(n - 1) * n..].to_vec();
    let mut mul = 0u64;
    for (i, ri) in r.iter().enumerate() {
        if ri.is_zero() {
            continue;
        }
        let lr = limbs(ri);
        for (yj, x) in yfull.iter_mut().zip(&nm.d[i * n..(i + 1) * n]) {
            *yj += ri * x;
            mul = mul.saturating_add(bigmul_units(lr, limbs(x)).get(Family::MulSchool));
        }
    }
    acc.n(Family::MulSchool, mul);
    // W = H (C^-1 N) / delta: rows i < n are (N_i + h_i y) / delta, the
    // last is delta y / delta = y
    let mut w = ZMat::zero(n, n);
    let (mut mul, mut div) = (0u64, 0u64);
    for i in 0..n - 1 {
        let lh = limbs(&h[i]);
        for j in 0..n {
            let num = nm.get(i, j) + &h[i] * &yfull[j];
            mul = mul.saturating_add(bigmul_units(lh, limbs(&yfull[j])).get(Family::MulSchool));
            div = div.saturating_add(bigdiv_units(limbs(&num), ld).get(Family::Div));
            let (q, rem) = num.div_rem(delta);
            if !rem.is_zero() {
                // (impossible when y generates G: an internal error, never
                // a silent change of route)
                return Err(not_integral("route 1"));
            }
            w.d[i * n + j] = q;
        }
    }
    acc.n(Family::MulSchool, mul);
    acc.n(Family::Div, div);
    acc.n(Family::Move, copy_units(&yfull));
    for (j, x) in yfull.into_iter().enumerate() {
        w.d[(n - 1) * n + j] = x;
    }
    // V = [[I, -h], [-r, 1 + r . h]]
    let mut v = ZMat::identity(n);
    let mut rh = BigInt::one();
    let mut mul = 0u64;
    for i in 0..n - 1 {
        v.d[i * n + n - 1] = -h[i].clone();
        v.d[(n - 1) * n + i] = -r[i].clone();
        if !r[i].is_zero() {
            rh += &r[i] * &h[i];
            mul = mul.saturating_add(bigmul_units(limbs(&r[i]), limbs(&h[i])).get(Family::MulSchool));
        }
    }
    acc.n(Family::MulSchool, mul);
    acc.n(Family::Move, copy_units(&h).saturating_add(copy_units(&r)));
    v.d[n * n - 1] = rh;
    let mut d = ZMat::identity(n);
    d.d[n * n - 1] = delta.clone();
    Ok(SmithForm { d, u: w, v, route: Route::Cyclic, attempts: attempt })
}

/// Column operation on columns (r, j) of every row of `m`: (x_r, x_j) ->
/// (s x_r + u x_j, -a x_r + p x_j) for a Bezout matrix [[s, u], [-a, p]]
/// (determinant 1).  Returns the operations' count (two each).
fn col2<R: Zn>(ring: &R, m: &mut [Vec<R::T>], r: usize, j: usize, b: &(R::T, R::T, R::T, R::T)) -> u64 {
    let (s, u, a, p) = b;
    let na = ring.neg(a);
    for row in m.iter_mut() {
        let (xr, xj) = (row[r].clone(), row[j].clone());
        row[r] = ring.lin(s, &xr, u, &xj);
        row[j] = ring.lin(&na, &xr, p, &xj);
    }
    2 * m.len() as u64
}

/// The same on rows (r, i) of `m`.
fn row2<R: Zn>(ring: &R, m: &mut [Vec<R::T>], r: usize, i: usize, b: &(R::T, R::T, R::T, R::T)) -> u64 {
    let (s, u, a, p) = b;
    let na = ring.neg(a);
    let (xr, xi) = (m[r].clone(), m[i].clone());
    m[r] = xr.iter().zip(&xi).map(|(x, y)| ring.lin(s, x, u, y)).collect();
    m[i] = xr.iter().zip(&xi).map(|(x, y)| ring.lin(&na, x, p, y)).collect();
    2 * xr.len() as u64
}

/// The Smith form of a relation lattice L in Z^k that contains delta Z^k,
/// given by k generators modulo delta, with bounded transforms: (d, V,
/// V^-1), d_1 | .. | d_k dividing delta, V unimodular and L V = D Z^k.
///
/// Over R = Z/delta, an elimination with recorded column operations and
/// free row operations (only L's image matters) gives V' in GL_k(R) with
/// column t of L V' in a_t R, d_t = gcd(a_t, delta); the divisibility pass
/// makes d_1 | .. | d_k.  Any unimodular V with V = V' Delta^-1 (mod
/// delta), Delta diagonal of units, then has L V in D Z^k (a unit times a
/// column keeps it in d_t R, and every d_t divides delta), with equality
/// by the index, prod d_t = [Z^k : L].  Column j of V matters modulo d_j
/// only, by the same argument.
///
/// V is the smaller (by the outputs' sizes) of two such:
/// - the construction ([`unipotent_factors`]): R has stable range 1, so a
///   row permutation P and a unipotent upper U_1 give U_1 P V' unit
///   leading minors, and V' = P^-1 U_1^-1 L_1 U_2 Delta with L_1 unipotent
///   lower and U_2 unipotent upper; V = P^-1 U_1^-1 L_1 U_2, the factors
///   lifted to (-delta/2, delta/2] and U_2's column j reduced modulo d_j
///   (V = G U_2 with G unimodular, and G d_j Z^k = d_j Z^k).  Proved: |V|
///   <= (1 + (k - 1) delta / 2)^3 and |V^-1| <= k^2 (1 + delta / 2)^(3 (k -
///   1)), about 3 bits(delta) and 3 (k - 1) bits(delta) bits;
/// - the elimination's own transform, exactly over Z (its cofactors are
///   below delta, the working matrix staying reduced), kept only while its
///   entries stay below the construction's bound (`growth`).
///
/// So both V and V^-1 have at most 3 (k - 1) (bits(delta) + 1) + 2
/// bits(k) + 2 bits, whatever the elimination's path: the classical
/// elimination's transforms, which this replaces, had no such bound.
fn small_smith<R: Zn>(ring: &R, rel: Vec<Vec<R::T>>, delta: &BigInt, acc: &mut Local) -> (Vec<BigInt>, ZMat, ZMat, Pick) {
    let k = rel.len();
    let one = ring.residue(&BigInt::one());
    let zero = ring.residue(&BigInt::zero());
    let mut a = rel;
    let mut vb: Vec<Vec<R::T>> = (0..k).map(|i| (0..k).map(|j| if i == j { one.clone() } else { zero.clone() }).collect()).collect();
    let (mut ops, mut steps) = (0u64, 0u64);
    let mut d: Vec<BigInt> = Vec::with_capacity(k);
    // the elimination's own transform, exactly over Z (its cofactors are
    // below delta: the working matrix stays reduced), with its inverse;
    // dropped once it outgrows the construction's bound (growth bits)
    let kb = (usize::BITS - k.leading_zeros()) as u64;
    let growth = 3 * (k as u64 - 1) * (delta.bits() + 1) + 2 * kb + 2;
    let mut ex: Option<(ZMat, ZMat)> = Some((ZMat::identity(k), ZMat::identity(k)));
    'pivots: for t in 0..k {
        loop {
            if R::WORD {
                acc.n(Family::ModArith, std::mem::take(&mut ops).saturating_add(std::mem::take(&mut steps)));
            }
            acc.add(Units(ring.take()));
            acc.flush();
            sagebrush_interrupt::check_coarse();
            if R::is_zero(&a[t][t]) {
                let found = (t..k).flat_map(|i| (t..k).map(move |j| (i, j))).find(|&(i, j)| !R::is_zero(&a[i][j]));
                acc.n(Family::Move, found.map_or(((k - t) * (k - t)) as u64, |(i, j)| ((i - t) * (k - t) + (j - t) + 1) as u64));
                let Some((i, j)) = found else {
                    // (the rest of L is delta Z^(k - t))
                    d.resize(k, delta.clone());
                    break 'pivots;
                };
                a.swap(t, i);
                for row in a.iter_mut().chain(vb.iter_mut()) {
                    row.swap(t, j);
                }
                if let Some((v, vi)) = ex.as_mut() {
                    for r in 0..k {
                        v.d.swap(r * k + t, r * k + j);
                        vi.d.swap(t * k + r, j * k + r);
                    }
                }
                acc.n(Family::Move, (4 * k + 2) as u64);
            }
            // row t by column operations (recorded in V'), column t by row
            // operations (free); a Bezout step strictly lowers the pivot
            for j in t + 1..k {
                if R::is_zero(&a[t][j]) {
                    continue;
                }
                ops = ops.saturating_add(1);
                if let Some(q) = ring.quotient(&a[t][j], &a[t][t]) {
                    for row in a.iter_mut().chain(vb.iter_mut()) {
                        row[j] = ring.sub_mul(&row[j], &q, &row[t]);
                    }
                    ops = ops.saturating_add(2 * k as u64);
                    // (col_j -= q col_t; the inverse's row_t += q row_j)
                    let qi = R::integer(&q);
                    exact_op(&mut ex, k, t, j, (BigInt::one(), BigInt::zero(), qi, BigInt::one()), growth, acc);
                } else {
                    // the cofactors over Z, so that the exact transform and
                    // the residues take the same step
                    let (x, y, ag, pg) = int_bezout(&R::integer(&a[t][t]), &R::integer(&a[t][j]), R::WORD, &mut steps, acc);
                    let b = (ring.residue(&x), ring.residue(&y), ring.residue(&ag), ring.residue(&pg));
                    ops = ops.saturating_add(col2(ring, &mut a, t, j, &b)).saturating_add(col2(ring, &mut vb, t, j, &b));
                    exact_op(&mut ex, k, t, j, (x, y, ag, pg), growth, acc);
                }
            }
            for i in t + 1..k {
                if R::is_zero(&a[i][t]) {
                    continue;
                }
                ops = ops.saturating_add(1);
                if let Some(q) = ring.quotient(&a[i][t], &a[t][t]) {
                    let at = a[t].clone();
                    for (x, y) in a[i].iter_mut().zip(&at) {
                        *x = ring.sub_mul(x, &q, y);
                    }
                    ops = ops.saturating_add(k as u64);
                } else {
                    let b = ring.bezout(&a[t][t], &a[i][t], &mut steps);
                    ops = ops.saturating_add(row2(ring, &mut a, t, i, &b));
                }
            }
            if !(t + 1..k).all(|j| R::is_zero(&a[t][j])) {
                continue;
            }
            // divisibility: gcd(a_tt, delta) must divide the rest (else a
            // row added to row t lowers that gcd on the next pass)
            let g = ring.gcd_e(&a[t][t], &mut steps);
            // (one unit per test made: the scan stops at the first failure)
            let mut bad = None;
            'scan: for i in t + 1..k {
                for j in t + 1..k {
                    ops = ops.saturating_add(1);
                    if !ring.divides(&g, &a[i][j]) {
                        bad = Some(i);
                        break 'scan;
                    }
                }
            }
            match bad {
                Some(i) => {
                    let ai = a[i].clone();
                    for (x, y) in a[t].iter_mut().zip(&ai) {
                        *x = ring.add(x, y);
                    }
                    ops = ops.saturating_add(k as u64);
                }
                None => {
                    d.push(R::integer(&g));
                    break;
                }
            }
        }
    }
    if R::WORD {
        acc.n(Family::ModArith, ops.saturating_add(steps));
    }
    acc.add(Units(ring.take()));
    let (v, vinv) = unipotent_factors(ring, vb, delta, &d, acc);
    // (the outputs' sizes: V's columns c V_2 and W's rows B = D V^-1)
    let dk = d.last().map_or(0, |x| x.bits());
    let size = |a: &ZMat, b: &ZMat| (a.max_bits() + delta.bits()).max(b.max_bits() + dk);
    let (v, vinv, pick) = match ex {
        Some((ve, vie)) if size(&ve, &vie) <= size(&v, &vinv) => (ve, vie, Pick::Exact),
        Some(_) => (v, vinv, Pick::Construction),
        None => (v, vinv, Pick::Dropped),
    };
    debug_assert!(v.max_bits() <= growth && vinv.max_bits() <= growth, "the transforms' proved bound");
    (d, v, vinv, pick)
}

/// Which transform [`small_smith`] returned (for its tests).
#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pick {
    /// the elimination's own exact transform (no larger)
    Exact,
    /// the construction (smaller than the exact transform)
    Construction,
    /// the construction, the exact transform having passed the bound
    /// and been dropped (its tracking stopped there)
    Dropped,
}

/// [`small_smith`] with delta's ring, from k generators of the relations
/// (any integers; reduced modulo delta), for its tests: (d, V, V^-1).
#[doc(hidden)]
pub fn small_smith_route(rel: &ZMat, delta: &BigInt) -> (Vec<BigInt>, ZMat, ZMat) {
    let (d, v, vinv, _) = small_smith_pick(rel, delta);
    (d, v, vinv)
}

/// [`small_smith_route`] and which transform it returned.
#[doc(hidden)]
pub fn small_smith_pick(rel: &ZMat, delta: &BigInt) -> (Vec<BigInt>, ZMat, ZMat, Pick) {
    assert!(rel.rows == rel.cols && rel.rows > 0 && delta > &BigInt::one(), "k x k generators and delta > 1");
    let mut acc = Local::new();
    match delta.to_u64() {
        Some(e) if e < WORD_E => {
            let ring = Word { e };
            let rel = (0..rel.rows).map(|i| rel.row(i).iter().map(|x| ring.residue(x)).collect()).collect();
            small_smith(&ring, rel, delta, &mut acc)
        }
        _ => {
            let ring = Big::new(delta);
            let rel = (0..rel.rows).map(|i| rel.row(i).iter().map(|x| ring.residue(x)).collect()).collect();
            small_smith(&ring, rel, delta, &mut acc)
        }
    }
}

/// x p + y a = g over Z (p > 0), with (x, y, a / g, p / g): the matrix
/// [[x, y], [-a/g, p/g]] has determinant 1 and |x| <= a / g, |y| <= p / g.
/// Counted after the work: on the word path one ModArith unit per quotient
/// step and per division by g (into `steps`); on the big path as the big
/// ring's Bezout, `biggcd_units` and the two divisions by g.
fn int_bezout(p: &BigInt, a: &BigInt, word: bool, steps: &mut u64, acc: &mut Local) -> (BigInt, BigInt, BigInt, BigInt) {
    let (mut r0, mut r1) = (p.clone(), a.clone());
    let (mut x0, mut x1, mut y0, mut y1) = (BigInt::one(), BigInt::zero(), BigInt::zero(), BigInt::one());
    let mut quotients = 0u64;
    while !r1.is_zero() {
        let (q, r) = r0.div_rem(&r1);
        (r0, r1) = (r1, r);
        let x2 = &x0 - &q * &x1;
        (x0, x1) = (x1, x2);
        let y2 = &y0 - &q * &y1;
        (y0, y1) = (y1, y2);
        quotients += 1;
    }
    let (ag, pg) = (a / &r0, p / &r0);
    if word {
        *steps += quotients + 2;
    } else {
        acc.add(crate::cost::biggcd_units(limbs(p), limbs(a)));
        acc.add(bigdiv_units(limbs(a), limbs(&r0)));
        acc.add(bigdiv_units(limbs(p), limbs(&r0)));
    }
    (x0, y0, ag, pg)
}

/// Column operation (col_t, col_j) -> (x col_t + y col_j, -a col_t + p
/// col_j) on the exact transform V, and its inverse (row_t, row_j) -> (p
/// row_t + a row_j, -y row_t + x row_j) on V^-1 (counted: `bigmul_units`
/// per product); the pair is dropped once an entry passes `growth` bits.
fn exact_op(ex: &mut Option<(ZMat, ZMat)>, k: usize, t: usize, j: usize, (x, y, a, p): (BigInt, BigInt, BigInt, BigInt), growth: u64, acc: &mut Local) {
    let Some((v, vi)) = ex.as_mut() else {
        return;
    };
    let mut top = 0u64;
    let lin = |s: &BigInt, u: &BigInt, w: &BigInt, z: &BigInt, acc: &mut Local| -> BigInt {
        acc.add(bigmul_units(limbs(s), limbs(u)));
        acc.add(bigmul_units(limbs(w), limbs(z)));
        s * u + w * z
    };
    let na = -&a;
    let ny = -&y;
    for r in 0..k {
        let (ct, cj) = (v.d[r * k + t].clone(), v.d[r * k + j].clone());
        v.d[r * k + t] = lin(&x, &ct, &y, &cj, acc);
        v.d[r * k + j] = lin(&na, &ct, &p, &cj, acc);
        let (rt, rj) = (vi.d[t * k + r].clone(), vi.d[j * k + r].clone());
        vi.d[t * k + r] = lin(&p, &rt, &a, &rj, acc);
        vi.d[j * k + r] = lin(&ny, &rt, &x, &rj, acc);
        top = top.max(v.d[r * k + t].bits()).max(v.d[r * k + j].bits()).max(vi.d[t * k + r].bits()).max(vi.d[j * k + r].bits());
    }
    if top > growth {
        *ex = None;
    }
}

/// For V' in GL_k(Z/delta): V unimodular with V = V' Delta^-1 (mod delta),
/// Delta diagonal of units, up to column j modulo d_j, and V^-1 exactly:
/// V = P^-1 U_1^-1 L_1 U_2 from U_1 P V' = L_1 Delta' U' (unit leading
/// minors, no pivoting), the factors lifted to (-delta/2, delta/2].  See
/// [`small_smith`] for the bounds.
fn unipotent_factors<R: Zn>(ring: &R, vb: Vec<Vec<R::T>>, delta: &BigInt, d: &[BigInt], acc: &mut Local) -> (ZMat, ZMat) {
    let k = vb.len();
    let one = ring.residue(&BigInt::one());
    let zero = ring.residue(&BigInt::zero());
    let (mut ops, mut steps) = (0u64, 0u64);
    let ident = || -> Vec<Vec<R::T>> { (0..k).map(|i| (0..k).map(|j| if i == j { one.clone() } else { zero.clone() }).collect()).collect() };
    // U_1: row j gets a combination of the rows below making the pivot of
    // the Schur complement a unit (its column is unimodular, and Z/delta
    // has stable range 1); the eliminations below the pivot follow
    let mut x = vb.clone();
    let mut u1 = ident();
    // (row swaps first: a unit in the column below needs no U_1 entry; P
    // records them, and a swap conjugates the U_1 built so far, which only
    // touches rows above)
    let mut perm: Vec<usize> = (0..k).collect();
    for j in 0..k {
        if !R::is_one(&ring.gcd_e(&x[j][j], &mut steps)) {
            if let Some(i) = (j + 1..k).find(|&i| R::is_one(&ring.gcd_e(&x[i][j], &mut steps))) {
                x.swap(j, i);
                perm.swap(j, i);
                u1.swap(j, i);
                for row in u1.iter_mut() {
                    row.swap(j, i);
                }
                acc.n(Family::Move, (4 * k) as u64);
            }
        }
        if !R::is_one(&ring.gcd_e(&x[j][j], &mut steps)) {
            // c = sum_i coef_i x_ij (i > j) with gcd(c, delta) that of the
            // column below j
            let mut c = zero.clone();
            let mut coef: Vec<(usize, R::T)> = vec![];
            for i in j + 1..k {
                if R::is_zero(&x[i][j]) {
                    continue;
                }
                if R::is_zero(&c) {
                    c = x[i][j].clone();
                    coef.push((i, one.clone()));
                } else {
                    let (s, u, _, _) = ring.bezout(&c, &x[i][j], &mut steps);
                    c = ring.lin(&s, &c, &u, &x[i][j]);
                    for (_, m) in coef.iter_mut() {
                        *m = ring.lin(&s, m, &zero, &zero);
                    }
                    coef.push((i, u));
                    ops = ops.saturating_add(coef.len() as u64 + 1);
                }
            }
            // t = the largest divisor of delta prime to x_jj: x_jj + t c is
            // a unit (a prime of delta divides x_jj or t, not both, and not
            // c when it divides x_jj)
            let t = ring.residue(&coprime_part(delta, &R::integer(&x[j][j]), R::WORD, &mut steps, acc));
            for (i, m) in &coef {
                let f = ring.lin(&t, m, &zero, &zero);
                let (xi, ui) = (x[*i].clone(), u1[*i].clone());
                for (y, z) in x[j].iter_mut().zip(&xi) {
                    *y = ring.lin(&one, y, &f, z);
                }
                for (y, z) in u1[j].iter_mut().zip(&ui) {
                    *y = ring.lin(&one, y, &f, z);
                }
                ops = ops.saturating_add(2 * k as u64 + 1);
            }
        }
        let inv = unit_inverse(ring, &x[j][j], &mut steps);
        for i in j + 1..k {
            if R::is_zero(&x[i][j]) {
                continue;
            }
            let l = ring.lin(&inv, &x[i][j], &zero, &zero);
            let xj = x[j].clone();
            for (y, z) in x[i].iter_mut().zip(&xj) {
                *y = ring.sub_mul(y, &l, z);
            }
            ops = ops.saturating_add(k as u64 + 1);
        }
    }
    // X = U_1 P V' = L_1 U_full, U_full = Delta' U': no pivoting
    let pv: Vec<&Vec<R::T>> = perm.iter().map(|&i| &vb[i]).collect();
    let mut xx: Vec<Vec<R::T>> = (0..k)
        .map(|i| (0..k).map(|j| (0..k).fold(zero.clone(), |s, l| ring.lin(&one, &s, &u1[i][l], &pv[l][j]))).collect())
        .collect();
    ops = ops.saturating_add((k * k * k) as u64);
    let mut l1 = ident();
    for j in 0..k {
        let inv = unit_inverse(ring, &xx[j][j], &mut steps);
        for i in j + 1..k {
            let l = ring.lin(&inv, &xx[i][j], &zero, &zero);
            let xj = xx[j].clone();
            for (y, z) in xx[i].iter_mut().zip(&xj) {
                *y = ring.sub_mul(y, &l, z);
            }
            l1[i][j] = l;
            ops = ops.saturating_add(k as u64 + 1);
        }
    }
    // U_2 = Delta' U' Delta'^-1: column j of U_full times u_jj^-1
    let mut u2 = ident();
    for j in 0..k {
        let inv = unit_inverse(ring, &xx[j][j], &mut steps);
        for i in 0..j {
            u2[i][j] = ring.lin(&inv, &xx[i][j], &zero, &zero);
        }
        ops = ops.saturating_add(j as u64);
    }
    // U_1^-1, unipotent upper, by back substitution
    let mut u1i = ident();
    for j in 0..k {
        for i in (0..j).rev() {
            // (U_1 U_1^-1)_ij = 0: u1i_ij = -sum_{i < l <= j} u1_il u1i_lj
            let mut s = zero.clone();
            for l in i + 1..=j {
                s = ring.lin(&one, &s, &u1[i][l], &u1i[l][j]);
            }
            u1i[i][j] = ring.neg(&s);
            ops = ops.saturating_add((j - i) as u64);
        }
    }
    if R::WORD {
        acc.n(Family::ModArith, ops.saturating_add(steps));
    }
    acc.add(Units(ring.take()));
    acc.flush();
    let half = delta >> 1usize;
    let lift = |m: &[Vec<R::T>]| -> ZMat {
        let rows: Vec<Vec<BigInt>> = m.iter().map(|row| row.iter().map(|x| {
            let y = R::integer(x);
            if y > half { y - delta } else { y }
        }).collect()).collect();
        ZMat::from_rows(rows)
    };
    acc.n(Family::Move, (3 * k * k) as u64);
    // (column j of the last factor matters modulo d_j only: V = G U_2
    // with G unimodular, and G d_j Z^k = d_j Z^k; so U_2's entries above
    // the diagonal are reduced into (-d_j/2, d_j/2], still unipotent)
    let mut f3 = lift(&u2);
    for j in 0..k {
        let hj = &d[j] >> 1usize;
        for i in 0..j {
            let x = f3.d[i * k + j].mod_floor(&d[j]);
            acc.add(bigdiv_units(limbs(&f3.d[i * k + j]), limbs(&d[j])));
            f3.d[i * k + j] = if x > hj { x - &d[j] } else { x };
        }
    }
    let (f1, f2) = (lift(&u1i), lift(&l1));
    // V = P^-1 U_1^-1 L_1 U_2 (row perm[i] of V is row i of the product),
    // V^-1 = U_2^-1 L_1^-1 U_1 P (column perm[i] of V^-1 is its column i)
    let prod = f1.mul(&f2).mul(&f3);
    let pinv = unipotent_inverse(&f3, true, acc).mul(&unipotent_inverse(&f2, false, acc)).mul(&unipotent_inverse(&f1, true, acc));
    let mut v = ZMat::zero(k, k);
    let mut vinv = ZMat::zero(k, k);
    for (i, &pi) in perm.iter().enumerate() {
        for j in 0..k {
            v.d[pi * k + j] = prod.get(i, j).clone();
            vinv.d[j * k + pi] = pinv.get(j, i).clone();
        }
    }
    acc.n(Family::Move, (2 * k * k) as u64);
    (v, vinv)
}

/// The inverse over Z of a unipotent triangular matrix (upper or lower),
/// by substitution (counted: `bigmul_units` per nonzero product).
fn unipotent_inverse(t: &ZMat, upper: bool, acc: &mut Local) -> ZMat {
    let k = t.rows;
    let mut inv = ZMat::identity(k);
    for j in 0..k {
        // column j of the inverse: (T X)_ij = [i == j]
        let order: Vec<usize> = if upper { (0..j).rev().collect() } else { (j + 1..k).collect() };
        for i in order {
            let mut s = BigInt::zero();
            let range: Vec<usize> = if upper { (i + 1..=j).collect() } else { (j..i).collect() };
            for l in range {
                let (a, b) = (t.get(i, l), inv.get(l, j));
                if !a.is_zero() && !b.is_zero() {
                    acc.add(bigmul_units(limbs(a), limbs(b)));
                    s += a * b;
                }
            }
            inv.d[i * k + j] = -s;
        }
    }
    acc.flush();
    inv
}

/// The largest divisor of e prime to x (repeatedly dividing out
/// gcd(c, x)): x + c y is a unit mod e whenever gcd(x, y, e) = 1.
/// Counted after the work: on the word path one ModArith unit per
/// reduction, Euclid quotient step and division (into `steps`), else
/// `biggcd_units` and `bigdiv_units`.
fn coprime_part(e: &BigInt, x: &BigInt, word: bool, steps: &mut u64, acc: &mut Local) -> BigInt {
    let mut c = e.clone();
    loop {
        let h = if word {
            let (mut a, mut b) = (c.clone(), x.mod_floor(&c));
            *steps += 1;
            while !b.is_zero() {
                let r = a.mod_floor(&b);
                (a, b) = (b, r);
                *steps += 1;
            }
            a
        } else {
            let h = c.gcd(x);
            acc.add(crate::cost::biggcd_units(limbs(&c), limbs(x)));
            h
        };
        if h.is_one() {
            return c;
        }
        let next = &c / &h;
        if word {
            *steps += 1;
        } else {
            acc.add(bigdiv_units(limbs(&c), limbs(&h)));
        }
        c = next;
    }
}

/// The inverse of a unit modulo the ring's modulus.
fn unit_inverse<R: Zn>(ring: &R, u: &R::T, steps: &mut u64) -> R::T {
    let mu = ring.unit_combination(std::slice::from_ref(u), steps).expect("a unit");
    mu.into_iter().next().map(|(_, m)| m).expect("a unit's inverse")
}

/// Route 2 (2 <= k nontrivial invariant factors), for a square
/// nonsingular matrix with a^-1 = N / delta in lowest terms.
///
/// G = Z^n a^-1 / Z^n has rank k.  With C^-1 = [[I, 0], [R, I_k]], Y = the
/// last k rows of C^-1 N (mod delta).  An elimination over Z/delta (Bezout
/// row and column operations) gives P Y Q = diag(s), P recorded and the
/// column operations applied to X = N_<n-k as well.  Y generates G exactly
/// when every row of X Q is zero past column k and divisible by g_j =
/// gcd(s_j, delta) at j < k; then N_i = c_i Y with c_i = q P, q_j = (w_j /
/// g_j) (s_j / g_j)^-1 (mod delta / g_j).  The relations Lambda = {z : z Y
/// = 0} are generated by the rows (delta / g_j) P_j and delta e_j; its
/// Smith form with bounded transforms ([`small_smith`], over Z/delta since
/// Lambda holds delta Z^k) gives V_2 unimodular with Lambda V_2 = D_B Z^k,
/// and the basis B = D_B V_2^-1 of Lambda, with B V_2 = D_B.  So the row
/// lattice of a C has the basis H = [[I, -c], [0, B]], W = H (C^-1 N) /
/// delta is integral, and with V = C [[I, c], [0, I]] diag(I, V_2) =
/// [[I, c V_2], [-R, (I - R c) V_2]], U = W: U a V = diag(I, D_B) = D.
///
/// k must be the exact number of nontrivial invariant factors (part A's,
/// proved: `snf::invariants_nonsingular`): with fewer rows Y never
/// generates G, and the uncapped attempts would never end.
///
/// Termination: for each prime p | delta, the rows of R N_<n-k + N_bottom
/// generate G / pG unless R lies in a proper algebraic subset modulo p;
/// with R uniform modulo delta, by CRT that happens for every p | delta at
/// once with probability bounded away from 0, so the attempts (each a
/// Stop poll) are not capped, and [`Retry`]'s ranges grow until uniform.
///
/// Units: the modular steps by the ring (word delta: ModArith, one unit
/// each; big delta: the helpers at the operands' sizes); the integer rows
/// through `bigmul_units` and `bigdiv_units`; the small Smith form the
/// same way.
// (the loops index several matrices by the same row and column at once)
#[allow(clippy::needless_range_loop)]
fn trailing<R: Zn>(ring: &R, nm: &ZMat, delta: &BigInt, d: &BigInt, k: usize, acc: &mut Local) -> Result<SmithForm, String> {
    let n = nm.rows;
    let top = n - k;
    let res: Vec<R::T> = nm.d.iter().map(|x| ring.residue(x)).collect();
    acc.add(ring.residue_units(nm));
    let one = ring.residue(&BigInt::one());
    let zero = ring.residue(&BigInt::zero());
    let ld = limbs(delta);
    let mut retry = Retry::new();
    let mut attempt = 0u64;
    let (rr, p, q) = loop {
        acc.flush();
        sagebrush_interrupt::check_coarse();
        let mut rr: Vec<Vec<BigInt>> = vec![vec![BigInt::zero(); top]; k];
        if attempt > 0 {
            for x in rr.iter_mut().flatten() {
                let (e, u) = retry.entry(attempt, delta);
                acc.add(u);
                *x = e;
            }
        }
        attempt += 1;
        let mut ops = 0u64;
        let mut steps = 0u64;
        // Y = R N_<top + N_bottom (mod delta), X = N_<top
        let mut y: Vec<Vec<R::T>> = (0..k).map(|t| res[(top + t) * n..(top + t + 1) * n].to_vec()).collect();
        for (t, row) in rr.iter().enumerate() {
            for (i, ri) in row.iter().enumerate() {
                if ri.is_zero() {
                    continue;
                }
                let r = ring.residue(ri);
                for (yj, x) in y[t].iter_mut().zip(&res[i * n..(i + 1) * n]) {
                    *yj = ring.lin(&one, yj, &r, x);
                }
                ops = ops.saturating_add(n as u64 + 1);
                if !R::WORD {
                    acc.add(bigdiv_units(limbs(ri), ld));
                }
            }
        }
        let mut p: Vec<Vec<R::T>> = (0..k).map(|i| (0..k).map(|j| if i == j { one.clone() } else { zero.clone() }).collect()).collect();
        // the elimination on Y alone, its column operations recorded (X is
        // transformed only once an attempt's Y generates: a failed attempt
        // costs O(k^2 n), not O(n^2 k))
        let mut cols: Vec<ColOp<R::T>> = vec![];
        let mut rank = k;
        for r in 0..k {
            loop {
                if R::is_zero(&y[r][r]) {
                    // a nonzero entry in the block rows >= r, columns >= r
                    let found = (r..k).flat_map(|i| (r..n).map(move |j| (i, j))).find(|&(i, j)| !R::is_zero(&y[i][j]));
                    // (the entries the search read, Move)
                    acc.n(Family::Move, found.map_or(((k - r) * (n - r)) as u64, |(i, j)| ((i - r) * (n - r) + (j - r) + 1) as u64));
                    let Some((i, j)) = found else {
                        break;
                    };
                    y.swap(r, i);
                    p.swap(r, i);
                    for row in y.iter_mut() {
                        row.swap(r, j);
                    }
                    cols.push(ColOp::Swap(r, j));
                    acc.n(Family::Move, (2 + k) as u64);
                }
                // (when the pivot divides the entry, a plain elimination
                // keeps the pivot's row and column: a Bezout step there
                // could swap them, and the passes could then cycle; so the
                // pivot strictly decreases whenever a Bezout step is taken)
                for j in r + 1..n {
                    if R::is_zero(&y[r][j]) {
                        continue;
                    }
                    ops = ops.saturating_add(1);
                    if let Some(q) = ring.quotient(&y[r][j], &y[r][r]) {
                        for row in y.iter_mut() {
                            row[j] = ring.sub_mul(&row[j], &q, &row[r]);
                        }
                        ops = ops.saturating_add(k as u64);
                        cols.push(ColOp::Sub(j, q, r));
                    } else {
                        let b = ring.bezout(&y[r][r], &y[r][j], &mut steps);
                        ops = ops.saturating_add(col2(ring, &mut y, r, j, &b));
                        cols.push(ColOp::Bezout(r, j, b));
                    }
                }
                for i in r + 1..k {
                    if R::is_zero(&y[i][r]) {
                        continue;
                    }
                    ops = ops.saturating_add(1);
                    if let Some(q) = ring.quotient(&y[i][r], &y[r][r]) {
                        let (pr, yr) = (p[r].clone(), y[r].clone());
                        for (a, b) in y[i].iter_mut().zip(&yr) {
                            *a = ring.sub_mul(a, &q, b);
                        }
                        for (a, b) in p[i].iter_mut().zip(&pr) {
                            *a = ring.sub_mul(a, &q, b);
                        }
                        ops = ops.saturating_add((n + k) as u64);
                    } else {
                        let b = ring.bezout(&y[r][r], &y[i][r], &mut steps);
                        ops = ops.saturating_add(row2(ring, &mut y, r, i, &b)).saturating_add(row2(ring, &mut p, r, i, &b));
                    }
                }
                if (r + 1..n).all(|j| R::is_zero(&y[r][j])) {
                    break;
                }
            }
            if R::is_zero(&y[r][r]) {
                rank = r;
                break;
            }
        }
        // generation: <Y> is G exactly when it is as large, |<Y>| = prod
        // delta / g_j (g_j = gcd(s_j, delta)) = |G| = |det a|
        let s: Vec<BigInt> = (0..k).map(|j| R::integer(&y[j][j])).collect();
        let g: Vec<BigInt> = (0..k).map(|j| R::integer(&ring.gcd_e(&y[j][j], &mut steps))).collect();
        let mut order = BigInt::one();
        for gj in &g {
            let f = delta / gj;
            if R::WORD {
                // (a word division, then a product that may outgrow a word)
                acc.n(Family::ModArith, 1);
            } else {
                acc.add(bigdiv_units(ld, limbs(gj)));
            }
            acc.add(bigmul_units(limbs(&order), limbs(&f)));
            order *= f;
        }
        let mut generates = rank == k && order == *d;
        let mut x: Vec<Vec<R::T>> = vec![];
        if generates {
            // X Q, by the recorded column operations
            x = (0..top).map(|i| res[i * n..(i + 1) * n].to_vec()).collect();
            for op in &cols {
                match op {
                    ColOp::Swap(r, j) => {
                        for row in x.iter_mut() {
                            row.swap(*r, *j);
                        }
                        acc.n(Family::Move, top as u64);
                    }
                    ColOp::Sub(j, q, r) => {
                        for row in x.iter_mut() {
                            row[*j] = ring.sub_mul(&row[*j], q, &row[*r]);
                        }
                        ops = ops.saturating_add(top as u64);
                    }
                    ColOp::Bezout(r, j, b) => {
                        ops = ops.saturating_add(col2(ring, &mut x, *r, *j, b));
                    }
                }
            }
            // (then every row of X Q is in the span: zero past column k and
            // divisible by g_j; checked, a guard)
            generates = x.iter().all(|w| (k..n).all(|j| R::is_zero(&w[j])) && (0..k).all(|j| R::integer(&w[j]).is_multiple_of(&g[j])));
            debug_assert!(generates, "X Q in the span of Y Q");
            ops = ops.saturating_add((top * n) as u64);
            if !R::WORD {
                // (the divisibility tests: a division of each w_j by g_j)
                for w in &x {
                    for (j, gj) in g.iter().enumerate() {
                        acc.add(bigdiv_units(limbs(&R::integer(&w[j])), limbs(gj)));
                    }
                }
            }
        }
        if R::WORD {
            acc.n(Family::ModArith, ops.saturating_add(steps));
        }
        acc.add(Units(ring.take()));
        if !generates {
            continue;
        }
        // q_ij = (w_j / g_j) (s_j / g_j)^-1 (mod delta / g_j): word delta,
        // one ModArith unit per operation and per quotient step; big delta,
        // the helpers at the operands' sizes
        let mut q: Vec<Vec<BigInt>> = Vec::with_capacity(top);
        let inv: Vec<(BigInt, BigInt)> = (0..k)
            .map(|j| {
                let m = delta / &g[j];
                let sj = (&s[j] / &g[j]).mod_floor(&m);
                let e = sj.extended_gcd(&m);
                if R::WORD {
                    let (mut a, mut b) = (sj.to_i128().unwrap_or(0), m.to_i128().unwrap_or(1));
                    let mut steps = 2u64;
                    while b != 0 {
                        (a, b) = (b, a.rem_euclid(b));
                        steps += 1;
                    }
                    acc.n(Family::ModArith, steps);
                } else {
                    acc.add(bigdiv_units(ld, limbs(&g[j])));
                    acc.add(bigdiv_units(limbs(&s[j]), limbs(&g[j])));
                    acc.add(crate::cost::biggcd_units(limbs(&sj), limbs(&m)));
                }
                (e.x.mod_floor(&m), m)
            })
            .collect();
        let (mut mul, mut div, mut word) = (0u64, 0u64, 0u64);
        for w in &x {
            let row: Vec<BigInt> = (0..k)
                .map(|j| {
                    let wi = R::integer(&w[j]);
                    let wj = &wi / &g[j];
                    let t = &wj * &inv[j].0;
                    if R::WORD {
                        word = word.saturating_add(3);
                    } else {
                        div = div.saturating_add(bigdiv_units(limbs(&wi), limbs(&g[j])).get(Family::Div));
                        mul = mul.saturating_add(bigmul_units(limbs(&wj), limbs(&inv[j].0)).get(Family::MulSchool));
                        div = div.saturating_add(bigdiv_units(limbs(&t), limbs(&inv[j].1)).get(Family::Div));
                    }
                    t.mod_floor(&inv[j].1)
                })
                .collect();
            q.push(row);
        }
        acc.n(Family::MulSchool, mul);
        acc.n(Family::Div, div);
        acc.n(Family::ModArith, word);
        break (rr, p.iter().map(|row| row.iter().map(R::integer).collect::<Vec<BigInt>>()).collect::<Vec<_>>(), (q, g));
    };
    let (q, g) = q;
    // c_i = q_i P (mod delta), as integers in [0, delta): word delta, one
    // ModArith unit per product and per reduction; big delta, the helpers
    let word = R::WORD;
    let (mut mul, mut div, mut wops) = (0u64, 0u64, 0u64);
    let c: Vec<Vec<BigInt>> = q
        .iter()
        .map(|qi| {
            (0..k)
                .map(|l| {
                    let mut t = BigInt::zero();
                    for (j, qij) in qi.iter().enumerate() {
                        if !qij.is_zero() {
                            t += qij * &p[j][l];
                            if word {
                                wops = wops.saturating_add(1);
                            } else {
                                mul = mul.saturating_add(bigmul_units(limbs(qij), limbs(&p[j][l])).get(Family::MulSchool));
                            }
                        }
                    }
                    if word {
                        wops = wops.saturating_add(1);
                    } else {
                        div = div.saturating_add(bigdiv_units(limbs(&t), ld).get(Family::Div));
                    }
                    t.mod_floor(delta)
                })
                .collect()
        })
        .collect();
    acc.n(Family::MulSchool, mul);
    acc.n(Family::Div, div);
    acc.n(Family::ModArith, wops);
    // the relations' generators (delta / g_j) P_j modulo delta (the
    // relation lattice also holds delta Z^k), then its Smith form with
    // bounded transforms: B V_2 = D_B
    let mut rel: Vec<Vec<R::T>> = Vec::with_capacity(k);
    let (mut mul, mut div, mut wops) = (0u64, 0u64, 0u64);
    for j in 0..k {
        let f = delta / &g[j];
        if R::WORD {
            wops = wops.saturating_add(1);
        } else {
            div = div.saturating_add(bigdiv_units(ld, limbs(&g[j])).get(Family::Div));
        }
        let lf = limbs(&f);
        rel.push(
            (0..k)
                .map(|l| {
                    let x = &f * &p[j][l];
                    if R::WORD {
                        wops = wops.saturating_add(2);
                    } else {
                        mul = mul.saturating_add(bigmul_units(lf, limbs(&p[j][l])).get(Family::MulSchool));
                        div = div.saturating_add(bigdiv_units(limbs(&x), ld).get(Family::Div));
                    }
                    ring.residue(&x)
                })
                .collect(),
        );
    }
    acc.n(Family::MulSchool, mul);
    acc.n(Family::Div, div);
    acc.n(Family::ModArith, wops);
    acc.flush();
    let (db, v2, v2inv, _) = small_smith(ring, rel, delta, acc);
    // B = D_B V_2^-1
    let mut mul = 0u64;
    let b: Vec<Vec<BigInt>> = (0..k)
        .map(|i| {
            let li = limbs(&db[i]);
            (0..k)
                .map(|j| {
                    let x = v2inv.get(i, j);
                    if !x.is_zero() {
                        mul = mul.saturating_add(bigmul_units(li, limbs(x)).get(Family::MulSchool));
                    }
                    &db[i] * x
                })
                .collect()
        })
        .collect();
    acc.n(Family::MulSchool, mul);
    // the last k rows of C^-1 N over Z: N_bottom + R N_<top
    let mut yfull: Vec<Vec<BigInt>> = (0..k).map(|t| nm.d[(top + t) * n..(top + t + 1) * n].to_vec()).collect();
    let mut mul = 0u64;
    for (t, row) in rr.iter().enumerate() {
        for (i, ri) in row.iter().enumerate() {
            if ri.is_zero() {
                continue;
            }
            let lr = limbs(ri);
            for (yj, x) in yfull[t].iter_mut().zip(&nm.d[i * n..(i + 1) * n]) {
                *yj += ri * x;
                mul = mul.saturating_add(bigmul_units(lr, limbs(x)).get(Family::MulSchool));
            }
        }
    }
    acc.n(Family::MulSchool, mul);
    // W = H (C^-1 N) / delta
    let mut w = ZMat::zero(n, n);
    let (mut mul, mut div) = (0u64, 0u64);
    let mut exact = true;
    let mut put = |w: &mut ZMat, i: usize, j: usize, num: BigInt, div: &mut u64| {
        *div = div.saturating_add(bigdiv_units(limbs(&num), ld).get(Family::Div));
        let (qq, rem) = num.div_rem(delta);
        exact &= rem.is_zero();
        w.d[i * n + j] = qq;
    };
    for i in 0..top {
        for j in 0..n {
            let mut num = nm.get(i, j).clone();
            for (l, cl) in c[i].iter().enumerate() {
                if !cl.is_zero() {
                    num -= cl * &yfull[l][j];
                    mul = mul.saturating_add(bigmul_units(limbs(cl), limbs(&yfull[l][j])).get(Family::MulSchool));
                }
            }
            put(&mut w, i, j, num, &mut div);
        }
    }
    for (t, bt) in b.iter().enumerate() {
        for j in 0..n {
            let mut num = BigInt::zero();
            for (l, bl) in bt.iter().enumerate() {
                if !bl.is_zero() {
                    num += bl * &yfull[l][j];
                    mul = mul.saturating_add(bigmul_units(limbs(bl), limbs(&yfull[l][j])).get(Family::MulSchool));
                }
            }
            put(&mut w, top + t, j, num, &mut div);
        }
    }
    acc.n(Family::MulSchool, mul);
    acc.n(Family::Div, div);
    if !exact {
        // (impossible when Y generates G: an internal error, never a silent
        // change of route)
        return Err(not_integral("route 2"));
    }
    // V = [[I, c V_2], [-R, (I - R c) V_2]]
    let v2 = &v2;
    let mut mul = 0u64;
    let prod = |a: &[BigInt], col: usize, mul: &mut u64| -> BigInt {
        let mut t = BigInt::zero();
        for (l, al) in a.iter().enumerate() {
            let x = v2.get(l, col);
            if !al.is_zero() && !x.is_zero() {
                t += al * x;
                *mul = mul.saturating_add(bigmul_units(limbs(al), limbs(x)).get(Family::MulSchool));
            }
        }
        t
    };
    let mut v = ZMat::zero(n, n);
    for i in 0..top {
        v.d[i * n + i] = BigInt::one();
        for col in 0..k {
            v.d[i * n + top + col] = prod(&c[i], col, &mut mul);
        }
    }
    for t in 0..k {
        // (I - R c)_t
        let mut irc: Vec<BigInt> = (0..k).map(|l| BigInt::from((l == t) as u8)).collect();
        for (i, ri) in rr[t].iter().enumerate() {
            if ri.is_zero() {
                continue;
            }
            for (l, x) in irc.iter_mut().enumerate() {
                if !c[i][l].is_zero() {
                    *x -= ri * &c[i][l];
                    mul = mul.saturating_add(bigmul_units(limbs(ri), limbs(&c[i][l])).get(Family::MulSchool));
                }
            }
        }
        for i in 0..top {
            v.d[(top + t) * n + i] = -rr[t][i].clone();
        }
        for col in 0..k {
            v.d[(top + t) * n + top + col] = prod(&irc, col, &mut mul);
        }
    }
    acc.n(Family::MulSchool, mul);
    acc.n(Family::Move, (n * n) as u64);
    let mut d = ZMat::identity(n);
    for t in 0..k {
        d.d[(top + t) * n + top + t] = db[t].clone();
    }
    Ok(SmithForm { d, u: w, v, route: Route::Trailing, attempts: attempt })
}

/// [`trailing`] with delta's ring (route 2 alone, from a^-1 = nm / delta
/// and d = |det a|: for the metering tests).  k must be the exact number
/// of nontrivial invariant factors: with a smaller k no attempt
/// generates, and the uncapped attempts never end (Stop ends them).
#[doc(hidden)]
pub fn trailing_route(nm: &ZMat, delta: &BigInt, d: &BigInt, k: usize) -> Result<SmithForm, String> {
    if k == 0 || k > nm.rows || nm.rows != nm.cols {
        return Err("route 2 needs a square inverse and 1 <= k <= n".into());
    }
    trailing_ring(nm, delta, d, k)
}

fn trailing_ring(nm: &ZMat, delta: &BigInt, d: &BigInt, k: usize) -> Result<SmithForm, String> {
    let mut acc = Local::new();
    match delta.to_u64() {
        Some(e) if e < WORD_E => trailing(&Word { e }, nm, delta, d, k, &mut acc),
        _ => trailing(&Big::new(delta), nm, delta, d, k, &mut acc),
    }
}

/// The internal error of a route whose W is not integral: impossible when
/// the generation test passed (the route's construction proves it), so a
/// bug, reported as one rather than taken as a reason to change routes.
fn not_integral(route: &str) -> String {
    format!("smith_form: internal error: {route}'s U is not integral (a proven invariant failed; please report it)")
}

/// A column operation of route 2's elimination, replayed on X.
enum ColOp<T> {
    /// swap columns r and j
    Swap(usize, usize),
    /// col_j -= q col_r
    Sub(usize, T, usize),
    /// columns (r, j) by a Bezout matrix
    Bezout(usize, usize, (T, T, T, T)),
}

/// [`cyclic`] with delta's ring: words below 2^62, BigInts above (route 1
/// alone, from a^-1 = nm / delta: for the metering tests).
#[doc(hidden)]
pub fn cyclic_route(nm: &ZMat, delta: &BigInt) -> Result<SmithForm, String> {
    if nm.rows == 0 || nm.rows != nm.cols {
        return Err("route 1 needs a square, nonempty inverse".into());
    }
    cyclic_ring(nm, delta)
}

fn cyclic_ring(nm: &ZMat, delta: &BigInt) -> Result<SmithForm, String> {
    let mut acc = Local::new();
    match delta.to_u64() {
        Some(e) if e < WORD_E => cyclic(&Word { e }, nm, delta, &mut acc),
        _ => cyclic(&Big::new(delta), nm, delta, &mut acc),
    }
}

/// The Smith form with transforms of any integer matrix: route 1 when a is
/// square and nonsingular with k <= 1 nontrivial invariant factors, route
/// 2 when 2 <= k <= K_MAX (both from one exact inverse), else the
/// classical elimination (by shape).
///
/// An error only for an internal failure (a route's proven invariant not
/// holding): a bug, never a property of the input.
pub fn smith_form(a: &ZMat) -> Result<SmithForm, String> {
    smith_form_k(a, K_MAX)
}

/// [`smith_form`] with route 2's threshold given (for its measurement).
#[doc(hidden)]
pub fn smith_form_k(a: &ZMat, k_max: usize) -> Result<SmithForm, String> {
    if a.rows == a.cols && a.rows > 0 {
        if let Some((nm, den, det)) = crate::zmat::inverse_det(a) {
            if den == det.abs() {
                return cyclic_ring(&nm, &den);
            } else {
                // (part A, its determinant and inverse known: the invariants
                // from d and the solve x = N b / delta that the inverse
                // already holds, b the fixed right-hand side)
                let b = crate::zmat::det_rhs(a.rows);
                let inv = crate::snf::invariants_nonsingular(a, &det.abs(), Some((nm.mul(&b), den.clone())));
                let k = inv.iter().filter(|x| !x.is_one()).count();
                if k <= k_max {
                    return trailing_ring(&nm, &den, &det.abs(), k);
                }
            }
        }
    }
    Ok(smith_classical(a))
}

/// L, the floor a Smith form with transforms of an m x n matrix needs
/// before it runs (proved, from the shape): its transforms' m^2 + n^2
/// entries and D's m n, each at least 8 bytes (a pointer-sized handle and
/// a limb, wasm32 too), in bytes; None if that overflows u64.  (Not the
/// transforms' measured size, about log2 d bits an entry for one of them:
/// a valid output can be far smaller, diag(1, .., 1, d) with U = V = I.)
pub fn floor_bytes(m: usize, n: usize) -> Option<u64> {
    let (m, n) = (m as u128, n as u128);
    let entries = m.checked_mul(m)?.checked_add(n.checked_mul(n)?)?.checked_add(m.checked_mul(n)?)?;
    u64::try_from(entries.checked_mul(8)?).ok()
}

/// The most nontrivial invariant factors route 2 takes; more go to the
/// classical elimination (a route threshold, never a refusal).  Measured
/// on 30 x 30 and 20 x 20 and 40 x 40 inputs: route 2 is 3 to 140 times
/// faster than the classical elimination up to k = 8; at k = 16 its small
/// k x k Smith form's transforms grow and the classical route is faster.
pub const K_MAX: usize = 8;

#[cfg(test)]
mod tests;
