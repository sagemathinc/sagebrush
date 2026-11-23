// Whether this page is the desktop app's: app/src-tauri/src/lib.rs sets __SB_DESKTOP_APP__ there only (window.__TAURI__
// is in the phone apps too; the CLI's page, on the same 127.0.0.1, has neither). Its own module, which every build
// imports (the notebook page's script with or without the LaTeX editor), so no use of it depends on the editor's entry.
export const desktopApp = (w: any = globalThis) => !!w.__TAURI__ && w.__SB_DESKTOP_APP__ === true;
