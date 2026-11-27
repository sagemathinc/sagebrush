//! The series ops against exact big-integer references, their counted work
//! against the admitted bounds on every branch, and the prime table against
//! its generator.  (Sage's values for the same ops: engine/web's fixture.)

use super::*;
use crate::nmod::Primes;
use num_integer::Integer;
use num_traits::{One, Signed, Zero};
use sagebrush_bigint::BigRational;

fn hex(x: &BigInt) -> String {
    if x.is_negative() {
        format!("-{}", (-x).to_str_radix(16))
    } else {
        x.to_str_radix(16)
    }
}

fn csv(v: &[BigInt]) -> String {
    v.iter().map(hex).collect::<Vec<_>>().join(",")
}

fn unhex(t: &str) -> BigInt {
    match t.strip_prefix('-') {
        Some(d) => -BigInt::parse_bytes(d.as_bytes(), 16).unwrap(),
        None => BigInt::parse_bytes(t.as_bytes(), 16).unwrap(),
    }
}

/// The "c" (and "d") strings of a reply object {"c":"..."[,"d":"..."]}.
fn fields(reply: &str) -> (String, Option<String>) {
    let c0 = reply.find("\"c\":\"").expect("c") + 5;
    let c1 = c0 + reply[c0..].find('"').unwrap();
    let d = reply.find("\"d\":\"").map(|i| {
        let d0 = i + 5;
        reply[d0..d0 + reply[d0..].find('"').unwrap()].to_string()
    });
    (reply[c0..c1].to_string(), d)
}

/// The rationals of a reply (reduced tokens "num/den", or raw c and d),
/// checking that reduced tokens are in lowest terms.
fn values(reply: &str) -> Vec<BigRational> {
    let (c, d) = fields(reply);
    if c.is_empty() {
        return vec![];
    }
    let den = d.as_deref().map(unhex);
    c.split(',')
        .map(|t| match (t.split_once('/'), &den) {
            (Some((a, b)), None) => {
                let (a, b) = (unhex(a), unhex(b));
                assert!(b > BigInt::one() && a.gcd(&b).is_one(), "{} is not in lowest terms", t);
                BigRational::new(a, b)
            }
            (None, None) => BigRational::from_integer(unhex(t)),
            (None, Some(d)) => BigRational::new(unhex(t), d.clone()),
            (Some(_), Some(_)) => panic!("a raw reply with a fraction token"),
        })
        .collect()
}

fn trimmed(mut v: Vec<BigRational>) -> Vec<BigRational> {
    while v.last().is_some_and(|x| x.is_zero()) {
        v.pop();
    }
    v
}

/// The reference: (a / da)(b / db) mod q^n, trailing zeros dropped.
fn ref_mul(a: &[BigInt], b: &[BigInt], da: &BigInt, db: &BigInt, n: usize) -> Vec<BigRational> {
    let mut c = vec![BigInt::zero(); n];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            if i + j < n {
                c[i + j] += x * y;
            }
        }
    }
    let d = da * db;
    trimmed(c.into_iter().map(|x| BigRational::new(x, d.clone())).collect())
}

fn ref_pow(a: &[BigInt], k: u64, da: &BigInt, n: usize) -> Vec<BigRational> {
    let base: Vec<BigRational> = a.iter().map(|x| BigRational::new(x.clone(), da.clone())).collect();
    let mut acc = vec![BigRational::one()];
    for _ in 0..k {
        let mut c = vec![BigRational::zero(); n.min(acc.len() + base.len())];
        for (i, x) in acc.iter().enumerate() {
            for (j, y) in base.iter().enumerate() {
                if i + j < c.len() {
                    c[i + j] += x * y;
                }
            }
        }
        acc = c;
    }
    acc.truncate(n);
    trimmed(acc)
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn big(&mut self, bits: u64) -> BigInt {
        let mut x = BigInt::zero();
        for _ in 0..bits.div_ceil(64) {
            x = (x << 64u32) + BigInt::from(self.next());
        }
        x = x >> ((bits.div_ceil(64) * 64 - bits) as u32);
        if self.next() & 1 == 1 {
            -x
        } else {
            x
        }
    }
    fn series(&mut self, len: usize, bits: u64) -> Vec<BigInt> {
        (0..len).map(|_| self.big(bits)).collect()
    }
}

/// Run series_mul through scan, admission and the op; the reply and the
/// admitted bound (asserting the counted work and the reply's length).
fn run_mul(a: &[BigInt], b: &[BigInt], da: Option<&BigInt>, db: Option<&BigInt>, n: usize, raw: bool) -> (String, Admitted) {
    // (inputs longer than n are refused: the callers send at most n)
    let (sa, sb) = (csv(&a[..a.len().min(n)]), csv(&b[..b.len().min(n)]));
    let (sda, sdb) = (da.map(hex), db.map(hex));
    let ca = scan(&sa, n, true).unwrap();
    let cb = scan(&sb, n, true).unwrap();
    let cda = sda.as_deref().map(|s| scan_denominator(s).unwrap());
    let cdb = sdb.as_deref().map(|s| scan_denominator(s).unwrap());
    let adm = mul_admit(&ca, &cb, cda.as_ref(), cdb.as_ref(), n, raw, 0).unwrap();
    counted::take();
    let mut out = String::with_capacity(adm.reply as usize);
    mul(&ca, &cb, cda.as_ref(), cdb.as_ref(), n, raw, &adm, &mut out).unwrap();
    let used = counted::take();
    assert!(used <= adm.work, "series_mul: counted {} > admitted {}", used, adm.work);
    assert!(out.len() as u64 <= adm.reply, "series_mul: a reply of {} bytes, admitted {}", out.len(), adm.reply);
    (out, adm)
}

fn run_pow(a: &[BigInt], k: u64, da: Option<&BigInt>, n: usize, raw: bool) -> (String, Admitted) {
    let sa = csv(&a[..a.len().min(n)]);
    let sda = da.map(hex);
    let ca = scan(&sa, n, true).unwrap();
    let cda = sda.as_deref().map(|s| scan_denominator(s).unwrap());
    let adm = pow_admit(&ca, k, cda.as_ref(), n, raw, 0).unwrap();
    counted::take();
    let mut out = String::with_capacity(adm.reply as usize);
    pow(&ca, k, cda.as_ref(), n, raw, &adm, &mut out).unwrap();
    let used = counted::take();
    assert!(used <= adm.work, "series_pow: counted {} > admitted {}", used, adm.work);
    assert!(out.len() as u64 <= adm.reply, "series_pow: a reply of {} bytes, admitted {}", out.len(), adm.reply);
    (out, adm)
}

#[test]
fn table_matches_the_generator() {
    let gen: Vec<u64> = Primes::ntt().take(NTT_PRIME_ROOTS.len()).collect();
    for (i, &(p, g)) in NTT_PRIME_ROOTS.iter().enumerate() {
        assert_eq!(p, gen[i], "table prime {}", i);
        assert!(p > 1 << 61 && p < 1 << 62 && p % (1 << 32) == 1, "table prime {}: {}", i, p);
        assert_eq!(g, ntt::primitive_root(p), "the root of table prime {}", i);
    }
}

#[test]
fn products_over_z_and_q() {
    let mut r = Rng(0x2545f4914f6cdd1d);
    let one = BigInt::one();
    for &(la, lb, bits, n) in &[(1, 1, 1, 1), (3, 5, 8, 4), (50, 70, 64, 100), (100, 100, 200, 150), (300, 41, 1000, 200), (40, 40, 4096, 60)] {
        let (a, b) = (r.series(la, bits), r.series(lb, bits));
        let (out, _) = run_mul(&a, &b, None, None, n, false);
        assert_eq!(values(&out), ref_mul(&a, &b, &one, &one, n), "Z: {} x {} to {}", la, lb, n);
        let (da, db) = (r.big(bits.min(4000)).abs() + 1u32, r.big(30).abs() + 1u32);
        for raw in [false, true] {
            let (out, _) = run_mul(&a, &b, Some(&da), Some(&db), n, raw);
            assert_eq!(values(&out), ref_mul(&a, &b, &da, &db, n), "Q (raw {}): {} x {} to {}", raw, la, lb, n);
        }
    }
}

#[test]
fn powers_and_their_edges() {
    let mut r = Rng(0x9e3779b97f4a7c15);
    let one = BigInt::one();
    for &(len, bits, k, n) in &[(1, 3, 2, 1), (4, 5, 1, 4), (6, 20, 2, 10), (10, 8, 3, 12), (5, 4, 24, 30), (3, 2, 100, 20)] {
        let a = r.series(len, bits);
        if a.iter().all(|x| x.is_zero()) {
            continue;
        }
        let (out, _) = run_pow(&a, k, None, n, false);
        assert_eq!(values(&out), ref_pow(&a, k, &one, n), "Z: k = {} n = {}", k, n);
        let da = r.big(10).abs() + 1u32;
        let (out, _) = run_pow(&a, k, Some(&da), n, false);
        assert_eq!(values(&out), ref_pow(&a, k, &da, n), "Q: k = {} n = {}", k, n);
    }
    // positive valuation with k v < n: q^2 (3 + ...) cubed
    let mut a = vec![BigInt::zero(), BigInt::zero(), BigInt::from(3)];
    a.extend(r.series(5, 9));
    let (out, _) = run_pow(&a, 3, None, 10, false);
    assert_eq!(values(&out), ref_pow(&a, 3, &one, 10));
}

#[test]
fn sigma_against_divisor_sums() {
    for &(k, n) in &[(0u64, 1usize), (0, 50), (1, 100), (2, 100), (3, 64), (5, 40), (11, 100), (100, 30)] {
        let adm = sigma_admit(k, n, 0).unwrap();
        counted::take();
        let mut out = String::with_capacity(adm.reply as usize);
        sigma(k, n, &adm, &mut out).unwrap();
        let used = counted::take();
        assert!(used <= adm.work, "sigma k = {} n = {}: counted {} > admitted {}", k, n, used, adm.work);
        let got: Vec<BigInt> = out.trim_matches('"').split(',').map(unhex).collect();
        let want: Vec<BigInt> = (1..=n as u64)
            .map(|m| (1..=m).filter(|d| m % d == 0).map(|d| num_traits::pow(BigInt::from(d), k as usize)).sum())
            .collect();
        assert_eq!(got, want, "sigma_{} to {}", k, n);
    }
}

#[test]
fn euler_against_the_product() {
    for n in [0usize, 1, 2, 3, 6, 8, 40, 200] {
        let adm = euler_admit(n, 0).unwrap();
        counted::take();
        let mut out = String::new();
        euler(n, &mut out);
        let used = counted::take();
        assert!(used <= adm.work && out.len() as u64 <= adm.reply, "euler to {}", n);
        // prod (1 - q^m), m < n, mod q^n
        let mut c = vec![0i64; n];
        if n > 0 {
            c[0] = 1;
        }
        for m in 1..n {
            for i in (m..n).rev() {
                c[i] -= c[i - m];
            }
        }
        while c.last() == Some(&0) {
            c.pop();
        }
        let got: Vec<i64> = if out == "\"\"" { vec![] } else { out.trim_matches('"').split(',').map(|t| t.parse().unwrap()).collect() };
        assert_eq!(got, c, "euler to {}", n);
    }
}

#[test]
fn the_worst_gcd_shape() {
    // d: three table primes (the selection must skip them) times a large
    // factor shared with every coefficient (big g_i, real divisions)
    let shared = BigInt::from(NTT_PRIME_ROOTS[5].0) * BigInt::from(1_000_003u64) * BigInt::from(NTT_PRIME_ROOTS[400].0);
    let d = BigInt::from(NTT_PRIME_ROOTS[0].0) * BigInt::from(NTT_PRIME_ROOTS[1].0) * BigInt::from(NTT_PRIME_ROOTS[2].0) * &shared;
    let mut r = Rng(77);
    let a: Vec<BigInt> = (0..20).map(|_| r.big(40) * &shared).collect();
    let b = vec![BigInt::one(), BigInt::from(2)];
    let one = BigInt::one();
    let (out, adm) = run_mul(&a, &b, Some(&d), None, 20, false);
    assert_eq!(values(&out), ref_mul(&a, &b, &d, &one, 20));
    // the selection skipped the table primes dividing d, and no selected
    // prime divides any coefficient's gcd with d
    let sd = hex(&d);
    let dens = [scan_denominator(&sd).unwrap()];
    let (idx, _) = select(adm.primes as usize, &dens.iter().collect::<Vec<_>>()).unwrap();
    for bad in [0, 1, 2, 5] {
        assert!(!idx.contains(&bad), "table prime {} divides d but was selected: {:?}", bad, idx);
    }
    for x in ref_mul(&a, &b, &one, &one, 20) {
        let g = x.numer().gcd(&d);
        assert!(g > one, "the shared factor");
        for &j in &idx {
            assert!(!(&g % BigInt::from(NTT_PRIME_ROOTS[j].0)).is_zero(), "selected prime {} divides a gcd", j);
        }
    }
}

#[test]
fn zero_and_edge_inputs() {
    let z = |n: usize| vec![BigInt::zero(); n];
    let two = BigInt::from(2);
    // all-zero inputs of every length, with and without denominators
    for len in [1, 3] {
        let (out, _) = run_mul(&z(len), &[BigInt::one()], None, None, 4, false);
        assert_eq!(fields(&out).0, "");
        let (out, _) = run_mul(&[BigInt::one()], &z(len), Some(&two), None, 4, false);
        assert_eq!(fields(&out).0, "");
    }
    // scan: grammar refusals
    for bad in ["01", "-0", "1,,2", "1,", "x", "A", "+1", "1 ", ","] {
        assert!(scan(bad, 10, true).is_err(), "{:?} scanned", bad);
    }
    assert!(scan_denominator("0").is_err() && scan_denominator("-3").is_err() && scan_denominator("1,2").is_err());
    assert!(scan("1,2,3", 2, true).is_err());
    let c = scan("0,0,5,0", 4, true).unwrap();
    assert_eq!((c.tokens, c.all_zero, c.valuation, c.max_digits), (4, false, 2, 1));
    assert!(scan("0,0", 4, true).unwrap().all_zero);
    assert!(scan("", 4, true).unwrap().all_zero);
}

#[test]
fn caps_refuse_naming_the_limit() {
    let big = "1".repeat(1025);
    let e = scan(&big, 1, true).unwrap_err();
    assert!(e.contains("1024"), "{}", e);
    // n beta over 2^26: a long series of 4096-bit coefficients
    let tok = "f".repeat(1024);
    let s = vec![tok.as_str(); 2000].join(",");
    let c = scan(&s, 1 << 17, true).unwrap();
    let e = mul_admit(&c, &c, None, None, 1 << 17, false, 0).unwrap_err();
    assert!(e.contains("fewer coefficients per call"), "{}", e);
    let e = sigma_admit(SIGMA_K_MAX + 1, 10, 0).unwrap_err();
    assert!(e.contains(&SIGMA_K_MAX.to_string()), "{}", e);
}

#[test]
fn bounds_never_wrap() {
    assert!(crt_new_work(P_MAX as u64).is_some() && crt_work(P_MAX as u64).is_some());
    assert!(crt_new_work(u64::MAX).is_none() && crt_work(u64::MAX).is_none());
    let t = "f".repeat(1024);
    let s = vec![t.as_str(); 16].join(",");
    let c = scan(&s, 1 << 17, true).unwrap();
    assert!(pow_admit(&c, u64::MAX / 2, None, 1 << 17, false, 0).is_err(), "a huge k was admitted");
    assert!(sigma_admit(SIGMA_K_MAX, SIGMA_N_MAX, 0).is_err(), "sigma's output bits");
}
