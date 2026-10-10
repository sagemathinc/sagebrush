//! Truncated Laurent series in one variable with symbolic coefficients:
//! Sage's taylor(f, x, a, n), and the expansions limits are read from.
//!
//! A series is t^v (c_0 + c_1 t + ... + c_{m-1} t^{m-1} + O(t^m)).
//! Functions compose through their Taylor expansion at the constant term
//! (derivatives from diff.rs), so every differentiable function works.

use crate::diff::{depends, diff};
use crate::err::{SymError, R};
use crate::expr::*;
use crate::simplify::simplify_rational;

#[derive(Clone, Debug)]
pub struct Series {
    /// valuation
    pub v: i64,
    /// coefficients of t^v, t^(v+1), ...; the precision is v + c.len()
    pub c: Vec<Expr>,
}

fn clean(e: &Expr) -> Expr {
    // keep coefficients small: rational simplification when they mix sums
    if matches!(e.kind, Kind::Add(_) | Kind::Mul(_)) && free_symbols(e).len() <= 3 {
        simplify_rational(e)
    } else {
        e.clone()
    }
}

impl Series {
    pub fn prec(&self) -> i64 {
        self.v + self.c.len() as i64
    }

    fn constant(e: &Expr, prec: i64) -> Series {
        let n = prec.max(1) as usize;
        let mut c = vec![zero(); n];
        c[0] = e.clone();
        Series { v: 0, c }.normalize()
    }

    /// Drop leading zero coefficients (raising the valuation).
    fn normalize(mut self) -> Series {
        let mut k = 0;
        while k < self.c.len() && self.c[k].is_zero() {
            k += 1;
        }
        if k == self.c.len() {
            // zero to this precision
            let p = self.prec();
            return Series { v: p, c: vec![] };
        }
        self.c.drain(..k);
        self.v += k as i64;
        self
    }

    fn coeff(&self, k: i64) -> Expr {
        let i = k - self.v;
        if i < 0 || i as usize >= self.c.len() {
            zero()
        } else {
            self.c[i as usize].clone()
        }
    }

    pub fn add(&self, o: &Series) -> Series {
        let v = self.v.min(o.v);
        let p = self.prec().min(o.prec());
        let c = (v..p).map(|k| clean(&add2(&self.coeff(k), &o.coeff(k)))).collect();
        Series { v, c }.normalize()
    }

    pub fn mul(&self, o: &Series) -> Series {
        if self.c.is_empty() || o.c.is_empty() {
            return Series { v: self.v + o.v, c: vec![] };
        }
        let v = self.v + o.v;
        let n = self.c.len().min(o.c.len());
        let mut c = vec![];
        for k in 0..n {
            let mut t = vec![];
            for i in 0..=k {
                t.push(mul2(&self.c[i], &o.c[k - i]));
            }
            c.push(clean(&add(t)));
        }
        Series { v, c }.normalize()
    }

    pub fn scale(&self, e: &Expr) -> Series {
        Series { v: self.v, c: self.c.iter().map(|a| clean(&mul2(a, e))).collect() }.normalize()
    }

    /// 1/self (the leading coefficient must not be zero).
    pub fn inv(&self) -> R<Series> {
        if self.c.is_empty() {
            return Err(SymError::Value("division by a series that vanishes to this order".into()));
        }
        let n = self.c.len();
        let a0 = &self.c[0];
        let ia0 = recip(a0);
        let mut b = vec![ia0.clone()];
        for k in 1..n {
            let mut t = vec![];
            for i in 1..=k {
                t.push(mul2(&self.c[i], &b[k - i]));
            }
            b.push(clean(&neg(&mul2(&ia0, &add(t)))));
        }
        Ok(Series { v: -self.v, c: b }.normalize())
    }

    /// self^r for a rational r (the valuation times r must be an integer).
    pub fn pow_rat(&self, r: &crate::num::Q) -> R<Series> {
        if self.c.is_empty() {
            return Ok(self.clone());
        }
        let vr = crate::num::Q::from_integer(self.v.into()) * r;
        if !vr.is_integer() {
            return Err(SymError::NotImplemented("Puiseux series (fractional powers of the variable) are not supported".into()));
        }
        // (a0 t^v (1 + u))^r = a0^r t^(v r) (1 + u)^r holds for real t of
        // both signs only when no branch is crossed: a0 off (-oo, 0] when
        // v = 0; a0 > 0 and (t^v)^r = t^(v r) for t < 0 otherwise (v and
        // v r even, or v odd and r (v - 1) an even integer).  sqrt(x^2) is
        // |x|, not x.
        let a0 = self.c[0].clone();
        if !r.is_integer() {
            let ok = if self.v == 0 {
                !free_symbols(&a0).is_empty() || crate::domain::off_cut(crate::domain::Cut::NonPositive, &a0)
            } else {
                let q = crate::num::Q::from_integer((self.v - 1).into()) * r;
                let even = |z: &crate::num::Q| z.is_integer() && (z.to_integer() % 2) == 0.into();
                // (for t > 0 only, as in a limit from the right or at
                // infinity, t^v > 0 and a0 > 0 suffice)
                crate::domain::const_sign(&a0) == Some(1) && (positive_side() || (self.v % 2 == 0 && even(&vr)) || (self.v % 2 != 0 && even(&q)))
            };
            if !ok {
                return Err(SymError::NotImplemented(format!("expansion of a fractional power at a branch point or cut of its base ({})", crate::to_string(&a0))));
            }
        }
        let u = Series { v: 0, c: self.c.iter().map(|x| div(x, &a0)).collect() };
        let mut one_u = u.clone();
        one_u.c[0] = zero();
        let one_u = one_u.normalize();
        let re = qnum(r.clone());
        // (1 + w)^r = sum binomial(r, k) w^k
        let n = self.c.len();
        let mut acc = Series::constant(&one(), n as i64);
        let mut term = Series::constant(&one(), n as i64);
        let mut binom = one();
        for k in 1..n {
            term = term.mul(&one_u);
            if term.c.is_empty() || term.v >= n as i64 {
                break;
            }
            binom = mul2(&binom, &div(&sub(&re, &int(k as i64 - 1)), &int(k as i64)));
            acc = acc.add(&term.scale(&binom));
        }
        let mut s = acc.scale(&pow(&a0, &re));
        s.v += num_traits::ToPrimitive::to_i64(&vr.to_integer()).unwrap();
        Ok(s)
    }

    /// f(self) for a function of one variable, via its Taylor expansion at
    /// the constant term.
    pub fn compose(&self, f: &dyn Fn(&Expr) -> Expr, prec: i64) -> R<Series> {
        if self.v < 0 {
            return Err(SymError::NotImplemented("expansion of a function at a pole of its argument".into()));
        }
        let a = self.coeff(0);
        // a placeholder that captures none of the symbols in f or a
        let mut avoid = free_symbols(&f(&sym("\u{1}")));
        avoid.extend(free_symbols(&a));
        let yn = fresh("__series_y", &avoid);
        let y = sym(&yn);
        let mut w = self.clone();
        if w.v == 0 {
            w.c[0] = zero();
            w = w.normalize();
        }
        // f(a + w) = sum f^(k)(a)/k! w^k
        let fy = f(&y);
        let mut deriv = fy.clone();
        let mut out = Series::constant(&subs(&fy, &[(y.clone(), a.clone())]), prec);
        let mut wk = Series::constant(&one(), prec);
        let mut fact = one();
        let mut k = 1;
        loop {
            wk = wk.mul(&w);
            if wk.c.is_empty() || wk.v >= prec {
                break;
            }
            deriv = diff(&deriv, &yn);
            fact = mul2(&fact, &int(k));
            let ck = clean(&div(&subs(&deriv, &[(y.clone(), a.clone())]), &fact));
            out = out.add(&wk.scale(&ck));
            k += 1;
            // (w has valuation >= 1, so w^k leaves the precision by k = prec;
            // a guard, never a silent truncation)
            if k as i64 > prec.max(200) + 1 {
                return Err(SymError::NotImplemented("series: the composition did not terminate".into()));
            }
        }
        Ok(out)
    }

    pub fn to_expr(&self, t: &Expr) -> Expr {
        add(self.c.iter().enumerate().map(|(i, a)| mul2(a, &pow(t, &int(self.v + i as i64)))).collect())
    }
}

/// The series of e in the variable x at 0, with coefficients up to t^(prec-1).
pub fn series(e: &Expr, x: &str, prec: i64) -> R<Series> {
    sagebrush_interrupt::check();
    if !depends(e, x) {
        return Ok(Series::constant(e, prec));
    }
    Ok(match &e.kind {
        Kind::Sym(_) => {
            let mut c = vec![zero(); (prec - 1).max(1) as usize];
            c[0] = one();
            Series { v: 1, c }
        }
        Kind::Add(v) => {
            let mut s = series(&v[0], x, prec)?;
            for t in &v[1..] {
                s = s.add(&series(t, x, prec)?);
            }
            s
        }
        Kind::Mul(v) => {
            // extra precision to absorb negative valuations of the factors
            let mut extra = 0;
            for f in v {
                extra -= series(f, x, 2)?.v.min(0);
            }
            let mut s = series(&v[0], x, prec + extra)?;
            for f in &v[1..] {
                s = s.mul(&series(f, x, prec + extra)?);
            }
            s.truncate(prec)
        }
        Kind::Pow(b, p) if b.is_const(Const::E) => {
            let s = series(p, x, prec + 2)?;
            s.compose(&|y: &Expr| exp(y), prec)?.truncate(prec)
        }
        Kind::Pow(b, p) => {
            if depends(p, x) {
                // b^p = e^(p log b) (composed directly: e^(x log 2) is 2^x again)
                let s = series(&mul2(p, &log(b)), x, prec + 2)?;
                return Ok(s.compose(&|y: &Expr| exp(y), prec)?.truncate(prec));
            }
            let bs = series(b, x, prec + 2)?;
            if let Some(k) = p.as_i64() {
                if k >= 0 {
                    let mut r = Series::constant(&one(), prec + 2);
                    for _ in 0..k {
                        r = r.mul(&bs);
                    }
                    return Ok(r.truncate(prec));
                }
                let extra = -bs.v * k.abs() + 2;
                let bs = series(b, x, prec + extra.max(2))?;
                let mut r = bs.inv()?;
                let base = r.clone();
                for _ in 1..(-k) {
                    r = r.mul(&base);
                }
                return Ok(r.truncate(prec));
            }
            if let Some(r) = p.as_rat() {
                return Ok(bs.pow_rat(r)?.truncate(prec));
            }
            // a symbolic exponent: through the derivatives
            let p2 = p.clone();
            bs.compose(&move |y: &Expr| pow(y, &p2), prec)?
        }
        Kind::Fun(Fun::Abs | Fun::Sign | Fun::Floor | Fun::Ceil | Fun::Heaviside, _) => {
            return Err(SymError::NotImplemented(format!("series of {}", crate::to_string(e))));
        }
        Kind::Fun(f, a) if a.len() == 1 => {
            let s = series(&a[0], x, prec + 2)?;
            if *f == Fun::Log && s.v > 0 {
                return Err(SymError::NotImplemented("the expansion has a logarithmic term (log of something that vanishes)".into()));
            }
            // a constant argument value on the function's branch cut: the
            // two sides differ (log(-1 + I x)), so no two-sided expansion
            if let Some((cut, _)) = crate::domain::cut_of(e) {
                let a0 = if s.v > 0 { zero() } else { s.coeff(0) };
                if cut != crate::domain::Cut::Unknown && s.v >= 0 && free_symbols(&a0).is_empty() && !crate::domain::off_cut(cut, &a0) {
                    return Err(SymError::NotImplemented(format!("expansion of {} on its branch cut", crate::to_string(e))));
                }
            }
            // at a pole (coth at 0, tanh at pi I/2): num(u)/den(u), a Laurent
            // series, not the Taylor series of a value that is infinite
            // (coth(0) came back as a finite coefficient: R2-SYMCALC-F8)
            if let Some((num_f, den_f)) = crate::domain::pole_parts(f) {
                let a0 = if s.v > 0 { zero() } else { s.coeff(0) };
                if s.v >= 0 && free_symbols(&a0).is_empty() && !crate::domain::certified_nonzero(&crate::simplify::simplify_full(&fun1(den_f.clone(), &a0))) {
                    let u = &a[0];
                    let n = num_f.map_or_else(one, |g| fun1(g, u));
                    return series(&mul2(&n, &pow(&fun1(den_f, u), &int(-1))), x, prec);
                }
            }
            let f2 = f.clone();
            s.compose(&move |y: &Expr| fun1(f2.clone(), y), prec)?.truncate(prec)
        }
        Kind::Fun(..) | Kind::Rel(..) => return Err(SymError::NotImplemented(format!("series of {}", crate::to_string(e)))),
        _ => Series::constant(e, prec),
    })
}

thread_local! {
    static POSITIVE_SIDE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn positive_side() -> bool {
    POSITIVE_SIDE.with(|c| c.get())
}

/// The series of e in x for x > 0 only (a one-sided expansion, which may
/// take the branch of a fractional power that holds there).
pub fn series_right(e: &Expr, x: &str, prec: i64) -> R<Series> {
    let old = POSITIVE_SIDE.with(|c| c.replace(true));
    let r = series(e, x, prec);
    POSITIVE_SIDE.with(|c| c.set(old));
    r
}

impl Series {
    pub fn truncate(mut self, prec: i64) -> Series {
        let n = (prec - self.v).max(0) as usize;
        self.c.truncate(n);
        self.normalize()
    }
}

/// Sage's taylor(f, x, a, n): the Taylor (or Laurent) polynomial of f at
/// x = a, up to (x - a)^n.
pub fn taylor(e: &Expr, x: &str, a: &Expr, n: i64) -> Expr {
    let xs = sym(x);
    let mut avoid = free_symbols(e);
    avoid.extend(free_symbols(a));
    let tn = fresh("__taylor_t", &avoid);
    let t = sym(&tn);
    let shifted = subs(e, &[(xs.clone(), add2(a, &t))]);
    let s = series(&shifted, &tn, n + 1).unwrap_or_else(|e| crate::err::throw(e));
    let poly = s.to_expr(&t);
    let base = if a.is_zero() { xs.clone() } else { sub(&xs, a) };
    subs(&poly, &[(t, base)])
}
