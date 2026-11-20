//! The invariant-division steps against plain division: exhaustively at
//! 8-bit limbs (the 2-by-1 on every input, the 3-by-2's reciprocal on every
//! divisor and its step on every divisor with edge and seeded dividends),
//! sampled at 16 and 64 bits.  These run with overflow checks on (the test
//! profile), so a plain operation that wraps panics: only the steps the
//! proof allows to wrap are written wrapping, and the tests count those
//! wraps and require them to happen.

use super::{mul_wide, mul_wide32, w16, w64, w8};

/// A small deterministic generator (xorshift64*).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
}

/// Whether the 2-by-1's step 1 sum v u1 + (u1 + 1) b + u0 reaches b^2, at
/// 8 bits.
fn wraps8(d: u8, u1: u8, u0: u8) -> bool {
    let v = u32::from(w8::recip(d));
    v * u32::from(u1) + (u32::from(u1) + 1) * 256 + u32::from(u0) >= 1 << 16
}

#[test]
fn recip_is_the_definition() {
    for d in 128u16..256 {
        assert_eq!(u32::from(w8::recip(d as u8)), (65535 / u32::from(d)) - 256);
    }
    for d in [1u64 << 63, (1 << 63) + 1, u64::MAX, u64::MAX - 1, 3 << 62] {
        assert_eq!(u128::from(w64::recip(d)), (u128::MAX / u128::from(d)) - (1u128 << 64), "{d:x}");
    }
}

/// Every normalized d, every u1 < d, every u0: the 2-by-1 is the division,
/// and step 1 wraps exactly where an exhaustive search finds it (10,480 triples on
/// 102 divisors, each with u1 = d - 1).
#[test]
fn div2by1_exhaustive_8() {
    let (mut wrapped, mut divisors) = (0u32, 0u32);
    for d in 128u8..=255 {
        let v = w8::recip(d);
        let mut any = false;
        for u1 in 0..d {
            for u0 in 0..=255u8 {
                let n = u16::from(u1) << 8 | u16::from(u0);
                let want = ((n / u16::from(d)) as u8, (n % u16::from(d)) as u8);
                assert_eq!(w8::div2by1(u1, u0, d, v), want, "{d} {u1} {u0}");
                if wraps8(d, u1, u0) {
                    assert_eq!(u1, d - 1);
                    wrapped += 1;
                    any = true;
                }
            }
        }
        divisors += u32::from(any);
    }
    assert_eq!((wrapped, divisors), (10480, 102));
}

/// The 3-by-2's reciprocal on every 8-bit divisor pair (d1 normalized).
#[test]
fn recip3_exhaustive_8() {
    for d1 in 128u32..256 {
        for d0 in 0u32..256 {
            let want = ((1u32 << 24) - 1) / (d1 * 256 + d0) - 256;
            assert_eq!(u32::from(w8::recip3(d1 as u8, d0 as u8, w8::recip(d1 as u8))), want, "{d1} {d0}");
        }
    }
}

/// Every 8-bit divisor pair, dividends at the edges and seeded: the 3-by-2
/// is floor(U / D) with its remainder; step 4's q1 + 1 wraps (q1 = b - 1
/// after step 1), and step 1's sum stays below b^2.
#[test]
fn div3by2_8() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let (mut cases, mut step4_wraps) = (0u64, 0u64);
    for d1 in 128u8..=255 {
        for d0 in 0u8..=255 {
            let dd = u32::from(d1) << 8 | u32::from(d0);
            let v3 = w8::recip3(d1, d0, w8::recip(d1));
            let r = |rng: &mut Rng| rng.next() as u8;
            let u2s = [0, 1, d1 / 2, d1.saturating_sub(1), d1, r(&mut rng), r(&mut rng) % d1.max(1)];
            for &u2 in &u2s {
                if u2 > d1 {
                    continue;
                }
                for u1 in [0, 1, d0.wrapping_sub(1), d0, d1, 254, 255, r(&mut rng), r(&mut rng)] {
                    if (u2, u1) >= (d1, d0) {
                        continue;
                    }
                    for u0 in [0, 1, 254, 255, r(&mut rng), r(&mut rng)] {
                        let uu = u32::from(u2) << 16 | u32::from(u1) << 8 | u32::from(u0);
                        let (q, r1, r0) = w8::div3by2(u2, u1, u0, d1, d0, v3);
                        assert_eq!((u32::from(q), u32::from(r1) << 8 | u32::from(r0)), (uu / dd, uu % dd), "{u2} {u1} {u0} / {d1} {d0}");
                        let s = u32::from(v3) * u32::from(u2) + (u32::from(u2) << 8 | u32::from(u1));
                        assert!(s < 1 << 16);
                        step4_wraps += u64::from(s >> 8 == 255);
                        cases += 1;
                    }
                }
            }
        }
    }
    assert!(cases > 5_000_000 && step4_wraps > 0, "{cases} {step4_wraps}");
}

/// 16-bit limbs, sampled: both steps against plain division.
#[test]
fn steps_16_sampled() {
    let mut rng = Rng(0x0123_4567_89ab_cdef);
    for _ in 0..2_000_000 {
        let d = (rng.next() as u16) | 0x8000;
        let u1 = (rng.next() as u16) % d;
        let u0 = rng.next() as u16;
        let n = u32::from(u1) << 16 | u32::from(u0);
        assert_eq!(w16::div2by1(u1, u0, d, w16::recip(d)), ((n / u32::from(d)) as u16, (n % u32::from(d)) as u16));
        let (d1, d0) = (d, rng.next() as u16);
        let dd = u64::from(d1) << 16 | u64::from(d0);
        let u2 = (u32::from(rng.next() as u16) % (u32::from(d1) + 1)) as u16;
        let u1 = if u2 == d1 { if d0 == 0 { continue } else { (rng.next() as u16) % d0 } } else { rng.next() as u16 };
        let uu = u64::from(u2) << 32 | u64::from(u1) << 16 | u64::from(u0);
        let v3 = w16::recip3(d1, d0, w16::recip(d1));
        assert_eq!(u64::from(v3), ((1u64 << 48) - 1) / dd - (1 << 16));
        let (q, r1, r0) = w16::div3by2(u2, u1, u0, d1, d0, v3);
        assert_eq!((u64::from(q), u64::from(r1) << 16 | u64::from(r0)), (uu / dd, uu % dd));
    }
}

/// u64: the 2-by-1 against u128 division, at random and at the wrap: with
/// u1 = d - 1 and u0 = b - 1, step 1 wraps for these divisors (found by
/// the same search at u64; at least one must, checked in u128).
#[test]
fn div2by1_64() {
    let mut rng = Rng(42);
    let mut wrapped = 0;
    let mut ds = vec![u64::MAX, u64::MAX - 1, 3 << 62, 9 << 60, (1 << 63) + 1, 1 << 63];
    ds.extend((0..64).map(|_| rng.next() | 1 << 63));
    for &d in &ds {
        let v = w64::recip(d);
        let (u1, u0) = (d - 1, u64::MAX);
        let sum = u128::from(v) * u128::from(u1);
        let step1 = sum.checked_add(u128::from(u1 + 1) << 64).and_then(|s| s.checked_add(u128::from(u0)));
        wrapped += usize::from(step1.is_none());
        let n = u128::from(u1) << 64 | u128::from(u0);
        assert_eq!(w64::div2by1(u1, u0, d, v), ((n / u128::from(d)) as u64, (n % u128::from(d)) as u64), "{d:x}");
    }
    assert!(wrapped >= 3, "{wrapped}");
    for _ in 0..2_000_000 {
        let d = rng.next() | 1 << 63;
        let u1 = rng.next() % d;
        let u0 = rng.next();
        let n = u128::from(u1) << 64 | u128::from(u0);
        assert_eq!(w64::div2by1(u1, u0, d, w64::recip(d)), ((n / u128::from(d)) as u64, (n % u128::from(d)) as u64));
    }
}

/// u64: the 3-by-2 against the definition, checked as q D + r = U and
/// r < D in three-limb arithmetic, at random and with q1 = b - 1 after
/// step 1 (u2 = d1 - 1 high, u1 large); the reciprocal against u128 math.
#[test]
fn div3by2_64() {
    let mut rng = Rng(7);
    let mut step4_wraps = 0;
    for i in 0..2_000_000u32 {
        let d1 = rng.next() | 1 << 63;
        let d0 = rng.next();
        let v3 = w64::recip3(d1, d0, w64::recip(d1));
        // (the top edges: u2 = d1 - 1 with u1 high, and u2 = d1 with u1 < d0)
        let (u2, u1) = match i % 4 {
            0 => (d1 - 1, u64::MAX - (rng.next() >> 40)),
            1 if d0 > 0 => (d1, rng.next() % d0),
            _ => (rng.next() % d1, rng.next()),
        };
        let u0 = rng.next();
        let (q, r1, r0) = w64::div3by2(u2, u1, u0, d1, d0, v3);
        // q (d1, d0) + (r1, r0) == (u2, u1, u0), three limbs
        let lo = u128::from(q) * u128::from(d0) + u128::from(r0);
        let mid = u128::from(q) * u128::from(d1) + (lo >> 64) + u128::from(r1);
        assert_eq!((lo as u64, mid as u64, (mid >> 64) as u64), (u0, u1, u2), "{u2:x} {u1:x} {u0:x} / {d1:x} {d0:x}");
        assert!((r1, r0) < (d1, d0));
        let (p1, p0) = w64::mul(v3, u2);
        let s1 = u128::from(p1) + u128::from(u2) + u128::from(p0.overflowing_add(u1).1);
        assert!(s1 < 1 << 64);
        step4_wraps += u32::from(s1 == u128::from(u64::MAX));
    }
    assert!(step4_wraps > 0, "the q1 + 1 wrap never ran");
    // the reciprocal: (v3 + b) D <= b^3 - 1 < (v3 + b + 1) D, in 4-limb u128 pieces
    for _ in 0..200_000 {
        let (d1, d0) = (rng.next() | 1 << 63, rng.next());
        let v3 = w64::recip3(d1, d0, w64::recip(d1));
        // (v3 + b) (d1 b + d0) = v3 d1 b + v3 d0 + d1 b^2 + d0 b
        let t = |v: u64| -> [u64; 4] {
            let a = u128::from(v) * u128::from(d0);
            let c = u128::from(v) * u128::from(d1);
            let l0 = a as u64;
            let s1 = (a >> 64) + (c as u64 as u128) + u128::from(d0);
            let s2 = (c >> 64) + (s1 >> 64) + u128::from(d1);
            [l0, s1 as u64, s2 as u64, (s2 >> 64) as u64]
        };
        let below = |x: [u64; 4]| x[3] == 0; // < b^3
        assert!(below(t(v3)), "(v3 + b) D <= b^3 - 1");
        if v3 < u64::MAX {
            assert!(!below(t(v3 + 1)), "(v3 + b + 1) D > b^3 - 1");
        }
    }
}

/// The 32-bit-halves product against u128, at random and at the edges (it
/// is the wasm32 product; native tests check it here).
#[test]
fn mul_wide32_is_the_product() {
    let mut rng = Rng(99);
    let edges = [0u64, 1, 0xffff_ffff, 1 << 32, u64::MAX, u64::MAX - 1, 1 << 63, (1 << 63) - 1];
    let check = |a: u64, b: u64| {
        let p = u128::from(a) * u128::from(b);
        assert_eq!(mul_wide32(a, b), ((p >> 64) as u64, p as u64), "{a:x} {b:x}");
        assert_eq!(mul_wide(a, b), ((p >> 64) as u64, p as u64));
    };
    for &a in &edges {
        for &b in &edges {
            check(a, b);
        }
    }
    for _ in 0..1_000_000 {
        check(rng.next(), rng.next());
    }
}
