//! The zeros of the Riemann zeta function on the critical line: the Riemann-Siegel theta and Z functions,
//! Gram points, and the n-th zero 1/2 + i gamma_n, for n up to 10^7.
//!
//! * theta(t) = Im log Gamma(1/4 + it/2) - (t/2) log pi, by Stirling's series after shifting the argument
//!   to |w| >= 10 (Abramowitz and Stegun, Handbook of Mathematical Functions, 6.1.40-6.1.41).
//! * Z(t) = e^{i theta(t)} zeta(1/2 + it), which is real.  Below t = RS_FROM, zeta(1/2 + it) comes from
//!   Euler-Maclaurin summation (H. M. Edwards, Riemann's Zeta Function, 1974, section 6.4); from there on,
//!   from the Riemann-Siegel formula with the correction terms C_0..C_4 (Edwards, chapter 7; W. Gabcke,
//!   Neue Herleitung und explizite Restabschaetzung der Riemann-Siegel-Formel, Goettingen 1979).  The C_k
//!   are Chebyshev expansions made by gen/zeta_rs_cheb.py.
//! * The zeros are found Gram block by Gram block.  The Gram point g_j solves theta(g_j) = j pi; it is good
//!   when (-1)^j Z(g_j) > 0.  Between consecutive good Gram points g_j < g_k (a Gram block), Rosser's rule
//!   says Z has at least k - j zeros, and then the zeros above g_j are numbered from j + 2 (J. B. Rosser,
//!   J. M. Yohe and L. Schoenfeld, "Rigorous computation and the zeros of the Riemann zeta-function",
//!   Information Processing 68, 1969).  Rosser's rule holds for every block below Gram point 13,999,525
//!   (R. P. Brent, J. van de Lune, H. J. J. te Riele and D. T. Winter, "On the zeros of the Riemann zeta
//!   function in the critical strip. II", Math. Comp. 39, 1982), hence the cap.  A block's sign changes are
//!   found on finer and finer grids until there are k - j of them; if a block has fewer even on the finest
//!   grid, the zeros are refused rather than misnumbered.  Each zero is then refined by the Illinois
//!   variant of regula falsi.
//!
//! Accuracy: Z is computed in double precision, and theta(t) itself is only as good as its rounding, about
//! 10^-16 t log t, so a zero near height t is good to a few units in its last place: against mpmath, at
//! worst 1.5 10^-15 gamma_n for the n tested up to 10^7 (tests/zeta.rs allows 10^-13 + 10^-14 gamma_n).

use crate::zeta_rs_cheb::RS_CHEB;
use std::f64::consts::PI;

/// The largest n for which zeta_zeros gives gamma_n (Rosser's rule is known to hold below it).
pub const ZETA_ZERO_INDEX_MAX: u64 = 10_000_000;
/// Z(t) uses the Riemann-Siegel formula from this height on, Euler-Maclaurin summation below it.
pub const RS_FROM: f64 = 2000.0;

#[derive(Clone, Copy, Debug)]
struct Cx {
    re: f64,
    im: f64,
}

impl Cx {
    fn new(re: f64, im: f64) -> Cx {
        Cx { re, im }
    }
    fn polar(r: f64, a: f64) -> Cx {
        let (s, c) = a.sin_cos();
        Cx::new(r * c, r * s)
    }
    fn add(self, o: Cx) -> Cx {
        Cx::new(self.re + o.re, self.im + o.im)
    }
    fn mul(self, o: Cx) -> Cx {
        Cx::new(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re)
    }
    fn scale(self, k: f64) -> Cx {
        Cx::new(self.re * k, self.im * k)
    }
    fn inv(self) -> Cx {
        let d = self.re * self.re + self.im * self.im;
        Cx::new(self.re / d, -self.im / d)
    }
    fn abs(self) -> f64 {
        self.re.hypot(self.im)
    }
}

/// B_2k / (2k (2k - 1)) for k = 1..=10: the coefficients of Stirling's series.
const STIRLING: [f64; 10] = [
    1.0 / 12.0,
    -1.0 / 360.0,
    1.0 / 1260.0,
    -1.0 / 1680.0,
    1.0 / 1188.0,
    -691.0 / 360360.0,
    1.0 / 156.0,
    -3617.0 / 122400.0,
    43867.0 / 244188.0,
    -174611.0 / 125400.0,
];

/// The Riemann-Siegel theta function, theta(t) = Im log Gamma(1/4 + it/2) - (t/2) log pi (odd in t).
pub fn theta(t: f64) -> f64 {
    if t < 0.0 {
        return -theta(-t);
    }
    // log Gamma(w) = log Gamma(w + 1) - log w: shift until |w| >= 10
    let mut w = Cx::new(0.25, t / 2.0);
    let mut shift = 0.0;
    while w.abs() < 10.0 {
        shift += w.im.atan2(w.re);
        w.re += 1.0;
    }
    let log_w = Cx::new(0.5 * (w.re * w.re + w.im * w.im).ln(), w.im.atan2(w.re));
    // Im[(w - 1/2) log w - w + (1/2) log 2 pi + sum B_2k / (2k (2k - 1) w^(2k - 1))]
    let mut im = (w.re - 0.5) * log_w.im + w.im * log_w.re - w.im;
    let inv = w.inv();
    let inv2 = inv.mul(inv);
    let mut p = inv;
    for c in STIRLING {
        im += c * p.im;
        p = p.mul(inv2);
    }
    im - shift - t / 2.0 * PI.ln()
}

/// 2 zeta(2k) for k = 1..: the size of B_2k (2 pi)^2k / (2k)!.
fn two_zeta_even(k: usize) -> f64 {
    let pi2 = PI * PI;
    match k {
        1 => 2.0 * pi2 / 6.0,
        2 => 2.0 * pi2 * pi2 / 90.0,
        3 => 2.0 * pi2 * pi2 * pi2 / 945.0,
        _ => 2.0 * (1..=40).map(|n| (n as f64).powi(-2 * k as i32)).sum::<f64>(),
    }
}

/// Z(t) by Euler-Maclaurin summation of zeta(1/2 + it): N - 1 terms of the series, then the tail
/// N^(1-s)/(s-1) + N^(-s)/2 + sum_k B_2k/(2k)! s(s+1)...(s+2k-2) N^(-s-2k+1), with N about (|s| + 50) / pi
/// so that each correction term is at most about a quarter of the one before.
fn z_euler_maclaurin(t: f64) -> f64 {
    let s = Cx::new(0.5, t);
    let n = ((s.abs() + 50.0) / PI).ceil() as u64;
    let mut sum = Cx::new(0.0, 0.0);
    for k in 1..n {
        let k = k as f64;
        sum = sum.add(Cx::polar(1.0 / k.sqrt(), -t * k.ln()));
    }
    let nf = n as f64;
    let n_s = Cx::polar(1.0 / nf.sqrt(), -t * nf.ln()); // N^(-s)
    let n_1s = n_s.scale(nf); // N^(1-s)
    sum = sum.add(n_1s.mul(Cx::new(-0.5, t).inv())).add(n_s.scale(0.5));
    // B_2k/(2k)! = (-1)^(k+1) 2 zeta(2k) / (2 pi)^2k, so the k-th term is
    // N^(1-s) (-1)^(k+1) 2 zeta(2k) q_k with q_k = s (s+1) ... (s+2k-2) / (2 pi N)^2k
    let w = 1.0 / (2.0 * PI * nf).powi(2);
    let mut q = s.scale(w);
    for k in 1..=40 {
        let sign = if k % 2 == 1 { 1.0 } else { -1.0 };
        let term = n_1s.mul(q).scale(sign * two_zeta_even(k));
        sum = sum.add(term);
        if term.abs() < 1e-18 {
            break;
        }
        let j = 2.0 * k as f64;
        q = q.mul(Cx::new(0.5 + j - 1.0, t)).mul(Cx::new(0.5 + j, t)).scale(w);
    }
    Cx::polar(1.0, theta(t)).mul(sum).re
}

/// A Chebyshev series sum c_j T_j(x), by Clenshaw's recurrence.
fn clenshaw(c: &[f64], x: f64) -> f64 {
    let (mut b1, mut b2) = (0.0, 0.0);
    for &cj in c[1..].iter().rev() {
        (b1, b2) = (2.0 * x * b1 - b2 + cj, b1);
    }
    x * b1 - b2 + c[0]
}

/// Z(t) by the Riemann-Siegel formula: 2 sum_{n <= m} n^(-1/2) cos(theta(t) - t log n) +
/// (-1)^(m-1) a^(-1/2) sum_{k <= 4} C_k(p) a^(-k), a = sqrt(t / 2 pi), m = floor(a), p = a - m.
fn z_riemann_siegel(t: f64) -> f64 {
    let a = (t / (2.0 * PI)).sqrt();
    let m = a.floor();
    let p = a - m;
    let th = theta(t);
    let mut s = 0.0;
    for n in 1..=m as u64 {
        let n = n as f64;
        s += (th - t * n.ln()).cos() / n.sqrt();
    }
    let x = 2.0 * p - 1.0;
    let mut r = 0.0;
    let mut ak = 1.0;
    for c in RS_CHEB {
        r += clenshaw(c, x) * ak;
        ak /= a;
    }
    let sign = if (m as u64) % 2 == 1 { 1.0 } else { -1.0 };
    2.0 * s + sign * r / a.sqrt()
}

/// The Riemann-Siegel Z function, Z(t) = e^{i theta(t)} zeta(1/2 + it): real, even in t, and zero exactly
/// where zeta(1/2 + it) is.
pub fn z(t: f64) -> f64 {
    let t = t.abs();
    if t < RS_FROM {
        z_euler_maclaurin(t)
    } else {
        z_riemann_siegel(t)
    }
}

/// The Gram point g_j, theta(g_j) = j pi, for j >= -1 (the one above the minimum of theta near t = 6.29).
pub fn gram_point(j: i64) -> f64 {
    assert!(j >= -1, "gram_point: j must be at least -1");
    let target = j as f64 * PI;
    // theta(t) is about (t/2) log(t / 2 pi e) - pi/8: start there, then Newton with theta'(t) about
    // (1/2) log(t / 2 pi)
    let mut t = 2.0 * PI * std::f64::consts::E;
    for _ in 0..60 {
        let f = t / 2.0 * (t / (2.0 * PI * std::f64::consts::E)).ln() - PI / 8.0 - target;
        let next = t - f / (0.5 * (t / (2.0 * PI)).ln());
        if (next - t).abs() <= 1e-12 * t {
            t = next;
            break;
        }
        t = next.max(7.0);
    }
    for _ in 0..60 {
        let d = (theta(t) - target) / (0.5 * (t / (2.0 * PI)).ln() + 1.0 / (48.0 * t * t));
        t -= d;
        if d.abs() <= 4.0 * f64::EPSILON * t {
            break;
        }
    }
    t
}

/// The zero of Z in [a, b], where Z(a) and Z(b) have opposite signs: regula falsi, Illinois variant.
fn refine(mut a: f64, mut fa: f64, mut b: f64, mut fb: f64) -> f64 {
    let mut side = 0;
    for _ in 0..100 {
        if (b - a).abs() <= 4.0 * f64::EPSILON * b.abs().max(1.0) {
            break;
        }
        let c = (a * fb - b * fa) / (fb - fa);
        if !(c > a.min(b) && c < a.max(b)) {
            break;
        }
        let fc = z(c);
        if fc == 0.0 {
            return c;
        }
        if (fc > 0.0) == (fb > 0.0) {
            b = c;
            fb = fc;
            if side == -1 {
                fa /= 2.0;
            }
            side = -1;
        } else {
            a = c;
            fa = fc;
            if side == 1 {
                fb /= 2.0;
            }
            side = 1;
        }
    }
    if fa.abs() < fb.abs() {
        a
    } else {
        b
    }
}

/// How finely a Gram block is searched for missing sign changes: each Gram interval into at most 2^12 parts.
const SEARCH_LEVELS: u32 = 12;

/// gamma_n for n = start, start + 1, ..., start + count - 1 (gamma_1 = 14.1347...), each n at most
/// ZETA_ZERO_INDEX_MAX.  Err if a Gram block's zeros can't be separated (not expected below the cap).
pub fn zeta_zeros(start: u64, count: u64) -> Result<Vec<f64>, String> {
    if start == 0 {
        return Err("zeta_zeros: the zeros are numbered from 1".into());
    }
    if count == 0 {
        return Ok(vec![]);
    }
    let last = start.checked_add(count - 1).filter(|&l| l <= ZETA_ZERO_INDEX_MAX);
    let last = last.ok_or_else(|| format!("zeta_zeros: n must be at most {ZETA_ZERO_INDEX_MAX}"))?;
    let good = |j: i64, zj: f64| if j % 2 == 0 { zj > 0.0 } else { zj < 0.0 };
    // a good Gram point g_j with j + 2 <= start: N(g_j) = j + 1
    let mut j = start as i64 - 2;
    let mut zj = z(gram_point(j));
    while j > -1 && !good(j, zj) {
        j -= 1;
        zj = z(gram_point(j));
    }
    let mut out = Vec::with_capacity(count as usize);
    let mut next = (j + 2) as u64; // the number of the first zero above g_j
    let mut pts = vec![(gram_point(j), zj)];
    while next <= last {
        // the block: up to the next good Gram point g_k
        let mut k = j + 1;
        loop {
            let g = gram_point(k);
            let zk = z(g);
            pts.push((g, zk));
            if good(k, zk) {
                break;
            }
            k += 1;
        }
        let want = (k - j) as usize;
        let changes = |p: &[(f64, f64)]| p.windows(2).filter(|w| (w[0].1 > 0.0) != (w[1].1 > 0.0)).count();
        let mut level = 0;
        while changes(&pts) < want {
            if level == SEARCH_LEVELS {
                return Err(format!(
                    "zeta_zeros: the Gram block from g_{j} to g_{k} shows fewer than {want} sign changes"
                ));
            }
            let mut finer = Vec::with_capacity(2 * pts.len());
            for w in pts.windows(2) {
                finer.push(w[0]);
                let m = 0.5 * (w[0].0 + w[1].0);
                finer.push((m, z(m)));
            }
            finer.push(*pts.last().unwrap());
            pts = finer;
            level += 1;
        }
        if changes(&pts) > want {
            return Err(format!("zeta_zeros: the Gram block from g_{j} to g_{k} shows more than {want} sign changes"));
        }
        for w in pts.windows(2) {
            if (w[0].1 > 0.0) != (w[1].1 > 0.0) {
                if next >= start && next <= last {
                    out.push(refine(w[0].0, w[0].1, w[1].0, w[1].1));
                }
                next += 1;
            }
        }
        j = k;
        pts = vec![*pts.last().unwrap()];
        sagebrush_interrupt::check_coarse();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gram_points_solve_theta() {
        for j in [-1i64, 0, 1, 10, 1000, 100_000, 10_000_000] {
            let g = gram_point(j);
            assert!((theta(g) - j as f64 * PI).abs() < 1e-14 * (j.abs() as f64 + 1.0) * 8.0, "j = {j}");
        }
        // g_0 = 17.8455995..., g_-1 = 9.6669080...
        assert!((gram_point(0) - 17.845599540410096).abs() < 1e-12);
        assert!((gram_point(-1) - 9.666908056130192).abs() < 1e-12);
    }

    #[test]
    fn euler_maclaurin_and_riemann_siegel_agree() {
        // the two ways of computing Z, where both are accurate
        let mut worst: f64 = 0.0;
        for i in 0..200 {
            let t = RS_FROM + 37.3 * i as f64;
            worst = worst.max((z_euler_maclaurin(t) - z_riemann_siegel(t)).abs());
        }
        assert!(worst < 1e-10, "worst {worst}");
    }
}

