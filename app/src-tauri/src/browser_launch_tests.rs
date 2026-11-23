// browser_launch: the flags, the profile directory, Chrome's pipe on a real child's fds 3 and 4 (and nothing else, even
// with colliding or churned descriptors), the start identity and the sweep, the cdp sidecar's Seatbelt profile, and
// the crash rows: when the holder of the app's pipe ends dies abruptly, Chrome, the net sidecar and the cdp sidecar each
// exit on the EOF.
// The process rows are macOS only (as the lane is).
use super::*;

#[test]
fn chrome_gets_o11_s_flags_exactly() {
    // (the whole list, in order: nothing more, nothing less, never a debugging port)
    assert_eq!(
        chrome_args(Path::new("/tmp/p"), 50123),
        [
            "--remote-debugging-pipe",
            "--user-data-dir=/tmp/p",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--disable-extensions",
            "--disable-component-extensions-with-background-pages",
            "--disable-background-networking",
            "--disable-default-apps",
            "--proxy-server=http://127.0.0.1:50123",
            "--proxy-bypass-list=<-loopback>",
            "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--dns-prefetch-disable",
            "--deny-permission-prompts",
            "--disable-blink-features=AutomationControlled",
            "about:blank",
        ]
    );
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
    with_fds(&mut cmd, chrome);
    let mut child = cmd.spawn().unwrap();
    drop(cmd); // (now only the child holds Chrome's ends)
    let mut to = std::fs::File::from(sidecar.child_fd3);
    writeln!(to, "hello").unwrap();
    drop(to);
    let mut line = String::new();
    std::io::BufReader::new(std::fs::File::from(sidecar.child_fd4)).read_line(&mut line).unwrap();
    assert_eq!(line, "got:hello\n");
    assert!(child.wait().unwrap().success());
}

/// How a child's fds 3 and 4 were set up for `child_view`.
#[cfg(unix)]
#[derive(Clone, Copy)]
enum Setup {
    Plain,
    /// The sources first moved onto these low descriptors in the child, then placed.
    Collide(i32, i32),
    /// The caller's descriptors churned (many opened and closed) between with_fds and spawn.
    Churn,
}

/// A child's view of its fds 3 and 4, proved through the intended ends: a marker sent on the parent's end of fd 3 must
/// come back, changed, on the parent's end of fd 4 (so the child's 3 and 4 are the pair, not reused numbers); then the
/// descriptors above 4 it holds (/dev/fd), and whether its fd 4 alone kept the pipe's write end open: the child closes
/// 4, then waits 3 s; the parent must see EOF within 2 s.  Returns (the listing, the echo, EOF in time).
#[cfg(unix)]
fn child_view(setup: Setup) -> (String, String, bool) {
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    let (chrome, sidecar) = debugging_pipes().unwrap();
    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.args(["-c", "read l <&3; printf 'echo:%s;' \"$l\" >&4; for f in 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32; do [ -e /dev/fd/$f ] && printf '%s ' $f; done >&2; exec 4>&-; sleep 3"]);
    cmd.stderr(std::process::Stdio::piped());
    match setup {
        Setup::Collide(x, y) => {
            // SAFETY: test-only, in the child before exec: dup2 only, then place_fds.  The closure owns the pair.
            unsafe {
                cmd.pre_exec(move || {
                    if libc::dup2(chrome.child_fd3.as_raw_fd(), x) < 0 || libc::dup2(chrome.child_fd4.as_raw_fd(), y) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    // (close-on-exec, as std makes every descriptor it hands out: what place_fds is given in real use)
                    if libc::fcntl(x, libc::F_SETFD, libc::FD_CLOEXEC) < 0 || libc::fcntl(y, libc::F_SETFD, libc::FD_CLOEXEC) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    place_fds(x, y)
                });
            }
        }
        Setup::Plain => with_fds(&mut cmd, chrome),
        Setup::Churn => {
            with_fds(&mut cmd, chrome);
            // (the caller opens and closes many descriptors, pipes included, before spawning: the pair must survive)
            for _ in 0..64 {
                let f = std::fs::File::open("/dev/null").unwrap();
                let p = std::io::pipe().unwrap();
                drop((f, p));
            }
            let _held: Vec<std::fs::File> = (0..8).map(|_| std::fs::File::open("/dev/null").unwrap()).collect();
        }
    }
    let mut child = cmd.spawn().unwrap();
    drop(cmd);
    // (a marker unique to this call, through the parent's end of the child's fd 3)
    let marker = format!("m{}x{:?}", std::process::id(), std::time::Instant::now()).replace(|c: char| !c.is_ascii_alphanumeric(), "");
    let mut to = std::fs::File::from(sidecar.child_fd3);
    let _ = writeln!(to, "{marker}"); // (a closed far end fails the echo below, not this write)
    drop(to);
    let mut seen = String::new();
    let mut err = child.stderr.take().unwrap();
    // (the echo, then EOF: read until the end, and time it from the echo's arrival; every read waits at most until a
    //  fixed deadline, so a row whose pipes are wrong fails instead of hanging)
    let mut from = std::fs::File::from(sidecar.child_fd4);
    let mut got = Vec::new();
    let mut buf = [0u8; 64];
    let mut echoed_at = None;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        let mut pfd = libc::pollfd { fd: from.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: poll on one descriptor we own, with a struct we own, for at most `left`.
        if left.is_zero() || unsafe { libc::poll(&mut pfd, 1, left.as_millis() as i32) } <= 0 {
            break;
        }
        let n = from.read(&mut buf).unwrap_or(0);
        if n == 0 {
            break;
        }
        got.extend_from_slice(&buf[..n]);
        if echoed_at.is_none() && got.ends_with(b";") {
            echoed_at = Some(std::time::Instant::now());
        }
    }
    let eof = echoed_at.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(2));
    child.kill().ok();
    child.wait().unwrap();
    err.read_to_string(&mut seen).unwrap();
    let echo = String::from_utf8_lossy(&got).to_string();
    let want = format!("echo:{marker};");
    (seen.trim().to_string(), if echo == want { "ok".into() } else { format!("{echo:?}, not {want:?}") }, eof)
}

#[cfg(unix)]
#[test]
fn a_child_holds_only_its_fds_3_and_4_even_when_the_sources_collide() {
    let (plain, plain_echo, plain_eof) = child_view(Setup::Plain);
    assert_eq!(plain_echo, "ok", "the marker went in on fd 3 and came back on fd 4");
    assert!(plain_eof, "closing the child's fd 4 ends the pipe: nothing else holds its write end");
    // (sources already on the targets, swapped, and one low and one high)
    for (x, y) in [(3, 4), (4, 3), (3, 6)] {
        let (seen, echo, eof) = child_view(Setup::Collide(x, y));
        assert_eq!(echo, "ok", "({x}, {y}): the child's 3 and 4 are the intended pair");
        assert_eq!(seen, plain, "({x}, {y}): no temporary copy of a pipe end survives exec");
        assert!(eof, "({x}, {y}): closing the child's fd 4 ends the pipe");
    }
}

#[cfg(unix)]
#[test]
fn the_pair_survives_the_caller_s_descriptor_churn_until_spawn() {
    let (plain, _, _) = child_view(Setup::Plain);
    let (seen, echo, eof) = child_view(Setup::Churn);
    assert_eq!(echo, "ok", "the marker crossed the intended pair, both ways");
    assert_eq!(seen, plain, "exactly the intended pair, nothing else");
    assert!(eof, "and closing the child's fd 4 ends the pipe");
}

#[cfg(target_os = "macos")]
#[test]
fn the_sweep_leaves_a_live_session_s_profile_and_removes_a_dead_one_s() {
    let me = std::process::id();
    assert!(start_identity(me).expect("this process").0 > 1_700_000_000);
    let root = std::env::temp_dir().join(format!("sb-sweep-test-{me}"));
    std::fs::create_dir_all(&root).unwrap();
    let mut child = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let rec = Launched { pid: child.id(), started: start_identity(child.id()).unwrap(), profile: profile_dir(&root, "s1").unwrap() };
    // (alive: refused, the directory stays, and nothing is signalled)
    assert_eq!(sweep_profile(&rec), Err("its browser is still running"));
    assert!(rec.profile.exists());
    assert!(child.try_wait().unwrap().is_none(), "never signalled");
    // (a record with another start time is another process: the directory is removed, the live child untouched)
    let other = Launched { started: (rec.started.0, rec.started.1 + 1), profile: profile_dir(&root, "s2").unwrap(), ..rec.clone() };
    assert_eq!(sweep_profile(&other), Ok(()));
    assert!(!other.profile.exists());
    assert!(child.try_wait().unwrap().is_none());
    // (once the process is gone, its directory is removed; and again is fine)
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(sweep_profile(&rec), Ok(()));
    assert!(!rec.profile.exists());
    assert_eq!(sweep_profile(&rec), Ok(()));
    std::fs::remove_dir_all(&root).unwrap();
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

/// Wait up to `ms` for `cond`.
#[cfg(target_os = "macos")]
fn within(ms: u64, mut cond: impl FnMut() -> bool) -> bool {
    let end = std::time::Instant::now() + std::time::Duration::from_millis(ms);
    while std::time::Instant::now() < end {
        if cond() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    cond()
}

/// Whether any process's command line still names `needle` (pgrep -f).
#[cfg(target_os = "macos")]
fn any_process_names(needle: &str) -> bool {
    std::process::Command::new("/usr/bin/pgrep").args(["-f", needle]).stdout(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

/// The crash row for Chrome: the app's ends of Chrome's pipe are held by a stand-in app process that is then killed
/// abruptly (SIGKILL: no cleanup runs); the OS closes its ends, and Chrome and every helper process it started must
/// be gone within a bound.  Chrome runs headless here (no window on the build machine); SAGEBRUSH_TEST_CHROME names the
/// binary, else the installed Google Chrome; without one the row says so and passes vacuously.
#[cfg(target_os = "macos")]
#[test]
fn after_an_abrupt_app_death_chrome_exits_on_the_pipe_s_eof() {
    let chrome_bin = std::env::var("SAGEBRUSH_TEST_CHROME").unwrap_or_else(|_| "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into());
    if !Path::new(&chrome_bin).exists() {
        eprintln!("NO CHROME: {chrome_bin} doesn't exist; the crash row didn't run");
        return;
    }
    let root = std::env::temp_dir().join(format!("sb-crash-test-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let profile = profile_dir(&root, "crash").unwrap();
    let (chrome_ends, app_ends) = debugging_pipes().unwrap();
    let mut args = chrome_args(&profile, 9);
    args.insert(1, "--headless=new".into());
    let mut cmd = std::process::Command::new(&chrome_bin);
    cmd.args(&args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    with_fds(&mut cmd, chrome_ends);
    let mut chrome = cmd.spawn().unwrap();
    drop(cmd);
    // (the stand-in app: it alone holds the app's ends, on its own fds 3 and 4)
    let mut app = std::process::Command::new("/bin/sleep");
    app.arg("600");
    with_fds(&mut app, app_ends);
    let mut holder = app.spawn().unwrap();
    drop(app);
    let needle = profile.display().to_string();
    assert!(within(10_000, || any_process_names(&needle)), "Chrome started");
    std::thread::sleep(std::time::Duration::from_secs(2));
    assert!(chrome.try_wait().unwrap().is_none(), "Chrome waits on its pipe while the app lives");
    holder.kill().unwrap(); // (SIGKILL)
    holder.wait().unwrap();
    let started = std::time::Instant::now();
    assert!(within(15_000, || chrome.try_wait().unwrap().is_some()), "Chrome exited on the pipe's EOF");
    assert!(within(15_000, || !any_process_names(&needle)), "and every process it started is gone");
    eprintln!("Chrome and its helpers gone {:?} after the app's death", started.elapsed());
    std::fs::remove_dir_all(&root).ok();
}

/// The crash row for the net sidecar: the real sidecar (SAGEBRUSH_TEST_AGENT_DIR: a sagebrush-agent checkout) with its
/// stdin held by a stand-in app process that is killed abruptly; the sidecar must see the EOF and exit.
#[cfg(target_os = "macos")]
#[test]
fn after_an_abrupt_app_death_the_net_sidecar_exits_on_stdin_s_eof() {
    let Ok(agent) = std::env::var("SAGEBRUSH_TEST_AGENT_DIR") else {
        eprintln!("NO AGENT CHECKOUT: SAGEBRUSH_TEST_AGENT_DIR unset; the net sidecar crash row didn't run");
        return;
    };
    let node = std::env::var("SAGEBRUSH_TEST_NODE").unwrap_or_else(|_| "/opt/homebrew/bin/node".into());
    let main = Path::new(&agent).join("lib/fleet/browser/sidecar-net-main.mjs");
    assert!(main.exists(), "{}", main.display());
    // (the stand-in app holds the write end of the sidecar's stdin; the sidecar's stdout goes nowhere)
    let (stdin_r, stdin_w) = std::io::pipe().unwrap();
    let mut sidecar = std::process::Command::new(&node).arg(&main).stdin(stdin_r).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
    let mut app = std::process::Command::new("/bin/sleep");
    app.arg("600").stdout(std::process::Stdio::from(std::os::fd::OwnedFd::from(stdin_w)));
    let mut holder = app.spawn().unwrap();
    drop(app);
    std::thread::sleep(std::time::Duration::from_secs(2));
    assert!(sidecar.try_wait().unwrap().is_none(), "the sidecar waits on stdin while the app lives");
    holder.kill().unwrap();
    holder.wait().unwrap();
    assert!(within(10_000, || sidecar.try_wait().unwrap().is_some()), "the sidecar exited on stdin's EOF");
    assert!(sidecar.wait().unwrap().success(), "with status 0");
}

/// The crash row for the cdp sidecar, launched as the app will launch it: the real sidecar-cdp-main.mjs (from the
/// SAGEBRUSH_TEST_AGENT_DIR checkout) under CDP_PROFILE through sandbox-exec, with Chrome's pipe ends on its fds 3 and 4
/// (their other ends held by a stand-in Chrome) and its stdin held by a stand-in app.  The app is killed abruptly;
/// the sidecar must see stdin's EOF and exit, with status 0, within the bound.
#[cfg(target_os = "macos")]
#[test]
fn after_an_abrupt_app_death_the_cdp_sidecar_exits_on_stdin_s_eof() {
    let Ok(agent) = std::env::var("SAGEBRUSH_TEST_AGENT_DIR") else {
        eprintln!("NO AGENT CHECKOUT: SAGEBRUSH_TEST_AGENT_DIR unset; the cdp sidecar crash row didn't run");
        return;
    };
    let node = std::env::var("SAGEBRUSH_TEST_NODE").unwrap_or_else(|_| "/opt/homebrew/bin/node".into());
    let main = Path::new(&agent).join("lib/fleet/browser/sidecar-cdp-main.mjs");
    assert!(main.exists(), "{}", main.display());
    let (chrome_ends, sidecar_ends) = debugging_pipes().unwrap();
    // (a stand-in Chrome holds the other ends of the pipe, as Chrome would, and outlives the app)
    let mut stand_in = std::process::Command::new("/bin/sleep");
    stand_in.arg("600");
    with_fds(&mut stand_in, chrome_ends);
    let mut chrome = stand_in.spawn().unwrap();
    drop(stand_in);
    // (the sidecar: the profile, its fds 3 and 4, stdin from the stand-in app, stdout nowhere)
    let (stdin_r, stdin_w) = std::io::pipe().unwrap();
    let mut cmd = std::process::Command::new("/usr/bin/sandbox-exec");
    cmd.args(["-p", CDP_PROFILE]).arg(&node).arg(&main).stdin(stdin_r).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    with_fds(&mut cmd, sidecar_ends);
    let mut sidecar = cmd.spawn().unwrap();
    drop(cmd);
    let mut app = std::process::Command::new("/bin/sleep");
    app.arg("600").stdout(std::process::Stdio::from(std::os::fd::OwnedFd::from(stdin_w)));
    let mut holder = app.spawn().unwrap();
    drop(app);
    std::thread::sleep(std::time::Duration::from_secs(2));
    assert!(sidecar.try_wait().unwrap().is_none(), "the sidecar waits on stdin while the app lives");
    holder.kill().unwrap();
    holder.wait().unwrap();
    let started = std::time::Instant::now();
    assert!(within(10_000, || sidecar.try_wait().unwrap().is_some()), "the cdp sidecar exited on stdin's EOF");
    assert!(sidecar.wait().unwrap().success(), "with status 0");
    eprintln!("the cdp sidecar gone {:?} after the app's death", started.elapsed());
    chrome.kill().ok();
    chrome.wait().ok();
}

#[test]
fn only_macos_starts_a_session() {
    if cfg!(target_os = "macos") {
        assert_eq!(platform(), Ok(()));
    } else {
        assert_eq!(platform(), Err(StartError::UnsupportedPlatform));
    }
}
