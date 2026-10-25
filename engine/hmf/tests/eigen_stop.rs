//! Stop inside an orbit eigenspace, at every check it makes, then the same
//! call again on the same Newspaces (its charpoly cache): the second call
//! must return the same eigenspace, never panic.  The modular data was
//! computed with the cache's lock held (eigen.rs), so an interrupt there
//! poisoned the lock and every later use of that cache panicked
//! (astra2's report on plan-nocliffs-S r1).  One test in this binary: the
//! interrupt flag and the check counters are process-wide.

use sagebrush_hmf::field::{Elt, Ideal};
use sagebrush_hmf::newspace::Newspaces;
use sagebrush_interrupt::hooks;

#[test]
fn stop_anywhere_in_an_orbit_eigenspace_then_the_same_cache_works() {
    let level = || Ideal::principal(Elt::int(71)).unwrap();
    // the reference: a full run on its own object, its checks counted
    sagebrush_interrupt::clear();
    let ns = Newspaces::new(level()).unwrap();
    let orbits = ns.newform_orbits().unwrap();
    let k = (0..orbits.orbits.len()).max_by_key(|&k| orbits.orbits[k].len()).unwrap();
    hooks::reset();
    hooks::trace();
    let full = |e: sagebrush_hmf::eigen::OrbitEigenspace| (e.g, e.krylov, e.pivots);
    let want = full(ns.orbit_eigenspace(&orbits, k).unwrap());
    let total = hooks::total();
    hooks::reset();
    assert!(total > 1, "the eigenspace made {} checks", total);
    let mut interrupted = 0;
    for at in 1..=total {
        let ns = Newspaces::new(level()).unwrap();
        let orbits = ns.newform_orbits().unwrap();
        hooks::reset();
        hooks::arm_at(at);
        let r = sagebrush_interrupt::catch(|| ns.orbit_eigenspace(&orbits, k));
        hooks::reset();
        sagebrush_interrupt::clear();
        if r.is_err() {
            interrupted += 1;
        }
        // the same object and cache, after the Stop
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ns.orbit_eigenspace(&orbits, k)));
        match again {
            Ok(Ok(e)) => assert!(full(e) == want, "check {}: a different eigenspace after Stop", at),
            Ok(Err(e)) => panic!("check {}: an error after Stop: {}", at, e),
            Err(_) => panic!("check {} of {}: the next call on the same Newspaces panicked (a poisoned cache lock)", at, total),
        }
    }
    assert!(interrupted > 0, "no check interrupted the eigenspace");
    println!("STOP orbit_eigenspace: {} checks, {} interrupted, the same cache worked after each", total, interrupted);
}
