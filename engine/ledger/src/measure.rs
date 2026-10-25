//! Every applicable row's usage measure (no-cliffs plan C r12 section 1,
//! r13 section 3; r17 section 1.3: every row that constrains the engine's
//! domain, not only those at the least figure), read under the ledger's
//! lock without allocating: the files are opened beforehand
//! (`Measure::open`, `prepare`) and read with pread into stack buffers.
//!
//! | row                 | measure                                         |
//! |---------------------|-------------------------------------------------|
//! | cgroup              | the cgroup's memory.current / usage_in_bytes     |
//! | RLIMIT_AS / _DATA   | VmSize / VmData (/proc/self/status)              |
//! | physical (Linux)    | the process's RssAnon + VmSwap, and MemAvailable |
//! |                     | for the machine-availability check               |
//!
//! Anything else (macOS, Windows, a file that can't be opened or read) is
//! unavailable: fail-closed (`crate::certified` is false).  macOS's
//! phys_footprint and Windows's job/private-commit queries are follow-ups.

// (WebAssembly measures committed pages in lib.rs: the readers here are
// native only)
#![cfg_attr(target_arch = "wasm32", allow(dead_code))]

#[cfg(not(target_arch = "wasm32"))]
use std::fs::File;

/// A row's kind, as the host names it (the native total source).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MeasureKind {
    /// the cgroup's usage file (memory.current, or memory.usage_in_bytes)
    Cgroup(String),
    AddressSpace,
    DataSegment,
    Physical,
    WindowsJob,
    WindowsPhysical,
    /// a row the host could not classify or measure (fail-closed)
    Unknown,
}

/// One applicable row (no-cliffs plan C r17 section 1.3): its kind and its
/// figure (the row's total).  Every applicable row is checked, each against
/// its own usage measure, not only the rows at the least figure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub kind: MeasureKind,
    pub figure: u64,
}

/// One row's fresh reading: its usage, and the machine's available bytes
/// for the physical row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reading {
    pub figure: u64,
    pub usage: u64,
    pub available: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Src {
    /// index into `cgroups`
    Cgroup(usize),
    AddressSpace,
    DataSegment,
    Physical,
}

/// The rows in force, with their measures (files opened beforehand).
pub struct Measure {
    #[cfg(not(target_arch = "wasm32"))]
    cgroups: Vec<File>,
    rows: Vec<(Src, u64)>,
    /// each check's readings, reused: allocated with one slot per row when
    /// the rows are set (outside the ledger's lock), filled under it without
    /// growing (no fixed row table, no cutoff on the number of rows:
    /// daybreak2's LIMIT-C2A-1)
    scratch: Vec<(u64, u64, Option<u64>)>,
    /// a row this build cannot measure (fail-closed)
    unmeasured: bool,
    /// no row at all (the nominal total)
    none: bool,
}

impl Measure {
    pub const NONE: Measure = Measure {
        #[cfg(not(target_arch = "wasm32"))]
        cgroups: Vec::new(),
        rows: Vec::new(),
        scratch: Vec::new(),
        unmeasured: false,
        none: true,
    };

    /// The measures for these rows, their files opened now (outside the
    /// ledger's lock).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn open(rows: &[Row]) -> Measure {
        let mut m = Measure { cgroups: Vec::new(), rows: Vec::with_capacity(rows.len()), scratch: Vec::with_capacity(rows.len()), unmeasured: false, none: rows.is_empty() };
        let mut proc = false;
        for r in rows {
            let src = match &r.kind {
                MeasureKind::Cgroup(path) if cfg!(target_os = "linux") => match File::open(path) {
                    Ok(f) => {
                        m.cgroups.push(f);
                        Src::Cgroup(m.cgroups.len() - 1)
                    }
                    Err(_) => {
                        m.unmeasured = true;
                        continue;
                    }
                },
                MeasureKind::AddressSpace if cfg!(target_os = "linux") => Src::AddressSpace,
                MeasureKind::DataSegment if cfg!(target_os = "linux") => Src::DataSegment,
                MeasureKind::Physical if cfg!(target_os = "linux") => Src::Physical,
                _ => {
                    m.unmeasured = true;
                    continue;
                }
            };
            proc |= !matches!(src, Src::Cgroup(_));
            m.rows.push((src, r.figure));
        }
        if proc && !proc_files_ready() {
            m.unmeasured = true;
        }
        m
    }

    /// Whether every row has a measure that OPENED (structure only: a
    /// fresh read can still fail, so certification also needs
    /// `read_each` to succeed: astra2's CORR-C2A-1).
    pub fn available(&self) -> bool {
        !self.none && !self.unmeasured
    }

    /// Each row's fresh reading, in order, passed to `f`; false when
    /// unavailable or unreadable (then nothing was measured).  No
    /// allocation, and one stack buffer as before (no-cliffs C r17's perf
    /// gate): /proc/self/status is read once and its fields kept, then the
    /// buffer is reused for /proc/meminfo and each cgroup file.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_each(&mut self, mut f: impl FnMut(Reading)) -> bool {
        if !self.available() {
            return false;
        }
        let mut buf = [0u8; 8192];
        let (mut vm_size, mut vm_data, mut anon, mut mem_available) = (None, None, None, None);
        if self.rows.iter().any(|(s, _)| !matches!(s, Src::Cgroup(_))) {
            let Some((sf, mf)) = proc_files() else { return false };
            let Some(status) = pread(sf, &mut buf) else { return false };
            vm_size = kb_field(status, b"VmSize:");
            vm_data = kb_field(status, b"VmData:");
            anon = kb_field(status, b"RssAnon:").and_then(|a| a.checked_add(kb_field(status, b"VmSwap:").unwrap_or(0)));
            if self.rows.iter().any(|(s, _)| *s == Src::Physical) {
                let Some(meminfo) = pread(mf, &mut buf) else { return false };
                mem_available = kb_field(meminfo, b"MemAvailable:");
            }
        }
        // (read everything first: a row unreadable midway measures nothing;
        // the scratch has one slot per row, so it never grows here)
        self.scratch.clear();
        for &(src, figure) in self.rows.iter() {
            let r = match src {
                Src::Cgroup(j) => pread(&self.cgroups[j], &mut buf).and_then(parse_uint).map(|u| (u, None)),
                Src::AddressSpace => vm_size.map(|u| (u, None)),
                Src::DataSegment => vm_data.map(|u| (u, None)),
                Src::Physical => anon.zip(mem_available).map(|(u, a)| (u, Some(a))),
            };
            let Some((usage, available)) = r else { return false };
            self.scratch.push((figure, usage, available));
        }
        for &(figure, usage, available) in &self.scratch {
            f(Reading { figure, usage, available });
        }
        true
    }
}

#[cfg(not(target_arch = "wasm32"))]
static PROC: std::sync::OnceLock<Option<(File, File)>> = std::sync::OnceLock::new();

/// Open /proc/self/status and /proc/meminfo once (before taking the lock:
/// opening allocates).
#[cfg(not(target_arch = "wasm32"))]
pub fn prepare() {
    let _ = proc_files_ready();
}

#[cfg(not(target_arch = "wasm32"))]
fn proc_files_ready() -> bool {
    proc_files().is_some()
}

#[cfg(not(target_arch = "wasm32"))]
fn proc_files() -> Option<&'static (File, File)> {
    PROC.get_or_init(|| {
        if !cfg!(target_os = "linux") {
            return None;
        }
        Some((File::open("/proc/self/status").ok()?, File::open("/proc/meminfo").ok()?))
    })
    .as_ref()
}

/// The whole file from offset 0 into buf (a /proc or cgroup file is
/// generated afresh by a read at offset 0), without allocating.
#[cfg(all(not(target_arch = "wasm32"), unix))]
fn pread<'a>(f: &File, buf: &'a mut [u8]) -> Option<&'a [u8]> {
    use std::os::unix::fs::FileExt;
    let mut n = 0;
    loop {
        let k = f.read_at(&mut buf[n..], n as u64).ok()?;
        if k == 0 {
            break;
        }
        n += k;
        if n == buf.len() {
            return None; // (larger than any of these files: refuse rather than truncate)
        }
    }
    Some(&buf[..n])
}

#[cfg(all(not(target_arch = "wasm32"), not(unix)))]
fn pread<'a>(_f: &File, _buf: &'a mut [u8]) -> Option<&'a [u8]> {
    None
}

/// A decimal integer at the start of the text (a cgroup usage file).
pub(crate) fn parse_uint(text: &[u8]) -> Option<u64> {
    let mut v: u64 = 0;
    let mut any = false;
    for &b in text {
        if b.is_ascii_digit() {
            v = v.checked_mul(10)?.checked_add((b - b'0') as u64)?;
            any = true;
        } else if any || !b.is_ascii_whitespace() {
            break;
        }
    }
    any.then_some(v)
}

/// The bytes of a "Name:   1234 kB" line.
pub(crate) fn kb_field(text: &[u8], name: &[u8]) -> Option<u64> {
    let mut i = 0;
    while i + name.len() <= text.len() {
        if (i == 0 || text[i - 1] == b'\n') && &text[i..i + name.len()] == name {
            return parse_uint(&text[i + name.len()..])?.checked_mul(1024);
        }
        i += 1;
    }
    None
}
