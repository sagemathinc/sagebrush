// The quadratic sieve's memory is admitted by the engine's memory ledger:
// refused, the ledger's typed error (factor_typed's Memory), never ECM in
// its place; admitted, the sieve runs and its reservation ends with it.  (A
// test binary of its own: the ledger's total is process-wide.)
use sagebrush_bigint::{BigInt, BigUint};
use sagebrush_classgroup::nf::factor::{factor, factor_typed, FactorError};
use sagebrush_classgroup::nf::siqs::{memory_bound, siqs, WHAT};
use sagebrush_ledger::{outstanding_bytes, set_total, EngineError, Total, TotalStatus};

fn total(bytes: u64) {
    set_total(Some(Total { bytes, status: TotalStatus::Observed, joint: false, uncertified: false }));
}

#[test]
fn the_sieve_runs_only_when_its_memory_is_admitted() {
    // 2^50 - 27 and 2^50 - 35: 100 bits, in the sieve's range, beyond rho
    let (p, q): (BigUint, BigUint) = ("1125899906842597".parse().unwrap(), "1125899906842589".parse().unwrap());
    let n = &p * &q;
    total(1 << 40);
    let before = outstanding_bytes();
    let g = siqs(&n, 1).unwrap().unwrap();
    assert!(g == p || g == q);
    assert_eq!(outstanding_bytes(), before, "released when the sieve returns");
    let want = vec![(BigInt::from(q.clone()), 1), (BigInt::from(p.clone()), 1)];
    assert_eq!(factor(&BigInt::from(n.clone())).unwrap(), want);
    // a total far below the process's own usage: the sieve is refused
    total(1 << 16);
    match siqs(&n, 1) {
        Err(EngineError::Memory(r)) => assert!(r.what == WHAT && r.need == memory_bound(n.bits() as u64) as u64, "{:?}", r),
        other => panic!("{:?}", other),
    }
    match factor_typed(&BigInt::from(n.clone())) {
        Err(FactorError::Memory(r)) => assert_eq!(r.what, WHAT),
        other => panic!("refused, not factored another way: {:?}", other),
    }
    assert!(factor(&BigInt::from(n.clone())).unwrap_err().starts_with(WHAT));
    total(1 << 40);
    assert_eq!(outstanding_bytes(), before);
}
