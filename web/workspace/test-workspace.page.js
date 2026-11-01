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
  const before = JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter((k) => !k.startsWith(W.LOCAL_KEY)).sort().map((k) => [k, localStorage.getItem(k)])));
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
  // (the workspace's own witness, design/workspace-durability.md A.1, aside: what was there is left as it was)
  const after = JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter((k) => !k.startsWith(W.LOCAL_KEY)).sort().map((k) => [k, localStorage.getItem(k)])));
  check(before === after, "localStorage is left exactly as it was (the workspace's witness aside)");
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
  const J = JSON.stringify;
  // (P0 #1) another device's notebook (`remote`), its content not here: never marked missing, and a mark an older
  // build wrote taken off
  await rawDel(w.main, "notebooks", "nb2");
  await rawPut(w.ws, "entries", { ...(await w.stat(gone.path)), remote: true, missing: true });
  const r5 = await W.migrate(w, localStorage);
  const remote = await w.stat(gone.path);
  check(remote.remote === true && !remote.missing && r5.missing === 0, "another device's notebook, its content not here: not marked missing, an older mark taken off: " + J({ missing: remote.missing, r5: r5.missing }));
  // (P0 #1, the defensive rule) the notebooks' store read empty (every record gone at once): this device's own
  // notebooks are not marked missing, and that is said; one record back and one gone: marked as before
  const said = [], warn = console.warn;
  console.warn = (...a) => { said.push(String(a[0])); };
  try {
    const own = (await w.list("/")).filter((e) => e.kind === "notebook" && !e.remote && !e.missing);
    const kept = [];
    const FENCE = "__sagebrush-workspace__";
    for (const id of await rawKeys(w.main, "notebooks")) if (id !== FENCE) kept.push([id, await rawGet(w.main, "notebooks", id)]);
    for (const [id] of kept) await rawDel(w.main, "notebooks", id);
    const left = (await rawKeys(w.main, "notebooks")).filter((k) => k !== FENCE);
    const r6 = await W.migrate(w, localStorage);
    const after = await Promise.all(own.map((e) => w.stat(e.path)));
    check(own.length >= 2 && left.length === 0 && after.every((e) => !e.missing) && r6.missing === 0 && said.some((x) => /store reads empty: not marked missing/.test(x)), "the notebooks' store read empty: this device's own notebooks not marked missing, said: " + J({ own: own.length, left, marked: after.filter((e) => e.missing).length, said }));
    for (const [id, rec] of kept.slice(1)) await rawPut(w.main, "notebooks", rec);
    said.length = 0;
    const r7 = await W.migrate(w, localStorage);
    const firstGone = own.find((e) => e.ref === kept[0][0]);
    check(!!firstGone && (await w.stat(firstGone.path)).missing === true && r7.missing === 1 && said.some((x) => /1 entries marked missing/.test(x)), "…with others' records there, the one gone is marked as before, and the mark said with the stores' counts: " + J({ r7: r7.missing, said }));
    await rawPut(w.main, "notebooks", kept[0][1]);
  } finally {
    console.warn = warn;
  }
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
  await new Promise((ok) => { const tx = w.ws.transaction(["versions", "versionBytes", "prunable", "meta"], "readwrite"), vs = tx.objectStore("versions"), vb = tx.objectStore("versionBytes"), pr = tx.objectStore("prunable"); for (let i = 0; i < many; i++) { const q = vs.add({ fid: "zz" + i, t: i, size: 1, sha256: "", by: "person", device: "d" }); q.onsuccess = () => { vb.put(new Uint8Array([1]), q.result); pr.put({ fid: "zz" + i, id: q.result, t: i, size: 1 }); }; } const m = tx.objectStore("meta"), g = m.get("versionBytes"); g.onsuccess = () => m.put((g.result ?? 0) + many, "versionBytes"); tx.oncomplete = ok; });
  const unbounded = [], pages = [];
  const wrap = (proto) => { const orig = proto.getAll; proto.getAll = function (q, n) { if (q == null && (this.name === "byFile" || this.name === "versions")) unbounded.push([this.name, n]); else if (this.name === "versions" && this instanceof IDBObjectStore) pages.push(n); return orig.apply(this, arguments); }; return () => (proto.getAll = orig); };
  const un1 = wrap(IDBIndex.prototype), un2 = wrap(IDBObjectStore.prototype);
  try {
    await w.write("/moved.txt", "fourth");
    await w.dropVersions("/moved.txt");
    check(unbounded.length === 0, "dropping a file's versions reads no other file's: " + JSON.stringify(unbounded));
    const before = (await w.versionsUsage()).count;
    const freed = await w.dropVersions("/");
    // (a page of at most 130 a transaction, by a key range from the last id: astra's CORR-E5C-3)
    // (from the versions store itself, by id, never waiting for the backfill: @sagebrush's round 5)
    check(unbounded.length === 0 && pages.length > 1 && pages.every((n) => n === 130), "all of them: a page of at most 130 records at a time, by a key range of ids (" + pages.length + " pages)");
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
  check(w.ws.version === W.WS_VERSION && ["fileBytes", "grants", "outbox", "syncIndex", "adoptJournal", "pins", "pending", "syncLedger"].every((x) => w.ws.objectStoreNames.contains(x)), "a version 1 workspace opened: upgraded to the current version, its stores added");
  check((await legacyLeft(w)) === 4 && (await rawKeys(w.ws, "fileBytes")).length === 0, "…and nothing moved by the upgrade itself");
  check(dec((await w.read("/L/a.txt")).content) === "AAA" && dec((await w.read("/Trash/t.txt")).content) === "in trash", "files not yet moved are read where they are (and Trash's)");
  check((await w.dataFiles()).map(([p]) => p).sort().join() === "/L/a.txt,/L/big.bin,/top.csv", "…and given to a notebook's interpreter (dataFiles: not Trash's)");
  check((await w.usage()).migration.left === 4, "the Storage panel's count: 4 left");
  await W.startMigrator(w);
  const st = await W.migrationState(w);
  check(st.done === true, "the migrator ran to done: " + JSON.stringify(st));
  check((await legacyLeft(w)) === 0, "…every data file moved, Trash's too");
  check(dec(await fb(w, "/L/big.bin")) === big && dec(await fb(w, "/Trash/t.txt")) === "in trash" && dec((await w.read("/top.csv")).content) === "x,y\n1,2\n", "…their bytes the same, in fileBytes");
  check(JSON.stringify((await w.dataFiles()).map(([p, b]) => [p, dec(b)]).sort()) === JSON.stringify([["/L/a.txt", "AAA"], ["/L/big.bin", big], ["/top.csv", "x,y\n1,2\n"]]), "…and given to a notebook's interpreter from there, read together (dataFiles: not Trash's)");
  {
    // (in one transaction on fileBytes, not one a file: what a kernel's start waits for)
    let n = 0;
    const tx = w.ws.transaction;
    w.ws.transaction = function (stores, ...rest) { if ([].concat(stores).includes("fileBytes")) n++; return tx.call(this, stores, ...rest); };
    try { await w.dataFiles(); } finally { delete w.ws.transaction; }
    check(n === 1 && w.ws.transaction === tx, `…in one transaction on fileBytes (${n})`);
  }
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

// R6-A3-1: a write naming a data file by its fid touches nothing unless the entry at the path is that file, checked
// before migrateOne (which would otherwise move another, unmigrated file's bytes first)
async function writeGuard() {
  const w = await v1([["/g/a.txt", "theirs"], ["/g/b.txt", "bee"]]);
  const snap = async () => JSON.stringify({ entry: await rawGet(w.ws, "entries", "/g/a.txt"), fileBytes: await Promise.all((await rawKeys(w.ws, "fileBytes")).map(async (k) => [k, Array.from(new Uint8Array(await rawGet(w.ws, "fileBytes", k) ?? []))])), old: dec(await rawGet(w.main, "files", "/g/a.txt")),
    meta: await Promise.all((await rawKeys(w.ws, "meta")).map(async (k) => [k, await rawGet(w.ws, "meta", k)])), ops: (await rawKeys(w.ws, "ops")).length, versions: (await rawKeys(w.ws, "versions")).length, left: await legacyLeft(w) });
  const before = await snap();
  const a0 = await rawGet(w.ws, "entries", "/g/a.txt");
  check(!a0.migrated && await fails(w.write("/g/a.txt", "mine", { fid: "0123456789abcdef" }), "conflict"), "a write naming another file's fid, an unmigrated file at the path: refused");
  check((await snap()) === before && dec((await w.read("/g/a.txt")).content) === "theirs", "…that file untouched: its entry, its old bytes where they were, nothing in fileBytes, no op, no version, the migration's state");
  const b = await w.stat("/g/b.txt");
  await w.write("/g/b.txt", "bee 2", { fid: b.fid });
  check(dec((await w.read("/g/b.txt")).content) === "bee 2" && (await w.stat("/g/b.txt")).migrated === true, "the same fid: written, the file moved first, as before");
  await w.create("/g/n.ipynb");
  check(await fails(w.write("/g/n.ipynb", { cells: [] }, { fid: b.fid }), "conflict"), "a fid named, a notebook at the path: refused");
  w.close();
}

// pathOfFile: a data file's path by its fid, read-only
async function pathOfFile_() {
  const w = await fresh();
  await w.create("/p/a.txt", { content: "a" });
  const a = await w.stat("/p/a.txt");
  const ops0 = (await rawKeys(w.ws, "ops")).length;
  let r = await w.pathOfFile(a.fid);
  check(r.ok && r.path === "/p/a.txt" && r.entry.fid === a.fid, "pathOfFile: a live file by its fid");
  await w.rename("/p/a.txt", "/q.txt");
  r = await w.pathOfFile(a.fid);
  check(r.ok && r.path === "/q.txt", "…followed after a rename");
  check((await w.pathOfFile("ffffffffffffffff")).why === "none" && (await w.pathOfFile("")).why === "none", "…an unknown fid, or none: none");
  const ops1 = (await rawKeys(w.ws, "ops")).length;
  await w.pathOfFile(a.fid);
  check((await rawKeys(w.ws, "ops")).length === ops1 && ops1 > ops0, "…and it writes nothing (no op)");
  await w.create("/x.ipynb");
  await w.remove("/q.txt");
  check((await w.pathOfFile(a.fid)).why === "trashed", "…only in Trash: trashed");
  // two live rows with one fid (which the workspace doesn't make; put raw): ambiguous, never the first
  await w.create("/d1.txt", { content: "1" });
  const { nkey: _k, ...d } = await rawGet(w.ws, "entries", "/d1.txt");
  await rawPut(w.ws, "entries", { ...d, path: "/d2.txt" });
  const amb = await w.pathOfFile(d.fid);
  check(amb.ok === false && amb.why === "ambiguous", "two live entries with the same fid: ambiguous");
  // the bound (api.ts PATH_OF_FILE_MAX = 64 entries with one identity): one live among exactly that many is found; one more
  // live entry past it is never missed (ambiguous, unread, never the first live one)
  await w.create("/c.txt", { content: "c" });
  const { nkey: _c, ...c } = await rawGet(w.ws, "entries", "/c.txt");
  const MAX = 64;   // (api.ts PATH_OF_FILE_MAX)
  for (let k = 0; k < MAX - 1; k++) await rawPut(w.ws, "entries", { ...c, path: `/Trash/c${k}.txt`, trashed: { from: "/c.txt", at: 1, id: "c" + k } });
  const atCap = await w.pathOfFile(c.fid);
  check(atCap.ok && atCap.path === "/c.txt", "pathOfFile: one live entry among exactly the bound's entries with its fid: found");
  await rawPut(w.ws, "entries", { ...c, path: "/zz-late.txt" });
  const over = await w.pathOfFile(c.fid);
  check(over.ok === false && over.why === "ambiguous", "…and a second live one past the bound: ambiguous, never the first");
  // the bound's trashed rows can't hide the one live entry either: 64 in Trash and one live is ambiguous, never "trashed"
  await w.create("/h.txt", { content: "h" });
  const { nkey: _h, ...hh } = await rawGet(w.ws, "entries", "/h.txt");
  for (let k = 0; k < MAX; k++) await rawPut(w.ws, "entries", { ...hh, path: `/Trash/h${k}.txt`, trashed: { from: "/h.txt", at: 1, id: "h" + k } });
  const hid = await w.pathOfFile(hh.fid);
  check(hid.ok === false && hid.why === "ambiguous", "…" + MAX + " in Trash and one live: ambiguous (fail closed), never trashed nor a guess");
  w.close();
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
  await W.adoptOld(w, await w.locked(() => W.reconcile(w, false, r)), r);
  check(r.files === 0 && r.recovered === 0 && (await w.list("/", { recursive: true })).filter((e) => e.kind === "file").length === 1, "reconcile doesn't take the marked old copy for a file of its own");
  await w.rename("/c/a.txt", "/c/b.txt");
  check(dec((await w.read("/c/b.txt")).content) === "AAA", "(renamed meanwhile)");
  await W.adoptOld(w, await w.locked(() => W.reconcile(w, false, r)), r);
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
  await W.adoptOld(w, await w.locked(() => W.reconcile(w, false, r)), r);
  const copy = await w.stat("/o/a (from an older tab).txt");
  check(copy && dec((await w.read(copy.path)).content) === "written by an older tab" && dec((await w.read("/o/a.txt")).content) === "AAA", "an older tab's write to a moved file: kept beside it as a file of its own, the file as it was");
  await W.adoptOld(w, await w.locked(() => W.reconcile(w, false, r)), r);
  check((await w.list("/o")).length === 2, "…once, however often reconcile runs");
  await rawPut(w.main, "files", enc("AAA"), "/o/b.txt");
  await w.create("/o/b.txt", { content: "AAA" }).catch(() => {});
  await W.adoptOld(w, await w.locked(() => W.reconcile(w, false, r)), r);
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
  // (holding a reservation of LEGACY_MAX × COPIES, as every caller of migrateOne does: the older tab's bytes are
  // read, and kept, inside it (daybreak2's LIMIT-6B7-1))
  const held = await W.reserve(W.LEGACY_MAX * W.COPIES);
  try { await w.locked(async () => w.migrateOne(await w.stat("/s/a.txt"), undefined, held)); } finally { held(); }
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

async function upgradeFromV2() {
  // a workspace whose migration already finished (or paused, or stopped mid-pass) under version 2
  // (astra's CORR-D01-1): the upgrade to 3 starts it again, so its old entries get their identities
  for (const state of [{ done: true }, { paused: "storage full" }, { pass: { start: 0, at: "/zzz", work: false } }]) {
    n++;
    localStorage.clear();
    const name = `ws-test-${n}`, mainName = `main-test-${n}`;
    await new Promise((ok, no) => {
      const r = indexedDB.open(name, 2);
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
        db.createObjectStore("fileBytes");
        const g = db.createObjectStore("grants", { keyPath: ["doc", "scope"] });
        g.createIndex("byDoc", "doc");
        g.createIndex("lastUsed", "lastUsed");
      };
      r.onsuccess = () => {
        const db = r.result, tx = db.transaction(["entries", "meta"], "readwrite");
        tx.objectStore("entries").put({ path: "/\u212A", kind: "folder", ref: null, created: 1, updated: 1 });
        tx.objectStore("entries").put({ path: "/old", kind: "folder", ref: null, created: 1, updated: 1 });
        tx.objectStore("meta").put(state, "migration");
        tx.oncomplete = () => { db.close(); ok(); };
        tx.onerror = () => no(tx.error);
      };
      r.onerror = () => no(r.error);
    });
    const w = await W.Workspace.open({ name, mainName });
    const before = await w.stat("/old");
    await W.startMigrator(w);
    const k = await w.stat("/\u212A"), old = await w.stat("/old");
    const label = JSON.stringify(state);
    check(!before.fid && before.nkey === undefined, `${label} under version 2: the upgrade itself moves no data`);
    check(/^[0-9a-f]{16}$/.test(k.fid ?? "") && /^[0-9a-f]{16}$/.test(old.fid ?? "") && k.nkey !== undefined && old.nkey !== undefined && (await W.migrationState(w)).done, `${label} under version 2: after the upgrade the migrator runs again, giving old folders ids and nkeys, then done`);
    check(await fails(w.mkdir("/K"), "exists"), `${label} under version 2: then a lookalike of an old folder is refused`);
    w.close();
  }
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
  // every name, ASCII included, in both directions (astra's CORR-9A3-1): U+212A KELVIN SIGN is "K" in NFC
  await w.create("/K.txt", { content: "k" });
  check(await fails(w.create("/K.txt", { content: "x" }), "exists") && await fails(w.mkdir("/K.txt"), "exists") && await fails(w.rename("/other.txt", "/K.txt"), "exists"), "a name normalizing to an ASCII one there (U+212A next to K): refused, by create, mkdir and rename");
  await w.create("/Km.txt", { content: "k" }).catch(() => {});
  check(!!(await w.stat("/Km.txt")) && await fails(w.create("/Km.txt", { content: "x" }), "exists"), "…and an ASCII name whose lookalike is there first");
  await w.create("/à.txt", { content: "a" });
  check(await fails(w.create("/à.txt", { content: "x" }), "exists"), "U+0340 (normalizing to U+0300) next to its composed form: refused");
  // a move carries its key: the rule then holds in the new folder, and no longer in the old
  await w.create("/mv/r\u00e9.txt", { content: "m" });
  await w.rename("/mv/r\u00e9.txt", "/mv2/r\u00e9.txt");
  check(await fails(w.create("/mv2/re\u0301.txt", { content: "x" }), "exists") && !!(await w.create("/mv/re\u0301.txt", { content: "y" })), "a rename carries the name's key: refused next to it in its new folder, free in its old");
  await w.create("/elsewhere" + decomposed, { content: "3" });
  check(!!(await w.stat("/elsewhere" + decomposed)), "the same name in another folder is fine");
  check(!!(await w.create("/Cafe.txt", { content: "c" })) && !!(await w.create("/cafe.txt", { content: "c" })), "letter case is another name");
  // lookalikes made before this rule (no nkey yet): given theirs by the migrator, then listed; both keep working
  const raw = (path) => new Promise((ok, no) => { const tx = w.ws.transaction("entries", "readwrite"); tx.objectStore("entries").put({ path, kind: "file", ref: path, size: 1, rev: 0, fid: [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join(""), created: 1, updated: 1 }); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await raw(decomposed);
  await raw("/K2K.txt");
  await raw("/K2K.txt");
  check((await w.usage()).lookalikes.length === 0, "(before the migrator gives them their key, the index doesn't list them)");
  await W.startMigrator(w);
  const u = await w.usage();
  const groups = u.lookalikes.map((g) => g.join()).sort();
  check(groups.length === 2 && groups.includes([composed, decomposed].sort().join()) && groups.includes(["/K2K.txt", "/K2K.txt"].sort().join()), "names that look the same, made before: listed together, ASCII ones too: " + JSON.stringify(u.lookalikes));
  // capped: groups and their members, the rest counted (members: every path not listed, in the group
  // listed (1) and in the group left out (2))
  const capped = await w.lookalikeGroups(1, 1);
  check(capped.lookalikes.length === 1 && capped.lookalikes[0].length === 1 && capped.lookalikesMore.groups === 1 && capped.lookalikesMore.members === 3, "the list is capped, groups and members both, the rest counted: " + JSON.stringify(capped));
  w.close();
}

async function lookalikesAtScale() {
  // the largest workspace (daybreak2's LIMIT-CAP1B-1): 100,000 entries, 10,000 of them in one folder; a
  // lookalike check is one bounded lookup, and the Storage list a cursor: their longest task is measured
  const w = await fresh();
  const PATHS = [];
  for (let i = 0; i < 10000; i++) PATHS.push(`/f${String(i).padStart(5, "0")}.txt`);
  for (let d = 0; d < 9; d++) for (let i = 0; i < 9999; i++) PATHS.push(`/d${d}/g${String(i).padStart(5, "0")}.txt`);
  await new Promise((ok, no) => { const tx = w.ws.transaction("entries", "readwrite"), st = tx.objectStore("entries"); for (let d = 0; d < 9; d++) st.put({ path: `/d${d}`, kind: "folder", ref: null, created: 1, updated: 1, fid: "f".repeat(15) + d, nkey: W.nkeyOf(`/d${d}`) }); for (const p of PATHS) st.put({ path: p, kind: "file", ref: p, size: 0, rev: 0, fid: "0".repeat(16), created: 1, updated: 1, migrated: true, nkey: W.nkeyOf(p) }); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  let longest = 0;
  const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longest = Math.max(longest, e.duration); });
  try { po.observe({ type: "longtask" }); } catch {}
  const big = await W.Workspace.open({ name: `ws-test-${n}`, mainName: `main-test-${n}`, limits: { ...W.LIMITS, maxEntries: 200000, maxFolderEntries: 20000 } });
  const t0 = performance.now();
  await big.create("/café.txt", { content: "1" });
  const r = await fails(big.create("/café.txt", { content: "2" }), "exists");
  const t1 = performance.now();
  const u = await big.usage();
  const t2 = performance.now();
  await new Promise((ok) => setTimeout(ok, 100));
  po.disconnect();
  check(r && u.lookalikes.length === 0, "at 100,000 entries (10,000 in one folder): a lookalike refused by the index: " + JSON.stringify({ create: Math.round(t1 - t0), usage: Math.round(t2 - t1) }));
  check(longest < 1000, `…its longest task under 1 s: ${Math.round(longest)} ms (create ${Math.round(t1 - t0)} ms, usage ${Math.round(t2 - t1)} ms)`);
  big.close();
  w.close();
}

// ---- detecting a lost workspace (design/workspace-durability.md, part A)
// (each case's workspace on its own: the notebooks' history database is one for the whole origin, so the fence
// an earlier case's workspace left there is dropped first; in a browser there is only ever one workspace)
const named = async () => {
  n++;
  for (const h of [await W.openHistoryDb(), await W.openBoardHistoryDb()]) if (h) { await rawDel(h, "history", ["__sagebrush-workspace__", ""]).catch(() => {}); h.close(); }
  return { name: `ws-test-${n}`, mainName: `main-test-${n}` };
};
const openAs = (o) => W.Workspace.open(o);
const dropDb = (name) => new Promise((ok, no) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = ok; r.onerror = () => no(r.error); r.onblocked = ok; });
const localW = (name) => { const r = W.readLocal(W.placeOf(name)); return "witness" in r ? r.witness : r; };
const opfsW = async (name) => { const r = await W.readOpfs(W.placeOf(name)); return "witness" in r ? r.witness : r; };
const wit = (o) => ({ v: 1, workspace: "a".repeat(16), generation: 1, seq: 10, entries: 3, sampled: 1, ...o });

async function durabilityDecide() {
  const R = (w) => ({ witness: w }), none = { none: true }, bad = { unreadable: "denied" };
  const held = (o) => ({ fresh: false, workspace: "a".repeat(16), generation: 1, seq: 10, ...o });
  check(W.decide(held({ fresh: true, workspace: undefined, seq: 0 }), [none, none]).state === "first", "decide: nothing anywhere: a first visit (or a complete clearing: indistinguishable)");
  check(W.decide(held({}), [none, none]).state === "ok", "decide: a workspace and no witness: ok");
  check(W.decide(held({ dataLoss: "total" }), [none, none]).state === "confirmed", "decide: Chrome's dataLoss total: confirmed");
  check(W.decide(held({ fresh: true, workspace: undefined, seq: 0 }), [R(wit({})), none]).state === "confirmed", "decide: a new database and a witness: confirmed");
  check(W.decide(held({ seq: 7 }), [R(wit({})), none]).state === "suspected", "decide: behind the witness, same workspace and generation: suspected");
  check(W.decide(held({ seq: 12 }), [R(wit({})), none]).state === "ok", "decide: ahead of the witness: ok (IndexedDB ahead is harmless)");
  check(W.decide(held({ generation: 1 }), [R(wit({ generation: 2, seq: 1 })), none]).state === "suspected", "decide: below a committed witness generation: suspected");
  check(W.decide(held({ generation: 3, seq: 0 }), [R(wit({ generation: 2 })), none]).state === "ok", "decide: a higher generation than the witnesses: ok");
  check(W.decide(held({ workspace: "b".repeat(16), seq: 0 }), [R(wit({})), none]).state === "ok", "decide: another workspace's witness: not compared");
  check(W.decide(held({ fresh: true, workspace: undefined, seq: 0 }), [bad, none]).state === "unknown", "decide: a new database and an unreadable witness: unknown, never a first visit");
  const okU = W.decide(held({}), [bad, bad]);
  check(okU.state === "ok" && !!okU.unavailable, "decide: a workspace whose witnesses can't be read: ok, detection unavailable said");
  check(W.decide(held({ seq: 15 }), [R(wit({ seq: 20 })), R(wit({ seq: 12 }))]).state === "suspected", "decide: two witnesses disagreeing: the newer counts");
  const p = wit({ reset: { to: 2, kind: "new", at: 1 } });
  check(W.resolveReset(p, held({})) === "rollback", "a prepared reset, IndexedDB unchanged: rolled back");
  check(W.resolveReset(p, held({ workspace: "c".repeat(16), generation: 2 })) === "finish", "…IndexedDB at the new generation: finished");
  check(W.resolveReset(p, held({ fresh: true, workspace: undefined })) === "lost" && W.resolveReset(wit({ reset: { to: 2, kind: "import", at: 1 } }), held({ fresh: true, workspace: undefined })) === "lost", "…a new database under a prepared reset (a reset never deletes the database): a loss, for any kind");
  check(W.resolveReset(p, null) === "unknown" && W.resolveReset(p, held({ workspace: "d".repeat(16), generation: 7 })) === "unknown", "…storage unreadable, or another generation: unknown");
  check(!W.newer(wit({ seq: 30 }), p) && W.newer(wit({ seq: 30 }), wit({})) && !W.newer(wit({ seq: 5 }), wit({})), "a normal publication never replaces a prepared reset, nor a newer witness");
}

async function durabilityFirstSave() {
  const o = await named();
  const w = await openAs(o);
  check(w.durability.state === "first" && !("witness" in W.readLocal(W.placeOf(o.name))), "a first visit: no witness yet");
  await w.create("/a.txt", { content: "a" });
  const lw = localW(o.name);
  check(lw.workspace === w.identity.workspace && lw.generation === 1 && lw.seq >= 1 && lw.entries === 1, "the first save has its witness in localStorage before it is reported: " + JSON.stringify(lw));
  await w.flushOpfs();
  const ow = await opfsW(o.name);
  check(ow.seq === lw.seq && ow.workspace === lw.workspace, "…and in OPFS once flushed: " + JSON.stringify(ow));
  w.close();
}

async function durabilityConfirmed() {
  const o = await named();
  let w = await openAs(o);
  await w.create("/a.txt", { content: "a" });
  await w.create("/b.txt", { content: "b" });
  const before = localW(o.name);
  w.close();
  await dropDb(o.name);
  w = await openAs(o);
  check(w.durability.state === "confirmed" && w.durability.witness?.entries === 2, "the database gone, a witness left: confirmed, with the witness's numbers: " + JSON.stringify(w.durability));
  check(await fails(w.create("/c.txt", { content: "c" }), "quarantined") && await fails(w.mkdir("/d"), "quarantined") && await fails(w.forAgent("agent:x").create("/e.txt", { content: "e" }), "quarantined"), "quarantined: the verbs refuse, the agents' too");
  const mr = await W.migrate(w, { length: 0, key: () => null, getItem: () => null, setItem: () => {} });
  await W.startMigrator(w);
  check(mr.boards === 0 && (await W.migrationState(w)).done === undefined && (await W.migrationState(w)).pass === undefined, "…and nothing else writes: migrate and the migrator do nothing");
  check(JSON.stringify(localW(o.name)) === JSON.stringify(before), "…the witness left as it was");
  w.close();
  w = await openAs(o);
  check(w.durability.state === "confirmed", "a reload doesn't lift the quarantine");
  const id = await w.reset("new");
  check(id.generation === 2 && w.durability.state === "ok" && !!(await w.create("/c.txt", { content: "c" })), "Start a new workspace here: generation 2, writable");
  check(localW(o.name).generation === 2 && localW(o.name).workspace === id.workspace && !localW(o.name).reset, "…the witness committed at it");
  w.close();
  w = await openAs(o);
  check(w.durability.state === "ok", "…and the next open is ok");
  w.close();
}

async function durabilitySuspected() {
  const o = await named();
  let w = await openAs(o);
  await w.create("/a.txt", { content: "a" });
  await w.create("/b.txt", { content: "b" });
  const lw = localW(o.name);
  W.writeLocal(W.placeOf(o.name), { ...lw, seq: lw.seq + 5 });
  w.close();
  w = await openAs(o);
  check(w.durability.state === "suspected", "changes missing (the witness ahead): suspected: " + JSON.stringify(w.durability));
  await w.reset("keep");
  check(w.durability.state === "ok" && (await paths(w)).join() === "/a.txt,/b.txt" && w.identity.generation === 2, "Keep what this browser has: nothing deleted, generation 2");
  w.close();
  w = await openAs(o);
  check(w.durability.state === "ok", "…and the next open is ok");
  w.close();
}

async function durabilityWitnesses() {
  const o = await named();
  let w = await openAs(o);
  await w.create("/a.txt", { content: "a" });
  await w.flushOpfs();
  localStorage.setItem(W.placeOf(o.name).key, "{not json");
  w.close();
  await dropDb(o.name);
  w = await openAs(o);
  check(w.durability.state === "confirmed", "the localStorage witness corrupt, the OPFS one used: confirmed");
  w.close();
  const p = await named();
  w = await openAs(p);
  await w.create("/a.txt", { content: "a" });
  W.writeLocal(W.placeOf(p.name), null);
  await W.writeOpfs(W.placeOf(p.name), null);
  w.close();
  w = await openAs(p);
  check(w.durability.state === "ok", "both witnesses gone, the workspace there: ok");
  w.close();
}

async function durabilityDenied() {
  const o = await named();
  const get = Storage.prototype.getItem, set = Storage.prototype.setItem, dir = navigator.storage.getDirectory;
  Storage.prototype.getItem = function () { throw new Error("denied (test)"); };
  Storage.prototype.setItem = function () { throw new Error("denied (test)"); };
  navigator.storage.getDirectory = async () => { throw new Error("denied (test)"); };
  try {
    let w = await openAs(o);
    check(w.durability.state === "unknown", "storage denied on a first visit: unknown, never first: " + JSON.stringify(w.durability));
    check(!!(await w.create("/a.txt", { content: "a" })) && !!w.witnessDown.local, "a save goes through when its witness can't be written, the witness noted down: " + JSON.stringify(w.witnessDown));
    w.close();
    w = await openAs(o);
    check(w.durability.state === "ok" && !!w.durability.unavailable, "…and a workspace there with unreadable witnesses: ok, detection said unavailable");
    w.close();
  } finally {
    Storage.prototype.getItem = get;
    Storage.prototype.setItem = set;
    navigator.storage.getDirectory = dir;
  }
}

async function durabilityTwoTabs() {
  const o = await named();
  const a = await openAs(o), b = await openAs(o);
  let last = 0, regressed = false;
  for (let i = 0; i < 10; i++) {
    await (i % 2 ? a : b).create(`/f${i}.txt`, { content: String(i) });
    const s = localW(o.name).seq;
    if (s < last) regressed = true;
    last = s;
  }
  // (the OPFS witness, flushed late and out of order: each flush samples under the lock, so it never goes back)
  await b.flushOpfs();
  await a.flushOpfs();
  check(!regressed && last === (await a.generation()) && (await opfsW(o.name)).seq === last, "two tabs committing in turn: the witnesses never go back");
  a.close();
  b.close();
}

async function durabilityTabs() {
  // astra's probe: two first opens at once install one identity
  {
    const o = await named();
    const [a, b] = await Promise.all([openAs(o), openAs(o)]);
    const ok = a.identity.workspace === b.identity.workspace && a.identity.generation === b.identity.generation;
    check(ok && !!(await a.create("/a.txt", { content: "a" })) && !!(await b.create("/b.txt", { content: "b" })), "two first opens at once: one identity, both can write: " + JSON.stringify([a.identity, b.identity]));
    a.close();
    b.close();
  }
  // astra's probe: a tab opened before another tab found a loss: its changes refused too, by meta (its channel
  // closed) and by the broadcast
  for (const viaChannel of [false, true]) {
    const o = await named();
    const early = await openAs(o);
    if (!viaChannel) early.channel?.close();
    let told = 0;
    early.onDurability(() => told++);
    await early.create("/a.txt", { content: "a" });
    const lw = localW(o.name);
    W.writeLocal(W.placeOf(o.name), { ...lw, seq: lw.seq + 5 });
    const later = await openAs(o);
    check(later.durability.state === "suspected", "(another tab finds changes missing)");
    if (viaChannel) for (let i = 0; i < 50 && !early.quarantined; i++) await new Promise((r) => setTimeout(r, 20));
    check(await fails(early.create("/after-loss.txt", { content: "x" }), "quarantined") && early.quarantined && told >= 1 && !(await paths(later)).includes("/after-loss.txt"), `a tab opened before the loss was found: its changes refused, the page told (${viaChannel ? "by the broadcast" : "by meta, inside the lock"})`);
    early.close();
    later.close();
  }
}

async function durabilityPurge() {
  // astra's probe: a reset to a new workspace doesn't come back through migrate (the old store's notebooks, localStorage's boards)
  for (const killed of [false, true]) {
    const o = await named();
    const w = await openAs(o);
    await rawPut(w.main, "notebooks", { id: "nb-old", name: "notes", cells: [], rev: 1, updated: 1 });
    localStorage.setItem("sagebrush-board:local:aaaaaaaaaaaa", JSON.stringify({ title: "Old board", nodes: [] }));
    await W.migrate(w, localStorage);
    check((await paths(w)).length >= 1, "(the old notebook and board brought in)");
    if (killed) W.RESET_HOOK.beforePurge = () => { throw new Error("killed (test)"); };
    await w.reset("new").catch(() => {});
    W.RESET_HOOK.beforePurge = undefined;
    let v = w;
    if (killed) { w.close(); v = await openAs(o); await v.settled(); }
    await W.migrate(v, localStorage);
    const nbs = await new Promise((ok) => { const r = v.main.transaction("notebooks").objectStore("notebooks").getAllKeys(); r.onsuccess = () => ok(r.result.filter((k) => k !== "__sagebrush-workspace__")); });
    check((await paths(v)).length === 0 && nbs.length === 0 && localStorage.getItem("sagebrush-board:local:aaaaaaaaaaaa") === null, `a reset to a new workspace${killed ? ", killed before its purge" : ""}, then migrate: nothing brought back`);
    v.close();
  }
}

async function durabilityPurgePending() {
  // astra's CORR-2A4-3: migrate brings nothing in while a purge is pending, even with its pages under way
  const o = await named();
  let w = await openAs(o);
  await new Promise((ok, no) => { const tx = w.main.transaction("notebooks", "readwrite"); for (let i = 0; i < 600; i++) tx.objectStore("notebooks").put({ id: "old-" + String(i).padStart(4, "0"), name: "n" + i, cells: [], rev: 1, updated: 1 }); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  W.RESET_HOOK.beforePurge = () => { throw new Error("killed (test)"); };
  await w.reset("new").catch(() => {});
  W.RESET_HOOK.beforePurge = undefined;
  w.close();
  // (the purge stopped after its first page, as a stop would leave it: 100 old notebooks left, the purge pending)
  W.RESET_HOOK.afterPage = (store) => { if (store === "notebooks") throw new Error("stopped (test)"); };
  w = await openAs(o);
  await w.settled();
  W.RESET_HOOK.afterPage = undefined;
  await W.migrate(w, localStorage);
  const early = await paths(w);
  await w.cleanUp();
  await W.migrate(w, localStorage);
  check(early.length === 0 && (await paths(w)).length === 0, `migrate while a purge is pending, and after: nothing brought back (${early.length}, ${(await paths(w)).length})`);
  w.close();
}

// (Storage's own length, read through its prototype's getter)
const realLength = (s) => Object.getOwnPropertyDescriptor(Storage.prototype, "length").get.call(s);

async function durabilityPurgeLocalSparse() {
  // daybreak2's LIMIT-28F-1: 500 keys to purge among 20,000 others: listed once per run, never a scan per step
  const o = await named();
  let w = await openAs(o);
  const others = [];
  for (let i = 0; i < 20000; i++) {
    const k = `unrelated-${i}`;
    localStorage.setItem(k, "x");
    others.push(k);
    if (i % 40 === 0) localStorage.setItem(`sagebrush-board:local:${String(i).padStart(12, "0")}`, "{}");
  }
  W.RESET_HOOK.beforePurge = () => { throw new Error("killed (test)"); };
  await w.reset("new").catch(() => {});
  W.RESET_HOOK.beforePurge = undefined;
  w.close();
  // (the work counted, not timed: daybreak2's r2 contract for LIMIT-28F-1. A scan is a run of localStorage.key(0),
  // key(1), ... and must read exactly the length there was when it began; the purge makes exactly two, its first
  // listing before any removal and its terminal verification after the last page, with no key() call between pages
  // and at most LOCAL_PAGE removals a page. The counters are on Storage.prototype, counting only this localStorage
  // (a property set on the instance would be a setItem), and are put back, and checked put back, in finally.
  // Times are only reported: a hang is the runner's timeout's to catch)
  const proto = Storage.prototype, realKey = proto.key, realRemove = proto.removeItem;
  const scans = [], steps = [];
  let removals = 0, pageRemovals = 0, stray = 0, cur = null;
  const L0 = localStorage.length;
  let last = performance.now(), openMs = 0;
  // (installed inside the try, so a failure part way through still puts everything back; the put-back is checked at
  // the end of finally, so it is checked whatever happened: daybreak2's #261 review)
  try {
    W.RESET_HOOK.afterPage = (store, n) => { if (store === "localStorage") { const t = performance.now(); steps.push({ n, removed: pageRemovals, keyCalls: 0, ms: Math.round(t - last) }); pageRemovals = 0; last = t; } };
    proto.key = function (i) {
      if (this === localStorage) {
        if (i === 0) scans.push((cur = { len: realLength(this), n: 0, removalsBefore: removals, pagesBefore: steps.length }));
        if (cur && i === cur.n) cur.n++;
        else stray++;
        if (steps.length) steps[steps.length - 1].keyCalls++;
      }
      return realKey.call(this, i);
    };
    proto.removeItem = function (k) {
      if (this === localStorage) { removals++; pageRemovals++; }
      return realRemove.call(this, k);
    };
    const t0 = performance.now();
    w = await openAs(o);
    openMs = performance.now() - t0;
    await w.settled();
  } finally {
    W.RESET_HOOK.afterPage = undefined;
    proto.key = realKey;
    proto.removeItem = realRemove;
    check(Storage.prototype.key === realKey && Storage.prototype.removeItem === realRemove, "the counters on Storage.prototype are put back");
  }
  const left = Object.keys(localStorage).filter((k) => k.startsWith("sagebrush-board:local:")).length;
  const [first, terminal] = scans;
  // (key() calls after a page and before the next page's end: only the terminal scan may make them, after the last page)
  const between = steps.slice(0, -1).reduce((a, s) => a + s.keyCalls, 0);
  const scansOk = scans.length === 2 && stray === 0 && first.n === first.len && first.removalsBefore === 0 && first.pagesBefore === 0
    && terminal.n === terminal.len && terminal.pagesBefore === steps.length && terminal.removalsBefore === removals;
  // (every removal inside a page: none after the last page's hook, and the pages' removals are all of them)
  const pagesOk = steps.length === 3 && steps.every((s) => s.n <= W.LOCAL_PAGE && s.removed <= W.LOCAL_PAGE) && removals === 500 && between === 0
    && pageRemovals === 0 && steps.reduce((a, s) => a + s.removed, 0) === removals;
  check(left === 0 && scansOk && pagesOk, `500 keys purged among 20,000 others, ${W.LOCAL_PAGE} a step: two scans (the listing, then the terminal check), no scan between pages: ${JSON.stringify({ L0, scans, stray, removals, afterLastPage: pageRemovals, steps })}`);
  check(openMs < 1000 && others.every((k) => localStorage.getItem(k) === "x"), `…the open within its budget (${Math.round(openMs)} ms), the other keys untouched`);
  for (const k of others) localStorage.removeItem(k);
  w.close();
}

async function durabilityResetManySmall() {
  // daybreak2's LIMIT-0EE-2: many small versions (200,000) go RESET_PAGE a page, their sizes read from the
  // versions' own records, the whole reset timed; large ones (4 MiB) at most RESET_PAGE_BYTES a page
  {
    const o = await named();
    const w = await openAs(o);
    const N = 200000, small = new Uint8Array(64);
    for (let start = 0; start < N; start += 20000) await new Promise((ok, no) => { const tx = w.ws.transaction(["versions", "versionBytes"], "readwrite"); for (let i = start; i < start + 20000; i++) { tx.objectStore("versions").put({ id: i + 1, fid: "0".repeat(16), t: 1, size: 64, sha256: "x", by: "person", device: "d" }); tx.objectStore("versionBytes").put(small, i + 1); } tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    const pages = [];
    let progress = 0;
    w.onDurability(() => { if (w.durability.state === "resetting") progress = Math.max(progress, w.resetRemoved); });
    W.RESET_HOOK.afterPage = (store, n) => { if (store === "versionBytes") pages.push(n); };
    const t0 = performance.now();
    await w.reset("new");
    const ms = performance.now() - t0;
    W.RESET_HOOK.afterPage = undefined;
    check(pages.length === N / W.RESET_PAGE && pages.every((n) => n <= W.RESET_PAGE), `200,000 small versions: ${W.RESET_PAGE} a page (${pages.length} pages)`);
    check(ms < 60000, `…the whole reset done in under a minute (${Math.round(ms)} ms)`);
    check(progress > 0, `…its progress told meanwhile (${progress} records removed at a notice)`);
    w.close();
  }
  {
    const o = await named();
    const w = await openAs(o);
    const big = new Uint8Array(4 << 20);
    for (let i = 0; i < 40; i++) await new Promise((ok, no) => { const tx = w.ws.transaction(["versions", "versionBytes"], "readwrite"); tx.objectStore("versions").put({ id: i + 1, fid: "0".repeat(16), t: 1, size: big.length, sha256: "x", by: "person", device: "d" }); tx.objectStore("versionBytes").put(big, i + 1); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    const pages = [];
    W.RESET_HOOK.afterPage = (store, n) => { if (store === "versionBytes") pages.push(n); };
    await w.reset("new");
    W.RESET_HOOK.afterPage = undefined;
    check(pages.length === 5 && pages.every((n) => n * (4 << 20) <= W.RESET_PAGE_BYTES), `40 versions of 4 MiB: at most ${W.RESET_PAGE_BYTES / 2 ** 20} MiB a page, by their recorded sizes (${JSON.stringify(pages)})`);
    w.close();
  }
  const e = W.showLossNotice({ durability: { state: "resetting" }, resetRemoved: 1234 });
  check(/being reset: 1234 records removed/.test(e?.textContent ?? "") && !e?.querySelector("button"), "the resetting notice: its progress, no choices");
  e?.remove();
}

async function durabilityPurgeLocal() {
  // daybreak2's LIMIT-0EE-1: localStorage's boards and pending copies purged LOCAL_PAGE keys a step; an open
  // resuming the purge stays within its budget however many there are
  const o = await named();
  let w = await openAs(o);
  for (let i = 0; i < 1000; i++) {
    localStorage.setItem(`sagebrush-board:local:${String(i).padStart(12, "0")}`, JSON.stringify({ title: "b" + i, nodes: [] }));
    localStorage.setItem(`sagebrush-workspace-pending:${String(i).padStart(12, "0")}`, "{}");
  }
  W.RESET_HOOK.beforePurge = () => { throw new Error("killed (test)"); };
  await w.reset("new").catch(() => {});
  W.RESET_HOOK.beforePurge = undefined;
  w.close();
  const steps = [];
  W.RESET_HOOK.afterPage = (store, n) => { if (store === "localStorage") steps.push(n); };
  const t0 = performance.now();
  w = await openAs(o);
  const openMs = performance.now() - t0;
  await w.settled();
  W.RESET_HOOK.afterPage = undefined;
  const left = Object.keys(localStorage).filter((k) => k.startsWith("sagebrush-board:local:") || k.startsWith("sagebrush-workspace-pending:")).length;
  check(left === 0 && steps.length === 2000 / W.LOCAL_PAGE && steps.every((n) => n <= W.LOCAL_PAGE), `2,000 keys in localStorage purged ${W.LOCAL_PAGE} a step (${steps.length} steps), none left`);
  check(openMs < 1000, `…the open resuming that purge returns within its budget (${Math.round(openMs)} ms)`);
  w.close();
}

async function durabilityResetBounds() {
  // daybreak2's L2: a reset to a new workspace empties its stores a page at a time, never one transaction over all
  // of it; killed part way, the next open finishes it
  for (const killed of [false, true]) {
    const o = await named();
    const w = await openAs(o);
    const N = 1600;
    await new Promise((ok, no) => { const tx = w.ws.transaction(["entries", "versions", "versionBytes"], "readwrite"); for (let i = 0; i < N; i++) { tx.objectStore("entries").put({ path: `/f${i}.txt`, kind: "file", ref: `/f${i}.txt`, size: 1, rev: 0, fid: i.toString(16).padStart(16, "0"), created: 1, updated: 1, migrated: true, nkey: "/\u0000f" + i }); tx.objectStore("versionBytes").put(new Uint8Array(64), i + 1); } tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    const pages = [];
    W.RESET_HOOK.afterPage = (store, n) => { pages.push([store, n]); if (killed && pages.length === 3) throw new Error("killed (test)"); };
    await w.reset("new").catch(() => {});
    W.RESET_HOOK.afterPage = undefined;
    let v = w;
    if (killed) {
      check(await fails(v.create("/x.txt", { content: "x" }), "storage") || await fails(v.create("/x.txt", { content: "x" }), "quarantined"), "(killed part way: nothing written meanwhile)");
      v.close();
      // (the open returns at once, the reset resumed in the background, writers refused until it's done: LIMIT-99B-3)
      const t0 = performance.now();
      W.RESET_HOOK.openBudgetMs = 0;
      v = await openAs(o);
      W.RESET_HOOK.openBudgetMs = undefined;
      const openMs = performance.now() - t0;
      check(v.durability.state === "resetting" && await fails(v.create("/y.txt", { content: "y" }), "quarantined"), "killed part way: the next open says resetting, and refuses writes meanwhile: " + JSON.stringify(v.durability));
      check(openMs < 2000, `…and returns without waiting for the cleanup (${Math.round(openMs)} ms)`);
      await v.settled();
    }
    const left = await new Promise((ok) => { const r = v.ws.transaction("entries").objectStore("entries").count(); r.onsuccess = () => ok(r.result); });
    check(left === 0 && v.durability.state === "ok" && v.identity.generation === 2 && !!(await v.create("/new.txt", { content: "n" })), `a reset of ${N} entries${killed ? ", killed part way, finished by the next open" : ""}: emptied, writable`);
    const bytes = new Set(["fileBytes", "versionBytes", "trash", "files"]);
    check(pages.every(([st, n]) => n <= (bytes.has(st) ? W.RESET_BYTES_PAGE : W.RESET_PAGE)) && (killed || pages.filter(([st]) => st === "entries").length === Math.ceil(N / W.RESET_PAGE)), `…a page of at most ${W.RESET_PAGE} records per transaction, ${W.RESET_BYTES_PAGE} of files' bytes (${pages.length} pages)`);
    v.close();
  }
  // daybreak2's LIMIT-99B-2: many keys in meta, deleted in pages by a bounded cursor (never all read again each page)
  {
    const o = await named();
    const w = await openAs(o);
    await new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); for (let i = 0; i < 3000; i++) tx.objectStore("meta").put({ x: i }, `stale:files:/f${i}`); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    const pages = [];
    W.RESET_HOOK.afterPage = (store, n) => { if (store === "meta") pages.push(n); };
    await w.reset("new");
    W.RESET_HOOK.afterPage = undefined;
    const left = await new Promise((ok) => { const r = w.ws.transaction("meta").objectStore("meta").getAllKeys(); r.onsuccess = () => ok(r.result.filter((k) => String(k).startsWith("stale:"))); });
    check(left.length === 0 && pages.length === 6 && pages.every((n) => n <= W.RESET_PAGE), `3,000 keys in meta: deleted, ${W.RESET_PAGE} a page (${JSON.stringify(pages)})`);
    w.close();
  }
  // daybreak2's LIMIT-99B-1: files' bytes deleted RESET_BYTES_PAGE records a page, each page's time measured with large values
  {
    const o = await named();
    const w = await openAs(o);
    const big = new Uint8Array(4 << 20);
    for (let i = 0; i < 64; i++) await new Promise((ok, no) => { const tx = w.ws.transaction("fileBytes", "readwrite"); big[0] = i; tx.objectStore("fileBytes").put(big, i.toString(16).padStart(16, "0")); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    const pages = [];
    W.RESET_HOOK.afterPage = (store, n, ms) => { if (store === "fileBytes") pages.push([n, Math.round(ms)]); };
    await w.reset("new");
    W.RESET_HOOK.afterPage = undefined;
    check(pages.length === 2 && pages.every(([n, ms]) => n <= W.RESET_BYTES_PAGE && ms < 500), `256 MiB of files' bytes: ${W.RESET_BYTES_PAGE} records a page, each page under 0.5 s (${JSON.stringify(pages)})`);
    w.close();
  }
  // daybreak2's L1: after a reset out of a quarantine, the OPFS witness is flushed when the page is hidden too
  const o = await named();
  let w = await openAs(o);
  await w.create("/a.txt", { content: "a" });
  w.close();
  await dropDb(o.name);
  w = await openAs(o);
  check(w.quarantined && !!w.onHidden, "opened quarantined: the flush on hidden installed already (daybreak2's L1)");
  await w.reset("new");
  check(!!w.onHidden, "a reset out of a quarantine: the flush on hidden installed");
  w.close();
}

async function durabilityNotices() {
  // the notebooks' own saves, gated by the page while quarantined (astra's probe: the notebook editor saved through it)
  const o = await named();
  let w = await openAs(o);
  await w.create("/a.txt", { content: "a" });
  w.close();
  await dropDb(o.name);
  w = await openAs(o);
  W.setSaveGate(() => (w.quarantined ? "quarantined (test)" : null));
  const st = new W.IdbStore(w.main, "nb-q", { id: "nb-q", name: "n", cells: [] });
  const saved = await st.save({ id: "nb-q", name: "CHANGED WHILE QUARANTINED", cells: [] });
  W.setSaveGate(null);
  check(typeof saved === "string" && /not saved/.test(saved), "the notebooks' saves refused while quarantined: " + JSON.stringify(saved));
  // (and their history's: nothing appended, clear and drop refused, by the quarantine's flag alone)
  const hdb = await W.openHistoryDb();
  const hist = new W.IdbPatchStore(hdb, "nb-q-history");
  hist.append({ time: "2026-10-20T00:00:00.000Z", id: "p1" });
  await new Promise((r) => setTimeout(r, 200));
  const rows = await new Promise((ok) => { const r = hdb.transaction("history").objectStore("history").count(IDBKeyRange.bound(["nb-q-history", ""], ["nb-q-history", "\uffff"])); r.onsuccess = () => ok(r.result); });
  check(rows === 0 && !!(await hist.clear().then(() => false, () => true)), "…and the notebooks' history: nothing appended, clearing refused, while quarantined");
  w.close();
  // (the flag this quarantine left, dropped: later cases' notebooks aren't refused)
  for (const k of Object.keys(localStorage)) if (k.startsWith("sagebrush-quarantined:")) localStorage.removeItem(k);
  // shown: a loss with its choices; a detection that can't work here, closable; an open that failed
  const box = (d, extra = {}) => { const e = W.showLossNotice({ durability: d, reset: async () => {}, ...extra }); const t = e?.textContent ?? ""; const b = [...(e?.querySelectorAll("button") ?? [])].map((x) => x.dataset.sbb); e?.remove(); return { t, b }; };
  const c = box({ state: "confirmed", why: "x", witness: { entries: 3, sampled: 1 } });
  check(/was lost/.test(c.t) && c.b.join() === "loss-new", "the notice for a loss: said, with Start a new workspace here");
  check(box({ state: "suspected", why: "x" }).b.join() === "loss-keep,loss-new", "…for missing changes: Keep, or Start new");
  const u = box({ state: "ok", unavailable: "denied" });
  check(/can't be detected/.test(u.t) && u.b.join() === "loss-close", "unreadable witnesses: said, and closable");
  check(/can't be detected/.test(box({ state: "ok" }, { witnessDown: { local: "quota" } }).t), "a witness that can't be written: said");
  check(/can't be opened/.test(box({ state: "unknown", why: "this browser's storage can't be opened: x" }).t), "an open that failed: said, never taken for a first visit");
  check(box({ state: "ok" }).t === "", "nothing to say: nothing shown");
}

// astra's eight Chromium probes on 2a4e53a8 (evidence/durability-detect-2a4-astra/probes.patch), kept as regression tests
async function durabilityAstraProbes() {
  const report=(name,v)=>{
    const wanted={
      'stale-reset':()=>v.error!==null&&v.paths.includes('/new.txt'),
      'other-tab-quarantine':()=>v.error!==null&&!v.paths.includes('/after-loss.txt'),
      'reset-resurrection':()=>v.afterMigration.length===0,
      'refused-reset-then-loss':()=>v.quarantined||v.state.state==='unknown',
      'concurrent-initial-identities':()=>v.a.workspace===v.b.workspace&&!v.ea&&!v.eb,
      'notebook-editor-quarantine':()=>!v.save?.saved&&v.name!=='CHANGED WHILE QUARANTINED',
      'unavailable-notice':()=>v.notice,
      'reset-without-prepare':()=>v.error!==null&&v.paths.includes('/a.txt')
    };check(wanted[name](),name+': '+JSON.stringify(v));
  };
  // Stale reset can erase the replacement workspace.
  {
    const o=await named(); const a=await openAs(o), b=await openAs(o);
    b.channel?.close(); b.channel=null; await a.reset('new'); await a.create('/new.txt',{content:'NEW'});
    let error=null;try {await b.reset('new')} catch(e){error=e.message}
    report('stale-reset',{error,paths:await paths(a),a:a.identity,b:b.identity});a.close();b.close();
  }
  // A previously open writer ignores persisted quarantine.
  {
    const o=await named(); const a=await openAs(o);await a.create('/a.txt',{content:'A'});await a.flushOpfs();
    const w=localW(o.name); W.writeLocal(W.placeOf(o.name),{...w,seq:w.seq+10});
    const b=await openAs(o);let error=null;try{await a.create('/after-loss.txt',{content:'WRITTEN'})}catch(e){error=e.message}
    report('other-tab-quarantine',{error,state:b.durability.state,paths:await paths(b)});a.close();b.close();
  }
  // New means empty only until reconcile reimports retained notebook data.
  {
    const o=await named();let a=await openAs(o); await a.create('/notes.ipynb');await a.reset('new');
    const immediately=await paths(a);a.close();a=await openAs(o);await W.migrate(a,localStorage);
    report('reset-resurrection',{immediately,afterMigration:await paths(a)});a.close();
  }
  // Failed preparation plus failed cleanup is treated as an actionable reset after primary loss.
  {
    const o=await named();let a=await openAs(o);await a.create('/a.txt',{content:'A'});await a.flushOpfs();
    W.RESET_HOOK.afterFirstWitness=()=>{throw Error('prepare refused')};W.RESET_HOOK.failCleanup=true;
    let refused=false;try{await a.reset('new')}catch(e){refused=true}
    W.RESET_HOOK.afterFirstWitness=undefined;W.RESET_HOOK.failCleanup=false;a.close();await dropDb(o.name);
    a=await openAs(o);report('refused-reset-then-loss',{refused,state:a.durability,quarantined:a.quarantined});a.close();
  }
  // Initial opens must share one primary identity, even before the first save.
  {
    const o=await named();const proto=W.Workspace.prototype, orig=proto.arrive;let count=0,release,entered;
    const wait=new Promise(r=>release=r), both=new Promise(r=>entered=r);
    proto.arrive=async function(...args){if(++count===2)entered();await wait;return orig.apply(this,args)};
    let a,b;try{const pa=openAs(o),pb=openAs(o);await both;release();[a,b]=await Promise.all([pa,pb])}finally{proto.arrive=orig}
    let ea=null,eb=null;try{await a.create('/a.txt',{content:'A'})}catch(e){ea=e.message}try{await b.create('/b.txt',{content:'B'})}catch(e){eb=e.message}
    report('concurrent-initial-identities',{a:a.identity,b:b.identity,ea,eb});a.close();b.close();
  }

  // The notebook editor's real store still saves while the Workspace is quarantined.
  {
    const {IdbStore}=await import('./stores.js');const o=await named();let a=await openAs(o);
    const e=await a.create('/n.ipynb');const old=await rawGet(a.main,'notebooks',e.ref);await a.flushOpfs();a.close();
    const witness=localW(o.name);W.writeLocal(W.placeOf(o.name),{...witness,seq:witness.seq+100});
    a=await openAs(o);const store=new IdbStore(a.main,e.ref);const loaded=await store.load();
    const save=await store.save({...loaded,name:'CHANGED WHILE QUARANTINED',baseRev:loaded.rev});
    report('notebook-editor-quarantine',{quarantined:a.quarantined,save,name:(await rawGet(a.main,'notebooks',e.ref)).name});a.close();
  }

  // Existing primary plus denied witnesses has no user-visible warning.
  {
    const o=await named();let a=await openAs(o);await a.create('/a.txt',{content:'A'});await a.flushOpfs();a.close();
    const get=Storage.prototype.getItem,dir=navigator.storage.getDirectory;
    Storage.prototype.getItem=function(){throw Error('denied')};navigator.storage.getDirectory=async()=>{throw Error('denied')};
    try{a=await openAs(o);report('unavailable-notice',{state:a.durability,witnessDown:a.witnessDown,notice:!!W.showLossNotice(a)});a.close()}finally{Storage.prototype.getItem=get;navigator.storage.getDirectory=dir}
  }
  // Known unavailable witnesses cause preparation to be silently skipped.
  {
    const o=await named();const a=await openAs(o);await a.create('/a.txt',{content:'A'});
    const set=Storage.prototype.setItem,dir=navigator.storage.getDirectory;
    Storage.prototype.setItem=function(){throw Error('denied')};navigator.storage.getDirectory=async()=>{throw Error('denied')};
    await a.create('/marker-fails.txt',{content:'M'});await a.flushOpfs();
    let error=null;try{await a.reset('new')}catch(e){error=e.message}finally{Storage.prototype.setItem=set;navigator.storage.getDirectory=dir}
    report('reset-without-prepare',{error,paths:await paths(a),identity:a.identity});a.close();
  }
}

// astra's six Chromium probes on 99b71e36 (evidence/durability-detect-99b-astra/probes.patch), kept as regression tests
async function durabilityAstraProbes99(){
 const out=(ok,name,v)=>check(ok,name+': '+JSON.stringify(v));
 // Fresh at indexedDB.open is not fresh after a different opener initializes it.
 {
  const o=await named(),proto=W.Workspace.prototype,orig=proto.arrive;let release,entered;
  const wait=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  proto.arrive=async function(info){if(info.fresh){entered();await wait}return orig.call(this,info)};
  let a,b;try{const pending=openAs(o);await ready;b=await openAs(o);await b.create('/real.txt',{content:'REAL'});release();a=await pending}finally{proto.arrive=orig}
  out(!a.quarantined&&!b.quarantined,'delayed-first-open',{a:a.durability,b:b.durability,paths:await paths(a)});a.close();b.close();
 }
 // A main-store page fails after deleting 500 of 501 records.
 {
  const o=await named();let a=await openAs(o);
  await new Promise((ok,no)=>{const tx=a.main.transaction('notebooks','readwrite'),st=tx.objectStore('notebooks');for(let i=0;i<501;i++)st.put({id:'p'+i,name:'p'+i,rev:1,cells:[]});tx.oncomplete=ok;tx.onerror=()=>no(tx.error)});
  let injected=false;W.RESET_HOOK.afterPage=(st)=>{if(st==='notebooks'&&!injected){injected=true;throw Error('purge page failed')}};
  let error=null;try{await a.reset('new')}catch(e){error=e.message}finally{W.RESET_HOOK.afterPage=undefined}
  const pending=await rawGet(a.ws,'meta','purgeMain');a.close();a=await openAs(o);await W.migrate(a,localStorage);
  const ps=await paths(a);out(ps.length===0,'purge-failure',{injected,error,pending,paths:ps});a.close();
 }
 // A stale notebook editor after reset is not fenced by workspace identity.
 {
  const o=await named(),a=await openAs(o),b=await openAs(o),e=await a.create('/old.ipynb');
  const store=new W.IdbStore(b.main,e.ref),old=await store.load();W.setSaveGate(()=>b.quarantined?'quarantined':null);
  await a.reset('new');await new Promise(r=>setTimeout(r,50));const save=await store.save({...old,baseRev:old.rev,name:'RESURRECTED'});
  await W.migrate(a,localStorage);const ps=await paths(a);out(!save?.saved&&ps.length===0,'stale-editor-after-reset',{bClosed:b.closed,save,paths:ps});W.setSaveGate(null);a.close();b.close();
 }
 // Existing page gate has not learned another tab's quarantine; flag reads/writes denied.
 {
  const o=await named(),a=await openAs(o),e=await a.create('/n.ipynb');await a.flushOpfs();
  const store=new W.IdbStore(a.main,e.ref),old=await store.load();W.setSaveGate(()=>a.quarantined?'quarantined':null);
  a.channel?.close();a.channel=null;const witness=localW(o.name);W.writeLocal(W.placeOf(o.name),{...witness,seq:witness.seq+10});await W.writeOpfs(W.placeOf(o.name),{...witness,seq:witness.seq+10});
  const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
  Storage.prototype.getItem=function(){throw Error('localStorage denied')};
  Storage.prototype.setItem=function(){throw Error('localStorage denied')};
  let b;try{b=await openAs(o);const save=await store.save({...old,baseRev:old.rev,name:'WRITTEN'});out(!save?.saved,'denied-flag-incumbent',{a:a.durability,b:b.durability,save})}finally{Storage.prototype.getItem=get;Storage.prototype.setItem=set;W.setSaveGate(null);a.close();b?.close()}
 }

 // First-visit state persists after its first save, so down notices are suppressed.
 {
  const o=await named(),a=await openAs(o),set=Storage.prototype.setItem,dir=navigator.storage.getDirectory;
  Storage.prototype.setItem=function(){throw Error('denied after open')};navigator.storage.getDirectory=async()=>{throw Error('denied after open')};
  try{await a.create('/first.txt',{content:'F'});await a.flushOpfs();out(!!W.showLossNotice(a),'first-save-failure-notice',{state:a.durability,down:a.witnessDown,notice:!!document.querySelector('#sagebrush-loss-notice')})}finally{Storage.prototype.setItem=set;navigator.storage.getDirectory=dir;a.close();document.querySelector('#sagebrush-loss-notice')?.remove()}
 }
 // Resume of a reset out of quarantine leaves the old quarantine flag behind.
 {
  const o=await named();let a=await openAs(o);await a.create('/a.txt',{content:'A'});await a.flushOpfs();a.close();
  const witness=localW(o.name);W.writeLocal(W.placeOf(o.name),{...witness,seq:witness.seq+10});a=await openAs(o);
  W.RESET_HOOK.afterPage=(st)=>{if(st==='entries')throw Error('killed reset')};await a.reset('new').catch(()=>{});W.RESET_HOOK.afterPage=undefined;a.close();
  a=await openAs(o);const save=await new W.IdbStore(a.main,'new-nb').save({id:'new-nb',name:'New',cells:[]});out(!!save?.saved,'resumed-reset-flag',{state:a.durability,flag:localStorage.getItem('sagebrush-quarantined:'+a.main.name),save});a.close();
 }
}

// astra's eight Chromium probes on 0eefec71 (evidence/durability-detect-0ee-astra/probes.patch), kept as
// regression tests; the board probe runs the wsSave of THIS head, extracted from board/page.ts by
// test-workspace.mjs (WS_SAVE), where astra pasted 0eefec71's, and a refusal it throws is recorded rather than
// thrown out of the probe
async function durabilityAstraProbes0ee(){
 const out=(ok,name,v)=>check(ok,name+': '+JSON.stringify(v));
 W.setSaveGate(null);
 // A pre-workspace editor has seen null, which currently disables identity checking forever.
 {
  const o=await named();const legacy=await new Promise((ok,no)=>{const r=indexedDB.open(o.mainName);r.onupgradeneeded=()=>{r.result.createObjectStore('notebooks',{keyPath:'id'});r.result.createObjectStore('files')};r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});
  const st=new W.IdbStore(legacy,'old',{id:'old',name:'Old',cells:[]});const doc=await st.load();
  const a=await openAs(o);await W.migrate(a,localStorage);await a.reset('new');
  const save=await st.save({...doc,baseRev:doc.rev,name:'LEGACY RESURRECTED'});await W.migrate(a,localStorage);
  out(!save?.saved,'no-fence-editor',{seen:st.fence,save,paths:await paths(a)});a.close();legacy.close();
 }

 // A document read before reset is paired with a fence read after reset.
 {
  const o=await named(),a=await openAs(o),e=await a.create('/before.ipynb'),st=new W.IdbStore(a.main,e.ref);
  const transaction=a.main.transaction.bind(a.main),desc=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete');let first=true;
  a.main.transaction=function(...args){const tx=transaction(...args);if(first&&args[0]==='notebooks'&&args[1]==='readonly'){first=false;Object.defineProperty(tx,'oncomplete',{get(){return desc.get.call(tx)},set(fn){desc.set.call(tx,async ev=>{await a.reset('new');fn.call(tx,ev)})}})}return tx};
  let doc;try{doc=await st.load()}finally{a.main.transaction=transaction}
  const save=await st.save({...doc,baseRev:doc.rev,name:'TORN LOAD'});await W.migrate(a,localStorage);
  out(!save?.saved,'split-load-fence',{seen:st.fence,identity:a.identity,save,paths:await paths(a)});a.close();
 }
 // History deletion checks one transaction, then deletes in another.
 {
  const o=await named(),a=await openAs(o);await a.create('/a.txt',{content:'A'});await a.flushOpfs();
  const hdb=await W.openHistoryDb(),h=new W.IdbPatchStore(hdb,'race-history');await h.loadInitial();
  await rawPut(hdb,'history',{nb:'race-history',time:'t1',env:{time:'t1'}});
  const witness=localW(o.name);W.writeLocal(W.placeOf(o.name),{...witness,seq:witness.seq+10});
  const allowed=h.allowed.bind(h);let b;h.allowed=async()=>{await allowed();b=await openAs(o)};
  let error=null;try{await h.clear()}catch(e){error=e.message}
  const rows=await rawKeys(hdb,'history');out(error!==null&&rows.some(k=>k[0]==='race-history'),'history-clear-race',{error,bState:b?.durability.state,left:rows.filter(k=>k[0]==='race-history')});a.close();b?.close();hdb.close();
 }
 // Fence publication failure is swallowed after the primary decided quarantine.
 {
  const o=await named(),a=await openAs(o),e=await a.create('/n.ipynb');await a.flushOpfs();a.channel?.close();a.channel=null;
  const st=new W.IdbStore(a.main,e.ref),doc=await st.load();const witness=localW(o.name);W.writeLocal(W.placeOf(o.name),{...witness,seq:witness.seq+10});
  const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v,...args){if(this.name==='notebooks'&&v?.id==='__sagebrush-workspace__')throw Error('fence write failed');return put.call(this,v,...args)};
  let b;try{b=await openAs(o);const save=await st.save({...doc,baseRev:doc.rev,name:'AFTER FENCE FAILURE'});out(!save?.saved,'failed-fence',{bState:b.durability.state,save})}finally{IDBObjectStore.prototype.put=put;a.close();b?.close()}
 }

 // A delayed broadcast in a closed old tab writes an old fence over the current one.
 {
  const o=await named(),a=await openAs(o),b=await openAs(o);await b.create('/a.txt',{content:'A'});const witness=localW(o.name);
  await b.reset('new');await new Promise(r=>setTimeout(r,25));
  a.channel.onmessage({data:{from:'delayed-peer',quarantine:{state:'suspected',witness,why:'old queued message'}}});
  await new Promise(r=>setTimeout(r,30));const fence=await rawGet(b.main,'notebooks','__sagebrush-workspace__');
  out(fence.workspace===b.identity.workspace&&fence.generation===b.identity.generation&&!fence.quarantined,'late-old-fence',{aClosed:a.closed,current:b.identity,fence});a.close();b.close();
 }
 // Exact wsSave function extracted and transpiled from this head's board/page.ts.
 {
  const o=await named();let a=await openAs(o);const e=await a.create('/b.board.json'),doc=(await a.read(e.path)).content;await a.flushOpfs();a.close();
  const witness=localW(o.name);W.writeLocal(W.placeOf(o.name),{...witness,seq:witness.seq+10});a=await openAs(o);
  const {WS_SAVE}=await import('./wssave.js');const result=await new Function('ws','id','d',"let wsRefused=null,wsBlocked=null,wsSeq=0,wsRev=1,wsEpoch=0,wsCopy=null,wsWriting=Promise.resolve();const wsLatest=new Map(),PENDING_MAX=8*2**20,PENDING=\"sagebrush-workspace-pending:\",SESSION=\"a\".repeat(16);const logSave=()=>{};const journalOn=false,jstore=null;let wsBridge=null;\n"+WS_SAVE+"\n\ntry{wsSave(id,d)}catch(e){wsRefused=e}return wsWriting.then(()=>({pending:!!localStorage.getItem(PENDING+id),refused:wsRefused?.code??wsRefused?.message}));")(a,e.ref,doc);
  out(!result.pending,'board-pending-through-quarantine',{quarantined:a.quarantined,...result});a.close();localStorage.removeItem('sagebrush-workspace-pending:'+e.ref);
 }
 // A purge-only resumed open sets an unquarantined fence before deleting main data.
 {
  const o=await named();let a=await openAs(o);await a.create('/old.ipynb');
  W.RESET_HOOK.beforePurge=()=>{throw Error('stop before purge')};await a.reset('new').catch(()=>{});W.RESET_HOOK.beforePurge=undefined;a.close();
  const proto=W.Workspace.prototype,orig=proto.cleanUp;let release,running;const wait=new Promise(r=>release=r);
  proto.cleanUp=function(...args){running=(async()=>{await wait;return orig.apply(this,args)})();return running};W.RESET_HOOK.openBudgetMs=0;
  try{a=await openAs(o)}finally{proto.cleanUp=orig;W.RESET_HOOK.openBudgetMs=undefined}
  let createError=null,entry;try{entry=await a.create('/new-accepted.ipynb')}catch(e){createError=e.message}
  release();await running;const content=entry?await rawGet(a.main,'notebooks',entry.ref):null;
  out(createError!==null,'purge-admits-new-save',{state:a.durability,createError,acknowledged:!!entry,contentSurvives:!!content,paths:await paths(a)});a.close();
 }
 // localStorage failure still drops the purge marker, allowing board resurrection.
 {
  const o=await named();let a=await openAs(o);const key='sagebrush-board:local:123456789abc';localStorage.setItem(key,JSON.stringify({title:'Old local board',nodes:[]}));await W.migrate(a,localStorage);
  const remove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){if(k===key)throw Error('remove denied');return remove.call(this,k)};
  let error=null;try{await a.reset('new')}catch(e){error=e.message}finally{Storage.prototype.removeItem=remove}
  const pending=await rawGet(a.ws,'meta','purgeMain');a.close();a=await openAs(o);await W.migrate(a,localStorage);
  const ps=await paths(a);out(ps.length===0,'local-purge-failure',{error,pending,paths:ps});a.close();localStorage.removeItem(key);
 }
}

async function durabilityDeliberate() {
  const o = await named();
  let w = await openAs(o);
  for (let i = 0; i < 20; i++) await w.create(`/f${i}.txt`, { content: "x" });
  for (let i = 0; i < 20; i++) await w.remove(`/f${i}.txt`);
  await w.emptyTrash();
  await w.dropOps(await w.lastSeq());
  w.close();
  w = await openAs(o);
  check(w.durability.state === "ok", "a mass delete, Trash emptied and the op log pruned: no false loss");
  w.close();
}

async function durabilityReset() {
  const H = W.RESET_HOOK;
  const kill = () => { throw new Error("killed (test)"); };
  const setup = async () => { const o = await named(); const w = await openAs(o); await w.create("/a.txt", { content: "a" }); await w.flushOpfs(); return { o, w }; };
  // a refused reset changes nothing: the first witness written, the second not; then its cleanup failing too
  {
    const { o, w } = await setup();
    const was = localW(o.name);
    H.afterFirstWitness = () => { throw new Error("OPFS refused (test)"); };
    check(await fails(w.reset("new"), "storage"), "prepare failing after the first witness: refused");
    H.afterFirstWitness = undefined;
    check(JSON.stringify(localW(o.name)) === JSON.stringify(was) && w.identity.generation === 1 && (await paths(w)).join() === "/a.txt", "…the first witness put back, nothing changed");
    H.afterFirstWitness = () => { throw new Error("OPFS refused (test)"); };
    H.failCleanup = true;
    check(await fails(w.reset("new"), "storage"), "…and with its cleanup failing too: refused");
    H.afterFirstWitness = undefined;
    H.failCleanup = false;
    check(!!localW(o.name).reset, "…the prepared witness left behind");
    check(!!(await w.create("/b.txt", { content: "b" })) && !!localW(o.name).reset, "…a normal save meanwhile doesn't write over a prepared witness");
    w.close();
    const v = await openAs(o);
    check(v.durability.state === "ok" && !localW(o.name).reset && v.identity.generation === 1 && (await paths(v)).join() === "/a.txt,/b.txt", "…the next open rolls it back: nothing changed");
    v.close();
  }
  // killed after prepare: rolled back
  {
    const { o, w } = await setup();
    H.afterPrepare = kill;
    check(!!(await fails(w.reset("new"), "storage").catch(() => true)), "(a kill after prepare)");
    H.afterPrepare = undefined;
    w.close();
    const v = await openAs(o);
    check(v.durability.state === "ok" && v.identity.generation === 1 && (await paths(v)).join() === "/a.txt" && !localW(o.name).reset && !(await opfsW(o.name)).reset, "killed after prepare: rolled back, both witnesses cleared");
    v.close();
  }
  // killed after the IndexedDB reset: finished
  {
    const { o, w } = await setup();
    H.afterIdb = kill;
    await w.reset("new").catch(() => {});
    H.afterIdb = undefined;
    w.close();
    const v = await openAs(o);
    check(v.durability.state === "ok" && v.identity.generation === 2 && (await paths(v)).length === 0 && localW(o.name).generation === 2 && !localW(o.name).reset, "killed after the IndexedDB reset: finished, the witnesses committed");
    v.close();
  }
  // killed after one witness's commit: finished
  {
    const { o, w } = await setup();
    H.afterFirstCommit = kill;
    await w.reset("new").catch(() => {});
    H.afterFirstCommit = undefined;
    w.close();
    const v = await openAs(o);
    const ow = await opfsW(o.name);
    check(v.durability.state === "ok" && v.identity.generation === 2 && ow.generation === 2 && !ow.reset, "killed after one witness's commit: finished, the other committed");
    v.close();
  }
  // the database gone under a prepared reset (a reset never deletes it, so this is a loss): confirmed, for any kind
  for (const kind of ["new", "import"]) {
    const { o, w } = await setup();
    H.afterPrepare = kill;
    await w.reset(kind).catch(() => {});
    H.afterPrepare = undefined;
    w.close();
    await dropDb(o.name);
    const v = await openAs(o);
    check(v.durability.state === "confirmed", `the database gone under a prepared reset (${kind}): a loss, confirmed: ` + JSON.stringify(v.durability));
    v.close();
  }
  // astra's probe: a refused reset (its cleanup failing too), then the database lost: confirmed, never the refused reset finished
  {
    const { o, w } = await setup();
    H.afterFirstWitness = () => { throw new Error("OPFS refused (test)"); };
    H.failCleanup = true;
    await w.reset("new").catch(() => {});
    H.afterFirstWitness = undefined;
    H.failCleanup = false;
    w.close();
    await dropDb(o.name);
    const v = await openAs(o);
    check(v.durability.state === "confirmed" && v.quarantined, "a refused reset, then the database lost: confirmed and quarantined, not the reset finished: " + JSON.stringify(v.durability));
    v.close();
  }
  // astra's probe: a stale tab's reset resets nothing (it would have erased the newer workspace's files)
  {
    const { o, w } = await setup();
    const stale = await openAs(o);
    stale.channel?.close();
    await w.reset("new");
    await w.create("/newer.txt", { content: "n" });
    check(await fails(stale.reset("new"), "storage") && (await paths(w)).join() === "/newer.txt", "a stale tab's reset: refused, the newer workspace's files kept");
    w.close();
    stale.close();
  }
  // astra's probe: witnesses noted down earlier this session don't let a reset skip its preparation
  {
    const { o, w } = await setup();
    w.witnessDown = { local: "earlier (test)", opfs: "earlier (test)" };
    let prepared = false;
    H.afterPrepare = () => { prepared = !!localW(o.name).reset; };
    await w.reset("new");
    H.afterPrepare = undefined;
    check(prepared, "witnesses noted down earlier: the reset still prepares both");
    w.close();
  }
  // a stale tab: by the broadcast, and by identity (workspace id, and generation alone)
  for (const kind of ["new", "keep"]) {
    const { o, w } = await setup();
    const other = await openAs(o);
    other.channel?.close();
    await w.reset(kind);
    check(await fails(other.create("/z.txt", { content: "z" }), "storage") && other.closed, `a tab opened before a reset (${kind}: ${kind === "new" ? "another workspace id" : "the same id, another generation"}): can't write, told to reload`);
    w.close();
    other.close();
  }
}

// astra's CORR-28F-1, and @sagebrush's cases for it: one reset at a time; a reset to a new workspace already
// admitted (here or in another tab) is joined, carried on to its own target, never another's; anything else
// meanwhile refused as busy
async function durabilityAdmission() {
  const H = W.RESET_HOOK;
  const two = async () => { const o = await named(), a = await openAs(o), b = await openAs(o); await a.create("/a.txt", { content: "A" }); for (const w of [a, b]) { w.channel?.close(); w.channel = null; } return { o, a, b }; };
  const primary = (w) => rawGet(w.ws, "meta", "identity");
  const same = (x, p) => x.workspace === p.workspace && x.generation === p.generation;
  // new and new at once (no broadcasts): one target, both told it
  {
    const { a, b } = await two();
    const r = await Promise.allSettled([a.reset("new"), b.reset("new")]);
    const p = await primary(a);
    check(p.generation === 2 && r.every((x) => x.status === "fulfilled" && same(x.value, p)), "two resets to a new workspace at once: the second joins the first, both told its identity: " + JSON.stringify({ r, p }));
    check(!!(await a.create("/a2.txt", { content: "a" })) && !!(await b.create("/b2.txt", { content: "b" })), "…both tabs write to it after");
    a.close(); b.close();
  }
  // new, and keep asked while it runs: keep refused, the new reset's target kept
  {
    const { a, b } = await two();
    let keep = null;
    H.afterPage = () => { keep ??= b.reset("keep").then((v) => v, (e) => ({ refused: String(e?.message ?? e) })); };
    const ra = await a.reset("new").finally(() => { H.afterPage = undefined; });
    const k = await keep, p = await primary(a);
    check(!!k?.refused && same(ra, p) && p.generation === 2 && p.workspace !== (await rawGet(b.ws, "meta", "identity")).workspace + "x", "keep asked while a new reset runs: refused, the new reset's target kept: " + JSON.stringify({ ra, k, p }));
    a.close(); b.close();
  }
  // keep and new at once: whichever is admitted second is refused (its tab's identity is stale), never written over
  {
    const { a, b } = await two();
    const r = await Promise.allSettled([b.reset("keep"), a.reset("new")]);
    const p = await primary(a);
    check(r.filter((x) => x.status === "fulfilled").length === 1 && r.every((x) => x.status === "rejected" || same(x.value, p)), "keep and new at once: one admitted, the other refused, the primary the admitted one's: " + JSON.stringify({ r, p }));
    a.close(); b.close();
  }
  // a tab that missed a reset's broadcast, resetting after it: refused, the reset kept
  {
    const { a, b } = await two();
    const ra = await a.reset("new");
    const err = await b.reset("new").then(() => null, (e) => String(e?.message ?? e));
    const p = await primary(a);
    check(!!err && same(ra, p), "a reset after another tab's, its broadcast missed: refused, the first reset's target kept: " + err);
    a.close(); b.close();
  }
  // a reset stopped part way, retried here and asked from a tab that missed everything: both join its target
  {
    const { a, b } = await two();
    let stopped = false;
    H.afterPage = () => { if (!stopped) { stopped = true; throw new Error("stopped (test)"); } };
    const first = await a.reset("new").then(() => null, (e) => String(e?.message ?? e));
    H.afterPage = undefined;
    const pending = await rawGet(a.ws, "meta", "resetting");
    const kept = await b.reset("keep").then(() => null, (e) => String(e?.message ?? e));
    const r = await Promise.allSettled([a.reset("new"), b.reset("new")]);
    const p = await primary(a);
    check(!!first && !!pending && !!kept && same(pending.to, p) && r.every((x) => x.status === "fulfilled" && same(x.value, p)), "a reset stopped part way: a keep refused; retried here and from a tab that missed it, both join its own target: " + JSON.stringify({ first, kept, pending, r, p }));
    check((await paths(a)).length === 0 && (await rawGet(a.ws, "meta", "resetting")) === undefined, "…and finish it");
    a.close(); b.close();
  }
  // a reset whose cleanup is done, and another reset, from a tab opened since, run to its end before the first
  // commits: the first publishes nothing, the witnesses and fence the second's
  {
    const { o, a, b } = await two();
    b.close();
    let c = null, rc = null;
    H.afterIdb = async () => { H.afterIdb = undefined; c = await openAs(o); c.channel?.close(); c.channel = null; rc = await c.reset("new"); };
    const ra = await a.reset("new").then((v) => v, (e) => ({ refused: String(e?.message ?? e) }));
    H.afterIdb = undefined;
    const p = await primary(a), lw = localW(o.name), fence = await rawGet(a.main, "notebooks", "__sagebrush-workspace__");
    check(!!ra.refused && same(rc, p) && p.generation === 3 && same(lw, p) && same(fence, p), "a reset overtaken before it committed: refused, the witness and fence the later reset's: " + JSON.stringify({ ra, rc, p, lw: { workspace: lw.workspace, generation: lw.generation }, fence }));
    a.close(); c?.close();
  }
}
// the ownership list (stores.js ownedByWorkspace), not whether a fence is there, decides what the workspace governs;
// a fence that can't be written blocks its database, across copies of the stores and until written
async function durabilityOwnership() {
  const O = W.ownedByWorkspace;
  check(O("sagebrush", "x") && O("sagebrush-history", "x") && O("sagebrush-board-history", "board:local:0123456789ab") && O("sagebrush-board-history", "board:local:0123456789ab:v2") && !O("sagebrush-board-history", "board:examples/sagebrush.json") && !O("sagebrush-board-history", "board:unsaved:abc") && !O("sagebrush-board-history", "board:local:0123456789abc"), "the ownership list: notebooks and their history, the workspace's own boards' history; not an example's, an unsaved one's");
  // quarantined: the workspace's board's history refused; an example's, not the workspace's, kept
  {
    const o = await named(); let a = await openAs(o); const e = await a.create("/b.board.json"); await a.flushOpfs(); a.close();
    const db = await W.openBoardHistoryDb();
    const mine = new W.IdbPatchStore(db, "board:local:" + e.ref), example = new W.IdbPatchStore(db, "board:examples/own-test.json");
    await mine.loadInitial(); await example.loadInitial();
    const wit = localW(o.name); W.writeLocal(W.placeOf(o.name), { ...wit, seq: wit.seq + 10 }); a = await openAs(o);
    mine.append({ time: "m-time", id: "m" }); example.append({ time: "x-time", id: "x" });
    await new Promise((r) => setTimeout(r, 50));
    const keys = (await rawKeys(db, "history")).filter((k) => k[1] !== "");
    check(a.quarantined && !keys.some((k) => k[0] === "board:local:" + e.ref) && keys.some((k) => k[0] === "board:examples/own-test.json"), "quarantined: the workspace's board's history refused, an example's kept: " + JSON.stringify(keys));
    await example.drop(); a.close(); db.close();
  }
  // a fence that couldn't be written: its database blocked (meta says so too), a write through another copy of the
  // stores refused; the next open writes it and lets writes through again
  {
    const S = await import("./stores.js");
    const o = await named(); let a = await openAs(o); const e = await a.create("/c.board.json"); await a.flushOpfs(); a.close();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v, ...args) { if (this.name === "history" && v?.nb === "__sagebrush-workspace__") throw Error("fence refused (test)"); return put.call(this, v, ...args); };
    try { a = await openAs(o); } finally { IDBObjectStore.prototype.put = put; }
    const db = await S.openBoardHistoryDb(), key = "board:local:" + e.ref, h = new S.IdbPatchStore(db, key);
    await h.loadInitial(); h.append({ time: "b-time", id: "b" }); await new Promise((r) => setTimeout(r, 50));
    const meta = await rawGet(a.ws, "meta", "fenceBlocked");
    check(a.fenceBlocked.includes("sagebrush-board-history") && !!meta?.includes("sagebrush-board-history") && !(await rawKeys(db, "history")).some((k) => k[0] === key), "a fence that couldn't be written: its database blocked, in meta too; a write through another copy of the stores refused: " + JSON.stringify({ blocked: a.fenceBlocked, meta }));
    a.close(); a = await openAs(o);
    const h2 = new S.IdbPatchStore(db, key); await h2.loadInitial(); h2.append({ time: "b2-time", id: "b2" }); await new Promise((r) => setTimeout(r, 50));
    check(!a.fenceBlocked.length && (await rawGet(a.ws, "meta", "fenceBlocked")) === undefined && (await rawKeys(db, "history")).some((k) => k[0] === key), "…the next open writes it: unblocked, writes let through");
    await h2.drop(); a.close(); db.close();
  }
  // localStorage that can't be had, or listed, while a reset purges it: unknown, never empty; the marker kept,
  // migrate refused meanwhile; the next open, with it back, finishes the purge
  for (const how of ["had", "listed"]) {
    const H = W.RESET_HOOK, o = await named(); let a = await openAs(o);
    const key = "sagebrush-board:local:0000000000a" + (how === "had" ? "1" : "2");
    localStorage.setItem(key, JSON.stringify({ title: "Old board " + how, nodes: [] })); await W.migrate(a, localStorage);
    const own = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), len = Object.getOwnPropertyDescriptor(Storage.prototype, "length");
    const deny = () => { if (how === "had") Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("denied (test)"); } }); else Object.defineProperty(Storage.prototype, "length", { configurable: true, get() { throw new Error("denied (test)"); } }); };
    const allow = () => { if (how === "had") Object.defineProperty(globalThis, "localStorage", own); else Object.defineProperty(Storage.prototype, "length", len); };
    H.beforePurge = deny; H.afterIdb = allow;
    let error = null; try { await a.reset("new"); } catch (e) { error = String(e?.message ?? e); } finally { allow(); H.beforePurge = undefined; H.afterIdb = undefined; }
    const marker = await rawGet(a.ws, "meta", "purgeLocal"), unknown = a.localUnknown;
    const during = await W.migrate(a, localStorage);
    check(error === null && marker === true && unknown && (await paths(a)).length === 0 && localStorage.getItem(key) !== null, `localStorage that can't be ${how} during the purge: the reset done, its purge kept pending, migrate brings nothing in: ` + JSON.stringify({ error, marker, unknown, during }));
    a.close(); a = await openAs(o); await a.settled(); await W.migrate(a, localStorage);
    check((await paths(a)).length === 0 && localStorage.getItem(key) === null && (await rawGet(a.ws, "meta", "purgeLocal")) === undefined && !a.localUnknown, "…the next open, with it back, finishes it: " + JSON.stringify(await paths(a)));
    a.close(); localStorage.removeItem(key);
  }
}

// astra's probes on 28f6511b, verbatim (only the name)
async function durabilityAstraProbes28f(){
 const out=(ok,name,v)=>check(ok,name+': '+JSON.stringify(v));W.setSaveGate(null);
 // Failed fence is deleted: a NEW editor now binds null and is allowed to write.
 {
  const o=await named(),a=await openAs(o),e=await a.create('/n.ipynb');await a.flushOpfs();a.channel?.close();a.channel=null;
  const witness=localW(o.name);W.writeLocal(W.placeOf(o.name),{...witness,seq:witness.seq+10});
  const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v,...args){if(this.name==='notebooks'&&v?.id==='__sagebrush-workspace__')throw Error('fence refused');return put.call(this,v,...args)};
  let b;try{b=await openAs(o);const st=new W.IdbStore(b.main,e.ref),doc=await st.load();const save=await st.save({...doc,baseRev:doc.rev,name:'NEW EDITOR THROUGH LOST FENCE'});out(!save?.saved,'new-editor-after-fence-deletion',{quarantined:b.quarantined,seen:st.fence,save})}finally{IDBObjectStore.prototype.put=put;a.close();b?.close()}
 }
 // Enumeration is unreadable only during reset; old local board returns afterwards.
 {
  const o=await named();let a=await openAs(o);const key='sagebrush-board:local:123456789abc';localStorage.setItem(key,JSON.stringify({title:'Enum old board',nodes:[]}));await W.migrate(a,localStorage);
  const oldKey=Storage.prototype.key;Storage.prototype.key=function(){throw Error('enumeration denied')};let error=null;
  try{await a.reset('new')}catch(e){error=e.message}finally{Storage.prototype.key=oldKey}
  const pending=await rawGet(a.ws,'meta','purgeMain');a.close();a=await openAs(o);await W.migrate(a,localStorage);const ps=await paths(a);out(ps.length===0,'local-enumeration-failure',{error,pending,paths:ps});a.close();localStorage.removeItem(key);
 }
 // Two admitted resets can overwrite the same resetting metadata between cleanup pages.
 {
  const o=await named(),a=await openAs(o),b=await openAs(o);await a.create('/a.txt',{content:'A'});
  a.channel?.close();a.channel=null;b.channel?.close();b.channel=null;
  const resets=await Promise.allSettled([a.reset('new'),b.reset('new')]);const primary=await rawGet(a.ws,'meta','identity');
  let aError=null,bError=null;try{await a.create('/a-after.txt',{content:'A'})}catch(e){aError=e.message}try{await b.create('/b-after.txt',{content:'B'})}catch(e){bError=e.message}
  const fulfilled=resets.filter(x=>x.status==='fulfilled').map(x=>x.value), coherent=fulfilled.every(x=>x.workspace===primary.workspace&&x.generation===primary.generation);
  out(coherent,'concurrent-resets',{resets:resets.map(x=>x.status==='fulfilled'?x.value:{error:String(x.reason)}),primary,aError,bError});a.close();b.close();
 }
 // Local board history is the same IdbPatchStore in a DB that never receives a workspace fence.
 {
  const S=await import('./stores.js');const o=await named();let a=await openAs(o);const e=await a.create('/board.board.json');await a.flushOpfs();a.close();
  const db=await S.openBoardHistoryDb(),h=new S.IdbPatchStore(db,'local:'+e.ref);await h.loadInitial();const witness=localW(o.name);W.writeLocal(W.placeOf(o.name),{...witness,seq:witness.seq+10});a=await openAs(o);
  h.append({time:'q-time',id:'q-change'});await new Promise(r=>setTimeout(r,50));const keys=await rawKeys(db,'history');const written=keys.filter(k=>k[0]==='local:'+e.ref);
  out(written.length===0,'local-board-history',{quarantined:a.quarantined,seen:h.fence,keys:written});a.close();db.close();
 }
}

// astra's probes on 56c60932, verbatim
async function deniedBundle(){
 const S=await import('./stores.js'),o=await named(),a=await openAs(o),e=await a.create('/n.ipynb');await a.flushOpfs();a.channel?.close();a.channel=null;
 const witness=localW(o.name);await W.writeOpfs(W.placeOf(o.name),{...witness,seq:witness.seq+10});
 const get=Storage.prototype.getItem,set=Storage.prototype.setItem,put=IDBObjectStore.prototype.put;
 Storage.prototype.getItem=function(){throw Error('denied')};Storage.prototype.setItem=function(){throw Error('denied')};
 IDBObjectStore.prototype.put=function(v,...args){if(this.name==='notebooks'&&v?.id==='__sagebrush-workspace__')throw Error('fence refused');return put.call(this,v,...args)};
 let b;try{b=await openAs(o);const st=new S.IdbStore(b.main,e.ref),doc=await st.load(),save=await st.save({...doc,baseRev:doc.rev,name:'EDIT THROUGH BLOCKED FENCE'});
 check(!save?.saved,'denied-separate-bundle: '+JSON.stringify({quarantined:b.quarantined,blocked:b.fenceBlocked,meta:await rawGet(b.ws,'meta','fenceBlocked'),seen:st.fence,save}));}
 finally{Storage.prototype.getItem=get;Storage.prototype.setItem=set;IDBObjectStore.prototype.put=put;a.close();b?.close()}
}
async function primaryRollback(){
 const S=await import('./stores.js'),o=await named();let a=await openAs(o);const e=await a.create('/n.ipynb'),old={...a.identity},oldStep=await rawGet(a.ws,'meta','fenceStep');await a.reset('keep');await a.flushOpfs();
 const fence=await rawGet(a.main,'notebooks','__sagebrush-workspace__');await rawPut(a.ws,'meta',old,'identity');await rawPut(a.ws,'meta',oldStep,'fenceStep');a.close();a=await openAs(o);
 const st=new S.IdbStore(a.main,e.ref),doc=await st.load(),save=await st.save({...doc,baseRev:doc.rev,name:'EDIT THROUGH FUTURE FENCE'});
 check(!save?.saved,'primary-generation-rollback: '+JSON.stringify({quarantined:a.quarantined,identity:a.identity,oldFence:fence,seen:st.fence,blocked:a.fenceBlocked,save}));a.close();
}
async function currentPending(){
 const o=await named(),a=await openAs(o),key=Storage.prototype.key;Storage.prototype.key=function(){throw Error('enumeration denied')};
 try{await a.reset('new')}finally{Storage.prototype.key=key}
 const marker=await rawGet(a.ws,'meta','purgeLocal'),e=await a.create('/new.board.json');
 const {WS_SAVE}=await import('./wssave.js');let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r),orig=a.write;
 a.write=async function(...args){enter();await held;throw Error('simulated shutdown before IndexedDB commit')};
 const save=new Function('ws','id','d',`let wsRefused=null,wsBlocked=null,wsSeq=0,wsRev=1,wsEpoch=0,wsCopy=null,wsWriting=Promise.resolve();const wsLatest=new Map(),PENDING_MAX=8*2**20,PENDING='sagebrush-workspace-pending:',SESSION='aaaaaaaaaaaaaaaa';const logSave=()=>{};const dropPending=()=>{};const journalOn=false,jstore=null;let wsBridge=null;${WS_SAVE};wsSave(id,d);return wsWriting;`);
 const saving=save(a,e.ref,{title:'NEW UNSAVED EDIT',nodes:[]});await entered;
 const pendingKey='sagebrush-workspace-pending:'+e.ref,before=localStorage.getItem(pendingKey);await a.cleanUp(true);const after=localStorage.getItem(pendingKey);
 release();await saving;a.write=orig;
 check(!!after,'current-generation-pending: '+JSON.stringify({marker,state:a.durability,ref:e.ref,before,after,stored:(await a.read(e.path)).content.title}));a.close();
}

async function deniedMeta(){
 const S=await import('./stores.js'),o=await named(),a=await openAs(o),e=await a.create('/n.ipynb');await a.flushOpfs();a.channel?.close();a.channel=null;
 const st=new S.IdbStore(a.main,e.ref),doc=await st.load();const witness=localW(o.name);await W.writeOpfs(W.placeOf(o.name),{...witness,seq:witness.seq+10});
 const get=Storage.prototype.getItem,set=Storage.prototype.setItem,put=IDBObjectStore.prototype.put;
 Storage.prototype.getItem=function(){throw Error('denied')};Storage.prototype.setItem=function(){throw Error('denied')};
 IDBObjectStore.prototype.put=function(v,...args){if(this.name==='notebooks'&&v?.id==='__sagebrush-workspace__')throw Error('fence refused');if(this.name==='meta'&&args[0]==='fenceBlocked')throw Error('meta refused');return put.call(this,v,...args)};
 let err=null;try{await openAs(o)}catch(e){err=e.message}
 try{const q=await rawGet(a.ws,'meta','quarantine'),save=await st.save({...doc,baseRev:doc.rev,name:'EDIT AFTER FAILED OPEN'});
 check(!save?.saved,'denied-separate-bundle-and-meta: '+JSON.stringify({openError:err,quarantine:q?.state,blockedMeta:await rawGet(a.ws,'meta','fenceBlocked'),seen:st.fence,save}));}
 finally{Storage.prototype.getItem=get;Storage.prototype.setItem=set;IDBObjectStore.prototype.put=put;a.close()}
}

// after a rollback of the workspace's database behind the editors' fences: "keep" goes past the latest fence, and
// the editors write again (CORR-56C-1); a board history the workspace doesn't own is written whatever the storage
// denies; and what confirming each write with the workspace's meta costs a save (for daybreak2)
async function durabilityAuthority() {
  {
    const o = await named(); let a = await openAs(o); const e = await a.create("/n.ipynb"), old = { ...a.identity }, oldStep = await rawGet(a.ws, "meta", "fenceStep");
    await a.reset("keep"); await a.flushOpfs();
    await rawPut(a.ws, "meta", old, "identity"); await rawPut(a.ws, "meta", oldStep, "fenceStep"); a.close(); a = await openAs(o);
    const blocked = [...a.fenceBlocked];
    const k = await a.reset("keep");
    const st = new W.IdbStore(a.main, e.ref), doc = await st.load(), save = await st.save({ ...doc, baseRev: doc.rev, name: "AFTER KEEP" });
    check(blocked.includes(a.main.name) && k.generation === 3 && !a.fenceBlocked.length && !!save?.saved, "a fence of a later generation found: blocked, not taken for written; keep goes past it, and the notebook saves again: " + JSON.stringify({ blocked, k, save }));
    a.close();
  }
  {
    const o = await named(); let a = await openAs(o); await a.create("/b.board.json"); await a.flushOpfs(); a.close();
    const wit = localW(o.name); W.writeLocal(W.placeOf(o.name), { ...wit, seq: wit.seq + 10 }); a = await openAs(o);
    const db = await W.openBoardHistoryDb(), ex = new W.IdbPatchStore(db, "board:examples/authority.json");
    await ex.loadInitial();
    const get = Storage.prototype.getItem; Storage.prototype.getItem = function () { throw Error("denied"); };
    try { ex.append({ time: "e-time", id: "e" }); await new Promise((r) => setTimeout(r, 50)); } finally { Storage.prototype.getItem = get; }
    check(a.quarantined && (await rawKeys(db, "history")).some((k) => k[0] === "board:examples/authority.json"), "quarantined, storage denied: a board history the workspace doesn't own still written");
    await ex.drop(); a.close(); db.close();
  }
  // each rule of the confirming, alone, through another copy of the stores with nothing wired: the workspace's
  // meta unreadable, naming another identity, a reset under way, or its database gone: refused; a history append too
  {
    const S = await import("./stores.js");
    const fresh = async () => { const o = await named(), a = await openAs(o), e = await a.create("/r.ipynb"); a.channel?.close(); a.channel = null; const st = new S.IdbStore(a.main, e.ref), doc = await st.load(); return { o, a, e, st, doc }; };
    const tryIt = (st, doc, name) => st.save({ ...doc, baseRev: doc.rev, name });
    {
      const { o, a, st, doc } = await fresh();
      const tx = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (names, ...rest) { if (this.name === o.name && names === "meta") throw new Error("denied (test)"); return tx.call(this, names, ...rest); };
      let save; try { save = await tryIt(st, doc, "UNREADABLE"); } finally { IDBDatabase.prototype.transaction = tx; }
      const after = await tryIt(st, doc, "READABLE");
      check(!save?.saved && !!after?.saved, "the workspace's meta unreadable: refused; readable again: saved: " + JSON.stringify({ save, after }));
      a.close();
    }
    {
      const { a, e, st, doc } = await fresh();
      const id = await rawGet(a.ws, "meta", "identity");
      await rawPut(a.ws, "meta", { ...id, workspace: "b".repeat(16) }, "identity");
      const save = await tryIt(st, doc, "OTHER IDENTITY");
      const hdb = await S.openHistoryDb(), h = new S.IdbPatchStore(hdb, "auth-" + e.ref); await h.loadInitial(); h.append({ time: "h-time", id: "h" }); await new Promise((r) => setTimeout(r, 80));
      const rows = (await rawKeys(hdb, "history")).filter((k) => k[0] === "auth-" + e.ref);
      check(!save?.saved && rows.length === 0, "the workspace's meta naming another identity than the fence: a save and a history append refused: " + JSON.stringify({ save, rows }));
      await rawPut(a.ws, "meta", id, "identity"); hdb.close(); a.close();
    }
    {
      const { a, st, doc } = await fresh();
      const id = await rawGet(a.ws, "meta", "identity");
      await rawPut(a.ws, "meta", { to: { workspace: "c".repeat(16), generation: id.generation + 1 }, seq: 0 }, "resetting");
      const save = await tryIt(st, doc, "DURING RESET");
      check(!save?.saved, "a reset under way in the workspace's meta, its fence not yet saying so: refused: " + JSON.stringify(save));
      a.close();
    }
    {
      // (the store on a connection of its own, so the workspace's closing doesn't close it: the save itself refused)
      const { o, a, e } = await fresh();
      const main = await S.openDb(o.mainName), st = new S.IdbStore(main, e.ref), doc = await st.load();
      a.close(); await dropDb(o.name);
      const save = await tryIt(st, doc, "NO WORKSPACE");
      check(typeof save === "string" && save.includes("record of the workspace is missing"), "the workspace's database gone, the fence still naming it: refused, saying so: " + JSON.stringify(save));
      main.close();
    }
  }
  // a tab left behind by a reset elsewhere (its broadcast missed) writes no fence, and so blocks nothing
  {
    const o = await named(), a = await openAs(o), b = await openAs(o), e = await a.create("/s.ipynb");
    for (const w of [a, b]) { w.channel?.close(); w.channel = null; }
    await a.reset("keep");
    await b.writeFence();
    const S = await import("./stores.js"), st = new S.IdbStore(a.main, e.ref), doc = await st.load(), save = await st.save({ ...doc, baseRev: doc.rev, name: "AFTER STALE" });
    check(!!save?.saved && (await rawGet(a.ws, "meta", "fenceBlocked")) === undefined && (await rawGet(a.main, "notebooks", "__sagebrush-workspace__")).generation === 2, "a stale tab's fence: not written, nothing blocked: " + JSON.stringify(save));
    a.close(); b.close();
  }
  {
    const o = await named(), a = await openAs(o), e = await a.create("/t.ipynb");
    const S = await import("./stores.js"), st = new S.IdbStore(a.main, e.ref), doc = await st.load();
    const plain = await S.openDb("authority-plain"), sp = new S.IdbStore(plain, "p"), dp = await sp.load();
    const time = async (s, d) => { const t = []; for (let i = 0; i < 100; i++) { const t0 = performance.now(); const r = await s.save({ ...d, baseRev: d.rev, name: "n" + i }); t.push(performance.now() - t0); d = { ...d, rev: r.rev }; } t.sort((x, y) => x - y); return { median: +t[50].toFixed(2), p95: +t[95].toFixed(2) }; };
    const owned = await time(st, doc), unowned = await time(sp, dp);
    check(owned.median < 20, `a save confirmed with the workspace's meta: ${JSON.stringify(owned)} ms, without: ${JSON.stringify(unowned)} ms (100 saves each)`);
    a.close(); plain.close(); await dropDb("authority-plain");
  }
}

// astra's probes on 51106cb6, verbatim (historyOrder, purgeMarks; metaFenceRace adapted below)
async function historyOrder(mode){
 const S=await import('./stores.js'),o=await named(),a=await openAs(o),e=await a.create('/n.ipynb'),db=await S.openHistoryDb(),h=new S.IdbPatchStore(db,e.ref);await h.loadInitial();
 h.append({time:'one',id:'one'});h.append({time:'two',id:'two'});await h[mode]();await h.appending;
 const rows=(await rawKeys(db,'history')).filter(k=>k[0]===e.ref);check(rows.length===0,'history-order-'+mode+': '+JSON.stringify({rows}));a.close();db.close();
}
async function purgeMarks(){
 const o=await named(),a=await openAs(o),key=Storage.prototype.key;Storage.prototype.key=function(){throw Error('enumeration denied')};try{await a.reset('new')}finally{Storage.prototype.key=key}
 const e=await a.create('/new.board.json'),prefixes=['sagebrush-board:local:'+e.ref,'sagebrush-board:local:'+e.ref+'#here','sagebrush-board:local:'+e.ref+'#outputs','sagebrush-workspace-pending:'+e.ref,'sagebrush-workspace-pending-unread:'+e.ref];
 for(const k of prefixes)localStorage.setItem(k,'current');localStorage.setItem('sagebrush-board:local:111111111111','old');await a.cleanUp(true);
 check(prefixes.every(k=>localStorage.getItem(k)==='current')&&!localStorage.getItem('sagebrush-board:local:111111111111'),'purge-current-marks-preserved');a.close();
}

// astra's metaFenceRace (51106cb6) under the lock: the same barrier (the write's meta read held) and the same
// failing fence puts, for all four verbs, the puts failing and not; one change of schedule: B's open now waits
// on the lock the write holds, so the barrier is let go once B is waiting, not after B is done (as written, the
// probe would wait on itself).  B decides the quarantine only after the write's transaction has ended, and the
// same verb after B is refused
async function durabilityLockOrder() {
  const S = await import("./stores.js"); S.setSaveGate(null);
  for (const fails of [true, false]) for (const mode of ["save", "append", "clear", "drop"]) {
    const o = await named(), a = await openAs(o), e = await a.create("/n.ipynb"); await a.flushOpfs(); a.channel?.close(); a.channel = null;
    const st = new S.IdbStore(a.main, e.ref), doc = await st.load(), db = await S.openHistoryDb(), h = new S.IdbPatchStore(db, e.ref);
    await h.loadInitial(); h.append({ time: "seed", id: "seed" }); await h.appending;
    const witness = localW(o.name); W.writeLocal(W.placeOf(o.name), { ...witness, seq: witness.seq + 10 });
    let enter, release; const entered = new Promise((r) => (enter = r)), held = new Promise((r) => (release = r));
    // (the barrier on the meta read inside the lock: for clear and drop the second, after their precheck)
    const origTx = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put, desc = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete"); let armed = true, reads = 0;
    const nth = mode === "clear" || mode === "drop" ? 2 : 1;
    IDBDatabase.prototype.transaction = function (stores, ...args) { const tx = origTx.call(this, stores, ...args); if (armed && this.name === o.name && stores === "meta" && args[0] === "readonly" && ++reads === nth) { armed = false; Object.defineProperty(tx, "oncomplete", { set(f) { desc.set.call(tx, function (ev) { enter(); held.then(() => f.call(tx, ev)); }); }, configurable: true }); } return tx; };
    const verb = (name) => (mode === "save" ? st.save({ ...doc, baseRev: doc.rev, name }) : mode === "append" ? (h.append({ time: name, id: name }), h.appending) : mode === "clear" ? h.clear() : h.drop());
    const order = [];
    let b = null, waited = false, first, second, rows, stored;
    try {
      const firstP = verb("first").then((v) => { order.push("write"); return v; }, (err) => { order.push("write"); return { error: String(err?.message ?? err) }; });
      // (bounded: a write that never reads meta there is held by nothing, and fails below)
      await Promise.race([entered, new Promise((r) => setTimeout(r, 3000))]); IDBDatabase.prototype.transaction = origTx;
      if (fails) IDBObjectStore.prototype.put = function (v, ...args) { if (v?.id === "__sagebrush-workspace__" || v?.nb === "__sagebrush-workspace__") throw Error("fence refused"); return put.call(this, v, ...args); };
      const bOpen = openAs(o).then((x) => { order.push("open"); b = x; });
      for (let i = 0; i < 200 && !waited; i++) { waited = (await navigator.locks.query()).pending.some((l) => l.name === "sagebrush-workspace" && l.mode === "exclusive"); if (!waited) await new Promise((r) => setTimeout(r, 10)); }
      release();
      first = await firstP; await bOpen; IDBObjectStore.prototype.put = put;
      // (after B: the same verb, refused)
      if (mode === "save") { const rec = await rawGet(a.main, "notebooks", e.ref); second = await st.save({ ...rec, baseRev: rec.rev, name: "AFTER QUARANTINE" }); stored = (await rawGet(a.main, "notebooks", e.ref)).name; }
      else if (mode === "append") { h.append({ time: "after", id: "after" }); await h.appending; }
      else { await rawPut(db, "history", { nb: e.ref, time: "raw", env: {} }); second = await (mode === "clear" ? h.clear() : h.drop()).then(() => "done", (err) => String(err?.message ?? err)); }
      rows = (await rawKeys(db, "history")).filter((k) => k[0] === e.ref).map((k) => k[1]);
      const after = mode === "save" ? typeof second === "string" && stored !== "AFTER QUARANTINE" : mode === "append" ? !rows.includes("after") : second !== "done" && rows.includes("raw");
      check(waited && order[0] === "write" && b?.quarantined && after, `the lock orders ${mode} against a quarantine, its fence puts ${fails ? "failing" : "written"}: B waited for the write, and ${mode} after B refused: ` + JSON.stringify({ waited, order, quarantined: b?.quarantined, blocked: b?.fenceBlocked, first, second, rows, stored }));
    } finally { release(); IDBDatabase.prototype.transaction = origTx; IDBObjectStore.prototype.put = put; a.close(); b?.close(); db.close(); }
  }
  // the lock held for good by another tab: a save and a clear give up after LOCK_WAIT, said, their requests
  // withdrawn (the lock let go later, nothing is written by them), the editor's change kept for a later save
  // that succeeds; appends wait in their queue, at most HISTORY_BACKLOG of them, one past it refused and said
  // (an editor never frozen, memory bounded, by a stuck tab)
  {
    const S = await import("./stores.js"), o = await named(), a = await openAs(o), e = await a.create("/held.ipynb");
    const st = new S.IdbStore(a.main, e.ref), doc = await st.load(), db = await S.openHistoryDb(), h = new S.IdbPatchStore(db, e.ref);
    await h.loadInitial(); h.append({ time: "seed", id: "seed" }); await h.appending;
    S.LOCK_WAIT.ms = 300; S.HISTORY_BACKLOG.entries = 3;
    const said = [], off = S.onHistoryRefused((m) => said.push(m));
    let release; await new Promise((r) => navigator.locks.request("sagebrush-workspace", () => new Promise((g) => { release = g; r(); })));
    try {
      const t0 = performance.now(), save = await Promise.race([st.save({ ...doc, baseRev: doc.rev, name: "HELD" }).then((v) => ({ v }), (err) => ({ err: String(err?.message ?? err) })), new Promise((r) => setTimeout(() => r({ hung: true }), 5000))]), waited = performance.now() - t0;
      const clear = await h.clear().then(() => "done", (err) => String(err?.message ?? err));
      // (q1 changed after it was asked for: kept as it was asked, charged as such: daybreak2's LIMIT-9D7-2)
      const e1 = { time: "q1", id: "q1" };
      const taken = [h.append(e1), ...[2, 3, 4, 5].map((i) => h.append({ time: "q" + i, id: "q" + i }))];
      e1.id = "CHANGED AFTER ASKED"; e1.pad = "x".repeat(10_000);
      const queued = S.historyBacklog().entries, charged = S.historyBacklog().bytes, each = 2 * JSON.stringify({ time: "q1", id: "q1" }).length + S.ENTRY_OVERHEAD;
      // (a clear and a drop asked for behind those appends, which wait for the lock: refused within LOCK_WAIT
      // all the same, and never deleting later: daybreak2's LIMIT-9D7-1, astra's CORR-9D7-2)
      const t1 = performance.now();
      const [clear2, drop2] = await Promise.all([h.clear(), h.drop()].map((p) => Promise.race([p.then(() => "done", (err) => String(err?.message ?? err)), new Promise((r) => setTimeout(() => r("still waiting"), 3000))])));
      const late = performance.now() - t1;
      await new Promise((r) => setTimeout(r, 200));
      const before = (await rawKeys(db, "history")).filter((k) => k[0] === e.ref).map((k) => k[1]);
      release(); release = null;
      await h.appending; await new Promise((r) => setTimeout(r, 300));
      const after = (await rawKeys(db, "history")).filter((k) => k[0] === e.ref).map((k) => k[1]), stored = (await rawGet(a.main, "notebooks", e.ref)).name;
      check(/busy/.test(save.err ?? "") && waited < 3000 && /busy/.test(clear), "the lock held for good elsewhere: a save (rejected) and a clear give up, saying the files are busy: " + JSON.stringify({ save, waited: Math.round(waited), clear }));
      check(stored !== "HELD" && after.includes("seed"), "…their requests withdrawn: the lock let go later, nothing written by them (the notebook as it was, the history not cleared): " + JSON.stringify({ stored, after }));
      check(taken.join() === "true,true,true,false,false" && queued === 3 && said.length === 2 && /TimeTravel/.test(said[0]) && before.join() === "seed", "…appends: three wait (the bound set to 3), the next two refused and said: " + JSON.stringify({ taken, queued, said: said.length, before }));
      check(["q1", "q2", "q3"].every((k) => after.includes(k)) && !after.includes("q4") && S.historyBacklog().entries === 0 && S.historyBacklog().bytes === 0, "…the three kept once it is let go, the backlog empty again: " + JSON.stringify({ after, backlog: S.historyBacklog() }));
      check(/busy/.test(clear2) && /busy/.test(drop2) && late < 2000, "a clear and a drop behind waiting appends, the lock held: refused within the bound all the same: " + JSON.stringify({ clear2, drop2, late: Math.round(late) }));
      check(["q1", "q2", "q3"].every((k) => after.includes(k)), "…and, the lock let go, they delete nothing afterwards: " + JSON.stringify(after));
      const q1 = (await rawGet(db, "history", [e.ref, "q1"]))?.env;
      check(q1?.id === "q1" && !("pad" in q1) && charged === 3 * each, "an append is kept as it was asked for, changed after or not, and charged twice its JSON and ENTRY_OVERHEAD: " + JSON.stringify({ q1, charged, each }));
      const rec = await rawGet(a.main, "notebooks", e.ref), later = await st.save({ ...rec, baseRev: rec.rev, name: "HELD" });
      check(!!later?.saved && (await rawGet(a.main, "notebooks", e.ref)).name === "HELD", "…and the same change, saved again once the lock is free: kept: " + JSON.stringify(later));
    } finally { release?.(); off(); S.LOCK_WAIT.ms = 10_000; S.HISTORY_BACKLOG.entries = 1000; a.close(); db.close(); }
  }
  // an append held while it waits as its JSON text alone (daybreak2's LIMIT-5B7-1): data that isn't plain JSON
  // (a buffer, a typed array, a Map, a Set, a Date) refused, however small its JSON; a graph whose JSON is small
  // for its heap (100,000 empty objects) charged as its text, which is all that is held; kept as it was asked for
  {
    const S = await import("./stores.js"), o = await named(), a = await openAs(o), e = await a.create("/plain.ipynb");
    const db = await S.openHistoryDb(), h = new S.IdbPatchStore(db, e.ref);
    await h.loadInitial();
    let release; await new Promise((r) => navigator.locks.request("sagebrush-workspace", () => new Promise((g) => { release = g; r(); })));
    try {
      const refused = [["a buffer", new ArrayBuffer(1 << 20)], ["a typed array", new Uint8Array(1 << 20)], ["a Map", new Map([[1, 2]])], ["a Set", new Set([1])], ["a Date", new Date()], ["undefined in an array", [undefined]]]
        .map(([what, v]) => [what, h.append({ time: "x-" + what, id: "x", data: v })]);
      // (cycles, an object's and an array's, and a DAG whose 40 levels each name the next twice, 2^40 paths in its
      // text: refused at once, nothing written or queued; a child shared, acyclic, taken and kept exactly:
      // daybreak2's LIMIT-7865-1, astra's CORR-786-1)
      const cyc = {}; cyc.self = cyc;
      const acyc = []; acyc.push(acyc);
      let dag = {}; for (let i = 0; i < 40; i++) dag = { l: dag, r: dag };
      const t0 = performance.now(), tookCycle = h.append({ time: "cyc", id: "cyc", data: cyc }), tookArray = h.append({ time: "acyc", id: "acyc", data: acyc }), tookDag = h.append({ time: "dag", id: "dag", data: dag }), ms = performance.now() - t0, q0 = S.historyBacklog().entries;
      check(tookCycle === false && tookArray === false && tookDag === false && ms < 500 && q0 === 0, "an append with a cycle (an object's, an array's), or a DAG of 2^40 paths: refused at once, nothing queued: " + JSON.stringify({ tookCycle, tookArray, tookDag, ms: Math.round(ms), q0 }));
      const child = { text: "shared", n: [1, 2] }, sharing = { time: "shared", id: "shared", a: child, b: child, list: [child, child] }, expect = JSON.stringify(sharing);
      const b0s = S.historyBacklog().bytes, tookShared = h.append(sharing), chargedShared = S.historyBacklog().bytes - b0s;
      child.text = "CHANGED";
      const wide = { time: "wide", id: "wide", file: undefined, wide: Array.from({ length: 100_000 }, () => ({})) };
      const b0 = S.historyBacklog().bytes, took = h.append(wide), charged = S.historyBacklog().bytes - b0, text = JSON.stringify(wide).length;
      wide.wide.length = 0; wide.id = "CHANGED";
      release(); release = null;
      await h.appending;
      const kept = (await rawGet(db, "history", [e.ref, "wide"]))?.env;
      const keptShared = (await rawGet(db, "history", [e.ref, "shared"]))?.env;
      check(tookShared && chargedShared === 2 * expect.length + S.ENTRY_OVERHEAD && JSON.stringify(keptShared) === expect, "a child shared twice, acyclic: taken, charged as its text, and kept exactly as asked: " + JSON.stringify({ tookShared, chargedShared, kept: keptShared }));
      check(refused.every(([, t]) => t === false) && S.historyBacklog().entries === 0, "an append of data that isn't plain JSON (a buffer, a typed array, a Map, a Set, a Date, undefined in an array): refused, not queued: " + JSON.stringify(refused));
      check(took && charged === 2 * text + S.ENTRY_OVERHEAD && kept?.id === "wide" && kept.wide.length === 100_000, "a wide graph of empty objects (and a property undefined, as patchflow's envelopes have): charged twice its text and ENTRY_OVERHEAD, the text being all that is held, and kept as it was asked: " + JSON.stringify({ took, charged, text, kept: kept && { id: kept.id, n: kept.wide.length } }));
    } finally { release?.(); a.close(); db.close(); }
  }
  // hooks never run (astra's CORR-C05-2): an own toJSON (not enumerable), one inherited through a plain-looking
  // object's prototype, a getter, a getter changing between reads, a toJSON put on Object.prototype: each refused,
  // no hook run; and the 8 MiB bound exact and unconditional (daybreak2's LIMIT-C05-1, astra's CORR-C05-1): an
  // entry alone just within it taken, just past it refused, said as too large for TimeTravel, its document saved
  {
    const S = await import("./stores.js"), o = await named(), a = await openAs(o), e = await a.create("/hooks.ipynb");
    const db = await S.openHistoryDb(), h = new S.IdbPatchStore(db, e.ref);
    await h.loadInitial();
    const said = [], off = S.onHistoryRefused((m) => said.push(m));
    let ran = 0;
    const own = { time: "own", id: "own" }; Object.defineProperty(own, "toJSON", { value: () => { ran++; return { time: "own", id: "HOOK" }; }, enumerable: false });
    const inherited = Object.create(Object.create(null, { toJSON: { value: () => { ran++; return {}; } } })); inherited.time = "inh"; inherited.id = "inh";
    const getter = { time: "get", id: "get" }; Object.defineProperty(getter, "x", { get: () => { ran++; return 1; }, enumerable: true });
    let reads = 0; const changing = { time: "chg", id: "chg" }; Object.defineProperty(changing, "x", { get: () => (++reads, ran++, reads > 1 ? "y".repeat(1e6) : "small"), enumerable: true });
    // (a Proxy can't be told from its object, and its descriptor traps run when it is read; but what is written is
    // the copy made from those descriptors, so its get trap never runs, and what is kept is what was measured)
    let gets = 0;
    const proxied = new Proxy({ time: "prx", id: "prx" }, { get: (t, k) => (k === "id" ? (gets++, "FROM GET TRAP") : t[k]) });
    const tookProxy = h.append(proxied);
    const took = [own, inherited, getter, changing].map((env) => h.append(env));
    Object.prototype.toJSON = function () { ran++; return this; };
    let polluted;
    try { polluted = h.append({ time: "pol", id: "pol" }); } finally { delete Object.prototype.toJSON; }
    await h.appending;
    const rows = (await rawKeys(db, "history")).filter((k) => k[0] === e.ref).map((k) => k[1]);
    const prx = (await rawGet(db, "history", [e.ref, "prx"]))?.env;
    check(tookProxy && gets === 0 && prx?.id === "prx", "a Proxy: what is written is the copy of what was measured, its get trap never run: " + JSON.stringify({ tookProxy, gets, prx }));
    check(took.every((t) => t === false) && polluted === false && ran === 0 && rows.filter((r) => r !== "prx").length === 0 && S.historyBacklog().entries === 0, "hooks: an own toJSON (not enumerable), an inherited one, a getter, a changing getter, a toJSON on Object.prototype: each refused, no hook run, nothing kept: " + JSON.stringify({ took, polluted, ran, rows }));
    // (one bounded walk (daybreak2's LIMIT-896-1): an envelope past the cap is refused as soon as its text passes
    // it, said as too large, never walked further to choose the words: a wide one (its text past the cap a third
    // of the way in) and one of ten million elements (past it by its length alone)
    said.length = 0;
    const wideOver = Array.from({ length: 2_000_000 }, () => ""), longOver = new Array(10_000_000).fill(0);
    const tw = performance.now(), tookWide = h.append({ time: "wideO", id: "w", t: wideOver }), tookLong = h.append({ time: "longO", id: "l", t: longOver }), msOver = performance.now() - tw;
    check(tookWide === false && tookLong === false && msOver < 1000 && said.length === 2 && said.every((m) => /too large to keep in TimeTravel/.test(m)), "an envelope past the cap, wide or long: refused as soon as it passes, said as too large: " + JSON.stringify({ tookWide, tookLong, ms: Math.round(msOver), said: said.length }));
    // (an array Proxy whose get trap throws (astra's on 89685b0c): read through descriptors alone, its length
    // from its own "length" descriptor: copied inertly, its get trap never run, append never throwing)
    let pgets = 0, threw = null, tookPrx2;
    const parr = new Proxy([1], { get: () => { pgets++; throw new Error("get trap"); } });
    try { tookPrx2 = h.append({ time: "parr", id: "parr", patch: parr }); } catch (err) { threw = String(err); }
    await h.appending;
    const parrKept = (await rawGet(db, "history", [e.ref, "parr"]))?.env;
    // (a Proxy whose descriptor trap throws: refused, never thrown on)
    let threw2 = null, tookGopd;
    try { tookGopd = h.append(new Proxy({ time: "gopd", id: "gopd" }, { getOwnPropertyDescriptor: () => { throw new Error("descriptor trap"); } })); } catch (err) { threw2 = String(err); }
    check(threw2 === null && tookGopd === false, "a Proxy whose descriptor trap throws: refused, nothing thrown: " + JSON.stringify({ threw2, tookGopd }));
    check(threw === null && tookPrx2 === true && pgets === 0 && JSON.stringify(parrKept?.patch) === "[1]", "an array Proxy whose get trap throws: copied inertly, its get trap never run, nothing thrown: " + JSON.stringify({ threw, tookPrx2, pgets, parrKept }));
    said.length = 0;
    const alone = Math.floor((S.HISTORY_BACKLOG.bytes - S.ENTRY_OVERHEAD) / 2), base = JSON.stringify({ time: "bigU", id: "big", t: "" }).length;
    const under = h.append({ time: "bigU", id: "big", t: "x".repeat(alone - base) });
    await h.appending;
    // (the backlog empty again before the next: its counters let go once the write is done)
    for (let i = 0; i < 100 && S.historyBacklog().entries; i++) await new Promise((r) => setTimeout(r, 10));
    const emptyBefore = S.historyBacklog().entries === 0;
    said.length = 0;
    const over = h.append({ time: "bigO", id: "big", t: "x".repeat(alone - base + 1) });
    const st = new S.IdbStore(a.main, e.ref), doc = await st.load(), saved = await st.save({ ...doc, baseRev: doc.rev, cells: [{ id: "c", code: "x".repeat(alone - base + 1) }] });
    await h.appending;
    const kept = (await rawKeys(db, "history")).filter((k) => k[0] === e.ref).map((k) => k[1]);
    check(under === true && kept.includes("bigU"), "an entry alone just within 8 MiB of charge: taken: " + JSON.stringify({ under, kept }));
    check(emptyBefore && over === false && !kept.includes("bigO") && said.length === 1 && /too large to keep in TimeTravel/.test(said[0]) && !!saved?.saved && (await rawGet(a.main, "notebooks", e.ref)).cells[0].code.length === alone - base + 1, "…one just past it: refused, said as too large for TimeTravel, its document saved all the same: " + JSON.stringify({ over, said, saved }));
    off(); a.close(); db.close();
  }
  // the OPFS witness's flush in the background: the lock held elsewhere, it doesn't wait for it (no request
  // left pending), and is done once the lock is free
  {
    const o = await named(), a = await openAs(o); await a.create("/flush.txt", { content: "f" });
    let release; await new Promise((r) => navigator.locks.request("sagebrush-workspace", () => new Promise((g) => { release = g; r(); })));
    let state;
    try {
      const raced = await Promise.race([a.flushOpfs().then(() => "returned"), new Promise((r) => setTimeout(() => r("waiting"), 1000))]);
      const pending = (await navigator.locks.query()).pending.filter((l) => l.name === "sagebrush-workspace").length;
      state = { raced, pending };
    } finally { release(); }
    const before = await opfsW(o.name);
    await a.flushOpfs();
    const after = await opfsW(o.name);
    check(state.raced === "returned" && state.pending === 0 && after.seq > (before?.seq ?? 0), "the OPFS flush, the lock held elsewhere: not waiting for it, nothing pending; done once it is free: " + JSON.stringify({ ...state, before: before?.seq, after: after.seq }));
    a.close();
  }
  // append after clear: kept, after it; and the other tabs told in that order
  {
    const S2 = await import("./stores.js"), o = await named(), a = await openAs(o), e = await a.create("/m.ipynb"), db = await S2.openHistoryDb(), h = new S2.IdbPatchStore(db, e.ref);
    await h.loadInitial();
    const heard = [], bc = new BroadcastChannel("sagebrush-history"); bc.onmessage = (ev) => { if (ev.data?.id === e.ref) heard.push(ev.data.clear ? "clear" : ev.data.env?.id); };
    h.append({ time: "one", id: "one" }); const c = h.clear(); h.append({ time: "three", id: "three" }); await c; await h.appending;
    await new Promise((r) => setTimeout(r, 100));
    const rows = (await rawKeys(db, "history")).filter((k) => k[0] === e.ref).map((k) => k[1]);
    check(rows.join() === "three" && heard.join() === "one,clear,three", "append, clear, append: the last kept, the tabs told in that order: " + JSON.stringify({ rows, heard }));
    bc.close(); a.close(); db.close();
  }
}

// (P0 #1, the grader's G-AD-1: the Files list's words, gating here: another device's entry whose content isn't in this
// browser reads "on another device", never "missing"; one whose content is here reads as usual; this device's own entry
// placed at another name by the server's index reads "(renamed)" while it stays there)
async function rowWords() {
  const J = JSON.stringify;
  const here = { notebook: new Set(["nb-here"]), board: new Set(["bd-here"]) };
  const nb = { path: "/a.ipynb", kind: "notebook", ref: "nb-there", created: 1, updated: 1, mode: "sage" };
  const words = {
    remoteNotebook: W.fileRowMeta({ ...nb, remote: true }, here),
    remoteNotebookHere: W.fileRowMeta({ ...nb, ref: "nb-here", remote: true }, here),
    remoteBoard: W.fileRowMeta({ path: "/b.board.json", kind: "board", ref: "bd-there", created: 1, updated: 1, remote: true }, here),
    remoteBoardHere: W.fileRowMeta({ path: "/b.board.json", kind: "board", ref: "bd-here", created: 1, updated: 1, remote: true }, here),
    remoteFile: W.fileRowMeta({ path: "/f.txt", kind: "file", ref: "/f.txt", created: 1, updated: 1, size: 3, remote: true }, here),
    remoteFileFailing: W.fileRowMeta({ path: "/f.txt", kind: "file", ref: "/f.txt", created: 1, updated: 1, size: 3, remote: true, fetchFailed: { why: "the files server answered 403", at: 1 } }, here),
    remoteFileApart: W.fileRowMeta({ path: "/f.txt", kind: "file", ref: "/f.txt", created: 1, updated: 1, size: 3, remote: true, fetchFailed: { why: "too large to sync", at: 1, final: true } }, here),
    ownFile: W.fileRowMeta({ path: "/f.txt", kind: "file", ref: "/f.txt", created: 1, updated: 1, size: 3 }, here),
    ownMissing: W.fileRowMeta({ ...nb, missing: true }, here),
    renamed: W.fileRowMeta({ ...nb, ref: "nb-here", path: "/a (2).ipynb", renamed: { from: "/a.ipynb", to: "/a (2).ipynb" } }, here),
    renamedMovedOn: W.fileRowMeta({ ...nb, ref: "nb-here", path: "/c.ipynb", renamed: { from: "/a.ipynb", to: "/a (2).ipynb" } }, here),
  };
  check(words.remoteNotebook === "on another device" && words.remoteBoard === "on another device" && words.remoteFile === "on another device", "another device's notebook, board and file, their content not here: \"on another device\", never \"missing\": " + J(words));
  check(words.remoteNotebookHere === "Sage" && words.remoteBoardHere === "" && words.ownFile === "3 B", "…with their content here (or this device's own): the usual words: " + J(words));
  check(words.ownMissing === "missing", "this device's own whose contents aren't found: \"missing\" as before");
  check(words.remoteFileFailing === "download failed, retrying" && words.remoteFileApart === "not downloaded: too large to sync", "another device's file whose download fails: said, never \"on another device\" in silence (B5): " + J([words.remoteFileFailing, words.remoteFileApart]));
  check(words.renamed === "(renamed)" && words.renamedMovedOn === "Sage", "this device's own renamed by the server's index: \"(renamed)\" while it stays at that name, not once it has moved on: " + J(words));
  const sums = [W.listedSummary({ count: 3, renamed: 1, paths: [] }), W.listedSummary({ count: 1, renamed: 1, paths: [] }), W.listedSummary({ count: 2, paths: [] })];
  check(sums[0] === "2 items sync kept aside; 1 item renamed (another device has one with the name)" && sums[1] === "1 item renamed (another device has one with the name)" && sums[2] === "2 items sync kept aside", "the Sync panel counts renamed ones apart from those kept aside (N-AD-2): " + J(sums));
  check(W.isElsewhere({ ...nb, remote: true }, here) && !W.isElsewhere({ ...nb, ref: "nb-here", remote: true }, here) && !W.isElsewhere(nb, here), "isElsewhere: another device's whose content isn't here, only");
}

// (@sagebrush's ruling on the delete-on repro's (2): the Files sidebar's sync line, once sync was used here, is never blank
// after an off: "Turn off sync here" says "Sync off", "Delete my synced data" says "Sync off: your synced data was
// deleted"; a device that never turned sync on says nothing.  The owner's view as the sidebar reads it (no session: no
// client starts))
async function syncLineOff() {
  const J = JSON.stringify;
  const lines = [W.sidebarLine({ state: "off" }), W.sidebarLine({ state: "off", used: true }), W.sidebarLine({ state: "off", used: true, reason: "your synced data was deleted" })];
  check(J(lines) === J(["", "Sync off", "Sync off: your synced data was deleted"]), "the sidebar's line when off: nothing, never used; \"Sync off\"; and with why: " + J(lines));
  const w = await fresh();
  const owner = W.SyncOwner.of(w, { origin: location.origin, fetch: async () => new Response("{}", { status: 401 }) });
  const line = async () => { await owner.reconcile(); return W.sidebarLine(owner.view().s); };
  const ns = "a".repeat(32) + ":1:" + w.device;
  const never = await line();
  await W.switchTo(w, ns);
  await W.syncOffIf(w);
  const offHere = await line();
  await W.switchTo(w, ns);
  await W.syncOffIf(w, undefined, "deleted");
  const deleted = await line();
  // (on again, then off here: the deletion's words don't stay)
  await W.switchTo(w, ns);
  await W.syncOffIf(w);
  const offAgain = await line();
  check(never === "" && offHere === "Sync off" && deleted === "Sync off: your synced data was deleted" && offAgain === "Sync off", "the sidebar's sync line: never on, nothing; off here, \"Sync off\"; deleted, said so; on and off again, \"Sync off\": " + J({ never, offHere, deleted, offAgain }));
  w.close();
}

export async function run() {
  for (const t of [rowWords, syncLineOff, storageUse, versionActions, fences, intents, paths_, createAndRead, writeCas, renames, trash, duplicates, limits, opsAndWatch, concurrent, versions, migration, migrationProvenance, recovery, recoveryConflict, edges, noLocks, rollback, dropping, emptying, folderLimit, migrationFull, recent, migrateV1, migrateOnWrite, writeGuard, pathOfFile_, migratePaused, migrateTargetFails, migrateCrashBetween, olderTabWrite, migrateCandidatePass, migrateOneTab, closedByUpgrade, migrateUndersized, staleChanged, migrateQueuedAndBounded, generationMonotonic, folderIds, folderIdsMigrated, upgradeFromV2, provenance, lookalikes, lookalikesAtScale, durabilityDecide, durabilityFirstSave, durabilityConfirmed, durabilitySuspected, durabilityWitnesses, durabilityDenied, durabilityTwoTabs, durabilityTabs, durabilityPurge, durabilityPurgePending, durabilityPurgeLocal, durabilityPurgeLocalSparse, durabilityResetManySmall, durabilityResetBounds, durabilityNotices, durabilityDeliberate, durabilityReset, durabilityAstraProbes, durabilityAstraProbes99, durabilityAstraProbes0ee, durabilityAstraProbes28f, durabilityAdmission, durabilityOwnership, deniedBundle, deniedMeta, primaryRollback, currentPending, durabilityAuthority, () => historyOrder("clear"), () => historyOrder("drop"), purgeMarks, durabilityLockOrder]) {
    console.log(`test: ${t.name || t}`);
    try { await t(); } catch (e) { results.push([false, `${t.name} threw: ${e?.stack ?? e}`]); }
  }
  return results;
}
