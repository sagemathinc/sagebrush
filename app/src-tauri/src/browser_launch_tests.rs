// browser_launch: the flags, the profile directory, Chrome's pipe on a real child's fds 3 and 4, the start identity,
// the identity-checked kill and the cdp sidecar's Seatbelt profile.  The process rows are macOS only (as the lane is).
use super::*;

#[test]
fn chrome_gets_o11_s_flags_exactly() {
    let a = chrome_args(Path::new("/tmp/p"), 50123);
    assert_eq!(a[0], "--remote-debugging-pipe");
    assert!(a.contains(&"--user-data-dir=/tmp/p".to_string()));
    assert!(a.contains(&"--proxy-server=http://127.0.0.1:50123".to_string()));
    assert!(a.contains(&"--proxy-bypass-list=<-loopback>".to_string()));
    for f in ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--dns-prefetch-disable", "--deny-permission-prompts", "--disable-blink-features=AutomationControlled", "--no-first-run", "--disable-extensions", "--disable-background-networking"] {
        assert!(a.iter().any(|x| x == f), "{f}");
    }
    assert!(!a.iter().any(|x| x.starts_with("--remote-debugging-port")), "never a debugging port");
    assert_eq!(a.len(), 17);
}

#[cfg(unix)]
#[test]
fn the_profile_directory_is_new_and_the_person_s_alone() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("sb-browser-test-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let d = profile_dir(&root, "abc-123").unwrap();
    assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(profile_dir(&root, "abc-123"), Err(StartError::Failed("the profile directory couldn't be made")), "never reused");
    for bad in ["", "../x", "a/b", "a b"] {
        assert!(profile_dir(&root, bad).is_err(), "{bad}");
    }
    std::fs::remove_dir_all(&root).unwrap();
}

#[cfg(unix)]
#[test]
fn a_child_gets_the_pipe_ends_on_fds_3_and_4() {
    use std::io::{BufRead, Write};
    let (chrome, sidecar) = debugging_pipes().unwrap();
    // (a stand-in Chrome: reads a line on fd 3, answers on fd 4)
    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.args(["-c", "read l <&3; echo \"got:$l\" >&4"]);
    with_fds(&mut cmd, &chrome);
    let mut child = cmd.spawn().unwrap();
    drop(chrome); // (Rust keeps only the sidecar's ends)
    let mut to = std::fs::File::from(sidecar.child_fd3);
    writeln!(to, "hello").unwrap();
    drop(to);
    let mut line = String::new();
    std::io::BufReader::new(std::fs::File::from(sidecar.child_fd4)).read_line(&mut line).unwrap();
    assert_eq!(line, "got:hello\n");
    assert!(child.wait().unwrap().success());
}

#[cfg(target_os = "macos")]
#[test]
fn the_start_identity_and_executable_tell_a_process_from_a_reused_pid() {
    let me = std::process::id();
    let started = start_identity(me).expect("this process");
    assert!(started.0 > 1_700_000_000);
    assert_eq!(executable(me).unwrap(), std::env::current_exe().unwrap().canonicalize().unwrap());
    let mut child = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let rec = Launched { pid: child.id(), started: start_identity(child.id()).unwrap(), exe: executable(child.id()).unwrap(), profile: PathBuf::from("/nonexistent") };
    assert!(is_same(&rec));
    // (a record whose start time or executable differs is someone else's process: never killed)
    for other in [Launched { started: (rec.started.0, rec.started.1 + 1), ..rec.clone() }, Launched { exe: PathBuf::from("/bin/cat"), ..rec.clone() }] {
        assert!(!kill_if_same(&other));
    }
    assert!(child.try_wait().unwrap().is_none(), "still running");
    assert!(kill_if_same(&rec));
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
    assert!(start_identity(rec.pid).is_none() || !is_same(&rec), "gone");
}

#[cfg(target_os = "macos")]
#[test]
fn the_cdp_sidecar_s_profile_refuses_the_network() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let try_connect = |sandboxed: bool| {
        let script = format!("exec 5<>/dev/tcp/127.0.0.1/{port}");
        let mut cmd = if sandboxed {
            let mut c = std::process::Command::new("/usr/bin/sandbox-exec");
            c.args(["-p", CDP_PROFILE, "/bin/bash", "-c", &script]);
            c
        } else {
            let mut c = std::process::Command::new("/bin/bash");
            c.args(["-c", &script]);
            c
        };
        cmd.stderr(std::process::Stdio::null()).status().unwrap().success()
    };
    assert!(try_connect(false), "the control: without the profile the connect works");
    assert!(!try_connect(true), "with the profile it's refused");
    // (and the profile still runs a program that doesn't touch the network)
    assert!(std::process::Command::new("/usr/bin/sandbox-exec").args(["-p", CDP_PROFILE, "/usr/bin/true"]).status().unwrap().success());
}

#[test]
fn only_macos_starts_a_session() {
    if cfg!(target_os = "macos") {
        assert_eq!(platform(), Ok(()));
    } else {
        assert_eq!(platform(), Err(StartError::UnsupportedPlatform));
    }
}
