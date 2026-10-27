//! The PNG engine's process (the raster child, PNG plan r8 §2.3 and §2.4):
//! the loop it runs once the prelude has loaded this extension, answering
//! the parent's requests on its standard input and output (two pipes; its
//! standard error is a file the parent reads after a failure) until the
//! parent closes them.
//!
//! The protocol is frames: a 16-byte header, `magic u32` ("SBRF"),
//! `kind u32`, `len u64` (little-endian), then `len` bytes of payload.
//!
//! The parent's requests:
//! - PING (len 0): PONG.
//! - RENDER: `scale f32, width u32, height u32, dpi f32, svg_len u64,
//!   text_len u64, bg_len u64` (40 bytes), then the SVG, the text chunks (as
//!   the WebAssembly ABI has them: each key and value after its u32 length)
//!   and the background, all UTF-8.
//! - DECODE: the PNG file's bytes.
//! - SHUTDOWN: the process exits (as it does when the request pipe closes).
//!
//! The replies:
//! - READY `pid u32, 0 u32`, once, after the warm-up;
//! - OK_RENDER `png_len u64, missing_len u64`, the PNG, the characters the
//!   font lacked (UTF-8);
//! - OK_DECODE `width u32, height u32, channels u32, 0 u32`, then the
//!   float32 values (little-endian);
//! - ERR_INPUT (the input refused), ERR_BACKEND (the engine failing, a bug),
//!   each a UTF-8 message; ERR_MEMORY `bytes u64` then what they were for: a
//!   fallible allocation refused, in-band.
//!
//! What the loop holds while idle is nothing it allocated: a header is read
//! into the stack, a payload only after the parent has set the call's limit
//! (it sets limits only on an idle child), so the idle loop runs at a limit
//! of its own VmSize.  An allocation that can't fail cleanly and is refused
//! aborts the process with Rust's "memory allocation of N bytes failed": the
//! parent's evidence (r8 §2.4).

use sagebrush_raster::Fail;
use std::io::{Read, Write};

pub const MAGIC: u32 = 0x4652_4253;

pub mod kind {
    pub const PING: u32 = 1;
    pub const RENDER: u32 = 2;
    pub const DECODE: u32 = 3;
    pub const SHUTDOWN: u32 = 4;
    // (written by the launcher and the prelude, never by this loop)
    #[allow(dead_code)]
    pub const ERR_START: u32 = 7;
    pub const READY: u32 = 100;
    pub const PONG: u32 = 101;
    pub const OK_RENDER: u32 = 102;
    pub const OK_DECODE: u32 = 103;
    pub const ERR_INPUT: u32 = 110;
    pub const ERR_BACKEND: u32 = 111;
    pub const ERR_MEMORY: u32 = 112;
}

/// The exit status of a protocol violation by the parent (a bad magic or
/// kind): the parent reads it as the engine failing.
const EXIT_PROTOCOL: i32 = 2;

fn header(kind: u32, len: u64) -> [u8; 16] {
    let mut h = [0u8; 16];
    h[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    h[4..8].copy_from_slice(&kind.to_le_bytes());
    h[8..16].copy_from_slice(&len.to_le_bytes());
    h
}

/// A frame: its header, then its parts in order (written as they are, not
/// joined into one buffer).
fn send(out: &mut impl Write, kind: u32, parts: &[&[u8]]) -> std::io::Result<()> {
    let len: u64 = parts.iter().map(|p| p.len() as u64).sum();
    out.write_all(&header(kind, len))?;
    for p in parts {
        out.write_all(p)?;
    }
    out.flush()
}

fn send_fail(out: &mut impl Write, e: Fail) -> std::io::Result<()> {
    match e {
        Fail::Input(s) => send(out, kind::ERR_INPUT, &[s.as_bytes()]),
        Fail::Backend(s) => send(out, kind::ERR_BACKEND, &[s.as_bytes()]),
        Fail::Memory { bytes, what } => send(out, kind::ERR_MEMORY, &[&bytes.to_le_bytes(), what.as_bytes()]),
    }
}

/// The payload of `len` bytes, allocated fallibly; if it can't be, it is
/// read and dropped in stack-sized pieces (so the stream stays in step) and
/// the call is the memory refusal.
fn payload(input: &mut impl Read, len: u64, what: &'static str) -> std::io::Result<Result<Vec<u8>, Fail>> {
    let n = usize::try_from(len).ok();
    let mut v = Vec::new();
    if let Some(n) = n.filter(|&n| v.try_reserve_exact(n).is_ok()) {
        v.resize(n, 0);
        input.read_exact(&mut v)?;
        return Ok(Ok(v));
    }
    let mut left = len;
    let mut chunk = [0u8; 4096];
    while left > 0 {
        let k = left.min(chunk.len() as u64) as usize;
        input.read_exact(&mut chunk[..k])?;
        left -= k as u64;
    }
    Ok(Err(Fail::Memory { bytes: len, what }))
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

fn render(req: &[u8]) -> Result<(Vec<u8>, String), Fail> {
    if req.len() < 40 {
        return Err(Fail::Backend("a RENDER request shorter than its header".into()));
    }
    let scale = f32::from_bits(u32_at(req, 0));
    let (width, height) = (u32_at(req, 4), u32_at(req, 8));
    let dpi = f32::from_bits(u32_at(req, 12));
    let (svg_len, text_len, bg_len) = (u64_at(req, 16), u64_at(req, 24), u64_at(req, 32));
    let body = &req[40..];
    if svg_len.checked_add(text_len).and_then(|n| n.checked_add(bg_len)) != Some(body.len() as u64) {
        return Err(Fail::Backend("a RENDER request whose parts don't add up to its length".into()));
    }
    let (svg, rest) = body.split_at(svg_len as usize);
    let (text, bg) = rest.split_at(text_len as usize);
    let svg = std::str::from_utf8(svg).map_err(|_| Fail::Input("an SVG that is not UTF-8".into()))?;
    let bg = std::str::from_utf8(bg).map_err(|_| Fail::Input("a background color that is not UTF-8".into()))?;
    let pairs = sagebrush_raster::text_pairs(text)?;
    let size = if width == 0 && height == 0 { None } else { Some((width, height)) };
    sagebrush_raster::render_png(svg, scale, size, bg, dpi, &pairs)
}

/// A call, a Rust panic in it (a bug) turned into ERR_BACKEND.
fn guarded<T>(f: impl FnOnce() -> Result<T, Fail> + std::panic::UnwindSafe) -> Result<T, Fail> {
    std::panic::catch_unwind(f).unwrap_or_else(|p| {
        let msg = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned());
        Err(Fail::Backend(format!("a panic in the PNG engine: {}", msg.unwrap_or_else(|| "(no message)".into()))))
    })
}

/// The kill pipe's watchdog (#157 r6 S2.3, r7 T4): when the parent gave
/// the kill pipe's read end as fd 3, a thread blocked on it ends the process
/// at once on a byte or on EOF (the parent closing it, or exiting): an end
/// identity-bound to this process, needing no signal and no pid.  Its stack
/// is small (64 KiB), inside the launch footprint the parent charges.  fd 4,
/// the life pipe's write end, is simply kept open until the process exits.
#[cfg(unix)]
fn start_watchdog() {
    if unsafe { libc::fcntl(3, libc::F_GETFD) } < 0 {
        return;
    }
    let _ = std::thread::Builder::new().name("sagebrush-raster-watchdog".into()).stack_size(64 * 1024).spawn(|| {
        let mut b = [0u8; 1];
        loop {
            let n = unsafe { libc::read(3, b.as_mut_ptr() as *mut libc::c_void, 1) };
            if n < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            unsafe { libc::_exit(137) };
        }
    });
}

/// The loop on the process's standard input and output.
pub fn main() -> ! {
    #[cfg(unix)]
    {
        use std::os::fd::FromRawFd;
        start_watchdog();
        // (the descriptors themselves: std's stdout is line-buffered, and
        // its stdin buffered, which a binary stream doesn't want)
        let (input, out) = unsafe { (std::fs::File::from_raw_fd(0), std::fs::File::from_raw_fd(1)) };
        main_loop(input, out)
    }
    #[cfg(not(unix))]
    {
        main_loop(std::io::stdin().lock(), std::io::stdout().lock())
    }
}

/// The loop: READY after the warm-up, then requests until the input closes.
/// Never returns: the process exits (0 at the end of its input).
fn main_loop(mut input: impl Read, mut out: impl Write) -> ! {
    let quit = |r: std::io::Result<()>| {
        if r.is_err() {
            std::process::exit(0); // (the parent is gone: nothing to answer)
        }
    };
    if let Err(e) = guarded(sagebrush_raster::warm) {
        quit(send_fail(&mut out, e));
        std::process::exit(0);
    }
    quit(send(&mut out, kind::READY, &[&std::process::id().to_le_bytes(), &0u32.to_le_bytes()]));
    loop {
        let mut h = [0u8; 16];
        if input.read_exact(&mut h).is_err() {
            std::process::exit(0);
        }
        let (magic, k, len) = (u32_at(&h, 0), u32_at(&h, 4), u64_at(&h, 8));
        if magic != MAGIC {
            std::process::exit(EXIT_PROTOCOL);
        }
        match k {
            kind::PING if len == 0 => quit(send(&mut out, kind::PONG, &[])),
            kind::SHUTDOWN => std::process::exit(0),
            kind::RENDER => {
                let r = match payload(&mut input, len, "the PNG request") {
                    Ok(Ok(req)) => guarded(move || render(&req)),
                    Ok(Err(e)) => Err(e),
                    Err(_) => std::process::exit(0),
                };
                quit(match r {
                    Ok((png, missing)) => send(
                        &mut out,
                        kind::OK_RENDER,
                        &[&(png.len() as u64).to_le_bytes(), &(missing.len() as u64).to_le_bytes(), &png, missing.as_bytes()],
                    ),
                    Err(e) => send_fail(&mut out, e),
                });
            }
            kind::DECODE => {
                let r = match payload(&mut input, len, "the PNG file") {
                    Ok(Ok(file)) => guarded(move || sagebrush_raster::decode_png(&file)),
                    Ok(Err(e)) => Err(e),
                    Err(_) => std::process::exit(0),
                };
                quit(match r {
                    Ok((w, h, ch, v)) => {
                        // (the values as they are in memory: little-endian on
                        // every target the package is built for)
                        let bytes = unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 4) };
                        let head = [w.to_le_bytes(), h.to_le_bytes(), ch.to_le_bytes(), 0u32.to_le_bytes()].concat();
                        send(&mut out, kind::OK_DECODE, &[&head, bytes])
                    }
                    Err(e) => send_fail(&mut out, e),
                });
            }
            _ => std::process::exit(EXIT_PROTOCOL),
        }
        // (memory freed here stays with the allocator for the next call, in
        // the process's VmSize, so in its standing charge: conservative.
        // Trimming it after each call, malloc_trim(0), cost some 8% of a
        // typical render in faults refilling it, in VM1's A/B)
    }
}

#[cfg(target_endian = "big")]
compile_error!("the raster child sends float32 values as they are in memory: little-endian targets only");
