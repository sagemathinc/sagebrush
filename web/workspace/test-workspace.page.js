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
// (a data file's bytes where they are kept now: fileBytes, under its own id, beside the index: capabilities §2a)
const fb = async (w, p) => { const e = await w.stat(p); return e?.fid ? rawGet(w.ws, "fileBytes", e.fid) : undefined; };

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
  check(f.ref === "/data/primes.csv" && f.size === 6 && f.migrated === true, "a data file, at its path, kept beside the index");
  check(dec(await fb(w, "/data/primes.csv")) === "2\n3\n5\n" && (await rawGet(w.main, "files", "/data/primes.csv")) === undefined, "its bytes in fileBytes, under its id, not the old way");
  check(await fails(w.create("/data/primes.csv", { content: "x" }), "exists"), "a taken path is refused");
  check(dec(await fb(w, "/data/primes.csv")) === "2\n3\n5\n", "…and not written over");
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
  check((await w.history(g.path)).length === 1 && (await w.version(g.path, 0)).length === 0, "an empty file written over is kept as a version (CORR-12C-4)");
  await w.write(g.path, "", { keepEmpty: false });
  await w.write(g.path, "again", { keepEmpty: false });
  check((await w.history(g.path)).length === 2, "…but Python's emptying before a write (keepEmpty: false) keeps no empty version");
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
  check(keys.length === 0 && dec(await fb(w, "/work/data/a.csv")) === "1" && dec((await w.read("/work/data/b.csv")).content) === "2", "data files' bytes stay under their ids, readable at their new paths: " + keys.join());
  check((await w.stat("/work/data/a.csv")).ref === "/work/data/a.csv", "…and their entries name them there");
  check(await fails(w.rename("/work", "/work/inside"), "invalid"), "a folder can't go inside itself");
  await w.create("/x.txt", { content: "x" });
  check(await fails(w.rename("/x.txt", "/work"), "exists"), "renaming onto a taken path is refused");
  check(dec(await fb(w, "/x.txt")) === "x" && !!(await w.stat("/x.txt")), "…and changes nothing");
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
  check(dec(await rawGet(w.main, "files", "/y.txt")) === "someone's" && dec(await fb(w, "/x.txt")) === "x", "…both kept");
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
  check(dec(await fb(w, "/Trash/d/a.txt")) === "A" && (await rawKeys(w.ws, "trash")).length === 0, "…its bytes kept where they were, under its id");
  check((await rawGet(w.main, "notebooks", nb.ref)) !== undefined, "a notebook in Trash is still kept");
  check(await fails(w.restore("/Trash/d/a.txt"), "invalid"), "something inside a folder in Trash comes back with the folder");
  await w.create("/d/new.txt", { content: "N" });
  const back = await w.restore("/Trash/d");
  check(back.path === "/d (2)" && !back.trashed, "restored beside what took its place: " + back.path);
  check(dec(await fb(w, "/d (2)/a.txt")) === "A" && dec((await w.read("/d (2)/a.txt")).content) === "A", "its bytes readable where it is back");
  await w.remove("/d/new.txt");
  await w.create("/d/new.txt", { content: "N2" });
  await w.remove("/d/new.txt");
  check((await paths(w, "/Trash", false)).join() === "/Trash/new (2).txt,/Trash/new.txt", "two things of one name in Trash");
  const ag = w.forAgent("agent:x");
  check(typeof ag.emptyTrash === "undefined" && typeof ag.dropVersions === "undefined" && typeof ag.forget === "undefined", "no agent verb removes contents for good");
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
  check((await rawKeys(w.main, "files")).length === 0 && (await rawKeys(w.ws, "fileBytes")).length === 0, "…and nothing of it kept");
  check(await fails(w.create("/big.board.json", { content: board("x".repeat(300)) }), "limit"), "a board over the limit is refused");
  await w.create("/1.txt", { content: "" });
  await w.create("/2.txt", { content: "" });
  await w.create("/3.txt", { content: "" });
  await w.create("/4.txt", { content: "" });
  await w.create("/5.txt", { content: "" });
  check(await fails(w.create("/6.txt", { content: "" }), "limit"), "the workspace's entries are bounded");
  check((await rawKeys(w.ws, "fileBytes")).length === 5, "…nothing of the refused file kept (its bytes in its entry's one transaction)");
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
  const e = await w.stat("/same.txt"), bytes = dec(await fb(w, "/same.txt"));
  const winner = r[0].status === "fulfilled" ? "one" : "two";
  check(bytes === winner && e.size === 3, "…its bytes are the winner's: " + bytes);
  // two renames of one folder: one wins, the other finds it gone
  await w.create("/f/z.txt", { content: "z" });
  const rr = await Promise.allSettled([w.rename("/f", "/g"), other.rename("/f", "/h")]);
  check(rr.filter((x) => x.status === "fulfilled").length === 1, "two renames of one folder: one wins");
  const where = (await paths(w)).filter((p) => p.endsWith("z.txt"));
  check(where.length === 1 && (await rawKeys(w.ws, "fileBytes")).length === 2 && dec(await fb(w, where[0])) === "z", "…one copy of its file, in one place: " + where.join());
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
  check((await w.stat("/g/" + String.fromCharCode(0xffff) + "x.txt")) !== undefined && !(await w.stat(u)) && dec(await fb(w, "/g/" + String.fromCharCode(0xffff) + "x.txt")) === "hello", "…and moves with its folder, bytes and all");
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
  check(!(await w.stat("/f/4.txt")) && (await rawKeys(w.ws, "fileBytes")).length === 3, "…and nothing of it kept");
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

async function emptying() {
  const w = await fresh();
  const nb = await w.create("/t/n.ipynb");
  const bd = await w.create("/t/b.board.json");
  await w.create("/t/f.txt", { content: "v1" });
  await w.write("/t/f.txt", "v2");
  const keep = await w.create("/keep.txt", { content: "stay" });
  const fid = (await w.stat("/t/f.txt")).fid;
  // (rows of each document's TimeTravel, as the pages keep them)
  const putRow = (name, nbKey) => new Promise((ok) => { const r = indexedDB.open(name); r.onsuccess = () => { const tx = r.result.transaction("history", "readwrite"); tx.objectStore("history").put({ nb: nbKey, time: 1, env: {} }); tx.oncomplete = () => { r.result.close(); ok(); }; }; });
  const countRows = (name, nbKey) => new Promise((ok) => { const r = indexedDB.open(name); r.onsuccess = () => { const q = r.result.transaction("history").objectStore("history").count(IDBKeyRange.bound([nbKey, -Infinity], [nbKey, Infinity])); q.onsuccess = () => { r.result.close(); ok(q.result); }; }; });
  await new Promise((ok) => { const r = indexedDB.open("sagebrush-history"); r.onupgradeneeded = () => r.result.createObjectStore("history", { keyPath: ["nb", "time"] }); r.onsuccess = () => { r.result.close(); ok(); }; });
  await new Promise((ok) => { const r = indexedDB.open("sagebrush-board-history"); r.onupgradeneeded = () => r.result.createObjectStore("history", { keyPath: ["nb", "time"] }); r.onsuccess = () => { r.result.close(); ok(); }; });
  await putRow("sagebrush-history", nb.ref);
  await putRow("sagebrush-board-history", "board:local:" + bd.ref + ":0123456789abcdef0123456789abcdef");
  await w.remove("/t");
  w.actor = "agent:helper";
  check(await fails(w.emptyTrash(), "invalid"), "an agent can't empty Trash");
  w.actor = "person";
  check(await fails(w.emptyTrash(["/keep.txt"]), "invalid"), "emptyTrash takes only what is in Trash");
  check((await w.emptyTrash()) === 4, "emptying Trash removes its entries (a folder and three)");
  check((await paths(w, "/Trash")).length === 0 && (await w.stat("/keep.txt")) !== undefined, "…Trash is empty, the rest stays");
  check((await rawGet(w.main, "notebooks", nb.ref)) === undefined && (await rawGet(w.ws, "boards", bd.ref)) === undefined && (await rawKeys(w.ws, "trash")).length === 0, "…their contents are gone");
  check((await countRows("sagebrush-history", nb.ref)) === 0, "…the notebook's TimeTravel too");
  check((await countRows("sagebrush-board-history", "board:local:" + bd.ref + ":0123456789abcdef0123456789abcdef")) === 0, "…and the board's");
  const vs = await new Promise((ok) => { const q = w.ws.transaction("versions").objectStore("versions").index("byFile").count(IDBKeyRange.bound([fid, -Infinity], [fid, Infinity])); q.onsuccess = () => ok(q.result); });
  check(vs === 0, "…and the file's versions");
  check((await w.ops()).some((o) => o.op === "emptyTrash"), "emptying Trash is logged");
  // one item of Trash only
  await w.remove("/keep.txt");
  await w.create("/other.txt", { content: "o" });
  await w.remove("/other.txt");
  check((await w.emptyTrash(["/Trash/keep.txt"])) === 1 && (await w.stat("/Trash/other.txt")) !== undefined, "emptying one item leaves the rest of Trash");
  check(typeof (w.forAgent("agent:x")).emptyTrash === "undefined", "the agent facade has no emptyTrash");
  w.close();
}

// Undo of Move to Trash: that entry, put in Trash that time, only
// (CORR-0B0-3); a rename asked for earlier and superseded, not made
// (CORR-0B0-1); a rename that leaves the title to the page (CORR-0B0-2)
// Step 2b's: what is held (versionsUsage, usage), a version by its id, and
// the browser asked once, on the person's first own write, to keep the
// storage (never for an agent's or the migration's).  First: the ask is
// once per page.
async function storageUse() {
  let asked = 0;
  try { Object.defineProperty(navigator.storage, "persist", { value: async () => { asked++; return true; }, configurable: true }); } catch {}
  const w = await fresh();
  localStorage.setItem("sagebrush-board:local:aaaaaaaaaaaa", JSON.stringify({ title: "Kept before", nodes: [] }));
  await W.migrate(w, localStorage);
  await w.forAgent("agent:x").create("/by-agent.txt", { content: "a" });
  check(asked === 0, "the migration's and an agent's writes don't ask the browser to keep the storage");
  await w.create("/d/one.txt", { content: "1" });
  await w.write("/d/one.txt", "11");
  await w.write("/d/one.txt", "111");
  check(asked === 1, "the person's first write asks it, once (" + asked + ")");
  await w.create("/d/two.csv", { content: "a,b" });
  await w.write("/d/two.csv", "a,b,c");
  await w.create("/top.txt", { content: "t" });
  await w.write("/top.txt", "tt");
  await w.create("/n.ipynb");
  const f1 = await w.versionsUsage("/d/one.txt"), fd = await w.versionsUsage("/d"), all = await w.versionsUsage();
  check(f1.count === 2 && f1.bytes === 1 + 2, "versionsUsage of a file: its versions and their bytes " + JSON.stringify(f1));
  check(fd.count === 3 && fd.bytes === 3 + 3, "…of a folder, its files' " + JSON.stringify(fd));
  check(all.count === 4 && all.bytes === 3 + 3 + 1, "…of everything " + JSON.stringify(all));
  check((await w.versionsUsage("/n.ipynb")).count === 0, "…of a notebook: none (its history is TimeTravel)");
  const hist = await w.history("/d/one.txt");
  check(dec(await w.versionById("/d/one.txt", hist[0].id)) === "1" && dec(await w.versionById("/d/one.txt", hist[1].id)) === "11", "versionById: a version's bytes by its id");
  check(await fails(w.versionById("/top.txt", hist[0].id), "missing"), "…another file's version id is refused");
  await w.dropVersions("/d/one.txt", { keep: 1 });
  check(dec(await w.versionById("/d/one.txt", hist[1].id)) === "11" && await fails(w.versionById("/d/one.txt", hist[0].id), "missing"), "…an id stays its version's when older ones are dropped; a dropped one is missing");
  await w.remove("/top.txt");
  const u = await w.usage();
  check(u.documents === 2 && u.files.count === 3 && u.files.bytes === 3 + 5 + 1 && u.trash.count === 1 && u.trash.bytes === 2 && u.versions.count === 3, "usage: documents, files, versions and Trash " + JSON.stringify(u));
  check((await w.dropVersions("/")) === 2 + 3 + 1 && (await w.versionsUsage()).count === 0 && (await w.versionsUsage()).bytes === 0, "dropping all of them frees what versionsUsage said");
  w.close();
}

// Version actions bound to what was shown (CORR-F85-1, -2), and
// dropVersions bounded (LIMIT-F85-2): a file's or a folder's never reads
// another file's versions; all of them, a bounded batch at a time.
async function versionActions() {
  const w = await fresh();
  await w.create("/victim.txt", { content: "original" });
  await w.write("/victim.txt", "original current");
  const shown = await w.stat("/victim.txt"), ids = (await w.history("/victim.txt")).map((v) => v.id);
  await w.rename("/victim.txt", "/moved.txt");
  await w.create("/victim.txt", { content: "replacement" });
  await w.write("/victim.txt", "replacement 2");
  check(await fails(w.dropVersions("/victim.txt", { expect: { fid: shown.fid, ids } }), "conflict"), "dropVersions of the file shown, another file at its path now: refused");
  check((await w.history("/moved.txt")).length === 1 && (await w.history("/victim.txt")).length === 1, "…nothing of either dropped");
  check(await fails(w.restoreVersion("/victim.txt", ids[0], { fid: shown.fid, rev: shown.rev }), "missing"), "restoreVersion: the shown file's version, at a path now another file's: refused");
  const moved = await w.stat("/moved.txt");
  check(await fails(w.restoreVersion("/moved.txt", ids[0], { fid: moved.fid, rev: moved.rev - 1 }), "conflict") && dec((await w.read("/moved.txt")).content) === "original current", "restoreVersion over a revision since written: refused, nothing written");
  const vid = (await w.history("/victim.txt"))[0].id, rep = await w.stat("/victim.txt");
  check(await fails(w.write("/victim.txt", "x", { fid: shown.fid }), "conflict") && dec((await w.read("/victim.txt")).content) === "replacement 2", "write with another file's fid: refused");
  check(await fails(w.restoreVersion("/victim.txt", ids[0], { fid: rep.fid, rev: rep.rev }), "missing"), "…a version id of another file: refused");
  await w.restoreVersion("/moved.txt", ids[0], { fid: moved.fid, rev: moved.rev });
  check(dec((await w.read("/moved.txt")).content) === "original" && (await w.history("/moved.txt")).length === 2, "restoreVersion of the file shown, as shown: written back, what it had kept");
  // only the confirmed ids go; a folder's confirmation of another count, or another folder: refused
  await w.write("/moved.txt", "third");
  const h3 = await w.history("/moved.txt"), m3 = await w.stat("/moved.txt");
  await w.dropVersions("/moved.txt", { expect: { fid: m3.fid, ids: [h3[0].id] } });
  check((await w.history("/moved.txt")).map((v) => v.id).join() === h3.slice(1).map((v) => v.id).join(), "dropVersions with ids: only those go");
  await w.mkdir("/f");
  await w.create("/f/a.txt", { content: "1" });
  await w.write("/f/a.txt", "2");
  const fu = await w.versionsUsage("/f"), fe = await w.stat("/f");
  await w.write("/f/a.txt", "3");
  check(await fails(w.dropVersions("/f", { expect: { count: fu.count, bytes: fu.bytes, created: fe.created } }), "conflict") && (await w.versionsUsage("/f")).count === 2, "a folder's, its versions changed since confirmed: refused, nothing dropped");
  check(await fails(w.dropVersions("/f", { expect: { created: fe.created + 1 } }), "conflict"), "…another folder at its path: refused");
  const fu2 = await w.versionsUsage("/f");
  check((await w.dropVersions("/f", { expect: { count: fu2.count, bytes: fu2.bytes, created: fe.created } })) === fu2.bytes && (await w.versionsUsage("/f")).count === 0, "…as confirmed: dropped");
  // many small versions of other files: a file's drop reads only its own; all of them, in batches
  const many = 2500;
  await new Promise((ok) => { const tx = w.ws.transaction(["versions", "versionBytes", "meta"], "readwrite"), vs = tx.objectStore("versions"), vb = tx.objectStore("versionBytes"); for (let i = 0; i < many; i++) { const q = vs.add({ fid: "zz" + i, t: i, size: 1, sha256: "", by: "person", device: "d" }); q.onsuccess = () => vb.put(new Uint8Array([1]), q.result); } const m = tx.objectStore("meta"), g = m.get("versionBytes"); g.onsuccess = () => m.put((g.result ?? 0) + many, "versionBytes"); tx.oncomplete = ok; });
  const unbounded = [];
  const wrap = (proto) => { const orig = proto.getAll; proto.getAll = function (q, n) { if (q == null && (this.name === "byFile" || this.name === "versions")) unbounded.push([this.name, n]); return orig.apply(this, arguments); }; return () => (proto.getAll = orig); };
  const un1 = wrap(IDBIndex.prototype), un2 = wrap(IDBObjectStore.prototype);
  try {
    await w.write("/moved.txt", "fourth");
    await w.dropVersions("/moved.txt");
    check(unbounded.length === 0, "dropping a file's versions reads no other file's: " + JSON.stringify(unbounded));
    const before = (await w.versionsUsage()).count;
    const freed = await w.dropVersions("/");
    check(unbounded.length > 1 && unbounded.every(([name, n]) => name === "versions" && n === 1000), "all of them: a batch of at most 1,000 records at a time (" + unbounded.length + " batches)");
    check(before >= many && freed >= many && (await w.versionsUsage()).count === 0 && (await w.versionsUsage()).bytes === 0, "…all gone, the total 0 (" + before + ", " + freed + ")");
  } finally { un1(); un2(); }
  w.close();
}

// A bulk drop confirmed, then a version kept: it stays (CORR-AC5-1); a
// rename bound to its entry (CORR-4B2-1); a read up to a size (LIMIT-F85-1)
async function fences() {
  const w = await fresh({ ...W.LIMITS, maxVersions: 3 });
  await w.create("/r.txt", { content: "a1" });
  for (const v of ["a2", "a3", "a4"]) await w.write("/r.txt", v);
  const u = await w.versionsUsage();
  check(u.count === 3 && u.maxId > 0, "versionsUsage gives the newest version's id " + JSON.stringify(u));
  await w.write("/r.txt", "a5");
  const u2 = await w.versionsUsage();
  check(u2.count === u.count && u2.bytes === u.bytes && u2.maxId > u.maxId, "(retention: the same count and bytes, another version " + JSON.stringify(u2) + ")");
  await w.dropVersions("/", { expect: { maxId: u.maxId } });
  const left = await w.history("/r.txt");
  check(left.length === 1 && left[0].id === u2.maxId && dec(await w.versionById("/r.txt", left[0].id)) === "a4", "everything's drop, confirmed before a version was kept: that version stays");
  check((await w.versionsUsage()).bytes === 2, "…and the total counts it (CORR-5D2-1): " + JSON.stringify(await w.versionsUsage()));
  await w.write("/r.txt", "a6");
  check((await w.versionsUsage()).bytes === 4 && (await w.history("/r.txt")).length === 2, "…and keeps counting after: " + JSON.stringify(await w.versionsUsage()));
  await w.mkdir("/f");
  await w.create("/f/s.txt", { content: "b1" });
  await w.write("/f/s.txt", "b2");
  const fu = await w.versionsUsage("/f"), fe = await w.stat("/f");
  await w.write("/f/s.txt", "b3");
  await w.dropVersions("/f", { expect: { created: fe.created, maxId: fu.maxId } });
  check((await w.history("/f/s.txt")).length === 1 && dec(await w.version("/f/s.txt", 0)) === "b2", "a folder's drop, confirmed before a version was kept: that version stays");
  // a file moved into the folder after it was confirmed: refused, its history kept (CORR-5D2-2)
  await w.mkdir("/g");
  await w.create("/h.txt", { content: "h1" });
  await w.write("/h.txt", "h2");
  await w.create("/g/k.txt", { content: "k1" });
  await w.write("/g/k.txt", "k2");
  const gu = await w.versionsUsage("/g"), ge = await w.stat("/g");
  await w.rename("/h.txt", "/g/h.txt");
  check(await fails(w.dropVersions("/g", { expect: { created: ge.created, maxId: gu.maxId, seq: gu.seq } }), "conflict") && (await w.history("/g/h.txt")).length === 1 && (await w.history("/g/k.txt")).length === 1, "a folder's drop, a file moved in since it was confirmed: refused, nothing dropped");
  await w.write("/g/k.txt", "k3");
  const gu2 = await w.versionsUsage("/g");
  await w.write("/g/k.txt", "k4");
  check((await w.dropVersions("/g", { expect: { created: ge.created, maxId: gu2.maxId, seq: gu2.seq } })) === 2 + 2 + 2 && (await w.history("/g/h.txt")).length === 0 && (await w.history("/g/k.txt")).length === 1, "…confirmed again, only writes since: dropped, the version kept since stays");
  // rename bound to its entry
  await w.create("/rename.txt", { content: "original" });
  const orig = await w.stat("/rename.txt");
  await w.rename("/rename.txt", "/moved-rename.txt");
  await w.create("/rename.txt", { content: "replacement" });
  check(await fails(w.rename("/rename.txt", "/renamed.txt", { expect: orig }), "conflict") && (await w.stat("/renamed.txt")) === undefined && dec((await w.read("/rename.txt")).content) === "replacement", "a rename bound to an entry moved away, another at its path: refused, nothing moved");
  const rep = await w.stat("/rename.txt");
  check((await w.rename("/rename.txt", "/renamed.txt", { expect: rep })).path === "/renamed.txt", "…bound to the one there, made");
  const nb = await w.create("/doc.ipynb");
  check((await w.rename("/doc.ipynb", "/doc2.ipynb", { expect: nb })).path === "/doc2.ipynb", "…a document bound to its ref");
  // to Trash bound to its entry (the File menu's Delete)
  await w.create("/del.txt", { content: "original" });
  const delOrig = await w.stat("/del.txt");
  await w.rename("/del.txt", "/del-moved.txt");
  await w.create("/del.txt", { content: "replacement" });
  check(await fails(w.remove("/del.txt", delOrig), "conflict") && dec((await w.read("/del.txt")).content) === "replacement" && (await w.stat("/Trash/del.txt")) === undefined, "a remove bound to an entry moved away, another at its path: refused, nothing in Trash");
  check((await w.remove("/del-moved.txt", delOrig)).path === "/Trash/del-moved.txt", "…bound to it where it is now: in Trash");
  const dn = await w.create("/deldoc.ipynb");
  await w.rename("/deldoc.ipynb", "/deldoc-moved.ipynb");
  await w.create("/deldoc.ipynb");
  check(await fails(w.remove("/deldoc.ipynb", dn), "conflict") && (await w.stat("/deldoc.ipynb")) !== undefined, "…a document: another notebook at its path, refused");
  check((await w.remove("/deldoc-moved.ipynb", dn)).path === "/Trash/deldoc-moved.ipynb", "…the notebook itself, by its ref: in Trash");
  // a read up to a size
  await w.create("/ten.txt", { content: "0123456789" });
  check(await fails(w.readUpTo("/ten.txt", 9), "limit") && dec((await w.readUpTo("/ten.txt", 10)).content) === "0123456789", "readUpTo: refused past its size, read within it");
  w.close();
}

async function intents() {
  const w = await fresh();
  await w.create("/undo.txt", { content: "original" });
  const t = await w.remove("/undo.txt");
  await w.restore("/Trash/undo.txt");
  await w.rename("/undo.txt", "/original-moved.txt");
  await w.create("/undo.txt", { content: "UNRELATED" });
  const t2 = await w.remove("/undo.txt");
  check(t2.path === t.path, "(a different file in Trash at the same path)");
  check(await fails(w.restore(t.path, t), "missing"), "Undo of a file restored, renamed, and its name's new file trashed: refused");
  check(dec((await w.read("/Trash/undo.txt")).content) === "UNRELATED" && (await w.stat("/undo.txt")) === undefined && dec((await w.read("/original-moved.txt")).content) === "original", "…nothing moved");
  check((await w.restore(t2.path, t2)).path === "/undo.txt", "Undo of the one there now restores it");
  // a document: the same id trashed again later is another time in Trash
  const nb = await w.create("/n.ipynb");
  const tn = await w.remove("/n.ipynb");
  await w.restore(tn.path);
  const tn2 = await w.remove("/n.ipynb");
  check(tn2.ref === nb.ref && await fails(w.restore(tn.path, tn), "missing"), "Undo of a notebook since restored and trashed again: refused");
  check((await w.restore(tn2.path, tn2)).path === "/n.ipynb", "…and of the latest time, restored");
  // a folder (no id of its own): when it was made and trashed
  await w.mkdir("/d");
  const td = await w.remove("/d");
  await w.restore(td.path);
  await w.rename("/d", "/d-moved");
  await w.mkdir("/d");
  await w.remove("/d");
  check(await fails(w.restore(td.path, td), "missing") && (await w.stat("/d-moved")) !== undefined, "Undo of a folder whose name is now another folder's in Trash: refused");
  // a clock that ties (CORR-989-2): a folder (no id, no fid), restored and
  // moved away, its name's new folder trashed at the same time; and one
  // file put in Trash twice at the same time: each time is its own
  {
    const t = Date.now(), wt = await W.Workspace.open({ name: `ws-test-tied-${n}`, mainName: `main-test-tied-${n}`, now: () => t });
    await wt.mkdir("/collision");
    await wt.create("/collision/original.txt", { content: "ORIGINAL" });
    const old = await wt.remove("/collision");
    await wt.restore(old.path);
    await wt.rename("/collision", "/original-kept");
    await wt.mkdir("/collision");
    await wt.create("/collision/replacement.txt", { content: "UNRELATED" });
    const repl = await wt.remove("/collision");
    check(await fails(wt.restore(old.path, old), "missing") && (await wt.stat("/Trash/collision/replacement.txt")) !== undefined && (await wt.stat("/collision")) === undefined, "same clock: Undo of a folder whose name is another folder's in Trash now, refused: " + JSON.stringify([old.trashed, repl.trashed]));
    await wt.create("/same.txt", { content: "s" });
    const once = await wt.remove("/same.txt");
    await wt.restore(once.path);
    const twice = await wt.remove("/same.txt");
    check(await fails(wt.restore(once.path, once), "missing"), "same clock: Undo of the first time a file went to Trash, after it was restored and trashed again: refused");
    check((await wt.restore(twice.path, twice)).path === "/same.txt", "…of the second, restored");
    wt.close();
  }
  // superseded: nothing moved, undefined
  check((await w.rename("/n.ipynb", "/m.ipynb", { still: () => false })) === undefined && (await w.stat("/n.ipynb")) !== undefined, "a rename superseded by the time it holds the lock: not made");
  check((await w.rename("/n.ipynb", "/m.ipynb", { still: () => true }))?.path === "/m.ipynb", "…and one still current, made");
  // the title left to the page
  const rec = await w.read("/m.ipynb");
  await w.write("/m.ipynb", { ...rec.content, name: "m" }, { base: rec.rev });
  await w.rename("/m.ipynb", "/k.ipynb", { retitle: false });
  check((await w.read("/k.ipynb")).content.name === "m", "retitle: false leaves the notebook's name to the page");
  const rk = await w.read("/k.ipynb");
  await w.write("/k.ipynb", { ...rk.content, name: "k" }, { base: rk.rev });
  await w.rename("/k.ipynb", "/j.ipynb");
  check((await w.read("/j.ipynb")).content.name === "j", "…which a rename otherwise makes its new name (its name having been its file's)");
  // emptying Trash of a board: what the board page keeps of it in localStorage goes too, another board's stays
  const gone = await w.create("/gone.board.json"), kept = await w.create("/kept.board.json");
  for (const b of [gone, kept]) for (const k of Object.values(W.BOARD_KEYS)) localStorage.setItem(k(b.ref), "x");
  await w.remove("/gone.board.json");
  await w.emptyTrash();
  check(Object.values(W.BOARD_KEYS).every((k) => localStorage.getItem(k(gone.ref)) === null), "emptying Trash of a board removes its copy from before, its mark as written here, and a closed page's changes");
  check(Object.values(W.BOARD_KEYS).every((k) => localStorage.getItem(k(kept.ref)) === "x"), "…and not another board's");
  w.close();
}

// Recent (fileopen.ts), the entry at a document's path checked to be it:
// pathOf's answer held while the document moves away and another is put
// at its path (CORR-FD1-2)
async function recent() {
  const w = await fresh();
  const F = await import("./fileopen.js");
  const a = await w.create("/RecentA.ipynb");
  localStorage.setItem("sagebrush-recent-opened", JSON.stringify([{ kind: "notebook", ref: a.ref }]));
  let entered, release, first = true;
  const ready = new Promise((r) => (entered = r)), hold = new Promise((r) => (release = r)), old = w.pathOf.bind(w);
  w.pathOf = async (...args) => { const p = await old(...args); if (first) { first = false; entered(); await hold; } return p; };
  const pending = F.recentOpened(w);
  await ready;
  await w.rename("/RecentA.ipynb", "/MovedA.ipynb");
  const b = await w.create("/RecentA.ipynb");
  release();
  const got = await pending;
  w.pathOf = old;
  check(got.length === 1 && got[0].ref === a.ref && got[0].ref !== b.ref && got[0].path === "/MovedA.ipynb", "Recent: a document moved while it was looked up, another at its old path: it is listed, where it is now, never the other: " + JSON.stringify(got.map((e) => [e.path, e.ref === b.ref])));
  check((await F.recentOpened(w, { kind: "notebook", ref: a.ref })).length === 0, "…the current one left out");
  await w.remove("/MovedA.ipynb");
  check((await F.recentOpened(w)).length === 0, "…one in Trash isn't listed");
  w.close();
}

// ---- capabilities step 1a: data files' bytes beside the index (design/capabilities.md §2a, §2b)

// (a workspace as version 1 made it, before fileBytes: its stores and entries, data files kept the old
// way: their bytes put in "sagebrush"/files (and Trash's in trash) once the page has opened it)
async function v1(files, trashed = []) {
  n++;
  localStorage.clear();
  const name = `ws-test-${n}`, mainName = `main-test-${n}`;
  await new Promise((ok, no) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      const db = r.result, e = db.createObjectStore("entries", { keyPath: "path" });
      e.createIndex("byRef", ["kind", "ref"]);
      db.createObjectStore("boards", { keyPath: "id" });
      db.createObjectStore("trash");
      db.createObjectStore("ops", { keyPath: "seq", autoIncrement: true });
      const v = db.createObjectStore("versions", { keyPath: "id", autoIncrement: true });
      v.createIndex("byFile", ["fid", "t"]);
      v.createIndex("byTime", "t");
      db.createObjectStore("versionBytes");
      db.createObjectStore("meta");
    };
    r.onsuccess = () => {
      const db = r.result, tx = db.transaction(["entries", "trash"], "readwrite"), st = tx.objectStore("entries");
      const folders = new Set();
      for (const [p] of [...files, ...trashed]) { const parts = p.split("/").slice(1, -1); let at = ""; for (const x of parts) { at += "/" + x; folders.add(at); } }
      for (const f of folders) st.put({ path: f, kind: "folder", ref: null, created: 1, updated: 1 });
      let i = 0;
      for (const [p, text] of files) st.put({ path: p, kind: "file", ref: p, size: enc(text).length, rev: 0, fid: "f" + String(++i).padStart(15, "0"), created: 1, updated: 1 });
      for (const [p, text, from] of trashed) { st.put({ path: p, kind: "file", ref: p, size: enc(text).length, rev: 0, fid: "t" + String(++i).padStart(15, "0"), created: 1, updated: 1, trashed: { from, at: 1, id: "x" + i } }); tx.objectStore("trash").put(enc(text), p); }
      tx.oncomplete = () => { db.close(); ok(); };
      tx.onerror = () => no(tx.error);
    };
    r.onerror = () => no(r.error);
  });
  const w = await W.Workspace.open({ name, mainName });
  for (const [p, text] of files) await rawPut(w.main, "files", enc(text), p);
  return w;
}
const legacyLeft = async (w) => (await w.list("/", { recursive: true })).concat(await w.list("/Trash", { recursive: true })).filter((e) => e.kind === "file" && !e.migrated).length;

async function migrateV1() {
  const big = "B".repeat(70000);
  const w = await v1([["/L/a.txt", "AAA"], ["/L/big.bin", big], ["/top.csv", "x,y\n1,2\n"]], [["/Trash/t.txt", "in trash", "/t.txt"]]);
  check(w.ws.version === 2 && w.ws.objectStoreNames.contains("fileBytes") && w.ws.objectStoreNames.contains("grants"), "a version 1 workspace opened: upgraded to version 2, its stores added");
  check((await legacyLeft(w)) === 4 && (await rawKeys(w.ws, "fileBytes")).length === 0, "…and nothing moved by the upgrade itself");
  check(dec((await w.read("/L/a.txt")).content) === "AAA" && dec((await w.read("/Trash/t.txt")).content) === "in trash", "files not yet moved are read where they are (and Trash's)");
  check((await w.dataFiles()).map(([p]) => p).sort().join() === "/L/a.txt,/L/big.bin,/top.csv", "…and given to a notebook's interpreter (dataFiles: not Trash's)");
  check((await w.usage()).migration.left === 4, "the Storage panel's count: 4 left");
  await W.startMigrator(w);
  const st = await W.migrationState(w);
  check(st.done === true, "the migrator ran to done: " + JSON.stringify(st));
  check((await legacyLeft(w)) === 0, "…every data file moved, Trash's too");
  check(dec(await fb(w, "/L/big.bin")) === big && dec(await fb(w, "/Trash/t.txt")) === "in trash" && dec((await w.read("/top.csv")).content) === "x,y\n1,2\n", "…their bytes the same, in fileBytes");
  const e = await w.stat("/L/big.bin");
  check(e.size === 70000 && /^[0-9a-f]{64}$/.test(e.sha256 ?? ""), "…with their size and SHA-256 on the entry");
  check((await rawKeys(w.main, "files")).length === 0 && (await rawKeys(w.ws, "trash")).length === 0, "…their old copies deleted");
  check((await w.staleCopies(10)).length === 0, "…and no old copy left marked");
  check((await w.usage()).migration.left === 0, "the Storage panel: nothing left");
  // a later open doesn't run it again
  await W.startMigrator(w);
  check((await W.migrationState(w)).done === true, "done stays done");
  w.close();
}

async function migrateOnWrite() {
  const w = await v1([["/w.txt", "old bytes"]]);
  await w.write("/w.txt", "new bytes");
  const e = await w.stat("/w.txt");
  check(e.migrated && dec(await fb(w, "/w.txt")) === "new bytes" && (await rawGet(w.main, "files", "/w.txt")) === undefined, "a write to a file not yet moved moves it first, then writes, the old copy deleted");
  const h = await w.history("/w.txt");
  check(h.length === 1 && dec(await w.version("/w.txt", 0)) === "old bytes", "…what it had kept as a version");
  // a rename and Trash of files not yet moved
  const v = await v1([["/r/a.txt", "a"], ["/r/b.txt", "b"]]);
  await v.rename("/r", "/s");
  check(dec((await v.read("/s/a.txt")).content) === "a" && (await rawKeys(v.main, "files")).length === 0 && (await legacyLeft(v)) === 0, "a folder moved: its files moved beside the index first, then the folder, one transaction");
  await v.remove("/s");
  check(dec((await v.read("/Trash/s/b.txt")).content) === "b", "…and to Trash");
  await v.emptyTrash();
  check((await rawKeys(v.ws, "fileBytes")).length === 0, "Trash emptied: their bytes gone with their entries, in one transaction");
  w.close();
  v.close();
}

async function migratePaused() {
  const w = await v1([["/p/a.txt", "AAA"], ["/p/b.txt", "BBB"]]);
  const est = navigator.storage.estimate;
  navigator.storage.estimate = async () => ({ quota: 100, usage: 99 });
  try {
    await W.startMigrator(w);
    const st = await W.migrationState(w);
    check(st.paused === "storage full" && !st.done, "no room: the migration pauses, saying so: " + JSON.stringify(st));
    check((await legacyLeft(w)) === 2 && dec((await w.read("/p/a.txt")).content) === "AAA", "…the old copies stay, and are read there");
    await W.startMigrator(w).catch(() => {});
  } finally {
    navigator.storage.estimate = est;
  }
  // room again: a page's emptying of Trash makes it go on (no loop meanwhile)
  await w.create("/junk.txt", { content: "j" });
  await w.remove("/junk.txt");
  await w.emptyTrash();
  for (let i = 0; i < 100 && !(await W.migrationState(w)).done; i++) await new Promise((r) => setTimeout(r, 50));
  check((await W.migrationState(w)).done === true && (await legacyLeft(w)) === 0, "space freed in the page: it goes on, to done");
  w.close();
}

async function migrateTargetFails() {
  const w = await v1([["/q/a.txt", "AAA"]]);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (v, k) { if (this.name === "fileBytes") throw new DOMException("the disk is full", "QuotaExceededError"); return put.call(this, v, k); };
  try {
    await W.startMigrator(w);
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  const st = await W.migrationState(w);
  check(st.paused === "storage full", "the move's own transaction refused (quota): paused, saying so");
  check((await legacyLeft(w)) === 1 && dec((await w.read("/q/a.txt")).content) === "AAA" && dec(await rawGet(w.main, "files", "/q/a.txt")) === "AAA", "…nothing of it done: the old copy authoritative, readable");
  check((await rawKeys(w.ws, "fileBytes")).length === 0 && (await w.staleCopies(10)).length === 0, "…and nothing half-made");
  w.close();
}

async function migrateCrashBetween() {
  // the move committed, the old copy's deletion never happened (a crash between the two)
  const w = await v1([["/c/a.txt", "AAA"]]);
  const drop = w.dropStale;
  w.dropStale = async () => { throw new Error("crashed"); };
  await w.locked(async () => w.migrateOne(await w.stat("/c/a.txt")));
  w.dropStale = drop;
  check((await w.stat("/c/a.txt")).migrated && dec(await rawGet(w.main, "files", "/c/a.txt")) === "AAA" && (await w.staleCopies(10)).length === 1, "(a crash between the move and the old copy's deletion: both, the old marked)");
  check(dec((await w.read("/c/a.txt")).content) === "AAA", "…the file read from where it is now");
  const r = { notebooks: 0, files: 0, recovered: 0, missing: 0 };
  await w.locked(() => W.reconcile(w, false, r));
  check(r.files === 0 && r.recovered === 0 && (await w.list("/", { recursive: true })).filter((e) => e.kind === "file").length === 1, "reconcile doesn't take the marked old copy for a file of its own");
  await w.rename("/c/a.txt", "/c/b.txt");
  check(dec((await w.read("/c/b.txt")).content) === "AAA", "(renamed meanwhile)");
  await w.locked(() => W.reconcile(w, false, r));
  check(r.files === 0 && r.recovered === 0, "…nor after the file was renamed away from its key");
  await W.startMigrator(w);
  check((await W.migrationState(w)).done && (await rawGet(w.main, "files", "/c/a.txt")) === undefined && (await w.staleCopies(10)).length === 0, "the migrator deletes the old copy, then its mark, and is done");
  w.close();
}

async function olderTabWrite() {
  // a page still running the code from before writes a moved file the old way: kept beside it, once
  const w = await v1([["/o/a.txt", "AAA"]]);
  await W.startMigrator(w);
  check((await w.stat("/o/a.txt")).migrated, "(moved)");
  await rawPut(w.main, "files", enc("written by an older tab"), "/o/a.txt");
  const r = { notebooks: 0, files: 0, recovered: 0, missing: 0 };
  await w.locked(() => W.reconcile(w, false, r));
  const copy = await w.stat("/o/a (from an older tab).txt");
  check(copy && dec((await w.read(copy.path)).content) === "written by an older tab" && dec((await w.read("/o/a.txt")).content) === "AAA", "an older tab's write to a moved file: kept beside it as a file of its own, the file as it was");
  await w.locked(() => W.reconcile(w, false, r));
  check((await w.list("/o")).length === 2, "…once, however often reconcile runs");
  await rawPut(w.main, "files", enc("AAA"), "/o/b.txt");
  await w.create("/o/b.txt", { content: "AAA" }).catch(() => {});
  await w.locked(() => W.reconcile(w, false, r));
  await W.startMigrator(w);
  check((await w.list("/o")).every((e) => e.migrated), "…and moved beside the index in turn");
  w.close();
}

async function migrateCandidatePass() {
  // an entry put behind the cursor during the candidate clean pass (adopted the old way: reconcile,
  // an older page's file): that pass doesn't count as clean; the next moves it; then done (CORR-CAP-46A-1)
  const w = await fresh();
  for (const i of [1, 2, 3, 4, 5, 6]) await w.create(`/c${i}.txt`, { content: "c" + i });
  const was = W.MIGRATE.files;
  W.MIGRATE.files = 2;
  let did = false, sawDoneEarly = false;
  W.MIGRATE.afterBatch = async (s) => {
    if (s.done && !(await w.stat("/a.bin"))?.migrated && did) sawDoneEarly = true;
    if (!did && s.pass && !s.pass.work && s.pass.at >= "/c3.txt") {
      did = true;
      // (a change to the index that leaves an entry not yet moved, and records its op, as every change
      // to the entries does, without touching the migration's own state: only the generation tells)
      await rawPut(w.main, "files", enc("adopted"), "/a.bin");
      await w.locked(() => new Promise((ok, no) => { const tx = w.ws.transaction(["entries", "ops"], "readwrite"); tx.objectStore("entries").put({ path: "/a.bin", kind: "file", ref: "/a.bin", size: 7, rev: 0, fid: "aaaaaaaaaaaaaaaa", created: 1, updated: 1 }); tx.objectStore("ops").add({ t: 1, device: w.device, by: "person", op: "adopt", path: "/a.bin", kind: "file" }); tx.oncomplete = ok; tx.onerror = () => no(tx.error); }));
    }
  };
  try {
    await W.startMigrator(w);
  } finally {
    W.MIGRATE.files = was;
    W.MIGRATE.afterBatch = null;
  }
  check(did, "(an entry adopted behind the cursor during the candidate clean pass)");
  const a = await w.stat("/a.bin");
  check((await W.migrationState(w)).done && a?.migrated && dec(await fb(w, "/a.bin")) === "adopted" && !sawDoneEarly, "…the migration isn't done until it is moved too: " + JSON.stringify({ migrated: a?.migrated }));
  w.close();
}

async function migrateOneTab() {
  const w = await v1([["/o/a.txt", "AAA"]]);
  let release;
  const held = new Promise((r) => navigator.locks.request("sagebrush-workspace-migrate", () => new Promise((g) => { release = g; r(); })));
  await held;
  await W.startMigrator(w);
  check(!(await W.migrationState(w)).done && (await legacyLeft(w)) === 1, "another tab migrating (its lock held): this one doesn't, and doesn't wait");
  release();
  await new Promise((r) => setTimeout(r, 50));
  await W.startMigrator(w);
  check((await W.migrationState(w)).done && (await legacyLeft(w)) === 0, "…and does once it is free");
  w.close();
}

async function migrateUndersized() {
  // LIMIT-CAP1A-1 / CORR-F81-2: an entry whose index says 1 byte, its old bytes 5 MiB: the read is
  // reserved for what a value kept the old way can be, before the workspace's lock and before the read;
  // the size corrected; the migration done in one pass, not retried for ever
  // (at the top: no folder for the migrator to give an id to first, under the lock held here)
  const w = await v1([["/ua.bin", "x"]]);
  const big = new Uint8Array(5 * 2 ** 20).fill(7);
  await rawPut(w.main, "files", big, "/ua.bin");
  const legacy = w.legacyBytes.bind(w), heldAtRead = [];
  w.legacyBytes = async (e) => { heldAtRead.push(W.reserved().held); return legacy(e); };
  // the workspace's lock held elsewhere: the migrator has its reservation while it waits for the lock
  let release;
  await new Promise((r) => navigator.locks.request("sagebrush-workspace", () => new Promise((g) => { release = g; r(); })));
  let batches = 0;
  W.MIGRATE.afterBatch = () => { batches++; };
  const run = W.startMigrator(w);
  let reservedWaiting = false;
  for (let i = 0; i < 100 && !reservedWaiting; i++) { await new Promise((r) => setTimeout(r, 20)); reservedWaiting = W.reserved().held === W.LEGACY_MAX * W.COPIES; }
  check(reservedWaiting, "the reservation is taken before the workspace's lock (held while it waits): " + W.reserved().held);
  release();
  try { await run; } finally { W.MIGRATE.afterBatch = null; w.legacyBytes = legacy; }
  check(heldAtRead.length > 0 && heldAtRead.every((h) => h >= W.LEGACY_MAX * W.COPIES), "…held when the old bytes are read, covering any value kept the old way: " + heldAtRead.join());
  const e = await w.stat("/ua.bin");
  check(e.migrated && e.size === big.length && (await fb(w, "/ua.bin")).length === big.length, "the index's 1 byte corrected to the bytes read, and moved");
  check((await W.migrationState(w)).done && batches <= 3, "…and the migration done, not retried for ever: " + batches + " batches");
  check(W.reserved().held === 0, "…its reservation released");
  // a write to a file kept the old way reads its old bytes (as the version to keep): reserved first too
  const x = await v1([["/wr/a.txt", "old"]]);
  const lx = x.legacyBytes.bind(x), heldW = [];
  x.legacyBytes = async (e) => { heldW.push(W.reserved().held); return lx(e); };
  await x.write("/wr/a.txt", "new");
  await x.rename("/wr", "/wr2");
  x.legacyBytes = lx;
  check(heldW.length > 0 && heldW.every((h) => h >= W.LEGACY_MAX * W.COPIES) && W.reserved().held === 0, "a write to a file kept the old way: its old bytes read under the reservation, released after: " + heldW.join());
  x.close();
  // larger than any value kept the old way can be: not moved, said, not read for it again; a move refused
  // (a) its index saying so: marked without reading it at all
  const t = await v1([["/huge/t.bin", "y".repeat(100)]]);
  const lt = t.legacyBytes.bind(t);
  let readsT = 0;
  t.legacyBytes = async (e) => { readsT++; return lt(e); };
  const afterT = await t.locked(async () => t.migrateOne(await t.stat("/huge/t.bin"), 10));
  check(!afterT.migrated && afterT.unmoved && afterT.size === 100 && readsT === 0, "a value whose index says it is over the bound: marked, never read (" + readsT + " reads)");
  // every change to it refused before any read of the old store, and nothing written (daybreak2)
  const get = IDBObjectStore.prototype.get, oldGets = [];
  IDBObjectStore.prototype.get = function (k) { if (this.name === "files" || this.name === "trash") oldGets.push(this.name + ":" + k); return get.apply(this, arguments); };
  const ops0 = (await t.ops()).length, e0 = JSON.stringify(await t.stat("/huge/t.bin"));
  try {
    check(await fails(t.write("/huge/t.bin", "new"), "limit") && await fails(t.duplicate("/huge/t.bin"), "limit") && await fails(t.rename("/huge/t.bin", "/huge/u.bin"), "limit") && await fails(t.remove("/huge/t.bin"), "limit") && await fails(t.remove("/huge"), "limit"), "writing, copying, renaming or putting it (or its folder) in Trash: refused, saying why");
    check(oldGets.length === 0 && readsT === 0, "…none of them reads the old store: " + oldGets.join());
    check((await t.ops()).length === ops0 && JSON.stringify(await t.stat("/huge/t.bin")) === e0 && (await rawGet(t.main, "files", "/huge/t.bin")) !== undefined, "…and none of them writes anything");
    // the way out: deleted for good by a person, without reading it; never by an agent
    const ag = t.forAgent("agent:x");
    const asAgent = Object.create(t);
    asAgent.actor = "agent:x";
    check(typeof ag.discard === "undefined" && await fails(asAgent.discard("/huge/t.bin", JSON.parse(e0)), "invalid"), "an agent can't delete it for good (not offered, and refused)");
    const before = oldGets.length;
    await t.discard("/huge/t.bin", JSON.parse(e0));
    const readByDiscard = oldGets.length - before;
    check(!(await t.stat("/huge/t.bin")) && (await rawGet(t.main, "files", "/huge/t.bin")) === undefined && readByDiscard === 0, "a person deletes it for good: its entry and old bytes gone, never read (" + readByDiscard + " reads)");
    check((await t.ops()).some((o) => o.op === "discard" && o.path === "/huge/t.bin"), "…logged");
    check(await fails(t.discard("/huge/none.bin", { fid: "x", created: 1 }), "missing"), "…a file not there: missing");
  } finally {
    IDBObjectStore.prototype.get = get;
  }
  // one parked in Trash: restoring it refused without reading it
  const tt = await v1([], [["/Trash/big.bin", "z".repeat(50), "/big.bin"]]);
  await tt.locked(async () => tt.migrateOne(await tt.stat("/Trash/big.bin"), 10));
  const g2 = [];
  IDBObjectStore.prototype.get = function (k) { if (this.name === "files" || this.name === "trash") g2.push(k); return get.apply(this, arguments); };
  try {
    check((await tt.stat("/Trash/big.bin")).unmoved && await fails(tt.restore("/Trash/big.bin"), "limit") && g2.length === 0, "one in Trash: restoring it refused, the old store not read");
  } finally {
    IDBObjectStore.prototype.get = get;
  }
  await tt.discard("/Trash/big.bin", await tt.stat("/Trash/big.bin"));
  check(!(await tt.stat("/Trash/big.bin")) && (await rawKeys(tt.ws, "trash")).length === 0, "…and deleted for good from there");
  tt.close();
  // an ordinary file isn't deleted for good this way: it goes to Trash
  const o = await fresh();
  await o.create("/plain.txt", { content: "p" });
  const pe = await o.stat("/plain.txt");
  check(await fails(o.discard("/plain.txt", pe), "invalid"), "an ordinary file isn't deleted for good this way");
  o.close();
  t.legacyBytes = lt;
  t.close();
  // (b) its index saying less than it is: read once, marked, never read by the migration again
  const v = await v1([["/huge/h.bin", "y"]]);
  await rawPut(v.main, "files", new Uint8Array(100), "/huge/h.bin");
  const lv = v.legacyBytes.bind(v);
  let readsV = 0;
  v.legacyBytes = async (e) => { readsV++; return lv(e); };
  const after = await v.locked(async () => v.migrateOne(await v.stat("/huge/h.bin"), 10));
  check(!after.migrated && after.unmoved && after.size === 100 && readsV === 1, "a value over the bound, its index saying less: read once, not moved, the entry says so, with its size");
  await v.locked(async () => v.migrateOne(await v.stat("/huge/h.bin"), 10));
  await W.startMigrator(v);
  check(readsV === 1, "…and never read by the migration again (" + readsV + " reads)");
  v.legacyBytes = lv;
  check((await W.migrationState(v)).done && (await v.usage()).migration.left === 0 && (await v.read("/huge/h.bin")).content.length === 100, "…the migration done without it; it is still read where it is");
  check(await fails(v.rename("/huge", "/huge2"), "limit"), "…and moving it is refused (its bytes stay where they are)");
  w.close();
  v.close();
}

async function staleChanged() {
  // CORR-F81-1: an older tab's write at a moved file's old key is never deleted
  // (a) written between the move and the old copy's deletion
  const w = await v1([["/s/a.txt", "BEFORE"]]);
  w.beforeStaleDelete = async () => { await rawPut(w.main, "files", enc("NEW OLD TAB EDIT"), "/s/a.txt"); };
  await w.locked(async () => w.migrateOne(await w.stat("/s/a.txt")));
  w.beforeStaleDelete = null;
  const copy = await w.stat("/s/a (from an older tab).txt");
  check(copy && dec((await w.read(copy.path)).content) === "NEW OLD TAB EDIT" && dec((await w.read("/s/a.txt")).content) === "BEFORE", "an older tab's write as the old copy is cleaned up: kept as a file of its own, the moved file as it was");
  check((await w.staleCopies(10)).length === 0, "…its mark gone");
  await W.startMigrator(w);
  check(dec((await w.read(copy.path)).content) === "NEW OLD TAB EDIT" && (await W.migrationState(w)).done && (await rawGet(w.main, "files", "/s/a.txt")) === undefined, "…then moved in turn, the migration done, nothing lost");
  // (b) after a crash left the mark, then an older tab's write, then a reopened page's migrator
  const v = await v1([["/s/b.txt", "BEFORE B"]]);
  const drop = v.dropStale;
  v.dropStale = async () => { throw new Error("crashed"); };
  await v.locked(async () => v.migrateOne(await v.stat("/s/b.txt")));
  v.dropStale = drop;
  await rawPut(v.main, "files", enc("WRITTEN AFTER THE CRASH"), "/s/b.txt");
  await W.startMigrator(v);
  const copyB = await v.stat("/s/b (from an older tab).txt");
  check(copyB && dec((await v.read(copyB.path)).content) === "WRITTEN AFTER THE CRASH" && dec((await v.read("/s/b.txt")).content) === "BEFORE B", "after a crash, an older tab's write at the marked key: kept, not deleted with the mark");
  // (c) the same bytes, in both cases: deleted, no copy
  const u = await v1([["/s/c.txt", "SAME"], ["/s/d.txt", "SAME D"]]);
  u.beforeStaleDelete = async () => { await rawPut(u.main, "files", enc("SAME"), "/s/c.txt"); };
  await u.locked(async () => u.migrateOne(await u.stat("/s/c.txt")));
  u.beforeStaleDelete = null;
  const dropU = u.dropStale;
  u.dropStale = async () => { throw new Error("crashed"); };
  await u.locked(async () => u.migrateOne(await u.stat("/s/d.txt")));
  u.dropStale = dropU;
  await W.startMigrator(u);
  check((await u.list("/s")).length === 2 && (await rawKeys(u.main, "files")).length === 0 && (await u.staleCopies(10)).length === 0, "the old copy still the bytes moved (written again the same, or after a crash): deleted, no copy made");
  w.close(); v.close(); u.close();
}

async function migrateQueuedAndBounded() {
  // a migrator queued behind another tab's holds nothing: no reservation, no request for the workspace's lock
  const files = Array.from({ length: 70 }, (_, i) => [`/b/f${String(i).padStart(2, "0")}.txt`, "x" + i]);
  const w = await v1(files);
  let release;
  await new Promise((r) => navigator.locks.request("sagebrush-workspace-migrate", () => new Promise((g) => { release = g; r(); })));
  await W.startMigrator(w);
  const q = await navigator.locks.query();
  check(W.reserved().held === 0 && W.reserved().waiting === 0 && !q.pending.some((p) => p.name === "sagebrush-workspace" || p.name === "sagebrush-workspace-migrate"), "a migrator queued behind another tab's: no reservation, no lock asked for");
  release();
  await new Promise((r) => setTimeout(r, 30));
  // each batch reads at most MIGRATE.files entries of the index, never a list of all of them
  const getAll = IDBObjectStore.prototype.getAll, counts = [];
  IDBObjectStore.prototype.getAll = function (q, n) { if (this.name === "entries") counts.push(n); return getAll.call(this, q, n); };
  try { await W.startMigrator(w); } finally { IDBObjectStore.prototype.getAll = getAll; }
  check((await W.migrationState(w)).done && counts.length > 2 && counts.every((n) => n !== undefined && n <= W.MIGRATE.files), "each batch reads at most " + W.MIGRATE.files + " entries: " + counts.join());
  w.close();
}

async function generationMonotonic() {
  const w = await fresh();
  await w.create("/g/a.txt", { content: "a" });
  await w.create("/g/b.txt", { content: "b" });
  const g = await w.generation();
  check(g === (await w.lastSeq()) && g > 0, "the generation: the latest op's seq");
  const n0 = await w.dropOps(g);
  check(n0 > 0 && (await w.ops()).length === 0 && (await w.generation()) === g, "every op record dropped: the generation stays");
  await w.create("/g/c.txt", { content: "c" });
  check((await w.generation()) > g, "…and the next change raises it");
  w.close();
}

async function closedByUpgrade() {
  const w = await fresh();
  await w.create("/k.txt", { content: "k" });
  let told = 0;
  w.onClosed(() => { told++; W.showReloadNotice(); });
  // a newer page opening the workspace's database at a later version
  await new Promise((ok, no) => { const r = indexedDB.open(`ws-test-${n}`, 99); r.onupgradeneeded = () => {}; r.onsuccess = () => { r.result.close(); ok(); }; r.onerror = () => no(r.error); r.onblocked = () => no(new Error("blocked: the old page didn't let go")); });
  check(w.closed && told === 1, "a newer page upgraded the workspace: this page's is closed, and told once");
  const box = document.getElementById("sagebrush-reload-notice");
  check(!!box && /updated in another tab/.test(box.textContent) && [...box.querySelectorAll("button")].some((b) => b.textContent === "Reload"), "…the page says so, with Reload");
  const err = await w.read("/k.txt").then(() => null, (e) => e);
  check(err instanceof W.WorkspaceError && err.code === "storage" && /reload/.test(err.message), "…reading or changing then says to reload, not an IndexedDB error");
  check(await fails(w.create("/l.txt", { content: "l" }), "storage"), "…and nothing is changed");
  box?.remove();
}

// ---- capabilities step 1b: identities (design/capabilities.md §3, §6)

async function folderIds() {
  const w = await fresh();
  const a = await w.mkdir("/A/B");
  const top = await w.stat("/A");
  check(/^[0-9a-f]{16}$/.test(a.fid ?? "") && /^[0-9a-f]{16}$/.test(top.fid ?? "") && a.fid !== top.fid, "folders made have ids of their own, the ones made on the way too");
  await w.create("/C/x.txt", { content: "x" });
  check(/^[0-9a-f]{16}$/.test((await w.stat("/C")).fid ?? ""), "…a folder made for a file too");
  await w.rename("/A", "/A2");
  check((await w.stat("/A2")).fid === top.fid && (await w.stat("/A2/B")).fid === a.fid, "a rename keeps them, inside too");
  await w.remove("/A2");
  await w.mkdir("/A2");
  check((await w.stat("/A2")).fid !== top.fid && (await w.stat("/Trash/A2")).fid === top.fid, "a folder removed and made again is a new one; the removed one keeps its id in Trash");
  w.close();
}

async function folderIdsMigrated() {
  // folders made before they had ids: given them by the migrator, before any grant can name them
  const w = await v1([["/old/sub/a.txt", "a"], ["/old2/b.txt", "b"]]);
  check(!(await w.stat("/old")).fid && !(await w.stat("/old/sub")).fid, "(version 1's folders have no ids)");
  await W.startMigrator(w);
  const ids = await Promise.all(["/old", "/old/sub", "/old2"].map(async (p) => (await w.stat(p)).fid));
  check(ids.every((x) => /^[0-9a-f]{16}$/.test(x ?? "")) && new Set(ids).size === 3 && (await W.migrationState(w)).done, "the migrator gives every folder an id, each its own");
  // a folder without an id renamed behind the cursor during the candidate clean pass (astra's
  // CORR-CAP-46A-1 with a folder): that pass doesn't count; the folder gets its id; then done
  const v = await fresh();
  for (const i of [1, 2, 3, 4, 5, 6]) await v.create(`/c${i}.txt`, { content: "c" });
  const was = W.MIGRATE.files;
  W.MIGRATE.files = 2;
  let did = false;
  W.MIGRATE.afterBatch = async (s) => {
    if (!did && s.pass && !s.pass.work && s.pass.at >= "/c3.txt") {
      did = true;
      await v.locked(() => new Promise((ok, no) => { const tx = v.ws.transaction("entries", "readwrite"); tx.objectStore("entries").put({ path: "/zz", kind: "folder", ref: null, created: 5, updated: 5 }); tx.oncomplete = ok; tx.onerror = () => no(tx.error); }));
      await v.rename("/zz", "/aa");
    }
  };
  try { await W.startMigrator(v); } finally { W.MIGRATE.files = was; W.MIGRATE.afterBatch = null; }
  check(did && /^[0-9a-f]{16}$/.test((await v.stat("/aa"))?.fid ?? "") && (await W.migrationState(v)).done, "a folder without an id moved behind the cursor during the candidate clean pass: given one before done");
  w.close();
  v.close();
}

async function provenance() {
  const w = await fresh();
  const ag = w.forAgent("agent:x");
  const e1 = await w.create("/e.board.json"), p1 = await w.createByPerson("/p.board.json"), n1 = await w.createByPerson("/p.ipynb");
  check(e1.made === "elsewhere" && p1.made === "person" && n1.made === "person", "create: from elsewhere; createByPerson (the pages' own New): the person's");
  check(typeof ag.createByPerson === "undefined" && typeof ag.createCopyOf === "undefined" && typeof ag.adopt === "undefined", "an agent has no way to say the person made something");
  const forged = await ag.create("/f.board.json", { made: "person", content: { title: "f", made: "person", nodes: [] } });
  check(forged.made === "elsewhere" && (await w.create("/g.board.json", { made: "person" })).made === "elsewhere", "…an agent's create, or anyone's, saying made: person in its options or its document: from elsewhere");
  // a copy has its source's provenance: a copy of something from elsewhere is still from elsewhere
  const dp = await w.duplicate("/p.board.json"), de = await ag.duplicate("/e.board.json"), dn = await w.duplicate("/p.ipynb");
  check(dp.made === "person" && de.made === "elsewhere" && dn.made === "person", "Duplicate keeps the source's provenance (an agent's too)");
  const tmp = await w.create("/tmp.board.json");
  await w.remove(tmp.path);
  const legacy = await w.locked(() => w.adopt("/", "old", ".board.json", { kind: "board", ref: tmp.ref }));
  check(legacy.made === undefined && (await w.createCopyOf(legacy, "/oldcopy.board.json")).made === undefined && (await w.duplicate(legacy.path)).made === undefined, "unknown (made before it was kept) stays unknown in a copy");
  check((await w.createCopyOf(p1, "/pc.board.json")).made === "person", "a page's copy of the person's board: the person's");
  // a change to the document never touches it; nor a rename or Trash
  await ag.write("/e.board.json", { title: "e", made: "person", nodes: [] });
  await w.rename("/p.board.json", "/p2.board.json");
  const t = await w.remove("/p2.board.json");
  check((await w.stat("/e.board.json")).made === "elsewhere" && t.made === "person" && (await w.restore(t.path, t)).made === "person", "a write saying made: person changes nothing; a rename, Trash and restore keep it");
  w.close();
}

async function lookalikes() {
  const w = await fresh();
  const composed = "/café.txt", decomposed = "/café.txt";
  await w.create(composed, { content: "1" });
  const r = await w.create(decomposed, { content: "2" }).then(() => null, (e) => e);
  check(r instanceof W.WorkspaceError && r.code === "exists" && /looks the same/.test(r.message), "a name that looks the same as one in its folder (another Unicode form) is refused, saying so");
  await w.mkdir("/résumé");
  check(await fails(w.mkdir("/résumé"), "exists"), "…a folder too");
  await w.create("/other.txt", { content: "o" });
  check(await fails(w.rename("/other.txt", decomposed), "exists"), "…and a rename to one");
  await w.create("/elsewhere" + decomposed, { content: "3" });
  check(!!(await w.stat("/elsewhere" + decomposed)), "the same name in another folder is fine");
  check(!!(await w.create("/Cafe.txt", { content: "c" })) && !!(await w.create("/cafe.txt", { content: "c" })), "ASCII names aren't looked at (letter case is another name)");
  // lookalikes made before this rule: listed for the Storage panel; both keep working
  await new Promise((ok, no) => { const tx = w.ws.transaction("entries", "readwrite"); tx.objectStore("entries").put({ path: decomposed, kind: "file", ref: decomposed, size: 1, rev: 0, fid: "dddddddddddddddd", created: 1, updated: 1 }); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  const u = await w.usage();
  check(u.lookalikes.length === 1 && u.lookalikes[0].join() === [composed, decomposed].sort().join(), "names that look the same, made before: listed together: " + JSON.stringify(u.lookalikes));
  w.close();
}

export async function run() {
  for (const t of [storageUse, versionActions, fences, intents, paths_, createAndRead, writeCas, renames, trash, duplicates, limits, opsAndWatch, concurrent, versions, migration, migrationProvenance, recovery, recoveryConflict, edges, noLocks, rollback, dropping, emptying, folderLimit, migrationFull, recent, migrateV1, migrateOnWrite, migratePaused, migrateTargetFails, migrateCrashBetween, olderTabWrite, migrateCandidatePass, migrateOneTab, closedByUpgrade, migrateUndersized, staleChanged, migrateQueuedAndBounded, generationMonotonic, folderIds, folderIdsMigrated, provenance, lookalikes]) {
    try { await t(); } catch (e) { results.push([false, `${t.name} threw: ${e?.stack ?? e}`]); }
  }
  return results;
}
