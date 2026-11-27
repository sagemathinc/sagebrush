// The desktop app's windows after the first (#1541: several documents at once, each in its own window).  Each is the
// app's own page, as "main" is (lib.rs page_window: the same navigation guard, the same initialization scripts,
// incognito), with:
//   - its label made here, "doc-<n>", never by a page;
//   - its own web view data folder, <app data>/webviews/<label>, so that each window's storage is its own on every
//     platform (WebKitGTK and WKWebView give each incognito web view its own store; WebView2 shares one per data folder,
//     and Tauri 2.12 doesn't pass a WebView2 profile name): removed when the window closes, and all of them at launch;
//   - its engine (engine.rs, one per window).
// A document is open in one window at a time: the page claims it (window_claim, by its workspace path) when it opens
// it, and a document another window holds focuses that window instead.  Paths here are workspace paths
// ("/a/b.ipynb", disk_fs.rs components), never a computer's.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::Url;

/// The page's port, for the windows opened after the first.
pub struct PagePort(pub u16);

/// The longest page address a window is opened at (a document's query, its path in it).
const AT_MAX: usize = 8192;

/// The address of window page `at` ("/?wsopen=%2Fa.ipynb", "/board/?doc=…"): this page's origin only, an absolute
/// path, nothing else (no other origin, scheme, user or "//host").
pub fn page_target(port: u16, at: &str) -> Result<Url, String> {
    if at.len() > AT_MAX || !at.starts_with('/') || at.starts_with("//") || at.contains('\\') || at.chars().any(|c| c.is_control()) {
        return Err("not one of this app's pages".into());
    }
    let base: Url = format!("http://127.0.0.1:{port}/").parse().map_err(|_| "no page address")?;
    let u = base.join(at).map_err(|_| "not one of this app's pages")?;
    if u.scheme() != "http" || !crate::nav::may_load(&u, port) {
        return Err("not one of this app's pages".into());
    }
    Ok(u)
}

/// Whether `label` is one this module made ("doc-" and a number).
pub fn is_doc_label(label: &str) -> bool {
    label.strip_prefix("doc-").is_some_and(|n| !n.is_empty() && n.len() <= 9 && n.bytes().all(|b| b.is_ascii_digit()))
}

/// The web view data folder of window `label`, under `data`; none for any label this module didn't make ("main"
/// keeps the default).
pub fn webview_dir(data: &Path, label: &str) -> Option<PathBuf> {
    is_doc_label(label).then(|| data.join("webviews").join(label))
}

/// Which window holds which document, by workspace path: one window per document.
#[derive(Default)]
pub struct Docs(Mutex<HashMap<String, String>>);

/// What a claim found.
#[derive(Debug, PartialEq)]
pub enum Claim {
    /// The document is this window's now (no other window holds it).
    Mine,
    /// Another window holds it: that window's label.
    Elsewhere(String),
}

impl Docs {
    /// Window `label` claims document `doc`: it holds it from now, unless another window holds it that still exists
    /// (`alive`; a window that doesn't loses its claims).  A window shows one document: its other claims end with a
    /// new one.
    pub fn claim(&self, doc: &str, label: &str, alive: impl Fn(&str) -> bool) -> Claim {
        let mut m = self.0.lock().unwrap();
        if let Some(holder) = m.get(doc) {
            if holder != label && alive(holder) {
                return Claim::Elsewhere(holder.clone());
            }
        }
        m.retain(|_, l| l != label);
        m.insert(doc.to_string(), label.to_string());
        Claim::Mine
    }
    /// The window that holds document `doc`, if it still exists (`alive`).
    pub fn holder_alive(&self, doc: &str, alive: impl Fn(&str) -> bool) -> Option<String> {
        self.0.lock().unwrap().get(doc).filter(|l| alive(l)).cloned()
    }
    /// Every claim of window `label` ends (it closed).
    pub fn release_window(&self, label: &str) {
        self.0.lock().unwrap().retain(|_, l| l != label);
    }
    #[cfg(test)]
    pub fn holder(&self, doc: &str) -> Option<String> {
        self.0.lock().unwrap().get(doc).cloned()
    }
}

/// The next window's number.
pub struct NextWindow(pub AtomicU32);
impl Default for NextWindow {
    fn default() -> Self {
        NextWindow(AtomicU32::new(1))
    }
}

/// The web view data folders of a previous launch's windows: removed (best effort) before any window opens.
pub fn clear_webview_dirs(data: &Path) {
    let _ = std::fs::remove_dir_all(data.join("webviews"));
}

// ---- the page's commands (capabilities/default.json: "main" and "doc-*")

/// A new window at this app's page `at` (lib.rs page_window, its own data folder): File ▸ New window, or a workspace
/// document `doc` opened in a window of its own (at "/?wsopen=<doc>", or the board's page).  A document another window
/// shows brings that window to the front instead, and no window opens; else the new window holds it from the start
/// (its page's own claim then finds it its own).  {label, opened}.  Async: a window made in a synchronous command
/// deadlocks on Windows (WebView2 waits on the thread the command holds; Tauri's own warning), which the self-test's
/// two-window probe hit there.
#[cfg(desktop)]
#[tauri::command]
pub async fn window_open(app: tauri::AppHandle, port: tauri::State<'_, PagePort>, next: tauri::State<'_, NextWindow>, docs: tauri::State<'_, Docs>, at: String, doc: Option<String>) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let url = page_target(port.0, &at)?;
    if let Some(d) = &doc {
        crate::disk::workspace_path(d)?;
        if let Some(holder) = docs.holder_alive(d, |l| app.get_webview_window(l).is_some()) {
            focus(&app, &holder);
            return Ok(serde_json::json!({ "label": holder, "opened": false }));
        }
    }
    let label = format!("doc-{}", next.0.fetch_add(1, Ordering::SeqCst));
    let data = crate::disk::data_dir(&app)?;
    let dir = webview_dir(&data, &label).ok_or("no window label")?;
    crate::page_window(&app, &label, url, port.0, false).data_directory(dir).build().map_err(|e| format!("the window didn't open: {e}"))?;
    if let Some(d) = &doc {
        docs.claim(d, &label, |l| app.get_webview_window(l).is_some());
    }
    Ok(serde_json::json!({ "label": label, "opened": true }))
}

/// Window `label` to the front.
#[cfg(desktop)]
fn focus(app: &tauri::AppHandle, label: &str) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The asking window opens workspace document `doc`: null if it's this window's now, else the label of the window
/// that has it, which is brought to the front.
#[cfg(desktop)]
#[tauri::command]
pub fn window_claim(app: tauri::AppHandle, webview: tauri::Webview, docs: tauri::State<Docs>, doc: String) -> Result<Option<String>, String> {
    use tauri::Manager;
    crate::disk::workspace_path(&doc)?;
    match docs.claim(&doc, webview.label(), |l| app.get_webview_window(l).is_some()) {
        Claim::Mine => Ok(None),
        Claim::Elsewhere(holder) => {
            focus(&app, &holder);
            Ok(Some(holder))
        }
    }
}

/// Window `label` closed: its claims end, and its data folder goes (best effort; what a web view still holds open is
/// left for the next launch's clear_webview_dirs).
#[cfg(desktop)]
pub fn closed(app: &tauri::AppHandle, label: &str) {
    use tauri::Manager;
    app.state::<Docs>().release_window(label);
    if let Ok(data) = crate::disk::data_dir(app) {
        if let Some(dir) = webview_dir(&data, label) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_opens_only_this_apps_pages() {
        for at in ["/", "/?wsopen=%2Fa%20b.ipynb", "/board/?doc=local:abc", "/?tex=0123abcd"] {
            let u = page_target(49214, at).unwrap();
            assert_eq!(u.origin().ascii_serialization(), "http://127.0.0.1:49214", "{at}");
        }
        for at in ["", "?x", "//evil.example/", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", "file:///etc/passwd", "/\n", &format!("/{}", "a".repeat(AT_MAX))] {
            assert!(page_target(49214, at).is_err(), "{at:?} accepted");
        }
    }

    #[test]
    fn only_this_modules_labels_get_a_folder() {
        let d = Path::new("/data");
        assert_eq!(webview_dir(d, "doc-1"), Some(PathBuf::from("/data/webviews/doc-1")));
        assert_eq!(webview_dir(d, "doc-123456789"), Some(PathBuf::from("/data/webviews/doc-123456789")));
        for l in ["main", "doc-", "doc-x", "doc-1/../..", "doc-../x", "doc-1234567890", "../doc-1", "doc-1 "] {
            assert_eq!(webview_dir(d, l), None, "{l:?}");
        }
    }

    #[test]
    fn a_document_is_open_in_one_window() {
        let docs = Docs::default();
        let all = |_: &str| true;
        assert_eq!(docs.claim("/a.ipynb", "main", all), Claim::Mine);
        // (another window: the holder's label, nothing taken)
        assert_eq!(docs.claim("/a.ipynb", "doc-1", all), Claim::Elsewhere("main".into()));
        assert_eq!(docs.holder("/a.ipynb").as_deref(), Some("main"));
        // (the holder claiming again: still its)
        assert_eq!(docs.claim("/a.ipynb", "main", all), Claim::Mine);
        // (a window opening another document lets its first one go)
        assert_eq!(docs.claim("/b.ipynb", "main", all), Claim::Mine);
        assert_eq!(docs.holder("/a.ipynb"), None);
        assert_eq!(docs.claim("/a.ipynb", "doc-1", all), Claim::Mine);
        assert_eq!(docs.holder("/a.ipynb").as_deref(), Some("doc-1"));
        // (a holder that no longer exists loses its claim)
        assert_eq!(docs.claim("/c.ipynb", "doc-2", all), Claim::Mine);
        assert_eq!(docs.claim("/c.ipynb", "doc-3", |l| l != "doc-2"), Claim::Mine);
        assert_eq!(docs.holder("/c.ipynb").as_deref(), Some("doc-3"));
        // (who holds it, if it still exists: what opening it in a new window asks first)
        assert_eq!(docs.holder_alive("/c.ipynb", |_| true).as_deref(), Some("doc-3"));
        assert_eq!(docs.holder_alive("/c.ipynb", |l| l != "doc-3"), None);
        assert_eq!(docs.holder_alive("/none.ipynb", |_| true), None);
        // (a closed window's claims all end)
        docs.release_window("doc-3");
        assert_eq!(docs.holder("/c.ipynb"), None);
        assert_eq!(docs.holder("/b.ipynb").as_deref(), Some("main"));
    }
}
