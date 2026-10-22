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
/// Armed (1): the live bytes just after the next allocation are recorded
/// in FIRST_LIVE, with its size in FIRST_SIZE.
static FIRST_ARMED: AtomicUsize = AtomicUsize::new(0);
static FIRST_LIVE: AtomicUsize = AtomicUsize::new(0);
static FIRST_SIZE: AtomicUsize = AtomicUsize::new(0);

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
/// The longest nmod_echelon reply text could be (20 bytes an entry).
const ENTRY_TEXT_BOUND: usize = 20 * ECH_MAX_ENTRIES;
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
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
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

fn stats() -> (u64, u64, u64) {
    let v: serde_json::Value = serde_json::from_str(&sagebrush_web::call(r#"{"fn":"ntt_cache_stats"}"#)).unwrap();
    let v = &v["ok"];
    (v[0].as_u64().unwrap(), v[1].as_u64().unwrap(), v[2].as_u64().unwrap())
}

/// The shared transform cache filled to its table-count policy (64
/// tables): a multimodular integer product needing more than 64 primes
/// (coefficients of about 2000 bits).
fn fill_count(s: &mut u64) {
    let c: Vec<String> = (0..16).map(|_| (0..32).map(|_| format!("{:019}", rng(s) % 10_000_000_000_000_000_000)).collect::<String>()).collect();
    let r = sagebrush_web::call(&format!(r#"{{"fn":"poly_mul","a":"{}","b":"{}"}}"#, c.join(","), c.join(",")));
    assert!(r.starts_with("{\"ok\""), "{}", &r[..r.len().min(200)]);
    let st = stats();
    eprintln!("shared cache, count policy: {:?}", st);
    assert_eq!(st.1, 64, "the shared cache at its 64-table policy");
}

/// The shared transform cache filled to its byte policy (2^28 bytes):
/// a multimodular integer product of length 2^20 (32 MiB tables) needing
/// 9 primes; eight tables remain, exactly 2^28 bytes.
fn fill_bytes(s: &mut u64) {
    let n = 1 << 19;
    let c: Vec<String> = (0..n).map(|_| (0..4).map(|_| format!("{:019}", rng(s) % 10_000_000_000_000_000_000)).collect::<String>() + "7").collect();
    let req = format!(r#"{{"fn":"poly_mul","a":"{}","b":"{}"}}"#, c.join(","), c.join(","));
    drop(c);
    let r = sagebrush_web::call(&req);
    assert!(r.starts_with("{\"ok\""), "{}", &r[..r.len().min(200)]);
    let st = stats();
    eprintln!("shared cache, byte policy: {:?}", st);
    assert_eq!((st.1, st.2), (8, 1 << 28), "the shared cache at its 2^28-byte policy");
}

/// The NTT-backed ops' worst requests.
fn ntt_requests(s: &mut u64) -> Vec<(&'static str, String)> {
    let mut v = vec![];
    for p in [P, NTT_P] {
        let (a, b) = (rand_poly(s, MUL_MAX_LEN, p), rand_poly(s, MUL_MAX_LEN, p));
        v.push(("nmod_poly_mul", format!(r#"{{"fn":"nmod_poly_mul","p":"{}","a":"{}","b":"{}"}}"#, p, csv(&a), csv(&b))));
        let (a, b) = (rand_poly(s, DIV_MAX_LEN, p), rand_poly(s, (1 << 14) + 1, p));
        v.push(("nmod_poly_divrem", format!(r#"{{"fn":"nmod_poly_divrem","p":"{}","a":"{}","b":"{}"}}"#, p, csv(&a), csv(&b))));
    }
    v
}

/// LIMIT-PR47-1: with the shared cache at each of its policy limits, every
/// NTT-backed op leaves (calls, tables, bytes) unchanged and stays within
/// its peak.  (Its own binary would be cleaner; here, after the peaks, the
/// counters are still exact: one test.)
fn ops_beside_full_cache() {
    let mut s = 0x9e3779b97f4a7c15u64;
    let reqs = ntt_requests(&mut s);
    for (state, fill) in [("count", fill_count as fn(&mut u64)), ("bytes", fill_bytes as fn(&mut u64))] {
        fill(&mut s);
        for (name, req) in &reqs {
            let before = stats();
            let (g, r) = growth(req);
            assert!(r.starts_with("{\"ok\":"), "{}", &r[..r.len().min(200)]);
            assert_eq!(stats(), before, "{} with the cache at its {} policy", name, state);
            assert!(req.len() + g <= peak_of(name), "{}: {} + {}", name, req.len(), g);
        }
    }
}

/// LIMIT-PR47-2: through the ABI (sb_alloc, sb_call), after a prior reply
/// larger than any nmod reply (20 ECH_MAX_ENTRIES bytes, about 3.2 MB:
/// an integer polynomial product of 8192 x 8192 coefficients of 100
/// digits, from another op): at the call's first allocation the old reply
/// is already freed, and the call's peak above the heap without it is
/// within the op's bound (the request excluded, already allocated).
fn abi_frees_the_old_reply_first() {
    let mut s = 0x51u64;
    let abi = |req: &str| -> (usize, usize, usize, usize) {
        unsafe {
            let p = sagebrush_web::sb_alloc(req.len());
            std::ptr::copy_nonoverlapping(req.as_ptr(), p, req.len());
            let old = sagebrush_web::sb_reply_len();
            let base = LIVE.load(Relaxed);
            PEAK.store(0, Relaxed);
            FIRST_LIVE.store(0, Relaxed);
            FIRST_ARMED.store(1, Relaxed);
            sagebrush_web::sb_call(p, req.len());
            FIRST_ARMED.store(0, Relaxed);
            let peak = PEAK.load(Relaxed);
            sagebrush_web::sb_free(p, req.len());
            (old, base, FIRST_LIVE.load(Relaxed) - FIRST_SIZE.load(Relaxed), peak)
        }
    };
    let big: Vec<String> = (0..8192).map(|_| (0..5).map(|_| format!("{:019}", rng(&mut s) % 10_000_000_000_000_000_000)).collect::<String>() + "12345").collect();
    let seed = format!(r#"{{"fn":"poly_mul","a":"{}","b":"{}","wire":"csv"}}"#, big.join(","), big.join(","));
    drop(big);
    let m: Vec<Vec<u64>> = (0..400).map(|_| (0..401).map(|_| P - 1 - rng(&mut s) % (1 << 40)).collect()).collect();
    let ech = format!(
        r#"{{"fn":"nmod_echelon","p":"{}","rows":400,"cols":401,"m":"{}","reduced":true,"want_rows":true}}"#,
        P,
        m.iter().map(|r| csv(r)).collect::<Vec<_>>().join(";")
    );
    drop(m);
    let mut reqs: Vec<(&str, String)> = vec![("nmod_echelon", ech)];
    let (a, b) = (rand_poly(&mut s, GCD_MAX_LEN, P), rand_poly(&mut s, GCD_MAX_LEN, P));
    reqs.push(("nmod_poly_gcd", format!(r#"{{"fn":"nmod_poly_gcd","p":"{}","a":"{}","b":"{}"}}"#, P, csv(&a), csv(&b))));
    let (a, b) = (rand_poly(&mut s, DIV_MAX_LEN, P), rand_poly(&mut s, 59, P));
    reqs.push(("nmod_poly_divrem", format!(r#"{{"fn":"nmod_poly_divrem","p":"{}","a":"{}","b":"{}"}}"#, P, csv(&a), csv(&b))));
    reqs.extend(ntt_requests(&mut s));
    for (name, req) in &reqs {
        abi(&seed);
        let old = sagebrush_web::sb_reply_len();
        assert!(old > ENTRY_TEXT_BOUND, "a prior reply past every nmod reply: {} bytes", old);
        let (old2, base, first, peak) = abi(req);
        assert_eq!(old2, old);
        // (without the early free, the first allocation would see it live)
        assert!(first + old <= base, "{}: the old reply ({} bytes) still live at the first allocation", name, old);
        // the call's peak above the heap at its first allocation (the old
        // reply freed, whatever its capacity)
        let g = peak - first;
        eprintln!("{} via the ABI: old reply {} bytes, freed before the first allocation; then peak {} + request {} <= {}", name, old, g, req.len(), peak_of(name));
        assert!(req.len() + g <= peak_of(name), "{}", name);
    }
}

#[test]
fn seeded_states() {
    // (the counters are global: run after peaks_within_bounds, not beside it)
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    abi_frees_the_old_reply_first();
    ops_beside_full_cache();
}

static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
