//! Stop inside the number-field order code (the systematic review's A16-F1:
//! building x^256 - 2's multiplication table made no check at all, for about
//! 2.8 s), in its own test binary: the interrupt flag and the check counters
//! are process-wide.  Each site's checks are traced on a whole maximal-order
//! computation, then Stop is armed at the middle one: the call unwinds there,
//! with no reservation left, and the next call gives the same order.

use sagebrush_bigint::BigInt;
use sagebrush_classgroup::nf::order::maximal_order;
use sagebrush_interrupt::hooks;
use sagebrush_ledger::{outstanding_bytes, set_total, Total, TotalStatus};

/// x^n - a.
fn binomial(n: usize, a: i64) -> Vec<BigInt> {
    let mut f = vec![BigInt::from(0); n + 1];
    f[0] = BigInt::from(-a);
    f[n] = BigInt::from(1);
    f
}

/// Trace a maximal order of `f`, then Stop at the middle check made in
/// `site`: it unwinds there, with every reservation released, and the next
/// call works.  Returns how many checks the site made.
fn stop_at(f: &[BigInt], site: &str) -> usize {
    sagebrush_interrupt::clear();
    hooks::reset();
    hooks::trace();
    let want = maximal_order(f).unwrap().0.basis;
    let idx = hooks::traced(site);
    hooks::reset();
    assert!(!idx.is_empty(), "no checks at {site}");
    let before = outstanding_bytes();
    hooks::arm_at(idx[idx.len() / 2]);
    let r = sagebrush_interrupt::catch(|| maximal_order(f).map(|o| o.0.n));
    let at = hooks::stopped_in();
    hooks::reset();
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "{site}: not interrupted ({r:?})");
    assert_eq!(at, site);
    assert_eq!(outstanding_bytes(), before, "{site}: a reservation left after Stop");
    assert_eq!(maximal_order(f).unwrap().0.basis, want, "{site}: the next call");
    idx.len()
}

#[test]
fn stop_inside_the_table_and_round_2() {
    set_total(Some(Total { bytes: 1 << 40, status: TotalStatus::Observed, joint: false, uncertified: false }));
    // x^16 - 2: Z[2^(1/16)] is maximal, so its table is the work: a coarse
    // poll at each of its 16 rows, a check at each of its 136 products
    let f = binomial(16, 2);
    let products = stop_at(&f, "nf order table");
    assert!(products >= 136, "{products} checks in the table");
    let rows = stop_at(&f, "nf order table poll");
    assert!(rows >= 16, "{rows} coarse polls in the table");
    // (and the order's own poll, before the table)
    assert!(stop_at(&f, "nf order poll") >= 1, "the order's coarse poll");
    // a coarse poll at every step of the inverse basis (16) and of the
    // discriminant's determinant (15), each O(n^2) big-number operations
    assert!(stop_at(&f, "nf inverse poll") >= 16, "the inverse's coarse polls");
    assert!(stop_at(&f, "nf det poll") >= 15, "the determinant's coarse polls");
    // x^6 - 192 = x^6 - 2^6 3: t / 2 is integral, so Round 2 enlarges at 2,
    // polling at each step and at each row of its map
    let g = binomial(6, 192);
    assert!(stop_at(&g, "nf round 2") >= 2, "checks in Round 2");
    assert!(stop_at(&g, "nf round 2 poll") >= 2, "Round 2's coarse polls, one a step");
    assert!(stop_at(&g, "nf round 2 map") >= 6, "checks in Round 2's map");
    assert!(stop_at(&g, "nf round 2 map poll") >= 6, "the map's coarse polls, one a row");
    // and Round 2's Hermite forms (a column), Frobenius rows and powers (a bit)
    assert!(stop_at(&g, "nf hnf poll") >= 6, "the Hermite form's coarse polls, one a column");
    assert!(stop_at(&g, "nf hnf reduce poll") >= 6, "its back-reduction's, one a column");
    assert!(stop_at(&g, "nf radical poll") >= 6, "the Frobenius rows' coarse polls");
    assert!(stop_at(&g, "nf pow poll") >= 1, "the powers' coarse polls");
}
