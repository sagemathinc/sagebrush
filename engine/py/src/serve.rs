//! The session worker's request loop (Ctrl-C plan r2 §3a, r4 and r5): each
//! request read, admitted, run once and answered once, natively, so that no
//! KeyboardInterrupt can fall between the steps that make a request's
//! lifecycle (a Python `finally` or `with` on the main thread can be skipped
//! by one, cpython#130279).
//!
//! - **Reading:** the request stream is read here, from its own buffer, one
//!   line at a time; no Python call reads it, so a line is never half
//!   consumed.  Only the request's `id` is parsed here.
//! - **Admission:** the moment a line is complete, a native assignment under
//!   STATE's mutex, before any Python runs for it.
//! - **One execution:** `run_request(line, serial)` is called once.  If an
//!   exception escapes it, it is never called again for that request:
//!   `fallback_reply(id, serial, exc)` builds the reply instead (it runs no
//!   user code, and is called again until it returns, as `encode` is).
//! - **One commit:** the encoded reply is written here, every byte, then the
//!   request is retired under the mutex.  Only then is the next line read.
//!
//! Interrupts are told apart by their signal (POSIX).  A targeted interrupt
//! is an id the parent writes on the control pipe: the control thread (a
//! Rust thread that never touches Python or the GIL) arms the in-flight
//! request under the mutex, only if it is that id, and wakes the main thread
//! with SIGUSR1; the worker's SIGUSR1 handler calls `_serve_take()`, true
//! iff the request it was armed for is still running.  SIGINT is external
//! only (a terminal's Ctrl-C, `kill -INT`): its handler raises iff a request
//! is running (`_serve_busy()`).  No Python callback ever runs while the
//! mutex is held.  On Windows there is no control pipe: interrupts arrive as
//! they do today (Ctrl-Break, through `_break_as_sigint`), and only the
//! lifecycle above is new.

use pyo3::exceptions::{PyKeyboardInterrupt, PyOSError, PyRuntimeError};
use pyo3::prelude::*;
use pyo3::types::PyDict;
use std::io::{ErrorKind, Read, Write};
#[cfg(all(test, unix))]
use std::os::unix::io::AsRawFd;
use std::mem::ManuallyDrop;
use std::sync::Mutex;

/// What the worker is doing.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    /// No request admitted: an interrupt is for nothing.
    Idle,
    /// `run_request` is running for the admitted request: interruptible.
    Running,
    /// Its user code is over (`run_request` returned or raised): the reply
    /// is being built, encoded and written; nothing left to interrupt.
    Closing,
}

struct State {
    phase: Phase,
    /// The admitted request's id (None: its line had no integer id).
    id: Option<u64>,
    /// Admissions so far: the admitted request's serial.
    serial: u64,
    /// The serial a targeted interrupt was armed for, until taken or retired.
    armed: Option<u64>,
    replied: u64,
    /// Control ids that armed nothing (their request had already finished).
    stale: u64,
    /// Targeted wakes sent.
    woken: u64,
    /// SIGUSR1 deliveries whose request had finished (take() false).
    late: u64,
}

static STATE: Mutex<State> = Mutex::new(State {
    phase: Phase::Idle,
    id: None,
    serial: 0,
    armed: None,
    replied: 0,
    stale: 0,
    woken: 0,
    late: 0,
});

fn state() -> std::sync::MutexGuard<'static, State> {
    // (no code panics while holding it; a poisoned lock is still the state)
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// What a control line targets.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Target {
    /// `*`: whatever request is running.
    Any,
    Id(u64),
}

fn parse_target(line: &[u8]) -> Option<Target> {
    let t = std::str::from_utf8(line).ok()?.trim();
    if t == "*" {
        return Some(Target::Any);
    }
    t.parse().ok().map(Target::Id)
}

/// Arm the running request iff it is `target`: under the mutex, so it can't
/// fall between another request's admission and commit.
fn arm(target: Target) -> bool {
    let mut st = state();
    let hit = st.phase == Phase::Running
        && match target {
            Target::Any => true,
            Target::Id(n) => st.id == Some(n),
        };
    if hit {
        st.armed = Some(st.serial);
    } else {
        st.stale += 1;
    }
    hit
}

fn admit(id: Option<u64>) -> u64 {
    let mut st = state();
    st.serial += 1;
    st.phase = Phase::Running;
    st.id = id;
    st.armed = None;
    st.serial
}

fn close() {
    let mut st = state();
    st.phase = Phase::Closing;
    st.armed = None;
}

fn retire() {
    let mut st = state();
    st.phase = Phase::Idle;
    st.id = None;
    st.armed = None;
    st.replied += 1;
}

/// The SIGUSR1 handler's question: was a targeted interrupt armed for the
/// request that is still running?  It clears the armed mark either way.
#[pyfunction(name = "_serve_take")]
fn serve_take() -> bool {
    let mut st = state();
    let hit = st.armed.take() == Some(st.serial) && st.phase == Phase::Running;
    if !hit {
        st.late += 1;
    }
    hit
}

/// The SIGINT handler's question: is a request's code running?
#[pyfunction(name = "_serve_busy")]
fn serve_busy() -> bool {
    state().phase == Phase::Running
}

/// The loop's counts (tests): admitted, replied, stale, woken, late.
#[pyfunction(name = "_serve_stats")]
fn serve_stats(py: Python<'_>) -> PyResult<Bound<'_, PyDict>> {
    let (admitted, replied, stale, woken, late) = {
        let st = state();
        (st.serial, st.replied, st.stale, st.woken, st.late)
    };
    let d = PyDict::new(py);
    d.set_item("admitted", admitted)?;
    d.set_item("replied", replied)?;
    d.set_item("stale", stale)?;
    d.set_item("woken", woken)?;
    d.set_item("late", late)?;
    Ok(d)
}

/// Whether a targeted interrupt also stops a native engine call in flight
/// (sagebrush-interrupt's per-call request, @sagebrush-sage2's guarded Stop
/// window; until it lands, a targeted interrupt reaches an engine call when
/// the call returns).
#[pyfunction(name = "_serve_native_stop")]
fn serve_native_stop() -> bool {
    false
}

// ---- raw I/O on inherited descriptors (never closed here)

#[cfg(unix)]
fn borrow_file(fd: i64) -> ManuallyDrop<std::fs::File> {
    use std::os::unix::io::FromRawFd;
    ManuallyDrop::new(unsafe { std::fs::File::from_raw_fd(fd as i32) })
}

#[cfg(windows)]
fn borrow_file(handle: i64) -> ManuallyDrop<std::fs::File> {
    use std::os::windows::io::FromRawHandle;
    ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(handle as isize as _) })
}

/// Newline-framed lines from a descriptor, its own buffer kept across short
/// reads, EINTR retried.
struct Lines {
    f: ManuallyDrop<std::fs::File>,
    buf: Vec<u8>,
    eof: bool,
}

impl Lines {
    fn new(f: ManuallyDrop<std::fs::File>) -> Lines {
        Lines { f, buf: Vec::new(), eof: false }
    }

    /// The next line without its newline; a last line without one is still
    /// a line; None at the end.
    fn next(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        let mut scanned = 0;
        loop {
            if let Some(i) = self.buf[scanned..].iter().position(|&b| b == b'\n') {
                let end = scanned + i;
                let line = self.buf[..end].to_vec();
                self.buf.drain(..=end);
                return Ok(Some(line));
            }
            scanned = self.buf.len();
            if self.eof {
                return Ok(if self.buf.is_empty() { None } else { Some(std::mem::take(&mut self.buf)) });
            }
            let mut chunk = [0u8; 65536];
            match self.f.read(&mut chunk) {
                Ok(0) => self.eof = true,
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
    }
}

/// Every byte written, EINTR and EAGAIN retried; false if the reader is gone
/// (EPIPE: the parent ended).
fn write_all(f: &mut std::fs::File, mut bytes: &[u8]) -> std::io::Result<bool> {
    while !bytes.is_empty() {
        match f.write(bytes) {
            Ok(0) => return Ok(false),
            Ok(n) => bytes = &bytes[n..],
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(std::time::Duration::from_millis(1)),
            Err(e) if e.kind() == ErrorKind::BrokenPipe => return Ok(false),
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

// ---- the control thread (POSIX)

#[cfg(unix)]
#[derive(Clone, Copy)]
struct MainThread(libc::pthread_t);

// (a thread id, only ever passed to pthread_kill; a pointer type on macOS)
#[cfg(unix)]
unsafe impl Send for MainThread {}

#[cfg(unix)]
fn control_loop(fd: i64, main: MainThread) {
    let mut lines = Lines::new(borrow_file(fd));
    while let Ok(Some(line)) = lines.next() {
        #[cfg(feature = "test-hooks")]
        hooks::delay(&hooks::ARM_DELAY_MS);
        let Some(target) = parse_target(&line) else { continue };
        if arm(target) {
            #[cfg(feature = "test-hooks")]
            hooks::delay(&hooks::WAKE_DELAY_MS);
            wake(main);
        }
    }
}

/// Wake the main thread for an armed request: SIGUSR1, thread-directed, so
/// that a blocking call there (time.sleep, a read) returns with EINTR and
/// Python runs the handler.  Not sent if SIGUSR1's action isn't a handler
/// (a user's code reset it): the default action would end the worker.
#[cfg(unix)]
fn wake(main: MainThread) {
    unsafe {
        let mut cur: libc::sigaction = std::mem::zeroed();
        if libc::sigaction(libc::SIGUSR1, std::ptr::null(), &mut cur) != 0 {
            return;
        }
        if cur.sa_sigaction == libc::SIG_DFL || cur.sa_sigaction == libc::SIG_IGN {
            return;
        }
        libc::pthread_kill(main.0, libc::SIGUSR1);
    }
    state().woken += 1;
}

// ---- the loop

fn is_keyboard_interrupt(py: Python<'_>, e: &PyErr) -> bool {
    e.is_instance_of::<PyKeyboardInterrupt>(py)
}

/// A reply built here, when Python can't build or encode one (never
/// expected: the reply that says so, with the request's id).
fn native_reply(id: Option<u64>, what: &str) -> String {
    let msg = format!("the session couldn't build this request's reply ({what})");
    let v = serde_json::json!({
        "id": id, "stdout": "", "stdout_chars": 0, "output_bytes": {"stdout": 0, "stderr": 0},
        "result": null, "error": msg, "data": null, "displays": [], "seconds": 0.0,
        "error_info": {"type": "session", "exception": null, "message": msg, "traceback": ""},
    });
    v.to_string() + "\n"
}

/// The worker's loop (see the module comment): requests read from
/// `input`, replies written to `output` (descriptors on POSIX, handles on
/// Windows; neither is closed here), targeted interrupts read from
/// `control` (POSIX; None: none).  Returns at the end of the input, or when
/// the parent stops reading the replies.  Main thread only.
#[pyfunction(name = "_serve_requests")]
#[pyo3(signature = (input, output, control, run_request, fallback_reply, encode))]
fn serve_requests(
    py: Python<'_>,
    input: i64,
    output: i64,
    control: Option<i64>,
    run_request: Bound<'_, PyAny>,
    fallback_reply: Bound<'_, PyAny>,
    encode: Bound<'_, PyAny>,
) -> PyResult<()> {
    if crate::MAIN.get() != Some(&std::thread::current().id()) {
        return Err(PyRuntimeError::new_err("the request loop runs on the main thread"));
    }
    if state().serial != 0 {
        return Err(PyRuntimeError::new_err("the request loop runs once per process"));
    }
    #[cfg(unix)]
    if let Some(fd) = control {
        let main = MainThread(unsafe { libc::pthread_self() });
        std::thread::Builder::new()
            .name("sagebrush-control".into())
            .spawn(move || control_loop(fd, main))
            .map_err(|e| PyOSError::new_err(e.to_string()))?;
    }
    #[cfg(not(unix))]
    let _ = control;
    let mut lines = Lines::new(borrow_file(input));
    let mut out = borrow_file(output);
    loop {
        let line = match py.detach(|| lines.next()) {
            Ok(Some(line)) => line,
            Ok(None) => return Ok(()),
            Err(e) => return Err(PyOSError::new_err(e.to_string())),
        };
        // (idle: whatever arrived while no request was admitted is handled
        // now, by handlers that find nothing running and ignore it)
        let _ = py.check_signals();
        let id = serde_json::from_slice::<serde_json::Value>(&line).ok().and_then(|v| v.get("id").and_then(|x| x.as_u64()));
        let serial = admit(id);
        #[cfg(feature = "test-hooks")]
        hooks::at_admission();
        let text = String::from_utf8_lossy(&line).into_owned();
        let ran = run_request.call1((text, serial));
        close();
        let reply = match ran {
            Ok(reply) => Some(reply),
            Err(mut exc) => loop {
                match fallback_reply.call1((id, serial, exc.value(py))) {
                    Ok(reply) => break Some(reply),
                    Err(e) if is_keyboard_interrupt(py, &e) => exc = e,
                    Err(_) => break None,
                }
            },
        };
        let wire = match reply {
            None => native_reply(id, "its fallback failed"),
            Some(reply) => loop {
                match encode.call1((&reply,)).and_then(|s| s.extract::<String>()) {
                    Ok(s) => break s,
                    Err(e) if is_keyboard_interrupt(py, &e) => continue,
                    Err(_) => break native_reply(id, "it couldn't be encoded"),
                }
            },
        };
        let written = py.detach(|| write_all(&mut out, wire.as_bytes()));
        retire();
        match written {
            Ok(true) => {}
            Ok(false) => return Ok(()),
            Err(e) => return Err(PyOSError::new_err(e.to_string())),
        }
    }
}

/// Tests only (a test-hooks build): the injection points of the plan's
/// tests, set from the worker's own namespace.
#[cfg(feature = "test-hooks")]
mod hooks {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};

    /// The next admission is interrupted at once (a KeyboardInterrupt at the
    /// first bytecode of run_request).
    pub static ADMIT_INTERRUPT: AtomicBool = AtomicBool::new(false);
    /// The control thread waits this long after reading an id, before arming.
    pub static ARM_DELAY_MS: AtomicU64 = AtomicU64::new(0);
    /// And this long between a successful arm and its wake.
    pub static WAKE_DELAY_MS: AtomicU64 = AtomicU64::new(0);

    pub fn delay(ms: &AtomicU64) {
        let ms = ms.load(SeqCst);
        if ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
    }

    pub fn at_admission() {
        if ADMIT_INTERRUPT.swap(false, SeqCst) {
            unsafe { pyo3::ffi::PyErr_SetInterrupt() };
        }
    }
}

#[cfg(feature = "test-hooks")]
#[pyfunction(name = "_serve_test")]
fn serve_test(name: &str, value: u64) -> PyResult<()> {
    use std::sync::atomic::Ordering::SeqCst;
    match name {
        "admit_interrupt" => hooks::ADMIT_INTERRUPT.store(value != 0, SeqCst),
        "arm_delay_ms" => hooks::ARM_DELAY_MS.store(value, SeqCst),
        "wake_delay_ms" => hooks::WAKE_DELAY_MS.store(value, SeqCst),
        _ => return Err(pyo3::exceptions::PyValueError::new_err(format!("no such hook: {name}"))),
    }
    Ok(())
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(serve_requests, m)?)?;
    m.add_function(wrap_pyfunction!(serve_take, m)?)?;
    m.add_function(wrap_pyfunction!(serve_busy, m)?)?;
    m.add_function(wrap_pyfunction!(serve_stats, m)?)?;
    m.add_function(wrap_pyfunction!(serve_native_stop, m)?)?;
    #[cfg(feature = "test-hooks")]
    m.add_function(wrap_pyfunction!(serve_test, m)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // (one test touches STATE: the loop's state is the process's)
    #[test]
    fn arm_take_and_retire() {
        let s = admit(Some(7));
        assert!(!arm(Target::Id(6)), "a stale id arms nothing");
        assert!(arm(Target::Id(7)));
        assert!(serve_take(), "armed for the running request");
        assert!(!serve_take(), "taken once");
        assert!(arm(Target::Any));
        close();
        assert!(!serve_take(), "closing clears the armed mark");
        assert!(!arm(Target::Id(7)), "nothing to interrupt once its code is over");
        retire();
        let t = admit(Some(8));
        assert_eq!(t, s + 1);
        assert!(!arm(Target::Id(7)), "the committed request's id never arms the next");
        assert!(serve_busy());
        retire();
        assert!(!serve_busy() && !arm(Target::Any));
    }

    #[test]
    fn targets_and_lines() {
        assert_eq!(parse_target(b"*"), Some(Target::Any));
        assert_eq!(parse_target(b" 12 "), Some(Target::Id(12)));
        assert_eq!(parse_target(b"x"), None);
        assert_eq!(parse_target(b"-1"), None);
    }

    #[cfg(unix)]
    #[test]
    fn lines_across_short_reads() {
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let w = fds[1];
        let t = std::thread::spawn(move || {
            let mut w = borrow_file(w as i64);
            for piece in [&b"{\"id\":"[..], b"1}\n{\"id\"", b":2}\n", b"tail"] {
                w.write_all(piece).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            unsafe { libc::close(w.as_raw_fd()) };
        });
        let mut lines = Lines::new(borrow_file(fds[0] as i64));
        assert_eq!(lines.next().unwrap().unwrap(), b"{\"id\":1}");
        assert_eq!(lines.next().unwrap().unwrap(), b"{\"id\":2}");
        assert_eq!(lines.next().unwrap().unwrap(), b"tail");
        assert_eq!(lines.next().unwrap(), None);
        t.join().unwrap();
        unsafe { libc::close(fds[0]) };
    }
}
