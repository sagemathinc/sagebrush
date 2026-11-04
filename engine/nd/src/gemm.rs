//! C = A * B on column-major f64 matrices, BLIS-style (Goto and van de Geijn): B is packed in KC x NC
//! blocks into NR-column panels, A in MC x KC blocks into MR-row panels, and a microkernel ([`crate::micro`])
//! runs on one MR x NR tile at a time. The blocking is written once, generic over the kernel
//! ([`gemm_cols_with`]); [`Kernel`] is the kernel selected for this build and CPU. Threads split C by columns
//! ([`partition`]): each thread packs its own panels into its own scratch and writes its own columns of C,
//! so threads share no mutable state.
//!
//! Summation order (the determinism rule, r4.2 §7): for each element, the KC blocks in order; within a
//! block, p in order; each block's partial sum is added into C. It doesn't depend on the partition.

#[allow(unused_imports)]
use crate::micro::{Micro, Scalar, ACC_LEN};

/// k-block (the packed panels' depth)
pub const KC: usize = 256;
/// row block of A packed at once, at most (each kernel's is the largest multiple of its MR not above it)
pub const MC: usize = 96;
/// column block of B packed at once, at most (each kernel's is the largest multiple of its NR not above it)
pub const NC: usize = 512;

/// A kernel's row block: a whole number of its MR-row panels, so a packed block never outgrows the scratch.
const fn mc_of(mr: usize) -> usize {
    MC / mr * mr
}
/// A kernel's column block: a whole number of its NR-column panels (NC = 512 isn't a multiple of 6).
const fn nc_of(nr: usize) -> usize {
    NC / nr * nr
}

/// The scratch one thread needs, in f64s, for any kernel: a packed A block and a packed B block.
pub const fn scratch_len() -> usize {
    MC * KC + KC * NC
}

/// The kernel this build and CPU use, chosen once ([`Kernel::selected`]) and recorded with every result.
#[derive(Clone, Copy)]
pub enum Kernel {
    /// the portable kernel (no FMA), 4 x 4 (not in a SIMD Wasm module, which never selects it)
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    Scalar,
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    Simd128,
    #[cfg(target_arch = "x86_64")]
    Avx2Fma(crate::micro::Avx2Fma),
    #[cfg(target_arch = "aarch64")]
    Neon,
}

impl Kernel {
    /// The fastest kernel this build and CPU may use: on Wasm, the module's own (one SIMD level per module);
    /// natively, AVX2+FMA if the CPU has it, else the portable one. (NEON is compiled but not selected until
    /// a CI host executes it: micro::NEON_ENABLED.) Natively the CPU check runs once and is cached.
    pub fn selected() -> Kernel {
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        return Kernel::Simd128;
        #[cfg(target_arch = "x86_64")]
        {
            extern crate std;
            static SELECTED: std::sync::OnceLock<Kernel> = std::sync::OnceLock::new();
            return *SELECTED.get_or_init(|| crate::micro::Avx2Fma::detect().map_or(Kernel::Scalar, Kernel::Avx2Fma));
        }
        #[cfg(target_arch = "aarch64")]
        return if crate::micro::NEON_ENABLED { Kernel::Neon } else { Kernel::Scalar };
        #[cfg(not(any(all(target_arch = "wasm32", target_feature = "simd128"), target_arch = "x86_64", target_arch = "aarch64")))]
        Kernel::Scalar
    }

    /// The kernel's name, recorded with every result (r4.2 §12).
    pub fn name(self) -> &'static str {
        match self {
            #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
            Kernel::Scalar => <Scalar<4, 4> as Micro>::NAME,
            #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
            Kernel::Simd128 => <crate::micro::Simd128 as Micro>::NAME,
            #[cfg(target_arch = "x86_64")]
            Kernel::Avx2Fma(_) => <crate::micro::Avx2Fma as Micro>::NAME,
            #[cfg(target_arch = "aarch64")]
            Kernel::Neon => <crate::micro::Neon as Micro>::NAME,
        }
    }

    /// The kernel's tile width (threads split C in blocks of it: [`partition`]).
    pub fn nr(self) -> usize {
        match self {
            #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
            Kernel::Scalar => 4,
            #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
            Kernel::Simd128 => <crate::micro::Simd128 as Micro>::NR,
            #[cfg(target_arch = "x86_64")]
            Kernel::Avx2Fma(_) => <crate::micro::Avx2Fma as Micro>::NR,
            #[cfg(target_arch = "aarch64")]
            Kernel::Neon => <crate::micro::Neon as Micro>::NR,
        }
    }

    /// [`gemm_cols_with`] on this kernel.
    pub fn gemm_cols(self, a: &Mat, b: &Mat, c_cols: &mut [f64], ldc: usize, j_begin: usize, j_end: usize, scratch: &mut [f64]) -> bool {
        match self {
            #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
            Kernel::Scalar => gemm_cols_with(&Scalar::<4, 4>, a, b, c_cols, ldc, j_begin, j_end, scratch),
            #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
            Kernel::Simd128 => gemm_cols_with(&crate::micro::Simd128, a, b, c_cols, ldc, j_begin, j_end, scratch),
            #[cfg(target_arch = "x86_64")]
            Kernel::Avx2Fma(k) => gemm_cols_with(&k, a, b, c_cols, ldc, j_begin, j_end, scratch),
            #[cfg(target_arch = "aarch64")]
            Kernel::Neon => gemm_cols_with(&crate::micro::Neon, a, b, c_cols, ldc, j_begin, j_end, scratch),
        }
    }
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

/// The columns of C thread `id` of `threads` computes, `[j0, j1)`: blocks of `nr` columns (the kernel's tile
/// width) dealt evenly, fixed by (n, threads, nr) only, so the threads' ranges are disjoint and cover 0..n. An
/// `id` at or beyond `threads` gets the empty range (n, n). (Overflow-free: the products saturate, then are
/// clamped to n.) The partition decides only who computes a column, never how: the bits don't depend on it.
pub fn partition(n: usize, threads: usize, id: usize, nr: usize) -> (usize, usize) {
    let t = threads.max(1);
    if id >= t {
        return (n, n);
    }
    let nr = nr.max(1);
    let per = n.div_ceil(nr).div_ceil(t).saturating_mul(nr);
    (id.saturating_mul(per).min(n), id.saturating_add(1).saturating_mul(per).min(n))
}

/// Pack rows i0..i0+mc, columns p0..p0+kc of A into `mr`-row panels (zero-padded to a multiple of mr).
fn pack_a(a: &Mat, i0: usize, mc: usize, p0: usize, kc: usize, mr: usize, out: &mut [f64]) {
    let mut o = 0;
    let mut i = 0;
    while i < mc {
        let rows = mr.min(mc - i);
        for p in 0..kc {
            for r in 0..mr {
                out[o] = if r < rows { a.at(i0 + i + r, p0 + p) } else { 0.0 };
                o += 1;
            }
        }
        i += mr;
    }
}

/// Pack rows p0..p0+kc, columns j0..j0+nc of B into `nr`-column panels (zero-padded to a multiple of nr).
fn pack_b(b: &Mat, p0: usize, kc: usize, j0: usize, nc: usize, nr: usize, out: &mut [f64]) {
    let mut o = 0;
    let mut j = 0;
    while j < nc {
        let cols = nr.min(nc - j);
        for p in 0..kc {
            for c in 0..nr {
                out[o] = if c < cols { b.at(p0 + p, j0 + j + c) } else { 0.0 };
                o += 1;
            }
        }
        j += nr;
    }
}

/// [`gemm_cols_with`] on the selected kernel ([`Kernel::selected`]).
pub fn gemm_cols(a: &Mat, b: &Mat, c_cols: &mut [f64], ldc: usize, j_begin: usize, j_end: usize, scratch: &mut [f64]) -> bool {
    Kernel::selected().gemm_cols(a, b, c_cols, ldc, j_begin, j_end, scratch)
}

/// Columns j_begin..j_end of C = A * B with microkernel `kern`, written into `c_cols`, which holds exactly those
/// columns of C (column-major, leading dimension `ldc`: element (i, j) at `c_cols[i + (j - j_begin) * ldc]`).
/// `scratch` has at least [`scratch_len`] elements. A is m x k, B is k x n.
///
/// Errors (dimension mismatch, short buffers, an overflowing layout) return `false` without writing anything:
/// every check comes before the first write.
#[allow(clippy::too_many_arguments)]
pub fn gemm_cols_with<K: Micro>(kern: &K, a: &Mat, b: &Mat, c_cols: &mut [f64], ldc: usize, j_begin: usize, j_end: usize, scratch: &mut [f64]) -> bool {
    let (mr, nr) = (K::MR, K::NR);
    // (a kernel's tile must be nonempty and fit the accumulator, checked before anything divides by it)
    if mr == 0 || nr == 0 || mr.checked_mul(nr).is_none_or(|t| t > ACC_LEN) {
        return false;
    }
    let (mcb, ncb) = (mc_of(mr), nc_of(nr));
    if mcb == 0 || ncb == 0 {
        return false;
    }
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
    let mut acc = [0.0f64; ACC_LEN];
    let mut jc = j_begin;
    while jc < j_end {
        let nc = ncb.min(j_end - jc);
        let mut pc = 0;
        while pc < k {
            let kc = KC.min(k - pc);
            pack_b(b, pc, kc, jc, nc, nr, sb);
            let mut ic = 0;
            while ic < m {
                let mc = mcb.min(m - ic);
                pack_a(a, ic, mc, pc, kc, mr, sa);
                let mut jr = 0;
                while jr < nc {
                    let cols = nr.min(nc - jr);
                    let bp = &sb[(jr / nr) * kc * nr..];
                    let mut ir = 0;
                    while ir < mc {
                        let rows = mr.min(mc - ir);
                        let ap = &sa[(ir / mr) * kc * mr..];
                        kern.tile(kc, ap, bp, &mut acc);
                        for cj in 0..cols {
                            let base = (jc - j_begin + jr + cj) * ldc + ic + ir;
                            let dst = &mut c_cols[base..base + rows];
                            for (r, d) in dst.iter_mut().enumerate() {
                                *d += acc[cj * mr + r];
                            }
                        }
                        ir += mr;
                    }
                    jr += nr;
                }
                ic += mcb;
            }
            pc += KC;
        }
        jc += ncb;
    }
    true
}

/// C = A * B on the selected kernel with up to `threads` threads (natively through engine/par when the
/// `parallel` feature is on; otherwise on the calling thread). `c` is m x n column-major with leading
/// dimension m.
#[cfg(any(test, feature = "parallel"))]
pub fn gemm(a: &Mat, b: &Mat, c: &mut [f64], threads: usize) -> bool {
    gemm_on(Kernel::selected(), a, b, c, threads)
}

/// [`gemm`] on a given kernel (tests compare kernels on the same inputs).
#[cfg(any(test, feature = "parallel"))]
pub fn gemm_on(kern: Kernel, a: &Mat, b: &Mat, c: &mut [f64], threads: usize) -> bool {
    extern crate std;
    use std::vec;
    let (m, n) = (a.rows, b.cols);
    let Some(mn) = m.checked_mul(n) else { return false };
    if b.rows != a.cols || c.len() < mn {
        return false;
    }
    let t = threads.max(1);
    // each thread's columns: contiguous chunks of C (leading dimension m)
    let (_, j1) = partition(n, t, 0, kern.nr());
    let chunk_cols = j1.max(1);
    if m == 0 || n == 0 {
        return kern.gemm_cols(a, b, c, m.max(1), 0, n, &mut vec![0.0; scratch_len()]);
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
                if !kern.gemm_cols(a, b, cs, m, j0, j1, &mut s) {
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
            if !kern.gemm_cols(a, b, cs, m, j0, j1, &mut s) {
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
        check_on(Kernel::selected(), m, n, k, threads)
    }

    fn check_on(kern: Kernel, m: usize, n: usize, k: usize, threads: &[usize]) {
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
            assert!(gemm_on(kern, &a, &b, &mut c, t), "gemm refused {m}x{k} * {k}x{n} on {}", kern.name());
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
        assert!(gemm_on(Kernel::Scalar, &a, &b, &mut c, 1));
        assert_eq!(fnv(&c), CROSS_KERNEL_FNV, "C's bits: {:#018x}", fnv(&c));
    }

    /// C = A * B, one thread, on microkernel `k` (any kernel, selected or not)
    fn product_with<K: crate::micro::Micro>(k: &K, a: &Mat, b: &Mat) -> Vec<f64> {
        let (m, n) = (a.rows, b.cols);
        let mut c = vec![f64::NAN; m * n];
        let mut s = vec![0.0; scratch_len()];
        assert!(gemm_cols_with(k, a, b, &mut c, m.max(1), 0, n, &mut s));
        c
    }

    fn pinned_inputs() -> (Vec<f64>, Vec<f64>) {
        let mut seed = 2026u32;
        let av = seeded(97 * 257, &mut seed);
        let bv = seeded(257 * 513, &mut seed);
        (av, bv)
    }

    /// The FMA family's pin: C for the same seeded 97 x 257 x 513 product from every kernel with a fused
    /// multiply-add (scalar `mul_add`, AVX2+FMA, NEON). Differs from [`CROSS_KERNEL_FNV`] only by fusing.
    pub(crate) const CROSS_KERNEL_FNV_FMA: u64 = 0x46f387dbd0333294;

    #[test]
    fn every_kernel_family_has_one_set_of_bits_whatever_the_tile() {
        use crate::micro::{Scalar, ScalarFma};
        let (av, bv) = pinned_inputs();
        let a = Mat::new(&av, 97, 257, 97).unwrap();
        let b = Mat::new(&bv, 257, 513, 257).unwrap();
        // without FMA: every tile shape, the pinned bits
        for c in [product_with(&Scalar::<4, 4>, &a, &b), product_with(&Scalar::<8, 6>, &a, &b), product_with(&Scalar::<6, 4>, &a, &b), product_with(&Scalar::<2, 8>, &a, &b)] {
            assert_eq!(fnv(&c), CROSS_KERNEL_FNV);
        }
        // with FMA: every tile shape, one other set of bits
        let f = product_with(&ScalarFma::<4, 4>, &a, &b);
        assert_eq!(fnv(&f), CROSS_KERNEL_FNV_FMA, "the FMA family's bits: {:#018x}", fnv(&f));
        assert_eq!(fnv(&product_with(&ScalarFma::<8, 6>, &a, &b)), CROSS_KERNEL_FNV_FMA);
        assert_ne!(CROSS_KERNEL_FNV_FMA, CROSS_KERNEL_FNV);
        // the native SIMD kernels: their family's bits (each where this CPU runs it)
        #[cfg(target_arch = "x86_64")]
        if let Some(k) = crate::micro::Avx2Fma::detect() {
            assert_eq!(fnv(&product_with(&k, &a, &b)), CROSS_KERNEL_FNV_FMA, "AVX2+FMA");
        }
        #[cfg(target_arch = "aarch64")]
        assert_eq!(fnv(&product_with(&crate::micro::Neon, &a, &b)), CROSS_KERNEL_FNV_FMA, "NEON");
    }

    /// Every kernel this build has, on every shape and thread count: the oracle and bit-identity across threads.
    #[test]
    fn every_kernel_shapes_and_threads() {
        let mut kernels = vec![Kernel::Scalar];
        #[cfg(target_arch = "x86_64")]
        kernels.extend(crate::micro::Avx2Fma::detect().map(Kernel::Avx2Fma));
        #[cfg(target_arch = "aarch64")]
        kernels.push(Kernel::Neon);
        for k in kernels {
            for &(m, n, k_) in &[(1, 1, 1), (3, 5, 7), (8, 6, 4), (9, 7, 300), (17, 13, 9), (97, 513, 257), (130, 70, 600), (0, 5, 3), (5, 0, 3), (5, 4, 0)] {
                check_on(k, m, n, k_, &[1, 2, 3, 8]);
            }
        }
    }

    #[test]
    fn a_tile_larger_than_the_accumulator_is_refused_without_writing() {
        // (no kernel in the crate has one; the guard keeps a future one from overrunning ACC_LEN)
        let v = vec![1.0; 64];
        let a = Mat::new(&v, 8, 8, 8).unwrap();
        let mut c = vec![7.0; 64];
        let mut s = vec![0.0; scratch_len()];
        assert!(!gemm_cols_with(&crate::micro::Scalar::<16, 8>, &a, &a, &mut c, 8, 0, 8, &mut s));
        assert!(c.iter().all(|&x| x == 7.0));
        assert!(gemm_cols_with(&crate::micro::Scalar::<8, 8>, &a, &a, &mut c, 8, 0, 8, &mut s));
        // (a zero-sized tile, and one whose MR * NR overflows: refused, not a division by zero or a wrap)
        c.fill(7.0);
        assert!(!gemm_cols_with(&crate::micro::Scalar::<0, 4>, &a, &a, &mut c, 8, 0, 8, &mut s));
        assert!(!gemm_cols_with(&crate::micro::Scalar::<4, 0>, &a, &a, &mut c, 8, 0, 8, &mut s));
        assert!(!gemm_cols_with(&Huge, &a, &a, &mut c, 8, 0, 8, &mut s));
        assert!(c.iter().all(|&x| x == 7.0));
    }

    /// A (safe, invalid) kernel whose MR * NR overflows usize.
    #[derive(Clone, Copy)]
    struct Huge;
    impl crate::micro::Micro for Huge {
        const MR: usize = usize::MAX / 2;
        const NR: usize = 3;
        const NAME: &'static str = "huge";
        fn tile(&self, _: usize, _: &[f64], _: &[f64], _: &mut [f64; crate::micro::ACC_LEN]) {
            unreachable!("never called: refused first")
        }
    }

    /// Each kernel's recorded width is its tile's NR, and the partition deals whole NR blocks (grader E1).
    #[test]
    fn partition_is_in_whole_tiles_of_the_kernel() {
        assert_eq!(Kernel::Scalar.nr(), <Scalar<4, 4> as crate::micro::Micro>::NR);
        #[cfg(target_arch = "x86_64")]
        if let Some(k) = crate::micro::Avx2Fma::detect() {
            assert_eq!(Kernel::Avx2Fma(k).nr(), 6);
        }
        #[cfg(target_arch = "aarch64")]
        assert_eq!(Kernel::Neon.nr(), 6);
        for nr in [4, 6] {
            for n in [0, 1, 5, 6, 7, 12, 13, 100, 1000] {
                for t in 1..9 {
                    for id in 0..t {
                        let (j0, j1) = partition(n, t, id, nr);
                        assert!(j0 == n || j0 % nr == 0, "n={n} t={t} id={id} nr={nr}: starts at {j0}");
                        assert!(j1 == n || j1 % nr == 0, "n={n} t={t} id={id} nr={nr}: ends at {j1}");
                    }
                }
            }
        }
    }

    /// On CI's x86-64 runners the AVX2+FMA kernel must actually run (grader E2): a runner without it would
    /// otherwise pass every AVX2 assertion by skipping it. (GitHub Actions sets GITHUB_ACTIONS=true itself;
    /// SAGEBRUSH_REQUIRE_AVX2=1 asks for the same anywhere.)
    #[test]
    #[cfg(target_arch = "x86_64")]
    fn avx2_runs_where_required() {
        extern crate std;
        let required = std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true") || std::env::var("SAGEBRUSH_REQUIRE_AVX2").as_deref() == Ok("1");
        if required {
            assert!(crate::micro::Avx2Fma::detect().is_some(), "this x86-64 host lacks AVX2+FMA, so the AVX2 kernel's tests would be skipped");
            assert_eq!(Kernel::selected().name(), "avx2-fma-8x6");
        }
    }

    #[test]
    fn blocks_are_whole_panels() {
        for r in 1..=16 {
            assert!(mc_of(r) % r == 0 && mc_of(r) <= MC && mc_of(r) > 0);
            assert!(nc_of(r) % r == 0 && nc_of(r) <= NC && nc_of(r) > 0);
        }
        assert_eq!(nc_of(6), 510);
    }

    #[test]
    fn selected_kernel_is_recorded() {
        let k = Kernel::selected();
        #[cfg(target_arch = "x86_64")]
        assert_eq!(k.name(), if crate::micro::Avx2Fma::detect().is_some() { "avx2-fma-8x6" } else { "scalar" });
        #[cfg(target_arch = "aarch64")]
        assert_eq!(k.name(), "scalar", "NEON must not be selected until a CI host runs it");
        assert!(k.nr() > 0);
    }

    #[test]
    fn partition_covers_once() {
        for n in [0, 1, 3, 4, 5, 63, 64, 1000] {
            for t in 1..10 {
                let mut next = 0;
                for id in 0..t {
                    let (j0, j1) = partition(n, t, id, 4);
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
            let (j0, j1) = partition(n, t, id, 4);
            assert!(j0 <= j1 && j1 <= n);
        }
        assert_eq!(partition(10, 4, 4, 4), (10, 10));
        assert_eq!(partition(12, 2, 0, 6), (0, 6));
        assert_eq!(partition(12, 2, 1, 6), (6, 12));
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
