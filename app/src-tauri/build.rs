// The app's own commands are declared here, so that a capability can allow
// them (the page is served from http://127.0.0.1, an origin that gets only
// what capabilities/default.json grants).
#[path = "src/build_guard.rs"]
mod build_guard;

fn main() {
    // (K1: a signed build never has the self-test's controls, src/build_guard.rs)
    let var = |k: &str| std::env::var(k).ok();
    let (signed, team, macos_team) = (var("SAGEBRUSH_SIGNED_BUILD"), var("SAGEBRUSH_TEAM_ID"), var("SAGEBRUSH_MACOS_TEAM_ID"));
    if let Some(why) = build_guard::refusal(var("CARGO_FEATURE_SELFTEST_CONTROLS").is_some(), signed.as_deref(), &[team.as_deref(), macos_team.as_deref()]) {
        panic!("{why}");
    }
    println!("cargo:rerun-if-env-changed=SAGEBRUSH_SIGNED_BUILD");
    println!("cargo:rerun-if-env-changed=SAGEBRUSH_TEAM_ID");
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
    // The agent the app hosts (src/agent_host.rs verify_bundle): the sha256 of agent/MANIFEST.json, which
    // app/engine/bundle.mjs writes beside the engine; none (an empty value) where no agent is bundled
    let manifest = std::path::Path::new("agent/MANIFEST.json");
    let agent_sha = std::fs::read(manifest).map(|b| { use sha2::{Digest, Sha256}; Sha256::digest(&b).iter().map(|x| format!("{x:02x}")).collect::<String>() }).unwrap_or_default();
    println!("cargo:rustc-env=SAGEBRUSH_AGENT_MANIFEST_SHA256={agent_sha}");
    println!("cargo:rerun-if-changed=agent/MANIFEST.json");
    // A Mac build signed for release: the Team ID it is signed with (not a secret; ten uppercase letters and digits),
    // so the agent's Node is checked by its signature (agent_host.rs node_check); unset: an unsigned build
    let team = std::env::var("SAGEBRUSH_MACOS_TEAM_ID").unwrap_or_default();
    if !team.is_empty() && !(team.len() == 10 && team.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())) {
        panic!("SAGEBRUSH_MACOS_TEAM_ID isn't a Team ID (ten uppercase letters and digits)");
    }
    println!("cargo:rustc-env=SAGEBRUSH_MACOS_TEAM_ID={team}");
    println!("cargo:rerun-if-env-changed=SAGEBRUSH_MACOS_TEAM_ID");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["startup_files", "selftest_file", "selftest_open", "file_open_dialog", "file_save_dialog", "file_read_text", "file_write_text", "folder_list", "folder_read", "folder_write", "selftest_persist", "selftest_report", "app_log", "engine_start", "engine_send", "engine_ack", "engine_stop", "window_open", "window_claim", "disk_list", "disk_stat", "disk_read", "disk_write", "disk_mkdir", "disk_rename", "disk_remove", "disk_where", "disk_reveal", "settings_write", "settings_read", "grants_read", "grants_write", "app_quit_hold", "app_quit_now", "signer_probe_sign"]),
    ))
    .expect("failed to run tauri-build");
}
