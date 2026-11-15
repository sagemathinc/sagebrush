//! Each of the small-prime table's two Stop checks works on its own: a Stop that lands in the marking passes is
//! seen there, before the primes are collected, and a call with no marking pass at all still sees a Stop while
//! collecting. (The feature test-hooks names the phase a Stop lands in.) A single test, because the flag and the
//! hooks are global to the process.
use sagebrush_interrupt::{catch, clear, hooks};
use sagebrush_primes::sieve::small_primes;

#[test]
fn each_phase_of_the_small_prime_table_sees_stop() {
    // the first check of small_primes(10^6) is a marking pass's (the odd primes up to 1000 are marked before
    // anything is collected): Stop there must be seen in marking
    hooks::reset();
    hooks::arm_after(1);
    let r = catch(|| small_primes(1_000_000));
    clear();
    assert!(r.is_err(), "Stop at the first check was not seen");
    assert_eq!(hooks::stopped_in(), "small_primes: marking");
    // n = 8 has no marking pass (3^2 > 8): only the collection's check can see Stop
    hooks::reset();
    hooks::arm_after(1);
    let r = catch(|| small_primes(8));
    clear();
    assert!(r.is_err(), "Stop in a call with no marking pass was not seen");
    assert_eq!(hooks::stopped_in(), "small_primes: collection");
    // and without a Stop both run to the end
    hooks::reset();
    assert_eq!(catch(|| small_primes(8)).unwrap(), vec![2, 3, 5, 7]);
    assert_eq!(catch(|| small_primes(1_000_000)).unwrap().len(), 78_498);
}
