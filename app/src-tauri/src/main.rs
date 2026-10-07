// Sagebrush as a desktop app: the sagebrush.space notebook (../dist, from
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
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

// files to open, until the page asks for them
struct Pending(Mutex<Vec<String>>);

#[tauri::command]
fn startup_files(state: tauri::State<Pending>) -> Vec<String> {
    state.0.lock().unwrap().drain(..).collect()
}

#[tauri::command]
fn selftest_file() -> Option<String> {
    std::env::var("SAGEBRUSH_APP_SELFTEST").ok().filter(|s| !s.is_empty())
}

// the page's console during a self-test (it has no other window to the outside)
#[tauri::command]
fn app_log(message: String) {
    eprintln!("[page] {message}");
}

#[tauri::command]
fn selftest_report(app: tauri::AppHandle, report: String, ok: bool) {
    println!("{report}");
    app.exit(if ok { 0 } else { 1 });
}

fn main() {
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
    tauri::Builder::default()
        .plugin(
            tauri_plugin_localhost::Builder::new(port)
                .host("127.0.0.1")
                .on_request(|_request, response| {
                    response.add_header("Cross-Origin-Opener-Policy", "same-origin");
                    response.add_header("Cross-Origin-Embedder-Policy", "require-corp");
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Pending(Mutex::new(args)))
        .invoke_handler(tauri::generate_handler![startup_files, selftest_file, selftest_report, app_log])
        .setup(move |app| {
            let url = format!("http://127.0.0.1:{port}/").parse().unwrap();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Sagebrush")
                .inner_size(1100.0, 860.0)
                .min_inner_size(480.0, 400.0)
                .disable_drag_drop_handler()
                .build()?;
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
