//! poly_mul's schoolbook work bound at extreme lengths, on every target
//! width: the closed form is checked arithmetic over usize lengths, so it
//! returns None exactly when the true count passes u64 (on 64-bit targets
//! usize::MAX does; on wasm32 it doesn't), never a wrapped value or a panic.
//! An integration test, so it also builds and runs under wasm32-wasip1.

use sagebrush_arith::zmul;

#[test]
fn the_schoolbook_closed_form_never_wraps() {
    // (the exact value in u128, then None exactly when it passes u64: on
    // 64-bit targets usize::MAX overflows; on wasm32 it doesn't)
    let reference = |a: usize, b: usize| -> Option<u64> {
        let (x, y) = (a as u128, b as u128);
        let v = x.checked_mul(y)?.checked_add(x + y + x.min(y))?;
        u64::try_from(v).ok()
    };
    let m = usize::MAX;
    for (a, b) in [(m, 1), (1, m), (m, m), (m / 2, 3), (m, 0), (0, 7), (3, 5), (1 << 20, 1 << 20)] {
        assert_eq!(zmul::schoolbook_work(a, b), reference(a, b), "zmul::schoolbook_work({}, {})", a, b);
    }
    if usize::BITS == 64 {
        assert_eq!(zmul::schoolbook_work(m, 1), None);
        assert_eq!(zmul::schoolbook_work(m, m), None);
    }
}
