//! Stop inside one prime's marking pass and inside one segment's primes (Codex A14-F1), in its own test
//! binary: the interrupt flag and the check counters are process-wide.  Each loop's polls are traced on a
//! full run, then Stop is armed at one of them: the call unwinds at that loop, and the next call works.
use sagebrush_interrupt::hooks;
use sagebrush_primes::count_in;
use sagebrush_primes::sieve::small_primes;

/// Trace `f`'s polls in `site`, then Stop at the `pick`-th of them; returns how many there were.
fn stop_at(site: &str, pick: usize, f: impl Fn()) -> usize {
    sagebrush_interrupt::clear();
    hooks::reset();
    hooks::trace();
    f();
    let idx = hooks::traced(site);
    hooks::reset();
    assert!(idx.len() > pick, "{site}: {} polls", idx.len());
    hooks::arm_at(idx[pick]);
    let r = sagebrush_interrupt::catch(&f);
    let at = hooks::stopped_in();
    hooks::reset();
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "{site}: not interrupted");
    assert_eq!(at, site);
    idx.len()
}

/// The polls of small_primes(n)'s marking when each pass polls after every `chunk` marks and at its end:
/// the pass of an odd prime p (p^2 <= n) marks the odd multiples from p^2, so ceil(marks / chunk) polls.
fn marking_polls(n: u64, chunk: u64) -> usize {
    let half = (n - 1) / 2 + 1;
    let root = (n as f64).sqrt() as u64 + 1;
    small_primes(root).iter().map(|&p| p as u64).filter(|&p| p > 2 && p * p <= n).map(|p| (half - p * p / 2).div_ceil(p).div_ceil(chunk) as usize).sum()
}

#[test]
fn stop_inside_a_pass_and_a_segment() {
    // n = 2 * 10^7: the pass of p = 3 alone is n / 6 marks, more than 3 * 2^20, so it polls 4 times
    // itself; Stop at the second poll is inside that pass (one poll a pass saw it only after the pass)
    let n = 20_000_000;
    let polls = stop_at("small primes marking", 1, || assert_eq!(small_primes(n).len(), 1_270_607));
    // exactly one poll every 2^20 marks of a pass (and one at its end): one poll a pass would be 5 fewer
    assert_eq!(polls, marking_polls(n, 1 << 20));
    assert_eq!(marking_polls(n, 1 << 20) - marking_polls(n, u64::MAX), 5);
    // a window just above 2^42 is sieved by the 155610 odd primes up to 2^21, polled every 2^16 of them
    let lo = 1u64 << 42;
    let polls = stop_at("sieve segment primes", 0, || assert_eq!(count_in(lo, lo + 1000), 33));
    assert!(polls >= 2, "{polls} polls in the segment");
    // and afterwards they run normally
    assert_eq!(small_primes(n).len(), 1_270_607);
    assert_eq!(count_in(0, 100), 25);
}
