//! sagebrush-raster-launch: starts Sagebrush's PNG engine process (the
//! raster child, PNG plan r8 §2.3) under its memory limit.
//!
//! A static, syscall-only Linux executable: no ELF interpreter, no libc, no
//! relocations, no TLS, no static data, no allocation.  The kernel maps it,
//! and its `_start` makes these system calls and nothing else:
//!
//! 1. prlimit64: RLIMIT_AS's soft limit set to LIMIT, never above the
//!    inherited hard limit (else it reports the hard limit and exits);
//! 2. prctl(PR_SET_PDEATHSIG, SIGKILL), then getppid() against PARENT: a
//!    parent already gone means exit;
//! 3. /proc/self/status's VmPeak against BOUND, the parent's bound on this
//!    image's whole footprint before the limit (r8 §2.3): it has made no
//!    mapping, so VmPeak is that footprint; over the bound, or unreadable,
//!    is a refusal the parent turns into the contained mode;
//! 4. execve(PROGRAM, [PROGRAM, ARGS...], the environment it was given).
//!
//! Usage: sagebrush-raster-launch LIMIT PARENT FD BOUND PROGRAM [ARGS...]
//! (LIMIT and BOUND in bytes, PARENT a pid, FD where a refusal is written).
//!
//! A refusal at step 1, 2, 3 or 4 is written to FD as one frame of the
//! raster child's protocol, ERR_START {stage, errno, observed}, and the
//! exit status is 100 + stage; a parent gone exits 98, bad arguments 99.

#![no_std]
#![no_main]
// (memset, memcpy, memcmp and bcmp below are this binary's own: it links no
// libc or std, whose definitions the lint compares them with)
#![allow(suspicious_runtime_symbol_definitions)]

use core::arch::{asm, global_asm};

/// The frame's magic ("SBRF") and the ERR_START kind (the raster child's
/// protocol).
const MAGIC: u32 = 0x4652_4253;
const ERR_START: u32 = 7;

const STAGE_LIMIT: u32 = 1;
const STAGE_PDEATHSIG: u32 = 2;
const STAGE_FOOTPRINT: u32 = 3;
const STAGE_EXEC: u32 = 4;
const EXIT_PARENT_GONE: usize = 98;
const EXIT_USAGE: usize = 99;

const RLIMIT_AS: usize = 9;
const PR_SET_PDEATHSIG: usize = 1;
const SIGKILL: usize = 9;
const AT_FDCWD: isize = -100;
const O_RDONLY_CLOEXEC: usize = 0o2_000_000;

#[cfg(target_arch = "x86_64")]
mod nr {
    pub const READ: usize = 0;
    pub const WRITE: usize = 1;
    pub const CLOSE: usize = 3;
    pub const EXECVE: usize = 59;
    pub const GETPPID: usize = 110;
    pub const PRCTL: usize = 157;
    pub const EXIT_GROUP: usize = 231;
    pub const OPENAT: usize = 257;
    pub const PRLIMIT64: usize = 302;
}

#[cfg(target_arch = "aarch64")]
mod nr {
    pub const OPENAT: usize = 56;
    pub const CLOSE: usize = 57;
    pub const READ: usize = 63;
    pub const WRITE: usize = 64;
    pub const EXIT_GROUP: usize = 94;
    pub const PRCTL: usize = 167;
    pub const GETPPID: usize = 173;
    pub const EXECVE: usize = 221;
    pub const PRLIMIT64: usize = 261;
}

#[cfg(target_arch = "x86_64")]
unsafe fn syscall(n: usize, a: usize, b: usize, c: usize, d: usize) -> isize {
    let r: isize;
    asm!("syscall", inlateout("rax") n as isize => r, in("rdi") a, in("rsi") b, in("rdx") c, in("r10") d,
         lateout("rcx") _, lateout("r11") _, options(nostack));
    r
}

#[cfg(target_arch = "aarch64")]
unsafe fn syscall(n: usize, a: usize, b: usize, c: usize, d: usize) -> isize {
    let r: isize;
    asm!("svc 0", in("x8") n, inlateout("x0") a as isize => r, in("x1") b, in("x2") c, in("x3") d,
         options(nostack));
    r
}

// The entry: the kernel's initial stack (argc, argv, NULL, envp, NULL,
// auxv) to launch(), with the stack aligned and the frame pointer cleared.
#[cfg(target_arch = "x86_64")]
global_asm!(".globl _start", "_start:", "xor ebp, ebp", "mov rdi, rsp", "and rsp, -16", "call {main}", "ud2", main = sym launch);

#[cfg(target_arch = "aarch64")]
global_asm!(".globl _start", "_start:", "mov x29, xzr", "mov x30, xzr", "mov x0, sp", "bl {main}", "brk #0", main = sym launch);

fn exit(code: usize) -> ! {
    unsafe {
        syscall(nr::EXIT_GROUP, code, 0, 0, 0);
    }
    loop {}
}

/// A decimal argument (at most 20 digits), or None.
unsafe fn decimal(mut p: *const u8) -> Option<u64> {
    if p.is_null() || *p == 0 {
        return None;
    }
    let mut v: u64 = 0;
    let mut n = 0;
    while *p != 0 {
        let d = (*p).wrapping_sub(b'0');
        if d > 9 || n == 20 {
            return None;
        }
        v = v.checked_mul(10)?.checked_add(d as u64)?;
        p = p.add(1);
        n += 1;
    }
    Some(v)
}

/// The refusal: an ERR_START frame on fd, then exit(100 + stage).
fn refuse(fd: usize, stage: u32, errno: u32, observed: u64) -> ! {
    // (16 bytes of header and 16 of payload, little-endian, on the stack)
    let mut f = [0u8; 32];
    put(&mut f, 0, &MAGIC.to_le_bytes());
    put(&mut f, 4, &ERR_START.to_le_bytes());
    put(&mut f, 8, &16u64.to_le_bytes());
    put(&mut f, 16, &stage.to_le_bytes());
    put(&mut f, 20, &errno.to_le_bytes());
    put(&mut f, 24, &observed.to_le_bytes());
    unsafe {
        syscall(nr::WRITE, fd, f.as_ptr() as usize, f.len(), 0);
    }
    exit(100 + stage as usize)
}

fn put(f: &mut [u8; 32], at: usize, b: &[u8]) {
    let mut i = 0;
    while i < b.len() {
        f[at + i] = b[i];
        i += 1;
    }
}

/// /proc/self/status's VmPeak in bytes; Err(errno) if it can't be read
/// (0: read, but no VmPeak line).
unsafe fn vm_peak() -> Result<u64, u32> {
    let path = b"/proc/self/status\0";
    let fd = syscall(nr::OPENAT, AT_FDCWD as usize, path.as_ptr() as usize, O_RDONLY_CLOEXEC, 0);
    if fd < 0 {
        return Err((-fd) as u32);
    }
    // (left uninitialized: the kernel fills what is read, and only that is
    // looked at; zeroing it would call memset through a GOT entry, the one
    // writable word the image would have)
    let mut raw = core::mem::MaybeUninit::<[u8; 8192]>::uninit();
    let cap = 8192usize;
    let base = raw.as_mut_ptr() as *mut u8;
    let mut len = 0usize;
    loop {
        let n = syscall(nr::READ, fd as usize, base.add(len) as usize, cap - len, 0);
        if n < 0 {
            syscall(nr::CLOSE, fd as usize, 0, 0, 0);
            return Err((-n) as u32);
        }
        len += n as usize;
        if n == 0 || len == cap {
            break;
        }
    }
    syscall(nr::CLOSE, fd as usize, 0, 0, 0);
    let buf = core::slice::from_raw_parts(base, len);
    // "VmPeak:\t   1234 kB" at a line's start
    let key = b"VmPeak:";
    let mut i = 0;
    while i + key.len() <= len {
        if (i == 0 || buf[i - 1] == b'\n') && buf[i..i + key.len()] == key[..] {
            let mut j = i + key.len();
            while j < len && (buf[j] == b' ' || buf[j] == b'\t') {
                j += 1;
            }
            let mut kb: u64 = 0;
            let mut digits = 0;
            while j < len && buf[j].is_ascii_digit() && digits < 20 {
                kb = kb.saturating_mul(10).saturating_add((buf[j] - b'0') as u64);
                j += 1;
                digits += 1;
            }
            return if digits > 0 { Ok(kb.saturating_mul(1024)) } else { Err(0) };
        }
        i += 1;
    }
    Err(0)
}

#[no_mangle]
unsafe extern "C" fn launch(sp: *const usize) -> ! {
    let argc = *sp;
    let argv = sp.add(1) as *const *const u8;
    let envp = argv.add(argc + 1);
    if argc < 6 {
        exit(EXIT_USAGE);
    }
    let arg = |i: usize| *argv.add(i);
    let (Some(limit), Some(parent), Some(fd), Some(bound)) = (decimal(arg(1)), decimal(arg(2)), decimal(arg(3)), decimal(arg(4))) else {
        exit(EXIT_USAGE);
    };
    let fd = fd as usize;
    // 1. the address-space limit, under the inherited hard limit
    let mut old = [0u64; 2];
    let r = syscall(nr::PRLIMIT64, 0, RLIMIT_AS, 0, old.as_mut_ptr() as usize);
    if r < 0 {
        refuse(fd, STAGE_LIMIT, (-r) as u32, 0);
    }
    if limit > old[1] {
        refuse(fd, STAGE_LIMIT, 0, old[1]);
    }
    let new = [limit, old[1]];
    let r = syscall(nr::PRLIMIT64, 0, RLIMIT_AS, new.as_ptr() as usize, 0);
    if r < 0 {
        refuse(fd, STAGE_LIMIT, (-r) as u32, 0);
    }
    // 2. killed with the parent; a parent gone already: nothing to start
    let r = syscall(nr::PRCTL, PR_SET_PDEATHSIG, SIGKILL, 0, 0);
    if r < 0 {
        refuse(fd, STAGE_PDEATHSIG, (-r) as u32, 0);
    }
    if syscall(nr::GETPPID, 0, 0, 0, 0) as u64 != parent {
        exit(EXIT_PARENT_GONE);
    }
    // 3. this image's whole footprint before the limit, against the bound
    match vm_peak() {
        Ok(peak) if peak <= bound => {}
        Ok(peak) => refuse(fd, STAGE_FOOTPRINT, 0, peak),
        Err(errno) => refuse(fd, STAGE_FOOTPRINT, errno, 0),
    }
    // 4. the program, argv[5] both its path and its argv[0]
    let r = syscall(nr::EXECVE, arg(5) as usize, argv.add(5) as usize, envp as usize, 0);
    refuse(fd, STAGE_EXEC, (-r) as u32, 0)
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    exit(EXIT_USAGE)
}

// The memory routines the compiler may call for the arrays above (there is
// no libc): byte loops, volatile so they are not turned back into calls.
#[no_mangle]
unsafe extern "C" fn memset(d: *mut u8, c: i32, n: usize) -> *mut u8 {
    let mut i = 0;
    while i < n {
        core::ptr::write_volatile(d.add(i), c as u8);
        i += 1;
    }
    d
}

#[no_mangle]
unsafe extern "C" fn memcpy(d: *mut u8, s: *const u8, n: usize) -> *mut u8 {
    let mut i = 0;
    while i < n {
        core::ptr::write_volatile(d.add(i), core::ptr::read_volatile(s.add(i)));
        i += 1;
    }
    d
}

#[no_mangle]
unsafe extern "C" fn memcmp(a: *const u8, b: *const u8, n: usize) -> i32 {
    let mut i = 0;
    while i < n {
        let (x, y) = (core::ptr::read_volatile(a.add(i)), core::ptr::read_volatile(b.add(i)));
        if x != y {
            return x as i32 - y as i32;
        }
        i += 1;
    }
    0
}

#[no_mangle]
unsafe extern "C" fn bcmp(a: *const u8, b: *const u8, n: usize) -> i32 {
    memcmp(a, b, n)
}
