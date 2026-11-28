//! Codex audit A07b: a derivative count kept and checked as Sage's, the
//! minimum signed exponent of a sum, a radical-index lcm past i64, and a
//! degree whose dense coefficient list cannot be held.  Expected values and
//! errors from Sage 10.10.
use sagebrush_sym::err::{catch, install_quiet_hook, SymError};
use sagebrush_sym::{parse::parse, print::to_string};

fn p(s: &str) -> Result<String, SymError> {
    install_quiet_hook();
    catch(|| to_string(&parse(s)))
}

/// integrate(f, x) as the engine runs it: Some(antiderivative), None if
/// none is found (unevaluated), or the typed error.
fn int(f: &str) -> Result<Option<String>, SymError> {
    install_quiet_hook();
    catch(|| sagebrush_sym::integrate::integrate(&parse(f), "x").map(|e| to_string(&e)))
}

fn line(s: &str) -> Result<String, String> {
    install_quiet_hook();
    sagebrush_sym::ops::run_line(s)
}

#[test]
fn f1_derivative_counts_as_sage() {
    // (controls, and Sage's variable-and-count specs)
    for (s, want) in [
        ("diff(x^2, x, 0)", "x^2"),
        ("diff(x, x, 1)", "1"),
        ("diff(x, x, 2)", "0"),
        ("derivative(x^3, x, 2)", "6*x"),
        ("diff(sin(x), x, 4)", "sin(x)"),
        ("diff(x*y^2, x, y)", "2*y"),
        ("diff(x^2*y^3, x, 2, y)", "6*y^2"),
        ("diff(x^2*y^3, x, y, 2)", "12*x*y"),
        ("diff(x^3*y, x, 1, y, 1)", "3*x^2"),
    ] {
        assert_eq!(p(s).as_deref(), Ok(want), "{}", s);
        assert_eq!(line(s).as_deref(), Ok(want), "line {}", s);
    }
    // (each count Sage refuses, refused with its error: never 1, never clamped)
    let refused = [
        ("diff(x, x, 9223372036854775808)", SymError::Overflow("Python int too large to convert to C long".into())),
        ("diff(x^2, x, 18446744073709551616)", SymError::Overflow("Python int too large to convert to C long".into())),
        ("diff(x^3, x, 9223372036854775807)", SymError::Overflow("value too large to convert to int".into())),
        ("diff(x, x, 1/2)", SymError::Type("argument symb must be a symbol".into())),
        ("diff(x, x, -1)", SymError::Value("derivative counts must be nonnegative".into())),
    ];
    for (s, want) in refused {
        assert_eq!(p(s), Err(want.clone()), "{}", s);
        assert!(line(s).is_err(), "line {}", s);
    }
    // (a large count of a polynomial: zero after its degree, no 2^31 - 1 steps)
    assert_eq!(p("diff(x^3, x, 2147483647)").as_deref(), Ok("0"));
}

#[test]
fn f4_a_degree_too_large_to_hold_densely() {
    // (sin of a power is not a linear argument: decided sparsely, never a
    // capacity panic)
    let r = int("sin(x^9223372036854775807)");
    assert!(r.is_ok(), "{:?}", r);
    // (by parts, x^(2^63 - 1) sin(x) needs x^(2^63 - 1)'s dense list: Sage's
    // MemoryError, typed, by the deterministic-algorithm rule: no fallback to
    // another method because memory ran short)
    assert!(matches!(int("x^9223372036854775807*sin(x)"), Err(SymError::Memory(_))));
    // (the dense list itself: Sage's MemoryError, typed)
    install_quiet_hook();
    let e = parse("x^9223372036854775807 + 1");
    assert!(matches!(catch(|| sagebrush_sym::poly::coeffs(&e, "x")), Err(SymError::Memory(_))));
    // (the degree is sparse)
    assert_eq!(sagebrush_sym::poly::degree(&e, "x"), 9223372036854775807);
    // (controls)
    let q = parse("3*x^2 + 2*x + 1");
    assert_eq!(sagebrush_sym::poly::coeffs(&q, "x").unwrap().len(), 3);
    assert_eq!(sagebrush_sym::poly::degree(&parse("0"), "x"), -1);
    assert_eq!(int("sin(2*x + 1)").ok().flatten().as_deref(), Some("-1/2*cos(2*x + 1)"));
}
