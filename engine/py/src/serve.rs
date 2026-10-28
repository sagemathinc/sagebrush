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
use pyo3::types::{PyDict, PyString};
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
    /// Requests whose reply couldn't be written whole (the parent gone, or a
    /// write error): ended without a commit, and the loop with them.
    aborted: u64,
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
    aborted: 0,
});

/// The request reader's buffer capacity and its idle releases so far, as of
/// its last line (reported in _serve_stats: the r5 semantic memory gate).
static INPUT_CAPACITY: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static INPUT_RELEASES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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

/// The reply was written whole: the request is committed.
fn commit() {
    let mut st = state();
    st.phase = Phase::Idle;
    st.id = None;
    st.armed = None;
    st.replied += 1;
}

/// Its reply couldn't be written whole: the request ends uncommitted
/// (astra's CORR-CTRLC-B-2), and no next one is read.
fn abort() {
    let mut st = state();
    st.phase = Phase::Idle;
    st.id = None;
    st.armed = None;
    st.aborted += 1;
}

/// The request's id, from its line's start: the parent writes it first,
/// `{"id": N, ...}` (Session._send), so admission needs no parse of the rest
/// (daybreak2's PR B r1 #1).  None if the line doesn't start so.
fn request_id(line: &[u8]) -> Option<u64> {
    let mut i = 0;
    let ws = |i: &mut usize| while *i < line.len() && matches!(line[*i], b' ' | b'\t' | b'\r' | b'\n') { *i += 1 };
    ws(&mut i);
    if line.get(i) != Some(&b'{') { return None; }
    i += 1;
    ws(&mut i);
    if !line[i..].starts_with(b"\"id\"") { return None; }
    i += 4;
    ws(&mut i);
    if line.get(i) != Some(&b':') { return None; }
    i += 1;
    ws(&mut i);
    let start = i;
    while i < line.len() && line[i].is_ascii_digit() && i - start < 20 { i += 1; }
    if i == start || (line[start] == b'0' && i - start > 1) { return None; }
    if !matches!(line.get(i), Some(b',' | b'}' | b' ' | b'\t' | b'\r' | b'\n')) { return None; }
    std::str::from_utf8(&line[start..i]).ok()?.parse().ok()
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
    let (admitted, replied, stale, woken, late, aborted) = {
        let st = state();
        (st.serial, st.replied, st.stale, st.woken, st.late, st.aborted)
    };
    let d = PyDict::new(py);
    d.set_item("admitted", admitted)?;
    d.set_item("replied", replied)?;
    d.set_item("stale", stale)?;
    d.set_item("woken", woken)?;
    d.set_item("late", late)?;
    d.set_item("aborted", aborted)?;
    d.set_item("input_capacity", INPUT_CAPACITY.load(std::sync::atomic::Ordering::Relaxed))?;
    d.set_item("input_releases", INPUT_RELEASES.load(std::sync::atomic::Ordering::Relaxed))?;
    d.set_item("read_chunk", READ_CHUNK)?;
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

/// An inherited descriptor (POSIX) or handle (Windows), read and written
/// here, never closed.
struct Borrowed(ManuallyDrop<std::fs::File>);

impl Read for Borrowed {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        (*self.0).read(b)
    }
}

impl Write for Borrowed {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        (*self.0).write(b)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        (*self.0).flush()
    }
}

/// The process's monotonic clock, for the idle wait's deadline.
fn monotonic() -> std::time::Duration {
    static T0: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    T0.get_or_init(std::time::Instant::now).elapsed()
}

/// POSIX: poll(2) for readable input (or its end), the GIL released by the caller.
#[cfg(unix)]
impl Source for Borrowed {
    #[allow(unsafe_code)]
    fn readable_within(&mut self, within: std::time::Duration) -> std::io::Result<bool> {
        use std::os::unix::io::AsRawFd;
        // (rounded up to a whole millisecond, so a wait never returns before its deadline as a 0 ms poll)
        let ms = within.as_micros().div_ceil(1000).min(i32::MAX as u128) as i32;
        let mut p = libc::pollfd { fd: self.0.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        let r = unsafe { libc::poll(&mut p, 1, ms) };
        if r < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(r > 0)
    }
    fn now(&self) -> std::time::Duration {
        monotonic()
    }
}

/// Windows: an anonymous pipe has nothing to wait on, so the burst reuse
/// is POSIX-only by design (daybreak2's r5 ruling, option (i) alone; astra and
/// daybreak2 YES): a fully consumed large buffer is let go at once, never
/// kept.  "Not readable" here means only that there is no burst grace: the
/// reader then makes its normal blocking read, as on POSIX (never an end of
/// input, never dropped data, never a spin); a partial line or a backlog is
/// kept as everywhere.
#[cfg(windows)]
impl Source for Borrowed {
    fn readable_within(&mut self, _within: std::time::Duration) -> std::io::Result<bool> {
        Ok(false)
    }
    fn now(&self) -> std::time::Duration {
        monotonic()
    }
    fn can_wait(&self) -> bool {
        false
    }
}

/// A descriptor (POSIX) or handle (Windows) the caller owns, as a File that is never closed here.
#[allow(unsafe_code)]
fn borrow_file(f: i64) -> Borrowed {
    #[cfg(unix)]
    let file = {
        use std::os::unix::io::FromRawFd;
        unsafe { std::fs::File::from_raw_fd(f as i32) }
    };
    #[cfg(windows)]
    let file = {
        use std::os::windows::io::FromRawHandle;
        unsafe { std::fs::File::from_raw_handle(f as isize as _) }
    };
    Borrowed(ManuallyDrop::new(file))
}

/// The read quantum: each read asks for at most this many bytes, and a line
/// longer than this, read cold, is staged in pieces of this size and laid out
/// once at its exact size (daybreak2's PR B r5 ruling: bounded cold growth).
const READ_CHUNK: usize = 1 << 16;

/// How long a fully consumed buffer larger than READ_CHUNK is kept for the
/// next request of a burst: if no input is readable for this long after a
/// reply, the capacity is let go before the reader blocks (daybreak2's PR B
/// r5 ruling: burst reuse, bounded).
const IDLE_RELEASE_LIMIT: std::time::Duration = std::time::Duration::from_millis(250);

/// What the reader reads from: bytes, whether some become readable within a
/// time, and a monotonic clock (a seam: the tests drive both deterministically).
trait Source: Read {
    /// Ok(true) as soon as input (or its end) is readable, Ok(false) once
    /// `within` passed without; Interrupted is retried by the caller, with
    /// the time left to the same deadline.
    fn readable_within(&mut self, within: std::time::Duration) -> std::io::Result<bool>;
    fn now(&self) -> std::time::Duration;
    /// Whether this source can wait for input at all (false: the idle wait is
    /// skipped, and a large buffer is let go as soon as it is all consumed).
    fn can_wait(&self) -> bool {
        true
    }
}

/// Newline-framed lines from a source, its own buffer kept across short
/// reads, EINTR retried.  The lines taken are passed by a head cursor, not
/// drained from the front each time; the buffer is compacted only when the
/// taken part is most of it, so a backlog of many queued lines costs time
/// linear in its bytes (daybreak2's PR B r1 #4).  A line is handed out as a
/// range of the buffer, read with `get` and not copied; it is let go, with
/// any compaction or release, only at the next call (the borrow checker keeps
/// a `get` slice from outliving it).
///
/// Memory (daybreak2's PR B r5 ruling): a line that doesn't fit the buffer's
/// capacity is read into READ_CHUNK pieces, and laid out once at its exact
/// size when it ends, so a cold long line's live bytes stay within twice its
/// length plus a few pieces, with no regrowth copies; the buffer is then kept
/// for the requests that follow, and let go (to no capacity) only when it is
/// all consumed and no input is readable for IDLE_RELEASE_LIMIT.  A partial
/// line or a backlog is never let go.
struct Lines<R: Source> {
    f: R,
    buf: Vec<u8>,
    head: usize,
    /// Where the unconsumed bytes start once the line last handed out is let go.
    taken: usize,
    scanned: usize,
    eof: bool,
    /// A long line's pieces, in order, until its newline (or the end) arrives,
    /// each of its exact size, and their total.
    stage: Vec<Vec<u8>>,
    staged: usize,
    /// Large buffers let go after an idle wait (reported in _serve_stats).
    releases: u64,
    /// Long lines laid out from pieces (tests: a warm buffer takes none).
    flattens: u64,
    /// The most bytes of capacity held at once, buffer and pieces (tests).
    peak: usize,
}

impl<R: Source> Lines<R> {
    fn new(f: R) -> Lines<R> {
        Lines { f, buf: Vec::new(), head: 0, taken: 0, scanned: 0, eof: false, stage: Vec::new(), staged: 0, releases: 0, flattens: 0, peak: 0 }
    }

    /// The bytes of the range `next` returned last.
    fn get(&self, r: std::ops::Range<usize>) -> &[u8] {
        &self.buf[r]
    }

    /// The buffer's capacity now (reported in _serve_stats).
    fn capacity(&self) -> usize {
        self.buf.capacity()
    }

    fn note_peak(&mut self) {
        let live = self.buf.capacity() + self.staged;
        self.peak = self.peak.max(live);
    }

    fn compact(&mut self) {
        if self.head == self.buf.len() {
            self.buf.clear();
            self.head = 0;
        } else if self.head >= READ_CHUNK && self.head * 2 >= self.buf.len() {
            self.buf.drain(..self.head);
            self.head = 0;
        }
    }

    /// Whether input becomes readable before IDLE_RELEASE_LIMIT passes: one
    /// deadline, taken once (an interrupted or early wait goes on to it).
    fn readable_soon(&mut self) -> std::io::Result<bool> {
        if !self.f.can_wait() {
            return Ok(false);
        }
        let end = self.f.now() + IDLE_RELEASE_LIMIT;
        loop {
            let now = self.f.now();
            if now >= end {
                return Ok(false);
            }
            match self.f.readable_within(end - now) {
                Ok(true) => return Ok(true),
                Ok(false) => {}
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
    }

    /// Lay the staged pieces out once, at their exact total size plus one read
    /// quantum (so that the next request of a burst, of the same size, fits
    /// without staging again), as the buffer.
    fn flatten(&mut self) -> std::io::Result<()> {
        let total = self.staged.checked_add(READ_CHUNK).ok_or_else(|| std::io::Error::other("a request line too long to hold"))?;
        let mut flat = Vec::with_capacity(total);
        self.peak = self.peak.max(self.staged + flat.capacity());
        for p in self.stage.drain(..) {
            flat.extend_from_slice(&p);
        }
        self.staged = 0;
        self.buf = flat;
        self.head = 0;
        self.flattens += 1;
        Ok(())
    }

    /// The next line's range, without its newline; a last line without one
    /// is still a line; None at the end.
    fn next(&mut self) -> std::io::Result<Option<std::ops::Range<usize>>> {
        self.head = self.taken;
        self.compact();
        if self.head == self.buf.len() && self.buf.capacity() > READ_CHUNK && !self.eof && !self.readable_soon()? {
            self.buf = Vec::new();  // (idle after a burst: the large capacity let go before blocking)
            self.releases += 1;
        }
        loop {
            if self.stage.is_empty() {
                let from = self.head + self.scanned;
                if let Some(i) = memchr::memchr(b'\n', &self.buf[from..]) {
                    let (start, end) = (self.head, from + i);
                    self.taken = end + 1;
                    self.scanned = 0;
                    return Ok(Some(start..end));
                }
                self.scanned = self.buf.len() - self.head;
                if self.eof {
                    self.taken = self.buf.len();
                    if self.head == self.buf.len() {
                        return Ok(None);
                    }
                    self.scanned = 0;
                    return Ok(Some(self.head..self.buf.len()));
                }
                self.compact();
            }
            let mut chunk = [0u8; READ_CHUNK];
            let n = match self.f.read(&mut chunk) {
                Ok(0) => {
                    self.eof = true;
                    if !self.stage.is_empty() {
                        self.flatten()?;  // (the last line, without a newline)
                        self.scanned = self.buf.len();
                    }
                    continue;
                }
                Ok(n) => n,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            let partial = self.buf.len() - self.head;
            if self.stage.is_empty() && self.buf.capacity() - self.buf.len() >= n {
                self.buf.extend_from_slice(&chunk[..n]);  // (it fits: no growth)
            } else if self.stage.is_empty() && partial + n <= 2 * READ_CHUNK {
                // (a short partial line, or the tail of a backlog: moved to the front, and grown within two quanta)
                self.buf.drain(..self.head);
                self.head = 0;
                self.buf.extend_from_slice(&chunk[..n]);
                self.note_peak();
            } else {
                // (a line longer than the buffer: the partial line becomes the first piece, the
                // buffer is let go, and the rest is read into pieces until the newline)
                if self.stage.is_empty() {
                    let first = self.buf[self.head..].to_vec();
                    self.note_peak();
                    self.buf = Vec::new();
                    self.head = 0;
                    self.staged = first.len();
                    self.stage.push(first);
                }
                let known = self.staged;  // (the line so far: no newline in it)
                let piece = chunk[..n].to_vec();
                let newline = memchr::memchr(b'\n', &piece).is_some();
                self.staged += piece.len();
                self.stage.push(piece);
                self.note_peak();
                if newline {
                    self.flatten()?;
                    self.scanned = known;
                }
            }
        }
    }
}

/// Every byte written, EINTR and EAGAIN retried: Ok(true) only then;
/// Ok(false) if the reader is gone (EPIPE, or a write of nothing); Err for
/// another error, perhaps after part of it was written.
fn write_all<W: Write>(f: &mut W, mut bytes: &[u8]) -> std::io::Result<bool> {
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
#[allow(unsafe_code)]
unsafe impl Send for MainThread {}

/// The calling thread, for the control thread's wake.
#[cfg(unix)]
#[allow(unsafe_code)]
fn this_thread() -> MainThread {
    MainThread(unsafe { libc::pthread_self() })
}

#[cfg(unix)]
fn control_loop(fd: i64, main: MainThread) {
    let mut lines = Lines::new(borrow_file(fd));
    while let Ok(Some(r)) = lines.next() {
        #[cfg(feature = "test-hooks")]
        hooks::delay(&hooks::ARM_DELAY_MS);
        let Some(target) = parse_target(lines.get(r)) else { continue };
        if arm(target) {
            #[cfg(feature = "test-hooks")]
            hooks::delay(&hooks::WAKE_DELAY_MS);
            wake(main);
        }
    }
}

/// Wake the main thread for an armed request: SIGUSR1, thread-directed, so
/// that a blocking call there (time.sleep, a read) returns with EINTR and
/// Python runs the handler.  SIGUSR1 is the worker's own signal: user code
/// that replaces or resets its action is outside the session's no-restart
/// guarantee.  The check below only avoids sending it to a SIG_DFL or
/// SIG_IGN action seen just before; a reset between that check and the
/// pthread_kill can still end the worker (astra's note), and the parent's
/// restart then follows.
#[cfg(unix)]
#[allow(unsafe_code)]
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

/// A reply line: the str `encode` returned (written from its own UTF-8, no
/// copy), or one built here.
enum Wire<'py> {
    Encoded(Bound<'py, PyString>),
    Native(String),
}

impl Wire<'_> {
    fn bytes(&self) -> &[u8] {
        match self {
            Wire::Encoded(s) => s.to_str().map(str::as_bytes).unwrap_or_default(),  // (checked when made)
            Wire::Native(t) => t.as_bytes(),
        }
    }
}

/// The request line as a str, decoded from the read buffer in place: one
/// pass, no copy of the line first.  Invalid UTF-8 is replaced, as before.
#[allow(unsafe_code)]
fn line_str<'py>(py: Python<'py>, line: &[u8]) -> Bound<'py, PyAny> {
    // SAFETY: PyUnicode_DecodeUTF8 reads exactly `line.len()` bytes from
    // `line`, which is valid for this call; the GIL is held (`py`); it returns
    // a new reference, or NULL with an exception set, which from_owned_ptr_or_err
    // takes (and the Err drops).
    let s = unsafe {
        Bound::from_owned_ptr_or_err(py, pyo3::ffi::PyUnicode_DecodeUTF8(line.as_ptr().cast(), line.len() as pyo3::ffi::Py_ssize_t, c"strict".as_ptr()))
    };
    s.unwrap_or_else(|_| PyString::new(py, &String::from_utf8_lossy(line)).into_any())
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
        let main = this_thread();
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
        // (filled and scanned detached; the line is then read in place, with
        // the GIL held, and let go only at the next call)
        let range = match py.detach(|| lines.next()) {
            Ok(Some(r)) => r,
            Ok(None) => return Ok(()),
            Err(e) => return Err(PyOSError::new_err(e.to_string())),
        };
        INPUT_CAPACITY.store(lines.capacity(), std::sync::atomic::Ordering::Relaxed);
        INPUT_RELEASES.store(lines.releases, std::sync::atomic::Ordering::Relaxed);
        // (idle: whatever arrived while no request was admitted is handled
        // now, by handlers that find nothing running and ignore it)
        let _ = py.check_signals();
        // (admitted at once: the id from the line's start, the rest parsed
        // once, by run_request's json.loads)
        let line = lines.get(range);
        let id = request_id(line);
        let serial = admit(id);
        #[cfg(feature = "test-hooks")]
        hooks::at_admission(py);
        let text = line_str(py, line);
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
            None => Wire::Native(native_reply(id, "its fallback failed")),
            Some(reply) => loop {
                match encode.call1((&reply,)) {
                    Ok(s) => match s.cast_into::<PyString>() {
                        Ok(s) if s.to_str().is_ok() => break Wire::Encoded(s),
                        _ => break Wire::Native(native_reply(id, "it couldn't be encoded")),
                    },
                    Err(e) if is_keyboard_interrupt(py, &e) => continue,
                    Err(_) => break Wire::Native(native_reply(id, "it couldn't be encoded")),
                }
            },
        };
        // (the encoded str is held, in `wire`, until the write returns: its
        // UTF-8 view is written with the GIL released, which PyO3's to_str
        // allows: "Because `str` objects are immutable, the returned slice is
        // independent of the GIL lifetime")
        let bytes = wire.bytes();
        #[cfg(feature = "test-hooks")]
        let written = py.detach(|| hooks::write_fault(&mut out, bytes).unwrap_or_else(|| write_all(&mut out, bytes)));
        #[cfg(not(feature = "test-hooks"))]
        let written = py.detach(|| write_all(&mut out, bytes));
        drop(wire);
        if let Some(end) = settle(written) {
            return end.map_err(|e| PyOSError::new_err(e.to_string()));
        }
    }
}

/// The reply's write settled: committed if it was written whole (None, the
/// loop goes on); otherwise the request ends uncommitted and the loop ends
/// (Some: how).
fn settle(written: std::io::Result<bool>) -> Option<std::io::Result<()>> {
    match written {
        Ok(true) => {
            commit();
            None
        }
        Ok(false) => {
            abort();
            Some(Ok(()))
        }
        Err(e) => {
            abort();
            Some(Err(e))
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

    /// After admission, the line held this long, GIL released, before
    /// run_request (the held-parse control: a targeted interrupt during it
    /// reaches the admitted request).
    pub static HOLD_MS: AtomicU64 = AtomicU64::new(0);
    /// The next reply's write fails: 1, the reader gone before any byte;
    /// 2, part of it written, then an error.
    pub static WRITE_FAULT: AtomicU64 = AtomicU64::new(0);
    /// Replies written this many bytes at a time, 0.2 ms apart (GIL released),
    /// until set to 0 (daybreak2's r4 control: the encoded str's view stays
    /// valid across a write in many parts).
    pub static SHORT_WRITE: AtomicU64 = AtomicU64::new(0);

    #[allow(unsafe_code)]
    pub fn at_admission(py: pyo3::Python<'_>) {
        if ADMIT_INTERRUPT.swap(false, SeqCst) {
            unsafe { pyo3::ffi::PyErr_SetInterrupt() };
        }
        let ms = HOLD_MS.swap(0, SeqCst);
        if ms > 0 {
            py.detach(|| std::thread::sleep(std::time::Duration::from_millis(ms)));
        }
    }

    pub fn write_fault<W: std::io::Write>(w: &mut W, bytes: &[u8]) -> Option<std::io::Result<bool>> {
        match WRITE_FAULT.swap(0, SeqCst) {
            1 => Some(Ok(false)),
            2 => {
                let _ = w.write_all(&bytes[..bytes.len() / 2]);
                Some(Err(std::io::Error::other("an injected write error")))
            }
            _ => match SHORT_WRITE.load(SeqCst) as usize {
                0 => None,
                k => {
                    for part in bytes.chunks(k) {
                        match super::write_all(w, part) {
                            Ok(true) => std::thread::sleep(std::time::Duration::from_micros(200)),
                            other => return Some(other),
                        }
                    }
                    Some(Ok(true))
                }
            },
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
        "hold_ms" => hooks::HOLD_MS.store(value, SeqCst),
        "write_fault" => hooks::WRITE_FAULT.store(value, SeqCst),
        "short_write" => hooks::SHORT_WRITE.store(value, SeqCst),
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

    /// The next line's bytes, copied (the tests' view of `next` and `get`).
    fn take<R: Read>(lines: &mut Lines<R>) -> Option<Vec<u8>> {
        lines.next().unwrap().map(|r| lines.get(r).to_vec())
    }

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
        let (r0, a0) = { let st = state(); (st.replied, st.aborted) };
        assert!(settle(Ok(true)).is_none(), "a complete write: the loop goes on");
        assert_eq!({ let st = state(); (st.replied, st.aborted) }, (r0 + 1, a0), "a complete write is one commit");
        let t = admit(Some(8));
        assert_eq!(t, s + 1);
        assert!(!arm(Target::Id(7)), "the committed request's id never arms the next");
        assert!(serve_busy());
        close();
        let (r1, a1) = { let st = state(); (st.replied, st.aborted) };
        assert!(matches!(settle(Ok(false)), Some(Ok(()))), "the reader gone: the loop ends");
        assert_eq!({ let st = state(); (st.replied, st.aborted) }, (r1, a1 + 1), "an incomplete write is no commit (CORR-CTRLC-B-2)");
        assert!(!serve_busy() && !arm(Target::Any));
        admit(Some(9));
        close();
        assert!(matches!(settle(Err(std::io::Error::other("x"))), Some(Err(_))), "a write error: the loop ends with it");
        assert_eq!({ let st = state(); (st.replied, st.aborted) }, (r1, a1 + 2), "a failed write is no commit either");
        assert!(!serve_busy() && !arm(Target::Any));
    }

    #[test]
    fn targets_and_lines() {
        assert_eq!(parse_target(b"*"), Some(Target::Any));
        assert_eq!(parse_target(b" 12 "), Some(Target::Id(12)));
        assert_eq!(parse_target(b"x"), None);
        assert_eq!(parse_target(b"-1"), None);
    }

    #[test]
    fn request_ids_from_the_line_start() {
        assert_eq!(request_id(br#"{"id": 12, "code": "x"}"#), Some(12));
        assert_eq!(request_id(br#"  {"id":7}"#), Some(7));
        assert_eq!(request_id(br#"{"id": 0, "code": "x"}"#), Some(0));
        for bad in [&br#"{"code": "x", "id": 3}"#[..], br#"{"id": "3"}"#, br#"{"id": 3.5}"#, br#"{"id": -1}"#, br#"{"id": 007}"#, br#"[1]"#, b"", br#"{"id": 123456789012345678901234}"#, br#"{"idx": 3}"#, br#"{"ab": 3}"#, br#"{ "di" : 3}"#] {
            assert_eq!(request_id(bad), None, "{}", String::from_utf8_lossy(bad));
        }
    }

    /// A reader giving its bytes in the given chunk sizes, cycling, and EINTR between them.
    struct Chunks { data: Vec<u8>, at: usize, sizes: Vec<usize>, k: usize, eintr: bool }
    impl Read for Chunks {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            self.eintr = !self.eintr;
            if self.eintr { return Err(std::io::Error::from(ErrorKind::Interrupted)); }
            let n = self.sizes[self.k % self.sizes.len()].min(b.len()).min(self.data.len() - self.at);
            self.k += 1;
            b[..n].copy_from_slice(&self.data[self.at..self.at + n]);
            self.at += n;
            Ok(n)
        }
    }
    impl Source for Chunks {
        fn readable_within(&mut self, _within: std::time::Duration) -> std::io::Result<bool> {
            Ok(true)  // (everything is there already: input is always readable)
        }
        fn now(&self) -> std::time::Duration {
            std::time::Duration::ZERO
        }
    }

    /// A source on a fake clock (ms): each part arrives at its time; a read
    /// returns what has arrived (a blocking read moves the clock to the next
    /// arrival); `readable_within` answers from the arrivals, moves the clock
    /// as a wait would, and is interrupted at the scripted times.  Every wait
    /// is recorded as (start, within).
    struct Timed {
        parts: std::collections::VecDeque<(u64, Vec<u8>)>,
        cur: Vec<u8>,
        at: usize,
        clock: u64,
        eintr_at: Vec<u64>,
        waits: Vec<(u64, u64)>,
    }
    impl Timed {
        fn new(parts: Vec<(u64, Vec<u8>)>, eintr_at: Vec<u64>) -> Timed {
            Timed { parts: parts.into(), cur: Vec::new(), at: 0, clock: 0, eintr_at, waits: Vec::new() }
        }
    }
    impl Read for Timed {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            if self.at == self.cur.len() {
                match self.parts.pop_front() {
                    None => return Ok(0),
                    Some((t, data)) => {
                        self.clock = self.clock.max(t);
                        self.cur = data;
                        self.at = 0;
                    }
                }
            }
            let n = (self.cur.len() - self.at).min(b.len()).min(READ_CHUNK);
            b[..n].copy_from_slice(&self.cur[self.at..self.at + n]);
            self.at += n;
            Ok(n)
        }
    }
    impl Source for Timed {
        fn readable_within(&mut self, within: std::time::Duration) -> std::io::Result<bool> {
            let within = within.as_millis() as u64;
            self.waits.push((self.clock, within));
            assert!(self.waits.len() < 1000, "waiting on and on: {:?}", &self.waits[..4]);
            if self.at < self.cur.len() {
                return Ok(true);
            }
            let deadline = self.clock + within;
            let next = self.parts.front().map(|p| p.0).unwrap_or(0);  // (the end is readable at once)
            if let Some(k) = self.eintr_at.iter().position(|&e| e >= self.clock && e < deadline.min(next.max(self.clock))) {
                self.clock = self.eintr_at.remove(k);
                return Err(std::io::Error::from(ErrorKind::Interrupted));
            }
            if next <= deadline {
                self.clock = self.clock.max(next);
                Ok(true)
            } else {
                self.clock = deadline;
                Ok(false)
            }
        }
        fn now(&self) -> std::time::Duration {
            std::time::Duration::from_millis(self.clock)
        }
    }
    fn line(n: usize, b: u8) -> Vec<u8> {
        let mut v = vec![b; n];
        v.push(b'\n');
        v
    }

    #[test]
    fn lines_backlog_and_compaction() {
        // (200,000 queued lines, in odd chunk sizes, across the compaction threshold, and a last line without a newline)
        let mut data = Vec::new();
        for i in 0..200_000u32 { data.extend_from_slice(format!("{{\"id\": {i}, \"code\": \"x\"}}\n").as_bytes()); }
        data.extend_from_slice(b"tail");
        let mut lines = Lines::new(Chunks { data, at: 0, sizes: vec![1, 7, 65536, 300, 4093], k: 0, eintr: false });
        let t = std::time::Instant::now();
        for i in 0..200_000u64 {
            let l = take(&mut lines).unwrap();
            assert_eq!(request_id(&l), Some(i));
        }
        assert_eq!(take(&mut lines).unwrap(), b"tail");
        assert_eq!(take(&mut lines), None);
        assert!(lines.buf.len() < 1 << 18, "the buffer kept {} bytes", lines.buf.len());
        assert!(t.elapsed() < std::time::Duration::from_secs(5), "{:?}", t.elapsed());
    }

    #[test]
    fn lines_compact_mid_stream() {
        // (32-byte lines in 65535-byte reads: a read ends on a line's end
        // only every 32 reads, so the backlog's compaction, not its clearing
        // when all of it is consumed, is what bounds the buffer)
        let mut data = Vec::new();
        for i in 0..200_000u32 { data.extend_from_slice(format!("{{\"id\": {i:>8}, \"code\": \"xxx\"}}\n").as_bytes()); }
        assert_eq!(data.len(), 200_000 * 32);
        let mut lines = Lines::new(Chunks { data, at: 0, sizes: vec![65535], k: 0, eintr: false });
        let mut most = 0;
        for i in 0..200_000u64 {
            let l = take(&mut lines).unwrap();
            assert_eq!(request_id(&l), Some(i));
            most = most.max(lines.buf.len());
        }
        assert_eq!(take(&mut lines), None);
        assert!(most < 1 << 18, "the buffer reached {most} bytes");
    }

    #[test]
    fn lines_cold_growth_bounded() {
        // (daybreak2's r5 gate (i): a 32 MiB line, then small ones queued behind it, in fragmented reads, read
        // cold: staged in pieces and laid out once (one flatten), the live peak within twice the line plus a few
        // read quanta, and the lines exact; the last one without a newline)
        let mut data = vec![b'x'; 32 << 20];
        data.extend_from_slice(b"\n{\"id\": 1}\n{\"id\": 2}\nlast, no newline");
        let mut lines = Lines::new(Chunks { data, at: 0, sizes: vec![READ_CHUNK, 1, 777, READ_CHUNK - 1], k: 0, eintr: false });
        let r = lines.next().unwrap().unwrap();
        assert_eq!(r.len(), 32 << 20);
        assert!(lines.get(r).iter().all(|&b| b == b'x'));
        assert_eq!(lines.flattens, 1);
        assert!(lines.peak <= 2 * (32 << 20) + 4 * READ_CHUNK, "a peak of {} bytes", lines.peak);
        assert_eq!(take(&mut lines).unwrap(), b"{\"id\": 1}");
        assert_eq!(take(&mut lines).unwrap(), b"{\"id\": 2}");
        assert_eq!(take(&mut lines).unwrap(), b"last, no newline");
        assert_eq!(take(&mut lines), None);
        // (a long line that ends with the input, no newline: staged, then laid out at the end)
        let mut lines = Lines::new(Chunks { data: vec![b'z'; 200_000], at: 0, sizes: vec![READ_CHUNK], k: 0, eintr: false });
        let l = take(&mut lines).unwrap();
        assert!(l.len() == 200_000 && l.iter().all(|&b| b == b'z'));
        assert_eq!(take(&mut lines), None);
    }

    #[test]
    fn lines_burst_reuse() {
        // (daybreak2's r5 gate (ii): the next request arrives 100 ms after the last, within the idle limit: the
        // buffer is kept and the next long line read into it, warm (no staging); one wait, of the full limit)
        let n = 300_000;
        let mut lines = Lines::new(Timed::new(vec![(0, line(n, b'a')), (100, line(n, b'b'))], vec![]));
        assert_eq!(take(&mut lines).unwrap(), vec![b'a'; n]);
        assert_eq!(take(&mut lines).unwrap(), vec![b'b'; n]);
        assert_eq!((lines.flattens, lines.releases), (1, 0));
        assert_eq!(lines.f.waits, vec![(0, 250)]);
        // (readable exactly at the deadline: it wins, nothing is let go)
        let mut lines = Lines::new(Timed::new(vec![(0, line(n, b'a')), (250, line(10, b'c'))], vec![]));
        take(&mut lines).unwrap();
        assert_eq!(take(&mut lines).unwrap(), vec![b'c'; 10]);
        assert_eq!(lines.releases, 0);
    }

    #[test]
    fn lines_idle_release() {
        // (no input for the idle limit after a long line: its capacity is let go before the reader blocks, and
        // the next request, a second later, is read as usual)
        let n = 300_000;
        let mut lines = Lines::new(Timed::new(vec![(0, line(n, b'a')), (1000, line(10, b'c'))], vec![]));
        take(&mut lines).unwrap();
        assert_eq!(take(&mut lines).unwrap(), vec![b'c'; 10]);
        assert_eq!(lines.releases, 1);
        assert!(lines.capacity() <= READ_CHUNK, "kept {} bytes", lines.capacity());
        assert_eq!(lines.f.waits, vec![(0, 250)]);
        // (interrupted waits go on to the one deadline, never a new one)
        let mut lines = Lines::new(Timed::new(vec![(0, line(n, b'a')), (1000, line(10, b'c'))], vec![100, 200]));
        take(&mut lines).unwrap();
        assert_eq!(take(&mut lines).unwrap(), vec![b'c'; 10]);
        assert_eq!(lines.releases, 1);
        assert_eq!(lines.f.waits, vec![(0, 250), (100, 150), (200, 50)]);
    }

    #[test]
    fn lines_never_release_a_partial_line() {
        // (the long line's newline is followed by the start of the next line: nothing is waited for or let go,
        // and the next line, finished a second later, is exact)
        let n = 300_000;
        let mut first = line(n, b'a');
        first.extend_from_slice(b"partial-");
        let mut lines = Lines::new(Timed::new(vec![(0, first), (1000, b"start\n".to_vec())], vec![]));
        take(&mut lines).unwrap();
        assert_eq!(take(&mut lines).unwrap(), b"partial-start");
        assert_eq!(lines.releases, 0);
        assert!(lines.f.waits.is_empty(), "{:?}", lines.f.waits);
    }

    #[test]
    fn lines_queued_and_at_the_boundary() {
        // (lines whose framed length is READ_CHUNK - 1, READ_CHUNK and READ_CHUNK + 1, queued together and
        // read in odd fragments: each exact)
        let mut data = Vec::new();
        for n in [READ_CHUNK - 2, READ_CHUNK - 1, READ_CHUNK, 0, 3] {
            data.extend(std::iter::repeat_n(b'z', n));
            data.push(b'\n');
        }
        let mut lines = Lines::new(Chunks { data, at: 0, sizes: vec![7, READ_CHUNK, 3, READ_CHUNK - 5], k: 0, eintr: false });
        for n in [READ_CHUNK - 2, READ_CHUNK - 1, READ_CHUNK, 0, 3] {
            let l = take(&mut lines).unwrap();
            assert!(l.len() == n && l.iter().all(|&b| b == b'z'), "{} for {}", l.len(), n);
        }
        assert_eq!(take(&mut lines), None);
    }

    /// A writer taking at most `n` bytes a call, with EINTR between, then failing as told after `fail_after` bytes.
    struct Sink { got: Vec<u8>, n: usize, eintr: bool, fail_after: Option<(usize, ErrorKind)> }
    impl Write for Sink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            if let Some((at, kind)) = self.fail_after { if self.got.len() >= at { return Err(std::io::Error::from(kind)); } }
            self.eintr = !self.eintr;
            if self.eintr { return Err(std::io::Error::from(ErrorKind::Interrupted)); }
            let n = self.n.min(b.len());
            self.got.extend_from_slice(&b[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }

    #[test]
    fn writes_whole_or_says_not() {
        let line = vec![b'x'; 10_000];
        let mut s = Sink { got: vec![], n: 333, eintr: false, fail_after: None };
        assert!(write_all(&mut s, &line).unwrap(), "short writes and EINTR: whole");
        assert_eq!(s.got, line);
        let mut s = Sink { got: vec![], n: 333, eintr: false, fail_after: Some((0, ErrorKind::BrokenPipe)) };
        assert!(!write_all(&mut s, &line).unwrap(), "the reader gone before any byte: not written");
        let mut s = Sink { got: vec![], n: 333, eintr: false, fail_after: Some((3000, ErrorKind::Other)) };
        assert!(write_all(&mut s, &line).is_err(), "part written, then an error: an error");
        assert!(s.got.len() < line.len());
    }

    #[cfg(unix)]
    #[test]
    #[allow(unsafe_code)]
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
            unsafe { libc::close(w.0.as_raw_fd()) };
        });
        let mut lines = Lines::new(borrow_file(fds[0] as i64));
        assert_eq!(take(&mut lines).unwrap(), b"{\"id\":1}");
        assert_eq!(take(&mut lines).unwrap(), b"{\"id\":2}");
        assert_eq!(take(&mut lines).unwrap(), b"tail");
        assert_eq!(take(&mut lines), None);
        t.join().unwrap();
        unsafe { libc::close(fds[0]) };
    }
}
