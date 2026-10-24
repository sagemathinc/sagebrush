//! Live progress (design-estimates-progress r4 §6): per-call slots that a
//! computation writes at its existing interrupt checks, and that a reader on
//! another thread copies without ever making the computation wait.
//!
//! A slot is 24 u32 words (the layout below; 64-bit values are two words, low
//! word first), written under a seqlock: the writer makes `seq` odd, writes the
//! fields, then makes it even again; a reader accepts a copy only if `seq` was
//! even and unchanged across it, and retries up to 4 times.  So counts never
//! tear.  [`encode`] and [`decode`] are the layout, shared by every host (the
//! JavaScript reader, src/runtime/progress.ts, implements the same one).
//!
//! Where the slots live:
//! - natively (the CPython package): 32 slots of atomics in this crate, with a
//!   32-bit occupancy bitmap.  A call claims a free slot with one
//!   compare-and-swap, publishes at most every 0.5 s, and releases it when the
//!   [`Call`] drops: on success, on error and on an interruption's unwinding
//!   alike.  [`snapshot`] runs on any thread, with no lock;
//! - in WebAssembly: the engine writes plain frames into a static area that
//!   the host locates through the optional export `sb_progress_ptr()` (engine/web)
//!   and copies into its own shared slots inside the existing
//!   `sagebrush.interrupted` import, so the engine has no new import.  The host
//!   assigns the call ids, the parents and the start times.
//!
//! When all 32 slots are taken the call still runs, untracked, and tries to
//! claim a slot again at each later publish; once it has one, flag bit 9 says
//! that its early part wasn't tracked.  Progress never changes a result and
//! never stops a computation.

// (in wasm the native slots are compiled but unused: the host owns them)
#![cfg_attr(all(target_arch = "wasm32", feature = "wasm-host"), allow(dead_code))]

use std::sync::atomic::{fence, AtomicU32, AtomicU64, Ordering::*};

/// Slots per host.
pub const SLOTS: usize = 32;
/// Words per slot.
pub const WORDS: usize = 24;
/// Where a 53-bit count saturates: $2^{53}-1$, so a count is exact in a double.
pub const SAT53: u64 = (1 << 53) - 1;
/// Where `stage_index` and `stage_count` saturate.
pub const SAT16: u64 = 0xFFFE;
const UNKNOWN16: u32 = 0xFFFF;

/// The word index of each field.
pub mod word {
    pub const SEQ: usize = 0;
    pub const FLAGS: usize = 1;
    pub const CALL_ID: usize = 2;
    pub const PARENT_ID: usize = 4;
    pub const GENERATION: usize = 6;
    pub const OP: usize = 7;
    pub const STAGE: usize = 8;
    pub const STAGE_POS: usize = 9;
    pub const DONE: usize = 10;
    pub const TOTAL: usize = 12;
    pub const WORK: usize = 14;
    pub const MEMORY_NOW: usize = 16;
    pub const MEMORY_PEAK: usize = 17;
    pub const UNIT: usize = 18;
    pub const FRACTION: usize = 19;
    pub const STARTED_MS: usize = 20;
    /// Words 22 and 23: reserved, zero.
    pub const RESERVED: usize = 22;
}

/// The flag bits (word 1); bits 12 to 31 are zero.
pub mod flag {
    pub const IN_USE: u32 = 1 << 0;
    pub const TOTAL_UNKNOWN: u32 = 1 << 1;
    pub const STAGE_COUNT_UNKNOWN: u32 = 1 << 2;
    pub const FRACTION: u32 = 1 << 3;
    pub const BEYOND_FORECAST: u32 = 1 << 4;
    pub const DONE_SATURATED: u32 = 1 << 5;
    pub const WORK_SATURATED: u32 = 1 << 6;
    pub const MEMORY_SATURATED: u32 = 1 << 7;
    pub const TOTAL_SATURATED: u32 = 1 << 8;
    pub const EARLY_PART_UNTRACKED: u32 = 1 << 9;
    pub const STAGE_INDEX_SATURATED: u32 = 1 << 10;
    pub const STAGE_COUNT_SATURATED: u32 = 1 << 11;
    pub const ALL: u32 = (1 << 12) - 1;
}

/// The static tables the op, stage and unit indices refer to (one
/// `progress_tables` call at load returns them).  Index 0 is "" (none).
/// Names a host registers at run time (a Python routine's own op, stage or
/// unit) get indices from [`HOST_NAMES`] up, in that host's table.
pub const OPS: &[&str] = &["", "factor", "groebner", "python"];
pub const STAGES: &[&str] = &["", "trial division", "primality", "rho", "ECM", "SIQS", "F4", "FGLM", "python"];
pub const UNITS: &[&str] = &["", "divisions", "tests", "curves", "iterations", "relations", "rows", "pairs", "steps", "items"];
/// The first index of a host-registered name.
pub const HOST_NAMES: u32 = 0x8000_0000;

/// The tables as JSON: {"ops": [...], "stages": [...], "units": [...], "host_names": 2147483648}.
pub fn tables_json() -> String {
    let list = |t: &[&str]| t.iter().map(|s| format!("\"{s}\"")).collect::<Vec<_>>().join(",");
    format!(
        "{{\"ops\":[{}],\"stages\":[{}],\"units\":[{}],\"host_names\":{HOST_NAMES},\"slots\":{SLOTS},\"words\":{WORDS}}}",
        list(OPS),
        list(STAGES),
        list(UNITS)
    )
}

/// One slot, decoded.  Counts are as reported; [`encode`] saturates them,
/// and [`decode`] returns the saturated values with their flags set.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Slot {
    pub in_use: bool,
    pub call_id: u64,
    pub parent_id: u64,
    pub generation: u32,
    pub op: u32,
    pub stage: u32,
    pub stage_index: u64,
    pub stage_index_saturated: bool,
    /// None: unknown.
    pub stage_count: Option<u64>,
    pub stage_count_saturated: bool,
    pub done: u64,
    pub done_saturated: bool,
    /// None: unknown.
    pub total: Option<u64>,
    pub total_saturated: bool,
    pub work: u64,
    pub work_saturated: bool,
    /// KiB; 0 when not measured.
    pub memory_now_kib: u64,
    pub memory_peak_kib: u64,
    pub memory_saturated: bool,
    pub unit: u32,
    /// In [0, 1] (clamped); None: absent.
    pub fraction: Option<f64>,
    pub beyond_forecast: bool,
    pub early_part_untracked: bool,
    pub started_ms: u64,
}

fn put64(w: &mut [u32; WORDS], i: usize, v: u64) {
    w[i] = v as u32;
    w[i + 1] = (v >> 32) as u32;
}

fn get64(w: &[u32; WORDS], i: usize) -> u64 {
    w[i] as u64 | (w[i + 1] as u64) << 32
}

/// A 53-bit count and whether it saturated.
fn sat53(v: u64) -> (u64, bool) {
    if v > SAT53 {
        (SAT53, true)
    } else {
        (v, false)
    }
}

/// The slot's words (with `seq` 0; reserved words zero).
pub fn encode(s: &Slot) -> [u32; WORDS] {
    let mut w = [0u32; WORDS];
    let mut f = 0u32;
    if s.in_use {
        f |= flag::IN_USE;
    }
    put64(&mut w, word::CALL_ID, s.call_id);
    put64(&mut w, word::PARENT_ID, s.parent_id);
    w[word::GENERATION] = s.generation;
    w[word::OP] = s.op;
    w[word::STAGE] = s.stage;
    let index = if s.stage_index > SAT16 || s.stage_index_saturated {
        f |= flag::STAGE_INDEX_SATURATED;
        SAT16
    } else {
        s.stage_index
    };
    let count = match s.stage_count {
        None => {
            f |= flag::STAGE_COUNT_UNKNOWN;
            UNKNOWN16
        }
        Some(c) if c > SAT16 || s.stage_count_saturated => {
            f |= flag::STAGE_COUNT_SATURATED;
            SAT16 as u32
        }
        Some(c) => c as u32,
    };
    w[word::STAGE_POS] = index as u32 | count << 16;
    let (done, ds) = sat53(s.done);
    if ds || s.done_saturated {
        f |= flag::DONE_SATURATED;
    }
    put64(&mut w, word::DONE, done);
    match s.total {
        None => {
            f |= flag::TOTAL_UNKNOWN;
            put64(&mut w, word::TOTAL, u64::MAX);
        }
        Some(t) => {
            let (t, ts) = sat53(t);
            if ts || s.total_saturated {
                f |= flag::TOTAL_SATURATED;
            }
            put64(&mut w, word::TOTAL, t);
        }
    }
    let (work, ws) = sat53(s.work);
    if ws || s.work_saturated {
        f |= flag::WORK_SATURATED;
    }
    put64(&mut w, word::WORK, work);
    let kib = |v: u64, f: &mut u32| {
        if v > u32::MAX as u64 {
            *f |= flag::MEMORY_SATURATED;
            u32::MAX
        } else {
            v as u32
        }
    };
    w[word::MEMORY_NOW] = kib(s.memory_now_kib, &mut f);
    w[word::MEMORY_PEAK] = kib(s.memory_peak_kib, &mut f);
    if s.memory_saturated {
        f |= flag::MEMORY_SATURATED;
    }
    w[word::UNIT] = s.unit;
    if let Some(x) = s.fraction {
        f |= flag::FRACTION;
        let x = if x.is_nan() { 0.0 } else { x.clamp(0.0, 1.0) };
        w[word::FRACTION] = (x * u32::MAX as f64).round() as u32;
    }
    if s.beyond_forecast {
        f |= flag::BEYOND_FORECAST;
    }
    if s.early_part_untracked {
        f |= flag::EARLY_PART_UNTRACKED;
    }
    put64(&mut w, word::STARTED_MS, s.started_ms);
    w[word::FLAGS] = f;
    w
}

/// The slot the words hold.
pub fn decode(w: &[u32; WORDS]) -> Slot {
    let f = w[word::FLAGS];
    let pos = w[word::STAGE_POS];
    Slot {
        in_use: f & flag::IN_USE != 0,
        call_id: get64(w, word::CALL_ID),
        parent_id: get64(w, word::PARENT_ID),
        generation: w[word::GENERATION],
        op: w[word::OP],
        stage: w[word::STAGE],
        stage_index: (pos & 0xFFFF) as u64,
        stage_index_saturated: f & flag::STAGE_INDEX_SATURATED != 0,
        stage_count: if f & flag::STAGE_COUNT_UNKNOWN != 0 { None } else { Some((pos >> 16) as u64) },
        stage_count_saturated: f & flag::STAGE_COUNT_SATURATED != 0,
        done: get64(w, word::DONE),
        done_saturated: f & flag::DONE_SATURATED != 0,
        total: if f & flag::TOTAL_UNKNOWN != 0 { None } else { Some(get64(w, word::TOTAL)) },
        total_saturated: f & flag::TOTAL_SATURATED != 0,
        work: get64(w, word::WORK),
        work_saturated: f & flag::WORK_SATURATED != 0,
        memory_now_kib: w[word::MEMORY_NOW] as u64,
        memory_peak_kib: w[word::MEMORY_PEAK] as u64,
        memory_saturated: f & flag::MEMORY_SATURATED != 0,
        unit: w[word::UNIT],
        fraction: if f & flag::FRACTION != 0 { Some(w[word::FRACTION] as f64 / u32::MAX as f64) } else { None },
        beyond_forecast: f & flag::BEYOND_FORECAST != 0,
        early_part_untracked: f & flag::EARLY_PART_UNTRACKED != 0,
        started_ms: get64(w, word::STARTED_MS),
    }
}

/// What a computation reports, between two publishes.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Report {
    pub stage: u32,
    pub stage_index: u64,
    pub stage_count: Option<u64>,
    pub done: u64,
    pub total: Option<u64>,
    pub unit: u32,
    pub work: u64,
    pub memory_now_bytes: u64,
    pub memory_peak_bytes: u64,
    pub fraction: Option<f64>,
    pub beyond_forecast: bool,
}

fn kib_of(bytes: u64) -> u64 {
    bytes.div_ceil(1024)
}

// ---------------------------------------------------------------- native slots

const Z: AtomicU32 = AtomicU32::new(0);
const ROW: [AtomicU32; WORDS] = [Z; WORDS];
static TABLE: [[AtomicU32; WORDS]; SLOTS] = [ROW; SLOTS];
static BITMAP: AtomicU32 = AtomicU32::new(0);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// Native publishes are at most this often (a call's last state is always
/// published when it ends).
const PUBLISH_EVERY_MS: u64 = 500;

/// A free slot, claimed (one compare-and-swap per attempt), or None.
fn claim() -> Option<usize> {
    let mut cur = BITMAP.load(Relaxed);
    loop {
        if cur == u32::MAX {
            return None;
        }
        let i = (!cur).trailing_zeros();
        match BITMAP.compare_exchange_weak(cur, cur | 1 << i, Acquire, Relaxed) {
            Ok(_) => return Some(i as usize),
            Err(now) => cur = now,
        }
    }
}

/// Writes the slot's words under the seqlock (one writer per slot: its owner).
fn store(i: usize, w: &[u32; WORDS]) {
    let row = &TABLE[i];
    let s = row[word::SEQ].load(Relaxed);
    row[word::SEQ].store(s.wrapping_add(1), Relaxed);
    fence(Release);
    for (k, v) in w.iter().enumerate().skip(1) {
        row[k].store(*v, Relaxed);
    }
    row[word::SEQ].store(s.wrapping_add(2), Release);
}

/// Clears the slot, then frees it in the bitmap (in that order, so a new
/// owner never finds the old one's fields).
fn release(i: usize) {
    store(i, &[0; WORDS]);
    BITMAP.fetch_and(!(1 << i), Release);
}

/// A consistent copy of slot i's words, or None after 4 torn reads.
pub fn read(i: usize) -> Option<[u32; WORDS]> {
    let row = &TABLE[i];
    for _ in 0..4 {
        let s1 = row[word::SEQ].load(Acquire);
        if s1 & 1 == 1 {
            std::hint::spin_loop();
            continue;
        }
        let mut w = [0u32; WORDS];
        for (k, x) in w.iter_mut().enumerate() {
            *x = row[k].load(Relaxed);
        }
        fence(Acquire);
        if row[word::SEQ].load(Relaxed) == s1 {
            w[word::SEQ] = s1;
            return Some(w);
        }
    }
    None
}

/// The slots in use now, decoded (a slot torn 4 times in a row is skipped
/// this time).  Lock-free; never makes a writer wait.
pub fn snapshot() -> Vec<Slot> {
    let bits = BITMAP.load(Acquire);
    (0..SLOTS)
        .filter(|i| bits & 1 << i != 0)
        .filter_map(read)
        .map(|w| decode(&w))
        .filter(|s| s.in_use)
        .collect()
}

/// The calls running untracked now: (call_id, parent_id, op, started_ms).
pub fn untracked() -> Vec<(u64, u64, u32, u64)> {
    UNTRACKED.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

static UNTRACKED: std::sync::Mutex<Vec<(u64, u64, u32, u64)>> = std::sync::Mutex::new(Vec::new());

static HOST: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// The index of a host-registered name (a Python routine's op, stage or
/// unit), registered at first use.
pub fn name_index(name: &str) -> u32 {
    let mut h = HOST.lock().unwrap_or_else(|e| e.into_inner());
    let i = match h.iter().position(|n| n == name) {
        Some(i) => i,
        None => {
            h.push(name.to_string());
            h.len() - 1
        }
    };
    HOST_NAMES + i as u32
}

fn name_of(table: &[&str], i: u32) -> String {
    if i >= HOST_NAMES {
        return HOST.lock().unwrap_or_else(|e| e.into_inner()).get((i - HOST_NAMES) as usize).cloned().unwrap_or_default();
    }
    table.get(i as usize).map(|s| s.to_string()).unwrap_or_else(|| format!("#{i}"))
}

fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn json_num(x: f64) -> String {
    // (as JavaScript's JSON.stringify writes it, so both hosts' records read
    // back alike: 41.5, and 3 for an integral value; never NaN or infinite here)
    format!("{x}")
}

/// The progress/1 record of a slot (the same as src/runtime/progress.ts's).
pub fn record_json(s: &Slot, now_ms: u64) -> String {
    let mut r = format!(
        "{{\"schema\":\"sagebrush.progress/1\",\"call_id\":{},\"parent_id\":{},\"op\":{},\"status\":\"running\",\"stage\":{},\"stage_index\":{}",
        s.call_id, s.parent_id, json_str(&name_of(OPS, s.op)), json_str(&name_of(STAGES, s.stage)), s.stage_index
    );
    if let Some(c) = s.stage_count {
        r += &format!(",\"stage_count\":{c}");
    }
    r += &format!(",\"count\":{{\"done\":{}", s.done);
    if let Some(t) = s.total {
        r += &format!(",\"total\":{t}");
    }
    r += &format!(",\"unit\":{},\"label\":\"counted\"", json_str(&name_of(UNITS, s.unit)));
    if s.done_saturated || s.total_saturated {
        r += ",\"saturated\":true";
    }
    r += "}";
    r += &format!(",\"elapsed_s\":{},\"beyond_forecast\":{}", json_num(now_ms.saturating_sub(s.started_ms) as f64 / 1000.0), s.beyond_forecast);
    if let Some(f) = s.fraction {
        r += &format!(",\"time_fraction\":{{\"value\":{},\"label\":\"estimated fraction\"}}", json_num(f));
    }
    if s.work != 0 {
        r += &format!(",\"work_spent\":{}", s.work);
    }
    if s.memory_now_kib != 0 {
        r += &format!(",\"memory_now_bytes\":{}", s.memory_now_kib * 1024);
    }
    if s.memory_peak_kib != 0 {
        r += &format!(",\"memory_peak_bytes\":{}", s.memory_peak_kib * 1024);
    }
    if s.early_part_untracked {
        r += ",\"early_part_untracked\":true";
    }
    r + "}"
}

/// Every call in progress now, as a JSON array of progress/1 records: the
/// tracked ones from the slots, then the untracked ones (no counts).
pub fn snapshot_json() -> String {
    let now = now_ms();
    let mut v: Vec<String> = snapshot().iter().map(|s| record_json(s, now)).collect();
    for (id, parent, op, started) in untracked() {
        v.push(format!(
            "{{\"schema\":\"sagebrush.progress/1\",\"call_id\":{id},\"parent_id\":{parent},\"op\":{},\"status\":\"untracked\",\"reason\":\"all 32 progress slots are in use\",\"elapsed_s\":{}}}",
            json_str(&name_of(OPS, op)),
            json_num(now.saturating_sub(started) as f64 / 1000.0)
        ));
    }
    format!("[{}]", v.join(","))
}

fn now_ms() -> u64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }
    #[cfg(target_arch = "wasm32")]
    {
        0
    }
}

thread_local! {
    /// The calls running on this thread, innermost last: a new call's parent.
    static STACK: std::cell::RefCell<Vec<u64>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// One call's progress, from [`begin`] until it drops (on success, error or
/// an interruption's unwinding alike).
pub struct Call {
    call_id: u64,
    parent_id: u64,
    op: u32,
    started_ms: u64,
    slot: Option<usize>,
    early: bool,
    last_ms: u64,
    report: Report,
    #[cfg(all(target_arch = "wasm32", feature = "wasm-host"))]
    frame: Option<usize>,
}

/// Starts reporting the progress of a call of op `op` (an index into [`OPS`],
/// or a host-registered name's index).
pub fn begin(op: u32) -> Call {
    let call_id = NEXT_ID.fetch_add(1, Relaxed);
    let parent_id = STACK.with(|s| s.borrow().last().copied().unwrap_or(0));
    STACK.with(|s| s.borrow_mut().push(call_id));
    let mut c = Call {
        call_id,
        parent_id,
        op,
        started_ms: now_ms(),
        slot: None,
        early: false,
        last_ms: 0,
        report: Report::default(),
        #[cfg(all(target_arch = "wasm32", feature = "wasm-host"))]
        frame: None,
    };
    #[cfg(all(target_arch = "wasm32", feature = "wasm-host"))]
    {
        c.frame = wasm::push();
    }
    #[cfg(not(all(target_arch = "wasm32", feature = "wasm-host")))]
    {
        c.slot = claim();
        if c.slot.is_none() {
            UNTRACKED.lock().unwrap_or_else(|e| e.into_inner()).push((call_id, parent_id, op, c.started_ms));
        }
    }
    c.flush();
    c
}

impl Call {
    /// This call's id (nonzero; never reused in this process).
    pub fn id(&self) -> u64 {
        self.call_id
    }

    /// The report to fill in; [`Call::publish`] writes it.
    pub fn report(&mut self) -> &mut Report {
        &mut self.report
    }

    /// Writes the report, at most every 0.5 s natively (cheap to call at
    /// every check); in wasm into the engine's frame, which the host copies.
    pub fn publish(&mut self) {
        #[cfg(all(target_arch = "wasm32", feature = "wasm-host"))]
        {
            self.flush();
        }
        #[cfg(not(all(target_arch = "wasm32", feature = "wasm-host")))]
        {
            let t = now_ms();
            if t.saturating_sub(self.last_ms) >= PUBLISH_EVERY_MS {
                self.last_ms = t;
                self.flush();
            }
        }
    }

    fn slot_words(&self) -> [u32; WORDS] {
        let r = &self.report;
        encode(&Slot {
            in_use: true,
            call_id: self.call_id,
            parent_id: self.parent_id,
            generation: 1,
            op: self.op,
            stage: r.stage,
            stage_index: r.stage_index,
            stage_count: r.stage_count,
            done: r.done,
            total: r.total,
            work: r.work,
            memory_now_kib: kib_of(r.memory_now_bytes),
            memory_peak_kib: kib_of(r.memory_peak_bytes),
            unit: r.unit,
            fraction: r.fraction,
            beyond_forecast: r.beyond_forecast,
            early_part_untracked: self.early,
            started_ms: self.started_ms,
            ..Slot::default()
        })
    }

    /// Writes the report now, whatever the time since the last write.
    pub fn flush(&mut self) {
        #[cfg(all(target_arch = "wasm32", feature = "wasm-host"))]
        {
            if let Some(f) = self.frame {
                wasm::write(f, &self.slot_words());
            }
        }
        #[cfg(not(all(target_arch = "wasm32", feature = "wasm-host")))]
        {
            if self.slot.is_none() {
                // untracked: one more try (a slot may have been released)
                if let Some(i) = claim() {
                    self.slot = Some(i);
                    self.early = true;
                    UNTRACKED.lock().unwrap_or_else(|e| e.into_inner()).retain(|u| u.0 != self.call_id);
                }
            }
            if let Some(i) = self.slot {
                store(i, &self.slot_words());
            }
        }
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        STACK.with(|s| {
            let mut s = s.borrow_mut();
            if let Some(k) = s.iter().rposition(|&c| c == self.call_id) {
                s.remove(k);
            }
        });
        #[cfg(all(target_arch = "wasm32", feature = "wasm-host"))]
        {
            if let Some(f) = self.frame {
                wasm::pop(f);
            }
        }
        #[cfg(not(all(target_arch = "wasm32", feature = "wasm-host")))]
        {
            match self.slot {
                Some(i) => release(i),
                None => UNTRACKED.lock().unwrap_or_else(|e| e.into_inner()).retain(|u| u.0 != self.call_id),
            }
        }
    }
}

// ---------------------------------------------------------------- the wasm frames

/// The engine's frame area in wasm (the host reads it through
/// `sb_progress_ptr()`): word 0 the layout version (1); word 1 an epoch,
/// incremented at every begin and end; word 2 the depth; word 3 zero; then
/// [`FRAMES`] frames of [`WORDS`] words in the slot layout, the innermost at
/// `depth - 1`.  In a frame, `call_id` holds the frame's serial number (the
/// host's own call ids and parents replace it), and `seq` is unused: the host
/// reads the frames only while the engine waits in its import.
pub const FRAMES: usize = 32;
pub const FRAME_HEADER: usize = 4;

#[cfg(all(target_arch = "wasm32", feature = "wasm-host"))]
mod wasm {
    use super::*;

    // (single-threaded: one engine instance per thread in wasm)
    static mut AREA: [u32; FRAME_HEADER + FRAMES * WORDS] = [0; FRAME_HEADER + FRAMES * WORDS];
    static SERIAL: AtomicU32 = AtomicU32::new(0);

    fn area() -> &'static mut [u32; FRAME_HEADER + FRAMES * WORDS] {
        unsafe { &mut *std::ptr::addr_of_mut!(AREA) }
    }

    pub fn ptr() -> *const u32 {
        let a = area();
        a[0] = 1;
        a.as_ptr()
    }

    /// A new innermost frame, or None beyond [`FRAMES`] deep (that call is
    /// not reported; its parent's frame stays).
    pub fn push() -> Option<usize> {
        let a = area();
        a[0] = 1;
        let d = a[2] as usize;
        if d >= FRAMES {
            return None;
        }
        let base = FRAME_HEADER + d * WORDS;
        a[base..base + WORDS].fill(0);
        a[base + word::CALL_ID] = SERIAL.fetch_add(1, Relaxed).wrapping_add(1);
        a[2] = d as u32 + 1;
        a[1] = a[1].wrapping_add(1);
        Some(d)
    }

    pub fn write(f: usize, w: &[u32; WORDS]) {
        let a = area();
        let base = FRAME_HEADER + f * WORDS;
        let serial = a[base + word::CALL_ID];
        a[base..base + WORDS].copy_from_slice(w);
        // the host keeps its own ids: the frame keeps its serial
        a[base + word::CALL_ID] = serial;
        a[base + word::CALL_ID + 1] = 0;
    }

    pub fn pop(f: usize) {
        let a = area();
        a[2] = a[2].min(f as u32);
        let base = FRAME_HEADER + f * WORDS;
        a[base..base + WORDS].fill(0);
        a[1] = a[1].wrapping_add(1);
    }

    /// Forgets every frame (a new call's start, after a trap dropped one).
    pub fn reset() {
        let a = area();
        a[2] = 0;
        a[1] = a[1].wrapping_add(1);
    }
}

/// The frame area's address (wasm, for engine/web's `sb_progress_ptr`).
#[cfg(all(target_arch = "wasm32", feature = "wasm-host"))]
pub fn frames_ptr() -> *const u32 {
    wasm::ptr()
}

/// Forgets every frame (wasm; engine/web calls it at each call's start).
#[cfg(all(target_arch = "wasm32", feature = "wasm-host"))]
pub fn reset_frames() {
    wasm::reset()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(s: &Slot) -> Slot {
        decode(&encode(s))
    }

    #[test]
    fn layout_round_trips_at_every_edge() {
        let base = Slot { in_use: true, call_id: 7, parent_id: 3, generation: 2, op: 1, stage: 4, unit: 3, started_ms: 1_700_000_000_123, ..Slot::default() };
        // exact values at 0 and at each maximum
        for (done, total) in [(0, Some(0)), (SAT53, Some(SAT53)), (5, None)] {
            let s = Slot { done, total, stage_count: Some(SAT16), stage_index: SAT16, ..base };
            let d = rt(&s);
            assert_eq!((d.done, d.total, d.stage_index, d.stage_count), (done, total, SAT16, Some(SAT16)));
            assert!(!d.done_saturated && !d.total_saturated && !d.stage_index_saturated && !d.stage_count_saturated);
        }
        // saturation: never wraps, and a saturated value never looks exact
        let s = Slot { done: SAT53 + 1, total: Some(u64::MAX - 1), work: u64::MAX, stage_index: 70000, stage_count: Some(SAT16 + 1), memory_now_kib: 1 << 40, ..base };
        let d = rt(&s);
        assert_eq!((d.done, d.total, d.work), (SAT53, Some(SAT53), SAT53));
        assert!(d.done_saturated && d.total_saturated && d.work_saturated);
        assert_eq!((d.stage_index, d.stage_count), (SAT16, Some(SAT16)));
        assert!(d.stage_index_saturated && d.stage_count_saturated && d.memory_saturated);
        assert_eq!(d.memory_now_kib, u32::MAX as u64);
        // sentinels: total and stage_count unknown; a fraction absent, at 0 and at 1
        let w = encode(&Slot { total: None, stage_count: None, ..base });
        assert_eq!(get64(&w, word::TOTAL), u64::MAX);
        assert_eq!(w[word::STAGE_POS] >> 16, 0xFFFF);
        assert_eq!(rt(&base).fraction, None);
        assert_eq!(rt(&Slot { fraction: Some(0.0), ..base }).fraction, Some(0.0));
        assert_eq!(rt(&Slot { fraction: Some(1.0), ..base }).fraction, Some(1.0));
        assert_eq!(rt(&Slot { fraction: Some(7.0), ..base }).fraction, Some(1.0));
        assert_eq!(rt(&Slot { fraction: Some(-1.0), ..base }).fraction, Some(0.0));
        // reserved words stay zero, and bits 12-31 of the flags
        let all = Slot { total: None, stage_count: None, fraction: Some(0.5), beyond_forecast: true, early_part_untracked: true, done: u64::MAX, work: u64::MAX, memory_peak_kib: u64::MAX, stage_index: u64::MAX, ..base };
        let w = encode(&all);
        assert_eq!((w[22], w[23]), (0, 0));
        assert_eq!(w[word::FLAGS] & !flag::ALL, 0);
        // every flag bit alone (where a field can set it alone) and together
        let alone: [(u32, Slot); 12] = [
            (flag::IN_USE, Slot { in_use: true, stage_count: Some(0), total: Some(0), ..Slot::default() }),
            (flag::TOTAL_UNKNOWN, Slot { stage_count: Some(0), total: None, ..Slot::default() }),
            (flag::STAGE_COUNT_UNKNOWN, Slot { stage_count: None, total: Some(0), ..Slot::default() }),
            (flag::FRACTION, Slot { fraction: Some(0.25), stage_count: Some(0), total: Some(0), ..Slot::default() }),
            (flag::BEYOND_FORECAST, Slot { beyond_forecast: true, stage_count: Some(0), total: Some(0), ..Slot::default() }),
            (flag::DONE_SATURATED, Slot { done: u64::MAX, stage_count: Some(0), total: Some(0), ..Slot::default() }),
            (flag::WORK_SATURATED, Slot { work: SAT53 + 1, stage_count: Some(0), total: Some(0), ..Slot::default() }),
            (flag::MEMORY_SATURATED, Slot { memory_peak_kib: 1 << 33, stage_count: Some(0), total: Some(0), ..Slot::default() }),
            (flag::TOTAL_SATURATED, Slot { total: Some(SAT53 + 1), stage_count: Some(0), ..Slot::default() }),
            (flag::EARLY_PART_UNTRACKED, Slot { early_part_untracked: true, stage_count: Some(0), total: Some(0), ..Slot::default() }),
            (flag::STAGE_INDEX_SATURATED, Slot { stage_index: SAT16 + 1, stage_count: Some(0), total: Some(0), ..Slot::default() }),
            (flag::STAGE_COUNT_SATURATED, Slot { stage_count: Some(SAT16 + 1), total: Some(0), ..Slot::default() }),
        ];
        let mut union = 0;
        for (bit, s) in alone.iter() {
            let w = encode(s);
            assert_eq!(w[word::FLAGS], *bit, "flag {bit:#x} alone");
            assert_eq!(encode(&decode(&w)), w, "flag {bit:#x} round trip");
            union |= bit;
        }
        assert_eq!(union, flag::ALL);
        let w = encode(&all);
        assert_eq!(encode(&decode(&w)), w);
    }

    // (the native slots are one table for the process, and the interrupt
    // flag too: one test, in order, holding the crate's test lock)
    #[test]
    fn native_slots_claim_nest_exhaust_release_and_never_tear() {
        let _serial = crate::tests::SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        assert!(snapshot().is_empty());
        let mut outer = begin(1);
        outer.report().done = 5;
        outer.report().total = Some(10);
        outer.flush();
        let inner = begin(3);
        let s = snapshot();
        assert_eq!(s.len(), 2);
        let o = s.iter().find(|x| x.call_id == outer.id()).unwrap();
        let i = s.iter().find(|x| x.call_id == inner.id()).unwrap();
        assert_eq!((o.parent_id, i.parent_id), (0, outer.id()));
        assert_eq!((o.done, o.total), (5, Some(10)));
        drop(inner);
        assert_eq!(snapshot().len(), 1);
        // 32 live calls, then a 33rd: it runs untracked, under its own id
        let mut live: Vec<Call> = (0..31).map(|_| begin(1)).collect();
        assert_eq!(snapshot().len(), 32);
        let mut extra = begin(2);
        assert_eq!(untracked(), vec![(extra.id(), live.last().unwrap().id(), 2, extra.started_ms)]);
        assert!(snapshot().iter().all(|x| x.call_id != extra.id()));
        // a slot freed: the untracked call claims it at its next write
        let freed = live.remove(3);
        drop(freed);
        extra.report().done = 1;
        extra.flush();
        let got = snapshot().into_iter().find(|x| x.call_id == extra.id()).unwrap();
        assert!(got.early_part_untracked);
        assert!(untracked().is_empty());
        drop(extra);
        drop(live);
        // released on an interruption's unwinding too
        crate::clear();
        let r = crate::catch(|| {
            let _c = begin(1);
            assert_eq!(snapshot().len(), 2);
            crate::request();
            crate::check();
        });
        assert!(r.is_err());
        crate::clear();
        assert_eq!(snapshot().len(), 1);
        // and on a panic (an error)
        let r = std::panic::catch_unwind(|| {
            let _c = begin(1);
            panic!("an error");
        });
        assert!(r.is_err());
        assert_eq!(snapshot().len(), 1);
        drop(outer);
        assert!(snapshot().is_empty());
        assert_eq!(BITMAP.load(Relaxed), 0);

        // a writer at full rate on its own slot; the reader checks that the
        // two halves of every 64-bit count agree (done == total == work)
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let i = loop {
            if let Some(i) = claim() {
                break i;
            }
        };
        let st = stop.clone();
        let w = std::thread::spawn(move || {
            let mut v: u64 = 0xFFFF_FFF0;
            while !st.load(Relaxed) {
                v = v.wrapping_add(0x1_0000_0001) & SAT53;
                store(i, &encode(&Slot { in_use: true, done: v, total: Some(v), work: v, ..Slot::default() }));
            }
        });
        let mut seen = 0;
        let t = std::time::Instant::now();
        while t.elapsed().as_millis() < 300 {
            if let Some(w) = read(i) {
                let d = decode(&w);
                if d.in_use {
                    assert_eq!(Some(d.done), d.total);
                    assert_eq!(d.done, d.work);
                    seen += 1;
                }
            }
        }
        stop.store(true, Relaxed);
        w.join().unwrap();
        release(i);
        assert!(seen > 0);
        assert_eq!(BITMAP.load(Relaxed), 0);
    }

    #[test]
    fn records_are_progress_records() {
        let s = Slot { in_use: true, call_id: 9, parent_id: 2, op: 1, stage: 4, stage_index: 2, stage_count: Some(4), done: 410, total: Some(1800), unit: 3, fraction: Some(0.5), started_ms: 1000, ..Slot::default() };
        assert_eq!(
            record_json(&s, 42_500),
            "{\"schema\":\"sagebrush.progress/1\",\"call_id\":9,\"parent_id\":2,\"op\":\"factor\",\"status\":\"running\",\"stage\":\"ECM\",\"stage_index\":2,\"stage_count\":4,\"count\":{\"done\":410,\"total\":1800,\"unit\":\"curves\",\"label\":\"counted\"},\"elapsed_s\":41.5,\"beyond_forecast\":false,\"time_fraction\":{\"value\":0.5,\"label\":\"estimated fraction\"}}"
        );
        let h = name_index("a \"quoted\" stage");
        assert_eq!(name_index("a \"quoted\" stage"), h);
        let r = record_json(&Slot { stage: h, total: None, stage_count: None, ..s }, 1000);
        assert!(r.contains("\"stage\":\"a \\\"quoted\\\" stage\""), "{r}");
        assert!(r.contains("\"count\":{\"done\":410,\"unit\""), "{r}");
    }

    #[test]
    fn tables_are_json() {
        let t = tables_json();
        assert!(t.starts_with("{\"ops\":[\"\",\"factor\""));
        assert!(t.contains("\"slots\":32,\"words\":24"));
    }
}
