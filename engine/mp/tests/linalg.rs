//! Dense linear algebra (design/mpmath-core.md §6.1): when MP_LINALG names a
//! file of cases written by mpmath 1.4.1's python backend (LU_decomp,
//! inverse, det, lu_solve on random real matrices), every result must be
//! identical, raw tuple for raw tuple, the singular ones' ZeroDivisionError
//! and det's int 0 included.  Without the file the test does nothing.

use sagebrush_mp::fail::checked;
use sagebrush_mp::linalg::{cholesky, cholesky_solve, det, inverse, lu_decomp, lu_solve, SolveError};
use sagebrush_mp::mpf::{Mpf, Rnd};

mod common;
use common::*;

fn mpfs(w: &[&str]) -> Vec<Mpf> {
    w.chunks(4).map(parse).collect()
}

fn show_all(v: &[Mpf]) -> String {
    v.iter().map(|m| show(&Ok(m.clone()))).collect::<Vec<_>>().join(" ")
}

#[test]
fn linalg() {
    let Ok(path) = std::env::var("MP_LINALG") else { return };
    let text = std::fs::read_to_string(&path).unwrap();
    let (mut n_cases, mut bad) = (0, 0);
    for line in text.lines() {
        let parts: Vec<&str> = line.split(" | ").collect();
        let head: Vec<&str> = parts[0].split(' ').collect();
        let (op, rnd, prec, n) = (head[0], head[1], head[2].parse::<u64>().unwrap(), head[3].parse::<usize>().unwrap());
        // (the row count, when it differs: gen_chol.py's lines carry it)
        let m = head.get(4).map_or(n, |m| m.parse::<usize>().unwrap());
        let solved = |r: Result<Vec<Mpf>, SolveError>| match r {
            Ok(x) => show_all(&x),
            Err(SolveError::Singular) => "ERR ZeroDivisionError".to_string(),
            Err(SolveError::NotPositiveDefinite) => "ERR ValueError".to_string(),
        };
        let rnd = Rnd::from_code("nfcdu".find(rnd).unwrap() as u32).unwrap();
        let a = mpfs(&parts[1].split(' ').collect::<Vec<_>>());
        let want = parts[3].strip_prefix("=> ").unwrap();
        let got = checked(|| match op {
            "lu" => {
                let mut lu = a.clone();
                match lu_decomp(&mut lu, n, prec, rnd) {
                    Ok(p) => format!("{} p {}", show_all(&lu), p.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(" ")),
                    Err(_) => "ERR ZeroDivisionError".to_string(),
                }
            }
            "inv" => match inverse(&a, n, prec, rnd) {
                Ok(x) => show_all(&x),
                Err(_) => "ERR ZeroDivisionError".to_string(),
            },
            "det" => match det(&a, n, prec, rnd) {
                Some(d) => show(&Ok(d)),
                None => "ZERO".to_string(),
            },
            "solve" | "lsq" => solved(lu_solve(&a, &mpfs(&parts[2].split(' ').collect::<Vec<_>>()), m, n, prec, rnd)),
            "chol" => solved(cholesky(&a, n, prec, rnd)),
            "cholsolve" => solved(cholesky_solve(&a, &mpfs(&parts[2].split(' ').collect::<Vec<_>>()), n, prec, rnd)),
            op => panic!("op {}", op),
        });
        n_cases += 1;
        // (mpf_div's own ZeroDivisionError, a 1 x 1 zero matrix's in U_solve, is the reference's too)
        let got = got.unwrap_or_else(|f| if f == sagebrush_mp::Fail::ZeroDivision { "ERR ZeroDivisionError".into() } else { format!("FAIL {:?}", f) });
        // (n = 1: LU's pivot list is empty, and the reference prints "p " with nothing after it)
        if got.trim_end() != want.trim_end() {
            bad += 1;
            if bad <= 6 {
                eprintln!("MISMATCH {} n={} prec={}\n  want {}\n  got  {}", op, n, prec, &want[..want.len().min(300)], &got[..got.len().min(300)]);
            }
        }
    }
    eprintln!("{} cases, {} mismatches", n_cases, bad);
    assert_eq!(bad, 0);
}
