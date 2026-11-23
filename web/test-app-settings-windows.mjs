// ci: web-runner order=293 runner=bun
// The desktop app's settings with several windows (#1541; app/src-tauri/src/settings-init.js, disk.rs settings_write
// and settings_read): each window its own localStorage, one settings.json.  A window writes only the keys it changed,
// which the app merges into settings.json, so no window writes another's settings back as they were; the others are
// told, and take the change without writing it back; a key a window has changed and not yet written is never taken
// from another.  Each window runs the real settings-init.js in a context of its own, over a host that merges as
// disk.rs does.
//   bun web/test-app-settings-windows.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";

let fails = 0, checks = 0;
const ok = (c, what) => { checks++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails++; };
const J = JSON.stringify;
const KEYS = ["sagebrush-theme", "sagebrush-files-sort", "sagebrush-mode"];
const template = readFileSync(new URL("../app/src-tauri/src/settings-init.js", import.meta.url), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));

// (settings.json and the app's two commands, as disk.rs: a change merged, then every other window told)
function host() {
  const h = { file: {}, versions: {}, last: 0, writes: [], listeners: new Map(), fail: false, hold: null, holdRead: null, failHeld: false };
  h.invoke = (from) => async (cmd, a) => {
    await tick();
    if (cmd === "settings_read") {
      // (what settings.json and the versions are when the read is made; a held read returns that, late)
      const snap = { values: { ...h.file }, versions: { ...h.versions } };
      if (h.holdRead?.label === from) await h.holdRead.gate;
      return snap;
    }
    if (cmd === "settings_write") {
      if (h.fail) throw new Error("disk full");
      if (h.hold?.label === from) { await h.hold.gate; if (h.failHeld) { h.failHeld = false; throw new Error("disk full"); } }
      h.writes.push({ from, ...a });
      for (const k of a.remove) delete h.file[k];
      Object.assign(h.file, a.set);
      const given = {};
      for (const k of [...Object.keys(a.set), ...a.remove]) given[k] = h.versions[k] = ++h.last;
      for (const [label, f] of h.listeners) if (label !== from) f({ payload: { from } });
      return given;
    }
    throw new Error(cmd);
  };
  return h;
}
// (a window: its own Storage, localStorage and sessionStorage, the script run first, as the app's init script)
function windowOf(h, label) {
  class Storage {
    constructor() { this.m = new Map(); }
    getItem(k) { return this.m.has(String(k)) ? this.m.get(String(k)) : null; }
    setItem(k, v) { this.m.set(String(k), String(v)); }
    removeItem(k) { this.m.delete(String(k)); }
    clear() { this.m.clear(); }
  }
  const ctx = { Storage, queueMicrotask, console, Promise, Map, Set, Object, JSON, String, setTimeout, addEventListener: () => {} };
  ctx.localStorage = new Storage();
  ctx.sessionStorage = new Storage();
  ctx.window = ctx;
  ctx.__TAURI_INTERNALS__ = { metadata: { currentWebview: { label } } };
  ctx.__TAURI__ = { core: { invoke: h.invoke(label) }, event: { listen: (ev, f) => { if (ev === "sb-settings-changed") h.listeners.set(label, f); return Promise.resolve(() => {}); } } };
  vm.createContext(ctx);
  vm.runInContext(template.replace("/*KEYS*/[]", J(KEYS)).replace("/*SETTINGS*/null", J(h.file)), ctx);
  return ctx;
}
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

// two windows, both from the same settings.json
{
  const h = host();
  h.file = { "sagebrush-theme": "light", "sagebrush-files-sort": "date" };
  const a = windowOf(h, "main"), b = windowOf(h, "doc-1");
  ok(a.localStorage.getItem("sagebrush-theme") === "light" && b.localStorage.getItem("sagebrush-theme") === "light", "both windows start from settings.json");
  a.localStorage.setItem("sagebrush-theme", "dark");
  await a.__sbSettingsFlush();
  await settle();
  ok(J(h.writes.at(-1)) === J({ from: "main", set: { "sagebrush-theme": "dark" }, remove: [] }), "a window writes only the key it changed: " + J(h.writes.at(-1)));
  ok(b.localStorage.getItem("sagebrush-theme") === "dark" && h.writes.length === 1, "the other window takes it, without writing it back: " + J({ b: b.localStorage.getItem("sagebrush-theme"), writes: h.writes.length }));
  // (the other window then changes another key: the first's change stays in settings.json)
  b.localStorage.setItem("sagebrush-files-sort", "name");
  await b.__sbSettingsFlush();
  await settle();
  ok(J(h.file) === J({ "sagebrush-theme": "dark", "sagebrush-files-sort": "name" }), "a second window's change of another key leaves the first's: " + J(h.file));
  ok(a.localStorage.getItem("sagebrush-files-sort") === "name", "...and the first window takes it");
  // (a removal removes that key alone)
  a.localStorage.removeItem("sagebrush-files-sort");
  await a.__sbSettingsFlush();
  await settle();
  ok(J(h.file) === J({ "sagebrush-theme": "dark" }) && b.localStorage.getItem("sagebrush-files-sort") === null, "a removal removes that key alone, in settings.json and the other window: " + J(h.file));
  // (a key this window changed and is still writing is never taken from another window's change: its own write lands
  // after, the later one)
  let release;
  h.hold = { label: "doc-1", gate: new Promise((r) => (release = r)) };
  b.localStorage.setItem("sagebrush-mode", "sage");
  await settle();
  a.localStorage.setItem("sagebrush-mode", "magma");
  await a.__sbSettingsFlush();
  await settle();
  ok(b.localStorage.getItem("sagebrush-mode") === "sage", "a key this window is still writing isn't taken from another window's change");
  release();
  h.hold = null;
  await b.__sbSettingsFlush();
  await settle();
  ok(h.file["sagebrush-mode"] === "sage" && a.localStorage.getItem("sagebrush-mode") === "sage", "...its own write, the later one, then reaches settings.json and the other window: " + J(h.file));
  ok(b.localStorage.getItem("sagebrush-mode") === "sage", "...and this window keeps its own value: what it read of the other's change while writing isn't applied after: " + b.localStorage.getItem("sagebrush-mode"));
  // (a write that fails: its keys are written with the next, unless changed again meanwhile)
  h.fail = true;
  a.localStorage.setItem("sagebrush-theme", "solar");
  const why = await a.__sbSettingsFlush().then(() => "ok", (e) => e.message);
  h.fail = false;
  a.localStorage.setItem("sagebrush-files-sort", "size");
  await a.__sbSettingsFlush();
  await settle();
  ok(why === "disk full" && h.file["sagebrush-theme"] === "solar" && h.file["sagebrush-files-sort"] === "size", "a write that fails: its key is written with the next: " + J({ why, file: h.file }));
}

// astra2's races (#1716 H1, H2), each observed on disk and in the window's localStorage
{
  // (H1: a write held, then failing, after a newer value of the same key was queued behind it: the old value isn't
  // put back, so the next unrelated write never takes settings.json back to it)
  const h = host();
  h.file = { "sagebrush-theme": "light" };
  const a = windowOf(h, "main");
  let release;
  h.hold = { label: "main", gate: new Promise((r) => (release = r)) };
  h.failHeld = true;
  a.localStorage.setItem("sagebrush-theme", "solar");
  await settle();
  h.hold = null;
  a.localStorage.setItem("sagebrush-theme", "dark");
  await settle();
  release();
  await a.__sbSettingsFlush().catch(() => {});
  await settle();
  a.localStorage.setItem("sagebrush-files-sort", "name");
  await a.__sbSettingsFlush().catch(() => {});
  await settle();
  ok(h.file["sagebrush-theme"] === "dark" && a.localStorage.getItem("sagebrush-theme") === "dark", "H1: an older write failing after a newer one of the same key doesn't come back: disk " + J(h.file) + ", local " + a.localStorage.getItem("sagebrush-theme"));
}
{
  // (H2: a read held, made before this window's own newer change of the key, returned late: not taken)
  const h = host();
  h.file = { "sagebrush-theme": "light" };
  const a = windowOf(h, "main"), b = windowOf(h, "doc-1");
  a.localStorage.setItem("sagebrush-theme", "dark");
  let release;
  h.holdRead = { label: "doc-1", gate: new Promise((r) => (release = r)) };
  await a.__sbSettingsFlush();
  await settle();
  // (doc-1's read of "dark" is held; doc-1 then writes its own "solar")
  h.holdRead = null;
  b.localStorage.setItem("sagebrush-theme", "solar");
  await b.__sbSettingsFlush();
  await settle();
  release();
  await settle();
  ok(h.file["sagebrush-theme"] === "solar" && b.localStorage.getItem("sagebrush-theme") === "solar" && a.localStorage.getItem("sagebrush-theme") === "solar", "H2: a read made before this window's own later change, returned late, isn't taken: disk " + J(h.file) + ", doc-1 " + b.localStorage.getItem("sagebrush-theme") + ", main " + a.localStorage.getItem("sagebrush-theme"));
}

console.log(fails ? `${fails} of ${checks} failed` : `test-app-settings-windows: all ${checks} passed`);
process.exit(fails ? 1 : 0);
