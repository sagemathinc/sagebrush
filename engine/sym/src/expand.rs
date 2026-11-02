//! expand: distribute products over sums and expand positive integer powers
//! of sums, everywhere (function arguments too); a negative integer power
//! of a sum becomes 1/(expanded sum).  Like Sage, numerators distribute
//! but denominators stay: (x + 1)/(x - 1) -> x/(x - 1) + 1/(x - 1).

use crate::expr::*;

pub fn expand(e: &Expr) -> Expr {
    sagebrush_interrupt::check();
    let e = map(e, &mut |c| expand(c));
    match &e.kind {
        Kind::Mul(v) => expand_product(v),
        Kind::Pow(b, x) => {
            if let (Kind::Add(_), Some(n)) = (&b.kind, x.as_i64()) {
                if n > 0 {
                    return power_of_sum(b, n as u64);
                }
                if n < 0 {
                    return pow(&power_of_sum(b, (-n) as u64), &int(-1));
                }
            }
            e.clone()
        }
        _ => e.clone(),
    }
}

/// The terms of e as a sum (e itself if not a sum).
fn terms(e: &Expr) -> Vec<Expr> {
    match &e.kind {
        Kind::Add(v) => v.clone(),
        _ => vec![e.clone()],
    }
}

fn expand_product(v: &[Expr]) -> Expr {
    // distribute every sum factor (with a nonnegative exponent)
    let mut acc: Vec<Expr> = vec![one()];
    for f in v {
        // (positive powers of sums were expanded into sums already)
        let ts = terms(f);
        let mut next = Vec::with_capacity(acc.len() * ts.len());
        for a in &acc {
            sagebrush_interrupt::check();
            for t in &ts {
                next.push(mul2(a, t));
            }
        }
        acc = next;
        sagebrush_interrupt::check();
    }
    add(acc)
}

/// (t1 + ... + tk)^n by repeated multiplication.
fn power_of_sum(b: &Expr, n: u64) -> Expr {
    let ts = terms(b);
    let mut acc: Vec<Expr> = vec![one()];
    for _ in 0..n {
        let mut next = Vec::with_capacity(acc.len() * ts.len());
        for a in &acc {
            sagebrush_interrupt::check();
            for t in &ts {
                next.push(expand(&mul2(a, t)));
            }
        }
        // combine like terms as we go
        acc = terms(&add(next));
        sagebrush_interrupt::check();
    }
    add(acc)
}

/// expand_bounded's refusal: the prospective length that exceeded the cap.
#[derive(Clone, Debug, PartialEq)]
pub struct BoundExceeded {
    pub projected: u128,
}

#[cfg(test)]
thread_local! {
    /// (tests) every guarded allocation site expand_bounded reaches: (site, prospective length)
    pub(crate) static OBSERVED: std::cell::RefCell<Vec<(&'static str, u128)>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[inline]
fn observe(_site: &'static str, _len: u128) {
    #[cfg(test)]
    OBSERVED.with(|o| o.borrow_mut().push((_site, _len)));
}

/// expand, with every vector it would build checked BEFORE it is allocated: the
/// product step (acc x terms), each power step (acc x terms) and each clone of a
/// sum's terms; a prospective length over cap refuses with BoundExceeded and
/// nothing past the check is allocated.  Same algorithm and result as expand
/// otherwise (expand itself is unchanged).  It returns its refusal instead of
/// unwinding: in WebAssembly a panic aborts.
pub fn expand_bounded(e: &Expr, cap: usize) -> Result<Expr, BoundExceeded> {
    sagebrush_interrupt::check();
    let mut err = None;
    let e = map(e, &mut |c| {
        if err.is_some() {
            return c.clone();
        }
        match expand_bounded(c, cap) {
            Ok(x) => x,
            Err(b) => {
                err = Some(b);
                c.clone()
            }
        }
    });
    if let Some(b) = err {
        return Err(b);
    }
    match &e.kind {
        Kind::Mul(v) => expand_product_bounded(v, cap),
        Kind::Pow(b, x) => {
            if let (Kind::Add(_), Some(n)) = (&b.kind, x.as_i64()) {
                if n > 0 {
                    return power_of_sum_bounded(b, n as u64, cap);
                }
                if n < 0 {
                    return Ok(pow(&power_of_sum_bounded(b, (-n) as u64, cap)?, &int(-1)));
                }
            }
            Ok(e.clone())
        }
        _ => Ok(e.clone()),
    }
}

fn terms_bounded(e: &Expr, cap: usize) -> Result<Vec<Expr>, BoundExceeded> {
    match &e.kind {
        Kind::Add(v) => {
            if v.len() > cap {
                return Err(BoundExceeded { projected: v.len() as u128 });
            }
            observe("clone", v.len() as u128);
            Ok(v.clone())
        }
        _ => Ok(vec![e.clone()]),
    }
}

fn prospective(acc: usize, ts: usize, cap: usize) -> Result<usize, BoundExceeded> {
    let p = acc as u128 * ts as u128;
    if p > cap as u128 {
        return Err(BoundExceeded { projected: p });
    }
    Ok(p as usize)
}

fn expand_product_bounded(v: &[Expr], cap: usize) -> Result<Expr, BoundExceeded> {
    let mut acc: Vec<Expr> = vec![one()];
    for f in v {
        let ts = terms_bounded(f, cap)?;
        let p = prospective(acc.len(), ts.len(), cap)?;
        observe("product", p as u128);
        let mut next = Vec::with_capacity(p);
        for a in &acc {
            sagebrush_interrupt::check();
            for t in &ts {
                next.push(mul2(a, t));
            }
        }
        acc = next;
        sagebrush_interrupt::check();
    }
    Ok(add(acc))
}

fn power_of_sum_bounded(b: &Expr, n: u64, cap: usize) -> Result<Expr, BoundExceeded> {
    let ts = terms_bounded(b, cap)?;
    let mut acc: Vec<Expr> = vec![one()];
    for _ in 0..n {
        let p = prospective(acc.len(), ts.len(), cap)?;
        observe("power", p as u128);
        let mut next = Vec::with_capacity(p);
        for a in &acc {
            sagebrush_interrupt::check();
            for t in &ts {
                next.push(expand_bounded(&mul2(a, t), cap)?);
            }
        }
        // combine like terms as we go
        acc = terms_bounded(&add(next), cap)?;
        sagebrush_interrupt::check();
    }
    Ok(add(acc))
}

#[cfg(test)]
mod expand_bounded_tests {
    //! Lane 4b-2: expand_bounded refuses a prospective vector over the cap BEFORE allocating it.
    use super::*;
    use crate::parse::parse;

    fn sum_of(prefix: &str, k: usize) -> Expr {
        add((0..k).map(|i| sym(&format!("{}{}", prefix, i))).collect())
    }

    fn nterms(e: &Expr) -> usize {
        match &e.kind {
            Kind::Add(v) => v.len(),
            _ => 1,
        }
    }

    fn run(e: &Expr, cap: usize) -> (Result<Expr, BoundExceeded>, Vec<(&'static str, u128)>) {
        OBSERVED.with(|o| o.borrow_mut().clear());
        let r = expand_bounded(e, cap);
        (r, OBSERVED.with(|o| o.borrow().clone()))
    }

    #[test]
    fn same_result_as_expand_under_a_large_cap() {
        for s in ["(x + 1)^5", "(a + b)*(c + d)*(a - b)", "sin((x + y)^3) + 1/(x - 1)^2", "(x + 1)/(x - 1)", "((a + b)*(c + d))^3", "x^2*(y - 1/x)", "exp((a + b)^2)*(a + 1)"] {
            let e = parse(s);
            assert_eq!(expand_bounded(&e, 1_000_000).unwrap(), expand(&e), "{}", s);
        }
    }

    #[test]
    fn a_product_over_the_cap_is_refused_before_its_vector_is_allocated() {
        // two sums of 300 distinct terms: each clone is admitted, the product's 90,000 is not
        let e = mul2(&sum_of("p", 300), &sum_of("q", 300));
        let (r, ev) = run(&e, 50_000);
        assert_eq!(r, Err(BoundExceeded { projected: 90_000 }));
        assert!(!ev.iter().any(|&(s, n)| s == "product" && n == 90_000), "{:?}", ev);
        assert!(ev.iter().all(|&(_, n)| n <= 50_000), "{:?}", ev);
    }

    #[test]
    fn a_power_step_over_the_cap_is_refused_before_its_vector_is_allocated() {
        // (300 terms)^2: step 2's prospective vector is 300*300 = 90,000 (its combined count would be 45,150)
        let e = pow(&sum_of("p", 300), &int(2));
        let (r, ev) = run(&e, 50_000);
        assert_eq!(r, Err(BoundExceeded { projected: 90_000 }));
        assert!(!ev.iter().any(|&(s, n)| s == "power" && n == 90_000), "{:?}", ev);
        assert!(ev.contains(&("power", 300)), "{:?}", ev);
    }

    #[test]
    fn exactly_at_the_cap_is_admitted_and_one_over_is_refused() {
        let at = mul2(&sum_of("p", 2), &sum_of("q", 25_000));
        let (r, ev) = run(&at, 50_000);
        assert_eq!(r.map(|x| nterms(&x)), Ok(50_000));
        assert!(ev.contains(&("product", 50_000)), "{:?}", ev.iter().filter(|e| e.0 == "product").collect::<Vec<_>>());
        let over = mul2(&sum_of("p", 3), &sum_of("q", 16_667));
        let (r, ev) = run(&over, 50_000);
        assert_eq!(r, Err(BoundExceeded { projected: 50_001 }));
        assert!(!ev.iter().any(|&(s, n)| s == "product" && n == 50_001), "the refused product reached its allocation: {:?}", ev.iter().filter(|e| e.0 == "product").collect::<Vec<_>>());
        assert!(ev.iter().all(|&(_, n)| n <= 50_000));
    }

    #[test]
    fn an_operand_over_the_cap_is_refused_at_its_clone() {
        let e = mul2(&sum_of("p", 50_001), &sym("y"));
        let (r, ev) = run(&e, 50_000);
        assert_eq!(r, Err(BoundExceeded { projected: 50_001 }));
        assert!(!ev.iter().any(|&(s, n)| s == "clone" && n == 50_001), "{:?}", ev.len());
    }

    #[test]
    fn the_witnesses_refuse_at_their_prospective_step_small_cap() {
        // the frozen pairs' shapes at cap 60 (the full-size pairs are calibration rows):
        // (u+v+w)^m: step m's prospective = 3*C(m+1, 2); m = 5 -> 45, m = 6 -> 63
        assert!(expand_bounded(&parse("(u + v + w)^5"), 60).is_ok());
        assert_eq!(expand_bounded(&parse("(u + v + w)^6"), 60), Err(BoundExceeded { projected: 63 }));
        // inside a function argument and a denominator: (a+b)^m's step m is 2*m
        assert!(expand_bounded(&parse("sin((a + b)^30)"), 60).is_ok());
        assert_eq!(expand_bounded(&parse("sin((a + b)^31)"), 60), Err(BoundExceeded { projected: 62 }));
        assert!(expand_bounded(&parse("1/(a + b)^30"), 60).is_ok());
        assert_eq!(expand_bounded(&parse("1/(a + b)^31"), 60), Err(BoundExceeded { projected: 62 }));
    }

    #[test]
    fn the_api_op_returns_its_refusal_without_unwinding() {
        let e = crate::api::encode(&parse("(u + v + w)^6"));
        assert_eq!(crate::api::call(&format!("expand_bounded\x1f{}\x1f60", e)), "err\x1fBoundExceeded\x1f63");
        let ok = crate::api::call(&format!("expand_bounded\x1f{}\x1f1000", e));
        assert_eq!(ok, format!("ok\x1f{}", crate::api::encode(&expand(&parse("(u + v + w)^6")))));
    }
}
