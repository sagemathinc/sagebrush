//! The nmod ops' peak live memory, measured by a counting allocator, at
//! each op's worst admitted request: within the op's closed-form bound
//! (nmod_ops::OPS, the request itself included); and refusals at a cap
//! allocate nothing size-dependent.  One test (the counters are global).

use sagebrush_web::nmod_ops::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            PEAK.fetch_max(LIVE.fetch_add(l.size(), Relaxed) + l.size(), Relaxed);
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

/// The growth of live memory during call(req), the reply included.
fn growth(req: &str) -> (usize, String) {
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    let r = sagebrush_web::call(req);
    (PEAK.load(Relaxed) - base, r)
}

fn csv(v: &[u64]) -> String {
    v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")
}

const P: u64 = 9223372036854775783;
const NTT_P: u64 = 4601552919265804289;

fn rand_poly(s: &mut u64, n: usize, p: u64) -> Vec<u64> {
    let mut v: Vec<u64> = (0..n).map(|_| rng(s) % p).collect();
    v[n - 1] = v[n - 1].max(1);
    v
}

fn peak_of(name: &str) -> usize {
    OPS.iter().find(|o| o.name == name).unwrap().peak
}

#[test]
fn peaks_within_bounds() {
    let mut s = 0x2545f4914f6cdd1du64;
    // nmod_echelon: 400 x 401 random (every one of the first 400 columns
    // pivots), 19-digit entries, reduced, with the rows
    let m: Vec<Vec<u64>> = (0..400).map(|_| (0..401).map(|_| P - 1 - rng(&mut s) % 1000).collect()).collect();
    let text = m.iter().map(|r| csv(r)).collect::<Vec<_>>().join(";");
    let req = format!(r#"{{"fn":"nmod_echelon","p":"{}","rows":400,"cols":401,"m":"{}","reduced":true,"want_rows":true}}"#, P, text);
    drop((m, text));
    let (g, r) = growth(&req);
    assert!(r.starts_with("{\"ok\":{\"pivots\":\"0,1,2,"), "{}", &r[..100]);
    eprintln!("nmod_echelon: request {} + growth {} <= {}", req.len(), g, peak_of("nmod_echelon"));
    assert!(req.len() + g <= peak_of("nmod_echelon"));
    drop((req, r));
    // nmod_poly_mul at the cap: three primes, and an NTT prime's own table
    for p in [P, NTT_P] {
        let (a, b) = (rand_poly(&mut s, MUL_MAX_LEN, p), rand_poly(&mut s, MUL_MAX_LEN, p));
        let req = format!(r#"{{"fn":"nmod_poly_mul","p":"{}","a":"{}","b":"{}"}}"#, p, csv(&a), csv(&b));
        drop((a, b));
        let (g, r) = growth(&req);
        assert!(r.starts_with("{\"ok\":\""));
        eprintln!("nmod_poly_mul p={}: request {} + growth {} <= {}", p, req.len(), g, peak_of("nmod_poly_mul"));
        assert!(req.len() + g <= peak_of("nmod_poly_mul"));
    }
    // nmod_poly_divrem: Newton (ql = lb = 2^14 + 1, and ql = 2^15 - 59)
    // and the classical path's most work (lb = 59)
    for (p, la, lb) in [(P, DIV_MAX_LEN, (1 << 14) + 1), (NTT_P, DIV_MAX_LEN, (1 << 14) + 1), (P, DIV_MAX_LEN, 60), (P, DIV_MAX_LEN, 59)] {
        let (a, b) = (rand_poly(&mut s, la, p), rand_poly(&mut s, lb, p));
        let req = format!(r#"{{"fn":"nmod_poly_divrem","p":"{}","a":"{}","b":"{}"}}"#, p, csv(&a), csv(&b));
        drop((a, b));
        let (g, r) = growth(&req);
        assert!(r.starts_with("{\"ok\":{\"q\":"), "{}", &r[..r.len().min(100)]);
        eprintln!("nmod_poly_divrem p={} {}/{}: request {} + growth {} <= {}", p, la, lb, req.len(), g, peak_of("nmod_poly_divrem"));
        assert!(req.len() + g <= peak_of("nmod_poly_divrem"));
    }
    // nmod_poly_gcd: random inputs at the cap (every Euclid step drops the
    // degree by one: the most steps), and one long step (lb = 2)
    for lb in [GCD_MAX_LEN, 2] {
        let (a, b) = (rand_poly(&mut s, GCD_MAX_LEN, P), rand_poly(&mut s, lb, P));
        let req = format!(r#"{{"fn":"nmod_poly_gcd","p":"{}","a":"{}","b":"{}"}}"#, P, csv(&a), csv(&b));
        drop((a, b));
        let (g, r) = growth(&req);
        assert_eq!(r, "{\"ok\":\"1\"}");
        eprintln!("nmod_poly_gcd {}/{}: request {} + growth {} <= {}", GCD_MAX_LEN, lb, req.len(), g, peak_of("nmod_poly_gcd"));
        assert!(req.len() + g <= peak_of("nmod_poly_gcd"));
    }
    // refusals: an oversized request allocates only its error message; one
    // count over a cap allocates no more than serde's copy of the request
    for op in OPS.iter().skip(1) {
        let req = format!(r#"{{"fn":"{}","x":"{}"}}"#, op.name, "0".repeat(op.max_request));
        let (g, r) = growth(&req);
        assert!(r.contains("the request has") && g < 1024, "{}: {}", op.name, g);
    }
    let ones = |n: usize| vec!["1"; n].join(",");
    for (f, cap) in [("nmod_poly_mul", MUL_MAX_LEN), ("nmod_poly_divrem", DIV_MAX_LEN), ("nmod_poly_gcd", GCD_MAX_LEN)] {
        let req = format!(r#"{{"fn":"{}","p":"7","a":"{}","b":"1"}}"#, f, ones(cap + 1));
        let (g, r) = growth(&req);
        assert!(r.contains("more than") && g < req.len() + 16 * 1024, "{f}: {g}");
    }
    let zeros = vec![vec!["0"; 401].join(","); 401].join(";");
    let req = format!(r#"{{"fn":"nmod_echelon","p":"7","rows":401,"cols":401,"m":"{}"}}"#, zeros);
    let (g, r) = growth(&req);
    assert!(r.contains("more than") && g < req.len() + 16 * 1024, "{g}");
}
