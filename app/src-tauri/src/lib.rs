// Sagebrush as an app (desktop, and Android/iOS from the same code): the sagebrush.space notebook (../dist, from
// app/build-frontend.mjs) in the system's web view, where Python and the
// engines run as WebAssembly, as on the site.  This shell adds what a page
// cannot do: open and save files on the computer (the dialog and fs plugins,
// used by the page in "app mode"), and open the files the system hands it
// (double-clicked .ipynb files, or paths on the command line).
//
// The page is served from http://127.0.0.1:<a free port> (the localhost
// plugin) with COOP/COEP headers, not from tauri://: WebKit (macOS, Linux)
// makes a page cross-origin isolated only on http(s) or localhost, and the
// notebook needs that for SharedArrayBuffer (Stop interrupts Python and keeps
// its variables).  The port serves only the app's own (public) page files;
// the computer's files are reached through Tauri's IPC, which is allowed for
// this window and origin only (capabilities/default.json).
//
// SAGEBRUSH_APP_SELFTEST=<notebook.ipynb>: the page opens that notebook,
// runs it, saves it, and reports (see selftest() in web/index.html); the
// report is printed and the app exits (0 if every check passed).
// (src/main.rs is the desktop entry; on Android and iOS, Tauri calls run()
// through mobile_entry_point.  desktop and mobile are tauri-build's cfgs.)
use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

// files to open, until the page asks for them
struct Pending(Mutex<Vec<String>>);

#[tauri::command]
fn startup_files(state: tauri::State<Pending>) -> Vec<String> {
    state.0.lock().unwrap().drain(..).collect()
}

#[tauri::command]
fn selftest_file(app: tauri::AppHandle) -> Option<String> {
    if let Some(path) = std::env::var("SAGEBRUSH_APP_SELFTEST").ok().filter(|s| !s.is_empty()) {
        return Some(path);
    }
    mobile_selftest_dir(&app).map(|d| d.join("selftest.ipynb").to_string_lossy().into_owned())
}

// the self-test directory on a phone (debug builds only; see below), or None
fn mobile_selftest_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    android_selftest_dir(app).or_else(|| ios_selftest_dir(app))
}

// Android has no environment for SAGEBRUSH_APP_SELFTEST: in a DEBUG build
// only, a self-test notebook placed in the app's own files directory (by
// `adb shell run-as`, which works only for a debuggable APK) is run instead,
// and its report is written next to it (stdout goes nowhere on Android).
// .github/workflows/app-mobile-selftest.yml does this on an emulator.  A
// release build has none of it.
#[cfg(all(target_os = "android", debug_assertions))]
fn android_selftest_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = std::path::PathBuf::from(format!("/data/user/0/{}/files/selftest", app.config().identifier));
    dir.join("selftest.ipynb").is_file().then_some(dir)
}

#[cfg(not(all(target_os = "android", debug_assertions)))]
fn android_selftest_dir(_app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    None
}

// iOS, the same: in a DEBUG build only, a self-test notebook placed in the
// app's own Documents/selftest (by `xcrun simctl get_app_container <udid>
// space.sagebrush.notebook data` in CI) is run, and its report is written
// next to it.  A release build has none of it: Documents is the user's
// (shared with the Files app), so a release build must never pick up a
// notebook from there by itself.
#[cfg(all(target_os = "ios", debug_assertions))]
fn ios_selftest_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().document_dir().ok()?.join("selftest");
    dir.join("selftest.ipynb").is_file().then_some(dir)
}

#[cfg(not(all(target_os = "ios", debug_assertions)))]
fn ios_selftest_dir(_app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    None
}

// A DEBUG build logs the first LOG_REQUESTS requests the page's server
// answers, for the self-test's diagnosis of cross-origin isolation
// (app/selftest/coi-reading.py): the plugin's hook sees only the URL (no
// method or Sec-Fetch headers) and runs only for a file it serves, so each
// line is that URL, whether it carries the self-test's ?sb-diag= marker, and
// the two headers the hook set.  A release build has none of it.
#[cfg(debug_assertions)]
const LOG_REQUESTS: usize = 40;

#[cfg(debug_assertions)]
fn log_request(url: &str) {
    static SEEN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = SEEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    if n <= LOG_REQUESTS {
        let diag = if url.contains("sb-diag=") { "yes" } else { "no" };
        eprintln!("[localhost] #{n} url={url:?} diag={diag} dest=unavailable mode=unavailable status=200(served) set: COOP=same-origin COEP=require-corp");
    } else if n == LOG_REQUESTS + 1 {
        eprintln!("[localhost] cap reached; later requests not logged");
    }
}

// the page's console during a self-test (it has no other window to the outside)
#[tauri::command]
fn app_log(message: String) {
    eprintln!("[page] {message}");
}

#[tauri::command]
fn selftest_report(app: tauri::AppHandle, report: String, ok: bool) {
    println!("{report}");
    // (written whole, then renamed into place: a reader polling for
    // report.txt never sees half of it)
    if let Some(dir) = mobile_selftest_dir(&app) {
        let tmp = dir.join("report.txt.tmp");
        if std::fs::write(&tmp, format!("{report}\n")).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join("report.txt"));
        }
    }
    app.exit(if ok { 0 } else { 1 });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .collect();
    // WebKitGTK (Linux) leaves SharedArrayBuffer out of workers even in a
    // cross-origin isolated page (Ubuntu 22.04's, at least); JavaScriptCore
    // takes its options from JSC_* variables, which its web process inherits
    #[cfg(target_os = "linux")]
    if std::env::var_os("JSC_useSharedArrayBuffer").is_none() {
        std::env::set_var("JSC_useSharedArrayBuffer", "1");
    }
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .expect("no free port for the notebook page");
    if std::env::var("SAGEBRUSH_APP_SELFTEST").is_ok() {
        eprintln!("[app] the page is at http://127.0.0.1:{port}/");
    }
    #[cfg(debug_assertions)]
    eprintln!("[localhost] logger start port={port} cap={LOG_REQUESTS} (debug build; \"set:\" is what this server's hook put on the response, not what the web view received)");
    tauri::Builder::default()
        .plugin(
            tauri_plugin_localhost::Builder::new(port)
                .host("127.0.0.1")
                .on_request(|_request, response| {
                    response.add_header("Cross-Origin-Opener-Policy", "same-origin");
                    response.add_header("Cross-Origin-Embedder-Policy", "require-corp");
                    #[cfg(debug_assertions)]
                    log_request(_request.url());
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Pending(Mutex::new(args)))
        .invoke_handler(tauri::generate_handler![startup_files, selftest_file, selftest_report, app_log])
        .setup(move |app| {
            let url = format!("http://127.0.0.1:{port}/").parse().unwrap();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url));
            // (a phone's window is the screen: no title, size or drag-and-drop)
            #[cfg(desktop)]
            let window = window
                .title("Sagebrush")
                .inner_size(1100.0, 860.0)
                .min_inner_size(480.0, 400.0)
                .disable_drag_drop_handler();
            window.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting Sagebrush")
        .run(|_app, _event| {
            // macOS hands over files (Finder, `open -a Sagebrush f.ipynb`) as an event
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                let files: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                _app.state::<Pending>().0.lock().unwrap().extend(files.iter().cloned());
                let _ = _app.emit("open-files", files);
            }
        });
}
