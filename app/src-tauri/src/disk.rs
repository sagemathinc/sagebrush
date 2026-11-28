// The app's workspace on the computer's disk: the
// documents and files people make in the app are real files in the OS's own place for an app's data, Tauri's
// app_data_dir (macOS ~/Library/Application Support/space.sagebrush.notebook, Linux $XDG_DATA_HOME/…, by default
// ~/.local/share/…, Windows %APPDATA%\space.sagebrush.notebook), under Workspace/.  The page's workspace
// (IndexedDB, in a web view that keeps nothing between launches) is a cache of it: each launch reads the tree
// (disk_list, disk_read) and every change is written through (disk_write, disk_rename, disk_remove;
// web/workspace/disk-mirror.ts).  settings.json beside Workspace/ holds the page's settings, agent-threads.json its
// agents' chats.
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
pub fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("the app's data folder: {e}"))?;
    Ok(std::env::var_os("SAGEBRUSH_APP_DATA_DIR").map(PathBuf::from).filter(|_| std::env::var_os("SAGEBRUSH_APP_SELFTEST").is_some()).unwrap_or(base))
}
/// Workspace/ under the app's data folder (made if missing; a link refused).
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = data_dir(app)?;
    open_root(&d)?;
    open_root(&d.join("Workspace"))
}

/// Whether `p` is a workspace path ("/a/b.ipynb", as every disk command takes it).
pub fn workspace_path(p: &str) -> Result<(), String> {
    components(p).map(|_| ())
}

/// Window `from` changed the workspace on disk (`what` "sb-disk-changed") or grants.json ("sb-grants-changed"): the
/// app's other windows are told, to read it again (#1541: web/workspace/disk-mirror.ts DiskMirror.pull,
/// grants-file.ts adoptGrants).  Every window hears it (a page listens for any window's events); each leaves out its
/// own.
fn told(app: &tauri::AppHandle, from: &tauri::Webview, what: &str) {
    use tauri::Emitter;
    if app.webview_windows().len() > 1 {
        let _ = app.emit(what, serde_json::json!({ "from": from.label() }));
    }
}
fn changed(app: &tauri::AppHandle, from: &tauri::Webview) {
    told(app, from, "sb-disk-changed");
}

// ---- the page's commands (the app's windows: capabilities/default.json)

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
pub fn disk_write(app: tauri::AppHandle, webview: tauri::Webview, request: tauri::ipc::Request) -> Result<Option<Entry>, String> {
    let p = path_header(&request)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("the bytes must be sent as bytes".into()) };
    let expect = Expect::parse(request.headers().get("Sagebrush-Expect").and_then(|h| h.to_str().ok()))?;
    let root = root(&app)?;
    write(&root, &p, bytes, &expect)?;
    changed(&app, &webview);
    stat(&root, &p)
}

#[tauri::command]
pub fn disk_stat(app: tauri::AppHandle, path: String) -> Result<Option<Entry>, String> {
    stat(&root(&app)?, &path)
}

#[tauri::command]
pub fn disk_mkdir(app: tauri::AppHandle, webview: tauri::Webview, path: String) -> Result<(), String> {
    mkdir(&root(&app)?, &path)?;
    changed(&app, &webview);
    Ok(())
}

#[tauri::command]
pub fn disk_rename(app: tauri::AppHandle, webview: tauri::Webview, from: String, to: String, expect: Option<String>) -> Result<(), String> {
    rename(&root(&app)?, &from, &to, &Expect::parse(expect.as_deref())?)?;
    changed(&app, &webview);
    Ok(())
}

#[tauri::command]
pub fn disk_remove(app: tauri::AppHandle, webview: tauri::Webview, path: String, expect: Option<String>) -> Result<(), String> {
    remove(&root(&app)?, &path, &Expect::parse(expect.as_deref())?)?;
    changed(&app, &webview);
    Ok(())
}

/// The folder the workspace is kept in, for the page to say where the files are.
#[tauri::command]
pub fn disk_where(app: tauri::AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.join("Workspace").to_string_lossy().into_owned())
}

/// Show in folder: the system's file manager at workspace path `path` ("/" the workspace's own folder), never
/// anything outside Workspace/ (disk_fs.rs reveal_target).  The file manager is started and left running; its exit is
/// waited for on a thread of its own, so it leaves no zombie.
#[tauri::command]
pub fn disk_reveal(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let (at, dir) = reveal_target(&root(&app)?, &path)?;
    let (program, args) = reveal_argv(&at, dir);
    let mut cmd = std::process::Command::new(&program);
    #[cfg(windows)]
    {
        // (explorer's "/select,<path>" passed as written: Rust's quoting of an argument with a comma isn't explorer's)
        use std::os::windows::process::CommandExt;
        for a in &args {
            cmd.raw_arg(a);
        }
    }
    #[cfg(not(windows))]
    cmd.args(&args);
    let mut child = cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().map_err(|e| format!("couldn't open the folder ({program}): {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// The page's settings kept in settings.json: these localStorage keys only (documents' drafts, journals and a
/// GitHub push's settings, which localStorage also holds, are no settings), each a string of at most SETTING_MAX
/// bytes, the file at most SETTINGS_MAX; but the agents page's chats (THREADS_KEY) in a file of their own.
/// settings-init.js gets the list from here; reading and writing both refuse anything else.
pub const SETTINGS_KEYS: &[&str] = &[
    "sagebrush-theme", "sagebrush-reactive", "sagebrush-mode", "sagebrush-phone",
    "sagebrush-files-sort", "sagebrush-files-sidebar", "sagebrush-files-open", "sagebrush-files-recent", "sagebrush-recent-opened",
    "sagebrush-side-w", "sagebrush-board-pen", "sagebrush-board-tools", "sagebrush-latex-follow",
    "sagebrush-term-intro", "sb-term-intro", "sb-term-h", "sagebrush-agents-preview-v1",
];
const SETTING_MAX: usize = 64 * 1024;
const SETTINGS_MAX: usize = 512 * 1024;

/// The agents page's chats (web/agents/page.ts STORE), each thread with its whole transcript: no small preference, so
/// kept in agent-threads.json beside settings.json, the page's value as it is (not JSON-escaped again), and bounded
/// only by what the page's own storage holds.  The web views' localStorage holds at most 5 MiB of UTF-16 units per
/// site, keys and values together: measured with web/measure-local-storage.mjs, the longest value under a one-letter
/// key 5,242,879 units of ASCII, Latin-1 or other BMP text in Chromium (149, Windows' WebView2's), 15,728,637 bytes of
/// UTF-8 at the most; and in WebKit (27.2, the engine of macOS's and Linux's web views) 5,242,879 units of ASCII or
/// Latin-1 but 2,621,439 of other text, 10,485,758 bytes at the most.  A unit is at most 3 bytes of UTF-8, so no value
/// the page could store is larger than THREADS_MAX; one that is, isn't the page's.  (settings.json may still hold the chats, as an older app kept them: read from there while
/// agent-threads.json has none, and moved at the next change)
const THREADS_KEY: &str = "sagebrush-agents-preview-v1";
const THREADS_FILE: &str = "agent-threads.json";
const LOCAL_STORAGE_UNITS: usize = 5 * 1024 * 1024;
const THREADS_MAX: usize = 3 * LOCAL_STORAGE_UNITS;

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
    let (kept, problem) = match data_dir(app).and_then(|d| open_root(&d)) {
        Err(e) => {
            SETTINGS_BLOCKED.store(true, std::sync::atomic::Ordering::SeqCst);
            (Default::default(), format!("Sagebrush couldn't read its settings ({e}): it starts with the usual ones."))
        }
        Ok(dir) => {
            let (kept, problems) = settings_kept(&dir);
            (kept, problems.join(" "))
        }
    };
    let keys = serde_json::to_string(SETTINGS_KEYS).unwrap_or_else(|_| "[]".into());
    let problem = serde_json::to_string(&problem).unwrap_or_else(|_| "\"\"".into());
    format!("window.__sbSettingsProblem = {problem};\n")
        + &fill_settings_script(include_str!("settings-init.js"), &serde_json::Value::Object(kept).to_string(), &keys)
}
/// (settings.json or agent-threads.json that couldn't be read nor set aside: neither written over this launch)
static SETTINGS_BLOCKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The settings a launch starts with, settings.json's and the chats, and what it says of a file it couldn't read.
/// (unreadable, too large or not the app's: kept aside as settings.json.bad (or .bad-2, …), agent-threads.json.bad,
/// never written over, and said; what it held starts empty.  If it can't be set aside, nothing is written to either)
fn settings_kept(dir: &std::path::Path) -> (serde_json::Map<String, serde_json::Value>, Vec<String>) {
    let aside = |name: &str, what: &str, why: String, start: &str| {
        let n = (1..1000).map(|i| if i == 1 { format!("{name}.bad") } else { format!("{name}.bad-{i}") }).find(|n| !dir.join(n).exists());
        match n.map(|n| (std::fs::rename(dir.join(name), dir.join(&n)), n)) {
            Some((Ok(()), n)) => format!("Sagebrush's {what} couldn't be read ({why}): they are kept as {n} in its folder, and it starts with {start}."),
            _ => {
                SETTINGS_BLOCKED.store(true, std::sync::atomic::Ordering::SeqCst);
                format!("Sagebrush's {what} couldn't be read ({why}), nor set aside: it starts with {start}, and won't save settings this time.")
            }
        }
    };
    let mut problems = vec![];
    let mut kept = settings_file(dir).unwrap_or_else(|why| {
        problems.push(aside("settings.json", "settings", why, "the usual ones"));
        Default::default()
    });
    match threads_file(dir) {
        Ok(Some(t)) => {
            kept.insert(THREADS_KEY.into(), t.into());
        }
        Ok(None) => {}
        Err(why) => problems.push(aside(THREADS_FILE, "agents' chats", why, "none")),
    }
    (kept, problems)
}

/// settings.json's settings now: none if there is no settings.json; an error if it isn't the app's settings (another
/// program's: never written over).
fn settings_file(dir: &std::path::Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    Ok(read_small(dir, "settings.json", SETTINGS_MAX as u64)?.map(|s| settings_of(&s)).transpose()?.unwrap_or_default())
}
/// agent-threads.json's chats now: none if there is none; an error if it is larger than the page could store, or not
/// text.
fn threads_file(dir: &std::path::Path) -> Result<Option<String>, String> {
    read_small(dir, THREADS_FILE, THREADS_MAX as u64)
}
/// The settings now: settings.json's, and the chats in agent-threads.json (else as settings.json may have them).
fn settings_now(dir: &std::path::Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let mut o = settings_file(dir)?;
    if let Some(t) = threads_file(dir)? {
        o.insert(THREADS_KEY.into(), t.into());
    }
    Ok(o)
}
/// The app's windows each change some settings (#1541): a window's change is its keys alone (`set`, `remove`), merged
/// into settings.json as it is, one change at a time, so no window writes back another's settings as they were.
/// Each key's version, for this run of the app: a change merged gives each key it names the next one, so a window can
/// tell a value it read or wrote from one older than what it has already seen (settings-init.js drops those).
struct SettingsVersions {
    last: u64,
    of: std::collections::BTreeMap<String, u64>,
}
static SETTINGS_LOCK: std::sync::Mutex<SettingsVersions> = std::sync::Mutex::new(SettingsVersions { last: 0, of: std::collections::BTreeMap::new() });
/// The change merged, one at a time; the versions it gave its keys.
fn settings_change(dir: &std::path::Path, set: serde_json::Map<String, serde_json::Value>, remove: &[String]) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let mut v = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut cur = settings_file(dir)?;
    let on_file = threads_file(dir)?;
    if let Some(t) = &on_file {
        cur.insert(THREADS_KEY.into(), t.clone().into());
    }
    for k in remove {
        cur.remove(k);
    }
    let keys: Vec<String> = set.keys().cloned().chain(remove.iter().cloned()).collect();
    cur.extend(set);
    // (the chats to agent-threads.json, the rest to settings.json; both checked before either is written, and the chats
    // written first, whenever they aren't what agent-threads.json holds (an older settings.json's moved): so a change
    // that fails between them leaves agent-threads.json, which is read first, the newer)
    let threads = match cur.remove(THREADS_KEY) {
        None => None,
        Some(serde_json::Value::String(s)) if s.len() <= THREADS_MAX => Some(s),
        Some(_) => return Err(format!("settings: {THREADS_KEY:?} isn't a string of at most {THREADS_MAX} bytes (more than the page's storage holds)")),
    };
    let json = serde_json::Value::Object(cur).to_string();
    settings_of(&json)?;
    if threads != on_file {
        match &threads {
            Some(t) => write_small(dir, THREADS_FILE, t)?,
            None => remove_small(dir, THREADS_FILE)?,
        }
    }
    write_small(dir, "settings.json", &json)?;
    let mut given = serde_json::Map::new();
    for k in keys {
        v.last += 1;
        let n = v.last;
        v.of.insert(k.clone(), n);
        given.insert(k, n.into());
    }
    Ok(given)
}
/// The settings now, with each key's version (0: not changed this run), read under the same lock as a change.
fn settings_versioned(dir: &std::path::Path) -> Result<serde_json::Value, String> {
    let v = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let values = settings_now(dir)?;
    let versions: serde_json::Map<String, serde_json::Value> = v.of.iter().map(|(k, n)| (k.clone(), (*n).into())).collect();
    Ok(serde_json::json!({ "values": values, "versions": versions }))
}

/// The asking window's change of the settings (settings-init.js): its keys' new values and the keys it removed; the
/// versions it gave them.  The other windows are told, to read them again (settings_read).
#[tauri::command]
pub fn settings_write(app: tauri::AppHandle, webview: tauri::Webview, set: serde_json::Map<String, serde_json::Value>, remove: Vec<String>) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    if SETTINGS_BLOCKED.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("settings.json couldn't be read when Sagebrush started, so it isn't written over".into());
    }
    let given = settings_change(&open_root(&data_dir(&app)?)?, set, &remove)?;
    told(&app, &webview, "sb-settings-changed");
    Ok(given)
}

/// The settings as settings.json has them now, with each key's version ({values, versions}), for a window another
/// one's change was told to.
#[tauri::command]
pub fn settings_read(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    settings_versioned(&open_root(&data_dir(&app)?)?)
}

/// The page's file permissions kept across launches, in grants.json beside settings.json: the record permissions.js
/// keeps in localStorage (whose web view forgets it at quit), its documents named by where they are ("ws:" and a
/// workspace notebook's path, or a notebook file's own "file:" id), since a workspace notebook's id is new at every
/// launch (web/workspace/grants-file.ts). A JSON object {v: 1, docs: {...}} of at most GRANTS_MAX bytes; anything
/// else is refused, and a grants.json that isn't one is read as none (nothing allowed: a prompt comes back).
const GRANTS_MAX: usize = 1024 * 1024;
fn grants_of(json: &str) -> Result<(), String> {
    if json.len() > GRANTS_MAX {
        return Err(format!("grants: larger than {GRANTS_MAX} bytes"));
    }
    let v = serde_json::from_str::<serde_json::Value>(json).map_err(|e| format!("grants: {e}"))?;
    if v.get("v").and_then(|x| x.as_u64()) != Some(1) || !v.get("docs").is_some_and(|d| d.is_object()) {
        return Err("grants: not the page's record ({v: 1, docs})".into());
    }
    Ok(())
}

#[tauri::command]
pub fn grants_read(app: tauri::AppHandle) -> Result<String, String> {
    grants_now(&open_root(&data_dir(&app)?)?)
}

/// grants.json as the page reads it: the page's record, or "" (none, or not a record).
fn grants_now(dir: &std::path::Path) -> Result<String, String> {
    Ok(read_small(dir, "grants.json", GRANTS_MAX as u64)?.filter(|s| grants_of(s).is_ok()).unwrap_or_default())
}
/// The app's windows each write the whole record (#1541), so a write is made only over the grants.json its window last
/// read or wrote (`expect`, its text as grants_read gave it, "" for none): else it is refused, and the page merges what
/// is there and writes again (web/workspace/grants-file.ts grantsSync).  One read-compare-write at a time.
static GRANTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub const GRANTS_CHANGED: &str = "grants.json was changed by another window";
fn grants_swap(dir: &std::path::Path, json: &str, expect: &str) -> Result<(), String> {
    grants_of(json)?;
    let _held = GRANTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if grants_now(dir)? != expect {
        return Err(GRANTS_CHANGED.into());
    }
    write_small(dir, "grants.json", json)
}

#[tauri::command]
pub fn grants_write(app: tauri::AppHandle, webview: tauri::Webview, json: String, expect: String) -> Result<(), String> {
    grants_swap(&open_root(&data_dir(&app)?)?, &json, &expect)?;
    told(&app, &webview, "sb-grants-changed");
    Ok(())
}

#[cfg(test)]
mod settings_tests {
    use serde_json::json;

    #[test]
    fn a_window_s_change_is_its_keys_alone() {
        let dir = std::env::temp_dir().join(format!("sb-settings-change-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let obj = |v: serde_json::Value| v.as_object().unwrap().clone();
        let now = || super::settings_now(&dir).unwrap();
        // (none yet: a change makes it, and versions its key)
        let v1 = super::settings_change(&dir, obj(json!({ "sagebrush-theme": "dark" })), &[]).unwrap()["sagebrush-theme"].as_u64().unwrap();
        // (another window changes another key: the first's stays, as it is, not as that window last read it)
        super::settings_change(&dir, obj(json!({ "sagebrush-files-sort": "name" })), &[]).unwrap();
        assert_eq!(serde_json::Value::Object(now()), json!({ "sagebrush-theme": "dark", "sagebrush-files-sort": "name" }));
        // (each change of a key a later version than the last, which a read gives with the values)
        let v2 = super::settings_change(&dir, obj(json!({ "sagebrush-theme": "solar" })), &[]).unwrap()["sagebrush-theme"].as_u64().unwrap();
        assert!(v2 > v1);
        let r = super::settings_versioned(&dir).unwrap();
        assert_eq!(r["values"]["sagebrush-theme"], "solar");
        assert_eq!(r["versions"]["sagebrush-theme"].as_u64(), Some(v2));
        // (a removal removes its key alone)
        super::settings_change(&dir, obj(json!({})), &["sagebrush-theme".into()]).unwrap();
        assert_eq!(serde_json::Value::Object(now()), json!({ "sagebrush-files-sort": "name" }));
        // (a key that isn't one of the app's settings: refused, nothing written)
        assert!(super::settings_change(&dir, obj(json!({ "not-a-setting": "x" })), &[]).is_err());
        assert_eq!(serde_json::Value::Object(now()), json!({ "sagebrush-files-sort": "name" }));
        // (settings.json made by another program, not the app's: never written over)
        std::fs::write(dir.join("settings.json"), "not json").unwrap();
        assert!(super::settings_change(&dir, obj(json!({ "sagebrush-theme": "dark" })), &[]).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("settings.json")).unwrap(), "not json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn fresh(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sb-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    /// A chat as the agents page stores it, of about `n` bytes: its JSON, quotes, newlines, other scripts and a line
    /// separator in its text.
    fn chat(n: usize) -> String {
        let text = "a reply, \"quoted\",\nover lines: Größe \u{4e2d} \u{1F600} \u{2028}. ".repeat(n / 60 + 1);
        json!({ "threads": [{ "id": "t1", "title": "A chat", "transcript": [{ "role": "user", "text": "hi" }, { "role": "assistant", "text": text }] }] }).to_string()
    }

    #[test]
    fn a_chat_larger_than_a_setting_round_trips() {
        // (S08: a chat of 79,709 bytes, more than a setting's SETTING_MAX, which settings.json alone refused)
        let dir = fresh("chat");
        let obj = |v: serde_json::Value| v.as_object().unwrap().clone();
        let big = chat(79_709);
        assert!(big.len() > super::SETTING_MAX);
        assert!(super::settings_of(&json!({ super::THREADS_KEY: big }).to_string()).is_err());
        let given = super::settings_change(&dir, obj(json!({ super::THREADS_KEY: big, "sagebrush-theme": "dark" })), &[]).unwrap();
        assert!(given[super::THREADS_KEY].as_u64().is_some());
        // (the chat in agent-threads.json as the page stored it, settings.json the small settings alone)
        assert_eq!(std::fs::read_to_string(dir.join(super::THREADS_FILE)).unwrap(), big);
        assert_eq!(std::fs::read_to_string(dir.join("settings.json")).unwrap(), json!({ "sagebrush-theme": "dark" }).to_string());
        // (and back: to another window's read, and to the next launch's pages, as it was)
        assert_eq!(super::settings_versioned(&dir).unwrap()["values"][super::THREADS_KEY], big);
        let (kept, problems) = super::settings_kept(&dir);
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(kept[super::THREADS_KEY], big);
        assert_eq!(kept["sagebrush-theme"], "dark");
        let script = super::fill_settings_script("const KEYS = /*KEYS*/[]; const saved = /*SETTINGS*/null;", &serde_json::Value::Object(kept).to_string(), "[]");
        let saved: serde_json::Value = serde_json::from_str(script.strip_prefix("const KEYS = []; const saved = ").unwrap().strip_suffix(';').unwrap()).unwrap();
        assert_eq!(saved[super::THREADS_KEY], big);
        // (another key's change leaves the chat as it is; its removal removes the file)
        super::settings_change(&dir, obj(json!({ "sagebrush-theme": "light" })), &[]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(super::THREADS_FILE)).unwrap(), big);
        super::settings_change(&dir, obj(json!({})), &[super::THREADS_KEY.into()]).unwrap();
        assert!(!dir.join(super::THREADS_FILE).exists());
        assert_eq!(serde_json::Value::Object(super::settings_now(&dir).unwrap()), json!({ "sagebrush-theme": "light" }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chats_up_to_what_the_page_s_storage_holds() {
        let dir = fresh("budget");
        let obj = |v: serde_json::Value| v.as_object().unwrap().clone();
        // (the most the page could store: taken; a byte more isn't the page's, refused, and nothing written)
        let most = "\u{4e2d}".repeat(super::LOCAL_STORAGE_UNITS);
        assert_eq!(most.len(), super::THREADS_MAX);
        super::settings_change(&dir, obj(json!({ super::THREADS_KEY: most })), &[]).unwrap();
        assert_eq!(std::fs::metadata(dir.join(super::THREADS_FILE)).unwrap().len() as usize, super::THREADS_MAX);
        let over = "a".repeat(super::THREADS_MAX + 1);
        assert!(super::settings_change(&dir, obj(json!({ super::THREADS_KEY: over, "sagebrush-theme": "dark" })), &[]).is_err());
        assert_eq!(std::fs::metadata(dir.join(super::THREADS_FILE)).unwrap().len() as usize, super::THREADS_MAX);
        assert!(!dir.join("settings.json").exists() || super::settings_file(&dir).unwrap().get("sagebrush-theme").is_none());
        // (nor anything but a string)
        assert!(super::settings_change(&dir, obj(json!({ super::THREADS_KEY: 3 })), &[]).is_err());
        // (an agent-threads.json larger than that, another program's: set aside and said at launch, the settings kept)
        std::fs::write(dir.join(super::THREADS_FILE), &over).unwrap();
        std::fs::write(dir.join("settings.json"), json!({ "sagebrush-theme": "dark" }).to_string()).unwrap();
        assert!(super::settings_change(&dir, obj(json!({ "sagebrush-theme": "light" })), &[]).is_err());
        let (kept, problems) = super::settings_kept(&dir);
        assert_eq!(serde_json::Value::Object(kept), json!({ "sagebrush-theme": "dark" }));
        assert!(problems.len() == 1 && problems[0].contains("agent-threads.json.bad"), "{problems:?}");
        assert_eq!(std::fs::read_to_string(dir.join("agent-threads.json.bad")).unwrap(), over);
        assert!(!dir.join(super::THREADS_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_older_app_s_chats_in_settings_json_move_to_their_file() {
        let dir = fresh("older");
        let obj = |v: serde_json::Value| v.as_object().unwrap().clone();
        let old = chat(1000);
        std::fs::write(dir.join("settings.json"), json!({ "sagebrush-theme": "dark", super::THREADS_KEY: old }).to_string()).unwrap();
        // (read from settings.json while agent-threads.json has none)
        assert_eq!(super::settings_now(&dir).unwrap()[super::THREADS_KEY], old);
        assert_eq!(super::settings_kept(&dir).0[super::THREADS_KEY], old);
        // (another key's change moves them)
        super::settings_change(&dir, obj(json!({ "sagebrush-theme": "light" })), &[]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(super::THREADS_FILE)).unwrap(), old);
        assert_eq!(std::fs::read_to_string(dir.join("settings.json")).unwrap(), json!({ "sagebrush-theme": "light" }).to_string());
        // (and agent-threads.json, once there, is read first: a change that failed after writing it left the newer)
        let newer = chat(2000);
        std::fs::write(dir.join(super::THREADS_FILE), &newer).unwrap();
        std::fs::write(dir.join("settings.json"), json!({ "sagebrush-theme": "light", super::THREADS_KEY: old }).to_string()).unwrap();
        assert_eq!(super::settings_now(&dir).unwrap()[super::THREADS_KEY], newer);
        // (removed, from both)
        super::settings_change(&dir, obj(json!({})), &[super::THREADS_KEY.into()]).unwrap();
        assert!(!dir.join(super::THREADS_FILE).exists());
        assert_eq!(serde_json::Value::Object(super::settings_now(&dir).unwrap()), json!({ "sagebrush-theme": "light" }));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod grants_tests {
    use super::grants_of;

    #[test]
    fn a_write_only_over_what_its_window_last_saw() {
        let dir = std::env::temp_dir().join(format!("sb-grants-swap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b, c) = (r#"{"v":1,"docs":{"file:/a":{"write":["/x"]}}}"#, r#"{"v":1,"docs":{}}"#, r#"{"v":1,"docs":{"file:/c":{}}}"#);
        // (none there: only a write expecting none)
        assert_eq!(super::grants_swap(&dir, a, b), Err(super::GRANTS_CHANGED.into()));
        assert_eq!(super::grants_swap(&dir, a, ""), Ok(()));
        // (a window that saw the first record takes the permission back; another that also saw only the first can't
        // write over that, nor can one expecting none)
        assert_eq!(super::grants_swap(&dir, b, a), Ok(()));
        assert_eq!(super::grants_swap(&dir, c, a), Err(super::GRANTS_CHANGED.into()));
        assert_eq!(super::grants_swap(&dir, c, ""), Err(super::GRANTS_CHANGED.into()));
        assert_eq!(super::grants_now(&dir).unwrap(), b);
        // (one that read it after can)
        assert_eq!(super::grants_swap(&dir, c, b), Ok(()));
        assert_eq!(super::grants_now(&dir).unwrap(), c);
        // (a grants.json that isn't a record reads as none, and is written over only by a write expecting none)
        std::fs::write(dir.join("grants.json"), "not json").unwrap();
        assert_eq!(super::grants_now(&dir).unwrap(), "");
        assert_eq!(super::grants_swap(&dir, a, c), Err(super::GRANTS_CHANGED.into()));
        assert_eq!(super::grants_swap(&dir, a, ""), Ok(()));
        // (and never a write that isn't a record)
        assert!(super::grants_swap(&dir, "not json", a).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_page_s_record_within_its_cap() {
        assert!(grants_of(r#"{"v":1,"seq":3,"docs":{"ws:/a/b.ipynb":{"write":["/a"],"t":3}}}"#).is_ok());
        for bad in [r#"{"v":2,"docs":{}}"#, r#"{"docs":{}}"#, r#"{"v":1,"docs":[]}"#, r#"[1]"#, "not json", ""] {
            assert!(grants_of(bad).is_err(), "{bad}");
        }
        let big = format!(r#"{{"v":1,"docs":{{"x":"{}"}}}}"#, "a".repeat(super::GRANTS_MAX));
        assert!(grants_of(&big).is_err());
    }
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
