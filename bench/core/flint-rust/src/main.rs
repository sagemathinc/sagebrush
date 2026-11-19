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

/// One invocation in the drivers' protocol (bench/core/drivers/common.py):
/// `build(v)` makes variant v's operands and operation; `inputs` hashes the
/// variants' operand hashes, `once` times variant 0 once, `time` runs every
/// variant once untimed, then cycles through them (repetitions calibrated to
/// at least TARGET seconds a sample, SAMPLES samples) and prints the
/// combined signature.  No row of this driver needs `time-fresh`.
fn run<T, F: FnMut() -> T>(mode: &str, variants: usize, mut build: impl FnMut(usize) -> (Vec<BigInt>, F), sig: impl Fn(&T) -> String) {
    const TARGET: f64 = 0.2;
    if mode == "inputs" {
        let hs: Vec<u64> = (0..variants).map(|v| seq_hash(&build(v).0)).collect();
        println!("INPUTS|{}", seq_hash_u64(&hs));
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
    let combined = format!("{}:{}", variants, seq_hash_u64(&joined.bytes().map(u64::from).collect::<Vec<_>>()));
    println!("TIME|{:.9e}|{}|{:.9e}|{:.9e}|{}|{}", samples[count / 2], combined, samples[0], samples[count - 1], k, count);
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

fn factor_product(n: usize, v: usize) -> Vec<BigInt> {
    let mut out = vec![BigInt::from(1)];
    for i in 1..=n {
        let q = vec![
            BigInt::from((i * i + i + 1 + v) as i64),
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

/// Variant v of the Sage driver's det_input over Z: node i + 2 + v.
fn zmat(n: usize, v: usize) -> Vec<BigInt> {
    (0..n)
        .flat_map(|i| {
            (0..n).map(move |j| {
                BigInt::from(pow_mod((i + 2 + v) as u64, j + 3, 1_000_003) as i64 - 500_001)
            })
        })
        .collect()
}


/// The rank rows beyond the square ones (expected_inputs.py's formulas, which
/// also certify the ranks): wide R(n x 2n); def R(n x n/2) R(n/2 x n); def_p
/// R(n x n) diag(1, ..., 1, p) R(n x n), p = 2^62 - 57.  The entries stay
/// below 2^110 in absolute value (def_p at n = 250), so i128 holds them.
const RANK_P: i128 = (1i128 << 62) - 57;

fn rank_rnd(rows: usize, cols: usize, s: u64) -> Vec<Vec<i128>> {
    (0..rows)
        .map(|i| (0..cols).map(|j| pow_mod(131 * i as u64 + 31 * j as u64 + s, 5, 1_000_003) as i128 - 500_001).collect())
        .collect()
}

fn rank_matmul(a: &[Vec<i128>], b: &[Vec<i128>]) -> Vec<Vec<i128>> {
    let cols = b[0].len();
    a.iter()
        .map(|row| {
            let mut out = vec![0i128; cols];
            for (x, brow) in row.iter().zip(b) {
                for (o, y) in out.iter_mut().zip(brow) {
                    *o += x * y;
                }
            }
            out
        })
        .collect()
}

/// (columns, entries row-major) of a wide, def or def_p row's integer matrix.
fn rank_matrix(case: &str, n: usize, v: usize) -> (usize, Vec<BigInt>) {
    let (s1, s2) = (10 * v as u64 + 1, 10 * v as u64 + 2);
    let a = if case.ends_with("_wide") {
        rank_rnd(n, 2 * n, s1)
    } else if case.ends_with("_def") {
        let r = n / 2;
        rank_matmul(&rank_rnd(n, r, s1), &rank_rnd(r, n, s2))
    } else {
        let mut c = rank_rnd(n, n, s2);
        for x in c[n - 1].iter_mut() {
            *x *= RANK_P;
        }
        rank_matmul(&rank_rnd(n, n, s1), &c)
    };
    let cols = a[0].len();
    (cols, a.concat().iter().map(|x| x.to_string().parse().expect("an integer")).collect())
}

extern "C" {
    // FLINT's own thread count (its public interface; the static library is
    // already linked through sagebrush-flint)
    fn flint_set_num_threads(num_threads: std::os::raw::c_int);
}

fn main() {
    // (1, or N for the flint-n backend: run.py sets BENCH_THREADS)
    let threads: i32 = std::env::var("BENCH_THREADS").ok().and_then(|t| t.parse().ok()).unwrap_or(1);
    // SAFETY: called once, before any FLINT call, with a positive count, as
    // FLINT's documentation allows
    unsafe { flint_set_num_threads(threads.max(1)) };
    let mut args = std::env::args().skip(1);
    let case_id = args.next().expect("case id");
    let n: usize = args.next().expect("n").parse().unwrap();
    let mode = args.next().expect("mode");
    let variants: usize = args.next().map_or(1, |k| k.parse().expect("K"));
    assert!(variants >= 1, "K must be at least 1");
    let poly_sig = |c: &Vec<BigInt>| format!("{}:{}", c.len() - 1, seq_hash(c));
    // (variants: salts + 6 v, matrix nodes + v, the factor product's
    // constant terms + v; rows with one input are run with K = 1)
    let salt = |s: i64, v: usize| s + 6 * v as i64;
    match case_id.as_str() {
        "poly_z_mul" => run(&mode, variants, |v| {
            let (za, zb) = (zpoly(n, salt(11, v)), zpoly(n, salt(17, v)));
            let (a, b) = (FPoly::new(&za), FPoly::new(&zb));
            ([za, zb].concat(), move || a.mul(&b).coeffs())
        }, poly_sig),
        "poly_z_gcd" => run(&mode, variants, |v| {
            let g = zpoly(n / 2, salt(5, v));
            let ga = mul_plain(&g, &zpoly(n, salt(11, v)));
            let gb = mul_plain(&g, &zpoly(n, salt(17, v)));
            let (a, b) = (FPoly::new(&ga), FPoly::new(&gb));
            ([ga, gb].concat(), move || a.gcd(&b).coeffs())
        }, poly_sig),
        "poly_z_factor" | "poly_z_factor_product" => run(&mode, variants, |v| {
            let f = if case_id == "poly_z_factor" {
                let mut coefficients = vec![BigInt::from(0); n + 1];
                coefficients[0] = BigInt::from(-1);
                coefficients[n] = BigInt::from(1);
                coefficients
            } else {
                factor_product(n, v)
            };
            let g = f.clone();
            (f, move || factor(&g))
        }, factor_sig),
        "mat_z_det" => run(&mode, variants, |v| {
            let entries = zmat(n, v);
            let a = FMat::new(n, n, &entries);
            (entries, move || a.det_raw().big().to_string())
        }, |s: &String| s.clone()),
        "mat_z_rank" => run(&mode, variants, |v| {
            let entries = zmat(n, v);
            let a = FMat::new(n, n, &entries);
            (entries, move || a.rank())
        }, |r: &usize| r.to_string()),
        "mat_z_charpoly" => run(&mode, variants, |v| {
            let entries = zmat(n, v);
            let a = FMat::new(n, n, &entries);
            (entries, move || a.charpoly_poly().coeffs())
        }, poly_sig),
        "mat_z_rank_wide" | "mat_z_rank_def" | "mat_z_rank_def_p" => run(&mode, variants, |v| {
            let (cols, entries) = rank_matrix(&case_id, n, v);
            let a = FMat::new(n, cols, &entries);
            (entries, move || a.rank())
        }, |r: &usize| r.to_string()),
        _ => panic!("unsupported Rust FLINT case {case_id}"),
    }
}
