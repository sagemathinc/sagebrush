//! Native GEMM timing (numerics-core P2a; advisory: daybreak2's re-run binds). For each n and thread count:
//! C = A * B on seeded inputs, R warm runs after one untimed, the median, p95 and best in ms, GFLOP/s at the
//! median, and the selected kernel. One JSON object per line.
//!   cargo run --release -p sagebrush-nd --features parallel --example gemm_bench -- 600,1000 1,8 21 [selected|scalar|neon]
use sagebrush_nd::gemm::{scratch_len, Kernel, Mat};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let sizes: Vec<usize> = args.get(1).map_or("1000", |s| s).split(',').map(|x| x.parse().unwrap()).collect();
    let threads: Vec<usize> = args.get(2).map_or("1", |s| s).split(',').map(|x| x.parse().unwrap()).collect();
    let reps: usize = args.get(3).map_or(21, |s| s.parse().unwrap());
    // (kernel: "selected" (default), "scalar", or "neon" on aarch64, which dispatch doesn't select yet)
    let kern = match args.get(4).map(String::as_str) {
        Some("scalar") => Kernel::Scalar,
        #[cfg(target_arch = "aarch64")]
        Some("neon") => Kernel::Neon,
        None | Some("selected") => Kernel::selected(),
        Some(other) => panic!("unknown kernel {other}"),
    };
    for &n in &sizes {
        let mut s = 12345u32;
        let mut rnd = || {
            s = s.wrapping_mul(1103515245).wrapping_add(12345);
            f64::from(s) / 4294967296.0 - 0.5
        };
        let av: Vec<f64> = (0..n * n).map(|_| rnd()).collect();
        let bv: Vec<f64> = (0..n * n).map(|_| rnd()).collect();
        let a = Mat::new(&av, n, n, n).unwrap();
        let b = Mat::new(&bv, n, n, n).unwrap();
        let mut c = vec![0.0; n * n];
        let mut scratch = vec![0.0; scratch_len()];
        for &t in &threads {
            // (1 thread: the kernel's blocking directly, as each thread runs it; more: engine/par, which needs
            // the `parallel` feature)
            let mut run = |c: &mut [f64]| {
                if t == 1 {
                    assert!(kern.gemm_cols(&a, &b, c, n, 0, n, &mut scratch));
                } else {
                    #[cfg(feature = "parallel")]
                    assert!(sagebrush_nd::gemm::gemm_on(kern, &a, &b, c, t));
                    #[cfg(not(feature = "parallel"))]
                    panic!("{t} threads need the parallel feature");
                }
            };
            run(&mut c);
            let mut times: Vec<f64> = (0..reps)
                .map(|_| {
                    let t0 = Instant::now();
                    run(&mut c);
                    t0.elapsed().as_secs_f64() * 1e3
                })
                .collect();
            times.sort_by(|x, y| x.partial_cmp(y).unwrap());
            let med = times[reps / 2];
            let p95 = times[(((reps as f64) * 0.95).ceil() as usize).clamp(1, reps) - 1];
            println!(
                "{{\"kernel\":\"{}\",\"n\":{n},\"threads\":{t},\"median_ms\":{med:.3},\"p95_ms\":{p95:.3},\"best_ms\":{:.3},\"gflops\":{:.2}}}",
                kern.name(),
                times[0],
                2.0 * (n as f64).powi(3) / (med * 1e6)
            );
        }
    }
}
