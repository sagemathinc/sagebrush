//! mat_mul asks for Stop in each of its phases, whatever the shape and the
//! wire: the parse of a and b (by entry bytes, so inside a long row; CSV and
//! JSON arrays), the flat copy, the kernel's scans and dot, and the reply
//! (by entry digits, written into one String sized first: no joins).  For
//! each phase: the checks' density, a Stop at its median check lands there,
//! and the next call's reply is the same.  Also the work no two checks
//! enclose: from the call's entry to its first check (serde's parse of the
//! request) and from its last check to its return (the reply's
//! serialization), measured with the hooks' clock, as is the longest gap
//! between checks.  One test (plus an ignored measurement at multi-MB
//! sizes): the hooks and the flag are global.

use sagebrush_interrupt::hooks;
use sagebrush_web::call;

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

fn entry(s: &mut u64, digits: usize) -> String {
    let mut t = String::new();
    if rng(s) & 1 == 0 {
        t.push('-');
    }
    t.push((b'1' + (rng(s) % 9) as u8) as char);
    for _ in 1..digits {
        t.push((b'0' + (rng(s) % 10) as u8) as char);
    }
    t
}

/// An r x c matrix in the compact wire format, entries of `digits` digits.
fn csv(s: &mut u64, r: usize, c: usize, digits: usize) -> String {
    (0..r).map(|_| (0..c).map(|_| entry(s, digits)).collect::<Vec<_>>().join(",")).collect::<Vec<_>>().join(";")
}

/// The same as JSON rows of decimal strings.
fn array(s: &mut u64, r: usize, c: usize, digits: usize) -> String {
    let rows: Vec<Vec<String>> = (0..r).map(|_| (0..c).map(|_| entry(s, digits)).collect()).collect();
    serde_json::to_string(&rows).unwrap()
}

fn req_csv(a: &str, b: &str) -> String {
    format!(r#"{{"fn":"mat_mul","a":"{}","b":"{}","wire":"csv"}}"#, a, b)
}

fn req_array(a: &str, b: &str) -> String {
    format!(r#"{{"fn":"mat_mul","a":{},"b":{}}}"#, a, b)
}

/// The call traced, with its leading and trailing unpolled work (ms) and
/// the longest gap between two checks (ms).
fn traced(req: &str) -> (String, f64, f64, f64) {
    hooks::reset();
    hooks::trace();
    let t0 = hooks::now_ns();
    let full = call(req);
    let t1 = hooks::now_ns();
    let (first, last) = hooks::first_last_ns();
    let gap = hooks::max_gap_ns();
    let lead = if first == 0 { (t1 - t0) as f64 } else { (first - t0) as f64 };
    let trail = if last == 0 { 0.0 } else { (t1 - last) as f64 };
    (full, lead / 1e6, trail / 1e6, gap as f64 / 1e6)
}

/// Run req traced; then, for each phase, Stop at its median check: the
/// call must stop in that phase, and the next call must work.  `min` is
/// the fewest checks each phase must make (for the kernel's dot: work /
/// 2^17, as a block poll covers at most 2^16 units after a remainder below
/// 2^16).
fn phases(label: &str, req: &str, want: &[(&str, usize)]) {
    let (full, lead, trail, gap) = traced(req);
    assert!(full.starts_with("{\"ok\":"), "{}: {}", label, &full[..full.len().min(200)]);
    let counts: Vec<(&str, Vec<u64>)> = want.iter().map(|&(ph, _)| (ph, hooks::traced(ph))).collect();
    let total = hooks::total();
    hooks::reset();
    eprintln!(
        "{}: {} request bytes, {} reply bytes; {} checks; leading {:.2} ms, trailing {:.2} ms, longest gap {:.2} ms; {:?}",
        label,
        req.len(),
        full.len(),
        total,
        lead,
        trail,
        gap,
        counts.iter().map(|(p, v)| (*p, v.len())).collect::<Vec<_>>()
    );
    for (what, ms) in [("leading", lead), ("trailing", trail), ("gap", gap)] {
        assert!(ms < 250.0, "{}: {} {:.2} ms, past the 250 ms Stop bound", label, what, ms);
    }
    for (&(ph, min), (_, idx)) in want.iter().zip(&counts) {
        assert!(idx.len() >= min.max(1), "{}: {} checks in {}, want at least {}", label, idx.len(), ph, min);
        hooks::reset();
        hooks::arm_at(idx[idx.len() / 2]);
        let r = sagebrush_interrupt::catch(|| call(req));
        let at = hooks::stopped_in();
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "{}: no Stop in {}", label, ph);
        assert_eq!(at, ph, "{}: stopped in {} instead of {}", label, at, ph);
    }
    assert_eq!(call(req), full, "{}: the next call", label);
}

#[test]
fn mat_mul_stops_in_every_phase() {
    let mut s = 0x2545f4914f6cdd1du64;
    // 1 x K x 1, 9-digit entries: the parse is two rows of 2^16 entries
    // (about 1.3 MB), the scans 2^17 entries, the dot 2^16 multiply-adds
    let (a, b) = (csv(&mut s, 1, 1 << 16, 9), csv(&mut s, 1 << 16, 1, 9));
    phases("1xKx1", &req_csv(&a, &b), &[("parse", 16), ("zmat-scan", 2), ("zmat-dot", 1)]);
    // the same on the array wire (JSON rows in, JSON rows out)
    let (a, b) = (array(&mut s, 1, 1 << 16, 9), array(&mut s, 1 << 16, 1, 9));
    phases("1xKx1 array", &req_array(&a, &b), &[("parse", 16), ("zmat-scan", 2), ("zmat-dot", 1)]);
    // 1 x K x 1 with 300-digit entries: the BigInt loop, weighed by words
    let (a, b) = (csv(&mut s, 1, 1 << 10, 300), csv(&mut s, 1 << 10, 1, 300));
    phases("1xKx1 big", &req_csv(&a, &b), &[("parse", 8), ("zmat-big-dot", 4)]);
    // single BigInt operations as the unit: 20000-digit entries
    let (a, b) = (csv(&mut s, 1, 16, 20000), csv(&mut s, 16, 1, 20000));
    phases("1xKx1 huge entries", &req_csv(&a, &b), &[("parse", 4), ("zmat-big-dot", 16)]);
    // 1 x K x M
    let (a, b) = (csv(&mut s, 1, 1 << 10, 9), csv(&mut s, 1 << 10, 1 << 8, 9));
    phases("1xKxM", &req_csv(&a, &b), &[("parse", 30), ("zmat-dot", 2)]);
    // square 128: 2^21 multiply-adds; the reply 2^14 entries of up to 21 digits
    let (a, b) = (csv(&mut s, 128, 128, 9), csv(&mut s, 128, 128, 9));
    phases("square", &req_csv(&a, &b), &[("parse", 4), ("zmat-dot", 16), ("reply", 4)]);
    // wide: 32 x 32 x 2^11 (2^21 multiply-adds, a 2^16-entry reply)
    let (a, b) = (csv(&mut s, 32, 32, 9), csv(&mut s, 32, 1 << 11, 9));
    phases("wide", &req_csv(&a, &b), &[("parse", 8), ("zmat-dot", 16), ("reply", 16)]);
    // output-heavy, inner k = 1: 512 x 1 x 512, a 2^18-entry reply (CSV and array)
    let (a, b) = (csv(&mut s, 512, 1, 9), csv(&mut s, 1, 512, 9));
    phases("output-heavy", &req_csv(&a, &b), &[("zmat-dot", 4), ("reply", 64)]);
    let (a, b) = (array(&mut s, 512, 1, 9), array(&mut s, 1, 512, 9));
    phases("output-heavy array", &req_array(&a, &b), &[("zmat-dot", 4), ("reply", 64)]);
}

/// Multi-MB requests and replies (run on a VM: cargo test --release -p
/// sagebrush-web --test mat_mul_stop -- --ignored --nocapture): the
/// leading (serde's parse of the request), trailing (the reply's
/// serialization) and between-check intervals, printed for the inventory.
#[test]
#[ignore]
fn mat_mul_unpolled_intervals_at_size() {
    let mut s = 0x853c49e6748fea9bu64;
    for (label, r, k, c) in [("input-heavy 1xKx1", 1usize, 1usize << 22, 1usize), ("output-heavy 2048x1x2048", 2048, 1, 2048), ("output-heavy 4096x1x4096", 4096, 1, 4096)] {
        for wire in ["csv", "array"] {
            let req = if wire == "csv" {
                req_csv(&csv(&mut s, r, k, 9), &csv(&mut s, k, c, 9))
            } else {
                req_array(&array(&mut s, r, k, 9), &array(&mut s, k, c, 9))
            };
            let (full, lead, trail, gap) = traced(&req);
            hooks::reset();
            // (only the identified leading and trailing serde intervals may
            // carry the named temporary exception, labelled: FU-MM-T, William
            // Oct 27 2026, until PR T; the longest gap between two engine
            // checks stays strict)
            let waived: Vec<&str> = [("leading", lead), ("trailing", trail)].iter().filter(|x| x.1 >= 250.0).map(|x| x.0).collect();
            println!(
                "{}{} {}: request {:.1} MB, reply {:.1} MB; leading {:.1} ms, trailing {:.1} ms, longest gap {:.1} ms",
                if waived.is_empty() { String::new() } else { format!("WAIVED FU-MM-T ({} serde interval past 250 ms): ", waived.join(" and ")) },
                label,
                wire,
                req.len() as f64 / 1e6,
                full.len() as f64 / 1e6,
                lead,
                trail,
                gap
            );
            assert!(gap < 250.0, "{} {}: {:.1} ms between two engine checks: strict, not waived", label, wire, gap);
        }
    }
}
