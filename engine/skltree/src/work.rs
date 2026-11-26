//! Stop polls that follow the work done, not the calls made (design note
//! sklearn-trees r3 §6, LIMITS' L3).
//!
//! Every loop whose trip count grows with the data calls [`tick`] with the
//! elements it has just handled; one shared counter polls Stop
//! (`sagebrush_interrupt::check_coarse`, which in WebAssembly asks the host
//! at every call) each time the count crosses a multiple of [`STRIDE`].  A
//! bulk operation passes its element count, so a chunk of up to STRIDE
//! elements is followed by at least one poll, and a long run of small ticks
//! polls every STRIDE elements: the stretch between two polls is at most
//! STRIDE elements of work plus one bounded constant, whatever n, f or the
//! value stride are.
//!
//! The polls touch no floating-point value, so they can't change a bit.

use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

/// The elements of work between two polls of Stop.
pub const STRIDE: u64 = 4096;

// (an atomic for a static without unsafe: the module is single-threaded, so
// these are plain loads and stores)
static DONE: AtomicU64 = AtomicU64::new(0);

/// Count `k` elements of work just done; poll Stop if the count crossed a
/// multiple of [`STRIDE`], or if `k` alone is a whole stride (an interrupt
/// then unwinds, or in WebAssembly traps).
#[inline]
pub fn tick(k: u64) {
    let before = DONE.load(Relaxed);
    let after = before.wrapping_add(k);
    DONE.store(after, Relaxed);
    if k >= STRIDE || after / STRIDE != before / STRIDE {
        sagebrush_interrupt::check_coarse();
    }
}

/// Visit `0..n` in chunks of at most [`STRIDE`] elements, ticking after each
/// chunk with its length: the shape of every bulk copy and scan.
pub fn chunks<E>(n: usize, mut f: impl FnMut(usize, usize) -> Result<(), E>) -> Result<(), E> {
    let mut lo = 0;
    while lo < n {
        let hi = n.min(lo + STRIDE as usize);
        f(lo, hi)?;
        tick((hi - lo) as u64);
        lo = hi;
    }
    Ok(())
}

// (the interrupt hooks are process-wide: the tests that read them run one at a time)
#[cfg(test)]
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[cfg(test)]
pub(crate) fn tests_serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn polls() -> u64 {
        sagebrush_interrupt::hooks::total()
    }

    #[test]
    fn every_chunk_polls_and_small_ticks_poll_every_stride() {
        let _g = tests_serial();
        sagebrush_interrupt::hooks::reset();
        let p0 = polls();
        // 10 full chunks and a partial one: at least one poll after each full chunk
        chunks::<()>(10 * STRIDE as usize + 7, |_, _| Ok(())).unwrap();
        assert!(polls() - p0 >= 10);
        // 3 * STRIDE single-element ticks: 3 polls (a crossing each STRIDE), never one per call
        let p1 = polls();
        for _ in 0..3 * STRIDE {
            tick(1);
        }
        assert_eq!(polls() - p1, 3);
    }

    #[test]
    fn a_requested_stop_interrupts_a_chunked_scan() {
        let _g = tests_serial();
        sagebrush_interrupt::hooks::reset();
        sagebrush_interrupt::hooks::arm_after(3);
        let mut seen = 0usize;
        let r = sagebrush_interrupt::catch(|| {
            chunks::<()>(100 * STRIDE as usize, |lo, hi| {
                seen += hi - lo;
                Ok(())
            })
        });
        sagebrush_interrupt::clear();
        sagebrush_interrupt::hooks::reset();
        assert!(r.is_err());
        assert!(seen <= 3 * STRIDE as usize, "{seen} elements before the Stop");
    }
}
