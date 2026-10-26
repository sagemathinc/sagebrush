// The host participants' exports (no-cliffs C r15 section 3.1) and the
// retired-bytes export (C r14 section 2, r15 section 4), through the C ABI
// as the WebAssembly host calls them.  Its own test binary (the ledger's
// state is process-wide), one test (no parallel interleaving).
use sagebrush_web::*;

fn reply() -> String {
    unsafe { String::from_utf8_lossy(std::slice::from_raw_parts(sb_reply_ptr(), sb_reply_len())).into_owned() }
}

fn reserve(what: &str, bytes: f64) -> f64 {
    unsafe { sb_reserve(what.as_ptr(), what.len(), bytes) }
}

/// A handle's slot part (gen * 2^32 + slot + 1).
fn slot(h: f64) -> u64 {
    h as u64 % (1 << 32)
}

#[test]
fn host_handles_and_retired_bytes_through_the_abi() {
    // a total with 1 MiB of allowance: E = 4 MiB / 4 (the native ledger
    // without a measure checks the residents against it)
    sb_set_memory_total((4u64 << 20) as f64, 0, 0);
    let base = sb_outstanding_bytes();
    let res0 = sagebrush_ledger::resident_bytes();

    // the map's first use inside an operation (astra2 CORR-C2B-MAP-OWNER-1):
    // its slots are admitted there but charged as the instance's resident,
    // so the operation ends clean and the map stays charged after it
    let op = sagebrush_ledger::Operation::enter();
    let z = reserve("first use", 0.0);
    assert!(z > 0.0, "{}", reply());
    assert_eq!(sb_release(z), 0);
    op.finish().expect("the map's charge belongs to the instance, not to the operation");
    let map = host_map_bytes();
    assert!(map > 0);
    assert_eq!(sagebrush_ledger::resident_bytes(), res0 + map, "the map stays charged after the operation");
    assert_eq!(sb_outstanding_bytes(), base);

    // reserve, grow, release
    let h = reserve("host transient", 1000.0);
    assert!(h > 0.0, "{}", reply());
    assert_eq!(host_map_bytes(), map);
    let before = base;
    assert_eq!(sb_outstanding_bytes(), before + 1000.0);
    assert_eq!(sb_grow(h, 24.0), 0);
    assert_eq!(sb_outstanding_bytes(), before + 1024.0);
    assert_eq!(sb_release(h), 0);
    assert_eq!(sb_outstanding_bytes(), before);

    // a released handle is unknown
    assert_eq!(sb_release(h), -1);
    assert_eq!(sb_grow(h, 1.0), -1);
    assert!(reply().contains("no host handle"));

    // its slot is reused under a new handle, and the stale one never
    // reaches the new obligation (astra2 CORR-C2B-HANDLE-1)
    let a = reserve("A", 1000.0);
    assert_eq!(sb_release(a), 0);
    let b = reserve("B", 2000.0);
    assert!(b > 0.0, "{}", reply());
    assert_eq!(slot(b), slot(a), "the free slot is reused");
    assert_ne!(b, a, "under a new handle");
    assert_eq!(sb_release(a), -1, "a stale release");
    assert_eq!(sb_outstanding_bytes(), before + 2000.0, "B is unchanged by a stale release");
    assert_eq!(sb_grow(a, 500.0), -1, "a stale grow");
    assert_eq!(sb_outstanding_bytes(), before + 2000.0, "B is unchanged by a stale grow");
    assert_eq!(sb_grow(b, 500.0), 0, "B still grows");
    assert_eq!(sb_outstanding_bytes(), before + 2500.0);
    assert_eq!(sb_release(b), 0, "B still releases");
    assert_eq!(sb_outstanding_bytes(), before);
    assert_eq!(sb_release(b), -1);

    // invalid handles and byte counts
    for bad in [0.0, -1.0, 0.5, f64::NAN, f64::INFINITY, (1u64 << 32) as f64, 1e17, (1u64 << 20) as f64] {
        assert_eq!(sb_release(bad), -1, "{}", bad);
        assert_eq!(sb_grow(bad, 1.0), -1, "{}", bad);
    }
    for b in [f64::NAN, -1.0, 0.5, 1e17] {
        assert_eq!(reserve("bad", b), -1.0);
        assert!(reply().contains("not a byte count"));
    }

    // a refusal: the reply holds the typed memory error, with `retired`
    assert_eq!(reserve("far too much", (1u64 << 40) as f64), 0.0);
    let r = reply();
    assert!(r.contains("\"memory\"") && r.contains("\"retired\":0") && r.contains("far too much"), "{}", r);

    // a refused grow leaves the handle as it was
    let h3 = reserve("grower", 64.0);
    assert!(h3 > 0.0);
    assert_eq!(sb_grow(h3, (1u64 << 40) as f64), 1);
    assert!(reply().contains("host result"));
    assert_eq!(sb_outstanding_bytes(), before + 64.0);
    assert_eq!(sb_release(h3), 0);

    // no generation wraps: a slot reused 2^21 times is retired, the next
    // reservation takes another slot, and every earlier handle stays stale
    let first = reserve("cycle", 0.0);
    let s0 = slot(first);
    let mut last = first;
    loop {
        assert_eq!(sb_release(last), 0);
        let h = reserve("cycle", 0.0);
        assert!(h > 0.0, "{}", reply());
        if slot(h) != s0 {
            assert_eq!(h as u64 >> 32, 0, "a fresh slot starts at generation 0");
            assert_eq!(last as u64 >> 32, (1 << 21) - 1, "the retired slot's last handle had the last generation");
            assert_eq!(sb_release(h), 0);
            break;
        }
        assert_eq!(h as u64 >> 32, (last as u64 >> 32) + 1, "one generation per reuse");
        last = h;
    }
    for stale in [first, last] {
        assert_eq!(sb_release(stale), -1);
        assert_eq!(sb_grow(stale, 1.0), -1);
    }
    assert_eq!(sb_outstanding_bytes(), before);

    // retired bytes: valid figures set, invalid ones are -1 (and a sticky
    // fault, which the ledger's own tests check)
    assert_eq!(sb_set_retired_bytes(65536.0 * 3.0, 0), 0);
    assert_eq!(sagebrush_ledger::retired_bytes(), 3 * 65536);
    for (b, f) in [(f64::NAN, 0), (-65536.0, 0), (1000.0, 0), (65536.0, 2), (9007199254740992.0, 0)] {
        assert_eq!(sb_set_retired_bytes(b, f), -1, "{} {}", b, f);
    }

    // zero-byte handles still cost their slots (daybreak2 LIMIT-C2BI-1):
    // they fill the map until its next growth is refused, a typed memory
    // refusal, with every byte of the map charged; grown inside an
    // operation, the map's charge outlives it (CORR-C2B-MAP-OWNER-1)
    assert_eq!(host_map_bytes(), map, "at most two live handles so far");
    let op = sagebrush_ledger::Operation::enter();
    let mut live = Vec::new();
    let refused = loop {
        let h = reserve("zero", 0.0);
        if h <= 0.0 {
            break h;
        }
        live.push(h);
        assert!(live.len() < 1 << 20, "zero-byte handles were never refused: the map grows outside the ledger");
    };
    assert_eq!(refused, 0.0, "{}", reply());
    let r = reply();
    assert!(r.contains("\"memory\"") && r.contains("host handle map"), "{}", r);
    let full = host_map_bytes();
    assert!(full > map && full >= live.len() as u64 * 16, "{} for {} handles", full, live.len());
    assert_eq!(sagebrush_ledger::resident_bytes(), res0 + full, "every byte of the map is charged");
    assert_eq!(sb_outstanding_bytes(), base, "the refused call holds nothing");
    for h in live.drain(..) {
        assert_eq!(sb_release(h), 0);
    }
    op.finish().expect("the map grown inside the operation is the instance's");
    assert_eq!(sagebrush_ledger::resident_bytes(), res0 + full, "the grown map stays charged after the operation");
    // released, the slots stay (the capacity is held) and are reused
    let h4 = reserve("zero again", 0.0);
    assert!(h4 > 0.0, "{}", reply());
    assert_eq!(host_map_bytes(), full, "a free slot is reused, the map doesn't grow");
    assert_eq!(sb_release(h4), 0);
    assert_eq!(sagebrush_ledger::resident_bytes(), res0 + full);
    assert_eq!(sb_outstanding_bytes(), base);
}
