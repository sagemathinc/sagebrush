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

/// A buffer of `len` float64s for a fit's inputs (its weights, its class counts): its handle, or a failure.
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_buffer_new(len: u32) -> i32 {
    sagebrush_wasmheap::clear_refusal();
    with(|t| code(t.buffer(len as usize)))
}

/// The address of a buffer's float64s, or 0.
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation (the buffer's address only).
#[allow(unsafe_code)]
pub extern "C" fn skt_buffer_ptr(h: u32) -> usize {
    with(|t| t.buffer_mut(h).map_or(0, |b| b.as_mut_ptr() as usize))
}

/// Release a buffer: 1, or 0 when there was none.
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_buffer_release(h: u32) -> i32 {
    with(|t| t.buffer_take(h).is_ok() as i32)
}

/// Fit one tree on a sealed dataset (fit::fit): `sw` and `classes` are buffer handles (0: none), consumed;
/// `kind` 0 gini, 1 entropy, 2 squared_error; the parameters as Python resolved them.  The tree's handle, or a
/// failure (the buffers are released either way).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_fit(ds: u32, sw: u32, classes: u32, kind: u32, max_depth: f64, min_samples_split: f64, min_samples_leaf: f64, min_weight_leaf: f64, max_features: f64, min_impurity_decrease: f64, seed: u32) -> i32 {
    use crate::criterion::Kind;
    use crate::data::Error;
    sagebrush_wasmheap::clear_refusal();
    with(|t| {
        let weights = if sw == 0 { None } else { t.buffer_take(sw).ok() };
        let counts = if classes == 0 { Some(vec![]) } else { t.buffer_take(classes).ok() };
        let r = (|| {
            if (sw != 0 && weights.is_none()) || counts.is_none() {
                return Err(Error::Handle);
            }
            let kind = match kind {
                0 => Kind::Gini,
                1 => Kind::Entropy,
                2 => Kind::Mse,
                _ => return Err(Error::Params),
            };
            // (counts and sizes arrive as exact float64 integers)
            let int = |v: f64| if v >= 0.0 && v.fract() == 0.0 && v < 2f64.powi(53) { Ok(v as u64) } else { Err(Error::Params) };
            // (fallibly: one entry an output, and y may be very wide)
            let counts = counts.as_deref().unwrap_or(&[]);
            let mut n_classes = Vec::new();
            n_classes.try_reserve_exact(counts.len()).map_err(|_| Error::Memory)?;
            for &c in counts {
                n_classes.push(int(c)? as usize);
            }
            let p = crate::fit::FitParams {
                kind,
                max_depth: int(max_depth)?,
                min_samples_split: int(min_samples_split)? as usize,
                min_samples_leaf: int(min_samples_leaf)? as usize,
                min_weight_leaf,
                max_features: int(max_features)? as usize,
                min_impurity_decrease,
                seed,
            };
            let mut detail = (0, 0);
            let fitted = crate::fit::fit(t.get(ds)?, weights.as_deref(), &n_classes, &p, &mut detail);
            t.detail = detail;
            let (tree, imp) = fitted?;
            t.put_tree(tree, imp)
        })();
        code(r)
    })
}

/// A fitted tree's sizes: 0 node_count, 1 max_depth, 2 n_outputs, 3 stride (max_n_classes, or 1), 4 n_features.
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_tree_info(h: u32, what: u32) -> f64 {
    with(|t| {
        t.tree(h).map_or(-1.0, |(tree, imp)| match what {
            0 => tree.node_count() as f64,
            1 => tree.max_depth as f64,
            2 => tree.n_outputs as f64,
            3 => tree.stride as f64,
            4 => imp.len() as f64,
            _ => -1.0,
        })
    })
}

/// The address of one of a fitted tree's arrays: 0 children_left, 1 children_right, 2 feature, 5 n_node_samples
/// (i64s); 3 threshold, 4 impurity, 6 weighted_n_node_samples, 8 value, 9 the raw importances (f64s); 7
/// missing_go_to_left (bytes).  0 if none.
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation (the arrays' addresses only).
#[allow(unsafe_code)]
pub extern "C" fn skt_tree_array(h: u32, which: u32) -> usize {
    with(|t| {
        t.tree(h).map_or(0, |(tree, imp)| match which {
            0 => tree.children_left.as_ptr() as usize,
            1 => tree.children_right.as_ptr() as usize,
            2 => tree.feature.as_ptr() as usize,
            3 => tree.threshold.as_ptr() as usize,
            4 => tree.impurity.as_ptr() as usize,
            5 => tree.n_node_samples.as_ptr() as usize,
            6 => tree.weighted_n_node_samples.as_ptr() as usize,
            7 => tree.missing_go_to_left.as_ptr() as usize,
            8 => tree.value.as_ptr() as usize,
            9 => imp.as_ptr() as usize,
            _ => 0,
        })
    })
}

/// Release a fitted tree (after its copy out): 1, or 0 when there was none.
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_tree_release(h: u32) -> i32 {
    with(|t| t.release_tree(h) as i32)
}

/// The bytes a fit may allocate beyond its dataset (fit::fit_bytes), for the host's admission, or -1 when the
/// shape overflows (refused).
#[no_mangle]
// SAFETY: an export of the kernel's wasm ABI (no_mangle; the skt_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn skt_fit_bytes(n: f64, f: f64, n_outputs: f64, stride: f64, max_depth: f64, min_samples_leaf: f64) -> f64 {
    let int = |v: f64| if v >= 0.0 && v.fract() == 0.0 && v < 2f64.powi(53) { Some(v as u64) } else { None };
    (|| crate::fit::fit_bytes(int(n)?, int(f)?, int(n_outputs)?, int(stride)?, int(max_depth)?, int(min_samples_leaf)?))().map_or(-1.0, |b| b as f64)
}
