//! Microkernels: C_tile (MR x NR) = sum over p of packed A column p (MR values) times packed B row p (NR
//! values), for one KC block (r4.2 §12: one blocking layer, a tuned microkernel per target).
//!
//! Determinism (r4.2 §7). Every kernel computes each element of its tile as `t = 0; for p in order:
//! t = t + a_p * b_p` (or, in an FMA kernel, `t = fma(a_p, b_p, t)`, correctly rounded once), and the blocking
//! layer adds each KC block's `t` into C in order. That order doesn't depend on the tile shape, so:
//! - every kernel without FMA ([`Scalar`], the Wasm SIMD128 one) gives the same bits, whatever its tile;
//! - every kernel with a fused multiply-add ([`ScalarFma`], AVX2+FMA, NEON) gives the same bits as each other.
//! (WebAssembly's relaxed-SIMD madd is not used: its spec lets an engine fuse or not on each call, so no
//! bit-reproducible result could be claimed for it. #615 ruling, Nov 4.)

/// The length of the accumulator handed to [`Micro::tile`]: room for the largest tile any kernel uses (MR * NR).
pub const ACC_LEN: usize = 64;

/// A microkernel and its register tile. `tile` writes the MR x NR tile column-major into `acc[..MR * NR]`
/// (element (i, j) at `acc[i + j * MR]`) from the packed panels `a` (kc x MR, p-major) and `b` (kc x NR,
/// p-major); it reads only `a[..kc * MR]` and `b[..kc * NR]` (and panics, never reads past, if they're short).
pub trait Micro: Copy {
    /// rows of the register tile
    const MR: usize;
    /// columns of the register tile
    const NR: usize;
    /// the name recorded with every result (r4.2 §12)
    const NAME: &'static str;
    fn tile(&self, kc: usize, a: &[f64], b: &[f64], acc: &mut [f64; ACC_LEN]);
}

/// The portable kernel, no FMA: the reference for every kernel without one.
#[derive(Clone, Copy)]
pub struct Scalar<const MR: usize, const NR: usize>;

impl<const MR: usize, const NR: usize> Micro for Scalar<MR, NR> {
    const MR: usize = MR;
    const NR: usize = NR;
    const NAME: &'static str = "scalar";
    #[inline]
    fn tile(&self, kc: usize, a: &[f64], b: &[f64], acc: &mut [f64; ACC_LEN]) {
        let (a, b) = (&a[..kc * MR], &b[..kc * NR]);
        let t = &mut acc[..MR * NR];
        t.fill(0.0);
        for (ap, bp) in a.chunks_exact(MR).zip(b.chunks_exact(NR)) {
            for (j, &bj) in bp.iter().enumerate() {
                for (i, &ai) in ap.iter().enumerate() {
                    t[j * MR + i] += ai * bj;
                }
            }
        }
    }
}

/// The portable kernel with a fused multiply-add (`f64::mul_add`, correctly rounded): the reference for every
/// FMA kernel's bits. Native only (it needs std's `mul_add`); a test oracle, never selected for speed.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Copy)]
pub struct ScalarFma<const MR: usize, const NR: usize>;

#[cfg(not(target_arch = "wasm32"))]
impl<const MR: usize, const NR: usize> Micro for ScalarFma<MR, NR> {
    const MR: usize = MR;
    const NR: usize = NR;
    const NAME: &'static str = "scalar-fma";
    #[inline]
    fn tile(&self, kc: usize, a: &[f64], b: &[f64], acc: &mut [f64; ACC_LEN]) {
        extern crate std;
        let (a, b) = (&a[..kc * MR], &b[..kc * NR]);
        let t = &mut acc[..MR * NR];
        t.fill(0.0);
        for (ap, bp) in a.chunks_exact(MR).zip(b.chunks_exact(NR)) {
            for (j, &bj) in bp.iter().enumerate() {
                for (i, &ai) in ap.iter().enumerate() {
                    t[j * MR + i] = std::primitive::f64::mul_add(ai, bj, t[j * MR + i]);
                }
            }
        }
    }
}

/// The WebAssembly SIMD128 kernel, 4 x 4, mul then add (no FMA): two f64 lanes per vector, the tile in 8
/// accumulators. Its bits are [`Scalar`]'s.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[derive(Clone, Copy)]
pub struct Simd128;

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
impl Micro for Simd128 {
    const MR: usize = 4;
    const NR: usize = 4;
    const NAME: &'static str = "wasm-simd128-4x4";
    #[inline]
    fn tile(&self, kc: usize, a: &[f64], b: &[f64], acc: &mut [f64; ACC_LEN]) {
        use core::arch::wasm32::*;
        let (a, b) = (&a[..kc * 4], &b[..kc * 4]);
        let mut c = [f64x2_splat(0.0); 8];
        for (ap, bp) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
            let av = [f64x2(ap[0], ap[1]), f64x2(ap[2], ap[3])];
            for j in 0..4 {
                let bj = f64x2_splat(bp[j]);
                for h in 0..2 {
                    c[j * 2 + h] = f64x2_add(c[j * 2 + h], f64x2_mul(av[h], bj));
                }
            }
        }
        for (k, v) in c.iter().enumerate() {
            acc[2 * k] = f64x2_extract_lane::<0>(*v);
            acc[2 * k + 1] = f64x2_extract_lane::<1>(*v);
        }
    }
}

/// The AVX2+FMA kernel, 8 x 6 (BLIS's Haswell shape: 12 ymm accumulators, 2 for A, 1 broadcast of B).
/// Only [`Avx2Fma::detect`] makes one, after the CPU reports AVX2 and FMA, so holding one proves the
/// instructions exist. Its bits are [`ScalarFma`]'s.
#[cfg(target_arch = "x86_64")]
#[derive(Clone, Copy)]
pub struct Avx2Fma {
    _detected: (),
}

#[cfg(target_arch = "x86_64")]
impl Avx2Fma {
    /// `Some` only on a CPU with AVX2 and FMA.
    pub fn detect() -> Option<Self> {
        extern crate std;
        (std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")).then_some(Avx2Fma { _detected: () })
    }
}

#[cfg(target_arch = "x86_64")]
impl Micro for Avx2Fma {
    const MR: usize = 8;
    const NR: usize = 6;
    const NAME: &'static str = "avx2-fma-8x6";
    #[inline]
    fn tile(&self, kc: usize, a: &[f64], b: &[f64], acc: &mut [f64; ACC_LEN]) {
        avx2_fma_tile(*self, &a[..kc * 8], &b[..kc * 6], acc)
    }
}

/// The AVX2+FMA tile, safely: `_detected` is the proof (an [`Avx2Fma`] exists only after detection).
#[cfg(target_arch = "x86_64")]
#[inline]
#[allow(unsafe_code)]
fn avx2_fma_tile(_detected: Avx2Fma, a: &[f64], b: &[f64], acc: &mut [f64; ACC_LEN]) {
    // SAFETY: an Avx2Fma exists only if detect() found AVX2 and FMA on this CPU (its field is private)
    unsafe { avx2_fma_8x6(a, b, acc) }
}

/// The 8 x 6 AVX2+FMA tile over whole panels `a` (kc x 8) and `b` (kc x 6) (their lengths are the caller's
/// slicing; chunks_exact keeps every load in bounds).
///
/// # Safety
/// The CPU must support AVX2 and FMA (the caller holds an [`Avx2Fma`]).
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,fma")]
#[allow(unsafe_code)]
unsafe fn avx2_fma_8x6(a: &[f64], b: &[f64], acc: &mut [f64; ACC_LEN]) {
    use core::arch::x86_64::*;
    let mut c = [_mm256_setzero_pd(); 12];
    for (ap, bp) in a.chunks_exact(8).zip(b.chunks_exact(6)) {
        let a0 = _mm256_loadu_pd(ap[0..4].as_ptr());
        let a1 = _mm256_loadu_pd(ap[4..8].as_ptr());
        for j in 0..6 {
            let bj = _mm256_set1_pd(bp[j]);
            c[2 * j] = _mm256_fmadd_pd(a0, bj, c[2 * j]);
            c[2 * j + 1] = _mm256_fmadd_pd(a1, bj, c[2 * j + 1]);
        }
    }
    for (k, v) in c.iter().enumerate() {
        _mm256_storeu_pd(acc[4 * k..4 * k + 4].as_mut_ptr(), *v);
    }
}

/// The NEON kernel (aarch64), 8 x 6: 4 q-registers of A, the tile in 24 accumulators, each B value
/// broadcast by lane. Its bits are [`ScalarFma`]'s. NEON is mandatory on aarch64, so no detection.
///
/// **Selected** on aarch64 ([`NEON_ENABLED`]): CI's engine-nd-neon job (macos-15, Apple silicon) executes its
/// oracle, thread-determinism and bit-family suite (r4.2 §12), green on master 3890aae2 (run 41877477454);
/// William, Nov 4 2026: "own NEON" (Mac native uses this kernel; Accelerate is a benchmark only).
#[cfg(target_arch = "aarch64")]
#[derive(Clone, Copy)]
pub struct Neon;

/// Whether dispatch may select [`Neon`] (r4.2 §12: no microkernel ships that no CI host has executed).
#[cfg(target_arch = "aarch64")]
pub const NEON_ENABLED: bool = true;

#[cfg(target_arch = "aarch64")]
impl Micro for Neon {
    const MR: usize = 8;
    const NR: usize = 6;
    const NAME: &'static str = "neon-fma-8x6";
    #[inline]
    fn tile(&self, kc: usize, a: &[f64], b: &[f64], acc: &mut [f64; ACC_LEN]) {
        neon_fma_tile(&a[..kc * 8], &b[..kc * 6], acc)
    }
}

/// The NEON tile, safely: NEON is part of every aarch64 target.
#[cfg(target_arch = "aarch64")]
#[inline]
#[allow(unsafe_code)]
fn neon_fma_tile(a: &[f64], b: &[f64], acc: &mut [f64; ACC_LEN]) {
    // SAFETY: NEON is part of every aarch64 target (Rust's aarch64 targets enable it), so the instructions exist
    unsafe { neon_fma_8x6(a, b, acc) }
}

/// The 8 x 6 NEON tile over whole panels `a` (kc x 8) and `b` (kc x 6) (their lengths are the caller's
/// slicing; chunks_exact keeps every load in bounds).
///
/// # Safety
/// The CPU must support NEON (every aarch64 CPU Rust targets does).
#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
#[allow(unsafe_code)]
unsafe fn neon_fma_8x6(a: &[f64], b: &[f64], acc: &mut [f64; ACC_LEN]) {
    use core::arch::aarch64::*;
    let mut c = [vdupq_n_f64(0.0); 24];
    for (ap, bp) in a.chunks_exact(8).zip(b.chunks_exact(6)) {
        let av = [vld1q_f64(ap[0..2].as_ptr()), vld1q_f64(ap[2..4].as_ptr()), vld1q_f64(ap[4..6].as_ptr()), vld1q_f64(ap[6..8].as_ptr())];
        for j in 0..6 {
            let bj = vdupq_n_f64(bp[j]);
            for h in 0..4 {
                c[j * 4 + h] = vfmaq_f64(c[j * 4 + h], av[h], bj);
            }
        }
    }
    for (k, v) in c.iter().enumerate() {
        vst1q_f64(acc[2 * k..2 * k + 2].as_mut_ptr(), *v);
    }
}
