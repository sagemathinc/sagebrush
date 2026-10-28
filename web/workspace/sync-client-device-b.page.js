// Device B of sync-client-cases.js's s5DocsOwners (DEV's switch, astra's DEVSW-1-R2): a page on a second origin (its own
// IndexedDB, Web Locks and channels: another browser, as far as storage goes) on the same account, framed by the case's
// page and driven by it over postMessage.  Its own SyncOwner holds its own connection; the switch is turned on with
// enableDocSync as the notebook page does; a notebook's store, its edits and its record.
import * as W from "./ws.js";

const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codesOf = (d) => J((d?.cells ?? []).map((c) => [c.id, c.code]));
const rawGet = (db, store, key) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
async function until(f, ms) {
  for (const end = Date.now() + ms; ; await sleep(25)) {
    try { if (await f()) return true; } catch {}
    if (Date.now() > end) return false;
  }
}
const B = { warns: [] };
let H, KIT, hdb, w, owner, docs, section;
const stores = new Map();

/** The workspace `name`, sync turned on here (the Sync panel's button), this page's owner the holder; then the switch. */
B.init = async (name) => {
  localStorage.clear();
  H = await import("./nb.js");
  w = await W.Workspace.open({ name, mainName: name + "-main" });
  hdb = await W.openHistoryDb();
  KIT = H.journalClasses({ IdbStore: W.IdbStore, IdbPatchStore: W.IdbPatchStore });
  owner = W.SyncOwner.of(w, { origin: location.origin });
  owner.start();
  const el = document.body.appendChild(document.createElement("div"));
  section = W.syncSection(w, el, { say() {}, fail() {}, usage: () => w.usage(), confirm: () => true, prompt: () => "delete" });
  if (!(await until(() => [...el.querySelectorAll("button")].some((b) => /Turn on sync/.test(b.textContent)), 10_000))) return { error: "no Turn on sync: " + el.textContent.slice(0, 200) };
  [...el.querySelectorAll("button")].find((b) => /Turn on sync/.test(b.textContent)).click();
  const held = await until(() => owner.isHolder() && owner.view().s.state === "synced", 20_000);
  const out = await W.enableDocSync({
    loadHistory: async () => H,
    makeDocs: () => (docs = new W.DocSync({ retryMs: 200, askMs: 5000 })),
    makeChannel: () => new BroadcastChannel(W.docSyncChannel(w.ws.name)),
    register: W.registerJournalWriter,
    own: async () => () => {},
    setReadOnly() {},
    readOnlyNow: () => false,
    flush() {},
    saved: async () => {},
    activate: () => w.activateJournal(),
    begun: () => w.journalBegun(),
    reopen: async () => true,
    setDocs: (d) => owner.setDocs(d),
    needReload() {},
    warn: (...a) => B.warns.push(a.map(String).join(" ")),
  });
  return { held, out, on: H.DOC_SYNC.on };
};
/** Whether this device's DocSync applied a page of notebook `id` from the server (within `ms`). */
B.arrived = (id, ms = 15_000) => until(() => docs?.events.some((e) => e.t === "page" && e.doc === id && e.applied > 0), ms);
/** The notebook's store here, loaded (its record made from the history's head). */
B.open = async (id) => {
  const st = new KIT.JournalStore(w.main, hdb, id, null, H);
  const d = await st.load();
  stores.set(id, st);
  return { codes: codesOf(d), writer: !!st.writer, synced: !!st.synced };
};
B.record = async (id) => codesOf(await rawGet(w.main, "notebooks", id));
/** A save of `cells` as the page makes it (the switch's DOC_SYNC.saved kicks this device's DocSync). */
B.edit = async (id, cells) => {
  const st = stores.get(id), rec = await rawGet(w.main, "notebooks", id);
  const out = await st.save({ name: rec.name, mode: rec.mode, id, cells: cells.map(([cid, code]) => ({ id: cid, code })), baseRev: rec.rev });
  return typeof out === "string" ? out : !!out?.saved;
};
/** The record of `id` here, once it is `codes` (within `ms`); else what it is. */
B.waitRecord = async (id, codes, ms = 15_000) => { await until(async () => (await B.record(id)) === codes, ms); return B.record(id); };
B.warnings = () => B.warns.slice();
B.close = async () => {
  for (const st of stores.values()) try { await st.release(); } catch {}
  stores.clear();
  section?.dispose();
  owner?.destroy();
  w?.close();
  hdb?.close();
  return true;
};

addEventListener("message", async (ev) => {
  if (ev.source !== parent || !ev.data || typeof ev.data.fn !== "string") return;
  const { id, fn, args } = ev.data;
  try {
    if (typeof B[fn] !== "function") throw new Error("no such call: " + fn);
    parent.postMessage({ id, ok: true, value: await B[fn](...(args ?? [])) }, "*");
  } catch (e) {
    parent.postMessage({ id, ok: false, error: String(e?.stack ?? e).slice(0, 500) }, "*");
  }
});
parent.postMessage({ ready: true }, "*");
