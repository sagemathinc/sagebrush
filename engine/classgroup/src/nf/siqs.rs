//! The self-initializing quadratic sieve (SIQS): a nontrivial factor of a
//! composite n that is not a perfect power.
//!
//! With a multiplier k and a = q_1 ... q_s a product of factor-base primes,
//! b^2 = kn (mod a) and c = (b^2 - kn) / a, every x gives
//!     (a x + b)^2 = a g(x) (mod n),   g(x) = a x^2 + 2 b x + c.
//! g is sieved over |x| < M.  Where g(x) is smooth over the factor base (but
//! for at most one larger prime) the congruence is a relation; a set of
//! relations whose exponents sum to even numbers gives X^2 = Y^2 (mod n),
//! and gcd(X - Y, n) is a proper factor at least half the time.
//!
//! The polynomials of one a are its 2^(s - 1) values of b, visited in Gray
//! code order so that each prime's sieve roots change by one addition (S. P.
//! Contini, "Factoring integers with the self-initializing quadratic sieve",
//! 1997).  The multiplier is Knuth and
//! Schroeppel's (R. D. Silverman, "The multiple polynomial quadratic sieve",
//! Math. Comp. 48, 1987).  The layout follows the class group sieve
//! (relations.rs) and C. Swenson's rust-qsieve (MIT); the parameter table
//! started from the one in J. Papadopoulos's msieve (public domain).
//!
//! One flat sieve array per polynomial, a single large prime, and dense
//! Gaussian elimination over GF(2).

use crate::arith::{invmod, jacobi, primes_up_to, sqrt_mod};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::{rem_u64, BigInt, BigUint};
use std::collections::{HashMap, HashSet};

/// SIQS is used for composites of this many bits: below, ECM is as fast;
/// above, the dense matrix is too large.
pub const MIN_BITS: u64 = 90;
pub const MAX_BITS: u64 = 250;

/// More relations than columns, so that the matrix has this many
/// dependencies (each splits n with chance at least 1/2).
const EXTRA: usize = 48;
/// At most this many times the relations wanted are kept as partial
/// relations, each waiting for a second one with the same large prime.
const PARTIALS_MAX: usize = 8;
/// Primes below this are not sieved (a candidate is divided by them
/// directly); `slack` allows for their missing logarithms.
const SMALL: u32 = 30;
/// The primes of a are at most this (and at most half the largest
/// factor-base prime).
const A_PRIME_MAX: f64 = 4000.0;
/// At most this many values of a per run (a 250-bit n needs about 800):
/// the set of those used is in memory_bound.  Past it, the sieve gives up.
const A_MAX: usize = 1 << 14;

#[derive(Clone, Debug)]
pub struct Params {
    /// the number of factor-base primes
    pub fb_size: usize,
    /// the sieve is over |x| < m
    pub m: usize,
    /// a cofactor up to lp_mult times the largest factor-base prime is kept
    /// as a large prime
    pub lp_mult: u64,
    /// bits taken off the sieve threshold
    pub slack: u32,
}

/// (bits, fb_size, m, lp_mult, slack), interpolated linearly between rows.
const TABLE: [(u64, usize, usize, u64, u32); 9] = [
    (80, 120, 1 << 13, 30, 8),
    (100, 250, 1 << 14, 30, 8),
    (120, 500, 1 << 15, 40, 8),
    (140, 1000, 1 << 15, 40, 8),
    (160, 1900, 1 << 16, 40, 8),
    (180, 3000, 1 << 16, 40, 8),
    (200, 5000, 3 << 15, 50, 8),
    (220, 8000, 1 << 17, 60, 8),
    (250, 14000, 3 << 16, 80, 8),
];

/// The parameters for an n of `bits` bits.
pub fn params(bits: u64) -> Params {
    let row = |r: (u64, usize, usize, u64, u32)| Params { fb_size: r.1, m: r.2, lp_mult: r.3, slack: r.4 };
    if bits <= TABLE[0].0 {
        return row(TABLE[0]);
    }
    for w in TABLE.windows(2) {
        let (lo, hi) = (w[0], w[1]);
        if bits <= hi.0 {
            let f = (bits - lo.0) as f64 / (hi.0 - lo.0) as f64;
            let mix = |a: f64, b: f64| a + (b - a) * f;
            return Params {
                fb_size: mix(lo.1 as f64, hi.1 as f64) as usize,
                m: mix(lo.2 as f64, hi.2 as f64) as usize,
                lp_mult: mix(lo.3 as f64, hi.3 as f64) as u64,
                slack: mix(lo.4 as f64, hi.4 as f64).round() as u32,
            };
        }
    }
    row(TABLE[TABLE.len() - 1])
}

/// An upper bound on the bytes live while n of `bits` bits is sieved and
/// its matrix solved (for the estimator, nf/cost.rs): the prime table, the
/// factor base and its roots, the sieve, the relations (PARTIALS_MAX times
/// as many partial ones) and the matrix.
pub fn memory_bound(bits: u64) -> u128 {
    memory_bound_with(bits, &params(bits))
}

/// memory_bound for the parameters `par`.
pub fn memory_bound_with(bits: u64, par: &Params) -> u128 {
    let nfb = par.fb_size.max(40) as u128;
    let want = nfb + 1 + EXTRA as u128;
    // the primes of a: kn < 2^(bits + 6), and the largest factor-base
    // prime is at least the size-th prime, above 4 size
    let qcap = (2.0 * nfb as f64).min(A_PRIME_MAX);
    let s = ((bits as f64 + 7.0) / 2.0 * std::f64::consts::LN_2 / qcap.ln()).ceil() as u128 + 3;
    // the table of primes, if the first bound had to be doubled once
    let table = 2 * (30 * nfb + 1000);
    let primes = table + 1 + 16 * super::cost::pi_plus(table as u64) as u128 + 64;
    let base = nfb * (25 + 9 + 4 * s) + 2 * par.m as u128 + 64;
    // a relation: t, and its columns (at most s + 1 + log2 |g|, four bytes
    // each); a combined one has the columns of two
    let t = 8 * bits.div_ceil(64) as u128 + 64;
    let cols = 4 * (bits as u128 / 2 + s + 24) + 64;
    let rels = want * (t + 2 * cols) + PARTIALS_MAX as u128 * want * (t + cols + 160);
    // the rows' odd columns, then the bits
    let matrix = want * cols + want * 2 * want.div_ceil(64) * 8;
    // the values of a used: s indices each, in a hash set of up to twice
    // as many slots
    let used = 2 * A_MAX as u128 * (8 * s + 48);
    primes + base + rels + matrix + used + 4 * nfb + 4096
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub multiplier: u32,
    pub a_primes: usize,
    pub polys: u64,
    pub candidates: u64,
    pub full: u64,
    pub partial: u64,
    pub combined: u64,
    /// the matrix after removing singletons: rows and columns
    pub matrix: (usize, usize),
    pub dependencies: usize,
}

/// 2^64 / the golden ratio, mixed into the caller's seed: xorshift's state
/// must not be zero, and a small seed alone leaves its first outputs with
/// few bits set.
const SEED_MIX: u64 = 0x9E37_79B9_7F4A_7C15;

/// xorshift64, for choosing the primes of a.  The engine has no source of
/// entropy (its only import on wasm32 is the interrupt flag), so a run is
/// a function of n and the seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// Knuth and Schroeppel's multiplier: the odd squarefree k for which kn has
/// the most small primes in its factor base, weighed by their logarithms.
fn multiplier(n: &BigInt) -> u32 {
    const KS: [u32; 20] = [1, 3, 5, 7, 11, 13, 15, 17, 19, 21, 23, 29, 31, 33, 35, 37, 39, 41, 43, 47];
    let primes: Vec<(u64, u64)> = primes_up_to(400)[1..].iter().map(|&p| (p, rem_u64(n, p))).collect();
    let n8 = rem_u64(n, 8);
    let ln2 = std::f64::consts::LN_2;
    let mut best = (f64::NEG_INFINITY, 1);
    for k in KS {
        let mut score = -0.5 * (k as f64).ln();
        score += match k as u64 * n8 % 8 {
            1 => 2.0 * ln2,
            5 => ln2,
            _ => 0.5 * ln2,
        };
        for &(p, np) in &primes {
            let r = k as u64 % p * np % p;
            let lp = (p as f64).ln();
            if r == 0 {
                score += lp / p as f64;
            } else if jacobi(r, p) == 1 {
                score += 2.0 * lp / (p - 1) as f64;
            }
        }
        if score > best.0 {
            best = (score, k);
        }
    }
    best.1
}

/// The factor base of kn: 2, then the odd primes p with kn a square mod p
/// (those dividing k included).
struct Fb {
    p: Vec<u32>,
    /// sqrt(kn) mod p
    t: Vec<u32>,
    logp: Vec<u8>,
    /// p^-1 mod 2^64 and floor((2^64 - 1) / p): p | x iff x * pinv <= plim
    /// (mod 2^64)
    pinv: Vec<u64>,
    plim: Vec<u64>,
}

impl Fb {
    /// Err is a prime factor of n met on the way.
    fn new(kn: &BigInt, n: &BigInt, size: usize) -> Result<Fb, u64> {
        let mut fb = Fb { p: vec![2], t: vec![1], logp: vec![1], pinv: vec![0], plim: vec![0] };
        let mut bound = 30 * size as u64 + 1000;
        loop {
            for &p in &primes_up_to(bound)[1..] {
                if fb.p.len() >= size || p <= *fb.p.last().unwrap() as u64 {
                    continue;
                }
                let r = rem_u64(kn, p);
                if r == 0 && rem_u64(n, p) == 0 {
                    return Err(p);
                }
                if r == 0 || jacobi(r, p) == 1 {
                    let mut inv = p; // Newton: each step doubles the correct bits
                    for _ in 0..5 {
                        inv = inv.wrapping_mul(2u64.wrapping_sub(p.wrapping_mul(inv)));
                    }
                    fb.p.push(p as u32);
                    fb.t.push(sqrt_mod(r, p) as u32);
                    fb.logp.push((p as f64).log2().round() as u8);
                    fb.pinv.push(inv);
                    fb.plim.push(u64::MAX / p);
                }
            }
            if fb.p.len() >= size {
                return Ok(fb);
            }
            bound *= 2;
        }
    }

    #[inline(always)]
    fn divides(&self, i: usize, x: u64) -> bool {
        x.wrapping_mul(self.pinv[i]) <= self.plim[i]
    }
}

/// A relation: t^2 = (-1)^e0 prod p_i^e_i * lp^2 (mod n).  `cols` lists the
/// columns with multiplicity: 0 is the sign, i + 1 is the i-th prime.
struct Rel {
    t: BigInt,
    cols: Vec<u32>,
    lp: u64,
}

// The loops below are functions of their own, never inlined: a WebAssembly
// host optimizes a function between calls, not while it runs, so a loop
// inside one long call would run as first compiled for the whole sieve.

/// For a = prod q with b = sum of (a / q_l) gamma_l: each sieved prime's
/// roots of g, x = (+-t - b) / a, as sieve indices x + m, and delta[l], the
/// roots' change when the sign of B_l flips: 2 B_l / a = 2 gamma_l / q_l.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn init_roots(fb: &Fb, first: usize, q: &[u64], gamma: &[u64], m: u64, r1: &mut [u32], r2: &mut [u32], slog: &mut [u8], delta: &mut [Vec<u32>]) {
    let s = q.len();
    let mut pre = vec![1u64; s + 1];
    let mut suf = vec![1u64; s + 1];
    for i in first..fb.p.len() {
        let p = fb.p[i] as u64;
        for l in 0..s {
            pre[l + 1] = pre[l] * (q[l] % p) % p;
        }
        for l in (0..s).rev() {
            suf[l] = suf[l + 1] * (q[l] % p) % p;
        }
        if pre[s] == 0 {
            // p divides a: g has one root there; found by division
            (r1[i], r2[i], slog[i]) = (0, 0, 0);
            for d in delta.iter_mut() {
                d[i] = 0;
            }
            continue;
        }
        let ainv = invmod(pre[s], p);
        let mut bm = 0;
        for l in 0..s {
            let aq = pre[l] * suf[l + 1] % p; // a / q_l
            bm = (bm + aq * (gamma[l] % p)) % p;
            delta[l][i] = (2 * (gamma[l] % p) % p * (ainv * aq % p) % p) as u32;
        }
        let t = fb.t[i] as u64;
        r1[i] = ((ainv * (t + p - bm) + m) % p) as u32;
        r2[i] = ((ainv * (2 * p - t - bm) + m) % p) as u32;
        slog[i] = fb.logp[i];
    }
}

/// The roots after b changes by -2 B_l (`up`) or +2 B_l.
#[inline(never)]
fn step_roots(p: &[u32], d: &[u32], up: bool, r1: &mut [u32], r2: &mut [u32]) {
    for (((&p, &d), x), y) in p.iter().zip(d).zip(r1).zip(r2) {
        let step = if up { d } else { p - d };
        *x += step;
        if *x >= p {
            *x -= p;
        }
        *y += step;
        if *y >= p {
            *y -= p;
        }
    }
}

/// One polynomial's sieve: every byte starts at `init` and gains log p at
/// each root of each prime.
#[inline(never)]
fn sieve_pass(sieve: &mut [u8], init: u8, p: &[u32], slog: &[u8], r1: &[u32], r2: &[u32]) {
    sieve.fill(init);
    for i in 0..p.len() {
        let (p, lg) = (p[i] as usize, slog[i]);
        let mut j = r1[i] as usize;
        while j < sieve.len() {
            sieve[j] = sieve[j].wrapping_add(lg);
            j += p;
        }
        if r2[i] != r1[i] {
            let mut j = r2[i] as usize;
            while j < sieve.len() {
                sieve[j] = sieve[j].wrapping_add(lg);
                j += p;
            }
        }
    }
}

/// The indices whose byte reached 128.
#[inline(never)]
fn scan(sieve: &[u8], found: &mut Vec<u32>) {
    for (ci, chunk) in sieve.chunks_exact(8).enumerate() {
        if u64::from_le_bytes(chunk.try_into().unwrap()) & 0x8080_8080_8080_8080 == 0 {
            continue;
        }
        for (bi, &byte) in chunk.iter().enumerate() {
            if byte >= 128 {
                found.push((ci * 8 + bi) as u32);
            }
        }
    }
}

/// Divides v = |g(x)|, x at sieve index j, by the factor-base primes, and
/// adds their columns: the unsieved primes and those of a (`idx`) by
/// division, a sieved prime only if x is one of its roots.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn trial_divide(fb: &Fb, first: usize, idx: &[usize], r1: &[u32], r2: &[u32], slog: &[u8], j: u64, v: &mut BigInt, cols: &mut Vec<u32>) {
    let divide = |v: &mut BigInt, i: usize, cols: &mut Vec<u32>| {
        let p = fb.p[i] as u64;
        while rem_u64(v, p) == 0 {
            *v /= BigInt::from(p);
            cols.push(i as u32 + 1);
        }
    };
    for i in 0..first {
        divide(v, i, cols);
    }
    for i in first..fb.p.len() {
        let jp = j + fb.p[i] as u64;
        if fb.divides(i, jp - r1[i] as u64) || fb.divides(i, jp - r2[i] as u64) {
            debug_assert!(slog[i] == 0 || rem_u64(v, fb.p[i] as u64) == 0);
            divide(v, i, cols);
        }
    }
    for &i in idx {
        divide(v, i, cols);
    }
}

/// row ^= pivot for each row of `rows` (of `stride` words, of which the
/// pivot holds those from w on) with `bit` set in word w.
#[inline(never)]
fn clear_column(rows: &mut [u64], pivot: &[u64], stride: usize, w: usize, bit: u64) {
    for row in rows.chunks_exact_mut(stride) {
        if row[w] & bit != 0 {
            for (x, y) in row[w..].iter_mut().zip(pivot) {
                *x ^= y;
            }
        }
    }
}

/// A nontrivial factor of n (odd, composite, not a perfect power), or None
/// if no dependency splits n or no new polynomial is left.  The sieve's
/// memory_bound is reserved with the engine's memory ledger before anything
/// is built and held while it runs; refused, the ledger's error, never
/// another route (memory decides only whether the sieve runs).  `seed`
/// selects the polynomials: the same seed gives the same run.
pub fn siqs(n: &BigUint, seed: u64) -> Result<Option<BigUint>, sagebrush_ledger::EngineError> {
    siqs_with(n, &params(n.bits() as u64), seed, &mut Stats::default())
}

/// What the sieve's reservation is, in a refusal.
pub const WHAT: &str = "the quadratic sieve";

/// siqs with the parameters `par` (and its statistics), its memory_bound
/// for them reserved the same way.
pub fn siqs_with(n: &BigUint, par: &Params, seed: u64, stats: &mut Stats) -> Result<Option<BigUint>, sagebrush_ledger::EngineError> {
    // (the bound is far below 2^64 bytes for any n and parameters this
    // module makes)
    let _held = sagebrush_ledger::reserve(WHAT, memory_bound_with(n.bits() as u64, par) as u64)?;
    Ok(sieve(n, par, seed, stats))
}

fn sieve(n: &BigUint, par: &Params, seed: u64, stats: &mut Stats) -> Option<BigUint> {
    let n = BigInt::from(n.clone());
    let k = multiplier(&n);
    stats.multiplier = k;
    let kn = &n * BigInt::from(k);
    let fb = match Fb::new(&kn, &n, par.fb_size.max(40)) {
        Ok(fb) => fb,
        Err(p) => return Some(BigUint::from(p)),
    };
    let nfb = fb.p.len();
    let pmax = *fb.p.last().unwrap() as u64;
    let lp_max = pmax * par.lp_mult.clamp(1, pmax);
    let m = par.m.max(1 << 10).next_multiple_of(8);
    let len = 2 * m;
    let first = fb.p.partition_point(|&p| p < SMALL);

    // |g(x)| <= M sqrt(kn / 2) on the interval when a = sqrt(2 kn) / M
    let log_kn = kn.to_f64().unwrap().log2();
    let log_gmax = (m as f64).log2() + 0.5 * log_kn - 0.5;
    let thresh = (log_gmax - (lp_max as f64).log2() - par.slack as f64).clamp(10.0, 127.0) as u8;
    // a byte reaches 128 when its logarithms reach the threshold
    let init = 128 - thresh;

    // the primes of a: s of them near target^(1/s)
    let ln_target = (0.5 * (log_kn + 1.0) - (m as f64).log2()) * std::f64::consts::LN_2;
    let qcap = (pmax as f64 / 2.0).min(A_PRIME_MAX);
    let s = ((ln_target / qcap.ln()).ceil() as usize).max(3);
    stats.a_primes = s;
    let center = fb.p.partition_point(|&p| (p as f64) < (ln_target / s as f64).exp());
    // candidates: sieved primes not dividing k
    let usable = |i: usize| i >= first && i < nfb && fb.t[i] != 0;
    let win_lo = center.saturating_sub(20).max(first);
    let win_hi = (center + 20).min(nfb);
    let window: Vec<usize> = (win_lo..win_hi).filter(|&i| usable(i)).collect();
    if window.len() < s {
        return None;
    }

    let mut rng = Rng((SEED_MIX ^ seed) | 1);
    let mut used: HashSet<Vec<usize>> = HashSet::new();
    let mut sieve = vec![0u8; len];
    let mut r1 = vec![0u32; nfb];
    let mut r2 = vec![0u32; nfb];
    let mut slog = vec![0u8; nfb];
    let mut delta = vec![vec![0u32; nfb]; s];
    let mut found: Vec<u32> = vec![];
    let mut rels: Vec<Rel> = vec![];
    let mut partials: HashMap<u64, (BigInt, Vec<u32>)> = HashMap::new();
    let want = nfb + 1 + EXTRA;

    while rels.len() < want {
        // a new a: s - 1 primes from the window, and the prime that brings
        // the product nearest the target
        let mut idx: Vec<usize> = vec![];
        let mut chosen = false;
        for _ in 0..2000 {
            idx.clear();
            while idx.len() < s - 1 {
                let i = window[(rng.next() % window.len() as u64) as usize];
                if !idx.contains(&i) {
                    idx.push(i);
                }
            }
            let rest = (ln_target - idx.iter().map(|&i| (fb.p[i] as f64).ln()).sum::<f64>()).exp();
            let j = fb.p.partition_point(|&p| (p as f64) < rest);
            let last = (j.saturating_sub(2)..(j + 3).min(nfb))
                .filter(|&i| usable(i) && !idx.contains(&i))
                .min_by(|&x, &y| (fb.p[x] as f64 - rest).abs().total_cmp(&(fb.p[y] as f64 - rest).abs()));
            let Some(last) = last else { continue };
            if (fb.p[last] as f64) < rest / 1.5 || fb.p[last] as f64 > rest * 1.5 {
                continue;
            }
            idx.push(last);
            idx.sort();
            if used.insert(idx.clone()) {
                chosen = true;
                break;
            }
            idx.clear();
        }
        // (a selection that never completed can leave s - 1 primes in idx)
        if !chosen || used.len() > A_MAX {
            return None;
        }
        let q: Vec<u64> = idx.iter().map(|&i| fb.p[i] as u64).collect();
        let a: BigInt = q.iter().map(|&x| BigInt::from(x)).product();
        // B_l = (a / q_l) gamma_l with gamma_l = sqrt(kn) (a / q_l)^-1 mod
        // q_l: b = sum of +-B_l has b^2 = kn (mod a)
        let mut gamma = vec![0u64; s];
        let mut bl: Vec<BigInt> = vec![];
        for l in 0..s {
            let aq = &a / BigInt::from(q[l]);
            let g = fb.t[idx[l]] as u64 * invmod(rem_u64(&aq, q[l]), q[l]) % q[l];
            gamma[l] = g.min(q[l] - g);
            bl.push(aq * BigInt::from(gamma[l]));
        }
        let mut b: BigInt = bl.iter().sum();
        init_roots(&fb, first, &q, &gamma, m as u64, &mut r1, &mut r2, &mut slog, &mut delta);
        let a_cols: Vec<u32> = idx.iter().map(|&i| i as u32 + 1).collect();
        let mut plus = vec![true; s];

        for poly in 0..1u64 << (s - 1) {
            // (a polynomial is a whole sieve pass: the host is asked at each)
            sagebrush_interrupt::check_coarse();
            if poly > 0 {
                // Gray code: flip the sign of one B_l
                let l = poly.trailing_zeros() as usize;
                let up = plus[l]; // b decreases by 2 B_l: the roots increase
                plus[l] = !up;
                if up {
                    b -= &bl[l] * BigInt::from(2);
                } else {
                    b += &bl[l] * BigInt::from(2);
                }
                step_roots(&fb.p[first..], &delta[l][first..], up, &mut r1[first..], &mut r2[first..]);
            }
            stats.polys += 1;
            let c = (&b * &b - &kn) / &a;
            debug_assert!(((&b * &b - &kn) % &a).is_zero());

            sieve_pass(&mut sieve, init, &fb.p[first..], &slog[first..], &r1[first..], &r2[first..]);
            found.clear();
            scan(&sieve, &mut found);
            for &j in &found {
                stats.candidates += 1;
                let j = j as u64;
                let x = BigInt::from(j as i64 - m as i64);
                let g = (&a * &x + &b * BigInt::from(2)) * &x + &c;
                let mut cols = a_cols.clone();
                if g.is_negative() {
                    cols.push(0);
                }
                let mut v = g.abs();
                trial_divide(&fb, first, &idx, &r1, &r2, &slog, j, &mut v, &mut cols);
                let t = (&a * &x + &b).mod_floor(&n);
                cols.shrink_to_fit();
                if v.is_one() {
                    stats.full += 1;
                    rels.push(Rel { t, cols, lp: 0 });
                } else if let Some(l) = v.to_u64().filter(|&l| l <= lp_max) {
                    // (prime: every prime factor of g(x) below pmax is
                    // in the factor base, and l <= pmax^2)
                    stats.partial += 1;
                    match partials.get(&l) {
                        None => {
                            if partials.len() < PARTIALS_MAX * want {
                                partials.insert(l, (t, cols));
                            }
                        }
                        Some((t0, cols0)) => {
                            stats.combined += 1;
                            cols.extend_from_slice(cols0);
                            cols.shrink_to_fit();
                            rels.push(Rel { t: (t * t0).mod_floor(&n), cols, lp: l });
                        }
                    }
                }
            }
            if rels.len() >= want {
                break;
            }
        }
    }

    let deps = dependencies(&rels, nfb + 1, stats);
    for dep in deps {
        sagebrush_interrupt::check_coarse();
        let (mut x, mut y) = (BigInt::one(), BigInt::one());
        let mut exps = vec![0u32; nfb + 1];
        for &ri in &dep {
            let r = &rels[ri];
            x = (x * &r.t).mod_floor(&n);
            for &c in &r.cols {
                exps[c as usize] += 1;
            }
            if r.lp != 0 {
                y = (y * BigInt::from(r.lp)).mod_floor(&n);
            }
        }
        debug_assert!(exps.iter().all(|e| e % 2 == 0));
        for (i, &e) in exps.iter().enumerate().skip(1) {
            if e > 0 {
                y = (y * BigInt::from(fb.p[i - 1]).modpow(&BigInt::from(e / 2), &n)).mod_floor(&n);
            }
        }
        debug_assert!(((&x * &x - &y * &y) % &n).is_zero());
        for d in [&x - &y, &x + &y] {
            let g = d.gcd(&n);
            if !g.is_one() && g != n {
                return g.to_biguint();
            }
        }
    }
    None
}

/// Sets of relations whose exponent vectors sum to zero mod 2: relations
/// holding the only occurrence of a column are dropped, then dense Gaussian
/// elimination with a record of the rows combined.
fn dependencies(rels: &[Rel], ncols: usize, stats: &mut Stats) -> Vec<Vec<usize>> {
    // each relation's columns of odd exponent
    let rows: Vec<Vec<u32>> = rels
        .iter()
        .map(|r| {
            let mut c = r.cols.clone();
            c.sort_unstable();
            let mut odd = vec![];
            for g in c.chunk_by(|x, y| x == y) {
                if g.len() % 2 == 1 {
                    odd.push(g[0]);
                }
            }
            odd
        })
        .collect();
    let mut weight = vec![0u32; ncols];
    for r in &rows {
        for &c in r {
            weight[c as usize] += 1;
        }
    }
    let mut alive = vec![true; rows.len()];
    loop {
        let mut changed = false;
        for (ri, r) in rows.iter().enumerate() {
            if alive[ri] && r.iter().any(|&c| weight[c as usize] == 1) {
                alive[ri] = false;
                changed = true;
                for &c in r {
                    weight[c as usize] -= 1;
                }
            }
        }
        if !changed {
            break;
        }
    }
    let mut col_of = vec![usize::MAX; ncols];
    let mut nc = 0;
    for c in 0..ncols {
        if weight[c] > 0 {
            col_of[c] = nc;
            nc += 1;
        }
    }
    // no more rows than give EXTRA dependencies
    let keep: Vec<usize> = (0..rows.len()).filter(|&i| alive[i]).take(nc + EXTRA).collect();
    let nr = keep.len();
    stats.matrix = (nr, nc);
    // row r: nc column bits, then nr record bits
    let wc = nc.div_ceil(64);
    let stride = wc + nr.div_ceil(64);
    let mut mat = vec![0u64; nr * stride];
    for (r, &ri) in keep.iter().enumerate() {
        for &c in &rows[ri] {
            let c = col_of[c as usize];
            mat[r * stride + c / 64] ^= 1 << (c % 64);
        }
        mat[r * stride + wc + r / 64] |= 1 << (r % 64);
    }
    let mut rank = 0;
    for c in 0..nc {
        sagebrush_interrupt::check_coarse();
        let (w, bit) = (c / 64, 1u64 << (c % 64));
        let Some(pr) = (rank..nr).find(|&r| mat[r * stride + w] & bit != 0) else { continue };
        if pr != rank {
            let (head, tail) = mat.split_at_mut(pr * stride);
            head[rank * stride..(rank + 1) * stride].swap_with_slice(&mut tail[..stride]);
        }
        let (head, tail) = mat.split_at_mut((rank + 1) * stride);
        clear_column(tail, &head[rank * stride + w..], stride, w, bit);
        rank += 1;
    }
    // the rows below the rank are zero: their records are dependencies
    let deps: Vec<Vec<usize>> = (rank..nr)
        .map(|r| {
            let rec = &mat[r * stride + wc..(r + 1) * stride];
            (0..nr).filter(|&i| rec[i / 64] >> (i % 64) & 1 == 1).map(|i| keep[i]).collect()
        })
        .collect();
    stats.dependencies = deps.len();
    deps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(p: &str, q: &str) {
        let (p, q): (BigUint, BigUint) = (p.parse().unwrap(), q.parse().unwrap());
        let n = &p * &q;
        let mut st = Stats::default();
        let g = siqs_with(&n, &params(n.bits() as u64), 1, &mut st).unwrap().unwrap_or_else(|| panic!("no factor of {}: {:?}", n, st));
        assert!(g == p || g == q, "{} from {}: {:?}", g, n, st);
    }

    #[test]
    fn splits_semiprimes() {
        // 2^50 - 27 and 2^50 - 35; 2^64 - 59 and 2^64 - 83; 2^80 - 65 and
        // 2^80 - 143
        check("1125899906842597", "1125899906842589");
        check("18446744073709551557", "18446744073709551533");
        check("1208925819614629174706111", "1208925819614629174706033");
    }

    #[test]
    fn splits_unbalanced_and_three_factors() {
        // 2^31 - 1 times 2^89 - 1
        check("2147483647", "618970019642690137449562111");
        // (2^50 - 27)(2^50 - 35)(2^61 - 1): any proper factor
        let ps: Vec<BigUint> = ["1125899906842597", "1125899906842589", "2305843009213693951"].iter().map(|s| s.parse().unwrap()).collect();
        let n: BigUint = ps.iter().cloned().product();
        let g = siqs(&n, 3).unwrap().unwrap();
        assert!(!g.is_one() && g != n && (&n % &g).is_zero());
    }

    #[test]
    fn multiplier_makes_small_primes_split() {
        // 3 n = 1 mod 8 for n = 3 mod 8
        let n: BigInt = "1208925819614629174706111".parse::<BigInt>().unwrap() * "1208925819614629174706033".parse::<BigInt>().unwrap();
        let k = multiplier(&n);
        assert!(k % 2 == 1 && k < 48);
        let kn = &n * BigInt::from(k);
        let fb = Fb::new(&kn, &n, 200).unwrap();
        assert_eq!(fb.p.len(), 200);
        for i in 1..fb.p.len() {
            let p = fb.p[i] as u64;
            assert_eq!(fb.t[i] as u64 * fb.t[i] as u64 % p, rem_u64(&kn, p));
            assert!(fb.divides(i, 7 * p) && !fb.divides(i, 7 * p + 1));
        }
    }

    // Below factor()'s range a selection of a can fail to complete (s - 1
    // primes chosen when the 2000 tries run out): None, never an index past
    // the selection (a panic, cx7's P2 on #2451).
    #[test]
    fn an_incomplete_selection_of_a_gives_none() {
        let n: BigUint = "512002022965249".parse().unwrap();
        let _ = siqs(&n, 1).unwrap();
        let tiny = Params { fb_size: 40, m: 32768, lp_mult: 40, slack: 8 };
        let _ = siqs_with(&n, &tiny, 1, &mut Stats::default()).unwrap();
    }

    #[test]
    fn parameters_interpolate() {
        assert_eq!(params(160).fb_size, 1900);
        let p = params(170);
        assert!(p.fb_size > 1900 && p.fb_size < 3000);
        assert_eq!(params(60).fb_size, params(80).fb_size);
        assert_eq!(params(400).fb_size, params(250).fb_size);
    }

    #[test]
    fn dependencies_sum_to_squares() {
        // columns 1, 2, 3: rows {1,2}, {2,3}, {1,3}, {1,1} and a singleton {4}
        let rel = |cols: &[u32]| Rel { t: BigInt::one(), cols: cols.to_vec(), lp: 0 };
        let rels = vec![rel(&[1, 2]), rel(&[2, 3]), rel(&[1, 3]), rel(&[1, 1]), rel(&[4, 1])];
        let deps = dependencies(&rels, 5, &mut Stats::default());
        assert_eq!(deps.len(), 2);
        for d in &deps {
            let mut e = [0u32; 5];
            for &r in d {
                assert_ne!(r, 4);
                for &c in &rels[r].cols {
                    e[c as usize] += 1;
                }
            }
            assert!(!d.is_empty() && e.iter().all(|x| x % 2 == 0));
        }
    }
}
