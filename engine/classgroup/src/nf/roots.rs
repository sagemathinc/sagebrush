//! Certified isolation of the complex roots of a squarefree integer
//! polynomial f of degree n (the second review's R3: (x - 10^8)^2 + 1 got two
//! wrong real roots from f64 starting values and an unchecked Newton
//! refinement, so Q(i) had signature (2, 0)).
//!
//! Approximations z_1..z_n come from Aberth's simultaneous iteration (f64
//! starting values for the polynomial translated to its centroid, then fixed
//! point at increasing precision).  They are certified by Weierstrass
//! inclusion disks (Braess and Hadeler, Numer. Math. 1973): with
//! W_i = f(z_i) / (lc prod_{j != i} (z_i - z_j)), every root lies in the union
//! of the disks |z - z_i| <= n |W_i|, and a union of m of them disjoint from
//! the rest holds exactly m roots.  Each radius is computed as an upper bound
//! (|re| + |im| for magnitudes, a bound on Horner's rounding error) and each
//! separation as a lower bound (max(|re|, |im|)), so that disjoint computed
//! disks are disjoint disks.  A disk meeting the real axis holds a real root
//! when the disk around its real part, enlarged to contain it, still meets
//! no other disk (then it holds one root, its own conjugate).  The number of
//! real roots is checked against an exact Sturm count.  Anything that does
//! not certify within the precision budget is an error, never a guess.

use sagebrush_bigint::{BigInt, BigRational};
use num_traits::{One, Signed, ToPrimitive, Zero};

/// A root: the center (re, im) and a radius, all fixed point (scaled by
/// 2^prec of its Isolated); `real`: the root is real (im = 0 then).
#[derive(Clone, Debug)]
pub struct Root {
    pub re: BigInt,
    pub im: BigInt,
    pub rad: BigInt,
    pub real: bool,
}

/// Certified disks, kept at the precision they were certified at (at least
/// the precision asked for): rounding them to fewer bits could make two
/// disks one (the third review's T4), so callers shift the centers to the
/// precision they need instead.
#[derive(Clone, Debug)]
pub struct Isolated {
    pub prec: u32,
    pub roots: Vec<Root>,
}

impl Isolated {
    /// The centers to `prec` bits (prec <= self.prec).
    pub fn centers(&self, prec: u32) -> Vec<(BigInt, BigInt)> {
        let sh = (self.prec - prec.min(self.prec)) as usize;
        self.roots.iter().map(|r| (&r.re >> sh, &r.im >> sh)).collect()
    }
}

type Cx = (BigInt, BigInt);

fn cmul(a: &Cx, b: &Cx, p: usize) -> Cx {
    (((&a.0 * &b.0) - (&a.1 * &b.1)) >> p, ((&a.0 * &b.1) + (&a.1 * &b.0)) >> p)
}

fn cdiv(a: &Cx, b: &Cx, p: usize) -> Option<Cx> {
    let d = &b.0 * &b.0 + &b.1 * &b.1;
    if d.is_zero() {
        return None;
    }
    Some(((((&a.0 * &b.0) + (&a.1 * &b.1)) << p) / &d, (((&a.1 * &b.0) - (&a.0 * &b.1)) << p) / &d))
}

/// f(z), f'(z) in fixed point.
fn horner(f: &[BigInt], z: &Cx, p: usize) -> (Cx, Cx) {
    let (mut v, mut d): (Cx, Cx) = ((BigInt::zero(), BigInt::zero()), (BigInt::zero(), BigInt::zero()));
    for c in f.iter().rev() {
        let nd = cmul(&d, z, p);
        d = (nd.0 + &v.0, nd.1 + &v.1);
        let nv = cmul(&v, z, p);
        v = (nv.0 + (c << p), nv.1);
    }
    (v, d)
}

fn fixed(x: f64, p: usize) -> BigInt {
    if !x.is_finite() {
        return BigInt::zero();
    }
    let m: BigInt = num_traits::FromPrimitive::from_f64((x * 2f64.powi(52)).round()).unwrap_or_default();
    if p >= 52 { m << (p - 52) } else { m >> (52 - p) }
}

/// f(y + c), exactly (Taylor shift).
fn shift(f: &[BigInt], c: &BigInt) -> Vec<BigInt> {
    let mut g = f.to_vec();
    let n = g.len();
    for i in 0..n {
        for j in (i..n - 1).rev() {
            let t = &g[j + 1] * c;
            g[j] += t;
        }
    }
    g
}

/// Starting values: Aberth in f64 on f translated to the centroid of its
/// roots (an integer c), then back; a circle around c if f64 fails.
fn seeds(f: &[BigInt], p: usize) -> Vec<Cx> {
    let n = f.len() - 1;
    let lc = &f[n];
    let c = (-&f[n - 1]) / (lc * BigInt::from(n as u64)); // (rounded toward 0: any integer will do)
    let g = shift(f, &c);
    let gl = g[n].to_f64().unwrap_or(1.0);
    let fc: Vec<f64> = g.iter().map(|x| x.to_f64().unwrap_or(f64::NAN) / gl).collect();
    let cf = c.clone() << p;
    let z = if fc.iter().all(|x| x.is_finite()) { super::embed::aberth(&fc) } else { vec![] };
    if z.len() == n && z.iter().all(|r| r.0.is_finite() && r.1.is_finite()) {
        // (off the real axis, distinctly: Aberth's iteration for a real
        // polynomial keeps real starting values real, so a complex pair
        // seeded on the axis would never leave it)
        return z.iter().enumerate().map(|(k, &(re, im))| {
            let kick = 1e-7 * (1.0 + re.abs() + im.abs()) * (k as f64 + 1.0);
            (fixed(re, p) + &cf, fixed(im + kick, p))
        }).collect();
    }
    (0..n).map(|k| {
        let t = 2.0 * std::f64::consts::PI * (k as f64 + 0.25) / n as f64;
        (fixed(t.cos(), p) + &cf, fixed(t.sin(), p))
    }).collect()
}

/// Aberth iterations at precision p (until the corrections are tiny or the
/// budget runs out).
fn aberth_fixed(f: &[BigInt], z: &mut [Cx], p: usize, iters: usize) {
    let n = z.len();
    let one: Cx = (BigInt::one() << p, BigInt::zero());
    // (converged: corrections of a few ulps)
    let tiny = BigInt::one() << 24usize;
    for _ in 0..iters {
        sagebrush_interrupt::check();
        let mut moved = BigInt::zero();
        for k in 0..n {
            let (v, d) = horner(f, &z[k], p);
            if v.0.is_zero() && v.1.is_zero() {
                continue;
            }
            let Some(ratio) = cdiv(&v, &d, p) else { continue };
            let mut s: Cx = (BigInt::zero(), BigInt::zero());
            for j in 0..n {
                if j != k {
                    let diff = (&z[k].0 - &z[j].0, &z[k].1 - &z[j].1);
                    if let Some(inv) = cdiv(&one, &diff, p) {
                        s = (s.0 + inv.0, s.1 + inv.1);
                    }
                }
            }
            let rs = cmul(&ratio, &s, p);
            let den = (&one.0 - &rs.0, -rs.1);
            let Some(w) = cdiv(&ratio, &den, p) else { continue };
            z[k] = (&z[k].0 - &w.0, &z[k].1 - &w.1);
            let m = w.0.abs().max(w.1.abs());
            if m > moved {
                moved = m;
            }
        }
        if moved <= tiny {
            break;
        }
    }
}

/// Inclusion radii (upper bounds, fixed point) for the approximations z.
fn radii(f: &[BigInt], z: &[Cx], p: usize) -> Option<Vec<BigInt>> {
    let n = z.len();
    let lc = f[n].abs();
    let one = BigInt::one() << p;
    let mut out = vec![];
    for i in 0..n {
        let (v, _) = horner(f, &z[i], p);
        // Horner's rounding error: at most 3 ulps per step, times |z|^j
        let zabs = z[i].0.abs() + z[i].1.abs() + &one;
        let mut s = BigInt::zero();
        let mut pw = one.clone();
        for _ in 0..=n {
            s += &pw;
            pw = ((&pw * &zabs) >> p) + 1u32;
        }
        let err = ((BigInt::from(3u32) * &s) >> p) + 1u32;
        let vup = v.0.abs() + v.1.abs() + BigInt::from(2u32) * &err;
        // lc prod |z_i - z_j|, from below
        let mut dlow = lc.clone() << p;
        for j in 0..n {
            if j != i {
                let dj = (&z[i].0 - &z[j].0).abs().max((&z[i].1 - &z[j].1).abs());
                dlow = (&dlow * &dj) >> p;
            }
        }
        if dlow.is_zero() {
            return None;
        }
        out.push(((BigInt::from(n as u64) * vup) << p) / &dlow + 1u32);
    }
    Some(out)
}

/// Whether the disks (c1, r1) and (c2, r2) are certainly disjoint.
fn apart(c1: &Cx, r1: &BigInt, c2: &Cx, r2: &BigInt) -> bool {
    (&c1.0 - &c2.0).abs().max((&c1.1 - &c2.1).abs()) > r1 + r2
}

/// Certified disks at precision p, with the real roots marked; None if the
/// disks are not separated (more precision needed).
fn certify(f: &[BigInt], z: &[Cx], p: usize) -> Option<Vec<Root>> {
    let r = radii(f, z, p)?;
    let n = z.len();
    for i in 0..n {
        for j in i + 1..n {
            if !apart(&z[i], &r[i], &z[j], &r[j]) {
                return None;
            }
        }
    }
    let mut out = vec![];
    for i in 0..n {
        if z[i].1.abs() > r[i] {
            out.push(Root { re: z[i].0.clone(), im: z[i].1.clone(), rad: r[i].clone(), real: false });
            continue;
        }
        // the disk around the real part holding this one: real if it meets no other
        let c = (z[i].0.clone(), BigInt::zero());
        let rr = &r[i] + z[i].1.abs();
        if (0..n).any(|j| j != i && !apart(&c, &rr, &z[j], &r[j])) {
            return None;
        }
        out.push(Root { re: z[i].0.clone(), im: BigInt::zero(), rad: rr, real: true });
    }
    Some(out)
}

/// The number of real roots, exactly (Sturm).
pub fn real_root_count(f: &[BigInt]) -> usize {
    let seq = super::embed::sturm(f);
    let lead = f.last().unwrap().abs();
    let bound = BigRational::new(f.iter().map(|c| c.abs()).max().unwrap() + &lead, lead);
    super::embed::sign_changes(&seq, &-bound.clone()) - super::embed::sign_changes(&seq, &bound)
}

/// Run Aberth from z at increasing precision until the roots certify with
/// radii below 2^-prec.
fn drive(f: &[BigInt], mut z: Vec<Cx>, mut p: usize, prec: u32, mut iters: usize) -> Result<(Vec<Root>, usize), String> {
    let n = f.len() - 1;
    let target = prec as usize + 16 + 2 * n.ilog2() as usize;
    for _ in 0..10 {
        aberth_fixed(f, &mut z, p, iters);
        if let Some(roots) = certify(f, &z, p) {
            let small = BigInt::one() << (p.saturating_sub(prec as usize + 2));
            if p >= target && roots.iter().all(|r| r.rad < small) {
                return Ok((roots, p));
            }
        }
        // roots that have not converged get a nudge off the real axis
        if let Some(r) = radii(f, &z, p) {
            let big = BigInt::one() << (p - 20);
            for (k, (zk, rk)) in z.iter_mut().zip(&r).enumerate() {
                if *rk > big {
                    zk.1 += &big * BigInt::from(k as u64 + 1);
                }
            }
        }
        // more precision, starting from where we are
        let np = (2 * p).max(target);
        z = z.into_iter().map(|(a, b)| (a << (np - p), b << (np - p))).collect();
        p = np;
        iters = 60;
    }
    Err(format!("could not isolate the roots of a polynomial of degree {} (precision {} bits)", n, p))
}

/// All roots of a squarefree integer polynomial of degree >= 1, certified,
/// to `prec` bits.
pub fn isolate(f: &[BigInt], prec: u32) -> Result<Isolated, String> {
    let n = f.len() - 1;
    if n == 0 {
        return Ok(Isolated { prec, roots: vec![] });
    }
    let cbits = f.iter().map(|c| c.bits()).max().unwrap_or(1) as usize;
    let p0 = 96 + cbits;
    let z = seeds(f, p0);
    let (roots, p) = drive(f, z, p0, prec.max(32), 500)?;
    let real = roots.iter().filter(|r| r.real).count();
    let exact = real_root_count(f);
    if real != exact {
        return Err(format!("root isolation found {} real roots, Sturm {}", real, exact));
    }
    Ok(Isolated { prec: p as u32, roots })
}

/// The same roots to at least `prec` bits, in the same order: each new disk
/// lies in the old one, both sets isolating, which proves the
/// correspondence.  (Already that precise: the same disks.)
pub fn refine(f: &[BigInt], old: &Isolated, prec: u32) -> Result<Isolated, String> {
    // (stored at prec bits or more is not enough: the radii must be below
    // 2^-prec too, or the centers are not that accurate)
    if prec <= old.prec {
        let small = BigInt::one() << (old.prec - prec) as usize;
        if old.roots.iter().all(|r| r.rad < small) {
            return Ok(old.clone());
        }
    }
    let cbits = f.iter().map(|c| c.bits()).max().unwrap_or(1) as usize;
    let p = (prec as usize + 64 + cbits).max(old.prec as usize);
    let sh = p - old.prec as usize;
    let z: Vec<Cx> = old.roots.iter().map(|r| (&r.re << sh, &r.im << sh)).collect();
    let (roots, p) = drive(f, z, p, prec, 40)?;
    // nesting: |new - old| + r_new <= r_old (at the new scale)
    let sh = p - old.prec as usize;
    for (nr, or) in roots.iter().zip(&old.roots) {
        let d = (&nr.re - (&or.re << sh)).abs() + (&nr.im - (&or.im << sh)).abs();
        if d + &nr.rad > (&or.rad << sh) || nr.real != or.real {
            return Err("root refinement left its isolating disk".into());
        }
    }
    Ok(Isolated { prec: p as u32, roots })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(v: &[i64]) -> Vec<BigInt> {
        v.iter().map(|&c| BigInt::from(c)).collect()
    }

    #[test]
    fn translated_gaussian_integer_roots() {
        // (x - 10^8)^2 + 1: roots 10^8 +- i, no real ones
        let f = vec![BigInt::from(10u64.pow(16) + 1), BigInt::from(-2 * 10i64.pow(8)), BigInt::from(1)];
        let iso = isolate(&f, 80).unwrap();
        assert!(iso.roots.iter().all(|r| !r.real));
        let p = iso.prec as usize;
        let one = BigInt::one() << p;
        for r in &iso.roots {
            assert!((&r.re - (BigInt::from(10u64.pow(8)) << p)).abs() <= r.rad);
            assert!((r.im.abs() - &one).abs() <= r.rad);
        }
        let f = vec![num_traits::pow(BigInt::from(10), 20) + 1u32, BigInt::from(-2 * 10i64.pow(10)), BigInt::from(1)];
        assert_eq!(isolate(&f, 64).unwrap().roots.iter().filter(|r| r.real).count(), 0);
    }

    #[test]
    fn real_and_complex_roots() {
        // x^3 - 2: one real root
        let iso = isolate(&b(&[-2, 0, 0, 1]), 100).unwrap();
        assert_eq!(iso.roots.iter().filter(|r| r.real).count(), 1);
        // x^4 - 10 x^2 + 1: four real roots; nearly coincident pair (x^2 - 2)(x^2 - 2 - 10^-?): Wilkinson-like
        let iso = isolate(&b(&[1, 0, -10, 0, 1]), 100).unwrap();
        assert_eq!(iso.roots.iter().filter(|r| r.real).count(), 4);
        let w = b(&[-40320, 109584, -118124, 67284, -22449, 4536, -546, 36, -1]); // -(x-1)...(x-8)
        let iso = isolate(&w, 60).unwrap();
        assert_eq!(iso.roots.iter().filter(|r| r.real).count(), 8);
        // refinement keeps the order
        let fine = refine(&w, &iso, 300).unwrap();
        let sh = (fine.prec - iso.prec) as usize;
        for (a, c) in iso.roots.iter().zip(&fine.roots) {
            assert!(((&c.re >> sh) - &a.re).abs() <= &a.rad + 2u32);
        }
    }
}


#[cfg(test)]
mod t4 {
    use super::*;
    /// Two roots 1/(3N) apart (the third review's T4): the disks stay
    /// disjoint whatever precision is asked for, and refinement keeps order.
    #[test]
    fn close_roots_keep_their_disks_and_order() {
        let n = num_traits::pow(BigInt::from(10), 25);
        // (3 N x + N)(3 N x + N - 1)
        let a = &n * 3u32;
        let (b1, b2) = (n.clone(), &n - 1u32);
        let f = vec![&b1 * &b2, &a * (&b1 + &b2), &a * &a];
        for prec in [32u32, 64, 256] {
            let iso = isolate(&f, prec).unwrap();
            let r = &iso.roots;
            assert!((&r[0].re - &r[1].re).abs() > &r[0].rad + &r[1].rad, "prec {}", prec);
            let coarse = refine(&f, &iso, 16).unwrap();
            let again = refine(&f, &coarse, 512).unwrap();
            let sh = (again.prec - iso.prec) as usize;
            for (o, nr) in iso.roots.iter().zip(&again.roots) {
                assert!(((&nr.re >> sh) - &o.re).abs() <= &o.rad + 2u32);
            }
        }
    }
}
