//! The WebAssembly entry points (browser B1, and the Node CLI without the native addon), on a shared memory:
//! the host (JS) lays out the operands and one scratch area per thread, starts the worker instances (each on
//! its own stack) and runs `nd_gemm_part(desc, id)` on every thread; it waits for them with Atomics, since the
//! Wasm wait instructions are not yet stable in Rust. Every call returns before the host reads C (r4.2 §6).
//!
//! The boundary is checked before any slice exists ([`check`], safe code): every address, length and end in
//! 64-bit arithmetic against the memory's current size, alignment, and the alias rule (the regions written, C
//! and the scratch, are disjoint from every other region; A and B, only read, may overlap each other). A job
//! that fails a check returns 0 having written nothing.

use crate::gemm::{gemm_cols, partition, scratch_len, Mat};
use core::arch::wasm32::memory_size;

/// The job descriptor, laid out by the host as u32s at `desc` (4-aligned):
/// [a, b, c, m, n, k, threads, scratch0, scratch_stride] (byte addresses; scratch for thread `id` at
/// scratch0 + id * scratch_stride, at least `scratch_len() * 8` bytes each).
const DESC_WORDS: usize = 9;

/// A job that passed [`check`]: element offsets (f64 index = byte address / 8) and sizes.
struct Job {
    a: usize,
    b: usize,
    c: usize,
    m: usize,
    n: usize,
    k: usize,
    threads: usize,
    s0: usize,
    sstride: usize,
}

/// A byte region [start, start + len), 64-bit; `None` if it overflows or runs past `mem`.
fn region(start: u64, len: u64, mem: u64) -> Option<(u64, u64)> {
    let end = start.checked_add(len)?;
    (end <= mem).then_some((start, end))
}

/// Whether two byte regions overlap (empty regions overlap nothing).
fn overlap(x: (u64, u64), y: (u64, u64)) -> bool {
    x.0 < x.1 && y.0 < y.1 && x.0 < y.1 && y.0 < x.1
}

/// Every boundary rule, in safe code, from the descriptor words and the memory size in bytes.
fn check(d: &[u32; DESC_WORDS], mem: u64) -> Option<Job> {
    let [a, b, c, m, n, k, threads, s0, sstride] = d.map(u64::from);
    if threads == 0 || [a, b, c, s0, sstride].iter().any(|x| x % 8 != 0) || sstride < scratch_len() as u64 * 8 {
        return None;
    }
    let ra = region(a, m.checked_mul(k)?.checked_mul(8)?, mem)?;
    let rb = region(b, k.checked_mul(n)?.checked_mul(8)?, mem)?;
    let rc = region(c, m.checked_mul(n)?.checked_mul(8)?, mem)?;
    let rs = region(s0, threads.checked_mul(sstride)?, mem)?;
    // (written regions: C and the scratch, disjoint from everything else; thread partitions within them are
    // disjoint by construction: C's by partition(), the scratch by stride >= scratch_len)
    if overlap(rc, ra) || overlap(rc, rb) || overlap(rs, ra) || overlap(rs, rb) || overlap(rs, rc) {
        return None;
    }
    let u = |x: u64| usize::try_from(x).ok();
    Some(Job { a: u(a / 8)?, b: u(b / 8)?, c: u(c / 8)?, m: u(m)?, n: u(n)?, k: u(k)?, threads: u(threads)?, s0: u(s0 / 8)?, sstride: u(sstride / 8)? })
}

/// The memory's current size in bytes (64-bit: a 4 GiB memory is 2^32).
fn memory_bytes() -> u64 {
    memory_size(0) as u64 * 65536
}

/// The f64 count of one thread's scratch, for the host's layout. (`no_mangle` is the only unsafe part:
/// an exported symbol name, unique in this module)
#[no_mangle]
#[allow(unsafe_code)]
pub extern "C" fn nd_gemm_scratch_len() -> u32 {
    scratch_len() as u32
}

/// Thread `id`'s share of C = A * B (its columns, [`partition`]). Returns 1 on success (an `id` at or
/// beyond the job's thread count has nothing to do), 0 if the job was refused, having written nothing.
///
/// Checked here, before any slice is made ([`check`]): the descriptor lies in memory and is 4-aligned; A, B,
/// C and the scratch lie in memory, 8-aligned, with lengths and ends computed without overflow; C and the
/// scratch overlap neither A, B nor each other; the stride holds a thread's scratch.
///
/// # Safety
/// Host preconditions, not checkable here: no one else writes A, B, C or the scratch during the call, and
/// every thread of the job is called with the same descriptor contents and a distinct `id` (so the threads'
/// columns of C and scratch areas, disjoint by construction, belong to one thread each).
#[no_mangle]
#[allow(unsafe_code)]
pub unsafe extern "C" fn nd_gemm_part(desc: u32, id: u32) -> u32 {
    let mem = memory_bytes();
    if desc % 4 != 0 || region(u64::from(desc), (DESC_WORDS * 4) as u64, mem).is_none() {
        return 0;
    }
    // SAFETY: the descriptor's DESC_WORDS u32s lie in memory, 4-aligned (checked above)
    let d = *(desc as usize as *const [u32; DESC_WORDS]);
    let Some(j) = check(&d, mem) else { return 0 };
    let id = id as usize;
    if id >= j.threads {
        return 1;
    }
    let (j0, j1) = partition(j.n, j.threads, id);
    let base = 0 as *mut f64;
    // SAFETY: every region was checked to lie in memory and be 8-aligned, and the written ones (this thread's
    // columns of C, its scratch) to be disjoint from the read-only A and B; an empty region is the empty slice
    let av: &[f64] = if j.m * j.k == 0 { &[] } else { core::slice::from_raw_parts(base.add(j.a), j.m * j.k) };
    let bv: &[f64] = if j.k * j.n == 0 { &[] } else { core::slice::from_raw_parts(base.add(j.b), j.k * j.n) };
    let cv: &mut [f64] = if (j1 - j0) * j.m == 0 { &mut [] } else { core::slice::from_raw_parts_mut(base.add(j.c + j0 * j.m), (j1 - j0) * j.m) };
    let sv: &mut [f64] = core::slice::from_raw_parts_mut(base.add(j.s0 + id * j.sstride), scratch_len());
    let (Some(am), Some(bm)) = (Mat::new(av, j.m, j.k, j.m.max(1)), Mat::new(bv, j.k, j.n, j.k.max(1))) else { return 0 };
    gemm_cols(&am, &bm, cv, j.m.max(1), j0, j1, sv) as u32
}

/// The selected microkernel's name (written as UTF-8 at `out`, at most `cap` bytes); returns its length, or 0
/// if the buffer does not lie in memory.
///
/// # Safety
/// No host precondition beyond the memory itself: the buffer is checked to lie in memory before it is written.
#[no_mangle]
#[allow(unsafe_code)]
pub unsafe extern "C" fn nd_microkernel(out: u32, cap: u32) -> u32 {
    let s = crate::micro::name().as_bytes();
    let n = s.len().min(cap as usize);
    if n == 0 || out == 0 || region(u64::from(out), n as u64, memory_bytes()).is_none() {
        return 0;
    }
    // SAFETY: [out, out + n) lies in memory (checked above) and is not the source (a static in the data segment
    // is read-only by convention; copy_nonoverlapping's regions are distinct unless the host aims out at it)
    core::ptr::copy(s.as_ptr(), out as usize as *mut u8, n);
    n as u32
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
