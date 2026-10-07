// The app's own commands are declared here, so that a capability can allow
// them (the page is served from http://127.0.0.1, an origin that gets only
// what capabilities/default.json grants).
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["startup_files", "selftest_file", "selftest_report", "app_log"]),
    ))
    .expect("failed to run tauri-build");
}
