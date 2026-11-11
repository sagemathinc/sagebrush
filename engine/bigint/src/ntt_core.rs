//! The transform machinery shared by the native and wasm limb widths.

use std::mem::size_of;
use std::ops::{Add, Sub};
use std::sync::{Arc, Mutex};

const BLOCK: usize = 1 << 12;
const CACHE_BYTES: usize = 1 << 28;

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
        let half = n / 2;
        let (mut w, mut iw) = (W::from_usize(1), W::from_usize(1));
        for j in 0..half {
            if j & (BLOCK - 1) == 0 {
                sagebrush_interrupt::check_coarse();
            }
            tw[half + j] = w;
            itw[half + j] = iw;
            w = W::mul_mod(w, root, modulus);
            iw = W::mul_mod(iw, iroot, modulus);
        }
        let mut k = half / 2;
        while k >= 1 {
            for j in 0..k {
                tw[k + j] = tw[2 * k + 2 * j];
                itw[k + j] = itw[2 * k + 2 * j];
            }
            k /= 2;
        }
        let twp = tw.iter().map(|&x| W::shoup(x, p)).collect();
        let itwp = itw.iter().map(|&x| W::shoup(x, p)).collect();
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
        sagebrush_interrupt::check_coarse();
        let (lo, hi) = a.split_at_mut(n / 2);
        dif_layer(lo, hi, &t.tw[n / 2..n], &t.twp[n / 2..n], t.p);
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
        sagebrush_interrupt::check_coarse();
        dit_layer(lo, hi, &t.itw[n / 2..n], &t.itwp[n / 2..n], t.p);
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
}

pub(crate) fn conv_table<W: NttWord>(a: &[W], b: &[W], t: &Table<W>) -> Vec<W> {
    let len = a.len() + b.len() - 1;
    let log = len.next_power_of_two().trailing_zeros();
    assert!(log <= t.log);
    let n = 1usize << log;
    let p = t.p;
    let load = |x: &[W]| {
        let mut f = vec![W::default(); n];
        for (d, &s) in f.iter_mut().zip(x) {
            *d = W::reduce(s, t.modulus);
        }
        f
    };
    sagebrush_interrupt::check_coarse();
    let mut fa = load(a);
    sagebrush_interrupt::check_coarse();
    dif(&mut fa, t);
    let square = std::ptr::eq(a, b);
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
    for i in 0..n {
        let x = if fa[i] >= p { fa[i] - p } else { fa[i] };
        let y0 = fb.as_ref().map_or(x, |v| v[i]);
        let y = if y0 >= p { y0 - p } else { y0 };
        fa[i] = W::pointwise(x, y, ninv, ninvp, p, t.modulus);
    }
    sagebrush_interrupt::check_coarse();
    dit(&mut fa, t);
    sagebrush_interrupt::check_coarse();
    fa.truncate(len);
    let p2 = p + p;
    for x in &mut fa {
        if *x >= p2 {
            *x = *x - p2;
        }
        if *x >= p {
            *x = *x - p;
        }
    }
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
    let t = Arc::new(Table::new(p, primitive_root, max_root_log, log));
    cache.retain(|t| t.p != p);
    let mut total = cache.iter().map(|t| table_bytes(t)).sum::<usize>() + table_bytes(&t);
    while !cache.is_empty() && (cache.len() >= max_tables || total > CACHE_BYTES) {
        total -= table_bytes(&cache[0]);
        cache.remove(0);
    }
    cache.push(t.clone());
    t
}
