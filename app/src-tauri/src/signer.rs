// The signer window (Autonomous agents, app pairing r4's native tier; the contract is N1 r2,
// macapp-notes/n1-native-signing-ipc.md): the one place the desktop app will sign for the person.  This first part has
// no keys: it is the window, the guards around it, and a stand-in command the self-test signs with, so that what can and
// can't reach the signing commands is shown before any key exists.
//   - The window is made by Rust alone, from native UI the app owns (the macOS menu's "Approvals…"; the tray and the
//     OS notification come later).  No page command opens it: a web page can't open it, point it at anything, or pass
//     it anything.
//   - It shows the app's own bundled page on the app protocol (tauri://localhost, http://tauri.localhost on Windows),
//     another origin than the page's (http://127.0.0.1:<port>); the page's server never serves it (lib.rs serve_page).
//     Its navigation guard keeps it on that one page; its page's CSP keeps out frames and remote script.
//   - Its commands are in a capability of their own (capabilities/signer.json: the signer window, local pages only);
//     the page's capability never lists them.  And each command checks, itself, that its caller is the signer window
//     on that page (signer_caller_ok), so a weakened capability alone still signs nothing.
// The self-test (app/selftest/run.mjs, "signer") counts, from this module's log lines, the calls that reached the
// command ("[signer] dispatch …") and the signatures made ("… signed").
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Url;

pub const LABEL: &str = "signer";
/// The signer's page, in the app's bundled files (app/signer/, copied by app/build-frontend.mjs).
pub const PAGE: &str = "signer/index.html";
/// The same page without its CSP: the self-test's control only (SAGEBRUSH_APP_SIGNER_CONTROL=csp-off).
const PAGE_NO_CSP: &str = "signer/probe-nocsp.html";

/// The self-test's controls, each leaving one guard out (never outside a self-test):
/// "cap": the signing command in the page's capability too; "cap+check": that and no caller check; "csp-off": the
/// signer's page without its CSP; "guard-off": the signer window's navigation guard left out.
pub fn control() -> Option<String> {
    std::env::var("SAGEBRUSH_APP_SIGNER_CONTROL").ok().filter(|_| std::env::var_os("SAGEBRUSH_APP_SELFTEST").is_some())
}

/// Whether `url` is the app protocol's page `path` ("/signer/index.html"): tauri://localhost/… (macOS, Linux) or
/// http(s)://tauri.localhost/… (Windows); nothing else, no other host, no user, no port.
fn app_page(url: &Url, path: &str) -> bool {
    let host_ok = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    host_ok && url.port().is_none() && url.username().is_empty() && url.password().is_none() && url.path() == path
}
/// The signer's pages the window may show: its page, and in the csp-off control only, that page without its CSP.
fn signer_page(url: &Url, control: Option<&str>) -> bool {
    app_page(url, &format!("/{PAGE}")) || (control == Some("csp-off") && app_page(url, &format!("/{PAGE_NO_CSP}")))
}

/// Whether the signer window may load `url` (its navigation guard): its own page only.
pub fn may_load(url: &Url, control: Option<&str>) -> bool {
    signer_page(url, control)
}

/// Whether a call of a signing command comes from the signer window on its own page.
pub fn signer_caller_ok(label: &str, url: &Url, control: Option<&str>) -> bool {
    label == LABEL && signer_page(url, control)
}

/// The signer window, made (or, if it is there, brought to the front).  Native UI the app owns calls this; no page can.
#[cfg(desktop)]
pub fn open(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    // (the native gate, immediately before the window is made: part 3's native signing commands check it again, each
    //  time, and refuse native signing if it fails or has changed)
    match crate::device_key::native_tier() {
        Ok(()) => eprintln!("[signer] native tier: yes"),
        Err(why) => eprintln!("[signer] native tier: no ({why})"),
    }
    let c = control();
    let page = if c.as_deref() == Some("csp-off") { PAGE_NO_CSP } else { PAGE };
    let guard_off = c.as_deref() == Some("guard-off");
    let gc = c.clone();
    let mut w = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App(page.into()))
        .title("Sagebrush: approvals")
        .inner_size(560.0, 640.0)
        .incognito(true)
        .disable_drag_drop_handler()
        .on_navigation(move |u| {
            let yes = guard_off || may_load(u, gc.as_deref());
            if !yes {
                eprintln!("[signer] refused to load {}", u.origin().ascii_serialization());
            }
            yes
        });
    // (a self-test's probe of the window: what the page is to try, the other local server's origin)
    if let Some(p) = std::env::var("SAGEBRUSH_APP_PERSIST").ok().filter(|_| std::env::var_os("SAGEBRUSH_APP_SELFTEST").is_some()) {
        if let Some(other) = p.strip_prefix("signer:") {
            w = w.initialization_script(&format!("window.__SB_SIGNER_PROBE__ = {};", serde_json::json!({ "other": other, "control": c })));
        }
    }
    w.build().map(|_| ()).map_err(|e| format!("the approvals window didn't open: {e}"))
}

static DISPATCHED: AtomicU64 = AtomicU64::new(0);
static SIGNED: AtomicU64 = AtomicU64::new(0);

/// The self-test's stand-in signing command (no key: it "signs" with a counter), so that who reaches a signing command
/// is shown before any key exists.  Outside a self-test it signs nothing.  Each call is logged: dispatched (it reached
/// the command), then signed or refused.
#[cfg(desktop)]
#[tauri::command]
pub fn signer_probe_sign(webview: tauri::Webview, msg: String) -> Result<String, String> {
    let url = webview.url().map_err(|e| format!("no page: {e}"))?;
    let n = DISPATCHED.fetch_add(1, Ordering::SeqCst) + 1;
    eprintln!("[signer] dispatch {n} from {} at {}", webview.label(), url.origin().ascii_serialization());
    if std::env::var_os("SAGEBRUSH_APP_SELFTEST").is_none() {
        eprintln!("[signer] refused {n}: not a self-test");
        return Err("not available".into());
    }
    let c = control();
    if c.as_deref() != Some("cap+check") && !signer_caller_ok(webview.label(), &url, c.as_deref()) {
        eprintln!("[signer] refused {n}: not the signer window's page");
        return Err("only the approvals window signs".into());
    }
    let s = SIGNED.fetch_add(1, Ordering::SeqCst) + 1;
    eprintln!("[signer] signed {n} (signature {s}) for {}", webview.label());
    Ok(format!("probe-signature-{s}-{}", msg.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn u(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn only_the_signer_window_on_its_own_page_signs() {
        for ok in ["tauri://localhost/signer/index.html", "http://tauri.localhost/signer/index.html", "https://tauri.localhost/signer/index.html"] {
            assert!(signer_caller_ok("signer", &u(ok), None), "{ok}");
        }
        // (another window, on the very same page: no)
        for label in ["main", "doc-1", "signer2", "Signer", ""] {
            assert!(!signer_caller_ok(label, &u("tauri://localhost/signer/index.html"), None), "{label}");
        }
        // (the signer window on any other page: no)
        for bad in [
            "http://127.0.0.1:49214/signer/index.html",
            "http://127.0.0.1:49214/",
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "tauri://localhost/signer/probe-nocsp.html",
            "tauri://evil/signer/index.html",
            "http://tauri.localhost:8080/signer/index.html",
            "http://user@tauri.localhost/signer/index.html",
            "http://tauri.localhost.evil.example/signer/index.html",
            "https://sagebrush.space/signer/index.html",
            "file:///signer/index.html",
            "about:blank",
        ] {
            assert!(!signer_caller_ok("signer", &u(bad), None), "{bad}");
        }
        // (the page without its CSP: in the self-test's csp-off control only)
        assert!(signer_caller_ok("signer", &u("tauri://localhost/signer/probe-nocsp.html"), Some("csp-off")));
        assert!(!signer_caller_ok("signer", &u("tauri://localhost/signer/probe-nocsp.html"), Some("cap")));
    }

    #[test]
    fn the_signing_command_is_the_signer_window_s_alone() {
        // (the signer's capability: that window, its local (app protocol) pages, no remote origin)
        let c: serde_json::Value = serde_json::from_str(include_str!("../capabilities/signer.json")).unwrap();
        assert_eq!(c["windows"], serde_json::json!(["signer"]));
        assert_eq!(c["local"], true);
        assert!(c.get("remote").is_none());
        assert_eq!(c["permissions"], serde_json::json!(["allow-signer-probe-sign"]));
        // (the page's capability, as the app adds it, never lists it; nor does its template's windows include the signer)
        let p: serde_json::Value = serde_json::from_str(&crate::nav::page_capability(49214)).unwrap();
        assert!(!p["permissions"].as_array().unwrap().iter().any(|x| x.as_str().is_some_and(|s| s.contains("signer"))), "{p}");
        assert!(!p["windows"].as_array().unwrap().iter().any(|w| w == "signer" || w == "*"), "{p}");
    }

    #[test]
    fn the_signer_window_stays_on_its_page() {
        assert!(may_load(&u("tauri://localhost/signer/index.html"), None));
        for bad in ["http://127.0.0.1:49214/", "https://sagebrush.space/", "tauri://localhost/index.html", "about:blank", "data:text/html,x", "blob:tauri://localhost/x"] {
            assert!(!may_load(&u(bad), None), "{bad}");
        }
    }
}
