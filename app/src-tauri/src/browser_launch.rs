// The browser lane's processes (browser-lane3-runtime.md sha256 49dc86d4, "Rust launches Chrome" and SEC §2, §3; O11
// §2): Rust starts Chrome itself, on its debugging pipe; the cdp sidecar runs with no network (a Seatbelt profile) and
// gets the other ends of Chrome's pipe on its own fds 3 and 4. macOS only: everywhere else platform() is a typed
// refusal, decided at compile time, with no switch.
//
// Ending (the SEC ruling on #1761, H3): nothing here ever signals a process by its PID.
//   - A live session ends Chrome and the sidecars through the Child handles the app holds.
//   - After an app crash the OS closes the app's pipe ends; Chrome (on --remote-debugging-pipe) and both sidecars
//     exit on that EOF. The crash rows in the tests show it for each of the three: Chrome, the net sidecar, and the
//     cdp sidecar launched as the app will launch it (under CDP_PROFILE, with Chrome's pipe ends on its fds 3 and 4).
//   - At the next start, the sweep removes a session's 0700 profile directory only once no process with the recorded
//     start identity remains; if one does, it refuses, leaves the directory and says so with a fixed reason. It never
//     signals.
//
// The unsafe code is two small items, each with its own comment for review:
//   - `place_fds`: the child-side closure (pre_exec) that puts two pipe ends on fds 3 and 4, with async-signal-safe
//     calls only (fcntl, dup2);
//   - `start_identity`: proc_pidinfo, to tell a recorded process from a reused PID.
use std::path::{Path, PathBuf};

/// Why a browser session can't start here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartError {
    /// Not macOS: no qualified sandbox for the cdp sidecar yet (Linux and Windows come with their own, each a PR).
    UnsupportedPlatform,
    /// A step failed; the reason is a fixed string.
    Failed(&'static str),
}

/// O11 §2's launch flags, exactly (and nothing else): the profile directory and the proxy's port vary per session.
pub fn chrome_args(profile: &Path, proxy_port: u16) -> Vec<String> {
    vec![
        "--remote-debugging-pipe".into(),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-sync".into(),
        "--disable-extensions".into(),
        "--disable-component-extensions-with-background-pages".into(),
        "--disable-background-networking".into(),
        "--disable-default-apps".into(),
        format!("--proxy-server=http://127.0.0.1:{proxy_port}"),
        "--proxy-bypass-list=<-loopback>".into(),
        "--disable-quic".into(),
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into(),
        "--dns-prefetch-disable".into(),
        "--deny-permission-prompts".into(),
        "--disable-blink-features=AutomationControlled".into(),
        "about:blank".into(),
    ]
}

/// The cdp sidecar's Seatbelt profile: everything a Node process needs, and no network of any kind (its only channel
/// is its stdio and Chrome's pipe, both inherited).
pub const CDP_PROFILE: &str = "(version 1)\n(allow default)\n(deny network*)\n";

/// A fresh profile directory for one session, mode 0700, under `root` (the app's own data directory).
#[cfg(unix)]
pub fn profile_dir(root: &Path, session: &str) -> Result<PathBuf, StartError> {
    use std::os::unix::fs::DirBuilderExt;
    if session.is_empty() || !session.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err(StartError::Failed("a session id that can't name a directory"));
    }
    let dir = root.join(format!("browser-{session}"));
    // (a new directory only: an existing one, or a missing root, is an error)
    std::fs::DirBuilder::new().mode(0o700).create(&dir).map_err(|_| StartError::Failed("the profile directory couldn't be made"))?;
    Ok(dir)
}

/// The record Rust keeps of each Chrome it launches, for the sweep at the next start: the PID with its start identity,
/// and the profile directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launched {
    pub pid: u32,
    pub started: (u64, u64),
    pub profile: PathBuf,
}

/// The two pipe ends one child gets as its fds 3 and 4.
#[cfg(unix)]
pub struct PipePair {
    pub child_fd3: std::os::fd::OwnedFd,
    pub child_fd4: std::os::fd::OwnedFd,
}

/// Chrome's debugging pipe: two pipes.  Chrome reads fd 3 and writes fd 4; the cdp sidecar writes its fd 3 (Chrome's
/// fd 3's other end) and reads its fd 4 (Chrome's fd 4's other end).
#[cfg(unix)]
pub fn debugging_pipes() -> std::io::Result<(PipePair, PipePair)> {
    let (to_chrome_r, to_chrome_w) = std::io::pipe()?;
    let (from_chrome_r, from_chrome_w) = std::io::pipe()?;
    let chrome = PipePair { child_fd3: to_chrome_r.into(), child_fd4: from_chrome_w.into() };
    let sidecar = PipePair { child_fd3: to_chrome_w.into(), child_fd4: from_chrome_r.into() };
    Ok((chrome, sidecar))
}

/// Give a command the pair's ends as its fds 3 and 4 (and nothing else beyond stdio: every other descriptor Rust
/// holds is close-on-exec, as std makes them).  The command takes the pair: its descriptors stay open, owned by the
/// command, until the command is dropped, so drop it once the child is spawned (then only the child holds them).
#[cfg(unix)]
pub fn with_fds(cmd: &mut std::process::Command, pair: PipePair) {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    // SAFETY: the closure runs in the forked child before exec; it calls only fcntl and dup2, which are
    // async-signal-safe, allocates nothing and touches no lock.  It owns the pair, so both descriptors are open
    // whenever the child is forked (fork copies the table; std's fds are close-on-exec, which dup2's targets aren't).
    unsafe {
        cmd.pre_exec(move || place_fds(pair.child_fd3.as_raw_fd(), pair.child_fd4.as_raw_fd()));
    }
}

/// In the child: `a` onto fd 3 and `b` onto fd 4.  A source that is itself 3 or 4 is first copied above 4, close-on-exec
/// (so the copy is gone at exec and the child holds nothing but its fds 3 and 4), and the two dup2s can't clobber each
/// other; dup2 leaves the targets without close-on-exec.
#[cfg(unix)]
fn place_fds(a: i32, b: i32) -> std::io::Result<()> {
    // SAFETY: plain syscalls on descriptors this process owns; each result is checked.
    unsafe {
        let high = |fd: i32| -> std::io::Result<i32> {
            if fd > 4 {
                return Ok(fd);
            }
            let r = libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 5);
            if r < 0 { Err(std::io::Error::last_os_error()) } else { Ok(r) }
        };
        let (a, b) = (high(a)?, high(b)?);
        if libc::dup2(a, 3) < 0 || libc::dup2(b, 4) < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

/// A process's start time (seconds, microseconds) from the kernel, or None if there is no such process.
#[cfg(target_os = "macos")]
pub fn start_identity(pid: u32) -> Option<(u64, u64)> {
    // SAFETY: proc_pidinfo writes at most `size` bytes into the zeroed struct we own; the result is checked.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let n = libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size);
        (n == size).then_some((info.pbi_start_tvsec, info.pbi_start_tvusec))
    }
}

/// The sweep at app start, for one recorded session: remove its profile directory, unless a process with the
/// recorded start identity still exists (then the directory stays, and the reason says why).  Never a signal.
#[cfg(target_os = "macos")]
pub fn sweep_profile(l: &Launched) -> Result<(), &'static str> {
    if start_identity(l.pid) == Some(l.started) {
        return Err("its browser is still running");
    }
    match std::fs::remove_dir_all(&l.profile) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("the profile directory couldn't be removed"),
    }
}

/// Start a browser session's processes.  Not macOS: refused, at compile time.
#[cfg(not(target_os = "macos"))]
pub fn platform() -> Result<(), StartError> {
    Err(StartError::UnsupportedPlatform)
}
#[cfg(target_os = "macos")]
pub fn platform() -> Result<(), StartError> {
    Ok(())
}

#[cfg(test)]
#[path = "browser_launch_tests.rs"]
mod tests;
