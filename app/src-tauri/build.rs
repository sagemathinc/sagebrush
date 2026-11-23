// The app's own commands are declared here, so that a capability can allow
// them (the page is served from http://127.0.0.1, an origin that gets only
// what capabilities/default.json grants).
fn main() {
    // The commit this app is built from, for About and the page's version stamp (src/version.rs): git's HEAD, else
    // CI's GITHUB_SHA, else "unknown" (a build outside a checkout)
    let sha = |s: &str| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
    let git = |args: &[&str]| std::process::Command::new("git").args(args).output().ok().filter(|o| o.status.success()).and_then(|o| String::from_utf8(o.stdout).ok()).map(|s| s.trim().to_string());
    let commit = git(&["rev-parse", "HEAD"]).filter(|s| sha(s)).or_else(|| std::env::var("GITHUB_SHA").ok().filter(|s| sha(s))).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=SAGEBRUSH_APP_COMMIT={commit}");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    // (a new commit builds again: git's HEAD, the branch it names, and packed refs)
    for p in [git(&["rev-parse", "--git-path", "HEAD"]), git(&["rev-parse", "--symbolic-full-name", "HEAD"]).and_then(|r| git(&["rev-parse", "--git-path", &r])), git(&["rev-parse", "--git-path", "packed-refs"])].into_iter().flatten() {
        println!("cargo:rerun-if-changed={p}");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["startup_files", "selftest_file", "selftest_open", "file_open_dialog", "file_save_dialog", "file_read_text", "file_write_text", "folder_list", "folder_read", "folder_write", "selftest_persist", "selftest_report", "app_log", "engine_start", "engine_send", "engine_ack", "engine_stop", "disk_list", "disk_stat", "disk_read", "disk_write", "disk_mkdir", "disk_rename", "disk_remove", "disk_where", "disk_reveal", "settings_write", "grants_read", "grants_write", "app_quit_hold", "app_quit_now"]),
    ))
    .expect("failed to run tauri-build");
}
