//! Sagebrush engines as a plain wasm32 module with a JSON ABI, so that one
//! small JavaScript file (web/sagebrush.mjs) can embed and call it anywhere
//! WebAssembly runs, including chat artifacts that forbid fetch().
//!
//! ABI: sb_alloc(len) -> ptr; write a UTF-8 JSON request there;
//! sb_call(ptr, len) -> ptr of a UTF-8 JSON reply whose length is
//! sb_reply_len().  Requests are {"fn": NAME, ...args}; replies are
//! {"ok": RESULT} or {"error": MESSAGE}.  Single-threaded.  The functions
//! and their results mirror the Python bindings (py/src/lib.rs: modsym,
//! ap, mf); newspace/newforms factor with sagebrush-poly (pure Rust) and
//! "factor" exposes it; "hmf_*" are Hilbert modular forms over Q(sqrt 5) (hmf.rs), "hmfq_*" over any real quadratic field (hmfq.rs).  Big
//! integers are decimal strings.


use sagebrush_bigint::BigInt;
use sagebrush_modsym::dirichlet::DirichletGroup;
use sagebrush_modsym::general::{Character, GeneralSpace};
use serde_json::{json, Value};

mod hmf;
mod hmfq;
pub mod nmod_ops;

static mut REPLY: Vec<u8> = Vec::new();

#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique);
// the block is leaked to the host, which returns it through sb_free with its length.
#[allow(unsafe_code)]
pub extern "C" fn sb_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique);
// the host passes back a block from sb_alloc(len) with that len, so rebuilding
// the Vec (length 0, capacity len) and dropping it frees exactly that allocation.
#[allow(unsafe_code)]
pub unsafe extern "C" fn sb_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique);
// REPLY's length is read on one thread with no other reference to REPLY live
// (wasm is single-threaded; natively only one-test ABI binaries call this).
// That is the supported boundary: any other native caller is unsupported.
#[allow(unsafe_code)]
pub extern "C" fn sb_reply_len() -> usize {
    unsafe { (*std::ptr::addr_of!(REPLY)).len() }
}

#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique);
// the host wrote `len` request bytes at `ptr` (a block from sb_alloc), so the
// slice is readable; REPLY is replaced on one thread with no other reference
// to it live (wasm is single-threaded; natively only one-test ABI binaries call
// this).  That is the supported boundary: any other native caller is unsupported.
#[allow(unsafe_code)]
pub unsafe extern "C" fn sb_call(ptr: *const u8, len: usize) -> *const u8 {
    let req = std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).unwrap_or("");
    let r = &mut *std::ptr::addr_of_mut!(REPLY);
    // the previous reply is freed first (the host copied it after the last
    // call), so it never coexists with this call's memory
    drop(std::mem::take(r));
    *r = call(req).into_bytes();
    r.as_ptr()
}

/// A symbolic-engine call (engine/sym/src/api.rs: "op\x1fargs..."); the
/// reply is in the same buffer as sb_call's.
#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique);
// the host wrote `len` request bytes at `ptr` (a block from sb_alloc), so the
// slice is readable; REPLY is replaced on one thread with no other reference
// to it live (wasm is single-threaded; natively only one-test ABI binaries call
// this).  That is the supported boundary: any other native caller is unsupported.
#[allow(unsafe_code)]
pub unsafe extern "C" fn sb_sym_call(ptr: *const u8, len: usize) -> *const u8 {
    let req = std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).unwrap_or("");
    let r = &mut *std::ptr::addr_of_mut!(REPLY);
    drop(std::mem::take(r));
    *r = sagebrush_sym::api::call(req).into_bytes();
    r.as_ptr()
}

/// A multivariate polynomial call (engine/mpoly: binary framing of
/// sagebrush_mpoly::call); the reply is in the same buffer as sb_call's.
#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique);
// the host wrote `len` request bytes at `ptr` (a block from sb_alloc), so the
// slice is readable; REPLY is replaced on one thread with no other reference
// to it live (wasm is single-threaded; natively only one-test ABI binaries call
// this).  That is the supported boundary: any other native caller is unsupported.
#[allow(unsafe_code)]
pub unsafe extern "C" fn sb_mp_call(ptr: *const u8, len: usize) -> *const u8 {
    let req = std::slice::from_raw_parts(ptr, len);
    let r = &mut *std::ptr::addr_of_mut!(REPLY);
    drop(std::mem::take(r));
    *r = sagebrush_mpoly::call_framed(req);
    r.as_ptr()
}

/// The memory share of a default polynomial factorization (item D0), pushed
/// by the host before a dispatch: bytes, an integer from 0 to 4 GiB, or -1
/// for none (anything else is none too).  Optional: a host that never calls
/// it leaves the factorizations their default.
#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn sb_set_memory_share(v: f64) {
    sagebrush_interrupt::set_memory_share(sagebrush_interrupt::share_from_f64(v));
}

/// The engine's memory total (no-cliffs plan C r10 section 1, the host's
/// lib/_capacity.py engine_total), pushed by the host before a dispatch:
/// bytes (an integer up to 2^53), status (0 observed, 1 zero, 2 nominal) and
/// uncertified (C r17 section 1.3: 1 when some row that constrains the
/// engine's domain is joint or unknown, the host's engine_uncertified; then
/// the ledger still admits but is not certified); anything else is none,
/// and the ledger uses the nominal total.  Optional, as sb_set_memory_share.
#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn sb_set_memory_total(bytes: f64, status: u32, uncertified: u32) {
    sagebrush_ledger::set_total(sagebrush_ledger::total_from_wasm(bytes, status, uncertified));
}

/// The instance-local total (no-cliffs C r16b section 3.2: a row bounding
/// this instance's own memory, the wasm32 ceiling), checked without R_ret:
/// bytes as for sb_set_memory_total, status 0 observed, 1 zero, 2 nominal,
/// or 3 for none (no instance row).  0; -1 for anything else, which also
/// sets the ledger's sticky fault (never certified from then on).
#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn sb_set_instance_total(bytes: f64, status: u32) -> i32 {
    match sagebrush_ledger::instance_total_from_wasm(bytes, status) {
        Ok(t) => {
            sagebrush_ledger::set_instance_total(t);
            0
        }
        Err(()) => {
            sagebrush_ledger::set_fault();
            -1
        }
    }
}

/// The ledger's live estimate (committed pages, or the baseline plus
/// residents, whichever is larger: no-cliffs plan C r13) and its gross
/// outstanding obligations: the host's common-domain check reads them (C-2).
#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn sb_live_estimate() -> f64 {
    sagebrush_ledger::live_estimate() as f64
}

#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn sb_outstanding_bytes() -> f64 {
    sagebrush_ledger::outstanding_bytes() as f64
}

/// R_ret, the pages of this domain's retired instances still pending their
/// finalizers, and the host's failed-creation fault (no-cliffs C r14
/// section 2, r15 section 4, r17 section 2), pushed by the host on creation
/// and when an instance's finalizers have both fired: bytes finite, >= 0, an
/// integer up to 2^53 - 1 and a multiple of 64 KiB; faulted 0 or 1.  0 when
/// set; -1 for anything else, which is also a sticky fault (the ledger is
/// not certified from then on).
#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn sb_set_retired_bytes(bytes: f64, faulted: u32) -> i32 {
    match sagebrush_ledger::set_retired(bytes, faulted) {
        Ok(()) => 0,
        Err(_) => -1,
    }
}

/// One slot of the host map: a live reservation (or none) and the slot's
/// generation, which every handle to it carries (astra2 CORR-C2B-HANDLE-1:
/// a stale handle never reaches the slot's next reservation).
struct HostSlot {
    gen: u32,
    r: Option<sagebrush_ledger::Reservation>,
}

thread_local! {
    /// The host participants' reservations (C r15 section 3.1), by slot; a
    /// released slot is reused under its next generation.  Bounded by memory,
    /// not by a count: the map's own capacity is admitted before each growth
    /// and held as the instance's resident (HOST_MAP); grown outside the
    /// ledger's lock.
    static HOST: std::cell::RefCell<Vec<HostSlot>> = const { std::cell::RefCell::new(Vec::new()) };
    /// The map's capacity in bytes, a registered resident of the instance
    /// (daybreak2 LIMIT-C2BI-1: a zero-byte handle still costs its slot;
    /// astra2 CORR-C2B-MAP-OWNER-1: not any operation's chain).
    static HOST_MAP: std::cell::RefCell<Option<sagebrush_ledger::Resident>> = const { std::cell::RefCell::new(None) };
    /// The reusable released slots in HOST (a reservation takes one before
    /// growing the map).
    static HOST_FREE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// One slot of the host map, in bytes.
const HOST_SLOT: u64 = std::mem::size_of::<HostSlot>() as u64;

/// A handle is gen * 2^32 + slot + 1, an integer below 2^53 (exact in the
/// host's numbers); a slot whose generation reaches GEN_END is retired, never
/// reused, so no handle value ever repeats (no generation wraps).  Its
/// storage stays charged in HOST_MAP.
const SLOT_SPAN: u64 = 1 << 32;
const GEN_END: u32 = 1 << 21;

/// The bytes the host map's capacity holds in the ledger.
pub fn host_map_bytes() -> u64 {
    HOST_MAP.with(|m| m.borrow().as_ref().map_or(0, |r| r.amount()))
}

/// Room for one more slot in a full host map.  The doubled capacity is
/// admitted on the current chain (under its rules) and at once becomes a
/// registered resident: the map outlives the operation that grew it, so its
/// charge has the instance's lifetime, not the chain's (astra2
/// CORR-C2B-MAP-OWNER-1).  The old capacity's resident stays until the
/// reallocation has moved the slots (it holds both), then is dropped with
/// the old buffer.  Allocation is outside the ledger's lock.
fn host_map_room(h: &mut Vec<HostSlot>) -> Result<(), sagebrush_ledger::EngineError> {
    if h.len() < h.capacity() {
        return Ok(());
    }
    let cap = h.capacity() as u64;
    let new = (cap * 2).max(4);
    let next = sagebrush_ledger::reserve("host handle map", new * HOST_SLOT)?.register_resident();
    h.reserve_exact((new - cap) as usize);
    debug_assert_eq!(h.capacity() as u64, new);
    HOST_MAP.with(|m| drop(m.borrow_mut().replace(next)));
    Ok(())
}

/// The host's bytes argument: an integer from 0 to 2^53, or None.
fn host_bytes(b: f64) -> Option<u64> {
    (b.is_finite() && b >= 0.0 && b.fract() == 0.0 && b <= 9007199254740992.0).then_some(b as u64)
}

/// A handle's slot and generation, if it is one in form (a positive integer
/// below 2^53 with a slot part); whether it is live is the slot's to say.
fn host_handle(handle: f64) -> Option<(usize, u32)> {
    let v = host_bytes(handle)?;
    let slot = (v % SLOT_SPAN).checked_sub(1)?;
    let gen = u32::try_from(v / SLOT_SPAN).ok().filter(|&g| g < GEN_END)?;
    Some((usize::try_from(slot).ok()?, gen))
}

/// The reply buffer's address (sb_reserve and sb_grow leave a refusal there,
/// sb_reply_len bytes of JSON).
#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique);
// REPLY's address is read on one thread with no other reference to REPLY live
// (wasm is single-threaded; natively only one-test ABI binaries call this).
// That is the supported boundary: any other native caller is unsupported.
#[allow(unsafe_code)]
pub extern "C" fn sb_reply_ptr() -> *const u8 {
    unsafe { (*std::ptr::addr_of!(REPLY)).as_ptr() }
}

// SAFETY: REPLY is replaced on one thread with no other reference to it live
// (wasm is single-threaded; natively only the one-test ABI binaries reach it).
// That is the supported boundary: any other native caller is unsupported.
#[allow(unsafe_code)]
fn set_reply(v: Value) {
    let r = unsafe { &mut *std::ptr::addr_of_mut!(REPLY) };
    drop(std::mem::take(r));
    *r = v.to_string().into_bytes();
}

/// A host participant's common-domain obligation in this instance's ledger
/// (no-cliffs C r7 section 4, r15 section 3.1): `bytes` for `what` (UTF-8 at
/// what_ptr, what_len).  > 0: the handle (an integer below 2^53, valid until
/// released: never reissued); 0: refused, the reply holds {"memory": {...}};
/// -1: an invalid argument or an internal error, the reply holds
/// {"error": ...}.
///
/// # Safety
/// `what_ptr` must point to `what_len` readable bytes (or `what_len` be 0),
/// as the host writes them into this instance's memory.
#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique);
// `what` is read per this fn's `# Safety` (the host wrote `what_len` bytes at
// `what_ptr`); the reservation itself is made through the ledger's safe API.
#[allow(unsafe_code)]
pub unsafe extern "C" fn sb_reserve(what_ptr: *const u8, what_len: usize, bytes: f64) -> f64 {
    let what = if what_len == 0 { "host" } else { std::str::from_utf8(std::slice::from_raw_parts(what_ptr, what_len)).unwrap_or("host") };
    let Some(x) = host_bytes(bytes) else {
        set_reply(json!({ "error": format!("sb_reserve: {} is not a byte count", bytes) }));
        return -1.0;
    };
    let placed = sagebrush_ledger::reserve(what, x).and_then(|r| {
        HOST.with(|h| {
            let mut h = h.borrow_mut();
            let free = HOST_FREE.with(|f| f.get());
            let reuse = if free > 0 { h.iter().position(|s| s.r.is_none() && s.gen < GEN_END) } else { None };
            let i = match reuse {
                Some(i) => {
                    h[i].r = Some(r);
                    HOST_FREE.with(|f| f.set(free - 1));
                    i
                }
                None => {
                    // (a refused map growth drops r: the reservation is
                    // released, never held without a handle)
                    host_map_room(&mut h)?;
                    h.push(HostSlot { gen: 0, r: Some(r) });
                    h.len() - 1
                }
            };
            // (a memory bound comes first: 2^32 slots exceed WebAssembly's
            // 4 GiB address space, so this fails closed only natively)
            match u64::try_from(i).ok().filter(|&s| s < SLOT_SPAN - 1) {
                Some(s) => Ok((h[i].gen as u64 * SLOT_SPAN + s + 1) as f64),
                None => {
                    h[i].r = None;
                    Err(sagebrush_ledger::EngineError::Internal("sb_reserve: no handle number left".into()))
                }
            }
        })
    });
    match placed {
        Ok(handle) => handle,
        Err(sagebrush_ledger::EngineError::Memory(r)) => {
            set_reply(json!({ "memory": memory_error_value(&r) }));
            0.0
        }
        Err(e) => {
            set_reply(json!({ "error": e.to_string() }));
            -1.0
        }
    }
}

/// Grow a host handle's obligation by `bytes` (a growing result, C r15
/// section 3.1): 0 ok; 1 refused, the reply holds {"memory": {...}}; -1 an
/// unknown or released handle, an invalid argument or an internal error.
#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn sb_grow(handle: f64, bytes: f64) -> i32 {
    let Some(x) = host_bytes(bytes) else {
        set_reply(json!({ "error": format!("sb_grow: {} is not a byte count", bytes) }));
        return -1;
    };
    // (the reservation is taken out for the admission, so no borrow is held
    // across the ledger's lock, then put back in the same slot)
    let Some((i, mut r)) = slot_take(handle) else {
        set_reply(json!({ "error": format!("sb_grow: no host handle {}", handle) }));
        return -1;
    };
    let out = match r.grow("host result", x) {
        Ok(()) => 0,
        Err(sagebrush_ledger::EngineError::Memory(m)) => {
            set_reply(json!({ "memory": memory_error_value(&m) }));
            1
        }
        Err(e) => {
            set_reply(json!({ "error": e.to_string() }));
            -1
        }
    };
    HOST.with(|h| h.borrow_mut()[i].r = Some(r));
    out
}

/// Release a host handle: 0, or -1 for an unknown or released handle.  The
/// slot's generation advances, so this handle is stale from then on.
#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn sb_release(handle: f64) -> i32 {
    match slot_take(handle) {
        Some((i, r)) => {
            drop(r);
            let reusable = HOST.with(|h| {
                let mut h = h.borrow_mut();
                h[i].gen += 1;
                h[i].gen < GEN_END
            });
            if reusable {
                HOST_FREE.with(|f| f.set(f.get() + 1));
            }
            0
        }
        None => -1,
    }
}

/// A live handle's slot and reservation, taken out of the slot (sb_grow
/// puts it back; sb_release advances the generation): only when the handle's
/// generation is the slot's.
fn slot_take(handle: f64) -> Option<(usize, sagebrush_ledger::Reservation)> {
    let (i, gen) = host_handle(handle)?;
    HOST.with(|h| {
        let mut h = h.borrow_mut();
        let s = h.get_mut(i)?;
        if s.gen != gen {
            return None;
        }
        s.r.take().map(|r| (i, r))
    })
}


/// The engine's typed memory refusal as the reply's "memory" member: the
/// host turns it into D1's error (SagebrushMemoryError), never a string to
/// parse (no-cliffs plan C r10; callers adopt it as their caps go).
pub fn memory_error_value(r: &sagebrush_ledger::Refusal) -> Value {
    json!({ "what": r.what, "row": r.row, "need": r.need, "allowance": r.allowance, "live": r.live, "outstanding": r.outstanding,
            "total": r.total, "status": r.status.name(), "joint": r.joint, "retired": r.retired })
}

/// After a trap (an error aborts in WebAssembly): "err\x1fKind\x1fmessage"
/// for the last symbolic error, or "" (an interrupt or a bug).
#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique);
// REPLY is replaced on one thread with no other reference to it live (wasm is
// single-threaded; natively only one-test ABI binaries call this).  That is the
// supported boundary: any other native caller is unsupported.
#[allow(unsafe_code)]
pub unsafe extern "C" fn sb_last_error() -> *const u8 {
    let r = &mut *std::ptr::addr_of_mut!(REPLY);
    drop(std::mem::take(r));
    *r = match sagebrush_sym::err::take_last_error() {
        Some((k, m)) => format!("err\x1f{}\x1f{}", k, m),
        None => String::new(),
    }
    .into_bytes();
    r.as_ptr()
}

/// The progress frame area (sagebrush_interrupt::progress, design-estimates-
/// progress r4 §6): the host copies it inside its `sagebrush.interrupted`
/// import.  An optional export: a host that doesn't look for it reads no
/// progress, and the engine needs no import for it.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
// SAFETY: an export of the engine's wasm ABI (no_mangle; the sb_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn sb_progress_ptr() -> *const u32 {
    sagebrush_interrupt::progress::frames_ptr()
}

/// The hosts' progress self-test: `depth` nested calls of op `op`, the
/// innermost counting `steps` steps (each a coarse interrupt check, so the
/// host copies the frames), then an in-band error if `fail`.  It computes
/// nothing; the hosts' tests use it (test/progress.test.ts).
fn progress_selftest(v: &Value) -> Result<Value, String> {
    use sagebrush_interrupt::progress;
    let depth = v.get("depth").and_then(Value::as_u64).unwrap_or(1).clamp(1, 40) as usize;
    let steps = v.get("steps").and_then(Value::as_u64).unwrap_or(1).min(1 << 32);
    let op = v.get("op").and_then(Value::as_u64).unwrap_or(1) as u32;
    let mut calls: Vec<progress::Call> = (0..depth).map(|_| progress::begin(op)).collect();
    let last = calls.last_mut().expect("depth >= 1");
    for k in 1..=steps {
        let r = last.report();
        r.stage = 1;
        r.stage_index = 1;
        r.stage_count = Some(2);
        r.done = k;
        r.total = Some(steps);
        r.unit = 8;
        r.work = k;
        last.publish();
        sagebrush_interrupt::check_coarse();
    }
    // (innermost first, as nested calls end)
    while let Some(c) = calls.pop() {
        drop(c);
    }
    if v.get("fail").and_then(Value::as_bool).unwrap_or(false) {
        return Err("progress_selftest: the requested failure".into());
    }
    Ok(json!({ "steps": steps, "calls": depth }))
}

/// The same JSON call natively (examples/atlas.rs builds the atlas with it).
pub fn call(req: &str) -> String {
    // the capped ops' request sizes are admitted before serde copies
    // anything (the last top-level fn name is read by one scan that owns no
    // text: every other value skipped); unknown names go on as before
    if let Some(op) = capped_op(req) {
        if req.len() > op.max_request {
            return json!({ "error": format!("{}: the request has {} bytes, more than {}", op.name, req.len(), op.max_request) }).to_string();
        }
        if let Some(f) = op.run {
            return nmod_ops::run(op, req, f);
        }
    }
    match serde_json::from_str::<Value>(req).map_err(|e| e.to_string()).and_then(|v| dispatch(&v)) {
        Ok(v) => json!({ "ok": v }),
        Err(e) => error_json(e),
    }
    .to_string()
}

/// The polynomials' factorization as modsym's factor callback (`run` gets
/// it): a refusal gives no factors, which checked_factor rejects as an
/// error (never a successful unfactored answer); an internal error is kept
/// and returned in place of checked_factor's generic message, so the reply
/// carries it as internal (rank-3 plan r3 section 3.5).
type Factored = Vec<(Vec<BigInt>, u32)>;
fn keeping_internal<T>(
    factor: &(dyn Fn(&[BigInt]) -> Result<Factored, sagebrush_poly::FactorLimit> + Sync),
    run: impl FnOnce(&(dyn Fn(&[BigInt]) -> Factored + Sync)) -> Result<T, String>,
) -> Result<T, String> {
    let internal: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    let fac = |f: &[BigInt]| match factor(f) {
        Ok(fs) => fs,
        Err(e) => {
            if e.kind == sagebrush_poly::Kind::Internal {
                let mut kept = internal.lock().unwrap_or_else(|p| p.into_inner());
                if kept.is_none() {
                    *kept = Some(e.to_string());
                }
            }
            Vec::new()
        }
    };
    let r = run(&fac);
    let kept = internal.lock().unwrap_or_else(|p| p.into_inner()).take();
    match kept {
        Some(m) => Err(m),
        None => r,
    }
}

/// A call's error reply: {"error": MESSAGE}, with "internal": true when the
/// message carries a failed proved invariant of the factoring engine (also
/// inside an op's own message), so the callers raise it as an internal
/// error, never as a resource limit or a user error.
fn error_json(e: String) -> Value {
    if e.contains(sagebrush_poly::INTERNAL_PREFIX) {
        json!({ "error": e, "internal": true })
    } else {
        json!({ "error": e })
    }
}

/// The row of [`nmod_ops::OPS`] named exactly by the request's last
/// top-level "fn" (as serde keeps it), if any.
fn capped_op(req: &str) -> Option<&'static nmod_ops::Op> {
    static NAMES: [&str; 5] = [
        nmod_ops::OPS[0].name,
        nmod_ops::OPS[1].name,
        nmod_ops::OPS[2].name,
        nmod_ops::OPS[3].name,
        nmod_ops::OPS[4].name,
    ];
    last_fn(req, &NAMES).map(|i| &nmod_ops::OPS[i])
}

#[cfg(test)]
fn fn_name_is(req: &str, name: &str) -> bool {
    last_fn(req, &[name]) == Some(0)
}

/// Which of `names` the request's top-level "fn" is (the last "fn", as
/// serde keeps it), by a scan of the raw bytes that owns no text: strings
/// are compared while their escapes are decoded, other values skipped.
/// None for no match, a non-string fn, or malformed input (serde then
/// reports it).
fn last_fn(req: &str, names: &[&str]) -> Option<usize> {
    let b = req.as_bytes();
    let mut i = 0;
    let ws = |b: &[u8], i: &mut usize| {
        while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\n' | b'\r') {
            *i += 1;
        }
    };
    ws(b, &mut i);
    if b.get(i) != Some(&b'{') {
        return None;
    }
    i += 1;
    let mut found = None;
    loop {
        ws(b, &mut i);
        match b.get(i) {
            Some(b'}') => return found,
            Some(b'"') => {}
            _ => return None,
        }
        let is_fn = json_str_match(b, &mut i, &["fn"])?.is_some();
        ws(b, &mut i);
        if b.get(i) != Some(&b':') {
            return None;
        }
        i += 1;
        ws(b, &mut i);
        if is_fn && b.get(i) == Some(&b'"') {
            found = json_str_match(b, &mut i, names)?;
        } else {
            if is_fn {
                found = None;
            }
            if !json_skip(b, &mut i) {
                return None;
            }
        }
        ws(b, &mut i);
        match b.get(i) {
            Some(b',') => i += 1,
            Some(b'}') => return found,
            _ => return None,
        }
    }
}

/// Which of `names` (ASCII, at most 64) the JSON string at b[*i] (an
/// opening quote) equals: decoded char by char (escapes included) and
/// compared with all of them at once, never stored; *i ends past the
/// closing quote.  None if malformed, Some(None) if it equals none.
fn json_str_match(b: &[u8], i: &mut usize, names: &[&str]) -> Option<Option<usize>> {
    *i += 1;
    debug_assert!(names.len() <= 64 && names.iter().all(|n| n.is_ascii()));
    let mut alive: u64 = if names.len() >= 64 { u64::MAX } else { (1u64 << names.len()) - 1 };
    let mut k = 0usize;
    let hex = |b: &[u8], i: &mut usize| -> Option<u32> {
        let h = std::str::from_utf8(b.get(*i..*i + 4)?).ok()?;
        *i += 4;
        u32::from_str_radix(h, 16).ok()
    };
    loop {
        let c: char = match *b.get(*i)? {
            b'"' => {
                *i += 1;
                return Some((0..names.len()).find(|&j| alive >> j & 1 == 1 && names[j].len() == k));
            }
            b'\\' => {
                *i += 1;
                let e = *b.get(*i)?;
                *i += 1;
                match e {
                    b'"' => '"',
                    b'\\' => '\\',
                    b'/' => '/',
                    b'b' => '\u{8}',
                    b'f' => '\u{c}',
                    b'n' => '\n',
                    b'r' => '\r',
                    b't' => '\t',
                    b'u' => {
                        let mut u = hex(b, i)?;
                        if (0xD800..0xDC00).contains(&u) && b.get(*i) == Some(&b'\\') && b.get(*i + 1) == Some(&b'u') {
                            *i += 2;
                            let lo = hex(b, i)?;
                            u = 0x10000 + ((u - 0xD800) << 10) + (lo.wrapping_sub(0xDC00) & 0x3FF);
                        }
                        char::from_u32(u).unwrap_or('\u{FFFD}')
                    }
                    _ => return None,
                }
            }
            _ => {
                // one UTF-8 character (req is a &str: boundaries are valid)
                let len = match b[*i] {
                    x if x < 0x80 => 1,
                    x if x >= 0xF0 => 4,
                    x if x >= 0xE0 => 3,
                    _ => 2,
                };
                let c = std::str::from_utf8(b.get(*i..*i + len)?).ok()?.chars().next()?;
                *i += len;
                c
            }
        };
        for (j, n) in names.iter().enumerate() {
            if alive >> j & 1 == 1 && n.as_bytes().get(k).map(|&x| x as u32) != Some(c as u32) {
                alive &= !(1u64 << j);
            }
        }
        k = k.saturating_add(1);
    }
}

/// Skip one JSON value at b[*i] (strings, objects and arrays by their
/// brackets, outside strings; scalars to the next delimiter), owning
/// nothing.  False if malformed.
fn json_skip(b: &[u8], i: &mut usize) -> bool {
    let mut depth = 0usize;
    loop {
        match b.get(*i) {
            None => return false,
            Some(b'"') => {
                if json_str_match(b, i, &[]).is_none() {
                    return false;
                }
                if depth == 0 {
                    return true;
                }
                continue;
            }
            Some(b'{') | Some(b'[') => depth += 1,
            Some(b'}') | Some(b']') => {
                if depth == 0 {
                    return true; // (a scalar ended by the enclosing bracket)
                }
                depth -= 1;
                if depth == 0 {
                    *i += 1;
                    return true;
                }
            }
            Some(b',') if depth == 0 => return true,
            _ => {}
        }
        *i += 1;
    }
}

fn u(v: &Value, k: &str) -> Result<u64, String> {
    v.get(k).and_then(Value::as_u64).ok_or_else(|| format!("missing integer argument '{}'", k))
}

/// A size argument (a count, a bound, a weight, a number of points) at most
/// `max`, so that it means the same on every target: usize is 32 bits in
/// WebAssembly, and an unchecked cast changed 2^32 to 0 there.
fn size(v: &Value, k: &str, default: Option<u64>, max: u64) -> Result<usize, String> {
    let x = match (v.get(k), default) {
        // (null is an absent argument: the default, or missing without one)
        (None | Some(Value::Null), Some(d)) => d,
        (None | Some(Value::Null), None) => return Err(format!("missing integer argument '{}'", k)),
        (Some(x), _) => x.as_u64().ok_or_else(|| format!("'{}' must be a nonnegative integer", k))?,
    };
    if x > max {
        return Err(format!("'{}' = {} is too large (at most {})", k, x, max));
    }
    usize::try_from(x).map_err(|_| format!("'{}' = {} is too large here", k, x))
}

/// The sign of a modular symbols space: -1, 0 or +1.
fn sign(v: &Value) -> Result<i32, String> {
    match v.get("sign").map(Value::as_i64) {
        None => Ok(0),
        Some(Some(s)) if (-1..=1).contains(&s) => Ok(s as i32),
        _ => Err("sign must be -1, 0 or 1".into()),
    }
}

/// What a class group result assumes: GRH; that the roots of unity found
/// are all, when that is not proven; and, when the analytic certificate
/// (h* R* below twice a proven lower bound for h R) did not go through,
/// the stopping rule's estimate of h R, which has no proven error bound.
fn assumes(w_proven: bool, certified: bool) -> Value {
    assumes_with(w_proven, certified, &[])
}

/// assumes, and the probable primes the maximal order's maximality assumes
/// prime (BPSW, above 2^64; the systematic review's NFD-F4).
fn assumes_with(w_proven: bool, certified: bool, primes: &[sagebrush_bigint::BigInt]) -> Value {
    let mut a: Vec<String> = vec!["GRH".into()];
    if !w_proven {
        a.push("the roots of unity found are all".into());
    }
    if !certified {
        a.push("h R is near its estimate (uncertified stopping rule)".into());
    }
    for p in primes {
        a.push(format!("{} is prime (Baillie-PSW)", p));
    }
    json!(a)
}

/// The level n >= 1.
fn level(v: &Value) -> Result<u64, String> {
    let n = u(v, "n")?;
    sagebrush_modsym::check_level(n)?;
    Ok(n)
}

/// The weight k >= 2 (default 2).
fn weight(v: &Value) -> Result<usize, String> {
    let k = size(v, "k", Some(2), (1 << 31) - 1).map_err(|_| "the weight must be an integer 2 <= k < 2^31".to_string())?;
    if k < 2 {
        return Err("the weight must be an integer 2 <= k < 2^31".into());
    }
    Ok(k)
}

/// A list of unsigned integers, every element checked.
fn u64s(v: &Value, what: &str) -> Result<Vec<u64>, String> {
    v.as_array().ok_or_else(|| format!("{} must be a list of nonnegative integers", what))?.iter()
        .map(|x| x.as_u64().ok_or_else(|| format!("{} must be a list of nonnegative integers", what)))
        .collect()
}

fn character(n: u64, v: &Value) -> Result<Character, String> {
    match v.get("chi") {
        None | Some(Value::Null) => Ok(Character::trivial(n)),
        Some(c) => {
            let bad = || "chi must be [order, gens, vals], gens and vals lists of the same length".to_string();
            let a = c.as_array().filter(|a| a.len() == 3).ok_or_else(bad)?;
            let order = a[0].as_u64().filter(|&o| o >= 1).ok_or_else(bad)?;
            let (gens, vals) = (u64s(&a[1], "gens")?, u64s(&a[2], "vals")?);
            if gens.len() != vals.len() {
                return Err(bad());
            }
            Character::from_generators(n, order, &gens, &vals)
        }
    }
}

fn curve(a: Option<&Value>) -> Result<sagebrush_ap::EllipticCurve, String> {
    let a: Vec<i64> = a.and_then(Value::as_array).ok_or("missing a")?.iter()
        .map(|x| x.as_i64().ok_or("a curve is [a1, a2, a3, a4, a6], integers"))
        .collect::<Result<_, _>>()?;
    let a: [i64; 5] = a.try_into().map_err(|_| "a curve is [a1, a2, a3, a4, a6]")?;
    sagebrush_ap::EllipticCurve::new(a)
}

fn exact_json(e: &sagebrush_modsym::exact::Exact) -> Value {
    json!({ "n": e.n, "q": e.q, "genus": e.genus, "cusps": e.cusps, "eisenstein": e.eis, "dim": e.dim,
            "charpoly": big(&e.coeffs), "primes_used": e.primes_used.len(), "bound_bits": e.bound_bits,
            "status": e.status, "checks": e.checks })
}

/// An optional nonnegative integer field of a request: None when absent or
/// null.
fn opt_u64(v: &Value, k: &str) -> Result<Option<u64>, String> {
    match v.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(x) => x.as_u64().map(Some).ok_or_else(|| format!("'{}' must be a nonnegative integer", k)),
    }
}

/// f within the request's optional "rounds": the session's opt-in
/// nf.relation_rounds (sent only when finite) for the class-group relation
/// searches, which are otherwise unlimited (classgroup::limits).
fn with_rounds<T>(v: &Value, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match opt_u64(v, "rounds")? {
        None => f(),
        Some(n) => sagebrush_classgroup::limits::with_round_limit(usize::try_from(n).unwrap_or(usize::MAX), f),
    }
}

fn bigs(v: Option<&Value>) -> Result<Vec<BigInt>, String> {
    // the compact wire format: "c0,c1,..." (sagebrush.linalg and poly send it)
    if let Some(Value::String(s)) = v {
        if s.is_empty() {
            return Ok(vec![]);
        }
        return s.split(',').map(|t| t.parse::<BigInt>().map_err(|e| e.to_string())).collect();
    }
    v.and_then(Value::as_array)
        .ok_or("missing integer list")?
        .iter()
        .map(|x| match x {
            Value::String(s) => s.parse::<BigInt>().map_err(|e| e.to_string()),
            Value::Number(n) => n.as_i64().map(BigInt::from).ok_or_else(|| "bad integer".to_string()),
            _ => Err("integers are numbers or decimal strings".to_string()),
        })
        .collect()
}

fn big1(v: Option<&Value>) -> Result<BigInt, String> {
    match v {
        Some(Value::String(s)) => s.parse::<BigInt>().map_err(|e| e.to_string()),
        Some(Value::Number(n)) => n.as_i64().map(BigInt::from).ok_or_else(|| "bad integer".to_string()),
        _ => Err("missing integer argument".into()),
    }
}

/// A matrix as rows, every row the same length.
fn rect(v: Option<&Value>) -> Result<Vec<Vec<BigInt>>, String> {
    let rows = matrix(v)?;
    if rows.iter().any(|r| r.len() != rows[0].len()) {
        return Err("matrix rows of different lengths".into());
    }
    Ok(rows)
}

fn matrix(v: Option<&Value>) -> Result<Vec<Vec<BigInt>>, String> {
    // compact: rows separated by ';' ("" is the matrix with no rows)
    if let Some(Value::String(s)) = v {
        if s.is_empty() {
            return Ok(vec![]);
        }
        return s.split(';').map(|r| bigs(Some(&Value::String(r.to_string())))).collect();
    }
    v.and_then(Value::as_array).ok_or("missing matrix (a list of rows)")?.iter().map(|r| bigs(Some(r))).collect()
}

/// A matrix argument (rows of integers) as a ZMat; every row the same length.
fn zmat(v: Option<&Value>) -> Result<sagebrush_arith::zmat::ZMat, String> {
    let rows = matrix(v)?;
    let c = rows.first().map_or(0, |r| r.len());
    if rows.iter().any(|r| r.len() != c) {
        return Err("matrix rows of different lengths".into());
    }
    let r = rows.len();
    Ok(sagebrush_arith::zmat::ZMat { rows: r, cols: c, d: rows.into_iter().flatten().collect() })
}

/// A matrix result: rows of decimal strings, or with "wire": "csv" one
/// string "a,b;c,d".
fn zrows(m: &sagebrush_arith::zmat::ZMat, v: &Value) -> Value {
    if csv(v) {
        return json!((0..m.rows).map(|i| m.row(i).iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")).collect::<Vec<_>>().join(";"));
    }
    json!((0..m.rows).map(|i| big(m.row(i))).collect::<Vec<_>>())
}

/// A vector result in the requested wire format.
fn zvec(x: &[BigInt], v: &Value) -> Value {
    if csv(v) {
        return json!(x.iter().map(|c| c.to_string()).collect::<Vec<_>>().join(","));
    }
    json!(big(x))
}

/// nmod_charpoly's admission (checked in this order): the whole request at
/// most NMOD_MAX_REQUEST bytes, before serde parses it (`call`); its matrix
/// text at most NMOD_MAX_BYTES; at most NMOD_MAX_N rows, counted without
/// allocating; then exactly n entries per row.  The peak live memory of an
/// admitted call, everything that coexists in sb_call (n <= 512):
///   the request bytes (sb_alloc)                       <= 5.25 MiB
///   serde's Value, its "m" string and the rest           <= 5.25 MiB + 4 KiB
///   the flat entries, 8 n^2                             = 2 MiB
///   the charpoly, doubled for allocator rounding: Krylov, its
///     n x (n + 1) matrix and two vectors, 2 * 8 n (n + 3) ~ 4 MiB; or
///     Hessenberg, its copy 8 n^2 plus the n + 1 prefix polynomials
///     8 n (n + 1) / 2 + 24 (n + 1), 2 * (2 + 1) MiB      <= 6.1 MiB
///   the result, its strings and the reply, ~60 (n + 1)  < 32 KiB
/// in all under 19 MiB beyond the engine's resident heap (the wasm test
/// test/nmod-charpoly-wasm.test.ts measures the growth on both paths); the
/// work is cubic, at most about n^3 = 2^27 multiply-adds, polled for Stop
/// every 2^16.
pub const NMOD_MAX_N: usize = 512;
/// At most 19 digits and one separator per entry below 2^63.
pub const NMOD_MAX_BYTES: usize = NMOD_MAX_N * NMOD_MAX_N * 20 + NMOD_MAX_N;
/// The matrix text plus the other fields.
pub const NMOD_MAX_REQUEST: usize = NMOD_MAX_BYTES + 4096;

/// The square matrix of nmod_charpoly's request: checked sizes first (the
/// text, then the row count by a scan that allocates nothing), then the
/// entries parsed into one flat vector of n^2 words reserved up front,
/// polling for Stop row by row.
fn nmod_square(s: &str, p: u64) -> Result<(usize, Vec<u64>), String> {
    if s.len() > NMOD_MAX_BYTES {
        return Err(format!("nmod_charpoly: the matrix text has {} bytes, more than {}", s.len(), NMOD_MAX_BYTES));
    }
    let n = if s.is_empty() { 0 } else { s.bytes().filter(|&c| c == b';').count() + 1 };
    if n > NMOD_MAX_N {
        return Err(format!("nmod_charpoly: {} rows, more than {}", n, NMOD_MAX_N));
    }
    let mut d: Vec<u64> = Vec::with_capacity(n * n);
    for r in s.split(';').filter(|_| n > 0) {
        sagebrush_interrupt::check_coarse();
        let mut count = 0;
        for t in r.split(',') {
            count += 1;
            if count > n {
                return Err("nmod_charpoly of a non-square matrix".into());
            }
            match t.parse::<u64>() {
                Ok(x) if x < p => d.push(x),
                _ => return Err("nmod_charpoly: entries must be integers in [0, p)".into()),
            }
        }
        if count != n {
            return Err("nmod_charpoly of a non-square matrix".into());
        }
    }
    Ok((n, d))
}

fn csv(v: &Value) -> bool {
    v.get("wire").and_then(Value::as_str) == Some("csv")
}

fn big(v: &[BigInt]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// The number field of "t" (monic integer coefficients, constant first).
fn nf_field(v: &Value) -> Result<sagebrush_poly::nf::Field, String> {
    sagebrush_poly::nf::Field::new(&bigs(v.get("t"))?)
}

/// A polynomial over the field: {"num": [[coordinates], ...], "den": d}.
fn kpoly(v: Option<&Value>, n: usize) -> Result<sagebrush_poly::nf::KPoly, String> {
    let v = v.ok_or("missing polynomial")?;
    let num = v.get("num").and_then(Value::as_array).ok_or("a polynomial needs \"num\"")?;
    let num: Vec<Vec<BigInt>> = num.iter().map(|c| bigs(Some(c))).collect::<Result<_, _>>()?;
    if num.iter().any(|c| c.len() > n) {
        return Err(format!("each coefficient has at most {} coordinates", n));
    }
    let den = big1(v.get("den"))?;
    if den.sign() == sagebrush_bigint::Sign::NoSign {
        return Err("zero denominator".into());
    }
    Ok(sagebrush_poly::nf::KPoly::new(n, num, den))
}

fn kpoly_json(f: &sagebrush_poly::nf::KPoly) -> Value {
    json!({ "num": f.num.iter().map(|c| big(c)).collect::<Vec<_>>(), "den": f.den.to_string() })
}

// ---------------------------------------------------------------- permutation groups

fn perms(n: usize, v: Option<&Value>) -> Result<Vec<sagebrush_group::Perm>, String> {
    let arr = match v {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(a) => a.as_array().ok_or("permutations are lists of images")?,
    };
    arr.iter()
        .map(|p| {
            let im: Vec<u32> = p.as_array().ok_or("a permutation is a list of images")?.iter().map(|x| x.as_u64().and_then(|x| u32::try_from(x).ok()).ok_or("images are point numbers")).collect::<Result<_, _>>()?;
            if im.len() != n {
                return Err(format!("a permutation of {} points, not {}", im.len(), n));
            }
            sagebrush_group::Perm::from_images(im)
        })
        .collect()
}

fn perm_json(gs: &[sagebrush_group::Perm]) -> Value {
    json!(gs.iter().map(|g| g.0.clone()).collect::<Vec<_>>())
}

/// {"fn": "perm_group", "n": n, "gens": [images...], "what": [...]} -> one
/// answer per requested property (points are 0..n-1).
fn perm_group(v: &Value) -> Result<Value, String> {
    use sagebrush_group::{Group, Rng};
    let n = size(v, "n", None, 1 << 20)?;
    let gens = perms(n, v.get("gens"))?;
    let g = Group::new(n, gens)?;
    let what: Vec<String> = match v.get("what") {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(String::from).ok_or("what must be names")).collect::<Result<_, _>>()?,
        _ => vec!["order".into()],
    };
    let point = || -> Result<u32, String> { v.get("point").and_then(Value::as_u64).filter(|&x| x < n as u64).map(|x| x as u32).ok_or_else(|| "missing or bad point".to_string()) };
    let mut rng = Rng::new(v.get("seed").and_then(Value::as_u64).unwrap_or(1));
    let mut out = serde_json::Map::new();
    for w in &what {
        let r = match w.as_str() {
            "order" => json!(g.order().to_string()),
            "orbits" => json!(g.orbits()),
            "orbit" => json!(g.orbit(point()?)),
            "is_transitive" => json!(g.is_transitive()),
            "is_primitive" => json!(g.is_primitive()),
            "is_abelian" => json!(g.is_abelian()),
            "is_solvable" => json!(g.is_solvable()),
            "transitivity" => json!(g.transitivity()),
            "blocks" => json!(g.blocks_containing(v.get("point").and_then(Value::as_u64).filter(|&x| x < n as u64).ok_or("bad point")? as u32)),
            "min_block" => {
                let seed: Vec<u32> = u64s(v.get("block").ok_or("missing block")?, "block")?.into_iter().map(|x| if x < n as u64 { Ok(x as u32) } else { Err("a block is a list of points") }).collect::<Result<_, _>>()?;
                if seed.is_empty() || seed.iter().any(|&x| x as usize >= n) {
                    return Err("bad block".into());
                }
                json!(g.min_block(&seed))
            }
            "block_system" => {
                let b: Vec<u32> = u64s(v.get("block").ok_or("missing block")?, "block")?.into_iter().map(|x| u32::try_from(x).ok().filter(|&x| (x as usize) < n).ok_or("a block is a list of points")).collect::<Result<_, _>>()?;
                json!(g.block_system(&b))
            }
            "stabilizer" => {
                let s = g.stabilizer(point()?);
                json!({"gens": perm_json(&s.gens), "order": s.order().to_string()})
            }
            "normal_closure" => {
                let x = perms(n, v.get("sub"))?;
                let c = g.normal_closure(&x);
                json!({"gens": perm_json(&c.gens), "order": c.order().to_string()})
            }
            "derived_subgroup" => {
                let d = g.derived_subgroup();
                json!({"gens": perm_json(&d.gens), "order": d.order().to_string()})
            }
            "derived_series" => json!(g.derived_series().iter().map(|d| json!({"gens": perm_json(&d.gens), "order": d.order().to_string()})).collect::<Vec<_>>()),
            "contains" => {
                let x = perms(n, Some(&json!([v.get("g").ok_or("missing g")?])))?;
                json!(g.contains(&x[0]))
            }
            "random" => {
                let k = size(v, "count", Some(1), 1 << 20)?;
                perm_json(&(0..k).map(|_| g.random(&mut rng)).collect::<Vec<_>>())
            }
            "elements" => {
                let limit = v.get("limit").and_then(Value::as_u64).unwrap_or(100_000);
                match g.elements(limit) {
                    Some(es) => perm_json(&es),
                    None => return Err(format!("the group has more than {} elements", limit)),
                }
            }
            "cycle_type_counts" => {
                let limit = v.get("limit").and_then(Value::as_u64).unwrap_or(200_000);
                let samples = size(v, "samples", Some(10_000), 1 << 26)?;
                let (c, exact) = g.cycle_type_counts(limit, samples, &mut rng);
                json!({"exact": exact, "counts": c.into_iter().map(|(t, k)| json!([t, k])).collect::<Vec<_>>()})
            }
            "is_normal" => {
                let sub = Group::new(n, perms(n, v.get("sub"))?)?;
                json!(g.contains_group(&sub) && g.is_normal(&sub))
            }
            "is_subgroup" => {
                // is the group generated by "sub" a subgroup of this one?
                let sub = Group::new(n, perms(n, v.get("sub"))?)?;
                json!(g.contains_group(&sub))
            }
            "base" => json!(g.chain.base()),
            "strong_gens" => perm_json(&g.chain.strong_gens()),
            other => return Err(format!("unknown permutation group property {}", other)),
        };
        out.insert(w.clone(), r);
    }
    Ok(Value::Object(out))
}

/// {"fn": "perm_group_named", "name": ..., "n": n} -> {"n", "gens"}
fn perm_group_named(v: &Value) -> Result<Value, String> {
    use sagebrush_group::named::*;
    let n = size(v, "n", None, 1 << 20)? as u64;
    let name = v.get("name").and_then(Value::as_str).ok_or("missing name")?;
    let g = match name {
        "symmetric" => symmetric(n as usize),
        "alternating" => alternating(n as usize),
        "cyclic" => cyclic(n as usize),
        "dihedral" => dihedral(n as usize),
        "mathieu" => mathieu(n as usize)?,
        "agl1" => agl1(n)?,
        "psl2" => pl2(n, false)?,
        "pgl2" => pl2(n, true)?,
        _ => return Err(format!("unknown group {}", name)),
    };
    Ok(json!({"n": g.n, "gens": perm_json(&g.gens)}))
}

fn dispatch(v: &Value) -> Result<Value, String> {
    let f = v.get("fn").and_then(Value::as_str).ok_or("missing fn")?;
    match f {
        // ---- Hilbert modular forms over Q(sqrt 5): engine/hmf (hmf.rs) ----
        f if f.starts_with("hmf_") => hmf::dispatch(f, v),
        f if f.starts_with("hmfq_") => hmfq::dispatch(f, v),
        "progress_tables" => serde_json::from_str(&sagebrush_interrupt::progress::tables_json()).map_err(|e| e.to_string()),
        "progress_selftest" => progress_selftest(v),
        "perm_group" => perm_group(v),
        "perm_group_named" => perm_group_named(v),
        "characters" => {
            let n = level(v)?;
            if n > 10_000_000 {
                return Err("characters: the modulus must be at most 10^7".into());
            }
            let g = DirichletGroup::new(n);
            let mut seen = vec![false; g.order() as usize];
            let mut out = vec![];
            for c in 0..g.order() {
                if seen[c as usize] {
                    continue;
                }
                let vec = g.vector(c);
                let chi = g.character(&vec);
                for j in 1..=chi.order {
                    if sagebrush_modsym::p1::gcd(j, chi.order) == 1 {
                        let w: Vec<u64> = vec.iter().map(|&x| x * j).collect();
                        seen[g.index(&w) as usize] = true;
                    }
                }
                let vals: Vec<u64> = g.gens.iter().map(|&x| chi.exponent(x as i64).unwrap() as u64).collect();
                out.push(json!({ "order": chi.order, "conductor": chi.conductor(), "even": chi.is_even(),
                                 "gens": g.gens.clone(), "vals": vals.clone(), "chi": [chi.order, g.gens.clone(), vals] }));
            }
            Ok(json!(out))
        }
        "dims" => {
            use sagebrush_modsym::dims::*;
            let (n, k) = (level(v)?, weight(v)?);
            let eps = character(n, v)?.minimal();
            // dim S^new(N) = sum over M (cond | M | N) of beta(N/M) dim S(M), beta = mu * mu.
            let f = eps.conductor();
            let beta = |x: u64| -> i64 {
                sagebrush_modsym::exact::factor(x).iter().map(|&(_, e)| match e { 1 => -2, 2 => 1, _ => 0 }).product()
            };
            let new: i64 = (1..=n).filter(|m| n % m == 0 && m % f == 0).map(|m| beta(n / m) * dim_cusp_forms(&eps.restrict(m), k) as i64).sum();
            Ok(json!({ "order": eps.order, "conductor": f, "cusp": dim_cusp_forms(&eps, k),
                       "eisenstein": dim_eisenstein(&eps, k), "modsym": dim_modsym(&eps, k), "new": new }))
        }
        "charpoly" => {
            let (n, k, q) = (level(v)?, weight(v)?, u(v, "q")?);
            let sign = sign(v)?;
            let eps = character(n, v)?;
            let e = sagebrush_modsym::general_exact::exact_charpoly(n, k, &eps, sign, q)?;
            let coeffs: Vec<Vec<String>> = e.coeffs.iter().map(|c| big(c)).collect();
            Ok(json!({ "m": e.m, "dim": e.dim, "coeffs": coeffs, "primes_used": e.primes_used.len(), "status": e.status, "checks": e.checks }))
        }
        "charpoly_mod" => {
            let (n, k, q) = (level(v)?, weight(v)?, u(v, "q")?);
            let sign = sign(v)?;
            let eps = character(n, v)?.minimal();
            let sp = GeneralSpace::new(n, k, &eps, sign)?;
            Ok(json!({ "dim": sp.dimension(), "ell": sp.p, "zeta": sp.zeta, "charpoly": sp.hecke_charpoly(q)? }))
        }
        // ---- sagebrush.modsym: weight 2, trivial character, sign +1 ----
        "ec_modsym" => {
            let n = level(v)?;
            let pair = |x: &Value, what: &str| -> Result<(i64, i64), String> {
                let a = x.as_array().filter(|a| a.len() == 2).ok_or_else(|| format!("each {} must be a pair", what))?;
                let f = |y: &Value| y.as_i64().or_else(|| y.as_str().and_then(|s| s.parse().ok())).ok_or_else(|| format!("each {} must be a pair of integers", what));
                Ok((f(&a[0])?, f(&a[1])?))
            };
            let list = |k: &str| -> Result<Vec<(i64, i64)>, String> {
                v.get(k).and_then(Value::as_array).ok_or_else(|| format!("missing list '{}'", k))?.iter().map(|x| pair(x, k)).collect()
            };
            let aps: Vec<(u64, i64)> = list("aps")?.into_iter().map(|(q, a)| if q > 1 { Ok((q as u64, a)) } else { Err("each a_q needs a prime q".to_string()) }).collect::<Result<_, _>>()?;
            let (zero, cycles, vals) = sagebrush_modsym::ec_modsym_values(n, &aps, &list("cusps")?)?;
            Ok(json!({ "zero": zero.to_string(), "cycles": cycles.to_string(), "values": vals.iter().map(|x| x.to_string()).collect::<Vec<_>>() }))
        }
        "hecke_charpoly" => {
            let (n, q) = (level(v)?, u(v, "q")?);
            let p = u(v, "p").unwrap_or(67108859);
            let r = sagebrush_modsym::hecke_charpoly(n, q, p)?;
            Ok(json!({ "symbols": r.symbols, "gens": r.gens, "dim": r.dim, "charpoly": r.charpoly, "hash": r.hash(),
                       "eisenstein_root": r.eisenstein_root(), "ms": r.ms.to_vec() }))
        }
        "weight2" | "charpoly_exact" => Ok(exact_json(&sagebrush_modsym::exact::exact_charpoly(level(v)?, u(v, "q")?)?)),
        "batch_exact" => {
            let levels = u64s(v.get("levels").ok_or("missing levels")?, "levels")?;
            levels.iter().try_for_each(|&n| sagebrush_modsym::check_level(n))?;
            let q = u(v, "q")?;
            let rs = sagebrush_modsym::exact::batch_exact(&levels, q);
            Ok(json!(levels.iter().zip(rs).map(|(&n, r)| match r {
                Ok(e) => exact_json(&e),
                Err(e) => json!({ "n": n, "error": e }),
            }).collect::<Vec<_>>()))
        }
        "level_data" => {
            let (psi, g, c, e, dim) = sagebrush_modsym::exact::level_data(level(v)?);
            Ok(json!({ "psi": psi, "genus": g, "cusps": c, "eisenstein": e, "dim": dim }))
        }
        "commute" => {
            let p = u(v, "p").unwrap_or(67108859);
            Ok(json!(sagebrush_modsym::hecke_commute(level(v)?, u(v, "q")?, u(v, "r")?, p)?))
        }
        "estimate" => {
            let (n, q) = (level(v)?, u(v, "q")?);
            sagebrush_modsym::validate(n, q, None)?;
            let e = sagebrush_modsym::estimate::estimate(n, q);
            Ok(json!({ "symbols": e.symbols, "dim": e.dim, "genus": e.genus, "primes": e.primes, "primes_max": e.primes_max,
                       "bytes_modp": e.bytes_modp, "bytes_exact": e.bytes_exact, "seconds_modp": e.seconds_modp,
                       "seconds_exact": e.seconds_exact }))
        }
        "estimate_newforms" => {
            let e = sagebrush_modsym::estimate::newforms(level(v)?, weight(v)?, size(v, "bound", Some(100), 1 << 24)?);
            Ok(json!({ "n": e.n, "k": e.k, "bound": e.bound, "dim_new": e.dim_new, "dim_top": e.dim_top, "levels": e.levels, "symbols": e.symbols,
                       "primes": e.primes, "trace_primes": e.trace_primes, "terms": e.terms, "term_names": sagebrush_modsym::estimate::NEWFORMS_TERMS,
                       "seconds": e.seconds, "seconds_low": e.seconds_low, "seconds_high": e.seconds_high, "bytes": e.bytes }))
        }
        "rational_newforms" => {
            let r = sagebrush_modsym::newforms::rational_newforms(level(v)?, u(v, "bound").unwrap_or(1000), 40)?;
            let forms = json!(r.forms.into_iter().map(|f| f.ap).collect::<Vec<_>>());
            // "details": what the forms come with (checked, not proven)
            Ok(if v.get("details").and_then(Value::as_bool) == Some(true) {
                json!({ "forms": forms, "status": r.status, "checks": r.checks })
            } else {
                forms
            })
        }
        // ---- sagebrush.nf / arith / matrix: engine/classgroup ----
        "factor_integer" => {
            let n = big1(v.get("n"))?;
            if n.sign() == sagebrush_bigint::Sign::NoSign {
                return Err("factor of 0".into());
            }
            Ok(json!(sagebrush_classgroup::api::factor_integer(&n)?.iter().map(|(p, e)| json!([p.to_string(), e])).collect::<Vec<_>>()))
        }
        "is_prime" => Ok(json!(sagebrush_classgroup::api::is_prime(&big1(v.get("n"))?))),
        "nf_data" => {
            let d = sagebrush_classgroup::api::nf_data(&bigs(v.get("f"))?)?;
            Ok(json!({ "degree": d.degree, "r1": d.r1, "r2": d.r2, "disc": d.disc.to_string(), "index": d.index.to_string(),
                       "basis": d.basis.iter().map(|r| big(r)).collect::<Vec<_>>(), "den": d.den.to_string(), "w": d.w, "w_proven": d.w_proven,
                       "assumes": d.assumed_primes.iter().map(|p| format!("{} is prime (Baillie-PSW)", p)).collect::<Vec<_>>() }))
        }
        "primes_above" => {
            let ps = sagebrush_classgroup::api::primes_above(&bigs(v.get("f"))?, u(v, "p")?)?;
            Ok(json!(ps.iter().map(|q| {
                let mut o = json!({ "p": q.p, "e": q.e, "f": q.f, "pi": big(&q.pi), "pi_den": q.pi_den.to_string() });
                if !q.assumed_primes.is_empty() {
                    o["assumes"] = json!(q.assumed_primes.iter().map(|p| format!("{} is prime (Baillie-PSW)", p)).collect::<Vec<_>>());
                }
                o
            }).collect::<Vec<_>>()))
        }
        "bnf" => {
            let f = bigs(v.get("f"))?;
            let b = with_rounds(&v, || sagebrush_classgroup::api::bnf(&f))?;
            Ok(json!({ "degree": b.degree, "r1": b.r1, "r2": b.r2, "disc": b.disc.to_string(), "h": b.h.to_string(),
                       "cyc": big(&b.cyc), "regulator": b.regulator, "w": b.w, "w_proven": b.w_proven, "certified": b.certified, "assumes": assumes_with(b.w_proven, b.certified, &b.assumed_primes) }))
        }
        "bnf_certify" => {
            let opt = |k: &str| -> Result<Option<u64>, String> {
                match v.get(k) {
                    None | Some(Value::Null) => Ok(None),
                    Some(x) => x.as_u64().map(Some).ok_or_else(|| format!("'{}' must be a nonnegative integer", k)),
                }
            };
            let b = sagebrush_classgroup::api::bnf_certify(&bigs(v.get("f"))?, opt("norm_max")?, opt("index_max")?)?;
            Ok(json!({ "degree": b.degree, "r1": b.r1, "r2": b.r2, "disc": b.disc.to_string(), "h": b.h.to_string(),
                       "cyc": big(&b.cyc), "regulator": b.regulator, "w": b.w,
                       "norm_bound": b.norm_bound.to_string(), "norm_bound_kind": b.norm_bound_kind, "fb_bound": b.fb_bound,
                       "primes_shown": b.primes_shown, "reg_lower": b.reg_lower, "index_bound": b.index_bound,
                       "unit_primes": b.unit_primes, "class_primes": big(&b.class_primes) }))
        }
        "bnf_relations" => {
            let bad = || "extra must be a list of primes".to_string();
            let extra: Vec<u64> = match v.get("extra") {
                None | Some(Value::Null) => vec![],
                Some(e) => e.as_array().ok_or_else(bad)?.iter()
                    .map(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())).ok_or_else(bad))
                    .collect::<Result<_, _>>()?,
            };
            let f = bigs(v.get("f"))?;
            let d = with_rounds(&v, || sagebrush_classgroup::api::bnf_relations(&f, &extra))?;
            let b = &d.bnf;
            Ok(json!({ "degree": b.degree, "r1": b.r1, "r2": b.r2, "disc": b.disc.to_string(), "h": b.h.to_string(),
                       "cyc": big(&b.cyc), "regulator": b.regulator, "w": b.w, "w_proven": b.w_proven, "certified": b.certified, "assumes": assumes_with(b.w_proven, b.certified, &b.assumed_primes),
                       "fb": d.fb.iter().map(|&(p, e, f)| json!([p, e, f])).collect::<Vec<_>>(),
                       "rels": d.rels.iter().map(|r| r.iter().map(|&(i, k)| json!([i, k])).collect::<Vec<_>>()).collect::<Vec<_>>(),
                       "elems": d.elems.iter().map(|(num, den)| json!([big(num), den.to_string()])).collect::<Vec<_>>() }))
        }
        "quadratic_class_group" => {
            // certify (default true): false skips the analytic certificate,
            // leaving the result conditional, like PARI's quadclassunit
            let certify = match v.get("certify") {
                None | Some(Value::Null) => true,
                Some(Value::Bool(b)) => *b,
                Some(x) => return Err(format!("certify must be true or false, not {}", x)),
            };
            let d = big1(v.get("d"))?;
            let (h, cyc, reg, certified) = with_rounds(&v, || sagebrush_classgroup::api::quadratic_with(&d, certify))?;
            let status = if certified { "certified (assuming GRH)" } else { "conditional on GRH and the stopping rule's estimate, not certified" };
            Ok(json!({ "h": h.to_string(), "cyc": big(&cyc), "regulator": reg, "certified": certified, "status": status, "assumes": assumes(true, certified) }))
        }
        "hermite_form" => Ok(json!(sagebrush_classgroup::api::hermite(&rect(v.get("m"))?).iter().map(|r| big(r)).collect::<Vec<_>>())),
        "elementary_divisors" => Ok(json!(big(&sagebrush_classgroup::api::elementary_divisors(&rect(v.get("m"))?)))),
        "lll" => Ok(json!(sagebrush_classgroup::api::lll(&rect(v.get("m"))?).iter().map(|r| big(r)).collect::<Vec<_>>())),
        "complex_roots" => {
            let digits = size(v, "digits", Some(15), 100_000)?;
            let r = sagebrush_classgroup::api::complex_roots(&bigs(v.get("f"))?, digits)?;
            Ok(json!(r.iter().map(|(re, im, e)| json!([re, im, e])).collect::<Vec<_>>()))
        }
        "factor_mod" => {
            let f = bigs(v.get("f"))?;
            let p = u(v, "p")?;
            if !(2..1u64 << 32).contains(&p) || !sagebrush_modsym::exact::is_prime(p) {
                return Err(format!("factor_mod needs a prime p < 2^32, not {}", p));
            }
            // (zero modulo p, not only over Z: [4, 8, 4] mod 2 trapped)
            let bp = BigInt::from(p);
            if f.iter().all(|c| (c % &bp).sign() == sagebrush_bigint::Sign::NoSign) {
                return Err("factor of the zero polynomial (modulo p)".into());
            }
            Ok(json!(sagebrush_poly::factor_mod(&f, p).iter().map(|(g, e)| json!([g, e])).collect::<Vec<_>>()))
        }
        // ---- Galois groups over Q and the transitive groups nTk (engine/galois) ----
        "galois_group" => {
            let f = bigs(v.get("f"))?;
            let proof = match v.get("proof") {
                Some(Value::Bool(true)) => sagebrush_galois::Proof::Always,
                Some(Value::Bool(false)) => sagebrush_galois::Proof::Never,
                _ => sagebrush_galois::Proof::WhenCheap,
            };
            let g = sagebrush_galois::galois_group_with(&f, proof)?;
            let t = &sagebrush_galois::tables::transitive_groups(g.degree)[g.number - 1];
            Ok(json!({ "n": g.degree, "k": g.number, "order": g.order.to_string(), "name": g.name, "proven": g.proven,
                       "log": g.log, "gens": perm_json(&t.gens) }))
        }
        "transitive_group" => {
            let n = size(v, "n", None, 1 << 20)?;
            if !sagebrush_galois::tables::supported(n) {
                return Err(format!("transitive groups are available for degrees 1 to 13, 17, 19 and 23, not {}", n));
            }
            let all = sagebrush_galois::tables::transitive_groups(n);
            match v.get("k").and_then(Value::as_u64) {
                None => Ok(json!(all.len())),
                Some(k) if k >= 1 && k <= all.len() as u64 => {
                    let t = &all[k as usize - 1];
                    Ok(json!({ "n": n, "k": k, "order": t.order.to_string(), "name": t.name, "gens": perm_json(&t.gens) }))
                }
                Some(k) => Err(format!("there are {} transitive groups of degree {}, not {}", all.len(), n, k)),
            }
        }
        // ---- sagebrush.poly: factoring in Z[x] (pure Rust) ----
        "factor" => {
            let f = bigs(v.get("f"))?;
            if f.iter().all(|c| c.sign() == sagebrush_bigint::Sign::NoSign) {
                return Err("factor of the zero polynomial".into());
            }
            // "work": the session's opt-in poly.work (sent only when finite);
            // otherwise the default, which limits only memory
            let r = match opt_u64(&v, "work")? {
                None => sagebrush_poly::try_factor(&f),
                Some(w) => sagebrush_poly::try_factor_with(&f, &sagebrush_poly::Budget::new(sagebrush_poly::Limits { work: w, ..sagebrush_poly::Limits::DEFAULT })),
            };
            let (c, fs) = r.map_err(|e| e.to_string())?;
            Ok(json!({ "content": c.to_string(), "factors": fs.iter().map(|(g, e)| json!([big(g), e])).collect::<Vec<_>>() }))
        }
        // ---- polynomials over a number field Q[y]/(T), T monic (poly/src/nf.rs) ----
        "nf_factor" => {
            let k = nf_field(v)?;
            let f = kpoly(v.get("f"), k.degree())?;
            let ((u, d), fs) = k.factor(&f)?;
            Ok(json!({ "unit": { "num": [big(&u)], "den": d.to_string() },
                       "factors": fs.iter().map(|(g, e)| json!([kpoly_json(g), e])).collect::<Vec<_>>() }))
        }
        "nf_gcd" => {
            let k = nf_field(v)?;
            let (f, g) = (kpoly(v.get("f"), k.degree())?, kpoly(v.get("g"), k.degree())?);
            let (h, _, _) = k.gcd(&f, &g)?;
            Ok(json!({ "gcd": kpoly_json(&h) }))
        }
        // ---- sagebrush.linalg: exact matrices over Z (and Q, scaled) ----
        "mat_det" => {
            let a = zmat(v.get("m"))?;
            if a.rows != a.cols {
                return Err("mat_det of a non-square matrix".into());
            }
            Ok(json!(sagebrush_arith::zmat::det(&a).to_string()))
        }
        "mat_rank" => Ok(json!(sagebrush_arith::zmat::rank(&zmat(v.get("m"))?))),
        "mat_rref" => {
            let (n, den, piv) = sagebrush_arith::zmat::rref(&zmat(v.get("m"))?);
            Ok(json!({ "rows": zrows(&n, v), "den": den.to_string(), "pivots": piv }))
        }
        "mat_solve" => {
            let a = zmat(v.get("a"))?;
            let b = zmat(v.get("b"))?;
            if a.rows != a.cols || a.rows != b.rows {
                return Err("mat_solve needs a square matrix and a right-hand side with as many rows".into());
            }
            Ok(match sagebrush_arith::zmat::solve(&a, &b) {
                None => Value::Null,
                Some((x, den)) => json!({ "rows": zrows(&x, v), "den": den.to_string() }),
            })
        }
        "mat_inverse" => {
            let a = zmat(v.get("m"))?;
            if a.rows != a.cols {
                return Err("mat_inverse of a non-square matrix".into());
            }
            Ok(match sagebrush_arith::zmat::inverse(&a) {
                None => Value::Null,
                Some((x, den)) => json!({ "rows": zrows(&x, v), "den": den.to_string() }),
            })
        }
        "mat_charpoly" => {
            let a = zmat(v.get("m"))?;
            if a.rows != a.cols {
                return Err("mat_charpoly of a non-square matrix".into());
            }
            Ok(zvec(&sagebrush_arith::zmat::charpoly(&a), v))
        }
        "nmod_charpoly" => {
            // m: rows "a,b;c,d" of entries in [0, p), p a prime below 2^63
            // (decimal string) -> the coefficients of det(x I - m) mod p,
            // constant term first
            let p = v.get("p").and_then(Value::as_str).and_then(|s| s.parse::<u64>().ok());
            let Some(p) = p.filter(|&p| p < 1 << 63 && sagebrush_bigint::nmod::is_prime(p)) else {
                return Err("nmod_charpoly needs a prime p below 2^63".into());
            };
            let Some(Value::String(s)) = v.get("m") else {
                return Err("nmod_charpoly needs the rows of m".into());
            };
            let (n, d) = nmod_square(s, p)?;
            let m = sagebrush_bigint::nmod::Modulus::new(p);
            let c = sagebrush_arith::nmod_mat::Mat { rows: n, cols: n, m, d }.charpoly();
            let s = c.iter().map(|x| x.to_string()).collect::<Vec<_>>();
            Ok(if csv(v) { json!(s.join(",")) } else { json!(s) })
        }
        "ntt_cache_stats" => {
            // (the shared transform cache: calls so far, tables, bytes; the
            // tests check that the nmod ops leave it alone)
            let (calls, count, bytes) = sagebrush_bigint::ntt::cache_stats();
            Ok(json!([calls, count, bytes]))
        }
        "mat_kernel" => Ok(zrows(&sagebrush_arith::zmat::kernel(&zmat(v.get("m"))?), v)),
        "mat_mul" => {
            let (a, b) = (zmat(v.get("a"))?, zmat(v.get("b"))?);
            if a.cols != b.rows {
                return Err("mat_mul: matrices of incompatible sizes".into());
            }
            Ok(zrows(&a.mul(&b), v))
        }
        // ---- sagebrush.poly: products and gcds in Z[x] ----
        "poly_mul" => Ok(zvec(
            &sagebrush_arith::zpoly::mul(&sagebrush_arith::zpoly::trim(bigs(v.get("a"))?), &sagebrush_arith::zpoly::trim(bigs(v.get("b"))?)),
            v,
        )),
        "poly_gcd" => Ok(zvec(&sagebrush_arith::zpoly::gcd(&bigs(v.get("a"))?, &bigs(v.get("b"))?), v)),
        "poly_divexact" => {
            let a = sagebrush_arith::zpoly::trim(bigs(v.get("a"))?);
            let b = sagebrush_arith::zpoly::trim(bigs(v.get("b"))?);
            if b.is_empty() {
                return Err("division by zero polynomial".into());
            }
            Ok(sagebrush_arith::zpoly::divexact(&a, &b).map_or(Value::Null, |q| zvec(&q, v)))
        }
        // ---- sagebrush.mf: Galois orbits of newforms, factored here ----
        "newspace" | "newforms" => {
            let (n, k) = (level(v)?, weight(v)?);
            let eps = character(n, v)?;
            let factor = |f: &[BigInt]| sagebrush_poly::try_factor(f).map(|r| r.1);
            let r = keeping_internal(&factor, |fac| sagebrush_modsym::newspace::newspace_orbits(n, k, &eps, fac))?;
            let mut out = json!({ "dim": r.dim, "order": r.m, "orbit_dims": r.dims, "orbit_charpolys": r.orbits.iter().map(|o| big(o)).collect::<Vec<_>>(),
                                  "T": r.ops, "status": r.status, "checks": r.checks });
            if f == "newforms" {
                let bound = size(v, "bound", Some(100), 1 << 24)?;
                if bound < 1 {
                    return Err("bound must be at least 1".into());
                }
                // LMFDB order: by dimension, then trace form
                let orbits = sagebrush_modsym::traces::labelled_orbits(n, k, &eps, &r, bound)?;
                out["newforms"] = json!(orbits.iter().enumerate().map(|(i, (dim, t, u))| {
                    let mut x = i;
                    let mut s = vec![];
                    loop {
                        s.push((b'a' + (x % 26) as u8) as char);
                        x /= 26;
                        if x == 0 {
                            break;
                        }
                    }
                    let letter: String = s.iter().rev().collect();
                    json!({ "letter": letter, "dim": dim, "traces": big(t), "charpoly": big(u) })
                }).collect::<Vec<_>>());
            }
            Ok(out)
        }
        // ---- sagebrush.ap: traces of Frobenius of elliptic curves ----
        "ap" => {
            let p = u(v, "p")?;
            if p < 2 || !sagebrush_modsym::exact::is_prime(p) || p >= 1 << 62 {
                return Err(format!("p = {} must be a prime below 2^62", p));
            }
            Ok(json!(curve(v.get("a"))?.ap(p)))
        }
        "aplist" => {
            let e = curve(v.get("a"))?;
            Ok(json!(sagebrush_ap::aplist(&e, u(v, "n")?).into_iter().map(|(p, x)| json!([p, x])).collect::<Vec<_>>()))
        }
        "ec_height" => {
            // the canonical height on balls (ap/src/height.rs): exact endpoints
            let a = bigs(v.get("a"))?;
            let x = bigs(v.get("x"))?;
            if x.len() != 2 {
                return Err("x is [numerator, denominator]".into());
            }
            let n = match u(v, "n")? {
                1 => 1u32,
                2 => 2,
                _ => return Err("n must be 1 or 2 (Q = P or 2P)".into()),
            };
            let local: Vec<(BigInt, BigInt, BigInt)> = v.get("local").and_then(|l| l.as_array()).ok_or("local: [[p, num, den], ...]")?
                .iter().map(|t| {
                    let t = bigs(Some(t))?;
                    if t.len() != 3 { return Err("local: [[p, num, den], ...]".to_string()); }
                    Ok((t[0].clone(), t[1].clone(), t[2].clone()))
                }).collect::<Result<_, String>>()?;
            let d = big1(v.get("d"))?;
            let roots: Vec<(BigInt, u64)> = v.get("roots").and_then(|l| l.as_array()).ok_or("roots: [[num, k], ...]")?
                .iter().map(|t| {
                    let t = bigs(Some(t))?;
                    if t.len() != 2 { return Err("roots: [[num, k], ...]".to_string()); }
                    Ok((t[0].clone(), t[1].to_string().parse::<u64>().map_err(|e| e.to_string())?))
                }).collect::<Result<_, String>>()?;
            let prec = size(v, "prec", Some(128), 4096)? as u64;
            let h = sagebrush_ap::height::canonical_height(&a, &x[0], &x[1], n, &local, &d, &roots, prec)?;
            let (lm, le) = h.lower();
            let (um, ue) = h.upper();
            Ok(json!({ "lo": [lm.to_string(), le], "hi": [um.to_string(), ue] }))
        }
        "ball_log" => {
            // log of a positive rational on balls: exact dyadic endpoints
            let x = bigs(v.get("x"))?;
            if x.len() != 2 {
                return Err("x is [numerator, denominator]".into());
            }
            let prec = size(v, "prec", Some(128), 4096)? as u64;
            let h = sagebrush_ap::height::log_rational(&x[0], &x[1], prec)?;
            let (lm, le) = h.lower();
            let (um, ue) = h.upper();
            Ok(json!({ "lo": [lm.to_string(), le], "hi": [um.to_string(), ue] }))
        }
        "ec_low_rank" => {
            // the analytic rank if 0 or 1, decided on balls (ap/src/lcert.rs)
            let an: Vec<i64> = v.get("an").and_then(|a| a.as_array()).ok_or("an: a list of integers")?
                .iter().map(|x| x.as_i64().ok_or_else(|| "an: a list of integers".to_string())).collect::<Result<_, _>>()?;
            let n = u(v, "n")?;
            Ok(match sagebrush_ap::lcert::low_rank(&an, n, 96) {
                // exact dyadic endpoints [m, e] (m 2^e) of the enclosure;
                // value is a double for display only (a midpoint and a radius
                // rounded separately did not enclose L: the review's ECBALL-F3)
                Some(r) => {
                    let (lm, le) = r.value.lower();
                    let (um, ue) = r.value.upper();
                    json!({ "w": r.w, "rank": r.rank, "value": r.value.to_f64_approx(), "lo": [lm.to_string(), le], "hi": [um.to_string(), ue] })
                }
                None => Value::Null,
            })
        }
        "ec_l_value" => {
            // (w, L(E,1) or L'(E,1)) on balls, the ball possibly holding 0
            let an: Vec<i64> = v.get("an").and_then(|a| a.as_array()).ok_or("an: a list of integers")?
                .iter().map(|x| x.as_i64().ok_or_else(|| "an: a list of integers".to_string())).collect::<Result<_, _>>()?;
            let n = u(v, "n")?;
            Ok(match sagebrush_ap::lcert::l_value(&an, n, 96) {
                Some((w, b)) => {
                    let (lm, le) = b.lower();
                    let (um, ue) = b.upper();
                    json!({ "w": w, "lo": [lm.to_string(), le], "hi": [um.to_string(), ue] })
                }
                None => Value::Null,
            })
        }
        "ec_real_period" => {
            // Omega_E on balls: exact dyadic endpoints
            let a = bigs(v.get("a"))?;
            let roots: Vec<(BigInt, u64)> = v.get("roots").and_then(|l| l.as_array()).ok_or("roots: [[num, k], ...]")?
                .iter().map(|t| {
                    let t = bigs(Some(t))?;
                    if t.len() != 2 { return Err("roots: [[num, k], ...]".to_string()); }
                    Ok((t[0].clone(), t[1].to_string().parse::<u64>().map_err(|e| e.to_string())?))
                }).collect::<Result<_, String>>()?;
            let prec = size(v, "prec", Some(128), 4096)? as u64;
            let h = sagebrush_ap::height::real_period(&a, &roots, prec)?;
            let (lm, le) = h.lower();
            let (um, ue) = h.upper();
            Ok(json!({ "lo": [lm.to_string(), le], "hi": [um.to_string(), ue] }))
        }
        "ec_point_search" => {
            let b = bigs(v.get("b"))?;
            let p = |x: &BigInt| x.to_string().parse::<i128>().map_err(|_| "b-invariants too large for the point search".to_string());
            if b.len() != 3 {
                return Err("b is [b2, b4, b6]".into());
            }
            let xs = sagebrush_ap::search::x_coordinates(p(&b[0])?, p(&b[1])?, p(&b[2])?, u(v, "rmax")?, u(v, "smax")?, size(v, "limit", Some(100000), 1 << 28)?)?;
            Ok(json!(xs.iter().map(|(r, s)| json!([r.to_string(), s])).collect::<Vec<_>>()))
        }
        "quartic_search" => {
            let p = |k: &str| -> Result<i128, String> {
                big1(v.get(k))?.to_string().parse::<i128>().map_err(|_| format!("{} is too large for the quartic search", k))
            };
            let max_cost = v.get("max_cost").and_then(Value::as_f64).unwrap_or(1e10) as u64;
            let s = sagebrush_ap::quartic::search(p("I")?, p("J")?, max_cost)?;
            let qs: Vec<Value> = s.quartics.iter().map(|f| json!(f.iter().map(|x| x.to_string()).collect::<Vec<_>>())).collect();
            Ok(json!({ "quartics": qs, "work": s.work, "amax": s.amax, "cost": s.cost }))
        }
        "aplist_many" => {
            let es = v.get("curves").and_then(Value::as_array).ok_or("missing curves")?.iter().map(|c| curve(Some(c))).collect::<Result<Vec<_>, _>>()?;
            let r = sagebrush_ap::aplist_many(&es, u(v, "n")?);
            Ok(json!(r.into_iter().map(|l| l.into_iter().map(|(p, x)| json!([p, x])).collect::<Vec<_>>()).collect::<Vec<_>>()))
        }
        "moments" => {
            let e = curve(v.get("a"))?;
            let (count, m) = sagebrush_ap::moments(&e, u(v, "n")?, size(v, "kmax", Some(4), 64)?);
            Ok(json!([count, m]))
        }
        _ => Err(format!("unknown fn '{}'", f)),
    }
}

#[cfg(test)]
mod tests {
    use super::call;

    fn ok(req: &str) -> serde_json::Value {
        let r: serde_json::Value = serde_json::from_str(&call(req)).unwrap();
        r.get("ok").cloned().unwrap_or_else(|| panic!("{} -> {}", req, r))
    }

    fn err(req: &str) -> String {
        let r: serde_json::Value = serde_json::from_str(&call(req)).unwrap();
        r.get("error").and_then(|e| e.as_str()).unwrap_or_else(|| panic!("{} -> {}", req, r)).to_string()
    }

    /// newspace/newforms: an internal error from the factor callback is the
    /// reply's error, flagged internal; a resource refusal keeps
    /// checked_factor's message (CORR-RANK3-INTERNAL-1, astra2)
    #[test]
    fn newspace_keeps_an_internal_factor_error() {
        use sagebrush_bigint::BigInt;
        let eps = super::character(23, &serde_json::json!({"fn": "newspace", "n": 23, "k": 2})).unwrap();
        let called = std::sync::atomic::AtomicUsize::new(0);
        let internal = |_: &[BigInt]| -> Result<super::Factored, sagebrush_poly::FactorLimit> {
            called.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Err(sagebrush_poly::Budget::unlimited().internal("an injected invariant"))
        };
        let e = super::keeping_internal(&internal, |fac| sagebrush_modsym::newspace::newspace_orbits(23, 2, &eps, fac)).map(|_| ()).unwrap_err();
        assert!(called.load(std::sync::atomic::Ordering::Relaxed) > 0, "the factor callback was never asked");
        assert!(e.starts_with(sagebrush_poly::INTERNAL_PREFIX) && e.contains("an injected invariant") && e.contains("please report it"), "{}", e);
        assert_eq!(super::error_json(e)["internal"], true);
        // a resource refusal: no factors, checked_factor's own error, unflagged
        let refusing = |_: &[BigInt]| -> Result<super::Factored, sagebrush_poly::FactorLimit> {
            Err(sagebrush_poly::Budget::unlimited().refuse("work", 2, 1))
        };
        let e = super::keeping_internal(&refusing, |fac| sagebrush_modsym::newspace::newspace_orbits(23, 2, &eps, fac)).map(|_| ()).unwrap_err();
        assert!(!e.contains(sagebrush_poly::INTERNAL_PREFIX), "{}", e);
        assert!(super::error_json(e).get("internal").is_none());
        // and the real factorization still answers
        let real = |f: &[BigInt]| sagebrush_poly::try_factor(f).map(|r| r.1);
        let r = super::keeping_internal(&real, |fac| sagebrush_modsym::newspace::newspace_orbits(23, 2, &eps, fac)).unwrap();
        assert_eq!(r.dim, 2);
    }

    /// A failed proved invariant of the factoring engine is flagged
    /// "internal" (also inside another op's message); a resource refusal
    /// and other errors are not (rank-3 plan r3, section 3.5).
    #[test]
    fn internal_factoring_errors_are_flagged() {
        let m = format!("{} (x divides the residual after the pre-pass in small-subset pre-pass); please report it; not factored", sagebrush_poly::INTERNAL_PREFIX);
        assert_eq!(super::error_json(m.clone()), serde_json::json!({ "error": m, "internal": true }));
        let wrapped = format!("hmf newspace: {}", m);
        assert_eq!(super::error_json(wrapped.clone())["internal"], true);
        assert_eq!(super::error_json("factor of the zero polynomial".into()), serde_json::json!({ "error": "factor of the zero polynomial" }));
        // a real resource refusal through call(): no flag
        let r: serde_json::Value = serde_json::from_str(&call(r#"{"fn":"factor","f":["1","1","0","0","1"],"work":1}"#)).unwrap();
        assert!(r["error"].as_str().unwrap().contains("resource limit exceeded") && r.get("internal").is_none(), "{}", r);
    }

    #[test]
    fn nmod_charpoly() {
        // [[1, 2], [3, 4]] over GF(7): x^2 - 5x - 2 = x^2 + 2x + 5
        assert_eq!(ok(r#"{"fn":"nmod_charpoly","m":"1,2;3,4","p":"7","wire":"csv"}"#), "5,2,1");
        // the largest prime below 2^63 (Krylov); the 0 x 0 matrix
        assert_eq!(ok(r#"{"fn":"nmod_charpoly","m":"0,1;1,0","p":"9223372036854775783","wire":"csv"}"#), "9223372036854775782,0,1");
        assert_eq!(ok(r#"{"fn":"nmod_charpoly","m":"","p":"5","wire":"csv"}"#), "1");
        assert_eq!(ok(r#"{"fn":"nmod_charpoly","m":"1,1;0,1","p":"2"}"#), serde_json::json!(["1", "0", "1"]));
        for bad in [
            r#"{"fn":"nmod_charpoly","m":"1,2;3,4","p":"9"}"#,                   // not prime
            r#"{"fn":"nmod_charpoly","m":"1,2;3,4","p":"9223372036854775837"}"#, // a prime past 2^63
            r#"{"fn":"nmod_charpoly","m":"1,2;3,7","p":"7"}"#,                   // an entry not reduced
            r#"{"fn":"nmod_charpoly","m":"1,2;-3,4","p":"7"}"#,
            r#"{"fn":"nmod_charpoly","m":"1,2,3;4,5,6","p":"7"}"#,               // not square
            r#"{"fn":"nmod_charpoly","m":"1,2;3","p":"7"}"#,
            r#"{"fn":"nmod_charpoly","p":"7"}"#,
        ] {
            assert!(err(bad).starts_with("nmod_charpoly"), "{}", bad);
        }
    }

    /// A square matrix text of zeros with n rows.
    fn zeros(n: usize) -> String {
        vec![vec!["0"; n].join(","); n].join(";")
    }

    #[test]
    fn nmod_charpoly_admission() {
        use super::{nmod_square, NMOD_MAX_BYTES, NMOD_MAX_N};
        // at the row limit: admitted (the parse alone; the cubic work of the
        // largest case belongs to the slow tests), one more: refused before
        // anything is parsed
        let (n, d) = nmod_square(&zeros(NMOD_MAX_N), 7).unwrap();
        assert_eq!((n, d.len()), (NMOD_MAX_N, NMOD_MAX_N * NMOD_MAX_N));
        assert!(nmod_square(&zeros(NMOD_MAX_N + 1), 7).unwrap_err().contains("rows, more than"));
        // a text past the byte limit is refused before it is scanned
        let long = "0".repeat(NMOD_MAX_BYTES + 1);
        assert!(nmod_square(&long, 7).unwrap_err().contains("bytes, more than"));
        // (at the limit: admitted, one entry with leading zeros)
        assert!(super::fn_name_is(r#"{"m": [1, {"fn": "x"}], "fn": "nmod_charpoly"}"#, "nmod_charpoly"));
        assert!(!super::fn_name_is(r#"{"fn": "mat_det", "m": "nmod_charpoly"}"#, "nmod_charpoly"));
        // escapes decoded without storing: an escaped "fn" and value, a huge
        // escaped key first, duplicate keys (the last wins, as in serde)
        assert!(super::fn_name_is(r#"{"\u0066n": "nmod\u005fcharpoly"}"#, "nmod_charpoly"));
        let huge_key = format!(r#"{{"{}": 1, "fn": "nmod_charpoly"}}"#, "\\u0041".repeat(1 << 20));
        assert!(super::fn_name_is(&huge_key, "nmod_charpoly"));
        assert!(!super::fn_name_is(r#"{"fn": "nmod_charpoly", "fn": "mat_det"}"#, "nmod_charpoly"));
        assert!(super::fn_name_is(r#"{"a": [1, {"fn": "x", "s": "}]\""}], "fn": "nmod_charpoly", "b": 2.5e3}"#, "nmod_charpoly"));
        assert!(!super::fn_name_is(r#"{"fn": "nmod_charpoly""#, "nmod_charpoly"));
        // a whole request past NMOD_MAX_REQUEST is refused before serde
        let big = format!(r#"{{"fn":"nmod_charpoly","p":"7","m":"{}"}}"#, "0".repeat(super::NMOD_MAX_REQUEST));
        assert!(err(&big).contains("the request has"));
        assert_eq!(nmod_square(&"0".repeat(NMOD_MAX_BYTES), 7).unwrap(), (1, vec![0]));
        // a long row is refused as soon as it passes n entries
        assert!(nmod_square(&format!("{};0", vec!["0"; 5].join(",")), 7).unwrap_err().contains("non-square"));
    }

}
