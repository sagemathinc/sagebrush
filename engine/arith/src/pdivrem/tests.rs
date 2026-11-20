use super::*;
use crate::qpoly::{scan_ints, CAPS};

/// zpoly_divrem's reply for a and b (a request of their length + 20 bytes).
fn z(a: &str, b: &str, caps: &qpoly::Caps) -> Result<String, String> {
    let (fa, fb) = (scan_ints(a)?, scan_ints(b)?);
    reply_z(&fa, &fb, (a.len() + b.len() + 20) as u64, caps)
}

fn want(q: &str, r: &str) -> String {
    format!("{{\"ok\":{{\"q\":\"{}\",\"r\":\"{}\"}}}}", q, r)
}

/// A division of a by b on a ledger of `limit` words (the plan's by
/// default) and a meter of `work` units: the reply's bytes or the fault, the
/// plan, the ledger's high-water mark, the units used and the ledger's log.
/// (the reply's bytes or the fault, the plan, the ledger's high-water, the
/// units used, the ledger's log)
type Run = (Result<u64, DivFault>, Plan, u64, u64, Vec<(&'static str, u64)>);

fn run_z(a: &str, b: &str, limit: Option<u64>, work: Option<u64>) -> Run {
    let (fa, fb) = (scan_ints(a).unwrap(), scan_ints(b).unwrap());
    let r = (a.len() + b.len() + 20) as u64;
    let Ok(Ok(plan)) = admit_z(&fa, &fb, r, &CAPS) else { panic!("not a division") };
    let led = Words::new(limit.unwrap_or(plan.limit));
    let mut m = Meter::new(work.unwrap_or(plan.work));
    let out = divide_z(&fa, &fb, &plan, &led, &mut m).and_then(|dv| {
        let bytes = reply_bytes(&dv).unwrap();
        led.note("reply", bytes.div_ceil(8));
        led.reserve(bytes.div_ceil(8))?;
        let mut s = String::with_capacity(bytes as usize);
        let e = emit(&dv, &mut s, &mut m);
        led.release(bytes.div_ceil(8));
        e.map(|_| bytes)
    });
    // (everything the division made is freed: the ledger holds nothing)
    assert_eq!(led.live(), 0, "the ledger holds words after the call");
    let log = led.log.borrow().clone();
    (out, plan, led.high(), m.used(), log)
}

/// The least x in [lo, hi] with ok(x), for a monotone ok.
fn least(mut lo: u64, mut hi: u64, ok: impl Fn(u64) -> bool) -> u64 {
    assert!(ok(hi));
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if ok(mid) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}

#[test]
fn z_matches_the_sage_oracle() {
    let text = include_str!("oracle_z.txt");
    let mut n = 0;
    for line in text.lines().filter(|l| !l.starts_with('#')) {
        let f: Vec<&str> = line.split('|').collect();
        assert_eq!(f.len(), 4, "{}", line);
        assert_eq!(z(f[0], f[1], &CAPS).unwrap(), want(f[2], f[3]), "{} / {}", f[0], f[1]);
        n += 1;
    }
    assert_eq!(n, 326);
}

#[test]
fn z_threshold_at_the_leading_coefficient() {
    // |r_i| = |c| divides once; |c| - 1 stays in the remainder; both signs
    // (the expected values are real Sage's, run as a black box)
    for (a, b, q, r) in [
        ("0,5", "1,5", "1", "-1"),
        ("0,4", "1,5", "", "0,4"),
        ("0,-5", "1,5", "-1", "1"),
        ("0,-4", "1,5", "", "0,-4"),
        ("0,5", "1,-5", "-1", "1"),
        ("0,4", "1,-5", "", "0,4"),
        ("0,-5", "1,-5", "1", "-1"),
        ("0,-4", "1,-5", "", "0,-4"),
    ] {
        assert_eq!(z(a, b, &CAPS).unwrap(), want(q, r), "{} / {}", a, b);
    }
}

#[test]
fn z_normalizes_before_any_size_arithmetic() {
    for b in ["", "0", "0,0", "0,0,0,0"] {
        assert_eq!(z("1,2,3", b, &CAPS).unwrap_err(), "division by zero polynomial", "{:?}", b);
    }
    assert_eq!(z("", "1,2", &CAPS).unwrap(), want("", ""));
    assert_eq!(z("0,0", "1,2", &CAPS).unwrap(), want("", ""));
    // a lower degree (trailing zeros too): q empty, r = a as given
    assert_eq!(z("3,4,0,0", "1,2,3", &CAPS).unwrap(), want("", "3,4"));
    assert_eq!(z("1,2,3,0", "5,6,0,0,0", &CAPS).unwrap(), want("", "1,2,3"));
    // trailing zeros on both sides of an ordinary division
    assert_eq!(z("1,0,3,0,0", "1,2,0", &CAPS).unwrap(), z("1,0,3", "1,2", &CAPS).unwrap());
    // a constant divisor: positive, negative, non-unit
    // (hex tokens: 12 is 18; the expected values are real Sage's)
    assert_eq!(z("6,-9,12", "3", &CAPS).unwrap(), want("2,-3,6", ""));
    assert_eq!(z("6,-9,12", "-3", &CAPS).unwrap(), want("-2,3,-6", ""));
    assert_eq!(z("7,-9,12", "-3", &CAPS).unwrap(), want("-3,3,-6", "-2"));
    // the grammar is integers only
    assert!(z("1/2", "1", &CAPS).unwrap_err().contains("is not a hex integer"));
}

#[test]
fn z_short_divisors_reach_long_dividends() {
    // (t^n - 1)/(t - 1): q = 1 + t + ... + t^(n-1), r = 0
    let n = 20_000usize;
    let mut a = vec!["0"; n + 1];
    a[0] = "-1";
    a[n] = "1";
    let a = a.join(",");
    assert_eq!(z(&a, "-1,1", &CAPS).unwrap(), want(&vec!["1"; n].join(","), ""));
}

#[test]
fn z_ledger_exact_cap_admits_and_one_word_below_refuses() {
    let a = (0..300).map(|i| format!("{:x}", 3 * i + 1)).collect::<Vec<_>>().join(",");
    let b = "-7,3,5";
    let (ok, plan, _, used, _) = run_z(&a, b, None, None);
    assert!(ok.is_ok());
    // the call's required words: its high-water mark (the same reservations
    // at every limit), checked against a search for the least limit
    let need = run_z(&a, b, None, None).2;
    assert_eq!(least(0, plan.limit, |l| run_z(&a, b, Some(l), None).0.is_ok()), need);
    assert!(run_z(&a, b, Some(need), None).0.is_ok(), "the exact required words admit");
    assert_eq!(run_z(&a, b, Some(need - 1), None).0.unwrap_err(), DivFault::Memory, "one word below refuses");
    let at = run_z(&a, b, None, Some(used)).0;
    assert!(at.is_ok(), "the exact work admits");
    assert_eq!(run_z(&a, b, None, Some(used - 1)).0.unwrap_err(), DivFault::Work, "one unit below refuses");
    // an identical call gives the same verdict and the same readings
    let (x, y) = (run_z(&a, b, Some(need - 1), None), run_z(&a, b, Some(need - 1), None));
    assert_eq!((x.0, x.2, x.3), (y.0, y.2, y.3));
}

/// The ledger at each kind of event: the first window growth, a later
/// window growth, the first quotient-arena growth, the call's high-water
/// event (a reallocation, old and new both held) and the reply's
/// reservation.  A call makes the same reservations at every limit, so each
/// event that raises the running maximum has an exact requirement: that
/// limit admits it, and one word below refuses exactly there.
#[test]
fn z_ledger_pins_at_each_event() {
    // (a long quotient of small coefficients by a short divisor: the window
    // and both arenas set new maxima; then multi-limb coefficients by a
    // constant, where the reply's 16 characters per limb make it the
    // high-water event)
    let n = 3000usize;
    let long = (0..=n).map(|i| format!("{:x}", (i * 7919) % 97 + 1)).collect::<Vec<_>>().join(",");
    let wide = (0..300).map(|i| format!("{:x}{}", i + 1, "f".repeat(150))).collect::<Vec<_>>().join(",");
    let cases: [(&str, &str, &[&str]); 2] = [
        (&long, "1,1", &["the first window growth", "a later window growth", "the first quotient growth", "a later quotient growth", "the high-water event"]),
        (&wide, "3", &["the reply"]),
    ];
    for (a, b, whats) in cases {
        let (ok, _, high, _, log) = run_z(a, b, None, None);
        assert!(ok.is_ok());
        let mut best = 0;
        let records: Vec<usize> = (0..log.len()).filter(|&i| { let r = log[i].1 > best; best = best.max(log[i].1); r }).collect();
        let first = |tag: &str| records.iter().copied().find(|&i| log[i].0 == tag);
        let last = |tag: &str| records.iter().copied().rfind(|&i| log[i].0 == tag);
        for &what in whats {
            let e = match what {
                "the first window growth" => first("window"),
                "a later window growth" => last("window"),
                "the first quotient growth" => first("q arena"),
                "a later quotient growth" => last("q arena"),
                "the high-water event" => records.last().copied(),
                _ => log.iter().rposition(|e| e.0 == "reply").filter(|i| records.contains(i)),
            };
            let e = e.unwrap_or_else(|| panic!("{}: no such event raises the maximum on this input", what));
            let req = log[e].1;
            let (out, _, _, _, lg) = run_z(a, b, Some(req - 1), None);
            assert_eq!(out.unwrap_err(), DivFault::Memory, "{}", what);
            assert_eq!(lg.len(), e + 1, "{}: one word below refuses exactly there", what);
            let (out, _, _, _, lg) = run_z(a, b, Some(req), None);
            assert!(lg.len() > e + 1 || out.is_ok(), "{}: the policy's requirement admits it", what);
        }
        // the call: its high-water admits, one word below refuses, and a
        // sampled sweep below refuses with the ledger's fault (monotone)
        assert!(run_z(a, b, Some(high), None).0.is_ok());
        assert_eq!(run_z(a, b, Some(high - 1), None).0.unwrap_err(), DivFault::Memory);
        let mut x = 0x9e37_79b9_7f4a_7c15u64;
        for _ in 0..16 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let l = x % high;
            assert_eq!(run_z(a, b, Some(l), None).0.unwrap_err(), DivFault::Memory, "limit {} of {}", l, high);
        }
    }
}

/// E7: the worst-case form 2^(B_a + k(B_b + 1)) bounds every coefficient
/// the division makes (quotient digits and every intermediate remainder),
/// across the oracle corpus.
#[test]
fn z_worst_case_bound_holds_across_the_corpus() {
    let text = include_str!("oracle_z.txt");
    let maxbits = |s: &str| s.split(',').map(|t| {
        let d = t.trim_start_matches('-');
        if d == "0" || d.is_empty() { 0 } else { 4 * (d.len() as u64 - 1) + (64 - u64::from_str_radix(&d[..1], 16).unwrap().leading_zeros() as u64) }
    }).max().unwrap_or(0);
    for line in text.lines().filter(|l| !l.starts_with('#')) {
        let f: Vec<&str> = line.split('|').collect();
        let (fa, fb) = (scan_ints(f[0]).unwrap(), scan_ints(f[1]).unwrap());
        let Ok(Ok(plan)) = admit_z(&fa, &fb, 64, &CAPS) else { continue };
        MAX_BITS.with(|c| c.set(0));
        let led = Words::new(plan.limit);
        let mut m = Meter::new(plan.work);
        drop(divide_z(&fa, &fb, &plan, &led, &mut m).unwrap());
        let bound = maxbits(f[0]) + plan.k * (maxbits(f[1]) + 1);
        assert!(MAX_BITS.with(|c| c.get()) <= bound, "{} / {}: {} > {}", f[0], f[1], MAX_BITS.with(|c| c.get()), bound);
    }
}

/// The floor's sign fix-up is its own charge, floor_fix(l_t) = l_t + 1: a
/// negative top or a negative c with a nonzero remainder costs exactly that
/// much more than the same magnitudes with equal signs; an exact division
/// costs nothing extra.
#[test]
fn z_floor_fix_is_charged_as_its_own_term() {
    let used = |a: &str, b: &str| run_z(a, b, None, None).3;
    // 7 / 2: t = 3; -7 / 2 and 7 / -2: t = -4 (|t| = 3 + 1, one limb)
    let base = used("0,7", "1,2");
    assert_eq!(used("0,-7", "1,2"), base + 2, "a negative top");
    assert_eq!(used("0,7", "1,-2"), base + 2, "a negative c");
    assert_eq!(used("0,-7", "1,-2"), base, "both negative: no fix-up");
    assert_eq!(used("0,-8", "1,2"), used("0,8", "1,2"), "an exact division: no fix-up");
}

/// (t^n - 1) and the divisors t - 1 and t^2 + t + 1: admitted at 20k, 50k
/// and 100k (timings and peak words with --nocapture); x^n / (x - c) with a
/// large c and a Fibonacci-type divisor refused by the ledger, by name.
#[test]
fn z_reach_and_genuine_growth() {
    for n in [20_000usize, 50_000, 100_000] {
        let mut a = vec!["0"; n + 1];
        a[0] = "-1";
        a[n] = "1";
        let a = a.join(",");
        for b in ["-1,1", "1,1,1"] {
            let t = std::time::Instant::now();
            let (out, _, high, used, _) = run_z(&a, b, None, None);
            let ms = t.elapsed().as_secs_f64() * 1e3;
            assert!(out.is_ok(), "n = {} b = {}: {:?}", n, b, out);
            // (the exact policy's live words, its work unbounded: growing to
            // the exact need copies an arena at every push, O(n^2), which is
            // why the policy amortizes; 100k is skipped for that reason)
            if n <= 50_000 {
                EXACT.with(|e| e.set(true));
                let (out, _, exact, _, _) = run_z(&a, b, None, Some(u64::MAX));
                EXACT.with(|e| e.set(false));
                assert!(out.is_ok());
                eprintln!("(t^{} - 1) / ({}): {:.1} ms, high-water {} words (exact policy {}, ratio {:.3}), {} units", n, b, ms, high, exact, high as f64 / exact as f64, used);
            } else {
                eprintln!("(t^{} - 1) / ({}): {:.1} ms, high-water {} words, {} units", n, b, ms, high, used);
            }
        }
    }
    // genuine growth: x^n / (x - c), c = 2^63 - 1, and x^n / (x^2 - x - 1)
    for (b, what) in [("-7fffffffffffffff,1", "x - (2^63 - 1)"), ("-1,-1,1", "x^2 - x - 1")] {
        let mut lo = 1000usize;
        let mut hi = 1 << 20;
        let x = |n: usize| {
            let mut a = vec!["0"; n + 1];
            a[n] = "1";
            a.join(",")
        };
        while hi - lo > lo / 50 {
            let mid = (lo + hi) / 2;
            if z(&x(mid), b, &CAPS).is_ok() {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let e = z(&x(hi), b, &CAPS).unwrap_err();
        assert!(e.contains("the division's memory needs more than") || e.contains("the division needs more than"), "{}", e);
        eprintln!("x^n / ({}): admitted to n ~ {}, refused from ~ {}: {}", what, lo, hi, e);
    }
}
