//! A Stop in number-field factoring, in its own test binary: the request flag
//! is process-wide, so it must not run alongside the other tests.

use sagebrush_bigint::BigInt;

/// The number-field factoring's shift search is a Stop point, and a Stop
/// leaves no state: prod_{j=-32}^{31} (x - j a), a^2 = 2, which needs 65
/// shifts (Codex audit A03-F2), stopped, then factored whole.
#[test]
fn number_field_shift_search_stops() {
    use sagebrush_poly::nf::{Field, KPoly};
    let z = |v: i64| BigInt::from(v);
    let k = Field::new(&[z(-2), z(0), z(1)]).unwrap();
    let mut f = KPoly::new(2, vec![vec![z(1), z(0)]], z(1));
    for j in -32i64..32 {
        f = k.mul(&f, &KPoly::new(2, vec![vec![z(0), z(-j)], vec![z(1), z(0)]], z(1)));
    }
    sagebrush_interrupt::request();
    let r = sagebrush_interrupt::catch(|| k.factor(&f));
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "interrupted");
    assert_eq!(k.factor(&f).unwrap().1.len(), 64);
}
