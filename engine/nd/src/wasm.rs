//! The WebAssembly entry points (browser B1, and the Node CLI without the native addon), on a shared memory:
//! the host (JS) lays out the operands and one scratch area per thread, starts the worker instances (each on
//! its own stack) and runs `nd_gemm_part(desc, id)` on every thread; it waits for them with Atomics, since the
//! Wasm wait instructions are not yet stable in Rust. Every call returns before the host reads C (r4.2 §6).
//!
//! The boundary is checked before any pointer is read or slice made ([`crate::boundary`], safe code: the
//! memory model, what is enforced and what the host must guarantee). A job that fails a check returns 0
//! having written nothing. `nd_gemm_part` is the only export that writes memory.

use crate::boundary::{check, desc_region, Facts, DESC_WORDS};
use crate::gemm::{gemm_cols, partition, scratch_len, Kernel, Mat};
use core::arch::wasm32::memory_size;
use core::ptr::{addr_of, with_exposed_provenance, with_exposed_provenance_mut};

extern "C" {
    /// The linker's end of the module's own memory (static data and its stack): the host's part starts here.
    static __heap_base: u8;
}

/// The memory's current size in bytes (64-bit: a 4 GiB memory is 2^32).
fn memory_bytes() -> u64 {
    memory_size(0) as u64 * 65536
}

/// Facts for the host's layout (read only; `no_mangle` is the only unsafe part: an exported symbol name,
/// unique in this module, and reading the linker symbol's address, never its contents): 0, the f64 count of one
/// thread's scratch; 1, the floor of the host's part of memory; 2 and 3, the address and length of the
/// selected microkernel's static name (UTF-8); anything else, 0.
#[no_mangle]
#[allow(unsafe_code)]
pub extern "C" fn nd_info(what: u32) -> u32 {
    match what {
        0 => scratch_len() as u32,
        1 => addr_of!(__heap_base) as usize as u32, // (its address only: safe)
        2 => Kernel::selected().name().as_ptr() as usize as u32,
        3 => Kernel::selected().name().len() as u32,
        _ => 0,
    }
}

/// Thread `id`'s share of C = A * B (its columns, [`partition`]). Returns 1 on success (an `id` at or
/// beyond the job's thread count has nothing to do), 0 if the job was refused, having written nothing.
///
/// Checked here, before any pointer is read or slice made ([`check`]): the descriptor and every nonempty
/// region are aligned, in the host's part of memory (at or above `__heap_base`, so never at 0), within memory
/// and at most `isize::MAX` bytes long; C and the scratch lie in the job's arena and overlap neither A, B, each
/// other nor the descriptor (which lies outside the arena); the stride holds a thread's scratch; this thread's
/// frame lies below the arena. Pointers are made from the checked absolute addresses (exposed provenance: the
/// host's part of linear memory is foreign to Rust, like memory handed over by FFI).
///
/// # Safety
/// Host preconditions (the trusted host's contract; not checkable here, since each call sees only its own frame,
/// which it checks lies below the arena), in the reviewed wording:
///
/// All participant stacks are pairwise disjoint and disjoint from module-owned memory, descriptor/control, A/B,
/// and the writable arena; the host and other jobs leave all job ranges untouched until join, apart from each
/// participant owning only its assigned C columns and scratch slot.
///
/// And every thread of the job is called with the same descriptor and a distinct `id` (so the threads' columns
/// of C and scratch areas, disjoint by construction, belong to one thread each).
#[no_mangle]
#[allow(unsafe_code)]
pub unsafe extern "C" fn nd_gemm_part(desc: u32, id: u32) -> u32 {
    let probe = 0u8;
    let facts = Facts {
        mem: memory_bytes(),
        floor: addr_of!(__heap_base) as usize as u64,
        max_len: isize::MAX as u64,
        frame: core::hint::black_box(addr_of!(probe)) as usize as u64,
    };
    if desc_region(u64::from(desc), &facts).is_none() {
        return 0;
    }
    // SAFETY: the descriptor's DESC_WORDS u32s lie in the host's part of memory, 4-aligned (checked above)
    let d = with_exposed_provenance::<[u32; DESC_WORDS]>(desc as usize).read();
    let Some(j) = check(u64::from(desc), &d, &facts) else { return 0 };
    let id = id as usize;
    if id >= j.threads {
        return 1;
    }
    let (j0, j1) = partition(j.n, j.threads, id, Kernel::selected().nr());
    // SAFETY: every nonempty region was checked to lie in the host's part of memory, nonzero, 8-aligned and at
    // most isize::MAX bytes, and the written ones (this thread's columns of C, its scratch) to lie in the
    // arena, disjoint from A, B and the descriptor; an empty region is the empty slice (no address used)
    let (na, nb, nc) = (j.m * j.k, j.k * j.n, (j1 - j0) * j.m);
    let av: &[f64] = if na == 0 { &[] } else { core::slice::from_raw_parts(with_exposed_provenance(j.a), na) };
    let bv: &[f64] = if nb == 0 { &[] } else { core::slice::from_raw_parts(with_exposed_provenance(j.b), nb) };
    let cv: &mut [f64] = if nc == 0 { &mut [] } else { core::slice::from_raw_parts_mut(with_exposed_provenance_mut(j.c + j0 * j.m * 8), nc) };
    let sv: &mut [f64] = core::slice::from_raw_parts_mut(with_exposed_provenance_mut(j.s0 + id * j.sstride), scratch_len());
    let (Some(am), Some(bm)) = (Mat::new(av, j.m, j.k, j.m.max(1)), Mat::new(bv, j.k, j.n, j.k.max(1))) else { return 0 };
    gemm_cols(&am, &bm, cv, j.m.max(1), j0, j1, sv) as u32
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
