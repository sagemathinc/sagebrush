//! The kernel's WebAssembly exports (src/runtime/skltree.ts is their one
//! caller).  Single-threaded: the instance's datasets are one thread-local
//! table.  The heap and its page bound are engine/wasmheap's: the host admits
//! each call's page-rounded growth and sets the bound to exactly that with
//! skt_begin before the call (design note sklearn-trees r3 §6).
//!
//! A call's outcome: >= 0, its result; < 0, a failure (data::Error), whose
//! detail skt_detail_row / skt_detail_col give.  Nothing here reads or
//! writes memory through a raw pointer: the host copies the arrays into the
//! buffers whose addresses skt_dataset_x/_y/_mask give.

use crate::data::{Dataset, Table};
use std::cell::RefCell;

thread_local! {
    static TABLE: RefCell<Table> = RefCell::new(Table::default());
}

fn with<T>(f: impl FnOnce(&mut Table) -> T) -> T {
    TABLE.with(|t| f(&mut t.borrow_mut()))
}

fn code<T: TryInto<i32>>(r: Result<T, crate::data::Error>) -> i32 {
    match r {
        Ok(v) => v.try_into().unwrap_or(crate::data::Error::Handle as i32),
        Err(e) => e as i32,
    }
}

/// An open dataset of n samples, f features and `outputs` outputs (with a
/// missing-value mask when `masked` is 1): its handle, or a failure.
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_dataset_new(n: u32, f: u32, outputs: u32, masked: u32) -> i32 {
    sagebrush_wasmheap::clear_refusal();
    with(|t| code(t.create(n as usize, f as usize, outputs as usize, masked == 1)))
}

fn address(h: u32, buf: impl FnOnce(&mut Dataset) -> usize) -> usize {
    with(|t| t.open(h).map_or(0, buf))
}

/// The address of an open dataset's X (n*f float32s, row-major), or 0.
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation (the buffer's address only).
#[allow(unsafe_code)]
pub extern "C" fn skt_dataset_x(h: u32) -> usize {
    address(h, |d| d.x.as_mut_ptr() as usize)
}

/// The address of an open dataset's y (n*outputs float64s, row-major), or 0.
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation (the buffer's address only).
#[allow(unsafe_code)]
pub extern "C" fn skt_dataset_y(h: u32) -> usize {
    address(h, |d| d.y.as_mut_ptr() as usize)
}

/// The address of an open dataset's mask (f bytes), or 0 (none, or no such
/// open dataset).
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation (the buffer's address only).
#[allow(unsafe_code)]
pub extern "C" fn skt_dataset_mask(h: u32) -> usize {
    address(h, |d| d.mask.as_mut().map_or(0, |m| m.as_mut_ptr() as usize))
}

/// Check what the host copied in and seal the dataset (data::Table::seal):
/// 0, or a failure.
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_dataset_seal(h: u32) -> i32 {
    with(|t| code(t.seal(h).map(|()| 0)))
}

/// Release a dataset: 1, or 0 when there was none.
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_dataset_release(h: u32) -> i32 {
    with(|t| t.release(h) as i32)
}

/// The last failure's row (or 0).
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_detail_row() -> f64 {
    with(|t| t.detail.0 as f64)
}

/// The last failure's column or output (or 0).
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_detail_col() -> f64 {
    with(|t| t.detail.1 as f64)
}

/// The bytes every live dataset holds (for the host's tests).
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_live_bytes() -> f64 {
    with(|t| t.live_bytes() as f64)
}

/// The heap's bound: from now on the memory may grow by at most `pages`.
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_begin(pages: u32) {
    sagebrush_wasmheap::begin(pages)
}

/// The last growth the bound refused (wasmheap::Refusal: three u32s).
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_last_refusal() -> *const sagebrush_wasmheap::Refusal {
    sagebrush_wasmheap::last_refusal()
}
