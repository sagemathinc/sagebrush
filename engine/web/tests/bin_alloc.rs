//! The binary entry point's allocations, by a counting allocator (S1, S2,
//! S3, S6): a refused request allocates nothing but its error reply (so
//! stage 1 and the validating pass allocate nothing); an admitted call's
//! first allocation is its decode, after its reservation; a refused
//! reservation allocates nothing but the error reply; and every admitted
//! call's peak live memory, its reply included, is within its
//! reservation.  One test (the counters are global).

use sagebrush_web::bin_ops::{call_bin, last_factor_budget_peak, reservation, FACTOR_MAX_LEN};
use sagebrush_web::nmod_ops::{DIV_MAX_LEN, GCD_MAX_LEN, MUL_MAX_LEN};
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

const P: u64 = 9223372036854775783;
const NTT_P: u64 = 4601552919265804289;

fn rand_poly(s: &mut u64, n: usize, p: u64) -> Vec<u64> {
    let mut v: Vec<u64> = (0..n).map(|_| rng(s) % p).collect();
    v[n - 1] = v[n - 1].max(1);
    v
}

fn u641(w: &[u64]) -> Vec<u8> {
    let mut v = Vec::new();
    wire::put_u641(&mut v, w);
    v
}

fn frame(op: &str, args: &[Vec<u8>]) -> Vec<u8> {
    let mut v = wire::MAGIC.to_vec();
    v.extend_from_slice(&(op.len() as u32).to_le_bytes());
    v.extend_from_slice(op.as_bytes());
    v.extend_from_slice(&(args.len() as u32).to_le_bytes());
    for a in args {
        v.extend_from_slice(&(a.len() as u32).to_le_bytes());
        v.extend_from_slice(a);
    }
    v
}

fn req(op: &str, p: u64, polys: &[&[u64]]) -> Vec<u8> {
    let mut args = vec![u641(&[p])];
    args.extend(polys.iter().map(|q| u641(q)));
    frame(op, &args)
}

/// One call measured: (the growth of live memory, the reply included; the
/// size of its first allocation; the reply).
fn measured(r: &[u8]) -> (usize, usize, Vec<u8>) {
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    FIRST_SIZE.store(0, Relaxed);
    FIRST_ARMED.store(1, Relaxed);
    let out = call_bin(r);
    FIRST_ARMED.store(0, Relaxed);
    (PEAK.load(Relaxed) - base, FIRST_SIZE.load(Relaxed), out)
}

fn is_ok(r: &[u8]) -> bool {
    matches!(wire::parse_reply(r), Ok(Ok(_)))
}

#[test]
fn binary_calls_allocate_only_within_their_reservation() {
    // a large total: nothing below is refused for memory except where set
    sagebrush_web::sb_set_memory_total((1u64 << 34) as f64, 0, 0);
    let mut s = 0x2545f4914f6cdd1du64;
    let small = rand_poly(&mut s, 50, 101);

    // -- refusals before the reservation allocate only their error reply
    // (stage 1 and the validating pass allocate nothing), and the reply
    // is the fixed bound's
    let good = req("nmod_poly_mul", 101, &[&small, &small]);
    let mut bad: Vec<Vec<u8>> = (0..good.len()).map(|c| good[..c].to_vec()).collect();
    let mut t = good.clone();
    t.push(0);
    bad.push(t);
    bad.push(frame("nmod_poly_xgcd", &[]));
    bad.push(req("nmod_poly_mul", 100, &[&small, &small]));
    bad.push(req("nmod_poly_mul", 101, &[&small, &[1, 101]]));
    bad.push(req("nmod_poly_mul", 101, &[&small, &[1, 0]]));
    bad.push(req("nmod_poly_mul", 101, &[&vec![1; MUL_MAX_LEN + 1], &small]));
    bad.push(req("nmod_poly_mul", 101, &[&vec![1; MUL_MAX_LEN], &vec![1; MUL_MAX_LEN + 3]]));
    bad.push(req("factor_mod", 4294967311, &[&small]));
    for (i, r) in bad.iter().enumerate() {
        let (g, first, out) = measured(r);
        assert!(!is_ok(&out), "{i}");
        assert_eq!((g, first), (wire::ERROR_REPLY_MAX, wire::ERROR_REPLY_MAX), "request {i}: only the error reply");
    }

    // -- admitted calls: the first allocation is the decode of the first
    // polynomial (after the reservation), and the peak, the reply
    // included, is within the reservation; nothing stays reserved
    let held = sagebrush_web::sb_outstanding_bytes();
    let mut cases: Vec<(&str, u64, usize, usize)> = vec![
        ("nmod_poly_mul", P, 1, 1),
        ("nmod_poly_mul", 101, 50, 7),
        ("nmod_poly_mul", P, MUL_MAX_LEN, MUL_MAX_LEN),
        ("nmod_poly_mul", NTT_P, MUL_MAX_LEN, MUL_MAX_LEN),
        ("nmod_poly_divrem", P, 1, 1),
        ("nmod_poly_divrem", P, DIV_MAX_LEN, (1 << 14) + 1),
        ("nmod_poly_divrem", NTT_P, DIV_MAX_LEN, (1 << 14) + 1),
        ("nmod_poly_divrem", P, DIV_MAX_LEN, 60),
        ("nmod_poly_divrem", P, DIV_MAX_LEN, 59),
        ("nmod_poly_gcd", P, 1, 1),
        ("nmod_poly_gcd", P, 1000, 999),
        ("nmod_poly_gcd", P, GCD_MAX_LEN, GCD_MAX_LEN),
        ("nmod_poly_gcd", NTT_P, GCD_MAX_LEN, GCD_MAX_LEN - 1),
        ("factor_mod", 65537, 1, 0),
        ("factor_mod", 4294967291, 200, 0),
    ];
    // (factor_mod's length cap is admitted; its work is its budget's)
    const { assert!(FACTOR_MAX_LEN >= 200) };
    for &(op, p, la, lb) in &cases {
        let a = rand_poly(&mut s, la, p);
        let b = if lb > 0 { Some(rand_poly(&mut s, lb, p)) } else { None };
        let polys: Vec<&[u64]> = std::iter::once(&a[..]).chain(b.as_deref()).collect();
        let r = req(op, p, &polys);
        drop(polys);
        let (g, first, out) = measured(&r);
        // (factor_mod's computation is within its own budget's reservations)
        let budget = if op == "factor_mod" { last_factor_budget_peak() as usize } else { 0 };
        let bound = reservation(op, la, lb).unwrap() as usize + budget;
        eprintln!("{op} p={p} {la}/{lb}: growth {g} <= reservation + budget peak {bound}");
        assert!(is_ok(&out), "{op} {la}/{lb}: {:?}", wire::parse_reply(&out));
        assert_eq!(first, 8 * la, "{op} {la}/{lb}: the first allocation is the decode");
        assert!(g <= bound, "{op} {la}/{lb}: growth {g} > reservation {bound}");
        assert_eq!(sagebrush_web::sb_outstanding_bytes(), held, "{op}: the reservation is released");
    }
    // many factors: x^256 - 1 mod 257 (256 linear factors), and a
    // repeated factor (x + 1)^64 mod 2, at the reply's bound
    let mut f = vec![0u64; 257];
    f[0] = 256;
    f[256] = 1;
    let mut g2 = vec![0u64; 65];
    g2[0] = 1;
    g2[64] = 1;
    for (p, f) in [(257u64, f), (2, g2)] {
        let r = req("factor_mod", p, &[&f]);
        let (g, first, out) = measured(&r);
        let bound = reservation("factor_mod", f.len(), 0).unwrap() as usize + last_factor_budget_peak() as usize;
        eprintln!("factor_mod p={p} {}: growth {g} <= reservation {bound}", f.len());
        assert!(is_ok(&out));
        assert_eq!(first, 8 * f.len());
        assert!(g <= bound);
    }
    cases.clear();

    // -- a refused reservation allocates nothing but the error reply: 1 MiB
    // of allowance (the native ledger without a measure checks against
    // the total / 4), and a product whose reservation is larger
    sagebrush_web::sb_set_memory_total((4u64 << 20) as f64, 0, 0);
    let (a, b) = (rand_poly(&mut s, MUL_MAX_LEN, P), rand_poly(&mut s, MUL_MAX_LEN, P));
    assert!(reservation("nmod_poly_mul", a.len(), b.len()).unwrap() > 1 << 20);
    let r = req("nmod_poly_mul", P, &[&a, &b]);
    let (g, first, out) = measured(&r);
    assert_eq!(wire::parse_reply(&out).unwrap(), Err((wire::Code::Cap as u16, 0)));
    // (the first allocation is the ledger's refusal record, which names
    // the op, freed before the error reply: never the decode)
    assert_eq!((g, first), (wire::ERROR_REPLY_MAX, "nmod_poly_mul".len()));
    // and a small call still runs
    let r = req("nmod_poly_mul", 101, &[&small, &small]);
    assert!(is_ok(&measured(&r).2));
    sagebrush_web::sb_set_memory_total((1u64 << 34) as f64, 0, 0);
}
