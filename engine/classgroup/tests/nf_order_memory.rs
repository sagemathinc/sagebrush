//! The memory of number-field orders is admitted by the engine's memory
//! ledger before it is allocated (the systematic review's A16-F2: an
//! 8 MiB ledger's 2 MiB share refused a 3 MiB reservation, yet nf_data built
//! a degree-48 table of over 4 MiB and peaked near 29 MiB).  Refused, up
//! front or mid-table, the ledger's typed error, with every reservation
//! released, and the same call succeeds once there is room.  And the
//! discriminant of f, now computed from its power sums without a second
//! table, is the same integer as the equation order's.  (A test binary of
//! its own: the ledger's total and its fake usage row are process-wide.)

use sagebrush_bigint::BigInt;
use sagebrush_classgroup::api::nf_data;
use sagebrush_classgroup::nf::factor::FactorError;
use sagebrush_classgroup::nf::mem::WHAT;
use sagebrush_classgroup::nf::order::{equation_disc, maximal_order, Order};
use sagebrush_ledger::{hooks, outstanding_bytes, set_total, Total, TotalStatus};

fn total(bytes: u64) {
    set_total(Some(Total { bytes, status: TotalStatus::Observed, joint: false, uncertified: false }));
}

/// A total whose share admits `bytes` and no more, the fake usage row 0:
/// phi (O + x) <= total / 4, phi = 21/8.
fn admitting(bytes: u64) -> u64 {
    (bytes * 21).div_ceil(8) * 4
}

fn poly(c: &[i64]) -> Vec<BigInt> {
    c.iter().map(|&x| BigInt::from(x)).collect()
}

/// x^n - a.
fn binomial(n: usize, a: BigInt) -> Vec<BigInt> {
    let mut f = vec![BigInt::from(0); n + 1];
    f[0] = -a;
    f[n] = BigInt::from(1);
    f
}

fn refused<T: std::fmt::Debug>(r: Result<T, FactorError>, what: &str) {
    match r {
        Err(FactorError::Memory(m)) => assert_eq!(m.what, WHAT, "{what}"),
        other => panic!("{what}: not the order's refusal: {other:?}"),
    }
}

#[test]
fn orders_run_only_when_their_memory_is_admitted() {
    total(1 << 40);
    // the discriminant of Z[t] from the power sums is the table's, exactly
    let big = BigInt::from(2) * BigInt::from(17).pow(8u32);
    for f in [poly(&[-2, 0, 1]), poly(&[-2, 0, 0, 1]), poly(&[1, 1, 0, 0, 0, 1]), poly(&[1, 0, -1, 0, 1]), poly(&[-192, 0, 0, 0, 0, 0, 1]), binomial(8, big.clone()), binomial(16, BigInt::from(2)), poly(&[7, -3, 0, 11, 0, 0, 1])] {
        assert_eq!(equation_disc(&f).unwrap(), Order::equation_order(&f).unwrap().disc().unwrap(), "{f:?}");
    }
    let f = binomial(32, BigInt::from(2));
    let charged = Order::equation_order(&f).unwrap().charged();
    let want = nf_data(&f).unwrap();
    let before = outstanding_bytes();

    // a share of half the order's own charges: refused mid-table (its
    // up-front part, the headers, is far less), the same way twice
    hooks::set_fake_usage(Some((0, None)));
    total(admitting(charged / 2));
    for _ in 0..2 {
        refused(Order::equation_order(&f), "the equation order, mid-table");
        assert_eq!(outstanding_bytes(), before, "every reservation released");
    }
    // through the public entries, typed
    refused(maximal_order(&f).map(|o| o.0.n), "maximal_order");
    refused(nf_data(&f).map(|d| d.degree), "nf_data");
    assert_eq!(outstanding_bytes(), before);
    // a share below the up-front part: refused before the table
    total(admitting(4 << 10));
    refused(Order::equation_order(&f), "the equation order, up front");
    assert_eq!(outstanding_bytes(), before);

    // room again: the same answer
    hooks::set_fake_usage(None);
    total(1 << 40);
    let got = nf_data(&f).unwrap();
    assert_eq!((got.disc, got.index, got.basis), (want.disc, want.index, want.basis));
    assert_eq!(outstanding_bytes(), before);
}
