//! Constructions of primitive groups: small finite fields, groups acting on
//! the projective line P^1(F_q) (PSL, PGL, P Sigma L, P Gamma L, and M10),
//! actions on k-subsets and on cosets, affine groups of prime degree; and
//! the primitive groups of each degree from 10 to 12, built from their
//! definitions (the classification says which ones exist; the counts and
//! invariants are checked against Magma in the tests).

use crate::group::Group;
use crate::named;
use crate::perm::{Perm, Rng};
use sagebrush_bigint::BigInt;

/// The field with q = p^k elements, as 0..q-1 (the integer with base-p
/// digits c_0 + c_1 p + ... = the polynomial c_0 + c_1 t + ...), with
/// log / exp tables for a primitive element.
pub struct Gf {
    pub q: u32,
    pub p: u32,
    pub k: u32,
    add: Vec<u32>, // q*q
    exp: Vec<u32>, // q-1 entries
    log: Vec<u32>, // q entries (log[0] unused)
}

impl Gf {
    pub fn new(q: u32) -> Result<Gf, String> {
        let (p, k) = prime_power(q).ok_or_else(|| format!("{} is not a prime power", q))?;
        // digits
        let dig = |x: u32| -> Vec<u32> { (0..k).map(|i| x / p.pow(i) % p).collect() };
        let num = |d: &[u32]| -> u32 { d.iter().enumerate().map(|(i, &c)| c * p.pow(i as u32)).sum() };
        let mut add = vec![0u32; (q * q) as usize];
        for a in 0..q {
            for b in 0..q {
                let (da, db) = (dig(a), dig(b));
                let s: Vec<u32> = da.iter().zip(&db).map(|(x, y)| (x + y) % p).collect();
                add[(a * q + b) as usize] = num(&s);
            }
        }
        // multiplication modulo a monic irreducible polynomial of degree k
        // whose root t is a primitive element: search the monic polynomials
        let mulpoly = |a: &[u32], b: &[u32], m: &[u32]| -> Vec<u32> {
            // a, b of length k; m monic of degree k: coefficients m[0..k] (m[k] = 1 implied)
            let mut r = vec![0u32; 2 * k as usize];
            for (i, &x) in a.iter().enumerate() {
                for (j, &y) in b.iter().enumerate() {
                    r[i + j] = (r[i + j] + x * y) % p;
                }
            }
            for d in (k as usize..2 * k as usize).rev() {
                let c = r[d];
                if c != 0 {
                    r[d] = 0;
                    for (i, &mi) in m.iter().enumerate() {
                        let idx = d - k as usize + i;
                        r[idx] = (r[idx] + p * p - c * mi % p) % p;
                    }
                }
            }
            r.truncate(k as usize);
            r
        };
        for mcode in 0..q {
            let m = dig(mcode);
            if k > 1 && m[0] == 0 {
                continue;
            }
            // powers of t (for k = 1: of a candidate generator g = mcode)
            let t: Vec<u32> = if k == 1 { vec![mcode % p] } else { let mut v = vec![0; k as usize]; v[1] = 1; v };
            if k == 1 && t[0] == 0 {
                continue;
            }
            let mut exp = vec![];
            let mut cur = { let mut v = vec![0u32; k as usize]; v[0] = 1; v };
            let mut ok = true;
            let mut seen = vec![false; q as usize];
            for _ in 0..q - 1 {
                let c = num(&cur);
                if seen[c as usize] || c == 0 {
                    ok = false;
                    break;
                }
                seen[c as usize] = true;
                exp.push(c);
                cur = if k == 1 { vec![cur[0] * t[0] % p] } else { mulpoly(&cur, &t, &m) };
            }
            if !ok || num(&cur) != 1 {
                continue;
            }
            let mut log = vec![0u32; q as usize];
            for (i, &e) in exp.iter().enumerate() {
                log[e as usize] = i as u32;
            }
            return Ok(Gf { q, p, k, add, exp, log });
        }
        Err(format!("no primitive element found for GF({})", q))
    }
    pub fn add(&self, a: u32, b: u32) -> u32 {
        self.add[(a * self.q + b) as usize]
    }
    pub fn neg(&self, a: u32) -> u32 {
        (0..self.q).find(|&b| self.add(a, b) == 0).unwrap()
    }
    pub fn mul(&self, a: u32, b: u32) -> u32 {
        if a == 0 || b == 0 {
            return 0;
        }
        self.exp[((self.log[a as usize] + self.log[b as usize]) % (self.q - 1)) as usize]
    }
    pub fn inv(&self, a: u32) -> u32 {
        self.exp[((self.q - 1 - self.log[a as usize]) % (self.q - 1)) as usize]
    }
    pub fn gen(&self) -> u32 {
        self.exp[1 % (self.q - 1) as usize]
    }
    /// x -> x^p
    pub fn frob(&self, a: u32) -> u32 {
        if a == 0 {
            return 0;
        }
        self.exp[((self.log[a as usize] as u64 * self.p as u64) % (self.q as u64 - 1)) as usize]
    }
    pub fn is_square(&self, a: u32) -> bool {
        a == 0 || self.p == 2 || self.log[a as usize] % 2 == 0
    }
}

pub fn prime_power(q: u32) -> Option<(u32, u32)> {
    if q < 2 {
        return None;
    }
    let p = (2..=q).find(|d| q % d == 0).unwrap();
    let mut m = q;
    let mut k = 0;
    while m % p == 0 {
        m /= p;
        k += 1;
    }
    if m == 1 {
        Some((p, k))
    } else {
        None
    }
}

/// A map of P^1(F_q) (points 0..q-1, infinity = q) as a permutation.
fn line_perm(f: &Gf, map: impl Fn(Option<u32>) -> Option<u32>) -> Perm {
    let q = f.q;
    Perm((0..=q).map(|x| map(if x == q { None } else { Some(x) }).unwrap_or(q)).collect())
}

/// x -> (a x + b) / (c x + d)
fn moebius(f: &Gf, a: u32, b: u32, c: u32, d: u32) -> Perm {
    line_perm(f, |x| match x {
        None => if c == 0 { None } else { Some(f.mul(a, f.inv(c))) },
        Some(x) => {
            let num = f.add(f.mul(a, x), b);
            let den = f.add(f.mul(c, x), d);
            if den == 0 { None } else { Some(f.mul(num, f.inv(den))) }
        }
    })
}

/// The groups on the projective line over F_q: which = "psl", "pgl", "psigmal", "pgammal", "m10" (q = 9).
pub fn projective_line(q: u32, which: &str) -> Result<Group, String> {
    let f = Gf::new(q)?;
    let g = f.gen();
    let one = 1;
    let t = moebius(&f, one, one, 0, one); // x -> x + 1
    let s = moebius(&f, 0, f.neg(one), one, 0); // x -> -1/x
    let sq = f.mul(g, g);
    let mut gens = vec![t.clone(), s.clone(), moebius(&f, sq, 0, 0, one)]; // PSL(2, q)
    let frob = line_perm(&f, |x| x.map(|x| f.frob(x)));
    let diag = moebius(&f, g, 0, 0, one); // x -> g x (PGL, determinant a non-square when q is odd)
    match which {
        "psl" => {}
        "pgl" => gens.push(diag),
        "psigmal" => gens.push(frob),
        // PSL(2, q) extended by the square of the Frobenius (q = 16: PSL(2, 16):2)
        "psigmal2" => gens.push(frob.mul(&frob)),
        "pgammal" => {
            gens.push(diag);
            gens.push(frob);
        }
        "m10" => {
            if q != 9 {
                return Err("M10 is a subgroup of PGammaL(2, 9)".into());
            }
            // PSL(2, 9) extended by x -> g x^3 (field automorphism times a non-square scaling)
            gens.push(line_perm(&f, |x| x.map(|x| f.mul(g, f.frob(x)))));
        }
        _ => return Err(format!("unknown group {}", which)),
    }
    Group::new(q as usize + 1, gens)
}

/// The action of g on the k-subsets of its points (in lexicographic order).
pub fn on_subsets(g: &Group, k: usize) -> Result<Group, String> {
    let n = g.n;
    let mut subs: Vec<Vec<u32>> = vec![];
    fn rec(n: u32, k: usize, start: u32, cur: &mut Vec<u32>, out: &mut Vec<Vec<u32>>) {
        if cur.len() == k {
            out.push(cur.clone());
            return;
        }
        for x in start..n {
            cur.push(x);
            rec(n, k, x + 1, cur, out);
            cur.pop();
        }
    }
    rec(n as u32, k, 0, &mut vec![], &mut subs);
    let idx: std::collections::HashMap<Vec<u32>, u32> = subs.iter().enumerate().map(|(i, s)| (s.clone(), i as u32)).collect();
    let gens = g
        .gens
        .iter()
        .map(|p| {
            Perm(subs.iter().map(|s| {
                let mut t: Vec<u32> = s.iter().map(|&x| p.image(x)).collect();
                t.sort_unstable();
                idx[&t]
            }).collect())
        })
        .collect();
    Group::new(subs.len(), gens)
}

/// The action of g on the right cosets of its subgroup h (by right multiplication).
pub fn on_cosets(g: &Group, h: &Group) -> Result<Group, String> {
    let n = g.n;
    let index = (g.order() / h.order()).to_string().parse::<usize>().map_err(|_| "index too large")?;
    let mut reps: Vec<Perm> = vec![Perm::identity(n)];
    let find = |reps: &[Perm], x: &Perm| -> Option<usize> { reps.iter().position(|r| h.contains(&x.mul(&r.inv()))) };
    let mut i = 0;
    while i < reps.len() {
        for s in &g.gens {
            let x = reps[i].mul(s);
            if find(&reps, &x).is_none() {
                reps.push(x);
            }
        }
        i += 1;
    }
    if reps.len() != index {
        return Err("coset enumeration failed".into());
    }
    let gens = g.gens.iter().map(|s| Perm(reps.iter().map(|r| find(&reps, &r.mul(s)).unwrap() as u32).collect())).collect();
    Group::new(index, gens)
}

/// A subgroup of g of the given order generated by two random elements (a search).
pub fn find_subgroup(g: &Group, order: u64, tries: usize) -> Option<Group> {
    let mut rng = Rng::new(0xC0FFEE);
    let want = BigInt::from(order);
    for _ in 0..tries {
        let (a, b) = (g.random(&mut rng), g.random(&mut rng));
        // shrink: powers of random elements give elements of smaller orders
        let a = a.pow((rng.below(6) + 1) as i64);
        let b = b.pow((rng.below(6) + 1) as i64);
        let h = Group::new(g.n, vec![a, b]).unwrap();
        if h.order() == want {
            return Some(h);
        }
    }
    None
}

/// The subgroups x -> a x + b of AGL(1, p) with a in the subgroup of order d of F_p^*.
pub fn affine_prime(p: u32, d: u32) -> Result<Group, String> {
    if !named::is_prime(p as u64) || (p - 1) % d != 0 {
        return Err("affine_prime(p, d) needs p prime and d | p - 1".into());
    }
    let f = Gf::new(p)?;
    let a = (0..(p - 1) / d).fold(1, |acc, _| f.mul(acc, f.gen()));
    let t = Perm((0..p).map(|x| (x + 1) % p).collect());
    let mut gens = vec![t];
    if d > 1 {
        gens.push(Perm((0..p).map(|x| f.mul(a, x)).collect()));
    }
    Group::new(p as usize, gens)
}

/// The primitive groups of degree n, for n = 10, 12 and the primes up to 23 (up to conjugacy).
pub fn primitive_groups(n: usize) -> Result<Vec<Group>, String> {
    let mut out = vec![];
    match n {
        10 => {
            out.push(on_subsets(&named::alternating(5), 2)?);
            out.push(on_subsets(&named::symmetric(5), 2)?);
            for w in ["psl", "pgl", "m10", "psigmal", "pgammal"] {
                out.push(projective_line(9, w)?);
            }
        }
        12 => {
            out.push(projective_line(11, "psl")?);
            out.push(projective_line(11, "pgl")?);
            // M11 on the 12 cosets of a PSL(2, 11)
            let m11 = named::mathieu(11)?;
            let l = find_subgroup(&m11, 660, 20000).ok_or("no PSL(2,11) found in M11")?;
            out.push(on_cosets(&m11, &l)?);
            out.push(named::mathieu(12)?);
        }
        _ if named::is_prime(n as u64) && n >= 5 => {
            let p = n as u32;
            for d in (1..p).filter(|d| (p - 1) % d == 0) {
                out.push(affine_prime(p, d)?);
            }
            if n == 11 {
                // PSL(2, 11) on the 11 cosets of an A5, and M11
                let l = projective_line(11, "psl")?;
                let a5 = find_subgroup(&l, 60, 20000).ok_or("no A5 found in PSL(2,11)")?;
                out.push(on_cosets(&l, &a5)?);
                out.push(named::mathieu(11)?);
            } else if n == 7 {
                out.push(psl32());
            } else if n == 13 {
                out.push(psl33()?);
            } else if n == 17 {
                // PSL(2, 16) <= PSL(2, 16):2 <= PSigmaL(2, 16) on the projective line over F_16
                for w in ["psl", "psigmal2", "psigmal"] {
                    out.push(projective_line(16, w)?);
                }
            } else if n == 23 {
                out.push(named::mathieu(23)?);
            } else if n != 5 && n != 7 && n != 11 && n != 13 && n != 19 {
                return Err(format!("the primitive groups of degree {} are not built in yet", n));
            }
        }
        _ => return Err(format!("the primitive groups of degree {} are not built in yet", n)),
    }
    out.push(named::alternating(n));
    out.push(named::symmetric(n));
    Ok(out)
}

/// PSL(3, 2) on the 7 points of the Fano plane.
fn psl32() -> Group {
    projective_plane(2).unwrap()
}

/// PSL(3, 3) on the 13 points of the projective plane over F_3.
fn psl33() -> Result<Group, String> {
    projective_plane(3)
}

/// PSL(3, p) (p prime) on the points of the projective plane over F_p, generated by elementary matrices.
fn projective_plane(p: u32) -> Result<Group, String> {
    // points: normalized nonzero vectors (first nonzero coordinate 1)
    let mut pts: Vec<[u32; 3]> = vec![];
    for a in 0..p {
        for b in 0..p {
            for c in 0..p {
                let v = [a, b, c];
                if v == [0, 0, 0] {
                    continue;
                }
                let lead = *v.iter().find(|&&x| x != 0).unwrap();
                if lead == 1 {
                    pts.push(v);
                }
            }
        }
    }
    let norm = |v: [u32; 3]| -> [u32; 3] {
        let lead = *v.iter().find(|&&x| x != 0).unwrap();
        let inv = (1..p).find(|&i| i * lead % p == 1).unwrap();
        [v[0] * inv % p, v[1] * inv % p, v[2] * inv % p]
    };
    let act = |m: [[u32; 3]; 3]| -> Perm {
        Perm(pts.iter().map(|v| {
            let w = [0, 1, 2].map(|i| (0..3).map(|j| m[i][j] * v[j]).sum::<u32>() % p);
            pts.iter().position(|x| *x == norm(w)).unwrap() as u32
        }).collect())
    };
    let mut gens = vec![];
    for i in 0..3 {
        for j in 0..3 {
            if i != j {
                let mut m = [[0u32; 3]; 3];
                for (k, row) in m.iter_mut().enumerate() {
                    row[k] = 1;
                }
                m[i][j] = 1;
                gens.push(act(m));
            }
        }
    }
    Group::new(pts.len(), gens)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_and_lines() {
        for q in [2u32, 3, 4, 5, 7, 8, 9, 11, 13, 16, 25, 27] {
            let f = Gf::new(q).unwrap();
            for a in 1..q {
                assert_eq!(f.mul(a, f.inv(a)), 1, "GF({})", q);
            }
        }
        let o = |q: u64, w: &str| projective_line(q as u32, w).unwrap().order();
        // |PSL(2,q)| = q(q^2-1)/gcd(2, q-1); PGL twice that for odd q; PGammaL(2,9) = 1440
        assert_eq!(o(9, "psl"), BigInt::from(360));
        assert_eq!(o(9, "pgl"), BigInt::from(720));
        assert_eq!(o(9, "m10"), BigInt::from(720));
        assert_eq!(o(9, "psigmal"), BigInt::from(720));
        assert_eq!(o(9, "pgammal"), BigInt::from(1440));
        assert_eq!(o(8, "psl"), BigInt::from(504));
        assert_eq!(o(8, "pgammal"), BigInt::from(1512));
        assert_eq!(o(11, "psl"), BigInt::from(660));
        assert_eq!(projective_plane(2).unwrap().order(), BigInt::from(168));
        assert_eq!(projective_plane(3).unwrap().order(), BigInt::from(5616));
    }

    #[test]
    fn primitive_counts() {
        // the numbers of primitive groups of degree n (OEIS A000019)
        for (n, want) in [(5usize, 5usize), (7, 7), (10, 9), (11, 8), (12, 6), (13, 9), (17, 10), (19, 8), (23, 7)] {
            let gs = primitive_groups(n).unwrap();
            assert_eq!(gs.len(), want, "degree {}", n);
            for g in &gs {
                assert!(g.is_primitive(), "degree {}: a group of order {} is not primitive", n, g.order());
            }
        }
    }
}
