use super::*;
use crate::coprime::{gcd_work_short, quot_work, quot_work_any};
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
    assert_eq!(gcd_work_short(u64::MAX / 3 + 1), None);
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

/// The gcd's meter when one operand has at most one limb: at most 3 max +
/// 95 (gcd_work_short), in both operand orders.
fn short_gcd(x: &[u64], y: &[u64]) {
    let hi = x.len().max(y.len());
    for (a, b) in [(x, y), (y, x)] {
        let mut s0 = vec![0u64; hi + 1];
        let mut s1 = vec![0u64; hi + 1];
        s0[..a.len()].copy_from_slice(a);
        s1[..b.len()].copy_from_slice(b);
        let mut m = Meter::new(u64::MAX);
        let (slot, lg) = gcd_in_place(&mut s0, a.len(), &mut s1, b.len(), &mut m).unwrap();
        let g = if slot { &s1[..lg] } else { &s0[..lg] };
        let (ua, ub) = (UBig::from_words(a), UBig::from_words(b));
        if ua == UBig::ZERO && ub == UBig::ZERO {
            assert_eq!(lg, 0);
        } else {
            assert_eq!(UBig::from_words(g), ua.gcd(&ub));
        }
        assert!(m.used() <= gcd_work_short(hi as u64).unwrap(), "{} > 3 * {} + 95", m.used(), hi);
    }
}

#[test]
fn one_limb_gcds_are_within_the_short_bound() {
    let mut next = rng(99);
    let big: Vec<u64> = (0..40).map(|_| next() | 1).collect();
    // c = 0; c < D; c > D (the swap); equal; D = 1; D = 4; a multi-limb c
    short_gcd(&[], &[4]);
    short_gcd(&[], &[]);
    short_gcd(&[3], &[10]);
    short_gcd(&[10], &[3]);
    short_gcd(&[7], &[7]);
    short_gcd(&[12345], &[1]);
    short_gcd(&[12], &[4]);
    short_gcd(&big, &[4]);
    short_gcd(&big, &[1]);
    short_gcd(&big, &[u64::MAX]);
    short_gcd(&big, &[]);
    // the largest coefficient the reduction admits: s <= O_MAX, so
    // ceil(s / 64) + 2 words
    let n = (zmul::O_MAX / 64 + 2) as usize;
    let huge: Vec<u64> = (0..n).map(|_| next()).collect();
    short_gcd(&huge, &[6]);
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
    let p = product(&fa, &fb, l, &pb)?;
    let mut out = String::with_capacity(pb.reply as usize);
    out.push_str("{\"ok\":\"");
    let used_b = emit(p, &pb, &mut out)?;
    out.push_str("\"}");
    assert!(out.len() as u64 <= pb.reply, "the reply {} > {}", out.len(), pb.reply);
    let total = r + used_a + used_b + counted::take();
    assert!(total <= pb.work, "work {} > admitted {}", total, pb.work);
    assert!(used_b <= pb.work_b);
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

/// Whether an n x n product of `tok` coefficients is admitted (both phases'
/// admissions and phase A's run; nothing of phase B allocated), and the
/// refusal otherwise.
fn admitted(n: usize, tok: &str) -> Result<PlanB, String> {
    let a = vec![tok; n].join(",");
    let r = (2 * a.len() + 20) as u64;
    let f = scan(&a)?;
    let pa = admit_a(&f, &f, r, &CAPS)?.unwrap();
    let l = lcms(&f, &f, &pa)?;
    admit_b(&f, &f, &l, &pa, r, &CAPS)
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
        let p = admitted(lo, tok).unwrap();
        eprintln!("{:>40}: n = {} ({} terms), work {}, peak {}; at n + 1: {}", tok, lo, 2 * lo - 1, p.work, p.peak, admitted(lo + 1, tok).err().unwrap_or_default());
    }
}
