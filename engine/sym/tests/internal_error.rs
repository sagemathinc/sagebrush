//! An internal error of the factoring engine through a symbolic caller
//! (rank-3 plan r3 section 3.5; CORR-RANK3-INTERNAL-2, astra2).  Integrating
//! 1/(x S_4) factors the denominator x S_4 (S_4 has 8 quadratic factors
//! modulo every good prime, so recombination runs); with the pre-pass
//! skipped (an injected fault, feature test-faults), x | g reaches the
//! invariant and the factoring engine's Internal error comes up.
//!
//! - natively, api::call answers "err\x1fRuntimeError\x1f<the message>"
//!   (sagebrush._native.sym_call hands that string to Python, which raises
//!   RuntimeError);
//! - in WebAssembly the panic aborts: the quiet hook's last-error record
//!   carries the same kind and message, which sb_last_error hands to the
//!   host after the trap (src/runtime/engine.ts symCall).
use sagebrush_sym::{api, err, integrate::integrate, parse::parse};

const F: &str = "1/(x^17 - 136*x^15 + 6476*x^13 - 141912*x^11 + 1513334*x^9 - 7453176*x^7 + 13950764*x^5 - 5596840*x^3 + 46225*x)";

#[test]
fn an_internal_factor_error_is_a_runtime_error_on_both_hosts() {
    err::install_quiet_hook();
    let fault = sagebrush_poly::test_faults::SKIP_PREPASS;
    // without the fault: no error (the logarithmic part needs the roots of
    // the irreducible S_4, so the integral stays unevaluated: None)
    assert!(err::catch(|| integrate(&parse(F), "x")).is_ok());
    // the typed error, through the symbolic caller
    let _ = err::take_last_error();
    let e = sagebrush_poly::test_faults::with(fault, || err::catch(|| integrate(&parse(F), "x"))).unwrap_err();
    let m = match &e {
        err::SymError::Internal(m) => m.clone(),
        other => panic!("not an internal error: {other:?}"),
    };
    assert!(m.starts_with(sagebrush_poly::INTERNAL_PREFIX) && m.contains("please report it"), "{}", m);
    // the WebAssembly route: the hook recorded the kind and the message
    assert_eq!(err::take_last_error(), Some(("RuntimeError".to_string(), m.clone())));
    // the native route: in band, as RuntimeError
    let req = format!("integrate\x1f{}\x1fx", api::encode(&parse(F)));
    let reply = sagebrush_poly::test_faults::with(fault, || api::call(&req));
    assert_eq!(reply, format!("err\x1fRuntimeError\x1f{}", m));
    let _ = err::take_last_error();
}
