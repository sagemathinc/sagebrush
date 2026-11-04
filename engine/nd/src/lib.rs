//! Sagebrush's numerics core: dense f64 kernels on column-major storage (design: numerics-core r4.2).
//!
//! The operation and blocking layers ([`gemm`]) are written once; under them, one small microkernel per
//! target ([`micro`]): portable scalar, and WebAssembly SIMD128. Native AVX2/AVX-512/NEON microkernels come
//! later, each enabled only once a CI host executes it (r4.2 §12).
//!
//! Determinism (r4.2 §7): every element of a product is summed in the same order (k in blocks of
//! [`gemm::KC`], in order; within a block p = 0, 1, ...; then added into C) whatever the thread count, the
//! column partition and the tile shape. Kernels without FMA give the bits of the portable scalar kernel;
//! kernels with a fused multiply-add give the bits of the scalar `mul_add` kernel ([`micro`]). So a result is
//! bit-identical across thread counts on one backend and kernel.
#![cfg_attr(target_arch = "wasm32", no_std)]

pub mod boundary;
pub mod gemm;
pub mod micro;
#[cfg(target_arch = "wasm32")]
pub mod wasm;
