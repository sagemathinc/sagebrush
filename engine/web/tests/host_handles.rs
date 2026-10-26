// The host participants' exports (no-cliffs C r15 section 3.1) and the
// retired-bytes export (C r14 section 2, r15 section 4), through the C ABI
// as the WebAssembly host calls them.  Its own test binary (the ledger's
// state is process-wide), one test (no parallel interleaving).
use sagebrush_web::*;

fn reply() -> String {
    unsafe { String::from_utf8_lossy(std::slice::from_raw_parts(sb_reply_ptr(), sb_reply_len())).into_owned() }
}

fn reserve(what: &str, bytes: f64) -> i32 {
    unsafe { sb_reserve(what.as_ptr(), what.len(), bytes) }
}

#[test]
fn host_handles_and_retired_bytes_through_the_abi() {
    // a total with 1 MiB of allowance: E = 4 MiB / 4 (the native ledger
    // without a measure checks the residents against it)
    sb_set_memory_total((4u64 << 20) as f64, 0, 0);
    let before = sb_outstanding_bytes();

    // reserve, grow, release
    let h = reserve("host transient", 1000.0);
    assert!(h > 0, "{}", reply());
    assert_eq!(sb_outstanding_bytes(), before + 1000.0);
    assert_eq!(sb_grow(h, 24.0), 0);
    assert_eq!(sb_outstanding_bytes(), before + 1024.0);
    assert_eq!(sb_release(h), 0);
    assert_eq!(sb_outstanding_bytes(), before);

    // a released handle is unknown; its slot is reused
    assert_eq!(sb_release(h), -1);
    assert_eq!(sb_grow(h, 1.0), -1);
    assert!(reply().contains("no host handle"));
    let h2 = reserve("again", 8.0);
    assert_eq!(h2, h, "the free slot is reused");
    assert_eq!(sb_release(h2), 0);

    // invalid handles and byte counts
    for bad in [0, -1, 1 << 20] {
        assert_eq!(sb_release(bad), -1);
    }
    for b in [f64::NAN, -1.0, 0.5, 1e17] {
        assert_eq!(reserve("bad", b), -1);
        assert!(reply().contains("not a byte count"));
    }

    // a refusal: the reply holds the typed memory error, with `retired`
    assert_eq!(reserve("far too much", (1u64 << 40) as f64), 0);
    let r = reply();
    assert!(r.contains("\"memory\"") && r.contains("\"retired\":0") && r.contains("far too much"), "{}", r);

    // a refused grow leaves the handle as it was
    let h3 = reserve("grower", 64.0);
    assert!(h3 > 0);
    assert_eq!(sb_grow(h3, (1u64 << 40) as f64), 1);
    assert!(reply().contains("host result"));
    assert_eq!(sb_outstanding_bytes(), before + 64.0);
    assert_eq!(sb_release(h3), 0);

    // retired bytes: valid figures set, invalid ones are -1 (and a sticky
    // fault, which the ledger's own tests check)
    assert_eq!(sb_set_retired_bytes(65536.0 * 3.0, 0), 0);
    assert_eq!(sagebrush_ledger::retired_bytes(), 3 * 65536);
    for (b, f) in [(f64::NAN, 0), (-65536.0, 0), (1000.0, 0), (65536.0, 2), (9007199254740992.0, 0)] {
        assert_eq!(sb_set_retired_bytes(b, f), -1, "{} {}", b, f);
    }
}
