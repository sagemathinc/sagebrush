//! Native frames for code that must stay right under an asynchronous
//! KeyboardInterrupt (#157 simpler path, r2 §1 and astra2's with-lock ruling).
//!
//! On CPython 3.9 and 3.14, `with lock:` on a `_thread` lock can leave the
//! lock held: a pending signal can raise after `__enter__` has acquired and
//! before the statement's cleanup range begins (measured: thousands of leaks
//! per 160,000 interrupts).  `locked_call` closes that seam by keeping the
//! acquire and the release obligation in Rust: between the C `acquire`
//! returning true and the guard being armed there is no Python callback, no
//! signal check, no GIL release and no allocation, and the guard releases on
//! every exit of the callable (a return, any exception, a KeyboardInterrupt),
//! leaving the callable's exception as it was.
//!
//! `settled_call` is the PNG call's frame (r4 §A.1-A.2): the call lock held
//! as in `locked_call`, then `body(ob)`, then `settle(ob, ok)` run until it
//! returns: a KeyboardInterrupt in it is retried (each retry resumes where
//! the last one stopped, `ob`'s flags recording each step), any other
//! failure leaves `ob` as the module's `_unsettled` obligation, refused at
//! the next call until it settles.  The body's own exception comes out as
//! the same object.
//!
//! `ReleaseLog` is the ledger's release log (lib/_memledger.py): a weak
//! reference per tracked owner whose callback is native, appending
//! (sequence, key) to a queue whose room was reserved when the owner was
//! tracked, so a release is never lost to an allocation failure and no
//! Python code runs in the callback.

use pyo3::exceptions::{PyKeyboardInterrupt, PyRuntimeError, PyTypeError};
use pyo3::prelude::*;
use pyo3::types::{PyList, PyTuple, PyWeakrefReference};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

thread_local! {
    /// The locks this thread holds through locked_call (their addresses):
    /// a nested call on one of them is refused at once instead of waiting
    /// for itself.
    static HELD: std::cell::RefCell<Vec<usize>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// The release obligation: `release()` called once when dropped, and the
/// lock's entry in HELD removed (if it was recorded).
struct Release<'py> {
    release: Bound<'py, PyAny>,
    addr: usize,
    recorded: bool,
}

impl Drop for Release<'_> {
    fn drop(&mut self) {
        if self.recorded {
            HELD.with(|h| {
                let mut h = h.borrow_mut();
                if let Some(i) = h.iter().rposition(|a| *a == self.addr) {
                    h.remove(i);
                }
            });
        }
        // (the lock is ours: its release can't fail; were it to, the
        // callable's own outcome is what the caller sees)
        let _ = self.release.call0();
        RELEASED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Counters, read by the tests (astra2's: not a Python wrapper around the
/// lock, which would reopen the seam).
static ACQUIRED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static RELEASED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// `lock` held, its release armed (see the module comment): acquired
/// blocking, or in slices of `wake` seconds with signals checked between
/// them, so a Stop while waiting raises holding nothing.
fn hold<'py>(py: Python<'py>, lock: &Bound<'py, PyAny>, wake: Option<f64>) -> PyResult<Release<'py>> {
    let lock_type = py.import("_thread")?.getattr("LockType")?;
    if !lock.get_type().is(&lock_type) {
        return Err(PyTypeError::new_err("locked_call needs a _thread lock"));
    }
    let addr = lock.as_ptr() as usize;
    if HELD.with(|h| h.borrow().contains(&addr)) {
        return Err(PyRuntimeError::new_err(
            "PNG work can't nest: this thread already holds the PNG engine's lock (a signal handler's call?)"));
    }
    // (the bound methods are made before anything is held)
    let acquire = lock.getattr("acquire")?;
    let release = lock.getattr("release")?;
    match wake {
        None => {
            // (a C call: once it returns true the lock is ours, and nothing
            // runs before the guard below exists)
            if !acquire.call0()?.is_truthy()? {
                return Err(PyTypeError::new_err("the lock was not acquired"));
            }
        }
        Some(w) => loop {
            if acquire.call1((true, w))?.is_truthy()? {
                break;
            }
            py.check_signals()?;
        },
    }
    // (armed first, with nothing between the acquire and here; only then
    // anything that may allocate)
    let mut guard = Release { release, addr, recorded: false };
    ACQUIRED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    HELD.with(|h| h.borrow_mut().push(addr));
    guard.recorded = true;
    Ok(guard)
}

/// `fn()` with `lock` held: acquired here (blocking, or in slices of `wake`
/// seconds with signals checked between them, so a Stop while waiting
/// raises holding nothing), released when `fn` returns or raises.  `lock`
/// must be a `_thread` lock (TypeError otherwise: an object with a Python
/// `acquire` could run code between the acquire and the guard).
#[pyfunction]
#[pyo3(signature = (lock, f, wake=None))]
pub fn locked_call<'py>(py: Python<'py>, lock: &Bound<'py, PyAny>, f: &Bound<'py, PyAny>, wake: Option<f64>) -> PyResult<Bound<'py, PyAny>> {
    let guard = hold(py, lock, wake)?;
    let out = f.call0();
    drop(guard);
    out
}

/// settle(ob, ok) until it returns: a KeyboardInterrupt retried (the first
/// one kept), any other exception returned as the failure.
fn settle_all<'py>(py: Python<'py>, settle: &Bound<'py, PyAny>, ob: &Bound<'py, PyAny>, ok: bool) -> Result<Option<PyErr>, PyErr> {
    let mut first: Option<PyErr> = None;
    loop {
        match settle.call1((ob, ok)) {
            Ok(_) => return Ok(first),
            Err(e) if e.is_instance_of::<PyKeyboardInterrupt>(py) => {
                if first.is_none() {
                    first = Some(e);
                }
            }
            Err(e) => return Err(e),
        }
    }
}

/// The error a failed settlement raises: holder.SagebrushEngineError, its
/// cause the settlement's own exception.
fn unsettled_error<'py>(py: Python<'py>, holder: &Bound<'py, PyAny>, what: &str, cause: PyErr) -> PyErr {
    let err = match holder.getattr("SagebrushEngineError").and_then(|t| t.call1((what,))) {
        Ok(e) => PyErr::from_value(e),
        Err(e) => e,
    };
    err.set_cause(py, Some(cause));
    err
}

/// The PNG call's frame (see the module comment): `lock` held throughout;
/// an earlier unsettled obligation (`holder._unsettled`) settled first, or
/// the call refused; `body(ob)`; `settle(ob, ok)` to its end; the lock
/// released once.  Returns body's value, or raises its exception (the same
/// object), or the first KeyboardInterrupt settlement absorbed after a body
/// that returned.
#[pyfunction]
pub fn settled_call<'py>(
    py: Python<'py>,
    lock: &Bound<'py, PyAny>,
    wake: f64,
    ob: &Bound<'py, PyAny>,
    body: &Bound<'py, PyAny>,
    settle: &Bound<'py, PyAny>,
    holder: &Bound<'py, PyAny>,
) -> PyResult<Bound<'py, PyAny>> {
    let guard = hold(py, lock, Some(wake))?;
    let pending = holder.getattr("_unsettled")?;
    if !pending.is_none() {
        match settle_all(py, settle, &pending, false) {
            Err(e) => {
                drop(guard);
                return Err(unsettled_error(py, holder, "an earlier PNG call's cleanup still fails, so PNG work is refused until it succeeds", e));
            }
            Ok(ki) => {
                holder.setattr("_unsettled", py.None())?;
                if let Some(k) = ki {
                    drop(guard);
                    return Err(k);
                }
            }
        }
    }
    let out = body.call1((ob,));
    let ok = out.is_ok();
    match settle_all(py, settle, ob, ok) {
        Err(e) => {
            // (kept, still charged; the next call settles it first)
            let kept = holder.setattr("_unsettled", ob);
            drop(guard);
            let err = unsettled_error(py, holder, "the PNG call's cleanup failed; its memory stays charged and PNG work is refused until the cleanup succeeds", e);
            if let Err(k) = kept {
                return Err(k);
            }
            Err(err)
        }
        Ok(ki) => {
            drop(guard);
            match (out, ki) {
                (Err(e), _) => Err(e),
                (Ok(_), Some(k)) => Err(k),
                (Ok(v), None) => Ok(v),
            }
        }
    }
}

/// (acquired, released) counts of locked_call's guarded sections.
#[pyfunction]
pub fn locked_call_counts() -> (u64, u64) {
    (ACQUIRED.load(std::sync::atomic::Ordering::Relaxed), RELEASED.load(std::sync::atomic::Ordering::Relaxed))
}

struct LogInner {
    queue: VecDeque<(u64, Py<PyAny>)>,
    next: u64,
    acked: u64,
    tracked: HashMap<u64, Py<PyAny>>,
}

fn locked(m: &Mutex<LogInner>) -> MutexGuard<'_, LogInner> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The weak reference's callback: (seq, key) appended, in room reserved at
/// track time.  Native: no Python code runs in it.
#[pyclass(module = "sagebrush._native.raster")]
struct Released {
    log: Arc<Mutex<LogInner>>,
    id: u64,
    key: Py<PyAny>,
}

#[pymethods]
impl Released {
    fn __call__(&self, py: Python<'_>, _wr: &Bound<'_, PyAny>) {
        let gone = {
            let mut g = locked(&self.log);
            let seq = g.next;
            g.next += 1;
            // (capacity was reserved for every tracked owner: no allocation)
            g.queue.push_back((seq, self.key.clone_ref(py)));
            g.tracked.remove(&self.id)
        };
        // (dropped after the log's mutex: a decref can run nothing of ours)
        drop(gone);
    }
}

/// The ledger's release log (see the module comment).
#[pyclass(module = "sagebrush._native.raster")]
pub struct ReleaseLog {
    log: Arc<Mutex<LogInner>>,
}

#[pymethods]
impl ReleaseLog {
    #[new]
    fn new() -> Self {
        ReleaseLog { log: Arc::new(Mutex::new(LogInner { queue: VecDeque::new(), next: 0, acked: 0, tracked: HashMap::new() })) }
    }

    /// owner's release recorded as key when owner is collected; a key whose
    /// earlier owner is still tracked is left as it is.
    fn track(&self, py: Python<'_>, owner: &Bound<'_, PyAny>, key: &Bound<'_, PyTuple>) -> PyResult<()> {
        let id: u64 = key.get_item(2)?.extract()?;
        {
            let g = locked(&self.log);
            if let Some(w) = g.tracked.get(&id) {
                if w.bind(py).cast::<PyWeakrefReference>().map(|w| w.upgrade().is_some()).unwrap_or(false) {
                    return Ok(());
                }
            }
        }
        // (Python objects made before the log's mutex is taken: an
        // allocation here may collect, and a collection may call Released)
        let cb = Bound::new(py, Released { log: self.log.clone(), id, key: key.clone().into_any().unbind() })?;
        let wr = PyWeakrefReference::new_with(owner, &cb)?;
        let mut g = locked(&self.log);
        let room = g.tracked.len() + 1;
        g.queue.reserve(room);
        let old = g.tracked.insert(id, wr.into_any().unbind());
        drop(g);
        drop(old);
        Ok(())
    }

    /// Up to `count` (seq, key) entries with seq >= frm, in order.
    fn peek<'py>(&self, py: Python<'py>, frm: u64, count: usize) -> PyResult<Bound<'py, PyList>> {
        let items: Vec<(u64, Py<PyAny>)> = {
            let g = locked(&self.log);
            g.queue.iter().filter(|(s, _)| *s >= frm).take(count).map(|(s, k)| (*s, k.clone_ref(py))).collect()
        };
        let out = PyList::empty(py);
        for (s, k) in items {
            out.append((s, k))?;
        }
        Ok(out)
    }

    /// Entries with seq < upto dropped (idempotent, monotonic).
    fn ack(&self, upto: u64) {
        let gone: Vec<(u64, Py<PyAny>)> = {
            let mut g = locked(&self.log);
            let mut v = Vec::new();
            while let Some((s, _)) = g.queue.front() {
                if *s >= upto {
                    break;
                }
                v.push(g.queue.pop_front().unwrap());
            }
            if upto > g.acked {
                g.acked = upto;
            }
            v
        };
        drop(gone);
    }

    fn pending(&self) -> usize {
        locked(&self.log).queue.len()
    }

    fn tracked(&self) -> usize {
        locked(&self.log).tracked.len()
    }
}
