//! The longest square products qpoly_mul computes at the op's caps,
//! recorded: n x n factors of one-digit numerators succeed at n and are
//! refused at n + 1 (the whole call: the reduction is metered).  Integers
//! and halves reach about 5.4 10^5 output terms, refused past that by the
//! reduction's meter; denominators whose D = L_a L_b has 2, 3 or 5 limbs by
//! the transform's points (zmul's cap); sum x^i / i squared with up to
//! 2140 terms (degree 2139), then by the reduction's meter.  (The NTT
//! backend's work form, taken at the 32-bit backend's log N + 1 stages, left
//! the reduction's meter less: 275,192, 273,070 and 2152 before.)

use sagebrush_arith::qpoly;

fn call(a: &str) -> Result<String, String> {
    let r = (2 * a.len() + 20) as u64;
    let f = qpoly::scan(a)?;
    qpoly::reply(&f, &f, r, &qpoly::CAPS)
}

#[test]
fn the_admitted_maxima() {
    const METER: &str = "the coefficients' reduction needs more than";
    const POINTS: &str = "the transform's points";
    // (token, the largest n, what refuses n + 1)
    let cases = [
        ("7", 270_922, METER),                                    // D = 1
        ("7/2", 268_789, METER),                                  // D = 4
        ("7/10000000001", 152_519, POINTS),                       // 2 limbs
        ("7/1000000000000000001", 96_977, POINTS),                // 3 limbs
        ("7/10000000000000000000000000000000001", 55_923, POINTS), // 5 limbs
    ];
    for (tok, n, why) in cases {
        let ok = call(&vec![tok; n].join(","));
        assert!(ok.is_ok(), "{} at n = {}: {:?}", tok, n, ok.err());
        let e = call(&vec![tok; n + 1].join(",")).err().unwrap_or_else(|| panic!("{} admitted at n = {}", tok, n + 1));
        assert!(e.contains(why), "{}: {}", tok, e);
    }
    let harmonic = |n: usize| (1..=n).map(|i| format!("1/{:x}", i)).collect::<Vec<_>>().join(",");
    assert!(call(&harmonic(2140)).is_ok());
    assert!(call(&harmonic(2141)).err().unwrap().contains(METER));
}
