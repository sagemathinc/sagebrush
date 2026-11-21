//! The Smith normal form with transforms: (D, U, V) with U A V = D, U and
//! V unimodular, D diagonal with the invariant factors t_1 | t_2 | ... in
//! order (zeros last).
//!
//! Units (`cost::tally`), counted in a `cost::Local` after the work and
//! flushed at the existing Stop checks: BigInt products through
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
            sagebrush_interrupt::check();
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
fn cyclic<R: Zn>(ring: &R, nm: &ZMat, delta: &BigInt, acc: &mut Local) -> Option<SmithForm> {
    let n = nm.rows;
    let res: Vec<R::T> = nm.d.iter().map(|x| ring.residue(x)).collect();
    acc.add(ring.residue_units(nm));
    let one = ring.residue(&BigInt::one());
    let ld = limbs(delta);
    let mut retry = Retry::new();
    let mut attempt = 0u64;
    let (r, mu) = loop {
        acc.flush();
        sagebrush_interrupt::check();
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
                // (impossible when y generates G: a guard, not a route)
                debug_assert!(false, "W is integral");
                return None;
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
    Some(SmithForm { d, u: w, v, route: Route::Cyclic, attempts: attempt })
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
/// = 0} are generated by the rows (delta / g_j) P_j and delta e_j; the
/// classical Smith form of that 2k x k matrix M gives U_2 M V_2 = [D_B; 0]
/// and a basis B = the first k rows of U_2 M, with B V_2 = D_B.  So the row
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
/// through `bigmul_units` and `bigdiv_units`; the small Smith form counts
/// itself.
// (the loops index several matrices by the same row and column at once)
#[allow(clippy::needless_range_loop)]
fn trailing<R: Zn>(ring: &R, nm: &ZMat, delta: &BigInt, d: &BigInt, k: usize, acc: &mut Local) -> Option<SmithForm> {
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
        sagebrush_interrupt::check();
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
    // the relations' generators M (2k x k) and their Smith form
    let mut m = ZMat::zero(2 * k, k);
    let mut mul = 0u64;
    for j in 0..k {
        let f = delta / &g[j];
        if R::WORD {
            acc.n(Family::ModArith, 1);
        } else {
            acc.add(bigdiv_units(ld, limbs(&g[j])));
        }
        let lf = limbs(&f);
        for l in 0..k {
            m.d[j * k + l] = &f * &p[j][l];
            mul = mul.saturating_add(bigmul_units(lf, limbs(&p[j][l])).get(Family::MulSchool));
        }
        m.d[(k + j) * k + j] = delta.clone();
    }
    acc.n(Family::MulSchool, mul);
    acc.n(Family::Move, (k * ld) as u64);
    acc.flush();
    let small = smith_classical(&m);
    let um = small.u.mul(&m);
    let b: Vec<Vec<BigInt>> = (0..k).map(|i| um.d[i * k..(i + 1) * k].to_vec()).collect();
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
        // (impossible when Y generates G: a guard, not a route)
        debug_assert!(false, "W is integral");
        return None;
    }
    // V = [[I, c V_2], [-R, (I - R c) V_2]]
    let v2 = &small.v;
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
        d.d[(top + t) * n + top + t] = small.d.get(t, t).clone();
    }
    Some(SmithForm { d, u: w, v, route: Route::Trailing, attempts: attempt })
}

/// [`trailing`] with delta's ring (route 2 alone, from a^-1 = nm / delta
/// and d = |det a|: for the metering tests).  k must be the exact number
/// of nontrivial invariant factors: with a smaller k no attempt
/// generates, and the uncapped attempts never end (Stop ends them).
#[doc(hidden)]
pub fn trailing_route(nm: &ZMat, delta: &BigInt, d: &BigInt, k: usize) -> Option<SmithForm> {
    if k == 0 || k > nm.rows || nm.rows != nm.cols {
        return None;
    }
    let mut acc = Local::new();
    match delta.to_u64() {
        Some(e) if e < WORD_E => trailing(&Word { e }, nm, delta, d, k, &mut acc),
        _ => trailing(&Big::new(delta), nm, delta, d, k, &mut acc),
    }
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
pub fn cyclic_route(nm: &ZMat, delta: &BigInt) -> Option<SmithForm> {
    if nm.rows == 0 || nm.rows != nm.cols {
        return None;
    }
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
pub fn smith_form(a: &ZMat) -> SmithForm {
    smith_form_k(a, K_MAX)
}

/// [`smith_form`] with route 2's threshold given (for its measurement).
#[doc(hidden)]
pub fn smith_form_k(a: &ZMat, k_max: usize) -> SmithForm {
    if a.rows == a.cols && a.rows > 0 {
        if let Some((nm, den, det)) = crate::zmat::inverse_det(a) {
            if den == det.abs() {
                if let Some(s) = cyclic_route(&nm, &den) {
                    return s;
                }
            } else {
                // (part A, its determinant known: the invariants from d and
                // one solve)
                let inv = crate::snf::invariants_nonsingular(a, &det.abs(), None);
                let k = inv.iter().filter(|x| !x.is_one()).count();
                if k <= k_max {
                    if let Some(s) = trailing_route(&nm, &den, &det.abs(), k) {
                        return s;
                    }
                }
            }
        }
    }
    smith_classical(a)
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
