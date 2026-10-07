//! Integral binary quartics with given invariants, for 2-descent on
//! elliptic curves over Q (Birch and Swinnerton-Dyer 1963).
//!
//! g(X, Y) = a X^4 + b X^3 Y + c X^2 Y^2 + d X Y^3 + e Y^4 has invariants
//!   I = 12ae - 3bd + c^2,  J = 72ace + 9bcd - 27ad^2 - 27eb^2 - 2c^3
//! and seminvariants H = 8ac - 3b^2, R = b^3 + 8a^2 d - 4abc, with the syzygy
//!   27 R^2 = 48 a^2 I H - H^3 - 64 a^3 J.
//! Given (a, H) the syzygy fixes R up to sign, and then b (mod 4a, by
//! translations X -> X + kY, which fix a, H and R) fixes c, d and e.
//!
//! Bounds (Stoll and Cremona's covariant, written from the published
//! mathematics): chi(g) = sum_i |g'(alpha_i)|^-1 |X - alpha_i Y|^2 over the
//! roots of g is a positive definite quadratic form covariant under SL2(R).
//! Every SL2(Z) class has a representative with the root z = x + iy of chi(g)
//! in the standard fundamental domain, so y >= sqrt(3)/2.  Writing
//! g = g_t((X - xY)/sqrt y, sqrt y Y) with g_t on the circle of forms whose
//! covariant has root i (the SO(2)-orbit of one of them):
//!   a = a_t / y^2,  H = H_t / y^2,
//! so |a| <= 4/3 max|a_t| and H/a = H_t/a_t over the t with a_t/a >= 3/4.
//! The real orbits with invariants (I, J) that take positive values all
//! contain a form X^4 + c X^2 + d X + e, which gives one point of each circle.
//!
//! The quartics of a 2-descent can be taken of the form P^2 + 4Q
//! (Cremona, Fisher and Stoll 2010, Theorem 1.1, completing the square in
//! their generalised binary quartics y^2 + P y = Q), so b is even.

use std::ops::{Add, Div, Mul, Sub};

#[derive(Clone, Copy, Debug)]
struct C(f64, f64);
impl Add for C {
    type Output = C;
    fn add(self, o: C) -> C {
        C(self.0 + o.0, self.1 + o.1)
    }
}
impl Sub for C {
    type Output = C;
    fn sub(self, o: C) -> C {
        C(self.0 - o.0, self.1 - o.1)
    }
}
impl Mul for C {
    type Output = C;
    fn mul(self, o: C) -> C {
        C(self.0 * o.0 - self.1 * o.1, self.0 * o.1 + self.1 * o.0)
    }
}
impl Div for C {
    type Output = C;
    fn div(self, o: C) -> C {
        let n = o.0 * o.0 + o.1 * o.1;
        C((self.0 * o.0 + self.1 * o.1) / n, (self.1 * o.0 - self.0 * o.1) / n)
    }
}
impl C {
    fn abs(self) -> f64 {
        self.0.hypot(self.1)
    }
}

/// The complex roots of f[0] x^4 + f[1] x^3 + ... + f[4] (f[0] != 0).
fn roots4(f: &[f64; 5]) -> [C; 4] {
    let co: Vec<f64> = f.iter().map(|x| x / f[0]).collect();
    let r = 1.0 + co[1..].iter().fold(0.0f64, |m, x| m.max(x.abs()));
    let p = |x: C| (((x + C(co[1], 0.0)) * x + C(co[2], 0.0)) * x + C(co[3], 0.0)) * x + C(co[4], 0.0);
    let mut z = [C(r, 0.0); 4];
    let mut w = C(1.0, 0.0);
    for zi in z.iter_mut() {
        *zi = C(r, 0.0) * w;
        w = w * C(0.4, 0.9);
    }
    for _ in 0..1000 {
        let mut delta = 0.0f64;
        for i in 0..4 {
            let mut den = C(1.0, 0.0);
            for j in 0..4 {
                if j != i {
                    den = den * (z[i] - z[j]);
                }
            }
            let step = p(z[i]) / den;
            z[i] = z[i] - step;
            delta = delta.max(step.abs());
        }
        if delta < 1e-15 * r {
            break;
        }
    }
    z
}

/// The real roots of x^3 + p x + q.
fn cubic_real_roots(p: f64, q: f64) -> Vec<f64> {
    let mut out = Vec::new();
    let disc = -4.0 * p * p * p - 27.0 * q * q;
    if disc > 0.0 {
        let m = 2.0 * (-p / 3.0).sqrt();
        let th = ((3.0 * q / (p * m)).clamp(-1.0, 1.0)).acos() / 3.0;
        for k in 0..3 {
            out.push(m * (th - 2.0 * std::f64::consts::PI * k as f64 / 3.0).cos());
        }
    } else {
        let s = (q * q / 4.0 + p * p * p / 27.0).max(0.0).sqrt();
        out.push((-q / 2.0 + s).cbrt() + (-q / 2.0 - s).cbrt());
    }
    for x in out.iter_mut() {
        for _ in 0..4 {
            let d = 3.0 * *x * *x + p;
            if d != 0.0 {
                *x -= (*x * *x * *x + p * *x + q) / d;
            }
        }
    }
    out.sort_by(|a, b| a.partial_cmp(b).unwrap());
    out
}

fn pmul(a: &[f64], b: &[f64]) -> Vec<f64> {
    let mut o = vec![0.0; a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            o[i + j] += x * y;
        }
    }
    o
}

/// f(pX + qY, rX + sY) for f = [a, b, c, d, e].
fn transform(f: &[f64; 5], p: f64, q: f64, r: f64, s: f64) -> [f64; 5] {
    let mut pw1 = vec![vec![1.0]];
    let mut pw2 = vec![vec![1.0]];
    for k in 0..4 {
        pw1.push(pmul(&pw1[k], &[p, q]));
        pw2.push(pmul(&pw2[k], &[r, s]));
    }
    let mut out = [0.0; 5];
    for k in 0..5 {
        let t = pmul(&pw1[4 - k], &pw2[k]);
        for (i, x) in t.iter().enumerate() {
            out[i] += f[k] * x;
        }
    }
    out
}

/// The root x + iy of the covariant chi(f).
fn chi_root(f: &[f64; 5]) -> (f64, f64) {
    let al = roots4(f);
    let dg = |x: C| ((C(4.0 * f[0], 0.0) * x + C(3.0 * f[1], 0.0)) * x + C(2.0 * f[2], 0.0)) * x + C(f[3], 0.0);
    let (mut a, mut b, mut c) = (0.0, 0.0, 0.0);
    for r in al {
        let w = 1.0 / dg(r).abs();
        a += w;
        b -= 2.0 * w * r.0;
        c += w * (r.0 * r.0 + r.1 * r.1);
    }
    (-b / (2.0 * a), (4.0 * a * c - b * b).max(0.0).sqrt() / (2.0 * a))
}

/// (a_t, H_t) for t in [0, pi) on the circle of forms equivalent to g0 whose
/// covariant has root i.
fn circle(g0: &[f64; 5], n: usize) -> Vec<(f64, f64)> {
    let (x, y) = chi_root(g0);
    let sy = y.sqrt();
    let gc = transform(g0, sy, x / sy, 0.0, 1.0 / sy);
    (0..n)
        .map(|k| {
            let t = std::f64::consts::PI * k as f64 / n as f64;
            let (ct, st) = (t.cos(), t.sin());
            let g = transform(&gc, ct, -st, st, ct);
            (g[0], 8.0 * g[0] * g[2] - 3.0 * g[1] * g[1])
        })
        .collect()
}

/// One form X^4 + c X^2 + d X + e in each real orbit with invariants (I, J)
/// that takes positive values: c = -psi/2 with psi^3 - 3 I psi - J >= 0.
fn real_types(i: f64, j: f64) -> Vec<[f64; 5]> {
    let rs = cubic_real_roots(-3.0 * i, -j);
    let mut psis = Vec::new();
    if rs.len() == 3 {
        psis.push((rs[0] + rs[1]) / 2.0);
    }
    let top = *rs.last().unwrap();
    psis.push(top + top.abs().max(1.0));
    psis.into_iter()
        .map(|psi| {
            let c = -psi / 2.0;
            let d2 = (6.0 * c * i - 8.0 * c * c * c - j) / 27.0;
            [1.0, 0.0, c, d2.max(0.0).sqrt(), (i - c * c) / 12.0]
        })
        .collect()
}

fn is_square(n: u128) -> Option<u128> {
    // quadratic residues mod 64, 63, 65, 11 reject most non-squares
    const Q64: u64 = 0x0202021202030213;
    if (Q64 >> (n % 64)) & 1 == 0 {
        return None;
    }
    let r63 = (n % 63) as u64;
    if !matches!(r63, 0 | 1 | 4 | 7 | 9 | 16 | 18 | 22 | 25 | 28 | 36 | 37 | 43 | 45 | 46 | 49 | 58) {
        return None;
    }
    let r65 = (n % 65) as u64;
    if !matches!(r65, 0 | 1 | 4 | 9 | 10 | 14 | 16 | 25 | 26 | 29 | 30 | 35 | 36 | 39 | 40 | 49 | 51 | 55 | 56 | 61 | 64) {
        return None;
    }
    if !matches!(n % 11, 0 | 1 | 3 | 4 | 5 | 9) {
        return None;
    }
    let mut r = (n as f64).sqrt() as u128;
    while r * r > n {
        r -= 1;
    }
    while (r + 1) * (r + 1) <= n {
        r += 1;
    }
    (r * r == n).then_some(r)
}

/// I and J of an integral quartic.
pub fn invariants(f: &[i128; 5]) -> (i128, i128) {
    let [a, b, c, d, e] = *f;
    (12 * a * e - 3 * b * d + c * c, 72 * a * c * e + 9 * b * c * d - 27 * a * d * d - 27 * e * b * b - 2 * c * c * c)
}

/// Is f congruent mod 4 to P^2 for an integral binary quadratic P?
fn square_mod4(f: &[i128; 5]) -> bool {
    for p0 in 0..2i128 {
        for p1 in 0..2i128 {
            for p2 in 0..2i128 {
                let p = [p0 * p0, 2 * p0 * p1, p1 * p1 + 2 * p0 * p2, 2 * p1 * p2, p2 * p2];
                if f.iter().zip(p.iter()).all(|(x, y)| (x - y).rem_euclid(4) == 0) {
                    return true;
                }
            }
        }
    }
    false
}

/// For a fixed a, H = 4t must make num(H) = 48 a^2 I H - H^3 - 64 a^3 J
/// equal to 27 R^2: tables of the t mod l for which that holds mod l
/// (27 | num, and num/27 a square or 0 mod the other l).  The wheel
/// 27*5*7*11 gives the offsets to visit; the other primes are checked by table.
const WHEEL: [u64; 4] = [27, 5, 7, 11];
const EXTRA: [u64; 7] = [13, 17, 19, 23, 29, 31, 37];

fn table(l: u64, k1: i128, k0: i128) -> Vec<bool> {
    let li = l as i128;
    let (k1, k0) = (k1.rem_euclid(li), k0.rem_euclid(li));
    (0..li)
        .map(|t| {
            let h = (4 * t) % li;
            let num = (k1 * h - h * h * h - k0).rem_euclid(li);
            if l == 27 {
                num == 0
            } else {
                // num = 27 s^2 iff 3 num = (9 s)^2
                let x = (3 * num) % li;
                x == 0 || crate::fp::jacobi(x as u64, l) == 1
            }
        })
        .collect()
}

pub struct Search {
    /// [a, b, c, d, e], every SL2(Z) class of the quartics with the
    /// invariants and a != 0 (with repetitions)
    pub quartics: Vec<[i128; 5]>,
    /// the number of (a, H) pairs tested
    pub work: u64,
    pub amax: u64,
    /// the number of (a, H) pairs in the reduced region (before sieving)
    pub cost: u64,
}

const SAMPLES: usize = 3000;
const LIMIT: f64 = 3.0e37; // below 2^125

/// All integral quartics P^2 + 4Q with invariants (I, J) (I, J from c4 and
/// 2 c6 of a minimal model) up to SL2(Z) equivalence and a != 0.  Errors if
/// the numbers involved could leave i128.
pub fn search(i: i128, j: i128, max_cost: u64) -> Result<Search, String> {
    search_impl(i, j, true, max_cost)
}

fn search_impl(i: i128, j: i128, use_sieve: bool, max_cost: u64) -> Result<Search, String> {
    let singular = match (i.checked_mul(i).and_then(|x| x.checked_mul(i)).and_then(|x| x.checked_mul(4)), j.checked_mul(j)) {
        (Some(x), Some(y)) => x == y,
        _ => false, // too big to be singular here: the size check below rejects it anyway
    };
    if singular {
        return Err("the invariants are singular (4 I^3 = J^2)".into());
    }
    let (fi, fj) = (i as f64, j as f64);
    let mut out = Search { quartics: Vec::new(), work: 0, amax: 0, cost: 0 };
    // plan: the a and the H interval for each, and the number of candidates
    let mut plan: Vec<(i128, i128, i128)> = Vec::new();
    for g0 in real_types(fi, fj) {
        let circ = circle(&g0, SAMPLES);
        for sgn in [1i128, -1] {
            let s = sgn as f64;
            let amax_f = 4.0 / 3.0 * circ.iter().fold(0.0f64, |m, &(at, _)| m.max(s * at)) * 1.001 + 1.0;
            let amax = amax_f.max(0.0) as i128;
            out.amax = out.amax.max(amax as u64);
            for big_a in 1..=amax {
                let a = sgn * big_a;
                let af = a as f64;
                let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
                for &(at, ht) in &circ {
                    if at / af >= 0.74 {
                        let h = af * ht / at;
                        lo = lo.min(h);
                        hi = hi.max(h);
                    }
                }
                if lo > hi {
                    continue;
                }
                let pad = 0.01 * (hi - lo) + 8.0 * big_a as f64;
                let (lo, hi) = ((lo - pad).floor(), (hi + pad).ceil());
                let hm = lo.abs().max(hi.abs());
                if hm.powi(3) > LIMIT || 48.0 * af * af * fi.abs() * hm > LIMIT || 64.0 * af.abs().powi(3) * fj.abs() > LIMIT {
                    return Err(format!("the quartic search needs numbers beyond 128 bits (|a| up to {}, |H| up to {:e})", amax, hm));
                }
                out.cost += ((hi - lo) / 4.0) as u64;
                plan.push((a, lo as i128, hi as i128));
            }
        }
    }
    if out.cost > max_cost {
        return Err(format!("the quartic search is too large: {:.2e} candidates (limit {:.2e})", out.cost as f64, max_cost as f64));
    }
    for (a, lo, hi) in plan {
        sagebrush_interrupt::check();
        let big_a = a.abs();
        {
            {
                let m = 8 * big_a;
                let (a2, a3) = (a * a, a * a * a);
                let k1 = 48 * a2 * i;
                let k0 = 64 * a3 * j;
                let (tl, th) = (lo.div_euclid(4) + 1, hi.div_euclid(4));
                if tl > th {
                    continue;
                }
                let n = (th - tl + 1) as u64;
                let wheel: Vec<(u64, u64, Vec<bool>)> =
                    WHEEL.iter().map(|&l| (l, tl.rem_euclid(l as i128) as u64, table(l, k1, k0))).collect();
                let extra: Vec<(u64, u64, Vec<bool>)> =
                    EXTRA.iter().map(|&l| (l, tl.rem_euclid(l as i128) as u64, table(l, k1, k0))).collect();
                let w: u64 = WHEEL.iter().product();
                let offsets: Vec<u64> = if use_sieve {
                    (0..w).filter(|&o| wheel.iter().all(|(l, r0, t)| t[((r0 + o) % l) as usize])).collect()
                } else {
                    (0..w).collect()
                };
                let mut base = 0u64;
                while base < n {
                    for &o in &offsets {
                        let k = base + o;
                        if k >= n {
                            break;
                        }
                        if use_sieve && !extra.iter().all(|(l, r0, t)| t[((r0 + k) % l) as usize]) {
                            continue;
                        }
                        out.work += 1;
                        let h = 4 * (tl + k as i128);
                        let num = k1 * h - h * h * h - k0;
                        if num < 0 || num % 27 != 0 {
                            continue;
                        }
                        let Some(rr) = is_square((num / 27) as u128) else { continue };
                        let rr = rr as i128;
                        // the even b in [0, 2|a|] (b and -b are GL2(Z)-equivalent)
                        // with c = (H + 3 b^2) / 8a integral
                        for b in (0..=2 * big_a).step_by(2) {
                            if (h + 3 * b * b) % m != 0 {
                                continue;
                            }
                            let c = (h + 3 * b * b) / (8 * a);
                            for rs in if rr == 0 { vec![0] } else { vec![rr, -rr] } {
                                let dn = rs - b * b * b + 4 * a * b * c;
                                if dn % (8 * a2) != 0 {
                                    continue;
                                }
                                let d = dn / (8 * a2);
                                let en = i + 3 * b * d - c * c;
                                if en % (12 * a) != 0 {
                                    continue;
                                }
                                let f = [a, b, c, d, en / (12 * a)];
                                if invariants(&f) == (i, j) && square_mod4(&f) {
                                    out.quartics.push(f);
                                }
                            }
                        }
                    }
                    base += w;
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn squares() {
        for n in 0..20000u128 {
            let r = (n as f64).sqrt() as u128;
            assert_eq!(is_square(n).is_some(), r * r == n, "{}", n);
        }
    }

    #[test]
    fn syzygy_and_search_finds_known_quartic() {
        // 37b2 = [0,1,1,-1873,-31833]: c4 = 89920, c6 = 26964008
        let s = search(89920, 2 * 26964008, u64::MAX).unwrap();
        assert!(s.quartics.contains(&[-3, 4, 148, -100, -1856]));
        for f in &s.quartics {
            assert_eq!(invariants(f), (89920, 2 * 26964008));
        }
    }

    // 11a2 = [0,-1,1,-7820,-263580]
    const C4_11A2: i128 = 375376;
    const C6_11A2: i128 = 229985128;

    #[test]
    fn sieve_loses_nothing() {
        // 37b2 and 11a2
        for (i, j) in [(89920i128, 2 * 26964008i128), (C4_11A2, 2 * C6_11A2)] {
            let mut a = search_impl(i, j, true, u64::MAX).unwrap().quartics;
            let mut b = search_impl(i, j, false, u64::MAX).unwrap().quartics;
            a.sort();
            b.sort();
            assert_eq!(a, b);
        }
    }
}
