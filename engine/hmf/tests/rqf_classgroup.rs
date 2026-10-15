//! Class numbers and class groups of real quadratic fields (rqf.rs, by
//! cycles of reduced ideals, unconditional) against engine/classgroup's
//! quadratic class groups (its public API: subexponential relations,
//! certified where it says so), for every fundamental discriminant 1000 <= D
//! < 6000 (it supports D >= 1000; smaller ones are in the LMFDB test).

use sagebrush_bigint::BigInt;
use sagebrush_hmf::rqf::QuadField;

/// About 90 s (run with --ignored).
#[test]
#[ignore]
fn class_groups_vs_classgroup_crate() {
    let mut n = 0;
    let mut skipped = vec![];
    for disc in 1000i64..6000 {
        let Ok(f) = QuadField::from_disc(disc) else { continue };
        let g = f.class_group();
        // where classgroup reports an error ("no convergence" for a few D),
        // there is nothing to compare
        // where classgroup reports an error ("no convergence") or panics (it
        // did at D = 2077 when this was written), there is nothing to compare
        let r = std::panic::catch_unwind(|| sagebrush_classgroup::api::quadratic(&BigInt::from(disc)));
        let Ok(Ok((h, cyc, _, _))) = r else {
            skipped.push(disc);
            continue;
        };
        assert_eq!(BigInt::from(g.h() as i64), h, "disc {}", disc);
        let mut ours: Vec<BigInt> = g.cyc.iter().map(|&c| BigInt::from(c)).collect();
        let mut theirs = cyc.clone();
        ours.sort();
        theirs.sort();
        assert_eq!(ours, theirs, "disc {}: class group structure", disc);
        n += 1;
    }
    eprintln!("compared {}; classgroup reported errors at {:?}", n, skipped);
    // when this was written classgroup answered for 1281 of the 1540 and
    // every answer agreed
    assert!(n > 1200);
}
