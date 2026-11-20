use super::*;
use crate::coprime::{quot_work, quot_work_any};
use dashu_int::ops::{Gcd, UnsignedAbs};
use dashu_int::{IBig, UBig};

fn rng(seed: u64) -> impl FnMut() -> u64 {
    let mut s = seed;
    move || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    }
}

/// x / y by divexact_in_place against dashu, with the meter at most Q and
/// Qhat; the dividend is left zero.
fn div(x: &[u64], y: &[u64]) {
    let (nx, ny) = (x.len(), y.len());
    let mut a = x.to_vec();
    a.push(0);
    let mut b = y.to_vec();
    let mut q = vec![0u64; nx - ny + 1];
    let mut m = Meter::new(u64::MAX);
    let n = divexact_in_place(&mut a, nx, &mut b, ny, &mut q, &mut m).unwrap();
    let want = UBig::from_words(x) / UBig::from_words(y);
    assert_eq!(UBig::from_words(&q[..n]), want, "{:x?} / {:x?}", x, y);
    assert!(q[n..].iter().all(|&w| w == 0));
    assert!(a.iter().all(|&w| w == 0), "the dividend is left zero");
    assert!(m.used() <= quot_work(nx as u64, ny as u64).unwrap(), "{} > Q({}, {})", m.used(), nx, ny);
    assert!(m.used() <= quot_work_any(nx as u64).unwrap());
    // (the per-limb charge is the Knuth D site's term, 2 l_y + 4 <= 2 lam + 8)
    assert!(m.largest_charge() <= 2 * nx as u64 + 8);
}

fn words(u: &UBig) -> Vec<u64> {
    let mut w: Vec<u64> = u.to_le_bytes().chunks(8).map(|c| c.iter().rev().fold(0u64, |a, &b| (a << 8) | b as u64)).collect();
    while w.last() == Some(&0) {
        w.pop();
    }
    w
}

#[test]
fn exact_quotients_match_dashu_and_their_bounds() {
    let h = 1u64 << 63;
    let mut next = rng(0x5eed);
    // the classic correction patterns as divisors, times random quotients
    let ys: Vec<Vec<u64>> = vec![vec![1], vec![u64::MAX], vec![3], vec![1, 0, h], vec![1, 0, h >> 2], vec![u64::MAX, 0, h], vec![u64::MAX, u64::MAX], vec![1, 1], vec![3, h], vec![u64::MAX, h - 1, 2]];
    let picks = [0, 1, h - 1, h, h + 1, u64::MAX - 1, u64::MAX];
    for y in &ys {
        for qn in 1..6 {
            for _ in 0..200 {
                let mut q: Vec<u64> = (0..qn).map(|_| picks[(next() % 7) as usize] ^ (next() % 3)).collect();
                if q[qn - 1] == 0 {
                    q[qn - 1] = 1;
                }
                let x = UBig::from_words(&q) * UBig::from_words(y);
                div(&words(&x), y);
            }
        }
        // q = 1 (equal operands) and d = 1
        div(y, y);
        div(y, &[1]);
    }
    // random shapes
    for _ in 0..3000 {
        let (ny, nq) = (1 + (next() % 6) as usize, 1 + (next() % 6) as usize);
        let mut y: Vec<u64> = (0..ny).map(|_| next()).collect();
        let mut q: Vec<u64> = (0..nq).map(|_| next()).collect();
        y[ny - 1] |= 1;
        q[nq - 1] |= 1;
        div(&words(&(UBig::from_words(&q) * UBig::from_words(&y))), &y);
    }
}

#[test]
fn a_remainder_is_an_invariant_failure() {
    let mut x = vec![7u64, 0];
    let mut y = vec![2u64];
    let mut q = vec![0u64; 1];
    let mut m = Meter::new(u64::MAX);
    assert_eq!(divexact_in_place(&mut x, 1, &mut y, 1, &mut q, &mut m), Err(Fault::Invariant));
    let mut x = vec![5u64, 1, 0];
    let mut y = vec![3u64, 1];
    let mut q = vec![0u64; 1];
    assert_eq!(divexact_in_place(&mut x, 2, &mut y, 2, &mut q, &mut m), Err(Fault::Invariant));
}

#[test]
fn qhat_covers_every_divisor_size() {
    for lx in 1..=300u64 {
        let qh = quot_work_any(lx).unwrap();
        for ly in 1..=lx {
            assert!(quot_work(lx, ly).unwrap() <= qh, "Q({}, {}) > Qhat", lx, ly);
        }
    }
    // the closed forms at extreme lengths: None, never a wrapped value
    assert_eq!(quot_work_any(u64::MAX), None);
    assert_eq!(quot_work(u64::MAX, 1), None);
    assert_eq!(quot_work(5, 0), None);
    assert_eq!(quot_work(5, 6), None);
    // the meter at the worst divisor size l_y ~ (l_x - 1) / 2
    let mut next = rng(77);
    for lx in [9usize, 21, 61] {
        let ly = (lx - 1) / 2;
        let mut y: Vec<u64> = (0..ly).map(|_| next()).collect();
        y[ly - 1] |= 1;
        let mut q: Vec<u64> = (0..lx - ly).map(|_| next()).collect();
        q[lx - ly - 1] = u64::MAX;
        let x = words(&(UBig::from_words(&q) * UBig::from_words(&y)));
        div(&x, &y);
    }
}

/// A factor's tokens from (numerator, denominator) pairs.
fn tokens(f: &[(i64, u64)]) -> String {
    f.iter()
        .map(|&(n, d)| if d == 1 { format!("{}{:x}", if n < 0 { "-" } else { "" }, n.unsigned_abs()) } else { format!("{}{:x}/{:x}", if n < 0 { "-" } else { "" }, n.unsigned_abs(), d) })
        .collect::<Vec<_>>()
        .join(",")
}

fn parse_big(t: &str) -> (IBig, UBig) {
    let (neg, n, d) = parts(t);
    let n = IBig::from(UBig::from_str_radix(n, 16).unwrap());
    (if neg { -n } else { n }, UBig::from_str_radix(d, 16).unwrap())
}

/// The reference: each product coefficient as a reduced rational, in the
/// reply's token form.
fn reference(a: &str, b: &str) -> String {
    let (fa, fb): (Vec<_>, Vec<_>) = (a.split(',').map(parse_big).collect(), b.split(',').map(parse_big).collect());
    let mut c: Vec<(IBig, UBig)> = vec![(IBig::from(0), UBig::from(1u8)); fa.len() + fb.len() - 1];
    for (i, (n1, d1)) in fa.iter().enumerate() {
        for (j, (n2, d2)) in fb.iter().enumerate() {
            let (n, d) = (n1 * n2, d1 * d2);
            let (cn, cd) = &c[i + j];
            let nn = cn * IBig::from(d.clone()) + &n * IBig::from(cd.clone());
            let dd = cd * &d;
            let g = nn.clone().unsigned_abs().gcd(&dd);
            let g = if g == UBig::from(0u8) { UBig::from(1u8) } else { g };
            c[i + j] = (nn / IBig::from(g.clone()), dd / g);
        }
    }
    while c.len() > 0 && c.last().unwrap().0 == IBig::from(0) {
        c.pop();
    }
    c.iter()
        .map(|(n, d)| {
            let s = if *n < IBig::from(0) { "-" } else { "" };
            let m = n.clone().unsigned_abs();
            if *d == UBig::from(1u8) || m == UBig::from(0u8) {
                format!("{}{:x}", s, m)
            } else {
                format!("{}{:x}/{:x}", s, m, d)
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// The whole path with the counts: (reply tokens, plan, phase A's meter,
/// the units counted).
pub(super) struct Run {
    pub out: String,
    pub plan: Option<PlanB>,
    pub used_a: u64,
    pub largest_a: u64,
    pub total: u64,
}

pub(super) fn run(a: &str, b: &str, caps: &Caps) -> Result<Run, String> {
    let r = (a.len() + b.len() + 20) as u64;
    let (fa, fb) = (scan(a)?, scan(b)?);
    let _ = counted::take();
    let pa = match admit_a(&fa, &fb, r, caps)? {
        None => return Ok(Run { out: String::new(), plan: None, used_a: 0, largest_a: 0, total: 0 }),
        Some(p) => p,
    };
    let mut m = Meter::new(pa.limit);
    let l = lcms_metered(&fa, &fb, &pa, &mut m).map_err(|f| format!("{:?} at {} (limit {})", f, m.used(), pa.limit))?;
    assert!(m.largest_charge() <= max_charge(pa.lam).unwrap());
    let (used_a, largest_a) = (m.used(), m.largest_charge());
    let pb = admit_b(&fa, &fb, &l, &pa, r, caps)?;
    let mut p = product(&fa, &fb, l, &pb)?;
    let mut out = String::with_capacity(pb.reply as usize);
    out.push_str("{\"ok\":\"");
    let used_b = emit(&mut p, &pb, &mut out)?;
    out.push_str("\"}");
    assert!(out.len() as u64 <= pb.reply, "the reply {} > {}", out.len(), pb.reply);
    // (the call's work within the cap; phase B's meter within its limit, its
    // largest single charge within max_charge(max(l_c, l_D)))
    let total = r + used_a + used_b + counted::take();
    assert!(total <= caps.int.work, "work {} > {}", total, caps.int.work);
    assert!(used_b <= pb.limit_b);
    assert!(p.meter.largest_charge() <= max_charge(pb.lc.max(pb.ld)).unwrap(), "phase B's largest charge {} > max_charge({})", p.meter.largest_charge(), pb.lc.max(pb.ld));
    let out = out[7..out.len() - 2].to_string();
    Ok(Run { out, plan: Some(pb), used_a, largest_a, total })
}

fn check(a: &str, b: &str) -> Run {
    let r = run(a, b, &CAPS).unwrap();
    assert_eq!(r.out, reference(a, b), "{} x {}", &a[..a.len().min(80)], &b[..b.len().min(80)]);
    r
}

#[test]
fn products_match_the_reference() {
    check("1/2,1", "-1/3,1");
    check("1", "1");
    check("0,0,5/7", "3/14");
    check("-1/2,-2/3,-3/4", "-4/5,-5/6");
    check("1/2,1/2,1/2", "2,2");
    check("1/3,1/6", "3,6");
    check(&tokens(&[(1, 1), (0, 1), (-1, 1)]), &tokens(&[(1, 2), (1, 2)]));
    let mut next = rng(4242);
    for &(la, lb, nb, db) in &[(1, 1, 8, 8), (3, 5, 16, 16), (7, 4, 60, 40), (20, 30, 63, 63), (60, 50, 40, 12), (200, 3, 10, 3)] {
        for _ in 0..5 {
            let f = |l: usize, next: &mut dyn FnMut() -> u64| {
                let v: Vec<(i64, u64)> = (0..l).map(|_| ((next() >> (64 - nb)) as i64 * if next() & 1 == 0 { 1 } else { -1 }, (next() >> (64 - db)).max(1))).collect();
                tokens(&v)
            };
            let (a, b) = (f(la, &mut next), f(lb, &mut next));
            check(&a, &b);
        }
    }
    // multi-limb numerators and denominators, coprime and shared
    let n1 = "f".repeat(70);
    let d1 = format!("1{}", "0".repeat(40));
    let d2 = "3".repeat(37);
    check(&format!("{}/{},-{}/{},1", n1, d1, n1, d2), &format!("{}/{},7/{}", d2, d1, d2));
}

#[test]
fn zero_and_empty_factors_are_answered_before_any_length_arithmetic() {
    for (a, b) in [("", "1/2"), ("1/2", ""), ("0,0", "1/2"), ("1/3", "0"), ("0/5,0", "1")] {
        let r = run(a, b, &CAPS).unwrap();
        assert!(r.plan.is_none() && r.out.is_empty(), "{:?} x {:?}", a, b);
    }
}

#[test]
fn malformed_tokens_are_refused() {
    for t in ["1/0", "1/-2", "-0", "01", "1/02", "1/", "/2", "1/2/3", "x", "1,,2", "1 ", "A"] {
        assert!(scan(t).is_err(), "{:?} accepted", t);
    }
    assert!(scan("0/5").is_ok() && scan("-1/1").is_ok());
}

#[test]
fn every_charge_site_is_within_its_term() {
    let mut next = rng(31);
    for lam in [1usize, 2, 5, 40, 300] {
        let x: Vec<u64> = (0..lam).map(|_| next() | 1).collect();
        let y: Vec<u64> = (0..lam.div_ceil(2)).map(|_| next() | 1).collect();
        // the product row: lam + 2
        let mut out = vec![0u64; x.len() + y.len()];
        let mut m = Meter::new(u64::MAX);
        mul_into(&x, &y, &mut out, &mut m).unwrap();
        assert!(m.largest_charge() <= lam as u64 + 2 || x.len() + y.len() > lam + 1);
        assert_eq!(m.used(), schoolbook_work(x.len(), y.len()).unwrap());
        // the gcd: 7 lam + 101
        let mut s0 = vec![0u64; lam + 1];
        let mut s1 = vec![0u64; lam + 1];
        s0[..lam].copy_from_slice(&x);
        s1[..y.len()].copy_from_slice(&y);
        let mut m = Meter::new(u64::MAX);
        gcd_in_place(&mut s0, lam, &mut s1, y.len(), &mut m).unwrap();
        assert!(m.largest_charge() <= max_charge(lam as u64).unwrap());
    }
    // the whole of phase A, at its worst shapes: within max_charge(Lambda)
    for (a, b) in [(vec!["1/2"; 500].join(","), "1".to_string()), ((1..300).map(|i| format!("1/{:x}", (1u64 << 62) + 2 * i + 1)).collect::<Vec<_>>().join(","), "1/3".to_string())] {
        let (fa, fb) = (scan(&a).unwrap(), scan(&b).unwrap());
        let pa = admit_a(&fa, &fb, 100, &CAPS).unwrap().unwrap();
        let mut m = Meter::new(pa.limit);
        lcms_metered(&fa, &fb, &pa, &mut m).unwrap();
        assert!(m.largest_charge() <= max_charge(pa.lam).unwrap(), "{} > max_charge({})", m.largest_charge(), pa.lam);
    }
}

/// Whether an n x n product of `tok` coefficients succeeds (the whole call,
/// the reduction being metered), and the refusal otherwise.
fn admitted(n: usize, tok: &str) -> Result<usize, String> {
    let a = vec![tok; n].join(",");
    let r = (2 * a.len() + 20) as u64;
    let f = scan(&a)?;
    reply(&f, &f, r, &CAPS).map(|x| x.len())
}

#[test]
#[ignore]
fn probe_admitted_maxima() {
    for tok in ["7", "7/2", "7/10000000001", "7/1000000000000000001", "7/10000000000000000000000000000000001"] {
        let (mut lo, mut hi) = (1usize, 1 << 20);
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if admitted(mid, tok).is_ok() { lo = mid } else { hi = mid - 1 }
        }
        eprintln!("{:>40}: n = {} ({} terms); at n + 1: {}", tok, lo, 2 * lo - 1, admitted(lo + 1, tok).err().unwrap_or_default());
    }
    // the five measured shapes, at the op's caps
    let mut next = rng(5);
    let rand = |n: usize, nb: u32, db: u32, next: &mut dyn FnMut() -> u64| (0..n).map(|_| format!("{}{:x}/{:x}", if next() & 1 == 0 { "-" } else { "" }, (next() >> (64 - nb)) | 1, (next() >> (64 - db)) | 1)).collect::<Vec<_>>().join(",");
    let harmonic = |n: usize| (1..=n).map(|i| format!("1/{:x}", i)).collect::<Vec<_>>().join(",");
    let rows = [("201 x 201 random 32/32", rand(201, 32, 32, &mut next), rand(201, 32, 32, &mut next)), ("1/i 200", harmonic(200), harmonic(200)), ("1/i 1000", harmonic(1000), harmonic(1000)), ("1/i 3000", harmonic(3000), harmonic(3000)), ("2000 random 16/16", rand(2000, 16, 16, &mut next), rand(2000, 16, 16, &mut next))];
    for (what, a, b) in &rows {
        let r = (a.len() + b.len() + 20) as u64;
        let t = std::time::Instant::now();
        let x = reply(&scan(a).unwrap(), &scan(b).unwrap(), r, &CAPS);
        eprintln!("{}: {} in {:.3} s", what, x.map(|s| format!("ok, {} bytes", s.len())).unwrap_or_else(|e| e), t.elapsed().as_secs_f64());
    }
    // the largest harmonic square admitted
    let (mut lo, mut hi) = (1usize, 3000);
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        let h = harmonic(mid);
        if reply(&scan(&h).unwrap(), &scan(&h).unwrap(), (2 * h.len() + 20) as u64, &CAPS).is_ok() { lo = mid } else { hi = mid - 1 }
    }
    let h = harmonic(lo + 1);
    eprintln!("harmonic: n = {}; at n + 1: {}", lo, reply(&scan(&h).unwrap(), &scan(&h).unwrap(), (2 * h.len() + 20) as u64, &CAPS).err().unwrap_or_default());
}

/// Many coprime denominators: phase A's meter passes its limit and the
/// refusal names it; the count at the refusal is at most max_charge(Lambda)
/// past the limit (the meter checks after every charge).
#[test]
fn coprime_denominators_are_refused_by_the_meter() {
    let a: String = (0..12_000u64).map(|i| format!("1/{:x}", (1u64 << 62) + 2 * i + 1)).collect::<Vec<_>>().join(",");
    let (fa, fb) = (scan(&a).unwrap(), scan("1/3").unwrap());
    let r = (a.len() + 30) as u64;
    let pa = admit_a(&fa, &fb, r, &CAPS).unwrap().unwrap();
    assert_eq!(pa.limit, zmul::WORK_MAX - r);
    let mut m = Meter::new(pa.limit);
    assert_eq!(lcms_metered(&fa, &fb, &pa, &mut m).err(), Some(Fault::Overrun));
    let over = m.used() - pa.limit;
    assert!(m.used() > pa.limit && over <= max_charge(pa.lam).unwrap(), "overshoot {} > max_charge({})", over, pa.lam);
    let e = lcms(&fa, &fb, &pa).err().unwrap();
    assert!(e.contains("the denominators' lcm needs more than") && e.contains(&pa.limit.to_string()), "{}", e);
    // (a request of more bytes than the work: refused before the meter)
    let tiny = Caps { int: zmul::Caps { work: r - 1, ..zmul::CAPS }, ..CAPS };
    assert!(admit_a(&fa, &fb, r, &tiny).err().unwrap().contains("leave no work"));
}

/// The general path's exact counts for the common shapes: one gcd,
/// quotient and product per denominator, 1 included.
#[test]
fn counts_of_the_general_path() {
    let halves = vec!["1/2"; 100].join(",");
    let ints = vec!["5"; 100].join(",");
    let h = check(&halves, &halves);
    let i = check(&ints, &ints);
    let (hp, ip) = (h.plan.unwrap(), i.plan.unwrap());
    eprintln!("all halves 100 x 100: phase A {}, total {}, admitted closed forms {}", h.used_a, h.total, hp.work);
    eprintln!("integers 100 x 100: phase A {}, total {}, admitted {}", i.used_a, i.total, ip.work);
    assert_eq!((h.used_a, h.total, hp.work), (HALVES_COUNTS.0, HALVES_COUNTS.1, HALVES_COUNTS.2));
    assert_eq!((i.used_a, i.total, ip.work), (INTS_COUNTS.0, INTS_COUNTS.1, INTS_COUNTS.2));
}

// (phase A: 131 units per token, the same for d = 1 and d = 2; the totals
// include the test's R; admitted: R, phase A's count and phase B's closed
// forms, the reduction being metered)
const HALVES_COUNTS: (u64, u64, u64) = (26200, 67314, 39328);
const INTS_COUNTS: (u64, u64, u64) = (26200, 66692, 38700);

/// Phase B sees the true lcm: 4096 x 4096 halves would be refused by the
/// output's bits with S_d (8192 bits per factor) in the slot, and are
/// admitted with bits(L) = 2; big numerators are refused by phase B's O,
/// naming it.
#[test]
fn phase_b_admits_on_the_actual_lcm_and_refuses_by_name() {
    let halves = vec!["-3/2"; 4096].join(",");
    let r = check(&halves, &halves);
    assert!(r.plan.unwrap().slot < 40);
    let fa = scan(&halves).unwrap();
    assert!(8191 * (2 * fa.sd + 16) > zmul::O_MAX);
    let big = vec![format!("{}/2", "f".repeat(2000)); 4096].join(",");
    let e = run(&big, &big, &CAPS).err().unwrap();
    assert!(e.contains("the product's bits (l_a + l_b - 1) s"), "{}", e);
}

/// The reply's exact bound: admitted with a reply cap at exactly the bound,
/// refused at one byte less (at phase B's admission, before the reply or
/// any of phase B's allocations); every token of these factors reaches
/// close to its digit bounds and the emitted reply is within it.
#[test]
fn the_reply_bound_is_exact() {
    let n = format!("-{}", "f".repeat(40));
    let a = (0..30).map(|i| format!("{}/{:x}", n, (1u64 << 63) + 2 * i + 1)).collect::<Vec<_>>().join(",");
    let b = (0..20).map(|i| format!("{}/{:x}", n, (1u64 << 62) + 6 * i + 5)).collect::<Vec<_>>().join(",");
    let r = check(&a, &b);
    let reply = r.plan.unwrap().reply;
    let at = Caps { reply, ..CAPS };
    let ok = run(&a, &b, &at).unwrap();
    assert!(ok.out.len() as u64 + 9 <= reply);
    let less = Caps { reply: reply - 1, ..CAPS };
    let e = run(&a, &b, &less).err().unwrap();
    assert!(e.contains("the reply's bytes") && e.contains(&reply.to_string()), "{}", e);
}

/// The actual counts against the admitted bound on shapes the bound refuses
/// (no caps), for the design discussion.
#[test]
#[ignore]
fn probe_actual_vs_admitted() {
    let big = Caps { int: zmul::Caps { work: u64::MAX, peak: u64::MAX, o: u64::MAX, n: u64::MAX, request: u64::MAX }, reply: u64::MAX };
    let mut next = rng(5);
    let rand = |n: usize, nb: u32, db: u32, next: &mut dyn FnMut() -> u64| (0..n).map(|_| format!("{}{:x}/{:x}", if next() & 1 == 0 { "-" } else { "" }, (next() >> (64 - nb)) | 1, (next() >> (64 - db)) | 1)).collect::<Vec<_>>().join(",");
    let harmonic = |n: usize| (1..=n).map(|i| format!("1/{:x}", i)).collect::<Vec<_>>().join(",");
    let cases = [
        ("201 x 201 random 32/32", rand(201, 32, 32, &mut next), rand(201, 32, 32, &mut next)),
        ("1/i, 200 x 200", harmonic(200), harmonic(200)),
        ("1/i, 1000 x 1000", harmonic(1000), harmonic(1000)),
        ("1/i, 3000 x 3000", harmonic(3000), harmonic(3000)),
        ("2000 x 2000 random 16/16", rand(2000, 16, 16, &mut next), rand(2000, 16, 16, &mut next)),
    ];
    for (what, a, b) in &cases {
        let r = run(a, b, &big).unwrap();
        let p = r.plan.unwrap();
        eprintln!("{}: actual {} (phase A {}), admitted {} ({:.0}x), ld {}, lc {}", what, r.total, r.used_a, p.work, p.work as f64 / r.total as f64, p.ld, p.lc);
    }
}


/// A reduction whose real work passes the cap: refused by phase B's meter,
/// by name, at most max_charge(max(l_c, l_D)) past its limit (the refusing
/// charge counted).
#[test]
fn a_long_reduction_is_refused_by_the_meter() {
    // (600 nearly coprime 22-bit denominators per factor: D of about 400
    // limbs, 1199 coefficients, within the output's bits)
    let a = (0..600u64).map(|i| format!("1/{:x}", (1u64 << 21) + 2 * i + 1)).collect::<Vec<_>>().join(",");
    let b = (0..600u64).map(|i| format!("-3/{:x}", (1u64 << 22) + 2 * i + 1)).collect::<Vec<_>>().join(",");
    let (fa, fb, r) = (scan(&a).unwrap(), scan(&b).unwrap(), (a.len() + b.len() + 20) as u64);
    let pa = admit_a(&fa, &fb, r, &CAPS).unwrap().unwrap();
    let l = lcms(&fa, &fb, &pa).unwrap();
    let pb = admit_b(&fa, &fb, &l, &pa, r, &CAPS).unwrap();
    let mut p = product(&fa, &fb, l, &pb).unwrap();
    let mut out = String::new();
    let e = emit(&mut p, &pb, &mut out).err().unwrap();
    assert!(e.contains("the coefficients' reduction needs more than"), "{}", e);
    let over = p.meter.used() - pb.limit_b;
    assert!(p.meter.used() > pb.limit_b && over <= max_charge(pb.lc.max(pb.ld)).unwrap(), "overshoot {}", over);
    assert!(p.meter.largest_charge() <= max_charge(pb.lc.max(pb.ld)).unwrap());
    assert!(reply(&fa, &fb, r, &CAPS).err().unwrap().contains("the coefficients' reduction needs more than"));
}

// ---- qpoly_clear ----

/// The reference: d = the lcm of the nonzero numerators' denominators, as
/// given; c_i = n_i (d / d_i); in the reply's form.
fn clear_reference(a: &str) -> String {
    if a.is_empty() {
        return "{\"ok\":{\"d\":\"1\",\"c\":\"\"}}".to_string();
    }
    let toks: Vec<(IBig, UBig)> = a.split(',').map(parse_big).collect();
    let mut d = UBig::from(1u8);
    for (n, dd) in &toks {
        if *n != IBig::from(0) {
            let g = d.clone().gcd(dd);
            d = &d / &g * dd;
        }
    }
    let c: Vec<String> = toks
        .iter()
        .map(|(n, dd)| {
            if *n == IBig::from(0) {
                return "0".to_string();
            }
            let v = n * IBig::from(&d / dd);
            if v < IBig::from(0) {
                format!("-{:x}", v.unsigned_abs())
            } else {
                format!("{:x}", v.unsigned_abs())
            }
        })
        .collect();
    format!("{{\"ok\":{{\"d\":\"{:x}\",\"c\":\"{}\"}}}}", d, c.join(","))
}

fn clear_run(a: &str, caps: &Caps) -> Result<(String, u64, u64), String> {
    let f = scan(a)?;
    let r = (a.len() + 20) as u64;
    let Some(plan) = admit_clear(&f, r, caps)? else {
        return Ok((clear_reply(&f, r, caps)?, 0, 0));
    };
    let mut m = Meter::new(plan.limit);
    let out = clear_metered(&f, r, caps, &plan, &mut m).map_err(|e| match e {
        ClearError::Refused(s) => s,
        ClearError::Fault(f, a) => format!("fault {:?} (phase A {})", f, a),
    })?;
    Ok((out, m.used(), m.largest_charge()))
}

#[test]
fn clear_matches_the_reference() {
    let mut next = rng(808);
    let cases: Vec<String> = vec![
        "".into(),
        "0".into(),
        "0,0,0".into(),
        "5".into(),
        "-3/7".into(),
        "1/2,1/3,1/6".into(),
        "1/2,0,0".into(),
        "3,-2,1".into(),
        tokens(&[(1, 2), (0, 1), (-5, 6), (7, 1)]),
        format!("{}/{},-{}/{},1,0", "f".repeat(70), "1".to_string() + &"0".repeat(40), "e".repeat(33), "3".repeat(37)),
    ];
    let mut all = cases;
    for &(l, nb, db) in &[(10usize, 8u32, 8u32), (100, 63, 20), (300, 30, 3), (50, 63, 63)] {
        let v: Vec<(i64, u64)> = (0..l).map(|_| ((next() >> (64 - nb)) as i64 * if next() & 1 == 0 { 1 } else { -1 }, (next() >> (64 - db)).max(1))).collect();
        all.push(tokens(&v));
    }
    for a in &all {
        let (out, _, _) = clear_run(a, &CAPS).unwrap();
        assert_eq!(out, clear_reference(a), "{}", &a[..a.len().min(80)]);
    }
}

/// The lcm is of the NONZERO numerators' denominators, AS GIVEN: `0/5`
/// takes no part, `2/4` contributes 4 (not 2).
#[test]
fn clear_takes_nonzero_denominators_as_given() {
    let (out, _, _) = clear_run("0/5,1/3", &CAPS).unwrap();
    assert_eq!(out, "{\"ok\":{\"d\":\"3\",\"c\":\"0,1\"}}");
    let (out, _, _) = clear_run("2/4,1", &CAPS).unwrap();
    assert_eq!(out, "{\"ok\":{\"d\":\"4\",\"c\":\"2,4\"}}");
    // (trailing zeros kept, length and order as given)
    let (out, _, _) = clear_run("-1/2,0,0/9,0", &CAPS).unwrap();
    assert_eq!(out, "{\"ok\":{\"d\":\"2\",\"c\":\"-1,0,0,0\"}}");
}

/// The meter's count within the admitted forms: phase B's within clear_work
/// (and pinned exactly for two shapes); the largest charge within
/// max_charge(Lambda).
#[test]
fn clear_counts_within_its_forms() {
    let mut next = rng(99);
    for &(l, nb, db) in &[(1usize, 8u32, 8u32), (40, 63, 30), (200, 20, 4), (64, 63, 63)] {
        let v: Vec<(i64, u64)> = (0..l).map(|_| ((next() >> (64 - nb)) as i64 * if next() & 1 == 0 { 1 } else { -1 }, (next() >> (64 - db)).max(1))).collect();
        let a = tokens(&v);
        let f = scan(&a).unwrap();
        let r = (a.len() + 20) as u64;
        let plan = admit_clear(&f, r, &CAPS).unwrap().unwrap();
        let mut m = Meter::new(plan.limit);
        // (phase A alone, to split the count)
        let mut lb = vec![0u64; plan.lam as usize + 1];
        let ws = coprime::workspace_words(plan.lam).unwrap() as usize;
        let d = plan.d_max as usize;
        let mut s = LcmScratch { ws: vec![0u64; ws], q: vec![0u64; d + 1], kx: vec![0u64; d + 1], ky: vec![0u64; d], prod: vec![0u64; plan.lam as usize + 1] };
        let nl = lcm(&f, &mut lb, &mut s, &mut m, true).unwrap();
        let used_a = m.used();
        let mut m2 = Meter::new(plan.limit);
        let out = clear_metered(&f, r, &CAPS, &plan, &mut m2).ok().unwrap();
        assert!(out.len() as u64 <= clear_reply_bound(&f, bits(&lb[..nl])).unwrap());
        let used_b = m2.used() - used_a;
        let form = clear_work(&f, nl as u64).unwrap();
        assert!(used_b <= form, "{} tokens: phase B {} > {}", l, used_b, form);
        assert!(m2.largest_charge() <= max_charge(plan.lam.max(nl as u64 + f.n_max + 1)).unwrap());
    }
    // (pinned: all halves and all integers, 100 tokens)
    let pin = |a: &str| {
        let f = scan(a).unwrap();
        let r = (a.len() + 20) as u64;
        let plan = admit_clear(&f, r, &CAPS).unwrap().unwrap();
        let mut m = Meter::new(plan.limit);
        clear_metered(&f, r, &CAPS, &plan, &mut m).ok().unwrap();
        m.used()
    };
    assert_eq!((pin(&vec!["1/2"; 100].join(",")), pin(&vec!["5"; 100].join(","))), CLEAR_COUNTS);
}

// (all halves and all integers count the same: one gcd, quotient and product
// per denominator, 1 included, then the scaling)
const CLEAR_COUNTS: (u64, u64) = (15602, 15602);

/// The reply's exact bound: a reply cap at exactly the bound admits; one
/// byte less refuses at phase B's admission, naming the cap, with no
/// partial reply; the reply cap alone (work and memory well within theirs).
#[test]
fn clear_reply_bound_is_exact() {
    let a = (0..40).map(|i| format!("-{}/{:x}", "f".repeat(30), (1u64 << 62) + 2 * i + 1)).collect::<Vec<_>>().join(",");
    let f = scan(&a).unwrap();
    let r = (a.len() + 20) as u64;
    let plan = admit_clear(&f, r, &CAPS).unwrap().unwrap();
    let mut m = Meter::new(plan.limit);
    let mut l = vec![0u64; plan.lam as usize + 1];
    let ws = coprime::workspace_words(plan.lam).unwrap() as usize;
    let d = plan.d_max as usize;
    let mut s = LcmScratch { ws: vec![0u64; ws], q: vec![0u64; d + 1], kx: vec![0u64; d + 1], ky: vec![0u64; d], prod: vec![0u64; plan.lam as usize + 1] };
    let nl = lcm(&f, &mut l, &mut s, &mut m, true).unwrap();
    let bound = clear_reply_bound(&f, bits(&l[..nl])).unwrap();
    let at = Caps { reply: bound, ..CAPS };
    let (out, _, _) = clear_run(&a, &at).unwrap();
    assert!(out.len() as u64 <= bound);
    let e = clear_run(&a, &Caps { reply: bound - 1, ..CAPS }).err().unwrap();
    assert!(e.contains("the reply's bytes") && e.contains(&bound.to_string()), "{}", e);
}

/// Many coprime denominators: refused by the lcm's meter, by name, at most
/// max_charge(Lambda) past its limit.
#[test]
fn clear_refused_by_the_lcm_meter() {
    let a: String = (0..12_000u64).map(|i| format!("1/{:x}", (1u64 << 62) + 2 * i + 1)).collect::<Vec<_>>().join(",");
    let f = scan(&a).unwrap();
    let r = (a.len() + 20) as u64;
    let plan = admit_clear(&f, r, &CAPS).unwrap().unwrap();
    let mut m = Meter::new(plan.limit);
    match clear_metered(&f, r, &CAPS, &plan, &mut m) {
        Err(ClearError::Fault(Fault::Overrun, true)) => {}
        _ => panic!("not refused by the lcm's meter"),
    }
    assert!(m.used() > plan.limit && m.used() - plan.limit <= max_charge(plan.lam).unwrap());
    let e = clear_reply(&f, r, &CAPS).err().unwrap();
    assert!(e.contains("the denominators' lcm needs more than"), "{}", e);
}
