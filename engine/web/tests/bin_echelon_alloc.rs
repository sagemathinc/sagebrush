//! The binary nmod_echelon's peak live memory, measured by a counting
//! allocator: within its reservation (bin_ops::echelon_reservation, a
//! conservative sum) and at least its largest phase (the decoded matrix and
//! the pivots, with the elimination's accumulators or the reply, which never
//! coexist); each killed term of the sum shown necessary at a named shape;
//! the ledger's boundary at exactly the reservation; a refusal allocates
//! nothing but the error reply.  One test (the counters are global).

use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_mat::Mat;
use sagebrush_web::bin_ops::{call_bin, echelon_reply_len, echelon_reservation};
use sagebrush_wire as wire;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
/// Armed (1): the live bytes just after the next allocation are recorded
/// in FIRST_LIVE, with its size in FIRST_SIZE.
static FIRST_ARMED: AtomicUsize = AtomicUsize::new(0);
static FIRST_LIVE: AtomicUsize = AtomicUsize::new(0);
static FIRST_SIZE: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every method forwards to `System` with the caller's own arguments,
// so System's GlobalAlloc contract carries over; the counting only updates
// atomics.
#[allow(unsafe_code)]
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let live = LIVE.fetch_add(l.size(), Relaxed) + l.size();
            PEAK.fetch_max(live, Relaxed);
            if FIRST_ARMED.swap(0, Relaxed) == 1 {
                FIRST_LIVE.store(live, Relaxed);
                FIRST_SIZE.store(l.size(), Relaxed);
            }
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
        LIVE.fetch_sub(l.size(), Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = System.realloc(p, l, new);
        if !q.is_null() {
            // (the old and new blocks may coexist while copying)
            PEAK.fetch_max(LIVE.load(Relaxed) + new, Relaxed);
            if new >= l.size() {
                LIVE.fetch_add(new - l.size(), Relaxed);
            } else {
                LIVE.fetch_sub(l.size() - new, Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static A: Counting = Counting;

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

const P63: u64 = 9223372036854775783;
const W: usize = std::mem::size_of::<usize>();

fn u641(w: &[u64]) -> Vec<u8> {
    let mut v = Vec::new();
    wire::put_u641(&mut v, w);
    v
}

fn req(p: u64, rows: usize, cols: usize, words: &[u64], flags: u64) -> Vec<u8> {
    let mut m = b"MAT1".to_vec();
    m.extend_from_slice(&(rows as u32).to_le_bytes());
    m.extend_from_slice(&(cols as u32).to_le_bytes());
    m.extend(u641(words));
    let args = [u641(&[p]), m, u641(&[flags])];
    let op = "nmod_echelon";
    let mut v = wire::MAGIC.to_vec();
    v.extend_from_slice(&(op.len() as u32).to_le_bytes());
    v.extend_from_slice(op.as_bytes());
    v.extend_from_slice(&(args.len() as u32).to_le_bytes());
    for a in &args {
        v.extend_from_slice(&(a.len() as u32).to_le_bytes());
        v.extend_from_slice(a);
    }
    v
}

/// (growth of live memory during the call, the reply included; the first
/// allocation's size; the reply)
fn measured(r: &[u8]) -> (usize, usize, Vec<u8>) {
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    FIRST_SIZE.store(0, Relaxed);
    FIRST_ARMED.store(1, Relaxed);
    let out = call_bin(r);
    FIRST_ARMED.store(0, Relaxed);
    (PEAK.load(Relaxed) - base, FIRST_SIZE.load(Relaxed), out)
}

fn pivots_of(r: &[u8]) -> usize {
    let ps = wire::parse_reply(r).unwrap().unwrap();
    wire::u641(wire::Arg { bytes: ps[0], offset: 0 }).unwrap().count
}

#[test]
fn the_echelon_allocates_within_its_reservation_and_at_least_its_largest_phase() {
    sagebrush_web::sb_set_memory_total((1u64 << 34) as f64, 0, 0);
    let mut s = 0x9e37_79b9_7f4a_7c15u64;
    // (one call first: the phases' names are registered once, the first
    // time each is entered, and the tally's thread-local is made)
    let warm = req(101, 2, 2, &[1, 2, 3, 4], 3);
    assert!(matches!(wire::parse_reply(&call_bin(&warm)), Ok(Ok(_))));
    let warm = req(9223372036854775783, 2, 2, &[1, 2, 3, 4], 3);
    assert!(matches!(wire::parse_reply(&call_bin(&warm)), Ok(Ok(_))));
    let held = sagebrush_web::sb_outstanding_bytes();
    // (rows, cols, p, want_rows): skinny both ways, square, wide and tall,
    // the u64-sum route (101) and the u128 route with its partial sums (P63)
    let cases = [
        (1usize, 4096usize, 101u64, true),
        (1, 4096, 101, false),
        (4096, 1, 101, true),
        (4096, 1, P63, false),
        (64, 64, 101, true),
        (64, 64, 101, false),
        (64, 64, P63, true),
        (300, 500, 101, false),
        (500, 300, P63, true),
        (1024, 1024, 101, false),
    ];
    for &(r, c, p, rows) in &cases {
        let w: Vec<u64> = (0..r * c).map(|_| rng(&mut s) % p).collect();
        let q = req(p, r, c, &w, if rows { 3 } else { 1 });
        let (g, first, out) = measured(&q);
        assert!(matches!(wire::parse_reply(&out), Ok(Ok(_))), "{r}x{c}");
        let bound = echelon_reservation(r, c, rows).unwrap() as usize;
        let k = pivots_of(&out);
        let reply = echelon_reply_len(r, c, k, rows).unwrap();
        let e = r * c;
        let lower = (8 * e + W * r.min(c) + (24 * c).max(reply)).saturating_sub(4096);
        eprintln!("{r}x{c} p={p} rows={rows}: lower {lower} <= growth {g} <= reservation {bound}");
        assert_eq!(first, 8 * e, "{r}x{c}: the first allocation is the decode");
        assert!(g <= bound, "{r}x{c} p={p}: growth {g} > reservation {bound}");
        assert!(g >= lower, "{r}x{c} p={p}: growth {g} < the largest phase {lower}");
        assert_eq!(sagebrush_web::sb_outstanding_bytes(), held, "{r}x{c}: the reservation is released");
        // the killed omitted-term mutants: without the term, the bound
        // fails at its named shape
        let without = |term: usize| bound - term;
        match (r, c, rows) {
            (64, 64, false) if p == 101 => assert!(g > without(8 * e), "8E is needed at 64x64"),
            (1, 4096, true) => assert!(g > without(32 * c), "32c is needed at 1x4096"),
            (64, 64, true) if p == 101 => {
                let full = echelon_reply_len(r, c, r.min(c), true).unwrap();
                assert!(g > without(full), "P is needed at 64x64 with rows")
            }
            _ => {}
        }
    }

    // the pivots: one allocation of exactly min(r, c) (the first of the
    // elimination's), in both routes
    for &(r, c) in &[(5usize, 9usize), (9, 5), (1, 4096), (700, 700)] {
        let mut a = Mat { rows: r, cols: c, m: Modulus::new(101), d: (0..r * c).map(|_| rng(&mut s) % 101).collect() };
        FIRST_SIZE.store(0, Relaxed);
        FIRST_ARMED.store(1, Relaxed);
        let _ = a.echelon(true, true);
        FIRST_ARMED.store(0, Relaxed);
        assert_eq!(FIRST_SIZE.load(Relaxed), W * r.min(c), "{r}x{c}: the pivots' capacity");
    }

    // the ledger's boundary at exactly the reservation: one fake row of
    // usage 0 (natively the rows measure the process, so a live figure
    // can't give an exact boundary), admitting x iff
    // FRAG_NUM (outstanding + x) <= FRAG_DEN (limit / 4)
    let (r, c) = (40, 60);
    let w: Vec<u64> = (0..r * c).map(|_| rng(&mut s) % 101).collect();
    let q = req(101, r, c, &w, 3);
    let need = echelon_reservation(r, c, true).unwrap();
    let o = held as u64;
    let (num, den) = (sagebrush_ledger::FRAG_NUM, sagebrush_ledger::FRAG_DEN);
    let at = 4 * (num * (o + need)).div_ceil(den);
    sagebrush_ledger::hooks::set_fake_rows(Some(vec![(at, 0, None)]));
    assert!(matches!(wire::parse_reply(&call_bin(&q)), Ok(Ok(_))), "admitted at exactly its reservation");
    sagebrush_ledger::hooks::set_fake_rows(Some(vec![(at - 4, 0, None)]));
    let (g, first, out) = measured(&q);
    assert_eq!(wire::parse_reply(&out).unwrap(), Err((wire::Code::Cap as u16, 0)), "refused one unit short");
    // (the first allocation is the ledger's refusal record, which names
    // the op, freed before the error reply: never the decode)
    assert_eq!((g, first), (wire::ERROR_REPLY_MAX, "nmod_echelon".len()));
    assert_eq!(sagebrush_web::sb_outstanding_bytes(), held);
    sagebrush_ledger::hooks::set_fake_rows(None);
    sagebrush_web::sb_set_memory_total((1u64 << 34) as f64, 0, 0);
}
