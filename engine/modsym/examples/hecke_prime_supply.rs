//! Check-only: the ledger below which the twisted traces' up-front CRT
//! refusal (traces::orbit_hecke_traces_from) cannot fire for any input the
//! op's admission L admits.
//!
//! For each level n <= NMAX (whole space and new subspace), the least
//! weight k at which some level M | n the op visits needs more CRT primes
//! than the source holds (c > S(e_M), e_M = eisenstein_exponent(M)), with
//! c from an upper bound on hecke_traces_primes (q the largest prime below
//! 2^30, the orbit dimension bounded by the space's, len = Sturm + 1), and
//! the bytes L admits there (cusp_hecke_lower at prec = Sturm + 2): the
//! ledger threshold is the least such L.  A lower bound on c gives the
//! bracket.  S(e) is counted by a segmented sieve of [2^30, 2^32).
//!
//!     cargo run --release --example hecke_prime_supply [NMAX]

use sagebrush_modsym::hecke_q::{cusp_dim, cusp_hecke_lower, sturm_bound};
use sagebrush_modsym::newspace::eisenstein_exponent;
use std::collections::BTreeMap;

const Q: f64 = 1_073_741_789.0; // the largest prime below 2^30
const SIGMA0_MAX: f64 = 1344.0; // max sigma0(n) for n < 2^30

fn supply(es: &[u64]) -> BTreeMap<u64, u64> {
    let (lo, hi): (u64, u64) = (1 << 30, 1 << 32);
    let lim = 1u64 << 16;
    let mut small = vec![true; lim as usize + 1];
    small[0] = false;
    small[1] = false;
    let mut i = 2;
    while i * i <= lim {
        if small[i as usize] {
            let mut j = i * i;
            while j <= lim {
                small[j as usize] = false;
                j += i;
            }
        }
        i += 1;
    }
    let ps: Vec<u64> = (2..=lim).filter(|&p| small[p as usize]).collect();
    let mut counts: BTreeMap<u64, u64> = es.iter().map(|&e| (e, 0)).collect();
    let seg = 1u64 << 24;
    let mut a = lo;
    while a < hi {
        let b = (a + seg).min(hi);
        let mut s = vec![true; (b - a) as usize];
        for &p in &ps {
            let mut j = a.div_ceil(p) * p;
            while j < b {
                s[(j - a) as usize] = false;
                j += p;
            }
        }
        for (o, &v) in s.iter().enumerate() {
            if v {
                let l = a + o as u64;
                for (e, c) in counts.iter_mut() {
                    if (l - 1).is_multiple_of(*e) {
                        *c += 1;
                    }
                }
            }
        }
        a = b;
    }
    counts
}

/// Bounds on hecke_traces_primes(k, dim, len, Q).1: need = 2 dim A_q A^2,
/// A = max over m <= len of (floor(sqrt(m^(k-1))) + 1) sigma0(m).
fn crt_count(k: u64, dim: u64, len: u64) -> (u64, u64) {
    let h = (k - 1) as f64 / 2.0;
    let (lq, ll, ld) = (Q.log2(), (len as f64).log2(), (dim.max(1) as f64).log2());
    // upper: A <= (len^h + 1) sigma0_max, A_q <= 2 (q^h + 1); + 1 bit of slack each
    let up = 1.0 + ld + (1.0 + h * lq + 1.0) + 2.0 * (h * ll + 1.0 + SIGMA0_MAX.log2());
    // lower: A >= len^h (m = len), A_q >= 2 q^h
    let lo = 1.0 + ld + 1.0 + h * lq + 2.0 * h * ll;
    ((up / 30.0).ceil() as u64 + 1, (lo / 30.0).floor() as u64)
}

fn main() {
    let nmax: u64 = std::env::args().nth(1).map_or(200, |s| s.parse().unwrap());
    let divisors = |n: u64| (1..=n).filter(move |m| n.is_multiple_of(*m));
    let mut es: Vec<u64> = (1..=nmax).map(eisenstein_exponent).collect();
    es.sort();
    es.dedup();
    let s = supply(&es);
    println!("supply S(e) in [2^30, 2^32): {:?}", s);
    // (bytes at the threshold by the upper bound on c, and by the lower)
    let mut worst: Option<(u64, u64, u64, bool, u64, u64, u64)> = None;
    let mut rows = vec![];
    for n in 1..=nmax {
        for new_only in [false, true] {
            let levels: Vec<u64> = if new_only { vec![n] } else { divisors(n).collect() };
            let smin = levels.iter().map(|&m| s[&eisenstein_exponent(m)]).min().unwrap();
            let k_cap = (12u64 << 30) / sturm_bound(n, 12).unwrap().max(1); // len < 2^30
            // least k with c(k) > smin, by bisection on the bound `which`
            let first = |which: usize| -> Option<u64> {
                let short = |k: u64| -> bool {
                    let d = cusp_dim(n, k as usize, false);
                    let len = sturm_bound(n, k as usize).unwrap() + 1;
                    let c = crt_count(k, d, len);
                    (if which == 0 { c.0 } else { c.1 }) > smin
                };
                let (mut lo, mut hi) = (2u64, k_cap.max(2));
                if !short(hi) {
                    return None;
                }
                while hi - lo > 1 {
                    let mid = lo + (hi - lo) / 2;
                    if short(mid) {
                        hi = mid;
                    } else {
                        lo = mid;
                    }
                }
                Some(hi)
            };
            let (Some(k_up), Some(k_lo)) = (first(0), first(1)) else { continue };
            let bytes = |k: u64| cusp_hecke_lower(n, k as usize, sturm_bound(n, k as usize).unwrap() as usize + 2, new_only).1;
            let (b_up, b_lo) = (bytes(k_up), bytes(k_lo));
            if cusp_dim(n, k_up as usize, new_only) == 0 {
                continue;
            }
            rows.push((b_up, n, new_only, k_up, b_lo, k_lo, smin));
            if worst.is_none_or(|w| b_up < w.0) {
                worst = Some((b_up, n, k_up, new_only, b_lo, k_lo, smin));
            }
        }
    }
    rows.sort();
    println!("least thresholds (bytes L admits where c may exceed the supply; bracket by c's lower bound):");
    for (b_up, n, new_only, k_up, b_lo, k_lo, smin) in rows.iter().take(12) {
        println!("  N={:<4} new_only={:<5} k>={:<12} L={:.3e} B ({:.2} PiB)  [c's lower bound: k>={} L={:.3e}]  S={}", n, new_only, k_up, *b_up as f64, *b_up as f64 / 2f64.powi(50), k_lo, *b_lo as f64, smin);
    }
    let w = worst.unwrap();
    println!("worst: N={} k={} new_only={}: ledger threshold {:.3e} bytes = {:.2} PiB (bracket up to {:.3e})", w.1, w.2, w.3, w.0 as f64, w.0 as f64 / 2f64.powi(50), w.4 as f64);
}
