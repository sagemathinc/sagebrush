//! kernels/src/libm.rs (glibc's exp and log over arrays) built with relaxed
//! SIMD, so that its fused multiply-adds are the hardware's.  Used only
//! where fma_probe() shows they are fused; elsewhere, and where relaxed SIMD
//! is missing, the main module's exact software version runs.
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[path = "../../src/libm.rs"]
mod libm;
