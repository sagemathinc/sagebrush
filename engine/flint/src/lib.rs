//! Factoring in Z[x] with FLINT (`fmpz_poly_factor`, van Hoeij's
//! algorithm).  This crate is LGPL-3.0-or-later, like FLINT; the rest of
//! Sagebrush does not depend on it unless a component needs factoring.
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
