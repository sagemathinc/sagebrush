// Which build this is, so that whoever tests the app can say exactly what they tested: the version (Cargo.toml and
// tauri.conf.json, kept equal) and the commit it was built from (build.rs). Both show in About (the macOS app menu's;
// Windows and Linux have no menu bar) as "Version 0.4.0 (1a2b3c4d)", and in the page's version stamp, from
// window.__SB_APP_VERSION__ (web/version.ts), on every platform.

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// 40 lowercase hex digits, or "unknown" (a build outside a git checkout).
pub const COMMIT: &str = env!("SAGEBRUSH_APP_COMMIT");

/// The commit's first 8 hex digits, as the site's stamp shows its own.
#[cfg(target_os = "macos")]
fn short_commit() -> &'static str {
    if COMMIT.len() == 40 { &COMMIT[..8] } else { COMMIT }
}

/// The page's copy, set before its own script runs (the desktop window's; phones show no stamp).
#[cfg(desktop)]
pub fn page_script() -> String {
    format!("window.__SB_APP_VERSION__ = {};", serde_json::json!({ "version": VERSION, "commit": COMMIT }))
}

/// The macOS menu bar: Tauri's default menu (tauri 2's Menu::default), with About naming the commit too.
#[cfg(target_os = "macos")]
pub fn menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem as P, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
    let name = app.package_info().name.clone();
    let about = AboutMetadata { name: Some(name.clone()), version: Some(VERSION.into()), short_version: Some(short_commit().into()), copyright: app.config().bundle.copyright.clone(), authors: app.config().bundle.publisher.clone().map(|p| vec![p]), ..Default::default() };
    Menu::with_items(app, &[
        &Submenu::with_items(app, name, true, &[&P::about(app, None, Some(about))?, &P::separator(app)?, &P::services(app, None)?, &P::separator(app)?, &P::hide(app, None)?, &P::hide_others(app, None)?, &P::separator(app)?, &P::quit(app, None)?])?,
        &Submenu::with_items(app, "File", true, &[&P::close_window(app, None)?])?,
        &Submenu::with_items(app, "Edit", true, &[&P::undo(app, None)?, &P::redo(app, None)?, &P::separator(app)?, &P::cut(app, None)?, &P::copy(app, None)?, &P::paste(app, None)?, &P::select_all(app, None)?])?,
        &Submenu::with_items(app, "View", true, &[&P::fullscreen(app, None)?])?,
        &Submenu::with_id_and_items(app, WINDOW_SUBMENU_ID, "Window", true, &[&P::minimize(app, None)?, &P::maximize(app, None)?, &P::separator(app)?, &P::close_window(app, None)?])?,
        &Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_build_is_named() {
        assert!(COMMIT == "unknown" || (COMMIT.len() == 40 && COMMIT.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))), "{COMMIT}");
        assert!(VERSION.split('.').count() == 3 && VERSION.split('.').all(|n| n.parse::<u32>().is_ok()), "{VERSION}");
        let v: serde_json::Value = serde_json::from_str(page_script().trim_start_matches("window.__SB_APP_VERSION__ = ").trim_end_matches(';')).unwrap();
        assert_eq!(v, serde_json::json!({ "version": VERSION, "commit": COMMIT }));
    }

    #[test]
    fn tauri_conf_has_the_same_version() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["version"], VERSION);
    }
}
