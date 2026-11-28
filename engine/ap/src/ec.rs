//! Points on y^2 = x^3 + A x + B over F_p (Montgomery form), and the
//! baby-step giant-step search for every t in the Hasse interval with
//! (p + 1 - t) P = O.

use crate::fp::Fp;


/// Jacobian coordinates (X : Y : Z) for (X/Z^2, Y/Z^3); Z = 0 is O.
#[derive(Clone, Copy, PartialEq)]
pub struct Jac {
    pub x: u64,
    pub y: u64,
    pub z: u64,
}

pub const O: Jac = Jac { x: 0, y: 0, z: 0 };

/// An affine point (x, y), never O.
#[derive(Clone, Copy)]
pub struct Aff {
    pub x: u64,
    pub y: u64,
}

pub struct Curve<'a> {
    pub f: &'a Fp,
    pub a: u64,
}

impl Curve<'_> {
    pub fn double(&self, p: Jac) -> Jac {
        let f = self.f;
        if p.z == 0 || p.y == 0 {
            return O;
        }
        let xx = f.sqr(p.x);
        let yy = f.sqr(p.y);
        let yyyy = f.sqr(yy);
        let zz = f.sqr(p.z);
        let t = f.sub(f.sub(f.sqr(f.add(p.x, yy)), xx), yyyy);
        let s = f.add(t, t);
        let m = f.add(f.add(f.add(xx, xx), xx), f.mul(self.a, f.sqr(zz)));
        let x3 = f.sub(f.sqr(m), f.add(s, s));
        let y8 = f.add(yyyy, yyyy);
        let y8 = f.add(y8, y8);
        let y8 = f.add(y8, y8);
        let y3 = f.sub(f.mul(m, f.sub(s, x3)), y8);
        let z3 = f.sub(f.sub(f.sqr(f.add(p.y, p.z)), yy), zz);
        Jac { x: x3, y: y3, z: z3 }
    }

    /// p + q for q affine (mixed addition).
    pub fn add_aff(&self, p: Jac, q: Aff) -> Jac {
        let f = self.f;
        if p.z == 0 {
            return Jac { x: q.x, y: q.y, z: f.one };
        }
        let z1z1 = f.sqr(p.z);
        let u2 = f.mul(q.x, z1z1);
        let s2 = f.mul(q.y, f.mul(p.z, z1z1));
        let h = f.sub(u2, p.x);
        let r = f.sub(s2, p.y);
        if h == 0 {
            return if r == 0 { self.double(p) } else { O };
        }
        let hh = f.sqr(h);
        let hhh = f.mul(h, hh);
        let v = f.mul(p.x, hh);
        let x3 = f.sub(f.sub(f.sqr(r), hhh), f.add(v, v));
        let y3 = f.sub(f.mul(r, f.sub(v, x3)), f.mul(p.y, hhh));
        Jac { x: x3, y: y3, z: f.mul(p.z, h) }
    }

    /// n P, left to right.
    pub fn mul(&self, p: Aff, n: u64) -> Jac {
        let mut r = O;
        for i in (0..64 - n.leading_zeros()).rev() {
            r = self.double(r);
            if (n >> i) & 1 == 1 {
                r = self.add_aff(r, p);
            }
        }
        r
    }
}

/// Buffers reused across primes (one per thread).
#[derive(Default)]
pub struct Scratch {
    baby: Vec<Jac>,
    baby_zi: Vec<u64>,
    pts: Vec<Jac>,
    zs: Vec<u64>,
    tmp: Vec<u64>,
    xs: Vec<u64>,
    table: Vec<(u64, u32)>,
}

/// x = X / Z^2 for every point (O excluded by the caller); zs keeps 1/Z.
fn normalize_x(f: &Fp, pts: &[Jac], zs: &mut Vec<u64>, tmp: &mut Vec<u64>, xs: &mut Vec<u64>) {
    zs.clear();
    zs.extend(pts.iter().map(|p| p.z));
    f.batch_inv(zs, tmp);
    xs.clear();
    xs.extend(pts.iter().zip(zs.iter()).map(|(p, &zi)| if p.z == 0 { u64::MAX } else { f.mul(p.x, f.sqr(zi)) }));
}

fn y_of(f: &Fp, p: &Jac, zi: u64) -> u64 {
    f.mul(p.y, f.mul(f.sqr(zi), zi))
}

/// Every t in [-w, w] with t = res mod md and t P = (p + 1) P, i.e.
/// (p + 1 - t) P = O, given that the true trace satisfies the congruence.
/// Baby-step giant-step on B = md P over t = res + md (u0 + v), |v| <= wv.
pub fn traces(c: &Curve, pt: Aff, w: i64, md: i64, res: i64, s: &mut Scratch) -> Vec<i64> {
    let f = c.f;
    let p1 = f.p as i64 + 1;
    let umin = (-w - res).div_euclid(md) + if (-w - res).rem_euclid(md) != 0 { 1 } else { 0 };
    let umax = (w - res).div_euclid(md);
    let u0 = (umin + umax) / 2;
    let wv = (u0 - umin).max(umax - u0);
    let m = ((wv as f64).sqrt().ceil() as usize).max(1);
    let b = if md == 1 {
        pt
    } else {
        let bj = c.mul(pt, md as u64);
        if bj.z == 0 {
            return small_order(c, pt, md as u64, w);
        }
        let zi = f.inv(bj.z);
        Aff { x: f.mul(bj.x, f.sqr(zi)), y: y_of(f, &bj, zi) }
    };
    // Baby steps j B, j = 1..=m, keyed by x (j B and -j B share it).
    s.pts.clear();
    let mut acc = O;
    for j in 1..=m {
        if j & 255 == 0 {
            sagebrush_interrupt::check();
        }
        acc = c.add_aff(acc, b);
        if acc.z == 0 {
            return small_order(c, pt, (md as usize * j) as u64, w);
        }
        s.pts.push(acc);
    }
    normalize_x(f, &s.pts, &mut s.zs, &mut s.tmp, &mut s.xs);
    let bits = (2 * m).next_power_of_two().trailing_zeros().max(4);
    let mask = (1usize << bits) - 1;
    s.table.clear();
    s.table.resize(mask + 1, (u64::MAX, 0));
    let hash = |x: u64| (x.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> (64 - bits)) as usize;
    for j in 0..m {
        let x = s.xs[j];
        let mut h = hash(x);
        while s.table[h].0 != u64::MAX {
            if s.table[h].0 == x {
                // (j+1) B = +-i B with i < j + 1: B has order dividing j + 1 -+ i.
                let i = s.table[h].1 as usize;
                let same = y_of(f, &s.pts[i - 1], s.zs[i - 1]) == y_of(f, &s.pts[j], s.zs[j]);
                let n = if same { j + 1 - i } else { j + 1 + i };
                return small_order(c, pt, (md as usize * n) as u64, w);
            }
            h = (h + 1) & mask;
        }
        s.table[h] = (x, j as u32 + 1);
    }
    std::mem::swap(&mut s.baby, &mut s.pts);
    std::mem::swap(&mut s.baby_zi, &mut s.zs);
    // Giant steps R_k = Q - k S with Q = (p + 1 - res - md u0) P and
    // S = (2m + 1) B, for k = -K..=K; R_k = v' B with |v'| <= m on a match.
    let step = 2 * m as i64 + 1;
    let sj = c.mul(b, step as u64);
    if sj.z == 0 {
        return small_order(c, pt, (md * step) as u64, w);
    }
    let zi = f.inv(sj.z);
    let neg_s = Aff { x: f.mul(sj.x, f.sqr(zi)), y: f.neg(y_of(f, &sj, zi)) };
    let kmax = (wv + m as i64) / step + 1;
    let start = p1 - res - md * u0 + kmax * step * md; // R_{-K} = start P
    let mut r = c.mul(pt, start as u64);
    s.pts.clear();
    for k in -kmax..=kmax {
        if k & 255 == 0 {
            sagebrush_interrupt::check();
        }
        s.pts.push(r);
        r = c.add_aff(r, neg_s);
    }
    normalize_x(f, &s.pts, &mut s.zs, &mut s.tmp, &mut s.xs);
    let mut out = vec![];
    for i in 0..s.pts.len() {
        let k = i as i64 - kmax;
        let v = if s.pts[i].z == 0 {
            Some(k * step)
        } else {
            let x = s.xs[i];
            let mut h = hash(x);
            let mut found = None;
            while s.table[h].0 != u64::MAX {
                if s.table[h].0 == x {
                    let j = s.table[h].1 as i64;
                    let jb = j as usize - 1;
                    let same = y_of(f, &s.baby[jb], s.baby_zi[jb]) == y_of(f, &s.pts[i], s.zs[i]);
                    found = Some(if same { k * step + j } else { k * step - j });
                    break;
                }
                h = (h + 1) & mask;
            }
            found
        };
        if let Some(v) = v {
            let t = res + md * (u0 + v);
            if t.abs() <= w {
                out.push(t);
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// P has order dividing n (small): its exact order, then every t in
/// [-w, w] with t = p + 1 mod that order.
fn small_order(c: &Curve, pt: Aff, n: u64, w: i64) -> Vec<i64> {
    let mut primes = vec![];
    let (mut m, mut d) = (n, 2);
    while d * d <= m {
        if m % d == 0 {
            primes.push(d);
            while m % d == 0 {
                m /= d;
            }
        }
        d += 1;
    }
    if m > 1 {
        primes.push(m);
    }
    let mut ord = n;
    for q in primes {
        while ord % q == 0 && c.mul(pt, ord / q).z == 0 {
            ord /= q;
        }
    }
    let o = ord as i64;
    let r = ((c.f.p + 1) % ord) as i64;
    let mut t = -w + (r + w).rem_euclid(o);
    let mut out = vec![];
    while t <= w {
        out.push(t);
        t += o;
    }
    out
}
