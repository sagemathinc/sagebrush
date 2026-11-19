use super::*;
use sagebrush_bigint::ntt::mul_words_local;
use crate::zpoly;
use num_traits::{One, Signed, Zero};
use sagebrush_bigint::BigInt;

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

fn hexs(v: &[BigInt]) -> String {
    v.iter()
        .map(|c| if c.is_negative() { format!("-{}", (-c).to_str_radix(16)) } else { c.to_str_radix(16) })
        .collect::<Vec<_>>()
        .join(",")
}

fn parse(s: &str) -> Vec<BigInt> {
    if s.is_empty() {
        return vec![];
    }
    s.split(',')
        .map(|t| match t.strip_prefix('-') {
            Some(d) => -BigInt::parse_bytes(d.as_bytes(), 16).unwrap(),
            None => BigInt::parse_bytes(t.as_bytes(), 16).unwrap(),
        })
        .collect()
}

/// A random coefficient of at most `bits` bits, either sign (zero allowed).
fn coef(s: &mut u64, bits: u64) -> BigInt {
    let mut x = BigInt::zero();
    let mut left = bits;
    while left > 0 {
        let take = left.min(64);
        let w = if take == 64 { rng(s) } else { rng(s) & ((1u64 << take) - 1) };
        x = (x << take as usize) + BigInt::from(w);
        left -= take;
    }
    if rng(s) & 1 == 1 {
        -x
    } else {
        x
    }
}

/// zmul's product of two hex lists, with the units counted and the plan.
fn run(a: &str, b: &str) -> (String, u64, Option<Plan>) {
    let r = (a.len() + b.len() + 40) as u64;
    let (ca, cb) = (scan(a).unwrap(), scan(b).unwrap());
    let plan = admit(&ca, &cb, r, &CAPS).unwrap();
    counted::take();
    let mut out = String::new();
    if let Some(p) = &plan {
        out.reserve(p.admitted.reply as usize);
        mul(&ca, &cb, p, &mut out).unwrap();
        assert!(out.len() as u64 + 16 <= p.admitted.reply, "the reply's bound");
    }
    (out, counted::take(), plan)
}

#[test]
fn products_match_zpoly_mul_within_their_work() {
    let mut s = 0x1234_5678_9abc_def1u64;
    let shapes: &[(usize, u64, usize, u64)] = &[
        (1, 1, 1, 1),
        (1, 8, 3, 8),
        (3, 8, 3, 8),
        (7, 64, 5, 63),
        (40, 65, 41, 1),
        (200, 64, 200, 64),
        (1000, 8, 4, 64),
        (16, 4096, 16, 4096),
        (2, 70000, 3, 9),
        (3000, 1, 2000, 2),
    ];
    for &(la, ba, lb, bb) in shapes {
        let mut a: Vec<BigInt> = (0..la).map(|_| coef(&mut s, ba)).collect();
        let mut b: Vec<BigInt> = (0..lb).map(|_| coef(&mut s, bb)).collect();
        // (nonzero leading coefficients, so the reference's length is l_a + l_b - 1)
        a[la - 1] = BigInt::one() + BigInt::from(rng(&mut s) % 5);
        b[lb - 1] = -(BigInt::one() + BigInt::from(rng(&mut s) % 5));
        let (out, counted, plan) = run(&hexs(&a), &hexs(&b));
        let want = zpoly::mul(&a, &b);
        assert_eq!(parse(&out), want, "{}x{} bits {}x{}", la, ba, lb, bb);
        let p = plan.unwrap();
        // the counted loops (packing, unpacking) plus the word product's
        // proven bound (bigint's own tests count it) are within the admitted work
        // (the schoolbook is counted with the rest; the NTT by bigint's own tests)
        let ntt = if p.schoolbook { 0 } else { mul_words_local_work(p.wa, p.wb).unwrap() };
        assert!(counted + ntt <= p.admitted.work, "{}x{}: {} + {} > {}", la, lb, counted, ntt, p.admitted.work);
    }
}

#[test]
fn signs_all_negative_alternating_and_cancelling() {
    let cases = [
        ("-1,-2,-3", "-4,-5"),
        ("1,-1,1,-1", "1,1"),
        ("-ffffffffffffffff", "ffffffffffffffff"),
        ("1,1", "1,-1"), // 1 - x^2: a zero middle coefficient
        ("1,1", "-1,1"),
        ("0,0,5", "0,3"),
    ];
    for (a, b) in cases {
        let (out, _, _) = run(a, b);
        assert_eq!(parse(&out), zpoly::mul(&parse(a), &parse(b)), "{} * {}", a, b);
    }
    // trailing zeros are dropped, the zero polynomial is ""
    let (out, _, plan) = run("0,0", "1,2");
    assert!(out.is_empty() && plan.is_none());
    let (out, _, plan) = run("", "1");
    assert!(out.is_empty() && plan.is_none());
}

/// sum d_k 2^(k s), as words of |Z| (one spare zero word) and its sign.
fn compose(d: &[BigInt], s: u64) -> (Vec<u64>, bool) {
    let mut z = BigInt::zero();
    for c in d.iter().rev() {
        z = (z << s as usize) + c;
    }
    let neg = z.is_negative();
    let mut m = if neg { -z } else { z };
    let mut words = vec![];
    let base = BigInt::one() << 64usize;
    while !m.is_zero() {
        let r = &m % &base;
        words.push(r.to_str_radix(10).parse::<u64>().unwrap());
        m = m >> 64usize;
    }
    words.push(0);
    (words, neg)
}

#[test]
fn centered_digits_at_the_slot_boundaries() {
    for s in [63u64, 64, 65, 127, 128, 129] {
        let half = BigInt::one() << (s - 1) as usize;
        let mut digits = vec![
            -half.clone(),                // -2^(s-1)
            &half - BigInt::one(),        //  2^(s-1) - 1
            -(&half - BigInt::one()),     // -(2^(s-1) - 1)
            BigInt::one(),
            -BigInt::one(),
            BigInt::zero(),
            &half - BigInt::from(2),      // one under the top
            -(&half - BigInt::from(2)),
            BigInt::from(7),
        ];
        let (z, neg) = compose(&digits, s);
        let mut out = String::new();
        unpack(&z, neg, digits.len(), s, &mut out).unwrap();
        assert_eq!(parse(&out), digits, "slot {}", s);
        // the negated polynomial (without -2^(s-1), whose negation is out of
        // the digit range), and with a negative leading digit
        digits.remove(0);
        let negd: Vec<BigInt> = digits.iter().map(|d| -d).collect();
        let (z, neg) = compose(&negd, s);
        let mut out = String::new();
        unpack(&z, neg, negd.len(), s, &mut out).unwrap();
        assert_eq!(parse(&out), negd, "slot {}, negated", s);
    }
}

#[test]
fn bits_above_the_last_coefficient_are_an_internal_error() {
    let (z, neg) = compose(&[BigInt::from(1), BigInt::from(2), BigInt::from(3)], 64);
    let mut out = String::new();
    let e = unpack(&z, neg, 2, 64, &mut out).unwrap_err();
    assert!(e.contains(INTERNAL_PREFIX), "{}", e);
}

#[test]
fn each_cap_admits_exactly_and_refuses_one_over() {
    let (a, b) = ("1,2,3,4", "5,6,7");
    let (ca, cb) = (scan(a).unwrap(), scan(b).unwrap());
    let r = 64u64;
    let p = admit(&ca, &cb, r, &CAPS).unwrap().unwrap();
    let adm = &p.admitted;
    let o = 6 * p.slot;
    let n = ((p.wa + p.wb - 1) as u64).next_power_of_two();
    let cases: [(&str, Caps, Caps); 5] = [
        ("the request's bytes", Caps { request: r, ..CAPS }, Caps { request: r - 1, ..CAPS }),
        ("the transform's points", Caps { n, ..CAPS }, Caps { n: n - 1, ..CAPS }),
        ("the product's bits", Caps { o, ..CAPS }, Caps { o: o - 1, ..CAPS }),
        ("the memory", Caps { peak: adm.peak, ..CAPS }, Caps { peak: adm.peak - 1, ..CAPS }),
        ("the work", Caps { work: adm.work, ..CAPS }, Caps { work: adm.work - 1, ..CAPS }),
    ];
    for (what, exact, one_under) in cases {
        assert!(admit(&ca, &cb, r, &exact).unwrap().is_some(), "{}: admitted at exactly its cap", what);
        let e = admit(&ca, &cb, r, &one_under).err().unwrap_or_default();
        assert!(e.starts_with(what) && e.contains("a smaller product per call"), "{}: refused one over its cap, naming it: {}", what, e);
    }
}

#[test]
fn the_quadratic_shape_is_refused_before_any_allocation() {
    // 2^20 one-digit coefficients times one coefficient of 2^20 bits: a 2^40-bit product
    let a = vec!["1"; 1 << 20].join(",");
    let b = "f".repeat(1 << 18);
    let (ca, cb) = (scan(&a).unwrap(), scan(&b).unwrap());
    let e = admit(&ca, &cb, (a.len() + b.len()) as u64, &CAPS).err().unwrap();
    assert!(e.contains("the product's bits"), "{}", e);
}

#[test]
fn large_admitted_shapes_fit_the_work_and_memory_caps() {
    // small slots at many terms, near the transform cap
    for (la, lb) in [(1usize << 20, 1usize << 20), (1 << 21, 3), (3, 1 << 21)] {
        let a = vec!["1"; la].join(",");
        let b = vec!["1"; lb].join(",");
        let (ca, cb) = (scan(&a).unwrap(), scan(&b).unwrap());
        match admit(&ca, &cb, (a.len() + b.len()) as u64, &CAPS) {
            Ok(Some(p)) => assert!(p.admitted.work <= WORK_MAX && p.admitted.peak <= PEAK_MAX),
            Ok(None) => panic!("not a zero product"),
            Err(e) => assert!(e.contains("a smaller product per call"), "{}", e),
        }
    }
}

#[test]
fn the_schoolbook_and_the_ntt_agree_around_the_threshold() {
    let mut s = 0xabcdu64;
    let t = SCHOOLBOOK_WORDS as usize;
    let long: Vec<BigInt> = (0..3000).map(|_| coef(&mut s, 64)).collect();
    for target in [t - 1, t, t + 1] {
        // (the slot depends on the shorter length; find the short factor whose
        // packed size is the target exactly)
        let long_text = hexs(&long);
        let mut found = None;
        // (the slot moves with the short factor's coefficient size: search
        // lengths and sizes for the target exactly)
        'search: for bits in (1..=16u64).rev().map(|d| 4 * d) {
          for l in 1..400usize {
            // (each coefficient exactly `bits` bits: the top bit set)
            let short: Vec<BigInt> = (0..l).map(|_| (BigInt::one() << (bits - 1) as usize) + coef(&mut s, bits - 1).abs()).collect();
            let short_text = hexs(&short);
            let (ca, cb) = (scan(&long_text).unwrap(), scan(&short_text).unwrap());
            let p = admit(&ca, &cb, (long_text.len() + short_text.len() + 32) as u64, &CAPS).unwrap().unwrap();
            if p.wb == target {
                found = Some((short, short_text, p));
                break 'search;
            }
            if p.wb > target {
                break;
            }
          }
        }
        let (short, short_text, p) = found.unwrap_or_else(|| panic!("no short factor packs to {} words", target));
        assert_eq!(p.schoolbook, target <= t, "{} words: schoolbook {}", target, p.schoolbook);
        let (ca, cb) = (scan(&long_text).unwrap(), scan(&short_text).unwrap());
        counted::take();
        let mut out = String::new();
        mul(&ca, &cb, &p, &mut out).unwrap();
        let counted = counted::take();
        assert_eq!(parse(&out), zpoly::mul(&long, &short), "{} words", target);
        // both backends give the same words
        let (x, _) = pack(&ca, p.slot, p.wa);
        let (y, _) = pack(&cb, p.slot, p.wb);
        assert_eq!(mul_words_schoolbook(&x, &y), mul_words_local(&x, &y), "{} words", target);
        // the schoolbook's count is exactly its closed form's
        if p.schoolbook {
            assert!(counted <= p.admitted.work, "{} words: {} > {}", target, counted, p.admitted.work);
            counted::take();
            let _ = mul_words_schoolbook(&x, &y);
            assert_eq!(counted::take(), schoolbook_work(x.len(), y.len()).unwrap());
        }
    }
}
