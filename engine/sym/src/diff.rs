//! Differentiation, with the derivatives written the way Sage writes them
//! (tan' = tan^2 + 1, arcsin' = 1/sqrt(-x^2 + 1), (x^x)' = x^x (log x + 1)).

use crate::expr::*;

/// d e / d x.
pub fn diff(e: &Expr, x: &str) -> Expr {
    sagebrush_interrupt::check();
    match &e.kind {
        Kind::Num(_) | Kind::Const(_) => zero(),
        Kind::Sym(s) => int((&**s == x) as i64),
        Kind::Add(v) => add(v.iter().map(|t| diff(t, x)).collect()),
        Kind::Mul(v) => {
            let mut terms = vec![];
            for i in 0..v.len() {
                let d = diff(&v[i], x);
                if d.is_zero() {
                    continue;
                }
                let mut f: Vec<Expr> = v.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, f)| f.clone()).collect();
                f.push(d);
                terms.push(mul(f));
            }
            add(terms)
        }
        Kind::Pow(b, p) => {
            let bx = depends(b, x);
            let px = depends(p, x);
            match (bx, px) {
                (false, false) => zero(),
                // p b^(p-1) b'
                (true, false) => mul(vec![p.clone(), pow(b, &sub(p, &one())), diff(b, x)]),
                // b^p log(b) p'
                (false, true) => {
                    if b.is_const(Const::E) {
                        mul2(e, &diff(p, x))
                    } else {
                        mul(vec![e.clone(), log(b), diff(p, x)])
                    }
                }
                // b^p (p' log b + p b'/b)
                (true, true) => mul2(e, &add2(&mul2(&diff(p, x), &log(b)), &div(&mul2(p, &diff(b, x)), b))),
            }
        }
        Kind::Fun(f, args) => diff_fun(e, f, args, x),
        Kind::Rel(r, a, b) => relation(*r, &diff(a, x), &diff(b, x)),
    }
}

pub fn depends(e: &Expr, x: &str) -> bool {
    match &e.kind {
        Kind::Sym(s) => &**s == x,
        _ => e.children().iter().any(|c| depends(c, x)),
    }
}

fn diff_fun(e: &Expr, f: &Fun, a: &[Expr], x: &str) -> Expr {
    match f {
        Fun::User(name) => {
            // chain rule through the arguments: sum D[i](f)(args) * args[i]'
            let mut terms = vec![];
            for (i, ai) in a.iter().enumerate() {
                let d = diff(ai, x);
                if d.is_zero() {
                    continue;
                }
                terms.push(mul2(&fun(Fun::Deriv(name.clone(), vec![i as u32]), a.to_vec()), &d));
            }
            return add(terms);
        }
        Fun::Deriv(name, idx) => {
            let mut terms = vec![];
            for (i, ai) in a.iter().enumerate() {
                let d = diff(ai, x);
                if d.is_zero() {
                    continue;
                }
                let mut j = idx.clone();
                j.push(i as u32);
                j.sort();
                terms.push(mul2(&fun(Fun::Deriv(name.clone(), j), a.to_vec()), &d));
            }
            return add(terms);
        }
        Fun::Integral if a.len() == 2 && a[1].as_sym() == Some(x) => return a[0].clone(),
        Fun::Atan2 => {
            // d atan2(y, u) = (u y' - y u') / (u^2 + y^2)
            let (y, u) = (&a[0], &a[1]);
            let num = sub(&mul2(u, &diff(y, x)), &mul2(y, &diff(u, x)));
            return div(&num, &add2(&pow(u, &int(2)), &pow(y, &int(2))));
        }
        Fun::Binomial | Fun::Integral | Fun::Limit => {
            if !a.iter().any(|t| depends(t, x)) {
                return zero();
            }
            return fun(Fun::Deriv(f.name().into(), vec![0]), vec![e.clone()]);
        }
        _ => {}
    }
    let u = &a[0];
    let du = diff(u, x);
    if du.is_zero() {
        return zero();
    }
    let two = int(2);
    let u2 = pow(u, &two);
    let d = match f {
        Fun::Sin => cos(u),
        Fun::Cos => neg(&sin(u)),
        Fun::Tan => add2(&pow(e, &two), &one()),
        Fun::Cot => sub(&neg(&pow(e, &two)), &one()),
        Fun::Sec => mul2(e, &fun1(Fun::Tan, u)),
        Fun::Csc => neg(&mul2(&fun1(Fun::Cot, u), e)),
        Fun::Asin => pow(&sub(&one(), &u2), &rat(-1, 2)),
        Fun::Acos => neg(&pow(&sub(&one(), &u2), &rat(-1, 2))),
        Fun::Atan => recip(&add2(&u2, &one())),
        Fun::Acot => neg(&recip(&add2(&u2, &one()))),
        Fun::Asec => recip(&mul2(&u2, &sqrt(&sub(&one(), &recip(&u2))))),
        Fun::Acsc => neg(&recip(&mul2(&u2, &sqrt(&sub(&one(), &recip(&u2)))))),
        Fun::Sinh => fun1(Fun::Cosh, u),
        Fun::Cosh => fun1(Fun::Sinh, u),
        Fun::Tanh => sub(&one(), &pow(e, &two)),
        Fun::Coth => sub(&one(), &pow(e, &two)),
        Fun::Sech => neg(&mul2(e, &fun1(Fun::Tanh, u))),
        Fun::Csch => neg(&mul2(&fun1(Fun::Coth, u), e)),
        Fun::Asinh => pow(&add2(&u2, &one()), &rat(-1, 2)),
        Fun::Acosh => recip(&mul2(&sqrt(&add2(u, &one())), &sqrt(&sub(u, &one())))),
        Fun::Atanh | Fun::Acoth => neg(&recip(&sub(&u2, &one()))),
        Fun::Asech => neg(&recip(&mul2(u, &sqrt(&sub(&one(), &u2))))),
        Fun::Acsch => neg(&recip(&mul2(&u2, &sqrt(&add2(&one(), &recip(&u2)))))),
        Fun::Log => recip(u),
        Fun::Abs => mul(vec![half(), add2(u, &fun1(Fun::Conjugate, u)), recip(e)]),
        Fun::Erf => mul(vec![int(2), exp(&neg(&u2)), pow(&pi(), &rat(-1, 2))]),
        Fun::Sign | Fun::Floor | Fun::Ceil | Fun::Heaviside => zero(),
        Fun::Factorial | Fun::Gamma => return mul2(&fun(Fun::Deriv(f.name().into(), vec![0]), vec![u.clone()]), &du),
        Fun::Conjugate | Fun::RealPart | Fun::ImagPart => return mul2(&fun(Fun::Deriv(f.name().into(), vec![0]), vec![u.clone()]), &du),
        _ => return mul2(&fun(Fun::Deriv(f.name().into(), vec![0]), vec![u.clone()]), &du),
    };
    mul2(&d, &du)
}

/// The n-th derivative.
pub fn diff_n(e: &Expr, x: &str, n: usize) -> Expr {
    let mut r = e.clone();
    for _ in 0..n {
        r = diff(&r, x);
    }
    r
}
