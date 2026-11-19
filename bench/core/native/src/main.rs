//! Bench-only driver: the engine's own routines for the cases that have a
//! direct entry, called natively on the same inputs as the other drivers,
//! in the protocol of bench/core/drivers/common.py (`CASE N MODE`).  It
//! measures the engine itself; the Sage-mode driver measures what users
//! get, and the difference between the two is the cost of reaching the
//! engine.
use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_arith::{nmod_mat, nmod_poly, zpoly};
use sagebrush_bigint::BigInt;
use std::time::Instant;

const MOD: u64 = 1_000_000_007;
const P: u64 = 65537;

fn residue(x: &BigInt) -> u64 {
    let text = x.to_string();
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.as_str()),
    };
    let v = digits.bytes().fold(0u64, |v, b| (v * 10 + u64::from(b - b'0')) % MOD);
    if negative && v != 0 {
        MOD - v
    } else {
        v
    }
}

fn hash_u64(xs: &[u64]) -> u64 {
    xs.iter().fold(17, |h, &x| (h * 1_000_003 + x % MOD) % MOD)
}

fn hash_big(xs: &[BigInt]) -> u64 {
    xs.iter().fold(17, |h, x| (h * 1_000_003 + residue(x)) % MOD)
}

/// One invocation in the protocol of bench/core/drivers/common.py: `build(v)`
/// makes variant v's operand hash and operation (outside any timing).
/// `time` runs every variant once untimed (the warm-up, and the answers the
/// combined signature covers), then cycles through them, never one input
/// repeated.  No row of this driver needs `time-fresh`.
fn run<T, F: FnMut() -> T>(mode: &str, variants: usize, mut build: impl FnMut(usize) -> (u64, F), sig: impl Fn(&T) -> String) {
    const TARGET: f64 = 0.2;
    if mode == "inputs" {
        let hs: Vec<u64> = (0..variants).map(|v| build(v).0).collect();
        println!("INPUTS|{}", hash_u64(&hs));
        return;
    }
    if mode == "once" {
        let mut op = build(0).1;
        let started = Instant::now();
        let answer = op();
        println!("RESULT|{:.9}|{}", started.elapsed().as_secs_f64(), sig(&answer));
        return;
    }
    assert!(mode == "time", "unknown or unsupported mode {mode}");
    let mut ops: Vec<F> = (0..variants).map(|v| build(v).1).collect();
    let (mut sigs, mut warm) = (Vec::with_capacity(variants), 0.0);
    for op in ops.iter_mut() {
        let started = Instant::now();
        let answer = op();
        warm += started.elapsed().as_secs_f64();
        sigs.push(sig(&answer));
    }
    let mut idx = 0usize;
    let mut reps = |k: usize| {
        let mut total = 0.0;
        for _ in 0..k {
            let op = &mut ops[idx % variants];
            idx += 1;
            let started = Instant::now();
            std::hint::black_box(op());
            total += started.elapsed().as_secs_f64();
        }
        total
    };
    let per = warm / variants as f64;
    let (mut k, mut t) = if per >= TARGET {
        (1usize, per)
    } else {
        let k = if per > 0.0 { ((TARGET * 1.2 / per) as usize + 1).max(1) } else { variants };
        (k, reps(k))
    };
    while t < TARGET && k < 1 << 24 {
        k = if t <= 0.0 { 2 * k } else { (2 * k).max((16 * k).min((k as f64 * TARGET * 1.2 / t) as usize + 1)) };
        t = reps(k);
    }
    let count = if t / k as f64 <= 2.0 { 5 } else { 3 };
    let mut samples: Vec<f64> = (0..count).map(|_| reps(k) / k as f64).collect();
    samples.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let joined = sigs.join(";");
    let combined = format!("{}:{}", variants, hash_u64(&joined.bytes().map(u64::from).collect::<Vec<_>>()));
    println!("TIME|{:.9e}|{}|{:.9e}|{:.9e}|{}|{}", samples[count / 2], combined, samples[0], samples[count - 1], k, count);
}

fn fppoly(n: usize, salt: u64) -> Vec<u64> {
    (0..n as u64).map(|i| (i * i * salt + 3 * i + 1) % P).collect()
}

fn zpoly_in(n: usize, salt: i64) -> Vec<BigInt> {
    (0..n as i64).map(|i| BigInt::from((i * i * salt + 3 * i + 1) % 1_000_003 - 500_001)).collect()
}

fn pow_mod(mut b: u64, mut e: u64, m: u64) -> u64 {
    let mut r = 1 % m;
    b %= m;
    while e > 0 {
        if e & 1 == 1 {
            r = (r as u128 * b as u128 % m as u128) as u64;
        }
        b = (b as u128 * b as u128 % m as u128) as u64;
        e >>= 1;
    }
    r
}

/// The Sage driver's det_input, variant v: entry (i, j) = (i + 2 + v)^(j + 3)
/// mod m - offset.
fn entries(n: usize, m: u64, offset: i64, v: usize) -> Vec<Vec<i64>> {
    (0..n).map(|i| (0..n).map(|j| pow_mod((i + 2 + v) as u64, j as u64 + 3, m) as i64 - offset).collect()).collect()
}

fn poly_sig(c: &[u64]) -> String {
    format!("{}:{}", c.len() as i64 - 1, hash_u64(c))
}

fn zpoly_sig(c: &[BigInt]) -> String {
    format!("{}:{}", c.len() as i64 - 1, hash_big(c))
}

fn factor_sig<C>(items: &[(C, u32)], hash: impl Fn(&C) -> (u64, u64)) -> String {
    let mut v: Vec<(u64, u64, u64)> = items.iter().map(|(f, e)| {
        let (deg, h) = hash(f);
        (deg, u64::from(*e), h)
    }).collect();
    v.sort();
    let flat: Vec<u64> = v.iter().flat_map(|&(a, b, c)| [a, b, c]).collect();
    format!("{}:{}", v.len(), hash_u64(&flat))
}

fn main() {
    let mut args = std::env::args().skip(1);
    let case_id = args.next().expect("case id");
    let n: usize = args.next().expect("n").parse().expect("n");
    let mode = args.next().expect("mode");
    let variants: usize = args.next().map_or(1, |k| k.parse().expect("K"));
    assert!(variants >= 1, "K must be at least 1");
    // (variants: salts + 6 v, matrix nodes + v, the factor product's
    // constant terms + v; rows with one input are run with K = 1)
    let salt = |s: u64, v: usize| s + 6 * v as u64;
    match case_id.as_str() {
        "poly_fp_mul" => run(&mode, variants, |v| {
            let (a, b, m) = (fppoly(n, salt(11, v)), fppoly(n, salt(17, v)), Modulus::new(P));
            (hash_u64(&[a.clone(), b.clone()].concat()), move || nmod_poly::mul(&a, &b, &m))
        }, |c| poly_sig(c)),
        "poly_fp_gcd" => run(&mode, variants, |v| {
            let m = Modulus::new(P);
            let g = fppoly(n / 2, salt(5, v));
            let (a, b) = (nmod_poly::mul(&g, &fppoly(n, salt(11, v)), &m), nmod_poly::mul(&g, &fppoly(n, salt(17, v)), &m));
            (hash_u64(&[a.clone(), b.clone()].concat()), move || nmod_poly::gcd(&a, &b, &m))
        }, |c| poly_sig(c)),
        "poly_fp_factor" => run(&mode, variants, |_| {
            let mut f = vec![BigInt::from(0); n + 1];
            f[0] = BigInt::from(-1);
            f[n] = BigInt::from(1);
            // (the operands as the other drivers hash them: x^n - 1 modulo p)
            let mut fp = vec![0u64; n + 1];
            fp[0] = P - 1;
            fp[n] = 1;
            (hash_u64(&fp), move || sagebrush_poly::factor_mod(&f, P))
        }, |r| factor_sig(r, |c: &Vec<u64>| ((c.len() - 1) as u64, hash_u64(c)))),
        "poly_z_mul" => run(&mode, variants, |v| {
            let (a, b) = (zpoly_in(n, salt(11, v) as i64), zpoly_in(n, salt(17, v) as i64));
            (hash_big(&[a.clone(), b.clone()].concat()), move || zpoly::mul(&a, &b))
        }, |c| zpoly_sig(c)),
        "poly_z_gcd" => run(&mode, variants, |v| {
            let g = zpoly_in(n / 2, salt(5, v) as i64);
            let (a, b) = (zpoly::mul(&g, &zpoly_in(n, salt(11, v) as i64)), zpoly::mul(&g, &zpoly_in(n, salt(17, v) as i64)));
            (hash_big(&[a.clone(), b.clone()].concat()), move || zpoly::gcd(&a, &b))
        }, |c| zpoly_sig(c)),
        "poly_z_factor" | "poly_z_factor_product" => run(&mode, variants, |v| {
            let f = if case_id == "poly_z_factor" {
                let mut f = vec![BigInt::from(0); n + 1];
                f[0] = BigInt::from(-1);
                f[n] = BigInt::from(1);
                f
            } else {
                let mut f = vec![BigInt::from(1)];
                for i in 1..=n as i64 {
                    f = zpoly::mul(&f, &[BigInt::from(i * i + i + 1 + v as i64), BigInt::from(i + 1), BigInt::from(1)]);
                }
                f
            };
            (hash_big(&f), move || sagebrush_poly::factor(&f))
        }, |r| factor_sig(&r.1, |c: &Vec<BigInt>| ((c.len() - 1) as u64, hash_big(c)))),
        "mat_fp_det" | "mat_fp_rank" | "mat_fp_charpoly" => {
            let fp = |v: usize| {
                let rows: Vec<Vec<u64>> = entries(n, P, 0, v).into_iter().map(|r| r.into_iter().map(|x| x as u64).collect()).collect();
                (hash_u64(&rows.concat()), nmod_mat::Mat::from_rows(&rows, Modulus::new(P)))
            };
            match case_id.as_str() {
                "mat_fp_det" => run(&mode, variants, |v| { let (h, a) = fp(v); (h, move || a.det()) }, |d| d.to_string()),
                "mat_fp_rank" => run(&mode, variants, |v| { let (h, a) = fp(v); (h, move || a.rank()) }, |r| r.to_string()),
                _ => run(&mode, variants, |v| { let (h, a) = fp(v); (h, move || a.charpoly()) }, |c| poly_sig(c)),
            }
        }
        "mat_fp_solve" => run(&mode, variants, |v| {
            let rows: Vec<Vec<u64>> = entries(n, P, 0, v).into_iter().map(|r| r.into_iter().map(|x| x as u64).collect()).collect();
            let rhs: Vec<u64> = (1..=n as u64).collect();
            let h = hash_u64(&[rows.concat(), rhs.clone()].concat());
            let a = nmod_mat::Mat::from_rows(&rows, Modulus::new(P));
            let b = nmod_mat::Mat::from_rows(&rhs.iter().map(|&x| vec![x]).collect::<Vec<_>>(), Modulus::new(P));
            (h, move || a.solve(&b).expect("solvable"))
        }, |x| {
            let xs: Vec<u64> = (0..n).map(|i| x.row(i)[0]).collect();
            format!("{}:{}", n, hash_u64(&xs))
        }),
        "mat_z_det" | "mat_z_rank" | "mat_z_charpoly" | "mat_z_hnf" => {
            let zrows = |v: usize| -> Vec<Vec<BigInt>> {
                entries(n, 1_000_003, 500_001, v).into_iter().map(|r| r.into_iter().map(BigInt::from).collect()).collect()
            };
            match case_id.as_str() {
                "mat_z_det" => run(&mode, variants, |v| { let r = zrows(v); let h = hash_big(&r.concat()); let a = ZMat::from_rows(r); (h, move || zmat::det(&a)) }, |d| d.to_string()),
                "mat_z_rank" => run(&mode, variants, |v| { let r = zrows(v); let h = hash_big(&r.concat()); let a = ZMat::from_rows(r); (h, move || zmat::rank(&a)) }, |r| r.to_string()),
                "mat_z_charpoly" => run(&mode, variants, |v| { let r = zrows(v); let h = hash_big(&r.concat()); let a = ZMat::from_rows(r); (h, move || zmat::charpoly(&a)) }, |c| zpoly_sig(c)),
                _ => run(&mode, variants, |v| { let r = zrows(v); let h = hash_big(&r.concat()); (h, move || sagebrush_classgroup::api::hermite(&r)) }, |h| format!("{}:{}", n, hash_big(&h.concat()))),
            }
        }
        _ => {
            eprintln!("no native entry for {case_id}");
            std::process::exit(3);
        }
    }
}
