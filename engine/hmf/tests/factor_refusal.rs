//! A factorization over Z refused within newform-orbit computations is the
//! caller's error (not a panic or a trap), and leaves no cached result: the
//! next call computes the orbits.

use sagebrush_poly::{with_default_limits, Limits};

fn tight() -> Limits {
    // (admission refuses any non-constant polynomial)
    Limits { max_degree: 0, ..Limits::DEFAULT }
}

#[test]
fn newspace_orbits_refusal() {
    use sagebrush_hmf::field::ideals_of_bounded_norm;
    use sagebrush_hmf::newspace::Newspaces;
    // the first level whose new part needs a factorization (dimension >= 2)
    let ns = ideals_of_bounded_norm(300)
        .into_iter()
        .map(|n| Newspaces::new(n).unwrap())
        .find(|ns| ns.new_dimension() >= 2)
        .expect("a newspace of dimension >= 2");
    let e = with_default_limits(tight(), || ns.newform_orbits()).unwrap_err();
    assert!(e.starts_with("factor: resource limit exceeded"), "{}", e);
    let o = ns.newform_orbits().unwrap();
    assert_eq!(o.dimensions().iter().sum::<usize>(), ns.new_dimension());
}

#[test]
fn definite_orbits_refusal() {
    use sagebrush_hmf::defnew::Newspaces;
    use sagebrush_hmf::quatalg::{MaximalOrder, QuatAlg};
    use sagebrush_hmf::rqf::QuadField;
    let f = QuadField::new(106).unwrap();
    let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
    let ns = Newspaces::new(&o, &f.unit_ideal()).unwrap();
    let e = with_default_limits(tight(), || ns.newform_orbits()).unwrap_err();
    assert!(e.starts_with("factor: resource limit exceeded"), "{}", e);
    assert_eq!(ns.newform_orbits().unwrap().dimensions().iter().sum::<usize>(), 50);
}
