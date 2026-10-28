//! `Context::enter` skips the writes when the context is already installed
//! (C-2c-i hot path, scope r3 section 2), and its guard keeps the old
//! restoration: whatever happened in between, and in whatever order guards
//! drop, a dropped guard leaves the thread at the context it found
//! (astra2's HP-CORR-2).  Context is thread-local, so each test has its own.

use sagebrush_ledger::Context;

const A: Context = Context { chain: 0, exclusive: false };
const B: Context = Context { chain: 7, exclusive: false };
const C: Context = Context { chain: 7, exclusive: true };

#[test]
fn an_equal_enter_still_restores_when_dropped_out_of_order() {
    // astra2's witness: A active; g = A.enter() (equal); h = B.enter();
    // drop(g) while h lives: the thread is back at A, as before the change
    assert_eq!(Context::current(), A);
    let g = A.enter();
    let h = B.enter();
    assert_eq!(Context::current(), B);
    drop(g);
    assert_eq!(Context::current(), A, "the equal guard restored what it found");
    drop(h);
    assert_eq!(Context::current(), A);
}

#[test]
fn equal_then_different_then_equal_nests_and_unwinds_exactly() {
    let outer = B.enter();
    assert_eq!(Context::current(), B);
    {
        let same = B.enter();
        {
            let other = C.enter();
            assert_eq!(Context::current(), C);
            {
                let back = B.enter();
                assert_eq!(Context::current(), B);
                drop(back);
            }
            assert_eq!(Context::current(), C);
            drop(other);
        }
        assert_eq!(Context::current(), B);
        drop(same);
    }
    assert_eq!(Context::current(), B);
    drop(outer);
    assert_eq!(Context::current(), A);
}

#[test]
fn a_chain_only_and_an_exclusive_only_difference_both_count() {
    // differs in the chain only
    let g = B.enter();
    assert_eq!(Context::current(), B);
    drop(g);
    assert_eq!(Context::current(), A);
    // differs in the exclusive flag only (the same chain)
    let base = B.enter();
    let g = C.enter();
    assert_eq!(Context::current(), C, "an exclusive-only difference is installed");
    drop(g);
    assert_eq!(Context::current(), B, "and restored");
    drop(base);
    let x = Context { chain: 0, exclusive: true }.enter();
    assert!(Context::current().exclusive);
    drop(x);
    assert_eq!(Context::current(), A);
}

#[test]
fn a_panic_at_any_depth_restores_the_context_found() {
    for depth in 0..3 {
        let base = B.enter();
        let r = std::panic::catch_unwind(|| {
            let _g1 = B.enter(); // equal
            let _g2 = if depth >= 1 { Some(C.enter()) } else { None };
            let _g3 = if depth >= 2 { Some(B.enter()) } else { None };
            panic!("at depth {}", depth);
        });
        assert!(r.is_err());
        assert_eq!(Context::current(), B, "depth {}", depth);
        drop(base);
        assert_eq!(Context::current(), A);
    }
}
