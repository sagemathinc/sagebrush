//! Galois orbits of newforms with character, against LMFDB's
//! hecke_orbit_dims, including CM forms and inner twists (where a small
//! Hecke operator cannot separate conjugates).
use sagebrush_modsym::general::Character;
use sagebrush_modsym::newspace::newspace_orbits;

#[test]
fn newspaces_match_lmfdb() {
    let factor = |f: &[sagebrush_bigint::BigInt]| sagebrush_poly::factor(f).1;
    // (label, N, k, char_values order, gens, vals, orbit dims)
    let cases: &[(&str, u64, usize, u64, &[u64], &[u64], &[usize])] = &[
        ("11.2.a", 11, 2, 1, &[2], &[1], &[1]),
        ("23.2.a", 23, 2, 1, &[5], &[1], &[2]),
        ("1.24.a", 1, 24, 1, &[], &[], &[2]),
        ("13.2.e", 13, 2, 6, &[2], &[1], &[2]),
        ("63.2.e", 63, 2, 3, &[29, 10], &[3, 1], &[2, 2]),
        ("21.3.h", 21, 3, 6, &[8, 10], &[3, 2], &[2, 4]),
    ];
    for &(label, n, k, order, gens, vals, want) in cases {
        let eps = Character::from_generators(n, order, gens, vals).unwrap();
        let r = newspace_orbits(n, k, &eps, &factor).unwrap();
        assert_eq!((r.status, r.dims.as_slice()), ("proven", want), "{}: {:?}", label, r.checks);
    }
}

#[test]
fn trace_forms_match_lmfdb() {
    use sagebrush_modsym::traces::orbit_traces;
    let factor = |f: &[sagebrush_bigint::BigInt]| sagebrush_poly::factor(f).1;
    // (N, k, order, gens, vals, [trace forms tr a_1..a_12 per orbit, in LMFDB order])
    let cases: &[(u64, usize, u64, &[u64], &[u64], &[[i64; 12]])] = &[
        (11, 2, 1, &[2], &[1], &[[1, -2, -1, 2, 1, 2, -2, 0, -2, -2, 1, -2]]),
        (13, 2, 6, &[2], &[1], &[[2, -3, -2, 1, 0, 6, 0, 0, -1, -3, 0, -4]]),
        // 28.2.e: a conjugate's eigenvalue meets an old/Eisenstein one.
        (28, 2, 3, &[15, 17], &[3, 1], &[[2, 0, -1, 0, -3, 0, -4, 0, 2, 0, 3, 0]]),
        // 63.2.e.a has CM by Q(sqrt(-3)).
        (63, 2, 3, &[29, 10], &[3, 1], &[[2, 0, 0, 2, 0, 0, -1, 0, 0, 0, 0, 0], [2, 2, 0, -2, -2, 0, -5, 0, 0, 4, -2, 0]]),
    ];
    for &(n, k, order, gens, vals, want) in cases {
        let eps = Character::from_generators(n, order, gens, vals).unwrap();
        let res = newspace_orbits(n, k, &eps, &factor).unwrap();
        let tr = orbit_traces(n, k, &eps, &res, 12).unwrap();
        let mut ours: Vec<(usize, Vec<i64>)> = res.dims.iter().cloned().zip(tr.iter().map(|t| t.iter().map(|x| i64::try_from(x.clone()).unwrap()).collect())).collect();
        ours.sort();
        let got: Vec<Vec<i64>> = ours.into_iter().map(|o| o.1).collect();
        let want: Vec<Vec<i64>> = want.iter().map(|w| w.to_vec()).collect();
        assert_eq!(got, want, "N = {}", n);
    }
}

#[test]
fn labels_do_not_depend_on_bound() {
    // MOD-F2: at 37.2.a both orbits have a_1 = 1, so bound = 1 must not
    // break the tie by the unrelated charpoly.
    use sagebrush_modsym::traces::labelled_orbits;
    let factor = |f: &[sagebrush_bigint::BigInt]| sagebrush_poly::factor(f).1;
    let eps = Character::trivial(37);
    let res = newspace_orbits(37, 2, &eps, &factor).unwrap();
    let a = labelled_orbits(37, 2, &eps, &res, 1).unwrap();
    let b = labelled_orbits(37, 2, &eps, &res, 12).unwrap();
    assert_eq!(a.iter().map(|o| &o.2).collect::<Vec<_>>(), b.iter().map(|o| &o.2).collect::<Vec<_>>());
    assert_eq!(a[0].1.len(), 1);
    // 37a: a_2 = -2.
    assert_eq!(i64::try_from(b[0].1[1].clone()).unwrap(), -2);
}

#[test]
fn factor_callback_is_checked() {
    // MOD-F3: a callback returning x^2 (or the reducible h itself) is refused.
    let eps = Character::trivial(37);
    let z = |v: &[i64]| v.iter().map(|&c| sagebrush_bigint::BigInt::from(c)).collect::<Vec<_>>();
    let bad = move |_: &[sagebrush_bigint::BigInt]| vec![(z(&[0, 0, 1]), 1)];
    assert!(newspace_orbits(37, 2, &eps, &bad).is_err());
    let whole = |f: &[sagebrush_bigint::BigInt]| vec![(f.to_vec(), 1)];
    assert!(newspace_orbits(37, 2, &eps, &whole).is_err());
}
