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
//! thread's own frame lies below the arena. That last check is per thread; the rest is the trusted host's
//! precondition (stated on `nd_gemm_part`; the page asserts its layout): "All participant stacks are pairwise
//! disjoint and disjoint from module-owned memory, descriptor/control, A/B, and the writable arena; the host and
//! other jobs leave all job ranges untouched until join, apart from each participant owning only its assigned C
//! columns and scratch slot."

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
    span(start, len, l, l.max_len)
}

/// [`region`] with its own longest length: `l.max_len` for a region that becomes a slice; the memory's size for
/// the arena, which never does (an arena over 2 GiB in a 4 GiB memory is fine; each slice in it is checked).
fn span(start: u64, len: u64, l: &Facts, longest: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return Some((start, start));
    }
    if start == 0 || start < l.floor || len > longest {
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
    desc_region_of(desc, DESC_WORDS, l)
}

/// [`desc_region`] for a descriptor of `words` u32s.
pub fn desc_region_of(desc: u64, words: usize, l: &Facts) -> Option<(u64, u64)> {
    if desc % 4 != 0 {
        return None;
    }
    region(desc, (words * 4) as u64, l)
}

/// Every boundary rule (above), from the descriptor's address and words.
pub fn check(desc: u64, d: &[u32; DESC_WORDS], l: &Facts) -> Option<Job> {
    layout(desc, d, l).map(|(j, _)| j)
}

/// [`check`], and the job's regions: the descriptor, the arena, A, B, C and the scratch.
fn layout(desc: u64, d: &[u32; DESC_WORDS], l: &Facts) -> Option<(Job, [(u64, u64); 6])> {
    let rd = desc_region(desc, l)?;
    let [a, b, c, m, n, k, threads, s0, sstride, lo, hi] = d.map(u64::from);
    if threads == 0 || [a, b, c, s0, sstride].iter().any(|x| x % 8 != 0) || sstride < scratch_len() as u64 * 8 {
        return None;
    }
    let arena = span(lo, hi.checked_sub(lo).filter(|&len| len > 0)?, l, l.mem)?;
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
    let j = Job { a: u(a)?, b: u(b)?, c: u(c)?, m: u(m)?, n: u(n)?, k: u(k)?, threads: u(threads)?, s0: u(s0)?, sstride: u(sstride)? };
    Some((j, [rd, arena, ra, rb, rc, rs]))
}

/// The thread pool's control words: [`CTL_BYTES`] bytes, 64-aligned, used by the host with atomics only.
pub const CTL_BYTES: u64 = 64;
/// The most participants a pool may have (the host's cap is lower: min(cores - 1, 8) helpers and the caller).
pub const MAX_PARTICIPANTS: u64 = 16;

/// A thread pool's layout (threads r2, contract 3), recorded once by the host (`nd_pool_init`) and immutable
/// after: the control words at `ctl`; then `participants` stack slots of `slot` bytes each, contiguous from
/// `stacks` (participant `id`'s is [stacks + id * slot, stacks + (id + 1) * slot)).
#[derive(Clone, Copy)]
pub struct Pool {
    pub ctl: u64,
    pub stacks: u64,
    pub slot: u64,
    pub participants: u64,
}

/// The pool's two regions, the control words and the stacks, if its layout is good: 2 to
/// [`MAX_PARTICIPANTS`] participants; the control words 64-aligned, the stacks and the slot size 16-aligned
/// and nonzero; each region in the host's part of memory (at or above the floor) and within memory, every size
/// computed without overflow; and the two disjoint.
pub fn pool_regions(p: &Pool, l: &Facts) -> Option<[(u64, u64); 2]> {
    if !(2..=MAX_PARTICIPANTS).contains(&p.participants) || p.ctl % 64 != 0 || p.stacks % 16 != 0 || p.slot == 0 || p.slot % 16 != 0 {
        return None;
    }
    let rc = region(p.ctl, CTL_BYTES, l)?;
    let rs = span(p.stacks, p.slot.checked_mul(p.participants)?, l, l.mem)?;
    (!overlap(rc, rs)).then_some([rc, rs])
}

/// [`check`] for participant `id` of a job: a job on more than one thread needs the recorded pool; its thread
/// count at most the pool's participants, `id` one of them; the control words and every stack disjoint from
/// the descriptor, the arena, A, B, C and the scratch; and the calling thread's frame in its own stack slot.
/// (A one-thread job runs on the caller's stack, below the arena, as [`check`] has it, pool or not.)
pub fn check_part(desc: u64, d: &[u32; DESC_WORDS], pool: Option<&Pool>, id: u64, l: &Facts) -> Option<Job> {
    let (j, job) = layout(desc, d, l)?;
    if j.threads == 1 {
        return Some(j);
    }
    let p = pool?;
    let [rc, rs] = pool_regions(p, l)?;
    if j.threads as u64 > p.participants || id >= p.participants || job.iter().any(|&r| overlap(r, rc) || overlap(r, rs)) {
        return None;
    }
    // (the slot's bounds cannot overflow: the stacks' end was computed without overflow)
    let own = p.stacks + id * p.slot;
    (own <= l.frame && l.frame < own + p.slot).then_some(j)
}

/// The solve descriptor (`nd_solve`), u32s at `desc` (4-aligned):
/// [a, b, ipiv, work, report, n, nrhs, lda, ldb, work_len, arena_lo, arena_hi, mode] (byte addresses; A n x n
/// with leading dimension lda and B n x nrhs with ldb, f64; ipiv n usizes; work work_len f64s; report
/// [`REPORT_WORDS`] u32s; mode 1 gesv, 2 MATLAB ([`crate::solve::Mode`]), any other value refused).
pub const SOLVE_DESC_WORDS: usize = 13;
/// The solve's report: [status, first zero diagonal or pivot column, kernel name address, kernel name length,
/// structure, rcond's f64 bits low word, high word].
pub const REPORT_WORDS: usize = 7;

/// A solve that passed [`check_solve`]: byte addresses and sizes.
pub struct SolveJob {
    pub a: usize,
    pub b: usize,
    pub ipiv: usize,
    pub work: usize,
    pub report: usize,
    pub n: usize,
    pub nrhs: usize,
    pub lda: usize,
    pub ldb: usize,
    pub work_len: usize,
    pub mode: crate::solve::Mode,
}

/// Every boundary rule for a solve, from the descriptor's address and words. All five regions are written, so
/// each lies in the arena, aligned to its element, above the floor, within memory and at most `max_len` bytes,
/// and they are pairwise disjoint; the descriptor lies outside the arena and the caller's frame below it; the
/// layouts are consistent (lda, ldb >= max(n, 1)), the mode is 1 or 2, the work is at least the mode's
/// `solve_work_len(mode, n, nrhs)`, and every size is computed without overflow.
pub fn check_solve(desc: u64, d: &[u32; SOLVE_DESC_WORDS], l: &Facts) -> Option<SolveJob> {
    let rd = desc_region_of(desc, SOLVE_DESC_WORDS, l)?;
    let [a, b, ipiv, work, report, n, nrhs, lda, ldb, work_len, lo, hi, mode] = d.map(u64::from);
    let mode = match mode {
        1 => crate::solve::Mode::Gesv,
        2 => crate::solve::Mode::Matlab,
        _ => return None,
    };
    let us = core::mem::size_of::<usize>() as u64;
    let u = |x: u64| usize::try_from(x).ok();
    let (nu, ru, ldau, ldbu, wu) = (u(n)?, u(nrhs)?, u(lda)?, u(ldb)?, u(work_len)?);
    if [a, b, work].iter().any(|x| x % 8 != 0) || ipiv % us != 0 || report % 4 != 0 {
        return None;
    }
    let need = crate::solve::solve_work_len(mode, nu, ru)?;
    if wu < need {
        return None;
    }
    let arena = span(lo, hi.checked_sub(lo).filter(|&len| len > 0)?, l, l.mem)?;
    let elems = |rows: usize, cols: usize, ld: usize| crate::gemm::span(rows, cols, ld).and_then(|e| (e as u64).checked_mul(8));
    let regions = [
        region(a, elems(nu, nu, ldau)?, l)?,
        region(b, elems(nu, ru, ldbu)?, l)?,
        region(ipiv, n.checked_mul(us)?, l)?,
        region(work, work_len.checked_mul(8)?, l)?,
        region(report, (REPORT_WORDS * 4) as u64, l)?,
    ];
    if overlap(rd, arena) || l.frame >= arena.0 {
        return None;
    }
    for (i, r) in regions.iter().enumerate() {
        if !within(*r, arena) || regions[i + 1..].iter().any(|q| overlap(*r, *q)) {
            return None;
        }
    }
    Some(SolveJob { a: u(a)?, b: u(b)?, ipiv: u(ipiv)?, work: u(work)?, report: u(report)?, n: nu, nrhs: ru, lda: ldau, ldb: ldbu, work_len: wu, mode })
}

/// The Cholesky descriptor (`nd_potrf`), u32s at `desc` (4-aligned): [a, work, report, n, lda, work_len,
/// arena_lo, arena_hi] (byte addresses; A n x n with leading dimension lda, f64; work work_len f64s; report
/// [`POTRF_REPORT_WORDS`] u32s).
pub const POTRF_DESC_WORDS: usize = 8;
/// The Cholesky report: [status, first column whose pivot is not positive (1-based; 0 if none), kernel name
/// address, kernel name length].
pub const POTRF_REPORT_WORDS: usize = 4;

/// A Cholesky factorization that passed [`check_potrf`]: byte addresses and sizes.
pub struct PotrfJob {
    pub a: usize,
    pub work: usize,
    pub report: usize,
    pub n: usize,
    pub lda: usize,
    pub work_len: usize,
}

/// Every boundary rule for a Cholesky factorization, as [`check_solve`]'s for its three regions (A, work,
/// report): each in the arena, aligned to its element, above the floor, within memory, at most `max_len`
/// bytes and pairwise disjoint; the descriptor outside the arena and the caller's frame below it; lda >=
/// max(n, 1); work at least `potrf_work_len(n)`; every size computed without overflow.
pub fn check_potrf(desc: u64, d: &[u32; POTRF_DESC_WORDS], l: &Facts) -> Option<PotrfJob> {
    let rd = desc_region_of(desc, POTRF_DESC_WORDS, l)?;
    let [a, work, report, n, lda, work_len, lo, hi] = d.map(u64::from);
    let u = |x: u64| usize::try_from(x).ok();
    let (nu, ldau, wu) = (u(n)?, u(lda)?, u(work_len)?);
    if [a, work].iter().any(|x| x % 8 != 0) || report % 4 != 0 {
        return None;
    }
    if wu < crate::chol::potrf_work_len(nu)? {
        return None;
    }
    let arena = span(lo, hi.checked_sub(lo).filter(|&len| len > 0)?, l, l.mem)?;
    let elems = crate::gemm::span(nu, nu, ldau).and_then(|e| (e as u64).checked_mul(8))?;
    let regions = [region(a, elems, l)?, region(work, work_len.checked_mul(8)?, l)?, region(report, (POTRF_REPORT_WORDS * 4) as u64, l)?];
    if overlap(rd, arena) || l.frame >= arena.0 {
        return None;
    }
    for (i, r) in regions.iter().enumerate() {
        if !within(*r, arena) || regions[i + 1..].iter().any(|q| overlap(*r, *q)) {
            return None;
        }
    }
    Some(PotrfJob { a: u(a)?, work: u(work)?, report: u(report)?, n: nu, lda: ldau, work_len: wu })
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

    /// A good solve layout: n = 10, nrhs = 2, lda = 12, ldb = 11, all in the arena from LO.
    fn good_solve() -> [u32; SOLVE_DESC_WORDS] {
        let (n, r, lda, ldb) = (10u64, 2u64, 12u64, 11u64);
        let wl = crate::solve::solve_work_len(crate::solve::Mode::Matlab, n as usize, r as usize).unwrap() as u64;
        let us = core::mem::size_of::<usize>() as u64;
        let a = LO;
        let b = a + 8 * (lda * (n - 1) + n);
        let ipiv = (b + 8 * (ldb * (r - 1) + n) + 7) / 8 * 8;
        let work = (ipiv + us * n + 7) / 8 * 8;
        let report = work + 8 * wl;
        let hi = report + 4 * REPORT_WORDS as u64;
        [a, b, ipiv, work, report, n, r, lda, ldb, wl, LO, hi, 2].map(|x| x as u32)
    }

    #[test]
    fn solve_layouts() {
        let g = good_solve();
        assert!(check_solve(DESC, &g, &L).is_some());
        let refused = |what: &str, i: usize, v: u32| {
            let mut d = g;
            d[i] = v;
            assert!(check_solve(DESC, &d, &L).is_none(), "{what}");
        };
        // (alignment, null, floor)
        refused("A misaligned", 0, g[0] + 4);
        refused("ipiv misaligned", 2, g[2] + 2);
        refused("work misaligned", 3, g[3] + 4);
        refused("report misaligned", 4, g[4] + 2);
        refused("A at 0", 0, 0);
        refused("report below the floor", 4, 64);
        // (layouts, work)
        refused("lda < n", 7, 9);
        refused("ldb < n", 8, 9);
        refused("work one short", 9, g[9] - 1);
        refused("n overflowing", 5, u32::MAX);
        // (the mode: only 1 (gesv) and 2 (MATLAB); gesv's smaller work is enough for gesv only)
        refused("mode 0", 12, 0);
        refused("mode 3", 12, 3);
        refused("mode u32::MAX", 12, u32::MAX);
        let gl = crate::solve::solve_work_len(crate::solve::Mode::Gesv, 10, 2).unwrap() as u32;
        let mut gm = g;
        gm[12] = 1;
        gm[9] = gl;
        assert!(check_solve(DESC, &gm, &L).is_some(), "gesv with gesv's work");
        gm[9] = gl - 1;
        assert!(check_solve(DESC, &gm, &L).is_none(), "gesv one short");
        refused("MATLAB mode with gesv's work", 9, gl);
        // (the arena, the descriptor, the frame)
        refused("report past the arena", 11, g[11] - 8);
        // (grader T3: each region alone just outside the arena, past its end, everything else as good; the place
        // 8-aligned so that only the arena refuses it (#621 G-T3), and the control: the same place with the arena
        // extended over it is accepted)
        for (i, what) in [(1usize, "B"), (2, "ipiv"), (3, "work")] {
            let mut d = g;
            d[i] = (g[11] + 64 + 7) / 8 * 8;
            assert!(check_solve(DESC, &d, &L).is_none(), "{what} outside the arena");
            d[11] = d[i] + (16 << 20);
            assert!(check_solve(DESC, &d, &L).is_some(), "{what}: the control, inside the extended arena");
        }
        refused("A before the arena", 10, g[0] + 8);
        assert!(check_solve(g[0] as u64 + 8, &g, &L).is_none(), "the descriptor on A");
        assert!(check_solve(DESC, &g, &Facts { frame: LO + 64, ..L }).is_none(), "the frame in the arena");
        // (each pair of the five regions, overlapping by placing one on the other)
        let starts = [0usize, 1, 2, 3, 4];
        for &i in &starts {
            for &j in &starts {
                if i != j {
                    let mut d = g;
                    d[i] = g[j] / 8 * 8 + if i == 2 || i == 4 { 0 } else { 0 };
                    assert!(check_solve(DESC, &d, &L).is_none(), "region {i} placed on region {j}");
                }
            }
        }
        // (an empty problem: n = 0, nothing to place but the report)
        let mut e = g;
        e[5] = 0;
        e[6] = 0;
        e[9] = crate::solve::solve_work_len(crate::solve::Mode::Matlab, 0, 0).unwrap() as u32;
        assert!(check_solve(DESC, &e, &L).is_some());
    }

    /// A good Cholesky layout: n = 10, lda = 12, all in the arena from LO.
    fn good_potrf() -> [u32; POTRF_DESC_WORDS] {
        let (n, lda) = (10u64, 12u64);
        let wl = crate::chol::potrf_work_len(n as usize).unwrap() as u64;
        let a = LO;
        let work = a + 8 * (lda * (n - 1) + n);
        let report = work + 8 * wl;
        let hi = report + 4 * POTRF_REPORT_WORDS as u64;
        [a, work, report, n, lda, wl, LO, hi].map(|x| x as u32)
    }

    #[test]
    fn potrf_layouts() {
        let g = good_potrf();
        assert!(check_potrf(DESC, &g, &L).is_some());
        let refused = |what: &str, i: usize, v: u32| {
            let mut d = g;
            d[i] = v;
            assert!(check_potrf(DESC, &d, &L).is_none(), "{what}");
        };
        // (alignment, null, floor)
        refused("A misaligned", 0, g[0] + 4);
        refused("work misaligned", 1, g[1] + 4);
        refused("report misaligned", 2, g[2] + 2);
        refused("A at 0", 0, 0);
        refused("work at 0", 1, 0);
        refused("report below the floor", 2, 64);
        // (the layout, the work)
        refused("lda < n", 4, 9);
        refused("lda 0", 4, 0);
        refused("work one short", 5, g[5] - 1);
        refused("n overflowing", 3, u32::MAX);
        // (the arena, the descriptor, the frame)
        refused("report past the arena", 7, g[7] - 4);
        refused("A before the arena", 6, g[0] + 8);
        refused("an empty arena", 7, g[6]);
        for (i, what) in [(0usize, "A"), (1, "work"), (2, "report")] {
            let mut d = g;
            d[i] = (g[7] + 64 + 7) / 8 * 8;
            assert!(check_potrf(DESC, &d, &L).is_none(), "{what} outside the arena");
            d[7] = d[i] + (16 << 20);
            assert!(check_potrf(DESC, &d, &L).is_some(), "{what}: the control, inside the extended arena");
        }
        assert!(check_potrf(g[0] as u64 + 8, &g, &L).is_none(), "the descriptor on A");
        assert!(check_potrf(0, &g, &L).is_none(), "the descriptor at 0");
        assert!(check_potrf(DESC + 2, &g, &L).is_none(), "the descriptor misaligned");
        assert!(check_potrf(DESC, &g, &Facts { frame: LO + 64, ..L }).is_none(), "the frame in the arena");
        // (each pair of the three regions, overlapping by placing one on the other)
        for i in 0..3 {
            for j in 0..3 {
                if i != j {
                    let mut d = g;
                    d[i] = g[j];
                    assert!(check_potrf(DESC, &d, &L).is_none(), "region {i} placed on region {j}");
                }
            }
        }
        // (an empty matrix: n = 0, nothing to place but the work's scratch and the report)
        let mut e = g;
        e[3] = 0;
        e[5] = crate::chol::potrf_work_len(0).unwrap() as u32;
        assert!(check_potrf(DESC, &e, &L).is_some());
    }

    // a pool below the descriptor: the control words at 2 MiB, four 256 KiB stacks from 3 MiB
    const SLOT: u64 = 256 << 10;
    const POOL: Pool = Pool { ctl: 2 << 20, stacks: 3 << 20, slot: SLOT, participants: 4 };
    // (participant id's frame, some way into its slot)
    fn on(id: u64) -> Facts {
        Facts { frame: POOL.stacks + id * SLOT + 1000, ..L }
    }
    // good()'s job on `threads` threads, the arena holding their scratch
    fn job(threads: u32) -> [u32; DESC_WORDS] {
        let mut d = good();
        d[6] = threads;
        d[10] = d[7] + threads * d[8];
        d
    }

    #[test]
    fn pool_layouts() {
        assert!(pool_regions(&POOL, &L).is_some());
        let refused = |what: &str, p: Pool| assert!(pool_regions(&p, &L).is_none(), "{what}");
        let accepted = |what: &str, p: Pool| assert!(pool_regions(&p, &L).is_some(), "{what}");
        refused("1 participant", Pool { participants: 1, ..POOL });
        refused("17 participants", Pool { participants: 17, ..POOL });
        accepted("16 participants", Pool { participants: 16, ..POOL });
        refused("control words misaligned", Pool { ctl: POOL.ctl + 32, ..POOL });
        refused("stacks misaligned", Pool { stacks: POOL.stacks + 8, ..POOL });
        refused("slot misaligned", Pool { slot: SLOT + 8, ..POOL });
        refused("slot 0", Pool { slot: 0, ..POOL });
        refused("control words below the floor", Pool { ctl: L.floor - 64, ..POOL });
        refused("stacks below the floor", Pool { stacks: L.floor - 16, ..POOL });
        refused("control words at 0", Pool { ctl: 0, ..POOL });
        refused("control words on the stacks", Pool { ctl: POOL.stacks + 3 * SLOT, ..POOL });
        refused("the stacks' last slot on the control words", Pool { ctl: POOL.stacks + 4 * SLOT - 64, ..POOL });
        accepted("control words just below the stacks", Pool { ctl: POOL.stacks - 64, ..POOL });
        accepted("control words just after the stacks", Pool { ctl: POOL.stacks + 4 * SLOT, ..POOL });
        // (overflow: slot * participants past u64; the largest stacks ending exactly at the memory's end, and 16 bytes more)
        refused("slot * participants overflowing", Pool { slot: (u64::MAX / 2) & !15, ..POOL });
        // (grader B7: 2^62 x 4 is 2^64, which a wrapping product would make 0, an empty and so acceptable region)
        refused("slot * participants wrapping to 0", Pool { slot: 1 << 62, ..POOL });
        let last = (L.mem - POOL.stacks) / 4 / 16 * 16;
        let top = Pool { stacks: L.mem - 4 * last, slot: last, ..POOL };
        accepted("stacks ending at the memory's end", top);
        refused("stacks one slot-step past it", Pool { slot: last + 16, ..top });
    }

    #[test]
    fn participant_layouts() {
        // (a one-thread job: the old rule, with or without a pool; a threaded job needs the pool)
        assert!(check_part(DESC, &job(1), None, 0, &L).is_some(), "1 thread, no pool");
        assert!(check_part(DESC, &job(1), Some(&POOL), 0, &on(0)).is_some(), "1 thread, a pool");
        assert!(check_part(DESC, &job(2), None, 0, &on(0)).is_none(), "2 threads, no pool");
        for id in 0..4 {
            assert!(check_part(DESC, &job(2), Some(&POOL), id, &on(id)).is_some(), "participant {id}");
            assert!(check_part(DESC, &job(4), Some(&POOL), id, &on(id)).is_some(), "participant {id} of 4");
        }
        // (threads = participants accepted, one more refused; an id past the pool refused)
        assert!(check_part(DESC, &job(5), Some(&POOL), 0, &on(0)).is_none(), "5 threads, a 4-participant pool");
        assert!(check_part(DESC, &job(2), Some(&POOL), 4, &Facts { frame: POOL.stacks + 4 * SLOT + 1000, ..L }).is_none(), "id 4");
        let bad = Pool { participants: 1, ..POOL };
        assert!(check_part(DESC, &job(2), Some(&bad), 0, &on(0)).is_none(), "a bad pool");
        // (the frame: its slot's first and last byte accepted; one past either end, or another's slot, refused)
        for id in 0..4u64 {
            let own = POOL.stacks + id * SLOT;
            let at = |frame: u64| check_part(DESC, &job(2), Some(&POOL), id, &Facts { frame, ..L }).is_some();
            assert!(at(own), "{id}: the slot's first byte");
            assert!(at(own + SLOT - 1), "{id}: the slot's last byte");
            assert!(!at(own + SLOT), "{id}: one past the slot");
            assert!(!at(own - 1), "{id}: one below the slot");
        }
        assert!(check_part(DESC, &job(2), Some(&POOL), 1, &on(2)).is_none(), "participant 1 on participant 2's stack");
        // (the control words, then the stacks, on each of the job's regions: refused; just next to them: accepted)
        let d = job(4);
        let places = [("the descriptor", DESC), ("the arena", d[9] as u64 + 512), ("A", d[0] as u64), ("B", d[1] as u64), ("C", d[2] as u64), ("the scratch", d[7] as u64)];
        for (what, at) in places {
            let ctl = at / 64 * 64;
            assert!(check_part(DESC, &d, Some(&Pool { ctl, ..POOL }), 0, &on(0)).is_none(), "the control words on {what}");
            let stacks = at / 16 * 16 - 3 * SLOT;
            let p = Pool { stacks, ..POOL };
            assert!(check_part(DESC, &d, Some(&p), 0, &Facts { frame: stacks + 1000, ..L }).is_none(), "the stacks on {what}");
        }
        accepted_adjacent(&d);
    }

    // control words ending where the descriptor starts, stacks ending where the arena starts (the frame in slot 0)
    fn accepted_adjacent(d: &[u32; DESC_WORDS]) {
        let p = Pool { ctl: DESC - 64, ..POOL };
        assert!(check_part(DESC, d, Some(&p), 0, &on(0)).is_some(), "control words just below the descriptor");
        let p = Pool { ctl: DESC + 64, ..POOL };
        assert!(check_part(DESC, d, Some(&p), 0, &on(0)).is_some(), "control words just after the descriptor");
        let stacks = d[9] as u64 - 4 * SLOT;
        let p = Pool { stacks, ..POOL };
        assert!(check_part(DESC, d, Some(&p), 0, &Facts { frame: stacks + 1000, ..L }).is_some(), "stacks just below the arena");
        let p = Pool { stacks: d[10] as u64, ..POOL };
        // (stacks just above the arena: disjoint, but the frame then lies above the arena, which check() refuses)
        assert!(check_part(DESC, d, Some(&p), 0, &Facts { frame: d[10] as u64 + 1000, ..L }).is_none(), "a frame above the arena");
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
        // an arena over 2 GiB is fine (it is never a slice): A of 2^31 - 8 bytes inside it, the scratch after
        let s = scratch_len() as u64 * 8;
        let (a, s0) = (LO, LO + (1 << 31));
        let big = [a, a, a, 1, 0, (1 << 28) - 1, 1, s0, s, LO, s0 + s].map(|x| x as u32);
        assert!(check(DESC, &big, &L).is_some(), "a 2 GiB+ arena");
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
        // (grader T3: C, then the scratch, starting just below the arena, where the stacks are)
        refused("C starting just below the arena", 9, (LO + 256 + 8) as u32);
        let s = scratch_len() as u32 * 8;
        let lo = LO as u32;
        let scratch_first = [lo, lo + 128, lo + 256 + 2 * s, 4, 4, 4, 2, lo + 256, s, lo, lo + 384 + 2 * s];
        assert!(check(DESC, &scratch_first, &L).is_some());
        let mut d = scratch_first;
        d[9] = lo + 256 + 8;
        assert!(check(DESC, &d, &L).is_none(), "the scratch starting just below the arena");
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
