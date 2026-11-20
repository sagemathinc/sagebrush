//! The series ops' peak live memory, measured by a counting allocator, at
//! the largest requests they admit: within each request's admitted peak
//! (zseries's closed forms, the request and reply included).  One test (the
//! counters are global).

use sagebrush_arith::{zmul, zseries};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

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

/// The growth of live memory during call(req), the reply included.
fn growth(req: &str) -> (usize, String) {
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    let r = sagebrush_web::call(req);
    (PEAK.load(Relaxed) - base, r)
}

fn list(t: usize, tok: &str) -> String {
    vec![tok; t].join(",")
}

#[test]
fn peaks_within_the_admitted_bounds() {
    let big = "f".repeat(1024); // a 4096-bit coefficient
    let den = format!("1{}", "0".repeat(1023));
    let cases: Vec<(&str, String)> = vec![
        // over Z at the length cap: the own table of 2^18 points
        ("mul Z n = 2^17", format!(r#"{{"fn":"series_mul","a":"{}","b":"{}","n":131072}}"#, list(1 << 17, "3"), list(1 << 17, "-5"))),
        // over Q, raw, the largest values: 2^12 coefficients of 8204 bits, 4096-bit denominators
        ("mul Q raw, 2^12 x 4096 bits", format!(r#"{{"fn":"series_mul","a":"{}","b":"{}","n":4096,"da":"{}","db":"{}","raw":true}}"#, list(1 << 12, &big), list(1 << 12, &big), den, den)),
        // over Q, reduced (each coefficient's gcd with d): 2^12 coefficients of 2048 bits, 1024-bit denominators
        ("mul Q reduced, 2^12 x 2048 bits", format!(r#"{{"fn":"series_mul","a":"{}","b":"3","n":4096,"da":"{}","db":"{}"}}"#, list(1 << 12, &"e".repeat(512)), &den[..256], &den[..256])),
        ("pow Z n = 2^16, k = 24", format!(r#"{{"fn":"series_pow","a":"{}","k":24,"n":65536}}"#, list(1 << 16, "1"))),
        ("pow Q reduced n = 2^10, k = 3", format!(r#"{{"fn":"series_pow","a":"{}","k":3,"n":1024,"da":"{}"}}"#, list(1 << 10, &"7".repeat(50)), &"3".repeat(50))),
        ("sigma k = 11, n = 2^18", r#"{"fn":"sigma_table","k":11,"n":262144}"#.to_string()),
        ("sigma k = 0, n = 2^20", r#"{"fn":"sigma_table","k":0,"n":1048576}"#.to_string()),
        ("euler n = 2^20", r#"{"fn":"series_euler","n":1048576}"#.to_string()),
        // poly_mul, each near both of its caps (N = 2^19 points, O <= 2^25 bits):
        // one-digit coefficients at the most terms (slot 30: the largest reply
        // per output bit), unbalanced, and huge coefficients
        ("poly_mul 2^19 x 2^19 one-digit", format!(r#"{{"fn":"poly_mul","a":"{}","b":"{}"}}"#, list(1 << 19, "f"), list(1 << 19, "-f"))),
        ("poly_mul 2^12 x 4, 64 x 4096 bits", format!(r#"{{"fn":"poly_mul","a":"{}","b":"{}"}}"#, list(1 << 12, &"9".repeat(16)), list(4, &big))),
        // the word schoolbook at its threshold: the longest factor times a short
        // one of exactly 128 packed words (no tables: operands, output and the reply)
        ("poly_mul schoolbook 2^18 x 105, one-digit x 64 bits (128 words)", format!(r#"{{"fn":"poly_mul","a":"{}","b":"{}"}}"#, list(1 << 18, "7"), list(105, &"9".repeat(16)))),
        ("poly_mul 2^8 x 2^8, 2^14 bits", format!(r#"{{"fn":"poly_mul","a":"{}","b":"{}"}}"#, list(1 << 8, &"d".repeat(1 << 12)), list(1 << 8, &format!("-{}", "e".repeat(1 << 12))))),
    ];
    for (what, req) in &cases {
        let admitted = admitted_peak(req);
        let (peak, reply) = growth(req);
        assert!(reply.starts_with("{\"ok\":"), "{}: {}", what, &reply[..reply.len().min(300)]);
        eprintln!("{}: measured {:.2} MiB, admitted {:.2} MiB ({} bytes to spare)", what, peak as f64 / (1 << 20) as f64, admitted as f64 / (1 << 20) as f64, admitted as i64 - peak as i64);
        assert!(peak as u64 <= admitted, "{}: {} bytes live at the peak, admitted {}", what, peak, admitted);
    }
}

/// The request's admitted peak, from the same closed forms the op uses.
fn admitted_peak(req: &str) -> u64 {
    let v: serde_json::Value = serde_json::from_str(req).unwrap();
    let s = |k: &str| v.get(k).and_then(|x| x.as_str());
    let n = v["n"].as_u64().unwrap_or(0) as usize;
    let r = req.len() as u64;
    let adm = match v["fn"].as_str().unwrap() {
        "series_mul" => {
            let (a, b) = (zseries::scan(s("a").unwrap(), n, true).unwrap(), zseries::scan(s("b").unwrap(), n, true).unwrap());
            let (da, db) = (s("da").map(|t| zseries::scan_denominator(t).unwrap()), s("db").map(|t| zseries::scan_denominator(t).unwrap()));
            let raw = v.get("raw").and_then(|x| x.as_bool()).unwrap_or(false);
            zseries::mul_admit(&a, &b, da.as_ref(), db.as_ref(), n, raw, r)
        }
        "series_pow" => {
            let a = zseries::scan(s("a").unwrap(), n, true).unwrap();
            let da = s("da").map(|t| zseries::scan_denominator(t).unwrap());
            zseries::pow_admit(&a, v["k"].as_u64().unwrap(), da.as_ref(), n, false, r)
        }
        "sigma_table" => zseries::sigma_admit(v["k"].as_u64().unwrap(), n, r),
        "poly_mul" => {
            let (a, b) = (zmul::scan(s("a").unwrap()).unwrap(), zmul::scan(s("b").unwrap()).unwrap());
            return zmul::admit(&a, &b, r, &zmul::CAPS).unwrap().unwrap().admitted.peak;
        }
        _ => zseries::euler_admit(n, r),
    };
    adm.unwrap().peak
}
