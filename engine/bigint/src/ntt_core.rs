//! The transform machinery shared by the native and wasm limb widths.

use std::mem::size_of;
use std::ops::{Add, Sub};
use std::sync::{Arc, Mutex};

const BLOCK: usize = 1 << 12;

// The work of this thread's transform products since it started, by kind:
// [butterflies and pointwise products, reductions mod p, words zero-filled].
// Cumulative and wrapping: a caller meters a product by the difference
// around it ([`units`]).
thread_local! {
    static UNITS: std::cell::Cell<[u64; 3]> = const { std::cell::Cell::new([0; 3]) };
}

#[inline]
fn tally(ntt: u64, reductions: u64, fills: u64) {
    UNITS.with(|u| {
        let v = u.get();
        u.set([v[0].wrapping_add(ntt), v[1].wrapping_add(reductions), v[2].wrapping_add(fills)]);
    });
}

/// This thread's transform-product work so far: [butterflies and pointwise
/// products, reductions mod p, words zero-filled], cumulative and wrapping.
/// The units of one product are the difference across it (wrapping_sub).
pub fn units() -> [u64; 3] {
    UNITS.with(|u| u.get())
}

/// Records `n` reductions mod p done outside the transforms (the CRT pass).
pub(crate) fn tally_reductions(n: u64) {
    tally(0, n, 0);
}

// (tests only: the word operations Table::new and conv_table perform,
// counted where they happen, against table_work's and conv_work's closed
// forms)
#[cfg(test)]
thread_local! {
    pub(crate) static WORK: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    // (the butterflies among them, for the 32-bit product's stage test)
    pub(crate) static BUTTERFLIES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}
#[cfg(test)]
fn count_butterflies(n: u64) {
    BUTTERFLIES.with(|c| c.set(c.get() + n));
}
#[cfg(not(test))]
#[inline(always)]
fn count_butterflies(_: u64) {}
#[cfg(test)]
pub(crate) fn count(n: u64) {
    WORK.with(|c| c.set(c.get() + n));
}
#[cfg(not(test))]
#[inline(always)]
pub(crate) fn count(_: u64) {}

/// A bound on [`Table::new`]'s word operations at `1 << log` points, N =
/// max(2^log, 2): two zero-filled N-word vectors (2N), the upper-half fill
/// (N / 2 steps of two products and two writes: 2N), the lower levels'
/// copies (fewer than N), two Shoup maps of N divisions counted 4 each (8N),
/// and the root and its inverse (two powers, at most 4 * 64 products).
pub const fn table_work(log: u32) -> Option<u64> {
    if log >= 63 {
        return None;
    }
    let n = if log == 0 { 2 } else { 1u64 << log };
    match n.checked_mul(16) {
        Some(x) => x.checked_add(512),
        None => None,
    }
}
/// A bound on [`conv_table`]'s word operations for a product of length
/// `len` (N = len padded to a power of two, `log` = log2 N): two loads (a
/// zero-filled N-word vector and at most N reductions each: 4N), two
/// forward transforms and one inverse ((N / 2) log N butterflies each), the
/// pointwise products (N), and the final reduction (at most N): at most
/// 3 (N / 2) log N + 6N, here 3 (N / 2) log N + 8N + 64.
pub const fn conv_work(log: u32) -> Option<u64> {
    if log >= 63 {
        return None;
    }
    let n = 1u64 << log;
    let butterflies = match (n / 2).checked_mul(3 * log as u64) {
        Some(x) => x,
        None => return None,
    };
    match n.checked_mul(8) {
        Some(x) => match butterflies.checked_add(x) {
            Some(y) => y.checked_add(64),
            None => None,
        },
        None => None,
    }
}
const CACHE_BYTES: usize = 1 << 28;
/// The tables table_cached has started building, over every cache.
pub(crate) static CACHE_BUILDS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub(crate) trait NttWord:
    Copy + Default + Ord + Add<Output = Self> + Sub<Output = Self> + Send + Sync + 'static
{
    type Modulus: Copy + Send + Sync;
    fn from_usize(x: usize) -> Self;
    fn modulus(p: Self) -> Self::Modulus;
    fn reduce(x: Self, m: Self::Modulus) -> Self;
    fn mul_mod(a: Self, b: Self, m: Self::Modulus) -> Self;
    fn inv_mod(a: Self, m: Self::Modulus) -> Self;
    fn pointwise(a: Self, b: Self, ninv: Self, ninvp: Self, p: Self, m: Self::Modulus) -> Self;
    fn root(m: Self::Modulus, primitive_root: Self, log: u32) -> (Self, Self);
    fn shoup(w: Self, p: Self) -> Self;
    fn mul_shoup_lazy(a: Self, w: Self, wp: Self, p: Self) -> Self;
}

pub(crate) struct Table<W: NttWord> {
    pub(crate) p: W,
    pub(crate) log: u32,
    modulus: W::Modulus,
    tw: Vec<W>,
    twp: Vec<W>,
    itw: Vec<W>,
    itwp: Vec<W>,
}

impl<W: NttWord> Table<W> {
    pub(crate) fn new(p: W, primitive_root: W, max_root_log: u32, log: u32) -> Table<W> {
        assert!(log <= max_root_log);
        let n = 1usize << log;
        let modulus = W::modulus(p);
        let (root, iroot) = W::root(modulus, primitive_root, log);
        let mut tw = vec![W::default(); n.max(2)];
        let mut itw = vec![W::default(); n.max(2)];
        count(256 + 2 * n.max(2) as u64);
        let half = n / 2;
        let (mut w, mut iw) = (W::from_usize(1), W::from_usize(1));
        for j in 0..half {
            if j & (BLOCK - 1) == 0 {
                sagebrush_interrupt::check_coarse();
            }
            tw[half + j] = w;
            itw[half + j] = iw;
            count(4);
            w = W::mul_mod(w, root, modulus);
            iw = W::mul_mod(iw, iroot, modulus);
        }
        let mut k = half / 2;
        while k >= 1 {
            for j in 0..k {
                if j & (BLOCK - 1) == 0 {
                    sagebrush_interrupt::check_coarse();
                }
                tw[k + j] = tw[2 * k + 2 * j];
                itw[k + j] = itw[2 * k + 2 * j];
                count(2);
            }
            k /= 2;
        }
        // (polled like the loops above: at the largest tables each map is
        // millions of divisions)
        let shoup_all = |v: &[W]| -> Vec<W> {
            let mut out = Vec::with_capacity(v.len());
            for (j, &x) in v.iter().enumerate() {
                if j & (BLOCK - 1) == 0 {
                    sagebrush_interrupt::check_coarse();
                }
                out.push(W::shoup(x, p));
                count(4);
            }
            out
        };
        let twp = shoup_all(&tw);
        let itwp = shoup_all(&itw);
        Table {
            p,
            log,
            modulus,
            tw,
            twp,
            itw,
            itwp,
        }
    }

    pub(crate) fn bytes(&self) -> usize {
        self.tw.len() * 4 * size_of::<W>()
    }
}

#[inline(always)]
fn dif_layer<W: NttWord>(lo: &mut [W], hi: &mut [W], w: &[W], wp: &[W], p: W) {
    count(lo.len() as u64);
    count_butterflies(lo.len() as u64);
    let p2 = p + p;
    for j in 0..lo.len() {
        let (x, y) = (lo[j], hi[j]);
        let s = x + y;
        lo[j] = if s >= p2 { s - p2 } else { s };
        hi[j] = W::mul_shoup_lazy(x + p2 - y, w[j], wp[j], p);
    }
}

#[inline(always)]
fn dit_layer<W: NttWord>(lo: &mut [W], hi: &mut [W], w: &[W], wp: &[W], p: W) {
    count(lo.len() as u64);
    count_butterflies(lo.len() as u64);
    let p2 = p + p;
    for j in 0..lo.len() {
        let mut x = lo[j];
        if x >= p2 {
            x = x - p2;
        }
        let t = W::mul_shoup_lazy(hi[j], w[j], wp[j], p);
        lo[j] = x + t;
        hi[j] = x + p2 - t;
    }
}

fn dif<W: NttWord>(a: &mut [W], t: &Table<W>) {
    let n = a.len();
    if n <= 1 {
        return;
    }
    if n > BLOCK {
        // (a layer of n / 2 butterflies, in BLOCK-sized chunks with a poll
        // between them: at most BLOCK butterflies between two polls, with no
        // branch in the butterfly loop)
        let (lo, hi) = a.split_at_mut(n / 2);
        let (w, wp) = (&t.tw[n / 2..n], &t.twp[n / 2..n]);
        for (((l, h), w), wp) in lo.chunks_mut(BLOCK).zip(hi.chunks_mut(BLOCK)).zip(w.chunks(BLOCK)).zip(wp.chunks(BLOCK)) {
            sagebrush_interrupt::check_coarse();
            dif_layer(l, h, w, wp, t.p);
            // (counted as done, chunk by chunk between the polls)
            tally(l.len() as u64, 0, 0);
        }
        dif(lo, t);
        dif(hi, t);
        return;
    }
    let mut m = n / 2;
    while m >= 1 {
        for chunk in a.chunks_exact_mut(2 * m) {
            let (lo, hi) = chunk.split_at_mut(m);
            dif_layer(lo, hi, &t.tw[m..2 * m], &t.twp[m..2 * m], t.p);
        }
        m /= 2;
    }
    // (no poll inside a block: its (n/2) log n butterflies, once done)
    tally((n / 2) as u64 * u64::from(n.trailing_zeros()), 0, 0);
}

fn dit<W: NttWord>(a: &mut [W], t: &Table<W>) {
    let n = a.len();
    if n <= 1 {
        return;
    }
    if n > BLOCK {
        let (lo, hi) = a.split_at_mut(n / 2);
        dit(lo, t);
        dit(hi, t);
        // (the layer in BLOCK-sized chunks with a poll between them, as in dif)
        let (w, wp) = (&t.itw[n / 2..n], &t.itwp[n / 2..n]);
        for (((l, h), w), wp) in lo.chunks_mut(BLOCK).zip(hi.chunks_mut(BLOCK)).zip(w.chunks(BLOCK)).zip(wp.chunks(BLOCK)) {
            sagebrush_interrupt::check_coarse();
            dit_layer(l, h, w, wp, t.p);
            tally(l.len() as u64, 0, 0);
        }
        return;
    }
    let mut m = 1;
    while m < n {
        for chunk in a.chunks_exact_mut(2 * m) {
            let (lo, hi) = chunk.split_at_mut(m);
            dit_layer(lo, hi, &t.itw[m..2 * m], &t.itwp[m..2 * m], t.p);
        }
        m *= 2;
    }
    tally((n / 2) as u64 * u64::from(n.trailing_zeros()), 0, 0);
}

pub(crate) fn conv_table<W: NttWord>(a: &[W], b: &[W], t: &Table<W>) -> Vec<W> {
    let len = a.len() + b.len() - 1;
    let log = len.next_power_of_two().trailing_zeros();
    assert!(log <= t.log);
    let n = 1usize << log;
    let p = t.p;
    let square = std::ptr::eq(a, b);
    // (the units are counted as each stage is done, never ahead of it: a
    // load's n zero-filled words and its inputs reduced; each transform's
    // (n/2) log n butterflies, in dif and dit; the n pointwise products;
    // the len final reductions)
    let load = |x: &[W]| {
        count((n + x.len()) as u64);
        let mut f = vec![W::default(); n];
        for (d, &s) in f.iter_mut().zip(x) {
            *d = W::reduce(s, t.modulus);
        }
        tally(0, x.len() as u64, n as u64);
        f
    };
    sagebrush_interrupt::check_coarse();
    let mut fa = load(a);
    sagebrush_interrupt::check_coarse();
    dif(&mut fa, t);
    let fb = if square {
        None
    } else {
        let mut fb = load(b);
        sagebrush_interrupt::check_coarse();
        dif(&mut fb, t);
        Some(fb)
    };
    let ninv = W::inv_mod(W::from_usize(n), t.modulus);
    let ninvp = W::shoup(ninv, p);
    count(n as u64);
    for i in 0..n {
        let x = if fa[i] >= p { fa[i] - p } else { fa[i] };
        let y0 = fb.as_ref().map_or(x, |v| v[i]);
        let y = if y0 >= p { y0 - p } else { y0 };
        fa[i] = W::pointwise(x, y, ninv, ninvp, p, t.modulus);
    }
    tally(n as u64, 0, 0);
    sagebrush_interrupt::check_coarse();
    dit(&mut fa, t);
    sagebrush_interrupt::check_coarse();
    fa.truncate(len);
    count(len as u64);
    let p2 = p + p;
    for x in &mut fa {
        if *x >= p2 {
            *x = *x - p2;
        }
        if *x >= p {
            *x = *x - p;
        }
    }
    tally(0, len as u64, 0);
    fa
}

/// The convolution of a and b at exactly the table's 2^log points, for a
/// product of at most 2^log + 1 coefficients: when it has 2^log + 1, the
/// last, a_last b_last, wraps onto index 0 and is taken off there (modulo
/// p), and the caller adds it back exactly.  The first min(len, 2^log)
/// coefficients, each in [0, p).  Counted as conv_table at 2^log points
/// (one more for the fold).
#[cfg_attr(not(any(test, target_pointer_width = "32")), allow(dead_code))]
pub(crate) fn conv_table_cyclic<W: NttWord>(a: &[W], b: &[W], t: &Table<W>) -> Vec<W> {
    let len = a.len() + b.len() - 1;
    let n = 1usize << t.log;
    assert!(len <= n + 1);
    let p = t.p;
    // (counted as conv_table, stage by stage as done: two loads, three
    // transforms, n pointwise products, min(len, n) final reductions, and
    // the fold's product)
    let load = |x: &[W]| {
        count((n + x.len()) as u64);
        let mut f = vec![W::default(); n];
        for (d, &s) in f.iter_mut().zip(x) {
            *d = W::reduce(s, t.modulus);
        }
        tally(0, x.len() as u64, n as u64);
        f
    };
    sagebrush_interrupt::check_coarse();
    let mut fa = load(a);
    sagebrush_interrupt::check_coarse();
    dif(&mut fa, t);
    let mut fb = load(b);
    sagebrush_interrupt::check_coarse();
    dif(&mut fb, t);
    let ninv = W::inv_mod(W::from_usize(n), t.modulus);
    let ninvp = W::shoup(ninv, p);
    count(n as u64);
    for i in 0..n {
        let x = if fa[i] >= p { fa[i] - p } else { fa[i] };
        let y = if fb[i] >= p { fb[i] - p } else { fb[i] };
        fa[i] = W::pointwise(x, y, ninv, ninvp, p, t.modulus);
    }
    tally(n as u64, 0, 0);
    drop(fb);
    sagebrush_interrupt::check_coarse();
    dit(&mut fa, t);
    sagebrush_interrupt::check_coarse();
    let kept = len.min(n);
    fa.truncate(kept);
    count(kept as u64 + 1);
    let p2 = p + p;
    for x in &mut fa {
        if *x >= p2 {
            *x = *x - p2;
        }
        if *x >= p {
            *x = *x - p;
        }
    }
    if len == n + 1 {
        // (index 0 holds c_0 + c_n, c_n = a_last b_last: take it off)
        let top = W::mul_mod(W::reduce(a[a.len() - 1], t.modulus), W::reduce(b[b.len() - 1], t.modulus), t.modulus);
        fa[0] = if fa[0] >= top { fa[0] - top } else { fa[0] + p - top };
        tally(0, 1, 0);
    }
    tally(0, kept as u64, 0);
    fa
}

fn table_bytes<W: NttWord>(t: &Table<W>) -> usize {
    t.bytes()
}

pub(crate) fn cache_stats<W: NttWord>(cache: &Mutex<Vec<Arc<Table<W>>>>) -> (usize, usize) {
    let cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    (cache.len(), cache.iter().map(|t| table_bytes(t)).sum())
}

pub(crate) fn table_cached<W: NttWord>(
    cache: &Mutex<Vec<Arc<Table<W>>>>,
    p: W,
    primitive_root: W,
    max_root_log: u32,
    log: u32,
    max_tables: usize,
) -> Arc<Table<W>> {
    let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(i) = cache.iter().position(|t| t.p == p && t.log >= log) {
        let t = cache.remove(i);
        cache.push(t.clone());
        return t;
    }
    // Built under the lock, so concurrent misses never build the same large
    // table twice.  Natively a Stop (or any panic) inside Table::new is
    // caught here: the partial table has dropped, the guard is released
    // normally (the mutex is not poisoned, nothing was published), and the
    // same payload continues outside the critical section.  In WebAssembly
    // a panic traps instead and the host discards the whole engine
    // instance, this cache with it.
    CACHE_BUILDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Table::new(p, primitive_root, max_root_log, log)));
    let t = match built {
        Ok(t) => Arc::new(t),
        Err(payload) => {
            drop(cache);
            std::panic::resume_unwind(payload)
        }
    };
    cache.retain(|t| t.p != p);
    let mut total = cache.iter().map(|t| table_bytes(t)).sum::<usize>() + table_bytes(&t);
    while !cache.is_empty() && (cache.len() >= max_tables || total > CACHE_BYTES) {
        total -= table_bytes(&cache[0]);
        cache.remove(0);
    }
    cache.push(t.clone());
    t
}

#[cfg(test)]
mod table_work_tests {
    use super::*;

    #[test]
    fn table_work_bounds_the_counted_build() {
        for log in [0u32, 1, 2, 3, 8, 12, 13, 16, 18] {
            WORK.with(|c| c.set(0));
            let (p, g) = crate::ntt::PRIMES[0];
            let t = Table::<u64>::new(p, g, (p - 1).trailing_zeros(), log);
            let counted = WORK.with(|c| c.get());
            let bound = table_work(log).unwrap();
            assert!(counted <= bound, "log {}: counted {} > bound {}", log, counted, bound);
            drop(t);
        }
        // (16 * 2^59 + 512 fits a u64; 16 * 2^60 does not: None, never a wrapped bound)
        assert!(table_work(59).is_some() && table_work(60).is_none() && table_work(63).is_none());
    }
}
