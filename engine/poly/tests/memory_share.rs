//! The host's memory share in a default factorization (item D0), in its own
//! test binary: the share is process-wide, so it must not run alongside the
//! other tests, which make default budgets.

use num_traits::One;
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::set_memory_share;
use sagebrush_poly::{try_factor, try_factor_with, with_default_limits, Budget, Limits, MemorySource};

#[test]
fn the_share_reaches_a_default_factorization() {
    // x^2 - c^2 with c of 2000 bits: its copy alone is more than 1 KiB
    let c: BigInt = (BigInt::one() << 2000u32) + BigInt::from(7);
    let f = vec![-(&c * &c), BigInt::from(0), BigInt::one()];
    // no share: the default 512 MiB, and it factors
    set_memory_share(None);
    assert_eq!(try_factor(&f).unwrap().1.len(), 2);
    // a share of 1024 bytes: refused, with the share applied, exactly
    set_memory_share(Some(1024));
    let e = try_factor(&f).unwrap_err();
    assert_eq!((e.what, e.memory_limit, e.memory_source), ("memory", 1024, MemorySource::HostShare));
    assert!(e.to_string().contains("; the limit, 1024 bytes, is this factorization's share of the memory observed free"), "{}", e);
    // an explicit policy is used as given: the host's share is not asked
    let wide = Limits { memory: 64 << 20, ..Limits::DEFAULT };
    assert_eq!(with_default_limits(wide, || try_factor(&f)).unwrap().1.len(), 2);
    // a caller's own budget is the caller's
    assert_eq!(try_factor_with(&f, &Budget::new(Limits::DEFAULT)).unwrap().1.len(), 2);
    // a budget made keeps the share it was made with
    let b = Budget::default();
    set_memory_share(Some(64 << 20));
    assert_eq!(b.limits().memory, 1024);
    assert!(try_factor_with(&f, &b).is_err());
    assert_eq!(try_factor(&f).unwrap().1.len(), 2);
    set_memory_share(None);
}
