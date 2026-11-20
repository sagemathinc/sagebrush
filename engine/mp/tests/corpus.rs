//! The differential corpus (design/mpmath-core.md §6.1): when MP_CORPUS names
//! a file of cases written by mpmath 1.3.0's python backend, every case's
//! raw result must be identical.  Without it the test does nothing (the
//! corpus is generated, not committed: see bench/mpmath).

use sagebrush_mp::mpf::{from_man_exp, mpf_add, mpf_div, mpf_mul, mpf_mul_int, mpf_pow_int, mpf_sqrt, Rnd};

use sagebrush_mp::fail::checked;
use sagebrush_mp::Fail;
use sagebrush_mp::kernel::{self, Sm};

mod common;
use common::*;

#[test]
fn corpus() {
    let Ok(path) = std::env::var("MP_CORPUS") else { return };
    let text = std::fs::read_to_string(&path).unwrap();
    let (mut n, mut bad, mut kn, mut kbad, mut limited) = (0, 0, 0, 0, 0);
    for line in text.lines() {
        let w: Vec<&str> = line.split(' ').collect();
        let rnd = Rnd::from_code("nfcdu".find(w[1]).unwrap() as u32).unwrap();
        let prec: u64 = w[2].parse().unwrap();
        let s = parse(&w[3..7]);
        let t = parse(&w[7..11]);
        let want = w[11..].join(" ");
        let got = checked(|| match w[0] {
            "add" => mpf_add(&s, &t, prec, rnd, false),
            "sub" => mpf_add(&s, &t, prec, rnd, true),
            "mul" => mpf_mul(&s, &t, prec, rnd),
            "div" => mpf_div(&s, &t, prec, rnd),
            "sqrt" => mpf_sqrt(&s, prec, rnd),
            "powi" => {
                let n = sagebrush_mp::int::Int::new(t.sign == 1, t.man.clone());
                mpf_pow_int(&s, &n, prec, rnd)
            }
            "muli" => mpf_mul_int(&s, t.sign, &t.man, prec, rnd),
            "fme" => from_man_exp(s.sign, s.man.clone(), s.exp.clone(), prec, rnd),
            op => panic!("op {}", op),
        });
        // (the kernel fast path, where it applies, gives exactly the general path's value)
        let (ks, kt) = (Sm::of(&s), Sm::of(&t));
        if let (Some(a), Some(b), Ok(g)) = (ks, kt, &got) {
            let k = match w[0] {
                "add" => kernel::add(a, b, prec, rnd, false),
                "sub" => kernel::add(a, b, prec, rnd, true),
                "mul" => kernel::mul(a, b, prec, rnd),
                _ => None,
            };
            if let Some(k) = k {
                kn += 1;
                if k.mpf() != *g {
                    kbad += 1;
                    if kbad <= 8 {
                        eprintln!("KERNEL MISMATCH {}\n  kernel {:?}", line, k);
                    }
                }
            }
        }
        n += 1;
        // (a result the reference can't allocate, its MemoryError or its shift's OverflowError, the core refuses
        // by its limit first: the limits' refusal, design §4.5)
        let refused = matches!(got, Err(Fail::Limit { .. }) | Err(Fail::Memory { .. })) && (want == "ERR MemoryError" || want == "ERR OverflowError");
        if refused {
            limited += 1;
        } else if show(&got) != want {
            bad += 1;
            if bad <= 8 {
                eprintln!("MISMATCH {}\n  got  {}", line, show(&got));
            }
        }
    }
    eprintln!("{} cases, {} mismatches ({} refused by the limit where the reference ran out of memory); the kernel took {}, {} mismatches", n, bad, limited, kn, kbad);
    assert_eq!(bad, 0);
    assert_eq!(kbad, 0);
}
