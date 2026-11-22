// Sagebrush as an app (desktop, and Android/iOS from the same code): the sagebrush.space notebook (../dist, from
// app/build-frontend.mjs) in the system's web view, where Python and the
// engines run as WebAssembly, as on the site.  This shell adds what a page
// cannot do: open and save files on the computer (on the desktop, its own
// dialogs and commands, by grants for the files the person picks, disk.rs;
// on a phone, the dialog and fs plugins), and open the files the system hands
// it (double-clicked .ipynb files, or paths on the command line).
//
// The page is served from http://127.0.0.1:<a free port> (serve_page, below,
// on a listener the app holds before its window exists) with COOP/COEP
// headers, not from tauri://: WebKit (macOS, Linux) makes a page cross-origin
// isolated only on http(s) or localhost, and the
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
mod disk;
#[cfg(desktop)]
mod engine;
mod nav;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

// the Terminal's shell worker's Content-Security-Policy (shell/worker-boot.js), the site's own
const SHELL_WORKER_CSP: &str = "default-src 'none'; script-src 'self' blob:; connect-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

// files to open, until the page asks for them
struct Pending(Mutex<Vec<String>>);

// (on the desktop, each granted (disk.rs grant): the page gets {grant, name, path}, never a path it can use; a file
// that can't be granted is said and left out)
#[cfg(desktop)]
#[tauri::command]
fn startup_files(app: tauri::AppHandle, state: tauri::State<Pending>) -> Vec<serde_json::Value> {
    let files: Vec<String> = state.0.lock().unwrap().drain(..).collect();
    files.iter().filter_map(|p| disk::grant(&app, std::path::Path::new(p)).map_err(|e| eprintln!("[app] {p}: {e}")).ok()).collect()
}
#[cfg(mobile)]
#[tauri::command]
fn startup_files(state: tauri::State<Pending>) -> Vec<String> {
    state.0.lock().unwrap().drain(..).collect()
}

/// The self-test's notebook (SAGEBRUSH_APP_SELFTEST), granted as a picked one would be.
#[cfg(desktop)]
#[tauri::command]
fn selftest_open(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    selftest_file(app.clone()).map(|p| disk::grant(&app, std::path::Path::new(&p))).transpose()
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

/// The page's listener can't be had: no window, and the app says why and stops (a self-test, which has no one to
/// read a dialog, prints it and exits 3 at once: no window was made, nothing is left to save).
fn fail_closed(app: &tauri::AppHandle, why: String) {
    eprintln!("[app] {why}");
    if std::env::var_os("SAGEBRUSH_APP_SELFTEST").is_some() {
        std::process::exit(3);
    }
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let handle = app.clone();
    app.dialog().message(why).title("Sagebrush can't start").kind(MessageDialogKind::Error).show(move |_| handle.exit(1));
}

/// The app's own page files, from `listener`: each with its type, its CSP (if it has one), no-cache, COOP/COEP
/// (cross-origin isolation, for SharedArrayBuffer), and the Terminal's shell worker its own policy.  Only the files
/// the app has (`files`, the embedded ones' paths), "/" and a folder's index.html: Tauri's own resolver answers any
/// other path with the notebook's index.html, so a page the app doesn't have (/board/ before the app had it,
/// /agents/) loaded the notebook at that path, and each of its relative loads (the analyzer's worker, KaTeX) got
/// that index.html too, until the app was restarted.  Any other path: 404, and a page asked for (a link to one of
/// the site's own pages) a short one with a way back.  One request at a time, as the localhost plugin this replaces
/// did; a response that can't be sent is logged, never the end of the server (the plugin's panicked its one thread),
/// which serves until the app exits.
fn serve_page(app: &tauri::AppHandle, listener: std::net::TcpListener, files: std::collections::HashSet<String>) -> Result<(), Box<dyn std::error::Error>> {
    let server = tiny_http::Server::from_listener(listener, None).map_err(|e| e.to_string())?;
    let assets = app.asset_resolver();
    #[cfg(any(debug_assertions, desktop))]
    let started = std::time::Instant::now();
    #[cfg(any(debug_assertions, desktop))]
    if request_log_cap() > 0 {
        let port = server.server_addr().to_ip().map_or(0, |a| a.port());
        let build = if cfg!(debug_assertions) { "debug build" } else { "release build, self-test" };
        eprintln!("[localhost] logger start port={port} cap={} ({build}; \"set:\" is what this server put on the response, not what the web view received)", request_log_cap());
    }
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let path = req.url().split(['?', '#']).next().unwrap_or("").to_string();
            let known = path == "/" || files.contains(&path) || (path.ends_with('/') && files.contains(&format!("{path}index.html")));
            let Some(asset) = assets.get(path.clone()).filter(|_| known) else {
                let page = req.headers().iter().any(|h| {
                    (h.field.equiv("Sec-Fetch-Dest") && h.value.as_str() == "document") || (h.field.equiv("Accept") && h.value.as_str().contains("text/html"))
                });
                let resp = if page {
                    tiny_http::Response::from_string(NOT_IN_APP).with_status_code(404).with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap())
                } else {
                    tiny_http::Response::from_string("").with_status_code(404)
                };
                let _ = req.respond(resp);
                continue;
            };
            let mut headers = vec![("Content-Type", asset.mime_type.clone())];
            if let Some(csp) = asset.csp_header.clone() {
                headers.push(("Content-Security-Policy", csp));
            }
            headers.push(("Cache-Control", "no-cache".into()));
            headers.push(("Cross-Origin-Opener-Policy", "same-origin".into()));
            headers.push(("Cross-Origin-Embedder-Policy", "require-corp".into()));
            // (File > Examples… shows an example's page in an <iframe sandbox>, an opaque origin: what that page loads from
            // here (KaTeX's style and fonts) is cross-origin to it, so needs CORP, as the site's web/_headers gives it)
            if path.starts_with("/katex/") || path.starts_with("/examples/") {
                headers.push(("Cross-Origin-Resource-Policy", "cross-origin".into()));
            }
            // (the Terminal's shell worker, with its own policy as the site serves it (no network connections, no
            // eval, no further workers, scripts from this origin and blob: only: web/csp-policy.mts
            // shellWorkerPolicy, checked equal by web/test-app-frontend.mjs); the app sets no other CSP
            // (tauri.conf.json))
            if path == "/shell/worker-boot.js" {
                headers.retain(|(h, _)| *h != "Content-Security-Policy");
                headers.push(("Content-Security-Policy", SHELL_WORKER_CSP.into()));
            }
            #[cfg(any(debug_assertions, desktop))]
            log_request(req.url(), started);
            let mut resp = tiny_http::Response::from_data(asset.bytes);
            for (h, v) in headers {
                if let Ok(h) = tiny_http::Header::from_bytes(h.as_bytes(), v.as_bytes()) {
                    resp.add_header(h);
                }
            }
            if let Err(e) = req.respond(resp) {
                eprintln!("[app] a page file wasn't sent in full: {path} ({e})");
            }
        }
    });
    Ok(())
}

// (a page the app doesn't have: the person can always get back to their files)
const NOT_IN_APP: &str = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>Not in the app · Sagebrush</title><body style=\"font:16px system-ui,sans-serif;margin:3em auto;max-width:36em;padding:0 1em\"><h1 style=\"font-size:1.3em\">This page isn't part of the Sagebrush app</h1><p>It's on the website, <a href=\"https://sagebrush.space/\">sagebrush.space</a>.</p><p><a href=\"/\">Back to your files</a></p>";

// SAGEBRUSH_APP_PERSIST=write:<token> or check:<token>, in a desktop self-test: instead of the notebook's self-test, the
// page's two-launch check of the workspace on disk (persistProbe in web/index.html; app/selftest/run.mjs)
#[tauri::command]
fn selftest_persist() -> Option<String> {
    std::env::var("SAGEBRUSH_APP_PERSIST").ok().filter(|s| !s.is_empty() && std::env::var_os("SAGEBRUSH_APP_SELFTEST").is_some())
}

// Quitting (desktop): the person's quit, or the window's close, is held and the page asked ("sb-quit") to write
// what it hasn't yet to disk (web/workspace/disk-mirror.ts drainOnQuit), which then quits (app_quit_now), after
// asking the person if that takes long.  A page that doesn't answer within QUIT_ANSWER (app_quit_hold: it's
// draining) is taken to have nothing it can write, and the app quits.  The self-test's own exits (app.exit with a
// code) aren't held.
#[cfg(desktop)]
static QUIT_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(desktop)]
static QUIT_HELD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(desktop)]
const QUIT_ANSWER: std::time::Duration = std::time::Duration::from_secs(3);

#[cfg(desktop)]
fn ask_quit(app: &tauri::AppHandle) {
    if app.emit("sb-quit", ()).is_err() {
        QUIT_OK.store(true, std::sync::atomic::Ordering::SeqCst);
        app.exit(0);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_ANSWER);
        if !QUIT_HELD.load(std::sync::atomic::Ordering::SeqCst) {
            QUIT_OK.store(true, std::sync::atomic::Ordering::SeqCst);
            app.exit(0);
        }
    });
}

/// The page is writing what it has to disk before the app quits.
#[cfg(desktop)]
#[tauri::command]
fn app_quit_hold() {
    QUIT_HELD.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// The page has written what it has (or the person chose to quit anyway): quit.
#[cfg(desktop)]
#[tauri::command]
fn app_quit_now(app: tauri::AppHandle) {
    QUIT_OK.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

// the page's commands: the engine's on the desktop too
#[cfg(desktop)]
fn handlers() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![startup_files, selftest_file, selftest_open, selftest_persist, selftest_report, app_log, disk::file_open_dialog, disk::file_save_dialog, disk::file_read_text, disk::file_write_text, disk::folder_list, disk::folder_read, disk::folder_write, engine::engine_start, engine::engine_send, engine::engine_ack, engine::engine_stop, disk::disk_list, disk::disk_stat, disk::disk_read, disk::disk_write, disk::disk_mkdir, disk::disk_rename, disk::disk_remove, disk::disk_where, disk::settings_write, disk::grants_read, disk::grants_write, app_quit_hold, app_quit_now]
}
#[cfg(mobile)]
fn handlers() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![startup_files, selftest_file, selftest_persist, selftest_report, app_log]
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
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    // (the fs plugin on a phone only, whose pickers hand over what only it reads; the desktop page has none, disk.rs)
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_fs::init());
    let builder = builder.manage(Pending(Mutex::new(args))).invoke_handler(handlers());
    #[cfg(desktop)]
    let builder = builder.manage(disk::Grants::default());
    // (the engine subprocess, on the desktop only: phones run the page's own worker, design/native-desktop.md §5)
    #[cfg(desktop)]
    let builder = builder.manage(engine::Engine::default());
    // (the paths of the app's own page files, as serve_page answers them: "/index.html", "/board/board.js")
    let context = tauri::generate_context!();
    let files: std::collections::HashSet<String> = context
        .assets()
        .iter()
        .map(|(k, _)| if k.starts_with('/') { k.into_owned() } else { format!("/{k}") })
        .collect();
    builder
        .setup(move |app| {
            // (the page's server, listening before the window exists: the window never loads a page from a port
            // this app doesn't hold)
            // (a free port; in a self-test, SAGEBRUSH_APP_PORT, so two launches can be made to differ: the workspace
            // never depends on the page's origin, web/workspace/disk-mirror.ts)
            let ask = std::env::var("SAGEBRUSH_APP_PORT").ok().filter(|_| std::env::var_os("SAGEBRUSH_APP_SELFTEST").is_some()).and_then(|p| p.parse::<u16>().ok()).unwrap_or(0);
            let listener = match std::net::TcpListener::bind(("127.0.0.1", ask)) {
                Ok(l) => l,
                Err(e) => {
                    fail_closed(app.handle(), format!("Sagebrush couldn't listen on 127.0.0.1 ({e})"));
                    return Ok(());
                }
            };
            let port = listener.local_addr()?.port();
            if std::env::var("SAGEBRUSH_APP_SELFTEST").is_ok() {
                eprintln!("[app] the page is at http://127.0.0.1:{port}/");
            }
            serve_page(app.handle(), listener, files.clone())?;
            // (a self-test's controls, run.mjs: "open" leaves out the window's navigation guard; "wide" that and gives
            // the commands to every http://127.0.0.1 port, as before nav.rs, so the check must see a page reach them)
            let control = std::env::var("SAGEBRUSH_APP_NAV_CONTROL").ok().filter(|_| std::env::var_os("SAGEBRUSH_APP_SELFTEST").is_some());
            let open = matches!(control.as_deref(), Some("open" | "wide"));
            // (the app's commands for this page's exact origin only, nav.rs page_capability; before the window exists)
            app.add_capability(if control.as_deref() == Some("wide") { nav::page_capability(port).replace(&format!("\"http://127.0.0.1:{port}\""), "\"http://127.0.0.1:*\"") } else { nav::page_capability(port) })?;
            let url = format!("http://127.0.0.1:{port}/").parse().unwrap();
            // (the window loads only this page's origin, the port just bound, and its own frames: nav.rs)
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url)).on_navigation(move |u| {
                let yes = open || nav::may_load(u, port);
                if !yes {
                    eprintln!("[app] refused to load {}", u.origin().ascii_serialization());
                }
                yes
            });
            // (a phone's window is the screen: no title, size or drag-and-drop; and the page learns it is in the
            // desktop app, before its own script runs, from __SB_DESKTOP_APP__: window.__TAURI__ is there on phones
            // too, and what only the desktop app offers (the LaTeX editor, web/latex/boot.ts latexHereFor) asks this)
            #[cfg(desktop)]
            let window = window
                .title("Sagebrush")
                .inner_size(1100.0, 860.0)
                .min_inner_size(480.0, 400.0)
                .disable_drag_drop_handler()
                // (nothing kept by the web view between launches: the workspace and the settings are files on disk,
                // the page's IndexedDB a cache of them for one launch, disk.rs)
                .incognito(true)
                .initialization_script("window.__SB_DESKTOP_APP__ = true;")
                .initialization_script(&disk::settings_script(app.handle()));
            // (a self-test's control of the workspace on disk: its import or its write-through left out, run.mjs)
            #[cfg(desktop)]
            let window = match std::env::var("SAGEBRUSH_APP_DISK_CONTROL").ok().filter(|_| std::env::var_os("SAGEBRUSH_APP_SELFTEST").is_some()).as_deref() {
                Some(c @ ("no-import" | "no-write")) => window.initialization_script(&format!("window.__SB_DISK_CONTROL__ = {c:?};")),
                _ => window,
            };
            window.build()?;
            Ok(())
        })
        .build(context)
        .expect("error while starting Sagebrush")
        .run(|_app, _event| {
            // (a window closed or the app quit by the person: held until the page has written its changes to disk)
            #[cfg(desktop)]
            match &_event {
                tauri::RunEvent::ExitRequested { api, code: None, .. } if !QUIT_OK.load(std::sync::atomic::Ordering::SeqCst) => {
                    api.prevent_exit();
                    ask_quit(_app);
                }
                tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if !QUIT_OK.load(std::sync::atomic::Ordering::SeqCst) => {
                    api.prevent_close();
                    ask_quit(_app);
                }
                _ => {}
            }
            // (the engine ends with the app)
            #[cfg(desktop)]
            if let tauri::RunEvent::Exit = _event {
                _app.state::<engine::Engine>().stop();
            }
            // macOS hands over files (Finder, `open -a Sagebrush f.ipynb`) as an event: kept for startup_files, and
            // sent to a page already there (granted, on macOS, as startup_files grants them)
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                let files: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                #[cfg(target_os = "macos")]
                let sent: Vec<serde_json::Value> = files.iter().filter_map(|p| disk::grant(_app, std::path::Path::new(p)).ok()).collect();
                #[cfg(target_os = "ios")]
                let sent = files.clone();
                _app.state::<Pending>().0.lock().unwrap().extend(files.iter().cloned());
                let _ = _app.emit("open-files", sent);
            }
        });
}
