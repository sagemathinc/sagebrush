//! A parser for expressions in Sage syntax: numbers (exact integers,
//! decimals as floats), names (pi, e, I, oo are constants), function calls,
//! + - * / ^ ** (right associative), unary minus, parentheses, and the
//! relations == != < <= > >=.

use crate::err::value_error;
use crate::expr::*;
use crate::num::Num;
use sagebrush_bigint::BigInt;

struct P<'a> {
    s: &'a [u8],
    i: usize,
}

pub fn parse(src: &str) -> Expr {
    let mut p = P { s: src.as_bytes(), i: 0 };
    let e = p.relation();
    p.ws();
    if p.i != p.s.len() {
        value_error(format!("cannot parse '{}' (at position {})", src, p.i));
    }
    e
}

impl<'a> P<'a> {
    fn ws(&mut self) {
        while self.i < self.s.len() && (self.s[self.i] as char).is_whitespace() {
            self.i += 1;
        }
    }
    fn peek(&mut self) -> Option<u8> {
        self.ws();
        self.s.get(self.i).copied()
    }
    fn eat(&mut self, t: &str) -> bool {
        self.ws();
        if self.s[self.i..].starts_with(t.as_bytes()) {
            self.i += t.len();
            true
        } else {
            false
        }
    }

    fn relation(&mut self) -> Expr {
        let a = self.sum();
        for (t, r) in [("==", Rel::Eq), ("!=", Rel::Ne), ("<=", Rel::Le), (">=", Rel::Ge), ("<", Rel::Lt), (">", Rel::Gt)] {
            if self.eat(t) {
                let b = self.sum();
                return relation(r, &a, &b);
            }
        }
        a
    }

    fn sum(&mut self) -> Expr {
        let mut terms = vec![self.product()];
        loop {
            if self.eat("+") {
                terms.push(self.product());
            } else if self.peek() == Some(b'-') {
                self.i += 1;
                terms.push(neg(&self.product()));
            } else {
                break;
            }
        }
        add(terms)
    }

    fn product(&mut self) -> Expr {
        let mut acc = self.unary();
        loop {
            self.ws();
            if self.s[self.i..].starts_with(b"**") {
                break; // handled in power
            }
            if self.eat("*") {
                let b = self.unary();
                acc = mul2(&acc, &b);
            } else if self.eat("/") {
                let b = self.unary();
                acc = div(&acc, &b);
            } else {
                break;
            }
        }
        acc
    }

    fn unary(&mut self) -> Expr {
        if self.eat("-") {
            return neg(&self.unary());
        }
        if self.eat("+") {
            return self.unary();
        }
        self.power()
    }

    fn power(&mut self) -> Expr {
        let b = self.atom();
        if self.eat("^") || self.eat("**") {
            let x = self.unary(); // right associative, allows x^-2
            return pow(&b, &x);
        }
        b
    }

    fn atom(&mut self) -> Expr {
        let c = match self.peek() {
            Some(c) => c,
            None => value_error("unexpected end of expression"),
        };
        if c == b'(' {
            self.i += 1;
            let e = self.relation();
            if !self.eat(")") {
                value_error("missing )");
            }
            return e;
        }
        if c.is_ascii_digit() || c == b'.' {
            let st = self.i;
            while self.i < self.s.len() && (self.s[self.i].is_ascii_digit() || self.s[self.i] == b'.') {
                self.i += 1;
            }
            if self.i < self.s.len() && (self.s[self.i] == b'e' || self.s[self.i] == b'E') && self.s.get(self.i + 1).map_or(false, |c| c.is_ascii_digit() || *c == b'-' || *c == b'+') {
                self.i += 2;
                while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
                    self.i += 1;
                }
            }
            let t = std::str::from_utf8(&self.s[st..self.i]).unwrap();
            if t.contains('.') || t.contains('e') || t.contains('E') {
                return float(t.parse::<f64>().unwrap_or_else(|_| value_error(format!("bad number {}", t))));
            }
            return num(Num::big(t.parse::<BigInt>().unwrap()));
        }
        if c.is_ascii_alphabetic() || c == b'_' {
            let st = self.i;
            while self.i < self.s.len() && (self.s[self.i].is_ascii_alphanumeric() || self.s[self.i] == b'_') {
                self.i += 1;
            }
            let name = std::str::from_utf8(&self.s[st..self.i]).unwrap().to_string();
            if self.peek() == Some(b'(') {
                self.i += 1;
                let mut args = vec![];
                if !self.eat(")") {
                    loop {
                        args.push(self.relation());
                        if self.eat(")") {
                            break;
                        }
                        if !self.eat(",") {
                            value_error("expected , or )");
                        }
                    }
                }
                return call(&name, args);
            }
            return match name.as_str() {
                "pi" => pi(),
                "e" => e(),
                "I" => i(),
                "oo" | "Infinity" | "infinity" => infinity(),
                "euler_gamma" => constant(Const::EulerGamma),
                _ => sym(&name),
            };
        }
        value_error(format!("unexpected '{}'", c as char))
    }
}

/// A function call by name: exp and sqrt are powers; unknown names are
/// symbolic functions.
pub fn call(name: &str, args: Vec<Expr>) -> Expr {
    match name {
        "exp" if args.len() == 1 => exp(&args[0]),
        "sqrt" if args.len() == 1 => sqrt(&args[0]),
        "diff" | "derivative" if args.len() >= 2 && args[1].as_sym().is_some() => {
            let n = args.get(2).and_then(|k| k.as_i64()).unwrap_or(1).max(0) as usize;
            crate::diff::diff_n(&args[0], args[1].as_sym().unwrap(), n)
        }
        _ => match Fun::from_name(name) {
            Some(f) => fun(f, args),
            None => fun(Fun::User(name.into()), args),
        },
    }
}
