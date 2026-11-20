//! Shared by the corpus tests: the text form of raw values.
#![allow(dead_code)]

use sagebrush_mp::exp::Exp;
use sagebrush_mp::mpf::Mpf;
use sagebrush_mp::nat::Nat;
use sagebrush_mp::Fail;

pub fn hex_nat(s: &str) -> Nat {
    let mut limbs = Vec::new();
    let b = s.as_bytes();
    let mut end = b.len();
    while end > 0 {
        let start = end.saturating_sub(16);
        limbs.push(u64::from_str_radix(&s[start..end], 16).unwrap());
        end = start;
    }
    Nat::from_limbs(&limbs)
}

pub fn nat_hex(n: &Nat) -> String {
    let l = n.limbs();
    if l.is_empty() {
        return "0".into();
    }
    let mut s = format!("{:x}", l[l.len() - 1]);
    for x in l[..l.len() - 1].iter().rev() {
        s.push_str(&format!("{:016x}", x));
    }
    s
}

pub fn parse_exp(s: &str) -> Exp {
    if let Ok(x) = s.parse::<i64>() {
        return Exp::S(x);
    }
    let (neg, digits) = match s.strip_prefix('-') {
        Some(d) => (true, d),
        None => (false, s),
    };
    let mut mag = Nat::zero();
    for ch in digits.bytes() {
        mag = mag.mul_u64(10).add_u64((ch - b'0') as u64);
    }
    Exp::from_parts(neg, mag)
}

pub fn show_exp(e: &Exp) -> String {
    match e {
        Exp::S(x) => x.to_string(),
        Exp::B { neg, mag } => {
            // decimal by repeated division
            let mut digits = Vec::new();
            let mut m = mag.clone();
            let ten = Nat::from_u64(10);
            while !m.is_zero() {
                let (q, r) = m.divmod(&ten);
                digits.push((b'0' + r.to_u64().unwrap() as u8) as char);
                m = q;
            }
            let s: String = digits.into_iter().rev().collect();
            if *neg { format!("-{}", s) } else { s }
        }
    }
}

pub fn parse(w: &[&str]) -> Mpf {
    Mpf { sign: w[0].parse().unwrap(), man: hex_nat(w[1]), exp: parse_exp(w[2]), bc: w[3].parse().unwrap() }
}

pub fn show(r: &Result<Mpf, Fail>) -> String {
    match r {
        Ok(m) => format!("{} {} {} {}", m.sign, nat_hex(&m.man), show_exp(&m.exp), m.bc),
        Err(Fail::ZeroDivision) => "ERR ZeroDivision".into(),
        Err(Fail::ComplexResult) => "ERR ComplexResult".into(),
        Err(Fail::KeyError) => "ERR KeyError".into(),
        Err(e) => format!("ERR {:?}", e),
    }
}
