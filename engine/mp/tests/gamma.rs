//! gamma (design/mpmath-core.md §6.1): when MP_GAMMA names a file of cases
//! written by mpmath's python backend in one session, in order (the caches'
//! history is part of a result), every case the core answers must be
//! identical.  A case the core leaves to mpmath's own path (None) is counted.
//! Without the file the test does nothing.

use sagebrush_mp::fail::checked;
use sagebrush_mp::gamma::mpf_gamma;
use sagebrush_mp::mpf::Rnd;

mod common;
use common::*;

#[test]
fn gamma() {
    let Ok(path) = std::env::var("MP_GAMMA") else { return };
    let text = std::fs::read_to_string(&path).unwrap();
    let (mut n, mut bad, mut left) = (0, 0, 0);
    for line in text.lines() {
        let w: Vec<&str> = line.split_whitespace().collect();
        let typ: u32 = w[0].parse().unwrap();
        let rnd = Rnd::from_code("nfcdu".find(w[1]).unwrap() as u32).unwrap();
        let prec: u64 = w[2].parse().unwrap();
        let x = parse(&w[3..7]);
        let want = w[7..].join(" ");
        n += 1;
        match checked(|| mpf_gamma(&x, prec, rnd, typ)) {
            Ok(None) => left += 1,
            Ok(Some(r)) => {
                if show(&Ok(r)) != want {
                    bad += 1;
                    if bad <= 8 {
                        eprintln!("MISMATCH {}\n  got  {}", line, show(&Ok(mpf_gamma(&x, prec, rnd, typ).unwrap())));
                    }
                }
            }
            Err(e) => {
                bad += 1;
                eprintln!("FAILED {} {:?}", line, e);
            }
        }
    }
    eprintln!("{} cases, {} answered by the core, {} mismatches, {} left to mpmath's own path", n, n - left, bad, left);
    assert_eq!(bad, 0);
}

/// gamma(1/3) at 1000 digits (prec 3325), from a fresh session, natively:
/// `cargo test --release --test gamma -- --ignored --nocapture`.
#[test]
#[ignore]
fn gamma_third_1000_digits_native() {
    use sagebrush_mp::exp::Exp;
    use sagebrush_mp::mpf::{from_man_exp, mpf_div, Rnd};
    use sagebrush_mp::nat::Nat;
    let one = from_man_exp(0, Nat::from_u64(1), Exp::S(0), 0, Rnd::Nearest);
    let three = from_man_exp(0, Nat::from_u64(3), Exp::S(0), 0, Rnd::Nearest);
    let x = mpf_div(&one, &three, 3325, Rnd::Nearest);
    let t = std::time::Instant::now();
    let r = mpf_gamma(&x, 3325, Rnd::Nearest, 0).unwrap();
    let t1 = t.elapsed();
    let t = std::time::Instant::now();
    let r2 = mpf_gamma(&x, 3325, Rnd::Nearest, 0).unwrap();
    eprintln!("native gamma(1/3) prec 3325: first {:?}, again {:?}, bc {}", t1, t.elapsed(), r.bc);
    assert_eq!(r, r2);
}
