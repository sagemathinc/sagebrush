//! Malformed framed requests allocate no more than their bytes warrant: the
//! counts they declare (arguments, terms, a big integer's words) are checked
//! against the bytes present before anything is allocated for them.  A
//! counting allocator measures each call's peak (a 64-bit host's lazy
//! commit would hide an oversized reservation; a wasm32 one cannot).

use sagebrush_mpoly::call_framed;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Counting;
static NOW: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every method forwards to `System` with the caller's own arguments,
// so System's GlobalAlloc contract carries over; the counting only updates
// atomics.
#[allow(unsafe_code)]
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let now = NOW.fetch_add(l.size(), Relaxed) + l.size();
            PEAK.fetch_max(now, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
        NOW.fetch_sub(l.size(), Relaxed);
    }
}

#[global_allocator]
static A: Counting = Counting;

fn frame(op: &str, args: &[&[u8]]) -> Vec<u8> {
    let mut v = (op.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(op.as_bytes());
    v.extend_from_slice(&(args.len() as u32).to_le_bytes());
    for a in args {
        v.extend_from_slice(&(a.len() as u32).to_le_bytes());
        v.extend_from_slice(a);
    }
    v
}

fn record(flags: u8, len: u64, den: &[u8], rest: &[u8]) -> Vec<u8> {
    let mut v = b"MP1".to_vec();
    v.push(flags);
    v.extend_from_slice(&2u32.to_le_bytes());
    v.extend_from_slice(&8u32.to_le_bytes());
    v.extend_from_slice(&len.to_le_bytes());
    v.extend_from_slice(den);
    v.extend_from_slice(rest);
    v
}

/// The peak bytes allocated above those live before the call.
fn peak_of(req: &[u8]) -> (usize, Vec<u8>) {
    let base = NOW.load(Relaxed);
    PEAK.store(base, Relaxed);
    let r = call_framed(req);
    (PEAK.load(Relaxed) - base, r)
}

#[test]
fn malformed_counts_allocate_within_their_bytes() {
    let one = [2u32.to_le_bytes().to_vec(), 1u64.to_le_bytes().to_vec()].concat();
    let mut table = frame("len", &[]);
    let k = table.len();
    table[k - 4..].copy_from_slice(&u32::MAX.to_le_bytes());
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("an argument table of 2^32 - 1", table),
        ("2^64 - 1 word terms", frame("len", &[&record(0, u64::MAX, &one, &[0; 32])])),
        ("2^40 big terms", frame("len", &[&record(1, 1 << 40, &one, &[0; 32])])),
        ("2^28 word terms in 32 bytes", frame("len", &[&record(0, 1 << 28, &one, &[0; 32])])),
        ("a denominator of 2^31 - 1 words", frame("len", &[&record(0, 0, &u32::MAX.to_le_bytes(), &[])])),
    ];
    for (what, req) in cases {
        let (peak, r) = peak_of(&req);
        assert_eq!(&r[..2], b"er", "{}: accepted", what);
        // (the reply's message and the parse's few small vectors)
        assert!(peak < 4096, "{}: {} bytes allocated for a {}-byte request", what, peak, req.len());
    }
}
