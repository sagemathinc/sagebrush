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
use napi::{Error, Result, Status};
use napi_derive::napi;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

static FAULTED: AtomicBool = AtomicBool::new(false);

/// The error code of an interrupted call (the session's Stop).
const INTERRUPTED: &str = "interrupted";
/// The error code of a fault (an unexpected panic): the process is retired.
const ENGINE_FAULT: &str = "engine_fault";

fn coded(code: &str, message: String) -> Error {
    Error::new(Status::GenericFailure, format!("{}: {}", code, message))
}

/// Run one export's body: refused once the process is faulted; an
/// interrupt is reported as such; any other panic faults the process.
fn guarded<T>(f: impl FnOnce() -> T) -> Result<T> {
    if FAULTED.load(SeqCst) {
        return Err(coded(ENGINE_FAULT, "the engine faulted earlier in this process".into()));
    }
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
