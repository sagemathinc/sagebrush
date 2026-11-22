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

// A bundle: resources/binaries/sagebrush-node and resources/agent/{package/bin/sagebrush-agent.mjs, package/lib/x.mjs,
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
        "node": {"version": "24.21.0", "path": "binaries/sagebrush-node", "sha256": sha_hex(b"node binary"), "size": 11}, "files": list});
    if codex {
        m["codex"] = serde_json::json!({"version": "0.171.0", "triple": "x86_64-unknown-linux-gnu"});
    }
    write_manifest(t, &m)
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
    let v = verify_bundle(&t.0, &sha).unwrap();
    assert_eq!(v, Versions { agent: "0.8.9".into(), claude_code: "2.1.314".into(), codex: None, node: "24.21.0".into() });
    let t = Tmp::new("b-codex");
    let sha = bundle(&t, true);
    assert_eq!(verify_bundle(&t.0, &sha).unwrap().codex.as_deref(), Some("0.171.0"));
}

#[test]
fn no_agent_in_this_build_or_another_manifest_is_refused() {
    let t = Tmp::new("b-none");
    let sha = bundle(&t, false);
    assert_eq!(verify_bundle(&t.0, "").unwrap_err(), BundleError::NotBundled);
    assert_eq!(verify_bundle(&t.0, &sha.to_uppercase()).unwrap_err(), BundleError::ManifestHash, "the compiled-in hash is lowercase hex");
    let mut other = sha.clone().into_bytes();
    other[0] = if other[0] == b'0' { b'1' } else { b'0' };
    assert_eq!(verify_bundle(&t.0, std::str::from_utf8(&other).unwrap()).unwrap_err(), BundleError::ManifestHash);
    // (a manifest edited to match changed files has another hash)
    let mut m: serde_json::Value = serde_json::from_slice(&fs::read(t.0.join("agent/MANIFEST.json")).unwrap()).unwrap();
    m["agent"]["version"] = "9.9.9".into();
    write_manifest(&t, &m);
    assert_eq!(verify_bundle(&t.0, &sha).unwrap_err(), BundleError::ManifestHash);
}

#[test]
fn every_change_to_the_tree_is_refused() {
    type Mutate = fn(&Path);
    let cases: [(&str, Mutate, BundleError); 11] = [
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
    ];
    for (what, mutate, want) in cases {
        let t = Tmp::new("b-mut");
        let sha = bundle(&t, false);
        assert!(verify_bundle(&t.0, &sha).is_ok());
        mutate(&t.0);
        assert_eq!(verify_bundle(&t.0, &sha).unwrap_err(), want, "{what}");
    }
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
        assert_eq!(verify_bundle(&t.0, &sha).unwrap_err(), want, "{what}");
    }
    for (what, f) in [
        ("listed twice", (|m: &mut serde_json::Value| { let x = m["files"][0].clone(); m["files"].as_array_mut().unwrap().push(x) }) as fn(&mut serde_json::Value)),
        ("mode 0700", |m| m["files"][0]["mode"] = "0700".into()),
        ("v 2", |m| m["v"] = 2.into()),
        ("no claude_code", |m| { m.as_object_mut().unwrap().remove("claude_code"); }),
        ("a bad release hash", |m| m["agent"]["release_sha256"] = "xyz".into()),
        ("the node path escaping", |m| m["node"]["path"] = "../sagebrush-node".into()),
    ] {
        let t = Tmp::new("b-form");
        bundle(&t, false);
        let mut m: serde_json::Value = serde_json::from_slice(&fs::read(t.0.join("agent/MANIFEST.json")).unwrap()).unwrap();
        f(&mut m);
        let sha = write_manifest(&t, &m);
        assert!(verify_bundle(&t.0, &sha).is_err(), "{what}");
    }
}

#[test]
fn the_agent_folder_itself_a_link_is_refused() {
    let t = Tmp::new("b-dirlink");
    let sha = bundle(&t, false);
    let real = t.0.join("agent-real");
    fs::rename(t.0.join("agent"), &real).unwrap();
    std::os::unix::fs::symlink(&real, t.0.join("agent")).unwrap();
    assert_eq!(verify_bundle(&t.0, &sha).unwrap_err(), BundleError::Link);
}
