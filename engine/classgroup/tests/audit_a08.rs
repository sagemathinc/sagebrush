//! Class-group edge cases from an audit, each checked against Sage 10.10:
//! an extra prime past the modular factorization's range is refused (it
//! panicked), a form to the power i64::MIN is the right class (it was the
//! identity), and the brute class number counts primitive forms only.
use sagebrush_bigint::BigInt;
use sagebrush_classgroup::api::bnf_relations;
use sagebrush_classgroup::form::{class_number_brute, Form};

#[test]
fn an_extra_prime_past_2_32_is_refused() {
    let f: Vec<BigInt> = [-2, 0, 0, 1].iter().map(|&c| BigInt::from(c)).collect();
    // (4294967311, the least prime past 2^32)
    let r = bnf_relations(&f, &[4_294_967_311]);
    assert_eq!(r.err().as_deref(), Some("primes above p >= 2^32 are not supported (p = 4294967311)"));
    // (control: an extra prime in range)
    assert!(bnf_relations(&f, &[101]).is_ok());
}

#[test]
fn a_form_to_the_least_i64() {
    // (2, 1, 3) of discriminant -23 has order 3, and -2^63 = 1 mod 3: itself
    let d = BigInt::from(-23);
    let g = Form::new(BigInt::from(2), BigInt::from(1), &d);
    let want = g.reduced();
    assert_eq!(g.pow(i64::MIN).reduced(), want);
    assert_eq!(g.pow(i64::MIN + 1).reduced(), g.pow(-1).reduced());
    assert_eq!(g.pow(i64::MAX).reduced(), g.pow(1).reduced());
    assert_eq!(g.pow(-2).reduced(), want);
}

#[test]
fn brute_class_numbers_count_primitive_forms() {
    // (Sage: len(BinaryQF_reduced_representatives(D, primitive_only=True)))
    for (d, h) in [(-12, 1), (-16, 1), (-27, 1), (-28, 1), (-48, 2), (-75, 2), (-3, 1), (-23, 3)] {
        assert_eq!(class_number_brute(d), h, "h({})", d);
    }
}
