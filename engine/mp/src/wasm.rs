//! The core's WebAssembly exports (src/abi.rs is the interface; the runtime's
//! binding, src/runtime/mpcore.ts, is its one caller).  Single-threaded: the
//! session's state is abi's thread-local core.  The heap and its page bound
//! are engine/wasmheap's: the host sets the bound with mp_begin before the
//! session's first call (§4.5: every allocation charged and bounded).
//!
//! An operand of the fused calls (mp_bin, mp_un) is a handle h >= 0, or
//! inline (h < 0) as sign, man, exp, bc, each an exact f64.  Their outcome:
//! 0, the result inline in res[0..4]; 1, the result kept as a handle, in
//! res[0]; < 0, a failure (abi::code).

use crate::abi;

/// A binary mpf operation on two operands, each inline (its limb count 0)
/// or packed: a's limbs first in the IO buffer, then b's.  The outcome: 0,
/// the result inline in res[0..4]; 1, by limbs (abi::Core::out); < 0, a
/// failure (abi::code).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn mp_bin(op: i32, prec: f64, rnd: i32, asign: u32, aman: f64, aexp: f64, abc: f64, an: u32, bsign: u32, bman: f64, bexp: f64, bbc: f64, bn: u32) -> i32 {
    sagebrush_wasmheap::clear_refusal();
    abi::with(|c| {
        // (two inline operands: the kernel fast path, no allocation, when it applies)
        if an == 0 && bn == 0 {
            if let Some(r) = c.kernel(op, prec, rnd, asign, aman, aexp, abc, bsign, bman, bexp, bbc) {
                return r;
            }
        }
        let (an, bn) = (an as usize, bn as usize);
        let e = c.operand(0, asign, aman, aexp, abc, 0, an);
        if e < 0 {
            return e;
        }
        let e = c.operand(1, bsign, bman, bexp, bbc, an, bn);
        if e < 0 {
            return e;
        }
        match c.run(op, prec, rnd) {
            n if n < 0 => n,
            _ => c.out(0),
        }
    })
}

/// Register r := an mpf of exact f64 fields.
#[no_mangle]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn mp_set_f(r: u32, sign: u32, man: f64, exp: f64, bc: f64) -> i32 {
    abi::with(|c| c.set_f(r as usize, sign, man, exp, bc))
}

/// Register r := an mpf from the IO buffer (abi::Core::set_fx).
#[no_mangle]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn mp_set_fx(r: u32, sign: u32, nman: u32, exp: f64, bc: f64, nexp: u32, expneg: u32) -> i32 {
    abi::with(|c| c.set_fx(r as usize, sign, nman as usize, exp, bc, nexp as usize, expneg != 0))
}

/// Register r := an int that is an exact f64.
#[no_mangle]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn mp_set_i(r: u32, v: f64) -> i32 {
    abi::with(|c| c.set_i(r as usize, v))
}

/// Register r := an int of n limbs from the IO buffer.
#[no_mangle]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn mp_set_ix(r: u32, neg: u32, n: u32) -> i32 {
    abi::with(|c| c.set_ix(r as usize, neg != 0, n as usize))
}

/// Register r := nothing (an optional argument not given).
#[no_mangle]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn mp_set_none(r: u32) {
    abi::with(|c| c.set_none(r as usize))
}

/// Run operation op on the registers: the count of results, or a failure.
#[no_mangle]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn mp_run(op: i32, prec: f64, rnd: i32) -> i32 {
    sagebrush_wasmheap::clear_refusal();
    abi::with(|c| c.run(op, prec, rnd))
}

/// Write out result k (abi::Core::out).
#[no_mangle]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn mp_out(k: u32) -> i32 {
    abi::with(|c| c.out(k as usize))
}

/// The session's end: every handle, cache and memo released.
#[no_mangle]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn mp_reset() {
    abi::with(|c| c.reset())
}

/// The largest number, in limbs, a call may make (the session's limit).
#[no_mangle]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn mp_set_max_limbs(n: u32) {
    crate::nat::set_max_limbs(n as usize)
}

/// The IO buffer with room for n limbs: its address, or 0 (refused).  It
/// moves when it grows: the host re-reads it after every call that may grow
/// it (this one, mp_out).
#[no_mangle]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation (the buffer's address only).
#[allow(unsafe_code)]
pub extern "C" fn mp_io(n: u32) -> usize {
    abi::with(|c| c.io_reserve(n as usize).map_or(0, |v| v.as_ptr() as usize))
}

/// The scalars out: 8 f64s, at a fixed address.
#[no_mangle]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation (the array's address only).
#[allow(unsafe_code)]
pub extern "C" fn mp_res() -> usize {
    abi::with(|c| c.res.as_ptr() as usize)
}

/// The heap's bound: from now on the memory may grow by at most `pages`.
#[no_mangle]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn mp_begin(pages: u32) {
    sagebrush_wasmheap::begin(pages)
}

/// The last growth the bound refused (wasmheap::Refusal: three u32s).
#[no_mangle]
// SAFETY: an export of the core's wasm ABI (no_mangle; the mp_ prefix keeps the symbol
// unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn mp_last_refusal() -> *const sagebrush_wasmheap::Refusal {
    sagebrush_wasmheap::last_refusal()
}
