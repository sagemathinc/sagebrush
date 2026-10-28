//! mat_mul asks for Stop in each of its phases, whatever the shape: the
//! parse of a and b (polled by entry bytes, so inside a long row), the
//! product (ZMat::mul's loops) and the reply (polled by entry digits).
//! For each phase: the checks' density, a Stop at its middle check lands
//! there, and the next call gives the same reply.  One test: the hooks and
//! the flag are global.

use sagebrush_interrupt::hooks;
use sagebrush_web::call;

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

/// An r x c matrix in the compact wire format, entries of `digits` digits.
fn text(s: &mut u64, r: usize, c: usize, digits: usize) -> String {
    let row = |s: &mut u64| {
        (0..c)
            .map(|_| {
                let mut t = String::new();
                if rng(s) & 1 == 0 {
                    t.push('-');
                }
                t.push((b'1' + (rng(s) % 9) as u8) as char);
                for _ in 1..digits {
                    t.push((b'0' + (rng(s) % 10) as u8) as char);
                }
                t
            })
            .collect::<Vec<_>>()
            .join(",")
    };
    (0..r).map(|_| row(s)).collect::<Vec<_>>().join(";")
}

/// Run req traced; then, for each phase, Stop at its median check: the
/// call must stop in that phase, and the next call must work.  `min` is
/// the fewest checks each phase must make.
fn phases(label: &str, req: &str, want: &[(&str, usize)]) {
    hooks::reset();
    hooks::trace();
    let full = call(req);
    assert!(full.starts_with("{\"ok\":"), "{}: {}", label, &full[..full.len().min(200)]);
    let gap = hooks::max_gap_ns();
    let counts: Vec<(&str, Vec<u64>)> = want.iter().map(|&(ph, _)| (ph, hooks::traced(ph))).collect();
    let total = hooks::total();
    hooks::reset();
    eprintln!("{}: {} checks; longest gap {:.2} ms; {:?}", label, total, gap as f64 / 1e6, counts.iter().map(|(p, v)| (*p, v.len())).collect::<Vec<_>>());
    assert!(gap < 250_000_000, "{}: {} ns between two checks", label, gap);
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

fn req(a: &str, b: &str) -> String {
    format!(r#"{{"fn":"mat_mul","a":"{}","b":"{}","wire":"csv"}}"#, a, b)
}

#[test]
fn mat_mul_stops_in_every_phase() {
    let mut s = 0x2545f4914f6cdd1du64;
    // 1 x K x 1, 9-digit entries: the parse is two rows of 2^16 entries
    // (about 1.3 MB, 20 checks at 2^16 bytes), the product 2^16
    // multiply-adds plus the scans of 2^17 entries
    let (a, b) = (text(&mut s, 1, 1 << 16, 9), text(&mut s, 1 << 16, 1, 9));
    phases("1xKx1", &req(&a, &b), &[("parse", 16), ("product", 2)]);
    // 1 x K x 1 with 300-digit entries: the BigInt loop, weighed by words
    let (a, b) = (text(&mut s, 1, 1 << 10, 300), text(&mut s, 1 << 10, 1, 300));
    phases("1xKx1 big", &req(&a, &b), &[("parse", 8), ("product", 4)]);
    // single BigInt operations as the unit: 20000-digit entries (one
    // parse, product or conversion each is the longest step between two
    // checks; the longest gap is printed and held under 250 ms)
    let (a, b) = (text(&mut s, 1, 16, 20000), text(&mut s, 16, 1, 20000));
    phases("1xKx1 huge entries", &req(&a, &b), &[("parse", 4), ("product", 16)]);
    // 1 x K x M
    let (a, b) = (text(&mut s, 1, 1 << 10, 9), text(&mut s, 1 << 10, 1 << 8, 9));
    phases("1xKxM", &req(&a, &b), &[("parse", 30), ("product", 4)]);
    // square 128: 2^21 multiply-adds; the reply 2^14 entries of up to 21 digits
    let (a, b) = (text(&mut s, 128, 128, 9), text(&mut s, 128, 128, 9));
    phases("square", &req(&a, &b), &[("parse", 4), ("product", 32), ("reply", 4)]);
    // wide: 32 x 32 x 2^11 (2^21 multiply-adds, a 2^16-entry reply)
    let (a, b) = (text(&mut s, 32, 32, 9), text(&mut s, 32, 1 << 11, 9));
    phases("wide", &req(&a, &b), &[("parse", 8), ("product", 32), ("reply", 16)]);
}
