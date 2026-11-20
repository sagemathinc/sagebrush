//! The float-chosen parameters at every precision (design/mpmath-core.md
//! §6.1 pins): when MP_PARAMS names a file written by gen_params.py from
//! CPython, each line "prec series_r series_u basecase_r e_terms pi_terms
//! acot5 acot18 acot239 acot4801 acot8749" must be what the core computes.

use sagebrush_mp::consts::{acot_terms, e_terms, pi_terms};
use sagebrush_mp::elefun::{basecase_r, series_r, series_u};

#[test]
fn params() {
    let Ok(path) = std::env::var("MP_PARAMS") else { return };
    let text = std::fs::read_to_string(&path).unwrap();
    let (mut n, mut bad) = (0, 0);
    for line in text.lines() {
        let p: i64 = line.split(' ').next().unwrap().parse().unwrap();
        let mut got = vec![p, series_r(p), series_u(p), basecase_r(p), e_terms(p), pi_terms(p)];
        for a in [5, 18, 26, 239, 4801, 8749] {
            got.push(acot_terms(a, p));
        }
        let got = got.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(" ");
        n += 1;
        if got != line {
            bad += 1;
            if bad <= 8 {
                eprintln!("MISMATCH want {}\n           got  {}", line, got);
            }
        }
    }
    eprintln!("{} precisions, {} mismatches", n, bad);
    assert_eq!(bad, 0);
}
