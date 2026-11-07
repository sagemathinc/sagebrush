//! The WebAssembly entry points (browser B1, and the Node CLI without the native addon), on a shared memory:
//! the host (JS) lays out the operands and one scratch area per thread, starts the worker instances (each on
//! its own stack) and runs `nd_gemm_part(desc, id)` on every thread; it waits for them with Atomics, since the
//! Wasm wait instructions are not yet stable in Rust. Every call returns before the host reads C (r4.2 §6).
//!
//! The boundary is checked before any pointer is read or slice made ([`crate::boundary`], safe code: the
//! memory model, what is enforced and what the host must guarantee). A job that fails a check returns 0
//! having written nothing. `nd_gemm_part`, `nd_solve` (single-threaded, numerics-core P2b-1) and `nd_potrf`
//! (single-threaded, CHOL-1) are the only exports that write memory.

use crate::boundary::{check_part, check_potrf, check_solve, desc_region, desc_region_of, pool_regions, Facts, Pool, DESC_WORDS, POTRF_DESC_WORDS, POTRF_REPORT_WORDS, REPORT_WORDS, SOLVE_DESC_WORDS};
use crate::gemm::{gemm_cols, partition, scratch_len, Kernel, Mat};
use core::arch::wasm32::memory_size;
use core::ptr::{addr_of, with_exposed_provenance, with_exposed_provenance_mut};
use core::sync::atomic::{AtomicU32, Ordering::{AcqRel, Acquire, Relaxed, Release}};

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

// The thread pool's layout, recorded once by `nd_pool_init` (in this module's own statics, so in the shared
// memory: every instance on it sees the one record): [ctl, stacks, slot, participants], published by POOL_SET
// (0 none, 1 being recorded, 2 recorded) with Release after the words, read with Acquire before them.
static POOL_SET: AtomicU32 = AtomicU32::new(0);
static POOL: [AtomicU32; 4] = [const { AtomicU32::new(0) }; 4];

/// The recorded pool, if any.
fn pool() -> Option<Pool> {
    if POOL_SET.load(Acquire) != 2 {
        return None;
    }
    let [ctl, stacks, slot, participants] = [0, 1, 2, 3].map(|i| u64::from(POOL[i].load(Relaxed)));
    Some(Pool { ctl, stacks, slot, participants })
}

/// Record the thread pool's layout (threads r2, contract 3): the control words at `ctl` ([`CTL_BYTES`]),
/// `participants` stack slots of `slot` bytes from `stacks` ([`Pool`]). Once per memory: returns 1, or 0 if
/// a pool was already recorded or the layout is bad ([`pool_regions`]), having recorded nothing. A job on more
/// than one thread runs only within the recorded pool ([`nd_gemm_part`]).
#[no_mangle]
#[allow(unsafe_code)]
pub extern "C" fn nd_pool_init(ctl: u32, stacks: u32, slot: u32, participants: u32) -> u32 {
    let p = Pool { ctl: ctl.into(), stacks: stacks.into(), slot: slot.into(), participants: participants.into() };
    let facts = Facts { mem: memory_bytes(), floor: addr_of!(__heap_base) as usize as u64, max_len: isize::MAX as u64, frame: 0 };
    if pool_regions(&p, &facts).is_none() || POOL_SET.compare_exchange(0, 1, AcqRel, Acquire).is_err() {
        return 0;
    }
    for (w, v) in POOL.iter().zip([ctl, stacks, slot, participants]) {
        w.store(v, Relaxed);
    }
    POOL_SET.store(2, Release);
    1
}

/// Thread `id`'s share of C = A * B (its columns, [`partition`]). Returns 1 on success (an `id` at or
/// beyond the job's thread count has nothing to do), 0 if the job was refused, having written nothing.
///
/// Checked here, before any pointer is read or slice made ([`check_part`]): the descriptor and every nonempty
/// region are aligned, in the host's part of memory (at or above `__heap_base`, so never at 0), within memory
/// and at most `isize::MAX` bytes long; C and the scratch lie in the job's arena and overlap neither A, B, each
/// other nor the descriptor (which lies outside the arena); the stride holds a thread's scratch; this thread's
/// frame lies below the arena. A job on more than one thread also needs the recorded pool ([`nd_pool_init`]):
/// its thread count at most the pool's participants and `id` one of them, the pool's control words and stacks
/// disjoint from the descriptor, the arena, A, B, C and the scratch, and this thread's frame in its own stack
/// slot. Pointers are made from the checked absolute addresses (exposed provenance: the host's part of linear
/// memory is foreign to Rust, like memory handed over by FFI).
///
/// # Safety
/// Host preconditions (the trusted host's contract; not checkable here, since each call sees only its own frame,
/// which it checks lies below the arena and, on a threaded job, in its own slot of the recorded pool's
/// stacks), in the reviewed wording:
///
/// All participant stacks are pairwise disjoint and disjoint from module-owned memory, descriptor/control, A/B,
/// and the writable arena; the host and other jobs leave all job ranges untouched until join, apart from each
/// participant owning only its assigned C columns and scratch slot.
///
/// (For a threaded job the stacks' layout is the recorded pool's, checked as above; what stays the host's is
/// setting each participant's `__stack_pointer` within its own slot.)
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
    let Some(j) = check_part(u64::from(desc), &d, pool().as_ref(), u64::from(id), &facts) else { return 0 };
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

/// X = A \\ B on one thread (numerics-core P2b-2: [`crate::solve::solve`] in the descriptor's mode: gesv, LU
/// whatever A is, no estimate (rcond NaN), as NumPy's solve; or MATLAB, the structure pass, then the diagonal,
/// triangular, Cholesky or LU path, and rcond from the factors, as mldivide): A is overwritten by its LU factors
/// on the LU paths, B by X, ipiv and work are used, and the report is written as [status, first zero diagonal
/// element or pivot's column, kernel name address, kernel name length, structure, rcond's f64 bits (low word,
/// high word)]: status 1 solved, 2 solved with an exactly zero diagonal element or pivot (Inf/NaN in X; rcond
/// 0), 3 not computed (A or B has an Inf or NaN; rcond NaN), 4 solved but nearly singular (0 < rcond < eps);
/// structure 0 general (LU), 1 diagonal, 2 upper triangular, 3 lower triangular, 4 symmetric positive definite
/// (Cholesky), 5 symmetric with a positive diagonal but not positive definite (Cholesky failed, then LU).
/// Returns 1, or 0 if the job was refused, having written nothing.
///
/// Checked here, before any pointer is read or slice made ([`check_solve`]): the descriptor is 4-aligned and
/// in the host's part; each of the five regions (A, B, ipiv, work, report) is aligned, nonzero, at or above
/// `__heap_base`, within memory and at most `isize::MAX` bytes, lies in the arena, and overlaps none of the
/// others; the descriptor lies outside the arena and this thread's frame below it; lda, ldb >= max(n, 1); the
/// mode word is 1 or 2; work holds the mode's `solve_work_len(mode, n, nrhs)`; every size is computed without
/// overflow.
///
/// # Safety
/// Host preconditions (the trusted host's contract for a solve; not checkable here): the caller's whole stack
/// is disjoint from module-owned memory, the descriptor and the arena; A, B, ipiv, work and the report are
/// this call's alone until it returns: no host, other job, thread or allocator reads, writes or reuses them
/// meanwhile; and nothing writes the descriptor during the call.
#[no_mangle]
#[allow(unsafe_code)]
pub unsafe extern "C" fn nd_solve(desc: u32) -> u32 {
    let probe = 0u8;
    let facts = Facts {
        mem: memory_bytes(),
        floor: addr_of!(__heap_base) as usize as u64,
        max_len: isize::MAX as u64,
        frame: core::hint::black_box(addr_of!(probe)) as usize as u64,
    };
    if desc_region_of(u64::from(desc), SOLVE_DESC_WORDS, &facts).is_none() {
        return 0;
    }
    // SAFETY: the descriptor's words lie in the host's part of memory, 4-aligned (checked above)
    let d = with_exposed_provenance::<[u32; SOLVE_DESC_WORDS]>(desc as usize).read();
    let Some(j) = check_solve(u64::from(desc), &d, &facts) else { return 0 };
    let kern = Kernel::selected();
    // SAFETY: each region was checked to be aligned, nonzero, in the host's part, within memory, at most
    // isize::MAX bytes, in the arena and disjoint from the others and from the descriptor; an empty region is
    // the empty slice (no address used)
    let a_len = crate::gemm::span(j.n, j.n, j.lda).unwrap_or(0);
    let b_len = crate::gemm::span(j.n, j.nrhs, j.ldb).unwrap_or(0);
    let a: &mut [f64] = if a_len == 0 { &mut [] } else { core::slice::from_raw_parts_mut(with_exposed_provenance_mut(j.a), a_len) };
    let b: &mut [f64] = if b_len == 0 { &mut [] } else { core::slice::from_raw_parts_mut(with_exposed_provenance_mut(j.b), b_len) };
    let ipiv: &mut [usize] = if j.n == 0 { &mut [] } else { core::slice::from_raw_parts_mut(with_exposed_provenance_mut(j.ipiv), j.n) };
    let work: &mut [f64] = if j.work_len == 0 { &mut [] } else { core::slice::from_raw_parts_mut(with_exposed_provenance_mut(j.work), j.work_len) };
    let report: &mut [u32] = core::slice::from_raw_parts_mut(with_exposed_provenance_mut(j.report), REPORT_WORDS);
    let Ok(rep) = crate::solve::solve(kern, j.mode, a, j.n, j.lda, b, j.nrhs, j.ldb, ipiv, work) else { return 0 };
    use crate::solve::{Status, Structure};
    let (code, col) = match rep.status {
        Status::Solved => (1, 0),
        Status::Singular(c) => (2, c as u32),
        Status::NonFinite => (3, 0),
        Status::NearlySingular => (4, 0),
    };
    let shape = match rep.structure {
        Structure::General => 0,
        Structure::Diagonal => 1,
        Structure::Upper => 2,
        Structure::Lower => 3,
        Structure::Spd => 4,
        Structure::SpdFallback => 5,
    };
    let bits = rep.rcond.to_bits();
    report.copy_from_slice(&[code, col, kern.name().as_ptr() as usize as u32, kern.name().len() as u32, shape, bits as u32, (bits >> 32) as u32]);
    1
}

/// A = R'R on one thread ([`crate::chol::potrf`], numerics-core CHOL-1): R overwrites A's upper triangle (A's
/// strictly lower part is not meaningful afterwards), work is used, and the report is written as [status, column, kernel
/// name address, kernel name length]: status 1 factored, 2 not positive definite at the 1-based column (A then
/// holds a partial factorization). Returns 1, or 0 if the job was refused, having written nothing.
///
/// Checked here, before any pointer is read or slice made ([`check_potrf`]): as [`nd_solve`]'s rules, for the
/// three regions A, work and report; lda >= max(n, 1); work holds `potrf_work_len(n)`.
///
/// # Safety
/// [`nd_solve`]'s host preconditions, for this call's A, work and report.
#[no_mangle]
#[allow(unsafe_code)]
pub unsafe extern "C" fn nd_potrf(desc: u32) -> u32 {
    let probe = 0u8;
    let facts = Facts {
        mem: memory_bytes(),
        floor: addr_of!(__heap_base) as usize as u64,
        max_len: isize::MAX as u64,
        frame: core::hint::black_box(addr_of!(probe)) as usize as u64,
    };
    if desc_region_of(u64::from(desc), POTRF_DESC_WORDS, &facts).is_none() {
        return 0;
    }
    // SAFETY: the descriptor's words lie in the host's part of memory, 4-aligned (checked above)
    let d = with_exposed_provenance::<[u32; POTRF_DESC_WORDS]>(desc as usize).read();
    let Some(j) = check_potrf(u64::from(desc), &d, &facts) else { return 0 };
    let kern = Kernel::selected();
    // SAFETY: as nd_solve's, for A, work and the report
    let a_len = crate::gemm::span(j.n, j.n, j.lda).unwrap_or(0);
    let a: &mut [f64] = if a_len == 0 { &mut [] } else { core::slice::from_raw_parts_mut(with_exposed_provenance_mut(j.a), a_len) };
    let work: &mut [f64] = if j.work_len == 0 { &mut [] } else { core::slice::from_raw_parts_mut(with_exposed_provenance_mut(j.work), j.work_len) };
    let report: &mut [u32] = core::slice::from_raw_parts_mut(with_exposed_provenance_mut(j.report), POTRF_REPORT_WORDS);
    let Ok(info) = crate::chol::potrf(kern, a, j.n, j.lda, work) else { return 0 };
    let (code, col) = match info {
        None => (1, 0),
        Some(k) => (2, k as u32 + 1),
    };
    report.copy_from_slice(&[code, col, kern.name().as_ptr() as usize as u32, kern.name().len() as u32]);
    1
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
