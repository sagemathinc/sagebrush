//! `mp`: the multiprecision core (engine/mp) natively, with the entry points
//! of its WebAssembly module (engine/mp/src/wasm.rs), so the runtime's
//! binding (src/runtime/mpcore.ts) runs on either unchanged: the same
//! registers, operations and results (engine/mp/src/abi.rs).
//!
//! The binding reads the core's scalars and IO limbs through `memory.buffer`
//! at the offsets mp_res and mp_io return.  Here that buffer is one arena,
//! made once and never freed or moved (so no view of it can dangle): the
//! scalars at offset 0, the IO limbs from offset 64.  Limbs the binding
//! writes are copied into the core before the call that reads them, and a
//! result's limbs out of it after the call that makes them.

use napi::bindgen_prelude::*;
use napi::{Env, JsArrayBuffer};
use napi_derive::napi;
use sagebrush_mp::abi;
use std::sync::OnceLock;

/// The arena's IO room, in limbs: two operands at the limb limit.
const IO_LIMBS: usize = 2 << 22;
const IO_AT: usize = 8;

struct Arena(*mut u64);
// SAFETY: the arena is only touched on the thread that calls the addon (Node's main thread), between calls.
#[allow(unsafe_code)]
unsafe impl Send for Arena {}
// SAFETY: as above.
#[allow(unsafe_code)]
unsafe impl Sync for Arena {}

static ARENA: OnceLock<Arena> = OnceLock::new();

/// The arena: 8 scalars and IO_LIMBS limbs, zeroed (committed by the OS as touched), for the process's life.
fn arena() -> &'static mut [u64] {
    let a = ARENA.get_or_init(|| Arena(Box::leak(vec![0u64; IO_AT + IO_LIMBS].into_boxed_slice()).as_mut_ptr()));
    // SAFETY: the allocation above, IO_AT + IO_LIMBS u64s, never freed; used by one thread at a time (Arena).
    #[allow(unsafe_code)]
    unsafe {
        std::slice::from_raw_parts_mut(a.0, IO_AT + IO_LIMBS)
    }
}

/// The binding's limbs 0..n into the core's IO buffer.
fn limbs_in(c: &mut abi::Core, n: usize) -> bool {
    let a = arena();
    match c.io_reserve(n) {
        Some(io) if n <= IO_LIMBS => {
            io[..n].copy_from_slice(&a[IO_AT..IO_AT + n]);
            true
        }
        _ => false,
    }
}

/// The scalars, and a result's limbs (out's kind: 1, an mpf by limbs, its
/// mantissa's then its exponent's; 3, an int), out to the arena.
fn sync_out(c: &abi::Core, kind: i32) {
    let a = arena();
    for (k, r) in c.res.iter().enumerate() {
        a[k] = r.to_bits();
    }
    let n = match kind {
        1 => (c.res[1] + c.res[4]) as usize,
        3 => c.res[1] as usize,
        _ => 0,
    };
    let n = n.min(c.io.len()).min(IO_LIMBS);
    a[IO_AT..IO_AT + n].copy_from_slice(&c.io[..n]);
}

/// memory.buffer's stand-in: the arena, as an ArrayBuffer over it.
#[napi(namespace = "mp", js_name = "mp_buffer")]
pub fn mp_buffer(env: Env) -> Result<JsArrayBuffer> {
    let a = arena();
    // SAFETY: the arena outlives every ArrayBuffer over it (it is never freed), and the finalizer frees nothing.
    #[allow(unsafe_code)]
    let b = unsafe { env.create_arraybuffer_with_borrowed_data(a.as_mut_ptr() as *mut u8, a.len() * 8, (), |_, _| {})? };
    Ok(b.into_raw())
}

#[napi(namespace = "mp", js_name = "mp_res")]
pub fn mp_res() -> u32 {
    0
}

#[napi(namespace = "mp", js_name = "mp_io")]
pub fn mp_io(n: u32) -> u32 {
    if n as usize > IO_LIMBS {
        return 0;
    }
    (IO_AT * 8) as u32
}

#[napi(namespace = "mp", js_name = "mp_set_f")]
pub fn mp_set_f(r: u32, sign: u32, man: f64, exp: f64, bc: f64) -> i32 {
    abi::with(|c| c.set_f(r as usize, sign, man, exp, bc))
}

#[napi(namespace = "mp", js_name = "mp_set_fx")]
pub fn mp_set_fx(r: u32, sign: u32, nman: u32, exp: f64, bc: f64, nexp: u32, expneg: u32) -> i32 {
    abi::with(|c| {
        if !limbs_in(c, (nman + nexp) as usize) {
            return abi::code::BAD_CALL;
        }
        c.set_fx(r as usize, sign, nman as usize, exp, bc, nexp as usize, expneg != 0)
    })
}

#[napi(namespace = "mp", js_name = "mp_set_i")]
pub fn mp_set_i(r: u32, v: f64) -> i32 {
    abi::with(|c| c.set_i(r as usize, v))
}

#[napi(namespace = "mp", js_name = "mp_set_ix")]
pub fn mp_set_ix(r: u32, neg: u32, n: u32) -> i32 {
    abi::with(|c| {
        if !limbs_in(c, n as usize) {
            return abi::code::BAD_CALL;
        }
        c.set_ix(r as usize, neg != 0, n as usize)
    })
}

#[napi(namespace = "mp", js_name = "mp_set_none")]
pub fn mp_set_none(r: u32) {
    abi::with(|c| c.set_none(r as usize))
}

#[napi(namespace = "mp", js_name = "mp_bin")]
#[allow(clippy::too_many_arguments)]
pub fn mp_bin(op: i32, prec: f64, rnd: i32, asign: u32, aman: f64, aexp: f64, abc: f64, an: u32, bsign: u32, bman: f64, bexp: f64, bbc: f64, bn: u32) -> i32 {
    abi::with(|c| {
        if !limbs_in(c, (an + bn) as usize) {
            return abi::code::BAD_CALL;
        }
        let k = c.bin(op, prec, rnd, asign, aman, aexp, abc, an as usize, bsign, bman, bexp, bbc, bn as usize);
        sync_out(c, k);
        k
    })
}

#[napi(namespace = "mp", js_name = "mp_run")]
pub fn mp_run(op: i32, prec: f64, rnd: i32) -> i32 {
    abi::with(|c| {
        let n = c.run(op, prec, rnd);
        sync_out(c, 0);
        n
    })
}

#[napi(namespace = "mp", js_name = "mp_out")]
pub fn mp_out(k: u32) -> i32 {
    abi::with(|c| {
        let kind = c.out(k as usize);
        sync_out(c, kind);
        kind
    })
}

#[napi(namespace = "mp", js_name = "mp_reset")]
pub fn mp_reset() {
    abi::with(|c| c.reset())
}

#[napi(namespace = "mp", js_name = "mp_set_max_limbs")]
pub fn mp_set_max_limbs(n: u32) {
    sagebrush_mp::nat::set_max_limbs(n as usize)
}

/// (the WebAssembly heap's page bound: natively, the process's memory is the bound)
#[napi(namespace = "mp", js_name = "mp_begin")]
pub fn mp_begin(_pages: u32) {}

/// (no WebAssembly growth to refuse natively: the arena's scalar 0, which the binding reads only after a wasm trap)
#[napi(namespace = "mp", js_name = "mp_last_refusal")]
pub fn mp_last_refusal() -> u32 {
    0
}
