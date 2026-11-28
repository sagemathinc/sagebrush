//! A Stop during a fractional-power expansion (A07's review), in its own test binary:
//! the request flag is process-wide.
use sagebrush_sym::{expr::*, parse::parse, series::taylor};

#[test]
fn a_fractional_power_expansion_stops() {
    sagebrush_sym::err::install_quiet_hook();
    // (x^200)^(1/200) through t^3 expands its base far (products quadratic in the precision):
    // a Stop requested before the call ends it at the next poll, and the next call is whole
    sagebrush_interrupt::request();
    let r = sagebrush_interrupt::catch(|| taylor(&parse("(x^200)^(1/200)"), "x", &zero(), 3));
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "stopped");
    // (the same call, not stopped, ends in its own answer: two-sided it is |x|, refused at the branch)
    let e = sagebrush_sym::err::catch(|| taylor(&parse("(x^200)^(1/200)"), "x", &zero(), 3)).unwrap_err();
    assert!(format!("{:?}", e).contains("branch point"), "{:?}", e);
}
