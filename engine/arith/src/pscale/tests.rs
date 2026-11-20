use super::*;
use crate::qpoly::{scan, scan_ints, CAPS};
use dashu_int::{IBig, UBig};

// ---- the reference: exact rationals by the test's own arithmetic ----

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
        assert!(d != UBig::ZERO);
        let g = ugcd(&mag(&n), &d);
        if g == UBig::ZERO || n == IBig::ZERO {
            return Q(IBig::ZERO, UBig::ONE);
        }
        Q(n / IBig::from(g.clone()), d / g)
    }
    fn parse(tok: &str) -> Q {
        let (neg, n, d) = parts(tok);
        let n = IBig::from(UBig::from_str_radix(n, 16).unwrap());
        Q::new(if neg { -n } else { n }, UBig::from_str_radix(d, 16).unwrap())
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

fn coeffs(a: &str) -> Vec<Q> {
    if a.is_empty() {
        return Vec::new();
    }
    a.split(',').map(Q::parse).collect()
}

fn list(v: &[Q]) -> String {
    let mut n = v.len();
    while n > 0 && v[n - 1].0 == IBig::ZERO {
        n -= 1;
    }
    v[..n].iter().map(Q::token).collect::<Vec<_>>().join(",")
}

fn ok(body: &str) -> String {
    format!("{{\"ok\":\"{}\"}}", body)
}

fn want(kind: Kind, a: &str, b: &str) -> String {
    let c = coeffs(a);
    match kind {
        Kind::Scale => {
            let s = Q::parse(b);
            ok(&list(&c.iter().map(|x| x.mul(&s)).collect::<Vec<_>>()))
        }
        Kind::Derivative => {
            let k = usize::from_str_radix(b, 16).unwrap_or(usize::MAX);
            let mut out = Vec::new();
            for (i, x) in c.iter().enumerate().skip(k.min(c.len())) {
                let mut f = UBig::ONE;
                for t in (i + 1 - k)..=i {
                    f *= UBig::from(t as u64);
                }
                out.push(x.mul(&Q::new(IBig::from(f), UBig::ONE)));
            }
            ok(&list(&out))
        }
        Kind::Add | Kind::Sub => {
            let d = coeffs(b);
            let neg = Q::new(-IBig::ONE, UBig::ONE);
            let one = Q::new(IBig::ONE, UBig::ONE);
            let zero = Q::new(IBig::ZERO, UBig::ONE);
            let s = if kind == Kind::Sub { &neg } else { &one };
            let out: Vec<Q> = (0..c.len().max(d.len()))
                .map(|i| {
                    let x = c.get(i).unwrap_or(&zero);
                    let y = d.get(i).unwrap_or(&zero).mul(s);
                    Q::new(&x.0 * IBig::from(y.1.clone()) + &y.0 * IBig::from(x.1.clone()), &x.1 * &y.1)
                })
                .collect();
            ok(&list(&out))
        }
        Kind::Integral => {
            let mut out = vec![Q::parse(b)];
            for (i, x) in c.iter().enumerate() {
                out.push(x.mul(&Q::new(IBig::ONE, UBig::from(i as u64 + 1))));
            }
            ok(&list(&out))
        }
    }
}

fn r_of(a: &str, b: &str) -> u64 {
    (a.len() + b.len() + 40) as u64
}

fn call(kind: Kind, a: &str, b: &str) -> Result<String, String> {
    let fa = scan(a)?;
    let fb = if kind == Kind::Derivative { scan_ints(b)? } else { scan(b)? };
    reply(kind, &fa, &fb, r_of(a, b), &CAPS)
}

fn check(kind: Kind, a: &str, b: &str) {
    assert_eq!(call(kind, a, b).unwrap(), want(kind, a, b), "{:?} a={} b={}", kind, a, b);
}

// ---- random shapes ----

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
    /// A token in lowest terms: numerator up to nb bits, denominator up to
    /// db bits (0: an integer); a quarter of them zero when zeros.
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
    fn poly(&mut self, len: u64, nb: u64, db: u64) -> String {
        (0..len).map(|_| self.token(nb, db, true)).collect::<Vec<_>>().join(",")
    }
}

#[test]
fn scale_derivative_integral_match_the_reference() {
    let mut g = Rng(0x2026_1120);
    for case in 0..400 {
        let len = g.below(40);
        let (nb, db) = (1 + g.below(300), if case % 3 == 0 { 0 } else { g.below(200) });
        let a = g.poly(len, nb, db);
        let (sn, sd) = (1 + g.below(260), if case % 2 == 0 { 0 } else { g.below(140) });
        let s = g.token(sn, sd, false);
        check(Kind::Scale, &a, &s);
        check(Kind::Integral, &a, &g.token(40, 20, true));
        let k = g.below(len + 3);
        check(Kind::Derivative, &a, &format!("{:x}", k));
    }
}

/// The hand rows: zero, constants, s = 0, 1 and -1, trailing zeros in the
/// input, k = 0, k = deg, k > deg, a huge k, the integral of zero, results
/// that stay integral, and tokens not in lowest terms (the right value).
#[test]
fn hand_rows() {
    for (a, s) in [("", "5"), ("0,0", "5"), ("1,2,3", "0"), ("1,-2,0,3/4", "1"), ("1,-2,0,3/4", "-1"), ("0,-1/3,5,0,0", "-1"), ("4,2", "1/2"), ("3,2", "1/2"), ("6/5,-10/3", "-15/4"), ("7", "-7/9"), ("1,0,0", "3"), ("-1,1", "-1/2")] {
        check(Kind::Scale, a, s);
    }
    assert_eq!(call(Kind::Scale, "4,2", "1/2").unwrap(), ok("2,1"));
    assert_eq!(call(Kind::Scale, "3,2", "1/2").unwrap(), ok("3/2,1"));
    assert_eq!(call(Kind::Scale, "0,-1/3,5,0,0", "-1").unwrap(), ok("0,1/3,-5"));
    for (a, k) in [("1,2,3", "0"), ("1,2,3", "2"), ("1,2,3", "3"), ("1,2,3", "4"), ("1,2,3", "fffffff"), ("1,2,3", "10000000"), ("", "1"), ("5", "1"), ("1/2,1/3,1/4,1/5,1/6", "2"), ("0,0,0,0,7/30", "3")] {
        check(Kind::Derivative, a, k);
    }
    for (a, c) in [("", "0"), ("", "-3/7"), ("0,0", "1"), ("1,1,1", "0"), ("3,-2,1/5", "1/2"), ("0,0,0,0,0,6", "0")] {
        check(Kind::Integral, a, c);
    }
    // (not in lowest terms: the right value, possibly not reduced)
    let r = call(Kind::Scale, "2/4,6/9", "3").unwrap();
    let body = &r[7..r.len() - 2];
    let got: Vec<Q> = coeffs(body);
    assert_eq!(got, vec![Q::parse("3/2"), Q::parse("2")]);
    // (b is one token)
    assert!(call(Kind::Scale, "1,2", "1,2").unwrap_err().contains("one token"));
    assert!(call(Kind::Scale, "1,2", "").unwrap_err().contains("one token"));
    assert!(call(Kind::Derivative, "1,2", "-1").is_err());
}

/// The sum and difference against the reference: random operands of unequal
/// lengths (integer-only, shared and coprime denominators, zeros), and the
/// hand rows: f - f is "", the top coefficients cancelling with interior
/// zeros kept, one side zero, equal denominators, a unit denominator, a
/// longer b (its tail's signs flipped for the difference, 0 kept).
#[test]
fn sum_and_difference_match_the_reference() {
    let mut g = Rng(0x5a5a_1120);
    for case in 0..400 {
        let (la, lb) = (g.below(30), g.below(30));
        let (nb, db) = (1 + g.below(250), if case % 3 == 0 { 0 } else { g.below(150) });
        let a = g.poly(la, nb, db);
        let b = if case % 5 == 0 { a.clone() } else { g.poly(lb, nb, db) };
        check(Kind::Add, &a, &b);
        check(Kind::Sub, &a, &b);
    }
    let f = "1/2,0,-3/7,5,0,9/4";
    assert_eq!(call(Kind::Sub, f, f).unwrap(), ok(""));
    // (the top three cancel; the interior zero below them stays)
    assert_eq!(call(Kind::Sub, "1,0,3,4,5,6", "0,0,2,4,5,6").unwrap(), ok("1,0,1"));
    assert_eq!(call(Kind::Add, "1/2,1/3", "-1/2,-1/3").unwrap(), ok(""));
    for (a, b) in [("", "1,2"), ("1,2", ""), ("", ""), ("0,0", "0"), ("1/6,5/6", "1/6,-5/6"), ("1/6,1/10", "1/15,1/14"), ("3,2", "1/2,7/9"), ("1/2", "1,-2,0,3/5"), ("7", "1,0,0,-1"), ("1/4,0", "-1/4")] {
        check(Kind::Add, a, b);
        check(Kind::Sub, a, b);
    }
    assert_eq!(call(Kind::Sub, "7", "1,0,0,-1").unwrap(), ok("6,0,0,1"));
    assert_eq!(call(Kind::Sub, "", "1,0,-2/3").unwrap(), ok("-1,0,2/3"));
    // (hex: 1/6 + 1/21 = 3/14, 1/16 + 1/20 = 9/80)
    assert_eq!(call(Kind::Add, "1/6,1/10", "1/15,1/14").unwrap(), ok("3/e,9/50"));
}

/// The trim runs once, charged one unit a token on the call's meter (in
/// chunks of 4096, each polled): a cancellation that zeros 9,000 of 10,000
/// coefficients keeps 1,000, and the trim alone is exactly 10,000 units.
#[test]
fn trim_is_charged_once_per_token() {
    let a = (0..10_000).map(|i| format!("{:x}/7", i + 1)).collect::<Vec<_>>().join(",");
    let b = (0..10_000).map(|i| if i < 1000 { "0".to_string() } else { format!("{:x}/7", i + 1) }).collect::<Vec<_>>().join(",");
    let (fa, fb) = (scan(&a).unwrap(), scan(&b).unwrap());
    let Ok(Ok(plan)) = admit(Kind::Sub, &fa, &fb, r_of(&a, &b), &CAPS) else { panic!() };
    let led = Words::new(plan.limit);
    let mut m = Meter::new(plan.work);
    let mp = compute(&fa, &fb, &plan, &led, &mut m).unwrap();
    assert_eq!(mp.kept, 1000);
    let before = m.used();
    assert_eq!(trim(&mp, &mut m), Ok(1000));
    assert_eq!(m.used() - before, 10_000, "one unit a token");
    // (and a meter one unit short of the trim refuses inside it)
    let mut short = Meter::new(9_999);
    assert_eq!(trim(&mp, &mut short), Err(DivFault::Work));
}

// ---- the closed forms ----

/// The reply bound: integer arithmetic, checked; at and around powers of 16;
/// None at the limits; and at least the actual reply on the pinned shapes,
/// with the exact pins for a sign, the /1 elision, a denominator, the
/// commas and trailing zeros.
#[test]
fn reply_bounds() {
    // falling_digits(k, n) = ceil(k bitlen(n) / 4)
    for (k, n, d) in [(1u64, 15u64, 1u64), (1, 16, 2), (1, 17, 2), (2, 15, 2), (2, 16, 3), (1, 255, 2), (1, 256, 3), (3, 4095, 9), (3, 4096, 10), (1, 0, 0)] {
        assert_eq!(falling_digits(k, n), Some(d), "({}, {})", k, n);
    }
    assert_eq!(falling_digits(u64::MAX, 2), None);
    assert_eq!(falling_digits(u64::MAX / 64 + 1, u64::MAX), None);
    assert_eq!(reply_bound(Kind::Scale, u64::MAX, 1, "3", 0), None);
    assert_eq!(reply_bound(Kind::Scale, 0, u64::MAX, "3", 0), None);
    assert_eq!(reply_bound(Kind::Derivative, 0, u64::MAX, "1", u64::MAX - 1), None);
    assert_eq!(reply_bound(Kind::Integral, u64::MAX - 5, 1, "1", 0), None);
    // the sum's bound: per pair max(n_a + d_b, n_b + d_a) + 1 + d_a + d_b + 2
    // (a missing denominator counted as "1"), a tail token + 1, commas, 9
    assert_eq!(pair_bound("3", 1, "5", 1), Some(9 + (2 + 1 + 2 + 2)));
    assert_eq!(pair_bound("1/2,7", 2, "-3/4", 1), Some(9 + (2 + 1 + 2 + 2) + (1 + 1) + 1));
    assert_eq!(pair_bound("", 0, "ab", 1), Some(9 + 3));
    for (a, b) in [("1/2,7", "-3/4"), ("ff/7,0,1", "1/ab,2"), ("1/2,1/3", "-1/2,-1/3")] {
        for kind in [Kind::Add, Kind::Sub] {
            let (fa, fb) = (scan(a).unwrap(), scan(b).unwrap());
            let Ok(Ok(plan)) = admit(kind, &fa, &fb, r_of(a, b), &CAPS) else { panic!() };
            assert!(call(kind, a, b).unwrap().len() as u64 <= plan.bound);
        }
    }
    // the exact pins: (shape, its reply, the bound)
    for (kind, a, b, reply, bound) in [
        // a sign gained and a slash: "3" * -1/2 -> "-3/2" (the 1 byte of
        // "3", then s's digits 1 + 1 and 2)
        (Kind::Scale, "3", "-1/2", "-3/2", 9 + 1 + (1 + 1 + 2)),
        // the /1 elision: 4 * 1/2 = 2
        (Kind::Scale, "4", "1/2", "2", 9 + 1 + 4),
        // commas and a zero: "0,5" * 3 = "0,f"
        (Kind::Scale, "0,5", "3", "0,f", 9 + 3 + 2 * (1 + 1 + 2)),
        // trailing zeros dropped before the bound: "5,0,0" * 3 = "f"
        (Kind::Scale, "5,0,0", "3", "f", 9 + 1 + (1 + 1 + 2)),
        // derivative of x^16 (deg 16, k = 1): 16 = "10", F <= 16: 2 digits
        (Kind::Derivative, "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1", "1", "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,10", 9 + 33 + 16 * 2),
        // integral: "0" constant, then 1/1, 1/2
        (Kind::Integral, "1,1", "0", "0,1,1/2", 9 + 1 + 1 + 3 + 2 * 2),
    ] {
        let fa = scan(a).unwrap();
        let fb = if kind == Kind::Derivative { scan_ints(b).unwrap() } else { scan(b).unwrap() };
        let Ok(Ok(plan)) = admit(kind, &fa, &fb, r_of(a, b), &CAPS) else { panic!("{} {}", a, b) };
        assert_eq!(plan.bound, bound as u64, "{:?} {} {}", kind, a, b);
        assert_eq!(call(kind, a, b).unwrap(), ok(reply));
        assert!(ok(reply).len() as u64 <= plan.bound);
    }
}

// ---- the ledger, the meter, the caps ----

/// One computed call on a ledger of `limit` words and a meter of `work`
/// units: the reply's bytes or the fault, the plan, the ledger's high-water
/// and requirement, the units used.
fn run(kind: Kind, a: &str, b: &str, limit: Option<u64>, work: Option<u64>) -> (Result<u64, DivFault>, Plan, u64, u64, u64) {
    let fa = scan(a).unwrap();
    let fb = if kind == Kind::Derivative { scan_ints(b).unwrap() } else { scan(b).unwrap() };
    let Ok(Ok(plan)) = admit(kind, &fa, &fb, r_of(a, b), &CAPS) else { panic!("not computed") };
    let led = Words::new(limit.unwrap_or(plan.limit));
    let mut m = Meter::new(work.unwrap_or(plan.work));
    let out = reply_on(&fa, &fb, &plan, &led, &mut m).map(|s| s.len() as u64);
    assert_eq!(led.live(), 0, "the ledger holds words after the call");
    (out, plan, led.high(), led.required(), m.used())
}

fn shapes() -> Vec<(Kind, String, String)> {
    let mut g = Rng(77);
    let big = |g: &mut Rng, n: u64, nb: u64, db: u64| (0..n).map(|_| g.token(nb, db, false)).collect::<Vec<_>>().join(",");
    vec![
        (Kind::Scale, big(&mut g, 200, 400, 300), g.token(500, 400, false)),
        (Kind::Scale, big(&mut g, 300, 2000, 0), "7/3".to_string()),
        (Kind::Derivative, big(&mut g, 200, 300, 200), "40".to_string()),
        (Kind::Derivative, big(&mut g, 300, 64, 64), "1".to_string()),
        (Kind::Integral, big(&mut g, 300, 300, 300), "-5/7".to_string()),
        (Kind::Add, big(&mut g, 300, 300, 200), big(&mut g, 250, 300, 200)),
        (Kind::Sub, big(&mut g, 200, 200, 0), big(&mut g, 300, 100, 100)),
    ]
}

/// The requirement is exact: at it the call succeeds, one word below it
/// refuses (Memory); the meter's count is exact the same way (Work); the
/// verdict is the same at every limit above.
#[test]
fn ledger_and_meter_are_exact() {
    for (kind, a, b) in shapes() {
        let (out, plan, high, req, used) = run(kind, &a, &b, None, None);
        assert!(out.is_ok(), "{:?}", kind);
        assert!(req <= high && high <= plan.limit);
        assert_eq!(run(kind, &a, &b, Some(req), None).0, out, "{:?}: at the requirement", kind);
        assert_eq!(run(kind, &a, &b, Some(req - 1), None).0, Err(DivFault::Memory), "{:?}: one below", kind);
        assert_eq!(run(kind, &a, &b, None, Some(used)).0, out, "{:?}: at the count", kind);
        assert_eq!(run(kind, &a, &b, None, Some(used - 1)).0, Err(DivFault::Work), "{:?}: one below the count", kind);
        assert_eq!(run(kind, &a, &b, Some(req + 1000), None).3, req, "the requirement is the same at every limit");
    }
}

/// The derivative's largest F_j is the last one (F_j grows with j): a row
/// whose last coefficient is the largest output, its ledger held within the
/// arenas, F and the reply.
#[test]
fn derivative_largest_falling_factorial_is_last() {
    let a = (0..400).map(|i| if i == 399 { "1" } else { "0" }).collect::<Vec<_>>().join(",");
    let (out, _plan, high, _req, _used) = run(Kind::Derivative, &a, "c8", None, None);
    let bytes = out.unwrap();
    // F_199 = 399!/199! has about 1640 bits: the reply holds it in hex
    assert!(bytes > 400 && bytes < 1200, "{}", bytes);
    assert!(high < 2000, "{}", high);
    assert_eq!(call(Kind::Derivative, &a, "c8").unwrap(), want(Kind::Derivative, &a, "c8"));
}

/// Past a cap: a terminal typed refusal naming it, never a partial reply.
#[test]
fn caps_refuse_with_their_names() {
    let a = "1,2,3";
    let fa = scan(a).unwrap();
    let fb = scan("5").unwrap();
    let tiny = qpoly::Caps { int: crate::zmul::Caps { work: 200, ..crate::zmul::CAPS }, reply: CAPS.reply };
    let e = reply(Kind::Scale, &fa, &fb, 60, &tiny).unwrap_err();
    assert!(e.contains("word operations"), "{}", e);
    let small = qpoly::Caps { reply: 12, ..CAPS };
    let e = reply(Kind::Scale, &fa, &fb, 60, &small).unwrap_err();
    assert!(e.contains("reply's bytes"), "{}", e);
    let e = reply(Kind::Scale, &fa, &fb, CAPS.int.request + 1, &CAPS).unwrap_err();
    assert!(e.contains("request's bytes"), "{}", e);
}

/// pscale.rs allocates only through the ledger: no `to_vec`, `vec!`,
/// `clone()` or `with_capacity` in the module, no `Vec::new()`.
#[test]
fn scale_paths_allocate_only_through_the_ledger() {
    let src = include_str!("../pscale.rs");
    let code: Vec<&str> = src.lines().filter(|l| !l.trim_start().starts_with("//")).take_while(|l| !l.starts_with("#[cfg(test)]")).collect();
    for bad in [".to_vec()", "vec![", ".clone()", "Vec::with_capacity", "String::with_capacity", "Vec::new()"] {
        let hits: Vec<&&str> = code.iter().filter(|l| l.contains(bad)).collect();
        assert!(hits.is_empty(), "{}: {:?}", bad, hits);
    }
}
