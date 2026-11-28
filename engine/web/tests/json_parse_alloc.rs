//! A JSON request's parsed form (serde_json's Value tree) takes at most
//! json_tree_bound(text) bytes, whatever its structure: the costliest shapes
//! (long arrays of one-character scalars, of empty containers and strings,
//! objects of short keys, deep nests, escaped strings) and an nmod
//! request's one long string measured by a counting allocator, each
//! parse's peak above what was live.  call() reserves that bound before parsing: with no room, the
//! typed memory reply, nothing parsed.  One test (the counters are global).

use sagebrush_web::{call, json_tree_bound};
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

fn repeat(open: &str, item: &str, close: &str, n: usize) -> String {
    let mut s = String::with_capacity(open.len() + n * (item.len() + 1) + close.len());
    s.push_str(open);
    for i in 0..n {
        if i > 0 {
            s.push(',');
        }
        s.push_str(item);
    }
    s.push_str(close);
    s
}

#[test]
fn a_parsed_request_fits_its_bound_and_is_reserved_first() {
    let n = 200_000;
    let mut shapes: Vec<(&str, String)> = vec![
        ("one-digit numbers", repeat("[", "0", "]", n)),
        ("empty arrays", repeat("[", "[]", "]", n)),
        ("empty objects", repeat("[", "{}", "]", n)),
        ("empty strings", repeat("[", "\"\"", "]", n)),
        ("one-character strings", repeat("[", "\"a\"", "]", n)),
        ("true", repeat("[", "true", "]", n)),
        ("nests of 100", repeat("[", &format!("{}{}", "[".repeat(100), "]".repeat(100)), "]", n / 100)),
        ("arrays of two", repeat("[", "[0,0]", "]", n)),
    ];
    // an object of distinct short keys
    let mut obj = String::from("{");
    for i in 0..n {
        if i > 0 {
            obj.push(',');
        }
        obj.push_str(&format!("\"{:x}\":0", i));
    }
    obj.push('}');
    shapes.push(("an object of short keys", obj));
    // a long escaped string (decoded through serde's scratch buffer)
    shapes.push(("one long escaped string", format!("[\"{}\"]", "\\u0041\\n".repeat(n))));
    // plain text then one escape: all of it goes through the scratch buffer
    shapes.push(("a long string ending in an escape", format!("[\"{}\\n\"]", "a".repeat(n * 8))));
    // a long string, an nmod request's matrix: its bound is about its size
    shapes.push(("one long string", format!("{{\"fn\":\"nmod_charpoly\",\"p\":\"7\",\"m\":\"{}\"}}", "0,".repeat(n * 4))));
    let mut worst = 0.0f64;
    for (what, text) in &shapes {
        let base = NOW.load(Relaxed);
        PEAK.store(base, Relaxed);
        let v: serde_json::Value = serde_json::from_str(text).unwrap();
        let peak = PEAK.load(Relaxed) - base;
        drop(v);
        let bound = json_tree_bound(text);
        let share = peak as f64 / bound as f64;
        eprintln!("{}: {} bytes of text, a peak of {}, the bound {} ({:.0}% of it)", what, text.len(), peak, bound, 100.0 * share);
        worst = worst.max(share);
        assert!(peak as u64 <= bound, "{}: a peak of {} past the bound {}", what, peak, bound);
    }
    // (a string without escapes costs its own size: an nmod request near its
    // byte cap, or a long integer list, is not refused for a tree it doesn't
    // have)
    let long = &shapes.last().unwrap().1;
    assert!(json_tree_bound(long) < 2 * long.len() as u64);
    eprintln!("the costliest: {:.0}% of its bound", 100.0 * worst);
    // call() with no room for the parse (a 1 MB engine total: 256 KB to
    // share): a 400 KB request is the typed memory refusal, before parsing
    sagebrush_ledger::set_total(Some(sagebrush_ledger::Total { bytes: 1 << 20, status: sagebrush_ledger::TotalStatus::Observed, joint: false, uncertified: false }));
    let req = format!("{{\"fn\":\"no such function\",\"x\":{}}}", shapes[0].1);
    let base = NOW.load(Relaxed);
    PEAK.store(base, Relaxed);
    let r = call(&req);
    let peak = PEAK.load(Relaxed) - base;
    sagebrush_ledger::set_total(None);
    let r: serde_json::Value = serde_json::from_str(&r).unwrap();
    assert!(r.get("memory").is_some(), "{}", r);
    assert_eq!(r["memory"]["what"], "a JSON request's parsed form");
    // (the reply itself, not the request's tree: a few KB)
    assert!(peak < 64 * 1024, "{} bytes allocated for a refused {}-byte request", peak, req.len());
}
