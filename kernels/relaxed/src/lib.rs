//! kernels/src/libm.rs (glibc's exp and log over arrays) and random.rs
//! (numpy.random's fills, whose normals call log) built with relaxed SIMD,
//! so that the fused multiply-adds are the hardware's.  Used only
//! where fma_probe() shows they are fused; elsewhere, and where relaxed SIMD
//! is missing, the main module's exact software version runs.
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[path = "../../src/libm.rs"]
#[allow(dead_code)]
mod libm;
#[path = "../../src/random.rs"]
mod random;

#[inline(always)]
pub(crate) fn sqrt(x: f64) -> f64 {
    use core::arch::wasm32::*;
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}
