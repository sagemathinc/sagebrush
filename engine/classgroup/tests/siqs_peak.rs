// The quadratic sieve's bound covers its real peak: with a counting
// allocator, the bytes live during a run never pass what the sieve charged
// against its reservation, and the charges are at most twice that peak (so
// the bound is neither too small nor needlessly large).  90, 150 and 200
// bits here; 249 bits is #[ignore]d (about two minutes) and runs with
// --ignored.  (A test binary of its own: it counts every allocation of the
// process.)
use sagebrush_bigint::{BigInt, BigUint};
use sagebrush_classgroup::nf::factor::is_probable_prime;
use sagebrush_classgroup::nf::siqs::{params, siqs_with, Stats};
use sagebrush_ledger::{set_total, Total, TotalStatus};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicI64, Ordering::Relaxed};

static LIVE: AtomicI64 = AtomicI64::new(0);
static PEAK: AtomicI64 = AtomicI64::new(0);
struct Count;

fn grew(by: i64) {
    let now = LIVE.fetch_add(by, Relaxed) + by;
    PEAK.fetch_max(now, Relaxed);
}

// SAFETY: each method forwards to System with the caller's arguments and
// only records the sizes System allocated or released.  A reallocation is
// counted at old + new while it runs (it may move).
#[allow(unsafe_code)]
unsafe impl GlobalAlloc for Count {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            grew(l.size() as i64);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
        LIVE.fetch_sub(l.size() as i64, Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        grew(n as i64);
        let q = System.realloc(p, l, n);
        LIVE.fetch_sub(if q.is_null() { n } else { l.size() } as i64, Relaxed);
        q
    }
}

#[global_allocator]
static A: Count = Count;

/// What the bound may be at most, in tenths of the peak: twice it (1.38 at
/// 90 bits, 1.40 at 150, 1.28 at 200 and 1.21 at 249, measured).
const K10: u64 = 20;

fn prime(bits: u64, s: &mut u64) -> BigUint {
    loop {
        let mut v = BigUint::from(1u32);
        for _ in 1..bits {
            *s ^= *s << 13;
            *s ^= *s >> 7;
            *s ^= *s << 17;
            v = (v << 1usize) + BigUint::from(*s >> 63);
        }
        if v.bits() == bits && (&v % 2u32) == BigUint::from(1u32) && is_probable_prime(&BigInt::from(v.clone())) {
            return v;
        }
    }
}

/// The tests take this: the allocator's counters are process-wide.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn check(bits: u64) {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    set_total(Some(Total { bytes: 1 << 40, status: TotalStatus::Observed, joint: false, uncertified: false }));
    let mut s = 0x1234_5678_9abc_def1u64 ^ bits;
    let n = prime(bits / 2, &mut s) * prime(bits - bits / 2, &mut s);
    let mut st = Stats::default();
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    let g = siqs_with(&n, &params(n.bits() as u64), 1, &mut st).unwrap();
    let peak = (PEAK.load(Relaxed) - base) as u64;
    assert!(g.is_some(), "{} bits: {:?}", bits, st);
    println!("{} bits: peak {} bytes, charged {} ({:.2}x), reserved {} ({:.2}x)", bits, peak, st.charged, st.charged as f64 / peak as f64, st.reserved, st.reserved as f64 / peak as f64);
    // (the bound itself, before the reservation rounds it up to chunks)
    assert!(peak <= st.charged && st.charged <= st.reserved, "{} bits: a peak of {} bytes, past the {} charged", bits, peak, st.charged);
    assert!(10 * st.charged <= K10 * peak, "{} bits: {} charged, more than {}/10 times the peak of {}", bits, st.charged, K10, peak);
}

#[test]
fn the_bound_covers_the_peak_90_150_and_200_bits() {
    check(90);
    check(150);
    check(200);
}

#[test]
#[ignore]
fn the_bound_covers_the_peak_249_bits() {
    check(249);
}
