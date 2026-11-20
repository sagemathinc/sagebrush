//! A malformed token (zmul's, zseries's, qpoly's) holding multi-byte UTF-8
//! across the error preview's 40-byte cut is refused with the grammar's
//! message, never a panic (the request's strings are any UTF-8).  An
//! integration test, so it also runs under wasm32-wasip1.

use sagebrush_arith::{qpoly, zmul, zseries};

#[test]
fn a_preview_never_cuts_a_character() {
    // (2-, 3- and 4-byte characters at every offset across the cut)
    let mut toks = vec!["界".repeat(20), "-".to_string() + &"f".repeat(38) + "é"];
    for ch in ["é", "界", "😀"] {
        for k in 35..41 {
            toks.push("a".repeat(k) + &ch.repeat(3));
        }
    }
    for tok in toks {
        let e = zmul::scan(&tok).err().expect("refused");
        assert!(e.contains("is not a hex integer"), "{}", e);
        let e = zseries::scan(&tok, 10, true).err().expect("refused");
        assert!(e.contains("is not a hex integer"), "{}", e);
        // (qpoly_mul's rational tokens, numerator and denominator)
        let e = qpoly::scan(&tok).err().expect("refused");
        assert!(e.contains("is not a hex rational"), "{}", e);
        let e = qpoly::scan(&format!("1/{}", tok)).err().expect("refused");
        assert!(e.contains("is not a hex rational"), "{}", e);
    }
    assert_eq!(zseries::preview(&("a".repeat(39) + "界"), 40), "a".repeat(39));
    assert_eq!(zseries::preview("abc", 40), "abc");
}
