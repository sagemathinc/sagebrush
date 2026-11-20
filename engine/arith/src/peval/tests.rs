use super::*;
use crate::qpoly::{scan, CAPS};
use dashu_int::{IBig, UBig};

fn ugcd(a: &UBig, b: &UBig) -> UBig {
    let (mut p, mut q) = (a.clone(), b.clone());
    while q != UBig::ZERO {
        let r = &p % &q;
        (p, q) = (q, r);
    }
    p
}

fn mag(n: &IBig) -> UBig {
    UBig::try_from(if *n < IBig::ZERO { -n.clone() } else { n.clone() }).unwrap()
}

/// A rational n/d (d > 0) in lowest terms.
#[derive(Clone, Debug, PartialEq)]
struct Q(IBig, UBig);

impl Q {
    fn new(n: IBig, d: UBig) -> Q {
        if n == IBig::ZERO {
            return Q(IBig::ZERO, UBig::ONE);
        }
        let g = ugcd(&mag(&n), &d);
        Q(n / IBig::from(g.clone()), d / g)
    }
    fn parse(tok: &str) -> Q {
        let (neg, n, d) = parts(tok);
        let n = IBig::from(UBig::from_str_radix(n, 16).unwrap());
        Q::new(if neg { -n } else { n }, UBig::from_str_radix(d, 16).unwrap())
    }
    fn add(&self, o: &Q) -> Q {
        Q::new(&self.0 * IBig::from(o.1.clone()) + &o.0 * IBig::from(self.1.clone()), &self.1 * &o.1)
    }
    fn mul(&self, o: &Q) -> Q {
        Q::new(&self.0 * &o.0, &self.1 * &o.1)
    }
    fn token(&self) -> String {
        let n = if self.0 < IBig::ZERO { format!("-{:x}", mag(&self.0)) } else { format!("{:x}", self.0) };
        if self.1 == UBig::ONE || self.0 == IBig::ZERO {
            n
        } else {
            format!("{}/{:x}", n, self.1)
        }
    }
}

/// a(v) by the test's own rational Horner.
fn want(a: &str, v: &str) -> String {
    let v = Q::parse(v);
    let mut r = Q::new(IBig::ZERO, UBig::ONE);
    if !a.is_empty() {
        for tok in a.split(',').rev() {
            r = r.mul(&v).add(&Q::parse(tok));
        }
    }
    format!("{{\"ok\":\"{}\"}}", r.token())
}

fn r_of(a: &str, b: &str) -> u64 {
    (a.len() + b.len() + 40) as u64
}

fn call(a: &str, v: &str) -> Result<String, String> {
    reply(&scan(a)?, &scan(v)?, r_of(a, v), &CAPS)
}

fn check(a: &str, v: &str) {
    assert_eq!(call(a, v).unwrap(), want(a, v), "a={} v={}", a, v);
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    fn ubig(&mut self, bits: u64) -> UBig {
        let mut v = UBig::ZERO;
        for _ in 0..bits.div_ceil(64) {
            v = (v << 64) + UBig::from(self.next());
        }
        v >> (bits.div_ceil(64) * 64 - bits) as usize
    }
    fn token(&mut self, nb: u64, db: u64, zeros: bool) -> String {
        if zeros && self.below(4) == 0 {
            return "0".to_string();
        }
        let bits = 1 + self.below(nb.max(1));
        let n = self.ubig(bits) + UBig::ONE;
        let d = if db == 0 {
            UBig::ONE
        } else {
            let bits = 1 + self.below(db);
            self.ubig(bits) + UBig::ONE
        };
        let neg = self.below(2) == 0;
        Q::new(if neg { -IBig::from(n) } else { IBig::from(n) }, d).token()
    }
}

/// a(v) against the reference: random polynomials (integer and rational,
/// zeros, trailing zeros) at random points (integer and rational, one and
/// several limbs, negative).
#[test]
fn eval_matches_the_reference() {
    let mut g = Rng(0x2026_1120_0e7a);
    for case in 0..400 {
        let len = g.below(24);
        let (nb, db) = (1 + g.below(200), if case % 3 == 0 { 0 } else { g.below(120) });
        let mut a = (0..len).map(|_| g.token(nb, db, true)).collect::<Vec<_>>();
        if case % 7 == 0 {
            a.push("0".to_string());
        }
        let a = a.join(",");
        let (vn, vd) = (1 + g.below(150), if case % 2 == 0 { 0 } else { g.below(130) });
        let v = g.token(vn, vd, false);
        check(&a, &v);
    }
}

/// The hand rows: the zero polynomial, constants, v = 0 (a_0's token, as
/// given), v = 1 and -1, an integer v, denominators sharing v's primes, and
/// both branches of the final reduction: c = gcd(A_n, q) = 1 (x^2 + 1 at
/// 1/3) and c > 1 (3x^2 + 2x + 1 at 1/3: A_n = 3 shares q's 3).
#[test]
fn hand_rows() {
    for (a, v) in [("", "5"), ("0,0", "1/2"), ("7", "1/3"), ("-1/2", "9"), ("1/2,3,5", "0"), ("1,2,3", "1"), ("1,2,3", "-1"), ("1,0,1", "2"), ("1/3,1/9,1/27", "1/3"), ("1/6,0,5/4", "-2/3"), ("1,0,1", "1/3"), ("1,2,3", "1/3"), ("1,2,3,0,0", "1/3")] {
        check(a, v);
    }
    // (c = 1: x^2 + 1 at 1/3 reduces by gcd(S, D) only; c = 3: 3x^2 + 2x + 1
    // at 1/3 = 2 needs the general gcd(S, D q^n))
    assert_eq!(call("1,0,1", "1/3").unwrap(), "{\"ok\":\"a/9\"}");
    assert_eq!(BY_D.with(|b| b.get()), Some(true));
    assert_eq!(call("1,2,3", "1/3").unwrap(), "{\"ok\":\"2\"}");
    assert_eq!(BY_D.with(|b| b.get()), Some(false));
    // (D and q sharing a prime with c = 1: (1/3)x^2 + 1 at 1/3, D = 3)
    assert_eq!(call("1,0,1/3", "1/3").unwrap(), want("1,0,1/3", "1/3"));
    assert_eq!(BY_D.with(|b| b.get()), Some(true));
    assert_eq!(call("1/2,3,5", "0").unwrap(), "{\"ok\":\"1/2\"}");
    assert_eq!(call("", "5").unwrap(), "{\"ok\":\"0\"}");
    assert!(call("1,2", "1,2").unwrap_err().contains("one token"));
}

/// The reply bound: integer arithmetic, None at the limits, and the reply
/// within it (checked in reply_on as an invariant too).
#[test]
fn reply_bounds() {
    // (D = 1, numerators of 4 bits, n = 2, p and q of 4 bits: S below
    // 2^(0 + 4 + 2 * 4 + 2), the denominator below 2^(0 + 2 * 4))
    assert_eq!(reply_bound(0, 4, 2, 4, 4), Some(9 + 2 + 14u64.div_ceil(4) + 8u64.div_ceil(4)));
    assert_eq!(reply_bound(u64::MAX, 1, 1, 1, 1), None);
    assert_eq!(reply_bound(0, 0, u64::MAX, 2, 2), None);
    assert_eq!(reply_bound(0, 0, u64::MAX, 0, 0), None);
}

/// One call after the lcm on a ledger of `limit` words and a meter of
/// `work` units: the reply's bytes or the fault, the requirement, the units
/// used.
fn run(a: &str, v: &str, limit: Option<u64>, work: Option<u64>) -> (Result<u64, DivFault>, u64, u64) {
    let (fa, fb) = (scan(a).unwrap(), scan(v).unwrap());
    let r = r_of(a, v);
    let Ok(Ok(plan)) = admit(&fa, &fb, r, &CAPS) else { panic!("short") };
    let mut m = Meter::new(work.unwrap_or(plan.work));
    let d = clear(&fa, &plan, &mut m).unwrap();
    let (bound, _fixed, lim) = admit_b(&fa, &fb, &d, &plan, r, &CAPS).unwrap();
    let led = Words::new(limit.unwrap_or(lim));
    let out = reply_on(&fa, &fb, &d, &plan, bound, &led, &mut m).map(|s| s.len() as u64);
    assert_eq!(led.live(), 0, "the ledger holds words after the call");
    (out, led.required(), m.used())
}

/// The requirement and the meter are exact: at them the call succeeds, one
/// below refuses.
#[test]
fn ledger_and_meter_are_exact() {
    let mut g = Rng(31);
    let a = (0..300).map(|_| g.token(200, 120, true)).collect::<Vec<_>>().join(",");
    for v in ["-7/3", "1/1000000000000000000000000000001", "e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7/5"] {
        let (out, req, used) = run(&a, v, None, None);
        assert!(out.is_ok(), "{}", v);
        assert_eq!(run(&a, v, Some(req), None).0, out);
        assert_eq!(run(&a, v, Some(req - 1), None).0, Err(DivFault::Memory));
        assert_eq!(run(&a, v, None, Some(used)).0, out);
        assert_eq!(run(&a, v, None, Some(used - 1)).0, Err(DivFault::Work));
    }
}

/// peval.rs allocates only through the ledger (the lcm's row is
/// qpoly_clear's, admitted in closed form): no `to_vec`, `vec!`, `clone()`,
/// `with_capacity` or `Vec::new()`.
#[test]
fn eval_paths_allocate_only_through_the_ledger() {
    let src = include_str!("../peval.rs");
    let code: Vec<&str> = src.lines().filter(|l| !l.trim_start().starts_with("//")).take_while(|l| !l.starts_with("#[cfg(test)]")).collect();
    for bad in [".to_vec()", "vec![", ".clone()", "Vec::with_capacity", "String::with_capacity", "Vec::new()"] {
        let hits: Vec<&&str> = code.iter().filter(|l| l.contains(bad)).collect();
        assert!(hits.is_empty(), "{}: {:?}", bad, hits);
    }
}
