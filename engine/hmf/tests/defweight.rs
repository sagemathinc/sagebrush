//! Weight k != (2, 2) over real quadratic fields (defweight.rs,
//! defweightnew.rs):
//!
//! - over Q(sqrt 5), the same dimensions and characteristic polynomials of
//!   T_P as the icosian code (weight.rs, checked against Magma and Dembélé
//!   2005);
//! - Magma 2.18 as a black box (fixtures/magma-weight-general.m) over ten
//!   fields: class numbers 1 and 2, narrow class numbers 1, 2 and 4, units
//!   of norm -1 and +1 (odd weights are 0 for the first and not for the
//!   second): dimensions, characteristic polynomials of T_P and U_P on the
//!   full space (exactly in parallel weight, up to the conjugation of F in
//!   non-parallel weight, where Magma's matrices lie in an extension of F),
//!   and newform orbits with the characteristic polynomials over F of their
//!   eigenvalues at prime levels (over Q where Magma's eigenvalue field is
//!   not presented over F).
//! - The convention for the real places (k1 at sqrt d -> -sqrt d,
//!   eigenvalues read at sqrt d -> +sqrt d): Magma puts k_i at
//!   InfinitePlaces(F)[i], so where its first place is sqrt d -> +sqrt d (in
//!   all ten fields here) its [k1, k2] is our (k2, k1). Magma 2.18 gives
//!   eigenvalues in two ways. The characteristic polynomial over F of an
//!   eigenvalue in a relative extension of F agrees with ours exactly, on
//!   every such orbit, read at Magma's place of k1. An eigenvalue in F
//!   comes from an absolute copy of F that Magma identifies with F by its
//!   defining polynomial, which fixes it only up to the conjugation of F
//!   (both cases occur: Q(sqrt 7) at level (2, 1 + w) agrees as it is,
//!   Q(sqrt 2) at level (w) after conjugation), so those orbits are
//!   compared up to one conjugation each, the same at every prime.

use sagebrush_bigint::BigInt;
use sagebrush_hmf::defweight::WeightSpace as GeneralSpace;
use sagebrush_hmf::defweightnew::WeightNewspaces as GeneralNewspaces;
use sagebrush_hmf::definite::DefiniteSpace;
use sagebrush_hmf::gpoly::{self, QPoly};
use sagebrush_hmf::quatalg::{MaximalOrder, QuatAlg};
use sagebrush_hmf::rqf::{QElt, QIdeal, QPrime, QuadField};
use sagebrush_hmf::weight::{Weight, WeightSpace};
use sagebrush_hmf::weightnew::WeightNewspaces;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

const FIXTURE: &str = include_str!("fixtures/magma-weight-general.txt");

fn order(d: i64) -> (QuadField, MaximalOrder) {
    let f = QuadField::new(d).unwrap();
    (f, MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap())
}

fn qe(a: i64, b: i64) -> QElt {
    QElt::new(a, b)
}

fn single_prime(f: &QuadField, i: &QIdeal) -> QPrime {
    let fac = f.factor(i).unwrap();
    assert!(fac.len() == 1 && fac[0].1 == 1, "not a prime");
    fac[0].0
}

/// Over Q(sqrt 5): the general code against the icosian code, at every
/// level of norm <= 30 (dimensions, five weights) and every level of norm
/// <= 20 (T_P at the primes of norm <= 11, weights (2, 4) and (4, 4), where
/// the space is nonzero: 75 characteristic polynomials).
#[test]
fn agrees_with_icosians() {
    let (f, o) = order(5);
    let ps = sagebrush_hmf::field::primes_of_bounded_norm(11);
    let mut compared = 0;
    for n in sagebrush_hmf::field::ideals_of_bounded_norm(30) {
        let level = f.principal(&qe(n.gen.a, n.gen.b)).unwrap();
        let sp = Arc::new(DefiniteSpace::new(&o, &level).unwrap());
        for (k1, k2) in [(2, 4), (4, 2), (4, 4), (3, 3), (2, 6)] {
            let w = Weight::new(k1, k2).unwrap();
            let ours = GeneralSpace::new(sp.clone(), w).unwrap();
            let theirs = WeightSpace::new(n.clone(), w).unwrap();
            assert_eq!(ours.dimension(), theirs.dimension(), "level {:?} weight {:?}", n.gen, w.k);
            if n.norm() > 20 || !(k1, k2).eq(&(2, 4)) && !(k1, k2).eq(&(4, 4)) || ours.dimension() == 0 {
                continue;
            }
            let gns = GeneralNewspaces::new(&o, &level, w).unwrap();
            let wns = WeightNewspaces::new(n.clone(), w).unwrap();
            for p in &ps {
                let q = single_prime(&f, &f.principal(&qe(p.gen.a, p.gen.b)).unwrap());
                let a = gns.hecke_charpoly(&q).unwrap();
                let b: QPoly = wns.hecke_charpoly(p).unwrap().into_iter().map(|c| QElt { a: c.a, b: c.b }).collect();
                assert_eq!(a, b, "level {:?} weight {:?} prime {:?}", n.gen, w.k, p.gen);
                compared += 1;
            }
        }
    }
    assert_eq!(compared, 75);
}

fn lines(tag: &str) -> Vec<Vec<String>> {
    FIXTURE.lines().filter(|l| l.starts_with(tag)).map(|l| l[tag.len()..].split('|').map(|s| s.trim().to_string()).collect()).collect()
}

struct Fields {
    fields: HashMap<i64, (QuadField, MaximalOrder, bool)>,
}

impl Fields {
    fn new() -> Fields {
        let mut fields = HashMap::new();
        for l in lines("F ") {
            let d: i64 = l[0].parse().unwrap();
            let (f, o) = order(d);
            // Magma's first place has sqrt d > 0: its [k1, k2] is our (k2, k1)
            fields.insert(d, (f, o, l[1] == "+"));
        }
        assert_eq!(fields.len(), 10);
        Fields { fields }
    }
    fn get(&self, d: &str) -> &(QuadField, MaximalOrder, bool) {
        &self.fields[&d.parse::<i64>().unwrap()]
    }
    fn level(&self, d: &str, s: &str) -> QIdeal {
        let f = &self.get(d).0;
        let v: Vec<i64> = s.replace(';', " ").split_whitespace().map(|x| x.parse().unwrap()).collect();
        f.ideal(&[qe(v[0], v[1]), qe(v[2], v[3])]).unwrap()
    }
    fn prime(&self, d: &str, s: &str) -> QPrime {
        let f = &self.get(d).0;
        let v: Vec<i64> = s.split_whitespace().map(|x| x.parse().unwrap()).collect();
        let i = if v[2] == 0 { f.principal(&qe(v[0], 0)).unwrap() } else { f.ideal(&[qe(v[0], 0), qe(v[1], v[2])]).unwrap() };
        single_prime(f, &i)
    }
    fn weight(&self, d: &str, s: &str) -> Weight {
        let v: Vec<u32> = s.split_whitespace().map(|x| x.parse().unwrap()).collect();
        if self.get(d).2 {
            Weight::new(v[1], v[0]).unwrap()
        } else {
            Weight::new(v[0], v[1]).unwrap()
        }
    }
}

fn qpoly(s: &str) -> QPoly {
    s.split(';')
        .map(|c| {
            let (a, b) = c.split_once(',').unwrap();
            QElt { a: a.trim().parse::<BigInt>().unwrap(), b: b.trim().parse::<BigInt>().unwrap() }
        })
        .collect()
}

#[test]
fn dimensions_vs_magma() {
    let fs = Fields::new();
    let ds = lines("D ");
    assert_eq!(ds.len(), 616);
    let mut spaces: HashMap<(String, String), Arc<DefiniteSpace>> = HashMap::new();
    for l in &ds {
        let (_, o, _) = fs.get(&l[0]);
        let n = fs.level(&l[0], &l[1]);
        let sp = spaces.entry((l[0].clone(), l[1].clone())).or_insert_with(|| Arc::new(DefiniteSpace::new(o, &n).unwrap())).clone();
        let w = fs.weight(&l[0], &l[2]);
        let s = GeneralSpace::new(sp, w).unwrap();
        assert_eq!(s.dimension(), l[3].parse::<usize>().unwrap(), "d = {} level {} weight {}", l[0], l[1], l[2]);
    }
}

fn newspaces<'a>(fs: &Fields, cache: &'a mut BTreeMap<(String, String, String), GeneralNewspaces>, l: &[String]) -> &'a GeneralNewspaces {
    cache.entry((l[0].clone(), l[1].clone(), l[2].clone())).or_insert_with(|| {
        let (_, o, _) = fs.get(&l[0]);
        GeneralNewspaces::new(o, &fs.level(&l[0], &l[1]), fs.weight(&l[0], &l[2])).unwrap()
    })
}

/// T_P (U_P for P | N) on the full space: exactly in parallel weight, up to
/// conjugation in non-parallel weight.
#[test]
fn hecke_charpolys_vs_magma() {
    let fs = Fields::new();
    let mut cache = BTreeMap::new();
    let (mut exact, mut up_to_conj) = (0, 0);
    for tag in ["H ", "C "] {
        for l in lines(tag) {
            let f = fs.get(&l[0]).0;
            let p = fs.prime(&l[0], &l[3]);
            let ns = newspaces(&fs, &mut cache, &l);
            let ours = ns.hecke_charpoly(&p).unwrap();
            let want = qpoly(&l[4]);
            let what = format!("d = {} level {} weight {} prime {}", l[0], l[1], l[2], l[3]);
            if tag == "H " {
                assert_eq!(ours, want, "{}", what);
                exact += 1;
            } else {
                assert!(ours == want || gpoly::conj(&f, &ours) == want, "{}: {:?} against {:?}", what, ours, want);
                up_to_conj += 1;
            }
        }
    }
    assert_eq!((exact, up_to_conj), (373, 968));
}

/// Newform orbits at prime levels: dimensions, and the characteristic
/// polynomials over F of a_P at the primes of norm <= 11 (over Q, as norms,
/// where Magma's eigenvalue field was not presented over F).
#[test]
fn orbits_vs_magma() {
    let fs = Fields::new();
    let mut want: BTreeMap<(String, String, String), Vec<(usize, Vec<(String, String)>)>> = BTreeMap::new();
    for l in lines("O ") {
        let toks: Vec<&str> = l[4].split_whitespace().collect();
        let mut aps = vec![];
        for c in toks.chunks(3) {
            let (z, cp) = c[2].split_once(':').unwrap();
            aps.push((format!("{} {} {}", c[0], c[1], z), cp.to_string()));
        }
        want.entry((l[0].clone(), l[1].clone(), l[2].clone())).or_default().push((l[3].parse().unwrap(), aps));
    }
    let mut cache = BTreeMap::new();
    let mut orbits = 0;
    let mut pinned = 0;
    for ((d, n, k), theirs) in &want {
        let (f, flip) = (fs.get(d).0, fs.get(d).2);
        let key = [d.clone(), n.clone(), k.clone()];
        let ns = newspaces(&fs, &mut cache, &key);
        let o = ns.newform_orbits().unwrap();
        let what = format!("d = {} level {} weight {}", d, n, k);
        let mut dims: Vec<usize> = o.orbits.iter().map(|g| g.len() - 1).collect();
        let mut tdims: Vec<usize> = theirs.iter().map(|t| t.0).collect();
        dims.sort();
        tdims.sort();
        assert_eq!(dims, tdims, "{}: orbit dimensions", what);
        let primes: Vec<QPrime> = theirs[0].1.iter().map(|(p, _)| fs.prime(d, p)).collect();
        let (cps, _) = ns.orbit_data(&o, &primes).unwrap();
        let mut used = vec![false; o.orbits.len()];
        for (dim, aps) in theirs {
            let matches = |j: usize, in_f_conj: bool| {
                o.orbits[j].len() - 1 == *dim
                    && aps.iter().zip(&cps[j]).all(|((_, cp), ours)| match cp.strip_prefix('Q') {
                        // over Q: N_(F/Q) of ours if the eigenvalue field
                        // contains F (degree 2 dim), else ours, rational
                        Some(q) => {
                            let q: Vec<BigInt> = q.split(';').map(|x| x.parse::<BigInt>().unwrap()).collect();
                            if q.len() - 1 == 2 * dim {
                                gpoly::norm(&f, ours).unwrap() == q
                            } else {
                                *ours == gpoly::from_z(&q)
                            }
                        }
                        None => {
                            let theirs = qpoly(cp);
                            // an eigenvalue in F: x - a, raised to the
                            // orbit's dimension, up to conjugation; a
                            // relative one is read at Magma's k1 place
                            let in_f = theirs.len() == 2;
                            let mut want = theirs.clone();
                            while want.len() - 1 < *dim {
                                want = gpoly::mul(&f, &want, &theirs);
                            }
                            let conj = if in_f { in_f_conj } else { !flip };
                            (if conj { gpoly::conj(&f, ours) } else { ours.clone() }) == want
                        }
                    })
            };
            let j = (0..o.orbits.len()).find(|&j| !used[j] && (matches(j, false) || matches(j, true))).unwrap_or_else(|| panic!("{}: an orbit of dimension {} has no match", what, dim));
            used[j] = true;
            orbits += 1;
            // the relative ones, compared exactly
            pinned += aps.iter().filter(|(_, cp)| !cp.starts_with('Q') && cp.split(';').count() > 2).count();
        }
    }
    assert_eq!((orbits, pinned), (100, 143));
}

/// Odd weights: 0 when N(eps) = -1 (Q(sqrt 2)), not in general when
/// N(eps) = 1 (Q(sqrt 3), level 2 (norm 4), weight (3, 3): Magma's
/// dimension 1, with T at the prime above 7 equal to -94).
#[test]
fn odd_weights() {
    let (f, o) = order(2);
    let sp = Arc::new(DefiniteSpace::new(&o, &f.principal(&qe(6, 0)).unwrap()).unwrap());
    assert_eq!(GeneralSpace::new(sp, Weight::new(3, 3).unwrap()).unwrap().dimension(), 0);
    let (f, o) = order(3);
    let ns = GeneralNewspaces::new(&o, &f.principal(&qe(2, 0)).unwrap(), Weight::new(3, 3).unwrap()).unwrap();
    assert_eq!(ns.top().dimension(), 1);
    let p = f.primes_above(7).unwrap()[0];
    assert_eq!(ns.hecke_charpoly(&p).unwrap(), vec![qe(94, 0), qe(1, 0)]);
}

/// Refusals: weight (2, 2), an algebra (a, b) with a or b outside Z, and
/// a Hecke operator at a prime dividing the level in an operator sum.
#[test]
fn refusals() {
    let (f, o) = order(3);
    let sp = Arc::new(DefiniteSpace::new(&o, &f.unit_ideal()).unwrap());
    assert!(GeneralSpace::new(sp, Weight::new(2, 2).unwrap()).is_err());
    let ns = GeneralNewspaces::new(&o, &f.principal(&qe(2, 0)).unwrap(), Weight::new(3, 3).unwrap()).unwrap();
    let p2 = f.primes_above(2).unwrap()[0];
    assert!(ns.new_charpoly(&vec![(p2, 1)]).is_err());
    let alg = QuatAlg::new(f, qe(-1, 0), qe(-3, 0)).unwrap();
    assert!(sagebrush_hmf::defweight::place_pairs(&alg).is_ok());
    let alg = QuatAlg::new(f, qe(-1, 0), qe(-5, 1)).unwrap();
    assert!(sagebrush_hmf::defweight::place_pairs(&alg).is_err());
    // a request above the work limit is refused before the work: T_3 on
    // S_(10, 10)((9)) over Q(sqrt 13), of dimension 972
    let (f, o) = order(13);
    let ns = GeneralNewspaces::new(&o, &f.principal(&qe(9, 0)).unwrap(), Weight::new(10, 10).unwrap()).unwrap();
    assert_eq!(ns.top().dimension(), 972);
    let p = f.primes_above(3).unwrap()[0];
    let t = std::time::Instant::now();
    let e = ns.hecke_charpoly(&p).unwrap_err();
    assert!(e.contains("above the limit"), "{}", e);
    assert!(t.elapsed().as_secs() < 5);
}
