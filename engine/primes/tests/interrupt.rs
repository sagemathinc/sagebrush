//! Stop is seen in every long loop of the crate: the small-prime table, the segmented sieve and prime_pi's
//! segments each unwind with sagebrush_interrupt::Interrupted once an interrupt is requested, and the next
//! call works normally.  A single test, because the flag is global to the process.
use sagebrush_primes::sieve::small_primes;
use sagebrush_primes::{count_in, prime_pi};

#[test]
fn the_long_loops_see_stop() {
    sagebrush_interrupt::request();
    let table = sagebrush_interrupt::catch(|| small_primes(10_000_000));
    let window = sagebrush_interrupt::catch(|| count_in(1 << 40, (1 << 40) + (1 << 22)));
    let pi = sagebrush_interrupt::catch(|| prime_pi(1 << 40));
    sagebrush_interrupt::clear();
    assert!(table.is_err(), "small_primes did not see the interrupt");
    assert!(window.is_err(), "the segmented sieve did not see the interrupt");
    assert!(pi.is_err(), "prime_pi did not see the interrupt");
    // and afterwards they run normally
    assert_eq!(sagebrush_interrupt::catch(|| small_primes(10_000_000)).unwrap().len(), 664_579);
    assert_eq!(sagebrush_interrupt::catch(|| prime_pi(1_000_000_000)).unwrap(), 50_847_534);
}
