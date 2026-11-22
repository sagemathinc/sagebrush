// The agent the app hosts (design/app-agent-host.md §5; the agent-host interfaces r5 §1, §2c, §3, §4): the app's
// own child process, started from the app's bundled files only, paired with the app's page by a code that never
// leaves this process except over the child's stdin and, once, to that page. This module owns everything about the
// child that matters for security; the launcher (macapp's, in lib.rs) chooses nothing but what to start.
//
// - The pairing code: 32 bytes from the OS's CSPRNG, base64url without padding. It goes to the child as the first
//   line of its stdin, {"v":1,"pair":"<code>"}, and to the page at most once, for that child's generation only
//   (take_pair_code). It is never in an argument, the environment, a URL, a log or a file; its bytes are zeroed when
//   it is dropped.
// - The launch: an absolute executable and fixed arguments, no shell, no PATH search, a cleared environment holding
//   only what the launcher passes, the launcher's working folder. On Unix the child leads a new process group, so
//   stop() can end everything it started.
// - The port line: the child's first stdout line, at most PORT_LINE_MAX bytes, within the launcher's limit (15 s),
//   exactly {"v":1,"listening":<1-65535>}. Anything else stops the child.
// - Child output: after the port line, stdout is drained and discarded, and stderr is from the start; nothing is
//   kept, logged, written to disk or passed on. Reads are at most DRAIN_CHUNK bytes into one reused buffer.
// - Failures are fixed codes (HostError::code(), BundleError::code()), never child text or OS messages.
// - Stopping: the end of stdin is the agent's signal to clean up and exit (lib/pair-stdin.mjs). stop() closes it,
//   waits up to the grace for the agent to exit, then kills the whole group (whatever the agent left running too);
//   it never signals any other process. Dropping an OwnedAgent without stop() kills the group at once.
// - The group's id stays ours until it is killed: the leader (the agent) is never reaped before the group kill. Its
//   exit is only observed (waitid with WNOWAIT), so a dead leader stays a zombie, and a zombie keeps its pid and its
//   process-group id from being reused; the kill can therefore reach only this agent's own group. The reap comes
//   after it, and with it the group id is given up (`group` 0: nothing left armed).
//
// C, verify_bundle(): before each start, the files the app will run (r5 §3): <resources>/agent/MANIFEST.json, whose
// sha256 must be the one compiled into the app, then every file it lists (size, sha256, mode), the Node sidecar, and
// nothing else in agent/: no extra file, no link, no special file. Any difference refuses the start; nothing is ever
// fetched instead.
//
// Windows: not yet (its owned child is a Job Object, with the Windows step of design/app-agent-host.md §4):
// spawn_owned refuses there with spawn_failed.

use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const PORT_LINE_MAX: usize = 256;
pub const PORT_WAIT: Duration = Duration::from_secs(15);
pub const DRAIN_CHUNK: usize = 8 * 1024;
const CODE_LEN: usize = 43; // (32 bytes in base64url without padding)
const MANIFEST_MAX: u64 = 16 * 1024 * 1024;
const FILES_MAX: usize = 100_000;

/// Why a launch or a pairing failed: r5 §2c's codes, the only thing ever said about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostError {
    SpawnFailed,
    NoPortLine,
    BadPortLine,
    ChildExited,
    PairCodeUsed,
    StaleGeneration,
}

impl HostError {
    pub fn code(self) -> &'static str {
        match self {
            HostError::SpawnFailed => "spawn_failed",
            HostError::NoPortLine => "no_port_line",
            HostError::BadPortLine => "bad_port_line",
            HostError::ChildExited => "child_exited",
            HostError::PairCodeUsed => "pair_code_used",
            HostError::StaleGeneration => "stale_generation",
        }
    }
}

/// The app's one-time pairing code for one child. Not Clone, not Debug-printable; zeroed when dropped.
pub struct PairCode {
    text: [u8; CODE_LEN],
}

impl PairCode {
    pub fn generate() -> Result<PairCode, HostError> {
        let mut raw = [0u8; 32];
        getrandom::fill(&mut raw).map_err(|_| HostError::SpawnFailed)?;
        let code = PairCode { text: base64url(&raw) };
        zero(&mut raw);
        Ok(code)
    }

    /// The code's text, for the page (the Tauri command hands it over and drops it).
    pub fn as_str(&self) -> &str {
        // (only base64url characters were ever written: always valid UTF-8)
        std::str::from_utf8(&self.text).unwrap_or("")
    }
}

impl Drop for PairCode {
    fn drop(&mut self) {
        zero(&mut self.text);
    }
}

impl std::fmt::Debug for PairCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PairCode(..)")
    }
}

fn zero(b: &mut [u8]) {
    for x in b.iter_mut() {
        // (volatile, so the write isn't optimized away before the memory is freed)
        unsafe { std::ptr::write_volatile(x, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

fn base64url(raw: &[u8; 32]) -> [u8; CODE_LEN] {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = [0u8; CODE_LEN];
    let mut o = 0;
    let mut i = 0;
    while i + 3 <= 32 {
        let n = (raw[i] as u32) << 16 | (raw[i + 1] as u32) << 8 | raw[i + 2] as u32;
        for k in 0..4 {
            out[o + k] = A[((n >> (18 - 6 * k)) & 63) as usize];
        }
        o += 4;
        i += 3;
    }
    // (32 = 30 + 2: the last two bytes give three characters)
    let n = (raw[30] as u32) << 16 | (raw[31] as u32) << 8;
    for k in 0..3 {
        out[o + k] = A[((n >> (18 - 6 * k)) & 63) as usize];
    }
    out
}

/// What the launcher starts: every value the app's own (r5 §2, the fixed launch).
pub struct Launch<'a> {
    pub exe: &'a Path,
    pub args: &'a [OsString],
    pub cwd: &'a Path,
    pub env: &'a [(OsString, OsString)],
    pub generation: u64,
    pub port_wait: Duration,
}

/// The running agent the app started.
pub struct OwnedAgent {
    generation: u64,
    port: u16,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    code: Option<PairCode>,
    drains: Vec<JoinHandle<()>>,
    #[cfg(unix)]
    group: i32,
}

impl std::fmt::Debug for OwnedAgent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // (never the code)
        write!(f, "OwnedAgent {{ generation: {}, port: {} }}", self.generation, self.port)
    }
}

impl OwnedAgent {
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn port(&self) -> u16 {
        self.port
    }
    /// Whether the child has exited (its code is then no good to anyone). It is not reaped here: see leader_exited.
    pub fn exited(&mut self) -> bool {
        self.leader_exited()
    }

    // The leader's exit, observed without reaping it (waitid WNOWAIT): an exited leader stays a zombie, holding its pid
    // and the group id until Drop has killed the group and then reaps it. Never try_wait() or wait() before that.
    #[cfg(unix)]
    fn leader_exited(&mut self) -> bool {
        let Some(c) = self.child.as_ref() else { return true };
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let r = unsafe { libc::waitid(libc::P_PID, c.id() as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
        if r != 0 {
            // (no such child to wait for: reaped some other way, so its ids may already be reused; disarm the group)
            self.group = 0;
            return true;
        }
        // (WNOHANG with nothing to report leaves the zeroed siginfo as it was; an exit reports SIGCHLD)
        info.si_signo == libc::SIGCHLD
    }
    #[cfg(not(unix))]
    fn leader_exited(&mut self) -> bool {
        match self.child.as_mut() {
            Some(c) => !matches!(c.try_wait(), Ok(None)),
            None => true,
        }
    }
}

/// Start the agent: the launch exactly as given, the code over its stdin, its port from its first stdout line.
pub fn spawn_owned(l: &Launch, code: PairCode) -> Result<OwnedAgent, HostError> {
    #[cfg(not(unix))]
    {
        let _ = (l, code);
        return Err(HostError::SpawnFailed);
    }
    #[cfg(unix)]
    {
        if !l.exe.is_absolute() || !l.cwd.is_absolute() {
            return Err(HostError::SpawnFailed);
        }
        let mut cmd = Command::new(l.exe);
        cmd.args(l.args).current_dir(l.cwd).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (k, v) in l.env {
            cmd.env(k, v);
        }
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|_| HostError::SpawnFailed)?;
        let group = child.id() as i32;
        let mut agent = OwnedAgent { generation: l.generation, port: 0, child: None, stdin: None, code: None, drains: Vec::new(), group };
        // (from here every failure kills the group: the drop below)
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = child.stdin.take();
        agent.child = Some(child);
        let (Some(stdout), Some(stderr), Some(mut stdin)) = (stdout, stderr, stdin) else {
            return Err(HostError::SpawnFailed);
        };
        agent.drains.push(std::thread::spawn(move || drain(stderr)));
        let (tx, rx) = mpsc::channel::<Result<u16, HostError>>();
        agent.drains.push(std::thread::spawn(move || {
            let mut stdout = stdout;
            let first = read_port_line(&mut stdout);
            let _ = tx.send(first);
            drain(stdout);
        }));
        let mut line = Vec::with_capacity(CODE_LEN + 32);
        line.extend_from_slice(b"{\"v\":1,\"pair\":\"");
        line.extend_from_slice(&code.text);
        line.extend_from_slice(b"\"}\n");
        let wrote = stdin.write_all(&line).and_then(|_| stdin.flush());
        zero(&mut line);
        if wrote.is_err() {
            return Err(HostError::ChildExited);
        }
        agent.stdin = Some(stdin);
        agent.code = Some(code);
        match rx.recv_timeout(l.port_wait) {
            Ok(Ok(port)) => {
                agent.port = port;
                Ok(agent)
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err(HostError::NoPortLine),
        }
    }
}

// The first line: at most PORT_LINE_MAX bytes, read a byte at a time so nothing after the newline is taken here.
fn read_port_line(r: &mut impl Read) -> Result<u16, HostError> {
    let mut line = Vec::with_capacity(PORT_LINE_MAX);
    let mut b = [0u8; 1];
    loop {
        match r.read(&mut b) {
            Ok(0) => return Err(if line.is_empty() { HostError::NoPortLine } else { HostError::BadPortLine }),
            Ok(_) => {
                if b[0] == b'\n' {
                    break;
                }
                if line.len() == PORT_LINE_MAX {
                    return Err(HostError::BadPortLine);
                }
                line.push(b[0]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(HostError::NoPortLine),
        }
    }
    parse_port_line(&line).ok_or(HostError::BadPortLine)
}

/// {"v":1,"listening":<1-65535>} and nothing else, or None.
pub fn parse_port_line(line: &[u8]) -> Option<u16> {
    let v: serde_json::Value = serde_json::from_slice(line).ok()?;
    let o = v.as_object()?;
    if o.len() != 2 || o.get("v")?.as_u64()? != 1 || !o.get("v")?.is_u64() {
        return None;
    }
    let p = o.get("listening")?;
    let n = p.as_u64()?;
    if !p.is_u64() || n == 0 || n > 65535 {
        return None;
    }
    Some(n as u16)
}

// Read and discard: one reused buffer, nothing kept.
fn drain(mut r: impl Read) {
    let mut buf = vec![0u8; DRAIN_CHUNK];
    loop {
        match r.read(&mut buf) {
            Ok(0) => return,
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

/// The page's one request for the code, for this generation only.
pub fn take_pair_code(agent: &mut OwnedAgent, generation: u64) -> Result<(PairCode, u16), HostError> {
    if generation != agent.generation {
        return Err(HostError::StaleGeneration);
    }
    if agent.exited() {
        agent.code = None;
        return Err(HostError::ChildExited);
    }
    match agent.code.take() {
        Some(c) => Ok((c, agent.port)),
        None => Err(HostError::PairCodeUsed),
    }
}

/// Stop it: the code dropped, stdin closed (the agent's cleanup), up to `grace` for it to exit, then the group killed.
pub fn stop(mut agent: OwnedAgent, grace: Duration) {
    agent.code = None;
    drop(agent.stdin.take());
    let t0 = Instant::now();
    while !agent.leader_exited() && t0.elapsed() < grace {
        std::thread::sleep(Duration::from_millis(20));
    }
    // (the drop kills the group while the leader still holds its id, then reaps the leader)
}

// (tests only, compiled out of the app: at each group kill, whether the leader was still unreaped, so a test can tell
//  a kill made while the group id was ours from one made after it was given up)
#[cfg(all(test, unix))]
thread_local! {
    static KILL_TRACE: std::cell::RefCell<Vec<bool>> = const { std::cell::RefCell::new(Vec::new()) };
}

impl Drop for OwnedAgent {
    fn drop(&mut self) {
        self.code = None;
        drop(self.stdin.take());
        #[cfg(unix)]
        if self.group > 0 {
            // (the group this child leads: the agent and everything it started that stayed in it; never any other pid.
            //  The leader is unreaped here, alive or a zombie, so the group id can't have been reused)
            #[cfg(test)]
            {
                let held = self.child.as_ref().is_some_and(|c| {
                    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                    unsafe { libc::waitid(libc::P_PID, c.id() as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) == 0 }
                });
                KILL_TRACE.with(|t| t.borrow_mut().push(held));
            }
            unsafe { libc::kill(-self.group, libc::SIGKILL) };
        }
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        // (reaped: the group id is no longer ours)
        #[cfg(unix)]
        {
            self.group = 0;
        }
        // (the drains are not joined: each ends when its pipe closes, and a process outside the group still holding
        //  a pipe must never hold up the app's quit)
        self.drains.clear();
    }
}

// ---- C: the bundle check

/// Why the bundle was refused; the page says only "bundle_check_failed" (or "not_bundled"). The variants are for tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BundleError {
    NotBundled,
    ManifestUnreadable,
    ManifestHash,
    ManifestForm,
    BadPath,
    Missing,
    NotAFile,
    Link,
    Extra,
    Size,
    Hash,
    Mode,
}

impl BundleError {
    pub fn code(&self) -> &'static str {
        if *self == BundleError::NotBundled { "not_bundled" } else { "bundle_check_failed" }
    }
}

/// The versions the manifest names, for About and agent_status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Versions {
    pub agent: String,
    pub claude_code: String,
    pub codex: Option<String>,
    pub node: String,
}

struct Entry {
    sha256: [u8; 32],
    size: u64,
    exec: bool,
}

/// Check <resources>/agent/ against its manifest, whose sha256 must be `manifest_sha256` (the app's compiled-in
/// SAGEBRUSH_AGENT_MANIFEST_SHA256, lowercase hex; empty: no agent in this build).
pub fn verify_bundle(resources: &Path, manifest_sha256: &str) -> Result<Versions, BundleError> {
    if manifest_sha256.is_empty() {
        return Err(BundleError::NotBundled);
    }
    let want = hex32(manifest_sha256).ok_or(BundleError::ManifestHash)?;
    let agent = resources.join("agent");
    no_link_dir(resources)?;
    no_link_dir(&agent)?;
    let mpath = agent.join("MANIFEST.json");
    let md = std::fs::symlink_metadata(&mpath).map_err(|_| BundleError::ManifestUnreadable)?;
    if !md.file_type().is_file() {
        return Err(BundleError::ManifestUnreadable);
    }
    if md.len() > MANIFEST_MAX {
        return Err(BundleError::ManifestForm);
    }
    let bytes = std::fs::read(&mpath).map_err(|_| BundleError::ManifestUnreadable)?;
    if Sha256::digest(&bytes).as_slice() != want {
        return Err(BundleError::ManifestHash);
    }
    let (versions, node, files) = parse_manifest(&bytes)?;
    // (the Node sidecar, outside agent/: its path relative to resources, checked like a listed file)
    check_file(resources, &node.0, &node.1)?;
    // (every file in agent/ is listed, and is what the list says; MANIFEST.json itself is checked above)
    let mut seen = 0usize;
    walk(&agent, &agent, &mut |rel, full| {
        if rel == "MANIFEST.json" {
            return Ok(());
        }
        let e = files.get(rel).ok_or(BundleError::Extra)?;
        seen += 1;
        check_entry(full, e)
    })?;
    if seen != files.len() {
        return Err(BundleError::Missing);
    }
    Ok(versions)
}

fn parse_manifest(bytes: &[u8]) -> Result<(Versions, (String, Entry), BTreeMap<String, Entry>), BundleError> {
    use BundleError::ManifestForm as F;
    let v: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| F)?;
    let o = v.as_object().ok_or(F)?;
    if o.get("v").and_then(|x| x.as_u64()) != Some(1) {
        return Err(F);
    }
    let s = |x: Option<&serde_json::Value>| x.and_then(|y| y.as_str()).map(|y| y.to_string()).filter(|y| !y.is_empty() && y.len() <= 64).ok_or(F);
    let agent = o.get("agent").and_then(|x| x.as_object()).ok_or(F)?;
    let claude = o.get("claude_code").and_then(|x| x.as_object()).ok_or(F)?;
    let node = o.get("node").and_then(|x| x.as_object()).ok_or(F)?;
    let codex = match o.get("codex") {
        None => None,
        Some(c) => Some(s(c.as_object().ok_or(F)?.get("version"))?),
    };
    s(agent.get("release_sha256")).and_then(|h| hex32(&h).ok_or(F))?;
    let versions = Versions { agent: s(agent.get("version"))?, claude_code: s(claude.get("version"))?, codex, node: s(node.get("version"))? };
    let node_path = s(node.get("path"))?;
    if !clean_rel(&node_path) {
        return Err(BundleError::BadPath);
    }
    let node_entry = Entry { sha256: hex32(&s(node.get("sha256"))?).ok_or(F)?, size: node.get("size").and_then(|x| x.as_u64()).ok_or(F)?, exec: true };
    let list = o.get("files").and_then(|x| x.as_array()).ok_or(F)?;
    if list.len() > FILES_MAX {
        return Err(F);
    }
    let mut files = BTreeMap::new();
    for f in list {
        let f = f.as_object().ok_or(F)?;
        let path = f.get("path").and_then(|x| x.as_str()).ok_or(F)?.to_string();
        if !clean_rel(&path) || path == "MANIFEST.json" {
            return Err(BundleError::BadPath);
        }
        let exec = match f.get("mode").and_then(|x| x.as_str()) {
            Some("0644") => false,
            Some("0755") => true,
            _ => return Err(F),
        };
        let e = Entry { sha256: hex32(f.get("sha256").and_then(|x| x.as_str()).ok_or(F)?).ok_or(F)?, size: f.get("size").and_then(|x| x.as_u64()).ok_or(F)?, exec };
        if files.insert(path, e).is_some() {
            return Err(BundleError::BadPath); // (listed twice)
        }
    }
    Ok((versions, (node_path, node_entry), files))
}

/// A normalized relative '/'-separated path: no '..', no '.', no empty component, nothing absolute, no '\\' or NUL.
pub fn clean_rel(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 4096
        && !p.starts_with('/')
        && !p.contains('\\')
        && !p.contains('\0')
        && p.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

fn hex32(h: &str) -> Option<[u8; 32]> {
    if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

fn no_link_dir(p: &Path) -> Result<(), BundleError> {
    let m = std::fs::symlink_metadata(p).map_err(|_| BundleError::Missing)?;
    if m.file_type().is_symlink() {
        return Err(BundleError::Link);
    }
    if !m.is_dir() {
        return Err(BundleError::NotAFile);
    }
    Ok(())
}

// Every entry under `dir`, depth first; a link or anything but a file or a folder refuses the bundle.
fn walk(root: &Path, dir: &Path, f: &mut dyn FnMut(&str, &Path) -> Result<(), BundleError>) -> Result<(), BundleError> {
    let rd = std::fs::read_dir(dir).map_err(|_| BundleError::Missing)?;
    for e in rd {
        let e = e.map_err(|_| BundleError::Missing)?;
        let full = e.path();
        let t = std::fs::symlink_metadata(&full).map_err(|_| BundleError::Missing)?.file_type();
        if t.is_symlink() {
            return Err(BundleError::Link);
        }
        if t.is_dir() {
            walk(root, &full, f)?;
        } else if t.is_file() {
            let rel = rel_of(root, &full).ok_or(BundleError::BadPath)?;
            f(&rel, &full)?;
        } else {
            return Err(BundleError::NotAFile);
        }
    }
    Ok(())
}

fn rel_of(root: &Path, full: &Path) -> Option<String> {
    let r = full.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in r.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_str()?.to_string()),
            _ => return None,
        }
    }
    let s = parts.join("/");
    clean_rel(&s).then_some(s)
}

fn check_file(base: &Path, rel: &str, e: &Entry) -> Result<(), BundleError> {
    // (each folder on the way, and the file, must not be a link)
    let mut p = PathBuf::from(base);
    for c in rel.split('/') {
        p.push(c);
        let m = std::fs::symlink_metadata(&p).map_err(|_| BundleError::Missing)?;
        if m.file_type().is_symlink() {
            return Err(BundleError::Link);
        }
    }
    check_entry(&p, e)
}

fn check_entry(full: &Path, e: &Entry) -> Result<(), BundleError> {
    let m = std::fs::symlink_metadata(full).map_err(|_| BundleError::Missing)?;
    if m.file_type().is_symlink() {
        return Err(BundleError::Link);
    }
    if !m.file_type().is_file() {
        return Err(BundleError::NotAFile);
    }
    if m.len() != e.size {
        return Err(BundleError::Size);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let exec = m.permissions().mode() & 0o111 != 0;
        let writable_by_others = m.permissions().mode() & 0o022 != 0;
        if exec != e.exec || writable_by_others {
            return Err(BundleError::Mode);
        }
    }
    let mut f = std::fs::File::open(full).map_err(|_| BundleError::Missing)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut n_total = 0u64;
    loop {
        let n = f.read(&mut buf).map_err(|_| BundleError::Missing)?;
        if n == 0 {
            break;
        }
        n_total += n as u64;
        if n_total > e.size {
            return Err(BundleError::Size);
        }
        h.update(&buf[..n]);
    }
    if n_total != e.size {
        return Err(BundleError::Size);
    }
    if h.finalize().as_slice() != e.sha256 {
        return Err(BundleError::Hash);
    }
    Ok(())
}

#[cfg(all(test, unix))]
#[path = "agent_host_tests.rs"]
mod tests;
