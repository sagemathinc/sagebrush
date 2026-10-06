//! Fixed-point real numbers to any precision: an integer x stands for
//! x / 2^prec.  Just what regulators need: square roots and logarithms,
//! exact addition and multiplication by integers, and a gcd of reals.

use num_bigint::{BigInt, Sign};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};

/// floor(sqrt(n) 2^prec) for n >= 0.
pub fn sqrt_fixed(n: &BigInt, prec: u32) -> BigInt {
    (n << (2 * prec as usize)).sqrt()
}

/// atanh(1/k) 2^prec for an integer k >= 2 (series in 1/k^2).
fn atanh_inv(k: u64, prec: u32) -> BigInt {
    let guard = 16;
    let p = prec as usize + guard;
    let k2 = BigInt::from(k) * BigInt::from(k);
    let mut power = (BigInt::one() << p) / BigInt::from(k); // 1/k^(2j+1)
    let mut sum = BigInt::zero();
    let mut j = 0u64;
    while !power.is_zero() {
        sum += &power / BigInt::from(2 * j + 1);
        power /= &k2;
        j += 1;
    }
    sum >> guard
}

/// ln 2 * 2^prec, cached for the largest precision asked so far.
pub fn ln2(prec: u32) -> BigInt {
    use std::sync::Mutex;
    static CACHE: Mutex<Option<(u32, BigInt)>> = Mutex::new(None);
    let mut c = CACHE.lock().unwrap();
    if let Some((p, v)) = c.as_ref() {
        if *p >= prec {
            return v >> (*p - prec) as usize;
        }
    }
    // ln 2 = 2 atanh(1/3)
    let v = atanh_inv(3, prec + 8) << 1usize >> 8usize;
    *c = Some((prec, v.clone()));
    v
}

/// 2 atanh(u) 2^p = ln((1 + u)/(1 - u)) 2^p for a small fixed-point u.
fn two_atanh(u: &BigInt, p: u32) -> BigInt {
    let u2 = (u * u) >> p as usize;
    let mut term = u.clone();
    let mut sum = BigInt::zero();
    let mut j = 0u64;
    while !term.is_zero() {
        sum += &term / BigInt::from(2 * j + 1);
        term = (&term * &u2) >> p as usize;
        j += 1;
    }
    sum << 1usize
}

/// Tables for argument reduction at working precision p: ln(1 + j/2^8)
/// and ln(1 + j/2^16), j < 256 (fixed point, 2^p).
struct LnTables {
    p: u32,
    t8: Vec<BigInt>,
    t16: Vec<BigInt>,
}

fn ln_tables(p: u32) -> std::sync::Arc<LnTables> {
    use std::sync::{Arc, Mutex};
    static CACHE: Mutex<Option<Arc<LnTables>>> = Mutex::new(None);
    let mut c = CACHE.lock().unwrap();
    if let Some(t) = c.as_ref() {
        if t.p >= p {
            return t.clone();
        }
    }
    // ln(1 + j/2^k) = 2 atanh(j / (2^(k+1) + j)); the 2^8 table by halving
    // twice more first (ln(1 + x) = 2 ln sqrt(1 + x)) keeps u below 2^-10
    let q = p + 16;
    let one = BigInt::one() << q as usize;
    let mut t8 = vec![];
    for j in 0..256u64 {
        let x = &one + ((BigInt::from(j) << q as usize) >> 8usize); // 1 + j/256
        let s = (((&x << q as usize).sqrt()) << q as usize).sqrt(); // x^(1/4)
        let u = ((&s - &one) << q as usize) / (&s + &one);
        t8.push((two_atanh(&u, q) << 2usize) >> 16usize);
    }
    let t16 = (0..256u64)
        .map(|j| {
            let u = (BigInt::from(j) << q as usize) / BigInt::from((1u64 << 17) + j);
            two_atanh(&u, q) >> 16usize
        })
        .collect();
    let t = Arc::new(LnTables { p, t8, t16 });
    *c = Some(t.clone());
    t
}

/// ln(x / 2^prec) 2^prec for x > 0 (absolute error a few units of 2^-prec).
pub fn ln_fixed(x: &BigInt, prec: u32) -> BigInt {
    assert!(x.is_positive());
    let guard = 24u32;
    let p = prec + guard;
    let tables = ln_tables(p);
    let tp = tables.p;
    // x = 2^e m with m / 2^p in [1, 2)
    let e = x.bits() as i64 - 1 - prec as i64;
    let mut m = if e >= 0 { (x << guard as usize) >> e as usize } else { x << (guard as i64 - e) as usize };
    let mut acc = BigInt::zero(); // ln of the factors divided out, at precision tp
    // divide by 1 + j/2^8, then by 1 + j/2^16: m in [1, 1 + 2^-16)
    for (k, table) in [(8u32, &tables.t8), (16u32, &tables.t16)] {
        let j = ((&m >> (p - k) as usize) - (BigInt::one() << k as usize)).to_u64().unwrap() as usize;
        let j = j.min(255);
        if j > 0 {
            let f = (BigInt::from((1u64 << k) + j as u64)) << (p - k) as usize; // (1 + j/2^k) 2^p
            m = (m << p as usize) / f;
            acc += &table[j];
        }
    }
    let one = BigInt::one() << p as usize;
    let u = ((&m - &one) << p as usize) / (&m + &one);
    let ln_m = two_atanh(&u, p) + (acc >> (tp - p) as usize);
    (ln2(prec) * BigInt::from(e)) + (ln_m >> guard as usize)
}

/// ln(n) 2^prec for an integer n > 0.
pub fn ln_int(n: &BigInt, prec: u32) -> BigInt {
    ln_fixed(&(n << prec as usize), prec)
}

/// The value as an f64.
pub fn to_f64(x: &BigInt, prec: u32) -> f64 {
    let b = x.bits() as i64;
    if b <= 1000 {
        x.to_f64().unwrap() / 2f64.powi(prec as i32)
    } else {
        let s = (b - 60) as usize;
        (x >> s).to_f64().unwrap() * 2f64.powi(s as i32 - prec as i32)
    }
}

/// The gcd of reals that are integer multiples of an unknown u, given as
/// fixed-point integers each within `err` of the truth: for each x the
/// reduced fraction h/k = x/g is identified by the continued fraction of
/// x/g (the integer Euclid on x and g), at the first convergent with
/// |x k - h g| <= 2 (h + k) err; then gcd = g/k.  Values within 4 err of 0
/// are skipped.  This needs a relative precision of about 2 log2(x/u) bits
/// and no error compounds (each step divides g exactly by an integer).
/// None if a fraction cannot be identified (precision too low).
pub fn real_gcd(xs: &[BigInt], err: &BigInt) -> Option<BigInt> {
    let mut g: Option<BigInt> = None;
    for x in xs {
        let x = x.abs();
        if x <= err * 4 {
            continue;
        }
        let Some(gv) = g.as_ref() else {
            g = Some(x);
            continue;
        };
        // convergents h/k of x / gv
        let (mut a, mut b) = (x.clone(), gv.clone());
        let (mut h1, mut h2) = (BigInt::one(), BigInt::zero());
        let (mut k1, mut k2) = (BigInt::zero(), BigInt::one());
        let mut found = None;
        while !b.is_zero() {
            let (t, r) = a.div_mod_floor(&b);
            let h = &t * &h1 + &h2;
            let k = &t * &k1 + &k2;
            if (&x * &k - &h * gv).abs() <= (&h + &k) * err * 2 {
                found = Some(k);
                break;
            }
            (h2, h1) = (h1, h);
            (k2, k1) = (k1, k);
            (a, b) = (b, r);
        }
        let k = found?;
        let half = &k >> 1usize;
        g = Some((gv + half) / k);
    }
    g
}

/// The sign of x as -1, 0, 1.
pub fn sign(x: &BigInt) -> i32 {
    match x.sign() {
        Sign::Minus => -1,
        Sign::NoSign => 0,
        Sign::Plus => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_and_roots() {
        let prec = 300;
        // ln 2, ln 10, ln 3 against their decimal expansions (40 digits)
        let close = |x: &BigInt, digits: &str| {
            let want: BigInt = digits.replace('.', "").parse().unwrap();
            let scale = BigInt::from(10).pow(40);
            let got = (x * &scale) >> prec as usize;
            assert!((got - want).abs() <= BigInt::from(2), "{}", digits);
        };
        close(&ln2(prec), "0.6931471805599453094172321214581765680755");
        close(&ln_int(&BigInt::from(10), prec), "2.3025850929940456840179914546843642076011");
        close(&ln_int(&BigInt::from(3), prec), "1.0986122886681096913952452369225257046475");
        // ln(a b) = ln a + ln b for large integers, to the last bits
        let a: BigInt = "123456789012345678901234567890123".parse().unwrap();
        let b: BigInt = "98765432109876543210".parse().unwrap();
        let lhs = ln_int(&(&a * &b), prec);
        let rhs = ln_int(&a, prec) + ln_int(&b, prec);
        assert!((lhs - rhs).abs() < BigInt::from(64));
        // and at high precision, through both reduction tables
        let hp = 2000;
        let a2: BigInt = BigInt::from(3).pow(700) + 12345;
        let b2: BigInt = BigInt::from(7).pow(300) - 1;
        let lhs = ln_int(&(&a2 * &b2), hp);
        let rhs = ln_int(&a2, hp) + ln_int(&b2, hp);
        assert!((lhs - rhs).abs() < BigInt::from(64));
        assert!((ln_int(&BigInt::from(1u64 << 40), hp) - ln2(hp) * BigInt::from(40)).abs() < BigInt::from(64));
        // ln of a number below 1
        let half = BigInt::one() << (prec as usize - 1);
        assert!((ln_fixed(&half, prec) + ln2(prec)).abs() < BigInt::from(64));
        // sqrt
        let s = sqrt_fixed(&BigInt::from(2), prec);
        assert!((&s * &s - (BigInt::from(2) << (2 * prec as usize))).abs() < (BigInt::from(4) << prec as usize));
        // real gcd: 7 r and 12 r give r
        let r = ln_int(&BigInt::from(5), prec);
        let g = real_gcd(&[&r * 7, &r * 12], &BigInt::from(16)).unwrap();
        assert!((g - &r).abs() < BigInt::from(1000));
        // large multiples (a real quadratic regulator at 10^27)
        let prec = 252;
        let two_r: BigInt = (BigInt::from(11329441556881u64) << prec as usize) + (BigInt::one() << 200usize);
        let ms = ["3433486612458768838721", "959559234839210419909", "-1345231017780547108151", "2680223764350793512599", "1152570258436487336845", "60867858548463913617"];
        let xs: Vec<BigInt> = ms.iter().map(|m| m.parse::<BigInt>().unwrap() * &two_r).collect();
        let g = real_gcd(&xs, &BigInt::from(16)).unwrap();
        assert_eq!(g, two_r, "{}", to_f64(&g, prec));
    }
}
