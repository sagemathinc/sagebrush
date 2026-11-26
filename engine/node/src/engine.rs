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
use napi::{Env, Error, JsFunction, JsTypedArray, NapiRaw, Result, Status, TypedArrayType};
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
pub fn init(env: Env, control: JsTypedArray, version: u32, total_source: Option<JsFunction>) -> Result<()> {
    guarded_unclaimed(&env, || -> Result<()> {
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
        if let Some(f) = total_source {
            register_total_source(&env, &f)?;
        }
        Ok(())
    })?
}

/// Advance the session's RUN to `id` before that run's first engine call
/// (RFC 1982: `id` must be after the current RUN; otherwise refused).
#[napi(js_name = "setRun")]
pub fn set_run(env: Env, id: u32) -> Result<()> {
    guarded(&env, || node_host::set_run(id))?.map_err(|e| coded("bad_run", e))
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
    /// The outermost export's N-API environment while it runs: the total
    /// host's "asking" marker (design N1 r3.3), present only on the session's
    /// thread inside an export.
    static ASK_ENV: std::cell::Cell<napi::sys::napi_env> = const { std::cell::Cell::new(std::ptr::null_mut()) };
    /// The total source raised the runtime's KeyboardInterrupt during this
    /// export (r3.5: the export reports "interrupted").
    static HOST_INTERRUPT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The outermost export's depth (RAII): restores "no export" on every exit.
struct Depth;

impl Drop for Depth {
    fn drop(&mut self) {
        DEPTH.with(|d| d.set(false));
        ASK_ENV.with(|e| e.set(std::ptr::null_mut()));
    }
}

/// Enter an export: refused, touching nothing but the reentry flag, when
/// another export is already running on this thread (a JS callback that
/// called back into the addon).
fn enter(env: &Env) -> Result<Depth> {
    if DEPTH.with(|d| d.get()) {
        REENTERED.with(|r| r.set(true));
        return Err(coded("reentrant", "the native engine was called from inside one of its own calls".into()));
    }
    DEPTH.with(|d| d.set(true));
    ASK_ENV.with(|e| e.set(env.raw()));
    Ok(Depth)
}

/// Whether a nested export was attempted since the last call, clearing the flag.
fn take_reentered() -> bool {
    REENTERED.with(|r| r.replace(false))
}

/// Run one export's body: refused when nested (r3.4) and before init or off
/// the session's thread; refused once the process is faulted; an interrupt
/// is reported as such; any other panic faults the process.
fn guarded<T>(env: &Env, f: impl FnOnce() -> T) -> Result<T> {
    let _depth = enter(env)?;
    owner()?;
    run(f)
}

/// `guarded` without the owner check (init itself).
fn guarded_unclaimed<T>(env: &Env, f: impl FnOnce() -> T) -> Result<T> {
    let _depth = enter(env)?;
    run(f)
}

fn run<T>(f: impl FnOnce() -> T) -> Result<T> {
    run_undo(f, |_| {})
}

/// `run`, with `undo` applied to a completed body's value when the call is
/// reported interrupted anyway (the total source's interrupt, r3.5): what
/// the body made must not outlive a call the host sees as interrupted
/// (reserve: the reservation is released, not leaked with its handle).
fn run_undo<T>(f: impl FnOnce() -> T, undo: impl FnOnce(&T)) -> Result<T> {
    if FAULTED.load(SeqCst) {
        return Err(coded(ENGINE_FAULT, "the engine faulted earlier in this process".into()));
    }
    sagebrush_interrupt::quiet_hook();
    HOST_INTERRUPT.with(|h| h.set(false));
    let out = catch_unwind(AssertUnwindSafe(f));
    // (r3.5: the total source's KeyboardInterrupt is the call's interrupt,
    // whether or not a check reached it before the call ended)
    let host_interrupt = HOST_INTERRUPT.with(|h| h.replace(false));
    match out {
        Ok(v) if host_interrupt => {
            undo(&v);
            sagebrush_interrupt::clear();
            Err(coded(INTERRUPTED, "the computation was interrupted".into()))
        }
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
pub fn engine_call(env: Env, req: String) -> Result<String> {
    guarded(&env, || {
        sagebrush_web::new_run();
        sagebrush_web::call(&req)
    })
}

/// A symbolic-engine call (engine/web's sb_sym_call).
#[napi(js_name = "symCall")]
pub fn sym_call(env: Env, req: String) -> Result<String> {
    guarded(&env, || {
        sagebrush_web::new_run();
        sagebrush_sym::api::call(&req)
    })
}

/// A multivariate polynomial call (engine/web's sb_mp_call): the request's
/// bytes as given (its byteOffset and length honoured), a fresh reply.
#[napi(js_name = "mpCall")]
pub fn mp_call(env: Env, req: Uint8Array) -> Result<Buffer> {
    let bytes: &[u8] = &req;
    guarded(&env, || {
        sagebrush_web::new_run();
        sagebrush_mpoly::call_framed(bytes)
    })
    .map(Buffer::from)
}

/// A binary call (engine/web's sb_bin_call).
#[napi(js_name = "binCall")]
pub fn bin_call(env: Env, req: Uint8Array) -> Result<Buffer> {
    let bytes: &[u8] = &req;
    guarded(&env, || {
        sagebrush_web::new_run();
        sagebrush_web::bin_ops::call_bin(bytes)
    })
    .map(Buffer::from)
}

/// The last symbolic-engine error (engine/web's sb_last_error): `""` or
/// `"err\x1fKIND\x1fMESSAGE"`.
#[napi(js_name = "lastError")]
pub fn last_error(env: Env) -> Result<String> {
    guarded(&env, || match sagebrush_sym::err::take_last_error() {
        Some((k, m)) => format!("err\x1f{}\x1f{}", k, m),
        None => String::new(),
    })
}

/// Reserve `bytes` for host work under the ledger (engine/web's
/// sb_reserve, the same body): `{"handle": n}`, `{"memory": ...}` (refused)
/// or `{"error": ...}`, as a JSON string.
#[napi]
pub fn reserve(env: Env, what: String, bytes: f64) -> Result<String> {
    let _depth = enter(&env)?;
    owner()?;
    run_undo(
        || sagebrush_web::host_reserve(if what.is_empty() { "host" } else { &what }, bytes),
        |&(handle, ref reply)| {
            if reply.is_none() {
                sagebrush_web::host_release(handle);
            }
        },
    )
    .map(|(handle, reply)| reply.unwrap_or_else(|| serde_json::json!({ "handle": handle })).to_string())
}

/// Grow a host reservation (sb_grow): `{"ok": true}`, `{"memory": ...}` or `{"error": ...}`.
#[napi]
pub fn grow(env: Env, handle: f64, bytes: f64) -> Result<String> {
    guarded(&env, || {
        let (_code, reply) = sagebrush_web::host_grow(handle, bytes);
        reply.unwrap_or_else(|| serde_json::json!({ "ok": true })).to_string()
    })
}

/// Release a host reservation (sb_release): true, or false for no such handle.
#[napi]
pub fn release(env: Env, handle: f64) -> Result<bool> {
    guarded(&env, || sagebrush_web::host_release(handle) == 0)
}

/// The memory share of a default polynomial factorization (sb_set_memory_share).
#[napi(js_name = "setMemoryShare")]
pub fn set_memory_share(env: Env, v: f64) -> Result<()> {
    guarded(&env, || sagebrush_interrupt::set_memory_share(sagebrush_interrupt::share_from_f64(v)))
}

/// A WebAssembly instance's total: not applicable natively (no instance
/// extent, design N1 r3.3); answers -1 and changes nothing.
#[napi(js_name = "setInstanceTotal")]
pub fn set_instance_total(env: Env, _bytes: f64, _status: u32) -> Result<i32> {
    guarded(&env, || -1)
}

/// Retired WebAssembly instances' bytes: none natively; a no-op answering 0.
#[napi(js_name = "setRetiredBytes")]
pub fn set_retired_bytes(env: Env, _bytes: f64, _faulted: u32) -> Result<i32> {
    guarded(&env, || 0)
}

// ---- the total host (design N1 r3.3, r3.4 S5, r3.5)

/// The session's total source: a JS function (engine.ts's trusted wrapper
/// of lib/_capacity.py's _capacity_total) returning a JSON string, one of
/// {"ok": null}, {"ok": [bytes, status, joint, [[kind, path|null, figure], ...]]},
/// {"interrupted": true} or {"error": "..."}.  Referenced for the process's life.
static TOTAL_SOURCE: std::sync::atomic::AtomicPtr<napi::sys::napi_ref__> = std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

#[allow(unsafe_code)]
fn register_total_source(env: &Env, f: &JsFunction) -> Result<()> {
    let mut r: napi::sys::napi_ref = std::ptr::null_mut();
    // SAFETY: a valid env and function value of this call; the reference (count 1)
    // is never deleted, so the function lives as long as the process.
    let st = unsafe { napi::sys::napi_create_reference(env.raw(), f.raw(), 1, &mut r) };
    if st != napi::sys::Status::napi_ok {
        return Err(coded("bad_control", "the total source could not be referenced".into()));
    }
    TOTAL_SOURCE.store(r, SeqCst);
    // (may_ask: a plain thread-local read, as the ledger requires: inside an
    // export on the session's thread; never on the computation's workers)
    sagebrush_ledger::set_total_host_asking(total_answer, || ASK_ENV.with(|e| !e.get().is_null()));
    Ok(())
}

/// The ledger's question, answered by the session's JS source on this
/// thread (r3.3), with r3.5's precedence: a panic here is the export's fault
/// (S3, the outer catch_unwind); the runtime's KeyboardInterrupt is the
/// export's interrupt; otherwise a nested export attempted during the call
/// makes the answer Unreadable; otherwise the source's answer, converted as
/// the Python extension converts its own.
fn total_answer() -> sagebrush_ledger::HostAnswer {
    use sagebrush_ledger::HostAnswer;
    let env = ASK_ENV.with(|e| e.get());
    if env.is_null() {
        return HostAnswer::NotAsked;
    }
    REENTERED.with(|r| r.set(false));
    let reply = call_total_source(env);
    let reentered = take_reentered();
    let Some(text) = reply else { return HostAnswer::Unreadable };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return HostAnswer::Unreadable };
    if v.get("interrupted") == Some(&serde_json::Value::Bool(true)) {
        HOST_INTERRUPT.with(|h| h.set(true));
        sagebrush_interrupt::request();
        return HostAnswer::Unreadable;
    }
    if reentered {
        return HostAnswer::Unreadable;
    }
    match v.get("ok") {
        Some(serde_json::Value::Null) => HostAnswer::from_parts(None),
        Some(ok) => match parts_of(ok) {
            Some(p) => HostAnswer::from_parts(Some(p)),
            None => HostAnswer::Unreadable,
        },
        None => HostAnswer::Unreadable,
    }
}

/// [bytes, status, joint, [[kind, path|null, figure], ...]] with
/// non-negative integer figures, or None (malformed).
fn parts_of(v: &serde_json::Value) -> Option<(u64, u32, bool, Vec<(String, Option<String>, u64)>)> {
    let a = v.as_array()?;
    if a.len() != 4 {
        return None;
    }
    let rows = a[3]
        .as_array()?
        .iter()
        .map(|r| {
            let r = r.as_array()?;
            if r.len() != 3 {
                return None;
            }
            let path = match &r[1] {
                serde_json::Value::Null => None,
                serde_json::Value::String(p) => Some(p.clone()),
                _ => return None,
            };
            Some((r[0].as_str()?.to_string(), path, r[2].as_u64()?))
        })
        .collect::<Option<Vec<_>>>()?;
    Some((a[0].as_u64()?, u32::try_from(a[1].as_u64()?).ok()?, a[2].as_bool()?, rows))
}

/// Call the source with no arguments; its string, or None.  A pending JS
/// exception (the trusted wrapper never throws, but defensively) is taken
/// and cleared before Rust continues (r3.4 S5).
#[allow(unsafe_code)]
fn call_total_source(env: napi::sys::napi_env) -> Option<String> {
    use napi::sys;
    let r = TOTAL_SOURCE.load(SeqCst);
    if r.is_null() {
        return None;
    }
    let clear = || {
        let mut e: sys::napi_value = std::ptr::null_mut();
        // SAFETY: env is this export's environment, on its thread.
        unsafe { sys::napi_get_and_clear_last_exception(env, &mut e) };
    };
    // SAFETY: env is the outermost export's environment on this thread (ASK_ENV),
    // r the process-lifetime reference to the source; every out-pointer is local.
    unsafe {
        let mut f: sys::napi_value = std::ptr::null_mut();
        let mut this: sys::napi_value = std::ptr::null_mut();
        let mut out: sys::napi_value = std::ptr::null_mut();
        if sys::napi_get_reference_value(env, r, &mut f) != sys::Status::napi_ok || f.is_null() {
            clear();
            return None;
        }
        if sys::napi_get_undefined(env, &mut this) != sys::Status::napi_ok {
            clear();
            return None;
        }
        if sys::napi_call_function(env, this, f, 0, std::ptr::null(), &mut out) != sys::Status::napi_ok {
            clear();
            return None;
        }
        let mut len: usize = 0;
        if sys::napi_get_value_string_utf8(env, out, std::ptr::null_mut(), 0, &mut len) != sys::Status::napi_ok {
            clear();
            return None;
        }
        let mut buf = vec![0u8; len + 1];
        let mut got: usize = 0;
        if sys::napi_get_value_string_utf8(env, out, buf.as_mut_ptr() as *mut std::os::raw::c_char, len + 1, &mut got) != sys::Status::napi_ok {
            clear();
            return None;
        }
        buf.truncate(got);
        String::from_utf8(buf).ok()
    }
}
