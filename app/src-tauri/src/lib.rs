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
#[cfg(desktop)]
mod engine;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

// the Terminal's shell worker's Content-Security-Policy (shell/worker-boot.js), the site's own
const SHELL_WORKER_CSP: &str = "default-src 'none'; script-src 'self' blob:; connect-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

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
// line is that URL (the path and query of one of the app's own files), whether
// it carries the self-test's ?sb-diag= marker, the two headers the hook set,
// and the milliseconds since the server started.
// A desktop RELEASE build logs them too, but only during its self-test
// (SAGEBRUSH_APP_SELFTEST set), at most SELFTEST_LOG_REQUESTS: whether a
// request reached the server at all (the self-test's module import is now and
// then never answered).  Without that variable it logs nothing.  A phone's
// release build has none of it (app-mobile.yml checks its library).
#[cfg(any(debug_assertions, desktop))]
const LOG_REQUESTS: usize = 40;
#[cfg(any(debug_assertions, desktop))]
const SELFTEST_LOG_REQUESTS: usize = 200;

/// How many requests this run logs: a debug build's LOG_REQUESTS; a desktop release build's SELFTEST_LOG_REQUESTS
/// during its self-test, else none.
#[cfg(any(debug_assertions, desktop))]
fn request_log_cap() -> usize {
    static CAP: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *CAP.get_or_init(|| {
        if cfg!(debug_assertions) {
            LOG_REQUESTS
        } else if std::env::var_os("SAGEBRUSH_APP_SELFTEST").is_some() {
            SELFTEST_LOG_REQUESTS
        } else {
            0
        }
    })
}

#[cfg(any(debug_assertions, desktop))]
fn log_request(url: &str, started: std::time::Instant) {
    let cap = request_log_cap();
    if cap == 0 {
        return;
    }
    static SEEN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = SEEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    if n <= cap {
        let diag = if url.contains("sb-diag=") { "yes" } else { "no" };
        let ms = started.elapsed().as_millis();
        eprintln!("[localhost] #{n} url={url:?} diag={diag} dest=unavailable mode=unavailable status=200(served) set: COOP=same-origin COEP=require-corp t={ms}ms");
    } else if n == cap + 1 {
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

// the page's commands: the engine's on the desktop too
#[cfg(desktop)]
fn handlers() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![startup_files, selftest_file, selftest_report, app_log, engine::engine_start, engine::engine_send, engine::engine_ack, engine::engine_stop]
}
#[cfg(mobile)]
fn handlers() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![startup_files, selftest_file, selftest_report, app_log]
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
    #[cfg(any(debug_assertions, desktop))]
    let started = std::time::Instant::now();
    #[cfg(any(debug_assertions, desktop))]
    if request_log_cap() > 0 {
        let build = if cfg!(debug_assertions) { "debug build" } else { "release build, self-test" };
        eprintln!("[localhost] logger start port={port} cap={} ({build}; \"set:\" is what this server's hook put on the response, not what the web view received)", request_log_cap());
    }
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_localhost::Builder::new(port)
                .host("127.0.0.1")
                .on_request(move |request, response| {
                    response.add_header("Cross-Origin-Opener-Policy", "same-origin");
                    response.add_header("Cross-Origin-Embedder-Policy", "require-corp");
                    // the Terminal's shell worker, with its own policy as the site serves it (no network
                    // connections, no eval, no further workers, scripts from this origin and blob: only:
                    // web/csp-policy.mts shellWorkerPolicy, checked equal by web/test-app-frontend.mjs); the app
                    // sets no other CSP (tauri.conf.json)
                    if request.url().split(['?', '#']).next() == Some("/shell/worker-boot.js") {
                        response.add_header("Content-Security-Policy", SHELL_WORKER_CSP);
                    }
                    #[cfg(any(debug_assertions, desktop))]
                    log_request(request.url(), started);
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Pending(Mutex::new(args)))
        .invoke_handler(handlers());
    // (the engine subprocess, on the desktop only: phones run the page's own worker, design/native-desktop.md §5)
    #[cfg(desktop)]
    let builder = builder.manage(engine::Engine::default());
    builder
        .setup(move |app| {
            let url = format!("http://127.0.0.1:{port}/").parse().unwrap();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url));
            // (a phone's window is the screen: no title, size or drag-and-drop; and the page learns it is in the
            // desktop app, before its own script runs, from __SB_DESKTOP_APP__: window.__TAURI__ is there on phones
            // too, and what only the desktop app offers (the LaTeX editor, web/latex/boot.ts latexHereFor) asks this)
            #[cfg(desktop)]
            let window = window
                .title("Sagebrush")
                .inner_size(1100.0, 860.0)
                .min_inner_size(480.0, 400.0)
                .disable_drag_drop_handler()
                .initialization_script("window.__SB_DESKTOP_APP__ = true;");
            window.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting Sagebrush")
        .run(|_app, _event| {
            // (the engine ends with the app)
            #[cfg(desktop)]
            if let tauri::RunEvent::Exit = _event {
                _app.state::<engine::Engine>().stop();
            }
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
