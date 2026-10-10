//! Factoring in Z[x] with FLINT (`fmpz_poly_factor`, van Hoeij's
//! algorithm), and integer matrices and polynomials ([`FMat`], [`FPoly`])
//! as references for the Sagebrush tests and benchmarks.  This crate's own
//! code is MIT OR Apache-2.0 (its Cargo.toml), but it links FLINT, which is
//! LGPL-3.0-or-later, so whatever links it is bound by the LGPL: only
//! sagebrush-oracle (tests and benchmarks) does, never a distributed
//! package (scripts/third-party-notices.mjs fails if one would).
//!
//! Polynomials cross the boundary as FLINT's string format
//! ("len  c0 c1 ... c_{len-1}"), so nothing depends on FLINT's internal
//! integer representation.

use sagebrush_bigint::BigInt;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_long, c_void};

#[repr(C)]
struct FmpzPoly {
    coeffs: *mut c_long,
    alloc: c_long,
    length: c_long,
}

#[repr(C)]
struct FmpzPolyFactor {
    c: c_long,
    p: *mut FmpzPoly,
    exp: *mut c_long,
    num: c_long,
    alloc: c_long,
}

extern "C" {
    fn fmpz_poly_init(poly: *mut FmpzPoly);
    fn fmpz_poly_clear(poly: *mut FmpzPoly);
    fn fmpz_poly_set_str(poly: *mut FmpzPoly, s: *const c_char) -> c_int;
    fn fmpz_poly_get_str(poly: *const FmpzPoly) -> *mut c_char;
    fn fmpz_poly_factor_init(fac: *mut FmpzPolyFactor);
    fn fmpz_poly_factor_clear(fac: *mut FmpzPolyFactor);
    fn fmpz_poly_factor(fac: *mut FmpzPolyFactor, g: *const FmpzPoly);
    fn fmpz_get_str(s: *mut c_char, base: c_int, f: *const c_long) -> *mut c_char;
    fn flint_free(p: *mut c_void);
    fn fmpz_init(f: *mut c_long);
    fn fmpz_clear(f: *mut c_long);
    fn fmpz_set_str(f: *mut c_long, s: *const c_char, base: c_int) -> c_int;
    fn fmpz_mat_init(mat: *mut FmpzMat, r: c_long, c: c_long);
    fn fmpz_mat_clear(mat: *mut FmpzMat);
    fn fmpz_mat_entry(mat: *const FmpzMat, i: c_long, j: c_long) -> *mut c_long;
    fn fmpz_mat_det(det: *mut c_long, a: *const FmpzMat);
    fn fmpz_mat_rref(b: *mut FmpzMat, den: *mut c_long, a: *const FmpzMat) -> c_long;
    fn fmpz_mat_inv(b: *mut FmpzMat, den: *mut c_long, a: *const FmpzMat) -> c_int;
    fn fmpz_mat_solve(x: *mut FmpzMat, den: *mut c_long, a: *const FmpzMat, b: *const FmpzMat) -> c_int;
    fn fmpz_mat_charpoly(cp: *mut FmpzPoly, a: *const FmpzMat);
    fn fmpz_mat_rank(a: *const FmpzMat) -> c_long;
    fn fmpz_mat_mul(c: *mut FmpzMat, a: *const FmpzMat, b: *const FmpzMat);
    fn fmpz_poly_mul(r: *mut FmpzPoly, a: *const FmpzPoly, b: *const FmpzPoly);
    fn fmpz_poly_gcd(r: *mut FmpzPoly, a: *const FmpzPoly, b: *const FmpzPoly);
}

#[repr(C)]
struct FmpzMat {
    entries: *mut c_long,
    r: c_long,
    c: c_long,
    stride: c_long,
}

/// An integer as FLINT's fmpz, read back as a BigInt.
fn fmpz_big(f: *const c_long) -> BigInt {
    // SAFETY: f points to an initialized fmpz.
    take_string(unsafe { fmpz_get_str(std::ptr::null_mut(), 10, f) }).parse().unwrap()
}

/// A scalar fmpz on the stack.
struct Fmpz(c_long);

impl Fmpz {
    fn new() -> Fmpz {
        let mut f = Fmpz(0);
        // SAFETY: fmpz_init writes the zero representation.
        unsafe { fmpz_init(&mut f.0) };
        f
    }
    fn big(&self) -> BigInt {
        fmpz_big(&self.0)
    }
}

impl Drop for Fmpz {
    fn drop(&mut self) {
        // SAFETY: initialized by fmpz_init.
        unsafe { fmpz_clear(&mut self.0) };
    }
}

/// A FLINT integer matrix (fmpz_mat), for comparisons and benchmarks.
pub struct FMat {
    m: FmpzMat,
}

impl FMat {
    pub fn zero(rows: usize, cols: usize) -> FMat {
        // SAFETY: fmpz_mat_init allocates and zeroes the matrix.
        unsafe {
            let mut m = std::mem::zeroed::<FmpzMat>();
            fmpz_mat_init(&mut m, rows as c_long, cols as c_long);
            FMat { m }
        }
    }

    /// From row-major entries.
    pub fn new(rows: usize, cols: usize, d: &[BigInt]) -> FMat {
        let a = FMat::zero(rows, cols);
        for i in 0..rows {
            for j in 0..cols {
                let cs = CString::new(d[i * cols + j].to_string()).unwrap();
                // SAFETY: (i, j) is in range; the entry is an initialized fmpz.
                unsafe { assert_eq!(fmpz_set_str(fmpz_mat_entry(&a.m, i as c_long, j as c_long), cs.as_ptr(), 10), 0) };
            }
        }
        a
    }

    pub fn rows(&self) -> usize {
        self.m.r as usize
    }

    pub fn cols(&self) -> usize {
        self.m.c as usize
    }

    /// Row-major entries.
    pub fn entries(&self) -> Vec<BigInt> {
        let mut v = vec![];
        for i in 0..self.m.r {
            for j in 0..self.m.c {
                // SAFETY: in range.
                v.push(fmpz_big(unsafe { fmpz_mat_entry(&self.m, i, j) }));
            }
        }
        v
    }

    pub fn det(&self) -> BigInt {
        let mut d = Fmpz::new();
        // SAFETY: square matrix (FLINT aborts otherwise).
        unsafe { fmpz_mat_det(&mut d.0, &self.m) };
        d.big()
    }

    /// (B, den, rank) with B / den the reduced row echelon form.
    pub fn rref(&self) -> (FMat, BigInt, usize) {
        let mut b = FMat::zero(self.rows(), self.cols());
        let mut den = Fmpz::new();
        // SAFETY: b has the shape of self.
        let r = unsafe { fmpz_mat_rref(&mut b.m, &mut den.0, &self.m) };
        (b, den.big(), r as usize)
    }

    pub fn inv(&self) -> Option<(FMat, BigInt)> {
        let mut b = FMat::zero(self.rows(), self.cols());
        let mut den = Fmpz::new();
        // SAFETY: shapes match.
        let ok = unsafe { fmpz_mat_inv(&mut b.m, &mut den.0, &self.m) };
        if ok == 0 {
            None
        } else {
            Some((b, den.big()))
        }
    }

    pub fn solve(&self, rhs: &FMat) -> Option<(FMat, BigInt)> {
        let mut x = FMat::zero(self.cols(), rhs.cols());
        let mut den = Fmpz::new();
        // SAFETY: shapes match.
        let ok = unsafe { fmpz_mat_solve(&mut x.m, &mut den.0, &self.m, &rhs.m) };
        if ok == 0 {
            None
        } else {
            Some((x, den.big()))
        }
    }

    pub fn rank(&self) -> usize {
        // SAFETY: valid matrix.
        unsafe { fmpz_mat_rank(&self.m) as usize }
    }

    pub fn mul(&self, o: &FMat) -> FMat {
        let mut c = FMat::zero(self.rows(), o.cols());
        // SAFETY: shapes match.
        unsafe { fmpz_mat_mul(&mut c.m, &self.m, &o.m) };
        c
    }

    /// det(x I - self), constant term first.
    pub fn charpoly(&self) -> Vec<BigInt> {
        // SAFETY: init/clear pair; square matrix.
        unsafe {
            let mut cp = std::mem::zeroed::<FmpzPoly>();
            fmpz_poly_init(&mut cp);
            fmpz_mat_charpoly(&mut cp, &self.m);
            let v = parse_poly(&take_string(fmpz_poly_get_str(&cp)));
            fmpz_poly_clear(&mut cp);
            v
        }
    }
}

impl Drop for FMat {
    fn drop(&mut self) {
        // SAFETY: initialized by fmpz_mat_init.
        unsafe { fmpz_mat_clear(&mut self.m) };
    }
}

/// A FLINT integer polynomial (fmpz_poly), constant term first.
pub struct FPoly {
    p: FmpzPoly,
}

impl FPoly {
    pub fn new(f: &[BigInt]) -> FPoly {
        let text = format!("{}  {}", f.len(), f.iter().map(|c| c.to_string()).collect::<Vec<_>>().join(" "));
        let cs = CString::new(text).unwrap();
        // SAFETY: init then set from a well-formed string.
        unsafe {
            let mut p = std::mem::zeroed::<FmpzPoly>();
            fmpz_poly_init(&mut p);
            assert_eq!(fmpz_poly_set_str(&mut p, cs.as_ptr()), 0);
            FPoly { p }
        }
    }

    fn empty() -> FPoly {
        // SAFETY: init.
        unsafe {
            let mut p = std::mem::zeroed::<FmpzPoly>();
            fmpz_poly_init(&mut p);
            FPoly { p }
        }
    }

    pub fn coeffs(&self) -> Vec<BigInt> {
        // SAFETY: valid polynomial.
        parse_poly(&take_string(unsafe { fmpz_poly_get_str(&self.p) }))
    }

    pub fn mul(&self, o: &FPoly) -> FPoly {
        let mut r = FPoly::empty();
        // SAFETY: valid polynomials.
        unsafe { fmpz_poly_mul(&mut r.p, &self.p, &o.p) };
        r
    }

    /// The gcd with positive leading coefficient.
    pub fn gcd(&self, o: &FPoly) -> FPoly {
        let mut r = FPoly::empty();
        // SAFETY: valid polynomials.
        unsafe { fmpz_poly_gcd(&mut r.p, &self.p, &o.p) };
        r
    }
}

impl Drop for FPoly {
    fn drop(&mut self) {
        // SAFETY: initialized by fmpz_poly_init.
        unsafe { fmpz_poly_clear(&mut self.p) };
    }
}

fn take_string(p: *mut c_char) -> String {
    // SAFETY: FLINT returns a NUL-terminated string allocated with flint_malloc.
    let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    unsafe { flint_free(p as *mut c_void) };
    s
}

fn parse_poly(s: &str) -> Vec<BigInt> {
    let mut it = s.split_whitespace();
    let len: usize = it.next().map_or(0, |t| t.parse().unwrap());
    let v: Vec<BigInt> = it.map(|t| t.parse().unwrap()).collect();
    assert_eq!(v.len(), len, "unexpected FLINT polynomial string {:?}", s);
    v
}

/// Factors f (coefficients constant term first, f != 0) as
/// content * prod g_i^{e_i} with g_i irreducible and primitive with
/// positive leading coefficient; returns (content, [(g_i, e_i)]).
pub fn factor(f: &[BigInt]) -> (BigInt, Vec<(Vec<BigInt>, u32)>) {
    let mut f = f.to_vec();
    while f.len() > 1 && f.last().map_or(false, |c| c.sign() == sagebrush_bigint::Sign::NoSign) {
        f.pop();
    }
    let text = format!("{}  {}", f.len(), f.iter().map(|c| c.to_string()).collect::<Vec<_>>().join(" "));
    let cs = CString::new(text).unwrap();
    // SAFETY: init/clear pairs on stack values, FLINT owns their storage.
    unsafe {
        let mut poly = std::mem::zeroed::<FmpzPoly>();
        fmpz_poly_init(&mut poly);
        assert_eq!(fmpz_poly_set_str(&mut poly, cs.as_ptr()), 0, "FLINT rejected the polynomial");
        let mut fac = std::mem::zeroed::<FmpzPolyFactor>();
        fmpz_poly_factor_init(&mut fac);
        fmpz_poly_factor(&mut fac, &poly);
        let content: BigInt = take_string(fmpz_get_str(std::ptr::null_mut(), 10, &fac.c)).parse().unwrap();
        let mut out = vec![];
        for i in 0..fac.num as usize {
            let g = parse_poly(&take_string(fmpz_poly_get_str(fac.p.add(i))));
            out.push((g, *fac.exp.add(i) as u32));
        }
        fmpz_poly_factor_clear(&mut fac);
        fmpz_poly_clear(&mut poly);
        (content, out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn z(v: &[i64]) -> Vec<BigInt> {
        v.iter().map(|&x| BigInt::from(x)).collect()
    }

    #[test]
    fn factors_small_polynomials() {
        // 2 (x - 1)^2 (x^2 + 1) = 2x^4 - 4x^3 + 4x^2 - 4x + 2
        let (c, mut fs) = factor(&z(&[2, -4, 4, -4, 2]));
        fs.sort();
        assert_eq!(c, BigInt::from(2));
        assert_eq!(fs, vec![(z(&[-1, 1]), 2), (z(&[1, 0, 1]), 1)]);
        // x^3 - x^2 - 6x = x (x - 3)(x + 2): the T_2 charpoly at level 37
        let (_, fs) = factor(&z(&[0, -6, -1, 1]));
        assert_eq!(fs.len(), 3);
    }

    #[test]
    fn irreducible_stays_whole() {
        // x^4 - 10x^2 + 1 is irreducible over Q but splits mod every prime.
        let (_, fs) = factor(&z(&[1, 0, -10, 0, 1]));
        assert_eq!(fs, vec![(z(&[1, 0, -10, 0, 1]), 1)]);
    }
}
