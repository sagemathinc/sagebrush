//! The differential corpus (design/mpmath-core.md §6.1): when MP_CORPUS names
//! a file of cases written by mpmath 1.3.0's python backend, every case's
//! raw result must be identical.  Without it the test does nothing (the
//! corpus is generated, not committed: see bench/mpmath).

use sagebrush_mp::mpf::{from_man_exp, mpf_add, mpf_div, mpf_mul, mpf_sqrt, Mpf, Rnd};
use sagebrush_mp::nat::Nat;
use sagebrush_mp::Fail;

fn hex_nat(s: &str) -> Nat {
    let mut limbs = Vec::new();
    let b = s.as_bytes();
    let mut end = b.len();
    while end > 0 {
        let start = end.saturating_sub(16);
        limbs.push(u64::from_str_radix(&s[start..end], 16).unwrap());
        end = start;
    }
    Nat::from_limbs(&limbs).unwrap()
}

fn nat_hex(n: &Nat) -> String {
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

fn parse(w: &[&str]) -> Mpf {
    Mpf { sign: w[0].parse().unwrap(), man: hex_nat(w[1]), exp: w[2].parse().unwrap(), bc: w[3].parse().unwrap() }
}

fn show(r: &Result<Mpf, Fail>) -> String {
    match r {
        Ok(m) => format!("{} {} {} {}", m.sign, nat_hex(&m.man), m.exp, m.bc),
        Err(Fail::ZeroDivision) => "ERR ZeroDivision".into(),
        Err(Fail::ComplexResult) => "ERR ComplexResult".into(),
        Err(Fail::KeyError) => "ERR KeyError".into(),
        Err(e) => format!("ERR {:?}", e),
    }
}

#[test]
fn corpus() {
    let Ok(path) = std::env::var("MP_CORPUS") else { return };
    let text = std::fs::read_to_string(&path).unwrap();
    let (mut n, mut bad) = (0, 0);
    for line in text.lines() {
        let w: Vec<&str> = line.split(' ').collect();
        let rnd = Rnd::from_code("nfcdu".find(w[1]).unwrap() as u32).unwrap();
        let prec: u64 = w[2].parse().unwrap();
        let s = parse(&w[3..7]);
        let t = parse(&w[7..11]);
        let want = w[11..].join(" ");
        let got = match w[0] {
            "add" => mpf_add(&s, &t, prec, rnd, false),
            "sub" => mpf_add(&s, &t, prec, rnd, true),
            "mul" => mpf_mul(&s, &t, prec, rnd),
            "div" => mpf_div(&s, &t, prec, rnd),
            "sqrt" => mpf_sqrt(&s, prec, rnd),
            "fme" => from_man_exp(s.sign, s.man.clone(), s.exp, prec, rnd),
            op => panic!("op {}", op),
        };
        n += 1;
        if show(&got) != want {
            bad += 1;
            if bad <= 8 {
                eprintln!("MISMATCH {}\n  got  {}", line, show(&got));
            }
        }
    }
    eprintln!("{} cases, {} mismatches", n, bad);
    assert_eq!(bad, 0);
}
