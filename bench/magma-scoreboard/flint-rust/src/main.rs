//! Bench-only FLINT 3.6 adapter, reusing Sagebrush's Rust oracle bindings.
use sagebrush_bigint::BigInt;
use sagebrush_flint::{factor, FMat, FPoly};
use std::time::Instant;

const MOD: u64 = 1_000_000_007;

fn mod_decimal(x: &BigInt) -> u64 {
    let text = x.to_string();
    let (negative, digits) = if let Some(rest) = text.strip_prefix('-') {
        (true, rest)
    } else {
        (false, text.as_str())
    };
    let mut value = 0u64;
    for b in digits.bytes() {
        value = (value * 10 + u64::from(b - b'0')) % MOD;
    }
    if negative && value != 0 {
        MOD - value
    } else {
        value
    }
}

fn seq_hash(xs: &[BigInt]) -> u64 {
    xs.iter()
        .fold(17, |h, x| (h * 1_000_003 + mod_decimal(x)) % MOD)
}

fn seq_hash_u64(xs: &[u64]) -> u64 {
    xs.iter()
        .fold(17, |h, &x| (h * 1_000_003 + x % MOD) % MOD)
}

fn timed<T, F: FnMut() -> T>(repeats: usize, mut operation: F) -> (f64, T) {
    let started = Instant::now();
    let mut answer = operation();
    for _ in 1..repeats {
        answer = operation();
    }
    (started.elapsed().as_secs_f64() / repeats as f64, answer)
}

fn zpoly(n: usize, salt: i64) -> Vec<BigInt> {
    (0..n)
        .map(|i| {
            BigInt::from(
                (((i * i) as i64 * salt + 3 * i as i64 + 1) % 1_000_003) - 500_001,
            )
        })
        .collect()
}

fn mul_plain(a: &[BigInt], b: &[BigInt]) -> Vec<BigInt> {
    let mut out = vec![BigInt::from(0); a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            out[i + j] = &out[i + j] + x * y;
        }
    }
    out
}

fn factor_product(n: usize) -> Vec<BigInt> {
    let mut out = vec![BigInt::from(1)];
    for i in 1..=n {
        let q = vec![
            BigInt::from((i * i + i + 1) as i64),
            BigInt::from((i + 1) as i64),
            BigInt::from(1),
        ];
        out = mul_plain(&out, &q);
    }
    out
}

fn factor_sig(answer: &(BigInt, Vec<(Vec<BigInt>, u32)>)) -> String {
    let mut items: Vec<(u64, u64, u64)> = answer
        .1
        .iter()
        .map(|(f, e)| ((f.len() - 1) as u64, u64::from(*e), seq_hash(f)))
        .collect();
    items.sort();
    let flat: Vec<u64> = items.iter().flat_map(|&(a, b, c)| [a, b, c]).collect();
    format!("{}:{}", items.len(), seq_hash_u64(&flat))
}

fn pow_mod(mut a: u64, mut e: usize, m: u64) -> u64 {
    let mut out = 1u64;
    while e > 0 {
        if e & 1 == 1 {
            out = ((out as u128 * a as u128) % m as u128) as u64;
        }
        a = ((a as u128 * a as u128) % m as u128) as u64;
        e >>= 1;
    }
    out
}

fn zmat(n: usize) -> Vec<BigInt> {
    (0..n)
        .flat_map(|i| {
            (0..n).map(move |j| {
                BigInt::from(pow_mod((i + 2) as u64, j + 3, 1_000_003) as i64 - 500_001)
            })
        })
        .collect()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let case_id = args.next().expect("case id");
    let n: usize = args.next().expect("n").parse().unwrap();
    let repeats: usize = args.next().expect("repeats").parse().unwrap();

    let (seconds, signature) = match case_id.as_str() {
        "poly_z_mul" => {
            let a = FPoly::new(&zpoly(n, 11));
            let b = FPoly::new(&zpoly(n, 17));
            let (seconds, result) = timed(repeats, || a.mul(&b));
            let coefficients = result.coeffs();
            (
                seconds,
                format!("{}:{}", coefficients.len() - 1, seq_hash(&coefficients)),
            )
        }
        "poly_z_gcd" => {
            let g = zpoly(n / 2, 5);
            let ga = mul_plain(&g, &zpoly(n, 11));
            let gb = mul_plain(&g, &zpoly(n, 17));
            let a = FPoly::new(&ga);
            let b = FPoly::new(&gb);
            let (seconds, result) = timed(repeats, || a.gcd(&b));
            let coefficients = result.coeffs();
            (
                seconds,
                format!("{}:{}", coefficients.len() - 1, seq_hash(&coefficients)),
            )
        }
        "poly_z_factor" | "poly_z_factor_product" => {
            let f = if case_id == "poly_z_factor" {
                let mut coefficients = vec![BigInt::from(0); n + 1];
                coefficients[0] = BigInt::from(-1);
                coefficients[n] = BigInt::from(1);
                coefficients
            } else {
                factor_product(n)
            };
            let (seconds, result) = timed(repeats, || factor(&f));
            (seconds, factor_sig(&result))
        }
        "mat_z_det" => {
            let a = FMat::new(n, n, &zmat(n));
            let (seconds, result) = timed(repeats, || a.det_raw());
            (seconds, result.big().to_string())
        }
        "mat_z_rank" => {
            let a = FMat::new(n, n, &zmat(n));
            let (seconds, result) = timed(repeats, || a.rank());
            (seconds, result.to_string())
        }
        "mat_z_charpoly" => {
            let a = FMat::new(n, n, &zmat(n));
            let (seconds, result) = timed(repeats, || a.charpoly_poly());
            let coefficients = result.coeffs();
            (
                seconds,
                format!("{}:{}", coefficients.len() - 1, seq_hash(&coefficients)),
            )
        }
        _ => panic!("unsupported Rust FLINT case {case_id}"),
    };
    println!("RESULT|{seconds:.9}|{signature}");
}
