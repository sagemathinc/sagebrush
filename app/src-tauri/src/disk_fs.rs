// The workspace's files on disk, the part that is only the file system's (no Tauri; disk.rs, the app's commands,
// uses it; its tests: disk_fs_tests.rs).
//
// Paths are workspace paths (components only: no "..", ".", empty, separator, NUL or drive character), each
// component checked, as it is walked, not to be a link (or a Windows reparse point): a page's path can't reach
// outside Workspace/, by mistake or on purpose.  (The threat is a malicious notebook, which can't make links:
// SECURITY-MODEL.md; a program on the computer that swaps a folder for a link meanwhile already runs as the person,
// so these are checks, not a race-proof confinement.)
//
// Every change carries what the page expects the file to be (Expect): whatever it is, absent, or the size,
// modification time and SHA-256 it last read or wrote.  The file is checked right before the change; one that isn't
// as expected was changed by another program, and the change is refused (CONFLICT): the page keeps its version
// elsewhere.  What is left is the moment between that check and the rename itself.  The check is a file's: a
// folder's move or removal doesn't check what is in it.  A write goes to a new temporary file beside the name,
// synced, then renamed over it; after a write, a rename or a removal the folder is synced too, best effort (a failure
// to is ignored; not on Windows, whose folders can't be).  A move of what isn't there is an error; a removal of what
// isn't there succeeds (it is gone either way).
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// A file or folder of the workspace on disk: {path, dir, size, mtime (ms)}, and a file's sha256 where it was read.
pub type Entry = serde_json::Value;

#[cfg(windows)]
fn is_link(m: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // (a symbolic link or a junction: both are reparse points)
    m.file_type().is_symlink() || m.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn is_link(m: &std::fs::Metadata) -> bool {
    m.file_type().is_symlink()
}

/// `p` refused if it is a link.
pub fn no_link(p: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if is_link(&m) => Err(format!("{} is a link, which the app doesn't follow", p.display())),
        _ => Ok(()),
    }
}

/// The folder at `p` (made if missing), refused if it is a link.
pub fn open_root(p: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(p).map_err(|e| format!("{}: {e}", p.display()))?;
    no_link(p)?;
    Ok(p.to_path_buf())
}

/// The components of workspace path `p`, or why it isn't one.
pub fn components(p: &str) -> Result<Vec<&str>, String> {
    let rest = p.strip_prefix('/').ok_or_else(|| format!("{p:?}: not a workspace path"))?;
    if rest.is_empty() {
        return Ok(vec![]);
    }
    let parts: Vec<&str> = rest.split('/').collect();
    for c in &parts {
        let bad = c.is_empty() || *c == "." || *c == ".." || c.chars().any(|ch| ch == '\\' || ch == '\0' || ch == ':' || (ch as u32) < 0x20) || c.len() > 255;
        if bad {
            return Err(format!("{p:?}: not a workspace path"));
        }
        if windows_alias(c) {
            return Err(format!("{p:?}: {c:?} isn't a name Windows keeps as written (a device's name, or one ending in a dot or a space)"));
        }
    }
    Ok(parts)
}

/// Whether Windows would take name `c` for something else: a device (CON, PRN, AUX, NUL, COM1–9 and COM¹²³, LPT1–9
/// and LPT¹²³: Microsoft's "Naming Files, Paths, and Namespaces"; with any extension, in any case) or the same name
/// without its trailing dots and spaces.  Refused everywhere, so the workspace's names mean the same file on every
/// computer.
fn windows_alias(c: &str) -> bool {
    if c.ends_with('.') || c.ends_with(' ') {
        return true;
    }
    let stem: Vec<char> = c.split('.').next().unwrap_or("").trim_end_matches(' ').chars().map(|ch| ch.to_ascii_uppercase()).collect();
    let head: String = stem.iter().take(3).collect();
    match stem.len() {
        3 => matches!(head.as_str(), "CON" | "PRN" | "AUX" | "NUL"),
        4 => matches!(head.as_str(), "COM" | "LPT") && matches!(stem[3], '1'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}'),
        _ => false,
    }
}

/// `p`'s parent folder (made, a folder at a time, if `make`), each folder refused if it is a link or no folder; and
/// `p`'s path.
fn parent(root: &Path, p: &str, make: bool) -> Result<(PathBuf, PathBuf), String> {
    let parts = components(p)?;
    let (last, dirs) = parts.split_last().ok_or_else(|| "the workspace's root isn't a file".to_string())?;
    let mut at = root.to_path_buf();
    for c in dirs {
        at.push(c);
        match std::fs::symlink_metadata(&at) {
            Ok(m) if is_link(&m) => return Err(format!("{p}: {c} is a link, which the app doesn't follow")),
            Ok(m) if !m.is_dir() => return Err(format!("{p}: {c} isn't a folder")),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && make => match std::fs::create_dir(&at) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(format!("{p}: {e}")),
            },
            Err(e) => return Err(format!("{p}: {e}")),
        }
    }
    let file = at.join(last);
    Ok((at, file))
}

/// The metadata of `at`, refused if it is a link; None if nothing is there.
fn no_link_at(at: &Path) -> Result<Option<std::fs::Metadata>, String> {
    match std::fs::symlink_metadata(at) {
        Ok(m) if is_link(&m) => Err(format!("{} is a link, which the app doesn't follow", at.display())),
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn mtime_ms(m: &std::fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}
#[allow(dead_code)]
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
fn sha256_of(at: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(at).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Every file and folder under Workspace/ (links skipped), as workspace paths with their size and modification time.
pub fn list(root: &Path) -> Result<Vec<Entry>, String> {
    let mut out = vec![];
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, at)) = stack.pop() {
        let rd = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for d in rd.flatten() {
            let Ok(m) = std::fs::symlink_metadata(d.path()) else { continue };
            let Some(name) = d.file_name().to_str().map(str::to_string) else { continue };
            let path = format!("{at}/{name}");
            if is_link(&m) || components(&path).is_err() || name.starts_with(".sbtmp-") {
                continue;
            }
            out.push(serde_json::json!({ "path": path.clone(), "dir": m.is_dir(), "size": if m.is_dir() { 0 } else { m.len() }, "mtime": mtime_ms(&m) }));
            if m.is_dir() {
                stack.push((d.path(), path));
            }
        }
    }
    Ok(out)
}

/// What the page expects a file to be before it changes it: whatever it is, absent, or the size, modification time
/// (ms) and SHA-256 it last read or wrote.
#[derive(Clone, PartialEq, Debug)]
pub enum Expect {
    Any,
    Absent,
    Is { size: u64, mtime: u64, sha256: String },
}
pub const CONFLICT: &str = "changed by another program";

impl Expect {
    /// "any", "absent", or "<size>:<mtime>:<sha256>".
    pub fn parse(s: Option<&str>) -> Result<Expect, String> {
        match s {
            None | Some("any") => Ok(Expect::Any),
            Some("absent") => Ok(Expect::Absent),
            Some(x) => {
                let bad = || "a bad expectation".to_string();
                let mut it = x.splitn(3, ':');
                let size = it.next().and_then(|v| v.parse().ok()).ok_or_else(bad)?;
                let mtime = it.next().and_then(|v| v.parse().ok()).ok_or_else(bad)?;
                let sha256 = it.next().filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(bad)?.to_ascii_lowercase();
                Ok(Expect::Is { size, mtime, sha256 })
            }
        }
    }
    /// Whether the file at `at` is as expected: its size and time, then its contents' SHA-256 (so an edit that keeps
    /// both size and time is seen too).
    fn holds(&self, at: &Path) -> Result<bool, String> {
        let m = no_link_at(at)?;
        Ok(match (self, m) {
            (Expect::Any, _) => true,
            (Expect::Absent, m) => m.is_none(),
            (Expect::Is { .. }, None) => false,
            (Expect::Is { size, mtime, sha256 }, Some(m)) => !m.is_dir() && m.len() == *size && mtime_ms(&m) == *mtime && sha256_of(at)? == *sha256,
        })
    }
}

#[cfg(unix)]
fn sync_dir(d: &Path) {
    if let Ok(f) = std::fs::File::open(d) {
        let _ = f.sync_all();
    }
}
#[cfg(not(unix))]
fn sync_dir(_d: &Path) {}

/// {size, mtime, sha256} of the file at `p` (None where there is none; a link refused).
pub fn stat(root: &Path, p: &str) -> Result<Option<Entry>, String> {
    let (_, at) = parent(root, p, false)?;
    let Some(m) = no_link_at(&at)? else { return Ok(None) };
    let sha = if m.is_dir() { serde_json::Value::Null } else { serde_json::Value::String(sha256_of(&at)?) };
    Ok(Some(serde_json::json!({ "path": p, "dir": m.is_dir(), "size": if m.is_dir() { 0 } else { m.len() }, "mtime": mtime_ms(&m), "sha256": sha })))
}

/// `bytes` as workspace path `p`, if the file there is as `expect` says (else CONFLICT, nothing changed).
pub fn write(root: &Path, p: &str, bytes: &[u8], expect: &Expect) -> Result<(), String> {
    let (dir, to) = parent(root, p, true)?;
    let tmp = dir.join(format!(".sbtmp-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let mut conflict = false;
    let done = (|| -> Result<(), String> {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        if !expect.holds(&to)? {
            conflict = true;
            return Err(CONFLICT.into());
        }
        std::fs::rename(&tmp, &to).map_err(|e| e.to_string())?;
        sync_dir(&dir);
        Ok(())
    })();
    if let Err(e) = done {
        let _ = std::fs::remove_file(&tmp);
        return Err(if conflict { CONFLICT.to_string() } else { format!("{p}: {e}") });
    }
    Ok(())
}
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn read(root: &Path, p: &str) -> Result<Vec<u8>, String> {
    let (_, at) = parent(root, p, false)?;
    no_link_at(&at)?.ok_or_else(|| format!("{p}: not there"))?;
    std::fs::read(&at).map_err(|e| format!("{p}: {e}"))
}

pub fn mkdir(root: &Path, p: &str) -> Result<(), String> {
    let (dir, at) = parent(root, p, true)?;
    match no_link_at(&at)? {
        Some(m) if m.is_dir() => Ok(()),
        Some(_) => Err(format!("{p}: a file is there")),
        None => match std::fs::create_dir(&at) {
            Ok(()) => {
                sync_dir(&dir);
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(e) => Err(format!("{p}: {e}")),
        },
    }
}

/// `from` moved to `to`, if `from` is there and as `expect` says and nothing is at `to` (else CONFLICT, nothing
/// moved).  A missing `from` is an error, never a success.
pub fn rename(root: &Path, from: &str, to: &str, expect: &Expect) -> Result<(), String> {
    let (da, a) = parent(root, from, false)?;
    let (db, b) = parent(root, to, true)?;
    if no_link_at(&a)?.is_none() {
        return if *expect == Expect::Any { Err(format!("{from}: not there")) } else { Err(CONFLICT.into()) };
    }
    if !expect.holds(&a)? || !Expect::Absent.holds(&b)? {
        return Err(CONFLICT.into());
    }
    std::fs::rename(&a, &b).map_err(|e| format!("{from} -> {to}: {e}"))?;
    sync_dir(&da);
    sync_dir(&db);
    Ok(())
}

/// A file (if it is as `expect` says, else CONFLICT, nothing removed), or a folder with what's in it (links in it
/// removed as links, never followed).
pub fn remove(root: &Path, p: &str, expect: &Expect) -> Result<(), String> {
    if components(p)?.is_empty() {
        return Err("the workspace's root isn't removed".into());
    }
    let (dir, at) = parent(root, p, false)?;
    let Some(m) = no_link_at(&at)? else { return Ok(()) };
    if !expect.holds(&at)? {
        return Err(CONFLICT.into());
    }
    if m.is_dir() { std::fs::remove_dir_all(&at) } else { std::fs::remove_file(&at) }.map_err(|e| format!("{p}: {e}"))?;
    sync_dir(&dir);
    Ok(())
}

/// A small file of the data folder (settings.json), as text: None if missing; refused if larger than `max`.
pub fn read_small(dir: &Path, name: &str, max: u64) -> Result<Option<String>, String> {
    let at = dir.join(name);
    match std::fs::metadata(&at) {
        Ok(m) if m.len() > max => Err(format!("{name} is larger than {max} bytes")),
        Ok(_) => std::fs::read_to_string(&at).map(Some).map_err(|e| format!("{name}: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{name}: {e}")),
    }
}

/// A small file of the data folder written whole: a temporary file, synced, renamed over it, the folder synced.
pub fn write_small(dir: &Path, name: &str, text: &str) -> Result<(), String> {
    let tmp = dir.join(format!(".{name}.sbtmp-{}", std::process::id()));
    let done = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, dir.join(name))
    })();
    if let Err(e) = done {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{name}: {e}"));
    }
    sync_dir(dir);
    Ok(())
}

/// A small file of the data folder removed (none there: nothing to do), the folder synced.
pub fn remove_small(dir: &Path, name: &str) -> Result<(), String> {
    match std::fs::remove_file(dir.join(name)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{name}: {e}")),
        _ => {
            sync_dir(dir);
            Ok(())
        }
    }
}

/// settings-init.js with its two blanks filled: the keys (disk.rs's own list) first, then the saved settings, so a
/// saved value that holds the keys' blank (a folder named "/*KEYS*/[]", say) is never filled in itself.
pub fn fill_settings_script(template: &str, settings_json: &str, keys_json: &str) -> String {
    template.replacen("/*KEYS*/[]", keys_json, 1).replacen("/*SETTINGS*/null", settings_json, 1)
}

/// What Show in folder shows for workspace path `p`: the workspace's own folder for "/", else the file or folder at
/// `p`, which must be there (each component walked, a link refused, as every other path is), and whether it is a
/// folder.  Never anything outside Workspace/.
pub fn reveal_target(root: &Path, p: &str) -> Result<(PathBuf, bool), String> {
    if components(p)?.is_empty() {
        no_link(root)?;
        return Ok((root.to_path_buf(), true));
    }
    let (_, at) = parent(root, p, false)?;
    let m = no_link_at(&at)?.ok_or_else(|| format!("{p}: not there"))?;
    Ok((at, m.is_dir()))
}

/// The program and arguments that show `at` in the system's file manager: on macOS always selected in Finder (`open
/// -R`), a folder as a file, since a folder can be an application (Name.app) that a plain `open` would launch; on
/// Windows a folder opened, a file selected (Explorer); on Linux its folder opened (xdg-open).  A fixed program, never a
/// shell; `at` is an absolute path inside Workspace/, so it can't be read as an option.
pub fn reveal_argv(at: &Path, dir: bool) -> (String, Vec<std::ffi::OsString>) {
    if cfg!(target_os = "macos") {
        ("/usr/bin/open".into(), vec!["-R".into(), at.as_os_str().to_owned()])
    } else if cfg!(windows) {
        // (passed as written (disk.rs raw_arg): explorer takes /select,"<path>" as one argument, and a folder quoted
        // the same way; a Windows path can't hold a quote, so the quotes can't be broken out of)
        let a: std::ffi::OsString = if dir { format!("\"{}\"", at.display()).into() } else { format!("/select,\"{}\"", at.display()).into() };
        ("explorer.exe".into(), vec![a])
    } else {
        let folder = if dir { at } else { at.parent().unwrap_or(at) };
        ("xdg-open".into(), vec![folder.as_os_str().to_owned()])
    }
}

#[cfg(test)]
#[path = "disk_fs_tests.rs"]
mod tests;
