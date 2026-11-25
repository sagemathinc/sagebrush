//! Dense matrices over Z/p (p a word-size prime): reduced row echelon
//! form, rank, determinant, inverse, solving, nullspace, products and the
//! characteristic polynomial (Hessenberg reduction, H. Cohen, A Course in
//! Computational Algebraic Number Theory, Algorithm 2.2.9).  Row
//! operations multiply by a fixed scalar with Shoup's trick.
//!
//! Units ([`cost::tally`](crate::cost::tally)), counted here and nowhere
//! else: multiply-adds summed in u128 (MulSchool); reductions of those
//! sums, multiplications by a scalar (each reduced), inverses and
//! reductions of inputs (ModArith); copies, row swaps, transposes and
//! zero fills (Move).

use crate::cost::{publish_progress, size_product, tally, tally_all, Family, FAMILIES};
use crate::nmod::{mul_shoup, Modulus};

mod fast;

pub use fast::{product_peak, reset_fast_product, with_fast_product};
#[cfg(feature = "test-hooks")]
pub use fast::{fast_allowance_left, fast_n0, fast_product_state, leave_fast_product_state, set_fast_n0};

/// P A = L U modulo p: L lower triangular (the pivots on its diagonal),
/// U unit upper triangular, stored together in `a`; row i of P A is row
/// perm[i] of A.
#[derive(Clone, Debug)]
pub struct Lu {
    a: Mat,
    perm: Vec<usize>,
}

impl Lu {
    /// x with A x = b.
    pub fn solve_vec(&self, b: &[u64]) -> Vec<u64> {
        let n = self.a.rows;
        let m = self.a.m;
        let batch = batch_len(&m);
        let d = &self.a.d;
        // (no Stop poll here, as before: the counts only)
        let mut poll = Poll::new();
        // the two triangular solves' products, their dot products'
        // reductions (one per chunk), and an inverse and a product per row
        poll.count(Family::MulSchool, (n * n.saturating_sub(1)) as u64);
        poll.count(Family::ModArith, (2 * (0..n).map(|i| i.div_ceil(batch)).sum::<usize>() + 2 * n) as u64);
        poll.count(Family::Move, 2 * n as u64);
        let (b64, pinv) = (batch64(&m), u64::MAX / m.n);
        let dot = |row: &[u64], v: &[u64]| -> u64 {
            if row.len() <= b64 {
                // one u64 sum, one reduction: as one u128 chunk
                let s: u64 = row.iter().zip(v).map(|(&x, &y)| (x as u32 as u64) * (y as u32 as u64)).sum();
                return reduce32(s, m.n, pinv);
            }
            let mut r = 0u64;
            for (ca, cb) in row.chunks(batch).zip(v.chunks(batch)) {
                let mut acc = 0u128;
                for (&x, &y) in ca.iter().zip(cb) {
                    acc += x as u128 * y as u128;
                }
                r = m.add(r, m.reduce_u128(acc));
            }
            r
        };
        let mut y = vec![0u64; n];
        for i in 0..n {
            let s = dot(&d[i * n..i * n + i], &y[..i]);
            let pv = d[i * n + i];
            y[i] = m.mul(m.sub(b[self.perm[i]], s), m.inv(pv).expect("singular"));
        }
        let mut x = vec![0u64; n];
        for i in (0..n).rev() {
            let s = dot(&d[i * n + i + 1..(i + 1) * n], &x[i + 1..]);
            x[i] = m.sub(y[i], s);
        }
        x
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mat {
    pub rows: usize,
    pub cols: usize,
    pub m: Modulus,
    /// Row-major entries, reduced mod p.
    pub d: Vec<u64>,
}

/// Asks for Stop (sagebrush_interrupt::check_coarse, which asks the wasm
/// host at every call) about every 2^16 multiply-adds, a few milliseconds
/// in wasm, where the 128-bit products are emulated: the natural
/// checkpoints of the dense algorithms here (a row, a column, a block) can
/// each cost tens of millions of them for large matrices.  Counts the
/// units by family in a local accumulator, flushed to the thread's tally
/// at each poll (with a metered region's progress) and when the Poll
/// drops, also while unwinding (one thread-local access per call).
struct Poll {
    since: u64,
    acc: [u64; FAMILIES],
    /// The units of one step of a loop whose steps all cost the same (a
    /// row of a product), counted as `steps` (one add per step).
    step: [u64; FAMILIES],
    steps: u64,
}

impl Poll {
    fn new() -> Poll {
        Poll::stepping([0; FAMILIES])
    }
    fn stepping(step: [u64; FAMILIES]) -> Poll {
        Poll { since: Carrying::take(), acc: [0; FAMILIES], step, steps: 0 }
    }
    /// One more step done.
    #[inline]
    fn step(&mut self) {
        self.steps += 1;
    }
    /// `work` toward the next Stop poll (the weights as before metering).
    #[inline]
    fn add(&mut self, work: usize) {
        self.since += work as u64;
        if self.since >= 1 << 16 {
            self.since = 0;
            self.flush();
            sagebrush_interrupt::check_coarse();
            publish_progress();
        }
    }
    /// Inside a fast product, before child products: this Poll's work
    /// toward the next poll carried on to theirs.
    fn hand_off(&mut self) {
        Carrying::put(self.since);
        self.since = 0;
    }
    /// After them: the carried work back.
    fn take_back(&mut self) {
        self.since += Carrying::take();
    }
    /// `n` units of family `f` (not a poll).
    #[inline]
    fn count(&mut self, f: Family, n: u64) {
        self.acc[f as usize] += n;
    }
    fn flush(&mut self) {
        if self.steps > 0 {
            for (a, &u) in self.acc.iter_mut().zip(&self.step) {
                *a += self.steps * u;
            }
            self.steps = 0;
        }
        if self.acc.iter().any(|&x| x != 0) {
            tally_all(&self.acc);
            self.acc = [0; FAMILIES];
        }
    }
}

impl Drop for Poll {
    fn drop(&mut self) {
        self.flush();
        Carrying::put(self.since);
    }
}

thread_local! {
    /// Inside a fast product (its depth, and the work toward the next Stop
    /// poll): the work carried from each Poll to the next, so that the
    /// product's own passes and its many small child products poll as one
    /// loop would, about every 2^16 of work, rather than each from zero.
    static CARRY: std::cell::Cell<(u32, u64)> = const { std::cell::Cell::new((0, 0)) };
}

/// While alive (a fast product running), Polls carry their work toward the
/// next Stop poll from one to the next; at the outermost one's end the
/// carry is dropped.
struct Carrying;

impl Carrying {
    fn new() -> Carrying {
        CARRY.with(|c| {
            let (d, s) = c.get();
            c.set((d + 1, s));
        });
        Carrying
    }
    /// The carried work (0 outside a fast product), now this Poll's.
    fn take() -> u64 {
        CARRY.with(|c| {
            let (d, s) = c.get();
            if d == 0 {
                return 0;
            }
            c.set((d, 0));
            s
        })
    }
    /// No fast product running, nothing carried (see
    /// [`fast::reset_fast_product`]).
    fn reset() {
        CARRY.with(|c| c.set((0, 0)));
    }
    #[cfg(feature = "test-hooks")]
    fn state() -> (u32, u64) {
        CARRY.with(|c| c.get())
    }
    /// A Poll's work toward the next poll, carried on (none outside).
    fn put(since: u64) {
        CARRY.with(|c| {
            let (d, s) = c.get();
            if d > 0 {
                c.set((d, s + since));
            }
        });
    }
}

impl Drop for Carrying {
    fn drop(&mut self) {
        CARRY.with(|c| {
            let (d, s) = c.get();
            c.set((d - 1, if d == 1 { 0 } else { s }));
        });
    }
}

/// The reductions of `rows` sums of `terms` products each, `batch` at a
/// time: one per started batch, and at least one per sum.
fn reductions(rows: usize, terms: usize, batch: usize) -> usize {
    rows * (terms / batch + 1)
}

/// How many products of reduced residues fit in a u128 sum.
fn batch_len(m: &Modulus) -> usize {
    let sq = (m.n as u128 - 1) * (m.n as u128 - 1);
    if sq == 0 {
        usize::MAX
    } else {
        (u128::MAX / sq).min(1 << 30) as usize
    }
}

/// The units [`Mat::echelon`] charges for a reduced echelon form (with the
/// determinant) of a `rows` x `cols` matrix whose first `rows` columns
/// are a nonsingular block that meets no zero factor on the way (the
/// generic case of [a | I] modulo a large prime): its block updates,
/// pivot scalings, flushes and back substitution, by the same loop bounds
/// and with no data.  Off that case the real count differs: a zero factor
/// skips its products (MulSchool and ModArith lower), a zero pivot's row
/// swap adds 2 cols moves (Move higher).
pub(crate) fn echelon_units_dense(rows: usize, cols: usize, batch: usize, block: usize) -> [u64; FAMILIES] {
    let mut u = [0u64; FAMILIES];
    let (ms, ma, mv) = (Family::MulSchool as usize, Family::ModArith as usize, Family::Move as usize);
    // `count` row updates of `len` entries by `factors` pivots each
    let upd = |u: &mut [u64; FAMILIES], len: usize, factors: usize, count: usize| {
        u[ms] = u[ms].saturating_add(size_product(&[factors, len, count]));
        u[ma] = u[ma].saturating_add(size_product(&[len, factors / batch + 1, count]));
        u[mv] = u[mv].saturating_add(size_product(&[len, count]));
    };
    let mut block_start = 0;
    for r in 0..rows {
        let col = r;
        let blk = r - block_start;
        if blk > 0 {
            u[ms] = u[ms].saturating_add(size_product(&[rows - r, blk]));
            u[ma] = u[ma].saturating_add(size_product(&[rows - r, blk / batch + 1]));
            upd(&mut u, cols - (col + 1), blk, 1);
        }
        u[ma] = u[ma].saturating_add((cols - col) as u64 + 1);
        let (r1, col1) = (r + 1, col + 1);
        if r1 - block_start == block {
            upd(&mut u, cols - col1, block, rows - r1);
            block_start = r1;
        }
    }
    // back substitution, bottom up: row i against the later pivots, in
    // chunks of about 2^16 multiply-adds (the full chunks multiplied, then
    // the remainder: O(rows) for the whole count)
    let step = ((1usize << 16) / cols.max(1)).max(1);
    for i in (0..rows).rev() {
        let later = rows - 1 - i;
        upd(&mut u, cols - (i + 1), step, later / step);
        if later % step > 0 {
            upd(&mut u, cols - (i + 1), later % step, 1);
        }
    }
    u
}

/// [`Mat::solve`] takes the LU route for at most this many columns.
const SOLVE_LU_COLS: usize = 8;

/// How many products of reduced residues fit in a u64 sum, for a modulus
/// below 2^32 (0 above: the residues are not 32-bit); at most batch_len.
fn batch64(m: &Modulus) -> usize {
    if m.n > 1 << 32 {
        return 0;
    }
    let sq = (m.n - 1) * (m.n - 1);
    if sq == 0 {
        1 << 30
    } else {
        ((u64::MAX / sq) as usize).min(1 << 30)
    }
}

/// How many products of reduced residues fit in a u64 sum that already
/// holds a residue (a fold's result, below n), for a modulus below 2^32:
/// b with b (n - 1)^2 + (n - 1) <= 2^64 - 1, at least 1 for every such n
/// (n (n - 1) < 2^64); 0 above 2^32.
fn fold64(m: &Modulus) -> usize {
    if m.n > 1 << 32 {
        return 0;
    }
    let q = m.n - 1;
    if q == 0 {
        1 << 30
    } else {
        ((u64::MAX - q) / (q * q)) as usize
    }
    .min(1 << 30)
}

/// The least [`fold64`] at which a row update folds its u64 sums (reduces
/// them every fold64 products) rather than sum in u128: one constant for
/// every target, so the route, and the work it counts, depend on the
/// modulus and the shape alone.  Measured: from fold64 = 4 the elimination
/// runs about 2.5 times faster natively and 3 to 5 times in wasm32; at
/// fold64 = 1 (primes above about 2^31.2), a reduction after every product,
/// the gain is within the builds' noise natively and 7% in wasm32, for
/// fifteen times the reductions, so those primes keep the u128 sums.
const FOLD_MIN: usize = 2;

/// Whether the modulus' u64 sums fold (a modulus below 2^32 whose
/// [`fold64`] reaches [`FOLD_MIN`]).
fn folding(m: &Modulus) -> bool {
    batch64(m) > 0 && fold64(m) >= FOLD_MIN
}

/// Whether a sum of `terms` products of residues takes the u64 route: in
/// one u64 sum ([`batch64`]), or folding every [`fold64`] products.
///
/// The work it counts is the u128 route's (normalized): its products as
/// MulSchool, and one ModArith reduction per sum as one u128 batch would
/// (batch_len >= batch64 products); the folds' reductions are part of the
/// product accumulation, never counted on their own, so the faster route
/// never charges more than the u128 sums of the same block.
fn u64_route(m: &Modulus, terms: usize) -> bool {
    terms <= batch64(m) || (folding(m) && !test_hooks::no_fold())
}

/// For the unit tests only: the same elimination without folding (the u128
/// sums past batch64: the route before folding), to compare the counted
/// units.
#[cfg(test)]
mod test_hooks {
    thread_local!(static NO_FOLD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
    pub(super) fn no_fold() -> bool {
        NO_FOLD.with(|c| c.get())
    }
    pub(super) fn set_no_fold(v: bool) {
        NO_FOLD.with(|c| c.set(v));
    }
    thread_local!(static FOLDS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) });
    /// The raw fold passes (a diagnostic: never counted as work units).
    pub(super) fn fold_done() {
        FOLDS.with(|c| c.set(c.get() + 1));
    }
    pub(super) fn folds_done() -> u64 {
        FOLDS.with(|c| c.get())
    }
    pub(super) fn reset_folds() {
        FOLDS.with(|c| c.set(0));
    }
    thread_local!(static PLAIN_SUMS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
    /// The characteristic polynomial's products each reduced and its row
    /// operations by Shoup's product (as before its u64 sums), to compare
    /// results and units.
    pub(super) fn plain_sums() -> bool {
        PLAIN_SUMS.with(|c| c.get())
    }
    pub(super) fn set_plain_sums(v: bool) {
        PLAIN_SUMS.with(|c| c.set(v));
    }
}
#[cfg(not(test))]
mod test_hooks {
    #[inline(always)]
    pub(super) fn no_fold() -> bool {
        false
    }
    #[inline(always)]
    pub(super) fn fold_done() {}
    #[inline(always)]
    pub(super) fn plain_sums() -> bool {
        false
    }
}

/// The folds of a u64 sum of `terms` products: the first [`batch64`] of
/// them in the empty sum, then [`fold64`] after each fold.  A diagnostic
/// (the tests' and the timings' raw count): folds are never counted as
/// work units (see [`u64_route`]).
#[cfg(test)]
fn folds(m: &Modulus, terms: usize) -> usize {
    let b64 = batch64(m);
    if terms <= b64 {
        0
    } else {
        (terms - b64).div_ceil(fold64(m))
    }
}

/// The sums of a row update: u128, or u64 when the products are of 32-bit
/// residues and few enough to fit (see [`batch64`]), or folded.
struct Acc {
    w: Vec<u128>,
    s: Vec<u64>,
}

impl Acc {
    fn new(len: usize) -> Acc {
        Acc { w: vec![0; len], s: vec![0; len] }
    }
}

/// x mod n for any u64 and n below 2^32, without branches (Barrett):
/// with pinv = floor((2^64 - 1) / n) >= 2^64 / n - 1, the quotient
/// estimate q = floor(x pinv / 2^64) is more than x / n - 2, so it is
/// floor(x / n) or one less and x - q n is below 2 n.
#[inline(always)]
fn reduce32(x: u64, n: u64, pinv: u64) -> u64 {
    let q = ((x as u128 * pinv as u128) >> 64) as u64;
    let r = x - q * n;
    // (masks, not branches: the comparisons are random on random data)
    r - (n & 0u64.wrapping_sub((r >= n) as u64))
}

/// (x - (a mod n)) mod n for x a residue, n below 2^32, without branches.
#[inline(always)]
fn sub_reduce32(x: u64, a: u64, n: u64, pinv: u64) -> u64 {
    let d = x + n - reduce32(a, n, pinv);
    d - (n & 0u64.wrapping_sub((d >= n) as u64))
}

/// sum_t a_t b_t mod p for residues a, b: in u64 when the products fit one
/// u64 sum or the modulus' sums fold (folded every fold64 products past the
/// first batch64, as the elimination's), else in u128 chunks of `batch`;
/// either way exactly the residue of the sum.
fn dot(a: &[u64], b: &[u64], m: &Modulus, batch: usize) -> u64 {
    if (a.len() <= batch64(m) || folding(m)) && !test_hooks::plain_sums() {
        let pinv = u64::MAX / m.n;
        let (mut limit, bf) = (batch64(m), fold64(m));
        let (mut s, mut seg) = (0u64, 0usize);
        for (&x, &y) in a.iter().zip(b) {
            if seg == limit {
                s = reduce32(s, m.n, pinv);
                (seg, limit) = (0, bf);
            }
            debug_assert!(s <= u64::MAX - (m.n - 1) * (m.n - 1));
            s += (x as u32 as u64) * (y as u32 as u64);
            seg += 1;
        }
        return reduce32(s, m.n, pinv);
    }
    let mut r = 0u64;
    for (ca, cb) in a.chunks(batch).zip(b.chunks(batch)) {
        let mut acc = 0u128;
        for (&x, &y) in ca.iter().zip(cb) {
            acc += x as u128 * y as u128;
        }
        r = m.add(r, m.reduce_u128(acc));
    }
    r
}

/// Sums of scaled rows for the characteristic polynomial's recurrence, for
/// 32-bit residues: acc[j] = sum f_i src_i[j] in u64, folded (every entry
/// reduced) every fold64 rows past the first batch64.
struct Sums {
    acc: Vec<u64>,
    n: u64,
    pinv: u64,
    seg: usize,
    limit: usize,
    bf: usize,
}

impl Sums {
    /// None unless the modulus' sums fold, as the elimination's (the caller
    /// reduces each product).
    fn new(m: &Modulus, len: usize) -> Option<Sums> {
        (folding(m) && !test_hooks::plain_sums()).then(|| Sums { acc: vec![0; len], n: m.n, pinv: u64::MAX / m.n, seg: 0, limit: batch64(m), bf: fold64(m) })
    }
    fn add_scaled(&mut self, f: u64, src: &[u64]) {
        if self.seg == self.limit {
            for a in self.acc.iter_mut() {
                *a = reduce32(*a, self.n, self.pinv);
            }
            (self.seg, self.limit) = (0, self.bf);
        }
        let q = (self.n - 1) * (self.n - 1);
        for (a, &c) in self.acc.iter_mut().zip(src) {
            debug_assert!(*a <= u64::MAX - q);
            *a += (f as u32 as u64) * (c as u32 as u64);
        }
        self.seg += 1;
    }
    /// next[j] -= acc[j] (mod p).
    fn subtract_from(&self, next: &mut [u64]) {
        for (x, &a) in next.iter_mut().zip(&self.acc) {
            *x = sub_reduce32(*x, a, self.n, self.pinv);
        }
    }
}

/// acc += f * src, f and the entries of src residues below 2^32, the sums
/// in u64 (the caller bounds how many products it adds).
#[allow(unsafe_code)]
fn axpy32(acc: &mut [u64], src: &[u64], f: u64) {
    #[cfg(target_arch = "x86_64")]
    {
        if std::is_x86_feature_detected!("avx2") {
            // SAFETY: AVX2 was just detected; the body is the safe kernel.
            unsafe { axpy32_avx2(acc, src, f) };
            return;
        }
    }
    axpy32_generic(acc, src, f)
}

#[inline(always)]
fn axpy32_generic(acc: &mut [u64], src: &[u64], f: u64) {
    // (the 32-bit casts are exact on residues below 2^32 and let the
    // compiler multiply 32 x 32 -> 64 bits, several lanes at a time)
    let f = f as u32 as u64;
    for (a, &y) in acc.iter_mut().zip(src) {
        *a += f * (y as u32 as u64);
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
// SAFETY: the caller must have checked AVX2 (axpy32 does); the body is the
// safe generic kernel.
#[allow(unsafe_code)]
unsafe fn axpy32_avx2(acc: &mut [u64], src: &[u64], f: u64) {
    axpy32_generic(acc, src, f)
}


/// [`batch_len`] for the models.
pub(crate) fn batch_of(m: &Modulus) -> usize {
    batch_len(m)
}

/// How many pivots [`Mat::echelon`] collects before it brings the rows
/// below up to date: 32 when their products fit u64 sums (fewer passes
/// over the rows below, which cost more than the sums), else 16.
pub(crate) fn block_of(m: &Modulus) -> usize {
    if batch64(m) >= 32 {
        32
    } else {
        16
    }
}

/// row[j] -= sum_t row[blk[t]] * src(t)[j] for j >= from: the products
/// summed in u128 (`batch` at a time), one reduction per entry.
#[inline]
#[allow(clippy::too_many_arguments)]
fn update_row<'a, F: Fn(usize) -> &'a [u64]>(row: &mut [u64], from: usize, blk: &[usize], src: F, m: &Modulus, batch: usize, acc: &mut Acc, poll: &mut Poll) {
    let len = row.len() - from;
    if u64_route(m, blk.len()) {
        // one u64 sum per entry: within batch64 products, the same products
        // and reductions as one u128 batch (batch_len >= batch64); past it,
        // the sums reduced (folded) every fold64 products.  Counted as the
        // u128 route's (u64_route): the folds are not counted
        let acc = &mut acc.s[..len];
        acc.iter_mut().for_each(|x| *x = 0);
        let pinv = u64::MAX / m.n;
        let (mut limit, bf) = (batch64(m), fold64(m));
        let mut cnt = 0;
        let mut seg = 0;
        for (t, &ct) in blk.iter().enumerate() {
            let f = row[ct];
            if f == 0 {
                continue;
            }
            if seg == limit {
                for a in acc.iter_mut() {
                    *a = reduce32(*a, m.n, pinv);
                }
                test_hooks::fold_done();
                (seg, limit) = (0, bf);
            }
            debug_assert!(seg < limit);
            // (each sum leaves room for one more product)
            debug_assert!(acc.iter().all(|&a| a <= u64::MAX - (m.n - 1) * (m.n - 1)));
            axpy32(acc, &src(t)[from..], f);
            cnt += 1;
            seg += 1;
        }
        poll.count(Family::MulSchool, (cnt * len) as u64);
        poll.count(Family::ModArith, len as u64);
        poll.count(Family::Move, len as u64);
        for (x, &a) in row[from..].iter_mut().zip(acc.iter()) {
            *x = sub_reduce32(*x, a, m.n, pinv);
        }
        return;
    }
    let acc = &mut acc.w[..len];
    let mut part: Option<Vec<u64>> = None;
    acc.iter_mut().for_each(|x| *x = 0);
    let mut cnt = 0;
    let mut batches = 0;
    for (t, &ct) in blk.iter().enumerate() {
        let f = row[ct];
        if f == 0 {
            continue;
        }
        let s = &src(t)[from..];
        for (a, &y) in acc.iter_mut().zip(s) {
            *a += f as u128 * y as u128;
        }
        cnt += 1;
        if cnt == batch {
            let p = part.get_or_insert_with(|| vec![0u64; len]);
            for (q, a) in p.iter_mut().zip(acc.iter_mut()) {
                *q = m.add(*q, m.reduce_u128(*a));
                *a = 0;
            }
            cnt = 0;
            batches += 1;
        }
    }
    // (the products are len per nonzero factor, batch * batches + cnt of
    // them; the reductions len per full batch, plus the last)
    poll.count(Family::MulSchool, ((batch * batches + cnt) * len) as u64);
    poll.count(Family::ModArith, (len * (batches + 1)) as u64);
    poll.count(Family::Move, len as u64);
    let tail = &mut row[from..];
    match part {
        None => {
            for (x, &a) in tail.iter_mut().zip(acc.iter()) {
                *x = m.sub(*x, m.reduce_u128(a));
            }
        }
        Some(p) => {
            for ((x, &a), &q) in tail.iter_mut().zip(acc.iter()).zip(&p) {
                *x = m.sub(*x, m.add(q, m.reduce_u128(a)));
            }
        }
    }
}

/// dst += c * src (mod p), c reduced.
#[inline]
fn axpy(dst: &mut [u64], src: &[u64], c: u64, m: &Modulus) {
    if c == 0 {
        return;
    }
    if batch64(m) > 0 && !test_hooks::plain_sums() {
        // (32-bit residues: x + c y < p + (p - 1)^2 < 2^64, one branch-free
        // reduction, which vectorizes)
        let pinv = u64::MAX / m.n;
        let c = c as u32 as u64;
        for (x, &y) in dst.iter_mut().zip(src) {
            *x = reduce32(*x + c * (y as u32 as u64), m.n, pinv);
        }
        return;
    }
    if m.n < 1 << 63 {
        let cp = m.shoup(c);
        for (x, &y) in dst.iter_mut().zip(src) {
            *x = m.add(*x, mul_shoup(y, c, cp, m.n));
        }
    } else {
        for (x, &y) in dst.iter_mut().zip(src) {
            *x = m.add(*x, m.mul(y, c));
        }
    }
}

#[inline]
fn scale(v: &mut [u64], c: u64, m: &Modulus) {
    if m.n < 1 << 63 {
        let cp = m.shoup(c);
        for x in v.iter_mut() {
            *x = mul_shoup(*x, c, cp, m.n);
        }
    } else {
        for x in v.iter_mut() {
            *x = m.mul(*x, c);
        }
    }
}

impl Mat {
    pub fn zero(rows: usize, cols: usize, m: Modulus) -> Mat {
        tally(Family::Move, (rows * cols) as u64);
        Mat { rows, cols, m, d: vec![0; rows * cols] }
    }

    /// A copy (counted: Move).
    fn copy(&self) -> Mat {
        tally(Family::Move, self.d.len() as u64);
        self.clone()
    }

    pub fn identity(n: usize, m: Modulus) -> Mat {
        let mut a = Mat::zero(n, n, m);
        for i in 0..n {
            a.d[i * n + i] = 1 % m.n;
        }
        a
    }

    pub fn from_rows(rows: &[Vec<u64>], m: Modulus) -> Mat {
        let r = rows.len();
        let c = rows.first().map_or(0, |x| x.len());
        tally(Family::ModArith, (r * c) as u64);
        Mat { rows: r, cols: c, m, d: rows.iter().flat_map(|row| row.iter().map(|&x| m.reduce(x))).collect() }
    }

    #[inline]
    pub fn get(&self, i: usize, j: usize) -> u64 {
        self.d[i * self.cols + j]
    }

    #[inline]
    pub fn set(&mut self, i: usize, j: usize, x: u64) {
        self.d[i * self.cols + j] = x;
    }

    pub fn row(&self, i: usize) -> &[u64] {
        &self.d[i * self.cols..(i + 1) * self.cols]
    }

    /// (not counted here: the callers count 2 cols Move in their Poll)
    fn swap_rows(&mut self, i: usize, j: usize) {
        if i != j {
            let c = self.cols;
            for k in 0..c {
                self.d.swap(i * c + k, j * c + k);
            }
        }
    }

    /// Two distinct rows, the first mutable.
    fn rows2(&mut self, i: usize, j: usize) -> (&mut [u64], &[u64]) {
        let c = self.cols;
        if i < j {
            let (a, b) = self.d.split_at_mut(j * c);
            (&mut a[i * c..(i + 1) * c], &b[..c])
        } else {
            let (a, b) = self.d.split_at_mut(i * c);
            (&mut b[..c], &a[j * c..(j + 1) * c])
        }
    }

    /// Reduce to reduced row echelon form in place; the pivot columns.
    pub fn rref(&mut self) -> Vec<usize> {
        let (piv, _) = self.echelon(true, false);
        piv
    }

    /// As `rref`, with the rows of the matrix the pivots were found in, in
    /// increasing order (S), and det of the submatrix in those rows and the
    /// pivot columns (P): the elimination is an LU factorization of it, so
    /// the determinant is the product of the pivots, signed by the order in
    /// which the rows were taken.
    pub fn rref_rows(&mut self) -> (Vec<usize>, Vec<usize>, u64) {
        let mut at: Vec<usize> = (0..self.rows).collect();
        let (piv, det) = self.echelon_impl(true, true, None, Some(&mut at));
        let k = piv.len();
        // det is the pivots' product times the sign of the whole row
        // permutation; make it the sign of the order of the first k rows
        let sign = perm_sign(&at) ^ inversions_odd(&at[..k]);
        let mut taken = vec![false; self.rows];
        for &i in &at[..k] {
            taken[i] = true;
        }
        let s: Vec<usize> = (0..self.rows).filter(|&i| taken[i]).collect();
        let m = self.m;
        (piv, s, if sign { m.neg(det) } else { det })
    }

    pub fn rank(&self) -> usize {
        self.copy().echelon(false, false).0.len()
    }

    pub fn det(&self) -> u64 {
        assert_eq!(self.rows, self.cols, "determinant of a non-square matrix");
        let (piv, d) = self.copy().echelon(false, true);
        if piv.len() < self.rows {
            0
        } else {
            d
        }
    }

    /// Gaussian elimination with delayed updates: pivots are collected in
    /// blocks of up to BLOCK, and the rows below are brought up to date
    /// one column at a time (to find the next pivot) and then all at once
    /// when the block is full, summing the block's products in u128 with
    /// one reduction per entry (a matrix-product shape, which also keeps
    /// the rows in cache).  Pivot rows end normalized to 1 at the pivot.
    /// With `reduced`, back substitution gives the reduced form, again as
    /// products: R_i = U_i - sum_{t > i} U_i[c_t] R_t.  Returns the pivot
    /// columns and the product of the pivots times the sign of the row
    /// permutation (the determinant, for a square matrix of full rank;
    /// computed only if `want_det`).
    pub fn echelon(&mut self, reduced: bool, want_det: bool) -> (Vec<usize>, u64) {
        self.echelon_impl(reduced, want_det, None, None)
    }

    /// An LU factorization of a square matrix, if it is nonsingular.
    pub fn lu(&self) -> Option<Lu> {
        assert_eq!(self.rows, self.cols);
        let n = self.rows;
        let mut a = self.copy();
        let mut perm: Vec<usize> = (0..n).collect();
        let (piv, _) = a.echelon_impl(false, false, Some((&mut perm, &mut vec![])), None);
        if piv.len() < n {
            return None;
        }
        Some(Lu { a, perm })
    }

    /// With `lu` = Some((perm, _)): keep the multipliers below the pivots
    /// (L, with the pivot values on its diagonal) and record the row
    /// permutation, for a square matrix.
    fn echelon_impl(&mut self, reduced: bool, want_det: bool, mut lu: Option<(&mut Vec<usize>, &mut Vec<u64>)>, mut rows_at: Option<&mut Vec<usize>>) -> (Vec<usize>, u64) {
        let block = block_of(&self.m);
        let keep = lu.is_some();
        let m = self.m;
        let (rows, cols) = (self.rows, self.cols);
        let batch = batch_len(&m);
        // (at most min(rows, cols) pivots: one allocation of exactly that,
        // the bound the binary echelon's reservation counts)
        let mut pivots: Vec<usize> = Vec::with_capacity(rows.min(cols));
        let mut det = 1 % m.n;
        let mut r = 0;
        let mut block_start = 0; // first pivot row of the pending block
        let mut col = 0;
        let mut acc = Acc::new(cols);
        let mut poll = Poll::new();
        let phase = sagebrush_interrupt::enter("eliminate");
        while col < cols && r < rows {
            let blk = &pivots[block_start..];
            poll.add((rows - r) * (blk.len() + 1));
            // column col of the rows below, up to date with the block
            if !blk.is_empty() {
                poll.count(Family::MulSchool, ((rows - r) * blk.len()) as u64);
                poll.count(Family::ModArith, reductions(rows - r, blk.len(), batch) as u64);
                if u64_route(&m, blk.len()) {
                    // (one u64 sum per entry, folded as in update_row, and
                    // counted as the u128 route's above)
                    let pinv = u64::MAX / m.n;
                    let (b64, bf) = (batch64(&m), fold64(&m));
                    for i in r..rows {
                        let mut s = 0u64;
                        let (mut seg, mut limit) = (0, b64);
                        for (t, &ct) in blk.iter().enumerate() {
                            if seg == limit {
                                s = reduce32(s, m.n, pinv);
                                test_hooks::fold_done();
                                (seg, limit) = (0, bf);
                            }
                            debug_assert!(s <= u64::MAX - (m.n - 1) * (m.n - 1));
                            s += (self.d[i * cols + ct] as u32 as u64) * (self.d[(block_start + t) * cols + col] as u32 as u64);
                            seg += 1;
                        }
                        self.d[i * cols + col] = sub_reduce32(self.d[i * cols + col], s, m.n, pinv);
                    }
                } else {
                for i in r..rows {
                    let mut s = 0u128;
                    let mut red = 0u64;
                    for (t, &ct) in blk.iter().enumerate() {
                        let f = self.d[i * cols + ct];
                        s += f as u128 * self.d[(block_start + t) * cols + col] as u128;
                        if (t + 1) % batch == 0 {
                            red = m.add(red, m.reduce_u128(s));
                            s = 0;
                        }
                    }
                    let red = m.add(red, m.reduce_u128(s));
                    self.d[i * cols + col] = m.sub(self.d[i * cols + col], red);
                }
                }
            }
            let Some(pr) = (r..rows).find(|&i| self.d[i * cols + col] != 0) else {
                col += 1;
                continue;
            };
            if pr != r {
                poll.count(Family::Move, 2 * cols as u64);
                self.swap_rows(r, pr);
                det = m.neg(det);
                if let Some((perm, _)) = lu.as_mut() {
                    perm.swap(r, pr);
                }
                if let Some(at) = rows_at.as_mut() {
                    at.swap(r, pr);
                }
            }
            // the pivot row, up to date for the columns after col (work
            // toward the next poll as a row of a flush)
            if !blk.is_empty() {
                poll.add(cols * blk.len());
                let (head, tail) = self.d.split_at_mut(r * cols);
                let row = &mut tail[..cols];
                update_row(row, col + 1, blk, |t| &head[(block_start + t) * cols..(block_start + t + 1) * cols], &m, batch, &mut acc, &mut poll);
                if !keep {
                    for &ct in blk {
                        row[ct] = 0;
                    }
                }
            }
            let pv = self.d[r * cols + col];
            if want_det {
                det = m.mul(det, pv);
            }
            // the inverse, the det product and the row's scaling
            poll.count(Family::ModArith, (cols - col) as u64 + want_det as u64);
            let inv = m.inv(pv).expect("modulus not prime");
            scale(&mut self.d[r * cols + col + 1..(r + 1) * cols], inv, &m);
            // the pivot value stays (as L's diagonal) when keeping L
            self.d[r * cols + col] = if keep { pv } else { 1 % m.n };
            pivots.push(col);
            r += 1;
            col += 1;
            if pivots.len() - block_start == block {
                self.flush(block_start, &pivots[block_start..], r, col, batch, &mut acc, keep, &mut poll);
                block_start = pivots.len();
            }
        }
        if pivots.len() > block_start {
            let blk = pivots[block_start..].to_vec();
            self.flush(block_start, &blk, r, col, batch, &mut acc, keep, &mut poll);
        }
        // rows r.. are zero (every column was processed or no rows remain)
        if !keep {
            // (in runs of 2^16 words with a Stop check between two runs:
            // below a low rank this is nearly the whole matrix; a fill of
            // one run checks nothing more than before.  Each run is counted
            // once done, so a Stop between runs charges only those done)
            for (i, part) in self.d[r * cols..].chunks_mut(1 << 16).enumerate() {
                if i > 0 {
                    sagebrush_interrupt::check_coarse();
                }
                part.fill(0);
                poll.count(Family::Move, part.len() as u64);
            }
        }
        drop(phase);
        if reduced {
            let _phase = sagebrush_interrupt::enter("back-substitute");
            self.back_substitute(&pivots, batch, &mut acc);
        }
        (pivots, det)
    }

    /// The rows below the block (from row `below`) up to date with the
    /// block's pivots in the columns from `from`, and zero in the block's
    /// pivot columns.
    #[allow(clippy::too_many_arguments)]
    fn flush(&mut self, start: usize, blk: &[usize], below: usize, from: usize, batch: usize, acc: &mut Acc, keep: bool, poll: &mut Poll) {
        let cols = self.cols;
        let m = self.m;
        let (head, tail) = self.d.split_at_mut(below * cols);
        for row in tail.chunks_exact_mut(cols) {
            poll.add(cols * blk.len());
            if blk.iter().all(|&ct| row[ct] == 0) {
                continue;
            }
            update_row(row, from, blk, |t| &head[(start + t) * cols..(start + t + 1) * cols], &m, batch, acc, poll);
            if !keep {
                for &ct in blk {
                    row[ct] = 0;
                }
            }
        }
    }

    /// From the echelon form with normalized pivot rows to the reduced
    /// form: R_i = U_i - sum_{t > i} U_i[c_t] R_t, bottom up.
    fn back_substitute(&mut self, piv: &[usize], batch: usize, acc: &mut Acc) {
        let cols = self.cols;
        let m = self.m;
        let k = piv.len();
        let mut poll = Poll::new();
        for i in (0..k).rev() {
            let later = &piv[i + 1..];
            if later.is_empty() || later.iter().all(|&ct| self.d[i * cols + ct] == 0) {
                continue;
            }
            let (head, tail) = self.d.split_at_mut((i + 1) * cols);
            let row = &mut head[i * cols..];
            // in chunks of about 2^16 multiply-adds, polled between them
            // (exact: R_t is zero in the other pivot columns, so a chunk
            // leaves the multipliers of the later chunks as they were)
            let step = ((1usize << 16) / cols.max(1)).max(1);
            for (s, chunk) in later.chunks(step).enumerate() {
                let off = s * step;
                update_row(row, piv[i] + 1, chunk, |t| &tail[(off + t) * cols..(off + t + 1) * cols], &m, batch, acc, &mut poll);
                poll.add(cols * chunk.len());
            }
            for &ct in later {
                row[ct] = 0;
            }
        }
    }

    /// [self | other] (same number of rows).
    pub fn augment(&self, other: &Mat) -> Mat {
        assert_eq!(self.rows, other.rows);
        let cols = self.cols + other.cols;
        tally(Family::Move, (self.rows * cols) as u64);
        let mut d = Vec::with_capacity(self.rows * cols);
        for i in 0..self.rows {
            d.extend_from_slice(self.row(i));
            d.extend_from_slice(other.row(i));
        }
        Mat { rows: self.rows, cols, m: self.m, d }
    }

    /// Columns lo..hi.
    pub fn columns(&self, lo: usize, hi: usize) -> Mat {
        tally(Family::Move, (self.rows * (hi - lo)) as u64);
        let mut d = Vec::with_capacity(self.rows * (hi - lo));
        for i in 0..self.rows {
            d.extend_from_slice(&self.row(i)[lo..hi]);
        }
        Mat { rows: self.rows, cols: hi - lo, m: self.m, d }
    }

    /// X with self X = b, for self square and nonsingular; None if singular.
    /// For a few columns, by an LU factorization and two triangular solves
    /// per column (about n^3/3 + 2 k n^2 multiply-adds for k columns);
    /// else by the reduced echelon form of [self | b] (about 2 n^3/3 +
    /// 3 k n^2 / 2, in products over whole blocks).
    pub fn solve(&self, b: &Mat) -> Option<Mat> {
        assert_eq!(self.rows, self.cols);
        let n = self.rows;
        if n > 0 && b.cols <= SOLVE_LU_COLS {
            assert_eq!(b.rows, n);
            let lu = self.lu()?;
            let mut x = Mat::zero(n, b.cols, self.m);
            for j in 0..b.cols {
                let col: Vec<u64> = (0..n).map(|i| b.d[i * b.cols + j]).collect();
                for (i, v) in lu.solve_vec(&col).into_iter().enumerate() {
                    x.d[i * b.cols + j] = v;
                }
            }
            // (the columns' copies in and out)
            tally(Family::Move, (2 * n * b.cols) as u64);
            return Some(x);
        }
        let mut a = self.augment(b);
        let piv = a.rref();
        // (n = 0: the empty solution; piv[n - 1] would panic)
        if n > 0 && (piv.len() < n || piv[n - 1] != n - 1) {
            return None;
        }
        Some(a.columns(n, a.cols))
    }

    pub fn inverse(&self) -> Option<Mat> {
        self.solve(&Mat::identity(self.rows, self.m))
    }

    /// A basis of the right kernel {x : self x = 0}, as the rows of the result.
    pub fn nullspace(&self) -> Mat {
        let mut a = self.copy();
        let piv = a.rref();
        let free: Vec<usize> = (0..self.cols).filter(|c| !piv.contains(c)).collect();
        let mut k = Mat::zero(free.len(), self.cols, self.m);
        tally(Family::ModArith, (free.len() * piv.len()) as u64);
        for (t, &f) in free.iter().enumerate() {
            k.set(t, f, 1 % self.m.n);
            for (i, &pc) in piv.iter().enumerate() {
                k.set(t, pc, self.m.neg(a.get(i, f)));
            }
        }
        k
    }

    pub fn transpose(&self) -> Mat {
        let mut t = Mat::zero(self.cols, self.rows, self.m);
        tally(Family::Move, self.d.len() as u64);
        for i in 0..self.rows {
            for j in 0..self.cols {
                t.d[j * self.rows + i] = self.d[i * self.cols + j];
            }
        }
        t
    }

    /// The product by the fast route's plan with crossover `n0` (see
    /// `nmod_mat/fast.rs`), whatever the allowance (tests and benchmarks
    /// only: it bypasses the admission).
    #[cfg(feature = "test-hooks")]
    pub fn mul_planned(&self, o: &Mat, n0: usize) -> Mat {
        assert_eq!(self.cols, o.rows);
        fast::mul_planned(self, o, n0)
    }

    /// The Winograd levels the plan with crossover `n0` runs (each fast
    /// product, its half products' included); `None` on overflow (tests
    /// and benchmarks).
    #[cfg(feature = "test-hooks")]
    pub fn planned_levels(m: usize, k: usize, n: usize, md: &Modulus, n0: usize) -> Option<u64> {
        match fast::plan(m, k, n, md, n0)?.0 {
            fast::Plan::Winograd => Mat::planned_levels(m / 2, k / 2, n / 2, md, n0)?.checked_mul(7)?.checked_add(1),
            fast::Plan::Classical => Some(0),
        }
    }

    /// self * o.  Classical ([`Mat::mul_classical`]) unless a caller has
    /// given this thread an allowance for the fast route's workspace
    /// ([`with_fast_product`]): then the fast route where its plan takes it
    /// and its extra words fit what is left of the allowance, which it
    /// holds while it runs.  Either way the same result, and the fast route
    /// never totals more units than the classical one.
    pub fn mul(&self, o: &Mat) -> Mat {
        assert_eq!(self.cols, o.rows);
        fast::mul(self, o)
    }

    /// The words the product of an m x k by a k x n matrix by the fast
    /// route's plan with crossover `n0` allocates at once at most (its result
    /// included); `None` on overflow (tests and benchmarks).
    #[cfg(feature = "test-hooks")]
    pub fn planned_peak(m: usize, k: usize, n: usize, md: &Modulus, n0: usize) -> Option<u64> {
        fast::plan(m, k, n, md, n0).map(|p| p.2)
    }

    /// self * o by the classical product: a row of sums of products at a
    /// time, in u64 sums where they cannot overflow, else in u128 sums
    /// against the transpose of o.
    pub fn mul_classical(&self, o: &Mat) -> Mat {
        assert_eq!(self.cols, o.rows);
        let m = self.m;
        let sq = (m.n as u128 - 1) * (m.n as u128 - 1);
        let batch = if sq == 0 { usize::MAX } else { (u128::MAX / sq).min(1 << 30) as usize };
        let mut c = Mat::zero(self.rows, o.cols, m);
        // a row: its products, and one reduction per chunk of each entry
        let mut step = [0; FAMILIES];
        step[Family::MulSchool as usize] = (o.cols * self.cols) as u64;
        step[Family::ModArith as usize] = (o.cols * self.cols.div_ceil(batch)) as u64;
        let mut poll = Poll::stepping(step);
        if self.cols <= batch64(&m) {
            // row i of C as one u64 sum per entry, row k of o times a_ik
            // (a reduction per entry, as one u128 batch: the same counts)
            let mut acc = vec![0u64; o.cols];
            for i in 0..self.rows {
                acc.iter_mut().for_each(|x| *x = 0);
                for (k, &f) in self.row(i).iter().enumerate() {
                    axpy32(&mut acc, o.row(k), f);
                }
                let pinv = u64::MAX / m.n;
                for (x, &a) in c.d[i * o.cols..(i + 1) * o.cols].iter_mut().zip(&acc) {
                    *x = reduce32(a, m.n, pinv);
                }
                poll.step();
                poll.add(o.cols * self.cols);
            }
            return c;
        }
        let bt = o.transpose();
        for i in 0..self.rows {
            let a = self.row(i);
            for j in 0..o.cols {
                let b = bt.row(j);
                let mut r = 0u64;
                for (ca, cb) in a.chunks(batch).zip(b.chunks(batch)) {
                    let mut acc = 0u128;
                    for (&x, &y) in ca.iter().zip(cb) {
                        acc += x as u128 * y as u128;
                    }
                    r = m.add(r, m.reduce_u128(acc));
                }
                c.d[i * o.cols + j] = r;
            }
            poll.step();
            poll.add(o.cols * self.cols);
        }
        c
    }

    /// self * v for a vector v (dot products summed in u128).
    pub fn mul_vec(&self, v: &[u64]) -> Vec<u64> {
        let m = self.m;
        let batch = batch_len(&m);
        let mut step = [0; FAMILIES];
        step[Family::MulSchool as usize] = self.cols as u64;
        step[Family::ModArith as usize] = self.cols.div_ceil(batch) as u64;
        let mut poll = Poll::stepping(step);
        (0..self.rows)
            .map(|i| {
                poll.add(self.cols);
                let mut r = 0u64;
                for (ca, cb) in self.row(i).chunks(batch).zip(v.chunks(batch)) {
                    let mut acc = 0u128;
                    for (&x, &y) in ca.iter().zip(cb) {
                        acc += x as u128 * y as u128;
                    }
                    r = m.add(r, m.reduce_u128(acc));
                }
                poll.step();
                r
            })
            .collect()
    }

    /// The characteristic polynomial det(x I - self), constant term first.
    /// By the Krylov sequence of a pseudo-random vector when it spans
    /// (then the minimal polynomial of the vector has degree n and is the
    /// characteristic polynomial: matrix-vector products and one
    /// elimination), else by Hessenberg reduction.
    pub fn charpoly(&self) -> Vec<u64> {
        assert_eq!(self.rows, self.cols);
        if let Some(c) = self.charpoly_krylov() {
            return c;
        }
        self.charpoly_hessenberg()
    }

    fn charpoly_krylov(&self) -> Option<Vec<u64>> {
        let n = self.rows;
        let m = self.m;
        if n == 0 || m.n < 1 << 20 {
            return None;
        }
        let mut seed = 0x9e3779b97f4a7c15u64 ^ m.n;
        let mut v: Vec<u64> = (0..n)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                m.reduce(seed)
            })
            .collect();
        // S has columns v, Av, ..., A^n v
        let mut s = Mat::zero(n, n + 1, m);
        let mut poll = Poll::new();
        poll.count(Family::ModArith, n as u64);
        poll.count(Family::Move, ((n + 1) * n) as u64);
        for i in 0..=n {
            for j in 0..n {
                s.d[j * (n + 1) + i] = v[j];
            }
            if i < n {
                v = self.mul_vec(&v);
            }
            poll.add(n * n);
        }
        let piv = s.rref();
        if piv.len() != n || piv[n - 1] != n - 1 {
            return None;
        }
        // A^n v = sum c_i A^i v: the charpoly is x^n - sum c_i x^i
        poll.count(Family::ModArith, n as u64);
        let mut c: Vec<u64> = (0..n).map(|i| m.neg(s.d[i * (n + 1) + n])).collect();
        c.push(1 % m.n);
        Some(c)
    }

    /// The characteristic polynomial by Hessenberg reduction.
    pub fn charpoly_hessenberg(&self) -> Vec<u64> {
        assert_eq!(self.rows, self.cols);
        let m = self.m;
        let n = self.rows;
        let mut h = self.copy();
        let mut poll = Poll::new();
        // Hessenberg form by similarity transformations
        for k in 1..n.saturating_sub(1) {
            // the pivot search
            poll.add(n);
            let Some(i) = (k..n).find(|&i| h.get(i, k - 1) != 0) else { continue };
            if i != k {
                h.swap_rows(i, k);
                poll.count(Family::Move, 4 * n as u64);
                for r in 0..n {
                    h.d.swap(r * n + i, r * n + k);
                }
            }
            let tinv = m.inv(h.get(k, k - 1)).expect("modulus not prime");
            poll.count(Family::ModArith, (n - k) as u64);
            // H <- L^-1 H L with L = I + sum_i u_i e_i e_k^T: the elementary
            // factors commute, so all the row operations, then column k +=
            // sum_i u_i column_i as one dot product per row
            let us: Vec<u64> = (k + 1..n).map(|i| m.mul(h.get(i, k - 1), tinv)).collect();
            for (t, &u) in us.iter().enumerate() {
                if u != 0 {
                    poll.add(n - k + 1);
                    poll.count(Family::ModArith, (n - k + 1) as u64);
                    let (dst, src) = h.rows2(k + 1 + t, k);
                    axpy(&mut dst[k - 1..], &src[k - 1..], m.neg(u), &m);
                }
            }
            if us.iter().any(|&u| u != 0) {
                poll.add(n * (n - k));
                let batch = batch_len(&m);
                poll.count(Family::MulSchool, (n * us.len()) as u64);
                poll.count(Family::ModArith, (n * us.len().div_ceil(batch)) as u64);
                for r in 0..n {
                    let row = &h.d[r * n + k + 1..(r + 1) * n];
                    let add = dot(row, &us, &m, batch);
                    h.d[r * n + k] = m.add(h.d[r * n + k], add);
                }
            }
        }
        // p_{k+1} = (x - h_kk) p_k - sum_i (prod_j h_{j,j-1}) h_{k-i,k} p_{k-i},
        // up to n^3 / 6 multiply-adds: polled by work too (daybreak
        // HARD-FE6-1: Stop went unobserved here for seconds)
        let mut p: Vec<Vec<u64>> = vec![vec![1 % m.n]];
        for k in 0..n {
            poll.add(k + 2);
            poll.count(Family::ModArith, p[k].len() as u64);
            let mut next = vec![0u64; k + 2];
            for (j, &c) in p[k].iter().enumerate() {
                next[j + 1] = m.add(next[j + 1], c);
                next[j] = m.sub(next[j], m.mul(h.get(k, k), c));
            }
            let mut t = 1 % m.n;
            // the terms f p_{k-i}: where the modulus' sums fold (as the
            // elimination's), summed in u64 per coefficient (folded every
            // fold64 terms past the first batch64), one reduction per
            // coefficient at the end; else each product reduced.  Counted
            // as each product reduced (one ModArith per coefficient of
            // each term), the same units whatever the sums.
            let mut acc = Sums::new(&m, k + 2);
            for i in 1..=k {
                poll.add(1);
                t = m.mul(t, h.get(k - i + 1, k - i));
                if t == 0 {
                    poll.count(Family::ModArith, 1);
                    break;
                }
                let f = m.mul(t, h.get(k - i, k));
                poll.count(Family::ModArith, 2);
                if f != 0 {
                    poll.add(p[k - i].len());
                    poll.count(Family::ModArith, p[k - i].len() as u64);
                    match acc.as_mut() {
                        Some(a) => a.add_scaled(f, &p[k - i]),
                        None => {
                            for (j, &c) in p[k - i].iter().enumerate() {
                                next[j] = m.sub(next[j], m.mul(f, c));
                            }
                        }
                    }
                }
            }
            if let Some(a) = acc {
                a.subtract_from(&mut next);
            }
            p.push(next);
        }
        p.pop().unwrap()
    }
}

/// Whether the permutation p of 0..n is odd.
fn perm_sign(p: &[usize]) -> bool {
    let mut seen = vec![false; p.len()];
    let mut odd = false;
    for i in 0..p.len() {
        if seen[i] {
            continue;
        }
        let mut j = i;
        let mut len = 0;
        while !seen[j] {
            seen[j] = true;
            j = p[j];
            len += 1;
        }
        odd ^= len % 2 == 0;
    }
    odd
}

/// Whether the distinct values v have an odd number of inversions (pairs
/// out of increasing order): the parity of the permutation that sorts them.
fn inversions_odd(v: &[usize]) -> bool {
    let mut odd = false;
    for (i, &x) in v.iter().enumerate() {
        for &y in &v[i + 1..] {
            odd ^= x > y;
        }
    }
    odd
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The delayed reductions' block: batch_len products of residues sum in
    /// a u128 without overflow, and one more could overflow (or the block is
    /// capped at 2^30), at every bit length of p up to nmod's largest
    /// (modular composition's matrix product relies on it).
    #[test]
    fn the_accumulation_block_fits_a_u128() {
        for p in [2u64, 3, 65537, (1 << 32) - 5, (1 << 40) + 15, (1 << 62) - 57, (1 << 63) + 29, u64::MAX - 58] {
            let m = Modulus::new(p);
            let b = batch_len(&m) as u128;
            let sq = (p as u128 - 1) * (p as u128 - 1);
            assert!(b >= 1 && b.checked_mul(sq).is_some(), "p {}", p);
            assert!(b == 1 << 30 || (b + 1).checked_mul(sq).is_none(), "p {}", p);
        }
    }

    /// The Poll flushes its accumulator when it drops while unwinding (a
    /// panic, or a Stop raised outside its own poll).
    #[test]
    fn a_poll_flushes_when_unwinding() {
        use crate::cost::{tallied, Family};
        let before = tallied();
        let r = std::panic::catch_unwind(|| {
            let mut poll = Poll::new();
            poll.count(Family::MulSchool, 1000);
            poll.count(Family::Move, 7);
            panic!("mid-kernel");
        });
        assert!(r.is_err());
        let now = tallied();
        assert_eq!(now.get(Family::MulSchool).wrapping_sub(before.get(Family::MulSchool)), 1000);
        assert_eq!(now.get(Family::Move).wrapping_sub(before.get(Family::Move)), 7);
    }

    /// rref_rows: the reduced form of rref, its pivot rows S in increasing
    /// order, and det A[S, P], against the determinant computed directly;
    /// with zeros that make the elimination swap rows (and so take rows out
    /// of order) and with dependent rows.
    #[test]
    fn rref_rows_gives_the_pivot_minor() {
        let m = Modulus::new(1_000_003);
        let mut s = 0x1234_5678_9abc_def1u64;
        for case in 0..60 {
            let (r, c) = (1 + (case % 9), 1 + (case * 7 % 11));
            let mut a = rand_mat(r, c, m, &mut s);
            for i in 0..r {
                for j in 0..c {
                    if rng(&mut s) % 3 == 0 {
                        a.d[i * c + j] = 0;
                    }
                }
            }
            if r > 2 && case % 2 == 0 {
                // a dependent row: row 1 = 2 row 0
                for j in 0..c {
                    a.d[c + j] = m.add(a.d[j], a.d[j]);
                }
            }
            let mut x = a.clone();
            let piv0 = x.clone().rref();
            let (piv, rows, d) = x.rref_rows();
            assert_eq!(piv, piv0);
            assert_eq!(x.d, { let mut y = a.clone(); y.rref(); y.d }, "case {case}: not rref's form");
            assert_eq!(rows.len(), piv.len());
            assert!(rows.windows(2).all(|w| w[0] < w[1]));
            let k = piv.len();
            let sub: Vec<Vec<u64>> = rows.iter().map(|&i| piv.iter().map(|&j| a.get(i, j)).collect()).collect();
            if k > 0 {
                assert_eq!(d, Mat::from_rows(&sub, m).det(), "case {case}: rows {rows:?}");
            }
        }
    }

    /// The same for more than 16 and more than 32 pivots: n rows in
    /// staircase form (row i zero left of column i, nonzero there) and some
    /// combinations of them, in shuffled order (eight shuffles of each), so
    /// that each column's pivot row lies anywhere and the elimination takes
    /// the pivot rows far out of order.
    #[test]
    fn rref_rows_gives_the_pivot_minor_past_16_and_32_pivots() {
        let m = Modulus::new(1_000_003);
        let mut s = 0x0fed_cba9_8765_4321u64;
        for case in 0..40 {
            let (n, deps, c) = [(20usize, 6usize, 30usize), (19, 8, 20), (38, 12, 55), (38, 14, 40), (40, 0, 40)][case % 5];
            let mut rows: Vec<Vec<u64>> = (0..n)
                .map(|i| (0..c).map(|j| if j < i { 0 } else if j == i { 1 + rng(&mut s) % (m.n - 1) } else { rng(&mut s) % m.n }).collect())
                .collect();
            for _ in 0..deps {
                let (a, b) = ((rng(&mut s) % n as u64) as usize, (rng(&mut s) % n as u64) as usize);
                let row = (0..c).map(|j| m.add(rows[a][j], m.mul(3, rows[b][j]))).collect();
                rows.push(row);
            }
            for i in (1..rows.len()).rev() {
                rows.swap(i, (rng(&mut s) % (i as u64 + 1)) as usize);
            }
            let a = Mat::from_rows(&rows, m);
            let mut x = a.clone();
            let piv0 = x.clone().rref();
            let (piv, srows, d) = x.rref_rows();
            assert_eq!(piv, piv0);
            assert_eq!(piv, (0..n).collect::<Vec<_>>());
            assert_eq!(x.d, { let mut y = a.clone(); y.rref(); y.d }, "{n} rows: not rref's form");
            assert_eq!(srows.len(), n);
            assert!(srows.windows(2).all(|w| w[0] < w[1]));
            let sub: Vec<Vec<u64>> = srows.iter().map(|&i| piv.iter().map(|&j| a.get(i, j)).collect()).collect();
            assert_eq!(d, Mat::from_rows(&sub, m).det(), "{n} rows: rows {srows:?}");
        }
    }

    /// For engine/hmf/tests/wasm-stop.mjs (the Stop button in wasm,
    /// daybreak HARD-FE6-1): the characteristic polynomial of a 1252 x 1252
    /// upper Hessenberg matrix of ones modulo 65537 (no reduction, then
    /// seconds of recurrence), which must notice a Stop pressed during the
    /// recurrence and trap.
    #[test]
    #[ignore]
    fn stop_hessenberg_recurrence() {
        let md = Modulus::new(65537);
        let n = 1252;
        let rows: Vec<Vec<u64>> = (0..n).map(|i| (0..n).map(|j| if j + 1 >= i { 1 } else { 0 }).collect()).collect();
        let c = Mat::from_rows(&rows, md).charpoly_hessenberg();
        println!("not interrupted: {}", c.len());
    }

    fn rng(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    fn rand_mat(r: usize, c: usize, m: Modulus, s: &mut u64) -> Mat {
        Mat { rows: r, cols: c, m, d: (0..r * c).map(|_| rng(s) % m.n).collect() }
    }

    #[test]
    fn inverse_det_charpoly() {
        let mut s = 5u64;
        for p in [2u64, 7, 1_000_000_007, (1 << 62) - 57, 18446744073709551557] {
            let m = Modulus::new(p);
            for n in [1usize, 2, 5, 17, 40] {
                let a = rand_mat(n, n, m, &mut s);
                let d = a.det();
                match a.inverse() {
                    Some(ai) => {
                        assert_ne!(d, 0);
                        assert_eq!(a.mul(&ai), Mat::identity(n, m));
                    }
                    None => assert_eq!(d, 0),
                }
                // det(AB) = det A det B
                let b = rand_mat(n, n, m, &mut s);
                assert_eq!(a.mul(&b).det(), m.mul(d, b.det()));
                // charpoly: constant term (-1)^n det, trace, and Cayley-Hamilton
                let cp = a.charpoly();
                assert_eq!(cp, a.charpoly_hessenberg(), "Krylov and Hessenberg agree p={p} n={n}");
                assert_eq!(cp.len(), n + 1);
                assert_eq!(cp[0], if n % 2 == 0 { d } else { m.neg(d) });
                let tr = (0..n).fold(0, |t, i| m.add(t, a.get(i, i)));
                assert_eq!(cp[n - 1], m.neg(tr));
                let mut acc = Mat::zero(n, n, m);
                for &c in cp.iter().rev() {
                    acc = acc.mul(&a);
                    for i in 0..n {
                        acc.d[i * n + i] = m.add(acc.d[i * n + i], c);
                    }
                }
                assert_eq!(acc, Mat::zero(n, n, m), "Cayley-Hamilton p={p} n={n}");
            }
        }
    }

    #[test]
    fn lu_solves() {
        let mut s = 77u64;
        for p in [7u64, 1_000_000_007, (1 << 62) - 57] {
            let m = Modulus::new(p);
            for n in [1usize, 2, 17, 40, 70] {
                let a = rand_mat(n, n, m, &mut s);
                let b: Vec<u64> = (0..n).map(|_| rng(&mut s) % p).collect();
                match a.lu() {
                    None => assert_eq!(a.det(), 0),
                    Some(lu) => {
                        let x = lu.solve_vec(&b);
                        assert_eq!(a.mul_vec(&x), b, "p={p} n={n}");
                    }
                }
            }
        }
    }

    #[test]
    fn charpoly_derogatory() {
        // the identity, a diagonal matrix with repeats and a Jordan-like
        // block: the Krylov space is too small and Hessenberg takes over
        let m = Modulus::new((1 << 62) - 57);
        for n in [1usize, 3, 10] {
            let id = Mat::identity(n, m);
            let mut want = vec![1u64];
            for _ in 0..n {
                want = crate::nmod_poly::mul(&want, &[m.neg(1), 1], &m);
            }
            assert_eq!(id.charpoly(), want);
        }
        let mut d = Mat::zero(6, 6, m);
        for (i, x) in [2u64, 2, 3, 3, 3, 5].iter().enumerate() {
            d.d[i * 6 + i] = *x;
        }
        assert_eq!(d.charpoly(), d.charpoly_hessenberg());
    }

    #[test]
    fn rank_and_nullspace() {
        let mut s = 8u64;
        let m = Modulus::new(1_000_000_007);
        // rank 3 product of 6x3 and 3x8
        let a = rand_mat(6, 3, m, &mut s).mul(&rand_mat(3, 8, m, &mut s));
        assert_eq!(a.rank(), 3);
        let k = a.nullspace();
        assert_eq!(k.rows, 5);
        assert_eq!(a.mul(&k.transpose()), Mat::zero(6, 5, m));
        let mut r = a.clone();
        let piv = r.rref();
        assert_eq!(piv, vec![0, 1, 2]);
        for i in 3..6 {
            assert!(r.row(i).iter().all(|&x| x == 0));
        }
    }

    /// The largest prime whose fold64 is at least k (k <= 16): by bisection
    /// on the monotone fold64, then the previous prime.
    fn last_folding(k: usize) -> u64 {
        use crate::nmod::prev_prime;
        let (mut lo, mut hi) = (3u64, 1u64 << 32);
        while hi - lo > 1 {
            let mid = lo + (hi - lo) / 2;
            if fold64(&Modulus::new(mid)) >= k {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        prev_prime(lo + 1)
    }

    /// The least prime above n.
    fn next_prime(n: u64) -> u64 {
        (n + 1..).find(|&x| crate::nmod::is_prime(x)).unwrap()
    }

    /// Gauss-Jordan elimination entry by entry with the modulus' own
    /// operations: the reduced form, the pivots and the determinant.
    fn reference_echelon(a: &Mat) -> (Mat, Vec<usize>, u64) {
        let m = a.m;
        let mut e = a.clone();
        let (mut piv, mut det, mut r) = (vec![], 1 % m.n, 0);
        for c in 0..e.cols {
            let Some(pr) = (r..e.rows).find(|&i| e.get(i, c) != 0) else { continue };
            if pr != r {
                for j in 0..e.cols {
                    let (x, y) = (e.get(r, j), e.get(pr, j));
                    e.set(r, j, y);
                    e.set(pr, j, x);
                }
                det = m.neg(det);
            }
            let pv = e.get(r, c);
            det = m.mul(det, pv);
            let inv = m.inv(pv).unwrap();
            for j in 0..e.cols {
                let v = m.mul(e.get(r, j), inv);
                e.set(r, j, v);
            }
            for i in 0..e.rows {
                let f = e.get(i, c);
                if i != r && f != 0 {
                    for j in 0..e.cols {
                        let v = m.sub(e.get(i, j), m.mul(f, e.get(r, j)));
                        e.set(i, j, v);
                    }
                }
            }
            piv.push(c);
            r += 1;
            if r == e.rows {
                break;
            }
        }
        if r < e.rows || e.rows != e.cols {
            det = 0;
        }
        (e, piv, det)
    }

    /// fold64: b products added to a residue fit a u64 sum and b + 1 may
    /// not, at least 1 below 2^32, 0 above; and the primes where it steps.
    #[test]
    fn the_fold_fits_a_u64() {
        // (the measured FOLD_MIN = 2: fold64 = 15 and 4 fold, fold64 = 1
        // doesn't, nor does any modulus above 2^32)
        assert_eq!(FOLD_MIN, 2);
        assert!(folding(&Modulus::new((1 << 30) + 3)) && folding(&Modulus::new((1 << 31) - 1)));
        assert!(!folding(&Modulus::new(3 * (1 << 30) + 1)) && !folding(&Modulus::new((1 << 32) - 5)));
        assert!(!folding(&Modulus::new((1 << 32) + 15)));
        for p in [3u64, 65537, (1 << 30) + 3, (1 << 31) - 1, 3 * (1 << 30) + 1, (1 << 32) - 5, last_folding(2), last_folding(16)] {
            let m = Modulus::new(p);
            let (b, q) = (fold64(&m) as u128, p as u128 - 1);
            assert!(b >= 1 && b * q * q + q <= u64::MAX as u128, "p {}", p);
            assert!(b == 1 << 30 || (b + 1) * q * q + q > u64::MAX as u128, "p {}", p);
            assert!(fold64(&m) <= batch64(&m).max(1), "p {}", p);
        }
        assert_eq!(fold64(&Modulus::new((1 << 32) + 15)), 0);
        for k in 2..=16 {
            let p = last_folding(k);
            assert!(fold64(&Modulus::new(p)) >= k && fold64(&Modulus::new(next_prime(p))) < k, "k {}", k);
        }
    }

    /// update_row (on the u64 route where it applies), against the sums in
    /// u128, for blocks of fold64, fold64 + 1, 2 fold64 + 1, 16 and 32
    /// factors, with entries p - 1 - {0, 1, 2} (the largest products) and
    /// random ones, some factors zero; and the reductions it counts, the
    /// u128 route's (one row's per batch, whatever the folds).
    #[test]
    fn update_row_folds_exactly() {
        use crate::cost::{tallied, Family};
        let mut s = 29u64;
        let ps = [(1u64 << 30) + 3, (1 << 31) - 1, 3 * (1 << 30) + 1, (1 << 32) - 5];
        for p in ps {
            let m = Modulus::new(p);
            let bf = fold64(&m);
            for k in [bf, bf + 1, 2 * bf + 1, 16, 32] {
                for big in [true, false] {
                    let len = 50;
                    let ent = |s: &mut u64| if big { p - 1 - rng(s) % 3 } else { rng(s) % p };
                    let srcs: Vec<Vec<u64>> = (0..k).map(|_| (0..len).map(|_| ent(&mut s)).collect()).collect();
                    let mut row: Vec<u64> = (0..len).map(|_| ent(&mut s)).collect();
                    // (the factors in columns len - k.. of the row, a few zero)
                    let from = 0;
                    let blk: Vec<usize> = (0..k).map(|t| t).collect();
                    let mut fac: Vec<u64> = (0..k).map(|_| ent(&mut s)).collect();
                    if !big {
                        fac[0] = 0;
                    }
                    let want: Vec<u64> = (0..len)
                        .map(|j| {
                            let t = (0..k).fold(0u128, |a, t| (a + fac[t] as u128 * srcs[t][j] as u128) % p as u128) as u64;
                            m.sub(row[j], t)
                        })
                        .collect();
                    // (update_row reads the factors from the row's block columns)
                    let mut full: Vec<u64> = fac.clone();
                    full.extend_from_slice(&row);
                    let srcs_full: Vec<Vec<u64>> = srcs.iter().map(|r| { let mut v = vec![0; k]; v.extend_from_slice(r); v }).collect();
                    let mut acc = Acc::new(k + len);
                    let before = tallied().get(Family::ModArith);
                    {
                        let mut poll = Poll::new();
                        update_row(&mut full, k + from, &blk, |t| &srcs_full[t][..], &m, batch_len(&m), &mut acc, &mut poll);
                    }
                    let counted = tallied().get(Family::ModArith).wrapping_sub(before);
                    row = full[k..].to_vec();
                    assert_eq!(row, want, "p {} k {} big {}", p, k, big);
                    let nz = fac.iter().filter(|&&f| f != 0).count();
                    // (normalized: the u128 route's reductions, one per batch,
                    // whatever the folds; the raw folds a diagnostic)
                    let want_red = nz / batch_len(&m) + 1;
                    assert_eq!(counted as usize, len * want_red, "p {} k {} big {}", p, k, big);
                }
            }
        }
    }

    /// The counted units (normalized, see u64_route): per family, the
    /// folding elimination counts exactly what the route before folding
    /// (the u128 sums past batch64, the same blocks) counts, and gives the
    /// same results; and it does fold (the raw fold count, a diagnostic).
    /// At folding primes and at primes that don't fold (below 2^30, the
    /// fold64 = 1 ones, above 2^32); dense, sparse, zero-row, rank-deficient,
    /// square, wide and tall.
    #[test]
    fn folding_counts_the_same_units() {
        use crate::cost::{metered, Family, Meter};
        let run = |a: &Mat, no_fold: bool| {
            test_hooks::set_no_fold(no_fold);
            test_hooks::reset_folds();
            let mut meter = Meter::accounting(u64::MAX);
            let mut e = a.clone();
            let r = metered(&mut meter, || e.echelon(true, true));
            let folded = test_hooks::folds_done();
            test_hooks::set_no_fold(false);
            assert_eq!(meter.units().total(), Some(meter.used()));
            let u: Vec<u64> = [Family::MulSchool, Family::ModArith, Family::Move].iter().map(|&f| meter.units().get(f)).collect();
            (e, r, u, folded)
        };
        let mut s = 41u64;
        for p in [65537u64, 1_000_000_007, (1 << 30) + 3, (1 << 31) - 1, (1 << 32) - 5, (1 << 32) + 15] {
            let m = Modulus::new(p);
            for (r, c) in [(48usize, 48usize), (32, 96), (40, 90), (90, 40), (120, 120)] {
                let dense = rand_mat(r, c, m, &mut s);
                let mut sparse = dense.clone();
                for (k, x) in sparse.d.iter_mut().enumerate() {
                    if k % 5 != 0 {
                        *x = 0;
                    }
                }
                let mut zero_rows = dense.clone();
                for i in (0..r).step_by(3) {
                    for j in 0..c {
                        zero_rows.set(i, j, 0);
                    }
                }
                let mut low = dense.clone();
                for i in r / 3..r {
                    for j in 0..c {
                        let v = m.add(low.get(i % (r / 3), j), low.get(i - 1, j));
                        low.set(i, j, v);
                    }
                }
                for (name, a) in [("dense", dense), ("sparse", sparse), ("zero rows", zero_rows), ("low rank", low)] {
                    let new = run(&a, false);
                    let old = run(&a, true);
                    assert_eq!((&new.0, &new.1), (&old.0, &old.1), "results p {} {}x{} {}", p, r, c, name);
                    assert_eq!(new.2, old.2, "units p {} {}x{} {}", p, r, c, name);
                    assert_eq!(old.3, 0, "no folds without folding");
                    // (a 16-pivot block folds at these primes once a row has
                    // more nonzero factors than batch64: dense ones do)
                    if folding(&m) && batch64(&m) < 16 && name == "dense" {
                        assert!(new.3 > 0, "folded, p {} {}x{}", p, r, c);
                    }
                    if !folding(&m) {
                        assert_eq!(new.3, 0, "nothing folds, p {}", p);
                    }
                }
            }
        }
    }

    /// The characteristic polynomial's u64 sums at their headroom: dot,
    /// Sums and axpy with every operand p - 1 (each product the largest), at
    /// lengths batch64, batch64 + 1, batch64 + fold64, batch64 + fold64 + 1
    /// and three folds past them, against u128 arithmetic; at fold64 = 4
    /// and 15, and at a prime whose whole sum fits.
    #[test]
    fn charpoly_sums_at_their_headroom() {
        for p in [(1u64 << 31) - 1, (1 << 30) + 3, 65537] {
            let m = Modulus::new(p);
            let (b, f) = (batch64(&m), fold64(&m));
            let q = p - 1;
            let want = |len: usize| ((len as u128 * (q as u128 * q as u128)) % p as u128) as u64;
            let lens: Vec<usize> = if b > 1 << 20 { vec![1, 2, 1000] } else { vec![b, b + 1, b + f, b + f + 1, b + 3 * f + 1] };
            for len in lens {
                let a = vec![q; len];
                assert_eq!(dot(&a, &a, &m, batch_len(&m)), want(len), "dot p {} len {}", p, len);
                // (Sums: len rows of p - 1, each scaled by p - 1, subtracted from 0)
                if let Some(mut s) = Sums::new(&m, 3) {
                    for _ in 0..len {
                        s.add_scaled(q, &[q, q, q]);
                    }
                    let mut next = vec![0u64; 3];
                    s.subtract_from(&mut next);
                    assert_eq!(next, vec![(p - want(len)) % p; 3], "Sums p {} len {}", p, len);
                }
            }
            // axpy: x + c y at the largest operands
            let mut x = vec![q; 5];
            axpy(&mut x, &[q; 5], q, &m);
            assert_eq!(x, vec![((q as u128 + q as u128 * q as u128) % p as u128) as u64; 5], "axpy p {}", p);
        }
    }

    /// The characteristic polynomial (Hessenberg) with its u64 sums against
    /// the same computation with every product reduced (the route before
    /// them): the same polynomial and exactly the same units, family by
    /// family, at primes of every class (tiny, small, folding, fold64 = 1,
    /// above 2^32), on random, sparse, zero, low-rank and all-(p - 1)
    /// matrices.
    #[test]
    fn charpoly_sums_change_neither_the_result_nor_the_units() {
        use crate::cost::{metered, Family, Meter};
        let run = |a: &Mat, plain: bool| {
            test_hooks::set_plain_sums(plain);
            let mut meter = Meter::accounting(u64::MAX);
            let c = metered(&mut meter, || a.charpoly_hessenberg());
            test_hooks::set_plain_sums(false);
            assert_eq!(meter.units().total(), Some(meter.used()));
            (c, [Family::MulSchool, Family::ModArith, Family::Move].map(|f| meter.units().get(f)))
        };
        let mut s = 77u64;
        for p in [3u64, 7, 65537, 1_000_000_007, (1 << 31) - 1, (1 << 32) - 5, (1 << 62) - 57] {
            let m = Modulus::new(p);
            for n in [1usize, 2, 9, 40, 73] {
                let dense = rand_mat(n, n, m, &mut s);
                let mut sparse = dense.clone();
                for (k, x) in sparse.d.iter_mut().enumerate() {
                    if k % 4 != 0 {
                        *x = 0;
                    }
                }
                let mut low = dense.clone();
                for i in n / 2..n {
                    for j in 0..n {
                        let v = m.add(low.get(i - n / 2, j), low.get(i.saturating_sub(1), j));
                        low.set(i, j, v);
                    }
                }
                let full = Mat { rows: n, cols: n, m, d: vec![p - 1; n * n] };
                for (name, a) in [("dense", dense), ("sparse", sparse), ("low", low), ("p-1", full), ("zero", Mat::zero(n, n, m)), ("identity", Mat::identity(n, m))] {
                    let new = run(&a, false);
                    let old = run(&a, true);
                    assert_eq!(new, old, "p {} n {} {}", p, n, name);
                }
            }
        }
    }

    /// The folding u64 route against the reference elimination, exactly,
    /// at the primes where fold64 steps (each side of 1..=16) and below
    /// 2^32: random, low-rank, all-(p - 1) and sparse matrices, wide enough
    /// that the blocks of 16 pivots fold.
    #[test]
    fn folded_sums_match_the_reference() {
        let mut s = 17u64;
        let mut ps = vec![(1u64 << 32) - 5, (1 << 31) - 1, (1 << 30) + 3];
        for k in [1, 2, 3, 4, 8, 15, 16] {
            let p = last_folding(k);
            ps.push(p);
            ps.push(next_prime(p));
        }
        for p in ps {
            let m = Modulus::new(p);
            assert_eq!(u64_route(&m, 16), p <= last_folding(FOLD_MIN), "p {}", p);
            for (r, c) in [(40usize, 40usize), (33, 70), (70, 33)] {
                let rand = rand_mat(r, c, m, &mut s);
                let mut low = rand.clone();
                for i in r / 2..r {
                    for j in 0..c {
                        let v = m.add(low.get(i - r / 2, j), m.mul(low.get(i - 1, j), p - 1));
                        low.set(i, j, v);
                    }
                }
                let full = Mat { rows: r, cols: c, m, d: vec![p - 1; r * c] };
                let mut sparse = rand.clone();
                for (k, x) in sparse.d.iter_mut().enumerate() {
                    if k % 3 != 0 {
                        *x = 0;
                    }
                }
                for a in [rand, low, full, sparse] {
                    let (want, wpiv, wdet) = reference_echelon(&a);
                    let mut e = a.clone();
                    let (piv, det) = e.echelon(true, true);
                    assert_eq!((&e, &piv), (&want, &wpiv), "p {} {}x{}", p, r, c);
                    // (echelon's factor is the determinant at full rank)
                    if r == c && piv.len() == r {
                        assert_eq!(det, wdet, "det p {} {}x{}", p, r, c);
                    }
                    if r == c {
                        assert_eq!(a.det(), wdet, "det() p {} {}x{}", p, r, c);
                    }
                }
            }
        }
    }

    /// The u64 sums at their edges: primes on both sides of block 32
    /// (batch64 >= 32), of the whole-block u64 row updates (batch64 >= 16)
    /// and of 32-bit residues, products whose inner length is batch64 (the
    /// largest u64 sum) or one more (the u128 route), all of p - 1, and
    /// the two routes of solve.
    #[test]
    fn small_modulus_sums_at_their_edges() {
        use crate::nmod::prev_prime;
        let mut s = 31u64;
        let b32 = prev_prime(759_250_126);
        let ps = [65537, b32, prev_prime(b32 + 2000), prev_prime((1 << 30) + 2), prev_prime(1 << 30), prev_prime(1 << 32), (1 << 32) + 15];
        for p in ps {
            let m = Modulus::new(p);
            let b = batch64(&m);
            // (the thresholds fall where the names say)
            assert_eq!(block_of(&m) == 32, p <= b32, "p={p}");
            assert_eq!(b >= 16, p <= (1 << 30) + 1, "p={p}");
            assert_eq!(b == 0, p > 1 << 32, "p={p}");
            for k in [b.min(64), b.min(64) + 1] {
                let full = |r, c| Mat { rows: r, cols: c, m, d: vec![p - 1; r * c] };
                // (p - 1)^2 k mod p = k
                let want = Mat { rows: 3, cols: 5, m, d: vec![k as u64 % p; 15] };
                assert_eq!(full(3, k).mul(&full(k, 5)), want, "p={p} k={k}");
                let (x, y) = (rand_mat(4, k, m, &mut s), rand_mat(k, 6, m, &mut s));
                let c = x.mul(&y);
                for i in 0..4 {
                    for j in 0..6 {
                        let e = (0..k).fold(0u128, |t, l| (t + x.get(i, l) as u128 * y.get(l, j) as u128) % p as u128);
                        assert_eq!(c.get(i, j) as u128, e, "p={p} k={k}");
                    }
                }
            }
            for n in [1usize, 33, 70] {
                let a = rand_mat(n, n, m, &mut s);
                // rank n - 5 (n > 5): rows past n - 5 sums of earlier ones
                let mut low = a.clone();
                if n > 5 {
                    for i in n - 5..n {
                        for j in 0..n {
                            let v = m.add(low.get(i - (n - 5), j), low.get(i - 1, j));
                            low.set(i, j, v);
                        }
                    }
                    assert_eq!(low.rank(), n - 5, "p={p} n={n}");
                    assert_eq!(low.det(), 0);
                    assert!(low.solve(&rand_mat(n, 2, m, &mut s)).is_none());
                }
                let few = rand_mat(n, SOLVE_LU_COLS, m, &mut s);
                let many = rand_mat(n, SOLVE_LU_COLS + 1, m, &mut s);
                match (a.solve(&few), a.solve(&many)) {
                    (Some(x), Some(y)) => {
                        assert_eq!(a.mul(&x), few, "LU route p={p} n={n}");
                        assert_eq!(a.mul(&y), many, "echelon route p={p} n={n}");
                    }
                    (None, None) => assert_eq!(a.det(), 0),
                    _ => panic!("the routes disagree on singularity p={p} n={n}"),
                }
            }
        }
    }
}

#[cfg(test)]
mod echelon_units_twin {
    use super::*;
    use crate::cost::tallied;
    use crate::nmod::Primes;

    /// The data-free count equals the echelon's own tally, every family,
    /// on [a | I] modulo a 62-bit prime with dense residues, n = 1..128.
    #[test]
    fn the_twin_counts_what_echelon_charges() {
        let p = Primes::new().next().unwrap();
        let m = Modulus::new(p);
        let mut s: u64 = 0x9e3779b97f4a7c15;
        let mut compared = 0;
        for n in 1..=128usize {
            let rows: Vec<Vec<u64>> = (0..n)
                .map(|_| {
                    (0..n)
                        .map(|_| {
                            s ^= s << 13;
                            s ^= s >> 7;
                            s ^= s << 17;
                            1 + s % (p - 1)
                        })
                        .collect()
                })
                .collect();
            let mut aug = Mat::from_rows(&rows, m).augment(&Mat::identity(n, m));
            let before = tallied();
            let (piv, _) = aug.echelon(true, true);
            let after = tallied();
            // (the residues are nonzero, but the block may still be singular
            // modulo p: such an n is skipped and counted)
            if piv.len() < n || piv[n - 1] != n - 1 {
                continue;
            }
            compared += 1;
            let got: Vec<u64> = (0..FAMILIES).map(|i| after.0[i].wrapping_sub(before.0[i])).collect();
            let want = echelon_units_dense(n, 2 * n, batch_of(&m), block_of(&m));
            assert_eq!(got, want.to_vec(), "n = {n}");
        }
        assert_eq!(compared, 128, "every n compared");
    }
}
