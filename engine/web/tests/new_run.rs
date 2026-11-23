// Each top-level entry point starts a new run: a Smith progress state a
// trapped call left behind (a trap runs no destructors) is cleared, and the
// run generation moves (engine/web's new_run, the live progress's two trap
// defenses in production), and the binomial factoring route's counts a
// trapped call left are dropped.  The state is left as a trap leaves it: opened,
// its guard forgotten.  Its own test binary (the progress state and the
// generation are the process's), one test.
use sagebrush_arith::smith::progress::testing;
use sagebrush_arith::zmat::ZMat;
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::progress::generation;
use sagebrush_web::*;

type Entry = unsafe extern "C" fn(*const u8, usize) -> *const u8;

// SAFETY: `req` is a live slice, so (ptr, len) is readable for the call, as
// the entry points require; this binary's one test is their only caller.
#[allow(unsafe_code)]
fn call(f: Entry, req: &[u8]) {
    unsafe {
        f(req.as_ptr(), req.len());
    }
}

#[test]
fn every_entry_point_starts_a_new_run() {
    let a = ZMat::from_rows(vec![vec![BigInt::from(2), BigInt::from(1)], vec![BigInt::from(1), BigInt::from(3)]]);
    testing::set_threshold(Some(1));
    let entries: [(&str, Entry, &[u8]); 4] = [
        ("sb_call", sb_call, br#"{"fn":"progress_tables"}"#),
        ("sb_sym_call", sb_sym_call, b"nop"),
        ("sb_mp_call", sb_mp_call, b""),
        ("sb_bin_call", sb_bin_call, b""),
    ];
    for (name, f, req) in entries {
        assert!(testing::open_and_leak(&a), "{name}: a state left behind");
        assert!(testing::state_set());
        // (and the binomial factoring route's counts, left as a trap leaves them)
        sagebrush_poly::binomial_testing::leave(1000);
        let g = generation();
        call(f, req);
        assert!(!testing::state_set(), "{name}: the stale state survived the call");
        assert_eq!(sagebrush_poly::binomial_testing::pending(), 0, "{name}: the binomial route's stale counts survived the call");
        assert!(generation() > g, "{name}: the run generation did not move");
    }
    testing::set_threshold(None);
}
