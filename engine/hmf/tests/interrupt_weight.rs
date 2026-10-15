//! The weight k computations are cancellable (the Stop button): with an
//! interrupt requested, WeightNewspaces::hecke_charpoly unwinds with
//! sagebrush_interrupt::Interrupted (defweight.rs checks at every term of a
//! Hecke operator, and in its searches). This file has a single test,
//! because the flag is global to the process.

use sagebrush_hmf::defweightnew::WeightNewspaces;
use sagebrush_hmf::quatalg::{MaximalOrder, QuatAlg};
use sagebrush_hmf::rqf::{QElt, QuadField};
use sagebrush_hmf::weight::Weight;

#[test]
fn weight_hecke_operators_are_cancellable() {
    let f = QuadField::new(10).unwrap();
    let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
    let ns = WeightNewspaces::new(&o, &f.principal(&QElt::int(3)).unwrap(), Weight::new(4, 4).unwrap()).unwrap();
    let p = f.primes_above(7).unwrap()[0];
    sagebrush_interrupt::request();
    let r = sagebrush_interrupt::catch(|| ns.hecke_charpoly(&p));
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "the interrupt was not seen");
    // and the next call works normally
    let c = sagebrush_interrupt::catch(|| ns.hecke_charpoly(&p)).unwrap().unwrap();
    assert_eq!(c.len(), 169);
}
