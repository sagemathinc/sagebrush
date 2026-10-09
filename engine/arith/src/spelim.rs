//! Sparse Gaussian elimination modulo a prime p < 2^31, structured as in
//! Faugère and Lachartre's reduction for Gröbner bases (and useful for any
//! sparse system whose pivots are largely known in advance: relation
//! matrices, Hecke kernels, ...).
//!
//! The pivots are sparse rows, each monic at its leading column.  A row to
//! reduce is loaded into a dense accumulator of signed 64-bit integers kept
//! in [0, p^2): subtracting c v (c, v < p) and adding p^2 back when the
//! result is negative needs no division, and an entry is reduced modulo p
//! only when it is read.  The columns are visited left to right: an entry
//! met at a pivot column is eliminated by that pivot (which only touches
//! columns to its right), any other entry is final and goes to the output.
//! So reducing by the known pivots is one pass per row, and the rows are
//! independent: natively they are spread over threads.  The remainders are
//! then echelonized among themselves.

/// A sparse row: increasing columns and their values in [0, p).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Row {
    pub cols: Vec<u32>,
    pub vals: Vec<u32>,
}

impl Row {
    pub fn is_empty(&self) -> bool {
        self.cols.is_empty()
    }

    pub fn len(&self) -> usize {
        self.cols.len()
    }

    /// The row scaled to a leading coefficient 1.
    pub fn monic(mut self, p: u32) -> Row {
        if let Some(&l) = self.vals.first() {
            if l != 1 {
                let i = inv(l, p);
                for v in self.vals.iter_mut() {
                    *v = ((*v as u64 * i as u64) % p as u64) as u32;
                }
            }
        }
        self
    }
}

fn inv(a: u32, p: u32) -> u32 {
    let (mut r0, mut r1) = (p as i64, a as i64);
    let (mut s0, mut s1) = (0i64, 1i64);
    while r1 != 0 {
        let q = r0 / r1;
        (r0, r1) = (r1, r0 - q * r1);
        (s0, s1) = (s1, s0 - q * s1);
    }
    s0.rem_euclid(p as i64) as u32
}

/// x mod p for 0 <= x < 2^62, by a precomputed reciprocal (no division).
#[derive(Clone, Copy)]
struct Red {
    p: u64,
    // floor(2^64 / p)
    r: u64,
}

impl Red {
    fn new(p: u32) -> Red {
        Red { p: p as u64, r: ((1u128 << 64) / p as u128) as u64 }
    }

    #[inline(always)]
    fn rem(&self, x: u64) -> u64 {
        let q = ((x as u128 * self.r as u128) >> 64) as u64;
        // q is floor(x / p) or one less (x < 2^62)
        let mut t = x - q * self.p;
        if t >= self.p {
            t -= self.p;
        }
        debug_assert!(t < self.p);
        t
    }
}

/// d -= c * row[1..] (entries kept in [0, p^2)), returning the last column.
#[inline(always)]
fn axpy(d: &mut [i64], c: i64, p2: i64, row: &Row) -> usize {
    let cols = &row.cols[1..];
    let vals = &row.vals[1..];
    for k in 0..cols.len() {
        let col = cols[k] as usize;
        let y = d[col] - c * vals[k] as i64;
        d[col] = y + ((y >> 63) & p2);
    }
    cols.last().map_or(0, |&c| c as usize)
}

/// The pivots: for each column, the monic row leading there (if any).
pub struct Pivots<'a> {
    pub p: u32,
    pub rows: Vec<Option<&'a Row>>,
}

/// One accumulator per thread, reused across rows.
struct Acc {
    d: Vec<i64>,
}

impl Pivots<'_> {
    /// row reduced by the pivots: the remaining entries (at columns
    /// without a pivot), in increasing order.
    fn reduce_one(&self, row: &Row, acc: &mut Acc) -> Row {
        let Some(&first) = row.cols.first() else { return Row::default() };
        let mut last = 0usize;
        for (&c, &v) in row.cols.iter().zip(&row.vals) {
            acc.d[c as usize] = v as i64;
            last = last.max(c as usize);
        }
        self.reduce_loaded(acc, first as usize, last, None)
    }

    /// The accumulator (entries in [0, p^2) between first and last)
    /// reduced by the pivots and the local ones (by leading column), left
    /// zero; the remaining entries as a row.
    fn reduce_loaded(&self, acc: &mut Acc, first: usize, mut last: usize, local: Option<&std::collections::HashMap<u32, Row>>) -> Row {
        let p = self.p as i64;
        let p2 = p * p;
        let red = Red::new(self.p);
        let d = &mut acc.d;
        let mut out = Row::default();
        let n = d.len();
        let mut j = first;
        while j < n {
            let x = d[j];
            if x != 0 {
                d[j] = 0;
                let c = red.rem(x as u64) as i64;
                if c != 0 {
                    match self.rows[j].or_else(|| local.and_then(|l| l.get(&(j as u32)))) {
                        Some(pr) => {
                            // d -= c * pr (its leading 1 at j is cancelled)
                            last = last.max(axpy(d, c, p2, pr));
                        }
                        None => {
                            out.cols.push(j as u32);
                            out.vals.push(c as u32);
                        }
                    }
                }
            }
            if j >= last {
                break;
            }
            j += 1;
        }
        out
    }

    /// A block of rows to their row space modulo the pivots, by random
    /// linear combinations (Steel's idea, as described by Monagan and
    /// Pearce): each combination is reduced by the pivots and the rows found
    /// so far, until one reduces to 0, which then (but for a probability
    /// about 1/p) the rest would too.  Monic rows with distinct leading
    /// columns, not reduced by one another.
    fn reduce_block(&self, rows: &[Row], acc: &mut Acc, seed: u64) -> Vec<Row> {
        let p = self.p as u64;
        let p2 = (p * p) as i64;
        let mut s = seed | 1;
        let mut rnd = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            1 + s % (p - 1)
        };
        let mut local: std::collections::HashMap<u32, Row> = std::collections::HashMap::new();
        let mut out = vec![];
        for _ in 0..rows.len() {
            // the combination, loaded into the accumulator
            let (mut first, mut last) = (usize::MAX, 0usize);
            for r in rows {
                if r.is_empty() {
                    continue;
                }
                let l = rnd() as i64;
                for (&c, &v) in r.cols.iter().zip(&r.vals) {
                    let y = acc.d[c as usize] - l * v as i64;
                    acc.d[c as usize] = y + ((y >> 63) & p2);
                }
                first = first.min(r.cols[0] as usize);
                last = last.max(*r.cols.last().unwrap() as usize);
            }
            if first == usize::MAX {
                break;
            }
            let r = self.reduce_loaded(acc, first, last, Some(&local));
            if r.is_empty() {
                break;
            }
            let r = r.monic(self.p);
            local.insert(r.cols[0], r.clone());
            out.push(r);
        }
        out
    }

    /// The rows' span modulo the pivots by random combinations of blocks
    /// (see reduce_block): rows with new leading columns, to be echelonized
    /// together.  Correct but for a probability about (number of blocks)/p.
    pub fn reduce_random(&self, rows: &[Row], ncols: usize, threads: usize, block: usize, seed: u64) -> Vec<Row> {
        let blocks: Vec<&[Row]> = rows.chunks(block.max(1)).collect();
        let threads = threads.max(1).min(blocks.len().max(1));
        if threads == 1 {
            let mut acc = Acc { d: vec![0; ncols] };
            let mut out = vec![];
            for (k, b) in blocks.iter().enumerate() {
                sagebrush_interrupt::check();
                out.extend(self.reduce_block(b, &mut acc, seed ^ (k as u64).wrapping_mul(0x9E3779B97F4A7C15)));
            }
            return out;
        }
        #[cfg(target_arch = "wasm32")]
        {
            unreachable!()
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            use std::sync::atomic::{AtomicUsize, Ordering};
            let next = AtomicUsize::new(0);
            let out: Vec<std::sync::Mutex<Vec<Row>>> = (0..blocks.len()).map(|_| std::sync::Mutex::new(vec![])).collect();
            std::thread::scope(|sc| {
                for _ in 0..threads {
                    sc.spawn(|| {
                        let mut acc = Acc { d: vec![0; ncols] };
                        loop {
                            let k = next.fetch_add(1, Ordering::Relaxed);
                            if k >= blocks.len() {
                                break;
                            }
                            let r = self.reduce_block(blocks[k], &mut acc, seed ^ (k as u64).wrapping_mul(0x9E3779B97F4A7C15));
                            *out[k].lock().unwrap() = r;
                        }
                    });
                }
            });
            out.into_iter().flat_map(|m| m.into_inner().unwrap()).collect()
        }
    }

    /// Every row reduced by the pivots (in order; empty rows reduced to 0),
    /// natively on up to `threads` threads.
    pub fn reduce(&self, rows: &[Row], ncols: usize, threads: usize) -> Vec<Row> {
        let threads = threads.max(1).min(rows.len().max(1));
        if threads == 1 || rows.len() < 8 {
            let mut acc = Acc { d: vec![0; ncols] };
            return rows
                .iter()
                .enumerate()
                .map(|(k, r)| {
                    if k & 63 == 0 {
                        sagebrush_interrupt::check();
                    }
                    self.reduce_one(r, &mut acc)
                })
                .collect();
        }
        #[cfg(target_arch = "wasm32")]
        {
            unreachable!()
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            use std::sync::atomic::{AtomicUsize, Ordering};
            let next = AtomicUsize::new(0);
            let out: Vec<std::sync::Mutex<Row>> = (0..rows.len()).map(|_| std::sync::Mutex::new(Row::default())).collect();
            std::thread::scope(|sc| {
                for _ in 0..threads {
                    sc.spawn(|| {
                        let mut acc = Acc { d: vec![0; ncols] };
                        loop {
                            // rows in chunks: fewer atomic operations
                            let k0 = next.fetch_add(4, Ordering::Relaxed);
                            if k0 >= rows.len() {
                                break;
                            }
                            for k in k0..(k0 + 4).min(rows.len()) {
                                let r = self.reduce_one(&rows[k], &mut acc);
                                *out[k].lock().unwrap() = r;
                            }
                        }
                    });
                }
            });
            out.into_iter().map(|m| m.into_inner().unwrap()).collect()
        }
    }
}

/// The rows (already reduced by any earlier pivots) echelonized among
/// themselves: monic rows with distinct leading columns, each reduced by
/// the ones found before it, in the order found.
pub fn echelonize(rows: Vec<Row>, ncols: usize, p: u32) -> Vec<Row> {
    let mut found: Vec<Row> = vec![];
    // the leading column of each found row, as an index into `found`
    let mut at: Vec<u32> = vec![u32::MAX; ncols];
    let mut acc = Acc { d: vec![0; ncols] };
    for r in rows {
        if r.is_empty() {
            continue;
        }
        let red = {
            // reduce by the found rows (looked up through `at`)
            let pp = p as i64;
            let p2 = pp * pp;
            let red = Red::new(p);
            let d = &mut acc.d;
            let mut last = 0usize;
            for (&c, &v) in r.cols.iter().zip(&r.vals) {
                d[c as usize] = v as i64;
                last = last.max(c as usize);
            }
            let mut out = Row::default();
            let mut j = r.cols[0] as usize;
            loop {
                let x = d[j];
                if x != 0 {
                    d[j] = 0;
                    let c = red.rem(x as u64) as i64;
                    if c != 0 {
                        let k = at[j];
                        if k != u32::MAX {
                            last = last.max(axpy(d, c, p2, &found[k as usize]));
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
            out
        };
        if !red.is_empty() {
            let red = red.monic(p);
            at[red.cols[0] as usize] = found.len() as u32;
            found.push(red);
        }
    }
    found
}

/// Rows with distinct leading columns (each monic and reduced by the ones
/// before it, as echelonize returns them) made fully reduced: no row has a
/// nonzero entry at another's leading column.  The order is kept.
pub fn back_reduce(rows: Vec<Row>, ncols: usize, p: u32) -> Vec<Row> {
    let n = rows.len();
    // by decreasing leading column: each is reduced by those to its right,
    // which are reduced already
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(rows[i].cols[0]));
    let mut done: Vec<Option<Row>> = vec![None; n];
    let mut at: Vec<u32> = vec![u32::MAX; ncols];
    let mut acc = Acc { d: vec![0; ncols] };
    let pp = p as i64;
    let p2 = pp * pp;
    let red = Red::new(p);
    for &i in &order {
        let r = &rows[i];
        let d = &mut acc.d;
        let mut last = 0usize;
        for (&c, &v) in r.cols.iter().zip(&r.vals) {
            d[c as usize] = v as i64;
            last = last.max(c as usize);
        }
        let mut out = Row::default();
        let mut j = r.cols[0] as usize;
        loop {
            let x = d[j];
            if x != 0 {
                d[j] = 0;
                let c = red.rem(x as u64) as i64;
                if c != 0 {
                    let k = at[j];
                    if k != u32::MAX {
                        last = last.max(axpy(d, c, p2, done[k as usize].as_ref().unwrap()));
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
        at[r.cols[0] as usize] = i as u32;
        done[i] = Some(out);
    }
    done.into_iter().map(|r| r.unwrap()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(e: &[(u32, u32)]) -> Row {
        Row { cols: e.iter().map(|x| x.0).collect(), vals: e.iter().map(|x| x.1).collect() }
    }

    #[test]
    fn small() {
        let p = 7;
        // pivots at 0 and 2: x0 + 3 x3, x2 + x3
        let a = row(&[(0, 1), (3, 3)]);
        let b = row(&[(2, 1), (3, 1)]);
        let piv = Pivots { p, rows: vec![Some(&a), None, Some(&b), None] };
        // 2 x0 + x1 + 5 x2 + x3 -> x1 + (1 - 6 - 5) x3 = x1 - 10 x3 = x1 + 4 x3 (mod 7)
        let r = row(&[(0, 2), (1, 1), (2, 5), (3, 1)]);
        let out = piv.reduce(&[r.clone()], 4, 1);
        assert_eq!(out[0], row(&[(1, 1), (3, 4)]));
        let ech = echelonize(vec![out[0].clone(), row(&[(1, 2), (3, 1)]), row(&[(3, 5)])], 4, p);
        // x1 + 4 x3, then 2x1 + x3 - 2(x1 + 4 x3) = -7 x3 = 0, then x3
        assert_eq!(ech, vec![row(&[(1, 1), (3, 4)]), row(&[(3, 1)])]);
    }

    #[test]
    fn random_combinations() {
        // three rows modulo the pivot at column 0, in one block, against the
        // exact reduction
        let p = 1000003;
        let a = row(&[(0, 1), (2, 5)]);
        let piv = Pivots { p, rows: vec![Some(&a), None, None, None] };
        let r1 = row(&[(0, 3), (1, 1), (3, 2)]);
        let r2 = row(&[(1, 2), (3, 4)]);
        let r3 = row(&[(2, 7), (3, 1)]);
        let out = piv.reduce_random(&[r1.clone(), r2.clone(), r3.clone(), r1.clone()], 4, 1, 8, 42);
        let ex = back_reduce(echelonize(piv.reduce(&[r1, r2, r3], 4, 1), 4, p), 4, p);
        let got = back_reduce(echelonize(out, 4, p), 4, p);
        assert_eq!(got, ex);
    }

    #[test]
    fn random_against_dense() {
        // random sparse pivots and rows mod a 31-bit prime, against a dense
        // elimination
        let p: u32 = 2147483629;
        let n = 60usize;
        let mut s = 12345u64;
        let mut rnd = |m: u64| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s % m
        };
        let mut pivs: Vec<Option<Row>> = vec![None; n];
        for j in 0..n {
            if rnd(3) != 0 {
                let mut e = vec![(j as u32, 1u32)];
                for k in j + 1..n {
                    if rnd(4) == 0 {
                        e.push((k as u32, rnd(p as u64) as u32));
                    }
                }
                pivs[j] = Some(row(&e));
            }
        }
        let rows: Vec<Row> = (0..20).map(|_| {
            let mut e: Vec<(u32, u32)> = vec![];
            for k in 0..n as u32 {
                if rnd(3) == 0 {
                    e.push((k, 1 + rnd(p as u64 - 1) as u32));
                }
            }
            row(&e)
        }).collect();
        let piv = Pivots { p, rows: pivs.iter().map(|r| r.as_ref()).collect() };
        let red = piv.reduce(&rows, n, 3);
        // dense check: each reduced row = row - sum c_j pivot_j, zero at pivot columns
        for (r, out) in rows.iter().zip(&red) {
            let mut d = vec![0u64; n];
            for (&c, &v) in r.cols.iter().zip(&r.vals) {
                d[c as usize] = v as u64;
            }
            for j in 0..n {
                if d[j] != 0 {
                    if let Some(pr) = &pivs[j] {
                        let c = d[j];
                        for (&col, &v) in pr.cols.iter().zip(&pr.vals) {
                            d[col as usize] = (d[col as usize] + (p as u64 - c) * v as u64 % p as u64) % p as u64;
                        }
                    }
                }
            }
            let want: Vec<(u32, u32)> = (0..n).filter(|&j| d[j] != 0).map(|j| (j as u32, d[j] as u32)).collect();
            assert_eq!(*out, row(&want));
        }
    }
}
