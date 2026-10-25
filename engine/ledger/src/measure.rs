//! The binding rows' usage measures (no-cliffs plan C r12 section 1, r13
//! section 3), read under the ledger's lock without allocating: the files
//! are opened beforehand (`Measure::open`, `prepare`) and read with pread
//! into a stack buffer.
//!
//! | binding row         | measure                                         |
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

/// A binding row's kind, as the host names it (the native total source).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MeasureKind {
    /// the cgroup's usage file (memory.current, or memory.usage_in_bytes)
    Cgroup(String),
    AddressSpace,
    DataSegment,
    Physical,
    WindowsJob,
    WindowsPhysical,
}

/// One fresh reading: the usage the binding rows measure (their maximum),
/// and the machine's available bytes where the physical row binds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reading {
    pub usage: u64,
    pub available: Option<u64>,
}

/// The measures of the binding rows in force.
pub struct Measure {
    #[cfg(not(target_arch = "wasm32"))]
    cgroups: Vec<File>,
    address_space: bool,
    data_segment: bool,
    physical: bool,
    /// a row this build cannot measure (fail-closed)
    unsupported: bool,
    /// no binding row at all (the nominal total)
    none: bool,
}

impl Measure {
    pub const NONE: Measure = Measure {
        #[cfg(not(target_arch = "wasm32"))]
        cgroups: Vec::new(),
        address_space: false,
        data_segment: false,
        physical: false,
        unsupported: false,
        none: true,
    };

    /// The measures for these rows, their files opened now (outside the
    /// ledger's lock).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn open(kinds: &[MeasureKind]) -> Measure {
        let mut m = Measure { cgroups: Vec::new(), address_space: false, data_segment: false, physical: false, unsupported: false, none: kinds.is_empty() };
        for k in kinds {
            match k {
                MeasureKind::Cgroup(path) if cfg!(target_os = "linux") => match File::open(path) {
                    Ok(f) => m.cgroups.push(f),
                    Err(_) => m.unsupported = true,
                },
                MeasureKind::AddressSpace if cfg!(target_os = "linux") => m.address_space = true,
                MeasureKind::DataSegment if cfg!(target_os = "linux") => m.data_segment = true,
                MeasureKind::Physical if cfg!(target_os = "linux") => m.physical = true,
                _ => m.unsupported = true,
            }
        }
        if (m.address_space || m.data_segment || m.physical) && !proc_files_ready() {
            m.unsupported = true;
        }
        m
    }

    pub fn available(&self) -> bool {
        !self.none && !self.unsupported
    }

    /// A fresh reading, or None when unavailable or unreadable.  No
    /// allocation.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read(&self) -> Option<Reading> {
        if !self.available() {
            return None;
        }
        let mut usage = 0u64;
        let mut available = None;
        let mut buf = [0u8; 8192];
        for f in &self.cgroups {
            let text = pread(f, &mut buf)?;
            usage = usage.max(parse_uint(text)?);
        }
        if self.address_space || self.data_segment || self.physical {
            let (status, meminfo) = proc_files()?;
            let text = pread(status, &mut buf)?;
            if self.address_space {
                usage = usage.max(kb_field(text, b"VmSize:")?);
            }
            if self.data_segment {
                usage = usage.max(kb_field(text, b"VmData:")?);
            }
            if self.physical {
                usage = usage.max(kb_field(text, b"RssAnon:")?.checked_add(kb_field(text, b"VmSwap:").unwrap_or(0))?);
                let text = pread(meminfo, &mut buf)?;
                available = Some(kb_field(text, b"MemAvailable:")?);
            }
        }
        Some(Reading { usage, available })
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
