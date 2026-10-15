//! The Hessenberg characteristic polynomial polls for Stop in its
//! recurrence, not only in its reduction (daybreak HARD-FE6-1). An upper
//! Hessenberg matrix needs no reduction (its polled work there is a pivot
//! search per column, below the polling interval), and with every entry on
//! or above the subdiagonal equal to 1 the recurrence does its full n^3 / 6
//! work: an interrupt requested beforehand must be seen there. This file
//! has a single test, because the flag is global to the process.

use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_mat::Mat;

#[test]
fn hessenberg_recurrence_is_cancellable() {
    let md = Modulus::new(65537);
    let n = 200;
    let rows: Vec<Vec<u64>> = (0..n).map(|i| (0..n).map(|j| if j + 1 >= i { 1 } else { 0 }).collect()).collect();
    let m = Mat::from_rows(&rows, md);
    // the reduction alone does not poll: n pivot searches of n entries
    // are below 2^16
    assert!(n * n < 1 << 16);
    sagebrush_interrupt::request();
    let r = sagebrush_interrupt::catch(|| m.charpoly_hessenberg());
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "the interrupt was not seen in the recurrence");
    // and without one, the same matrix gives its characteristic polynomial
    let c = sagebrush_interrupt::catch(|| m.charpoly_hessenberg()).unwrap();
    assert_eq!(c.len(), n + 1);
    assert_eq!(c[n], 1);
}
