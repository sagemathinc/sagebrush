//! The engine's dispatcher for the native backend (#7, design N1 r3 + r3.2):
//! the same entry points as the wasm module's exports (engine/web's sb_call,
//! sb_sym_call, sb_mp_call and sb_bin_call), on the same Rust bodies.  N-API
//! passes strings and byte arrays by value, so the wasm alloc/free/reply
//! layer has no counterpart here.
//!
//! Every export runs inside `guarded`: a panic whose payload is
//! `sagebrush_interrupt::Interrupted` becomes the typed "interrupted" error,
//! and the next call works; any other panic is a fault, after which every
//! call in this process is refused (the host retires the process).

use napi::bindgen_prelude::{Buffer, Uint8Array};
use napi::{Env, Error, JsTypedArray, Result, Status, TypedArrayType};
use napi_derive::napi;
use sagebrush_interrupt::node_host;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::SeqCst};
use std::sync::OnceLock;
use std::thread::ThreadId;

static FAULTED: AtomicBool = AtomicBool::new(false);

/// The session that claimed this process: the thread of its first `init`
/// (design N1 r3, S2/H2: one native session per OS process; a second init,
/// from any thread, Worker or N-API environment, is refused, and nothing
/// resets the claim).
static CLAIM: OnceLock<ThreadId> = OnceLock::new();

/// The control buffer's layout version (node_host's four words).
const CONTROL_VERSION: u32 = 1;

/// Calls are taken only from the claiming session's thread, after `init`.
fn owner() -> Result<()> {
    match CLAIM.get() {
        None => Err(coded("not_initialized", "the native engine's session is not initialized (init first)".into())),
        Some(t) if *t != std::thread::current().id() => {
            Err(coded("wrong_thread", "the native engine belongs to another thread of this process".into()))
        }
        Some(_) => Ok(()),
    }
}

/// Claim this process for one session and install its control words: a
/// Uint32Array of exactly four words over the session's SharedArrayBuffer
/// (the host checks that the buffer is shared), with `[VERSION, STOP_UPTO,
/// RUN, reserved]`, VERSION equal to `version` and to this addon's
/// CONTROL_VERSION, and nothing pending against an unstarted run
/// (STOP_UPTO is not after RUN).  The buffer is referenced strongly for the
/// rest of the process.
#[napi]
#[allow(unsafe_code)]
pub fn init(env: Env, control: JsTypedArray, version: u32) -> Result<()> {
    guarded_unclaimed(|| -> Result<()> {
        if version != CONTROL_VERSION {
            return Err(coded("bad_control", format!("control version {} (this addon speaks {})", version, CONTROL_VERSION)));
        }
        let reference = env.create_reference(&control)?;
        let mut v = control.into_value()?;
        if v.typedarray_type != TypedArrayType::Uint32 || v.length != node_host::WORDS || v.byte_offset % 4 != 0 {
            return Err(coded("bad_control", format!("a Uint32Array of {} words is required", node_host::WORDS)));
        }
        let words = AsMut::<[u32]>::as_mut(&mut v).as_mut_ptr() as *mut AtomicU32;
        // SAFETY: the typed array's data is `WORDS` u32s (checked above), 4-aligned
        // (a SharedArrayBuffer's data is page-aligned and the offset is a multiple of 4);
        // the strong reference below keeps the buffer alive for the process's life.
        let w = |i: usize| unsafe { &*words.add(i) };
        if w(node_host::VERSION).load(SeqCst) != CONTROL_VERSION {
            return Err(coded("bad_control", "the control words' VERSION does not match".into()));
        }
        if node_host::after(w(node_host::STOP_UPTO).load(SeqCst), w(node_host::RUN).load(SeqCst)) {
            return Err(coded("bad_control", "a Stop is pending against a run that hasn't started".into()));
        }
        if CLAIM.set(std::thread::current().id()).is_err() {
            return Err(coded("already_claimed", "this process already has a native engine session".into()));
        }
        // the reference is never released: the session lives as long as the process
        std::mem::forget(reference);
        // SAFETY: as above; install's contract holds for the rest of the process.
        unsafe { node_host::install(words) };
        Ok(())
    })?
}

/// Advance the session's RUN to `id` before that run's first engine call
/// (RFC 1982: `id` must be after the current RUN; otherwise refused).
#[napi(js_name = "setRun")]
pub fn set_run(id: u32) -> Result<()> {
    guarded(|| node_host::set_run(id))?.map_err(|e| coded("bad_run", e))
}

/// The error code of an interrupted call (the session's Stop).
const INTERRUPTED: &str = "interrupted";
/// The error code of a fault (an unexpected panic): the process is retired.
const ENGINE_FAULT: &str = "engine_fault";

fn coded(code: &str, message: String) -> Error {
    Error::new(Status::GenericFailure, format!("{}: {}", code, message))
}

thread_local! {
    /// Whether an addon export is running on this thread (design N1 r3.4, S4).
    static DEPTH: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Whether a nested export was attempted since the flag was last cleared
    /// (the total host's answer reads and clears it: a tainted answer is
    /// Unreadable, r3.4).
    static REENTERED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The outermost export's depth (RAII): restores "no export" on every exit.
struct Depth;

impl Drop for Depth {
    fn drop(&mut self) {
        DEPTH.with(|d| d.set(false));
    }
}

/// Enter an export: refused, touching nothing but the reentry flag, when
/// another export is already running on this thread (a JS callback that
/// called back into the addon).
fn enter() -> Result<Depth> {
    if DEPTH.with(|d| d.get()) {
        REENTERED.with(|r| r.set(true));
        return Err(coded("reentrant", "the native engine was called from inside one of its own calls".into()));
    }
    DEPTH.with(|d| d.set(true));
    Ok(Depth)
}

/// Whether a nested export was attempted since the last call, clearing the flag.
#[allow(dead_code)]
pub(crate) fn take_reentered() -> bool {
    REENTERED.with(|r| r.replace(false))
}

/// Run one export's body: refused when nested (r3.4) and before init or off
/// the session's thread; refused once the process is faulted; an interrupt
/// is reported as such; any other panic faults the process.
fn guarded<T>(f: impl FnOnce() -> T) -> Result<T> {
    let _depth = enter()?;
    owner()?;
    run(f)
}

/// `guarded` without the owner check (init itself).
fn guarded_unclaimed<T>(f: impl FnOnce() -> T) -> Result<T> {
    let _depth = enter()?;
    run(f)
}

fn run<T>(f: impl FnOnce() -> T) -> Result<T> {
    if FAULTED.load(SeqCst) {
        return Err(coded(ENGINE_FAULT, "the engine faulted earlier in this process".into()));
    }
    sagebrush_interrupt::quiet_hook();
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(v) => Ok(v),
        Err(payload) => {
            if payload.downcast_ref::<sagebrush_interrupt::Interrupted>().is_some() {
                sagebrush_interrupt::clear();
                Err(coded(INTERRUPTED, "the computation was interrupted".into()))
            } else {
                FAULTED.store(true, SeqCst);
                let what = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "a panic with no message".into());
                Err(coded(ENGINE_FAULT, what))
            }
        }
    }
}

/// A JSON engine call (engine/web's sb_call): `{"fn": NAME, ...}` to
/// `{"ok": ...}` or `{"error": ...}`.
#[napi(js_name = "engineCall")]
pub fn engine_call(req: String) -> Result<String> {
    guarded(|| {
        sagebrush_web::new_run();
        sagebrush_web::call(&req)
    })
}

/// A symbolic-engine call (engine/web's sb_sym_call).
#[napi(js_name = "symCall")]
pub fn sym_call(req: String) -> Result<String> {
    guarded(|| {
        sagebrush_web::new_run();
        sagebrush_sym::api::call(&req)
    })
}

/// A multivariate polynomial call (engine/web's sb_mp_call): the request's
/// bytes as given (its byteOffset and length honoured), a fresh reply.
#[napi(js_name = "mpCall")]
pub fn mp_call(req: Uint8Array) -> Result<Buffer> {
    let bytes: &[u8] = &req;
    guarded(|| {
        sagebrush_web::new_run();
        sagebrush_mpoly::call_framed(bytes)
    })
    .map(Buffer::from)
}

/// A binary call (engine/web's sb_bin_call).
#[napi(js_name = "binCall")]
pub fn bin_call(req: Uint8Array) -> Result<Buffer> {
    let bytes: &[u8] = &req;
    guarded(|| {
        sagebrush_web::new_run();
        sagebrush_web::bin_ops::call_bin(bytes)
    })
    .map(Buffer::from)
}

/// The last symbolic-engine error (engine/web's sb_last_error): `""` or
/// `"err\x1fKIND\x1fMESSAGE"`.
#[napi(js_name = "lastError")]
pub fn last_error() -> Result<String> {
    guarded(|| match sagebrush_sym::err::take_last_error() {
        Some((k, m)) => format!("err\x1f{}\x1f{}", k, m),
        None => String::new(),
    })
}

/// Reserve `bytes` for host work under the ledger (engine/web's
/// sb_reserve, the same body): `{"handle": n}`, `{"memory": ...}` (refused)
/// or `{"error": ...}`, as a JSON string.
#[napi]
pub fn reserve(what: String, bytes: f64) -> Result<String> {
    guarded(|| {
        let (handle, reply) = sagebrush_web::host_reserve(if what.is_empty() { "host" } else { &what }, bytes);
        reply.unwrap_or_else(|| serde_json::json!({ "handle": handle })).to_string()
    })
}

/// Grow a host reservation (sb_grow): `{"ok": true}`, `{"memory": ...}` or `{"error": ...}`.
#[napi]
pub fn grow(handle: f64, bytes: f64) -> Result<String> {
    guarded(|| {
        let (_code, reply) = sagebrush_web::host_grow(handle, bytes);
        reply.unwrap_or_else(|| serde_json::json!({ "ok": true })).to_string()
    })
}

/// Release a host reservation (sb_release): true, or false for no such handle.
#[napi]
pub fn release(handle: f64) -> Result<bool> {
    guarded(|| sagebrush_web::host_release(handle) == 0)
}

/// The memory share of a default polynomial factorization (sb_set_memory_share).
#[napi(js_name = "setMemoryShare")]
pub fn set_memory_share(v: f64) -> Result<()> {
    guarded(|| sagebrush_interrupt::set_memory_share(sagebrush_interrupt::share_from_f64(v)))
}

/// A WebAssembly instance's total: not applicable natively (no instance
/// extent, design N1 r3.3); answers -1 and changes nothing.
#[napi(js_name = "setInstanceTotal")]
pub fn set_instance_total(_bytes: f64, _status: u32) -> Result<i32> {
    guarded(|| -1)
}

/// Retired WebAssembly instances' bytes: none natively; a no-op answering 0.
#[napi(js_name = "setRetiredBytes")]
pub fn set_retired_bytes(_bytes: f64, _faulted: u32) -> Result<i32> {
    guarded(|| 0)
}
