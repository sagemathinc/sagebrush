//! The product's fast route (Winograd's form of Strassen's product) and the
//! gate that decides, before any work, whether it is taken.
//!
//! The gate: the fast route's counted units, as the meter totals them, must
//! be at most the classical product's ([`Mat::mul`]) for the same shape,
//! exactly.  Both sides are computed here in checked integer arithmetic from
//! the shape and the modulus alone; an overflow means no fast route.  The
//! fast route charges every unit it does: each base product and peeling
//! strip as the classical product of its own shape, the block additions and
//! subtractions as ModArith, and every copy (the quadrants taken out of the
//! factors, the strips, the result written into place) as Move.  So a
//! product never charges more than the classical product would.

use super::{batch64, batch_len, Carrying, Mat, Poll};
use crate::cost::{Family, Units, FAMILIES};
use crate::nmod::Modulus;
use std::cell::Cell;

/// The units [`Mat::mul_classical`] counts for an m x k by k x n product: its products
/// (MulSchool), one reduction per started batch of each entry (ModArith),
/// the result's zero fill and, on its u128 branch, the transpose of the
/// right factor (its own zero fill and its copy) (Move); `None` on overflow.
pub(super) fn classical_units(m: usize, k: usize, n: usize, md: &Modulus) -> Option<Units> {
    let (m, k, n) = (m as u64, k as u64, n as u64);
    let mut u = [0u64; FAMILIES];
    u[Family::MulSchool as usize] = m.checked_mul(k)?.checked_mul(n)?;
    let batch = batch_len(md) as u64;
    u[Family::ModArith as usize] = m.checked_mul(n)?.checked_mul(k.div_ceil(batch))?;
    let mut mv = m.checked_mul(n)?;
    if k > batch64(md) as u64 {
        mv = mv.checked_add(k.checked_mul(n)?.checked_mul(2)?)?;
    }
    u[Family::Move as usize] = mv;
    Some(Units(u))
}

#[cfg(test)]
pub(super) mod test_hooks {
    use std::cell::Cell;
    thread_local! {
        static FORCE: Cell<bool> = const { Cell::new(false) };
        static LEVELS: Cell<u64> = const { Cell::new(0) };
    }
    /// Take the fast route wherever the shape allows it, whatever the gate
    /// says (to test the kernel's own counts on small shapes).
    pub fn set_force(on: bool) {
        FORCE.with(|f| f.set(on));
    }
    pub(in super::super) fn forced() -> bool {
        FORCE.with(|f| f.get())
    }
    /// The Winograd levels run on this thread since the last reset.
    pub fn levels() -> u64 {
        LEVELS.with(|l| l.get())
    }
    pub fn reset_levels() {
        LEVELS.with(|l| l.set(0));
    }
    pub(in super::super) fn level() {
        LEVELS.with(|l| l.set(l.get() + 1));
    }
}

#[cfg(test)]
fn forced() -> bool {
    test_hooks::forced()
}
#[cfg(not(test))]
fn forced() -> bool {
    false
}

fn plus(a: Units, b: Units) -> Option<Units> {
    let mut u = a.0;
    for (x, y) in u.iter_mut().zip(b.0) {
        *x = x.checked_add(y)?;
    }
    Some(Units(u))
}

fn times(a: Units, c: u64) -> Option<Units> {
    let mut u = a.0;
    for x in u.iter_mut() {
        *x = x.checked_mul(c)?;
    }
    Some(Units(u))
}

fn family(f: Family, n: u64) -> Units {
    let mut u = [0u64; FAMILIES];
    u[f as usize] = n;
    Units(u)
}

/// How an m x k by k x n product is done: classical, or one Winograd level
/// over the even core (its seven half products each planned the same way)
/// with the odd row, column and inner index done as classical strips.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Plan {
    Classical,
    Winograd,
}

/// The units of one Winograd level over an m x k by k x n product whose
/// half products cost `half` each, as [`winograd`] counts them:
/// - the quadrants of the even cores of A and B taken out (Move);
/// - the eight additions and subtractions on them and the seven on the
///   half products (ModArith), and the seven half products;
/// - the core of C written into the result (Move);
/// - for odd k: the rank-1 term of A's last column and B's last row over
///   the core, each entry a product (MulSchool), its reduction and its
///   addition (ModArith);
/// - for odd m: A's last row taken out (Move), its classical (1, k, n)
///   product, written into the result's last row (Move);
/// - for odd n: B's last column taken out (Move), the classical (m, k, 1)
///   product of A by it (its last entry, the corner, is the last row's
///   too), its first m' entries written into the result (Move).
fn winograd_units(m: usize, k: usize, n: usize, half: Units, md: &Modulus) -> Option<Units> {
    let (me, ke, ne) = ((m - m % 2) as u64, (k - k % 2) as u64, (n - n % 2) as u64);
    let (hm, hk, hn) = (me / 2, ke / 2, ne / 2);
    let (k64, n64) = (k as u64, n as u64);
    let quads = (4 * hm).checked_mul(hk)?.checked_add((4 * hk).checked_mul(hn)?)?;
    let adds = quads.checked_add((7 * hm).checked_mul(hn)?)?;
    let mut u = plus(times(half, 7)?, family(Family::ModArith, adds))?;
    u = plus(u, family(Family::Move, quads.checked_add(me.checked_mul(ne)?)?))?;
    if k % 2 == 1 {
        let core = me.checked_mul(ne)?;
        u = plus(u, family(Family::MulSchool, core))?;
        u = plus(u, family(Family::ModArith, core.checked_mul(2)?))?;
    }
    if m % 2 == 1 {
        u = plus(u, family(Family::Move, k64.checked_add(n64)?))?;
        u = plus(u, classical_units(1, k, n, md)?)?;
    }
    if n % 2 == 1 {
        u = plus(u, family(Family::Move, k64.checked_add(me)?))?;
        u = plus(u, classical_units(m, k, 1, md)?)?;
    }
    Some(u)
}

/// The peak of the words [`Mat::mul_classical`] allocates for an m x k by k x n
/// product, all live together: the result, and on its u64 branch a row's
/// sums, on its u128 branch the transpose of the right factor.
pub(super) fn classical_peak(m: usize, k: usize, n: usize, md: &Modulus) -> Option<u64> {
    let (m, k, n) = (m as u64, k as u64, n as u64);
    let side = if k > batch64(md) as u64 { k.checked_mul(n)? } else { n };
    m.checked_mul(n)?.checked_add(side)
}

/// The peak of the words one Winograd level allocates, as [`winograd`]
/// schedules them, with `half` the peak of each half product (its result
/// included): the largest live set at any point, a child product's peak
/// counted on top of what is live while it runs.  In quadrant words
/// qa = m'k'/4, qb = k'n'/4, qc = m'n'/4:
/// - A's sums: a11, a21, a22, S1, S2 (S3 over a21), 5 qa; then B's, 5 qb;
/// - P5 = S1 T1 at 5 qa + 5 qb, then S1, T1 dropped;
/// - P7 = S3 T3 at 4 qa + 4 qb + qc, then S3, T3 dropped;
/// - P6 = S2 T2 at 3 qa + 3 qb + 2 qc;
/// - P1 = a11 b11 at 3 qa + 3 qb + 3 qc, then a11, b11 dropped and
///   U2 = P1 + P6 over P6;
/// - a12, b21 taken; P2 = a12 b21 at 3 qa + 3 qb + 4 qc, then
///   C11 = P1 + P2 over P1, P2 dropped; S4 over a12 (S2 dropped), T4 over
///   T2 (b21 dropped);
/// - P3 = S4 b22 at 2 qa + 2 qb + 4 qc, then S4, b22 dropped; U3 over P7,
///   U4 over U2, C12 = U4 + P3 over P3, U4 dropped;
/// - P4 = a22 T4 at qa + qb + 4 qc, then a22, T4 dropped; C21 = U3 - P4
///   over P4, C22 = U3 + P5 over P5, U3 dropped: 4 qc;
/// - for odd n: B's last column (k) and the classical (m, k, 1) product;
///   then its m words live;
/// - for odd m: A's last row (k) and the classical (1, k, n) product; then
///   its n words live;
/// - the result (mn) with the four quadrants and the strips.
fn winograd_peak(m: usize, k: usize, n: usize, half: u64, md: &Modulus) -> Option<u64> {
    let (me, ke, ne) = ((m - m % 2) as u64, (k - k % 2) as u64, (n - n % 2) as u64);
    let (qa, qb, qc) = (me / 2 * (ke / 2), ke / 2 * (ne / 2), me / 2 * (ne / 2));
    let (m64, k64, n64) = (m as u64, k as u64, n as u64);
    // a live set of i qa + j qb + l qc (+ extra)
    let at = |i: u64, j: u64, l: u64, extra: u64| -> Option<u64> {
        qa.checked_mul(i)?.checked_add(qb.checked_mul(j)?)?.checked_add(qc.checked_mul(l)?)?.checked_add(extra)
    };
    let mut peak = at(5, 5, 0, half)?;
    for (i, l) in [(4, 1), (3, 2), (3, 3), (3, 4), (2, 4), (1, 4)] {
        peak = peak.max(at(i, i, l, half)?);
    }
    // (the live sets between the child products are below these)
    let mut strips = 0u64;
    if n % 2 == 1 {
        peak = peak.max(at(0, 0, 4, k64.checked_add(classical_peak(m, k, 1, md)?)?)?);
        strips = m64;
    }
    if m % 2 == 1 {
        peak = peak.max(at(0, 0, 4, strips.checked_add(k64)?.checked_add(classical_peak(1, k, n, md)?)?)?);
        strips = strips.checked_add(n64)?;
    }
    peak.max(at(0, 0, 4, strips.checked_add(m64.checked_mul(n64)?)?)?).into()
}

/// The plan for an m x k by k x n product, its units and its peak words:
/// Winograd where the smallest dimension is at least `n0` and its units
/// (its half products planned the same way) total at most the classical
/// product's, else classical.  So each product, at every level, totals at
/// most what the classical product would.  `None` if a count overflows
/// (then nothing may take the fast route).
pub(super) fn plan(m: usize, k: usize, n: usize, md: &Modulus, n0: usize) -> Option<(Plan, Units, u64)> {
    let classical = classical_units(m, k, n, md)?;
    let cpeak = classical_peak(m, k, n, md)?;
    if m.min(k).min(n) < n0.max(2) {
        return Some((Plan::Classical, classical, cpeak));
    }
    let (_, half, hpeak) = plan(m / 2, k / 2, n / 2, md, n0)?;
    let fast = winograd_units(m, k, n, half, md)?;
    if fast.total()? <= classical.total()? || forced() {
        Some((Plan::Winograd, fast, winograd_peak(m, k, n, hpeak, md)?))
    } else {
        Some((Plan::Classical, classical, cpeak))
    }
}

/// rows x cols of `a` from (r0, c0), copied (Move, a row at a time, counted
/// as each row is done).
fn take(a: &Mat, r0: usize, c0: usize, rows: usize, cols: usize, poll: &mut Poll) -> Mat {
    let mut d = Vec::with_capacity(rows * cols);
    for i in r0..r0 + rows {
        d.extend_from_slice(&a.d[i * a.cols + c0..i * a.cols + c0 + cols]);
        poll.count(Family::Move, cols as u64);
        poll.add(cols);
    }
    Mat {
        rows,
        cols,
        m: a.m,
        d,
    }
}

/// The crossover of the fast route for primes whose products sum in u64
/// (below 2^32) and for the rest (u128 sums): no product with a smaller
/// dimension, at any level, takes it.  One value for every target, so
/// that a product's route and units depend on the modulus and the shape
/// alone, never on where it runs or on the CPU's features.  Measured
/// natively (with AVX2 and without) and in wasm32: the u64 kernel's
/// classical product is fast enough that the fast route only pays from
/// 384 up (one level at 256, its halves at 128, was slower); the u128
/// kernel's from 64 up.
pub(super) const N0_U64: usize = 384;
pub(super) const N0_U128: usize = 64;

#[cfg(feature = "test-hooks")]
thread_local! {
    static N0_OVERRIDE: Cell<Option<usize>> = const { Cell::new(None) };
}

/// The crossover [`Mat::mul`] uses on this thread in place of the constants
/// (`None`: the constants), so that one host can run the route each value
/// gives (tests).
#[cfg(feature = "test-hooks")]
pub fn set_fast_n0(n0: Option<usize>) {
    N0_OVERRIDE.with(|c| c.set(n0));
}

fn n0_for(md: &Modulus) -> usize {
    #[cfg(feature = "test-hooks")]
    if let Some(n0) = N0_OVERRIDE.with(|c| c.get()) {
        return n0;
    }
    if batch64(md) > 0 {
        N0_U64
    } else {
        N0_U128
    }
}

thread_local! {
    /// The fast route's admission on this thread: off (`None`), or the words
    /// of workspace beyond the classical product's it may still hold.
    static ALLOWANCE: Cell<Option<u64>> = const { Cell::new(None) };
}

/// The words [`Mat::mul`] allocates at once for an m x k by k x n product on
/// a thread whose allowance is `allowance` words, and the part of them past
/// the classical product's (0 on the classical route): the fast route's
/// planned peak when its plan takes it and that excess fits the allowance,
/// else the classical product's.  The same decision `Mat::mul` makes, from
/// the shape, the prime and the allowance alone, for a caller's admission
/// before it runs.  `None` if the classical peak overflows.
pub fn product_peak(m: usize, k: usize, n: usize, md: &Modulus, allowance: u64) -> Option<(u64, u64)> {
    let classical = classical_peak(m, k, n, md)?;
    Some(match decide(m, k, n, md, allowance) {
        Route::Fast { peak, extra, .. } => (peak, extra),
        Route::Classical => (classical, 0),
    })
}

/// The route of an m x k by k x n product with `allowance` words left.
enum Route {
    Classical,
    /// The fast route with crossover `n0`: its planned peak, and the part
    /// of it past the classical product's, held from the allowance.
    Fast { n0: usize, peak: u64, extra: u64 },
}

/// The one decision [`Mat::mul`] runs and [`product_peak`] reports: the
/// fast route where the smallest dimension is at least the crossover, the
/// plan takes it, and its peak's excess over the classical product's fits
/// the allowance; else classical (also when a count overflows).
fn decide(m: usize, k: usize, n: usize, md: &Modulus, allowance: u64) -> Route {
    let n0 = n0_for(md);
    if m.min(k).min(n) < n0 {
        return Route::Classical;
    }
    match (plan(m, k, n, md, n0), classical_peak(m, k, n, md)) {
        (Some((Plan::Winograd, _, peak)), Some(classical)) => {
            let extra = peak.saturating_sub(classical);
            if extra <= allowance {
                Route::Fast { n0, peak, extra }
            } else {
                Route::Classical
            }
        }
        _ => Route::Classical,
    }
}

/// Runs `f` with an allowance of `words` (u64 words) for the fast product's
/// workspace on this thread: each product ([`Mat::mul`]) inside it whose
/// plan takes the fast route and whose peak exceeds the classical one's by
/// at most what is left of the allowance holds that excess while it runs
/// and takes the fast route; any other runs classical.  The decision is
/// logical: from the shape, the prime, the fixed peak formulas and this
/// allowance, before any work, never from the free heap or an allocation's
/// success.  The previous allowance (none outside) is restored on return
/// and on unwinding.
pub fn with_fast_product<T>(words: u64, f: impl FnOnce() -> T) -> T {
    struct Restore(Option<u64>);
    impl Drop for Restore {
        fn drop(&mut self) {
            ALLOWANCE.with(|a| a.set(self.0));
        }
    }
    let _restore = Restore(ALLOWANCE.with(|a| a.replace(Some(words))));
    f()
}

/// What is left of this thread's allowance (`None`: off), and the
/// crossover for a prime (tests and benchmarks).
#[cfg(feature = "test-hooks")]
pub fn fast_allowance_left() -> Option<u64> {
    ALLOWANCE.with(|a| a.get())
}

#[cfg(feature = "test-hooks")]
pub fn fast_n0(md: &Modulus) -> usize {
    n0_for(md)
}

/// Clears this thread's fast-product state at a top-level call's start
/// (engine/web's new_run): on wasm a Stop is a trap, which runs no
/// destructors, so a trapped fast product can leave its carried poll work
/// and its allowance (reduced by its held words) behind, and the next call
/// would poll on a different cadence and choose its route from them.
pub fn reset_fast_product() {
    super::Carrying::reset();
    ALLOWANCE.with(|a| a.set(None));
}

/// Leaves the state as a fast product trapped inside an allowance would
/// (its guards forgotten), and reads it back: (depth, carried work) and the
/// allowance (tests).
#[cfg(feature = "test-hooks")]
pub fn leave_fast_product_state() {
    std::mem::forget(super::Carrying::new());
    super::Carrying::put(1000);
    ALLOWANCE.with(|a| a.set(Some(7)));
    std::mem::forget(Held(3));
}

#[cfg(feature = "test-hooks")]
pub fn fast_product_state() -> ((u32, u64), Option<u64>) {
    (super::Carrying::state(), ALLOWANCE.with(|a| a.get()))
}

/// Words held from the allowance while a fast product runs, given back
/// when it ends (also on Stop or a panic).
struct Held(u64);

impl Drop for Held {
    fn drop(&mut self) {
        ALLOWANCE.with(|a| a.set(a.get().map(|w| w + self.0)));
    }
}

/// [`Mat::mul`]: the fast route where the allowance admits it, else the
/// classical product.
pub(super) fn mul(a: &Mat, b: &Mat) -> Mat {
    let Some(left) = ALLOWANCE.with(|a| a.get()) else {
        return a.mul_classical(b);
    };
    let Route::Fast { n0, extra, .. } = decide(a.rows, a.cols, b.cols, &a.m, left) else {
        return a.mul_classical(b);
    };
    ALLOWANCE.with(|a| a.set(Some(left - extra)));
    let _held = Held(extra);
    winograd(a, b, n0)
}

/// x + y or x - y, entry by entry, into a new matrix (ModArith, a row at a
/// time, counted as each row is done).
fn lin(x: &Mat, y: &Mat, sub: bool, poll: &mut Poll) -> Mat {
    debug_assert_eq!((x.rows, x.cols), (y.rows, y.cols));
    let m = x.m;
    let mut d = Vec::with_capacity(x.d.len());
    for i in 0..x.rows {
        let (a, b) = (&x.d[i * x.cols..(i + 1) * x.cols], &y.d[i * y.cols..(i + 1) * y.cols]);
        if sub {
            d.extend(a.iter().zip(b).map(|(&s, &t)| m.sub(s, t)));
        } else {
            d.extend(a.iter().zip(b).map(|(&s, &t)| m.add(s, t)));
        }
        poll.count(Family::ModArith, x.cols as u64);
        poll.add(x.cols);
    }
    Mat { rows: x.rows, cols: x.cols, m, d }
}

/// How [`over`] combines x and y into x.
#[derive(Clone, Copy)]
enum Op {
    /// x + y
    Add,
    /// x - y
    Sub,
    /// y - x
    From,
}

/// x op y into x, entry by entry (ModArith, a row at a time, counted as
/// each row is done).
fn over(x: &mut Mat, y: &Mat, op: Op, poll: &mut Poll) {
    debug_assert_eq!((x.rows, x.cols), (y.rows, y.cols));
    let (m, c) = (x.m, x.cols);
    for i in 0..x.rows {
        let (a, b) = (&mut x.d[i * c..(i + 1) * c], &y.d[i * c..(i + 1) * c]);
        match op {
            Op::Add => a.iter_mut().zip(b).for_each(|(s, &t)| *s = m.add(*s, t)),
            Op::Sub => a.iter_mut().zip(b).for_each(|(s, &t)| *s = m.sub(*s, t)),
            Op::From => a.iter_mut().zip(b).for_each(|(s, &t)| *s = m.sub(t, *s)),
        }
        poll.count(Family::ModArith, c as u64);
        poll.add(c);
    }
}

/// a b by the plan for its shape: classical ([`Mat::mul_classical`]), or one Winograd
/// level whose half products are planned the same way.  Counts exactly
/// [`plan`]'s units, and allocates at most its peak words at once.
pub(super) fn mul_planned(a: &Mat, b: &Mat, n0: usize) -> Mat {
    let (m, k, n) = (a.rows, a.cols, b.cols);
    match plan(m, k, n, &a.m, n0) {
        Some((Plan::Winograd, _, _)) => winograd(a, b, n0),
        _ => a.mul_classical(b),
    }
}

/// One Winograd level (7 products, 15 additions) over the even core, with
/// the odd row, column and inner index as strips; each temporary dropped
/// after its last use and the sums formed over their operands where those
/// are not needed again (the schedule [`winograd_peak`] counts).
fn winograd(a: &Mat, b: &Mat, n0: usize) -> Mat {
    let (m, k, n) = (a.rows, a.cols, b.cols);
    let md = a.m;
    let (me, ne) = (m - m % 2, n - n % 2);
    let (hm, hk, hn) = (me / 2, (k - k % 2) / 2, ne / 2);
    #[cfg(test)]
    test_hooks::level();
    let _carry = Carrying::new();
    let mut poll = Poll::new();
    let a11 = take(a, 0, 0, hm, hk, &mut poll);
    let mut a21 = take(a, hm, 0, hm, hk, &mut poll);
    let a22 = take(a, hm, hk, hm, hk, &mut poll);
    let s1 = lin(&a21, &a22, false, &mut poll);
    over(&mut a21, &a11, Op::From, &mut poll);
    let s3 = a21;
    let s2 = lin(&s1, &a11, true, &mut poll);
    let b11 = take(b, 0, 0, hk, hn, &mut poll);
    let mut b12 = take(b, 0, hn, hk, hn, &mut poll);
    let b22 = take(b, hk, hn, hk, hn, &mut poll);
    let t1 = lin(&b12, &b11, true, &mut poll);
    over(&mut b12, &b22, Op::From, &mut poll);
    let t3 = b12;
    let t2 = lin(&b22, &t1, true, &mut poll);
    poll.hand_off();
    let mut c22 = mul_planned(&s1, &t1, n0); // P5
    drop((s1, t1));
    let mut u3 = mul_planned(&s3, &t3, n0); // P7
    drop((s3, t3));
    let mut u2 = mul_planned(&s2, &t2, n0); // P6
    let mut c11 = mul_planned(&a11, &b11, n0); // P1
    drop((a11, b11));
    poll.take_back();
    over(&mut u2, &c11, Op::Add, &mut poll); // U2 = P1 + P6
    let mut s4 = take(a, 0, hk, hm, hk, &mut poll); // a12
    let b21 = take(b, hk, 0, hk, hn, &mut poll);
    poll.hand_off();
    let p2 = mul_planned(&s4, &b21, n0);
    poll.take_back();
    over(&mut c11, &p2, Op::Add, &mut poll); // C11 = P1 + P2
    drop(p2);
    over(&mut s4, &s2, Op::Sub, &mut poll); // S4 = a12 - S2
    drop(s2);
    let mut t4 = t2;
    over(&mut t4, &b21, Op::Sub, &mut poll); // T4 = T2 - b21
    drop(b21);
    poll.hand_off();
    let mut c12 = mul_planned(&s4, &b22, n0); // P3
    poll.take_back();
    drop((s4, b22));
    over(&mut u3, &u2, Op::Add, &mut poll); // U3 = U2 + P7
    over(&mut u2, &c22, Op::Add, &mut poll); // U4 = U2 + P5
    over(&mut c12, &u2, Op::Add, &mut poll); // C12 = U4 + P3
    drop(u2);
    poll.hand_off();
    let mut c21 = mul_planned(&a22, &t4, n0); // P4
    poll.take_back();
    drop((a22, t4));
    over(&mut c21, &u3, Op::From, &mut poll); // C21 = U3 - P4
    over(&mut c22, &u3, Op::Add, &mut poll); // C22 = U3 + P5
    drop(u3);
    // the strips: the last column (all m rows: its corner entry is the last
    // row's too) and the last row
    poll.hand_off();
    let last_col = (n % 2 == 1).then(|| {
        let bcol = take(b, 0, n - 1, k, 1, &mut poll);
        a.mul_classical(&bcol)
    });
    let last_row = (m % 2 == 1).then(|| {
        let arow = take(a, m - 1, 0, 1, k, &mut poll);
        arow.mul_classical(b)
    });
    poll.take_back();
    // the result: the core of C a row at a time (Move), the odd inner
    // index's rank-1 term added into it (a product, its reduction and the
    // addition per entry), the last column's entry (Move); then the last
    // row (Move)
    let mut d = Vec::with_capacity(m * n);
    for i in 0..me {
        let (l, r) = if i < hm { (&c11, &c12) } else { (&c21, &c22) };
        let ii = i % hm;
        let at = d.len();
        d.extend_from_slice(&l.d[ii * hn..(ii + 1) * hn]);
        d.extend_from_slice(&r.d[ii * hn..(ii + 1) * hn]);
        poll.count(Family::Move, ne as u64);
        poll.add(ne);
        if k % 2 == 1 {
            let f = a.d[i * k + k - 1];
            let brow = &b.d[(k - 1) * n..(k - 1) * n + ne];
            for (x, &y) in d[at..].iter_mut().zip(brow) {
                *x = md.add(*x, md.mul(f, y));
            }
            poll.count(Family::MulSchool, ne as u64);
            poll.count(Family::ModArith, 2 * ne as u64);
            poll.add(ne);
        }
        if let Some(c) = &last_col {
            d.push(c.d[i]);
            poll.count(Family::Move, 1);
            poll.add(1);
        }
    }
    drop((c11, c12, c21, c22, last_col));
    if let Some(r) = last_row {
        d.extend_from_slice(&r.d);
        poll.count(Family::Move, n as u64);
        poll.add(n);
    }
    debug_assert!(d.iter().all(|&v| v < md.n));
    Mat { rows: m, cols: n, m: md, d }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::{metered, Meter};

    fn total(u: Units) -> u64 {
        u.total().unwrap()
    }

    fn rand(r: usize, c: usize, md: Modulus, s: &mut u64) -> Mat {
        Mat {
            rows: r,
            cols: c,
            m: md,
            d: (0..r * c)
                .map(|_| {
                    *s ^= *s << 13;
                    *s ^= *s >> 7;
                    *s ^= *s << 17;
                    *s % md.n
                })
                .collect(),
        }
    }

    fn units_of<T>(f: impl FnOnce() -> T) -> (T, Units) {
        let mut meter = Meter::accounting(u64::MAX);
        let r = metered(&mut meter, f);
        assert_eq!(meter.units().total(), Some(meter.used()));
        (r, meter.units())
    }

    /// The classical count is Mat::mul's own, on both of its branches.
    #[test]
    fn classical_units_are_the_products_own() {
        let mut s = 3u64;
        for p in [3u64, 65537, (1 << 31) - 1, (1 << 62) - 57] {
            let md = Modulus::new(p);
            for &(m, k, n) in &[
                (1usize, 1usize, 1usize),
                (3, 5, 7),
                (8, 2, 9),
                (17, 33, 5),
                (40, 40, 40),
            ] {
                let (a, b) = (rand(m, k, md, &mut s), rand(k, n, md, &mut s));
                let (_, u) = units_of(|| a.mul(&b));
                assert_eq!(
                    u,
                    classical_units(m, k, n, &md).unwrap(),
                    "p {} {}x{}x{}",
                    p,
                    m,
                    k,
                    n
                );
            }
        }
    }

    /// The fast route, forced wherever the shape allows it (so on small
    /// shapes, where the gate would refuse it): the result is the classical
    /// one exactly, and the metered units are its plan's, on even, odd,
    /// rectangular and thin shapes, every class of prime, one to several
    /// levels, with all entries p - 1 and random ones.
    #[test]
    fn the_forced_fast_product_is_exact_and_counts_its_plan() {
        let mut s = 11u64;
        test_hooks::set_force(true);
        for p in [2u64, 3, 65537, (1 << 31) - 1, 3 * (1 << 30) + 1, (1 << 62) - 57] {
            let md = Modulus::new(p);
            for n0 in [2usize, 5, 16] {
                for &(m, k, n) in &[(2usize, 2usize, 2usize), (4, 4, 4), (5, 5, 5), (7, 6, 5), (6, 7, 8), (9, 9, 9), (16, 15, 17), (33, 32, 31), (40, 3, 40), (3, 40, 3), (48, 48, 48)] {
                    for full in [false, true] {
                        let a = if full { Mat { rows: m, cols: k, m: md, d: vec![p - 1; m * k] } } else { rand(m, k, md, &mut s) };
                        let b = if full { Mat { rows: k, cols: n, m: md, d: vec![p - 1; k * n] } } else { rand(k, n, md, &mut s) };
                        let want = a.mul_classical(&b);
                        test_hooks::reset_levels();
                        let (got, u) = units_of(|| mul_planned(&a, &b, n0));
                        let at = format!("p {} n0 {} {}x{}x{}", p, n0, m, k, n);
                        assert_eq!(got, want, "{}", at);
                        assert_eq!(u, plan(m, k, n, &md, n0).unwrap().1, "units {}", at);
                        assert_eq!(test_hooks::levels() > 0, m.min(k).min(n) >= n0, "levels {}", at);
                    }
                }
            }
        }
        test_hooks::set_force(false);
    }

    /// The fast route as the gate takes it (n0 = 2), executed: at each
    /// prime class's even equality flip, just above it, at its odd flip, on
    /// a rectangular shape, and two and three levels deep; each with its
    /// result, its metered units equal to the plan's, its total at most the
    /// classical one, and the Winograd levels it ran.  The sizes just below
    /// the flips run classical with the classical units.
    #[test]
    fn the_gated_fast_product_runs_where_the_gate_admits_it() {
        let mut s = 5u64;
        // (prime, m, k, n, Winograd levels run; 0: classical)
        let rows: &[(u64, usize, usize, usize, u64)] = &[
            (65537, 64, 64, 64, 0),
            (65537, 66, 66, 66, 1),
            (65537, 68, 68, 68, 1),
            (65537, 83, 83, 83, 0),
            (65537, 85, 85, 85, 1),
            (65537, 132, 132, 132, 8),
            (65537, 264, 264, 264, 57),
            ((1 << 31) - 1, 76, 76, 76, 0),
            ((1 << 31) - 1, 78, 78, 78, 1),
            ((1 << 31) - 1, 111, 111, 111, 0),
            ((1 << 31) - 1, 113, 113, 113, 1),
            ((1 << 31) - 1, 156, 156, 156, 8),
            ((1 << 62) - 57, 72, 72, 72, 0),
            ((1 << 62) - 57, 74, 74, 74, 1),
            ((1 << 62) - 57, 95, 95, 95, 0),
            ((1 << 62) - 57, 97, 97, 97, 1),
            ((1 << 62) - 57, 148, 148, 148, 8),
        ];
        for &(p, m, k, n, levels) in rows {
            let md = Modulus::new(p);
            let (a, b) = (rand(m, k, md, &mut s), rand(k, n, md, &mut s));
            let want = a.mul_classical(&b);
            test_hooks::reset_levels();
            let (got, u) = units_of(|| mul_planned(&a, &b, 2));
            let at = format!("p {} {}x{}x{}", p, m, k, n);
            assert_eq!(got, want, "{}", at);
            let (pl, planned, _) = plan(m, k, n, &md, 2).unwrap();
            assert_eq!(u, planned, "units {}", at);
            let c = classical_units(m, k, n, &md).unwrap();
            assert!(total(u) <= total(c), "{}", at);
            assert_eq!(test_hooks::levels(), levels, "levels {}", at);
            assert_eq!(pl == Plan::Winograd, levels > 0, "{}", at);
            if levels == 0 {
                assert_eq!(u, c, "{}", at);
            } else {
                assert!(total(u) < total(c) || (m, n) == (66, 66) || (m, n) == (78, 78) || (m, n) == (74, 74), "{}", at);
            }
        }
        // a rectangular shape taken fast, and its transpose's shape
        for &(m, k, n) in &[(200usize, 100usize, 160usize), (160, 100, 200)] {
            let md = Modulus::new(65537);
            let (a, b) = (rand(m, k, md, &mut s), rand(k, n, md, &mut s));
            test_hooks::reset_levels();
            let (got, u) = units_of(|| mul_planned(&a, &b, 2));
            assert_eq!(got, a.mul(&b));
            assert_eq!(u, plan(m, k, n, &md, 2).unwrap().1);
            assert!(test_hooks::levels() > 0, "{}x{}x{}", m, k, n);
            assert!(total(u) < total(classical_units(m, k, n, &md).unwrap()));
        }
        // zero dimensions: classical, an empty or zero result
        let md = Modulus::new(65537);
        for &(m, k, n) in &[(0usize, 5usize, 5usize), (5, 0, 5), (5, 5, 0), (0, 0, 0)] {
            let (a, b) = (rand(m, k, md, &mut s), rand(k, n, md, &mut s));
            assert_eq!(plan(m, k, n, &md, 2).unwrap().0, Plan::Classical);
            assert_eq!(mul_planned(&a, &b, 2), a.mul(&b));
        }
    }

    /// The route `Mat::mul` runs is the one `product_peak` reports, over a
    /// grid of shapes, primes, crossovers and allowances on both sides of
    /// each product's extra words: the fast route (Winograd levels run)
    /// exactly where it reports the plan's peak, else the classical peak
    /// and no extra; the allowance restored afterwards.
    #[test]
    fn mul_runs_the_route_product_peak_reports() {
        let mut s = 17u64;
        let mut fast_seen = [0usize; 2];
        for p in [2u64, 65537, (1 << 31) - 1, (1 << 62) - 57] {
            let md = Modulus::new(p);
            for n0 in [2usize, 4, 9] {
                set_fast_n0(Some(n0));
                for &(m, k, n) in &[(1usize, 1usize, 1usize), (3, 3, 3), (4, 4, 4), (8, 9, 10), (9, 8, 9), (16, 16, 16), (20, 3, 20), (33, 32, 31), (40, 40, 40), (64, 64, 64), (96, 80, 72)] {
                    let classical = classical_peak(m, k, n, &md).unwrap();
                    let planned = plan(m, k, n, &md, n0).unwrap();
                    let wanted = planned.2.saturating_sub(classical);
                    let (a, b) = (rand(m, k, md, &mut s), rand(k, n, md, &mut s));
                    for allowance in [0, wanted.saturating_sub(1), wanted, wanted + 1, u64::MAX] {
                        let at = format!("p {} n0 {} {}x{}x{} allowance {}", p, n0, m, k, n, allowance);
                        test_hooks::reset_levels();
                        let left = with_fast_product(allowance, || {
                            a.mul(&b);
                            fast_allowance_left()
                        });
                        assert_eq!(left, Some(allowance), "{}", at);
                        let fast = test_hooks::levels() > 0;
                        let reported = product_peak(m, k, n, &md, allowance).unwrap();
                        let want = if fast { (planned.2, wanted) } else { (classical, 0) };
                        assert_eq!(reported, want, "{}", at);
                        assert_eq!(fast, planned.0 == Plan::Winograd && m.min(k).min(n) >= n0 && wanted <= allowance, "{}", at);
                        fast_seen[fast as usize] += 1;
                    }
                }
            }
        }
        set_fast_n0(None);
        // (both routes occur in the grid)
        assert!(fast_seen[0] > 0 && fast_seen[1] > 0, "{:?}", fast_seen);
    }

    /// NUMERIC's grid, the fast route forced at n0 = 8 (so every shape of
    /// {n0 - 1, n0, n0 + 1, 2 n0 - 1, 2 n0, 2 n0 + 1}^3 and the thin ones
    /// runs it, one or two levels deep): the classical result exactly, and
    /// the plan's units, at each prime class, for all entries p - 1, all
    /// zero, the identity pattern, one nonzero entry, random entries, and
    /// nonzero factors whose product is zero (A = [X X], B = [R; -R]: the
    /// Winograd sums cancel).
    #[test]
    fn the_numeric_grid() {
        let n0 = 8usize;
        let sizes = [n0 - 1, n0, n0 + 1, 2 * n0 - 1, 2 * n0, 2 * n0 + 1];
        let mut shapes: Vec<(usize, usize, usize)> = vec![];
        for &m in &sizes {
            for &k in &sizes {
                for &n in &sizes {
                    shapes.push((m, k, n));
                }
            }
        }
        shapes.extend([(2 * n0 + 1, 2, 2 * n0 + 1), (2, 2 * n0 + 1, 2), (40, 3, 37), (3, 40, 2), (33, 2, 2)]);
        let mut s = 17u64;
        test_hooks::set_force(true);
        for p in [2u64, 3, 65537, (1 << 31) - 1, 3 * (1 << 30) + 1, (1 << 62) - 57] {
            let md = Modulus::new(p);
            let fill = |r: usize, c: usize, f: &dyn Fn(usize, usize) -> u64| Mat { rows: r, cols: c, m: md, d: (0..r * c).map(|x| f(x / c, x % c)).collect() };
            for &(m, k, n) in &shapes {
                let mut pairs: Vec<(Mat, Mat)> = vec![
                    (fill(m, k, &|_, _| p - 1), fill(k, n, &|_, _| p - 1)),
                    (fill(m, k, &|_, _| 0), rand(k, n, md, &mut s)),
                    (fill(m, k, &|i, j| (i == j) as u64), rand(k, n, md, &mut s)),
                    (rand(m, k, md, &mut s), fill(k, n, &|i, j| (i == j) as u64)),
                    (fill(m, k, &|i, j| if (i, j) == (m / 2, k - 1) { p - 1 } else { 0 }), rand(k, n, md, &mut s)),
                    (rand(m, k, md, &mut s), rand(k, n, md, &mut s)),
                ];
                // A = [X X], B = [R; -R] (B's odd last row zero): AB = 0
                let (x, r) = (rand(m, k / 2, md, &mut s), rand(k / 2, n, md, &mut s));
                let a = fill(m, k, &|i, j| if j < 2 * (k / 2) { x.d[i * (k / 2) + j % (k / 2)] } else { 1 });
                let b = fill(k, n, &|i, j| {
                    if i < k / 2 {
                        r.d[i * n + j]
                    } else if i < 2 * (k / 2) {
                        md.sub(0, r.d[(i - k / 2) * n + j])
                    } else {
                        0
                    }
                });
                pairs.push((a, b));
                for (i, (a, b)) in pairs.iter().enumerate() {
                    let want = a.mul_classical(b);
                    if i == pairs.len() - 1 {
                        assert!(want.d.iter().all(|&v| v == 0));
                    }
                    let (got, u) = units_of(|| mul_planned(a, b, n0));
                    assert_eq!(got, want, "p {} {}x{}x{} pair {}", p, m, k, n, i);
                    assert_eq!(u, plan(m, k, n, &md, n0).unwrap().1, "units p {} {}x{}x{} pair {}", p, m, k, n, i);
                }
            }
        }
        test_hooks::set_force(false);
    }

    /// The grid with the gate deciding, at n0 = 64 and p = 65537 (random
    /// entries): the classical result exactly, the plan's units, at most
    /// the classical total.
    #[test]
    fn the_numeric_grid_gated() {
        let n0 = 64usize;
        let sizes = [n0 - 1, n0, n0 + 1, 2 * n0 - 1, 2 * n0, 2 * n0 + 1];
        let md = Modulus::new(65537);
        let mut s = 23u64;
        let mut fast = 0;
        for &m in &sizes {
            for &k in &sizes {
                for &n in &sizes {
                    let (a, b) = (rand(m, k, md, &mut s), rand(k, n, md, &mut s));
                    test_hooks::reset_levels();
                    let (got, u) = units_of(|| mul_planned(&a, &b, n0));
                    assert_eq!(got, a.mul_classical(&b), "{}x{}x{}", m, k, n);
                    assert_eq!(u, plan(m, k, n, &md, n0).unwrap().1);
                    assert!(total(u) <= total(classical_units(m, k, n, &md).unwrap()));
                    fast += (test_hooks::levels() > 0) as usize;
                }
            }
        }
        assert!(fast > 0);
    }

    /// The plan never totals more than the classical product, at any shape
    /// (square, odd, rectangular, thin), any prime class and any n0; and at
    /// a large enough shape it does take the fast route.
    #[test]
    fn a_plan_never_totals_more_than_classical() {
        for p in [
            3u64,
            65537,
            (1 << 31) - 1,
            3 * (1 << 30) + 1,
            (1 << 62) - 57,
        ] {
            let md = Modulus::new(p);
            for n0 in [2usize, 16, 33, 64] {
                for &(m, k, n) in &[
                    (1usize, 1usize, 1usize),
                    (35, 36, 37),
                    (64, 64, 64),
                    (65, 63, 64),
                    (300, 20, 300),
                    (20, 300, 20),
                    (257, 255, 256),
                    (1024, 1024, 1024),
                    (1023, 1025, 1024),
                ] {
                    let (pl, u, _) = plan(m, k, n, &md, n0).unwrap();
                    let c = classical_units(m, k, n, &md).unwrap();
                    assert!(total(u) <= total(c), "p {} n0 {} {}x{}x{}", p, n0, m, k, n);
                    if pl == Plan::Classical {
                        assert_eq!(u, c);
                    }
                }
            }
            assert_eq!(
                plan(1024, 1024, 1024, &md, 64).unwrap().0,
                Plan::Winograd,
                "p {}",
                p
            );
        }
    }

    /// One level (half products classical): where the square fast route's
    /// total first reaches the classical one, pinned with both totals, for
    /// a u64 prime, a folding prime and a u128 prime.  An odd size pays its
    /// strips and is taken fast only from a larger size.
    #[test]
    fn the_gate_flips_where_pinned() {
        let one = |n: usize, p: u64| {
            let md = Modulus::new(p);
            let f = winograd_units(
                n,
                n,
                n,
                classical_units(n / 2, n / 2, n / 2, &md).unwrap(),
                &md,
            )
            .unwrap();
            let c = classical_units(n, n, n, &md).unwrap();
            assert_eq!(
                plan(n, n, n, &md, n).unwrap().0 == Plan::Winograd,
                total(f) <= total(c)
            );
            (total(f), total(c))
        };
        assert_eq!(one(64, 65537), (271_360, 270_336));
        assert_eq!(one(66, 65537), (296_208, 296_208));
        assert_eq!(one(76, (1 << 31) - 1), (463_524, 462_080));
        assert_eq!(one(78, (1 << 31) - 1), (498_888, 498_888));
        assert_eq!(one(72, (1 << 62) - 57), (416_016, 414_720));
        assert_eq!(one(74, (1 << 62) - 57), (449_032, 449_032));
        // the first even and odd sizes taken fast, and the sizes from there
        // to 400 not taken fast (at the u128 prime, a reduction per 16 terms:
        // the halves of 99..105 need one more each than 48's)
        let none: &[usize] = &[];
        for (p, even, odd, back) in [
            (65537u64, 66, 85, none),
            ((1 << 31) - 1, 78, 113, none),
            ((1 << 62) - 57, 74, 97, &[99, 101, 103, 105][..]),
        ] {
            let md = Modulus::new(p);
            let fast = |n: usize| plan(n, n, n, &md, n).unwrap().0 == Plan::Winograd;
            let first = |odd: usize| (2..400).find(|&n| n % 2 == odd && fast(n));
            assert_eq!((first(0), first(1)), (Some(even), Some(odd)), "p {}", p);
            assert_eq!((odd..400).filter(|&n| !fast(n)).collect::<Vec<_>>(), back, "p {}", p);
        }
    }

    /// Counts that would overflow give no plan (and so no fast route).
    #[test]
    fn an_overflowing_count_gives_no_plan() {
        let md = Modulus::new(65537);
        assert!(classical_units(usize::MAX, 2, 2, &md).is_none());
        assert!(plan(usize::MAX / 2, usize::MAX / 2, 4, &md, 2).is_none());
    }
}
