//! How long a Stop can go unnoticed while an op builds its own transform
//! table (LocalTables::with_root, the series ops' path) at the largest size
//! they admit: every pass of Table::new polls.  Its own test binary: the
//! interrupt hooks are global.

use sagebrush_bigint::nmod::Modulus;
use sagebrush_bigint::ntt::{LocalTables, PRIMES};
use sagebrush_interrupt::hooks;

#[test]
fn local_table_poll_gap() {
    let (p, g) = PRIMES[0];
    let max_len = (1 << 18) - 1;
    hooks::reset();
    hooks::trace();
    let lt = LocalTables::with_root(&Modulus::new(p), g, max_len);
    let polls = hooks::total();
    let gap = hooks::max_gap_ns();
    hooks::reset();
    assert_eq!(lt.bytes(), 32 << 18);
    // the upper-half fill (2^17 / 2^12), the lower levels (more than 2^16 /
    // 2^12) and the two Shoup maps (2 x 2^18 / 2^12): at least 176
    assert!(polls >= 176, "{} polls building a table of 2^18 points", polls);
    eprintln!("table of 2^18 points: {} polls, longest gap {:.3} ms", polls, gap as f64 / 1e6);
    // at most 2^12 entries of one pass between two polls: far below the
    // 250 ms Stop bound
    assert!(gap <= 20_000_000, "{:.2} ms between two polls building a table", gap as f64 / 1e6);
}
