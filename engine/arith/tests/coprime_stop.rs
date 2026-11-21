//! How long a Stop can go unnoticed while a decoder checks gcd = 1 on
//! large integers (there is no size cap: the check is metered and polls
//! Stop): the longest wall time between two Stop checks, and between two
//! polls of the WebAssembly host as the interrupt crate's test hooks
//! simulate them, for a pair of 24576-limb integers (Lehmer windows) and a
//! 32768-limb integer against one of half its size (a Knuth-D remainder of
//! 16385 quotient limbs first), all above the former 16384-limb cap; and a
//! Stop requested in the middle of a check ends the decode.  One test: the
//! hooks are global.

use dashu_int::UBig;
use sagebrush_arith::cost::Cost;
use sagebrush_arith::wire_decode::{decode_qv, Admit};
use sagebrush_wire::WireError;
use sagebrush_interrupt::hooks;
use sagebrush_wire::{qv1, Arg};

fn rnd(words: usize, seed: &mut u64) -> UBig {
    let v: Vec<u64> = (0..words)
        .map(|_| {
            *seed ^= *seed << 13;
            *seed ^= *seed >> 7;
            *seed ^= *seed << 17;
            *seed
        })
        .collect();
    UBig::from_words(&v) | (UBig::ONE << (64 * words - 1))
}

struct Open;

impl Admit for Open {
    fn admit(&mut self, _bytes: u64, _cost: Cost) -> Result<(), WireError> {
        Ok(())
    }
}

fn qv_bytes(n: &UBig, d: &UBig) -> Vec<u8> {
    let mut b = b"QV_1".to_vec();
    for x in [n, d] {
        b.extend_from_slice(b"ZV_1");
        b.extend_from_slice(&1u64.to_le_bytes());
        let w = x.as_words();
        b.extend_from_slice(&((w.len() as u32) << 1).to_le_bytes());
        for l in w {
            b.extend_from_slice(&l.to_le_bytes());
        }
    }
    b
}

/// A coprime pair of a and b limbs.
fn pair(a: usize, b: usize, seed: &mut u64) -> Vec<u8> {
    loop {
        let (x, y) = (rnd(a, seed), rnd(b, seed));
        if dashu_int::ops::Gcd::gcd(&x, &y) == UBig::ONE {
            return qv_bytes(&x, &y);
        }
    }
}

#[test]
fn gcd_checks_above_the_old_cap_poll_stop() {
    let mut seed = 0x1234_5678_9abc_def1u64;
    for (what, a, b) in [("equal sizes", 24576, 24576), ("half size", 32768, 16384)] {
        let p = pair(a, b, &mut seed);
        let q = qv1(Arg { bytes: &p, offset: 0 }).unwrap();
        hooks::reset();
        hooks::trace();
        sagebrush_interrupt::check_coarse();
        let t = std::time::Instant::now();
        assert!(decode_qv(&q, &mut Open).is_ok());
        let secs = t.elapsed().as_secs_f64();
        sagebrush_interrupt::check_coarse();
        let (gap, poll, total) = (hooks::max_gap_ns(), hooks::max_poll_gap_ns(), hooks::total());
        hooks::reset();
        eprintln!("{} ({} and {} limbs): {:.2} s; {} checks; longest gap between checks {:.2} ms, between host polls {:.2} ms", what, a, b, secs, total, gap as f64 / 1e6, poll as f64 / 1e6);
        assert!(total > 2, "no check inside the gcd");
        assert!(gap <= 250_000_000, "{:.2} ms between two Stop checks, past the 250 ms Stop bound", gap as f64 / 1e6);
        assert!(poll <= 250_000_000, "{:.2} ms between two host polls, past the 250 ms Stop bound", poll as f64 / 1e6);

        // Stop in the middle: the decode unwinds, and nothing is returned
        hooks::reset();
        hooks::arm_after((total / 2).max(1));
        let r = sagebrush_interrupt::catch(|| decode_qv(&q, &mut Open));
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "{}: the decode finished past a Stop", what);
    }
}
