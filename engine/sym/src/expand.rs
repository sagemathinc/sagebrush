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
