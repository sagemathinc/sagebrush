//! Relations among the prime forms of an imaginary quadratic order, by
//! Jacobson's sieve ("Applying sieving to the computation of class
//! groups", Math. Comp. 1999), in the self-initialising style of SIQS.
//!
//! A polynomial is a form phi = (a, b, c) with a = q_1 ... q_k a product of
//! factor-base primes and b^2 = D mod 4a (CRT, no composition).  If
//! m = phi(x, 1) = a x^2 + b x + c is smooth, the form (m, B), B = 2ax + b,
//! lies in the class of phi^-1, so
//!     sum_{p | m} s_p v_p(m) [p] + sum_q t_q [q] = 0
//! where s_p = +1 when B = b_p (mod 2p), else -1, and t_q likewise with b:
//! a relation, found with u64/i128 arithmetic only.

use crate::arith::*;

/// A prime ideal of norm p, as the prime form (p, b_p, .): b_p^2 = D mod 4p,
/// 0 <= b_p <= p.
#[derive(Clone, Debug)]
pub struct FbPrime {
    pub p: u64,
    pub b: i128,
    /// sqrt(D) mod p (0 when p | D); for the sieve
    pub t: u64,
    pub logp: u8,
}

pub struct FactorBase {
    pub d: i128,
    pub primes: Vec<FbPrime>,
    /// index of p in primes, by p (for large-prime lookups too)
    pub index: std::collections::HashMap<u64, usize>,
}

/// b with b^2 = D (mod 4p), 0 <= b <= p, b = D (mod 2); None if p is inert.
pub fn prime_form_b(d: i128, p: u64) -> Option<i128> {
    if p == 2 {
        return match d.rem_euclid(8) {
            1 => Some(1),
            0 => Some(0),
            4 => Some(2),
            _ => None,
        };
    }
    let k = kronecker(d, p);
    if k < 0 {
        return None;
    }
    let mut t = sqrt_mod(reduce(d, p), p) as i128;
    if (t - d).rem_euclid(2) != 0 {
        t = p as i128 - t;
    }
    // b in [0, p] with b = t (mod p) and b = D (mod 2)
    Some(t)
}

impl FactorBase {
    pub fn new(d: i128, bound: u64) -> FactorBase {
        let mut primes = vec![];
        let mut index = std::collections::HashMap::new();
        for p in primes_up_to(bound) {
            if let Some(b) = prime_form_b(d, p) {
                let t = if p == 2 { 0 } else { sqrt_mod(reduce(d, p), p) };
                index.insert(p, primes.len());
                primes.push(FbPrime { p, b, t, logp: (p as f64).log2().round() as u8 });
            }
        }
        FactorBase { d, primes, index }
    }

    /// s = +1 if B = b_p (mod 2p), -1 if B = -b_p (mod 2p).
    pub fn sign(&self, i: usize, bb: i128) -> i32 {
        let fp = &self.primes[i];
        let m = 2 * fp.p as i128;
        if (bb - fp.b).rem_euclid(m) == 0 {
            1
        } else {
            debug_assert_eq!((bb + fp.b).rem_euclid(m), 0, "B = {} for p = {}", bb, fp.p);
            -1
        }
    }
}

/// A relation: sum of e_i [p_i] = 0 (sparse, sorted by index).
pub type Relation = Vec<(usize, i64)>;

fn add_to(rel: &mut Vec<(usize, i64)>, i: usize, e: i64) {
    if let Some(x) = rel.iter_mut().find(|x| x.0 == i) {
        x.1 += e;
    } else {
        rel.push((i, e));
    }
}

fn normalize(mut rel: Relation) -> Relation {
    rel.retain(|x| x.1 != 0);
    rel.sort();
    rel
}

pub struct Params {
    pub m: i64,           // sieve over |x| <= m
    pub small: u64,       // primes below this are not sieved
    pub lp_mult: u64,     // large primes up to lp_mult * (largest FB prime)
    pub slack: u8,        // threshold slack (bits)
}

pub struct Stats {
    pub polys: u64,
    pub candidates: u64,
    pub full: u64,
    pub partial_pairs: u64,
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// Collect `want` relations (full ones and combined partials).  `counts`
/// holds how often each factor-base prime occurs in the relations so far:
/// the first prime of each a is the least covered one, so that every
/// column gets relations (each relation of a polynomial contains all of a).
pub fn collect(fb: &FactorBase, want: usize, par: &Params, seed: u64, stats: &mut Stats, counts: &mut Vec<u32>) -> Vec<Relation> {
    let d = fb.d;
    let absd = (-d) as u128;
    let n = fb.primes.len();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ seed);
    let m = par.m;
    let width = (2 * m + 1) as usize;
    let mut sieve = vec![0u8; width];
    let mut out: Vec<Relation> = vec![];
    let mut partials: std::collections::HashMap<u64, (Relation, i32)> = std::collections::HashMap::new();
    let pmax = fb.primes.last().unwrap().p;
    let lp_max = pmax * par.lp_mult;
    // target a ~ sqrt(|D|) / (2m); choose q's of a size so that k is small
    let target = ((absd as f64).sqrt() / (2.0 * m as f64)).max(3.0);
    // candidate q's: odd FB primes (ramified ones too: their b is 0 mod q)
    let qs: Vec<usize> = (0..n).filter(|&i| fb.primes[i].p > 2 && fb.primes[i].p >= par.small.min(pmax / 4).max(3)).collect();
    // q's near size s: a window of about 60 around it
    let window = |s: f64| -> Vec<usize> {
        let center = qs.partition_point(|&i| (fb.primes[i].p as f64) < s).min(qs.len().saturating_sub(1));
        let lo = center.saturating_sub(30);
        let hi = (center + 30).min(qs.len());
        qs[lo..hi].to_vec()
    };
    // the sieve threshold for a polynomial with leading coefficient a
    let threshold = |a: f64| -> u8 {
        let vmax = (a * (m as f64) * (m as f64) + (absd as f64) / (4.0 * a)).log2();
        ((vmax - (lp_max as f64).log2()).max(1.0) as u8).saturating_sub(par.slack)
    };
    let mut roots1 = vec![0i64; n];
    let mut roots2 = vec![0i64; n];
    while out.len() < want {
        // the first q: the least covered prime (ties: random); then primes
        // making a close to the target
        let least = qs.iter().map(|&i| counts[i]).min().unwrap_or(0);
        let low: Vec<usize> = qs.iter().cloned().filter(|&i| counts[i] == least).collect();
        let q1 = low[(rng.next() % low.len() as u64) as usize];
        let mut a_idx: Vec<usize> = vec![q1];
        let rest = target / fb.primes[q1].p as f64;
        if rest > 1.5 * qs.first().map_or(3.0, |&i| fb.primes[i].p as f64) {
            let j = ((rest.ln() / (pmax as f64 / 2.0).ln()).ceil() as usize).max(1);
            let win = window(rest.powf(1.0 / j as f64));
            let mut tries = 0;
            while a_idx.len() < 1 + j && tries < 1000 {
                tries += 1;
                let i = win[(rng.next() % win.len() as u64) as usize];
                if !a_idx.contains(&i) {
                    a_idx.push(i);
                }
            }
        }
        let k = a_idx.len();
        // while some column has no relation, take only a few from each a
        let cap = if qs.iter().any(|&i| counts[i] == 0) { 3 } else { usize::MAX };
        let start = out.len();
        let thresh = threshold(a_idx.iter().map(|&i| fb.primes[i].p as f64).product());
        let a: i128 = a_idx.iter().map(|&i| fb.primes[i].p as i128).product();
        // B_l = (a/q) * ((a/q)^-1 t_q mod q)
        let bl: Vec<i128> = a_idx
            .iter()
            .map(|&i| {
                let q = fb.primes[i].p;
                let aq = a / q as i128;
                let inv = invmod(reduce(aq, q), q);
                aq * mulmod(inv, fb.primes[i].t, q) as i128
            })
            .collect();
        // all 2^(k-1) sign choices (the first sign fixed)
        for signs in 0..(1u64 << (k - 1)) {
            let mut b: i128 = bl[0];
            for l in 1..k {
                b += if signs >> (l - 1) & 1 == 1 { -bl[l] } else { bl[l] };
            }
            b = b.rem_euclid(a);
            if (b - d).rem_euclid(2) != 0 {
                b += a; // a is odd: b^2 = D mod 4 as well
            }
            debug_assert_eq!((b * b - d).rem_euclid(4 * a), 0);
            let c = (b * b - d) / (4 * a);
            stats.polys += 1;
            // roots of a x^2 + b x + c mod p: x = (-b +- t) / 2a
            for (i, fp) in fb.primes.iter().enumerate() {
                let p = fp.p;
                if p < par.small || (a % p as i128) == 0 {
                    roots1[i] = -1;
                    continue;
                }
                let inv2a = invmod(reduce(2 * a, p), p);
                let mb = reduce(-b, p);
                let r1 = mulmod((mb + fp.t) % p, inv2a, p);
                let r2 = mulmod((mb + p - fp.t) % p, inv2a, p);
                // first index i = x + m with x = r mod p
                roots1[i] = ((r1 as i64 + m) % p as i64) as i64;
                roots2[i] = ((r2 as i64 + m) % p as i64) as i64;
            }
            sieve.iter_mut().for_each(|s| *s = 0);
            for (i, fp) in fb.primes.iter().enumerate() {
                if roots1[i] < 0 {
                    continue;
                }
                let p = fp.p as usize;
                let lg = fp.logp;
                let mut j = roots1[i] as usize;
                while j < width {
                    sieve[j] = sieve[j].wrapping_add(lg);
                    j += p;
                }
                if roots2[i] != roots1[i] {
                    let mut j = roots2[i] as usize;
                    while j < width {
                        sieve[j] = sieve[j].wrapping_add(lg);
                        j += p;
                    }
                }
            }
            for (j, &s) in sieve.iter().enumerate() {
                if s < thresh {
                    continue;
                }
                let x = j as i64 - m;
                stats.candidates += 1;
                let xi = x as i128;
                let val = a * xi * xi + b * xi + c; // > 0
                let mut v = val as u128;
                let bb = 2 * a * xi + b;
                let mut rel: Relation = vec![];
                for (i, fp) in fb.primes.iter().enumerate() {
                    let p = fp.p as u128;
                    if v % p == 0 {
                        let mut e = 0;
                        while v % p == 0 {
                            v /= p;
                            e += 1;
                        }
                        let s = fb.sign(i, bb) as i64;
                        add_to(&mut rel, i, s * e);
                    }
                    if v == 1 {
                        break;
                    }
                }
                for &i in &a_idx {
                    add_to(&mut rel, i, fb.sign(i, b) as i64);
                }
                if v == 1 {
                    let rel = normalize(rel);
                    if !rel.is_empty() {
                        for &(i, _) in &rel {
                            counts[i] += 1;
                        }
                        out.push(rel);
                        stats.full += 1;
                    }
                } else if v <= lp_max as u128 && is_prime_u64(v as u64) {
                    // a large prime L: its sign as for a factor-base prime
                    let l = v as u64;
                    let Some(bl) = prime_form_b(d, l) else { continue };
                    let ml = 2 * l as i128;
                    let sl = if (bb - bl).rem_euclid(ml) == 0 { 1 } else { -1 };
                    match partials.remove(&l) {
                        None => {
                            partials.insert(l, (rel, sl));
                        }
                        Some((r1, s1)) => {
                            // s2 r1 - s1 r2 eliminates [L]
                            let mut comb: Relation = vec![];
                            for &(i, e) in &r1 {
                                add_to(&mut comb, i, sl as i64 * e);
                            }
                            for &(i, e) in &rel {
                                add_to(&mut comb, i, -(s1 as i64) * e);
                            }
                            let comb = normalize(comb);
                            if !comb.is_empty() {
                                for &(i, _) in &comb {
                                    counts[i] += 1;
                                }
                                out.push(comb);
                                stats.partial_pairs += 1;
                            }
                        }
                    }
                }
                if out.len() >= want || out.len() - start >= cap {
                    break;
                }
            }
            if out.len() >= want || out.len() - start >= cap {
                break;
            }
        }
    }
    out
}

pub fn is_prime_u64(n: u64) -> bool {
    if n < 2 {
        return false;
    }
    for p in [2u64, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37] {
        if n % p == 0 {
            return n == p;
        }
    }
    let (mut d, mut s) = (n - 1, 0);
    while d % 2 == 0 {
        d /= 2;
        s += 1;
    }
    'outer: for a in [2u64, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37] {
        let mut x = powmod(a, d, n);
        if x == 1 || x == n - 1 {
            continue;
        }
        for _ in 0..s - 1 {
            x = mulmod(x, x, n);
            if x == n - 1 {
                continue 'outer;
            }
        }
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::form::Form;
    use num_bigint::BigInt;

    /// Every relation composes to the identity.
    #[test]
    fn relations_are_relations() {
        for &d in &[-1_000_000_007i128 * 4 + 1, -(10i128.pow(12) + 39), -(10i128.pow(18) + 31), -(10i128.pow(24) + 7)] {
            if d.rem_euclid(4) != 1 && d.rem_euclid(4) != 0 {
                continue;
            }
            let ld = ((-d) as f64).ln();
            let fb = FactorBase::new(d, (6.0 * ld * ld) as u64);
            let par = Params { m: 1 << 13, small: 30, lp_mult: 30, slack: 2 };
            let mut st = Stats { polys: 0, candidates: 0, full: 0, partial_pairs: 0 };
            let mut counts = vec![0; fb.primes.len()];
            let rels = collect(&fb, 40, &par, 1, &mut st, &mut counts);
            let dd = BigInt::from(d);
            for r in &rels {
                let mut f = Form::identity(&dd);
                for &(i, e) in r {
                    let fp = &fb.primes[i];
                    let g = Form::new(BigInt::from(fp.p), BigInt::from(fp.b), &dd);
                    f = f.compose(&g.pow(e));
                }
                assert!(f.is_identity(), "D = {}: relation {:?} gives {:?}", d, r, f);
            }
        }
    }
}
