// The app's workspace on the computer's disk (design: macapp-notes native-storage-design, approved Nov 17): the
// documents and files people make in the app are real files in the OS's own place for an app's data, Tauri's
// app_data_dir (macOS ~/Library/Application Support/space.sagebrush.notebook, Linux $XDG_DATA_HOME/…, by default
// ~/.local/share/…, Windows %APPDATA%\space.sagebrush.notebook), under Workspace/.  The page's workspace
// (IndexedDB, in a web view that keeps nothing between launches) is a cache of it: each launch reads the tree
// (disk_list, disk_read) and every change is written through (disk_write, disk_rename, disk_remove;
// web/workspace/disk-mirror.ts).  settings.json beside Workspace/ holds the page's settings.
//
// Every path the page names is a workspace path ("/a/b.ipynb"): components only, none empty, ".", ".." or with a
// separator, NUL or a Windows drive or stream character, and no component on disk a symbolic link (or a Windows
// junction); so nothing here reads or writes outside Workspace/, whatever the page asks.  A write goes to a
// temporary file in the same folder, synced, then renamed over the name: a reader never sees half a file.
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Workspace/ under the app's data folder (made if missing; refused if it is a link).
pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("the app's data folder: {e}"))?;
    let root = std::env::var_os("SAGEBRUSH_APP_DATA_DIR").map(PathBuf::from).filter(|_| std::env::var_os("SAGEBRUSH_APP_SELFTEST").is_some()).unwrap_or(base).join("Workspace");
    std::fs::create_dir_all(&root).map_err(|e| format!("{}: {e}", root.display()))?;
    no_link(&root)?;
    Ok(root)
}

fn no_link(p: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if is_link(&m) => Err(format!("{} is a link, which the app doesn't follow", p.display())),
        _ => Ok(()),
    }
}

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
    }
    Ok(parts)
}

/// `p` under `root`, every component that exists checked not to be a link.
pub fn resolve(root: &Path, p: &str) -> Result<PathBuf, String> {
    let mut at = root.to_path_buf();
    for c in components(p)? {
        at.push(c);
        no_link(&at)?;
    }
    Ok(at)
}

/// The folders of `p`'s parent made, one at a time, none of them a link.
fn make_parents(root: &Path, p: &str) -> Result<PathBuf, String> {
    let parts = components(p)?;
    let (last, dirs) = parts.split_last().ok_or_else(|| "the workspace's root isn't a file".to_string())?;
    let mut at = root.to_path_buf();
    for c in dirs {
        at.push(c);
        no_link(&at)?;
        match std::fs::create_dir(&at) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && at.is_dir() => {}
            Err(e) => return Err(format!("{}: {e}", at.display())),
        }
    }
    at.push(last);
    no_link(&at)?;
    Ok(at)
}

/// A file or folder of the workspace on disk: {path, dir, size, mtime (ms)}.
pub type Entry = serde_json::Value;

/// Every file and folder under Workspace/ (links skipped), as workspace paths with their size and modification
/// time (ms).
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
            let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
            out.push(serde_json::json!({ "path": path.clone(), "dir": m.is_dir(), "size": if m.is_dir() { 0 } else { m.len() }, "mtime": mtime }));
            if m.is_dir() {
                stack.push((d.path(), path));
            }
        }
    }
    Ok(out)
}

/// `bytes` as workspace path `p`: a temporary file beside it, synced, renamed over it.
pub fn write(root: &Path, p: &str, bytes: &[u8]) -> Result<(), String> {
    let to = make_parents(root, p)?;
    let dir = to.parent().ok_or("no folder")?;
    let tmp = dir.join(format!(".sbtmp-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let done = (|| {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, &to)
    })();
    if let Err(e) = done {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{}: {e}", to.display()));
    }
    Ok(())
}
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn read(root: &Path, p: &str) -> Result<Vec<u8>, String> {
    let at = resolve(root, p)?;
    std::fs::read(&at).map_err(|e| format!("{}: {e}", at.display()))
}

pub fn mkdir(root: &Path, p: &str) -> Result<(), String> {
    let at = make_parents(root, p)?;
    match std::fs::create_dir(&at) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && at.is_dir() => Ok(()),
        Err(e) => Err(format!("{}: {e}", at.display())),
    }
}

pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let a = resolve(root, from)?;
    let b = make_parents(root, to)?;
    std::fs::rename(&a, &b).map_err(|e| format!("{} -> {}: {e}", a.display(), b.display()))
}

/// A file, or a folder with what's in it (links in it removed as links, never followed).
pub fn remove(root: &Path, p: &str) -> Result<(), String> {
    if components(p)?.is_empty() {
        return Err("the workspace's root isn't removed".into());
    }
    let at = resolve(root, p)?;
    match std::fs::symlink_metadata(&at) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(&at),
        Ok(_) => std::fs::remove_file(&at),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
    .map_err(|e| format!("{}: {e}", at.display()))
}

// ---- the page's commands (the main window only: capabilities/default.json)

fn path_header(req: &tauri::ipc::Request) -> Result<String, String> {
    let h = req.headers().get("Sagebrush-Path").ok_or("no path")?.to_str().map_err(|_| "a path that isn't text")?;
    percent_decode(h)
}
fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = b.get(i + 1..i + 3).and_then(|x| std::str::from_utf8(x).ok()).and_then(|x| u8::from_str_radix(x, 16).ok()).ok_or("a bad path")?;
            out.push(h);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "a path that isn't UTF-8".to_string())
}

#[tauri::command]
pub fn disk_list(app: tauri::AppHandle) -> Result<Vec<Entry>, String> {
    list(&root(&app)?)
}

#[tauri::command]
pub fn disk_read(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(read(&root(&app)?, &path)?))
}

/// The bytes are the request's body; the path its Sagebrush-Path header (percent-encoded).
#[tauri::command]
pub fn disk_write(app: tauri::AppHandle, request: tauri::ipc::Request) -> Result<(), String> {
    let p = path_header(&request)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("the bytes must be sent as bytes".into()) };
    write(&root(&app)?, &p, bytes)
}

#[tauri::command]
pub fn disk_mkdir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    mkdir(&root(&app)?, &path)
}

#[tauri::command]
pub fn disk_rename(app: tauri::AppHandle, from: String, to: String) -> Result<(), String> {
    rename(&root(&app)?, &from, &to)
}

#[tauri::command]
pub fn disk_remove(app: tauri::AppHandle, path: String) -> Result<(), String> {
    remove(&root(&app)?, &path)
}

/// The folder the workspace is kept in, for the page to say where the files are.
#[tauri::command]
pub fn disk_where(app: tauri::AppHandle) -> Result<String, String> {
    Ok(root(&app)?.to_string_lossy().into_owned())
}

/// settings.json beside Workspace/: the page's settings (a JSON object), or null when there are none yet.
#[tauri::command]
pub fn settings_read(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let f = root(&app)?.parent().ok_or("no data folder")?.join("settings.json");
    match std::fs::read_to_string(&f) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", f.display())),
    }
}

#[tauri::command]
pub fn settings_write(app: tauri::AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json).map_err(|e| format!("settings: {e}"))?;
    let dir = root(&app)?.parent().ok_or("no data folder")?.to_path_buf();
    let tmp = dir.join(format!(".settings.sbtmp-{}", std::process::id()));
    let done = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(json.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, dir.join("settings.json"))
    })();
    done.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("settings.json: {e}")
    })
}
