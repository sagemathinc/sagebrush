//! Native A \ b timing (numerics-core P2b-1; advisory, daybreak2's re-run binds): getrf + getrs on a fresh
//! seeded n x n A and n x r B per sample (the copy into the work buffers is outside the timed interval), the
//! first call reported apart, then R warm samples; median, p95, best, all samples, and the oracle (eta) first.
//!   cargo run --release -p sagebrush-nd --example solve_bench -- 16,64,256,1000 1 21 [selected|scalar]
use sagebrush_nd::gemm::Kernel;
use sagebrush_nd::lu::{getrf, getrf_work_len, getrs, solve_work_len};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let sizes: Vec<usize> = args.get(1).map_or("1000", |s| s).split(',').map(|x| x.parse().unwrap()).collect();
    let r: usize = args.get(2).map_or(1, |s| s.parse().unwrap());
    let reps: usize = args.get(3).map_or(21, |s| s.parse().unwrap());
    let kern = if args.get(4).map(String::as_str) == Some("scalar") { Kernel::Scalar } else { Kernel::selected() };
    for &n in &sizes {
        let mut s = 777u32 + n as u32;
        let mut rnd = || {
            s = s.wrapping_mul(1103515245).wrapping_add(12345);
            f64::from(s) / 4294967296.0 - 0.5
        };
        let a0: Vec<f64> = (0..n * n).map(|_| rnd()).collect();
        let b0: Vec<f64> = (0..n * r).map(|_| rnd()).collect();
        let (mut a, mut b) = (a0.clone(), b0.clone());
        let mut ipiv = vec![0usize; n];
        let mut work = vec![0.0; solve_work_len(n, r).unwrap().max(getrf_work_len(n, n).unwrap())];
        let mut once = |a: &mut [f64], b: &mut [f64]| {
            getrf(kern, a, n, n, n, &mut ipiv, &mut work).unwrap();
            getrs(kern, a, n, n, &ipiv, b, r, n, &mut work).unwrap();
        };
        let t0 = Instant::now();
        once(&mut a, &mut b);
        let first = t0.elapsed().as_secs_f64() * 1e3;
        // the oracle before any timing: eta = ||b - A x|| / (||A|| ||x|| + ||b||), inf-norm, column 0
        let an = (0..n).map(|i| (0..n).map(|j| a0[i + j * n].abs()).sum::<f64>()).fold(0.0, f64::max);
        let res = (0..n).map(|i| (b0[i] - (0..n).map(|p| a0[i + p * n] * b[p]).sum::<f64>()).abs()).fold(0.0, f64::max);
        let xn = b[..n].iter().fold(0.0f64, |m, v| m.max(v.abs()));
        let bn = b0[..n].iter().fold(0.0f64, |m, v| m.max(v.abs()));
        let eta = res / (an * xn + bn);
        assert!(eta <= 10.0 * n as f64 * f64::EPSILON / 2.0, "oracle failed: eta {eta:e}");
        let mut times = Vec::with_capacity(reps);
        for _ in 0..reps {
            a.copy_from_slice(&a0);
            b.copy_from_slice(&b0);
            let t0 = Instant::now();
            once(&mut a, &mut b);
            times.push(t0.elapsed().as_secs_f64() * 1e3);
        }
        let all = times.clone();
        times.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let med = times[reps / 2];
        let p95 = times[(((reps as f64) * 0.95).ceil() as usize).clamp(1, reps) - 1];
        let gf = (2.0 / 3.0 * (n as f64).powi(3) + 2.0 * (n as f64).powi(2) * r as f64) / (med * 1e6);
        println!(
            "{{\"kernel\":\"{}\",\"n\":{n},\"nrhs\":{r},\"eta\":{eta:e},\"first_ms\":{first:.4},\"median_ms\":{med:.4},\"p95_ms\":{p95:.4},\"best_ms\":{:.4},\"gflops\":{gf:.2},\"samples_ms\":{:?}}}",
            kern.name(),
            times[0],
            all.iter().map(|t| (t * 1e4).round() / 1e4).collect::<Vec<_>>()
        );
    }
}
