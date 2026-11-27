// The tools the app connects (design/app-connect-tools.md §2, "Choose installed"): a Claude Code the person chose,
// checked before the app ever runs it and again before each use. Nothing here searches PATH, downloads anything, or
// picks a file on its own: the path comes from the person's file picker.
//
// choose(path, ...): the path must be absolute. Its final link (if any) is resolved once and the target bound: from
// then on only that target is used. The target must be a regular file, executable, owned by the person or by root,
// not writable by group or others; its own folder likewise, and every folder above it owned by the person or root and
// not writable by group or others, except a root-owned sticky folder ABOVE its own folder (so a file directly in
// /tmp still fails). Then `<target> --version` runs (version()), and its answer must be exactly "<v> (Claude Code)\n"
// with v in the supported set. The identity recorded is the target's device, inode, size, mtime and mode.
//
// recheck(chosen): before every later use, the bound target is looked at again (never resolved again): not a link,
// the same identity, and the same rules for it and its folders; any difference is identity_changed (or the rule it
// now breaks), and the person has to choose again.
//
// version(): no shell; an explicit environment (PATH fixed, HOME the person's, DISABLE_AUTOUPDATER=1, nothing
// inherited); the app's own working folder; stdin closed; stdout and stderr each capped at VERSION_OUTPUT bytes; its
// own process group, killed at VERSION_DEADLINE and reaped. Both streams are read on the calling thread from
// non-blocking pipes, so no reader outlives the call, even if something the tool left behind holds a pipe open; if
// a pipe can't be made non-blocking, nothing is read and the run is refused. Its PATH holds only the FIXED_PATH
// folders that qualify (for every step of the folder's path, the resolved folder and all above it root's and not
// writable by group or others); any other is left out, so a helper the tool looks up can't have been put there by
// anyone else. With none left, PATH is NO_PATH (never empty: an empty PATH means the working folder), so a lookup
// fails.
//
// The refusal codes are the agent's (--claude-path) closed list, in its order: wrong_owner is the file or a folder
// above it owned by someone other than the person or root; parent_writable a folder above it writable by others. Windows: unsupported_platform, until the agent host starts agents there.

use std::path::{Path, PathBuf};
use std::time::Duration;

pub const VERSION_DEADLINE: Duration = Duration::from_secs(5);
pub const VERSION_OUTPUT: usize = 4096;
/// The version run's PATH folders, in order; only those that qualify are used (qualify_path).
pub const FIXED_PATH: &[&str] = &["/usr/bin", "/bin"];
/// The PATH when no folder qualifies: a device, not a folder, so every lookup in it fails.
pub const NO_PATH: &str = "/dev/null";

/// Why a chosen tool was refused (each a code the page shows in plain words).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolRefusal {
    NotAbsolute,
    Missing,
    NotRegular,
    NotExecutable,
    WrongOwner,
    WritableByOthers,
    ParentWritable,
    VersionUnknown,
    VersionMismatch,
    NoAnswer,
    IdentityChanged,
    UnsupportedPlatform,
}

impl ToolRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            ToolRefusal::NotAbsolute => "not_absolute",
            ToolRefusal::Missing => "missing",
            ToolRefusal::NotRegular => "not_regular",
            ToolRefusal::NotExecutable => "not_executable",
            ToolRefusal::WrongOwner => "wrong_owner",
            ToolRefusal::WritableByOthers => "writable_by_others",
            ToolRefusal::ParentWritable => "parent_writable",
            ToolRefusal::VersionUnknown => "version_unknown",
            ToolRefusal::VersionMismatch => "version_mismatch",
            ToolRefusal::NoAnswer => "no_answer",
            ToolRefusal::IdentityChanged => "identity_changed",
            ToolRefusal::UnsupportedPlatform => "unsupported_platform",
        }
    }
}

/// A file's identity, as recorded when it was chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Identity {
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
    pub mtime_ns: i128,
    pub mode: u32,
}

/// A tool the person chose: the bound target (never resolved again), its identity, and the version it answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chosen {
    pub path: PathBuf,
    pub identity: Identity,
    pub version: String,
}

/// How version() runs the tool: the person's home, the app's own working folder for it, the versions supported.
pub struct VersionRun<'a> {
    pub home: &'a Path,
    pub cwd: &'a Path,
    pub supported: &'a [&'a str],
}

/// A child's output pipe: readable, with its descriptor (for O_NONBLOCK and poll).
#[cfg(unix)]
trait ReadFd: std::io::Read {
    fn raw(&self) -> std::os::fd::RawFd;
}
#[cfg(unix)]
impl<T: std::io::Read + std::os::fd::AsRawFd> ReadFd for T {
    fn raw(&self) -> std::os::fd::RawFd {
        self.as_raw_fd()
    }
}

/// The person's effective user id (the owner a chosen tool and its folders may have, besides root).
#[cfg(unix)]
pub fn my_uid() -> u32 {
    unsafe { libc::geteuid() }
}

/// Choose `path` for Claude Code: resolve and bind, check the file and its folders, run its version, record it.
/// `me`: the person's uid (my_uid(); tests give another to stand for "someone else").
#[cfg(unix)]
pub fn choose(path: &Path, me: u32, run: &VersionRun) -> Result<Chosen, ToolRefusal> {
    choose_in(path, me, run, FIXED_PATH, &[0])
}

/// choose(), with the PATH folders and their allowed owners given (tests stand other folders and owners in).
#[cfg(unix)]
fn choose_in(path: &Path, me: u32, run: &VersionRun, dirs: &[&str], owners: &[u32]) -> Result<Chosen, ToolRefusal> {
    if !path.is_absolute() {
        return Err(ToolRefusal::NotAbsolute);
    }
    std::fs::symlink_metadata(path).map_err(|_| ToolRefusal::Missing)?;
    // (the final link, and any in the folders above, resolved once: the target is what is bound and shown)
    let target = std::fs::canonicalize(path).map_err(|_| ToolRefusal::Missing)?;
    let identity = check_file(&target, me)?;
    let version = version_in(&target, run, dirs, owners)?;
    // (the file must not have changed while its version ran)
    if check_file(&target, me)? != identity {
        return Err(ToolRefusal::IdentityChanged);
    }
    Ok(Chosen { path: target, identity, version })
}

/// Before each use: the bound target, looked at again (not resolved again), must be the one chosen.
#[cfg(unix)]
pub fn recheck(chosen: &Chosen, me: u32) -> Result<(), ToolRefusal> {
    match std::fs::symlink_metadata(&chosen.path) {
        Err(_) => return Err(ToolRefusal::IdentityChanged),
        Ok(m) if m.file_type().is_symlink() => return Err(ToolRefusal::IdentityChanged),
        Ok(_) => {}
    }
    let now = check_file(&chosen.path, me).map_err(|e| if e == ToolRefusal::Missing { ToolRefusal::IdentityChanged } else { e })?;
    if now != chosen.identity {
        return Err(ToolRefusal::IdentityChanged);
    }
    Ok(())
}

/// The target's own rules and its folders'; its identity.
#[cfg(unix)]
pub(crate) fn check_file(target: &Path, me: u32) -> Result<Identity, ToolRefusal> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(target).map_err(|_| ToolRefusal::Missing)?;
    if m.file_type().is_symlink() || !m.file_type().is_file() {
        return Err(ToolRefusal::NotRegular);
    }
    let mode = m.mode();
    if m.uid() != me && m.uid() != 0 {
        return Err(ToolRefusal::WrongOwner);
    }
    if mode & 0o022 != 0 {
        return Err(ToolRefusal::WritableByOthers);
    }
    // (executable by its owner, who is the person or root; for root's files, by everyone)
    let exec = if m.uid() == me { mode & 0o100 != 0 } else { mode & 0o001 != 0 };
    if !exec {
        return Err(ToolRefusal::NotExecutable);
    }
    check_folders(target.parent(), me)?;
    Ok(Identity { dev: m.dev(), ino: m.ino(), size: m.size(), mtime_ns: m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128, mode })
}

/// A file's own folder (`dir`) and every folder above it: each a real folder owned by the person or root, and not
/// writable by group or others, except a root-owned sticky folder above the file's own folder.
#[cfg(unix)]
pub(crate) fn check_folders(dir: Option<&Path>, me: u32) -> Result<(), ToolRefusal> {
    use std::os::unix::fs::MetadataExt;
    let mut first = true;
    let mut dir = dir;
    while let Some(d) = dir {
        let dm = std::fs::symlink_metadata(d).map_err(|_| ToolRefusal::Missing)?;
        if !dm.is_dir() || dm.file_type().is_symlink() {
            return Err(ToolRefusal::ParentWritable);
        }
        if dm.uid() != me && dm.uid() != 0 {
            return Err(ToolRefusal::WrongOwner);
        }
        let dmode = dm.mode();
        if dmode & 0o022 != 0 {
            // (a root-owned sticky folder is allowed above the file's own folder, never as it)
            let sticky_root = dm.uid() == 0 && dmode & 0o1000 != 0;
            if first || !sticky_root {
                return Err(ToolRefusal::ParentWritable);
            }
        }
        first = false;
        dir = d.parent();
    }
    Ok(())
}

/// `<target> --version`, bounded and isolated; its answer, which must be exactly "<v> (Claude Code)\n" with v
/// supported.
#[cfg(unix)]
pub fn version(target: &Path, run: &VersionRun) -> Result<String, ToolRefusal> {
    version_in(target, run, FIXED_PATH, &[0])
}

/// The PATH for the version run: the folders of `dirs` that qualify, in order, joined; NO_PATH if none does. A folder
/// qualifies when, for every step of its path (the folder itself and each folder above it, as written), the step
/// resolves and the resolved folder and every folder above it is a real folder owned by one of `owners` (root alone,
/// outside tests) and not writable by group or others: so no link on the way, and no folder a link or the PATH folder
/// sits in, can be changed by anyone else.
#[cfg(unix)]
fn qualify_path(dirs: &[&str], owners: &[u32]) -> String {
    let kept: Vec<&str> = dirs.iter().copied().filter(|d| qualifies(Path::new(d), owners)).collect();
    if kept.is_empty() {
        NO_PATH.to_string()
    } else {
        kept.join(":")
    }
}

#[cfg(unix)]
fn qualifies(dir: &Path, owners: &[u32]) -> bool {
    use std::os::unix::fs::MetadataExt;
    dir.is_absolute()
        && dir.ancestors().all(|step| {
            let Ok(resolved) = std::fs::canonicalize(step) else { return false };
            resolved.ancestors().all(|f| {
                std::fs::symlink_metadata(f).is_ok_and(|m| !m.file_type().is_symlink() && m.is_dir() && owners.contains(&m.uid()) && m.mode() & 0o022 == 0)
            })
        })
}

// (tests only: the setup of the non-blocking pipes fails, to reach the fail-closed path nothing else can)
#[cfg(test)]
thread_local! {
    static FAIL_NONBLOCK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
#[cfg(test)]
fn nonblock_fault() -> bool {
    FAIL_NONBLOCK.with(|f| f.get())
}
#[cfg(not(test))]
fn nonblock_fault() -> bool {
    false
}

/// version(), with the PATH folders and their allowed owners given.
#[cfg(unix)]
fn version_in(target: &Path, run: &VersionRun, dirs: &[&str], owners: &[u32]) -> Result<String, ToolRefusal> {
    let out = run_bounded(target, &["--version"], run, dirs, owners)?;
    let v = parse_claude_version(&out).ok_or(ToolRefusal::VersionUnknown)?;
    if !run.supported.contains(&v.as_str()) {
        return Err(ToolRefusal::VersionMismatch);
    }
    Ok(v)
}

/// `<target> <args>`, bounded and isolated as version() describes; its stdout, once it exited 0 with both streams
/// ended and within their caps (stderr only counted against its cap).
#[cfg(unix)]
pub(crate) fn run_bounded(target: &Path, args: &[&str], run: &VersionRun, dirs: &[&str], owners: &[u32]) -> Result<Vec<u8>, ToolRefusal> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    // (a folder the tool would look its helpers up in, open to someone else, is left out of its PATH)
    let path_env = qualify_path(dirs, owners);
    let mut cmd = Command::new(target);
    cmd.args(args)
        .env_clear()
        .env("PATH", path_env)
        .env("HOME", run.home)
        .env("DISABLE_AUTOUPDATER", "1")
        .current_dir(run.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = cmd.spawn().map_err(|_| ToolRefusal::NoAnswer)?;
    let pid = child.id() as libc::pid_t;
    // (both streams read here, on this thread, from non-blocking pipes under poll(): no reader thread exists, so
    //  nothing is left behind when a descendant that escaped the group keeps a pipe open; at most VERSION_OUTPUT + 1
    //  bytes each, and a stream past its cap is closed at once)
    let mut streams: [Option<Box<dyn ReadFd>>; 2] = [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn ReadFd>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn ReadFd>),
    ];
    // (a pipe that can't be made non-blocking could block a read past the deadline: then nothing is read, and the
    //  run goes straight to the cleanup below and is refused)
    let mut nonblocking = streams.iter().all(|s| s.is_some()) && !nonblock_fault();
    for s in streams.iter().flatten() {
        let fd = s.raw();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            nonblocking = false;
        }
    }
    let mut bufs: [Vec<u8>; 2] = [Vec::new(), Vec::new()];
    let mut eof = [false, false];
    let mut over = false;
    // (the leader's exit is observed without reaping it (WNOWAIT): until the reap, its pid and group id can't be
    //  reused, so the group kill below can only reach this tool's own group)
    let started = std::time::Instant::now();
    let grace = Duration::from_secs(1);
    let mut gone = false;
    let mut exited_at: Option<std::time::Instant> = None;
    while nonblocking {
        // (read what is there, waiting at most 10 ms)
        let mut fds: Vec<libc::pollfd> = Vec::new();
        let mut which: Vec<usize> = Vec::new();
        for (i, s) in streams.iter().enumerate() {
            if let (Some(s), false) = (s, eof[i]) {
                fds.push(libc::pollfd { fd: s.raw(), events: libc::POLLIN, revents: 0 });
                which.push(i);
            }
        }
        if !fds.is_empty() {
            unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, 10) };
        } else {
            std::thread::sleep(Duration::from_millis(10));
        }
        for (k, &i) in which.iter().enumerate() {
            if fds[k].revents == 0 {
                continue;
            }
            let mut chunk = [0u8; 4096];
            loop {
                let Some(s) = streams[i].as_mut() else { break };
                match s.read(&mut chunk) {
                    Ok(0) => {
                        eof[i] = true;
                        break;
                    }
                    Ok(n) => {
                        bufs[i].extend_from_slice(&chunk[..n]);
                        if bufs[i].len() > VERSION_OUTPUT {
                            // (past the cap: refused whatever follows; the stream closed now, so the writer stops)
                            over = true;
                            eof[i] = true;
                            streams[i] = None;
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        eof[i] = true;
                        break;
                    }
                }
            }
        }
        if exited_at.is_none() && !gone {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let r = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
            if r != 0 {
                if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                    // (no such child: reaped some other way, so its group id may already be someone else's)
                    gone = true;
                }
            } else if info.si_signo == libc::SIGCHLD {
                // (WNOHANG with nothing to report leaves the zeroed siginfo as it was; an exit reports SIGCHLD)
                exited_at = Some(std::time::Instant::now());
            }
        }
        let done = eof[0] && eof[1];
        if over || gone || (exited_at.is_some() && done) {
            break;
        }
        // (the tool exited but a stream stays open past the grace: something it left behind holds it)
        if exited_at.is_some_and(|t| t.elapsed() >= grace) || started.elapsed() >= VERSION_DEADLINE {
            break;
        }
    }
    // (the whole group, whatever happened: a child the tool left behind dies with it; then the leader is reaped;
    //  then both read ends are closed, here, so nothing of this run outlives the call)
    if !gone {
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
    let status = if gone { None } else { child.wait().ok() };
    drop(streams);
    if over {
        return Err(ToolRefusal::VersionUnknown);
    }
    if exited_at.is_none() || !(eof[0] && eof[1]) {
        return Err(ToolRefusal::NoAnswer);
    }
    let [out, _err] = bufs; // (stderr only counted against its cap)
    let status = status.ok_or(ToolRefusal::NoAnswer)?;
    // (an answer past either cap was refused above, while reading)
    if !status.success() {
        return Err(ToolRefusal::VersionUnknown);
    }
    Ok(out)
}

/// "<MAJOR.MINOR.PATCH> (Claude Code)\n" exactly: canonical decimal parts, no other byte.
pub fn parse_claude_version(out: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(out).ok()?;
    let v = s.strip_suffix(" (Claude Code)\n")?;
    let parts: Vec<&str> = v.split('.').collect();
    let canonical = |p: &&str| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()) && (p.len() == 1 || !p.starts_with('0'));
    (parts.len() == 3 && parts.iter().all(canonical)).then(|| v.to_string())
}

#[cfg(not(unix))]
pub fn choose(_path: &Path, _me: u32, _run: &VersionRun) -> Result<Chosen, ToolRefusal> {
    Err(ToolRefusal::UnsupportedPlatform)
}

#[cfg(not(unix))]
pub fn recheck(_chosen: &Chosen, _me: u32) -> Result<(), ToolRefusal> {
    Err(ToolRefusal::UnsupportedPlatform)
}

#[cfg(test)]
#[cfg(unix)]
#[path = "tools_tests.rs"]
mod tests;
