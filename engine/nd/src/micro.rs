//! Microkernels: C_tile (MR x NR) = sum over p of packed A column p (MR values) times packed B row p (NR
//! values), for one KC block. Each target has its own; all perform, per element of the tile, the same
//! sequence of multiplies and adds (acc = acc + a*b, p = 0, 1, ...), so their results are bit-identical.

/// rows of the register tile
pub const MR: usize = 4;
/// columns of the register tile
pub const NR: usize = 4;

/// The portable microkernel: `acc` (column-major MR x NR) from packed panels `a` (kc x MR, p-major) and `b`
/// (kc x NR, p-major).
#[inline]
pub fn tile_scalar(kc: usize, a: &[f64], b: &[f64], acc: &mut [f64; MR * NR]) {
    let (a, b) = (&a[..kc * MR], &b[..kc * NR]);
    let mut t = [0.0f64; MR * NR];
    for (ap, bp) in a.chunks_exact(MR).zip(b.chunks_exact(NR)) {
        for j in 0..NR {
            let bj = bp[j];
            for i in 0..MR {
                t[j * MR + i] += ap[i] * bj;
            }
        }
    }
    *acc = t;
}

/// The WebAssembly SIMD128 microkernel: two f64 lanes per vector, the MR x NR tile in MR/2 * NR
/// accumulators (fully unrolled: MR and NR are constants).
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
pub fn tile_simd128(kc: usize, a: &[f64], b: &[f64], acc: &mut [f64; MR * NR]) {
    use core::arch::wasm32::*;
    const H: usize = MR / 2;
    let (a, b) = (&a[..kc * MR], &b[..kc * NR]);
    let mut c = [f64x2_splat(0.0); H * NR];
    for (ap, bp) in a.chunks_exact(MR).zip(b.chunks_exact(NR)) {
        let mut av = [f64x2_splat(0.0); H];
        for h in 0..H {
            av[h] = f64x2(ap[2 * h], ap[2 * h + 1]);
        }
        for j in 0..NR {
            let bj = f64x2_splat(bp[j]);
            for h in 0..H {
                c[j * H + h] = f64x2_add(c[j * H + h], f64x2_mul(av[h], bj));
            }
        }
    }
    for (k, v) in c.iter().enumerate() {
        acc[2 * k] = f64x2_extract_lane::<0>(*v);
        acc[2 * k + 1] = f64x2_extract_lane::<1>(*v);
    }
}

/// The microkernel this build uses (selected at compile time for Wasm, which has one SIMD level per
/// module; native runtime dispatch comes with the native microkernels)
#[inline]
pub fn tile(kc: usize, a: &[f64], b: &[f64], acc: &mut [f64; MR * NR]) {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    return tile_simd128(kc, a, b, acc);
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    tile_scalar(kc, a, b, acc)
}

/// The name of the selected microkernel, recorded with every result (r4.2 §12)
pub fn name() -> &'static str {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    return "wasm-simd128-4x4";
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    "scalar"
}
