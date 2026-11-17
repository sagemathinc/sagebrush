// The cases of web/workspace/test-disk-mirror.mjs (the desktop app's workspace on disk, disk-mirror.ts), run in
// the page, against a disk in memory with disk.rs's verbs (paths are workspace paths; every write a new
// modification time).
import * as W from "./ws.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const enc = (s) => new TextEncoder().encode(s), dec = (b) => new TextDecoder().decode(b);
let n = 0;
// (a workspace of its own, as a launch's: another database, as another origin's)
const launch = async () => { n++; localStorage.clear(); return W.Workspace.open({ name: `ws-disk-${n}-${Math.random().toString(36).slice(2, 8)}`, mainName: `main-disk-${n}` }); };

/** A disk in memory: files (bytes, mtime) and folders, by workspace path. */
function memDisk() {
  const files = new Map(), dirs = new Set(["/"]);
  let clock = 1000;
  const parentOf = (p) => p.slice(0, Math.max(1, p.lastIndexOf("/")));
  const mk = (p) => { while (p !== "/" && !dirs.has(p)) { dirs.add(p); p = parentOf(p); } };
  const st = (p) => (files.has(p) ? { path: p, dir: false, size: files.get(p).bytes.length, mtime: files.get(p).mtime } : dirs.has(p) ? { path: p, dir: true, size: 0, mtime: 0 } : null);
  const disk = {
    files, dirs,
    async list() { return [...[...dirs].filter((d) => d !== "/").map(st), ...[...files.keys()].map(st)]; },
    async stat(p) { return st(p); },
    async read(p) { if (!files.has(p)) throw new Error("no " + p); return files.get(p).bytes.slice(); },
    async write(p, b) { mk(parentOf(p)); files.set(p, { bytes: b.slice(), mtime: ++clock }); return st(p); },
    async mkdir(p) { mk(p); },
    async rename(a, b) {
      mk(parentOf(b));
      if (files.has(a)) { files.set(b, { ...files.get(a), mtime: ++clock }); files.delete(a); return; }
      for (const k of [...files.keys()]) if (k.startsWith(a + "/")) { files.set(b + k.slice(a.length), files.get(k)); files.delete(k); }
      for (const d of [...dirs]) if (d === a || d.startsWith(a + "/")) { dirs.delete(d); dirs.add(b + d.slice(a.length)); }
    },
    async remove(p) { files.delete(p); for (const k of [...files.keys()]) if (k.startsWith(p + "/")) files.delete(k); for (const d of [...dirs]) if (d === p || d.startsWith(p + "/")) dirs.delete(d); },
    /** another program's write: a new mtime */
    external(p, text) { mk(parentOf(p)); files.set(p, { bytes: enc(text), mtime: ++clock }); },
  };
  return disk;
}
const NB = (src) => ({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } }, cells: [{ cell_type: "code", source: src, metadata: {}, outputs: [], execution_count: null, id: "c1" }] });
const nbSource = (text) => JSON.parse(text).cells.map((c) => (Array.isArray(c.source) ? c.source.join("") : c.source)).join("\n");

export async function run() {
  try { await cases(); } catch (e) { results.push([false, "threw: " + (e?.stack ?? e)]); }
  return results;
}
async function cases() {
  // ---- 1. a launch makes things; every change reaches the disk at once
  {
    const disk = memDisk(), ws = await launch();
    const m = new W.DiskMirror(ws, disk, new Map()).start();
    await ws.create("/n/first.ipynb", { content: NB("x = 6 * 7") });
    await ws.create("/b.board.json");
    await ws.create("/d/data.csv", { content: enc("a,b\n1,2\n") });
    await ws.mkdir("/empty");
    await m.flushed();
    check(disk.files.has("/n/first.ipynb") && nbSource(dec(disk.files.get("/n/first.ipynb").bytes)) === "x = 6 * 7", "a notebook made: its .ipynb on disk");
    check(disk.files.has("/b.board.json") && dec(disk.files.get("/b.board.json").bytes) === dec(await W.fileBytes(ws, "/b.board.json")), "a board made: its file on disk, as Download writes it");
    check(dec(disk.files.get("/d/data.csv")?.bytes ?? new Uint8Array()) === "a,b\n1,2\n", "a data file made: its bytes on disk");
    check(disk.dirs.has("/empty"), "a folder made: on disk");
    await ws.write("/d/data.csv", enc("a,b\n3,4\n"));
    await ws.write("/d/data.csv", enc("a,b\n5,6\n"));
    await m.flushed();
    check(dec(disk.files.get("/d/data.csv").bytes) === "a,b\n5,6\n", "two writes in a row: the disk has the last");
    await ws.rename("/d/data.csv", "/d/renamed.csv");
    await m.flushed();
    check(!disk.files.has("/d/data.csv") && disk.files.has("/d/renamed.csv"), "a rename: moved on disk");
    const t = await ws.remove("/d/renamed.csv");
    await m.flushed();
    check(!disk.files.has("/d/renamed.csv") && disk.files.has(W.toDisk(t.path)), "to Trash: moved to .Trash on disk (" + W.toDisk(t.path) + ")");
    await ws.restore(t.path);
    await m.flushed();
    check(disk.files.has("/d/renamed.csv") && ![...disk.files.keys()].some((k) => k.startsWith("/.Trash/")), "restored: back from .Trash on disk");
    const t2 = await ws.remove("/d/renamed.csv");
    await ws.emptyTrash([t2.path]);
    await m.flushed();
    check(![...disk.files.keys()].some((k) => k.startsWith("/.Trash/")) && !disk.files.has("/d/renamed.csv"), "Trash emptied: gone from disk");
    // (a notebook's save goes through its store, not the workspace's verbs: the page's "saved" asks for its file)
    const e = await ws.stat("/n/first.ipynb");
    await ws.write("/n/first.ipynb", NB("x = 7 * 6"));
    m.docSaved(e.ref);
    await m.flushed();
    check(nbSource(dec(disk.files.get("/n/first.ipynb").bytes)) === "x = 7 * 6", "a notebook's save: its file written");
    m.close();

    // ---- 2. the next launch (another origin: an empty workspace) finds the same files
    const ws2 = await launch();
    check((await ws2.list("/", { recursive: true })).length === 0, "the next launch's workspace starts empty (another origin's)");
    const r = await W.importDisk(ws2, disk);
    const paths = (await ws2.list("/", { recursive: true })).filter((e) => !e.path.startsWith("/Trash")).map((e) => e.path).sort();
    check(JSON.stringify(paths) === JSON.stringify(["/b.board.json", "/d", "/empty", "/n", "/n/first.ipynb"]), "imported: the same tree " + JSON.stringify(paths));
    check(nbSource(W.notebookFileText((await ws2.read("/n/first.ipynb")).content)) === "x = 7 * 6", "imported: the notebook as last saved");
    check(dec(await W.fileBytes(ws2, "/b.board.json")) === dec(disk.files.get("/b.board.json").bytes), "imported: the board as on disk");
    check(r.skipped.length === 0 && r.files === 2, `the import's report: ${r.files} files, nothing skipped`);
    ws2.close?.();

    // ---- 3. another program changes a file between launches: the next launch has the change
    disk.external("/n/first.ipynb", JSON.stringify(NB("edited = 'in an editor'")));
    disk.external("/new.txt", "made in Finder");
    const ws3 = await launch();
    const r3 = await W.importDisk(ws3, disk);
    check(nbSource(W.notebookFileText((await ws3.read("/n/first.ipynb")).content)) === "edited = 'in an editor'", "an edit made outside between launches: imported");
    check(dec((await ws3.read("/new.txt")).content) === "made in Finder", "a file made outside between launches: imported");

    // ---- 4. another program changes a file during a launch: Sagebrush's write never goes over it
    let said = null;
    const m3 = new W.DiskMirror(ws3, disk, r3.known, (p, kept) => (said = [p, kept])).start();
    disk.external("/new.txt", "changed in an editor meanwhile");
    await ws3.write("/new.txt", enc("written in Sagebrush"));
    await m3.flushed();
    check(dec(disk.files.get("/new.txt").bytes) === "changed in an editor meanwhile", "the other program's change kept");
    check(dec(disk.files.get("/new (from Sagebrush).txt")?.bytes ?? new Uint8Array()) === "written in Sagebrush", "Sagebrush's version beside it");
    check(said && said[0] === "/new.txt" && said[1] === "/new (from Sagebrush).txt", "and the person told: " + JSON.stringify(said));
    // (a control: the same with the file's stat as last read: written over, as it should be)
    await ws3.write("/n/first.ipynb", NB("mine"));
    const e3 = await ws3.stat("/n/first.ipynb");
    m3.docSaved(e3.ref);
    await m3.flushed();
    check(nbSource(dec(disk.files.get("/n/first.ipynb").bytes)) === "mine", "a file unchanged outside since the import: written over (the control)");
    m3.close();
  }
  // ---- 5. a large workspace's import, timed (an observation)
  {
    const disk = memDisk();
    const big = JSON.stringify(NB("y = 1\n".repeat(200)));
    for (let i = 0; i < 500; i++) disk.external(`/nb/n${String(i).padStart(3, "0")}.ipynb`, big);
    const blob = new Uint8Array(1 << 20).fill(7);
    for (let i = 0; i < 200; i++) await disk.write(`/data/f${i}.bin`, blob);
    const ws = await launch();
    const r = await W.importDisk(ws, disk);
    check(r.files === 700 && r.skipped.length === 0, `a large workspace imported: ${r.files} files, ${(r.bytes / 2 ** 20).toFixed(0)} MiB`);
    results.push([true, `OBS import of 500 notebooks and 200 MiB of files: ${r.ms} ms (this machine, headless Chromium; the app's IPC reads not included)`]);
  }
  return results;
}
