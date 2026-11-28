//! Codex audit A07 (engine/sym): fractional powers in series and limits, a
//! rational exponent's integer part past i64, and the exponent -2^63; and
//! Taylor polynomials against stored Sage 10.10 answers.
use sagebrush_sym::{expr::*, limit::{limit, Dir}, parse::parse, series::taylor, simplify::simplify_full, to_string};

fn t(f: &str, n: i64) -> String {
    to_string(&taylor(&parse(f), "x", &zero(), n))
}

fn lim(f: &str, dir: Dir) -> String {
    to_string(&limit(&parse(f), "x", &zero(), dir))
}

#[test]
fn a07_f1_fractional_powers_keep_their_leading_term() {
    sagebrush_sym::err::install_quiet_hook();
    // (x^8 + x^10)^(1/4) = x^2 (1 + x^2)^(1/4): Sage 10.10 gives 1*x^2 + Order(x^3) and
    // limit(f/x^2, x=0) = 1, from both sides and two-sided
    assert_eq!(t("(x^8 + x^10)^(1/4)", 2), "x^2");
    assert_eq!(t("(x^8 + x^10)^(1/4)", 4), to_string(&parse("x^2 + 1/4*x^4")));
    // a base whose leading term is known but not enough of it: (x^8 + x^10)^(1/2) through x^6 needs
    // the base through x^10, past the x^8 that two terms over the requested precision gave
    assert_eq!(t("(x^4 + x^6)^(1/2)", 4), to_string(&parse("x^2 + 1/2*x^4")));
    assert_eq!(t("(x^8 + x^10)^(1/2)", 6), to_string(&parse("x^4 + 1/2*x^6")));
    assert_eq!(t("(x^12 + x^15)^(1/3)", 7), to_string(&parse("x^4 + 1/3*x^7")));
    for dir in [Dir::Both, Dir::Plus, Dir::Minus] {
        assert_eq!(lim("(x^8 + x^10)^(1/4)/x^2", dir), "1");
    }
    // the audit's grid: (x^(q m) (1 + x^2))^(1/q) = x^m (1 + x^2)^(1/q) and (x^(q m))^(1/q) = x^m,
    // m even (so both sides agree), q = 2..8: through t^m the series is x^m, and f/x^m -> 1
    for q in 2..=8 {
        for m in [2, 4, 6] {
            for f in [format!("(x^{} * (1 + x^2))^(1/{})", q * m, q), format!("(x^{})^(1/{})", q * m, q)] {
                assert_eq!(t(&f, m), format!("x^{}", m), "{}", f);
                assert_eq!(lim(&format!("{}/x^{}", f, m), Dir::Both), "1", "{}", f);
            }
        }
    }
    // a base that vanishes to every precision asked for still gives an exact zero series
    assert_eq!(t("(x^40)^(1/2)", 3), "0");
}

#[test]
fn a07_f2_an_integer_part_past_i64_stays_in_the_power() {
    sagebrush_sym::err::install_quiet_hook();
    // 4^(18446744073709551617/2) is 2^18446744073709551617, never 2: the power stays as written
    for s in ["4^(18446744073709551617/2)", "4^(-18446744073709551617/2)", "(1/4)^(18446744073709551617/2)"] {
        let e = parse(s);
        assert!(matches!(e.kind, Kind::Pow(..)), "{} -> {}", s, to_string(&e));
        assert_ne!(to_string(&e), "2");
        assert_ne!(to_string(&e), "1/2");
    }
    // an integer part that fits is still taken out: 4^(7/2) = 128
    assert_eq!(to_string(&parse("4^(7/2)")), "128");
}

#[test]
fn a07_f3_the_exponent_minus_two_to_the_63() {
    sagebrush_sym::err::install_quiet_hook();
    // simplify_full keeps the negative exponent (Sage keeps x^(-9223372036854775808));
    // the series refuses, instead of 1/x
    let e = parse("x^(-9223372036854775808)");
    let s = to_string(&simplify_full(&e));
    assert!(s.contains("9223372036854775808") && (s.contains('-') || s.starts_with("1/")), "{}", s);
    assert_ne!(s, "x^9223372036854775808");
    let r = sagebrush_sym::err::catch(|| t("x^(-9223372036854775808)", 2));
    assert!(r.is_err(), "{:?}", r);
    // and the next exponent up is unaffected
    assert_eq!(t("x^(-2)", 0), "x^(-2)");
}

#[test]
fn taylor_polynomials_as_sage_gives_them() {
    // 80 expressions drawn at random (seed 720260128) for the audit's differential
    // check, with Sage 10.10's taylor(f, x, 0, n)
    sagebrush_sym::err::install_quiet_hook();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/corpus/taylor_sage.json");
    let d: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = d["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 80);
    for c in cases {
        let (f, n, s) = (c["expr"].as_str().unwrap(), c["n"].as_i64().unwrap(), c["sage"].as_str().unwrap());
        let ours = taylor(&parse(f), "x", &zero(), n);
        let diff = simplify_full(&sub(&ours, &parse(s)));
        assert!(diff.is_zero(), "taylor({}, x, 0, {}) = {}, Sage {}", f, n, to_string(&ours), s);
    }
}
