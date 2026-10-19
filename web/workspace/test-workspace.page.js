// The cases of web/workspace/test-workspace.mjs, run in the page (real
// IndexedDB, localStorage, Web Locks, BroadcastChannel).  Each case has
// databases of its own.
import * as W from "./ws.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
let n = 0;
const fresh = async (limits) => {
  n++;
  localStorage.clear();
  return W.Workspace.open({ name: `ws-test-${n}`, mainName: `main-test-${n}`, ...(limits ? { limits } : {}) });
};
const fails = async (p, code) => { try { await p; return false; } catch (e) { return e instanceof W.WorkspaceError ? e.code === code : `${e}`; } };
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const paths = async (w, folder = "/", rec = true) => (await w.list(folder, { recursive: rec })).map((e) => e.path).sort();
const rawGet = (db, store, key) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const rawKeys = (db, store) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAllKeys(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const rawPut = (db, store, value, key) => new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value, key); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); });
const rawDel = (db, store, key) => new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).delete(key); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); });
const board = (title, extra = {}) => ({ title, nodes: [{ id: "a", text: "hi" }], ...extra });

async function paths_() {
  const bad = ["", "a", "/a//b", "/a/./b", "/a/../b", "/a\u0000b", "/" + "x".repeat(256), "/" + Array(33).fill("d").join("/"), "/" + "y/".repeat(600)];
  for (const p of bad) { let threw = false; try { W.normPath(p); } catch (e) { threw = e instanceof W.PathError; } check(threw, `normPath refuses ${JSON.stringify(p.slice(0, 20))}`); }
  check(W.normPath("/a/b/") === "/a/b" && W.normPath("/") === "/", "normPath drops a trailing slash");
  check(W.kindOf("/x.ipynb") === "notebook" && W.kindOf("/x.board.json") === "board" && W.kindOf("/x.json") === "file" && W.kindOf("/.ipynb") === "file", "kindOf by name");
  check(W.safeName("a/b\u0001c") === "a-b-c" && W.safeName("  ") === "Untitled" && W.safeName("..") === "Untitled", "safeName");
  check(JSON.stringify(W.splitExt("x.board.json")) === '["x",".board.json"]' && JSON.stringify(W.splitExt(".bashrc")) === '[".bashrc",""]', "splitExt");
  const taken = new Set(["/f/a.txt", "/f/a (2).txt"]);
  check(W.freePath("/f", "a", ".txt", (p) => taken.has(p)) === "/f/a (3).txt", "freePath: the first free name");
}

async function createAndRead() {
  const w = await fresh();
  const nb = await w.create("/Algebra/groups.ipynb", { mode: "sage" });
  check(nb.kind === "notebook" && nb.mode === "sage", "a notebook made, with its language");
  check((await paths(w)).join() === "/Algebra,/Algebra/groups.ipynb", "its folder made with it: " + (await paths(w)).join());
  const rec = await rawGet(w.main, "notebooks", nb.ref);
  check(rec?.name === "groups" && Array.isArray(rec.cells) && rec.mode === "sage", "the notebook is in sagebrush/notebooks, named for its file");
  const bd = await w.create("/Algebra/Sylow.board.json");
  const b = await w.read(bd.path);
  check(b.content.title === "Sylow" && Array.isArray(b.content.nodes) && b.rev === 1, "a blank board, titled for its name");
  const f = await w.create("/data/primes.csv", { content: "2\n3\n5\n" });
  check(f.ref === "/data/primes.csv" && f.size === 6, "a data file, at its path");
  check(dec(await rawGet(w.main, "files", "/data/primes.csv")) === "2\n3\n5\n", "its bytes where Python reads them");
  check(await fails(w.create("/data/primes.csv", { content: "x" }), "exists"), "a taken path is refused");
  check(dec(await rawGet(w.main, "files", "/data/primes.csv")) === "2\n3\n5\n", "…and not written over");
  await rawPut(w.main, "files", enc("orphan"), "/data/orphan.txt");
  check(await fails(w.create("/data/orphan.txt", { content: "new" }), "exists"), "bytes kept at a path with no entry are not written over");
  check(dec(await rawGet(w.main, "files", "/data/orphan.txt")) === "orphan", "…they stay");
  check(await fails(w.create("/Algebra/groups.ipynb/x.txt", { content: "" }), "exists"), "a file can't be a folder");
  check(await fails(w.create("/Trash/x.txt", { content: "" }), "invalid"), "nothing is made in Trash");
  check(await fails(w.create("/a/../b.txt", { content: "" }), "invalid"), "a bad path is refused");
  check(await fails(w.create("/b.board.json", { content: { nope: 1 } }), "invalid"), "a board must be a board");
  check(!(await w.stat("/b.board.json")) && (await rawKeys(w.ws, "boards")).length === 1, "…and nothing of it kept");
  const top = (await w.list("/")).map((e) => e.path).sort();
  check(top.join() === "/Algebra,/data", "list: the folder's own entries");
  w.close();
}

async function writeCas() {
  const w = await fresh();
  const bd = await w.create("/b.board.json", { content: board("B") });
  const r1 = await w.read(bd.path);
  await w.write(bd.path, board("B2"), { base: r1.rev });
  check((await w.read(bd.path)).content.title === "B2", "a board written");
  check(await fails(w.write(bd.path, board("stale"), { base: r1.rev }), "conflict"), "a write from a stale revision is refused");
  check((await w.read(bd.path)).content.title === "B2", "…nothing written");
  const nb = await w.create("/n.ipynb");
  const n1 = await w.read(nb.path);
  await w.write(nb.path, { cells: [{ id: "c", cell_type: "code", input: "1+1" }], name: "other" }, { base: n1.rev });
  const n2 = await w.read(nb.path);
  check(n2.content.cells.length === 1 && n2.content.name === "n", "a notebook written; its name stays its file's");
  check(await fails(w.write(nb.path, { cells: [] }, { base: n1.rev }), "conflict"), "a notebook's stale write refused");
  const f = await w.create("/f.txt", { content: "a" });
  await w.write(f.path, "bb", { base: 0 });
  const fr = await w.read(f.path);
  check(dec(fr.content) === "bb" && fr.rev === 1 && fr.entry.size === 2, "a file written, its revision counted");
  await w.write(f.path, "bb");
  check((await w.history(f.path)).length === 1, "writing the same bytes again keeps no version");
  const g = await w.create("/g.txt", { content: "" });
  await w.write(g.path, "now");
  check((await w.history(g.path)).length === 0, "nor does writing over an empty file");
  check(await fails(w.write(f.path, "c", { base: 0 }), "conflict"), "a file's stale write refused");
  w.close();
}

async function renames() {
  const w = await fresh();
  await w.create("/proj/data/a.csv", { content: "1" });
  await w.create("/proj/data/b.csv", { content: "2" });
  const nb = await w.create("/proj/notes.ipynb");
  await w.rename("/proj", "/work");
  check((await paths(w)).join() === "/work,/work/data,/work/data/a.csv,/work/data/b.csv,/work/notes.ipynb", "a folder renamed with all it holds");
  const keys = (await rawKeys(w.main, "files")).sort();
  check(keys.join() === "/work/data/a.csv,/work/data/b.csv", "data files' bytes moved to their new paths: " + keys.join());
  check((await w.stat("/work/data/a.csv")).ref === "/work/data/a.csv", "…and their entries name them there");
  check(await fails(w.rename("/work", "/work/inside"), "invalid"), "a folder can't go inside itself");
  await w.create("/x.txt", { content: "x" });
  check(await fails(w.rename("/x.txt", "/work"), "exists"), "renaming onto a taken path is refused");
  check(dec(await rawGet(w.main, "files", "/x.txt")) === "x", "…and changes nothing");
  await w.rename("/work/notes.ipynb", "/work/lecture.ipynb");
  check((await rawGet(w.main, "notebooks", nb.ref)).name === "lecture", "a notebook named as its file is renamed with it");
  await w.write("/work/lecture.ipynb", { cells: [] });
  const rec = await rawGet(w.main, "notebooks", nb.ref);
  await new Promise((ok) => { const tx = w.main.transaction("notebooks", "readwrite"); tx.objectStore("notebooks").put({ ...rec, name: "My own title" }); tx.oncomplete = ok; });
  await w.rename("/work/lecture.ipynb", "/work/talk.ipynb");
  check((await rawGet(w.main, "notebooks", nb.ref)).name === "My own title", "a notebook with a title of its own keeps it");
  const bd = await w.create("/s.board.json");
  await w.rename(bd.path, "/t.board.json");
  check((await w.read("/t.board.json")).content.title === "t", "a board titled as its file is retitled");
  // bytes at the new path, no entry: refused, nothing lost
  await rawPut(w.main, "files", enc("someone's"), "/y.txt");
  check(await fails(w.rename("/x.txt", "/y.txt"), "exists"), "a rename onto unlisted bytes is refused");
  check(dec(await rawGet(w.main, "files", "/y.txt")) === "someone's" && dec(await rawGet(w.main, "files", "/x.txt")) === "x", "…both kept");
  w.close();
}

async function trash() {
  const w = await fresh();
  await w.create("/d/a.txt", { content: "A" });
  const nb = await w.create("/d/n.ipynb");
  const t = await w.remove("/d");
  check(t.path === "/Trash/d" && t.trashed?.from === "/d", "a folder in Trash, remembering where it was");
  check((await paths(w, "/")).every((p) => !p.startsWith("/Trash")), "Trash isn't listed with the rest");
  check((await paths(w, "/Trash")).join() === "/Trash/d,/Trash/d/a.txt,/Trash/d/n.ipynb", "Trash lists what's in it");
  check((await rawKeys(w.main, "files")).length === 0, "a data file in Trash is out of Python's files");
  check(dec(await rawGet(w.ws, "trash", "/Trash/d/a.txt")) === "A", "…its bytes kept in the workspace's trash");
  check((await rawGet(w.main, "notebooks", nb.ref)) !== undefined, "a notebook in Trash is still kept");
  check(await fails(w.restore("/Trash/d/a.txt"), "invalid"), "something inside a folder in Trash comes back with the folder");
  await w.create("/d/new.txt", { content: "N" });
  const back = await w.restore("/Trash/d");
  check(back.path === "/d (2)" && !back.trashed, "restored beside what took its place: " + back.path);
  check(dec(await rawGet(w.main, "files", "/d (2)/a.txt")) === "A" && (await rawKeys(w.ws, "trash")).length === 0, "its bytes back where Python reads them");
  await w.remove("/d/new.txt");
  await w.create("/d/new.txt", { content: "N2" });
  await w.remove("/d/new.txt");
  check((await paths(w, "/Trash", false)).join() === "/Trash/new (2).txt,/Trash/new.txt", "two things of one name in Trash");
  check(typeof w.emptyTrash === "undefined" && typeof w.purge === "undefined", "no verb removes contents for good");
  w.close();
}

async function duplicates() {
  const w = await fresh();
  const bd = await w.create("/b.board.json", { content: board("B") });
  const d = await w.duplicate(bd.path);
  check(d.path === "/b (2).board.json" && d.ref !== bd.ref, "a board duplicated beside itself, as a board of its own");
  await w.write(d.path, board("changed"));
  check((await w.read(bd.path)).content.title === "B", "…changing the copy leaves the original");
  const nb = await w.create("/n.ipynb", { content: { cells: [{ id: "x", cell_type: "code", input: "2" }] } });
  const nd = await w.duplicate(nb.path, "/m.ipynb");
  const nr = await w.read(nd.path);
  check(nr.content.cells[0].input === "2" && nr.content.name === "m" && nd.ref !== nb.ref, "a notebook duplicated with its cells");
  check(await fails(w.duplicate(nb.path, "/m.board.json"), "invalid"), "a notebook's copy is a notebook");
  w.close();
}

async function limits() {
  const w = await fresh({ maxFileBytes: 10, maxBoardBytes: 200, maxEntries: 5 });
  check(await fails(w.create("/big.bin", { content: new Uint8Array(11) }), "limit"), "a file over the limit is refused");
  check((await rawKeys(w.main, "files")).length === 0, "…and nothing of it kept");
  check(await fails(w.create("/big.board.json", { content: board("x".repeat(300)) }), "limit"), "a board over the limit is refused");
  await w.create("/1.txt", { content: "" });
  await w.create("/2.txt", { content: "" });
  await w.create("/3.txt", { content: "" });
  await w.create("/4.txt", { content: "" });
  await w.create("/5.txt", { content: "" });
  check(await fails(w.create("/6.txt", { content: "" }), "limit"), "the workspace's entries are bounded");
  check((await rawKeys(w.main, "files")).length === 5, "…the refused file's bytes taken back");
  w.close();
}

async function opsAndWatch() {
  const w = await fresh();
  const other = await W.Workspace.open({ name: `ws-test-${n}`, mainName: `main-test-${n}` });
  const seen = [];
  other.watch((c) => seen.push(...c.ops.map((o) => o.op + " " + o.path)));
  await w.create("/a/x.txt", { content: "1" });
  await w.rename("/a/x.txt", "/a/y.txt");
  await w.remove("/a/y.txt");
  const log = (await w.ops()).map((o) => `${o.op} ${o.path}${o.to ? " " + o.to : ""}`);
  check(log.join("|") === "mkdir /a|create /a/x.txt|rename /a/x.txt /a/y.txt|mkdir /Trash|remove /a/y.txt /Trash/y.txt", "the operation log: " + log.join("|"));
  check((await w.ops()).every((o) => o.device === w.device && /^[0-9a-f]{16}$/.test(o.device)), "each op names this device");
  for (let i = 0; i < 50 && seen.length < 5; i++) await new Promise((r) => setTimeout(r, 20));
  check(seen.join("|") === "mkdir /a|create /a/x.txt|rename /a/x.txt|mkdir /Trash|remove /a/y.txt", "another tab's watcher is told: " + seen.join("|"));
  check(other.device === w.device, "the device id is this browser's, shared by its tabs");
  other.close();
  w.close();
}

async function concurrent() {
  const w = await fresh();
  const other = await W.Workspace.open({ name: `ws-test-${n}`, mainName: `main-test-${n}` });
  // two tabs making the same path at once: one of them, never both or a mixture
  const r = await Promise.allSettled([w.create("/same.txt", { content: "one" }), other.create("/same.txt", { content: "two" })]);
  check(r.filter((x) => x.status === "fulfilled").length === 1, "two tabs making one path: exactly one wins");
  const e = await w.stat("/same.txt"), bytes = dec(await rawGet(w.main, "files", "/same.txt"));
  const winner = r[0].status === "fulfilled" ? "one" : "two";
  check(bytes === winner && e.size === 3, "…its bytes are the winner's: " + bytes);
  // two renames of one folder: one wins, the other finds it gone
  await w.create("/f/z.txt", { content: "z" });
  const rr = await Promise.allSettled([w.rename("/f", "/g"), other.rename("/f", "/h")]);
  check(rr.filter((x) => x.status === "fulfilled").length === 1, "two renames of one folder: one wins");
  const where = (await paths(w)).filter((p) => p.endsWith("z.txt"));
  check(where.length === 1 && (await rawKeys(w.main, "files")).filter((k) => k.endsWith("z.txt")).length === 1, "…one copy of its file, in one place: " + where.join());
  other.close();
  w.close();
}

async function migration() {
  const w = await fresh();
  // what this browser has today
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  localStorage.setItem("sagebrush-board:local:" + ids[0], JSON.stringify(board("My board", { mode: "sage" })));
  localStorage.setItem("sagebrush-board:local:" + ids[0] + "#here", "1");
  localStorage.setItem("sagebrush-board:local:" + ids[0] + "#outputs", "0123456789abcdef0123456789abcdef");
  localStorage.setItem("sagebrush-board:local:" + ids[1], JSON.stringify(board("My board")));
  localStorage.setItem("sagebrush-boards", JSON.stringify([{ id: ids[0], title: "My board", mode: "sage", at: 1000 }, { id: ids[1], title: "My board", mode: "python", at: 2000 }]));
  localStorage.setItem("sagebrush-board:examples/primes.json", JSON.stringify(board("Primes, edited")));
  localStorage.setItem("sagebrush-board:examples/primes.json#outputs", "fedcba9876543210fedcba9876543210");
  localStorage.setItem("sagebrush-board:local:cccccccccccc", "{not json");
  localStorage.setItem("sagebrush-board:unsaved:python", JSON.stringify(board("not kept")));
  localStorage.setItem("sagebrush-current", "nb1");
  await rawPut(w.main, "notebooks", { id: "nb1", name: "", mode: "python", cells: [], rev: 3, updated: 5 });
  await rawPut(w.main, "notebooks", { id: "nb2", name: "Untitled", mode: "magma", cells: [], rev: 1, updated: 6 });
  await rawPut(w.main, "notebooks", { id: "nb3", name: "a/b", mode: "python", cells: [], rev: 1, updated: 7 });
  await rawPut(w.main, "files", enc("csv"), "/primes.csv");
  await rawPut(w.main, "files", enc("deep"), "/out/run1/result.txt");
  await rawPut(w.main, "files", enc("odd"), "relative.txt");
  const before = JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])));
  const r = await W.migrate(w, localStorage);
  const all = await paths(w);
  check(all.includes("/My board.board.json") && all.includes("/My board (2).board.json"), "boards made here listed, same titles apart: " + all.join());
  check(all.includes("/Edited examples/Primes, edited.board.json"), "an edited example is a board of its own");
  check(all.includes("/Untitled.ipynb") && all.includes("/Untitled (2).ipynb") && all.includes("/a-b.ipynb"), "notebooks listed by name, untitled and clashing ones apart");
  check(all.includes("/primes.csv") && all.includes("/out/run1/result.txt") && all.includes("/Recovered/relative.txt"), "data files at their paths; a key that isn't one in /Recovered");
  check((await w.stat("/Recovered/relative.txt")).ref === "relative.txt", "…still naming the bytes Python wrote");
  const b0 = await rawGet(w.ws, "boards", ids[0]);
  check(b0?.doc.title === "My board" && b0.docId === "0123456789abcdef0123456789abcdef", "a board keeps its id and its outputs' and history's name");
  const e0 = (await w.list("/")).find((e) => e.ref === ids[0]);
  check(e0?.mode === "sage" && e0.created === 1000, "…its language and when it was written");
  const ex = await w.stat("/Edited examples/Primes, edited.board.json");
  check(ex.origin === "examples/primes.json", "the edited example remembers its address");
  check(r.unreadable.join() === "sagebrush-board:local:cccccccccccc", "a key that isn't a board is reported");
  check(r.boards === 3 && r.notebooks === 3 && r.files === 2 && r.recovered === 1, "the report's counts: " + JSON.stringify(r));
  check(!all.some((p) => p.includes("not kept")), "a board storage refused (unsaved) isn't one to bring in");
  const after = JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])));
  check(before === after, "localStorage is left exactly as it was");
  check(localStorage.getItem("sagebrush-board:local:cccccccccccc") === "{not json", "…the unreadable key too");
  // again: nothing new
  const r2 = await W.migrate(w, localStorage);
  check((await paths(w)).join() === all.join() && r2.boards === 0 && r2.copies === 0 && r2.notebooks === 0 && r2.files === 0, "migrating again adds nothing");
  // an older tab writes the old copy: brought in as a copy, once
  localStorage.setItem("sagebrush-board:local:" + ids[0], JSON.stringify(board("My board", { mode: "sage", nodes: [{ id: "b", text: "later" }] })));
  const r3 = await W.migrate(w, localStorage);
  const now = await paths(w);
  check(r3.copies === 1 && now.includes("/My board (from an older tab).board.json"), "a later write by an older tab comes in as a copy");
  check((await rawGet(w.ws, "boards", ids[0])).doc.nodes[0].text === "hi", "…the board itself untouched");
  await W.migrate(w, localStorage);
  check((await paths(w)).length === now.length, "…and only once");
  // changed back to what was brought in first: nothing new (it was brought in already)
  localStorage.setItem("sagebrush-board:local:" + ids[0], JSON.stringify(board("My board", { mode: "sage" })));
  await W.migrate(w, localStorage);
  check((await paths(w)).length === now.length, "a document already brought in from a key isn't brought in again");
  // reconcile, later: new contents with no entry in /Recovered; contents gone marked, never dropped
  await rawPut(w.main, "notebooks", { id: "nb4", name: "Late", mode: "python", cells: [], rev: 1, updated: 8 });
  await rawDel(w.main, "notebooks", "nb2");
  const r4 = await W.migrate(w, localStorage);
  check((await paths(w)).includes("/Late.ipynb") && r4.notebooks === 1 && r4.recovered === 0, "a notebook found later (an older tab's) is listed at the top, as notebooks are");
  const gone = (await w.list("/")).find((e) => e.ref === "nb2");
  check(gone?.missing === true && r4.missing === 1, "an entry whose notebook is gone is marked missing, and kept");
  check(await fails(w.read(gone.path), "missing"), "…reading it says so");
  await rawPut(w.main, "notebooks", { id: "nb2", name: "Untitled", mode: "magma", cells: [], rev: 1, updated: 6 });
  await W.migrate(w, localStorage);
  check(!(await w.stat(gone.path)).missing, "…and unmarked when it's back");
  w.close();
}

// (localStorage that can't be written: what migrate must not need, CORR-4A0-2)
const readOnly = (m) => ({ get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem() { throw new Error("refused"); } });

async function migrationProvenance() {
  // edited examples and changed local boards, with localStorage refusing every write: each document once (CORR-4A0-2)
  let w = await fresh();
  let m = new Map([["sagebrush-board:examples/a.json", JSON.stringify(board("Edited"))]]);
  await W.migrate(w, readOnly(m));
  await W.migrate(w, readOnly(m));
  check((await w.list("/", { recursive: true })).filter((e) => e.kind === "board").length === 1, "an edited example is brought in once, with storage refusing writes");
  w.close();
  w = await fresh();
  m = new Map([["sagebrush-board:local:aaaaaaaaaaaa", JSON.stringify(board("Old"))]]);
  await W.migrate(w, readOnly(m));
  m.set("sagebrush-board:local:aaaaaaaaaaaa", JSON.stringify(board("Changed")));
  await W.migrate(w, readOnly(m));
  await W.migrate(w, readOnly(m));
  const names = (await w.list("/")).filter((e) => e.kind === "board").map((e) => e.path).sort();
  check(names.join() === "/Changed (from an older tab).board.json,/Old.board.json", "a changed board: the original and one copy: " + names.join());
  w.close();
}

async function recovery() {
  // bytes in Trash with no entry: a failure while recovering them leaves no entry without contents, and a retry makes one (CORR-4A0-1)
  const w = await fresh();
  await rawPut(w.ws, "trash", enc("only copy"), "/Trash/orphan.txt");
  const real = w.mainTx.bind(w);
  w.mainTx = async (st, mode, f) => { if (st === "files" && mode === "readwrite") throw new Error("injected file write failure"); return real(st, mode, f); };
  let threw = false;
  try { await W.migrate(w, readOnly(new Map())); } catch { threw = true; }
  w.mainTx = real;
  check(threw, "a failed write is said");
  check((await w.list("/", { recursive: true })).length === 0, "…and no entry was made");
  check(dec(await rawGet(w.ws, "trash", "/Trash/orphan.txt")) === "only copy", "…the bytes are still in Trash");
  // a stop after the bytes were written, before the entry: the retry reuses them
  const adopt = w.adopt.bind(w);
  w.adopt = async () => { throw new Error("injected stop"); };
  try { await W.migrate(w, readOnly(new Map())); } catch {}
  w.adopt = adopt;
  check(dec(await rawGet(w.main, "files", "/Recovered/orphan.txt")) === "only copy", "(the bytes were written before the stop)");
  await W.migrate(w, readOnly(new Map()));
  const all = await paths(w);
  check(all.join() === "/Recovered,/Recovered/orphan.txt", "the retry makes one entry, reusing the bytes: " + all.join());
  check(dec((await w.read("/Recovered/orphan.txt")).content) === "only copy" && (await rawKeys(w.ws, "trash")).length === 0, "…readable, and out of Trash");
  // a stop after the entry but before the Trash copy is dropped (as astra injected): the retry only finishes (CORR-094-1)
  await rawPut(w.ws, "trash", enc("second"), "/Trash/after-entry.txt");
  const adopt2 = w.adopt.bind(w);
  w.adopt = async (folder, base, ext, fields, also = {}) => { await adopt2(folder, base, ext, fields, { ...also, dropTrash: [], dropMeta: [] }); throw new Error("injected stop after the entry"); };
  try { await W.migrate(w, readOnly(new Map())); } catch {}
  w.adopt = adopt2;
  check((await w.stat("/Recovered/after-entry.txt")) !== undefined && (await rawGet(w.ws, "trash", "/Trash/after-entry.txt")) !== undefined, "(stopped with the entry made and the Trash copy still there)");
  await W.migrate(w, readOnly(new Map()));
  await W.migrate(w, readOnly(new Map()));
  const rec2 = (await paths(w, "/Recovered")).filter((p) => p.includes("after-entry"));
  check(rec2.join() === "/Recovered/after-entry.txt", "the retry finishes that recovery, adding no second entry: " + rec2.join());
  check((await rawGet(w.ws, "trash", "/Trash/after-entry.txt")) === undefined && dec((await w.read("/Recovered/after-entry.txt")).content) === "second", "…the Trash copy dropped, the bytes readable");
  // a user's own file with the same bytes, at the free name, is not taken for a recovery's
  await rawPut(w.main, "files", enc("same"), "/Recovered/twin.txt");
  await w.adopt("/Recovered", "twin", ".txt", { kind: "file", ref: "/Recovered/twin.txt", size: 4, rev: 0 }, { at: "/Recovered/twin.txt" });
  await rawPut(w.ws, "trash", enc("same"), "/Trash/twin.txt");
  await W.migrate(w, readOnly(new Map()));
  const twins = (await paths(w, "/Recovered")).filter((p) => p.includes("twin"));
  check(twins.join() === "/Recovered/twin (2).txt,/Recovered/twin.txt", "equal bytes don't make a user's file a recovery's: " + twins.join());
  // an entry naming no contents is shown missing
  await new Promise((ok) => { const tx = w.ws.transaction("entries", "readwrite"); tx.objectStore("entries").put({ path: "/broken.txt", kind: "file", ref: null, created: 0, updated: 0 }); tx.oncomplete = ok; });
  await W.migrate(w, readOnly(new Map()));
  check((await w.stat("/broken.txt")).missing === true, "an entry naming no contents is marked missing");
  w.close();
}

async function edges() {
  const w = await fresh();
  // a name starting with U+FFFF is in its folder's subtree (CORR-4A0-3)
  const u = "/f/" + String.fromCharCode(0xffff) + "x.txt";
  await w.create(u, { content: "hello" });
  check((await w.list("/f", { recursive: true })).length === 1, "a U+FFFF name is listed");
  await w.rename("/f", "/g");
  check((await w.stat("/g/" + String.fromCharCode(0xffff) + "x.txt")) !== undefined && !(await w.stat(u)) && dec(await rawGet(w.main, "files", "/g/" + String.fromCharCode(0xffff) + "x.txt")) === "hello", "…and moves with its folder, bytes and all");
  await w.remove("/g");
  check((await paths(w, "/Trash")).length === 2, "…and goes to Trash with it");
  // a move that would make a descendant too deep or too long is refused whole (CORR-4A0-4)
  await w.create("/a/x.txt", { content: "x" });
  const deep = "/" + Array(32).fill("d").join("/");
  check(await fails(w.rename("/a", deep), "invalid"), "a move making a path 33 deep is refused");
  check(dec((await w.read("/a/x.txt")).content) === "x" && !(await w.stat(deep)), "…nothing moved");
  await w.create("/b/" + "n".repeat(200) + ".txt", { content: "y" });
  const long = "/" + Array(4).fill("m".repeat(250)).join("/");
  check(await fails(w.rename("/b", long), "invalid"), "a move making a path over 1024 characters is refused");
  check((await w.stat("/b/" + "n".repeat(200) + ".txt")) !== undefined, "…nothing moved");
  w.close();
}

async function noLocks() {
  // without Web Locks, nothing is changed (CORR-4A0-5)
  const w = await fresh();
  const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, "locks");
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  try {
    const r = await Promise.allSettled([w.create("/race.txt", { content: "first" }), w.create("/race.txt", { content: "second" })]);
    check(r.every((x) => x.status === "rejected" && x.reason?.code === "storage"), "without Web Locks, changes are refused");
    check(!(await w.stat("/race.txt")) && (await rawKeys(w.main, "files")).length === 0, "…and nothing was written");
  } finally {
    delete navigator.locks;
    if (!("locks" in navigator) && desc) Object.defineProperty(Navigator.prototype, "locks", desc);
  }
  check(typeof navigator.locks?.request === "function", "(Web Locks restored)");
  w.close();
}

async function rollback() {
  // a clock set back: the count still holds (CORR-BEF-1)
  let clock = 1000;
  n++;
  localStorage.clear();
  const w = await W.Workspace.open({ name: `ws-test-${n}`, mainName: `main-test-${n}`, now: () => clock, limits: { ...W.LIMITS, maxVersions: 2 } });
  await w.create("/c.txt", { content: "c0" });
  for (const [t, x] of [[2000, "c1"], [3000, "c2"], [1500, "c3"]]) { clock = t; await w.write("/c.txt", x); }
  const h = await w.history("/c.txt");
  check(h.length === 2, "a clock set back: still at most maxVersions: " + h.length);
  check(dec(await w.version("/c.txt", 1)) === "c2" && dec(await w.version("/c.txt", 0)) === "c1", "…the latest ones kept, in the order kept");
  w.close();
}

async function dropping() {
  const w = await fresh();
  await w.create("/d/a.txt", { content: "a0" });
  await w.create("/d/b.txt", { content: "b0" });
  await w.create("/e.txt", { content: "e0" });
  for (const x of ["1", "2", "3"]) { await w.write("/d/a.txt", "a" + x); await w.write("/d/b.txt", "b" + x); await w.write("/e.txt", "e" + x); }
  w.actor = "agent:helper";
  check(await fails(w.dropVersions("/d/a.txt"), "invalid"), "an agent can't drop versions");
  check((await w.history("/d/a.txt")).length === 3, "…none dropped");
  w.actor = "person";
  check((await w.dropVersions("/d/a.txt", { keep: 1 })) === 4, "a person drops a file's older versions, keeping the latest (bytes freed)");
  check((await w.history("/d/a.txt")).length === 1 && dec(await w.version("/d/a.txt", 0)) === "a2", "…the latest kept");
  check((await w.dropVersions("/d")) === 8 && (await w.history("/d/b.txt")).length === 0, "…a folder's, all of them");
  check((await w.history("/e.txt")).length === 3, "…others' untouched");
  check((await w.dropVersions("/")) === 6 && (await w.history("/e.txt")).length === 0, "…everything's, with /");
  check((await w.ops()).filter((o) => o.op === "dropVersions").map((o) => o.path).join() === "/d/a.txt,/d,/", "each drop is logged");
  check(dec((await w.read("/d/a.txt")).content) === "a3", "the files themselves are untouched");
  w.close();
}

async function migrationFull() {
  // the workspace full part way: what fitted is in, the rest said, nothing lost
  const w = await fresh({ ...W.LIMITS, maxEntries: 2 });
  for (const id of ["dddddddddddd", "eeeeeeeeeeee", "ffffffffffff"]) localStorage.setItem("sagebrush-board:local:" + id, JSON.stringify(board("B " + id)));
  const r = await W.migrate(w, localStorage);
  check(typeof r.full === "string", "a full workspace is reported: " + r.full);
  check((await paths(w)).length === 2, "…what fitted is listed");
  check(["dddddddddddd", "eeeeeeeeeeee", "ffffffffffff"].every((id) => localStorage.getItem("sagebrush-board:local:" + id)), "…and every board is still where it was");
  w.close();
}

async function versions() {
  let clock = 1_000_000;
  n++;
  localStorage.clear();
  const open = (limits) => W.Workspace.open({ name: `ws-test-${n}`, mainName: `main-test-${n}`, now: () => clock, ...(limits ? { limits } : {}) });
  const w = await open();
  await w.create("/v.txt", { content: "v1" });
  clock += 10; await w.write("/v.txt", "v2");
  clock += 10; await w.write("/v.txt", "v3");
  let h = await w.history("/v.txt");
  check(h.length === 2 && dec(await w.version("/v.txt", 0)) === "v1" && dec(await w.version("/v.txt", 1)) === "v2", "each overwrite keeps what the file had, oldest first");
  check(h.every((v) => v.by === "person" && v.size === 2 && /^[0-9a-f]{64}$/.test(v.sha256)), "a version says who, how big, and its SHA-256");
  w.actor = "agent:helper";
  clock += 10; await w.write("/v.txt", "v4");
  h = await w.history("/v.txt");
  check(h.at(-1).by === "agent:helper" && (await w.ops()).at(-1).by === "agent:helper", "an agent's write is credited to it, in the version and the log");
  w.actor = "person";
  await w.rename("/v.txt", "/renamed.txt");
  check((await w.history("/renamed.txt")).length === 3, "a renamed file keeps its versions");
  await w.remove("/renamed.txt");
  await w.restore("/Trash/renamed.txt");
  check((await w.history("/renamed.txt")).length === 3, "…and through Trash and back");
  const nb = await w.create("/n.ipynb");
  check(await fails(w.history(nb.path), "invalid"), "a document's history is its TimeTravel, not this");
  w.close();
  // the bounds: a file's latest N; none older than the age; all within the bytes
  const w2 = await open({ ...W.LIMITS, maxVersions: 2, maxVersionAgeMs: 1000, maxVersionBytes: 9 });
  await w2.create("/a.txt", { content: "a1" });
  for (const x of ["a2", "a3", "a4"]) { clock += 10; await w2.write("/a.txt", x); }
  const ha = await w2.history("/a.txt");
  check(ha.length === 2 && dec(await w2.version("/a.txt", 0)) === "a2" && dec(await w2.version("/a.txt", 1)) === "a3", "a file keeps its latest versions: " + ha.length);
  clock += 5000; await w2.write("/a.txt", "a5");
  check((await w2.history("/a.txt")).length === 1, "versions past the age go (the one just kept stays)");
  await w2.create("/b.txt", { content: "bbbb" });
  clock += 10; await w2.write("/b.txt", "BBBB");
  clock += 10; await w2.write("/b.txt", "cccc");
  const total = (await w2.history("/a.txt")).reduce((s, v) => s + v.size, 0) + (await w2.history("/b.txt")).reduce((s, v) => s + v.size, 0);
  check(total <= 9 && (await w2.history("/b.txt")).length >= 1, "all versions together stay within their bytes, oldest dropped first: " + total);
  await w2.create("/big.txt", { content: "0123456789" });
  check(await fails(w2.write("/big.txt", "x"), "limit"), "a file whose present bytes can't be kept as a version isn't written over");
  check(dec((await w2.read("/big.txt")).content) === "0123456789", "…it keeps them");
  w2.close();
}

async function folderLimit() {
  // a folder holds at most maxFolderEntries of its own (LIMIT-094-1); folders apart don't share it
  const w = await fresh({ ...W.LIMITS, maxFolderEntries: 3 });
  for (const i of [1, 2, 3]) await w.create(`/f/${i}.txt`, { content: "" });
  check(await fails(w.create("/f/4.txt", { content: "" }), "limit"), "a fourth entry in a folder of three is refused");
  check(!(await w.stat("/f/4.txt")) && (await rawKeys(w.main, "files")).length === 3, "…and nothing of it kept");
  check(await fails(w.create("/f/sub/x.txt", { content: "" }), "limit"), "…a folder made on the way counts too");
  for (const i of [1, 2, 3]) await w.create(`/g/${i}.txt`, { content: "" });
  check((await w.list("/g")).length === 3, "another folder has its own room");
  check(await fails(w.rename("/g/1.txt", "/f/moved.txt"), "limit"), "a move into a full folder is refused");
  check((await w.stat("/g/1.txt")) !== undefined, "…nothing moved");
  await w.rename("/f/1.txt", "/f/one.txt");
  check((await w.stat("/f/one.txt")) !== undefined, "a rename within a full folder is fine");
  await w.create("/top.txt", { content: "" });
  check(await fails(w.create("/top2.txt", { content: "" }), "limit"), "the top folder is bounded too (f, g, top.txt)");
  const deep = await fresh({ ...W.LIMITS, maxFolderEntries: 3 });
  for (let i = 0; i < 5; i++) await deep.create(`/d/s${i}/x.txt`, { content: "" }).catch(() => {});
  check((await deep.list("/d")).length === 3, "a folder with many below it, but only its own counted: " + (await deep.list("/d")).length);
  check((await deep.list("/d/s0", {})).length === 1, "…its subfolders hold their own");
  w.close();
  deep.close();
}

async function recoveryConflict() {
  // a stop after the destination was recorded, before the bytes; then a person makes a file at that very path: the original is never dropped for it (CORR-DF0-1)
  const w = await fresh();
  await rawPut(w.ws, "trash", enc("IRREPLACEABLE ORIGINAL"), "/Trash/conflict.txt");
  const real = w.mainTx.bind(w);
  w.mainTx = async (st, mode, f) => { if (st === "files" && mode === "readwrite") throw new Error("injected file write failure"); return real(st, mode, f); };
  try { await W.migrate(w, readOnly(new Map())); } catch {}
  w.mainTx = real;
  await w.create("/Recovered/conflict.txt", { content: "unrelated user file" });
  await W.migrate(w, readOnly(new Map()));
  check(dec((await w.read("/Recovered/conflict.txt")).content) === "unrelated user file", "the person's file is untouched");
  const all = (await paths(w, "/Recovered")).filter((p) => p.includes("conflict"));
  const found = [];
  for (const p of all) found.push(dec((await w.read(p)).content));
  check(found.includes("IRREPLACEABLE ORIGINAL"), "the original is recovered beside it: " + all.join());
  check((await rawGet(w.ws, "trash", "/Trash/conflict.txt")) === undefined, "…and only then out of Trash");
  // a file where the /Recovered folder would be: recovery stops, the original stays in Trash; once it's gone, recovery finishes
  const v = await fresh();
  await v.create("/Recovered", { content: "a file named Recovered" });
  await rawPut(v.ws, "trash", enc("ORIGINAL 2"), "/Trash/blocked.txt");
  let threw = false;
  try { await W.migrate(v, readOnly(new Map())); } catch { threw = true; }
  check(threw && dec(await rawGet(v.ws, "trash", "/Trash/blocked.txt")) === "ORIGINAL 2", "a file in the folder's way: nothing recovered, the original still in Trash");
  check(dec((await v.read("/Recovered")).content) === "a file named Recovered", "…the file in the way untouched");
  await v.rename("/Recovered", "/Recovered.txt");
  await W.migrate(v, readOnly(new Map()));
  const got = (await paths(v, "/Recovered")).filter((p) => p.includes("blocked"));
  check(got.length === 1 && dec((await v.read(got[0])).content) === "ORIGINAL 2" && (await rawGet(v.ws, "trash", "/Trash/blocked.txt")) === undefined, "…then recovered once the way is clear: " + got.join());
  w.close();
  v.close();
}

export async function run() {
  for (const t of [paths_, createAndRead, writeCas, renames, trash, duplicates, limits, opsAndWatch, concurrent, versions, migration, migrationProvenance, recovery, recoveryConflict, edges, noLocks, rollback, dropping, folderLimit, migrationFull]) {
    try { await t(); } catch (e) { results.push([false, `${t.name} threw: ${e?.stack ?? e}`]); }
  }
  return results;
}
