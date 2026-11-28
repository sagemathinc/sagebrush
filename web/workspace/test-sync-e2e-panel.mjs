// ci: web-sync.5 order=22 chrome
// The Sync panel's end-to-end encryption section (web/workspace/sync-e2e-panel.ts; plan notes m2-e2e-opt-in-plan),
// in headless Chromium with its real WebCrypto and IndexedDB, against the sync Worker in Miniflare with E2E on, the
// section's other inputs (sync's state, the owner's reason, the enable flow) given by the test:
//   - no chain and sync unused: "Turn on encrypted sync…"; sync on or used: the line to delete the synced data first;
//   - turning on: the confirm's words, genesis, the recovery code shown once (Copy, Download as a revoked Blob URL with
//     no account id in its name, Close only once ticked), the device unconfirmed until then, confirmed after; the code
//     nowhere after close (the DOM, localStorage, IndexedDB, the console); then sync's enable, once;
//   - a device whose code may never have been saved says so; a refused chain offers Reset, whose confirm says what is
//     lost, and nothing is deleted without it; another browser's device: the words, no Reset;
//   - a genesis the server refuses over plaintext says to delete the synced data first, and nothing is turned on;
//   - the E2E routes off: no section at all.
//   CHROME=google-chrome node web/workspace/test-sync-e2e-panel.mjs
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { dispatch } from "../miniflare-dispatch.mjs";
import { browser } from "../agents/a14-cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
let failures = 0, count = 0;
const ok = (c, msg, detail) => { count++; console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const J = JSON.stringify;
const SITE = "https://sagebrush.test";
const IDS = { ONA: "e2e0a000-0001-4e2e-8e2e-e2e2e2e2e201", UNC: "e2e0a000-0002-4e2e-8e2e-e2e2e2e2e202", FRK: "e2e0a000-0003-4e2e-8e2e-e2e2e2e2e203", ESC: "e2e0a000-0004-4e2e-8e2e-e2e2e2e2e204", NEW1: "e2e0a000-0005-4e2e-8e2e-e2e2e2e2e205", SLOW: "e2e0a000-0006-4e2e-8e2e-e2e2e2e2e206", SWA: "e2e0a000-0007-4e2e-8e2e-e2e2e2e2e207", N1A: "e2e0a000-0008-4e2e-8e2e-e2e2e2e2e208", P3: "e2e0a000-0009-4e2e-8e2e-e2e2e2e2e209", RST: "e2e0a000-000a-4e2e-8e2e-e2e2e2e2e20a", N1B: "e2e0a000-000b-4e2e-8e2e-e2e2e2e2e20b", E5A: "e2e0a000-000c-4e2e-8e2e-e2e2e2e2e20c", E6A: "e2e0a000-000d-4e2e-8e2e-e2e2e2e2e20d", E7A: "e2e0a000-000e-4e2e-8e2e-e2e2e2e2e20e" };
const script = execFileSync("bun", ["build", join(here, "../sync/test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8", maxBuffer: 64 << 20 });
const plan = { storage_bytes: 1 << 30, max_file_bytes: 1 << 20, sync: { enabled: true, version_bytes: 1 << 20, read_bytes_per_day: 1 << 30 } };
const rl = (id) => ({ SYNC_PREAUTH: { namespace_id: id, simple: { limit: 1_000_000, period: 60 } }, SYNC_INGRESS_IP: { namespace_id: "8" + id, simple: { limit: 1_000_000, period: 60 } }, SYNC_ACCOUNT_INGRESS: { namespace_id: "9" + id, simple: { limit: 1_000_000, period: 60 } }, SYNC_ADMIN_LIMIT: { namespace_id: "7" + id, simple: { limit: 1_000_000, period: 60 } } });
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
    modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"],
    name: "on", routes: ["sagebrush.test/*"], outboundService: async () => Response.json(plan), ratelimits: rl("4301"),
    durableObjects: { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } },
    bindings: { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", COCALC_ORIGIN: "https://cocalc.test", COCALC_CLIENT_SECRET: "client-secret", PURGE_KEY: "purge-key", LIMITS_KEY: "limits-key", SYNC_ACCOUNTS: Object.values(IDS).join(","), SYNC_E2E: "1", SYNC_TEST_PIN_MS: "1000" },
  }],
}));
const db = await mf.getD1Database("SHARE_DB", "on");
{
  const mig = join(here, "../share/migrations");
  for (const m of readdirSync(mig).filter((f) => f.endsWith(".sql")).sort())
    for (const s of readFileSync(join(mig, m), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();
}
const at = (path, init = {}) => dispatch(mf, SITE + path, { redirect: "manual", ...init });
const signIn = async (id) => (await at("/auth/dev", { method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: J({ token: "dev-token", account_id: id }) })).headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
const sessions = {};
for (const [k, id] of Object.entries(IDS)) {
  sessions[k] = await signIn(id);
  ok((await at("/api/sync/v1/enable", { method: "POST", headers: { cookie: sessions[k], origin: SITE, "content-type": "application/json" }, body: "{}" })).status === 200, `(sync on for ${k})`);
}

// ---- the page: the section, the E2E chunk itself, and a proxy to the server as the account the page names
const dir = mkdtempSync(join(tmpdir(), "sb-e2e-panel-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, [
  `export * as Panel from ${J(join(here, "sync-e2e-panel.ts"))};`,
  `export * as K from ${J(join(here, "e2e-start.ts"))};`,
  `export * as S from ${J(join(here, "sync-e2e.ts"))};`,
  `export { e2eAccountOf } from ${J(join(here, "e2e-here.ts"))};`,
  `export { accountHash } from ${J(join(here, "..", "sync-protocol", "protocol.ts"))};`,
].join("\n"));
const js = execFileSync("bun", ["build", entry, "--format", "esm", "--target", "browser"], { encoding: "utf8", maxBuffer: 64 << 20 });
rmSync(dir, { recursive: true, force: true });
let as = "ONA";
const html = `<!doctype html><body><div id="box"></div><script type="module">import * as m from "/s.js"; Object.assign(window, m);
window.IDS = ${J(IDS)};
window.T = { enabled: 0, reconciled: 0, confirms: [], prompts: [], answer: true, label: null, reason: undefined, sync: { on: false, used: false }, copied: null, urls: [], revoked: [], clicks: [], logs: [] };
// (what the page could leak to: the clipboard, Blob URLs, a download's click, the console)
Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t) => { T.copied = t; } } });
const cou = URL.createObjectURL.bind(URL), rou = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (b) => { const u = cou(b); T.urls.push(u); return u; };
URL.revokeObjectURL = (u) => { T.revoked.push(u); rou(u); };
HTMLAnchorElement.prototype.click = function () { T.clicks.push({ download: this.download, href: this.href }); };
for (const k of ["log", "info", "warn", "error", "debug"]) { const o = console[k].bind(console); console[k] = (...a) => { T.logs.push(a.map(String).join(" ")); o(...a); }; }
window.as = async (k) => { window.current = k; await fetch("/__as/" + k); };
window.deps = (over = {}) => ({
  chain: async () => { const r = await fetch("/api/sync/v1/e2e/chain?from=0"); const b = r.status === 200 ? await r.json() : null; return { status: r.status, entries: b?.entries }; },
  chunk: async () => K,
  hash: async () => accountHash(IDS[window.current]),
  sync: () => T.sync,
  enable: async () => { T.enabled++; },
  reason: () => T.reason,
  reconcile: () => { T.reconciled++; },
  confirm: (t) => { T.confirms.push(t); return T.answer; },
  prompt: (t, v) => { T.prompts.push(t); return T.label ?? v; },
  modalHost: document.body,
  ...over,
});
window.section = (over) => { const box = document.getElementById("box"); box.replaceChildren(); window.sec = Panel.e2eSection(box, deps(over)); return window.sec; };
window.text = () => document.getElementById("box").innerText;
window.buttons = () => [...document.querySelectorAll("#box button")].map((b) => b.textContent);
window.click = (label) => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent === label); if (!b) throw new Error("no button " + label); b.click(); return true; };
window.idb = (fn) => new Promise((res, rej) => { const r = indexedDB.open("sagebrush-e2e-v1"); r.onsuccess = () => { const tx = r.result.transaction(["devices", "pins"], "readonly"); const out = fn(tx.objectStore("devices"), tx.objectStore("pins")); tx.oncomplete = () => res(out instanceof IDBRequest ? out.result : out); tx.onerror = () => rej(tx.error); }; r.onerror = () => rej(r.error); });
window.deviceOf = async (k) => { const key = e2eAccountOf(await accountHash(IDS[k])); return idb((d) => d.get(key)); };
window.ready = true;</script>`;
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/s.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(js);
  if (u.pathname.startsWith("/__as/")) { as = u.pathname.slice(6); return res.writeHead(204).end(); }
  if (!u.pathname.startsWith("/api/")) return res.writeHead(200, { "content-type": "text/html" }).end(html);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await at(u.pathname + u.search, { method: req.method, headers: { cookie: sessions[as], origin: SITE, ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}) }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
  res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const B = await browser();
try {
  const P = await B.tab();
  await P.send("Page.navigate", { url: ORIGIN + "/" });
  await P.until(`window.ready === true`, 15000);
  const C = await P.ev(`({ TURN_ON: Panel.TURN_ON_CONFIRM, RESET: Panel.RESET_CONFIRM, USED: Panel.USED_LINE, UNCONFIRMED: Panel.UNCONFIRMED_LINE, ON: Panel.ON_LINE, FORKED: S.FORKED, NO_DEVICE: S.NO_DEVICE, WRONG: S.WRONG_ACCOUNT })`);

  // ---- no chain: turned on only where sync was never used for the account
  {
    const r = await P.ev(`(async () => { await as("ONA"); T.sync = { on: false, used: false }; await section().refresh(); const off = { text: text(), buttons: buttons() };
      T.sync = { on: true, used: true }; await sec.refresh(); const on = { text: text(), buttons: buttons() };
      T.sync = { on: false, used: true }; await sec.refresh(); const used = { text: text(), buttons: buttons() };
      return { off, on, used }; })()`);
    ok(J(r.off.buttons) === J(["Turn on encrypted sync…"]), "no chain, sync never used here: the switch is offered", r.off);
    ok(r.on.buttons.length === 0 && r.on.text.includes(C.USED) && r.used.buttons.length === 0 && r.used.text.includes(C.USED), "no chain, sync on or used before: no switch, the line to delete the synced data first", { on: r.on, used: r.used });
  }

  // ---- turning on: the confirm, genesis, the code shown once, the device confirmed only after the tick, then enable
  {
    const r = await P.ev(`(async () => {
      T.sync = { on: false, used: false }; T.label = "<img src=x onerror=alert(1)> laptop"; await section().refresh();
      click("Turn on encrypted sync…");
      for (let i = 0; i < 200 && !document.querySelector(".e2e-code-dialog"); i++) await new Promise((r) => setTimeout(r, 25));
      const dlg = document.querySelector(".e2e-code-dialog"), code = dlg?.querySelector("pre")?.textContent ?? "";
      const close = [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Close");
      const before = { closeDisabled: close.disabled, stored: (await deviceOf("ONA"))?.recoveryShown, enabled: T.enabled };
      click("Close");
      // (and Close forced enabled without the tick, as a script could: it still doesn't close)
      close.disabled = false; close.click(); close.disabled = true;
      const stillOpen = !!document.querySelector(".e2e-code-dialog") && dlg.open;
      click("Copy"); await new Promise((r) => setTimeout(r, 20));
      click("Download as a text file");
      dlg.querySelector("input[type=checkbox]").click();
      const enabledAfterTick = !close.disabled;
      click("Close");
      for (let i = 0; i < 200 && T.enabled === 0; i++) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 100));
      const dev = await deviceOf("ONA");
      const dump = JSON.stringify([await idb((d) => d.getAll()), await idb((d, p) => p.getAll())], (k, v) => (v instanceof CryptoKey ? "key" : ArrayBuffer.isView(v) ? Array.from(v).join(",") : v));
      const flat = code.replace(/[^0-9a-z]/gi, "");
      return { code, flat, before, stillOpen, enabledAfterTick, copied: T.copied === code, clicks: T.clicks, urls: T.urls, revoked: T.revoked,
        after: { dialog: !!document.querySelector(".e2e-code-dialog"), inDom: document.documentElement.outerHTML.includes(code) || document.documentElement.outerHTML.includes(flat.slice(0, 16)),
          inStorage: JSON.stringify(localStorage).includes(flat.slice(0, 16)) || dump.includes(flat.slice(0, 16)), inLogs: T.logs.some((l) => l.includes(flat.slice(0, 16))),
          stored: dev?.recoveryShown, enabled: T.enabled, reconciled: T.reconciled },
        confirm: T.confirms.at(-1), text: text(), img: !!document.querySelector("#box img, .e2e-code-dialog img") };
    })()`);
    ok(r.confirm === C.TURN_ON, "turning on asks the confirm that says what end-to-end means and what is lost with both the keys and the code", r.confirm);
    ok(r.flat.length >= 32 && r.before.closeDisabled && r.before.stored === false && r.before.enabled === 0 && r.stillOpen, "the recovery code is shown, Close disabled until ticked (a click does nothing), the device stored unconfirmed, sync not yet on", { before: r.before, stillOpen: r.stillOpen, len: r.flat.length });
    ok(r.copied && r.clicks.length === 1 && r.clicks[0].download === "sagebrush-recovery-code.txt" && r.urls.length === 1 && J(r.revoked) === J(r.urls), "Copy gives the code to the clipboard; Download is a Blob URL revoked right after its click, named with no account id", { clicks: r.clicks, urls: r.urls.length, revoked: r.revoked.length });
    ok(r.enabledAfterTick && !r.after.dialog && !r.after.inDom && !r.after.inStorage && !r.after.inLogs, "after the tick and Close: the code is nowhere in the DOM, localStorage, IndexedDB or the console", r.after);
    ok(r.after.stored === true && r.after.enabled === 1 && r.after.reconciled >= 1 && r.text.includes(C.ON) && !r.img, "the device confirmed only after the tick; then sync turned on once, the owner asked to decide again, and the section says it's on (the typed name never drawn as HTML)", { after: r.after, text: r.text });
  }

  // ---- the dialog closed by the browser (Escape, twice: the second isn't one a page can refuse): the code gone just as
  // after Close, the device left unconfirmed, and the section says so
  {
    await P.ev(`(async () => { await as("ESC"); T.sync = { on: false, used: false }; T.label = null; await section().refresh(); click("Turn on encrypted sync…");
      for (let i = 0; i < 200 && !document.querySelector(".e2e-code-dialog"); i++) await new Promise((r) => setTimeout(r, 25));
      window.escCode = document.querySelector(".e2e-code-dialog pre").textContent.replace(/[^0-9a-z]/gi, "").slice(0, 16); return true; })()`);
    const key = async () => { for (const type of ["keyDown", "keyUp"]) await P.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }); };
    await key();
    await new Promise((r) => setTimeout(r, 200));
    const afterOne = await P.ev(`!!document.querySelector(".e2e-code-dialog")`);
    await key();
    await new Promise((r) => setTimeout(r, 200));
    await key();
    const r = await P.ev(`(async () => {
      for (let i = 0; i < 200 && document.querySelector(".e2e-code-dialog"); i++) await new Promise((r) => setTimeout(r, 25));
      for (let i = 0; i < 200 && !text().includes(Panel.UNCONFIRMED_LINE); i++) await new Promise((r) => setTimeout(r, 25));
      return { dialog: !!document.querySelector(".e2e-code-dialog"), inDom: document.documentElement.outerHTML.includes(escCode), stored: (await deviceOf("ESC"))?.recoveryShown, text: text() };
    })()`);
    ok(r.dialog === false && !r.inDom && r.stored === false && r.text.includes(C.UNCONFIRMED), "the dialog closed by the browser (Escape, repeated): the code nowhere in the DOM, the device still unconfirmed, and the section says so: " + J({ afterOne, ...r, text: r.text.slice(0, 200) }));
  }

  // ---- a device whose code may never have been saved: said
  {
    const r = await P.ev(`(async () => { await as("UNC"); await K.DeviceKeys.create("tablet", e2eAccountOf(await accountHash(IDS.UNC))); T.reason = undefined; await section().refresh(); return text(); })()`);
    ok(r.includes(C.ON) && r.includes(C.UNCONFIRMED), "a device whose recovery code may never have been saved: the section says so", r);
  }

  // ---- a refused chain: Reset, whose confirm says what is lost; nothing deleted without it
  {
    const r = await P.ev(`(async () => {
      await as("FRK"); const made = await K.DeviceKeys.create("desk", e2eAccountOf(await accountHash(IDS.FRK))); await made.confirm();
      T.reason = S.FORKED; await section().refresh();
      const offered = buttons();
      T.answer = false; const n0 = T.reconciled; click("Reset this device…"); await new Promise((r) => setTimeout(r, 200));
      const kept = !!(await deviceOf("FRK"));
      T.answer = true; click("Reset this device…");
      for (let i = 0; i < 100 && (await deviceOf("FRK")); i++) await new Promise((r) => setTimeout(r, 25));
      const fk = e2eAccountOf(await accountHash(IDS.FRK)), gone = !(await deviceOf("FRK")), pin = await idb((d, p) => p.get(fk));
      return { offered, kept, gone, pinGone: pin === undefined, confirm: T.confirms.at(-1), reconciled: T.reconciled - n0 };
    })()`);
    ok(J(r.offered) === J(["Reset this device…"]), "a refused chain (forked): Reset this device is offered", r.offered);
    ok(r.kept && r.gone && r.pinGone && r.confirm === C.RESET && r.reconciled >= 1, "Reset's confirm says plainly that, with no other device and no recovery code, the files can't be recovered; declined, nothing is deleted; accepted, the device goes and the owner decides again", r);
    const nd = await P.ev(`(async () => { T.reason = S.NO_DEVICE; await sec.refresh(); return { text: text(), buttons: buttons() }; })()`);
    ok(nd.text.includes(C.NO_DEVICE) && nd.buttons.length === 0, "another browser's device (no device here): the words, no Reset", nd);
  }

  // ---- a genesis the server refuses over plaintext: the line to delete the synced data first; nothing turned on
  {
    const r = await P.ev(`(async () => {
      T.reason = undefined; T.sync = { on: false, used: false }; const n0 = T.enabled;
      const refusing = { DeviceKeys: { create: async () => { throw Object.assign(new Error("this account's sync already holds files in the clear"), { code: "plaintext_log" }); }, load: async () => null }, resetDevice: async () => {} };
      await as("ONA");
      await section({ chain: async () => ({ status: 200, entries: [] }), chunk: async () => refusing }).refresh();
      click("Turn on encrypted sync…");
      await new Promise((r) => setTimeout(r, 300));
      return { text: text(), enabled: T.enabled - n0, dialog: !!document.querySelector(".e2e-code-dialog") };
    })()`);
    ok(r.text.includes(C.USED) && r.enabled === 0 && !r.dialog, "genesis refused over changes in the clear: the section says to delete the synced data first; no code shown, nothing turned on", r);
  }

  // ---- (E2462-1) the section follows the verified account: a key with another account reads that account's chain
  // again (here: a fresh account's switch, then one with a chain and this browser's device), the same key reads nothing,
  // and clear() empties it
  {
    const r = await P.ev(`(async () => {
      let reads = 0;
      const box = document.getElementById("box"); box.replaceChildren();
      T.reason = undefined; T.sync = { on: false, used: false };
      const d = deps({ chain: async () => { reads++; return deps().chain(); } });
      const second = Panel.e2eSection(box, d);
      await as("NEW1"); second.update(JSON.stringify(["NEW1"])); await new Promise((r) => setTimeout(r, 400));
      const first = { buttons: buttons(), reads };
      second.update(JSON.stringify(["NEW1"])); await new Promise((r) => setTimeout(r, 300));
      const same = reads;
      await as("ONA"); second.update(JSON.stringify(["ONA"])); await new Promise((r) => setTimeout(r, 600));
      const switched = { text: text(), buttons: buttons(), reads };
      second.clear();
      return { first, same, switched, cleared: box.childNodes.length };
    })()`);
    ok(J(r.first.buttons) === J(["Turn on encrypted sync…"]) && r.same === r.first.reads && r.switched.reads === r.first.reads + 1 && r.switched.text.includes(C.ON) && r.switched.buttons.length === 0 && r.cleared === 0,
      "the section follows the account: another account's key reads its chain again (here: on, its device), the same key reads nothing, clear() empties it", r);
  }

  // ---- (E2462-2) "on in this browser" only with this browser's device: a chain and none here (reset) says so
  {
    const r = await P.ev(`(async () => { await as("FRK"); T.reason = undefined; await section().refresh(); return { text: text(), buttons: buttons() }; })()`);
    ok(!r.text.includes(C.ON) && r.text.includes(C.NO_DEVICE), "a chain and no device in this browser (reset, the owner with no reason): not \"on in this browser\", but that this browser isn't set up", r);
  }

  // ---- (E2462-3) the section closed while genesis runs: no dialog then; the device unconfirmed; the code kept in
  // this page for the account and shown when its section next opens, then confirmed once ticked, and sync turned on
  {
    const r = await P.ev(`(async () => {
      await as("SLOW"); T.reason = undefined; T.sync = { on: false, used: false }; T.label = null;
      let open; const gate = new Promise((r) => { open = r; });
      const slowK = { ...K, DeviceKeys: { ...K.DeviceKeys, load: (...a) => K.DeviceKeys.load(...a), create: async (...a) => { await gate; return K.DeviceKeys.create(...a); } }, resetDevice: K.resetDevice };
      const first = section({ chunk: async () => slowK });
      await first.refresh();
      const n0 = T.enabled;
      click("Turn on encrypted sync…");
      await new Promise((r) => setTimeout(r, 100));
      first.dispose();
      open();
      for (let i = 0; i < 200 && !(await deviceOf("SLOW")); i++) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 300));
      const closed = { dialog: !!document.querySelector(".e2e-code-dialog"), stored: (await deviceOf("SLOW"))?.recoveryShown, enabled: T.enabled - n0 };
      await section().refresh();
      for (let i = 0; i < 200 && !document.querySelector(".e2e-code-dialog"); i++) await new Promise((r) => setTimeout(r, 25));
      const dlg = document.querySelector(".e2e-code-dialog");
      const shown = !!dlg && (dlg.querySelector("pre")?.textContent ?? "").length > 0;
      dlg?.querySelector("input[type=checkbox]").click();
      if (dlg) click("Close");
      for (let i = 0; i < 200 && T.enabled - n0 === 0; i++) await new Promise((r) => setTimeout(r, 25));
      return { closed, shown, stored: (await deviceOf("SLOW"))?.recoveryShown, enabled: T.enabled - n0 };
    })()`);
    ok(r.closed.dialog === false && r.closed.stored === false && r.closed.enabled === 0, "the section closed while genesis ran: no dialog, the device unconfirmed, sync not turned on", r.closed);
    ok(r.shown && r.stored === true && r.enabled === 1, "the section opened again for that account: the kept code shown, the device confirmed once ticked, then sync turned on", r);
  }


  // (a turn-on whose genesis waits at a gate the row opens, on the account `k`; returns once the dialog would be next)
  await P.ev(`window.slowOn = async (k, after) => {
    await as(k); T.reason = undefined; T.sync = { on: false, used: false }; T.label = null;
    let open; const gate = new Promise((r) => { open = r; });
    const slowK = { ...K, DeviceKeys: { ...K.DeviceKeys, load: (...a) => K.DeviceKeys.load(...a), create: async (...a) => { await gate; return K.DeviceKeys.create(...a); } }, resetDevice: K.resetDevice };
    const s = section({ chunk: async () => slowK });
    await s.refresh();
    click("Turn on encrypted sync…");
    await new Promise((r) => setTimeout(r, 100));
    await after(s);
    open();
    for (let i = 0; i < 200 && !(await deviceOf(k)); i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 300));
    return s;
  };
  window.dialogUp = async (ms = 1500) => { for (let i = 0; i < ms / 25 && !document.querySelector(".e2e-code-dialog"); i++) await new Promise((r) => setTimeout(r, 25)); return !!document.querySelector(".e2e-code-dialog"); };
  window.saveAndClose = () => { const d = document.querySelector(".e2e-code-dialog"); d.querySelector("input[type=checkbox]").click(); click("Close"); };`);

  // ---- (T1, T2) another account signed in while genesis runs: no dialog on its page, the device unconfirmed, the code
  // kept for the account it was made for, never shown to another, and shown when that account's section opens
  {
    const r = await P.ev(`(async () => {
      const n0 = T.enabled;
      // (only the page's account changes: the genesis itself goes on as SWA's, as an in-flight request would)
      await slowOn("SWA", async () => { window.current = "NEW1"; });
      const during = { dialog: !!document.querySelector(".e2e-code-dialog"), stored: (await deviceOf("SWA"))?.recoveryShown };
      await section().refresh();
      const asOther = await dialogUp(800);
      window.current = "SWA";
      await section().refresh();
      const asOwn = await dialogUp();
      if (asOwn) saveAndClose();
      for (let i = 0; i < 200 && T.enabled === n0; i++) await new Promise((r) => setTimeout(r, 25));
      return { during, asOther, asOwn, stored: (await deviceOf("SWA"))?.recoveryShown, enabled: T.enabled - n0 };
    })()`);
    ok(r.during.dialog === false && r.during.stored === false, "another account signed in while genesis ran: no dialog, the device unconfirmed", r.during);
    ok(r.asOther === false && r.asOwn === true && r.stored === true && r.enabled === 1, "the kept code isn't shown to another account's section, and is shown to its own, confirmed once ticked, sync then on", r);
  }

  // ---- (N1) the panel closed while the dialog is open: the tick and Close still confirm, and sync is still turned on
  {
    const r = await P.ev(`(async () => {
      await as("N1A"); T.reason = undefined; T.sync = { on: false, used: false }; const n0 = T.enabled;
      const s = section(); await s.refresh();
      click("Turn on encrypted sync…");
      await dialogUp();
      s.dispose();
      saveAndClose();
      for (let i = 0; i < 200 && T.enabled === n0; i++) await new Promise((r) => setTimeout(r, 25));
      return { stored: (await deviceOf("N1A"))?.recoveryShown, enabled: T.enabled - n0 };
    })()`);
    ok(r.stored === true && r.enabled === 1, "the panel closed while the code's dialog was open: once ticked the device is confirmed and sync still turned on", r);
  }

  // ---- another account signed in while the dialog is open: the device still confirmed once ticked, but sync isn't
  // turned on for the account now signed in
  {
    const r = await P.ev(`(async () => {
      await as("N1B"); T.reason = undefined; T.sync = { on: false, used: false }; const n0 = T.enabled;
      await section().refresh();
      click("Turn on encrypted sync…");
      await dialogUp();
      window.current = "NEW1";
      saveAndClose();
      await new Promise((r) => setTimeout(r, 400));
      const out = { stored: (await deviceOf("N1B"))?.recoveryShown, enabled: T.enabled - n0 };
      window.current = "N1B";
      return out;
    })()`);
    ok(r.stored === true && r.enabled === 0, "another account signed in while the dialog was open: the device confirmed once ticked, sync not turned on for the new account", r);
  }

  // ---- (N2) a device this browser refuses as another account's: said, with Reset
  {
    const r = await P.ev(`(async () => {
      await as("ONA"); T.reason = undefined;
      const wrong = { ...K, DeviceKeys: { ...K.DeviceKeys, load: async () => { throw Object.assign(new Error("the key chain's answer is for another account"), { code: "wrong_account" }); } } };
      await section({ chunk: async () => wrong }).refresh();
      return { text: text(), buttons: buttons() };
    })()`);
    ok(r.text.includes(C.WRONG) && J(r.buttons) === J(["Reset this device…"]), "a device load refused as another account's: the words, and Reset", r);
  }

  // ---- (N3) a refresh in flight when the section closes opens no kept code's dialog; the code stays kept for the next open
  {
    const r = await P.ev(`(async () => {
      await slowOn("P3", async (s) => { s.dispose(); });
      let release; const slow = new Promise((r) => { release = r; });
      const s2 = section({ chain: async () => { await slow; return deps().chain(); } });
      const pending = s2.refresh();
      s2.dispose();
      release();
      await pending;
      const after = await dialogUp(800);
      await section().refresh();
      const next = await dialogUp();
      if (next) saveAndClose();
      await new Promise((r) => setTimeout(r, 300));
      return { after, next, stored: (await deviceOf("P3"))?.recoveryShown };
    })()`);
    ok(r.after === false && r.next === true && r.stored === true, "a refresh in flight when its section closed opens no dialog; the kept code is shown at the next open", r);
  }

  // ---- (SEC C1) a kept code whose device was reset meanwhile (another tab's Reset) is dropped, never shown
  {
    const r = await P.ev(`(async () => {
      await slowOn("RST", async (s) => { s.dispose(); });
      await K.resetDevice(e2eAccountOf(await accountHash(IDS.RST)));
      await section().refresh();
      const first = await dialogUp(800);
      await section().refresh();
      const second = await dialogUp(800);
      return { first, second };
    })()`);
    ok(r.first === false && r.second === false, "a kept code whose device was reset meanwhile: never shown, and dropped (the next open shows nothing either)", r);
  }

  // ---- (E2462-5) a kept code whose confirm then fails: the failure said, nothing unhandled, the section not left busy
  {
    const r = await P.ev(`(async () => {
      const unhandled = []; window.addEventListener("unhandledrejection", (e) => unhandled.push(String(e.reason)));
      await as("E5A"); T.reason = undefined; T.sync = { on: false, used: false }; T.label = null;
      let open; const gate = new Promise((r) => { open = r; });
      const failing = { ...K, DeviceKeys: { ...K.DeviceKeys, load: (...a) => K.DeviceKeys.load(...a), create: async (...a) => { await gate; const m = await K.DeviceKeys.create(...a); return { ...m, confirm: async () => { throw new Error("the device store couldn't be written"); } }; } }, resetDevice: K.resetDevice };
      const first = section({ chunk: async () => failing }); await first.refresh();
      click("Turn on encrypted sync…"); await new Promise((r) => setTimeout(r, 100));
      first.dispose(); open();
      for (let i = 0; i < 200 && !(await deviceOf("E5A")); i++) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 300));
      const again = section(); await again.refresh();
      const shown = await dialogUp();
      if (shown) saveAndClose();
      await new Promise((r) => setTimeout(r, 500));
      return { shown, busy: again.busy(), text: text(), unhandled, stored: (await deviceOf("E5A"))?.recoveryShown };
    })()`);
    ok(r.shown && r.busy === false && r.unhandled.length === 0 && /couldn't be turned on/.test(r.text) && r.stored === false, "a kept code whose confirm fails: the failure said, nothing unhandled, the section not left busy, the device still unconfirmed", r);
  }

  // ---- (E2462-6) a kept code met by a load that fails transiently: kept, unshown, and shown at the next open
  {
    const r = await P.ev(`(async () => {
      await slowOn("E6A", async (s) => { s.dispose(); });
      const flaky = { ...K, DeviceKeys: { ...K.DeviceKeys, load: async () => { throw Object.assign(new Error("the key chain couldn't be read (503)"), { code: "server" }); } } };
      await section({ chunk: async () => flaky }).refresh();
      const during = await dialogUp(800);
      await section().refresh();
      const next = await dialogUp();
      if (next) saveAndClose();
      await new Promise((r) => setTimeout(r, 300));
      return { during, next, stored: (await deviceOf("E6A"))?.recoveryShown };
    })()`);
    ok(r.during === false && r.next === true && r.stored === true, "a kept code met by a transient load failure: kept and unshown, then shown at the next open and confirmed", r);
  }

  // ---- a kept code met by a refusal (chain_reset): a definite answer, so dropped, never shown
  {
    const r = await P.ev(`(async () => {
      await slowOn("E7A", async (s) => { s.dispose(); });
      const refusing = { ...K, DeviceKeys: { ...K.DeviceKeys, load: async () => { throw Object.assign(new Error("reset"), { code: "chain_reset" }); } } };
      await section({ chunk: async () => refusing }).refresh();
      const during = await dialogUp(800);
      await section().refresh();
      const next = await dialogUp(800);
      return { during, next, stored: (await deviceOf("E7A"))?.recoveryShown };
    })()`);
    ok(r.during === false && r.next === false && r.stored === false, "a kept code met by a refusal (chain_reset): dropped, never shown, the device left unconfirmed", r);
  }

  // ---- the E2E routes off: no section at all
  {
    const r = await P.ev(`(async () => { await section({ chain: async () => ({ status: 404 }) }).refresh(); return document.getElementById("box").childNodes.length; })()`);
    ok(r === 0, "the E2E routes off (404): nothing of end-to-end encryption is drawn", r);
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close?.();
  server.close();
  await mf.dispose();
}
console.log(failures ? `${failures} of ${count} FAILED` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
