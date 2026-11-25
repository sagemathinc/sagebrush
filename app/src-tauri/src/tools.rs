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
// own process group, killed at VERSION_DEADLINE and reaped.
//
// The refusal codes are the agent's (--claude-path) closed list, in its order: wrong_owner is the file or a folder
// above it owned by someone other than the person or root; parent_writable a folder above it writable by others. Windows: unsupported_platform, until the agent host starts agents there.

use std::path::{Path, PathBuf};
use std::time::Duration;

pub const VERSION_DEADLINE: Duration = Duration::from_secs(5);
pub const VERSION_OUTPUT: usize = 4096;

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

/// The person's effective user id (the owner a chosen tool and its folders may have, besides root).
#[cfg(unix)]
pub fn my_uid() -> u32 {
    unsafe { libc::geteuid() }
}

/// Choose `path` for Claude Code: resolve and bind, check the file and its folders, run its version, record it.
/// `me`: the person's uid (my_uid(); tests give another to stand for "someone else").
#[cfg(unix)]
pub fn choose(path: &Path, me: u32, run: &VersionRun) -> Result<Chosen, ToolRefusal> {
    if !path.is_absolute() {
        return Err(ToolRefusal::NotAbsolute);
    }
    std::fs::symlink_metadata(path).map_err(|_| ToolRefusal::Missing)?;
    // (the final link, and any in the folders above, resolved once: the target is what is bound and shown)
    let target = std::fs::canonicalize(path).map_err(|_| ToolRefusal::Missing)?;
    let identity = check_file(&target, me)?;
    let version = version(&target, run)?;
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
fn check_file(target: &Path, me: u32) -> Result<Identity, ToolRefusal> {
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
    let mut first = true;
    let mut dir = target.parent();
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
    Ok(Identity { dev: m.dev(), ino: m.ino(), size: m.size(), mtime_ns: m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128, mode })
}

/// `<target> --version`, bounded and isolated; its answer, which must be exactly "<v> (Claude Code)\n" with v
/// supported.
#[cfg(unix)]
pub fn version(target: &Path, run: &VersionRun) -> Result<String, ToolRefusal> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(target);
    cmd.arg("--version")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", run.home)
        .env("DISABLE_AUTOUPDATER", "1")
        .current_dir(run.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = cmd.spawn().map_err(|_| ToolRefusal::NoAnswer)?;
    let pid = child.id() as libc::pid_t;
    // (each stream read on its own thread, at most VERSION_OUTPUT + 1 bytes: one more means over the cap; the
    //  results come back on channels, so a stream something else keeps open can't hold the app)
    let take = |s: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(s) = s {
                let _ = s.take(VERSION_OUTPUT as u64 + 1).read_to_end(&mut buf);
            }
            let _ = tx.send(buf);
        });
        rx
    };
    let out = take(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err = take(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    // (the leader's exit is observed without reaping it (WNOWAIT): until the reap, its pid and group id can't be
    //  reused, so the group kill below can only reach this tool's own group)
    let started = std::time::Instant::now();
    let mut gone = false;
    let exited = loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let r = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
        if r != 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            // (no such child: reaped some other way, so its group id may already be someone else's: no group kill)
            gone = true;
            break false;
        }
        // (WNOHANG with nothing to report leaves the zeroed siginfo as it was; an exit reports SIGCHLD)
        if info.si_signo == libc::SIGCHLD {
            break true;
        }
        if started.elapsed() >= VERSION_DEADLINE {
            break false;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // (the whole group, whatever happened: a child the tool left behind dies with it; then the leader is reaped)
    if !gone {
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
    let status = if gone { None } else { child.wait().ok() };
    let grace = Duration::from_secs(1);
    let (out, err) = match (out.recv_timeout(grace), err.recv_timeout(grace)) {
        (Ok(o), Ok(e)) => (o, e),
        _ => return Err(ToolRefusal::NoAnswer),
    };
    let status = if exited { status } else { None };
    let status = status.ok_or(ToolRefusal::NoAnswer)?;
    if !status.success() || out.len() > VERSION_OUTPUT || err.len() > VERSION_OUTPUT {
        return Err(ToolRefusal::VersionUnknown);
    }
    let v = parse_claude_version(&out).ok_or(ToolRefusal::VersionUnknown)?;
    if !run.supported.contains(&v.as_str()) {
        return Err(ToolRefusal::VersionMismatch);
    }
    Ok(v)
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
