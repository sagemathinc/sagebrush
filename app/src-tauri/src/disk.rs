// The app's workspace on the computer's disk: the
// documents and files people make in the app are real files in the OS's own place for an app's data, Tauri's
// app_data_dir (macOS ~/Library/Application Support/space.sagebrush.notebook, Linux $XDG_DATA_HOME/…, by default
// ~/.local/share/…, Windows %APPDATA%\space.sagebrush.notebook), under Workspace/.  The page's workspace
// (IndexedDB, in a web view that keeps nothing between launches) is a cache of it: each launch reads the tree
// (disk_list, disk_read) and every change is written through (disk_write, disk_rename, disk_remove;
// web/workspace/disk-mirror.ts).  settings.json beside Workspace/ holds the page's settings.
//
// Every path the page names is a workspace path ("/a/b.ipynb"), links refused as it is walked, and every change is
// checked against what the page expects the file to be (disk_fs.rs).
use std::path::PathBuf;
use tauri::Manager;
#[path = "disk_fs.rs"]
mod fs;
use fs::*;
#[path = "folder_fs.rs"]
mod folder_fs;
use folder_fs::Grant;

/// The app's data folder (a self-test may name its own, SAGEBRUSH_APP_DATA_DIR).
fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("the app's data folder: {e}"))?;
    Ok(std::env::var_os("SAGEBRUSH_APP_DATA_DIR").map(PathBuf::from).filter(|_| std::env::var_os("SAGEBRUSH_APP_SELFTEST").is_some()).unwrap_or(base))
}
/// Workspace/ under the app's data folder (made if missing; a link refused).
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = data_dir(app)?;
    open_root(&d)?;
    open_root(&d.join("Workspace"))
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

/// The bytes are the request's body; the path its Sagebrush-Path header (percent-encoded), and what the page expects
/// the file to be its Sagebrush-Expect header (disk_fs.rs Expect).  The file as written: {size, mtime, sha256}.
#[tauri::command]
pub fn disk_write(app: tauri::AppHandle, request: tauri::ipc::Request) -> Result<Option<Entry>, String> {
    let p = path_header(&request)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("the bytes must be sent as bytes".into()) };
    let expect = Expect::parse(request.headers().get("Sagebrush-Expect").and_then(|h| h.to_str().ok()))?;
    let root = root(&app)?;
    write(&root, &p, bytes, &expect)?;
    stat(&root, &p)
}

#[tauri::command]
pub fn disk_stat(app: tauri::AppHandle, path: String) -> Result<Option<Entry>, String> {
    stat(&root(&app)?, &path)
}

#[tauri::command]
pub fn disk_mkdir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    mkdir(&root(&app)?, &path)
}

#[tauri::command]
pub fn disk_rename(app: tauri::AppHandle, from: String, to: String, expect: Option<String>) -> Result<(), String> {
    rename(&root(&app)?, &from, &to, &Expect::parse(expect.as_deref())?)
}

#[tauri::command]
pub fn disk_remove(app: tauri::AppHandle, path: String, expect: Option<String>) -> Result<(), String> {
    remove(&root(&app)?, &path, &Expect::parse(expect.as_deref())?)
}

/// The folder the workspace is kept in, for the page to say where the files are.
#[tauri::command]
pub fn disk_where(app: tauri::AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.join("Workspace").to_string_lossy().into_owned())
}

/// The page's settings kept in settings.json: these localStorage keys only (documents' drafts, journals and a
/// GitHub push's settings, which localStorage also holds, are no settings), each a string of at most SETTING_MAX
/// bytes, the file at most SETTINGS_MAX.  settings-init.js gets the list from here; reading and writing both refuse
/// anything else.
pub const SETTINGS_KEYS: &[&str] = &[
    "sagebrush-theme", "sagebrush-reactive", "sagebrush-mode", "sagebrush-phone",
    "sagebrush-files-sort", "sagebrush-files-sidebar", "sagebrush-files-open", "sagebrush-files-recent", "sagebrush-recent-opened",
    "sagebrush-side-w", "sagebrush-board-pen", "sagebrush-board-tools", "sagebrush-latex-follow",
    "sagebrush-term-intro", "sb-term-intro", "sb-term-h", "sagebrush-agents-preview-v1",
];
const SETTING_MAX: usize = 64 * 1024;
const SETTINGS_MAX: usize = 512 * 1024;

/// The settings `json` holds, or why they aren't settings.
fn settings_of(json: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    if json.len() > SETTINGS_MAX {
        return Err(format!("settings: larger than {SETTINGS_MAX} bytes"));
    }
    let o = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(json).map_err(|e| format!("settings: {e}"))?;
    if let Some((k, _)) = o.iter().find(|(k, v)| !SETTINGS_KEYS.contains(&k.as_str()) || !v.as_str().is_some_and(|s| s.len() <= SETTING_MAX)) {
        return Err(format!("settings: {k:?} isn't one of the app's settings, or isn't a string of at most {SETTING_MAX} bytes"));
    }
    Ok(o)
}

/// The script every page of the window runs first: the page's settings, from settings.json (only what settings_of
/// accepts), put in its localStorage once per launch, and each later change of one of them written back
/// (settings-init.js); and any problem reading them, for the page to say (__sbSettingsProblem).
pub fn settings_script(app: &tauri::AppHandle) -> String {
    let mut problem = String::new();
    let kept = match data_dir(app).and_then(|d| open_root(&d)) {
        Err(e) => {
            problem = format!("Sagebrush couldn't read its settings ({e}): it starts with the usual ones.");
            SETTINGS_BLOCKED.store(true, std::sync::atomic::Ordering::SeqCst);
            Default::default()
        }
        Ok(dir) => match read_small(&dir, "settings.json", SETTINGS_MAX as u64).and_then(|s| s.map(|s| settings_of(&s)).transpose()) {
            Ok(o) => o.unwrap_or_default(),
            // (unreadable, too large or not the app's settings: kept aside as settings.json.bad (or .bad-2, …), never
            // written over, and said; the settings start empty.  If it can't be set aside, nothing is written to it)
            Err(why) => {
                let aside = (1..1000).map(|i| if i == 1 { "settings.json.bad".to_string() } else { format!("settings.json.bad-{i}") }).find(|n| !dir.join(n).exists());
                match aside.map(|n| (std::fs::rename(dir.join("settings.json"), dir.join(&n)), n)) {
                    Some((Ok(()), n)) => problem = format!("Sagebrush's settings couldn't be read ({why}): they are kept as {n} in its folder, and it starts with the usual ones."),
                    _ => {
                        SETTINGS_BLOCKED.store(true, std::sync::atomic::Ordering::SeqCst);
                        problem = format!("Sagebrush's settings couldn't be read ({why}), nor set aside: it starts with the usual ones, and won't save settings this time.");
                    }
                }
                Default::default()
            }
        },
    };
    let keys = serde_json::to_string(SETTINGS_KEYS).unwrap_or_else(|_| "[]".into());
    let problem = serde_json::to_string(&problem).unwrap_or_else(|_| "\"\"".into());
    format!("window.__sbSettingsProblem = {problem};\n")
        + &fill_settings_script(include_str!("settings-init.js"), &serde_json::Value::Object(kept).to_string(), &keys)
}
/// (settings.json that couldn't be read nor set aside: not written over this launch)
static SETTINGS_BLOCKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub fn settings_write(app: tauri::AppHandle, json: String) -> Result<(), String> {
    if SETTINGS_BLOCKED.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("settings.json couldn't be read when Sagebrush started, so it isn't written over".into());
    }
    settings_of(&json)?;
    write_small(&open_root(&data_dir(&app)?)?, "settings.json", &json)
}

// ---- a notebook opened from the computer, and the files beside it (folder_fs.rs): through grants made here only,
// for a file the person picked in the app's own Open or Save dialog, or the system handed over; the page names a
// grant, never a path.  The fs plugin isn't the page's on the desktop (capabilities/default.json).

/// The app's grants (its one window's), the newest GRANTS_KEPT only (each id random, never a count another could guess).
#[derive(Default)]
pub struct Grants(std::sync::Mutex<(u64, std::collections::VecDeque<(String, Grant)>)>);
const GRANTS_KEPT: usize = 8;

/// 128 random bits, as hex: two SipHash keys of the system's randomness, each over a fresh count.
fn new_id(n: u64) -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(n);
        h.write_u64(i);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// A grant for `file`, as the page gets it: {grant, name, path} (the path to show, never one the page can use).
pub fn grant(app: &tauri::AppHandle, file: &std::path::Path) -> Result<serde_json::Value, String> {
    let g = folder_fs::grant_for(file)?;
    let (shown, name) = (folder_fs::shown(&g), g.name.clone());
    let state = app.state::<Grants>();
    let mut s = state.0.lock().map_err(|_| "the grants".to_string())?;
    s.0 += 1;
    let id = new_id(s.0);
    s.1.push_back((id.clone(), g));
    while s.1.len() > GRANTS_KEPT {
        s.1.pop_front();
    }
    Ok(serde_json::json!({ "grant": id, "name": name, "path": shown }))
}
fn granted(app: &tauri::AppHandle, id: &str) -> Result<Grant, String> {
    let state = app.state::<Grants>();
    let s = state.0.lock().map_err(|_| "the grants".to_string())?;
    s.1.iter().find(|(k, _)| k == id).map(|(_, g)| g.clone()).ok_or_else(|| "not a file this window was given".to_string())
}

/// The app's Open dialog, over its window: the notebook picked, granted; None if the person cancelled.
#[tauri::command]
pub async fn file_open_dialog(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut b = app.dialog().file().add_filter("Notebooks", &["ipynb", "sage", "py", "m"]);
    if let Some(w) = app.get_webview_window("main") {
        b = b.set_parent(&w);
    }
    let Some(p) = b.blocking_pick_file() else { return Ok(None) };
    grant(&app, &p.into_path().map_err(|e| e.to_string())?).map(Some)
}

/// The app's Save dialog, over its window, proposing the page's `name` made a plain notebook's (folder_fs.rs
/// save_name): the file to save as, always a .ipynb (as_notebook), granted; None if the person cancelled.
#[tauri::command]
pub async fn file_save_dialog(app: tauri::AppHandle, name: String) -> Result<Option<serde_json::Value>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut b = app.dialog().file().set_file_name(folder_fs::save_name(&name)).add_filter("Jupyter notebook", &["ipynb"]);
    if let Some(w) = app.get_webview_window("main") {
        b = b.set_parent(&w);
    }
    let Some(p) = b.blocking_save_file() else { return Ok(None) };
    let picked = p.into_path().map_err(|e| e.to_string())?;
    let p = folder_fs::as_notebook(picked.clone());
    // (.ipynb added here, so the dialog never asked about the file of that name: one there is never written over)
    if p != picked && p.exists() {
        return Err(format!("{} is already there: Save as again, choosing it by its full name to replace it", p.display()));
    }
    grant(&app, &p).map(Some)
}

#[tauri::command]
pub fn file_read_text(app: tauri::AppHandle, grant: String) -> Result<String, String> {
    String::from_utf8(folder_fs::read_own(&granted(&app, &grant)?)?).map_err(|_| "the file isn't UTF-8 text".to_string())
}

#[tauri::command]
pub fn file_write_text(app: tauri::AppHandle, grant: String, text: String) -> Result<(), String> {
    folder_fs::write_own(&granted(&app, &grant)?, text.as_bytes())
}

#[tauri::command]
pub fn folder_list(app: tauri::AppHandle, grant: String) -> Result<Vec<Entry>, String> {
    folder_fs::list_beside(&granted(&app, &grant)?)
}

#[tauri::command]
pub fn folder_read(app: tauri::AppHandle, grant: String, name: String) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(folder_fs::read_beside(&granted(&app, &grant)?, &name)?))
}

/// The bytes are the request's body; the grant its Sagebrush-Grant header, the name its Sagebrush-Name (percent-encoded).
#[tauri::command]
pub fn folder_write(app: tauri::AppHandle, request: tauri::ipc::Request) -> Result<(), String> {
    let grant = request.headers().get("Sagebrush-Grant").ok_or("no grant")?.to_str().map_err(|_| "a grant that isn't text")?.to_string();
    let name = percent_decode(request.headers().get("Sagebrush-Name").ok_or("no name")?.to_str().map_err(|_| "a name that isn't text")?)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("the bytes must be sent as bytes".into()) };
    folder_fs::write_beside(&granted(&app, &grant)?, &name, bytes)
}
