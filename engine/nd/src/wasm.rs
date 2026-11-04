//! The WebAssembly entry points (browser B1, and the Node CLI without the native addon), on a shared memory:
//! the host (JS) lays out the operands and one scratch area per thread, starts the worker instances (each on
//! its own stack) and runs `gemm_part(desc, id)` on every thread; it waits for them with Atomics, since the
//! Wasm wait instructions are not yet stable in Rust. Every call returns before the host reads C (r4.2 §6).

use crate::gemm::{gemm_cols, partition, scratch_len, Mat};

/// The job descriptor, laid out by the host as u32s at `desc`:
/// [a, b, c, m, n, k, threads, scratch0, scratch_stride] (byte addresses; scratch for thread `id` at
/// scratch0 + id * scratch_stride, at least `scratch_len() * 8` bytes each).
const DESC_WORDS: usize = 9;

/// The f64 count of one thread's scratch, for the host's layout. (`no_mangle` is the only unsafe part:
/// an exported symbol name, unique in this module)
#[no_mangle]
#[allow(unsafe_code)]
pub extern "C" fn nd_gemm_scratch_len() -> u32 {
    scratch_len() as u32
}

/// Thread `id`'s share of C = A * B (its columns, [`partition`]). Returns 1 on success, 0 if the job was
/// refused (bad shapes or layout), in which case nothing was written.
///
/// # Safety
/// The host guarantees: `desc` points at [`DESC_WORDS`] u32s; A (m x k), B (k x n) and C (m x n) are
/// column-major f64 arrays with leading dimensions m, k and m at the given 8-byte-aligned addresses, inside
/// this module's memory; A and B are not written by anyone during the call; each thread's scratch area is
/// its own; and every thread of the pool is called with the same `desc` and a distinct `id` (ids at or beyond `threads` do nothing), so the
/// column ranges of C the threads write are disjoint (the partition is a function of n and threads only).
#[no_mangle]
#[allow(unsafe_code)]
pub unsafe extern "C" fn nd_gemm_part(desc: *const u32, id: u32) -> u32 {
    let d = core::slice::from_raw_parts(desc, DESC_WORDS);
    let [a, b, c, m, n, k, threads, s0, sstride] = [d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8]].map(|x| x as usize);
    // (a pool larger than the job: the extra threads have no columns, and nothing to do)
    if threads > 0 && id as usize >= threads {
        return 1;
    }
    if threads == 0 || a % 8 != 0 || b % 8 != 0 || c % 8 != 0 || s0 % 8 != 0 || sstride < scratch_len() * 8 {
        return 0;
    }
    let (j0, j1) = partition(n, threads, id as usize);
    let av = core::slice::from_raw_parts(a as *const f64, m * k);
    let bv = core::slice::from_raw_parts(b as *const f64, k * n);
    // (this thread's columns only: disjoint from every other thread's)
    let cv = core::slice::from_raw_parts_mut((c as *mut f64).add(j0 * m), (j1 - j0) * m);
    let sv = core::slice::from_raw_parts_mut((s0 + id as usize * sstride) as *mut f64, scratch_len());
    let (Some(am), Some(bm)) = (Mat::new(av, m, k, m.max(1)), Mat::new(bv, k, n, k.max(1))) else { return 0 };
    gemm_cols(&am, &bm, cv, m.max(1), j0, j1, sv) as u32
}

/// The selected microkernel's name (written as UTF-8 at `out`, at most `cap` bytes); returns its length.
///
/// # Safety
/// `out` points at `cap` writable bytes in this module's memory.
#[no_mangle]
#[allow(unsafe_code)]
pub unsafe extern "C" fn nd_microkernel(out: *mut u8, cap: u32) -> u32 {
    let s = crate::micro::name().as_bytes();
    let n = s.len().min(cap as usize);
    core::ptr::copy_nonoverlapping(s.as_ptr(), out, n);
    n as u32
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
