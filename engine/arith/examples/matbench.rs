//! Exact matrices over Z: Sagebrush (sagebrush-arith) against FLINT 3,
//! checking that the answers agree.  Usage: matbench [n ...]
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_bigint::BigInt;
use sagebrush_flint::FMat;
use std::time::Instant;

fn time<T, F: FnMut() -> T>(mut f: F) -> (f64, T) {
    let t = Instant::now();
    let mut n = 0;
    let mut out;
    loop {
        out = f();
        n += 1;
        if t.elapsed().as_secs_f64() > 0.3 {
            break;
        }
    }
    (t.elapsed().as_secs_f64() / n as f64, out)
}

fn main() {
    let sizes: Vec<usize> = std::env::args().skip(1).map(|s| s.parse().unwrap()).collect();
    let sizes = if sizes.is_empty() { vec![10, 30, 60, 100, 200] } else { sizes };
    let mut s = 0x1234_5678u64;
    let mut rnd = |range: u64| {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        BigInt::from((s % (2 * range + 1)) as i64 - range as i64)
    };
    println!("{:<10} {:>5} {:>6} {:>12} {:>12} {:>7}", "op", "n", "bits", "sagebrush", "flint", "ratio");
    for &n in &sizes {
        for range in [100u64, 1 << 40] {
            let d: Vec<BigInt> = (0..n * n).map(|_| rnd(range)).collect();
            let a = ZMat { rows: n, cols: n, d: d.clone() };
            let fa = FMat::new(n, n, &d);
            let bd: Vec<BigInt> = (0..n).map(|_| rnd(range)).collect();
            let b = ZMat { rows: n, cols: 1, d: bd.clone() };
            let fb = FMat::new(n, 1, &bd);
            let bits = 64 - range.leading_zeros();
            let row = |op: &str, ts: f64, tf: f64| {
                println!("{:<10} {:>5} {:>6} {:>10.3}ms {:>10.3}ms {:>7.2}", op, n, bits, ts * 1e3, tf * 1e3, ts / tf)
            };
            let (ts, x) = time(|| zmat::det(&a));
            let (tf, y) = time(|| fa.det());
            assert_eq!(x, y, "det");
            row("det", ts, tf);
            let (ts, x) = time(|| zmat::solve(&a, &b).unwrap());
            let (tf, y) = time(|| fb_solve(&fa, &fb));
            assert_eq!(x.0.d.iter().map(|v| v * &y.1).collect::<Vec<_>>(), y.0.iter().map(|v| v * &x.1).collect::<Vec<_>>(), "solve");
            row("solve", ts, tf);
            if n <= 100 {
                let (ts, x) = time(|| zmat::inverse(&a).unwrap());
                let (tf, y) = time(|| { let (m, den) = fa.inv().unwrap(); (m.entries(), den) });
                assert_eq!(x.0.d.iter().map(|v| v * &y.1).collect::<Vec<_>>(), y.0.iter().map(|v| v * &x.1).collect::<Vec<_>>(), "inverse");
                row("inverse", ts, tf);
                let (ts, x) = time(|| zmat::charpoly(&a));
                let (tf, y) = time(|| fa.charpoly());
                assert_eq!(x, y, "charpoly");
                row("charpoly", ts, tf);
            }
            // rank-deficient n x (n+5): rows n/2.. are combinations
            let r = n / 2;
            let left = ZMat { rows: n, cols: r, d: (0..n * r).map(|_| rnd(10)).collect() };
            let right = ZMat { rows: r, cols: n + 5, d: (0..r * (n + 5)).map(|_| rnd(range)).collect() };
            let c = left.mul(&right);
            let fc = FMat::new(c.rows, c.cols, &c.d);
            let (ts, x) = time(|| zmat::rref(&c));
            let (tf, y) = time(|| fc.rref());
            assert_eq!(x.2.len(), y.2, "rank");
            let fe = y.0.entries();
            for i in 0..x.2.len() {
                for j in 0..c.cols {
                    assert_eq!(x.0.get(i, j) * &y.1, &fe[i * c.cols + j] * &x.1, "rref");
                }
            }
            row("rref", ts, tf);
        }
    }
}

fn fb_solve(a: &FMat, b: &FMat) -> (Vec<BigInt>, BigInt) {
    let (m, den) = a.solve(b).unwrap();
    (m.entries(), den)
}
