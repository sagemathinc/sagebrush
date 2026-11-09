//! The elementary-function corpus (design/mpmath-core.md §6.1): when
//! MP_ELEFUN names a file written by gen_elefun.py, one session of
//! mpmath 1.3.0's python backend in call order, the core replays it from a
//! fresh session in the same order (so every cache fills as the reference's
//! did) and every raw result must be identical.

use sagebrush_mp::elefun::{
    cos_sin_fixed, exp_fixed, log_int_fixed, mpc_exp, mpc_sqrt, mpf_cos, mpf_exp, mpf_log, mpf_pow, mpf_sin, reset,
};
use sagebrush_mp::int::Int;
use sagebrush_mp::mpf::{Mpf, Rnd};
use sagebrush_mp::Fail;

mod common;
use common::*;

fn show_int(r: &Int) -> String {
    format!("{} {} 0 0", r.is_neg() as u32, nat_hex(&r.mag))
}

fn show_pair(r: Result<(Mpf, Mpf), Fail>) -> String {
    match r {
        Ok((a, b)) => format!("{} | {}", show(&Ok(a)), show(&Ok(b))),
        Err(e) => show(&Err(e)),
    }
}

fn show_ints(r: Result<(Int, Int), Fail>) -> String {
    match r {
        Ok((a, b)) => format!("{} | {}", show_int(&a), show_int(&b)),
        Err(e) => show(&Err(e)),
    }
}

#[test]
fn elefun_corpus() {
    let Ok(path) = std::env::var("MP_ELEFUN") else { return };
    let text = std::fs::read_to_string(&path).unwrap();
    reset();
    let (mut n, mut bad) = (0, 0);
    for line in text.lines() {
        let (case, want) = line.split_once(" => ").unwrap();
        let w: Vec<&str> = case.split(' ').collect();
        let rnd = Rnd::from_code("nfcdu".find(w[1]).unwrap() as u32).unwrap();
        let prec: u64 = w[2].parse().unwrap();
        let s = parse(&w[3..7]);
        let t = parse(&w[7..11]);
        let si = Int::new(s.sign == 1, s.man.clone());
        let got = match w[0] {
            "exp" => show(&mpf_exp(&s, prec, rnd)),
            "log" => show(&mpf_log(&s, prec, rnd)),
            "cos" => show(&mpf_cos(&s, prec, rnd)),
            "sin" => show(&mpf_sin(&s, prec, rnd)),
            "pow" => show(&mpf_pow(&s, &t, prec, rnd)),
            "cexp" => show_pair(mpc_exp(&(s, t), prec, rnd)),
            "csqrt" => show_pair(mpc_sqrt(&(s, t), prec, rnd)),
            "expfix" => match exp_fixed(&si, prec as i64, None) {
                Ok(v) => show_int(&v),
                Err(e) => show(&Err(e)),
            },
            "csfix" => show_ints(cos_sin_fixed(&si, prec as i64, None)),
            "logint" => match log_int_fixed(&si, prec as i64, None) {
                Ok(v) => show_int(&v),
                Err(e) => show(&Err(e)),
            },
            op => panic!("op {}", op),
        };
        n += 1;
        if got != want {
            bad += 1;
            if bad <= 8 {
                eprintln!("MISMATCH {}\n  got  {}", line.chars().take(400).collect::<String>(), got.chars().take(400).collect::<String>());
            }
        }
    }
    eprintln!("{} cases, {} mismatches", n, bad);
    assert_eq!(bad, 0);
}
