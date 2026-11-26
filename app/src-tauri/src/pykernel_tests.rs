// Native (Python) on real interpreters: the machine's own CPython (3.10 or newer, found among the usual places), venvs
// made from it, shell scripts standing for interpreters, and a stub sagebrush_kernel that answers commands.

use super::*;
use crate::tools::my_uid;
use std::fs;
use std::os::unix::fs::PermissionsExt;

struct Tmp(PathBuf);
impl Tmp {
    fn new(name: &str) -> Tmp {
        use std::sync::atomic::AtomicU64;
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("sb-pyk-{name}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir(&d).unwrap();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o700)).unwrap();
        Tmp(fs::canonicalize(d).unwrap())
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run(t: &Tmp) -> VersionRun<'_> {
    VersionRun { home: &t.0, cwd: &t.0, supported: &[] }
}

/// The machine's own CPython for the tests: the first of the usual places that chooses (SB_TEST_PYTHON first).
fn system_python() -> ChosenPython {
    let t = Tmp::new("find");
    let mut tried = Vec::new();
    let mut candidates: Vec<String> = std::env::var("SB_TEST_PYTHON").into_iter().collect();
    candidates.extend(["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].map(String::from));
    for c in candidates {
        match choose_python(Path::new(&c), my_uid(), &run(&t)) {
            Ok(p) => return p,
            Err(e) => tried.push(format!("{c}: {}", e.code())),
        }
    }
    panic!("the tests need a CPython >= 3.10 that passes the rules; tried {tried:?}");
}

fn script(dir: &Path, name: &str, body: &str, mode: u32) -> PathBuf {
    let p = dir.join(name);
    fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(mode)).unwrap();
    p
}

/// The stub kernel: a ready line describing itself, then one command per input line.
const STUB: &str = r#"
import sys, os, json, signal, subprocess, time
def say(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
try:
    import sbpp_probe
    pp = True
except ImportError:
    pp = False
say({"ready": True, "prefix": sys.prefix, "cwd": os.getcwd(), "path": sys.path, "env": sorted(os.environ),
     "sitecustomize": getattr(sys.modules.get("sitecustomize"), "__file__", None), "pp": pp})
for line in sys.stdin:
    c = json.loads(line)
    k = c["cmd"]
    if k == "echo":
        say({"echo": c["v"]})
    elif k == "sleep":
        try:
            time.sleep(30)
        except KeyboardInterrupt:
            say({"interrupted": True})
    elif k == "line":
        sys.stdout.write("x" * c["n"] + "\n"); sys.stdout.flush()
    elif k == "big":
        sys.stdout.write("x" * c["n"]); sys.stdout.flush(); time.sleep(30)
    elif k == "exit":
        sys.exit(c["code"])
    elif k == "hang":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        p = subprocess.Popen(["sleep", "60"])
        say({"child": p.pid})
        time.sleep(60)
    elif k == "escape":
        subprocess.Popen([sys.executable, "-c", c["code"], c["probe"]], start_new_session=True)
        say({"escaped": True})
        sys.exit(0)
"#;

/// A resource folder holding the stub as sagebrush_kernel.
fn stub(t: &Tmp) -> PathBuf {
    let res = t.0.join("res");
    fs::create_dir_all(res.join("sagebrush_kernel")).unwrap();
    fs::write(res.join("sagebrush_kernel/__init__.py"), "").unwrap();
    fs::write(res.join("sagebrush_kernel/__main__.py"), STUB).unwrap();
    res
}

fn workspace(t: &Tmp) -> PathBuf {
    let w = t.0.join("ws");
    fs::create_dir_all(&w).unwrap();
    w
}

fn path_env() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    vec![("PATH".into(), std::env::var_os("PATH").unwrap_or_default())]
}

/// The next line, as JSON, within 10 s.
fn line(k: &Kernel) -> serde_json::Value {
    match k.recv(Duration::from_secs(10)) {
        Some(KernelEvent::Line(l)) => serde_json::from_str(&l).unwrap(),
        other => panic!("expected a line, got {other:?}; stderr: {}", String::from_utf8_lossy(&k.stderr_tail())),
    }
}

fn exit_of(k: &Kernel, wait: Duration) -> String {
    let t = Instant::now();
    while t.elapsed() < wait {
        match k.recv(Duration::from_millis(100)) {
            Some(KernelEvent::Exit(w)) => return w,
            Some(KernelEvent::Line(_)) | None => {}
        }
    }
    panic!("no exit within {wait:?}");
}

#[test]
fn the_machines_python_is_chosen_and_rechecked() {
    let p = system_python();
    assert!((p.version.0, p.version.1) >= MIN_PYTHON, "{:?}", p.version);
    assert!(p.exec_path.is_absolute());
    assert!(recheck_python(&p, my_uid()).is_ok());
}

#[test]
fn the_probe_answer_is_exact() {
    assert_eq!(parse_python_version(b"3.12.4 CPython\n"), Some((3, 12, 4)));
    assert_eq!(parse_python_version(b"3.10.0 CPython\n"), Some((3, 10, 0)));
    for bad in [&b"3.12.4 PyPy\n"[..], b"3.12.4 CPython", b"3.12.4 CPython\r\n", b"3.12 CPython\n", b"03.12.4 CPython\n", b"3.12.4  CPython\n", b"3.12.4rc1 CPython\n", b""] {
        assert_eq!(parse_python_version(bad), None, "{:?}", String::from_utf8_lossy(bad));
    }
}

#[test]
fn an_interpreter_too_old_unknown_or_open_to_others_is_refused() {
    let t = Tmp::new("refuse");
    for (body, mode, want) in [
        ("printf '3.9.6 CPython\\n'", 0o755, ToolRefusal::VersionMismatch),
        ("printf '3.12.1 PyPy\\n'", 0o755, ToolRefusal::VersionUnknown),
        ("printf 'Python 3.12.1\\n'", 0o755, ToolRefusal::VersionUnknown),
        ("printf '3.12.1 CPython\\n'; exit 1", 0o755, ToolRefusal::VersionUnknown),
        ("printf '3.12.1 CPython\\n'", 0o775, ToolRefusal::WritableByOthers),
        ("printf '3.12.1 CPython\\n'", 0o644, ToolRefusal::NotExecutable),
    ] {
        let p = script(&t.0, &format!("py{mode:o}-{}", body.len()), body, mode);
        assert_eq!(choose_python(&p, my_uid(), &run(&t)).unwrap_err(), want, "{body} {mode:o}");
    }
    assert_eq!(choose_python(Path::new("python3"), my_uid(), &run(&t)).unwrap_err(), ToolRefusal::NotAbsolute);
    // (a script answering well is chosen: the probe runs it with -I -c and only its answer counts)
    let ok = script(&t.0, "pyok", "printf '3.12.1 CPython\\n'", 0o755);
    assert_eq!(choose_python(&ok, my_uid(), &run(&t)).map(|p| p.version), Ok((3, 12, 1)));
}

#[test]
fn a_link_in_the_chain_owned_by_someone_else_or_in_an_open_folder_is_refused() {
    let t = Tmp::new("chain");
    let real = script(&t.0, "pyreal", "printf '3.12.1 CPython\\n'", 0o755);
    let open = t.0.join("open");
    fs::create_dir(&open).unwrap();
    std::os::unix::fs::symlink(&real, open.join("python")).unwrap();
    fs::set_permissions(&open, fs::Permissions::from_mode(0o777)).unwrap();
    assert_eq!(choose_python(&open.join("python"), my_uid(), &run(&t)).unwrap_err(), ToolRefusal::ParentWritable);
    fs::set_permissions(&open, fs::Permissions::from_mode(0o755)).unwrap();
    let c = choose_python(&open.join("python"), my_uid(), &run(&t)).unwrap();
    assert_eq!(c.exec_path, open.join("python"), "run by the chosen path");
    assert_eq!(c.target, real);
    assert_eq!(c.chain.len(), 1);
    if my_uid() != 0 {
        assert_eq!(choose_python(&open.join("python"), my_uid().wrapping_add(1).max(1), &run(&t)).unwrap_err(), ToolRefusal::WrongOwner);
    }
}

#[test]
fn a_venv_is_run_by_its_own_path_and_keeps_its_prefix() {
    let base = system_python();
    let t = Tmp::new("venv");
    let v = t.0.join("v");
    let st = std::process::Command::new(&base.exec_path).args(["-m", "venv", "--without-pip"]).arg(&v).status().unwrap();
    assert!(st.success());
    let p = choose_python(&v.join("bin/python"), my_uid(), &run(&t)).unwrap();
    assert_eq!(p.exec_path, v.join("bin/python"));
    assert!(!p.chain.is_empty(), "a venv's python is a link");
    assert!(p.venv_cfg[1].is_some(), "its pyvenv.cfg is bound");
    let res = stub(&t);
    let ws = workspace(&t);
    let k = Kernel::start(&KernelSpec { python: &p, resources: &res, cwd: &ws, base_env: Some(path_env()) }, my_uid()).unwrap();
    let r = line(&k);
    assert_eq!(fs::canonicalize(r["prefix"].as_str().unwrap()).unwrap(), v, "the kernel runs in the venv");
}

#[test]
fn a_venv_whose_link_or_config_changed_must_be_chosen_again() {
    let base = system_python();
    let t = Tmp::new("venvchg");
    let v = t.0.join("v");
    assert!(std::process::Command::new(&base.exec_path).args(["-m", "venv", "--without-pip"]).arg(&v).status().unwrap().success());
    let py = v.join("bin/python");
    let p = choose_python(&py, my_uid(), &run(&t)).unwrap();
    // (pyvenv.cfg rewritten)
    let cfg = v.join("pyvenv.cfg");
    let old = fs::read_to_string(&cfg).unwrap();
    fs::write(&cfg, format!("{old}include-system-site-packages = true\n")).unwrap();
    assert_eq!(recheck_python(&p, my_uid()).unwrap_err(), ToolRefusal::IdentityChanged, "pyvenv.cfg changed");
    let p = choose_python(&py, my_uid(), &run(&t)).unwrap();
    // (the link re-pointed, to a script that would answer the same)
    let other = script(&t.0, "other", "printf '3.12.1 CPython\\n'", 0o755);
    fs::remove_file(&py).unwrap();
    std::os::unix::fs::symlink(&other, &py).unwrap();
    assert_eq!(recheck_python(&p, my_uid()).unwrap_err(), ToolRefusal::IdentityChanged, "the link re-pointed");
    let res = stub(&t);
    let ws = workspace(&t);
    assert_eq!(Kernel::start(&KernelSpec { python: &p, resources: &res, cwd: &ws, base_env: Some(path_env()) }, my_uid()).err(), Some(KernelError::Refused(ToolRefusal::IdentityChanged)), "and start refuses");
}

#[test]
fn the_kernel_starts_outside_the_workspace_and_a_planted_sitecustomize_is_never_imported() {
    let p = system_python();
    let t = Tmp::new("site");
    let res = stub(&t);
    let ws = workspace(&t);
    let mark = t.0.join("site-ran");
    // (a sitecustomize.py, and a json.py that would break the stub, planted in the workspace; and the person's
    //  PYTHONPATH with an empty part, which means the working folder while Python's site setup runs, before any code
    //  of ours: so the interpreter must not start in the workspace)
    fs::write(ws.join("sitecustomize.py"), format!("open({:?}, 'w').write('x')\n", mark.display().to_string())).unwrap();
    fs::write(ws.join("json.py"), "raise SystemExit('planted json.py imported')\n").unwrap();
    let pp = t.0.join("pp");
    fs::create_dir(&pp).unwrap();
    let mut env = path_env();
    env.push(("PYTHONPATH".into(), format!("{}:", pp.display()).into()));
    let k = Kernel::start(&KernelSpec { python: &p, resources: &res, cwd: &ws, base_env: Some(env) }, my_uid()).unwrap();
    let r = line(&k);
    assert!(!mark.exists(), "the workspace's sitecustomize.py was not imported");
    assert!(r["sitecustomize"].as_str().map_or(true, |f| !f.starts_with(ws.to_str().unwrap())), "{r}");
    assert_eq!(fs::canonicalize(r["cwd"].as_str().unwrap()).unwrap(), ws, "then it changed to the workspace");
    let path: Vec<&str> = r["path"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(path[0], res.to_str().unwrap(), "the resource folder first");
    assert!(!path.iter().any(|e| e.is_empty() || *e == "." || *e == "/" || Path::new(e) == ws), "no working folder on sys.path: {path:?}");
}

#[test]
fn the_kernel_gets_the_persons_environment_less_the_control_plane() {
    let p = system_python();
    let t = Tmp::new("env");
    let res = stub(&t);
    let ws = workspace(&t);
    let pp = t.0.join("pp");
    fs::create_dir(&pp).unwrap();
    fs::write(pp.join("sbpp_probe.py"), "").unwrap();
    let mut env = path_env();
    for (k, v) in [("SAGEBRUSH_TOKEN", "secret"), ("COCALC_API_KEY", "secret"), ("TAURI_PRIVATE", "x"), ("HF_HOME", "/tmp/hf"), ("CUDA_VISIBLE_DEVICES", "0")] {
        env.push((k.into(), v.into()));
    }
    env.push(("PYTHONPATH".into(), pp.clone().into_os_string()));
    let k = Kernel::start(&KernelSpec { python: &p, resources: &res, cwd: &ws, base_env: Some(env) }, my_uid()).unwrap();
    let r = line(&k);
    let names: Vec<&str> = r["env"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    for gone in ["SAGEBRUSH_TOKEN", "COCALC_API_KEY", "TAURI_PRIVATE"] {
        assert!(!names.contains(&gone), "{gone} stripped: {names:?}");
    }
    for kept in ["HF_HOME", "CUDA_VISIBLE_DEVICES", "PYTHONPATH", "MPLBACKEND"] {
        assert!(names.contains(&kept), "{kept} kept: {names:?}");
    }
    assert_eq!(r["pp"], true, "PYTHONPATH is honoured (no -I for the kernel)");
}

#[test]
fn lines_go_both_ways_and_an_interrupt_reaches_the_running_code() {
    let p = system_python();
    let t = Tmp::new("io");
    let (res, ws) = (stub(&t), workspace(&t));
    let mut k = Kernel::start(&KernelSpec { python: &p, resources: &res, cwd: &ws, base_env: Some(path_env()) }, my_uid()).unwrap();
    line(&k);
    k.send(r#"{"cmd":"echo","v":"héllo"}"#).unwrap();
    assert_eq!(line(&k)["echo"], "héllo");
    assert_eq!(k.send("a\nb"), Err(KernelError::InputRefused));
    k.send(r#"{"cmd":"sleep"}"#).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    k.interrupt();
    assert_eq!(line(&k)["interrupted"], true);
    k.send(r#"{"cmd":"exit","code":3}"#).unwrap();
    assert_eq!(exit_of(&k, Duration::from_secs(10)), "exit 3");
    assert_eq!(k.send(r#"{"cmd":"echo","v":1}"#), Err(KernelError::Ended));
    k.stop();
}

#[test]
fn a_line_at_the_cap_is_read_and_one_byte_more_ends_the_kernel() {
    let p = system_python();
    let t = Tmp::new("atcap");
    let (res, ws) = (stub(&t), workspace(&t));
    let k = Kernel::start(&KernelSpec { python: &p, resources: &res, cwd: &ws, base_env: Some(path_env()) }, my_uid()).unwrap();
    line(&k);
    k.send(&format!(r#"{{"cmd":"line","n":{LINE_MAX}}}"#)).unwrap();
    match k.recv(Duration::from_secs(10)) {
        Some(KernelEvent::Line(l)) => assert_eq!(l.len(), LINE_MAX),
        other => panic!("{other:?}"),
    }
    // (one byte more, newline and all: refused once the newline shows how long the line was)
    k.send(&format!(r#"{{"cmd":"line","n":{}}}"#, LINE_MAX + 1)).unwrap();
    assert_eq!(exit_of(&k, Duration::from_secs(10)), "line over the cap");
}

#[test]
fn a_line_past_the_cap_ends_the_kernel() {
    let p = system_python();
    let t = Tmp::new("cap");
    let (res, ws) = (stub(&t), workspace(&t));
    let k = Kernel::start(&KernelSpec { python: &p, resources: &res, cwd: &ws, base_env: Some(path_env()) }, my_uid()).unwrap();
    line(&k);
    k.send(&format!(r#"{{"cmd":"big","n":{}}}"#, LINE_MAX + 1)).unwrap();
    assert_eq!(exit_of(&k, Duration::from_secs(10)), "line over the cap");
}

#[test]
fn stop_ends_a_kernel_that_ignores_sigterm_with_its_whole_group() {
    let p = system_python();
    let t = Tmp::new("hang");
    let (res, ws) = (stub(&t), workspace(&t));
    let mut k = Kernel::start(&KernelSpec { python: &p, resources: &res, cwd: &ws, base_env: Some(path_env()) }, my_uid()).unwrap();
    line(&k);
    k.send(r#"{"cmd":"hang"}"#).unwrap();
    let child = line(&k)["child"].as_i64().unwrap() as libc::pid_t;
    let started = Instant::now();
    // (stop on another thread, so a stop that never returns fails here instead of hanging the run)
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        k.stop();
        let _ = tx.send(k);
    });
    let k = rx.recv_timeout(TERM_GRACE + Duration::from_secs(3)).expect("stop returned");
    let took = started.elapsed();
    assert!(took >= TERM_GRACE && took < TERM_GRACE + Duration::from_secs(2), "SIGKILL after the grace: {took:?}");
    assert_eq!(exit_of(&k, Duration::from_secs(1)), "stopped");
    let mut gone = false;
    for _ in 0..200 {
        // (gone, or a zombie waiting for init: either way it no longer runs)
        let st = std::process::Command::new("ps").args(["-o", "stat=", "-p", &child.to_string()]).output().unwrap();
        let s = String::from_utf8_lossy(&st.stdout);
        if s.trim().is_empty() || s.trim().starts_with('Z') {
            gone = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(gone, "the kernel's own child ended with its group");
}

#[test]
fn something_the_kernel_left_holding_its_pipes_holds_nothing_of_ours_after_the_end() {
    let p = system_python();
    let t = Tmp::new("escape");
    let (res, ws) = (stub(&t), workspace(&t));
    let probe = t.0.join("probe");
    // (a descendant in its own session keeps all three pipes; 3 s later it writes to stdout and stderr, SIGPIPE
    //  ignored, and records whether a reader still held each)
    let code = "import os,sys,time,signal\nsignal.signal(signal.SIGPIPE,signal.SIG_IGN)\ntime.sleep(3)\nr=[]\nfor fd in (1,2):\n try:\n  os.write(fd,b'x'); r.append('open')\n except OSError:\n  r.append('closed')\nopen(sys.argv[1],'w').write(' '.join(r))\n";
    let mut k = Kernel::start(&KernelSpec { python: &p, resources: &res, cwd: &ws, base_env: Some(path_env()) }, my_uid()).unwrap();
    line(&k);
    let started = Instant::now();
    k.send(&serde_json::json!({"cmd": "escape", "code": code, "probe": probe.to_str().unwrap()}).to_string()).unwrap();
    assert_eq!(exit_of(&k, Duration::from_secs(5)), "exit 0");
    k.stop();
    assert!(started.elapsed() < Duration::from_millis(2500), "the end didn't wait for the descendant: {:?}", started.elapsed());
    let mut got = String::new();
    for _ in 0..600 {
        if let Ok(s) = fs::read_to_string(&probe) {
            if !s.is_empty() {
                got = s;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(got, "closed closed", "no reader of ours outlived the end");
}

#[test]
fn the_control_plane_prefixes_are_stripped_by_name_only() {
    let env = kernel_env(vec![("SAGEBRUSH_X".into(), "1".into()), ("COCALC_Y".into(), "1".into()), ("TAURI_Z".into(), "1".into()), ("MY_SAGEBRUSH_NOTE".into(), "1".into()), ("MPLBACKEND".into(), "TkAgg".into())].into_iter());
    let names: Vec<String> = env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
    assert_eq!(names, ["MY_SAGEBRUSH_NOTE", "MPLBACKEND"]);
    assert_eq!(env[1].1, "TkAgg", "the person's MPLBACKEND kept");
    let env = kernel_env(std::iter::empty());
    assert_eq!(env, vec![("MPLBACKEND".into(), "Agg".into())]);
}
