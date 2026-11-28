//! Codex audit A07b F2: expanding a sum to the minimum signed exponent,
//! i64::MIN, takes its magnitude without signed negation; F3: the radical-
//! index search with an lcm past i64.  Its own test binary: Stop's test
//! hooks are process-wide.
use sagebrush_sym::err::{catch, install_quiet_hook};
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

#[test]
fn f3_radical_index_lcm_past_i64() {
    // (Sage's exact lcm is 18446743979220271189: the candidate search must
    // not overflow forming it.  The integral's other methods run long on
    // these radicals, so Stop is armed well past the search; an interrupt
    // is fine, an overflow panic is not, since catch passes it through)
    install_quiet_hook();
    for f in [
        "sin(x^(1/4294967291) + x^(1/4294967279))",
        "exp(x^(1/4294967291) + x^(1/4294967279))",
        "1/(1 + x^(1/4294967291) + x^(1/4294967279))",
    ] {
        let e = parse(f);
        sagebrush_interrupt::hooks::reset();
        sagebrush_interrupt::hooks::arm_at(20_000);
        // (an answer, a typed refusal or an interrupt: each returns here; an
        // overflow panic unwinds through both catches and fails the test)
        let _ = sagebrush_interrupt::catch(|| catch(|| sagebrush_sym::integrate::integrate(&e, "x")));
        sagebrush_interrupt::clear();
        sagebrush_interrupt::hooks::reset();
        let _ = f;
    }
    // (control: small indices still substitute u = x^(1/6), lcm(2, 3))
    let e = parse("1/(x^(1/2) + x^(1/3))");
    assert!(matches!(catch(|| sagebrush_sym::integrate::integrate(&e, "x")), Ok(Some(_))));
}
