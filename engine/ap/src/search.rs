//! Rational points of small height on an elliptic curve over Q: the x = r/s^2
//! (gcd(r, s) = 1) with |r| <= rmax and s <= smax for which
//!   s^6 (4x^3 + b2 x^2 + 2 b4 x + b6) = 4r^3 + b2 r^2 s^2 + 2 b4 r s^4 + b6 s^6
//! is a square: then (2y + a1 x + a3)^2 = that / s^6 has a rational solution.
//! The caller (lib/_sage_ec.py) lifts each x to the points above it.

use crate::quartic::is_square;

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// [(r, s)] with x = r/s^2 the x-coordinate of a point (sorted by s, then r),
/// at most `limit` of them; Err if the numbers could leave i128.
pub fn x_coordinates(b2: i128, b4: i128, b6: i128, rmax: u64, smax: u64, limit: usize) -> Result<Vec<(i128, u64)>, String> {
    let (r, s) = (rmax as f64, smax as f64);
    let size = 4.0 * r.powi(3) + (b2 as f64).abs() * r * r * s * s + 2.0 * (b4 as f64).abs() * r * s.powi(4) + (b6 as f64).abs() * s.powi(6);
    if size > 1e37 {
        return Err("the point search needs numbers beyond 128 bits".into());
    }
    // For each s, the r mod l for which F(r, s) is a square (or 0) mod the
    // prime l: a wheel mod 5*7*11*13 = 5005 lists the r to visit, the primes
    // 17..47 are checked by table; about 1 r in 1000 gets the exact test.
    const WHEEL: [i128; 4] = [5, 7, 11, 13];
    const EXTRA: [i128; 9] = [17, 19, 23, 29, 31, 37, 41, 43, 47];
    let sq = |m: i128| -> Vec<bool> {
        let mut t = vec![false; m as usize];
        for x in 0..m {
            t[(x * x % m) as usize] = true;
        }
        t
    };
    let wsq: Vec<Vec<bool>> = WHEEL.iter().map(|&m| sq(m)).collect();
    let esq: Vec<Vec<bool>> = EXTRA.iter().map(|&m| sq(m)).collect();
    const W: i128 = 5 * 7 * 11 * 13;
    let mut out = Vec::new();
    for sv in 1..=smax {
        sagebrush_interrupt::check();
        let s = sv as i128;
        let (s2, s4, s6) = (s * s, s * s * s * s, s * s * s * s * s * s);
        let (c2, c1, c0) = (b2 * s2, 2 * b4 * s4, b6 * s6);
        let f = |r: i128| ((4 * r + c2) * r + c1) * r + c0;
        let wok: Vec<Vec<bool>> = WHEEL.iter().zip(&wsq).map(|(&m, t)| (0..m).map(|r| t[f(r).rem_euclid(m) as usize]).collect()).collect();
        let eok: Vec<Vec<bool>> = EXTRA.iter().zip(&esq).map(|(&m, t)| (0..m).map(|r| t[f(r).rem_euclid(m) as usize]).collect()).collect();
        let lo = -(rmax as i128);
        let hi = rmax as i128;
        let offsets: Vec<(i128, [u8; 9])> = (0..W)
            .filter(|&o| WHEEL.iter().zip(&wok).all(|(&m, t)| t[(lo + o).rem_euclid(m) as usize]))
            .map(|o| {
                let mut r = [0u8; 9];
                for (k, &m) in EXTRA.iter().enumerate() {
                    r[k] = (o % m) as u8;
                }
                (o, r)
            })
            .collect();
        let mut base = lo;
        while base <= hi {
            let mut bres = [0usize; 9];
            for (k, &m) in EXTRA.iter().enumerate() {
                bres[k] = base.rem_euclid(m) as usize;
            }
            'next: for &(o, ref ores) in &offsets {
                let rv = base + o;
                if rv > hi {
                    break;
                }
                for k in 0..9 {
                    // both residues are below m: no division
                    let mut i = bres[k] + ores[k] as usize;
                    if i >= EXTRA[k] as usize {
                        i -= EXTRA[k] as usize;
                    }
                    if !eok[k][i] {
                        continue 'next;
                    }
                }
                let v = f(rv);
                if v < 0 || is_square(v as u128).is_none() {
                    continue;
                }
                if sv > 1 && gcd(rv.unsigned_abs() as u64, sv) != 1 {
                    continue;
                }
                out.push((rv, sv));
                if out.len() >= limit {
                    return Ok(out);
                }
            }
            base += W;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_37a1() {
        // y^2 + y = x^3 - x: b2 = 0, b4 = -2, b6 = 1
        let xs = x_coordinates(0, -2, 1, 10, 3, 1000).unwrap();
        for x in [(0, 1), (1, 1), (-1, 1), (2, 1), (6, 1), (1, 2)] {
            assert!(xs.contains(&x), "{:?}", x);
        }
    }
}
