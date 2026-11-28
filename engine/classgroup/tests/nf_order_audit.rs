//! Every allocation of an order and of Round 2 is reserved before it is
//! made (A16-F2, the ENGINE ruling: no allocation outside a reservation, at
//! any point, transients included), with the test-only audit allocator of
//! the memory ledger (feature ledger-audit): inside the engine entry, each
//! allocation is made under a reservation's scope, and the live bytes never
//! pass the reserved sum.  And the bound isn't needlessly large: the most
//! reserved at once is at most twice the most live (x^n - 2 at degrees 16, 32
//! and 48, and x^8 - 2 17^8, whose generator's large coefficients make
//! Round 2 enlarge at 17).  CI runs it: cargo test -p sagebrush-classgroup
//! --features ledger-audit --test nf_order_audit (without the feature it
//! runs nothing).
#![cfg(feature = "ledger-audit")]

use sagebrush_bigint::BigInt;
use sagebrush_classgroup::nf::order::Order;
use sagebrush_ledger::{audit, set_total, Operation, Total, TotalStatus};

#[global_allocator]
static ALLOC: audit::Audit<std::alloc::System> = audit::Audit::new(std::alloc::System);

/// What the audit tolerates above the reserved sum: the few small values a
/// step returns after its scratch reservation is released.
const SLACK: u64 = 16 << 10;

/// x^n - a.
fn binomial(n: usize, a: BigInt) -> Vec<BigInt> {
    let mut f = vec![BigInt::from(0); n + 1];
    f[0] = -a;
    f[n] = BigInt::from(1);
    f
}

#[test]
fn every_allocation_of_an_order_is_reserved_first() {
    // (one test function: the audit's counters are process-wide)
    set_total(Some(Total { bytes: 1 << 36, status: TotalStatus::Observed, joint: false, uncertified: false }));
    // (a warm-up, outside the audited window: the interrupt crate's test
    // hooks, on in test builds, record each phase name the first time it is
    // entered, in a vector of their own)
    let mut w = Order::equation_order(&binomial(6, BigInt::from(192))).unwrap();
    while let Some(w2) = w.enlarge_at(&BigInt::from(2)).unwrap() {
        w = w2;
    }
    w.disc().unwrap();
    drop(w);
    let big = BigInt::from(2) * BigInt::from(17).pow(8u32);
    for (f, primes) in [(binomial(16, BigInt::from(2)), vec![2]), (binomial(32, BigInt::from(2)), vec![2]), (binomial(48, BigInt::from(2)), vec![2, 3]), (binomial(8, big), vec![2, 17])] {
        let primes: Vec<BigInt> = primes.into_iter().map(BigInt::from).collect();
        audit::start(SLACK);
        let op = Operation::enter();
        let mut o = Order::equation_order(&f).unwrap();
        for p in &primes {
            while let Some(o2) = o.enlarge_at(p).unwrap() {
                o = o2;
            }
        }
        let d = o.disc().unwrap();
        drop(op);
        let (n, last) = audit::violations();
        assert_eq!(n, 0, "degree {}: {} allocations without a reservation, the last of {} bytes", f.len() - 1, n, last);
        assert_eq!(audit::breaches(), 0, "degree {}: live bytes above the reserved sum", f.len() - 1);
        let (peak, cover) = audit::peaks();
        assert!(cover <= 2 * peak + SLACK, "degree {}: {} reserved at most, for {} live at most", f.len() - 1, cover, peak);
        eprintln!("degree {}: live at most {} bytes, reserved at most {} ({:.2}x); disc {} bits", f.len() - 1, peak, cover, cover as f64 / peak as f64, d.bits());
        drop(o);
    }
}
