//! `mp`: the multiprecision core (engine/mp) natively, with the entry points
//! of its WebAssembly module (engine/mp/src/wasm.rs), so the runtime's
//! binding (src/runtime/mpcore.ts) runs on either unchanged: the same
//! registers, operations and results (engine/mp/src/abi.rs).
//!
//! The binding reads the core's scalars and IO limbs through `memory.buffer`
//! at the offsets mp_res and mp_io return.  Here that buffer is an ordinary
//! JavaScript ArrayBuffer owned by the calling environment (its instance
//! data holds a reference): the scalars at byte 0, the IO limbs from byte 64.
//! When the IO needs more room, a larger buffer replaces it, the old one's
//! bytes copied and the old one detached, as a WebAssembly memory's growth
//! detaches its old buffer.  Limbs the binding writes are copied into the
//! core before the call that reads them, and a result's out of it after the
//! call that makes it.  No memory is shared outside the environment, and no
//! code here is unsafe.
//!
//! The core's session (abi::Core, its caches) is its thread's; an
//! environment is bound to the thread it was first used on, and a second
//! environment on that thread is refused, so each environment (the main
//! thread, each worker) has its own session.

use napi::bindgen_prelude::*;
use napi::{Env, JsArrayBuffer, Ref};
use napi_derive::napi;
use sagebrush_mp::abi;
use std::cell::Cell;
use std::thread::ThreadId;

const IO_AT: usize = 64;

struct Mp {
    thread: ThreadId,
    id: u64,
    buf: Ref<()>,
    len: usize,
}

thread_local! {
    /// The environment this thread's core serves (its Mp's id), 0 before the first.
    static OWNER: Cell<u64> = const { Cell::new(0) };
}

static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn err(m: &str) -> Error {
    Error::from_reason(m.to_string())
}

/// This environment's state, made on first use, checked to be this thread's.
fn state(env: &Env) -> Result<&'static mut Mp> {
    if env.get_instance_data::<Mp>()?.is_none() {
        if OWNER.with(|o| o.get()) != 0 {
            return Err(err("the multiprecision core already serves another environment on this thread"));
        }
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let len = IO_AT + 8 * 1024;
        let b = env.create_arraybuffer(len)?.into_raw();
        let buf = env.create_reference(b)?;
        // (installed first; the thread is claimed only once the state is in place, so a failure on the way
        // leaves the thread unclaimed and the next call tries again)
        env.set_instance_data(Mp { thread: std::thread::current().id(), id, buf, len }, (), |mut c| {
            let _ = c.value.buf.unref(c.env);
            OWNER.with(|o| {
                if o.get() == c.value.id {
                    o.set(0)
                }
            });
        })?;
        OWNER.with(|o| o.set(id));
    }
    let mp = env.get_instance_data::<Mp>()?.ok_or_else(|| err("the multiprecision core has no state"))?;
    if mp.thread != std::thread::current().id() || OWNER.with(|o| o.get()) != mp.id {
        return Err(err("the multiprecision core is bound to another thread's environment"));
    }
    Ok(mp)
}

/// The buffer's bytes, checked to be the buffer this state made, still attached and of its length.  A
/// buffer detached or replaced behind the core (a transfer to a worker, say) is refused, and the state is
/// given a fresh buffer of the same length, so the next call starts clean: the binding re-reads
/// memory.buffer before each copy.
fn bytes(env: &Env, mp: &mut Mp) -> Result<napi::JsArrayBufferValue> {
    let b = env.get_reference_value::<JsArrayBuffer>(&mp.buf)?.into_value()?;
    if b.len() == mp.len {
        return Ok(b);
    }
    let fresh = env.create_arraybuffer(mp.len)?.into_raw();
    let r = env.create_reference(fresh)?;
    let mut old = std::mem::replace(&mut mp.buf, r);
    old.unref(*env)?;
    Err(err("the multiprecision core's buffer was detached or resized outside it"))
}

/// The binding's limbs 0..n into the core's IO buffer.
fn limbs_in(env: &Env, c: &mut abi::Core, n: usize) -> Result<bool> {
    let mp = state(env)?;
    if IO_AT + 8 * n > mp.len {
        return Ok(false);
    }
    let b = bytes(env, mp)?;
    let Some(io) = c.io_reserve(n) else { return Ok(false) };
    for (k, l) in io[..n].iter_mut().enumerate() {
        let at = IO_AT + 8 * k;
        *l = u64::from_le_bytes(b[at..at + 8].try_into().unwrap_or([0; 8]));
    }
    Ok(true)
}

/// The scalars, and a result's limbs (out's kind: 1, an mpf by limbs, its
/// mantissa's then its exponent's; 3, an int), out to the buffer.
fn sync_out(env: &Env, c: &abi::Core, kind: i32) -> Result<()> {
    let n = match kind {
        1 => (c.res[1] + c.res[4]) as usize,
        3 => c.res[1] as usize,
        5 => c.res[1] as usize,
        _ => 0,
    }
    .min(c.io.len());
    grow(env, n)?;
    let mp = state(env)?;
    let mut b = bytes(env, mp)?;
    for (k, r) in c.res.iter().enumerate() {
        b[8 * k..8 * k + 8].copy_from_slice(&r.to_le_bytes());
    }
    for (k, l) in c.io[..n].iter().enumerate() {
        let at = IO_AT + 8 * k;
        b[at..at + 8].copy_from_slice(&l.to_le_bytes());
    }
    Ok(())
}

/// Room for n IO limbs: a larger buffer, the old bytes copied and the old one detached, when needed.
fn grow(env: &Env, n: usize) -> Result<()> {
    let mp = state(env)?;
    let need = IO_AT + 8 * n;
    if need <= mp.len {
        return Ok(());
    }
    let len = need.max(2 * mp.len);
    // (made and filled first, and only then put in place: a failure on the way leaves the old buffer in use)
    let mut nb = env.create_arraybuffer(len)?;
    {
        let ob = bytes(env, mp)?;
        nb[..mp.len].copy_from_slice(&ob[..mp.len]);
    }
    let r = env.create_reference(nb.into_raw())?;
    let mut old = std::mem::replace(&mut mp.buf, r);
    mp.len = len;
    let ob = env.get_reference_value::<JsArrayBuffer>(&old)?;
    old.unref(*env)?;
    // (the old buffer detached, as a wasm memory's growth detaches it: a stale view reads nothing)
    ob.detach()?;
    Ok(())
}

/// The message of a call Stop ended (the binding's KeyboardInterrupt).
const INTERRUPTED: &str = "the multiprecision core was interrupted (Stop)";

/// A call on this environment's session.  Stop (mp_interrupt, from another thread) reaches the core's loops
/// through engine/interrupt; the call then ends with INTERRUPTED, the request consumed, the core's borrow
/// dropped by the unwind (a cache taken out mid-call is lost, never left half made).
fn with<R: Default>(env: &Env, f: impl FnOnce(&mut abi::Core) -> Result<R>) -> Result<R> {
    state(env)?;
    let mut r = Ok(R::default());
    match sagebrush_interrupt::catch(|| abi::with(|c| r = f(c))) {
        Ok(()) => r,
        Err(_) => {
            sagebrush_interrupt::clear();
            Err(err(INTERRUPTED))
        }
    }
}

/// Stop: ask the call running on any thread (a worker's) to end at its next check.  The host calls it from
/// a thread that isn't busy in the core (its main thread) when the user presses Ctrl-C.
#[napi(namespace = "mp", js_name = "mp_interrupt")]
pub fn mp_interrupt() {
    sagebrush_interrupt::request();
}

/// memory.buffer's stand-in: this environment's current buffer.
#[napi(namespace = "mp", js_name = "mp_buffer")]
pub fn mp_buffer(env: Env) -> Result<JsArrayBuffer> {
    let mp = state(&env)?;
    env.get_reference_value::<JsArrayBuffer>(&mp.buf)
}

#[napi(namespace = "mp", js_name = "mp_res")]
pub fn mp_res() -> u32 {
    0
}

/// Room for n limbs: the IO's byte offset, or 0 (refused: past the limb limit).
#[napi(namespace = "mp", js_name = "mp_io")]
pub fn mp_io(env: Env, n: u32) -> Result<u32> {
    if n as usize > sagebrush_mp::nat::max_limbs().saturating_mul(2) {
        return Ok(0);
    }
    grow(&env, n as usize)?;
    Ok(IO_AT as u32)
}

#[napi(namespace = "mp", js_name = "mp_set_f")]
pub fn mp_set_f(env: Env, r: u32, sign: u32, man: f64, exp: f64, bc: f64) -> Result<i32> {
    with(&env, |c| Ok(c.set_f(r as usize, sign, man, exp, bc)))
}

#[napi(namespace = "mp", js_name = "mp_set_fx")]
pub fn mp_set_fx(env: Env, r: u32, sign: u32, nman: u32, exp: f64, bc: f64, nexp: u32, expneg: u32) -> Result<i32> {
    with(&env, |c| {
        if !limbs_in(&env, c, (nman + nexp) as usize)? {
            return Ok(abi::code::BAD_CALL);
        }
        Ok(c.set_fx(r as usize, sign, nman as usize, exp, bc, nexp as usize, expneg != 0))
    })
}

#[napi(namespace = "mp", js_name = "mp_set_m")]
pub fn mp_set_m(env: Env, r: u32, count: u32, nwords: u32) -> Result<i32> {
    with(&env, |c| {
        if !limbs_in(&env, c, nwords as usize)? {
            return Ok(abi::code::BAD_CALL);
        }
        Ok(c.set_m(r as usize, count as usize, nwords as usize))
    })
}

#[napi(namespace = "mp", js_name = "mp_set_i")]
pub fn mp_set_i(env: Env, r: u32, v: f64) -> Result<i32> {
    with(&env, |c| Ok(c.set_i(r as usize, v)))
}

#[napi(namespace = "mp", js_name = "mp_set_ix")]
pub fn mp_set_ix(env: Env, r: u32, neg: u32, n: u32) -> Result<i32> {
    with(&env, |c| {
        if !limbs_in(&env, c, n as usize)? {
            return Ok(abi::code::BAD_CALL);
        }
        Ok(c.set_ix(r as usize, neg != 0, n as usize))
    })
}

#[napi(namespace = "mp", js_name = "mp_set_none")]
pub fn mp_set_none(env: Env, r: u32) -> Result<()> {
    with(&env, |c| {
        c.set_none(r as usize);
        Ok(())
    })
}

#[napi(namespace = "mp", js_name = "mp_bin")]
#[allow(clippy::too_many_arguments)]
pub fn mp_bin(env: Env, op: i32, prec: f64, rnd: i32, asign: u32, aman: f64, aexp: f64, abc: f64, an: u32, bsign: u32, bman: f64, bexp: f64, bbc: f64, bn: u32) -> Result<i32> {
    with(&env, |c| {
        if !limbs_in(&env, c, (an + bn) as usize)? {
            return Ok(abi::code::BAD_CALL);
        }
        let k = c.bin(op, prec, rnd, asign, aman, aexp, abc, an as usize, bsign, bman, bexp, bbc, bn as usize);
        sync_out(&env, c, k)?;
        Ok(k)
    })
}

#[napi(namespace = "mp", js_name = "mp_run")]
pub fn mp_run(env: Env, op: i32, prec: f64, rnd: i32) -> Result<i32> {
    with(&env, |c| {
        let n = c.run(op, prec, rnd);
        sync_out(&env, c, 0)?;
        Ok(n)
    })
}

#[napi(namespace = "mp", js_name = "mp_out")]
pub fn mp_out(env: Env, k: u32) -> Result<i32> {
    with(&env, |c| {
        let kind = c.out(k as usize);
        sync_out(&env, c, kind)?;
        Ok(kind)
    })
}

#[napi(namespace = "mp", js_name = "mp_reset")]
pub fn mp_reset(env: Env) -> Result<()> {
    with(&env, |c| {
        c.reset();
        Ok(())
    })
}

#[napi(namespace = "mp", js_name = "mp_set_max_limbs")]
pub fn mp_set_max_limbs(env: Env, n: u32) -> Result<()> {
    state(&env)?;
    sagebrush_mp::nat::set_max_limbs(n as usize);
    Ok(())
}

/// (the WebAssembly heap's page bound: natively, the process's memory is the bound)
#[napi(namespace = "mp", js_name = "mp_begin")]
pub fn mp_begin(_pages: u32) {}

/// (no WebAssembly growth to refuse natively; the binding reads it only after a wasm trap)
#[napi(namespace = "mp", js_name = "mp_last_refusal")]
pub fn mp_last_refusal() -> u32 {
    0
}
