//! Galois orbits of newforms with character, against LMFDB's
//! hecke_orbit_dims, including CM forms and inner twists (where a small
//! Hecke operator cannot separate conjugates).
use sagebrush_modsym::general::Character;
use sagebrush_modsym::newspace::newspace_orbits;

#[test]
fn newspaces_match_lmfdb() {
    let factor = |f: &[num_bigint::BigInt]| sagebrush_flint::factor(f).1;
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
