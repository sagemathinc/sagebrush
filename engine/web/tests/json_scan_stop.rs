//! The pre-parse scan (json_tree_bound) checks for Stop every 64 KB of the
//! text, inside a long string, escaped string or number as well, and a
//! Stop requested there ends the scan at that check.  One test: the hooks
//! and the flag are global.

use sagebrush_interrupt::hooks;
use sagebrush_web::json_tree_bound;

#[test]
fn the_scan_checks_for_stop_inside_long_tokens() {
    let mib = 1 << 20;
    let tokens = [
        ("a string", format!("\"{}\"", "a".repeat(mib))),
        ("an escaped string", format!("\"{}\"", "\\n".repeat(mib / 2))),
        ("a number", "7".repeat(mib)),
        ("a matrix", format!("[{}]", vec!["[0,1,2,3]"; mib / 10].join(","))),
    ];
    for (what, text) in &tokens {
        sagebrush_interrupt::clear();
        hooks::reset();
        let _ = json_tree_bound(text);
        let checks = hooks::total();
        let want = (text.len() / 0x10000) as u64;
        assert!(checks >= want, "{}: {} checks for {} bytes (at least {})", what, checks, text.len(), want);
        // (and not one a byte)
        assert!(checks <= want + 2, "{}: {} checks for {} bytes", what, checks, text.len());
    }
    // a Stop requested at the third check ends the scan there
    for (what, text) in &tokens {
        sagebrush_interrupt::clear();
        hooks::reset();
        hooks::arm_at(3);
        let r = sagebrush_interrupt::catch(|| json_tree_bound(text));
        assert!(r.is_err(), "{}: the scan ran past a requested Stop", what);
        assert_eq!(hooks::total(), 3, "{}", what);
    }
    sagebrush_interrupt::clear();
    hooks::reset();
}
