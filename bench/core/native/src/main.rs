//! Bench-only driver: the engine's own routines for the cases that have a
//! direct entry, called natively on the same inputs as the other drivers,
//! in the protocol of bench/core/drivers/common.py (`CASE N MODE`).  It
//! measures the engine itself; the Sage-mode driver measures what users
//! get, and the difference between the two is the cost of reaching the
//! engine.
use sagebrush_arith::cost::{metered, Meter};
use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_arith::{nmod_mat, nmod_poly, zpoly};
use sagebrush_bigint::BigInt;
use std::time::Instant;

const MOD: u64 = 1_000_000_007;
const P: u64 = 65537;
const P31: u64 = 2_147_483_647;

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

/// The smallest positive step Instant shows (seconds): protocol 5's timer
/// granularity.
fn timer_granularity() -> f64 {
    let (mut best, mut last) = (f64::INFINITY, Instant::now());
    for _ in 0..2000 {
        let now = Instant::now();
        let d = now.duration_since(last).as_secs_f64();
        if d > 0.0 && d < best {
            best = d;
        }
        last = now;
    }
    if best.is_finite() { best } else { 1e-9 }
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
    if mode == "units" {
        // (spec: each variant built and run once, untimed, inside a metered
        // region on an accounting meter with no bound; one line per variant,
        // the 10 families in Family order, then the meter's total.  A row
        // whose engine code charges nothing prints UNITS|unmetered.  Work on
        // other threads is not counted (the tally is per thread): run.py
        // compares 1 thread with N to catch that.)
        let mut lines = Vec::with_capacity(variants);
        let mut any = false;
        for v in 0..variants {
            let mut op = build(v).1;
            let mut meter = Meter::accounting(u64::MAX);
            std::hint::black_box(metered(&mut meter, || op()));
            let u = meter.units();
            any |= meter.used() > 0;
            lines.push(format!("UNITS|{}|{}|{}", v, u.0.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","), meter.used()));
        }
        if any {
            for line in lines {
                println!("{line}");
            }
        } else {
            println!("UNITS|unmetered");
        }
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
    // (protocol 5, drivers/common.py: per-op mode at or above
    // max(1 ms, 1000 g), else batched from seeded offsets; a TIMING record
    // before the TIME line)
    let seed: u64 = std::env::var("BENCH_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let forced = std::env::var("BENCH_TIMING").unwrap_or_else(|_| "auto".to_string());
    let g = timer_granularity();
    let threshold = 1e-3f64.max(1000.0 * g);
    let offset = |j: usize| ((seed as u128 * 1_000_003 + j as u128 * 7919) % variants as u128) as usize;
    let per = warm / variants as f64;
    let head = format!("\"granularity\":{:e},\"threshold\":{:e},\"seed\":{},\"k\":{}", g, threshold, seed, variants);
    let mut per_op_samples: Option<Vec<Vec<f64>>> = None;
    let (record, med, lo, hi, k, count) = if forced == "per-op" || (forced == "auto" && per >= threshold) {
        let rotations = if per <= 2.0 { 5 } else { 3 };
        let mut samples: Vec<Vec<f64>> = vec![Vec::with_capacity(rotations); variants];
        for r in 0..rotations {
            let start = offset(r);
            for i in 0..variants {
                let v = (start + i) % variants;
                let started = Instant::now();
                std::hint::black_box(ops[v]());
                samples[v].push(started.elapsed().as_secs_f64());
            }
        }
        let mut means: Vec<f64> = (0..rotations).map(|r| samples.iter().map(|s| s[r]).sum::<f64>() / variants as f64).collect();
        means.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let rows: Vec<String> = samples.iter().map(|s| format!("[{}]", s.iter().map(|x| format!("{:e}", x)).collect::<Vec<_>>().join(","))).collect();
        let record = format!("{{{},\"mode\":\"per-op\",\"samples\":[{}]", head, rows.join(","));
        per_op_samples = Some(samples);
        (record, means[rotations / 2], means[0], means[rotations - 1], variants, rotations)
    } else {
        let mut reps = |start: usize, k: usize| {
            let mut total = 0.0;
            for i in 0..k {
                let op = &mut ops[(start + i) % variants];
                let started = Instant::now();
                std::hint::black_box(op());
                total += started.elapsed().as_secs_f64();
            }
            total
        };
        let (mut k, mut t) = if per >= TARGET {
            (1usize, per)
        } else {
            let k = if per > 0.0 { ((TARGET * 1.2 / per) as usize + 1).max(1) } else { variants };
            (k, reps(0, k))
        };
        while t < TARGET && k < 1 << 24 {
            k = if t <= 0.0 { 2 * k } else { (2 * k).max((16 * k).min((k as f64 * TARGET * 1.2 / t) as usize + 1)) };
            t = reps(0, k);
        }
        let count = if t / k as f64 <= 2.0 { 5 } else { 3 };
        let offsets: Vec<usize> = (0..count).map(offset).collect();
        let batches: Vec<f64> = offsets.iter().map(|&o| reps(o, k) / k as f64).collect();
        let mut sorted = batches.clone();
        sorted.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let record = format!(
            "{{{},\"mode\":\"batched\",\"reps\":{},\"batches\":[{}],\"offsets\":[{}]",
            head,
            k,
            batches.iter().map(|x| format!("{:e}", x)).collect::<Vec<_>>().join(","),
            offsets.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")
        );
        (record, sorted[count / 2], sorted[0], sorted[count - 1], k, count)
    };
    // (the per-variant pass, BENCH_VTIME=1 on the calibrated targets: each
    // variant on its own, its per-op samples when one operation takes at
    // least TARGET, else repetitions calibrated to TARGET and 3 samples)
    let vtime = if std::env::var("BENCH_VTIME").as_deref() == Ok("1") {
        let mut entries = Vec::with_capacity(variants);
        for (v, op) in ops.iter_mut().enumerate() {
            let reused = per_op_samples.as_ref().map(|s| s[v].clone()).filter(|s| s.iter().all(|&x| x >= TARGET));
            let (mut xs, reps) = match reused {
                Some(s) => (s, 1usize),
                None => {
                    let mut timed = |n: usize| {
                        let started = Instant::now();
                        for _ in 0..n {
                            std::hint::black_box(op());
                        }
                        started.elapsed().as_secs_f64()
                    };
                    let one = timed(1);
                    let (mut n, mut t) = if one >= TARGET { (1usize, one) } else {
                        let n = if one > 0.0 { ((TARGET * 1.2 / one) as usize + 1).max(1) } else { 2 };
                        (n, timed(n))
                    };
                    while t < TARGET && n < 1 << 24 {
                        n = if t <= 0.0 { 2 * n } else { (2 * n).max((16 * n).min((n as f64 * TARGET * 1.2 / t) as usize + 1)) };
                        t = timed(n);
                    }
                    ((0..3).map(|_| timed(n) / n as f64).collect(), n)
                }
            };
            xs.sort_by(|x, y| x.partial_cmp(y).unwrap());
            entries.push(format!(
                "{{\"v\":{},\"seconds\":{:e},\"min\":{:e},\"max\":{:e},\"reps\":{},\"samples\":{}}}",
                v,
                xs[xs.len() / 2],
                xs[0],
                xs[xs.len() - 1],
                reps,
                xs.len()
            ));
        }
        format!(",\"vtime\":[{}]", entries.join(","))
    } else {
        String::new()
    };
    println!("TIMING|{}{}}}", record, vtime);
    let joined = sigs.join(";");
    let combined = format!("{}:{}", variants, hash_u64(&joined.bytes().map(u64::from).collect::<Vec<_>>()));
    println!("TIME|{:.9e}|{}|{:.9e}|{:.9e}|{}|{}", med, combined, lo, hi, k, count);
}

/// The dense factoring rows' input (drivers/sagebrush_case.py's dense_poly):
/// monic of degree n, coefficients from a 64-bit LCG, residues mod 65537
/// (fp) or integers in [-1000, 1000].
fn dense_poly(n: usize, fp: bool, v: usize) -> Vec<i64> {
    let mut s: u64 = 1_000_003 * if fp { 1 } else { 2 } + 7919 * v as u64 + 12345;
    let mut out: Vec<i64> = (0..n)
        .map(|_| {
            s = s.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            let r = s >> 33;
            if fp { (r % 65537) as i64 } else { (r % 2001) as i64 - 1000 }
        })
        .collect();
    out.push(1);
    out
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
        "poly_fp_factor_dense" => run(&mode, variants, |v| {
            let c = dense_poly(n, true, v);
            let f: Vec<BigInt> = c.iter().map(|&x| BigInt::from(x)).collect();
            let fp: Vec<u64> = c.iter().map(|&x| x as u64).collect();
            (hash_u64(&fp), move || sagebrush_poly::factor_mod(&f, P))
        }, |r| factor_sig(r, |c: &Vec<u64>| ((c.len() - 1) as u64, hash_u64(c)))),
        "poly_z_factor_dense" => run(&mode, variants, |v| {
            let f: Vec<BigInt> = dense_poly(n, false, v).into_iter().map(BigInt::from).collect();
            (hash_big(&f), move || sagebrush_poly::factor(&f))
        }, |r| factor_sig(&r.1, |c: &Vec<BigInt>| ((c.len() - 1) as u64, hash_big(c)))),
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
        "mat_fp_det" | "mat_fp_rank" | "mat_fp_charpoly" | "mat_fp31_det" | "mat_fp31_rank" | "mat_fp31_charpoly" => {
            // (mat_fp31_*: the same rows modulo 2^31 - 1, a word-size prime)
            let pm = if case_id.starts_with("mat_fp31_") { P31 } else { P };
            let fp = |v: usize| {
                let rows: Vec<Vec<u64>> = entries(n, pm, 0, v).into_iter().map(|r| r.into_iter().map(|x| x as u64).collect()).collect();
                (hash_u64(&rows.concat()), nmod_mat::Mat::from_rows(&rows, Modulus::new(pm)))
            };
            match case_id.trim_start_matches("mat_fp31_").trim_start_matches("mat_fp_") {
                "det" => run(&mode, variants, |v| { let (h, a) = fp(v); (h, move || a.det()) }, |d| d.to_string()),
                "rank" => run(&mode, variants, |v| { let (h, a) = fp(v); (h, move || a.rank()) }, |r| r.to_string()),
                _ => run(&mode, variants, |v| { let (h, a) = fp(v); (h, move || a.charpoly()) }, |c| poly_sig(c)),
            }
        }
        "mat_fp_solve" | "mat_fp31_solve" => run(&mode, variants, |v| {
            let pm = if case_id.starts_with("mat_fp31_") { P31 } else { P };
            let rows: Vec<Vec<u64>> = entries(n, pm, 0, v).into_iter().map(|r| r.into_iter().map(|x| x as u64).collect()).collect();
            let rhs: Vec<u64> = (1..=n as u64).collect();
            let h = hash_u64(&[rows.concat(), rhs.clone()].concat());
            let a = nmod_mat::Mat::from_rows(&rows, Modulus::new(pm));
            let b = nmod_mat::Mat::from_rows(&rhs.iter().map(|&x| vec![x]).collect::<Vec<_>>(), Modulus::new(pm));
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
        "mat_z_rank_wide" | "mat_z_rank_def" | "mat_z_rank_def_p" => run(&mode, variants, |v| {
            let (cols, entries) = rank_matrix(&case_id, n, v);
            let h = hash_big(&entries);
            let a = ZMat::from_rows(entries.chunks(cols).map(|r| r.to_vec()).collect());
            (h, move || zmat::rank(&a))
        }, |r| r.to_string()),
        _ => {
            eprintln!("no native entry for {case_id}");
            std::process::exit(3);
        }
    }
}
