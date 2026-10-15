//! Weight k != (2, 2) against Magma 2.18 as a black box
//! (fixtures/magma-weight.m, HilbertCuspForms(F, N, [k1, k2])):
//!
//! * dimensions of S_k(N) for every level of norm <= 50 in ten weights, odd
//!   weights included (where the space is 0), and of norm <= 100 in four;
//! * characteristic polynomials over F of T_P (U_P for P | N) on the full
//!   space at composite and prime levels;
//! * newform orbits at prime levels (Magma 2.18's NewSubspace fails in
//!   non-parallel weight at most composite levels, so new subspaces are
//!   compared at prime levels only; the 42 spaces there where Magma raised
//!   an error are listed in the fixture and skipped): their dimensions over
//!   F, and Magma's
//!   exact eigenvalues at every prime of norm <= 30, compared with ours
//!   through one explicit isomorphism of the fields they generate
//!   (weight_joint/mod.rs).
//!
//! * the 42 spaces where Magma raised an error (daybreak TEST-DDD-3):
//!   Sagebrush's newspace, orbits and exact eigenvalues there, checked
//!   against Magma's full-space characteristic polynomials (H lines) by
//!   the product of the new and old parts, and internally.
//!
//! Dembélé 2005, Examples 3.5-3.7 and Tables 1 and 2, are checked too.

mod joint;
mod weight_joint;

use joint::Q;
use sagebrush_bigint::BigInt;
use sagebrush_hmf::field::{Elt, Ideal, Prime};
use sagebrush_hmf::fpoly::{FInt, FPoly};
use sagebrush_hmf::weight::{Weight, WeightSpace};
use sagebrush_hmf::weightnew::WeightNewspaces;
use std::collections::BTreeMap;
use weight_joint::{joint_alg, relative_eigenvalue, Alg};

const FIXTURE: &str = include_str!("fixtures/magma-weight.txt");

fn pair(s: &str) -> (i64, i64) {
    let v: Vec<i64> = s.split_whitespace().map(|x| x.parse().unwrap()).collect();
    (v[0], v[1])
}

fn level(s: &str) -> Ideal {
    let (a, b) = pair(s);
    Ideal::principal(Elt::new(a, b)).unwrap()
}

fn prime(s: &str) -> Prime {
    let i = level(s);
    assert!(i.factors.len() == 1 && i.factors[0].1 == 1);
    i.factors[0].0
}

fn weight(s: &str) -> Weight {
    let (a, b) = pair(s);
    Weight::new(a as u32, b as u32).unwrap()
}

fn lines(tag: &str) -> Vec<Vec<String>> {
    FIXTURE
        .lines()
        .filter(|l| l.starts_with(tag))
        .map(|l| l[tag.len()..].split('|').map(|s| s.trim().to_string()).collect())
        .collect()
}

fn fint(s: &str) -> FInt {
    let (a, b) = s.split_once(',').unwrap();
    FInt::new(a.trim().parse().unwrap(), b.trim().parse().unwrap())
}

#[test]
fn dimensions_vs_magma() {
    let ds = lines("D ");
    // complete: every level of norm <= 50 in all ten weights, and of norm
    // <= 100 in the first four
    let mut seen: std::collections::HashSet<(sagebrush_hmf::field::Hnf, String)> = std::collections::HashSet::new();
    for d in &ds {
        assert!(seen.insert((level(&d[0]).hnf, d[1].clone())), "duplicate line for level {} weight {}", d[0], d[1]);
    }
    let all = ["2 4", "4 2", "4 4", "2 6", "6 2", "4 6", "6 6", "2 8", "3 3", "3 5"];
    for n in sagebrush_hmf::field::ideals_of_bounded_norm(100).iter().filter(|n| !n.is_one()) {
        for k in &all[..if n.norm() <= 50 { 10 } else { 4 }] {
            assert!(seen.contains(&(n.hnf, k.to_string())), "no line for level {} weight {}", n.gen, k);
        }
    }
    assert_eq!(ds.len(), seen.len());
    for d in &ds {
        let s = WeightSpace::new(level(&d[0]), weight(&d[1])).unwrap();
        assert_eq!(s.dimension(), d[2].parse::<usize>().unwrap(), "level {} weight {}", d[0], d[1]);
    }
}

#[test]
fn hecke_charpolys_vs_magma() {
    let hs = lines("H ");
    assert!(hs.len() > 100);
    let mut spaces: BTreeMap<(String, String), WeightNewspaces> = BTreeMap::new();
    for h in &hs {
        let ns = spaces.entry((h[0].clone(), h[1].clone())).or_insert_with(|| WeightNewspaces::new(level(&h[0]), weight(&h[1])).unwrap());
        let want: FPoly = h[3].split(';').map(fint).collect();
        assert_eq!(ns.hecke_charpoly(&prime(&h[2])).unwrap(), want, "level {} weight {} prime {}", h[0], h[1], h[2]);
    }
}

fn check_orbits(max_norm: u64) -> usize {
    // (level, weight) -> orbits (dimension, field, a_P strings); prime order
    let mut want: BTreeMap<(String, String), Vec<(usize, String, Vec<String>)>> = BTreeMap::new();
    let mut order: Vec<String> = vec![];
    for o in lines("O ") {
        let field = o[3].strip_prefix("field:").unwrap().trim().to_string();
        let toks: Vec<&str> = o[4].split_whitespace().collect();
        let mut ps = vec![];
        let mut aps = vec![];
        for c in toks.chunks(2) {
            let (b, a) = c[1].split_once(':').unwrap();
            ps.push(format!("{} {}", c[0], b));
            aps.push(a.to_string());
        }
        if order.is_empty() {
            order = ps.clone();
        }
        assert_eq!(ps, order);
        want.entry((o[0].clone(), o[1].clone())).or_default().push((o[2].parse().unwrap(), field, aps));
    }
    let primes: Vec<Prime> = order.iter().map(|s| prime(s)).collect();
    let mut total = 0;
    for ((n, k), theirs) in &want {
        let lev = level(n);
        if lev.norm() > max_norm {
            continue;
        }
        let ns = WeightNewspaces::new(lev, weight(k)).unwrap();
        let o = ns.newform_orbits().unwrap();
        let what = format!("level {} weight {}", n, k);
        let mut dims: Vec<usize> = o.orbits.iter().map(|g| g.len() - 1).collect();
        let mut tdims: Vec<usize> = theirs.iter().map(|t| t.0).collect();
        dims.sort();
        tdims.sort();
        assert_eq!(dims, tdims, "{}: orbit dimensions", what);
        assert_eq!(ns.new_dimension().unwrap(), dims.iter().sum::<usize>(), "{}", what);
        let hs = ns.orbit_eigenvalues(&o, &primes).unwrap();
        let ours: Vec<(Alg, Vec<Vec<Q>>)> = o
            .orbits
            .iter()
            .zip(&hs)
            .map(|(g, row)| {
                let alg = Alg::relative(g);
                let aps = row.iter().map(|h| relative_eigenvalue(&alg, g, h)).collect();
                (alg, aps)
            })
            .collect();
        let mut used = vec![false; ours.len()];
        for (d, field, aps) in theirs {
            let (k2, a2) = joint::theirs(field, &aps.iter().map(|s| s.as_str()).collect::<Vec<_>>());
            let alg2 = Alg::absolute(k2);
            let mut errs = vec![];
            let hit = (0..ours.len()).find(|&j| {
                if used[j] || o.orbits[j].len() - 1 != *d {
                    return false;
                }
                match joint_alg(&ours[j].0, &ours[j].1, &alg2, &a2) {
                    Ok(_) => true,
                    Err(e) => {
                        errs.push(e);
                        false
                    }
                }
            });
            match hit {
                Some(j) => used[j] = true,
                None => panic!("{}: an orbit of dimension {} has no match: {:?}", what, d, errs),
            }
            total += 1;
        }
    }
    total
}

/// Every prime level of norm <= 100 where Magma did not raise an error: 109
/// orbits.
#[test]
fn orbits_vs_magma() {
    assert_eq!(check_orbits(100), 109);
}

fn f(a: i64, b: i64) -> FInt {
    FInt::new(BigInt::from(a), BigInt::from(b))
}

/// Dembélé 2005: Examples 3.5 and 3.6, weight (2, 4) at levels (3 + w) and
/// (7 + 2w), with the eigenvalues of Tables 1 and 2 (at 2, sqrt 5 = (2 + w),
/// 3, (3 + w), (4 - w)), and Example 3.7, dimension 74 at level (30).
#[test]
fn dembele_examples() {
    let w = Weight::new(2, 4).unwrap();
    let ps: Vec<Prime> = ["2 0", "2 1", "3 0", "3 1", "4 -1"].iter().map(|s| prime(s)).collect();
    for (lev, table) in [
        // Table 1 (its last two columns, (4 + w) and (5 - w), are checked below)
        ((3, 1), vec![vec![f(-12, 4), f(0, -10), f(-6, 12), f(11, 0), f(2, 30)]]),
        // Table 2: f1, f2, f3
        (
            (7, 2),
            vec![
                vec![f(-14, 0), f(-17, -1), f(-21, 24), f(-23, 14), f(28, -53)],
                vec![f(0, 4), f(2, -4), f(30, -12), f(4, -12), f(4, 16)],
                vec![f(6, -4), f(11, 3), f(-45, 12), f(1, 30), f(-30, -21)],
            ],
        ),
    ] {
        let ns = WeightNewspaces::new(Ideal::principal(Elt::new(lev.0, lev.1)).unwrap(), w).unwrap();
        let o = ns.newform_orbits().unwrap();
        assert!(o.orbits.iter().all(|g| g.len() == 2));
        let hs = ns.orbit_eigenvalues(&o, &ps).unwrap();
        let mut got: Vec<Vec<FInt>> = hs.iter().map(|row| row.iter().map(|h| h.first().cloned().unwrap_or_else(FInt::zero)).collect()).collect();
        let mut want = table;
        got.sort();
        want.sort();
        assert_eq!(got, want, "level {:?}", lev);
    }
    // Table 1, (4 + w) and (5 - w): -88w - 16 and -30w + 70
    let ns = WeightNewspaces::new(Ideal::principal(Elt::new(3, 1)).unwrap(), w).unwrap();
    let o = ns.newform_orbits().unwrap();
    let hs = ns.orbit_eigenvalues(&o, &[prime("4 1"), prime("5 -1")]).unwrap();
    assert_eq!(hs[0], vec![vec![f(-16, -88)], vec![f(70, -30)]]);
    // Example 3.7
    assert_eq!(WeightSpace::new(Ideal::principal(Elt::int(30)).unwrap(), w).unwrap().dimension(), 74);
}

/// The 42 spaces at prime levels where Magma raised an error (E lines):
/// for every prime P of norm <= 11 not dividing the level N, Magma's
/// full-space characteristic polynomial of T_P (an H line) must be the
/// product over our newform orbits of the characteristic polynomials of
/// a_P, times the square of that at level (1) (old forms from level one
/// occur d(N) = 2 times at a prime level). And every exact eigenvalue
/// a_P = h(theta)/g'(theta) at the primes of norm <= 30 must be a root of
/// the characteristic polynomial c over F of a_P on its orbit:
/// sum c_i h^i g'^(d - i) = 0 modulo g, exactly in O_F[x].
#[test]
fn magma_error_spaces() {
    let es = lines("E ");
    assert_eq!(es.len(), 42);
    let hs = lines("H ");
    let one = Ideal::principal(Elt::int(1)).unwrap();
    let primes30 = sagebrush_hmf::field::primes_of_bounded_norm(30);
    let mut checked = 0;
    for e in &es {
        let lev = level(&e[0]);
        assert!(lev.factors.len() == 1 && lev.factors[0].1 == 1, "level {} is not prime", e[0]);
        let k = weight(&e[1]);
        let what = format!("level {} weight {}", e[0], e[1]);
        let ns = WeightNewspaces::new(lev.clone(), k).unwrap();
        let o = ns.newform_orbits().unwrap();
        assert_eq!(o.orbits.iter().map(|g| g.len() - 1).sum::<usize>(), ns.new_dimension().unwrap(), "{}", what);
        let ones = WeightNewspaces::new(one.clone(), k).unwrap();
        let o1 = ones.newform_orbits().unwrap();
        let mine: Vec<&Vec<String>> = hs.iter().filter(|h| h[0] == e[0] && h[1] == e[1]).collect();
        assert_eq!(mine.len(), 5, "{}: H lines", what);
        for h in mine {
            let p = prime(&h[2]);
            let want: FPoly = h[3].split(';').map(fint).collect();
            // Magma's full space against ours
            assert_eq!(ns.hecke_charpoly(&p).unwrap(), want, "{}: T_P at {}", what, h[2]);
            if lev.factors[0].0 == p {
                continue;
            }
            let mut prod: FPoly = vec![FInt::one()];
            for cp in ns.orbit_charpolys(&o, &[p]).unwrap() {
                prod = sagebrush_hmf::fpoly::mul(&prod, &cp[0]);
            }
            for cp in ones.orbit_charpolys(&o1, &[p]).unwrap() {
                prod = sagebrush_hmf::fpoly::mul(&prod, &cp[0]);
                prod = sagebrush_hmf::fpoly::mul(&prod, &cp[0]);
            }
            assert_eq!(prod, want, "{}: new times old at {}", what, h[2]);
            checked += 1;
        }
        let (cps, hs2) = ns.orbit_data(&o, &primes30).unwrap();
        for ((g, crow), hrow) in o.orbits.iter().zip(&cps).zip(&hs2) {
            for (cp, h) in crow.iter().zip(hrow) {
                assert!(is_root(cp, g, h), "{}: an exact eigenvalue is not a root of its orbit charpoly", what);
            }
        }
    }
    assert_eq!(checked, 205);
}

/// f modulo the monic g, in O_F[x].
fn rem_monic(f: &[FInt], g: &[FInt]) -> FPoly {
    let d = g.len() - 1;
    let mut r: FPoly = f.to_vec();
    while r.len() > d {
        let c = r.pop().unwrap();
        let k = r.len() - d; // the popped term was c x^(k + d)
        for i in 0..d {
            r[k + i] = r[k + i].sub(&c.mul(&g[i]));
        }
    }
    sagebrush_hmf::fpoly::trim(r)
}

/// Whether a = h(theta)/g'(theta) is a root of c in F[x]/(g):
/// sum_i c_i h^i g'^(n - i) = 0 modulo g, n = deg c.
fn is_root(c: &[FInt], g: &[FInt], h: &[FInt]) -> bool {
    use sagebrush_hmf::fpoly::mul;
    let n = c.len() - 1;
    let gd: FPoly = g.iter().enumerate().skip(1).map(|(j, x)| FInt::new(&x.a * BigInt::from(j as i64), &x.b * BigInt::from(j as i64))).collect();
    // powers h^i and g'^i modulo g
    let mut hp: Vec<FPoly> = vec![vec![FInt::one()]];
    let mut gp: Vec<FPoly> = vec![vec![FInt::one()]];
    for _ in 0..n {
        hp.push(rem_monic(&mul(hp.last().unwrap(), h), g));
        gp.push(rem_monic(&mul(gp.last().unwrap(), &gd), g));
    }
    let mut s: FPoly = vec![];
    for (i, ci) in c.iter().enumerate() {
        let t = rem_monic(&mul(&mul(&hp[i], &gp[n - i]), &[ci.clone()]), g);
        let len = s.len().max(t.len());
        s = (0..len).map(|k| s.get(k).cloned().unwrap_or_else(FInt::zero).add(&t.get(k).cloned().unwrap_or_else(FInt::zero))).collect();
    }
    sagebrush_hmf::fpoly::trim(s).is_empty()
}
