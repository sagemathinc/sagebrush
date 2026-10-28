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
static INPUT_ARENA: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
/// F2: the long-line buffers freed before their requests ran, and those of them that carried read-ahead bytes into
/// the arena (an observation: no allocation is kept for them).
static INPUT_EARLY_RELEASES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static INPUT_EARLY_SUFFIXES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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
    d.set_item("input_arena", INPUT_ARENA.load(std::sync::atomic::Ordering::Relaxed))?;
    d.set_item("input_early_releases", INPUT_EARLY_RELEASES.load(std::sync::atomic::Ordering::Relaxed))?;
    d.set_item("input_early_release_suffix", INPUT_EARLY_SUFFIXES.load(std::sync::atomic::Ordering::Relaxed))?;
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
        // (rounded up to a whole millisecond from the full precision, so a wait never ends before its deadline)
        let ms = within.as_nanos().div_ceil(1_000_000).min(i32::MAX as u128) as i32;
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

/// What the early release did (F2, F3): not the request reader's long-line buffer (the control reader, or the arena
/// itself); or a long-line buffer freed, any read-ahead bytes after its line carried into the arena (counted in
/// `early_suffixes` when there were some).
#[derive(Debug, PartialEq, Eq)]
enum Early {
    NotApplicable,
    Released,
}

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

/// The staging peak bound (see Lines), in the allocations' ACTUAL
/// capacities (daybreak2's r5c item 1): `staged` bytes in pieces filled to
/// `piece` bytes, so p = ceil(staged/piece) pieces, each of actual capacity at
/// most `piece_cap`; each piece-list allocation at most `list_extra` entries
/// beyond the doubling it asked for (so at most max(4, 2p) + list_extra); the
/// flat buffer at most `flat_extra` bytes beyond the staged bytes plus one
/// READ_CHUNK.  Bounded over the three moments: the flatten (flat, pieces and
/// list together), a list growth (pieces and the old and new lists together)
/// and staging start (the old cold buffer, at most 4 READ_CHUNK, and the
/// first pieces).  With the exact capacities std's allocator gives (all the
/// extras 0, piece_cap = piece = READ_CHUNK = C), it is at most about
/// 2 L' + 8 C + 24 (6 L'/C + 12), i.e. (2 + 2^-12 x 9) L' + O(C).
#[cfg(test)]  // (the tests' gate: astra's R5C-1, no production dead code)
fn staging_bound(staged: usize, piece: usize, piece_cap: usize, list_extra: usize, flat_extra: usize) -> usize {
    let p = staged.div_ceil(piece);
    let entry = std::mem::size_of::<Vec<u8>>();
    staged + READ_CHUNK + flat_extra + p * piece_cap + 4 * READ_CHUNK + 2 * piece_cap + entry * (3 * (2 * p).max(4) + 2 * list_extra)
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
/// Memory (daybreak2's PR B r5 ruling, the bound made exact for astra's
/// R5-2): a line that doesn't fit the buffer's capacity is read into pieces
/// of P = READ_CHUNK bytes, and laid out once at its exact size when it ends,
/// with no regrowth copies.  For a cold line staging L' bytes (the line, its
/// newline, and at most READ_CHUNK = C bytes read after it), every input
/// allocation together (buffer, pieces, the piece list's own storage and the
/// moments where old and new allocations coexist), counted in their actual
/// capacities, stays within `staging_bound`: twice the line, plus a few
/// quanta, plus 24 bytes per list entry for a doubling list and its old and
/// new allocations together (with exact capacities about 0.22% of L' at
/// P = 64 KiB); the buffer is then kept
/// for the requests that follow, and let go (to no capacity) only when it is
/// all consumed and no input is readable for IDLE_RELEASE_LIMIT.  A partial
/// line or a backlog is never let go.
///
/// That is the control policy (`Lines::new`: the POSIX control reader, and
/// r5's tests).  The worker's request reader (`Lines::request`, the Windows
/// arena design r2, daybreak2's and astra's rulings) keeps an ARENA instead:
/// allocated once, of actual capacity A >= 2 READ_CHUNK, reads that ask for
/// at most the buffer's free space (the consumed head drained first when
/// less than a quantum is free), and staging only when the unconsumed part of
/// a line fills the whole buffer.  So every request line of framed length (its
/// newline included) at most A, every one up to 2 READ_CHUNK in particular, is
/// read with no allocation, free or regrowth, whatever the read fragmentation
/// and whatever later requests arrive in the same reads.  A longer line stages
/// as above, with the arena kept (cleared) as `spare`; once that line is
/// consumed (decoded: F2 and F3 below; the idle release otherwise), its buffer
/// is freed and the arena swapped back in: no allocation.  The release follows
/// that semantic state (`large`), not a capacity comparison.  Memory: the request reader holds A for the worker's
/// life, and A more than the staging bound while a long line is staged or held.
///
/// F2 (PR B fix design r2c) and F3 (PR B F3 design r1): the request reader
/// frees every consumed long-line buffer as soon as its line is decoded,
/// before the request runs (`release_consumed_long_line`), any read-ahead
/// bytes after the line carried into the arena.  So no consumed long-line
/// allocation straddles run_request: through every request, of any length,
/// the reader's input storage is exactly its arena (`large` false,
/// `capacity()` equal to `arena_cap`), read-ahead input included.  The burst
/// reuse is given up for the request reader: each long line stages afresh.
struct Lines<R: Source> {
    f: R,
    buf: Vec<u8>,
    head: usize,
    /// Where the unconsumed bytes start once the line last handed out is let go.
    taken: usize,
    scanned: usize,
    eof: bool,
    /// A long line's pieces, in order, until its newline (or the end) arrives:
    /// each of `piece` capacity (READ_CHUNK; smaller only in tests), filled
    /// before the next is begun (short reads coalesce, so L staged bytes take
    /// at most ceil(L/piece) pieces); the bytes in them, and the pieces'
    /// capacities (kept as running totals, so no accounting scans the list).
    stage: Vec<Vec<u8>>,
    staged: usize,
    stage_caps: usize,
    piece: usize,
    /// Extra capacity asked for, beyond what is needed, for each new piece,
    /// piece list and flat buffer: always 0 except in the tests, which use it
    /// to stand for an allocator that hands out more than requested, so that
    /// the accounting is shown to read actual capacities (daybreak2's r5c item 1).
    extra: (usize, usize, usize),
    /// Large buffers let go after an idle wait (reported in _serve_stats).
    releases: u64,
    /// Long lines laid out from pieces (tests: a warm buffer takes none).
    flattens: u64,
    /// The most bytes of capacity held at once, buffer, spare and pieces (tests).
    peak: usize,
    /// The request reader's arena (see above): its requested size (2 READ_CHUNK; 0 for the control policy), its
    /// actual capacity A, whether `buf` is a flattened long line rather than the arena, and the arena while it is not
    /// in use (allocated, cleared; never freed while the reader lives).
    floor: usize,
    arena_cap: usize,
    large: bool,
    spare: Vec<u8>,
    /// The capacity of a buffer taken out of `buf` at a staging start and still live while its bytes are staged
    /// (astra's accounting witness): counted by capacity(), so every allocation moment in between sees it.
    held: usize,
    /// F2: the early releases so far, all of them and those that carried a suffix.
    early_releases: u64,
    early_suffixes: u64,
}

impl<R: Source> Lines<R> {
    fn new(f: R) -> Lines<R> {
        Lines { f, buf: Vec::new(), head: 0, taken: 0, scanned: 0, eof: false, stage: Vec::new(), staged: 0, stage_caps: 0, piece: READ_CHUNK, extra: (0, 0, 0), releases: 0, flattens: 0, peak: 0, floor: 0, arena_cap: 0, large: false, spare: Vec::new(), held: 0, early_releases: 0, early_suffixes: 0 }
    }

    /// The request reader: an arena of 2 READ_CHUNK (plus `extra`, which only the tests use, to stand for an
    /// allocator that hands out more), its actual capacity recorded and counted from the start.
    fn request_with(f: R, extra: usize) -> Lines<R> {
        let mut l = Lines::new(f);
        l.floor = 2 * READ_CHUNK;
        l.buf = Vec::with_capacity(l.floor + extra);
        l.arena_cap = l.buf.capacity();
        l.note_peak();
        l
    }

    fn request(f: R) -> Lines<R> {
        Lines::request_with(f, 0)
    }

    /// The bytes of the range `next` returned last.
    fn get(&self, r: std::ops::Range<usize>) -> &[u8] {
        &self.buf[r]
    }

    /// Every byte of input storage held now: the buffer's capacity, the
    /// pieces' capacities and the piece list's own (reported in _serve_stats).
    fn capacity(&self) -> usize {
        self.buf.capacity() + self.spare.capacity() + self.held + self.stage_caps + self.stage.capacity() * std::mem::size_of::<Vec<u8>>()
    }

    /// Whether a consumed buffer is let go at an idle moment: the request reader's long-line buffer (semantic: never
    /// the arena, whatever its actual capacity), or under the control policy any buffer over a read quantum.
    fn releasable(&self) -> bool {
        if self.floor > 0 { self.large } else { self.buf.capacity() > READ_CHUNK }
    }

    /// The release: the request reader frees its long-line buffer and takes its arena back (no allocation); the
    /// control policy lets the buffer go to no capacity.
    fn release(&mut self) {
        if self.floor > 0 {
            self.buf = std::mem::take(&mut self.spare);  // (the long-line buffer freed here; the arena, cleared, back)
            self.buf.clear();
            self.large = false;
        } else {
            self.buf = Vec::new();  // (idle after a burst: the large capacity let go before blocking)
        }
        self.releases += 1;
    }

    /// F2 (PR B fix design r2c) and F3, called right after the line `next` handed out last is decoded (its bytes no
    /// longer borrowed): a consumed long-line buffer, whatever its capacity, is freed and the arena taken back, any
    /// read-ahead bytes after the line's newline carried into it, and the cursors reset, so that the next `next()`
    /// scans those bytes once, from their start.  No allocation: they fit the arena.  The control reader, or the arena
    /// itself: NotApplicable.
    fn release_consumed_long_line(&mut self) -> Early {
        if self.floor == 0 || !self.large {
            return Early::NotApplicable;
        }
        // (a long-line buffer exists only just after `flatten`, whose line `next` then returned without reading
        // again: the stage is empty, and what follows the line is what the newline's read brought after it, a read of
        // at most READ_CHUNK bytes, the newline among them; the arena holds at least 2 READ_CHUNK)
        // (and the line starts the buffer: `flatten` set head to 0, and `next` reset scanned as it returned the line)
        assert!(self.stage.is_empty() && self.staged == 0 && self.stage_caps == 0 && self.held == 0, "a staged line at the early release");
        assert!(self.head == 0 && self.scanned == 0, "the long line doesn't start the buffer");
        let suffix = self.buf.len() - self.taken;
        let mut arena = std::mem::take(&mut self.spare);
        assert!(arena.is_empty() && suffix < READ_CHUNK && suffix <= arena.capacity(), "the read-ahead doesn't fit the arena");
        arena.extend_from_slice(&self.buf[self.taken..]);
        self.buf = arena;  // (the long-line buffer freed here)
        self.large = false;
        self.taken = 0;
        self.early_releases += 1;
        if suffix > 0 {
            self.early_suffixes += 1;
        }
        Early::Released
    }

    /// The request reader's staging start: the unconsumed part of the buffer (no newline in it) becomes the first
    /// pieces; the arena is kept, cleared, as the spare (a long-line buffer is freed instead).
    fn stage_whole_buffer(&mut self) {
        let mut old = std::mem::take(&mut self.buf);
        self.held = old.capacity();  // (live, and counted, until it goes or is kept)
        let h = self.head;
        self.stage_bytes(&old[h..]);
        self.note_peak();
        self.held = 0;
        if self.large {
            drop(old);
            self.large = false;
        } else {
            old.clear();
            self.spare = old;
        }
        self.head = 0;
    }

    fn note_peak(&mut self) {
        self.peak = self.peak.max(self.capacity());
    }

    /// Append to the staged line, filling the last piece (to `piece` bytes)
    /// before beginning another.  The piece list grows by doubling into a new
    /// allocation, the old one moved over and then let go; the moment both
    /// exist is counted with their actual capacities, as is every piece.
    fn stage_bytes(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            if self.stage.last().is_none_or(|p| p.len() == self.piece) {
                if self.stage.len() == self.stage.capacity() {
                    let mut grown: Vec<Vec<u8>> = Vec::with_capacity((2 * self.stage.capacity()).max(4) + self.extra.1);
                    let entry = std::mem::size_of::<Vec<u8>>();
                    self.peak = self.peak.max(self.capacity() + grown.capacity() * entry);  // (the old list and the new together)
                    grown.append(&mut self.stage);
                    self.stage = grown;  // (the old list let go here)
                }
                let piece: Vec<u8> = Vec::with_capacity(self.piece + self.extra.0);
                self.stage_caps += piece.capacity();
                self.stage.push(piece);
                self.note_peak();
            }
            let last = self.stage.last_mut().expect("a piece");
            let k = (self.piece - last.len()).min(bytes.len());
            last.extend_from_slice(&bytes[..k]);
            self.staged += k;
            bytes = &bytes[k..];
        }
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
                // (the deadline: one last zero-time probe, so input readable at the boundary still wins; an
                // interrupted probe is tried once more, then the deadline stands: no spin)
                for _ in 0..2 {
                    match self.f.readable_within(std::time::Duration::ZERO) {
                        Ok(r) => return Ok(r),
                        Err(e) if e.kind() == ErrorKind::Interrupted => {}
                        Err(e) => return Err(e),
                    }
                }
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
    /// quantum (room for the newline read's read-ahead; under the control
    /// policy also so that the next request of a burst, of the same size, fits
    /// without staging again: the request reader frees it before its request
    /// runs, F3), as the buffer.
    fn flatten(&mut self) -> std::io::Result<()> {
        let total = self.staged.checked_add(READ_CHUNK).ok_or_else(|| std::io::Error::other("a request line too long to hold"))?;
        let mut flat = Vec::with_capacity(total + self.extra.2);
        self.peak = self.peak.max(self.capacity() + flat.capacity());
        for p in std::mem::take(&mut self.stage) {
            flat.extend_from_slice(&p);
        }  // (each piece is let go as it is copied, and the piece list itself after the last)
        self.staged = 0;
        self.stage_caps = 0;
        self.buf = flat;
        self.large = self.floor > 0;  // (the request reader: a long-line buffer, its arena in spare)
        self.head = 0;
        self.flattens += 1;
        Ok(())
    }

    /// The next line's range, without its newline; a last line without one
    /// is still a line; None at the end.
    fn next(&mut self) -> std::io::Result<Option<std::ops::Range<usize>>> {
        self.head = self.taken;
        self.compact();
        if self.head == self.buf.len() && self.releasable() && !self.eof && !self.readable_soon()? {
            self.release();
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
            let mut want = READ_CHUNK;
            if self.floor > 0 && self.stage.is_empty() {
                // (the request reader's read rule: the consumed head drained when less than a quantum is free; a
                // buffer full of one line's bytes, no newline among them, stages; otherwise a read of at most the
                // free space, so the buffer never grows here)
                if self.head > 0 && self.buf.capacity() - self.buf.len() < READ_CHUNK {
                    self.buf.drain(..self.head);
                    self.head = 0;
                }
                let room = self.buf.capacity() - self.buf.len();
                if room == 0 {
                    self.stage_whole_buffer();
                } else {
                    want = room.min(READ_CHUNK);
                }
            }
            let mut chunk = [0u8; READ_CHUNK];
            let n = match self.f.read(&mut chunk[..want]) {
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
                    let old = std::mem::take(&mut self.buf);
                    self.held = old.capacity();  // (live, and counted, until it goes)
                    let h = self.head;
                    self.stage_bytes(&old[h..]);
                    self.note_peak();
                    self.held = 0;
                    drop(old);
                    self.head = 0;
                }
                let known = self.staged;  // (the line so far: no newline in it)
                let newline = memchr::memchr(b'\n', &chunk[..n]).is_some();
                self.stage_bytes(&chunk[..n]);
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
    let mut lines = Lines::request(borrow_file(input));
    INPUT_ARENA.store(lines.arena_cap, std::sync::atomic::Ordering::Relaxed);
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
        // (F2, F3: `line` is not used after the decode, so its borrow has ended; every consumed long-line buffer is
        // freed here, before the request runs, and the capacity stored again for _serve_stats.  F3's invariant: no
        // consumed long-line allocation straddles run_request, the reader's input storage is exactly its arena)
        lines.release_consumed_long_line();
        debug_assert!(!lines.large && lines.capacity() == lines.arena_cap, "a long-line allocation through run_request");
        INPUT_CAPACITY.store(lines.capacity(), std::sync::atomic::Ordering::Relaxed);
        INPUT_EARLY_RELEASES.store(lines.early_releases, std::sync::atomic::Ordering::Relaxed);
        INPUT_EARLY_SUFFIXES.store(lines.early_suffixes, std::sync::atomic::Ordering::Relaxed);
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
    fn take<R: Source>(lines: &mut Lines<R>) -> Option<Vec<u8>> {
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
            // (an interrupt may land anywhere up to the deadline, the deadline itself included)
            if let Some(k) = self.eintr_at.iter().position(|&e| e >= self.clock && e <= deadline.min(next.max(self.clock))) {
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
    fn lines_compact_within_a_kept_buffer() {
        // (run5's surviving r2-lines-never-compact: since r5 the read path's own drain bounds a growing buffer, so
        // lines_compact_mid_stream no longer reaches compact(); here a 1 MiB line leaves a kept buffer of about
        // 1 MiB + 2 READ_CHUNK (Chunks is always readable: no idle release), every later 65535-byte read fits it,
        // so the read path never drains, and only compact() keeps the used length short: under 2 READ_CHUNK + 32,
        // where without it the length runs up to the whole capacity)
        let mut data = vec![b'x'; 1 << 20];
        data.push(b'\n');
        for i in 0..100_000u32 { data.extend_from_slice(format!("{{\"id\": {i:>8}, \"code\": \"xxx\"}}\n").as_bytes()); }
        let mut lines = Lines::new(Chunks { data, at: 0, sizes: vec![65535], k: 0, eintr: false });
        let big = take(&mut lines).unwrap();
        assert!(big.len() == 1 << 20 && big.iter().all(|&b| b == b'x'));
        assert_eq!(lines.flattens, 1);
        let kept = lines.buf.capacity();
        assert!(kept > 1 << 20, "the big line left {kept} bytes of capacity");  // (the precondition; 1 MiB > 3 READ_CHUNK)
        let mut most = 0;
        for i in 0..100_000u64 {
            let l = take(&mut lines).unwrap();
            assert_eq!(request_id(&l), Some(i));
            most = most.max(lines.buf.len());
        }
        assert_eq!(take(&mut lines), None);
        assert_eq!(lines.buf.capacity(), kept, "the kept buffer was let go or regrown");
        assert!(most < 3 * READ_CHUNK, "the used length reached {most} bytes of a {kept}-byte buffer");
    }

    /// A request line of framed length `n` (its newline included): `n - 1` copies of `b`, then the newline.
    fn framed(n: usize, b: u8) -> Vec<u8> {
        line(n - 1, b)
    }

    #[test]
    fn request_arena_read_ahead() {
        // (astra's WINPOL-1 trace: a framed 2C line read 65000, then at most 65536 a read; r5's rule staged it at
        // partial + n = 196072, the arena reads it in place: after 65000 + 65536 bytes the room is 536, and the last
        // read is the 535 remaining bytes and the newline, no byte of the next request (daybreak2's erratum).  Then a framed 2C - 100 line whose second read carries
        // 100 bytes of the requests behind it: they fit too.  Windows' policy (NoWait) throughout)
        let mut data = framed(2 * READ_CHUNK, b'a');
        data.extend_from_slice(b"{\"id\": 2}\n{\"id\": 3}\n");
        let mut lines = Lines::request(NoWait(Chunks { data, at: 0, sizes: vec![65000, 65536, 65536], k: 0, eintr: false }));
        let (p0, a) = (lines.buf.as_ptr(), lines.arena_cap);
        assert!(a >= 2 * READ_CHUNK);
        assert_eq!(take(&mut lines).unwrap(), vec![b'a'; 2 * READ_CHUNK - 1]);
        assert_eq!(take(&mut lines).unwrap(), b"{\"id\": 2}");
        assert_eq!(take(&mut lines).unwrap(), b"{\"id\": 3}");
        assert_eq!(take(&mut lines), None);
        assert_eq!((lines.flattens, lines.releases), (0, 0));
        assert!(lines.buf.as_ptr() == p0 && lines.buf.capacity() == a, "the arena was reallocated");
        assert_eq!(lines.peak, a);
        let mut data = framed(2 * READ_CHUNK - 100, b'b');
        for i in 0..10u8 { data.extend_from_slice(&framed(10, b'c' + i)); }  // (exactly 100 framed bytes behind it)
        assert_eq!(data.len(), 2 * READ_CHUNK);
        let mut lines = Lines::request(NoWait(Chunks { data, at: 0, sizes: vec![READ_CHUNK], k: 0, eintr: false }));
        let p0 = lines.buf.as_ptr();
        assert_eq!(take(&mut lines).unwrap(), vec![b'b'; 2 * READ_CHUNK - 101]);
        for i in 0..10u8 { assert_eq!(take(&mut lines).unwrap(), vec![b'c' + i; 9]); }
        assert_eq!(take(&mut lines), None);
        assert_eq!((lines.flattens, lines.releases), (0, 0));
        assert!(lines.buf.as_ptr() == p0 && lines.buf.capacity() == a, "the arena was reallocated (read-ahead)");
    }

    #[test]
    fn request_arena_boundaries() {
        // (framed 2C - 1, 2C and 2C + 1, and A - 1, A and A + 1 of the measured arena A, each after a short request
        // (so it starts mid-buffer) and before three more, in fragmented reads, Windows' policy: up to A no staging,
        // release or regrowth; past A one staged line, its buffer let go once consumed and the same arena back)
        let a = Lines::request(NoWait(Chunks { data: Vec::new(), at: 0, sizes: vec![1], k: 0, eintr: false })).arena_cap;
        let mut ns = vec![2 * READ_CHUNK - 1, 2 * READ_CHUNK, 2 * READ_CHUNK + 1, a - 1, a, a + 1];
        ns.sort();
        ns.dedup();
        for n in ns {
            let mut data = line(10, b'0');
            data.extend_from_slice(&framed(n, b'q'));
            for i in 0..3u8 { data.extend_from_slice(&line(5, b'a' + i)); }
            let mut lines = Lines::request(NoWait(Chunks { data, at: 0, sizes: vec![READ_CHUNK, 1, 777, READ_CHUNK - 1], k: 0, eintr: false }));
            let p0 = lines.buf.as_ptr();
            assert_eq!(lines.arena_cap, a);
            assert_eq!(take(&mut lines).unwrap(), vec![b'0'; 10]);
            assert_eq!(take(&mut lines).unwrap(), vec![b'q'; n - 1], "framed {n}");
            for i in 0..3u8 { assert_eq!(take(&mut lines).unwrap(), vec![b'a' + i; 5], "framed {n}"); }
            assert_eq!(take(&mut lines), None);
            let staged = (n > a) as u64;
            assert_eq!((lines.flattens, lines.releases), (staged, staged), "framed {n}");
            assert!(lines.buf.as_ptr() == p0 && lines.buf.capacity() == a && lines.spare.capacity() == 0, "framed {n}: not the same arena");
        }
    }

    #[test]
    fn request_arena_back_after_an_idle_release() {
        // (POSIX's policy: a long line, then a short request after the idle limit: the arena kept as the spare while
        // the long line is held, one release, and the short one read into the original arena; within the burst the
        // long-line buffer is kept.  `next` alone: the serve loop releases it at its decode first, F3, so there this
        // path finds nothing; see early_release_leaves_the_idle_release_nothing)
        let n = 300_000;
        let mut lines = Lines::request(Timed::new(vec![(0, line(n, b'a')), (1000, line(10, b'c'))], vec![]));
        let (p0, a) = (lines.buf.as_ptr(), lines.arena_cap);
        assert_eq!(take(&mut lines).unwrap(), vec![b'a'; n]);
        assert!(lines.large && lines.spare.as_ptr() == p0 && lines.spare.capacity() == a, "the arena not kept while the long line is held");
        assert_eq!(take(&mut lines).unwrap(), vec![b'c'; 10]);
        assert_eq!((lines.flattens, lines.releases), (1, 1));
        assert!(!lines.large && lines.buf.as_ptr() == p0 && lines.buf.capacity() == a && lines.spare.capacity() == 0);
        let mut lines = Lines::request(Timed::new(vec![(0, line(n, b'a')), (100, line(10, b'c'))], vec![]));
        take(&mut lines).unwrap();
        assert_eq!(take(&mut lines).unwrap(), vec![b'c'; 10]);
        assert_eq!(lines.releases, 0);
        assert!(lines.large);
    }

    #[test]
    fn request_arena_actual_capacity() {
        // (an allocator that hands the arena 100 bytes more: A is the measured capacity, a framed 2C + 50 line still
        // fits it, and the release follows the semantic state, not "A is over a read quantum": nothing is let go)
        let mut data = framed(2 * READ_CHUNK + 50, b'r');
        data.extend_from_slice(&line(3, b's'));
        let mut lines = Lines::request_with(NoWait(Chunks { data, at: 0, sizes: vec![READ_CHUNK - 3], k: 0, eintr: false }), 100);
        let (p0, a) = (lines.buf.as_ptr(), lines.arena_cap);
        assert!(a >= 2 * READ_CHUNK + 100);
        assert_eq!(take(&mut lines).unwrap(), vec![b'r'; 2 * READ_CHUNK + 49]);
        assert_eq!(take(&mut lines).unwrap(), vec![b's'; 3]);
        assert_eq!(take(&mut lines), None);
        assert_eq!((lines.flattens, lines.releases), (0, 0));
        assert!(lines.buf.as_ptr() == p0 && lines.buf.capacity() == a);
        assert_eq!(lines.peak, a);
    }

    #[test]
    fn request_arena_staging_peak() {
        // (a 1 MiB line through the request reader, Windows' policy: the peak, in actual capacities, within the staging
        // bound plus the arena kept alongside; once all is consumed, the arena alone)
        let n = 1 << 20;
        let mut data = line(n, b'z');
        data.extend_from_slice(&line(4, b'y'));
        let mut lines = Lines::request(NoWait(Chunks { data, at: 0, sizes: vec![READ_CHUNK, 4093], k: 0, eintr: false }));
        let a = lines.arena_cap;
        assert_eq!(take(&mut lines).unwrap(), vec![b'z'; n]);
        let staged = n + 1 + READ_CHUNK;  // (the line, its newline, at most one read after it)
        assert!(lines.peak <= staging_bound(staged, READ_CHUNK, READ_CHUNK, 0, 0) + a, "a peak of {} bytes", lines.peak);
        assert_eq!(take(&mut lines).unwrap(), vec![b'y'; 4]);
        assert_eq!(take(&mut lines), None);
        assert_eq!((lines.flattens, lines.releases), (1, 1));
        assert_eq!(lines.capacity(), a);
    }

    #[test]
    fn request_arena_staging_start_accounting() {
        // (astra's witness: the arena over-allocated by 100 bytes, A = 131 172, 8-byte pieces, a framed A + 1 line.
        // Its staging start copies the full arena into pieces; when the piece list grows from 16 384 to 32 768
        // entries, the arena is still live: 16 384 x 8 piece bytes + A + (16 384 + 32 768) x 24 list bytes = 1 441 892.
        // r2 recorded 1 310 720 there, without the arena)
        let a = 2 * READ_CHUNK + 100;
        let mut data = framed(a + 1, b'w');
        data.extend_from_slice(&line(2, b'v'));
        let mut lines = Lines::request_with(NoWait(Chunks { data, at: 0, sizes: vec![READ_CHUNK], k: 0, eintr: false }), 100);
        assert_eq!(lines.arena_cap, a, "the precondition: the allocator's exact capacity for the injected arena");
        lines.piece = 8;
        assert_eq!(take(&mut lines).unwrap(), vec![b'w'; a]);
        let at_growth = 16_384 * 8 + a + (16_384 + 32_768) * std::mem::size_of::<Vec<u8>>();
        assert_eq!(at_growth, 1_441_892);
        assert!(lines.peak >= at_growth, "the arena not counted at the list growth: a peak of {}", lines.peak);
        assert_eq!(take(&mut lines).unwrap(), vec![b'v'; 2]);
        assert_eq!(take(&mut lines), None);
        assert_eq!((lines.flattens, lines.releases), (1, 1));
        assert_eq!((lines.held, lines.capacity()), (0, a));
    }

    #[test]
    fn control_reader_has_no_arena() {
        // (the control policy, Lines::new: no arena, nothing held before input; a short line takes a short buffer)
        let mut lines = Lines::new(NoWait(Chunks { data: line(5, b'1'), at: 0, sizes: vec![READ_CHUNK], k: 0, eintr: false }));
        assert_eq!((lines.floor, lines.arena_cap, lines.capacity()), (0, 0, 0));
        assert_eq!(take(&mut lines).unwrap(), vec![b'1'; 5]);
        assert!(lines.capacity() < READ_CHUNK && lines.spare.capacity() == 0);
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
        let staged = (32 << 20) + 1 + READ_CHUNK;  // (the line, its newline, at most one read after it)
        assert!(lines.peak <= staging_bound(staged, READ_CHUNK, READ_CHUNK, 0, 0), "a peak of {} bytes", lines.peak);
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
        assert_eq!(lines.f.waits, vec![(0, 250), (250, 0)]);  // (the wait, then the final zero-time probe)
        // (interrupted waits go on to the one deadline, never a new one)
        let mut lines = Lines::new(Timed::new(vec![(0, line(n, b'a')), (1000, line(10, b'c'))], vec![100, 200]));
        take(&mut lines).unwrap();
        assert_eq!(take(&mut lines).unwrap(), vec![b'c'; 10]);
        assert_eq!(lines.releases, 1);
        assert_eq!(lines.f.waits, vec![(0, 250), (100, 150), (200, 50), (250, 0)]);
    }

    #[test]
    fn lines_interrupted_at_the_deadline() {
        // (astra's R5-3: an interrupt exactly at the deadline, with input readable then: the final zero-time probe
        // finds it, and the buffer is kept; with no input then, the deadline stands and the buffer is let go)
        let n = 300_000;
        let mut lines = Lines::new(Timed::new(vec![(0, line(n, b'a')), (250, line(10, b'c'))], vec![250]));
        take(&mut lines).unwrap();
        assert_eq!(take(&mut lines).unwrap(), vec![b'c'; 10]);
        assert_eq!(lines.releases, 0);
        assert_eq!(lines.f.waits, vec![(0, 250), (250, 0)]);
        let mut lines = Lines::new(Timed::new(vec![(0, line(n, b'a')), (1000, line(10, b'c'))], vec![250]));
        take(&mut lines).unwrap();
        assert_eq!(take(&mut lines).unwrap(), vec![b'c'; 10]);
        assert_eq!(lines.releases, 1);
        assert_eq!(lines.f.waits, vec![(0, 250), (250, 0)]);
    }

    /// Windows' policy (option (i) alone): a source that never waits.
    struct NoWait(Chunks);
    impl Read for NoWait {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(b)
        }
    }
    impl Source for NoWait {
        fn readable_within(&mut self, _within: std::time::Duration) -> std::io::Result<bool> {
            Ok(false)
        }
        fn now(&self) -> std::time::Duration {
            std::time::Duration::ZERO
        }
        fn can_wait(&self) -> bool {
            false
        }
    }

    #[test]
    fn lines_one_byte_reads() {
        // (astra's R5-2: a 300 kB line read one byte at a time, then a small one: short reads coalesce into
        // read-quantum pieces, so every input allocation together, the piece list included, stays within twice the
        // line plus a few quanta; and on Windows' policy, all of it is let go once the line is consumed)
        let n = 300_000;
        let mut data = line(n, b'a');
        data.extend_from_slice(&line(10, b'c'));
        let mut lines = Lines::new(NoWait(Chunks { data, at: 0, sizes: vec![1], k: 0, eintr: false }));
        assert_eq!(take(&mut lines).unwrap(), vec![b'a'; n]);
        assert!(lines.peak <= staging_bound(n + 1, READ_CHUNK, READ_CHUNK, 0, 0), "a peak of {} bytes for a {} byte line", lines.peak, n);
        assert!(lines.stage.capacity() == 0 && lines.stage.is_empty(), "the piece list kept: {}", lines.stage.capacity());
        assert_eq!(take(&mut lines).unwrap(), vec![b'c'; 10]);
        assert_eq!(lines.releases, 1);
        assert!(lines.capacity() <= READ_CHUNK, "kept {} bytes of input storage", lines.capacity());
    }

    #[test]
    fn lines_staging_bound_small_pieces() {
        // (astra's R5-2: with 16-byte pieces a 1 MiB line takes 65 537 of them, so the piece list's metadata,
        // 24 bytes a piece and a doubling list, is the largest term after the line itself: the full accounted
        // peak stays within staging_bound, and the flatten's moment (flat, pieces and list together) is counted)
        let n = 1 << 20;
        let mut lines = Lines::new(Chunks { data: line(n, b'q'), at: 0, sizes: vec![1000, 7, 4096], k: 0, eintr: false });
        lines.piece = 16;
        assert_eq!(take(&mut lines).unwrap(), vec![b'q'; n]);
        assert_eq!(lines.flattens, 1);
        let pieces = (n + 1).div_ceil(16);
        assert!(lines.peak <= staging_bound(n + 1, 16, 16, 0, 0), "a peak of {} over {}", lines.peak, staging_bound(n + 1, 16, 16, 0, 0));
        let at_flatten = (n + 1 + READ_CHUNK) + pieces * 16 + pieces * std::mem::size_of::<Vec<u8>>();
        assert!(lines.peak >= at_flatten, "the flatten's moment not counted: {} < {}", lines.peak, at_flatten);
        assert!(lines.stage.capacity() == 0 && lines.stage_caps == 0);
    }

    #[test]
    fn lines_staging_actual_capacities() {
        // (daybreak2's r5c item 1: an allocator that hands out more than requested, injected: pieces 8 bytes
        // over, piece lists 3 entries over, the flat buffer 100 bytes over.  The accounting reads the actual
        // capacities: the peak covers the flatten's moment counted with them, and stays within staging_bound
        // in those actual terms; an accounting of the requested sizes would come out below the moment)
        let n = 1 << 20;
        let mut lines = Lines::new(Chunks { data: line(n, b'r'), at: 0, sizes: vec![1000, 7, 4096], k: 0, eintr: false });
        lines.piece = 16;
        lines.extra = (8, 3, 100);
        assert_eq!(take(&mut lines).unwrap(), vec![b'r'; n]);
        let pieces = (n + 1).div_ceil(16);
        let at_flatten = (n + 1 + READ_CHUNK + 100) + pieces * (16 + 8) + pieces * std::mem::size_of::<Vec<u8>>();
        assert!(lines.peak >= at_flatten, "actual capacities not counted: {} < {}", lines.peak, at_flatten);
        let bound = staging_bound(n + 1, 16, 16 + 8, 3, 100);
        assert!(lines.peak <= bound, "a peak of {} over {}", lines.peak, bound);
        assert!(lines.stage.capacity() == 0 && lines.stage_caps == 0);
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

    /// F2's tests (PR B fix design r2c): a source that returns exactly its scripted parts, one per read (a part longer
    /// than the read is split, the rest kept first), then the end; always readable.
    struct Script(std::collections::VecDeque<Vec<u8>>);
    impl Read for Script {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            match self.0.pop_front() {
                None => Ok(0),
                Some(mut p) => {
                    let n = p.len().min(b.len());
                    b[..n].copy_from_slice(&p[..n]);
                    if n < p.len() {
                        self.0.push_front(p.split_off(n));
                    }
                    Ok(n)
                }
            }
        }
    }
    impl Source for Script {
        fn readable_within(&mut self, _within: std::time::Duration) -> std::io::Result<bool> {
            Ok(true)
        }
        fn now(&self) -> std::time::Duration {
            std::time::Duration::ZERO
        }
    }
    /// The parts: `data` cut at every READ_CHUNK boundary and at each given offset (so a read ends exactly there).
    fn script(data: &[u8], cuts: &[usize]) -> Script {
        let mut at: Vec<usize> = (1..=data.len() / READ_CHUNK).map(|k| k * READ_CHUNK).chain(cuts.iter().copied()).filter(|&c| c > 0 && c < data.len()).collect();
        at.sort();
        at.dedup();
        let mut parts = std::collections::VecDeque::new();
        let mut prev = 0;
        for c in at.into_iter().chain([data.len()]) {
            parts.push_back(data[prev..c].to_vec());
            prev = c;
        }
        Script(parts)
    }
    /// A long line framed 5 READ_CHUNK + 1 bytes, so its newline (at offset 5 READ_CHUNK, a part boundary) is the first
    /// byte of the read that ends `n` bytes after it (n < READ_CHUNK), then `rest`; and the line's length.
    fn long_then(rest: &[u8], n: usize) -> (Script, usize) {
        let first = framed(5 * READ_CHUNK + 1, b'L');
        let mut data = first.clone();
        data.extend_from_slice(rest);
        (script(&data, &[first.len() + n]), first.len() - 1)
    }

    #[test]
    fn early_release_frees_a_consumed_long_line() {
        // (no byte after the newline: Released, the arena back, the cursors reset; the next request and the end as
        // before, and the arena is all that is left)
        let (src, len) = long_then(&framed(100, b'z'), 0);
        let mut lines = Lines::request(src);
        let a = lines.arena_cap;
        assert_eq!(take(&mut lines).unwrap(), vec![b'L'; len]);
        assert!(lines.large && lines.taken == lines.buf.len() && lines.buf.capacity() > a);
        assert_eq!(lines.release_consumed_long_line(), Early::Released);
        assert!(!lines.large && lines.buf.is_empty() && lines.buf.capacity() == a && lines.spare.capacity() == 0);
        assert_eq!((lines.head, lines.taken, lines.scanned), (0, 0, 0));
        assert_eq!((lines.early_releases, lines.early_suffixes, lines.releases), (1, 0, 0));
        assert_eq!(take(&mut lines).unwrap(), vec![b'z'; 99]);
        assert_eq!(lines.release_consumed_long_line(), Early::NotApplicable);
        assert_eq!(take(&mut lines), None);
        assert_eq!(lines.capacity(), a);
    }

    #[test]
    fn early_release_frees_the_smallest_long_line() {
        // (F3's boundary: a line of framed length A, the arena's capacity, never leaves the arena (NotApplicable); the
        // next, framed A + 1, the shortest that stages, is Released like any other, the arena back)
        let a = Lines::request(script(b"", &[])).arena_cap;
        let fits = framed(a, b'f');
        let over = framed(a + 1, b'o');
        let mut data = fits.clone();
        data.extend_from_slice(&over);
        data.extend_from_slice(&line(3, b'r'));
        let mut lines = Lines::request(script(&data, &[fits.len(), fits.len() + over.len()]));
        assert_eq!(lines.arena_cap, a);
        assert_eq!(take(&mut lines).unwrap(), vec![b'f'; a - 1]);
        assert!(!lines.large && lines.flattens == 0, "framed A: in the arena");
        assert_eq!(lines.release_consumed_long_line(), Early::NotApplicable);
        assert_eq!(take(&mut lines).unwrap(), vec![b'o'; a]);
        assert!(lines.large && lines.flattens == 1 && lines.buf.capacity() > a, "framed A + 1: staged, laid out");
        assert_eq!(lines.release_consumed_long_line(), Early::Released);
        assert!(!lines.large && lines.buf.capacity() == a && lines.capacity() == a, "the arena back, and only it");
        assert_eq!(take(&mut lines).unwrap(), vec![b'r'; 3]);
        assert_eq!(take(&mut lines), None);
        assert_eq!((lines.early_releases, lines.early_suffixes, lines.flattens, lines.releases), (1, 0, 1, 0));
    }

    #[test]
    fn early_release_carries_the_suffix() {
        // (0, 1 and READ_CHUNK - 1 read-ahead bytes after the newline, the start of a framed 2 READ_CHUNK line: they
        // are the arena's only bytes after the release, scanned once by the next call, and every line after them comes
        // out exactly; the arena is never reallocated)
        for n in [0, 1, READ_CHUNK - 1] {
            let mut rest = framed(2 * READ_CHUNK, b'n');
            rest.extend_from_slice(&line(5, b'e'));
            let (src, len) = long_then(&rest, n);
            let mut lines = Lines::request(src);
            let a = lines.arena_cap;
            assert_eq!(take(&mut lines).unwrap(), vec![b'L'; len], "suffix {n}");
            assert_eq!(lines.buf.len() - lines.taken, n, "suffix {n}: the precondition");
            assert_eq!(lines.release_consumed_long_line(), Early::Released, "suffix {n}");
            assert!(!lines.large && lines.buf.capacity() == a && lines.spare.capacity() == 0, "suffix {n}: the arena back");
            assert_eq!(lines.buf, vec![b'n'; n], "suffix {n}: exactly the read-ahead bytes");
            assert_eq!((lines.head, lines.taken, lines.scanned), (0, 0, 0), "suffix {n}");
            assert_eq!((lines.early_releases, lines.early_suffixes), (1, (n > 0) as u64), "suffix {n}");
            let p0 = lines.buf.as_ptr();
            assert_eq!(take(&mut lines).unwrap(), vec![b'n'; 2 * READ_CHUNK - 1], "suffix {n}");
            assert_eq!(take(&mut lines).unwrap(), vec![b'e'; 5], "suffix {n}");
            assert_eq!(take(&mut lines), None, "suffix {n}");
            assert!(lines.buf.as_ptr() == p0 && lines.buf.capacity() == a && lines.flattens == 1, "suffix {n}: the same arena");
        }
    }

    #[test]
    fn early_release_carries_several_lines_in_the_suffix() {
        // (two whole short lines and the start of a third in the read-ahead: all three exact, in order)
        let mut rest = framed(10, b'a');
        rest.extend_from_slice(&framed(20, b'b'));
        rest.extend_from_slice(&framed(300, b'c'));
        let (src, len) = long_then(&rest, 10 + 20 + 5);
        let mut lines = Lines::request(src);
        assert_eq!(take(&mut lines).unwrap(), vec![b'L'; len]);
        assert_eq!(lines.release_consumed_long_line(), Early::Released);
        assert_eq!(lines.buf.len(), 35);
        assert_eq!(take(&mut lines).unwrap(), vec![b'a'; 9]);
        assert_eq!(take(&mut lines).unwrap(), vec![b'b'; 19]);
        assert_eq!(take(&mut lines).unwrap(), vec![b'c'; 299]);
        assert_eq!(take(&mut lines), None);
        assert_eq!((lines.early_releases, lines.early_suffixes), (1, 1));
    }

    #[test]
    fn early_release_not_applicable_on_the_arena_and_the_control_policy() {
        // (no threshold since F3, so a release that ignored `large` would swap the empty spare in for the arena: the
        // arena and its unread bytes are untouched; and never the control policy)
        let mut lines = Lines::request(script(b"{\"id\": 1}\n{\"id\": 2}\n", &[]));
        let a = lines.arena_cap;
        assert_eq!(take(&mut lines).unwrap(), b"{\"id\": 1}");
        assert_eq!(lines.release_consumed_long_line(), Early::NotApplicable);
        assert_eq!(take(&mut lines).unwrap(), b"{\"id\": 2}", "nothing was touched");
        assert_eq!((lines.capacity(), lines.buf.capacity(), lines.early_releases), (a, a, 0));
        let mut control = Lines::new(script(&framed(200_000, b'c'), &[]));
        assert_eq!(take(&mut control).unwrap().len(), 200_000 - 1);
        assert_eq!(control.release_consumed_long_line(), Early::NotApplicable, "never the control policy (floor 0)");
    }

    #[test]
    fn early_release_then_another_long_line_stages_again() {
        let one = framed(200_000, b'1');
        let two = framed(400_000, b'2');
        let mut data = one.clone();
        data.extend_from_slice(&two);
        data.extend_from_slice(b"{\"id\": 3}\n");
        let mut lines = Lines::request(script(&data, &[one.len(), one.len() + two.len()]));
        let a = lines.arena_cap;
        assert_eq!(take(&mut lines).unwrap(), vec![b'1'; 200_000 - 1]);
        assert_eq!(lines.release_consumed_long_line(), Early::Released);
        assert_eq!(take(&mut lines).unwrap(), vec![b'2'; 400_000 - 1], "the next long line, staged from the arena again");
        assert_eq!(lines.flattens, 2);
        assert_eq!(lines.release_consumed_long_line(), Early::Released);
        assert_eq!(take(&mut lines).unwrap(), b"{\"id\": 3}");
        assert_eq!(take(&mut lines), None);
        assert_eq!((lines.capacity(), lines.early_releases), (a, 2));
    }

    #[test]
    fn early_release_every_production_shape() {
        // (F3: req_1mib's 1 MiB line twice, then the 2 MiB burst row's line twice, back to back: each is staged afresh
        // from the arena (one flatten each, the line before's buffer never reused) and released before its request
        // would run, the reader then exactly at its arena; then a short request, read in the arena)
        let sizes = [1 << 20, 1 << 20, 2 << 20, 2 << 20];
        let mut data = Vec::new();
        let mut cuts = Vec::new();
        for (k, &n) in sizes.iter().enumerate() {
            data.extend_from_slice(&framed(n, b'0' + k as u8));
            cuts.push(data.len());
        }
        data.extend_from_slice(&line(2, b'e'));
        let mut lines = Lines::request(script(&data, &cuts));
        let a = lines.arena_cap;
        for (k, &n) in sizes.iter().enumerate() {
            assert_eq!(take(&mut lines).unwrap(), vec![b'0' + k as u8; n - 1], "line {k}");
            assert!(lines.large && lines.buf.capacity() > a, "line {k}: staged, laid out");
            assert_eq!(lines.flattens, k as u64 + 1, "line {k}: staged afresh");
            assert_eq!(lines.release_consumed_long_line(), Early::Released, "line {k}");
            assert!(!lines.large && lines.buf.capacity() == a && lines.capacity() == a, "line {k}: the arena alone");
            assert_eq!(lines.early_releases, k as u64 + 1, "line {k}");
        }
        assert_eq!(take(&mut lines).unwrap(), vec![b'e'; 2]);
        assert_eq!(lines.release_consumed_long_line(), Early::NotApplicable);
        assert_eq!(take(&mut lines), None);
        assert_eq!((lines.capacity(), lines.releases, lines.early_suffixes), (a, 0, 0));
    }

    #[test]
    fn lines_burst_restages() {
        // (F3, the request reader's side of lines_burst_reuse (the control policy's, unchanged): the next long line
        // arrives 100 ms after the last, within the idle limit, but the last one's buffer was released at its decode,
        // so the next stages afresh from the same arena; no idle wait is taken and no idle release counted.  1 MiB
        // lines, then 2 MiB ones)
        for n in [1 << 20, 2 << 20] {
            let mut lines = Lines::request(Timed::new(vec![(0, line(n, b'a')), (100, line(n, b'b')), (200, line(10, b'c'))], vec![]));
            let (p0, a) = (lines.buf.as_ptr(), lines.arena_cap);
            assert_eq!(take(&mut lines).unwrap(), vec![b'a'; n], "{n}");
            assert_eq!(lines.release_consumed_long_line(), Early::Released, "{n}");
            assert!(!lines.large && lines.capacity() == a && lines.buf.as_ptr() == p0, "{n}: the arena back");
            assert_eq!(take(&mut lines).unwrap(), vec![b'b'; n], "{n}");
            assert_eq!(lines.flattens, 2, "{n}: staged afresh, no reuse");
            assert_eq!(lines.release_consumed_long_line(), Early::Released, "{n}");
            assert!(!lines.large && lines.capacity() == a && lines.buf.as_ptr() == p0, "{n}: the arena back again");
            assert_eq!(take(&mut lines).unwrap(), vec![b'c'; 10], "{n}");
            assert_eq!(lines.release_consumed_long_line(), Early::NotApplicable, "{n}");
            assert_eq!((lines.capacity(), lines.early_releases, lines.releases), (a, 2, 0), "{n}");
            assert!(lines.f.waits.is_empty(), "{n}: an idle wait was taken: {:?}", lines.f.waits);
        }
    }

    #[test]
    fn early_release_leaves_the_idle_release_nothing() {
        // (F3's idle path: after a released long line, the next request a second later, past the idle limit: the
        // request reader has nothing left to let go (no wait, no release), while the control policy, unchanged, still
        // keeps its buffer and lets it go at the idle limit, as in lines_idle_release)
        let n = 300_000;
        let mut lines = Lines::request(Timed::new(vec![(0, line(n, b'a')), (1000, line(10, b'c'))], vec![]));
        let a = lines.arena_cap;
        assert_eq!(take(&mut lines).unwrap(), vec![b'a'; n]);
        assert_eq!(lines.release_consumed_long_line(), Early::Released);
        assert_eq!(take(&mut lines).unwrap(), vec![b'c'; 10]);
        assert_eq!((lines.releases, lines.early_releases, lines.capacity()), (0, 1, a));
        assert!(lines.f.waits.is_empty(), "an idle wait was taken: {:?}", lines.f.waits);
        let mut control = Lines::new(Timed::new(vec![(0, line(n, b'a')), (1000, line(10, b'c'))], vec![]));
        assert_eq!(take(&mut control).unwrap(), vec![b'a'; n]);
        assert_eq!(control.release_consumed_long_line(), Early::NotApplicable);
        assert_eq!(take(&mut control).unwrap(), vec![b'c'; 10]);
        assert_eq!((control.releases, control.early_releases), (1, 0));
        assert_eq!(control.f.waits, vec![(0, 250), (250, 0)]);
    }
}
