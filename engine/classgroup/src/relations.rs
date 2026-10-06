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
//! a relation, found with u64/i128 arithmetic (and one big-integer
//! division per polynomial, for c).

use crate::arith::*;
use sagebrush_bigint::BigInt;
use num_traits::ToPrimitive;

/// A prime ideal of norm p, as the prime form (p, b_p, .): b_p^2 = D mod 4p,
/// 0 <= b_p <= p.
#[derive(Clone, Debug)]
pub struct FbPrime {
    pub p: u64,
    pub b: i128,
    /// sqrt(D) mod p (0 when p | D); for the sieve
    pub t: u64,
    pub logp: u8,
    /// p^-1 mod 2^64 and floor((2^64 - 1) / p), for odd p: p | n iff
    /// n * pinv <= plim (mod 2^64)
    pub pinv: u64,
    pub plim: u64,
}

impl FbPrime {
    #[inline(always)]
    fn divides(&self, n: u64) -> bool {
        n.wrapping_mul(self.pinv) <= self.plim
    }
}

/// p^-1 mod 2^64 for odd p (Newton: each step doubles the correct bits).
fn inv_2_64(p: u64) -> u64 {
    let mut x = p; // correct to 3 bits
    for _ in 0..5 {
        x = x.wrapping_mul(2u64.wrapping_sub(p.wrapping_mul(x)));
    }
    x
}

pub struct FactorBase {
    pub d: BigInt,
    pub primes: Vec<FbPrime>,
    /// index of p in primes, by p (for large-prime lookups too)
    pub index: std::collections::HashMap<u64, usize>,
}

/// b with b^2 = D (mod 4p), 0 <= b <= p, b = D (mod 2); None if p is inert.
pub fn prime_form_b(d: &BigInt, p: u64) -> Option<i128> {
    let d8 = bigmod(d, 8);
    if p == 2 {
        return match d8 {
            1 => Some(1),
            0 => Some(0),
            4 => Some(2),
            _ => None,
        };
    }
    let dp = bigmod(d, p);
    if kronecker_res(d8, dp, p) < 0 {
        return None;
    }
    let mut t = sqrt_mod(dp, p) as i128;
    if (t - d8 as i128).rem_euclid(2) != 0 {
        t = p as i128 - t;
    }
    // b in [0, p] with b = t (mod p) and b = D (mod 2)
    Some(t)
}

impl FactorBase {
    pub fn new(d: &BigInt, bound: u64) -> FactorBase {
        let mut primes = vec![];
        let mut index = std::collections::HashMap::new();
        for p in primes_up_to(bound) {
            if let Some(b) = prime_form_b(d, p) {
                let t = if p == 2 { 0 } else { sqrt_mod(bigmod(d, p), p) };
                index.insert(p, primes.len());
                let (pinv, plim) = if p % 2 == 1 { (inv_2_64(p), u64::MAX / p) } else { (0, 0) };
                primes.push(FbPrime { p, b, t, logp: (p as f64).log2().round() as u8, pinv, plim });
            }
        }
        FactorBase { d: d.clone(), primes, index }
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

/// The element whose principal ideal a relation describes:
/// prod ((B + sqrt D) / 2)^c over the pairs (B, c).  Real quadratic fields
/// need it for the regulator.
pub type Elem = Vec<(i128, i64)>;

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
    /// only primes up to this are sieved and trial divided; a larger
    /// factor-base prime enters a relation as its prime cofactor
    pub sieve_bound: u64,
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
pub fn collect(fb: &FactorBase, want: usize, par: &Params, seed: u64, stats: &mut Stats, counts: &mut Vec<u32>) -> (Vec<Relation>, Vec<Elem>) {
    let d = &fb.d;
    let d_odd = bigmod(d, 2) as i128;
    let absd = d.to_f64().unwrap().abs();
    let real = d.sign() == sagebrush_bigint::Sign::Plus;
    let n = fb.primes.len();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ seed);
    let m = par.m;
    let width = (2 * m + 1) as usize;
    let mut sieve = vec![0u8; width];
    let mut out: Vec<Relation> = vec![];
    let mut elems: Vec<Elem> = vec![];
    let mut partials: std::collections::HashMap<u64, (Relation, i32, i128)> = std::collections::HashMap::new();
    let pmax = fb.primes.last().unwrap().p;
    let ns = fb.primes.partition_point(|fp| fp.p <= par.sieve_bound);
    let lp_max = pmax * par.lp_mult;
    // target a ~ sqrt(|D|) / (2m); choose q's of a size so that k is small
    // a so that |Q(x)| is balanced over |x| <= m: for D < 0, a m^2 = |D|/4a;
    // for D > 0 (Q changes sign), a m^2 = D/2a
    let target = ((if real { 2.0 } else { 1.0 } * absd).sqrt() / (2.0 * m as f64)).max(3.0);
    // candidate q's: odd FB primes (ramified ones too: their b is 0 mod q)
    let qs: Vec<usize> = (0..n).filter(|&i| fb.primes[i].p > 2 && fb.primes[i].p >= par.small.min(pmax / 4).max(3)).collect();
    // partners of the first q: sieved primes, which occur in many other
    // relations (partners that occur only together in the relations of
    // their own a would satisfy a parity relation and leave the lattice a
    // sublattice of index 2^k)
    let partners: Vec<usize> = {
        let sieved: Vec<usize> = qs.iter().cloned().filter(|&i| fb.primes[i].p <= par.sieve_bound).collect();
        if sieved.len() >= 30 { sieved } else { qs.clone() }
    };
    let pmax_partner = fb.primes[*partners.last().unwrap()].p as f64;
    // partners near size s: a window of about 60 around it
    let window = |s: f64| -> Vec<usize> {
        let center = partners.partition_point(|&i| (fb.primes[i].p as f64) < s).min(partners.len().saturating_sub(1));
        let lo = center.saturating_sub(30);
        let hi = (center + 30).min(partners.len());
        partners[lo..hi].to_vec()
    };
    // the sieve threshold for a polynomial with leading coefficient a
    let threshold = |a: f64| -> u8 {
        let vmax = (a * (m as f64) * (m as f64) + absd / (4.0 * a)).log2();
        ((vmax - (lp_max as f64).log2()).max(1.0) as u8).saturating_sub(par.slack)
    };
    let mut roots1 = vec![0i64; n];
    let mut roots2 = vec![0i64; n];
    let mut inv2a = vec![0u64; n];
    let mut tries = vec![0u32; n];
    assert!(pmax < 1 << 31);
    // polynomials since the last new relation: give up (rather than loop)
    // after very many, and let the caller change the parameters
    let mut idle = 0u64;
    while out.len() < want && idle < 50_000 {
        sagebrush_interrupt::check();
        let before = out.len();
        // the first q: the least covered prime (ties: random); then primes
        // making a close to the target
        // for D > 0 every other polynomial is free (a near the target, so
        // that Q(x) takes both signs): units come from products of the
        // elements, and with positive norms only, a unit of norm -1 (and so
        // the regulator itself) could never appear
        let covering = qs.iter().any(|&i| counts[i] == 0);
        let free = real && (!covering || rng.next() % 4 == 0) && rng.next() % 2 == 0;
        let q1 = if free {
            let j = ((target.ln() / (pmax_partner / 2.0).ln()).ceil() as usize).max(1);
            let win = window(target.powf(1.0 / j as f64));
            win[(rng.next() % win.len() as u64) as usize]
        } else {
            let least = qs.iter().map(|&i| counts[i]).min().unwrap_or(0);
            let low: Vec<usize> = qs.iter().cloned().filter(|&i| counts[i] == least).collect();
            low[(rng.next() % low.len() as u64) as usize]
        };
        let mut a_idx: Vec<usize> = vec![q1];
        tries[q1] += 1;
        let rest = target / fb.primes[q1].p as f64;
        let qmin = qs.first().map_or(3.0, |&i| fb.primes[i].p as f64);
        // a q1 that was tried before gets partners even when it alone is
        // big enough: a new polynomial each time
        if rest > 1.5 * qmin || tries[q1] > 1 {
            let j = ((rest.ln() / (pmax_partner / 2.0).ln()).ceil() as usize).max(1);
            let win = window(rest.max(qmin).powf(1.0 / j as f64));
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
        // (2a)^-1 mod p for the sieved primes; 0 marks the others (p small
        // or dividing a), which are trial divided directly
        for (i, fp) in fb.primes[..ns].iter().enumerate() {
            let p = fp.p;
            let ap = reduce(a, p);
            inv2a[i] = if p < par.small || ap == 0 { 0 } else { invmod(2 * ap % p, p) };
        }
        // all 2^(k-1) sign choices (the first sign fixed)
        for signs in 0..(1u64 << (k - 1)) {
            let mut b: i128 = bl[0];
            for l in 1..k {
                b += if signs >> (l - 1) & 1 == 1 { -bl[l] } else { bl[l] };
            }
            b = b.rem_euclid(a);
            if (b - d_odd).rem_euclid(2) != 0 {
                b += a; // a is odd: b^2 = D mod 4 as well
            }
            // c = (b^2 - D) / 4a, exact; |c| ~ |D| / 4a fits in i128
            let bb0 = BigInt::from(b);
            let c = ((&bb0 * &bb0 - d) / BigInt::from(4 * a)).to_i128().expect("c fits in i128");
            stats.polys += 1;
            // roots of a x^2 + b x + c mod p: x = (-b +- t) / 2a
            for (i, fp) in fb.primes[..ns].iter().enumerate() {
                let inv = inv2a[i];
                if inv == 0 {
                    roots1[i] = -1;
                    continue;
                }
                let p = fp.p;
                let mb = p - reduce(b, p);
                let r1 = (mb + fp.t) % p * inv % p;
                let r2 = (mb + p - fp.t) % p * inv % p;
                // first index i = x + m with x = r mod p
                roots1[i] = ((r1 + m as u64) % p) as i64;
                roots2[i] = ((r2 + m as u64) % p) as i64;
            }
            sieve.iter_mut().for_each(|s| *s = 0);
            for (i, fp) in fb.primes[..ns].iter().enumerate() {
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
                let val = a * xi * xi + b * xi + c; // > 0 when D < 0
                let mut v = val.unsigned_abs();
                let bb = 2 * a * xi + b;
                let mut rel: Relation = vec![];
                for (i, fp) in fb.primes[..ns].iter().enumerate() {
                    // a sieved prime divides Q(x) iff x is one of its roots
                    if roots1[i] >= 0 {
                        // (sieved primes are odd)
                        let ju = j as u64 + fp.p;
                        if !fp.divides(ju - roots1[i] as u64) && !fp.divides(ju - roots2[i] as u64) {
                            continue;
                        }
                    }
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
                if v > 1 && v <= pmax as u128 && ns < n && is_prime_u64(v as u64) {
                    // a factor-base prime above the sieve bound
                    if let Ok(i) = fb.primes.binary_search_by_key(&(v as u64), |fp| fp.p) {
                        add_to(&mut rel, i, fb.sign(i, bb) as i64);
                        v = 1;
                    }
                }
                if v == 1 {
                    let rel = normalize(rel);
                    if !rel.is_empty() {
                        for &(i, _) in &rel {
                            counts[i] += 1;
                        }
                        out.push(rel);
                        elems.push(vec![(bb, 1)]);
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
                            partials.insert(l, (rel, sl, bb));
                        }
                        Some((r1, s1, b1)) => {
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
                                elems.push(vec![(b1, sl as i64), (bb, -(s1 as i64))]);
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
        idle = if out.len() > before { 0 } else { idle + (1 << (k - 1)) };
    }
    (out, elems)
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
    // deterministic bases: {2, 7, 61} below 4759123141 (Jaeschke), the
    // first twelve primes below 3.3e24
    let bases: &[u64] = if n < 4_759_123_141 { &[2, 7, 61] } else { &[2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37] };
    'outer: for &a in bases {
        if a % n == 0 {
            continue;
        }
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
    use sagebrush_bigint::BigInt;

    #[test]
    fn primality() {
        let small = crate::arith::primes_up_to(200_000);
        for n in 0..200_000u64 {
            assert_eq!(is_prime_u64(n), small.binary_search(&n).is_ok(), "{}", n);
        }
        // strong pseudoprimes to some of the bases
        for n in [3215031751u64, 4759123141, 1122004669633, 3825123056546413051] {
            assert!(!is_prime_u64(n), "{}", n);
        }
        assert!(is_prime_u64(4294967291) && is_prime_u64((1 << 61) - 1));
    }

    #[test]
    fn divisibility_by_inverse() {
        for p in [3u64, 5, 7, 101, 65521, 1000003] {
            let fp = FbPrime { p, b: 0, t: 0, logp: 0, pinv: inv_2_64(p), plim: u64::MAX / p };
            for n in (0..5000u64).chain([u64::MAX - 7, 1 << 40, p * 12345]) {
                assert_eq!(fp.divides(n), n % p == 0, "{} | {}", p, n);
            }
        }
    }

    /// Every relation composes to the identity.
    #[test]
    fn relations_are_relations() {
        for &d in &[-1_000_000_007i128 * 4 + 1, -(10i128.pow(12) + 39), -(10i128.pow(18) + 31), -(10i128.pow(24) + 7)] {
            if d.rem_euclid(4) != 1 && d.rem_euclid(4) != 0 {
                continue;
            }
            let ld = ((-d) as f64).ln();
            let fb = FactorBase::new(&BigInt::from(d), (6.0 * ld * ld) as u64);
            let par = Params { m: 1 << 13, small: 30, lp_mult: 30, slack: 2, sieve_bound: 3000 };
            let mut st = Stats { polys: 0, candidates: 0, full: 0, partial_pairs: 0 };
            let mut counts = vec![0; fb.primes.len()];
            let (rels, _) = collect(&fb, 40, &par, 1, &mut st, &mut counts);
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
