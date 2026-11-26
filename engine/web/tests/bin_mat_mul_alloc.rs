//! The binary nmod_mat_mul's peak live memory, measured by a counting
//! allocator: within its reservation (bin_ops::mat_mul_reservation: the
//! decoded factors, the product's peak under the fixed fast-route allowance
//! and the reply) and at least its largest phase; the fast route's extra
//! words shown needed where it is taken; the route and the units the same
//! under two different ledger states (the choice reads no free memory); the
//! ledger's boundary at exactly the reservation, and a refusal allocating
//! nothing but the error reply.  One test (the counters are global).

use sagebrush_arith::cost::{metered, Meter};
use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_mat::{product_peak, Mat};
use sagebrush_web::bin_ops::{call_bin, mat_mul_reply_len, mat_mul_reservation, MAT_MUL_FAST_ALLOWANCE};
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

fn u641(w: &[u64]) -> Vec<u8> {
    let mut v = Vec::new();
    wire::put_u641(&mut v, w);
    v
}

fn mat1(rows: usize, cols: usize, words: &[u64]) -> Vec<u8> {
    let mut m = b"MAT1".to_vec();
    m.extend_from_slice(&(rows as u32).to_le_bytes());
    m.extend_from_slice(&(cols as u32).to_le_bytes());
    m.extend(u641(words));
    m
}

fn req(p: u64, r: usize, k: usize, c: usize, a: &[u64], b: &[u64]) -> Vec<u8> {
    let args = [u641(&[p]), mat1(r, k, a), mat1(k, c, b)];
    let op = "nmod_mat_mul";
    let mut v = wire::MAGIC.to_vec();
    v.extend_from_slice(&(op.len() as u32).to_le_bytes());
    v.extend_from_slice(op.as_bytes());
    v.extend_from_slice(&(args.len() as u32).to_le_bytes());
    for x in &args {
        v.extend_from_slice(&(x.len() as u32).to_le_bytes());
        v.extend_from_slice(x);
    }
    v
}

/// (growth of live memory during the call, the reply included; the first
/// allocation's size; the reply)
fn measured(q: &[u8]) -> (usize, usize, Vec<u8>) {
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    FIRST_SIZE.store(0, Relaxed);
    FIRST_ARMED.store(1, Relaxed);
    let out = call_bin(q);
    FIRST_ARMED.store(0, Relaxed);
    (PEAK.load(Relaxed) - base, FIRST_SIZE.load(Relaxed), out)
}

fn random(s: &mut u64, n: usize, p: u64) -> Vec<u64> {
    (0..n).map(|_| rng(s) % p).collect()
}

#[test]
fn the_product_allocates_within_its_reservation_and_reads_no_free_memory() {
    sagebrush_web::sb_set_memory_total((1u64 << 34) as f64, 0, 0);
    let mut s = 0x2545_f491_4f6c_dd1du64;
    // (one call first per kernel class: the phases' names are registered
    // once, and the tally's thread-local is made)
    for p in [101u64, P63] {
        let w = req(p, 2, 2, 2, &[1, 2, 3, 4], &[1, 0, 0, 1]);
        assert!(matches!(wire::parse_reply(&call_bin(&w)), Ok(Ok(_))));
    }
    let held = sagebrush_web::sb_outstanding_bytes();
    // (r, k, c, p): thin both ways, non-square, the u64 kernel (101, 65537)
    // and the u128 kernel (P63), classical and fast (400^3 at 65537, 140^3
    // at P63)
    let cases = [
        (1usize, 4096usize, 1usize, 101u64),
        (4096, 1, 4096, 101),
        (64, 64, 64, P63),
        (300, 500, 200, 65537),
        (200, 500, 300, P63),
        (400, 400, 400, 65537),
        (140, 140, 140, P63),
    ];
    for &(r, k, c, p) in &cases {
        let (a, b) = (random(&mut s, r * k, p), random(&mut s, k * c, p));
        let q = req(p, r, k, c, &a, &b);
        let (g, first, out) = measured(&q);
        assert!(matches!(wire::parse_reply(&out), Ok(Ok(_))), "{r}x{k}x{c}");
        let bound = mat_mul_reservation(r, k, c, p).unwrap() as usize;
        let reply = mat_mul_reply_len(r, c).unwrap();
        let lower = (8 * (r * k + k * c) + 8 * r * c).max(8 * r * c + reply).saturating_sub(4096);
        eprintln!("{r}x{k}x{c} p={p}: lower {lower} <= growth {g} <= reservation {bound}");
        assert_eq!(first, 8 * r * k, "{r}x{k}x{c}: the first allocation is A's decode");
        assert!(g <= bound, "{r}x{k}x{c} p={p}: growth {g} > reservation {bound}");
        assert!(g >= lower, "{r}x{k}x{c} p={p}: growth {g} < the largest phase {lower}");
        assert_eq!(sagebrush_web::sb_outstanding_bytes(), held, "{r}x{k}x{c}: the reservation is released");
        // where the fast route is taken, its extra words are needed: the
        // bound without them fails
        let (_, extra) = product_peak(r, k, c, &Modulus::new(p), MAT_MUL_FAST_ALLOWANCE).unwrap();
        if (r, p) == (400, 65537) || (r, p) == (140, P63) {
            assert!(extra > 0, "{r}^3 takes the fast route");
            assert!(g > bound - 8 * extra as usize, "{r}^3: the fast route's extra words are needed");
        }
    }

    // the route reads no free memory: the same request under two different
    // ledger states (fake rows: plenty, and nearly full but still admitting)
    // gives the same reply and the same units, the fast route's (fewer than
    // the classical product's)
    let (r, k, c, p) = (400, 400, 400, 65537);
    let (a, b) = (random(&mut s, r * k, p), random(&mut s, k * c, p));
    let q = req(p, r, k, c, &a, &b);
    let need = mat_mul_reservation(r, k, c, p).unwrap();
    let o = held as u64;
    let (num, den) = (sagebrush_ledger::FRAG_NUM, sagebrush_ledger::FRAG_DEN);
    let exact = 4 * (num * (o + need)).div_ceil(den);
    let mut runs = vec![];
    for limit in [1u64 << 40, exact] {
        sagebrush_ledger::hooks::set_fake_rows(Some(vec![(limit, 0, None)]));
        let mut meter = Meter::accounting(u64::MAX);
        let out = metered(&mut meter, || call_bin(&q));
        assert!(matches!(wire::parse_reply(&out), Ok(Ok(_))), "admitted at limit {limit}");
        runs.push((out, meter.units()));
    }
    sagebrush_ledger::hooks::set_fake_rows(None);
    assert_eq!(runs[0], runs[1], "the same reply and units under both ledger states");
    let m = Modulus::new(p);
    let mut classical = Meter::accounting(u64::MAX);
    metered(&mut classical, || Mat { rows: r, cols: k, m, d: a.clone() }.mul_classical(&Mat { rows: k, cols: c, m, d: b.clone() }));
    assert!(runs[0].1.total() < classical.units().total(), "400^3 took the fast route");

    // the ledger's boundary at exactly the reservation, and a refusal one
    // unit short allocating nothing but the ledger's record and the error
    // reply
    sagebrush_ledger::hooks::set_fake_rows(Some(vec![(exact, 0, None)]));
    assert!(matches!(wire::parse_reply(&call_bin(&q)), Ok(Ok(_))), "admitted at exactly its reservation");
    sagebrush_ledger::hooks::set_fake_rows(Some(vec![(exact - 4, 0, None)]));
    let (g, first, out) = measured(&q);
    assert_eq!(wire::parse_reply(&out).unwrap(), Err((wire::Code::Cap as u16, 0)), "refused one unit short");
    assert_eq!((g, first), (wire::ERROR_REPLY_MAX, "nmod_mat_mul".len()));
    assert_eq!(sagebrush_web::sb_outstanding_bytes(), held);
    sagebrush_ledger::hooks::set_fake_rows(None);
    sagebrush_web::sb_set_memory_total((1u64 << 34) as f64, 0, 0);
}
