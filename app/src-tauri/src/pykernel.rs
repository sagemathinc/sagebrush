// Native (Python): the machine's own CPython as a kernel (remote design r3.3, item 5; the shared interface with the
// remote host: one `sagebrush_kernel` package, the same rules for choosing the interpreter, the same spawn contract).
//
// choose_python(path, ...): the person's pick, checked like a chosen tool (tools.rs) and bound by the path chosen,
// not only its target: a venv's bin/python is a link to the base interpreter, and run by its target (on macOS, even
// with argv[0] set to the link) the interpreter loses the venv. So what is bound is the chosen path with its folders
// resolved (the exec path), each link from it to the target as (link, what it reads), the target's identity, and the
// venv's pyvenv.cfg in either place Python looks (its identity, or its absence). The target and its folders, every
// link and the folder holding it, and pyvenv.cfg are owned by the person or root and not writable by others. The
// version probe is `<exec path> -I -c PROBE` under the tool checker's bounded run (minimal environment, qualified
// PATH, deadline, caps, own group); its answer must be exactly "<major>.<minor>.<micro> <implementation>\n", CPython,
// at least MIN_PYTHON.
//
// recheck_python(chosen): before every start, the chain is read again (never resolved anew): each link must read
// the same, the target and pyvenv.cfg be the ones bound; any difference is identity_changed.
//
// Kernel::start(spec): `<exec path> [-P on 3.11+] -c BOOTSTRAP <resource folder> <workspace folder>`, no shell,
// started in START_DIR (root's, never the workspace: Python's site setup runs before BOOTSTRAP and could otherwise
// import a sitecustomize.py from the workspace). BOOTSTRAP drops '' and the working folder from sys.path, puts the
// resource folder (the one holding sagebrush_kernel; an argument, never part of the code) first, changes to the
// workspace, and runs sagebrush_kernel. Unlike the probe, the kernel gets the person's environment (their packages,
// user site-packages, PYTHONPATH, GPU variables), less the app's own and CoCalc's variables (STRIPPED_PREFIXES:
// control-plane credentials and private host settings), in its own session and process group (setsid), as the person.
// Its stdout is JSON lines, each at most LINE_MAX, queued up to QUEUE_MAX (each charged EVENT_COST besides its
// bytes, so empty lines count) and then not read until taken; its stderr is kept, the last STDERR_KEEP bytes.
// One thread does all of a kernel's I/O, on non-blocking pipes under poll(), and it is joined before stop() returns,
// so nothing of a kernel outlives its stop even if something it left behind holds a pipe. That thread alone signals
// the kernel and reaps it, so no signal can follow the reap. interrupt() asks it for SIGINT to the group; the end (stop(), or the kernel's own exit, its output read for at most EXIT_GRACE) is the tree rule: SIGTERM to the group, SIGKILL after
// TERM_GRACE, then the reap. An exit is reported, never followed by a restart.

use crate::tools::{self, Identity, ToolRefusal, VersionRun};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// The oldest CPython the kernel runs on (the wheel's requires-python).
pub const MIN_PYTHON: (u32, u32) = (3, 10);
/// A kernel's output line, at most (the remote host's ChildPort reads with the same limit).
pub const LINE_MAX: usize = 4 * 1024 * 1024;
/// Lines read but not yet taken, each charged its bytes plus EVENT_COST: past this, no more lines are queued and the
/// kernel's stdout is no longer read until they are taken (it blocks). So at most QUEUE_MAX + LINE_MAX + EVENT_COST.
pub const QUEUE_MAX: usize = 8 * 1024 * 1024;
/// What a queued line costs besides its bytes (its event and its place in the queue), so empty lines count too.
pub const EVENT_COST: usize = 64;
/// One read from the kernel's stdout or stderr, at most.
const CHUNK: usize = 64 * 1024;
/// Input written but not yet taken by the kernel: past this, send() refuses.
pub const INPUT_MAX: usize = 8 * 1024 * 1024;
/// The kernel's stderr, the last bytes kept.
pub const STDERR_KEEP: usize = 64 * 1024;
/// After the kernel's own exit, how long its output is still read (all of it, unless something it left behind holds
/// the pipes open).
pub const EXIT_GRACE: Duration = Duration::from_secs(1);
/// SIGTERM to SIGKILL, at the end.
pub const TERM_GRACE: Duration = Duration::from_secs(2);
/// Links followed from the chosen path to the interpreter, at most.
const MAX_LINKS: usize = 40;
/// Where the interpreter starts, before BOOTSTRAP changes to the workspace: root's, never the workspace.
pub const START_DIR: &str = "/";
/// Variables never passed to the kernel (the app's and CoCalc's control plane, and the host's private settings).
pub const STRIPPED_PREFIXES: &[&str] = &["SAGEBRUSH_", "COCALC_", "TAURI_"];

/// The version probe: one line, "<major>.<minor>.<micro> <implementation>\n".
const PROBE: &str = "import sys,platform;i=sys.version_info;sys.stdout.write('%d.%d.%d %s\\n'%(i[0],i[1],i[2],platform.python_implementation()))";
/// The kernel's bootstrap, fixed (the same on every host): nothing but the builtin sys is touched while '' or the
/// working folder can be on sys.path.
pub const BOOTSTRAP: &str = "import sys\nsys.path[:]=[p for p in sys.path if p not in ('','.')]\nimport os\nc=os.getcwd()\nsys.path[:]=[p for p in sys.path if p!=c]\nsys.path.insert(0,sys.argv.pop(1))\nos.chdir(sys.argv.pop(1))\nimport runpy\nrunpy.run_module('sagebrush_kernel',run_name='__main__',alter_sys=True)\n";

/// An interpreter the person chose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChosenPython {
    /// What the kernel is started by: the chosen path, its folders resolved.
    pub exec_path: PathBuf,
    /// Each link from exec_path to the target: the link, and what it reads.
    pub chain: Vec<(PathBuf, PathBuf)>,
    pub target: PathBuf,
    pub identity: Identity,
    /// pyvenv.cfg beside the interpreter and one folder up: each its identity, or None if absent.
    pub venv_cfg: [Option<Identity>; 2],
    pub version: (u32, u32, u32),
}

/// Choose `path` as the Native (Python) interpreter. `me`: the person's uid.
#[cfg(unix)]
pub fn choose_python(path: &Path, me: u32, run: &VersionRun) -> Result<ChosenPython, ToolRefusal> {
    choose_python_in(path, me, run, tools::FIXED_PATH, &[0])
}

#[cfg(unix)]
fn choose_python_in(path: &Path, me: u32, run: &VersionRun, dirs: &[&str], owners: &[u32]) -> Result<ChosenPython, ToolRefusal> {
    if !path.is_absolute() {
        return Err(ToolRefusal::NotAbsolute);
    }
    let first = path.file_name().ok_or(ToolRefusal::NotRegular)?;
    let parent = std::fs::canonicalize(path.parent().ok_or(ToolRefusal::NotRegular)?).map_err(|_| ToolRefusal::Missing)?;
    let exec_path = parent.join(first);
    let (chain, target) = walk_chain(&exec_path, me)?;
    let identity = tools::check_file(&target, me)?;
    let venv_cfg = venv_cfgs(&exec_path, me)?;
    let out = tools::run_bounded(&exec_path, &["-I", "-c", PROBE], run, dirs, owners)?;
    let version = parse_python_version(&out).ok_or(ToolRefusal::VersionUnknown)?;
    if (version.0, version.1) < MIN_PYTHON {
        return Err(ToolRefusal::VersionMismatch);
    }
    let chosen = ChosenPython { exec_path, chain, target, identity, venv_cfg, version };
    // (nothing of it may have changed while the probe ran)
    recheck_python(&chosen, me)?;
    Ok(chosen)
}

/// Before each start: the bound chain, read again, and the target and pyvenv.cfg, the same.
#[cfg(unix)]
pub fn recheck_python(chosen: &ChosenPython, me: u32) -> Result<(), ToolRefusal> {
    let changed = |e: ToolRefusal| if e == ToolRefusal::Missing { ToolRefusal::IdentityChanged } else { e };
    let mut at = chosen.exec_path.clone();
    for (link, reads) in &chosen.chain {
        if &at != link {
            return Err(ToolRefusal::IdentityChanged);
        }
        match std::fs::read_link(link) {
            Ok(r) if &r == reads => {}
            _ => return Err(ToolRefusal::IdentityChanged),
        }
        check_link(link, me).map_err(changed)?;
        at = next_step(link, reads);
    }
    if at != chosen.target {
        return Err(ToolRefusal::IdentityChanged);
    }
    if std::fs::symlink_metadata(&at).map_or(true, |m| m.file_type().is_symlink()) {
        return Err(ToolRefusal::IdentityChanged);
    }
    if tools::check_file(&at, me).map_err(changed)? != chosen.identity {
        return Err(ToolRefusal::IdentityChanged);
    }
    if venv_cfgs(&chosen.exec_path, me).map_err(changed)? != chosen.venv_cfg {
        return Err(ToolRefusal::IdentityChanged);
    }
    Ok(())
}

/// The links from `start` to a file that isn't one; each link (and the folder holding it) checked.
#[cfg(unix)]
fn walk_chain(start: &Path, me: u32) -> Result<(Vec<(PathBuf, PathBuf)>, PathBuf), ToolRefusal> {
    let mut chain = Vec::new();
    let mut at = start.to_path_buf();
    loop {
        let m = std::fs::symlink_metadata(&at).map_err(|_| ToolRefusal::Missing)?;
        if !m.file_type().is_symlink() {
            return Ok((chain, at));
        }
        if chain.len() >= MAX_LINKS {
            return Err(ToolRefusal::NotRegular);
        }
        check_link(&at, me)?;
        let reads = std::fs::read_link(&at).map_err(|_| ToolRefusal::Missing)?;
        let next = next_step(&at, &reads);
        // (the next step's folders resolved, so each link in the chain is named by a path without links above it)
        let next = match (next.parent(), next.file_name()) {
            (Some(p), Some(n)) => std::fs::canonicalize(p).map_err(|_| ToolRefusal::Missing)?.join(n),
            _ => return Err(ToolRefusal::NotRegular),
        };
        chain.push((at, reads));
        at = next;
    }
}

/// Where a link leads: what it reads, taken from the link's own folder when relative.
fn next_step(link: &Path, reads: &Path) -> PathBuf {
    if reads.is_absolute() {
        reads.to_path_buf()
    } else {
        link.parent().map(|p| p.join(reads)).unwrap_or_else(|| reads.to_path_buf())
    }
}

/// A link in the chain: owned by the person or root, in folders that pass the tool rules.
#[cfg(unix)]
fn check_link(link: &Path, me: u32) -> Result<(), ToolRefusal> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(link).map_err(|_| ToolRefusal::Missing)?;
    if m.uid() != me && m.uid() != 0 {
        return Err(ToolRefusal::WrongOwner);
    }
    tools::check_folders(link.parent(), me)
}

/// pyvenv.cfg beside the interpreter and one folder up (where Python looks for it): each checked like a file of the
/// tool's (owner, not writable by others, its folders), with its identity; None where there is none.
#[cfg(unix)]
fn venv_cfgs(exec_path: &Path, me: u32) -> Result<[Option<Identity>; 2], ToolRefusal> {
    use std::os::unix::fs::MetadataExt;
    let bin = exec_path.parent().ok_or(ToolRefusal::NotRegular)?;
    let mut out = [None, None];
    for (i, dir) in [Some(bin), bin.parent()].into_iter().enumerate() {
        let Some(dir) = dir else { continue };
        let cfg = dir.join("pyvenv.cfg");
        let m = match std::fs::symlink_metadata(&cfg) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(ToolRefusal::Missing),
            Ok(m) => m,
        };
        if m.file_type().is_symlink() || !m.file_type().is_file() {
            return Err(ToolRefusal::NotRegular);
        }
        if m.uid() != me && m.uid() != 0 {
            return Err(ToolRefusal::WrongOwner);
        }
        if m.mode() & 0o022 != 0 {
            return Err(ToolRefusal::WritableByOthers);
        }
        tools::check_folders(Some(dir), me)?;
        out[i] = Some(Identity { dev: m.dev(), ino: m.ino(), size: m.size(), mtime_ns: m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128, mode: m.mode() });
    }
    Ok(out)
}

/// "<major>.<minor>.<micro> CPython\n" exactly, with canonical decimal parts; the version.
pub fn parse_python_version(out: &[u8]) -> Option<(u32, u32, u32)> {
    let s = std::str::from_utf8(out).ok()?;
    let v = s.strip_suffix(" CPython\n")?;
    let parts: Vec<&str> = v.split('.').collect();
    let canonical = |p: &&str| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()) && (p.len() == 1 || !p.starts_with('0'));
    if parts.len() != 3 || !parts.iter().all(canonical) {
        return None;
    }
    Some((parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?))
}

/// How a kernel starts.
pub struct KernelSpec<'a> {
    pub python: &'a ChosenPython,
    /// The folder holding the sagebrush_kernel package.
    pub resources: &'a Path,
    /// The workspace's folder: the kernel's working folder.
    pub cwd: &'a Path,
    /// The environment it starts from: None, the app's own (the person's); tests give one. STRIPPED_PREFIXES are
    /// removed from it, and MPLBACKEND=Agg added unless set.
    pub base_env: Option<Vec<(std::ffi::OsString, std::ffi::OsString)>>,
}

/// The kernel's environment: `base` less STRIPPED_PREFIXES, with MPLBACKEND=Agg unless set.
pub fn kernel_env(base: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    use std::os::unix::ffi::OsStrExt;
    let mut env: Vec<_> = base.filter(|(k, _)| !STRIPPED_PREFIXES.iter().any(|p| k.as_bytes().starts_with(p.as_bytes()))).collect();
    if !env.iter().any(|(k, _)| k == "MPLBACKEND") {
        env.push(("MPLBACKEND".into(), "Agg".into()));
    }
    env
}

/// What a kernel says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KernelEvent {
    /// One line of its stdout, without the newline.
    Line(String),
    /// It ended: why, in a few words ("exit 0", "signal 9", "line over the cap", "not UTF-8", "stopped").
    Exit(String),
}

/// Why a kernel didn't start, or refused input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KernelError {
    Refused(ToolRefusal),
    Spawn(String),
    /// The input would go past INPUT_MAX, or holds a newline.
    InputRefused,
    Ended,
}

struct Shared {
    queue: VecDeque<KernelEvent>,
    queued: usize,
    input: VecDeque<u8>,
    stderr: VecDeque<u8>,
    ended: bool,
    /// (tests only) every signal sent to the kernel's group, and the reap, in order.
    #[cfg(test)]
    trace: Vec<&'static str>,
}

/// (tests only) a signal or the reap, recorded in order.
#[allow(unused_variables)]
fn note(shared: &(Mutex<Shared>, Condvar), what: &'static str) {
    #[cfg(test)]
    shared.0.lock().unwrap().trace.push(what);
}

/// A running kernel. Dropping it stops it.
pub struct Kernel {
    pid: libc::pid_t,
    shared: Arc<(Mutex<Shared>, Condvar)>,
    stop: Arc<AtomicBool>,
    /// An interrupt asked for: the I/O thread, the only one that signals the kernel or reaps it, sends it, so no
    /// signal can follow the reap (after which the pid and group id could be someone else's).
    interrupt: Arc<AtomicBool>,
    io: Option<std::thread::JoinHandle<()>>,
}

#[cfg(unix)]
impl Kernel {
    /// Start the kernel: the interpreter rechecked first, then spawned as the module comment says.
    pub fn start(spec: &KernelSpec, me: u32) -> Result<Kernel, KernelError> {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        recheck_python(spec.python, me).map_err(KernelError::Refused)?;
        let mut cmd = Command::new(&spec.python.exec_path);
        if (spec.python.version.0, spec.python.version.1) >= (3, 11) {
            cmd.arg("-P");
        }
        cmd.arg("-c").arg(BOOTSTRAP).arg(spec.resources).arg(spec.cwd);
        let env = match &spec.base_env {
            Some(e) => kernel_env(e.clone().into_iter()),
            None => kernel_env(std::env::vars_os()),
        };
        cmd.env_clear().envs(env);
        cmd.current_dir(START_DIR).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // (its own session, and so its own group: pgid = sid = its pid; if setsid fails, the spawn fails)
        unsafe {
            cmd.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) });
        }
        let mut child = cmd.spawn().map_err(|e| KernelError::Spawn(e.to_string()))?;
        let pid = child.id() as libc::pid_t;
        let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
        let shared = Arc::new((
            Mutex::new(Shared {
                queue: VecDeque::new(),
                queued: 0,
                input: VecDeque::new(),
                stderr: VecDeque::new(),
                ended: false,
                #[cfg(test)]
                trace: Vec::new(),
            }),
            Condvar::new(),
        ));
        let stop = Arc::new(AtomicBool::new(false));
        let interrupt = Arc::new(AtomicBool::new(false));
        let (Some(stdin), Some(stdout), Some(stderr)) = (stdin, stdout, stderr) else {
            end_tree(pid, &shared);
            let _ = child.wait();
            return Err(KernelError::Spawn("no pipes".into()));
        };
        let fds: [std::os::fd::OwnedFd; 3] = [stdin.into(), stdout.into(), stderr.into()];
        for fd in &fds {
            use std::os::fd::AsRawFd;
            let fd = fd.as_raw_fd();
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
                // (a blocking pipe could hold the I/O thread past a stop: refused, and the tree ended)
                end_tree(pid, &shared);
                return Err(KernelError::Spawn("pipes not non-blocking".into()));
            }
        }
        // (the Child handle's own wait isn't used: the I/O thread observes the exit with WNOWAIT and reaps after the
        //  tree rule, so the group id can't be reused while it is signalled)
        std::mem::forget(child);
        let io = {
            let (shared, stop, interrupt) = (shared.clone(), stop.clone(), interrupt.clone());
            std::thread::spawn(move || io_loop(pid, fds, shared, stop, interrupt))
        };
        Ok(Kernel { pid, shared, stop, interrupt, io: Some(io) })
    }

    /// Send one line (no newline in it) to the kernel's stdin.
    pub fn send(&self, line: &str) -> Result<(), KernelError> {
        if line.contains('\n') {
            return Err(KernelError::InputRefused);
        }
        let (m, cv) = &*self.shared;
        let mut s = m.lock().unwrap();
        if s.ended {
            return Err(KernelError::Ended);
        }
        if s.input.len() + line.len() + 1 > INPUT_MAX {
            return Err(KernelError::InputRefused);
        }
        s.input.extend(line.as_bytes());
        s.input.push_back(b'\n');
        cv.notify_all();
        Ok(())
    }

    /// The next event, waiting at most `wait`.
    pub fn recv(&self, wait: Duration) -> Option<KernelEvent> {
        let (m, cv) = &*self.shared;
        let deadline = Instant::now() + wait;
        let mut s = m.lock().unwrap();
        loop {
            if let Some(e) = s.queue.pop_front() {
                if let KernelEvent::Line(l) = &e {
                    s.queued -= l.len() + EVENT_COST;
                }
                return Some(e);
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            s = cv.wait_timeout(s, deadline - now).unwrap().0;
        }
    }

    /// What the queued lines are charged now (QUEUE_MAX's measure).
    pub fn queued_bytes(&self) -> usize {
        self.shared.0.lock().unwrap().queued
    }

    /// How many events are queued now.
    pub fn queued_events(&self) -> usize {
        self.shared.0.lock().unwrap().queue.len()
    }

    /// The last of the kernel's stderr.
    pub fn stderr_tail(&self) -> Vec<u8> {
        self.shared.0.lock().unwrap().stderr.iter().copied().collect()
    }

    /// Stop what it is running: SIGINT to its group, sent by the I/O thread while the kernel is unreaped (asked
    /// after the end, it is dropped).
    pub fn interrupt(&self) {
        self.interrupt.store(true, Ordering::SeqCst);
    }

    /// (tests only) the signals sent and the reap, in order.
    #[cfg(test)]
    fn trace(&self) -> Vec<&'static str> {
        self.shared.0.lock().unwrap().trace.clone()
    }

    /// End it (the tree rule), and join its I/O: when this returns, nothing of the kernel is held by the app.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.shared.1.notify_all();
        if let Some(io) = self.io.take() {
            let _ = io.join();
        }
    }
}

impl Drop for Kernel {
    fn drop(&mut self) {
        #[cfg(unix)]
        self.stop();
    }
}

/// The leader's exit, observed without reaping it: Some(true) exited, Some(false) still running, None gone.
#[cfg(unix)]
fn exited(pid: libc::pid_t) -> Option<bool> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
    if r != 0 {
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) { Some(false) } else { None };
    }
    Some(info.si_signo == libc::SIGCHLD)
}

/// The tree rule, then the reap: SIGTERM to the group, SIGKILL after TERM_GRACE (or at once if the leader has already
/// exited), then the leader reaped; its status, in words.
#[cfg(unix)]
fn end_tree(pid: libc::pid_t, shared: &(Mutex<Shared>, Condvar)) -> String {
    if exited(pid).is_none() {
        return "gone".into();
    }
    unsafe { libc::kill(-pid, libc::SIGTERM) };
    note(shared, "sigterm");
    let t = Instant::now();
    while exited(pid) == Some(false) && t.elapsed() < TERM_GRACE {
        std::thread::sleep(Duration::from_millis(10));
    }
    unsafe { libc::kill(-pid, libc::SIGKILL) };
    note(shared, "sigkill");
    let mut status: libc::c_int = 0;
    let r = loop {
        let r = unsafe { libc::waitpid(pid, &mut status, 0) };
        if r < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        break r;
    };
    note(shared, "reaped");
    if r != pid {
        "gone".into()
    } else if libc::WIFEXITED(status) {
        format!("exit {}", libc::WEXITSTATUS(status))
    } else if libc::WIFSIGNALED(status) {
        format!("signal {}", libc::WTERMSIG(status))
    } else {
        "ended".into()
    }
}

/// `pending` split into lines and queued, while the queue has room; what is left stays in `pending`. A line past
/// LINE_MAX, or one that isn't UTF-8, ends the kernel (the reason returned).
fn feed(pending: &mut Vec<u8>, line: &mut Vec<u8>, shared: &(Mutex<Shared>, Condvar)) -> Option<String> {
    let mut used = 0;
    let mut s = shared.0.lock().unwrap();
    while s.queued <= QUEUE_MAX && used < pending.len() {
        let rest = &pending[used..];
        match rest.iter().position(|&b| b == b'\n') {
            Some(p) => {
                if line.len() + p > LINE_MAX {
                    return Some("line over the cap".into());
                }
                line.extend_from_slice(&rest[..p]);
                used += p + 1;
                match String::from_utf8(std::mem::take(line)) {
                    Ok(l) => {
                        s.queued += l.len() + EVENT_COST;
                        s.queue.push_back(KernelEvent::Line(l));
                        shared.1.notify_all();
                    }
                    Err(_) => return Some("not UTF-8".into()),
                }
            }
            None => {
                if line.len() + rest.len() > LINE_MAX {
                    return Some("line over the cap".into());
                }
                line.extend_from_slice(rest);
                used = pending.len();
            }
        }
    }
    pending.drain(..used);
    None
}

/// All of one kernel's I/O, on this thread: stdin written from the input queue, stdout split into lines, stderr kept,
/// the exit observed; at the end the tree rule, the reap, the pipes closed, and Exit queued.
#[cfg(unix)]
fn io_loop(pid: libc::pid_t, fds: [std::os::fd::OwnedFd; 3], shared: Arc<(Mutex<Shared>, Condvar)>, stop: Arc<AtomicBool>, interrupt: Arc<AtomicBool>) {
    use std::os::fd::AsRawFd;
    let [stdin, stdout, stderr] = fds;
    let mut stdin = Some(stdin);
    let mut open = [true, true]; // stdout, stderr
    let mut line: Vec<u8> = Vec::new();
    // (read from stdout but not yet queued as lines, because the queue was full: at most one read)
    let mut pending: Vec<u8> = Vec::new();
    let mut why: Option<String> = None;
    let mut exited_at: Option<Instant> = None;
    let mut chunk = vec![0u8; CHUNK];
    loop {
        if stop.load(Ordering::SeqCst) {
            why = Some("stopped".into());
            break;
        }
        // (the leader is unreaped until end_tree below, which only this thread calls: its group is still its own)
        if interrupt.swap(false, Ordering::SeqCst) {
            unsafe { libc::kill(-pid, libc::SIGINT) };
            note(&shared, "sigint");
        }
        if !pending.is_empty() {
            why = feed(&mut pending, &mut line, &shared);
            if why.is_some() {
                break;
            }
        }
        let (want_out, has_input) = {
            let s = shared.0.lock().unwrap();
            (s.queued <= QUEUE_MAX && pending.is_empty(), !s.input.is_empty())
        };
        let mut pfds: Vec<libc::pollfd> = Vec::new();
        let mut which: Vec<u8> = Vec::new();
        if let (Some(i), true) = (&stdin, has_input) {
            pfds.push(libc::pollfd { fd: i.as_raw_fd(), events: libc::POLLOUT, revents: 0 });
            which.push(0);
        }
        if open[0] && want_out {
            pfds.push(libc::pollfd { fd: stdout.as_raw_fd(), events: libc::POLLIN, revents: 0 });
            which.push(1);
        }
        if open[1] {
            pfds.push(libc::pollfd { fd: stderr.as_raw_fd(), events: libc::POLLIN, revents: 0 });
            which.push(2);
        }
        if pfds.is_empty() {
            std::thread::sleep(Duration::from_millis(20));
        } else {
            unsafe { libc::poll(pfds.as_mut_ptr(), pfds.len() as libc::nfds_t, 20) };
        }
        for (k, &w) in which.iter().enumerate() {
            if pfds[k].revents == 0 {
                continue;
            }
            match w {
                0 => {
                    let Some(i) = &stdin else { continue };
                    let mut s = shared.0.lock().unwrap();
                    let (a, _) = s.input.as_slices();
                    let n = unsafe { libc::write(i.as_raw_fd(), a.as_ptr() as *const libc::c_void, a.len()) };
                    if n > 0 {
                        s.input.drain(..n as usize);
                    } else if n < 0 {
                        let e = std::io::Error::last_os_error();
                        if e.kind() != std::io::ErrorKind::WouldBlock && e.kind() != std::io::ErrorKind::Interrupted {
                            // (the kernel closed its stdin: what was queued can't go anywhere)
                            s.input.clear();
                            drop(s);
                            stdin = None;
                        }
                    }
                }
                1 => {
                    let n = unsafe { libc::read(stdout.as_raw_fd(), chunk.as_mut_ptr() as *mut libc::c_void, chunk.len()) };
                    if n == 0 {
                        open[0] = false;
                    } else if n > 0 {
                        pending.extend_from_slice(&chunk[..n as usize]);
                        why = feed(&mut pending, &mut line, &shared);
                    } else {
                        let e = std::io::Error::last_os_error();
                        if e.kind() != std::io::ErrorKind::WouldBlock && e.kind() != std::io::ErrorKind::Interrupted {
                            open[0] = false;
                        }
                    }
                }
                _ => {
                    let n = unsafe { libc::read(stderr.as_raw_fd(), chunk.as_mut_ptr() as *mut libc::c_void, chunk.len()) };
                    if n == 0 {
                        open[1] = false;
                    } else if n > 0 {
                        let mut s = shared.0.lock().unwrap();
                        s.stderr.extend(&chunk[..n as usize]);
                        let over = s.stderr.len().saturating_sub(STDERR_KEEP);
                        s.stderr.drain(..over);
                    } else {
                        let e = std::io::Error::last_os_error();
                        if e.kind() != std::io::ErrorKind::WouldBlock && e.kind() != std::io::ErrorKind::Interrupted {
                            open[1] = false;
                        }
                    }
                }
            }
            if why.is_some() {
                break;
            }
        }
        if why.is_some() {
            break;
        }
        // (the kernel's own exit ends it: its output is read to the end, for at most EXIT_GRACE, since something it
        //  left behind could hold the pipes)
        if exited_at.is_none() && exited(pid) != Some(false) {
            exited_at = Some(Instant::now());
        }
        if let Some(t) = exited_at {
            if (!open[0] && pending.is_empty() && !open[1]) || t.elapsed() >= EXIT_GRACE {
                break;
            }
        }
    }
    let status = end_tree(pid, &shared);
    drop(stdin);
    drop(stdout);
    drop(stderr);
    let mut s = shared.0.lock().unwrap();
    s.ended = true;
    s.queue.push_back(KernelEvent::Exit(why.unwrap_or(status)));
    shared.1.notify_all();
}

#[cfg(test)]
#[cfg(unix)]
#[path = "pykernel_tests.rs"]
mod tests;
