// The quadratic sieve's memory is admitted by the engine's memory ledger:
// up front for its fixed structures, then in chunks as relations are kept.
// Refused, up front or mid-run, the ledger's typed error (factor_typed's
// Memory), never ECM in its place, with every reservation released; the
// same input on the same allowance is refused at the same place.  (A test
// binary of its own: the ledger's total and its fake usage row are
// process-wide.)
use sagebrush_bigint::{BigInt, BigUint};
use sagebrush_classgroup::nf::factor::{factor, factor_typed, is_probable_prime, FactorError};
use sagebrush_classgroup::nf::order::maximal_order;
use sagebrush_classgroup::nf::proof::{certify, Limits};
use sagebrush_classgroup::nf::siqs::{memory_bound, params, siqs, siqs_with, Stats, WHAT};
use sagebrush_ledger::{hooks, outstanding_bytes, set_total, EngineError, Total, TotalStatus};

fn total(bytes: u64) {
    set_total(Some(Total { bytes, status: TotalStatus::Observed, joint: false, uncertified: false }));
}

/// A total whose share admits `bytes` and no more, the fake usage row 0:
/// phi (O + x) <= total / 4, phi = 21/8.
fn admitting(bytes: u64) -> u64 {
    (bytes * 21).div_ceil(8) * 4
}

fn prime(bits: u64, s: &mut u64) -> BigUint {
    loop {
        let mut v = BigUint::from(1u32);
        for _ in 1..bits {
            *s ^= *s << 13;
            *s ^= *s >> 7;
            *s ^= *s << 17;
            v = (v << 1usize) + BigUint::from(*s >> 63);
        }
        if v.bits() == bits && (&v % 2u32) == BigUint::from(1u32) && is_probable_prime(&BigInt::from(v.clone())) {
            return v;
        }
    }
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
    // a total far below the process's own usage: refused up front
    total(1 << 16);
    match siqs(&n, 1) {
        Err(EngineError::Memory(r)) => assert_eq!(r.what, WHAT),
        other => panic!("{:?}", other),
    }
    match factor_typed(&BigInt::from(n.clone())) {
        Err(FactorError::Memory(r)) => assert_eq!(r.what, WHAT),
        other => panic!("refused, not factored another way: {:?}", other),
    }
    assert!(factor(&BigInt::from(n.clone())).unwrap_err().starts_with(WHAT));
    // the maximal order of x^2 - n factors its discriminant 4n, and the
    // class group's proof starts there: each gives the refusal typed
    let f = vec![-BigInt::from(n.clone()), BigInt::from(0), BigInt::from(1)];
    match maximal_order(&f) {
        Err(FactorError::Memory(r)) => assert_eq!(r.what, WHAT),
        other => panic!("maximal_order: {:?}", other.map(|_| ())),
    }
    match certify(&f, &Limits::default()) {
        Err(FactorError::Memory(r)) => assert_eq!(r.what, WHAT),
        other => panic!("certify: {:?}", other.map(|_| ())),
    }
    assert_eq!(outstanding_bytes(), before);

    // mid-run: the share admits the up-front bound and one chunk, which a
    // 160-bit n's relations and matrix outgrow
    let mut s = 0x2545_F491_4F6C_DD1Du64;
    let n = prime(80, &mut s) * prime(80, &mut s);
    hooks::set_fake_usage(Some((0, None)));
    total(admitting(memory_bound(n.bits() as u64) as u64 + (1 << 20)));
    let mut runs = vec![];
    for _ in 0..2 {
        let mut st = Stats::default();
        match siqs_with(&n, &params(n.bits() as u64), 1, &mut st) {
            Err(EngineError::Memory(r)) => {
                assert_eq!(r.what, WHAT);
                runs.push((r.need, st.polys, st.full, st.partial, st.reserved));
            }
            other => panic!("refused mid-run: {:?}", other),
        }
        assert!(st.polys > 0, "refused after sieving began, not up front");
        assert_eq!(outstanding_bytes(), before, "every chunk released");
    }
    assert_eq!(runs[0], runs[1], "the same input on the same allowance is refused at the same place");
    match factor_typed(&BigInt::from(n.clone())) {
        Err(FactorError::Memory(r)) => assert_eq!(r.what, WHAT),
        other => panic!("refused mid-run, not factored another way: {:?}", other),
    }
    hooks::set_fake_usage(None);
    total(1 << 40);
}
