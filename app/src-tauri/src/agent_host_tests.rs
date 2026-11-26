// agent_host.rs: the owned child (with /bin/sh scripts standing in for the agent) and the bundle check (with trees
// built here). Unix only, like the owned child itself for now.
use super::*;
use std::fs;
use std::os::unix::fs::PermissionsExt;

struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Tmp {
        let mut raw = [0u8; 8];
        getrandom::fill(&mut raw).unwrap();
        let p = std::env::temp_dir().join(format!("sb-agent-host-{tag}-{}", raw.iter().map(|b| format!("{b:02x}")).collect::<String>()));
        fs::create_dir_all(&p).unwrap();
        Tmp(p.canonicalize().unwrap())
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// An agent stand-in: a /bin/sh script, run with the module's launch (absolute /bin/sh, the script as its argument).
fn script(t: &Tmp, body: &str) -> Vec<OsString> {
    let p = t.0.join("agent.sh");
    fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    vec![p.into_os_string()]
}

fn launch<'a>(t: &'a Tmp, args: &'a [OsString], env: &'a [(OsString, OsString)], wait_ms: u64) -> Launch<'a> {
    Launch { exe: Path::new("/bin/sh"), args, cwd: &t.0, env, generation: 7, port_wait: Duration::from_millis(wait_ms) }
}

fn env_for(t: &Tmp) -> Vec<(OsString, OsString)> {
    vec![("DIR".into(), t.0.clone().into_os_string()), ("PATH".into(), "/usr/bin:/bin".into())]
}

const GOOD: &str = r#"IFS= read -r line; printf '%s\n' "$line" > "$DIR/got"; echo '{"v":1,"listening":4242}'; while IFS= read -r x; do :; done; echo clean > "$DIR/clean""#;

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

fn wait_until(mut f: impl FnMut() -> bool, ms: u64) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_millis(ms) {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    f()
}

#[test]
fn pair_code_is_43_base64url_characters_and_fresh() {
    let a = PairCode::generate().unwrap();
    let b = PairCode::generate().unwrap();
    assert_eq!(a.as_str().len(), 43);
    assert!(a.as_str().bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
    assert_ne!(a.as_str(), b.as_str());
    assert_eq!(format!("{a:?}"), "PairCode(..)", "Debug never shows the code");
}

#[test]
fn base64url_matches_the_standard_encoding() {
    // (RFC 4648 §5 for 32 bytes 0..31: what the agent's Buffer.from(_, "base64url") decodes)
    let raw: [u8; 32] = core::array::from_fn(|i| i as u8);
    assert_eq!(std::str::from_utf8(&base64url(&raw)).unwrap(), "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    let ff = [0xffu8; 32];
    assert_eq!(std::str::from_utf8(&base64url(&ff)).unwrap(), "__________________________________________8");
}

#[test]
fn port_line_is_exact() {
    assert_eq!(parse_port_line(br#"{"v":1,"listening":4242}"#), Some(4242));
    assert_eq!(parse_port_line(br#"{"listening":1,"v":1}"#), Some(1));
    for bad in [&br#"{"v":1,"listening":0}"#[..], br#"{"v":1,"listening":65536}"#, br#"{"v":1,"listening":42.0}"#, br#"{"v":1,"listening":"42"}"#,
        br#"{"v":2,"listening":42}"#, br#"{"v":1,"listening":42,"x":1}"#, br#"{"v":1}"#, br#"[1,42]"#, b"listening 42", br#"{"v":1,"listening":-1}"#] {
        assert_eq!(parse_port_line(bad), None, "{}", String::from_utf8_lossy(bad));
    }
}

#[test]
fn spawn_hands_the_code_over_stdin_once_and_reads_the_port() {
    let t = Tmp::new("good");
    let args = script(&t, GOOD);
    let env = env_for(&t);
    let code = PairCode::generate().unwrap();
    let text = code.as_str().to_string();
    let mut a = spawn_owned(&launch(&t, &args, &env, 5000), code).unwrap();
    assert_eq!(a.port(), 4242);
    assert_eq!(fs::read_to_string(t.0.join("got")).unwrap(), format!("{{\"v\":1,\"pair\":\"{text}\"}}\n"), "the stdin line, exactly");
    assert_eq!(take_pair_code(&mut a, 8).unwrap_err(), HostError::StaleGeneration);
    let (c, port) = take_pair_code(&mut a, 7).unwrap();
    assert_eq!((c.as_str(), port), (text.as_str(), 4242));
    assert_eq!(take_pair_code(&mut a, 7).unwrap_err(), HostError::PairCodeUsed);
    stop(a, Duration::from_secs(5));
    assert!(t.0.join("clean").exists(), "the end of stdin let the agent clean up before it was stopped");
}

#[test]
fn the_launch_is_exactly_the_launchers_no_inherited_environment_no_relative_paths() {
    let t = Tmp::new("env");
    std::env::set_var("SB_AGENT_HOST_LEAK", "1");
    let args = script(&t, r#"IFS= read -r line; env | sort > "$DIR/env"; pwd -P > "$DIR/cwd"; echo '{"v":1,"listening":9}'; while read x; do :; done"#);
    let env = env_for(&t);
    let a = spawn_owned(&launch(&t, &args, &env, 5000), PairCode::generate().unwrap()).unwrap();
    let seen = fs::read_to_string(t.0.join("env")).unwrap();
    assert!(!seen.contains("SB_AGENT_HOST_LEAK"), "nothing from the app's own environment");
    assert!(seen.lines().all(|l| l.starts_with("DIR=") || l.starts_with("PATH=") || l.starts_with("PWD=") || l.starts_with("SHLVL=") || l.starts_with("_=") || l.starts_with("OLDPWD=")), "{seen}");
    assert_eq!(fs::read_to_string(t.0.join("cwd")).unwrap().trim(), t.0.to_str().unwrap());
    stop(a, Duration::from_secs(5));
    let rel = [OsString::from("agent.sh")];
    let l = Launch { exe: Path::new("sh"), args: &rel, cwd: &t.0, env: &env, generation: 1, port_wait: Duration::from_secs(1) };
    assert_eq!(spawn_owned(&l, PairCode::generate().unwrap()).unwrap_err(), HostError::SpawnFailed, "a relative executable (a PATH search) is refused");
    let l = Launch { exe: Path::new("/bin/sh"), args: &args, cwd: Path::new("."), env: &env, generation: 1, port_wait: Duration::from_secs(1) };
    assert_eq!(spawn_owned(&l, PairCode::generate().unwrap()).unwrap_err(), HostError::SpawnFailed, "a relative working folder is refused");
    let missing = Launch { exe: Path::new("/nonexistent/sagebrush-node"), args: &args, cwd: &t.0, env: &env, generation: 1, port_wait: Duration::from_secs(1) };
    assert_eq!(spawn_owned(&missing, PairCode::generate().unwrap()).unwrap_err(), HostError::SpawnFailed);
}

#[test]
fn a_missing_slow_or_bad_port_line_stops_the_child() {
    for (what, body, want) in [
        ("no line in time", r#"IFS= read -r line; echo $$ > "$DIR/pid"; sleep 30"#, HostError::NoPortLine),
        ("exits first", r#"IFS= read -r line; echo $$ > "$DIR/pid"; exit 3"#, HostError::NoPortLine),
        ("not the port line", r#"IFS= read -r line; echo $$ > "$DIR/pid"; echo hello; sleep 30"#, HostError::BadPortLine),
        ("port 0", r#"IFS= read -r line; echo $$ > "$DIR/pid"; echo '{"v":1,"listening":0}'; sleep 30"#, HostError::BadPortLine),
        ("a longer line than the limit", r#"IFS= read -r line; echo $$ > "$DIR/pid"; head -c 300 /dev/zero | tr '\0' x; echo; sleep 30"#, HostError::BadPortLine),
        // (valid JSON past the limit: only the cap refuses it)
        ("a valid port line padded past the limit", r#"IFS= read -r line; echo $$ > "$DIR/pid"; printf '{"v":1,"listening":5}%300s\n' ''; sleep 30"#, HostError::BadPortLine),
        ("no newline, then the end", r#"IFS= read -r line; echo $$ > "$DIR/pid"; printf '{"v":1,"listening":5}'"#, HostError::BadPortLine),
    ] {
        let t = Tmp::new("bad");
        let args = script(&t, body);
        let env = env_for(&t);
        let t0 = Instant::now();
        let e = spawn_owned(&launch(&t, &args, &env, 700), PairCode::generate().unwrap()).unwrap_err();
        assert_eq!(e, want, "{what}");
        assert!(t0.elapsed() < Duration::from_secs(5), "{what}: bounded by the wait");
        let pid: i32 = fs::read_to_string(t.0.join("pid")).unwrap().trim().parse().unwrap();
        assert!(wait_until(|| !alive(pid), 3000), "{what}: the child is gone");
    }
}

#[test]
fn a_child_that_exits_without_reading_its_code_fails_either_way() {
    // (it can exit before the code is written, child_exited, or after, no_port_line: both refuse the launch)
    for _ in 0..20 {
        let t = Tmp::new("unread");
        let args = script(&t, "exit 0");
        let env = env_for(&t);
        let e = spawn_owned(&launch(&t, &args, &env, 2000), PairCode::generate().unwrap()).unwrap_err();
        assert!(matches!(e, HostError::ChildExited | HostError::NoPortLine), "{e:?}");
    }
}

#[test]
fn output_after_the_port_line_is_drained_and_nothing_blocks() {
    let t = Tmp::new("flood");
    // (16 MiB on each stream after the port line: far past any pipe buffer, so an undrained pipe would block it)
    let args = script(&t, r#"IFS= read -r line; echo '{"v":1,"listening":77}'; head -c 16777216 /dev/zero; head -c 16777216 /dev/zero >&2; echo done > "$DIR/done"; while read x; do :; done"#);
    let env = env_for(&t);
    let a = spawn_owned(&launch(&t, &args, &env, 5000), PairCode::generate().unwrap()).unwrap();
    assert!(wait_until(|| t.0.join("done").exists(), 20000), "the child wrote all its output");
    stop(a, Duration::from_secs(5));
}

#[test]
fn stop_kills_what_the_agent_left_running_and_one_that_ignores_the_end_of_stdin() {
    let t = Tmp::new("group");
    let args = script(&t, r#"IFS= read -r line; sleep 300 & echo $! > "$DIR/gc"; echo '{"v":1,"listening":5}'; while read x; do :; done"#);
    let env = env_for(&t);
    let a = spawn_owned(&launch(&t, &args, &env, 5000), PairCode::generate().unwrap()).unwrap();
    assert!(wait_until(|| t.0.join("gc").exists(), 3000));
    let gc: i32 = fs::read_to_string(t.0.join("gc")).unwrap().trim().parse().unwrap();
    assert!(alive(gc));
    stop(a, Duration::from_secs(5));
    assert!(wait_until(|| !alive(gc), 3000), "the process the agent started is gone too");

    let t = Tmp::new("stubborn");
    let args = script(&t, r#"IFS= read -r line; trap '' TERM HUP; echo $$ > "$DIR/pid"; echo '{"v":1,"listening":5}'; sleep 300"#);
    let env = env_for(&t);
    let a = spawn_owned(&launch(&t, &args, &env, 5000), PairCode::generate().unwrap()).unwrap();
    let pid: i32 = fs::read_to_string(t.0.join("pid")).unwrap().trim().parse().unwrap();
    let t0 = Instant::now();
    stop(a, Duration::from_millis(300));
    assert!(t0.elapsed() < Duration::from_secs(3), "stop is bounded by its grace");
    assert!(wait_until(|| !alive(pid), 3000), "a child that ignores the end of stdin is killed after the grace");
}

#[test]
fn dropping_without_stop_kills_at_once_and_an_exited_child_has_no_code() {
    let t = Tmp::new("drop");
    let args = script(&t, r#"IFS= read -r line; echo $$ > "$DIR/pid"; echo '{"v":1,"listening":5}'; while read x; do :; done"#);
    let env = env_for(&t);
    let a = spawn_owned(&launch(&t, &args, &env, 5000), PairCode::generate().unwrap()).unwrap();
    let pid: i32 = fs::read_to_string(t.0.join("pid")).unwrap().trim().parse().unwrap();
    drop(a);
    assert!(wait_until(|| !alive(pid), 3000));

    let t = Tmp::new("exits");
    let args = script(&t, r#"IFS= read -r line; echo '{"v":1,"listening":5}'; exit 0"#);
    let env = env_for(&t);
    let mut a = spawn_owned(&launch(&t, &args, &env, 5000), PairCode::generate().unwrap()).unwrap();
    assert!(wait_until(|| a.exited(), 3000));
    assert_eq!(take_pair_code(&mut a, 7).unwrap_err(), HostError::ChildExited, "the code of a child that's gone is never handed out");
    assert_eq!(take_pair_code(&mut a, 7).unwrap_err(), HostError::ChildExited);
}

// The leader's state without reaping it: Some(true) exited (a zombie, still ours), Some(false) running, None no such
// child (reaped: its pid and group id are free for reuse).
fn leader_state(pid: u32) -> Option<bool> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
    if r != 0 {
        return None;
    }
    Some(info.si_signo == libc::SIGCHLD)
}

// A leader that exits by itself, leaving a process it started running in its group: the group's id must stay ours
// (the leader unreaped) until the group is killed, and only then is the leader reaped.
fn kills_traced() -> Vec<&'static str> {
    KILL_TRACE.with(|t| std::mem::take(&mut *t.borrow_mut()))
}

fn exiting_leader(tag: &str) -> (Tmp, OwnedAgent, u32, i32) {
    let t = Tmp::new(tag);
    let args = script(&t, r#"IFS= read -r line; sleep 300 & echo $! > "$DIR/gc"; echo '{"v":1,"listening":5}'; exit 0"#);
    let env = env_for(&t);
    let mut a = spawn_owned(&launch(&t, &args, &env, 5000), PairCode::generate().unwrap()).unwrap();
    let pid = a.child.as_ref().unwrap().id();
    assert!(wait_until(|| t.0.join("gc").exists() && a.exited(), 5000), "the leader exited");
    let gc: i32 = fs::read_to_string(t.0.join("gc")).unwrap().trim().parse().unwrap();
    (t, a, pid, gc)
}

#[test]
fn an_exited_leader_is_observed_not_reaped_so_its_group_id_stays_ours() {
    let (_t, mut a, pid, gc) = exiting_leader("zombie");
    // (asked again and again, as the page's status and take_pair_code do: still a zombie each time, never reaped)
    for _ in 0..5 {
        assert!(a.exited());
        assert_eq!(leader_state(pid), Some(true), "the exited leader is still unreaped: its pid and group id can't be reused");
    }
    assert_eq!(take_pair_code(&mut a, 7).unwrap_err(), HostError::ChildExited);
    assert_eq!(leader_state(pid), Some(true), "take_pair_code doesn't reap it either");
    assert!(alive(gc), "what it left running is still in its group");
    assert_eq!(a.group, pid as i32, "the group kill is armed only while the leader holds the id");
    kills_traced();
    drop(a);
    assert_eq!(kills_traced(), ["group_held", "child_kill"], "the group kill came while the leader still held the group id, then the leader's own");
    assert!(wait_until(|| !alive(gc), 3000), "dropping it kills what the leader left running");
    assert_eq!(leader_state(pid), None, "and only then reaps the leader: nothing of ours is left to signal");
}

#[test]
fn stop_after_the_leader_exited_kills_the_group_then_reaps() {
    let (_t, a, pid, gc) = exiting_leader("zombie-stop");
    let t0 = Instant::now();
    kills_traced();
    stop(a, Duration::from_secs(5));
    assert_eq!(kills_traced(), ["group_held", "child_kill"], "stop's group kill came while the leader still held the group id");
    assert!(t0.elapsed() < Duration::from_secs(2), "an exited leader doesn't make stop wait out the grace");
    assert!(wait_until(|| !alive(gc), 3000), "the descendants are cleaned up");
    assert_eq!(leader_state(pid), None, "the leader is reaped after the group kill");
}

#[test]
fn a_waitid_result_is_read_rightly_an_interruption_is_asked_again() {
    assert_eq!(observed(0, None), Observed::Answer);
    assert_eq!(observed(0, Some(libc::EINTR)), Observed::Answer, "success, whatever errno holds");
    assert_eq!(observed(-1, Some(libc::EINTR)), Observed::Retry, "interrupted says nothing about the child");
    assert_eq!(observed(-1, Some(libc::ECHILD)), Observed::Gone);
    assert_eq!(observed(-1, Some(libc::EINVAL)), Observed::Gone);
    assert_eq!(observed(-1, None), Observed::Gone);
}

#[test]
fn a_leader_reaped_some_other_way_disarms_every_signal() {
    // (the fallback for a child this module didn't reap: its pid and group id may be someone else's by now, so nothing
    //  may be signalled, neither the group nor the pid; nothing is waited for either)
    let t = Tmp::new("reaped-elsewhere");
    let args = script(&t, r#"IFS= read -r line; echo '{"v":1,"listening":5}'; exit 0"#);
    let env = env_for(&t);
    let mut a = spawn_owned(&launch(&t, &args, &env, 5000), PairCode::generate().unwrap()).unwrap();
    let pid = a.child.as_ref().unwrap().id();
    assert!(wait_until(|| a.exited(), 5000));
    assert_eq!(leader_state(pid), Some(true));
    // (reaped behind the module's back)
    let mut status = 0;
    assert_eq!(unsafe { libc::waitpid(pid as i32, &mut status, 0) }, pid as i32);
    assert!(a.exited(), "ECHILD reads as gone");
    assert_eq!(a.group, 0, "the group kill is disarmed");
    assert!(a.child.is_none(), "and the pid is let go: no kill() or wait() on it");
    assert_eq!(take_pair_code(&mut a, 7).unwrap_err(), HostError::ChildExited);
    kills_traced();
    drop(a);
    assert_eq!(kills_traced(), Vec::<&str>::new(), "dropping it sends no signal at all");
}

#[test]
fn a_running_leader_is_never_reaped_by_the_status_checks() {
    let t = Tmp::new("running");
    let args = script(&t, r#"IFS= read -r line; echo '{"v":1,"listening":5}'; while read x; do :; done"#);
    let env = env_for(&t);
    let mut a = spawn_owned(&launch(&t, &args, &env, 5000), PairCode::generate().unwrap()).unwrap();
    let pid = a.child.as_ref().unwrap().id();
    assert!(!a.exited());
    assert_eq!(leader_state(pid), Some(false));
    kills_traced();
    stop(a, Duration::from_secs(5));
    assert_eq!(kills_traced(), ["group_held", "child_kill"]);
    assert_eq!(leader_state(pid), None);
}

#[test]
fn error_codes_are_r5s() {
    let all = [HostError::SpawnFailed, HostError::NoPortLine, HostError::BadPortLine, HostError::ChildExited, HostError::PairCodeUsed, HostError::StaleGeneration];
    assert_eq!(all.map(|e| e.code()), ["spawn_failed", "no_port_line", "bad_port_line", "child_exited", "pair_code_used", "stale_generation"]);
    assert_eq!(BundleError::NotBundled.code(), "not_bundled");
    assert_eq!(BundleError::Hash.code(), "bundle_check_failed");
}

// ---- C

fn sha_hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

// A bundle: the Node sidecar (here at <tmp>/binaries/sagebrush-node; in the app beside its executable, shipped_node())
// and resources/agent/{package/bin/sagebrush-agent.mjs, package/lib/x.mjs,
// node_modules/dep/index.js}, its manifest, and the manifest's sha256.
fn bundle(t: &Tmp, codex: bool) -> String {
    let r = &t.0;
    let files: [(&str, &[u8], &str); 3] = [("package/bin/sagebrush-agent.mjs", b"#!/usr/bin/env node\n", "0755"), ("package/lib/x.mjs", b"export {}\n", "0644"), ("node_modules/dep/index.js", b"module.exports = 1\n", "0644")];
    for (p, body, mode) in files {
        let f = r.join("agent").join(p);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, body).unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(if mode == "0755" { 0o755 } else { 0o644 })).unwrap();
    }
    fs::create_dir_all(r.join("binaries")).unwrap();
    fs::write(r.join("binaries/sagebrush-node"), b"node binary").unwrap();
    fs::set_permissions(r.join("binaries/sagebrush-node"), fs::Permissions::from_mode(0o755)).unwrap();
    let list: Vec<serde_json::Value> = files.iter().map(|(p, b, m)| serde_json::json!({"path": p, "sha256": sha_hex(b), "size": b.len(), "mode": m})).collect();
    let mut m = serde_json::json!({"v": 1, "agent": {"version": "0.8.9", "release_sha256": sha_hex(b"tgz")}, "claude_code": {"version": "2.1.314"},
        "node": {"version": "24.21.0", "sha256": sha_hex(b"node binary"), "size": 11}, "files": list});
    if codex {
        m["codex"] = serde_json::json!({"version": "0.171.0", "triple": "x86_64-unknown-linux-gnu"});
    }
    write_manifest(t, &m)
}

/// The Node binary the start would exec, passed to verify_bundle.
fn node(t: &Tmp) -> std::path::PathBuf {
    t.0.join("binaries/sagebrush-node")
}

fn write_manifest(t: &Tmp, m: &serde_json::Value) -> String {
    let bytes = serde_json::to_vec(m).unwrap();
    fs::write(t.0.join("agent/MANIFEST.json"), &bytes).unwrap();
    sha_hex(&bytes)
}

#[test]
fn a_bundle_as_built_passes_and_names_its_versions() {
    let t = Tmp::new("b-ok");
    let sha = bundle(&t, false);
    let v = verify_bundle(&t.0, &node(&t), &sha, NodeCheck::Bytes).unwrap();
    assert_eq!(v, Versions { agent: "0.8.9".into(), claude_code: Some("2.1.314".into()), codex: None, node: "24.21.0".into() });
    let t = Tmp::new("b-codex");
    let sha = bundle(&t, true);
    assert_eq!(verify_bundle(&t.0, &node(&t), &sha, NodeCheck::Bytes).unwrap().codex.as_deref(), Some("0.171.0"));
}

#[test]
fn the_node_checked_is_the_one_given_wherever_it_is_and_the_shipped_one_is_beside_the_executable() {
    // (outside resources, as in the app: Contents/MacOS beside Contents/Resources)
    let t = Tmp::new("b-node-out");
    let sha = bundle(&t, false);
    let other = Tmp::new("b-node-exe");
    let moved = other.0.join("sagebrush-node");
    fs::rename(node(&t), &moved).unwrap();
    assert!(verify_bundle(&t.0, &moved, &sha, NodeCheck::Bytes).is_ok());
    assert_eq!(verify_bundle(&t.0, &node(&t), &sha, NodeCheck::Bytes).unwrap_err(), BundleError::Missing, "only the node given is checked");
    // (another binary given, of another size: refused)
    fs::write(other.0.join("node2"), b"node").unwrap();
    fs::set_permissions(other.0.join("node2"), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(verify_bundle(&t.0, &other.0.join("node2"), &sha, NodeCheck::Bytes).unwrap_err(), BundleError::Size);
    assert_eq!(shipped_node().unwrap(), std::env::current_exe().unwrap().parent().unwrap().join("sagebrush-node"));
}

#[test]
fn no_agent_in_this_build_or_another_manifest_is_refused() {
    let t = Tmp::new("b-none");
    let sha = bundle(&t, false);
    assert_eq!(verify_bundle(&t.0, &node(&t), "", NodeCheck::Bytes).unwrap_err(), BundleError::NotBundled);
    assert_eq!(verify_bundle(&t.0, &node(&t), &sha.to_uppercase(), NodeCheck::Bytes).unwrap_err(), BundleError::ManifestHash, "the compiled-in hash is lowercase hex");
    let mut other = sha.clone().into_bytes();
    other[0] = if other[0] == b'0' { b'1' } else { b'0' };
    assert_eq!(verify_bundle(&t.0, &node(&t), std::str::from_utf8(&other).unwrap(), NodeCheck::Bytes).unwrap_err(), BundleError::ManifestHash);
    // (a manifest edited to match changed files has another hash)
    let mut m: serde_json::Value = serde_json::from_slice(&fs::read(t.0.join("agent/MANIFEST.json")).unwrap()).unwrap();
    m["agent"]["version"] = "9.9.9".into();
    write_manifest(&t, &m);
    assert_eq!(verify_bundle(&t.0, &node(&t), &sha, NodeCheck::Bytes).unwrap_err(), BundleError::ManifestHash);
}

#[test]
fn every_change_to_the_tree_is_refused() {
    type Mutate = fn(&Path);
    let cases: [(&str, Mutate, BundleError); 14] = [
        ("a listed file's content, same size", |r| fs::write(r.join("agent/package/lib/x.mjs"), b"export {}\t").unwrap(), BundleError::Hash),
        ("a listed file's size", |r| fs::write(r.join("agent/package/lib/x.mjs"), b"export {};\n").unwrap(), BundleError::Size),
        ("a file not listed (a planted module)", |r| fs::write(r.join("agent/node_modules/dep/evil.js"), b"x").unwrap(), BundleError::Extra),
        ("a planted folder with a file", |r| { fs::create_dir_all(r.join("agent/node_modules/evil")).unwrap(); fs::write(r.join("agent/node_modules/evil/index.js"), b"x").unwrap() }, BundleError::Extra),
        ("a listed file missing", |r| fs::remove_file(r.join("agent/node_modules/dep/index.js")).unwrap(), BundleError::Missing),
        ("a listed file made a link", |r| { fs::remove_file(r.join("agent/package/lib/x.mjs")).unwrap(); std::os::unix::fs::symlink("/etc/hostname", r.join("agent/package/lib/x.mjs")).unwrap() }, BundleError::Link),
        ("a link to a folder", |r| std::os::unix::fs::symlink("/tmp", r.join("agent/node_modules/tmp")).unwrap(), BundleError::Link),
        ("the executable bit added", |r| fs::set_permissions(r.join("agent/package/lib/x.mjs"), fs::Permissions::from_mode(0o755)).unwrap(), BundleError::Mode),
        ("writable by others", |r| fs::set_permissions(r.join("agent/package/lib/x.mjs"), fs::Permissions::from_mode(0o666)).unwrap(), BundleError::Mode),
        ("the Node sidecar changed", |r| fs::write(r.join("binaries/sagebrush-node"), b"node binarY").unwrap(), BundleError::Hash),
        ("the Node sidecar a link", |r| { fs::remove_file(r.join("binaries/sagebrush-node")).unwrap(); std::os::unix::fs::symlink("/bin/sh", r.join("binaries/sagebrush-node")).unwrap() }, BundleError::Link),
        ("the Node sidecar missing", |r| fs::remove_file(r.join("binaries/sagebrush-node")).unwrap(), BundleError::Missing),
        ("the Node sidecar not executable", |r| fs::set_permissions(r.join("binaries/sagebrush-node"), fs::Permissions::from_mode(0o644)).unwrap(), BundleError::Mode),
        ("the Node sidecar a folder", |r| { fs::remove_file(r.join("binaries/sagebrush-node")).unwrap(); fs::create_dir(r.join("binaries/sagebrush-node")).unwrap() }, BundleError::NotAFile),
    ];
    for (what, mutate, want) in cases {
        let t = Tmp::new("b-mut");
        let sha = bundle(&t, false);
        assert!(verify_bundle(&t.0, &node(&t), &sha, NodeCheck::Bytes).is_ok());
        mutate(&t.0);
        assert_eq!(verify_bundle(&t.0, &node(&t), &sha, NodeCheck::Bytes).unwrap_err(), want, "{what}");
    }
}

#[test]
fn claude_code_absent_is_a_bundle_without_it_and_present_in_another_form_is_refused() {
    // (a build without the Claude Code CLI: the manifest has no claude_code block)
    let t = Tmp::new("b-noclaude");
    bundle(&t, false);
    let mut m: serde_json::Value = serde_json::from_slice(&fs::read(t.0.join("agent/MANIFEST.json")).unwrap()).unwrap();
    m.as_object_mut().unwrap().remove("claude_code");
    let sha = write_manifest(&t, &m);
    let v = verify_bundle(&t.0, &node(&t), &sha, NodeCheck::Bytes).unwrap();
    assert_eq!(v, Versions { agent: "0.8.9".into(), claude_code: None, codex: None, node: "24.21.0".into() });
    // (stray Claude Code bytes in a bundle without them are a file not listed)
    let f = t.0.join("agent/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude");
    fs::create_dir_all(f.parent().unwrap()).unwrap();
    fs::write(&f, b"claude").unwrap();
    fs::set_permissions(&f, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(verify_bundle(&t.0, &node(&t), &sha, NodeCheck::Bytes).unwrap_err(), BundleError::Extra);
    for (what, v) in [
        ("null", serde_json::json!(null)),
        ("a string", serde_json::json!("2.1.314")),
        ("no version", serde_json::json!({})),
        ("an empty version", serde_json::json!({"version": ""})),
        ("a version not a string", serde_json::json!({"version": 2})),
        ("a 65-character version", serde_json::json!({"version": "9".repeat(65)})),
    ] {
        let t = Tmp::new("b-claude-form");
        bundle(&t, false);
        let mut m: serde_json::Value = serde_json::from_slice(&fs::read(t.0.join("agent/MANIFEST.json")).unwrap()).unwrap();
        m["claude_code"] = v;
        let sha = write_manifest(&t, &m);
        assert_eq!(verify_bundle(&t.0, &node(&t), &sha, NodeCheck::Bytes).unwrap_err(), BundleError::ManifestForm, "claude_code {what}");
    }
    // (64 characters is the bound, still accepted)
    let t = Tmp::new("b-claude-64");
    bundle(&t, false);
    let mut m: serde_json::Value = serde_json::from_slice(&fs::read(t.0.join("agent/MANIFEST.json")).unwrap()).unwrap();
    m["claude_code"] = serde_json::json!({"version": "9".repeat(64)});
    let sha = write_manifest(&t, &m);
    assert_eq!(verify_bundle(&t.0, &node(&t), &sha, NodeCheck::Bytes).unwrap().claude_code.as_deref(), Some("9".repeat(64).as_str()));
}

#[test]
fn a_manifest_with_bad_paths_or_form_is_refused() {
    for (what, edit, want) in [
        ("..", serde_json::json!("../binaries/sagebrush-node"), BundleError::BadPath),
        ("absolute", serde_json::json!("/etc/passwd"), BundleError::BadPath),
        ("empty component", serde_json::json!("package//x.mjs"), BundleError::BadPath),
        ("dot component", serde_json::json!("package/./x.mjs"), BundleError::BadPath),
        ("backslash", serde_json::json!("package\\x.mjs"), BundleError::BadPath),
        ("the manifest itself", serde_json::json!("MANIFEST.json"), BundleError::BadPath),
        ("not a string", serde_json::json!(7), BundleError::ManifestForm),
    ] {
        let t = Tmp::new("b-path");
        bundle(&t, false);
        let mut m: serde_json::Value = serde_json::from_slice(&fs::read(t.0.join("agent/MANIFEST.json")).unwrap()).unwrap();
        m["files"][1]["path"] = edit;
        let sha = write_manifest(&t, &m);
        assert_eq!(verify_bundle(&t.0, &node(&t), &sha, NodeCheck::Bytes).unwrap_err(), want, "{what}");
    }
    for (what, f) in [
        ("listed twice", (|m: &mut serde_json::Value| { let x = m["files"][0].clone(); m["files"].as_array_mut().unwrap().push(x) }) as fn(&mut serde_json::Value)),
        ("mode 0700", |m| m["files"][0]["mode"] = "0700".into()),
        ("v 2", |m| m["v"] = 2.into()),
        ("a bad release hash", |m| m["agent"]["release_sha256"] = "xyz".into()),
        ("a leftover node path", |m| m["node"]["path"] = "binaries/sagebrush-node".into()),
        ("another key in node", |m| m["node"]["triple"] = "x".into()),
        ("no node size", |m| { m["node"].as_object_mut().unwrap().remove("size"); }),
    ] {
        let t = Tmp::new("b-form");
        bundle(&t, false);
        let mut m: serde_json::Value = serde_json::from_slice(&fs::read(t.0.join("agent/MANIFEST.json")).unwrap()).unwrap();
        f(&mut m);
        let sha = write_manifest(&t, &m);
        assert!(verify_bundle(&t.0, &node(&t), &sha, NodeCheck::Bytes).is_err(), "{what}");
    }
}

#[test]
fn the_agent_folder_itself_a_link_is_refused() {
    let t = Tmp::new("b-dirlink");
    let sha = bundle(&t, false);
    let real = t.0.join("agent-real");
    fs::rename(t.0.join("agent"), &real).unwrap();
    std::os::unix::fs::symlink(&real, t.0.join("agent")).unwrap();
    assert_eq!(verify_bundle(&t.0, &node(&t), &sha, NodeCheck::Bytes).unwrap_err(), BundleError::Link);
}

#[test]
fn a_team_requirement_only_for_a_team_id_in_its_form() {
    let r = team_requirement("ABCDE12345").unwrap();
    assert!(r.starts_with("anchor apple generic and ") && r.ends_with("certificate leaf[subject.OU] = \"ABCDE12345\""), "{r}");
    assert!(r.contains("certificate leaf[field.1.2.840.113635.100.6.1.13] exists"), "a Developer ID Application leaf");
    for bad in ["", "ABCDE1234", "ABCDE123456", "abcde12345", "ABCDE 1234", "ABCD\"12345", "ABCDE1234\n", "ÄBCDE12345"] {
        assert!(team_requirement(bad).is_none(), "{bad:?}");
    }
}

#[cfg(not(target_os = "macos"))]
#[test]
fn a_signed_build_check_off_macos_refuses() {
    let t = Tmp::new("b-sig-off");
    let sha = bundle(&t, false);
    assert_eq!(verify_bundle(&t.0, &node(&t), &sha, NodeCheck::TeamSignature("ABCDE12345")).unwrap_err(), BundleError::NodeSignature);
    assert_eq!(node_check(), NodeCheck::Bytes);
}

// A standalone Developer ID-signed executable to stand in for the signed Node: Chrome's crash handler (Chrome is on
// the macOS CI runners and on the test Mac), copied, with its Team ID as codesign reports it.
#[cfg(target_os = "macos")]
fn signed_helper(t: &Tmp) -> (std::path::PathBuf, String) {
    let src = Path::new("/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/Current/Helpers/chrome_crashpad_handler");
    assert!(src.is_file(), "the signed stand-in {} isn't here", src.display());
    let dst = t.0.join("signed-node");
    fs::copy(src, &dst).unwrap();
    fs::set_permissions(&dst, fs::Permissions::from_mode(0o755)).unwrap();
    let out = std::process::Command::new("codesign").args(["-dv"]).arg(&dst).output().unwrap();
    let text = String::from_utf8_lossy(&out.stderr).to_string();
    let team = text.lines().find_map(|l| l.strip_prefix("TeamIdentifier=")).expect("a Team ID").trim().to_string();
    (dst, team)
}

/// Runs `args` on `file`, failing the test with the tool's own output when it doesn't succeed.
#[cfg(target_os = "macos")]
fn tool(args: &[&str], file: &Path) {
    let out = std::process::Command::new(args[0]).args(&args[1..]).arg(file).output().unwrap();
    assert!(out.status.success(), "{args:?} {}: {}{}", file.display(), String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
}

/// A small program of the test's own, compiled here (Xcode's cc), executable.
#[cfg(target_os = "macos")]
fn own_program(t: &Tmp, name: &str) -> std::path::PathBuf {
    use std::io::Write as _;
    let out = t.0.join(name);
    let mut cc = std::process::Command::new("cc").args(["-x", "c", "-o"]).arg(&out).arg("-").stdin(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
    cc.stdin.take().unwrap().write_all(b"int main(void) { return 0; }\n").unwrap();
    let r = cc.wait_with_output().unwrap();
    assert!(r.status.success(), "cc: {}", String::from_utf8_lossy(&r.stderr));
    fs::set_permissions(&out, fs::Permissions::from_mode(0o755)).unwrap();
    out
}

#[cfg(target_os = "macos")]
fn bundle_signed(t: &Tmp) -> (String, std::path::PathBuf, String) {
    let sha = bundle(t, false);
    let (node, team) = signed_helper(t);
    (sha, node, team)
}

#[cfg(target_os = "macos")]
#[test]
fn a_signed_node_of_the_apps_team_passes_and_another_team_or_signature_is_refused() {
    let t = Tmp::new("b-sig");
    let (sha, n, team) = bundle_signed(&t);
    // (the bytes differ from the manifest's: only the signature counts in a signed build)
    assert_eq!(verify_bundle(&t.0, &n, &sha, NodeCheck::Bytes).unwrap_err(), BundleError::Size);
    assert!(verify_bundle(&t.0, &n, &sha, NodeCheck::TeamSignature(&team)).is_ok());
    let other = if team == "ABCDE12345" { "ZYXWV98765" } else { "ABCDE12345" };
    assert_eq!(verify_bundle(&t.0, &n, &sha, NodeCheck::TeamSignature(other)).unwrap_err(), BundleError::NodeSignature, "another team");
    assert_eq!(verify_bundle(&t.0, &n, &sha, NodeCheck::TeamSignature(&team.to_lowercase())).unwrap_err(), BundleError::NodeSignature, "a Team ID not in its form");
    // (Apple's own platform binary: Apple's anchor, but no Developer ID leaf of this team)
    let ls = t.0.join("apple-ls");
    fs::copy("/bin/ls", &ls).unwrap();
    assert_eq!(verify_bundle(&t.0, &ls, &sha, NodeCheck::TeamSignature(&team)).unwrap_err(), BundleError::NodeSignature, "an Apple platform binary");
    // (signed ad hoc, and unsigned: a program of the test's own, so no other vendor's signature is rewritten)
    let adhoc = own_program(&t, "adhoc-node");
    tool(&["codesign", "-f", "-s", "-"], &adhoc);
    assert_eq!(verify_bundle(&t.0, &adhoc, &sha, NodeCheck::TeamSignature(&team)).unwrap_err(), BundleError::NodeSignature, "ad hoc");
    let unsigned = own_program(&t, "unsigned-node");
    tool(&["codesign", "--remove-signature"], &unsigned);
    assert_eq!(verify_bundle(&t.0, &unsigned, &sha, NodeCheck::TeamSignature(&team)).unwrap_err(), BundleError::NodeSignature, "unsigned");
    // (one byte changed, early in the file and near its middle: each architecture's code is checked)
    let len = fs::metadata(&n).unwrap().len();
    for at in [20_000u64, len / 2] {
        let bad = t.0.join(format!("bad-node-{at}"));
        fs::copy(&n, &bad).unwrap();
        let mut b = fs::read(&bad).unwrap();
        b[at as usize] ^= 0x01;
        fs::write(&bad, &b).unwrap();
        fs::set_permissions(&bad, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(verify_bundle(&t.0, &bad, &sha, NodeCheck::TeamSignature(&team)).unwrap_err(), BundleError::NodeSignature, "a byte changed at {at}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn a_signed_node_must_still_be_a_plain_executable_file() {
    let t = Tmp::new("b-sig-shape");
    let (sha, n, team) = bundle_signed(&t);
    let link = t.0.join("node-link");
    std::os::unix::fs::symlink(&n, &link).unwrap();
    assert_eq!(verify_bundle(&t.0, &link, &sha, NodeCheck::TeamSignature(&team)).unwrap_err(), BundleError::Link);
    assert_eq!(verify_bundle(&t.0, &t.0.join("no-node"), &sha, NodeCheck::TeamSignature(&team)).unwrap_err(), BundleError::Missing);
    fs::set_permissions(&n, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(verify_bundle(&t.0, &n, &sha, NodeCheck::TeamSignature(&team)).unwrap_err(), BundleError::Mode, "not executable");
    fs::set_permissions(&n, fs::Permissions::from_mode(0o757)).unwrap();
    assert_eq!(verify_bundle(&t.0, &n, &sha, NodeCheck::TeamSignature(&team)).unwrap_err(), BundleError::Mode, "writable by others");
    fs::set_permissions(&n, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(verify_bundle(&t.0, &n, &sha, NodeCheck::TeamSignature(&team)).is_ok());
    // (the agent's own files are still checked exactly in a signed build)
    fs::write(t.0.join("agent/node_modules/dep/evil.js"), b"x").unwrap();
    assert_eq!(verify_bundle(&t.0, &n, &sha, NodeCheck::TeamSignature(&team)).unwrap_err(), BundleError::Extra);
}

// The bundle app/engine/bundle.mjs built beside this crate (CI runs it before these tests): the real tree, the
// manifest sha256 build.rs compiled in, and the Node it put in binaries/, as an unsigned build checks them.
#[test]
fn the_bundle_bundle_mjs_built_passes() {
    let sha = env!("SAGEBRUSH_AGENT_MANIFEST_SHA256");
    if sha.is_empty() {
        assert!(std::env::var_os("CI").is_none(), "CI bundles the agent (app/engine/bundle.mjs) before the app's tests");
        return;
    }
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let nodes: Vec<_> = fs::read_dir(dir.join("binaries")).unwrap().map(|e| e.unwrap().path()).filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("sagebrush-node-")).collect();
    assert_eq!(nodes.len(), 1, "one Node in binaries/: {nodes:?}");
    let v = verify_bundle(dir, &nodes[0], sha, NodeCheck::Bytes).unwrap();
    assert_eq!(v.claude_code, None, "no Claude Code in this build");
    assert_eq!(v.node, "24.21.0");
    // (and one byte of a real module changed is refused)
    let f = dir.join("agent/package/lib/fleet/bytes.mjs");
    let f = if f.exists() { f } else { dir.join("agent/package/bin/sagebrush-agent.mjs") };
    let orig = fs::read(&f).unwrap();
    let mut b = orig.clone();
    b[0] ^= 0x01;
    fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap();
    fs::write(&f, &b).unwrap();
    let r = verify_bundle(dir, &nodes[0], sha, NodeCheck::Bytes);
    fs::write(&f, &orig).unwrap();
    assert_eq!(r.unwrap_err(), BundleError::Hash);
    assert!(verify_bundle(dir, &nodes[0], sha, NodeCheck::Bytes).is_ok(), "restored");
}
