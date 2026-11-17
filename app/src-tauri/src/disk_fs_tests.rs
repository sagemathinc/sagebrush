// disk_fs.rs's tests (cargo test --lib, which app.yml runs on every platform): paths stay inside Workspace/, links are never followed, and a change is
// refused when the file isn't what the page expects (another program changed it: its size, time or contents).
use super::*;
use std::path::{Path, PathBuf};

fn dirs(name: &str) -> (PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("sb-disk-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let root = base.join("Workspace");
    let outside = base.join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "secret").unwrap();
    (root, outside)
}
fn is(root: &Path, p: &str) -> Expect {
    let e = stat(root, p).unwrap().unwrap();
    Expect::Is { size: e["size"].as_u64().unwrap(), mtime: e["mtime"].as_u64().unwrap(), sha256: e["sha256"].as_str().unwrap().to_string() }
}
fn outside_untouched(outside: &Path) {
    assert_eq!(std::fs::read(outside.join("secret.txt")).unwrap(), b"secret");
    assert_eq!(std::fs::read_dir(outside).unwrap().count(), 1, "something made outside the workspace");
}

#[test]
fn paths_outside_the_workspace_are_refused() {
    let (rp, outside) = dirs("paths");
    let root = open_root(&rp).unwrap();
    for p in ["/../x", "/a/../../x", "/./x", "/a//b", "x", "", "/a\\b", "/c:x", "/a\0b", "/a/./b", "/.."] {
        assert!(components(p).is_err(), "{p:?} accepted as a path");
        assert!(write(&root, p, b"x", &Expect::Any).is_err(), "{p:?} written");
    }
    assert_eq!(components("/a/b.ipynb").unwrap(), vec!["a", "b.ipynb"]);
    outside_untouched(&outside);
}

#[test]
fn names_windows_would_alias_are_refused() {
    let (rp, _) = dirs("aliases");
    let root = open_root(&rp).unwrap();
    for p in ["/CON", "/con.txt", "/a/Nul.ipynb", "/aux", "/PRN.board.json", "/com1", "/LPT9.csv", "/COM3 .txt", "/a.", "/a ", "/d./x", "/x/y. "] {
        assert!(components(p).is_err(), "{p:?} accepted as a path");
        assert!(write(&root, p, b"x", &Expect::Any).is_err(), "{p:?} written");
    }
    for p in ["/console.txt", "/connect", "/com10", "/com0", "/lpt", "/nul-x.txt", "/a.b", "/.hidden", "/notes .txt"] {
        assert!(components(p).is_ok(), "{p:?} refused");
    }
}

#[test]
fn the_verbs() {
    let (rp, _) = dirs("verbs");
    let root = open_root(&rp).unwrap();
    write(&root, "/n/a.ipynb", b"{}", &Expect::Absent).unwrap();
    assert_eq!(read(&root, "/n/a.ipynb").unwrap(), b"{}");
    write(&root, "/n/a.ipynb", b"{\"v\":2}", &is(&root, "/n/a.ipynb")).unwrap();
    assert_eq!(std::fs::read_dir(rp.join("n")).unwrap().count(), 1, "a temporary file left");
    assert_eq!(stat(&root, "/n/a.ipynb").unwrap().unwrap()["sha256"], sha256_hex(b"{\"v\":2}"));
    mkdir(&root, "/f/g").unwrap();
    assert!(rp.join("f/g").is_dir());
    rename(&root, "/n/a.ipynb", "/m/b.ipynb", &is(&root, "/n/a.ipynb")).unwrap();
    assert!(rp.join("m/b.ipynb").is_file() && !rp.join("n/a.ipynb").exists());
    remove(&root, "/m/b.ipynb", &Expect::Any).unwrap();
    assert!(!rp.join("m/b.ipynb").exists());
    assert!(remove(&root, "/", &Expect::Any).is_err() && rp.is_dir());
    assert!(list(&root).unwrap().iter().all(|e| e["path"].as_str().unwrap().starts_with('/')));
}

#[test]
fn changes_by_another_program_are_never_written_over() {
    let (rp, _) = dirs("expect");
    let root = open_root(&rp).unwrap();
    write(&root, "/a.txt", b"mine", &Expect::Absent).unwrap();
    let mine = is(&root, "/a.txt");
    std::fs::write(rp.join("a.txt"), b"theirs, longer").unwrap();
    assert_eq!(write(&root, "/a.txt", b"mine again", &mine), Err(CONFLICT.to_string()));
    assert_eq!(std::fs::read(rp.join("a.txt")).unwrap(), b"theirs, longer");
    assert_eq!(std::fs::read_dir(&rp).unwrap().count(), 1, "a temporary file left");
    std::fs::write(rp.join("b.txt"), b"theirs").unwrap();
    assert_eq!(write(&root, "/b.txt", b"mine", &Expect::Absent), Err(CONFLICT.to_string()));
    assert_eq!(rename(&root, "/a.txt", "/c.txt", &mine), Err(CONFLICT.to_string()));
    assert!(rp.join("a.txt").exists() && !rp.join("c.txt").exists());
    let theirs = is(&root, "/a.txt");
    assert_eq!(rename(&root, "/a.txt", "/b.txt", &theirs), Err(CONFLICT.to_string()));
    assert_eq!(std::fs::read(rp.join("b.txt")).unwrap(), b"theirs");
    assert_eq!(remove(&root, "/a.txt", &mine), Err(CONFLICT.to_string()));
    assert!(rp.join("a.txt").exists());
    // (a missing source is an error, never a silent success)
    assert!(rename(&root, "/none.txt", "/d.txt", &Expect::Any).is_err());
    assert_eq!(rename(&root, "/none.txt", "/d.txt", &mine), Err(CONFLICT.to_string()));
    // (the control: as expected, done)
    rename(&root, "/a.txt", "/c.txt", &theirs).unwrap();
    assert!(rp.join("c.txt").exists());
}

#[test]
fn an_edit_keeping_size_and_time_is_seen_by_its_contents() {
    let (rp, _) = dirs("digest");
    let root = open_root(&rp).unwrap();
    write(&root, "/a.txt", b"AAAA", &Expect::Absent).unwrap();
    let mine = is(&root, "/a.txt");
    let t = std::fs::metadata(rp.join("a.txt")).unwrap().modified().unwrap();
    std::fs::write(rp.join("a.txt"), b"BBBB").unwrap();
    std::fs::File::options().write(true).open(rp.join("a.txt")).unwrap().set_modified(t).unwrap();
    let now = is(&root, "/a.txt");
    let Expect::Is { size, mtime, .. } = &now else { unreachable!() };
    let Expect::Is { size: s0, mtime: m0, .. } = &mine else { unreachable!() };
    assert!(size == s0 && mtime == m0, "the edit didn't keep size and time: not the case under test");
    assert_eq!(write(&root, "/a.txt", b"CCCC", &mine), Err(CONFLICT.to_string()));
    assert_eq!(std::fs::read(rp.join("a.txt")).unwrap(), b"BBBB");
    assert_eq!(remove(&root, "/a.txt", &mine), Err(CONFLICT.to_string()));
    assert_eq!(rename(&root, "/a.txt", "/b.txt", &mine), Err(CONFLICT.to_string()));
    // (the control: what is there, expected, is written over)
    write(&root, "/a.txt", b"CCCC", &now).unwrap();
}

#[cfg(unix)]
#[test]
fn links_are_never_followed() {
    let (rp, outside) = dirs("links");
    let root = open_root(&rp).unwrap();
    std::os::unix::fs::symlink(&outside, rp.join("link")).unwrap();
    assert!(write(&root, "/link/x.txt", b"x", &Expect::Any).is_err());
    assert!(read(&root, "/link/secret.txt").is_err());
    write(&root, "/r.txt", b"r", &Expect::Absent).unwrap();
    assert!(rename(&root, "/r.txt", "/link/r.txt", &Expect::Any).is_err());
    assert!(mkdir(&root, "/link/sub").is_err());
    mkdir(&root, "/f").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.txt"), rp.join("f/s.txt")).unwrap();
    assert!(write(&root, "/f/s.txt", b"evil", &Expect::Any).is_err());
    assert!(!list(&root).unwrap().iter().any(|e| { let p = e["path"].as_str().unwrap(); p == "/link" || p.starts_with("/link/") || p == "/f/s.txt" }));
    remove(&root, "/f", &Expect::Any).unwrap();
    assert!(remove(&root, "/link", &Expect::Any).is_err());
    let lroot = rp.parent().unwrap().join("Workspace2");
    std::os::unix::fs::symlink(&outside, &lroot).unwrap();
    assert!(open_root(&lroot).is_err());
    outside_untouched(&outside);
}
