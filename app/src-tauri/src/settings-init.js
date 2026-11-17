// The desktop app's settings (disk.rs settings_script): its web view keeps nothing between launches, so the page's
// settings, which it keeps in localStorage, are kept in settings.json in the app's data folder instead.  Each page
// of the window runs this first.  The first page of a launch puts the saved settings into localStorage (once:
// sessionStorage, which the window keeps for the launch, says it's done); every later change of one of them writes
// all of them back.  Only the settings listed here: localStorage also holds documents' drafts, journals and the
// like, which are no settings (and a GitHub push's settings, sagebrush.gitpush, aren't kept on disk by this).
(() => {
  const KEYS = new Set([
    "sagebrush-theme", "sagebrush-reactive", "sagebrush-mode", "sagebrush-phone",
    "sagebrush-files-sort", "sagebrush-files-sidebar", "sagebrush-files-open", "sagebrush-files-recent", "sagebrush-recent-opened",
    "sagebrush-side-w", "sagebrush-board-pen", "sagebrush-board-tools", "sagebrush-latex-follow",
    "sagebrush-term-intro", "sb-term-intro", "sb-term-h", "sagebrush-agents-preview-v1",
  ]);
  const saved = /*SETTINGS*/null;
  try {
    if (!sessionStorage.getItem("sb-settings-seeded")) {
      if (saved && typeof saved === "object") for (const [k, v] of Object.entries(saved)) if (KEYS.has(k) && typeof v === "string") localStorage.setItem(k, v);
      sessionStorage.setItem("sb-settings-seeded", "1");
    }
  } catch {}
  let queued = false;
  const writeBack = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const o = {};
      try { for (const k of KEYS) { const v = localStorage.getItem(k); if (v !== null) o[k] = v; } } catch { return; }
      window.__TAURI__?.core.invoke("settings_write", { json: JSON.stringify(o) }).catch((e) => console.warn("settings.json:", e));
    });
  };
  const P = Storage.prototype, set = P.setItem, remove = P.removeItem, clear = P.clear;
  P.setItem = function (k, v) { set.call(this, k, v); if (this === localStorage && KEYS.has(String(k))) writeBack(); };
  P.removeItem = function (k) { remove.call(this, k); if (this === localStorage && KEYS.has(String(k))) writeBack(); };
  P.clear = function () { clear.call(this); if (this === localStorage) writeBack(); };
})();
