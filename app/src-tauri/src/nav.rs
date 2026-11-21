// Who reaches the app's commands (the workspace on disk, the settings, quitting, the fs plugin, the engine): only the
// app's own page, at http://127.0.0.1:<the port this app holds> (serve_page).  Two parts:
// - page_capability: the commands are granted to that exact origin, added at launch (capabilities/default.json, the
//   template, grants nothing as written).  A page or frame of another local server, or a notebook output's frame (an
//   opaque origin), is refused, whatever the web view puts in it (Windows puts Tauri's invoke bootstrap in every frame).
// - may_load: the window loads only that origin, any path (lib.rs, on_navigation), whatever sends it elsewhere: a
//   link, a script, a redirect.  Besides it, only what the page's own frames are made of: about:blank and about:srcdoc,
//   and blob: URLs of the page's own origin (macOS asks about a frame's navigation too, not only the window's).
// The self-test checks both, with controls (app/selftest/run.mjs, "who can reach the app's commands").
use tauri::Url;

/// Whether the window may load `url`, its page being at http://127.0.0.1:`port`/.
pub fn may_load(url: &Url, port: u16) -> bool {
    match url.scheme() {
        "http" => own(url, port),
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        // (blob:http://127.0.0.1:<port>/<uuid>: a blob the page made; its origin is the URL in its path)
        "blob" => Url::parse(url.path()).is_ok_and(|inner| inner.scheme() == "http" && own(&inner, port)),
        _ => false,
    }
}

/// The page's capability: capabilities/default.json (which, as written, applies to no origin), for exactly
/// http://127.0.0.1:`port`.  So the app's commands answer only its own page, never a page or a frame of another local
/// server's, nor a notebook output's frame (an opaque origin), whatever the web view puts in those frames (Windows'
/// puts Tauri's invoke bootstrap in every frame).
pub fn page_capability(port: u16) -> String {
    let mut c: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).expect("capabilities/default.json");
    c["identifier"] = "page".into();
    c["local"] = false.into();
    c["remote"] = serde_json::json!({ "urls": [format!("http://127.0.0.1:{port}")] });
    // (a phone's page opens and saves files through the dialog and fs plugins, whose pickers hand over what only the
    // fs plugin reads; the desktop page has neither, and reaches the person's files by the app's grants, disk.rs)
    #[cfg(mobile)]
    if let Some(p) = c["permissions"].as_array_mut() {
        p.extend(serde_json::json!(["dialog:default", "fs:allow-read-text-file", "fs:allow-write-text-file", "fs:allow-read-file", "fs:allow-write-file", "fs:allow-read-dir", "fs:allow-stat", "fs:allow-exists", { "identifier": "fs:scope", "allow": [{ "path": "**" }, { "path": "/**" }] }]).as_array().unwrap().iter().cloned());
    }
    c.as_object_mut().map(|o| o.remove("$schema"));
    c.to_string()
}

fn own(url: &Url, port: u16) -> bool {
    url.host_str() == Some("127.0.0.1") && url.port_or_known_default() == Some(port) && url.username().is_empty() && url.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::may_load;
    fn ok(u: &str) -> bool {
        may_load(&u.parse().unwrap(), 49214)
    }

    #[test]
    fn the_page_s_own_origin_any_path() {
        assert!(ok("http://127.0.0.1:49214/"));
        assert!(ok("http://127.0.0.1:49214/board/?f=a.board.json#x"));
        assert!(ok("http://127.0.0.1:49214/examples/x/preview.html"));
    }

    #[test]
    fn every_other_origin_refused() {
        for u in [
            "http://127.0.0.1:49215/",
            "http://127.0.0.1/",
            "http://127.0.0.1:80/",
            "http://localhost:49214/",
            "http://[::1]:49214/",
            "http://127.0.0.2:49214/",
            "https://127.0.0.1:49214/",
            "http://user@127.0.0.1:49214/",
            "http://user:pw@127.0.0.1:49214/",
            "https://sagebrush.space/",
            "ws://127.0.0.1:49214/",
            "file:///etc/passwd",
            "data:text/html,<script>1</script>",
            "javascript:alert(1)",
            "tauri://localhost/",
            "ipc://localhost/disk_read",
        ] {
            assert!(!ok(u), "{u} should be refused");
        }
    }

    #[test]
    fn the_capability_is_the_template_for_the_exact_origin() {
        let c: serde_json::Value = serde_json::from_str(&super::page_capability(49214)).unwrap();
        let t: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(c["remote"]["urls"], serde_json::json!(["http://127.0.0.1:49214"]));
        assert_eq!(c["local"], false);
        assert_eq!(c["windows"], t["windows"]);
        assert_eq!(c["permissions"], t["permissions"]);
        // (the template alone grants nothing)
        assert_eq!(t["remote"]["urls"], serde_json::json!([]));
        assert_eq!(t["local"], false);
    }

    #[test]
    fn the_desktop_page_has_no_file_system_plugin() {
        // (no fs: or dialog: permission at all, so no path the page names reaches the computer's files: the person's
        // files only by the app's grants, disk.rs)
        let c: serde_json::Value = serde_json::from_str(&super::page_capability(49214)).unwrap();
        let ps = c["permissions"].as_array().unwrap();
        let named = |p: &serde_json::Value| p.as_str().or_else(|| p["identifier"].as_str()).unwrap_or("").to_string();
        assert!(!ps.iter().any(|p| named(p).starts_with("fs:") || named(p).starts_with("dialog:")), "{ps:?}");
        for cmd in ["allow-file-open-dialog", "allow-file-save-dialog", "allow-file-read-text", "allow-file-write-text", "allow-folder-list", "allow-folder-read", "allow-folder-write", "allow-selftest-open"] {
            assert!(ps.iter().any(|p| p == cmd), "{cmd}");
        }
    }

    #[test]
    fn the_page_s_own_frames() {
        assert!(ok("about:blank"));
        assert!(ok("about:srcdoc"));
        assert!(ok("blob:http://127.0.0.1:49214/0b6a9c1e-0000-4000-8000-000000000000"));
        assert!(!ok("blob:http://127.0.0.1:49215/0b6a9c1e-0000-4000-8000-000000000000"));
        assert!(!ok("blob:https://sagebrush.space/0b6a9c1e-0000-4000-8000-000000000000"));
        assert!(!ok("blob:null/0b6a9c1e-0000-4000-8000-000000000000"));
        assert!(!ok("about:config"));
    }
}
