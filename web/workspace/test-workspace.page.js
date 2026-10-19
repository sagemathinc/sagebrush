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
  const after = JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter((k) => !k.startsWith(W.MOVED)).sort().map((k) => [k, localStorage.getItem(k)])));
  check(before === after, "localStorage is left as it was (markers aside)");
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
  // a lost marker: the board is found by its id, not brought in twice
  localStorage.removeItem(W.MOVED + "sagebrush-board:local:" + ids[1]);
  await W.migrate(w, localStorage);
  check((await paths(w)).length === now.length, "a lost marker brings in nothing twice");
  // reconcile, later: new contents with no entry in /Recovered; contents gone marked, never dropped
  await rawPut(w.main, "notebooks", { id: "nb4", name: "Late", mode: "python", cells: [], rev: 1, updated: 8 });
  await rawDel(w.main, "notebooks", "nb2");
  const r4 = await W.migrate(w, localStorage);
  check((await paths(w)).includes("/Recovered/Late.ipynb") && r4.recovered === 1, "a notebook found later is listed in /Recovered");
  const gone = (await w.list("/")).find((e) => e.ref === "nb2");
  check(gone?.missing === true && r4.missing === 1, "an entry whose notebook is gone is marked missing, and kept");
  check(await fails(w.read(gone.path), "missing"), "…reading it says so");
  await rawPut(w.main, "notebooks", { id: "nb2", name: "Untitled", mode: "magma", cells: [], rev: 1, updated: 6 });
  await W.migrate(w, localStorage);
  check(!(await w.stat(gone.path)).missing, "…and unmarked when it's back");
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

export async function run() {
  for (const t of [paths_, createAndRead, writeCas, renames, trash, duplicates, limits, opsAndWatch, concurrent, versions, migration, migrationFull]) {
    try { await t(); } catch (e) { results.push([false, `${t.name} threw: ${e?.stack ?? e}`]); }
  }
  return results;
}
