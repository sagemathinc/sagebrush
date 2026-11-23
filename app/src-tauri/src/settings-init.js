// The desktop app's settings (disk.rs settings_script): its web view keeps nothing between launches, so the page's
// settings, which it keeps in localStorage, are kept in settings.json in the app's data folder instead.  Each page
// of the window runs this first.  The first page of a launch puts the saved settings into localStorage (once:
// sessionStorage, which the window keeps for the launch, says it's done); every later change of one of them is
// written back (that key alone).  Only the settings disk.rs lists (SETTINGS_KEYS, put in below; disk.rs refuses any other):
// localStorage also holds documents' drafts, journals and the like, which are no settings.
(() => {
  const KEYS = new Set(/*KEYS*/[]);
  const saved = /*SETTINGS*/null;
  try {
    if (!sessionStorage.getItem("sb-settings-seeded")) {
      if (saved && typeof saved === "object") for (const [k, v] of Object.entries(saved)) if (KEYS.has(k) && typeof v === "string") localStorage.setItem(k, v);
      sessionStorage.setItem("sb-settings-seeded", "1");
    }
  } catch {}
  // (written back asynchronously, coalesced, one write at a time: each write the keys changed since the last, so the
  // app's other windows (#1541), which each change some settings too, never have theirs written back as they were
  // (disk.rs settings_write merges a change into settings.json).  The window's __sbSettingsFlush, which a quit waits
  // for, resolves once the last write is done, and rejects if it failed; a failure is also said like a file's,
  // web/workspace/disk-mirror.ts, and its keys are written with the next)
  const dirty = new Map(); // key -> its value, or null: removed
  // (each key's local change count (a failed write's value is put back only if the key hasn't changed here since it
  // was sent), and the version the app gave it last that this window has seen (disk.rs settings_change): a value read
  // or written with an older one is dropped, never taken nor put back)
  const gen = new Map(), seen = new Map();
  const later = (k, v) => typeof v === "number" && v > (seen.get(k) ?? 0);
  let queued = false, last = Promise.resolve(), failed = null;
  const writeBack = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!dirty.size) return;
      const sent = new Map(dirty), sentGen = new Map([...sent.keys()].map((k) => [k, gen.get(k) ?? 0]));
      dirty.clear();
      const set = {}, remove = [];
      for (const [k, v] of sent) if (v === null) remove.push(k); else set[k] = v;
      last = last.then(() => window.__TAURI__?.core.invoke("settings_write", { set, remove })).then(
        (given) => {
          failed = null;
          for (const [k, v] of Object.entries(given ?? {})) if (later(k, v)) seen.set(k, v);
          window.__sbDiskError?.("settings.json", null);
        },
        (e) => {
          failed = e;
          // (written with the next: unless changed here since, whose value is the newer)
          for (const [k, v] of sent) if (!dirty.has(k) && (gen.get(k) ?? 0) === sentGen.get(k)) dirty.set(k, v);
          console.warn("settings.json:", e);
          window.__sbDiskError?.("settings.json", e);
        });
    });
  };
  const changed = (k) => { gen.set(k, (gen.get(k) ?? 0) + 1); try { dirty.set(k, localStorage.getItem(k)); } catch {} writeBack(); };
  window.__sbSettingsFlush = async () => {
    // (a failed write tried again)
    if (failed) writeBack();
    await Promise.resolve();
    await Promise.resolve();
    await last;
    if (failed) throw failed;
  };
  const P = Storage.prototype, set = P.setItem, remove = P.removeItem, clear = P.clear;
  P.setItem = function (k, v) { set.call(this, k, v); if (this === localStorage && KEYS.has(String(k))) changed(String(k)); };
  P.removeItem = function (k) { remove.call(this, k); if (this === localStorage && KEYS.has(String(k))) changed(String(k)); };
  P.clear = function () { clear.call(this); if (this === localStorage) for (const k of KEYS) changed(k); };
  // (another window changed some settings: they are read again, one read at a time, and each key taken only if the
  // read's version of it is later than any this window has seen, and the key hasn't changed here meanwhile (nor is
  // being written): never written back.  A page reads a setting when it needs it, so what it shows already may follow
  // on its next use or load)
  let reading = Promise.resolve();
  const take = () => (reading = reading.then(async () => {
    await last.catch(() => {});
    const before = new Map(gen);
    let now;
    try { now = await window.__TAURI__.core.invoke("settings_read"); } catch (e) { console.warn("settings.json:", e); return; }
    const values = now?.values, versions = now?.versions;
    if (!values || typeof values !== "object" || !versions || typeof versions !== "object") return;
    for (const k of KEYS) {
      if (dirty.has(k) || queued || (gen.get(k) ?? 0) !== (before.get(k) ?? 0) || !later(k, versions[k])) continue;
      seen.set(k, versions[k]);
      const v = typeof values[k] === "string" ? values[k] : null;
      try { if (localStorage.getItem(k) !== v) { if (v === null) remove.call(localStorage, k); else set.call(localStorage, k, v); } } catch {}
    }
  }));
  const listen = () => {
    const me = window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label;
    window.__TAURI__?.event?.listen?.("sb-settings-changed", (ev) => { if (me && ev?.payload?.from !== me) void take(); })?.catch?.(() => {});
  };
  if (window.__TAURI__?.event) listen();
  else addEventListener("DOMContentLoaded", listen, { once: true });
})();
