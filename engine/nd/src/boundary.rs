//! The boundary of the WebAssembly entry points ([`crate::wasm`]), checked in safe code before any pointer is
//! read or slice made. Target-independent, so that native tests cover it with wasm32's limits.
//!
//! The memory model (r4.2 §6, E1/ND-M1): linear memory below `floor` (the linker's `__heap_base`) is the
//! module's own: its static data and the linker's stack. Above it, the host lays out
//! - the descriptor and its control words, read only by the module;
//! - one writable arena `[lo, hi)`, which holds C and the scratch (and usually A and B);
//! - one stack per thread, every one below the arena (a stack grows down, so it never reaches the arena).
//!
//! Enforced here: every nonempty region (descriptor included) starts at or above `floor` (so never at address
//! 0, never on the module's statics), is aligned, and ends within memory, its length at most `max_len`
//! (`isize::MAX`: a slice's limit); the arena is above `floor` and within memory; C and the scratch lie in the
//! arena; the descriptor lies outside it; C and the scratch overlap neither A, B nor each other; and the calling
//! thread's own frame lies below the arena. That last check is per thread: that every *other* participant's
//! stack is below the arena too, with all stacks mutually disjoint and disjoint from the module's own memory,
//! the descriptor and every operand and scratch region, is the trusted host's precondition (the page asserts
//! its layout), as is that nothing but the job's own calls (each writing only its columns of C and its scratch)
//! writes the descriptor, A, B, C or the scratch until every participant has returned (`nd_gemm_part`).

use crate::gemm::scratch_len;

/// The job descriptor, laid out by the host as u32s at `desc` (4-aligned):
/// [a, b, c, m, n, k, threads, scratch0, scratch_stride, arena_lo, arena_hi] (byte addresses; scratch for
/// thread `id` at scratch0 + id * scratch_stride, at least `scratch_len() * 8` bytes each).
pub const DESC_WORDS: usize = 11;

/// What the module knows of its memory at a call: its size in bytes, the floor of the host's part (the
/// linker's `__heap_base`), the longest slice in bytes (`isize::MAX`), and the address of the calling
/// thread's current frame.
pub struct Facts {
    pub mem: u64,
    pub floor: u64,
    pub max_len: u64,
    pub frame: u64,
}

/// A job that passed [`check`]: byte addresses and sizes.
pub struct Job {
    pub a: usize,
    pub b: usize,
    pub c: usize,
    pub m: usize,
    pub n: usize,
    pub k: usize,
    pub threads: usize,
    pub s0: usize,
    pub sstride: usize,
}

/// A byte region [start, start + len) in the host's part of memory, 64-bit: `None` if nonempty and it starts
/// below the floor (or at 0), is longer than a slice may be, overflows or runs past the memory. An empty
/// region is `(start, start)` and never dereferenced.
fn region(start: u64, len: u64, l: &Facts) -> Option<(u64, u64)> {
    if len == 0 {
        return Some((start, start));
    }
    if start == 0 || start < l.floor || len > l.max_len {
        return None;
    }
    let end = start.checked_add(len)?;
    (end <= l.mem).then_some((start, end))
}

/// Whether two byte regions overlap (empty regions overlap nothing).
fn overlap(x: (u64, u64), y: (u64, u64)) -> bool {
    x.0 < x.1 && y.0 < y.1 && x.0 < y.1 && y.0 < x.1
}

/// Whether region `r` lies within `outer` (an empty region lies anywhere).
fn within(r: (u64, u64), outer: (u64, u64)) -> bool {
    r.0 == r.1 || (outer.0 <= r.0 && r.1 <= outer.1)
}

/// The descriptor's region, if `desc` may be read: 4-aligned, in the host's part, within memory.
pub fn desc_region(desc: u64, l: &Facts) -> Option<(u64, u64)> {
    if desc % 4 != 0 {
        return None;
    }
    region(desc, (DESC_WORDS * 4) as u64, l)
}

/// Every boundary rule (above), from the descriptor's address and words.
pub fn check(desc: u64, d: &[u32; DESC_WORDS], l: &Facts) -> Option<Job> {
    let rd = desc_region(desc, l)?;
    let [a, b, c, m, n, k, threads, s0, sstride, lo, hi] = d.map(u64::from);
    if threads == 0 || [a, b, c, s0, sstride].iter().any(|x| x % 8 != 0) || sstride < scratch_len() as u64 * 8 {
        return None;
    }
    let arena = region(lo, hi.checked_sub(lo).filter(|&len| len > 0)?, l)?;
    let ra = region(a, m.checked_mul(k)?.checked_mul(8)?, l)?;
    let rb = region(b, k.checked_mul(n)?.checked_mul(8)?, l)?;
    let rc = region(c, m.checked_mul(n)?.checked_mul(8)?, l)?;
    let rs = region(s0, threads.checked_mul(sstride)?, l)?;
    // (written regions: C and the scratch, in the arena and disjoint from everything else; thread partitions
    // within them are disjoint by construction: C's by partition(), the scratch by stride >= scratch_len)
    let written_ok = within(rc, arena) && within(rs, arena) && !overlap(rd, arena) && l.frame < arena.0;
    let disjoint = !(overlap(rc, ra) || overlap(rc, rb) || overlap(rs, ra) || overlap(rs, rb) || overlap(rs, rc));
    if !written_ok || !disjoint {
        return None;
    }
    let u = |x: u64| usize::try_from(x).ok();
    Some(Job { a: u(a)?, b: u(b)?, c: u(c)?, m: u(m)?, n: u(n)?, k: u(k)?, threads: u(threads)?, s0: u(s0)?, sstride: u(sstride)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    // wasm32's limits: a 4 GiB memory, slices up to 2^31 - 1 bytes; the floor and frame as in the demo
    const L: Facts = Facts { mem: 1 << 32, floor: 1 << 20, max_len: i32::MAX as u64, frame: 5 << 20 };
    const DESC: u64 = 8 << 20;
    const LO: u64 = 16 << 20;

    // a good 4x4x4 job, 2 threads, all in the arena [LO, LO + 1 MiB + scratch)
    fn good() -> [u32; DESC_WORDS] {
        let s = scratch_len() as u32 * 8;
        let lo = LO as u32;
        [lo, lo + 128, lo + 256, 4, 4, 4, 2, lo + 384, s, lo, lo + 384 + 2 * s]
    }

    #[test]
    fn good_job_passes() {
        assert!(check(DESC, &good(), &L).is_some());
    }

    #[test]
    fn slices_longer_than_isize_are_refused() {
        // (astra's probe: an A of exactly 2^31 bytes, m = 1, k = 2^28, n = 0, inside a 4 GiB memory)
        let mut d = good();
        d[0] = 1 << 31;
        d[3] = 1;
        d[5] = 1 << 28;
        d[4] = 0;
        assert!(check(DESC, &d, &L).is_none());
        d[5] = (1 << 28) - 1; // 2^31 - 8 bytes: a slice may be that long
        assert!(check(DESC, &d, &L).is_some());
    }

    #[test]
    fn floor_null_arena_stack_and_descriptor_rules() {
        let refused = |what: &str, i: usize, v: u32| {
            let mut d = good();
            d[i] = v;
            assert!(check(DESC, &d, &L).is_none(), "{what}");
        };
        refused("C at 0", 2, 0);
        refused("scratch at 0", 7, 0);
        refused("A at 0", 0, 0);
        refused("C below the floor (on the module's statics)", 2, 8);
        refused("C outside the arena", 2, (LO + (4 << 20)) as u32);
        refused("an arena below the floor", 9, 0);
        refused("an empty arena", 10, LO as u32);
        let at = |desc: u64| check(desc, &good(), &L).is_none();
        assert!(at(0), "the descriptor at 0");
        assert!(at(8), "the descriptor on the module's statics");
        assert!(at(DESC + 2), "a misaligned descriptor");
        assert!(at(LO + 256), "the descriptor on C");
        assert!(at(LO + 384), "the descriptor on the scratch");
        assert!(at(LO + 100), "the descriptor in the arena");
        assert!(check(DESC, &good(), &Facts { frame: LO + 8, ..L }).is_none(), "the caller's frame in the arena");
        assert!(check(DESC, &good(), &Facts { frame: LO + (64 << 20), ..L }).is_none(), "the caller's frame above it");
        refused("the scratch outside the arena (the arena ending at it)", 10, (LO + 384) as u32);
        // (address 0 is refused even with a floor of 0; an arena below the floor, or past memory, is refused
        // even when C, the scratch and the frame would allow it)
        let zero = Facts { floor: 0, ..L };
        assert!(check(DESC, &{ let mut d = good(); d[0] = 0; d }, &zero).is_none(), "A at 0, floor 0");
        assert!(check(0, &good(), &zero).is_none(), "the descriptor at 0, floor 0");
        let low = Facts { frame: 0, ..L };
        assert!(check(DESC, &{ let mut d = good(); d[9] = (L.floor - 64) as u32; d }, &low).is_none(), "an arena from below the floor");
        let small = Facts { mem: LO + (4 << 20), ..L };
        assert!(check(DESC, &good(), &small).is_some());
        assert!(check(DESC, &{ let mut d = good(); d[10] = (small.mem + 8) as u32; d }, &small).is_none(), "an arena past memory");
        // empty operands may sit anywhere (never dereferenced), and C before A is fine
        let mut d = good();
        d[4] = 0;
        d[2] = 0;
        assert!(check(DESC, &d, &L).is_some());
        let mut d = good();
        d.swap(0, 2);
        assert!(check(DESC, &d, &L).is_some());
    }
}
