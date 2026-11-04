//! C = A * B on column-major f64 matrices, BLIS-style (Goto and van de Geijn): B is packed in KC x NC
//! blocks into NR-column panels, A in MC x KC blocks into MR-row panels, and the microkernel ([`crate::micro`])
//! runs on one MR x NR tile at a time. Threads split C by columns ([`partition`]): each thread packs its own
//! panels into its own scratch and writes its own columns of C, so threads share no mutable state.
//!
//! Summation order (the determinism rule, r4.2 §7): for each element, the KC blocks in order; within a
//! block, p in order; each block's partial sum is added into C. It doesn't depend on the partition.

use crate::micro::{tile, MR, NR};

/// k-block (the packed panels' depth)
pub const KC: usize = 256;
/// row block of A packed at once
pub const MC: usize = 96;
/// column block of B packed at once
pub const NC: usize = 512;

/// The scratch one thread needs, in f64s: a packed A block and a packed B block.
pub const fn scratch_len() -> usize {
    MC * KC + KC * NC
}

/// The number of elements a column-major `rows x cols` matrix with leading dimension `ld` spans:
/// `(cols - 1) * ld + rows`, 0 when empty; `None` when `ld < max(rows, 1)` or the span overflows.
pub fn span(rows: usize, cols: usize, ld: usize) -> Option<usize> {
    if ld < rows.max(1) {
        return None;
    }
    if rows == 0 || cols == 0 {
        return Some(0);
    }
    (cols - 1).checked_mul(ld)?.checked_add(rows)
}

/// A column-major matrix view: element (i, j) is `data[i + j * ld]`. Its fields are private, so the only way
/// to make one is [`Mat::new`], which checks the invariant every kernel relies on: `ld >= max(rows, 1)` and
/// `data` holds every element.
#[derive(Clone, Copy)]
pub struct Mat<'a> {
    data: &'a [f64],
    rows: usize,
    cols: usize,
    ld: usize,
}

impl<'a> Mat<'a> {
    /// a view, checked (with overflow-checked arithmetic): `ld >= max(rows, 1)` and `data` holds every element
    pub fn new(data: &'a [f64], rows: usize, cols: usize, ld: usize) -> Option<Self> {
        if data.len() < span(rows, cols, ld)? {
            return None;
        }
        Some(Mat { data, rows, cols, ld })
    }
    pub fn rows(&self) -> usize {
        self.rows
    }
    pub fn cols(&self) -> usize {
        self.cols
    }
    pub fn ld(&self) -> usize {
        self.ld
    }
    #[inline]
    fn at(&self, i: usize, j: usize) -> f64 {
        self.data[i + j * self.ld]
    }
}

/// The columns of C thread `id` of `threads` computes, `[j0, j1)`: blocks of NR columns dealt evenly, fixed
/// by (n, threads) only, so the threads' ranges are disjoint and cover 0..n. An `id` at or beyond `threads`
/// gets the empty range (n, n). (Overflow-free: the products saturate, then are clamped to n.)
pub fn partition(n: usize, threads: usize, id: usize) -> (usize, usize) {
    let t = threads.max(1);
    if id >= t {
        return (n, n);
    }
    let per = n.div_ceil(NR).div_ceil(t).saturating_mul(NR);
    (id.saturating_mul(per).min(n), id.saturating_add(1).saturating_mul(per).min(n))
}

/// Pack rows i0..i0+mc, columns p0..p0+kc of A into MR-row panels (zero-padded to a multiple of MR).
fn pack_a(a: &Mat, i0: usize, mc: usize, p0: usize, kc: usize, out: &mut [f64]) {
    let mut o = 0;
    let mut i = 0;
    while i < mc {
        let rows = MR.min(mc - i);
        for p in 0..kc {
            for r in 0..MR {
                out[o] = if r < rows { a.at(i0 + i + r, p0 + p) } else { 0.0 };
                o += 1;
            }
        }
        i += MR;
    }
}

/// Pack rows p0..p0+kc, columns j0..j0+nc of B into NR-column panels (zero-padded to a multiple of NR).
fn pack_b(b: &Mat, p0: usize, kc: usize, j0: usize, nc: usize, out: &mut [f64]) {
    let mut o = 0;
    let mut j = 0;
    while j < nc {
        let cols = NR.min(nc - j);
        for p in 0..kc {
            for c in 0..NR {
                out[o] = if c < cols { b.at(p0 + p, j0 + j + c) } else { 0.0 };
                o += 1;
            }
        }
        j += NR;
    }
}

/// Columns j_begin..j_end of C = A * B, written into `c_cols`, which holds exactly those columns of C
/// (column-major, leading dimension `ldc`: element (i, j) at `c_cols[i + (j - j_begin) * ldc]`).
/// `scratch` has at least [`scratch_len`] elements. A is m x k, B is k x n.
///
/// Errors (dimension mismatch, short buffers, an overflowing layout) return `false` without writing anything:
/// every check comes before the first write.
pub fn gemm_cols(a: &Mat, b: &Mat, c_cols: &mut [f64], ldc: usize, j_begin: usize, j_end: usize, scratch: &mut [f64]) -> bool {
    let (m, k) = (a.rows, a.cols);
    if b.rows != k || j_begin > j_end || j_end > b.cols || scratch.len() < scratch_len() {
        return false;
    }
    let ncols = j_end - j_begin;
    match span(m, ncols, ldc) {
        Some(need) if c_cols.len() >= need => {}
        _ => return false,
    }
    if m == 0 {
        return true;
    }
    // C := 0, then accumulate each KC block (also covers k == 0: C = 0)
    for j in 0..ncols {
        c_cols[j * ldc..j * ldc + m].fill(0.0);
    }
    if k == 0 {
        return true;
    }
    let (sa, sb) = scratch.split_at_mut(MC * KC);
    let mut acc = [0.0f64; MR * NR];
    let mut jc = j_begin;
    while jc < j_end {
        let nc = NC.min(j_end - jc);
        let mut pc = 0;
        while pc < k {
            let kc = KC.min(k - pc);
            pack_b(b, pc, kc, jc, nc, sb);
            let mut ic = 0;
            while ic < m {
                let mc = MC.min(m - ic);
                pack_a(a, ic, mc, pc, kc, sa);
                let mut jr = 0;
                while jr < nc {
                    let cols = NR.min(nc - jr);
                    let bp = &sb[(jr / NR) * kc * NR..];
                    let mut ir = 0;
                    while ir < mc {
                        let rows = MR.min(mc - ir);
                        let ap = &sa[(ir / MR) * kc * MR..];
                        tile(kc, ap, bp, &mut acc);
                        for cj in 0..cols {
                            let base = (jc - j_begin + jr + cj) * ldc + ic + ir;
                            let dst = &mut c_cols[base..base + rows];
                            for (r, d) in dst.iter_mut().enumerate() {
                                *d += acc[cj * MR + r];
                            }
                        }
                        ir += MR;
                    }
                    jr += NR;
                }
                ic += MC;
            }
            pc += KC;
        }
        jc += NC;
    }
    true
}

/// C = A * B with up to `threads` threads (natively through engine/par when the `parallel` feature is on;
/// otherwise on the calling thread). `c` is m x n column-major with leading dimension m.
#[cfg(any(test, feature = "parallel"))]
pub fn gemm(a: &Mat, b: &Mat, c: &mut [f64], threads: usize) -> bool {
    extern crate std;
    use std::vec;
    let (m, n) = (a.rows, b.cols);
    let Some(mn) = m.checked_mul(n) else { return false };
    if b.rows != a.cols || c.len() < mn {
        return false;
    }
    let t = threads.max(1);
    // each thread's columns: contiguous chunks of C (leading dimension m)
    let (_, j1) = partition(n, t, 0);
    let chunk_cols = j1.max(1);
    if m == 0 || n == 0 {
        return gemm_cols(a, b, c, m.max(1), 0, n, &mut vec![0.0; scratch_len()]);
    }
    let Some(chunk) = chunk_cols.checked_mul(m) else { return false };
    #[cfg(feature = "parallel")]
    {
        let ok = core::sync::atomic::AtomicBool::new(true);
        sagebrush_par::install(t, || {
            sagebrush_par::for_each_chunk_mut(&mut c[..mn], chunk, |id, cs| {
                let j0 = id * chunk_cols;
                let j1 = (j0 + chunk_cols).min(n);
                let mut s = vec![0.0; scratch_len()];
                if !gemm_cols(a, b, cs, m, j0, j1, &mut s) {
                    ok.store(false, core::sync::atomic::Ordering::Relaxed);
                }
            })
        });
        ok.into_inner()
    }
    #[cfg(not(feature = "parallel"))]
    {
        let mut s = vec![0.0; scratch_len()];
        for (id, cs) in c[..mn].chunks_mut(chunk).enumerate() {
            let j0 = id * chunk_cols;
            let j1 = (j0 + chunk_cols).min(n);
            if !gemm_cols(a, b, cs, m, j0, j1, &mut s) {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64) / ((1u64 << 53) as f64) - 0.5
    }

    fn naive(a: &Mat, b: &Mat) -> Vec<f64> {
        let (m, n, k) = (a.rows, b.cols, a.cols);
        let mut c = vec![0.0; m * n];
        for j in 0..n {
            for i in 0..m {
                let mut s = 0.0;
                for p in 0..k {
                    s += a.at(i, p) * b.at(p, j);
                }
                c[i + j * m] = s;
            }
        }
        c
    }

    fn check(m: usize, n: usize, k: usize, threads: &[usize]) {
        let mut s = 1 + (m * 1000003 + n * 1009 + k) as u64;
        let av: Vec<f64> = (0..m * k).map(|_| lcg(&mut s)).collect();
        let bv: Vec<f64> = (0..k * n).map(|_| lcg(&mut s)).collect();
        let a = Mat::new(&av, m, k, m.max(1)).unwrap();
        let b = Mat::new(&bv, k, n, k.max(1)).unwrap();
        let r = naive(&a, &b);
        // the oracle bound (r4.2 §7): |C - C_ref| <= c k u |A||B| elementwise; |entries| <= 1/2 so |A||B| <= k/4
        let tol = 10.0 * (k.max(1) as f64) * f64::EPSILON * (k.max(1) as f64) / 4.0;
        let mut first: Option<Vec<f64>> = None;
        for &t in threads {
            let mut c = vec![f64::NAN; m * n];
            assert!(gemm(&a, &b, &mut c, t), "gemm refused {m}x{k} * {k}x{n}");
            for (x, y) in c.iter().zip(&r) {
                assert!((x - y).abs() <= tol, "{m}x{k}*{k}x{n} t={t}: {x} vs {y}");
            }
            // bit-identical across thread counts
            match &first {
                None => first = Some(c),
                Some(f) => assert!(f.iter().zip(&c).all(|(x, y)| x.to_bits() == y.to_bits()), "t={t} differs bitwise from t={}", threads[0]),
            }
        }
    }

    #[test]
    fn shapes_and_threads() {
        for &(m, n, k) in &[(1, 1, 1), (3, 5, 7), (4, 4, 4), (17, 13, 9), (96, 96, 256), (97, 513, 257), (130, 70, 600), (0, 5, 3), (5, 0, 3), (5, 4, 0)] {
            check(m, n, k, &[1, 2, 3, 8]);
        }
    }

    /// The seeded inputs shared with test/nd-wasm.test.ts: a 32-bit LCG, exact in f64 in Rust and JS.
    pub(crate) fn seeded(count: usize, seed: &mut u32) -> Vec<f64> {
        (0..count)
            .map(|_| {
                *seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
                f64::from(*seed) / 4294967296.0 - 0.5
            })
            .collect()
    }

    /// FNV-1a over the f64 bits, as test/nd-wasm.test.ts computes it.
    pub(crate) fn fnv(c: &[f64]) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for x in c {
            for byte in x.to_bits().to_le_bytes() {
                h = (h ^ u64::from(byte)).wrapping_mul(0x100000001b3);
            }
        }
        h
    }

    /// The cross-microkernel pin (r4.2 §7; grader T2): C for this seeded 97 x 257 x 513 product (k crosses a
    /// KC block) hashes to the same value from every microkernel. This native run uses the scalar one; the
    /// Wasm SIMD128 one must give the same bits (test/nd-wasm.test.ts, on the committed module). A fused
    /// multiply-add or any reordering in either kernel changes the bits.
    pub(crate) const CROSS_KERNEL_FNV: u64 = 0x364c3cb66df0cabb;

    #[test]
    fn cross_kernel_bits() {
        let (m, k, n) = (97, 257, 513);
        let mut seed = 2026u32;
        let av = seeded(m * k, &mut seed);
        let bv = seeded(k * n, &mut seed);
        let a = Mat::new(&av, m, k, m).unwrap();
        let b = Mat::new(&bv, k, n, k).unwrap();
        let mut c = vec![0.0; m * n];
        assert!(gemm(&a, &b, &mut c, 1));
        assert_eq!(fnv(&c), CROSS_KERNEL_FNV, "C's bits: {:#018x}", fnv(&c));
    }

    #[test]
    fn partition_covers_once() {
        for n in [0, 1, 3, 4, 5, 63, 64, 1000] {
            for t in 1..10 {
                let mut next = 0;
                for id in 0..t {
                    let (j0, j1) = partition(n, t, id);
                    assert!(j0 <= j1 && j1 <= n);
                    if j0 < j1 {
                        assert_eq!(j0, next);
                        next = j1;
                    }
                }
                assert_eq!(next, n);
            }
        }
    }

    #[test]
    fn overflow_and_bad_layouts_are_refused_without_writing() {
        let v = vec![1.0; 16];
        // spans that overflow, near usize::MAX
        assert!(Mat::new(&v, 2, usize::MAX, usize::MAX / 2).is_none());
        assert!(Mat::new(&v, usize::MAX, 2, usize::MAX).is_none());
        assert!(span(1, usize::MAX, 2).is_none());
        assert!(Mat::new(&v, 4, 4, 0).is_none());
        // gemm_cols: a C layout whose span overflows, a short C, a short scratch: false, C untouched
        let a = Mat::new(&v, 4, 4, 4).unwrap();
        let b = Mat::new(&v, 4, 4, 4).unwrap();
        let mut s = vec![0.0; scratch_len()];
        let mut c = vec![7.0; 16];
        assert!(!gemm_cols(&a, &b, &mut c, usize::MAX, 0, 4, &mut s));
        assert!(!gemm_cols(&a, &b, &mut c[..15], 4, 0, 4, &mut s));
        assert!(!gemm_cols(&a, &b, &mut c, 3, 0, 4, &mut s));
        assert!(!gemm_cols(&a, &b, &mut c, 4, 0, 5, &mut s));
        assert!(!gemm_cols(&a, &b, &mut c, 4, 0, 4, &mut s[..10]));
        assert!(c.iter().all(|&x| x == 7.0), "a refused call wrote C");
        // partition near usize::MAX: no panic, ranges within n, beyond-threads ids empty
        for &(n, t, id) in &[(usize::MAX, 3, 2), (usize::MAX, usize::MAX, usize::MAX - 1), (10, 4, 4), (10, 4, 99)] {
            let (j0, j1) = partition(n, t, id);
            assert!(j0 <= j1 && j1 <= n);
        }
        assert_eq!(partition(10, 4, 4), (10, 10));
    }

    #[test]
    fn refuses_bad_shapes() {
        let v = vec![0.0; 16];
        let a = Mat::new(&v, 4, 4, 4).unwrap();
        let b = Mat::new(&v, 3, 4, 3).unwrap();
        let mut c = vec![0.0; 16];
        assert!(!gemm(&a, &b, &mut c, 1));
        assert!(Mat::new(&v, 4, 5, 4).is_none());
        assert!(Mat::new(&v, 4, 4, 3).is_none());
    }
}
