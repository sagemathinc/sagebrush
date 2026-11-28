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

#[test]
fn a07_round2_cost_follows_the_base_not_one_over_r() {
    // (x^20)^(1/400) through t^3: the base is asked for in doubling precisions and shows x^20 at
    // 24, not after an expansion through t^1600 at once (that took 22 s), and the answer (a
    // Puiseux refusal, x^(1/20)) comes at once; (x^200)^(1/200), |x| two-sided, is refused at the
    // branch after its base is found by doubling, and x^200 is built by squaring, not 200 products
    sagebrush_sym::err::install_quiet_hook();
    let t0 = std::time::Instant::now();
    let e = sagebrush_sym::err::catch(|| t("(x^20)^(1/400)", 3)).unwrap_err();
    assert!(format!("{:?}", e).contains("Puiseux"), "{:?}", e);
    assert!(t0.elapsed().as_secs() < 5, "{:?}", t0.elapsed());
    let e = sagebrush_sym::err::catch(|| t("(x^200)^(1/200)", 3)).unwrap_err();
    assert!(format!("{:?}", e).contains("branch point"), "{:?}", e);
    // where the expansion exists it comes out: (x^100 + x^102)^(1/2) = x^50 (1 + x^2)^(1/2), zero
    // through t^3 and x^50 + 1/2*x^52 through t^52
    assert_eq!(t("(x^100 + x^102)^(1/2)", 3), "0");
    assert_eq!(t("(x^100 + x^102)^(1/2)", 52), to_string(&parse("x^50 + 1/2*x^52")));
    assert!(t0.elapsed().as_secs() < 20, "{:?}", t0.elapsed());
}

#[test]
fn a07_round2_a_valuation_past_i64_is_refused() {
    // x^(2^63) as a series at 0: its valuation v r doesn't fit i64; refused, not a panic
    // (Sage gives 0; a typed refusal is the accepted alternative)
    sagebrush_sym::err::install_quiet_hook();
    let r = sagebrush_sym::err::catch(|| t("x^9223372036854775808", 2));
    assert!(r.is_err(), "{:?}", r);
}

#[test]
fn a07_round2_exponents_past_u32_are_not_truncated() {
    // numeric review of #2365: polynomial arithmetic took exponents `as u32`, so x^(2^32) simplified
    // to 1 and x^(2^40 + 3) to x^3; such exponents now stay as written (Sage 10.10 keeps each)
    sagebrush_sym::err::install_quiet_hook();
    use sagebrush_sym::simplify::{factor, simplify_rational};
    let keeps = |f: &dyn Fn(&Expr) -> Expr, s: &str, digits: &str| {
        let out = to_string(&f(&parse(s)));
        assert!(out.contains(digits), "{} -> {}", s, out);
    };
    keeps(&simplify_full, "x^4294967296", "4294967296");
    keeps(&simplify_full, "x^4294967297", "4294967297");
    keeps(&simplify_rational, "x^(-4294967297)", "4294967297");
    keeps(&simplify_full, "x^1099511627779", "1099511627779");
    keeps(&simplify_full, "x^4611686018427387904", "4611686018427387904");
    keeps(&simplify_full, "x^(-9223372036854775807)", "9223372036854775807");
    keeps(&factor, "x^4294967296 - 1", "4294967296");
    keeps(&simplify_full, "(x^2147483648 + 1)^2", "2147483648");
    keeps(&simplify_full, "x^4294967296*y + y", "4294967296");
    assert!(!simplify_full(&parse("x^4294967296")).is_one());
    // and below 2^31 nothing changes: (x^5 - 1).factor()
    assert_eq!(to_string(&factor(&parse("x^5 - 1"))), to_string(&parse("(x - 1)*(x^4 + x^3 + x^2 + x + 1)")));
}

#[test]
fn a07_round2_negative_fractional_powers() {
    sagebrush_sym::err::install_quiet_hook();
    // a negative power of a base known only to vanish is refused, never taken as zero:
    // without it limit((x^40)^(-1/2) x^20, x=0, +) was 0; Sage 10.10 gives 1
    assert_eq!(lim("(x^40)^(-1/2)*x^20", Dir::Plus), "1");
    // a short base under a negative power: (x^4 + x^5)^(-3/2) = x^-6 (1 + x)^(-3/2) through t^3
    assert_eq!(t("(x^4 + x^5)^(-3/2)", 3), to_string(&parse("x^(-6) - 3/2*x^(-5) + 15/8*x^(-4) - 35/16*x^(-3) + 315/128*x^(-2) - 693/256*x^(-1) + 3003/1024 - 6435/2048*x + 109395/32768*x^2 - 230945/65536*x^3")));
    // an integer exponent whose precision request overflows is refused at once
    let t0 = std::time::Instant::now();
    assert!(sagebrush_sym::err::catch(|| t("(x^2 + x^3)^(-4611686018427387904)", 2)).is_err());
    assert!(t0.elapsed().as_secs() < 5);
}
