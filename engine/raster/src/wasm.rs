//! The PNG module's exports of its WebAssembly heap: the heap and its page
//! bound are engine/wasmheap's (PNG plan r8 §2.2), shared with Sagebrush's
//! other wasm modules; these name them in the raster module's ABI.

pub use sagebrush_wasmheap::clear_refusal;

/// The host's bound: from now on the memory may grow by at most `pages`
/// pages over its size now (on a fresh instance, its initial pages).
#[no_mangle]
// SAFETY: an export of the raster module's wasm ABI (no_mangle; the rs_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn rs_begin(pages: u32) {
    sagebrush_wasmheap::begin(pages)
}

/// The last growth refused since the call began (all zero: none).
#[no_mangle]
// SAFETY: an export of the raster module's wasm ABI (no_mangle; the rs_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn rs_last_refusal() -> *const sagebrush_wasmheap::Refusal {
    sagebrush_wasmheap::last_refusal()
}

/// Where the heap starts: below it the stack and static data.
#[no_mangle]
// SAFETY: an export of the raster module's wasm ABI (no_mangle; the rs_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn rs_heap_base() -> usize {
    sagebrush_wasmheap::heap_base()
}
