//! The dense products ask for Stop about every 2^16 units of work whatever
//! the shape (`ZMat::mul`'s i64/i128 and BigInt loops, `nmod_mat::Mat::mul`):
//! a 1 x K x 1 dot product, a 1 x K x M row, square, tall and wide.
//! - Density: a product of W units makes at least about W / 2^16 checks
//!   (before, ZMat's i64/i128 loop made none, its BigInt loop and nmod's
//!   one per output row).
//! - A Stop requested beforehand unwinds the i64/i128 loop (before, it
//!   returned Ok).
//! - A Stop armed at a middle check unwinds, and the next product is exact.
//! One test: the hooks and the flag are global to the process.

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

/// The checks `f` makes, uninterrupted, and its result.
fn traced<T>(f: impl FnOnce() -> T) -> (u64, T) {
    hooks::reset();
    hooks::trace();
    let r = f();
    let n = hooks::total();
    hooks::reset();
    (n, r)
}

/// `f` with a Stop armed at its middle check (out of `n`): it must unwind.
fn stops_midway<T>(label: &str, n: u64, f: impl FnOnce() -> T) {
    hooks::reset();
    hooks::arm_at((n / 2).max(1));
    let r = sagebrush_interrupt::catch(f);
    hooks::reset();
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "{}: a Stop armed at check {} of {} was not seen", label, n / 2, n);
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

#[test]
fn dense_products_poll_whatever_the_shape() {
    let mut s = 0x9e3779b97f4a7c15u64;
    // ---- ZMat, the i64/i128 loop (entries of 9 digits, under 30 bits): (r, k, c)
    for (label, r, k, c) in [
        ("zmat i64 1xKx1", 1, 1 << 16, 1),
        ("zmat i64 1xKxM", 1, 1 << 10, 1 << 8),
        ("zmat i64 square", 64, 64, 64),
        ("zmat i64 tall", 1 << 10, 16, 16),
        ("zmat i64 wide", 16, 16, 1 << 10),
    ] {
        let (a, b) = (zm(&mut s, r, k, 9), zm(&mut s, k, c, 9));
        let want = zref(&a, &b);
        let (n, p) = traced(|| a.mul(&b));
        assert_eq!(p.d, want, "{}: the product", label);
        let work = (r * k * c) as u64;
        eprintln!("{}: {} multiply-adds, {} checks", label, work, n);
        assert!(n >= work >> 16, "{}: {} checks for {} multiply-adds, want at least {}", label, n, work, work >> 16);
        // a Stop requested beforehand unwinds (the loop asked nothing before)
        sagebrush_interrupt::request();
        let r0 = sagebrush_interrupt::catch(|| a.mul(&b));
        sagebrush_interrupt::clear();
        assert!(r0.is_err(), "{}: a Stop requested beforehand was not seen", label);
        stops_midway(label, n, || a.mul(&b));
        assert_eq!(a.mul(&b).d, want, "{}: the next product", label);
    }
    // ---- ZMat, the BigInt loop: 1 x K x 1, 1 x K x M and square with
    // 300-digit entries (997 bits: 16 x 16 word products each, weighed so)
    for (label, r, k, c) in [("zmat big 1xKx1", 1, 1 << 12, 1), ("zmat big 1xKxM", 1, 1 << 8, 1 << 4), ("zmat big square", 16, 16, 16)] {
        let (a, b) = (zm(&mut s, r, k, 300), zm(&mut s, k, c, 300));
        let want = zref(&a, &b);
        let (n, p) = traced(|| a.mul(&b));
        assert_eq!(p.d, want, "{}: the product", label);
        let work = (r * k * c) as u64 * 16 * 16;
        eprintln!("{}: {} weighted units, {} checks", label, work, n);
        assert!(n >= work >> 16, "{}: {} checks for {} units, want at least {}", label, n, work, work >> 16);
        stops_midway(label, n, || a.mul(&b));
        assert_eq!(a.mul(&b).d, want, "{}: the next product", label);
    }
    // ---- nmod_mat::Mat::mul: a small prime and a 63-bit one
    for p in [7u64, 9223372036854775783] {
        let m = Modulus::new(p);
        for (label, r, k, c) in [("nmod 1xKx1", 1, 1 << 18, 1), ("nmod 1xKxM", 1, 1 << 10, 1 << 8), ("nmod square", 64, 64, 64), ("nmod wide", 16, 16, 1 << 10)] {
            let (a, b) = (nm(&mut s, r, k, m), nm(&mut s, k, c, m));
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
            let (n, prod) = traced(|| a.mul(&b));
            assert_eq!(prod.d, want, "{} p={}: the product", label, p);
            let work = (r * k * c) as u64;
            eprintln!("{} p={}: {} multiply-adds, {} checks", label, p, work, n);
            assert!(n >= work >> 16, "{} p={}: {} checks for {} multiply-adds, want at least {}", label, p, n, work, work >> 16);
            stops_midway(label, n, || a.mul(&b));
            assert_eq!(a.mul(&b).d, want, "{} p={}: the next product", label, p);
        }
    }
}
