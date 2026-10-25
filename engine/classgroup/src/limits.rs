//! Opt-in limits of the class-group searches (C0's per-area follow-up).
//!
//! By default every relation search (nf/bnf.rs, imag.rs, realq.rs) runs
//! until it converges or is interrupted: a computation's own time is the
//! user's, and each round polls `sagebrush_interrupt::check`.  A caller
//! that wants the old behaviour, "no convergence" after a fixed number of
//! rounds, sets a limit for the calls it makes on this thread with
//! [`with_round_limit`]; the former fixed values are kept below as the
//! documented choices.

use std::cell::Cell;

/// The former fixed round limit of the general relation search (nf/bnf.rs).
pub const CALIBRATED_BNF_ROUNDS: usize = 60;
/// The former fixed round limit of the quadratic searches (imag.rs, realq.rs).
pub const CALIBRATED_QUADRATIC_ROUNDS: usize = 200;

thread_local! {
    static ROUNDS: Cell<Option<usize>> = const { Cell::new(None) };
}

/// The number of relation-search rounds a search on this thread may run:
/// unlimited unless an enclosing [`with_round_limit`] set one.
pub fn round_limit() -> usize {
    ROUNDS.with(|r| r.get()).unwrap_or(usize::MAX)
}

/// Run f with at most `rounds` relation-search rounds per search on this
/// thread (a search that hasn't converged by then fails with "no
/// convergence", as before).  The previous setting is restored afterwards,
/// also when f unwinds.
pub fn with_round_limit<T>(rounds: usize, f: impl FnOnce() -> T) -> T {
    struct Restore(Option<usize>);
    impl Drop for Restore {
        fn drop(&mut self) {
            ROUNDS.with(|r| r.set(self.0));
        }
    }
    let _r = Restore(ROUNDS.with(|r| r.replace(Some(rounds))));
    f()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sagebrush_bigint::BigInt;

    #[test]
    fn unlimited_by_default_and_opt_in() {
        assert_eq!(round_limit(), usize::MAX);
        assert_eq!(with_round_limit(7, round_limit), 7);
        // restored, also after an unwind
        assert_eq!(round_limit(), usize::MAX);
        let _ = std::panic::catch_unwind(|| with_round_limit(3, || panic!("x")));
        assert_eq!(round_limit(), usize::MAX);
    }

    #[test]
    fn searches_honour_an_explicit_limit_and_converge_without_one() {
        let poly = |c: &[i64]| c.iter().map(|&x| BigInt::from(x)).collect::<Vec<_>>();
        // zero rounds: every search refuses at once, as the old limits did
        // when exhausted
        let e = with_round_limit(0, || crate::api::bnf(&poly(&[-5, 0, 0, 1])).map(|_| ())).unwrap_err();
        assert!(e.contains("no convergence"), "{}", e);
        // (|D| above the small-discriminant shortcuts, so both quadratic
        // routes use their relation search: -1000003 is fundamental, 1000003
        // being a prime = 3 mod 4; 1004 = 4 * 251 is too)
        let e = with_round_limit(0, || crate::api::quadratic(&BigInt::from(-1000003)).map(|_| ())).unwrap_err();
        assert!(e.contains("no convergence"), "{}", e);
        let e = with_round_limit(0, || crate::api::quadratic(&BigInt::from(1004)).map(|_| ())).unwrap_err();
        assert!(e.contains("no convergence"), "{}", e);
        // the default: they converge
        assert_eq!(crate::api::bnf(&poly(&[-5, 0, 0, 1])).unwrap().h, BigInt::from(1));
        assert!(crate::api::quadratic(&BigInt::from(-1000003)).is_ok());
        assert!(crate::api::quadratic(&BigInt::from(1004)).is_ok());
    }
}
