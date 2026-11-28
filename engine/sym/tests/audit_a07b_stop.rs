//! Codex audit A07b F2: expanding a sum to the minimum signed exponent,
//! i64::MIN, takes its magnitude without signed negation.  Its own test
//! binary: Stop's test hooks are process-wide.
use sagebrush_sym::err::install_quiet_hook;
use sagebrush_sym::parse::parse;

fn line(s: &str) -> Result<String, String> {
    install_quiet_hook();
    sagebrush_sym::ops::run_line(s)
}

#[test]
fn f2_minimum_signed_exponent_of_a_sum() {
    // (the magnitude without signed negation; the expansion itself is
    // stoppable, so Stop is armed some checks in, past the sign test, and
    // interrupts the expansion's own loop)
    install_quiet_hook();
    let e = parse("(x+1)^(-9223372036854775808)");
    sagebrush_interrupt::hooks::reset();
    sagebrush_interrupt::hooks::arm_at(50);
    let r = sagebrush_interrupt::catch(|| sagebrush_sym::expand::expand(&e));
    sagebrush_interrupt::clear();
    sagebrush_interrupt::hooks::reset();
    assert!(r.is_err(), "interrupted in the expansion, not a negation panic");
    // (controls)
    assert_eq!(line("expand((x+1)^(-3))").as_deref(), Ok("1/(x^3 + 3*x^2 + 3*x + 1)"));
    assert_eq!(line("expand(x^(-9223372036854775808))").as_deref(), Ok("x^(-9223372036854775808)"));
}
