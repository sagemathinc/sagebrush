//! The class enumeration and its lattice searches are cancellable (the
//! Stop button, @sagebrush-daybreak's HARD-2CF-1): with an interrupt
//! requested, ClassSet::new unwinds with sagebrush_interrupt::Interrupted.
//! This file has a single test, because the flag is global to the process.

use sagebrush_hmf::classes::ClassSet;
use sagebrush_hmf::quatalg::{MaximalOrder, QuatAlg};
use sagebrush_hmf::rqf::QuadField;

#[test]
fn class_sets_are_cancellable() {
    // Q(sqrt 79): 69 classes, so the enumeration reaches the checks
    let f = QuadField::new(79).unwrap();
    let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
    sagebrush_interrupt::request();
    let r = sagebrush_interrupt::catch(|| ClassSet::new(&o));
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "the interrupt was not seen");
    // and the next call works normally
    let cs = sagebrush_interrupt::catch(|| ClassSet::new(&o)).unwrap().unwrap();
    assert_eq!(cs.len(), 69);
}
