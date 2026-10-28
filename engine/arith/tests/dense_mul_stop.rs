//! The dense products ask for Stop about every 2^16 units of work whatever
//! the shape, in each kernel phase on its own (astra2's DENSE-1/DENSE-2):
//! - `zmat-dot`: ZMat::mul's i64/i128 dot loop (before: no check at all);
//! - `zmat-big-dot`: its BigInt loop, weighed by word products (before:
//!   one check per output row);
//! - `nmod-dot`: nmod_mat::Mat::mul's dot, in batches of at most 2^16
//!   (before: one check per output row);
//! - `nmod-transpose`: its transpose of B, polled by entry (a 1 x C B is
//!   one row).
//! For each case: the checks made **in that phase** (not in the scans
//! before it) are at least its work / 2^16; a Stop armed at the phase's
//! median check lands in that phase; the next product is exact.  Failures
//! are collected per case and reported together, so a mutant that removes
//! one kernel's polling fails exactly that kernel's cases.  One test: the
//! hooks and the flag are global to the process.

use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_mat::Mat;
use sagebrush_arith::zmat::ZMat;
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::hooks;

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

/// An r x c integer matrix with signed entries of `digits` decimal digits.
fn zm(s: &mut u64, r: usize, c: usize, digits: usize) -> ZMat {
    let d = (0..r * c)
        .map(|_| {
            let mut t = String::with_capacity(digits + 1);
            if rng(s) & 1 == 0 {
                t.push('-');
            }
            t.push((b'1' + (rng(s) % 9) as u8) as char);
            for _ in 1..digits {
                t.push((b'0' + (rng(s) % 10) as u8) as char);
            }
            t.parse::<BigInt>().unwrap()
        })
        .collect();
    ZMat { rows: r, cols: c, d }
}

fn nm(s: &mut u64, r: usize, c: usize, m: Modulus) -> Mat {
    let rows: Vec<Vec<u64>> = (0..r).map(|_| (0..c).map(|_| rng(s) % m.n).collect()).collect();
    Mat::from_rows(&rows, m)
}

/// The plain product, for reference (no polling involved).
fn zref(a: &ZMat, b: &ZMat) -> Vec<BigInt> {
    let mut d = vec![];
    for i in 0..a.rows {
        for j in 0..b.cols {
            let mut s = BigInt::from(0i64);
            for l in 0..a.cols {
                s += &a.d[i * a.cols + l] * &b.d[l * b.cols + j];
            }
            d.push(s);
        }
    }
    d
}

fn nref(a: &Mat, b: &Mat, p: u64) -> Vec<u64> {
    let (r, k, c) = (a.rows, a.cols, b.cols);
    let mut want = vec![];
    for i in 0..r {
        for j in 0..c {
            let mut acc = 0u128;
            for l in 0..k {
                acc = (acc + a.d[i * k + l] as u128 * b.d[l * c + j] as u128) % p as u128;
            }
            want.push(acc as u64);
        }
    }
    want
}

/// One case: `f` traced; the checks in `phase` at least `need`; a Stop at
/// the phase's median check lands there; then `f` again equals `want`.
/// Problems are pushed to `bad`, never panicking, so every case reports.
fn case<T: PartialEq + std::fmt::Debug>(bad: &mut Vec<String>, label: &str, phase: &str, need: u64, want: &T, f: impl Fn() -> T) {
    hooks::reset();
    hooks::trace();
    let got = f();
    let idx = hooks::traced(phase);
    let total = hooks::total();
    hooks::reset();
    eprintln!("{}: {} checks in {} (need {}), {} in all", label, idx.len(), phase, need, total);
    if &got != want {
        bad.push(format!("{}: the product differs from the reference", label));
        return;
    }
    if (idx.len() as u64) < need.max(1) {
        bad.push(format!("{}: {} checks in {}, want at least {}", label, idx.len(), phase, need.max(1)));
        return;
    }
    hooks::reset();
    hooks::arm_at(idx[idx.len() / 2]);
    let r = sagebrush_interrupt::catch(&f);
    let at = hooks::stopped_in();
    hooks::reset();
    sagebrush_interrupt::clear();
    if r.is_ok() {
        bad.push(format!("{}: a Stop armed at {}'s median check was not seen", label, phase));
    } else if at != phase {
        bad.push(format!("{}: the Stop landed in {} instead of {}", label, at, phase));
    }
    if &f() != want {
        bad.push(format!("{}: the next product differs", label));
    }
}

#[test]
fn dense_products_poll_in_every_kernel_phase() {
    let mut s = 0x9e3779b97f4a7c15u64;
    let mut bad = vec![];
    // ---- ZMat, the i64/i128 loop (9-digit entries): (r, k, c)
    for (label, r, k, c) in [
        ("zmat i64 1xKx1", 1, 1 << 16, 1),
        ("zmat i64 1xKxM", 1, 1 << 10, 1 << 8),
        ("zmat i64 square", 64, 64, 64),
        ("zmat i64 tall", 1 << 10, 16, 16),
        ("zmat i64 wide", 16, 16, 1 << 10),
    ] {
        let (a, b) = (zm(&mut s, r, k, 9), zm(&mut s, k, c, 9));
        let want = zref(&a, &b);
        case(&mut bad, label, "zmat-dot", (r * k * c) as u64 >> 16, &want, || a.mul(&b).d);
    }
    // ---- ZMat, the BigInt loop: 300-digit entries (997 bits: 16 x 16 word
    // products a multiply-add, weighed so)
    for (label, r, k, c) in [("zmat big 1xKx1", 1, 1 << 12, 1), ("zmat big 1xKxM", 1, 1 << 8, 1 << 4), ("zmat big square", 16, 16, 16)] {
        let (a, b) = (zm(&mut s, r, k, 300), zm(&mut s, k, c, 300));
        let want = zref(&a, &b);
        case(&mut bad, label, "zmat-big-dot", (r * k * c * 256) as u64 >> 16, &want, || a.mul(&b).d);
    }
    // ---- nmod_mat::Mat::mul: a small prime (overflow-safe batch 2^30
    // before) and a 63-bit one
    for p in [7u64, 9223372036854775783] {
        let m = Modulus::new(p);
        for (label, r, k, c) in [("nmod 1xKx1", 1, 1 << 18, 1), ("nmod 1xKxM", 1, 1 << 10, 1 << 8), ("nmod square", 64, 64, 64), ("nmod wide", 16, 16, 1 << 10)] {
            let (a, b) = (nm(&mut s, r, k, m), nm(&mut s, k, c, m));
            let want = nref(&a, &b, p);
            case(&mut bad, &format!("{} p={}", label, p), "nmod-dot", (r * k * c) as u64 >> 16, &want, || a.mul(&b).d);
        }
        // the transpose: B = 1 x C is one row (1 x 1 x C), and R x 1 x C
        for (label, r, c) in [("nmod transpose 1x1xC", 1, 1 << 18), ("nmod transpose Rx1xC", 4, 1 << 17)] {
            let (a, b) = (nm(&mut s, r, 1, m), nm(&mut s, 1, c, m));
            let want = nref(&a, &b, p);
            case(&mut bad, &format!("{} p={}", label, p), "nmod-transpose", c as u64 >> 16, &want, || a.mul(&b).d);
        }
    }
    // ---- empty dimensions (astra2 DENSE-R2-ZERO): R x 0 x C, R x K x 0,
    // 0 x K x C, and a large R x 0 x C: the exact shape, all zeros, and a
    // Stop requested beforehand still seen
    for (r, k, c) in [(5usize, 0usize, 7usize), (5, 3, 0), (0, 3, 7), (1 << 12, 0, 1 << 6)] {
        let (a, b) = (zm(&mut s, r, k, 9), zm(&mut s, k, c, 9));
        let z = a.mul(&b);
        if z.rows != r || z.cols != c || z.d.len() != r * c || z.d.iter().any(|x| *x != BigInt::from(0i64)) {
            bad.push(format!("zmat empty {}x{}x{}: not the {}x{} zero matrix", r, k, c, r, c));
        }
        sagebrush_interrupt::request();
        let e = sagebrush_interrupt::catch(|| a.mul(&b));
        sagebrush_interrupt::clear();
        if e.is_ok() {
            bad.push(format!("zmat empty {}x{}x{}: a pending Stop was not seen", r, k, c));
        }
        for p in [7u64, 9223372036854775783] {
            let m = Modulus::new(p);
            let a = Mat { rows: r, cols: k, m, d: (0..r * k).map(|_| rng(&mut s) % p).collect() };
            let b = Mat { rows: k, cols: c, m, d: (0..k * c).map(|_| rng(&mut s) % p).collect() };
            let z = a.mul(&b);
            if z.rows != r || z.cols != c || z.d.len() != r * c || z.d.iter().any(|&x| x != 0) {
                bad.push(format!("nmod empty {}x{}x{} p={}: not the {}x{} zero matrix", r, k, c, p, r, c));
            }
            sagebrush_interrupt::request();
            let e = sagebrush_interrupt::catch(|| a.mul(&b));
            sagebrush_interrupt::clear();
            if e.is_ok() {
                bad.push(format!("nmod empty {}x{}x{} p={}: a pending Stop was not seen", r, k, c, p));
            }
        }
    }
    assert!(bad.is_empty(), "{} problem(s):\n{}", bad.len(), bad.join("\n"));
}
