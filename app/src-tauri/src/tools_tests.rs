// The chosen-tool checks on real files: a private folder per test, shell scripts standing for Claude Code, and the
// person's uid given (another one stands for "someone else").

use super::*;
use std::fs;
use std::os::unix::fs::PermissionsExt;

struct Tmp(PathBuf);
impl Tmp {
    fn new(name: &str) -> Tmp {
        Tmp::under(&std::env::temp_dir(), name)
    }
    fn under(base: &Path, name: &str) -> Tmp {
        let d = base.join(format!("sb-tools-{name}-{}-{}", std::process::id(), rand_suffix()));
        fs::create_dir(&d).unwrap();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o700)).unwrap();
        Tmp(fs::canonicalize(d).unwrap())
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn rand_suffix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos() as u64 ^ (std::thread::current().id().as_u64_stub())
}
trait IdStub {
    fn as_u64_stub(&self) -> u64;
}
impl IdStub for std::thread::ThreadId {
    fn as_u64_stub(&self) -> u64 {
        let s = format!("{self:?}");
        s.bytes().fold(0u64, |a, b| a.wrapping_mul(31).wrapping_add(b as u64))
    }
}

/// A script at dir/name: "#!/bin/sh" and `body`, with `mode`.
fn script(dir: &Path, name: &str, body: &str, mode: u32) -> PathBuf {
    let p = dir.join(name);
    fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(mode)).unwrap();
    p
}
const GOOD: &str = "printf '2.1.330 (Claude Code)\\n'";
const SUPPORTED: &[&str] = &["2.1.330"];
fn run(t: &Tmp) -> VersionRun<'_> {
    VersionRun { home: &t.0, cwd: &t.0, supported: SUPPORTED }
}

#[test]
fn a_chosen_tool_is_bound_checked_and_answered() {
    let t = Tmp::new("ok");
    let p = script(&t.0, "claude", GOOD, 0o755);
    let c = choose(&p, my_uid(), &run(&t)).unwrap();
    assert_eq!(c.path, p);
    assert_eq!(c.version, "2.1.330");
    assert!(recheck(&c, my_uid()).is_ok());
}

#[test]
fn the_path_must_be_absolute_and_a_regular_file() {
    let t = Tmp::new("form");
    script(&t.0, "claude", GOOD, 0o755);
    assert_eq!(choose(Path::new("claude"), my_uid(), &run(&t)).unwrap_err(), ToolRefusal::NotAbsolute);
    assert_eq!(choose(Path::new("./claude"), my_uid(), &run(&t)).unwrap_err(), ToolRefusal::NotAbsolute);
    assert_eq!(choose(&t.0.join("nothing"), my_uid(), &run(&t)).unwrap_err(), ToolRefusal::Missing);
    fs::create_dir(t.0.join("adir")).unwrap();
    fs::set_permissions(t.0.join("adir"), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(choose(&t.0.join("adir"), my_uid(), &run(&t)).unwrap_err(), ToolRefusal::NotRegular);
    // (a dangling link)
    std::os::unix::fs::symlink(t.0.join("gone"), t.0.join("dangling")).unwrap();
    assert_eq!(choose(&t.0.join("dangling"), my_uid(), &run(&t)).unwrap_err(), ToolRefusal::Missing);
}

#[test]
fn a_link_is_resolved_once_and_its_target_bound() {
    let t = Tmp::new("link");
    let real = script(&t.0, "claude-real", GOOD, 0o755);
    let other = script(&t.0, "other", GOOD, 0o755);
    let link = t.0.join("claude");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let c = choose(&link, my_uid(), &run(&t)).unwrap();
    assert_eq!(c.path, real, "the target is what is bound and shown");
    // (the link re-pointed: the bound target is unchanged, and still the one used)
    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&other, &link).unwrap();
    assert!(recheck(&c, my_uid()).is_ok());
    assert_eq!(c.path, real);
}

#[test]
fn the_file_writable_by_others_not_executable_or_owned_by_someone_else_is_refused() {
    let t = Tmp::new("mode");
    for (mode, want) in [(0o775, ToolRefusal::WritableByOthers), (0o757, ToolRefusal::WritableByOthers), (0o644, ToolRefusal::NotExecutable), (0o055, ToolRefusal::NotExecutable)] {
        let p = script(&t.0, &format!("c{mode:o}"), GOOD, mode);
        assert_eq!(choose(&p, my_uid(), &run(&t)).unwrap_err(), want, "{mode:o}");
    }
    let p = script(&t.0, "claude", GOOD, 0o755);
    let someone_else = my_uid().wrapping_add(1).max(1);
    if my_uid() != 0 {
        assert_eq!(choose(&p, someone_else, &run(&t)).unwrap_err(), ToolRefusal::WrongOwner);
    }
    assert!(choose(&p, my_uid(), &run(&t)).is_ok(), "0755, ours");
    let p5 = script(&t.0, "c0500", GOOD, 0o500);
    assert!(choose(&p5, my_uid(), &run(&t)).is_ok(), "0500, ours: executable by its owner, the person");
}

#[test]
fn its_folders_must_not_be_writable_by_others_and_a_root_sticky_one_only_above_its_own() {
    let t = Tmp::new("parents");
    for mode in [0o777, 0o775, 0o757, 0o1777] {
        let d = t.0.join(format!("d{mode:o}"));
        fs::create_dir(&d).unwrap();
        let p = script(&d, "claude", GOOD, 0o755);
        fs::set_permissions(&d, fs::Permissions::from_mode(mode)).unwrap();
        assert_eq!(choose(&p, my_uid(), &run(&t)).unwrap_err(), ToolRefusal::ParentWritable, "its own folder {mode:o}");
    }
    // (a folder further up, writable by others and not root's sticky one)
    let up = t.0.join("up");
    fs::create_dir(&up).unwrap();
    let inner = up.join("inner");
    fs::create_dir(&inner).unwrap();
    fs::set_permissions(&inner, fs::Permissions::from_mode(0o700)).unwrap();
    let p = script(&inner, "claude", GOOD, 0o755);
    fs::set_permissions(&up, fs::Permissions::from_mode(0o777)).unwrap();
    assert_eq!(choose(&p, my_uid(), &run(&t)).unwrap_err(), ToolRefusal::ParentWritable, "a folder above");
    fs::set_permissions(&up, fs::Permissions::from_mode(0o1777)).unwrap();
    assert_eq!(choose(&p, my_uid(), &run(&t)).unwrap_err(), ToolRefusal::ParentWritable, "sticky but ours, not root's");
    fs::set_permissions(&up, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(choose(&p, my_uid(), &run(&t)).is_ok());
    // (root's sticky /tmp: fine above the file's own private folder, never as its own folder)
    use std::os::unix::fs::MetadataExt;
    let tmp = fs::canonicalize("/tmp").unwrap();
    let m = fs::metadata(&tmp).unwrap();
    assert!(m.uid() == 0 && m.mode() & 0o1777 == 0o1777, "the test needs /tmp as root's sticky, world-writable folder");
    let private = Tmp::under(&tmp, "sticky");
    let p = script(&private.0, "claude", GOOD, 0o755);
    assert!(choose(&p, my_uid(), &run(&private)).is_ok(), "under a private folder in /tmp");
    let direct = tmp.join(format!("sb-tools-direct-{}", std::process::id()));
    let _ = fs::remove_file(&direct);
    fs::write(&direct, format!("#!/bin/sh\n{GOOD}\n")).unwrap();
    fs::set_permissions(&direct, fs::Permissions::from_mode(0o755)).unwrap();
    let r = choose(&direct, my_uid(), &run(&private));
    let _ = fs::remove_file(&direct);
    assert_eq!(r.unwrap_err(), ToolRefusal::ParentWritable, "directly in /tmp");
}

#[test]
fn the_version_answer_is_exact_and_supported() {
    let t = Tmp::new("answers");
    for (i, (body, want)) in [
        ("printf '2.1.330 (Claude Code) \\n'", ToolRefusal::VersionUnknown),
        ("printf '2.1.330 (Claude Code)\\r\\n'", ToolRefusal::VersionUnknown),
        ("printf '2.1.330 (Claude Code)\\nmore\\n'", ToolRefusal::VersionUnknown),
        ("printf '2.1.330 (Claude Code)'", ToolRefusal::VersionUnknown),
        ("printf 'v2.1.330 (Claude Code)\\n'", ToolRefusal::VersionUnknown),
        ("printf '02.1.330 (Claude Code)\\n'", ToolRefusal::VersionUnknown),
        ("printf '2.1 (Claude Code)\\n'", ToolRefusal::VersionUnknown),
        ("printf '2.1.330 (Codex)\\n'", ToolRefusal::VersionUnknown),
        ("true", ToolRefusal::VersionUnknown),
        ("printf '2.1.330 (Claude Code)\\n'; exit 3", ToolRefusal::VersionUnknown),
        ("printf '2.1.331 (Claude Code)\\n'", ToolRefusal::VersionMismatch),
        ("printf '2.1.33 (Claude Code)\\n'", ToolRefusal::VersionMismatch),
    ]
    .into_iter()
    .enumerate()
    {
        let p = script(&t.0, &format!("c{i}"), body, 0o755);
        assert_eq!(choose(&p, my_uid(), &run(&t)).unwrap_err(), want, "{body}");
    }
}

#[test]
fn output_past_the_cap_on_either_stream_is_refused_and_at_the_cap_is_read() {
    let t = Tmp::new("caps");
    let n = VERSION_OUTPUT;
    // (stderr exactly at the cap: still fine; one byte more: refused; stdout over the cap: refused)
    let at = script(&t.0, "at", &format!("head -c {n} /dev/zero >&2; {GOOD}"), 0o755);
    assert!(choose(&at, my_uid(), &run(&t)).is_ok(), "stderr at the cap");
    let over_err = script(&t.0, "over-err", &format!("head -c {} /dev/zero >&2; {GOOD}", n + 1), 0o755);
    assert_eq!(choose(&over_err, my_uid(), &run(&t)).unwrap_err(), ToolRefusal::VersionUnknown);
    let over_out = script(&t.0, "over-out", &format!("head -c {} /dev/zero", n + 1), 0o755);
    assert_eq!(choose(&over_out, my_uid(), &run(&t)).unwrap_err(), ToolRefusal::VersionUnknown);
    // (an endless flood ends at once: the reader stops one byte past the cap and lets the pipe go, so the writer
    //  dies of it; refused as an answer past the cap, well before the deadline)
    let flood = script(&t.0, "flood", "yes", 0o755);
    let started = std::time::Instant::now();
    assert_eq!(choose(&flood, my_uid(), &run(&t)).unwrap_err(), ToolRefusal::VersionUnknown);
    assert!(started.elapsed() < VERSION_DEADLINE, "{:?}", started.elapsed());
}

#[test]
fn a_hang_is_killed_with_its_whole_group_at_the_deadline() {
    let t = Tmp::new("hang");
    let pidfile = t.0.join("child.pid");
    let body = format!("sleep 60 & echo $! > '{}'; sleep 60", pidfile.display());
    let p = script(&t.0, "claude", &body, 0o755);
    let started = std::time::Instant::now();
    assert_eq!(choose(&p, my_uid(), &run(&t)).unwrap_err(), ToolRefusal::NoAnswer);
    let took = started.elapsed();
    assert!(took >= VERSION_DEADLINE && took < VERSION_DEADLINE + Duration::from_secs(3), "{took:?}");
    let child: libc::pid_t = fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
    let mut gone = false;
    for _ in 0..100 {
        if unsafe { libc::kill(child, 0) } != 0 {
            gone = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(gone, "the tool's own child was killed with its group");
}

#[test]
fn it_runs_with_nothing_inherited_a_fixed_folder_and_no_stdin() {
    let t = Tmp::new("env");
    std::env::set_var("SB_TOOL_CANARY", "inherited");
    let cwd = t.0.display();
    // (any line besides the answer makes it refused: so being accepted shows each condition held)
    let body = format!(
        "[ -z \"$SB_TOOL_CANARY\" ] || echo leaked\n[ \"$DISABLE_AUTOUPDATER\" = 1 ] || echo autoupdater\n[ \"$PATH\" = /usr/bin:/bin ] || echo path\n[ \"$HOME\" = '{cwd}' ] || echo home\n[ \"$(pwd -P)\" = '{cwd}' ] || echo cwd\n[ \"$(env | wc -l | tr -d ' ')\" -le 8 ] || echo env\nif read x; then echo stdin; fi\n{GOOD}"
    );
    let p = script(&t.0, "claude", &body, 0o755);
    let r = choose(&p, my_uid(), &run(&t));
    std::env::remove_var("SB_TOOL_CANARY");
    assert_eq!(r.map(|c| c.version), Ok("2.1.330".to_string()));
}

#[test]
fn a_change_after_the_choice_means_choose_again() {
    let t = Tmp::new("changed");
    type Change = fn(&Path, &Path);
    let cases: [(&str, Change, ToolRefusal); 7] = [
        ("rewritten", |p, _| fs::write(p, format!("#!/bin/sh\n{GOOD}\n# more\n")).unwrap(), ToolRefusal::IdentityChanged),
        ("replaced by rename", |p, d| { let n = script(d, "new", GOOD, 0o755); fs::rename(n, p).unwrap(); }, ToolRefusal::IdentityChanged),
        ("mode changed", |p, _| fs::set_permissions(p, fs::Permissions::from_mode(0o700)).unwrap(), ToolRefusal::IdentityChanged),
        ("removed", |p, _| fs::remove_file(p).unwrap(), ToolRefusal::IdentityChanged),
        ("made a link", |p, d| { let n = script(d, "elsewhere", GOOD, 0o755); fs::remove_file(p).unwrap(); std::os::unix::fs::symlink(n, p).unwrap(); }, ToolRefusal::IdentityChanged),
        ("made writable by others", |p, _| fs::set_permissions(p, fs::Permissions::from_mode(0o777)).unwrap(), ToolRefusal::WritableByOthers),
        ("its folder opened up", |_, d| fs::set_permissions(d, fs::Permissions::from_mode(0o777)).unwrap(), ToolRefusal::ParentWritable),
    ];
    for (what, change, want) in cases {
        let d = t.0.join(what.replace(' ', "-"));
        fs::create_dir(&d).unwrap();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o700)).unwrap();
        let p = script(&d, "claude", GOOD, 0o755);
        let c = choose(&p, my_uid(), &run(&t)).unwrap();
        change(&p, &d);
        assert_eq!(recheck(&c, my_uid()).unwrap_err(), want, "{what}");
        let _ = fs::set_permissions(&d, fs::Permissions::from_mode(0o700));
    }
}

#[test]
fn the_answer_parser_takes_exactly_one_form() {
    assert_eq!(parse_claude_version(b"2.1.330 (Claude Code)\n").as_deref(), Some("2.1.330"));
    assert_eq!(parse_claude_version(b"0.0.0 (Claude Code)\n").as_deref(), Some("0.0.0"));
    assert_eq!(parse_claude_version(b"999999.1.0 (Claude Code)\n").as_deref(), Some("999999.1.0"));
    for bad in [&b"1000000.1.0 (Claude Code)\n"[..], b"2.1.330 (Claude Code)", b"2.1.330  (Claude Code)\n", b"2.1.330 (claude code)\n", b"2.1.-1 (Claude Code)\n", b"2.1.3a (Claude Code)\n", b"2..1 (Claude Code)\n", b"\xff (Claude Code)\n", b""] {
        assert_eq!(parse_claude_version(bad), None, "{:?}", String::from_utf8_lossy(bad));
    }
}

#[test]
fn the_refusal_codes_are_the_closed_list() {
    use ToolRefusal::*;
    let all = [NotAbsolute, Missing, NotRegular, NotExecutable, WrongOwner, WritableByOthers, ParentWritable, VersionUnknown, VersionMismatch, NoAnswer, IdentityChanged, UnsupportedPlatform];
    let codes: Vec<&str> = all.iter().map(|r| r.code()).collect();
    assert_eq!(codes, ["not_absolute", "missing", "not_regular", "not_executable", "wrong_owner", "writable_by_others", "parent_writable", "version_unknown", "version_mismatch", "no_answer", "identity_changed", "unsupported_platform"]);
}
