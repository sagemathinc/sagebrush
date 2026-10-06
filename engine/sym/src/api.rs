//! The interface to the front ends: expressions travel as a compact,
//! lossless serialization (canonical, so equal expressions have equal
//! strings), and every operation is one call with string arguments.  The
//! engine keeps no state between calls, so it survives a WebAssembly
//! trap, and the Python objects are just strings (hashable, picklable).
//!
//! Serialization (prefix):
//!   n<p>/<q>        exact rational        z<re>;<im>;   exact complex
//!   f<bits hex>     float                 g<hex>,<hex>   complex float
//!   s<len>:<name>   symbol                c<x>           constant (p e g + - u ?)
//!   A<k>{...}       sum of k terms        M<k>{...}      product
//!   P{b}{x}         power                 F<len>:<name><k>{...}  function
//!   D<len>:<name><m>,<i,...><k>{...}     derivative D[i...](f)(args)
//!   R<op>{a}{b}     relation (= ! < l > g)
//!
//! Calls: "op\x1farg\x1farg..." -> "ok\x1fresult\x1f..." or "err\x1fKind\x1fmessage".

use crate::err::{catch, SymError};
use crate::expr::*;
use crate::num::{Num, Q};
use crate::print::{to_latex, to_string};
use sagebrush_bigint::BigInt;
use std::fmt::Write;

// ------------------------------------------------------------------ encoding

pub fn encode(e: &Expr) -> String {
    let mut s = String::new();
    enc(e, &mut s);
    s
}

fn enc_q(q: &Q, s: &mut String) {
    let _ = write!(s, "{}/{}", q.numer(), q.denom());
}

fn enc(e: &Expr, s: &mut String) {
    match &e.kind {
        Kind::Num(Num::Exact(a, b)) => {
            if num_traits::Zero::is_zero(b) {
                s.push('n');
                enc_q(a, s);
                s.push(';');
            } else {
                s.push('z');
                enc_q(a, s);
                s.push(';');
                enc_q(b, s);
                s.push(';');
            }
        }
        Kind::Num(Num::Float(a, b)) => {
            if *b == 0.0 {
                let _ = write!(s, "f{:x};", a.to_bits());
            } else {
                let _ = write!(s, "g{:x},{:x};", a.to_bits(), b.to_bits());
            }
        }
        Kind::Sym(n) => {
            let _ = write!(s, "s{}:{}", n.len(), n);
        }
        Kind::Const(c) => {
            s.push('c');
            s.push(match c {
                Const::Pi => 'p',
                Const::E => 'e',
                Const::EulerGamma => 'g',
                Const::Infinity => '+',
                Const::MinusInfinity => '-',
                Const::UnsignedInfinity => 'u',
                Const::Undefined => '?',
            });
        }
        Kind::Add(v) | Kind::Mul(v) => {
            let _ = write!(s, "{}{}", if matches!(e.kind, Kind::Add(_)) { 'A' } else { 'M' }, v.len());
            for c in v {
                s.push('{');
                enc(c, s);
                s.push('}');
            }
        }
        Kind::Pow(b, x) => {
            s.push_str("P{");
            enc(b, s);
            s.push_str("}{");
            enc(x, s);
            s.push('}');
        }
        Kind::Fun(f, a) => {
            match f {
                Fun::Deriv(name, idx) => {
                    let ix: Vec<String> = idx.iter().map(|i| i.to_string()).collect();
                    let _ = write!(s, "D{}:{}{},{}", name.len(), name, idx.len(), ix.join(","));
                    if !ix.is_empty() {
                        s.push(',');
                    }
                }
                _ => {
                    let n = match f {
                        Fun::User(n) => format!("@{}", n),
                        _ => f.name(),
                    };
                    let _ = write!(s, "F{}:{}", n.len(), n);
                }
            }
            let _ = write!(s, "{}", a.len());
            for c in a {
                s.push('{');
                enc(c, s);
                s.push('}');
            }
        }
        Kind::Rel(r, a, b) => {
            s.push('R');
            s.push(match r {
                Rel::Eq => '=',
                Rel::Ne => '!',
                Rel::Lt => '<',
                Rel::Le => 'l',
                Rel::Gt => '>',
                Rel::Ge => 'g',
            });
            s.push('{');
            enc(a, s);
            s.push_str("}{");
            enc(b, s);
            s.push('}');
        }
    }
}

struct Dec<'a> {
    s: &'a [u8],
    i: usize,
}

fn bad() -> ! {
    crate::err::value_error("malformed expression")
}

impl<'a> Dec<'a> {
    fn next(&mut self) -> u8 {
        let c = *self.s.get(self.i).unwrap_or_else(|| bad());
        self.i += 1;
        c
    }
    fn until(&mut self, stop: u8) -> &'a str {
        let st = self.i;
        while self.i < self.s.len() && self.s[self.i] != stop {
            self.i += 1;
        }
        let r = std::str::from_utf8(&self.s[st..self.i]).unwrap_or_else(|_| bad());
        self.i += 1;
        r
    }
    fn number(&mut self) -> usize {
        let st = self.i;
        while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
            self.i += 1;
        }
        std::str::from_utf8(&self.s[st..self.i]).unwrap().parse().unwrap_or_else(|_| bad())
    }
    fn q(&mut self) -> Q {
        let t = self.until(b';');
        let (n, d) = t.split_once('/').unwrap_or_else(|| bad());
        Q::new(n.parse::<BigInt>().unwrap_or_else(|_| bad()), d.parse::<BigInt>().unwrap_or_else(|_| bad()))
    }
    fn braced(&mut self) -> Expr {
        if self.next() != b'{' {
            bad();
        }
        let e = self.expr();
        if self.next() != b'}' {
            bad();
        }
        e
    }
    fn name(&mut self) -> String {
        let n = self.number();
        if self.next() != b':' {
            bad();
        }
        let st = self.i;
        self.i += n;
        std::str::from_utf8(&self.s[st..self.i]).unwrap_or_else(|_| bad()).to_string()
    }
    fn expr(&mut self) -> Expr {
        match self.next() {
            b'n' => raw(Kind::Num(Num::Exact(self.q(), num_traits::Zero::zero()))),
            b'z' => {
                let a = self.q();
                let b = self.q();
                raw(Kind::Num(Num::Exact(a, b)))
            }
            b'f' => {
                let h = self.until(b';');
                raw(Kind::Num(Num::Float(f64::from_bits(u64::from_str_radix(h, 16).unwrap_or_else(|_| bad())), 0.0)))
            }
            b'g' => {
                let h = self.until(b';');
                let (a, b) = h.split_once(',').unwrap_or_else(|| bad());
                let p = |t: &str| f64::from_bits(u64::from_str_radix(t, 16).unwrap_or_else(|_| bad()));
                raw(Kind::Num(Num::Float(p(a), p(b))))
            }
            b's' => raw(Kind::Sym(self.name().into())),
            b'c' => raw(Kind::Const(match self.next() {
                b'p' => Const::Pi,
                b'e' => Const::E,
                b'g' => Const::EulerGamma,
                b'+' => Const::Infinity,
                b'-' => Const::MinusInfinity,
                b'u' => Const::UnsignedInfinity,
                b'?' => Const::Undefined,
                _ => bad(),
            })),
            c @ (b'A' | b'M') => {
                let k = self.number();
                let v: Vec<Expr> = (0..k).map(|_| self.braced()).collect();
                raw(if c == b'A' { Kind::Add(v) } else { Kind::Mul(v) })
            }
            b'P' => {
                let b = self.braced();
                let x = self.braced();
                raw(Kind::Pow(b, x))
            }
            b'F' => {
                let n = self.name();
                let f = match n.strip_prefix('@') {
                    Some(u) => Fun::User(u.into()),
                    None => Fun::from_name(&n).unwrap_or_else(|| match n.as_str() {
                        "integrate" => Fun::Integral,
                        "limit" => Fun::Limit,
                        _ => bad(),
                    }),
                };
                let k = self.number();
                let v: Vec<Expr> = (0..k).map(|_| self.braced()).collect();
                raw(Kind::Fun(f, v))
            }
            b'D' => {
                let n = self.name();
                let m = self.number();
                if self.next() != b',' {
                    bad();
                }
                let mut idx = vec![];
                for _ in 0..m {
                    idx.push(self.number() as u32);
                    if self.next() != b',' {
                        bad();
                    }
                }
                let k = self.number();
                let v: Vec<Expr> = (0..k).map(|_| self.braced()).collect();
                raw(Kind::Fun(Fun::Deriv(n.into(), idx), v))
            }
            b'R' => {
                let r = match self.next() {
                    b'=' => Rel::Eq,
                    b'!' => Rel::Ne,
                    b'<' => Rel::Lt,
                    b'l' => Rel::Le,
                    b'>' => Rel::Gt,
                    b'g' => Rel::Ge,
                    _ => bad(),
                };
                let a = self.braced();
                let b = self.braced();
                raw(Kind::Rel(r, a, b))
            }
            _ => bad(),
        }
    }
}

pub fn decode(s: &str) -> Expr {
    let mut d = Dec { s: s.as_bytes(), i: 0 };
    let e = d.expr();
    if d.i != d.s.len() {
        bad();
    }
    e
}

// ------------------------------------------------------------------ calls

const SEP: char = '\x1f';

fn kind_name(e: &SymError) -> &'static str {
    match e {
        SymError::DivisionByZero => "ZeroDivisionError",
        SymError::Value(_) => "ValueError",
        SymError::NotImplemented(_) => "NotImplementedError",
    }
}

/// One call: "op\x1fargs..." -> "ok\x1fresults..." or "err\x1fKind\x1fmessage".
pub fn call(req: &str) -> String {
    crate::err::install_quiet_hook();
    let parts: Vec<&str> = req.split(SEP).collect();
    match catch(|| dispatch(parts[0], &parts[1..])) {
        Ok(out) => {
            let mut s = String::from("ok");
            for o in out {
                s.push(SEP);
                s.push_str(&o);
            }
            s
        }
        Err(e) => format!("err{}{}{}{}", SEP, kind_name(&e), SEP, e),
    }
}

fn d(s: &str) -> Expr {
    decode(s)
}

fn int_arg(s: &str) -> i64 {
    s.parse().unwrap_or_else(|_| crate::err::value_error(format!("expected an integer, got {}", s)))
}

fn dispatch(op: &str, a: &[&str]) -> Vec<String> {
    let one_ = |e: Expr| vec![encode(&e)];
    let arg = |i: usize| -> &str { a.get(i).copied().unwrap_or_else(|| crate::err::value_error(format!("{}: missing argument", op))) };
    match op {
        // constructors
        "sym" => one_(sym(arg(0))),
        "int" => one_(big(arg(0).parse::<BigInt>().unwrap_or_else(|_| crate::err::value_error("bad integer")))),
        "rat" => {
            let (n, q) = arg(0).split_once('/').unwrap_or((arg(0), "1"));
            let (n, q): (BigInt, BigInt) = (n.parse().unwrap_or_else(|_| bad()), q.parse().unwrap_or_else(|_| bad()));
            if num_traits::Zero::is_zero(&q) {
                crate::err::throw(SymError::DivisionByZero);
            }
            one_(qnum(Q::new(n, q)))
        }
        "float" => one_(float(arg(0).parse::<f64>().unwrap_or_else(|_| bad()))),
        "complex" => one_(num(Num::Float(arg(0).parse().unwrap_or_else(|_| bad()), arg(1).parse().unwrap_or_else(|_| bad())))),
        "const" => one_(match arg(0) {
            "pi" => pi(),
            "e" => e(),
            "I" => i(),
            "oo" | "+oo" | "Infinity" => infinity(),
            "-oo" | "-Infinity" => constant(Const::MinusInfinity),
            "uinf" => constant(Const::UnsignedInfinity),
            "euler_gamma" => constant(Const::EulerGamma),
            c => crate::err::value_error(format!("unknown constant {}", c)),
        }),
        "parse" => one_(crate::parse::parse(arg(0))),
        // arithmetic
        "add" => one_(add2(&d(arg(0)), &d(arg(1)))),
        "sub" => one_(sub(&d(arg(0)), &d(arg(1)))),
        "mul" => one_(mul2(&d(arg(0)), &d(arg(1)))),
        "div" => one_(div(&d(arg(0)), &d(arg(1)))),
        "pow" => one_(pow(&d(arg(0)), &d(arg(1)))),
        "neg" => one_(neg(&d(arg(0)))),
        "fun" => one_(crate::parse::call(arg(0), a[1..].iter().map(|s| d(s)).collect())),
        "rel" => {
            let r = match arg(0) {
                "==" => Rel::Eq,
                "!=" => Rel::Ne,
                "<" => Rel::Lt,
                "<=" => Rel::Le,
                ">" => Rel::Gt,
                ">=" => Rel::Ge,
                _ => bad(),
            };
            one_(relation(r, &d(arg(1)), &d(arg(2))))
        }
        // printing and inspection
        "str" => vec![to_string(&d(arg(0)))],
        "latex" => vec![to_latex(&d(arg(0)))],
        "variables" => free_symbols(&d(arg(0))),
        "operator" => {
            let e = d(arg(0));
            let (tag, ch): (String, Vec<Expr>) = match &e.kind {
                Kind::Num(n) => (if n.is_exact() { if n.is_real() { "rational" } else { "complex" } } else { "float" }.into(), vec![]),
                Kind::Sym(_) => ("symbol".into(), vec![]),
                Kind::Const(_) => ("constant".into(), vec![]),
                Kind::Add(v) => ("add".into(), v.clone()),
                Kind::Mul(v) => ("mul".into(), v.clone()),
                Kind::Pow(b, x) => ("pow".into(), vec![b.clone(), x.clone()]),
                Kind::Fun(f, v) => (format!("fun:{}", f.name()), v.clone()),
                Kind::Rel(r, x, y) => (format!("rel:{:?}", r), vec![x.clone(), y.clone()]),
            };
            let mut out = vec![tag];
            out.extend(ch.iter().map(encode));
            out
        }
        "number" => {
            // an exact rational or a float, as text
            let e = d(arg(0));
            match e.as_num() {
                Some(Num::Exact(a, b)) if num_traits::Zero::is_zero(b) => vec!["q".into(), format!("{}/{}", a.numer(), a.denom())],
                Some(Num::Exact(a, b)) => vec!["z".into(), format!("{}/{}", a.numer(), a.denom()), format!("{}/{}", b.numer(), b.denom())],
                Some(Num::Float(x, y)) => vec!["f".into(), format!("{:e}", x), format!("{:e}", y)],
                None => vec!["".into()],
            }
        }
        "n" => {
            let v = crate::eval::n(&d(arg(0)));
            let (x, y) = v.as_num().unwrap().to_c64();
            vec![format!("{:e}", x), format!("{:e}", y)]
        }
        "pysrc" => vec![pysrc(&d(arg(0)))],
        "eval_many" => {
            let e = d(arg(0));
            let xs: Vec<f64> = arg(2).split(',').filter(|t| !t.is_empty()).map(|t| t.parse().unwrap_or(f64::NAN)).collect();
            vec![crate::eval::eval_many(&e, arg(1), &xs).iter().map(|v| format!("{:e}", v)).collect::<Vec<_>>().join(",")]
        }
        // calculus
        "diff" => one_(crate::diff::diff_n(&d(arg(0)), arg(1), a.get(2).map_or(1, |s| int_arg(s)) as usize)),
        "expand" => one_(crate::expand::expand(&d(arg(0)))),
        "factor" => one_(crate::simplify::factor(&d(arg(0)))),
        "simplify_rational" => one_(crate::simplify::simplify_rational(&d(arg(0)))),
        "simplify_trig" => one_(crate::simplify::simplify_trig(&d(arg(0)))),
        "simplify_full" => one_(crate::simplify::simplify_full(&d(arg(0)))),
        "together" => {
            let (n, q) = crate::simplify::together(&d(arg(0)));
            one_(div(&crate::expand::expand(&n), &crate::expand::expand(&q)))
        }
        "taylor" => one_(crate::series::taylor(&d(arg(0)), arg(1), &d(arg(2)), int_arg(arg(3)))),
        "limit" => {
            let dir = match a.get(3).copied().unwrap_or("") {
                "+" => crate::limit::Dir::Plus,
                "-" => crate::limit::Dir::Minus,
                _ => crate::limit::Dir::Both,
            };
            one_(crate::limit::limit(&d(arg(0)), arg(1), &d(arg(2)), dir))
        }
        "solve" => {
            // solve neq eq... nvars var...: solutions as k-lists
            let ne = int_arg(arg(0)) as usize;
            let eqs: Vec<Expr> = a[1..1 + ne].iter().map(|s| d(s)).collect();
            let vars: Vec<String> = a[1 + ne..].iter().map(|s| s.to_string()).collect();
            let sols = crate::solve::solve(&eqs, &vars);
            let mut out = vec![sols.len().to_string()];
            for s in sols {
                out.push(s.len().to_string());
                out.extend(s.iter().map(encode));
            }
            out
        }
        "integrate" => {
            // integrate f x [a b]: the antiderivative (or definite integral),
            // unevaluated when none is found
            let f = d(arg(0));
            let x = arg(1);
            if a.len() >= 4 {
                let (lo, hi) = (d(arg(2)), d(arg(3)));
                one_(crate::integrate::definite(&f, x, &lo, &hi).unwrap_or_else(|| fun(Fun::Integral, vec![f.clone(), sym(x), lo, hi])))
            } else {
                one_(crate::integrate::integrate(&f, x).unwrap_or_else(|| fun(Fun::Integral, vec![f.clone(), sym(x)])))
            }
        }
        "desolve" => {
            // desolve de y x [ics...]
            let ics: Vec<Expr> = a[3..].iter().map(|s| d(s)).collect();
            one_(crate::ode::desolve(&d(arg(0)), arg(1), arg(2), &ics))
        }
        "integrate_steps" => {
            // the steps, depth first: depth \x1e rule \x1e var \x1e integrand \x1e result
            let f = d(arg(0));
            match crate::integrate::integrate_steps(&f, arg(1)) {
                Some((_, st)) => {
                    let mut out = vec![];
                    flatten_steps(&st, 0, &mut out);
                    out
                }
                None => vec![],
            }
        }
        "subs" => {
            let e = d(arg(0));
            let rules: Vec<(Expr, Expr)> = a[1..].chunks(2).map(|p| (d(p[0]), d(p[1]))).collect();
            one_(subs(&e, &rules))
        }
        "degree" => vec![crate::poly::degree(&d(arg(0)), arg(1)).to_string()],
        "coefficient" => one_(crate::poly::coefficient(&d(arg(0)), arg(1), int_arg(arg(2)))),
        "coefficients" => match crate::poly::coeffs(&d(arg(0)), arg(1)) {
            Some(c) => c.iter().map(encode).collect(),
            None => crate::err::value_error("not a polynomial"),
        },
        "numerator" => one_(numer_denom(&d(arg(0))).0),
        "denominator" => one_(numer_denom(&d(arg(0))).1),
        "is_zero" => {
            let e = d(arg(0));
            let z = e.is_zero() || crate::simplify::simplify_full(&e).is_zero();
            vec![(z as u8).to_string()]
        }
        _ => crate::err::value_error(format!("unknown operation {}", op)),
    }
}

fn flatten_steps(s: &crate::integrate::Step, depth: usize, out: &mut Vec<String>) {
    out.push(format!("{}\x1e{}\x1e{}\x1e{}\x1e{}", depth, s.rule, s.var, encode(&s.integrand), encode(&s.result)));
    for t in &s.sub {
        flatten_steps(t, depth + 1, out);
    }
}

/// Python source computing e with the math module as _m (variables as
/// _v_name), for fast numerical evaluation (plots).
pub fn pysrc(e: &Expr) -> String {
    match &e.kind {
        Kind::Num(n) => {
            let (a, b) = n.to_c64();
            if b == 0.0 {
                format!("({:?})", a)
            } else {
                format!("complex({:?}, {:?})", a, b)
            }
        }
        Kind::Sym(s) => format!("_v_{}", s),
        Kind::Const(c) => match c {
            Const::Pi => "_m.pi".into(),
            Const::E => "_m.e".into(),
            Const::EulerGamma => "0.5772156649015329".into(),
            Const::Infinity => "float('inf')".into(),
            Const::MinusInfinity => "float('-inf')".into(),
            _ => "float('nan')".into(),
        },
        Kind::Add(v) => format!("({})", v.iter().map(pysrc).collect::<Vec<_>>().join(" + ")),
        Kind::Mul(v) => format!("({})", v.iter().map(pysrc).collect::<Vec<_>>().join(" * ")),
        Kind::Pow(b, x) => {
            if b.is_const(Const::E) {
                return format!("_m.exp({})", pysrc(x));
            }
            if let Some(r) = x.as_rat() {
                if *r == crate::num::qr(1, 2) {
                    return format!("_m.sqrt({})", pysrc(b));
                }
            }
            format!("({} ** {})", pysrc(b), pysrc(x))
        }
        Kind::Fun(f, a) => {
            let args: Vec<String> = a.iter().map(pysrc).collect();
            let name = match f {
                Fun::Sin | Fun::Cos | Fun::Tan | Fun::Asin | Fun::Acos | Fun::Atan | Fun::Sinh | Fun::Cosh | Fun::Tanh | Fun::Asinh | Fun::Acosh | Fun::Atanh
                | Fun::Floor | Fun::Ceil | Fun::Erf => format!("_m.{}", match f {
                    Fun::Asin => "asin",
                    Fun::Acos => "acos",
                    Fun::Atan => "atan",
                    Fun::Asinh => "asinh",
                    Fun::Acosh => "acosh",
                    Fun::Atanh => "atanh",
                    _ => return format!("_m.{}({})", f.name(), args.join(", ")),
                }),
                Fun::Atan2 => "_m.atan2".into(),
                Fun::Log => "_m.log".into(),
                Fun::Abs => "abs".into(),
                Fun::Gamma => "_gamma".into(),
                Fun::Factorial => return format!("_gamma({} + 1)", args[0]),
                Fun::Cot => return format!("(1 / _m.tan({}))", args[0]),
                Fun::Sec => return format!("(1 / _m.cos({}))", args[0]),
                Fun::Csc => return format!("(1 / _m.sin({}))", args[0]),
                Fun::Acot => return format!("_m.atan(1 / {})", args[0]),
                Fun::Coth => return format!("(1 / _m.tanh({}))", args[0]),
                Fun::Sech => return format!("(1 / _m.cosh({}))", args[0]),
                Fun::Csch => return format!("(1 / _m.sinh({}))", args[0]),
                Fun::Sign => return format!("_sgn({})", args[0]),
                Fun::Heaviside => return format!("(1.0 if {} > 0 else 0.0)", args[0]),
                _ => return format!("_undefined({:?})", f.name()),
            };
            format!("{}({})", name, args.join(", "))
        }
        Kind::Rel(..) => "_undefined('relation')".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        for s in ["x^2 + 1/3*x - 2.5", "sin(x)/(x + I)", "f(x, y) == 2", "e^(-x^2)*pi", "atan2(y, x) + abs(-x)", "1.5 + 2.5*I"] {
            let e = crate::parse::parse(s);
            assert_eq!(decode(&encode(&e)), e, "{}", s);
        }
        let d = crate::diff::diff(&crate::parse::parse("f(x^2)"), "x");
        assert_eq!(decode(&encode(&d)), d);
    }

    #[test]
    fn calls() {
        let x = call("sym\x1fx");
        let xs = x.split('\x1f').nth(1).unwrap().to_string();
        let r = call(&format!("pow\x1f{}\x1f{}", xs, encode(&int(2))));
        let p = r.split('\x1f').nth(1).unwrap().to_string();
        assert_eq!(call(&format!("str\x1f{}", p)), "ok\x1fx^2");
        assert_eq!(call(&format!("diff\x1f{}\x1fx", p)).split('\x1f').nth(1).map(|s| to_string(&decode(s))), Some("2*x".into()));
        assert!(call(&format!("div\x1f{}\x1f{}", xs, encode(&zero()))).starts_with("err\x1fZeroDivisionError"));
    }
}
