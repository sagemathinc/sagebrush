//! qpoly_mul's closed forms at extreme lengths, on every target width: each
//! is checked arithmetic, so it returns None exactly when the true value
//! passes u64, never a wrapped value or a panic.  An integration test, so
//! it also builds and runs under wasm32-wasip1.

use sagebrush_arith::{coprime, qpoly};

fn fit(v: Option<u128>) -> Option<u64> {
    v.and_then(|v| u64::try_from(v).ok())
}

#[test]
fn the_closed_forms_never_wrap() {
    let m = u64::MAX as u128;
    let lens = [0u64, 1, 2, 3, 1 << 20, u64::MAX / 7, u64::MAX / 3, u64::MAX / 2, u64::MAX - 3, u64::MAX];
    for &x in &lens {
        let x1 = x as u128;
        // Qhat(lx) = ceil((lx + 3)^2 / 2) + 3 lx + 8
        let qhat = (x1 + 3).checked_mul(x1 + 3).map(|s| s.div_ceil(2) + 3 * x1 + 8);
        assert_eq!(coprime::quot_work_any(x), if x1 + 3 > m { None } else { fit(qhat) }, "Qhat({})", x);
        // max_charge, 7 l + 101
        assert_eq!(qpoly::max_charge(x), fit(Some(7 * x1 + 101)), "max_charge({})", x);
        for &y in &lens {
            let y1 = y as u128;
            // Q(lx, ly) = (lx - ly + 1)(2 ly + 4) + 3 lx + 8, for 1 <= ly <= lx
            let q = if y == 0 || y > x { None } else { (x1 - y1 + 1).checked_mul(2 * y1 + 4).map(|v| v + 3 * x1 + 8) };
            let want = if y == 0 || y > x || 2 * y1 + 4 > m || x1 - y1 + 1 > m || 3 * x1 > m { None } else { fit(q) };
            assert_eq!(coprime::quot_work(x, y), want, "Q({}, {})", x, y);
        }
    }
}
