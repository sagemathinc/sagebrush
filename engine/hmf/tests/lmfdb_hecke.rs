//! Hecke operators against the LMFDB (field 2.2.5.1, every level of norm
//! <= 1000, every prime of norm <= 30 not dividing the level;
//! fixtures/lmfdb.py). The LMFDB gives the newforms, so we check
//!   charpoly(T_P | M_2(N)) = (x - N(P) - 1) prod_{M | N} g_M(x)^d(N/M),
//! where g_M is the characteristic polynomial of T_P on S_2^new(M) and the
//! first factor is the Eisenstein series (Donnelly-Voight 2016, section 2).

use sagebrush_arith::zmat::{charpoly, ZMat};
use sagebrush_bigint::BigInt;
use sagebrush_hmf::field::{ideals_of_bounded_norm, primes_of_bounded_norm, Hnf, Ideal, Prime};
use sagebrush_hmf::Space;
use std::collections::HashMap;

type Poly = Vec<BigInt>;

fn mul(a: &Poly, b: &Poly) -> Poly {
    let mut c = vec![BigInt::from(0i64); a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            c[i + j] = &c[i + j] + &(x * y);
        }
    }
    c
}

fn hnf3(s: &str) -> Hnf {
    let v: Vec<u64> = s.split_whitespace().map(|x| x.parse().unwrap()).collect();
    Hnf { a: v[0], b: v[1], c: v[2] }
}

fn fixture() -> HashMap<(Hnf, Hnf), Poly> {
    include_str!("fixtures/lmfdb-2.2.5.1-hecke.txt")
        .lines()
        .filter(|l| !l.starts_with('#'))
        .map(|l| {
            let parts: Vec<&str> = l.split('|').collect();
            let f = parts[2].split_whitespace().map(|x| BigInt::from(x.parse::<i64>().unwrap())).collect();
            ((hnf3(parts[0]), hnf3(parts[1])), f)
        })
        .collect()
}

fn newdims() -> HashMap<Hnf, usize> {
    include_str!("fixtures/lmfdb-2.2.5.1-newdims.txt")
        .lines()
        .filter(|l| !l.starts_with('#'))
        .map(|l| {
            let v: Vec<u64> = l.split_whitespace().map(|x| x.parse().unwrap()).collect();
            (Hnf { a: v[1], b: v[2], c: v[3] }, v[4] as usize)
        })
        .collect()
}

fn divisors(n: &Ideal) -> Vec<(Ideal, usize)> {
    let mut out = vec![(vec![], 1usize)];
    for &(p, e) in &n.factors {
        let mut next = vec![];
        for (f, d) in &out {
            for k in 0..=e {
                let mut g: Vec<(Prime, u32)> = f.clone();
                if k > 0 {
                    g.push((p, k));
                }
                next.push((g, d * (e - k + 1) as usize));
            }
        }
        out = next;
    }
    out.into_iter().map(|(f, d)| (Ideal::from_factors(f), d)).collect()
}

#[test]
fn hecke_charpolys_vs_lmfdb() {
    let table = fixture();
    let dims = newdims();
    let primes = primes_of_bounded_norm(30);
    let mut checked = 0;
    for n in ideals_of_bounded_norm(1000) {
        let s = Space::from_ideal(n.clone()).unwrap();
        for p in primes.iter().filter(|p| n.factors.iter().all(|(q, _)| q != *p)) {
            let mut want: Poly = vec![BigInt::from(-(p.norm as i64) - 1), BigInt::from(1i64)];
            for (m, d) in divisors(&n) {
                let g = match table.get(&(m.hnf, p.hnf)) {
                    Some(g) => g.clone(),
                    None => {
                        assert_eq!(dims[&m.hnf], 0, "missing LMFDB data for a nonzero newspace");
                        vec![BigInt::from(1i64)]
                    }
                };
                for _ in 0..d {
                    want = mul(&want, &g);
                }
            }
            let t = s.hecke_matrix(p).unwrap().dense();
            let rows = t.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect();
            let got = charpoly(&ZMat::from_rows(rows));
            assert!(got == want, "level {} (norm {}), T at {} (norm {})", n.gen, n.norm(), p.gen, p.norm);
            checked += 1;
        }
    }
    assert!(checked > 3000);
}
