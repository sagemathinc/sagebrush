//! MultiCrt::new's Stop prefixes: the setup polls Stop once per quotient
//! Q_j, after charging it, so a Stop at the m-th poll has charged the
//! residues and inverses c_j, the product of the primes, half, and Q_0 ..
//! Q_{m-1} exactly, never a later Q_j nor the reciprocals.  The prefix is
//! rebuilt here by hand from the primes.  (A file of its own: the Stop
//! hooks are global.  Native only: a Stop unwinds, and wasm32 aborts on a
//! panic.)

#![cfg(not(target_arch = "wasm32"))]

use sagebrush_arith::cost::{bigmul_units, tallied, Family, FAMILIES};
use sagebrush_arith::crt::MultiCrt;
use sagebrush_arith::nmod::{Modulus, Primes};
use sagebrush_interrupt::hooks;

fn units_of<T>(f: impl FnOnce() -> T) -> ([u64; FAMILIES], u64) {
    sagebrush_interrupt::clear();
    hooks::reset();
    let before = tallied();
    let _ = f();
    let after = tallied();
    let checks = hooks::total();
    hooks::reset();
    let mut d = [0; FAMILIES];
    for (i, v) in d.iter_mut().enumerate() {
        *v = after.0[i].wrapping_sub(before.0[i]);
    }
    (d, checks)
}

fn stopped_at_check<T>(at: u64, f: impl FnOnce() -> T) -> [u64; FAMILIES] {
    sagebrush_interrupt::clear();
    hooks::reset();
    hooks::arm_at(at);
    let before = tallied();
    let r = sagebrush_interrupt::catch(f);
    let after = tallied();
    assert!(r.is_err(), "stopped");
    assert_eq!(hooks::total(), at, "the Stop came at the armed check");
    sagebrush_interrupt::clear();
    hooks::reset();
    let mut d = [0; FAMILIES];
    for (i, x) in d.iter_mut().enumerate() {
        *x = after.0[i].wrapping_sub(before.0[i]);
    }
    d
}

/// Little-endian words of the product of `ps`, and the MulSchool units of
/// building it a word at a time (each product at the length before it).
fn product(ps: impl Iterator<Item = u64>, mul: &mut u64) -> Vec<u64> {
    let mut x = vec![1u64];
    for p in ps {
        *mul += bigmul_units(x.len(), 1).get(Family::MulSchool);
        let mut carry = 0u128;
        for w in x.iter_mut() {
            let t = *w as u128 * p as u128 + carry;
            *w = t as u64;
            carry = t >> 64;
        }
        if carry > 0 {
            x.push(carry as u64);
        }
    }
    x
}

/// Euclid's quotient steps on (n, a mod n), counted here on their own.
fn euclid_steps(n: u64, a: u64) -> u64 {
    let (mut r0, mut r1, mut steps) = (n, a % n, 0);
    while r1 != 0 {
        (r0, r1) = (r1, r0 % r1);
        steps += 1;
    }
    steps
}

/// The units `new` charges before its first poll, and each Q_j's.
fn by_hand(primes: &[u64]) -> ([u64; FAMILIES], Vec<[u64; FAMILIES]>) {
    let (ma, mv, ms) = (Family::ModArith as usize, Family::Move as usize, Family::MulSchool as usize);
    let k = primes.len();
    let mut head = [0u64; FAMILIES];
    for j in 0..k {
        let m = Modulus::new(primes[j]);
        let prod = primes[..j].iter().fold(1 % m.n, |a, &p| m.mul(a, m.reduce(p)));
        head[ma] += 2 * j as u64 + euclid_steps(m.n, prod);
    }
    let all = product(primes.iter().copied(), &mut head[ms]);
    head[mv] += 2 * all.len() as u64;
    let qlen = all.len() + 1;
    let qs = (0..k)
        .map(|j| {
            let mut u = [0u64; FAMILIES];
            let qj = product(primes.iter().enumerate().filter(|&(i, _)| i != j).map(|(_, &p)| p), &mut u[ms]);
            let m = Modulus::new(primes[j]);
            let r = qj.iter().rev().fold(0u64, |r, &d| m.reduce_wide(r, d));
            u[ma] += qj.len() as u64 + euclid_steps(m.n, r);
            u[mv] += (qlen - qj.len()) as u64;
            u
        })
        .collect();
    (head, qs)
}

static HOOKS: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn a_stop_in_the_setup_charges_the_prefix() {
    let _g = HOOKS.lock().unwrap_or_else(|e| e.into_inner());
    for primes in [Primes::new().take(9).collect::<Vec<u64>>(), vec![2, 3, 5, 7, 11, 13], vec![u64::MAX - 58, u64::MAX - 82, u64::MAX - 94]] {
        let k = primes.len();
        let (head, qs) = by_hand(&primes);
        // the whole run: the head, every Q_j, the k reciprocals; k polls
        let (full, checks) = units_of(|| MultiCrt::new(&primes));
        assert_eq!(checks, k as u64, "one poll per Q_j");
        let mut want = head;
        for q in &qs {
            for (w, x) in want.iter_mut().zip(q) {
                *w += x;
            }
        }
        want[Family::ModArith as usize] += k as u64;
        assert_eq!(full, want, "{primes:?}: the setup's units, rebuilt");
        assert_eq!(full, MultiCrt::setup_units(&primes).0, "{primes:?}: its twin");
        // a Stop at poll m: the head and Q_0 .. Q_{m-1}
        let mut prefix = head;
        for (m, q) in qs.iter().enumerate() {
            for (w, x) in prefix.iter_mut().zip(q) {
                *w += x;
            }
            let got = stopped_at_check(m as u64 + 1, || MultiCrt::new(&primes));
            assert_eq!(got, prefix, "{primes:?}: a Stop at poll {}", m + 1);
        }
    }
}
