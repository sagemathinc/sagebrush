// The cases of web/workspace/test-disk-mirror.mjs (the desktop app's workspace on disk, disk-mirror.ts), run in
// the page, against a disk in memory with disk.rs's verbs and their checks: every write a new modification time and
// its SHA-256; a change refused (CONFLICT) when the file isn't what the page expects; a missing source an error.
// A test can hold a file's writes (as a slow disk or an IPC call in flight) and make them fail.
import * as W from "./ws.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const enc = (s) => new TextEncoder().encode(s), dec = (b) => new TextDecoder().decode(b);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let n = 0;
// (a workspace of its own, as a launch's: another database, as another origin's)
const launch = async () => { n++; localStorage.clear(); return W.Workspace.open({ name: `ws-disk-${n}-${Math.random().toString(36).slice(2, 8)}`, mainName: `main-disk-${n}` }); };
const fast = (ms) => tick(Math.min(ms, 5));

/** A disk in memory: files (bytes, mtime, sha256) and folders, by workspace path. */
function memDisk() {
  const files = new Map(), dirs = new Set(["/"]), held = new Map(), fail = new Map(), writes = new Map();
  let clock = 1000;
  const parentOf = (p) => p.slice(0, Math.max(1, p.lastIndexOf("/")));
  const mk = (p) => { while (p !== "/" && !dirs.has(p)) { dirs.add(p); p = parentOf(p); } };
  const st = (p) => (files.has(p) ? { path: p, dir: false, size: files.get(p).bytes.length, mtime: files.get(p).mtime, sha256: files.get(p).sha } : dirs.has(p) ? { path: p, dir: true, size: 0, mtime: 0 } : null);
  const holds = (x, p) => { const s = st(p); return x === "any" ? true : x === "absent" ? !s : !!s && !s.dir && s.size === x.size && s.mtime === x.mtime && s.sha256 === x.sha256; };
  const put = async (p, b, mtime) => files.set(p, { bytes: b.slice(), mtime, sha: await W.sha256Hex(b) });
  const disk = {
    files, dirs, writes,
    async list() { return [...[...dirs].filter((d) => d !== "/").map(st), ...[...files.keys()].map(st)]; },
    async stat(p) { return st(p); },
    async read(p) { if (!files.has(p)) throw new Error("no " + p); return files.get(p).bytes.slice(); },
    async write(p, b, expect) {
      if (held.has(p)) await held.get(p).promise;
      const f = fail.get(p);
      if (f && f.n !== 0) { f.n--; throw new Error("disk full"); }
      if (!holds(expect, p)) throw new Error(W.CONFLICT);
      writes.set(p, (writes.get(p) ?? 0) + 1);
      mk(parentOf(p));
      await put(p, b, ++clock);
      return st(p);
    },
    async mkdir(p) { mk(p); },
    async rename(a, b, expect) {
      if (!files.has(a) && !dirs.has(a)) { if (expect === "any") throw new Error("no " + a); throw new Error(W.CONFLICT); }
      if (!holds(expect, a) || st(b)) throw new Error(W.CONFLICT);
      mk(parentOf(b));
      if (files.has(a)) { files.set(b, { ...files.get(a) }); files.delete(a); return; }
      for (const k of [...files.keys()]) if (k.startsWith(a + "/")) { files.set(b + k.slice(a.length), files.get(k)); files.delete(k); }
      for (const d of [...dirs]) if (d === a || d.startsWith(a + "/")) { dirs.delete(d); dirs.add(b + d.slice(a.length)); }
    },
    async remove(p, expect) {
      if (!holds(expect, p)) throw new Error(W.CONFLICT);
      files.delete(p); for (const k of [...files.keys()]) if (k.startsWith(p + "/")) files.delete(k); for (const d of [...dirs]) if (d === p || d.startsWith(p + "/")) dirs.delete(d);
    },
    /** another program's write: a new mtime, unless `keepTime` (an edit keeping size and time) */
    async external(p, text, keepTime = false) { mk(parentOf(p)); await put(p, enc(text), keepTime && files.has(p) ? files.get(p).mtime : ++clock); },
    /** the writes of `p` held until release() */
    hold(p) { let release; const promise = new Promise((r) => (release = r)); held.set(p, { promise }); return () => { held.delete(p); release(); }; },
    /** the next `k` writes of `p` failing (-1: all of them) */
    failing(p, k) { fail.set(p, { n: k }); },
  };
  return disk;
}
const NB = (src) => ({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } }, cells: [{ cell_type: "code", source: src, metadata: {}, outputs: [], execution_count: null, id: "c1" }] });
const nbSource = (text) => JSON.parse(text).cells.map((c) => (Array.isArray(c.source) ? c.source.join("") : c.source)).join("\n");
const text = (disk, p) => (disk.files.has(p) ? dec(disk.files.get(p).bytes) : undefined);
const mirror = (ws, disk, known = new Map(), on = {}) => new W.DiskMirror(ws, disk, known, on, fast).start();

export async function run() {
  try { await cases(); } catch (e) { results.push([false, "threw: " + (e?.stack ?? e)]); }
  return results;
}
async function cases() {
  // ---- 1. a launch makes things; every change reaches the disk
  {
    const disk = memDisk(), ws = await launch();
    const m = mirror(ws, disk);
    await ws.create("/n/first.ipynb", { content: NB("x = 6 * 7") });
    await ws.create("/b.board.json");
    await ws.create("/d/data.csv", { content: enc("a,b\n1,2\n") });
    await ws.mkdir("/empty");
    await m.drain(5000);
    check(nbSource(text(disk, "/n/first.ipynb") ?? "{\"cells\":[]}") === "x = 6 * 7", "a notebook made: its .ipynb on disk");
    check(text(disk, "/b.board.json") === dec(await W.fileBytes(ws, "/b.board.json")), "a board made: its file on disk, as Download writes it");
    check(text(disk, "/d/data.csv") === "a,b\n1,2\n", "a data file made: its bytes on disk");
    check(disk.dirs.has("/empty"), "a folder made: on disk");
    await ws.rename("/d/data.csv", "/d/renamed.csv");
    await m.drain(5000);
    check(!disk.files.has("/d/data.csv") && disk.files.has("/d/renamed.csv"), "a rename: moved on disk");
    const t = await ws.remove("/d/renamed.csv");
    await m.drain(5000);
    check(!disk.files.has("/d/renamed.csv") && disk.files.has(W.toDisk(t.path)), "to Trash: moved to .Trash on disk (" + W.toDisk(t.path) + ")");
    await ws.restore(t.path);
    await m.drain(5000);
    check(disk.files.has("/d/renamed.csv") && ![...disk.files.keys()].some((k) => k.startsWith("/.Trash/")), "restored: back from .Trash on disk");
    const t2 = await ws.remove("/d/renamed.csv");
    await ws.emptyTrash([t2.path]);
    await m.drain(5000);
    check(![...disk.files.keys()].some((k) => k.startsWith("/.Trash/")) && !disk.files.has("/d/renamed.csv"), "Trash emptied: gone from disk");
    const e = await ws.stat("/n/first.ipynb");
    await ws.write("/n/first.ipynb", NB("x = 7 * 6"));
    m.docSaved(e.ref);
    await m.drain(5000);
    check(nbSource(text(disk, "/n/first.ipynb")) === "x = 7 * 6", "a notebook's save: its file written");
    m.close();

    // ---- 2. the next launch (another origin: an empty workspace) finds the same files
    const ws2 = await launch();
    check((await ws2.list("/", { recursive: true })).length === 0, "the next launch's workspace starts empty (another origin's)");
    const r = await W.importDisk(ws2, disk);
    const paths = (await ws2.list("/", { recursive: true })).filter((e) => !e.path.startsWith("/Trash")).map((e) => e.path).sort();
    check(JSON.stringify(paths) === JSON.stringify(["/b.board.json", "/d", "/empty", "/n", "/n/first.ipynb"]), "imported: the same tree " + JSON.stringify(paths));
    check(nbSource(W.notebookFileText((await ws2.read("/n/first.ipynb")).content)) === "x = 7 * 6", "imported: the notebook as last saved");
    check(r.skipped.length === 0 && r.files === 2 && [...r.known.values()].every((s) => /^[0-9a-f]{64}$/.test(s.sha256)), `the import's report: ${r.files} files, nothing skipped, each file's SHA-256 kept`);

    // ---- 3. another program's changes between launches: imported
    await disk.external("/n/first.ipynb", JSON.stringify(NB("edited = 'in an editor'")));
    await disk.external("/new.txt", "made in Finder");
    const ws3 = await launch();
    const r3 = await W.importDisk(ws3, disk);
    check(nbSource(W.notebookFileText((await ws3.read("/n/first.ipynb")).content)) === "edited = 'in an editor'", "an edit made outside between launches: imported");
    check(dec((await ws3.read("/new.txt")).content) === "made in Finder", "a file made outside between launches: imported");

    // ---- 4. another program's change during a launch: never written over; Sagebrush's version beside it, at a free name
    let said = [];
    const m3 = mirror(ws3, disk, r3.known, { conflict: (p, kept) => said.push([p, kept]) });
    await disk.external("/new.txt", "changed in an editor meanwhile");
    await disk.external("/new (from Sagebrush).txt", "a file of the person's, with that name");
    await ws3.write("/new.txt", enc("written in Sagebrush"));
    await m3.drain(5000);
    check(text(disk, "/new.txt") === "changed in an editor meanwhile", "the other program's change kept");
    check(text(disk, "/new (from Sagebrush).txt") === "a file of the person's, with that name", "a file already named \"… (from Sagebrush)\": never written over");
    check(text(disk, "/new (from Sagebrush 2).txt") === "written in Sagebrush", "Sagebrush's version beside it, at the next free name");
    check(said.length === 1 && said[0][0] === "/new.txt" && said[0][1] === "/new (from Sagebrush 2).txt", "and the person told: " + JSON.stringify(said));
    await ws3.write("/new.txt", enc("written again"));
    await m3.drain(5000);
    check(text(disk, "/new (from Sagebrush 2).txt") === "written again" && text(disk, "/new.txt") === "changed in an editor meanwhile", "its later saves go to that copy too");
    // (the control: unchanged outside since the import: written over)
    await ws3.write("/n/first.ipynb", NB("mine"));
    await m3.drain(5000);
    check(nbSource(text(disk, "/n/first.ipynb")) === "mine", "a file unchanged outside since the import: written over (the control)");
    // (an edit keeping size and time: seen by its SHA-256)
    await disk.external("/n/first.ipynb", text(disk, "/n/first.ipynb").replace("mine", "MINE"), true);
    said = [];
    await ws3.write("/n/first.ipynb", NB("ours"));
    await m3.drain(5000);
    check(nbSource(text(disk, "/n/first.ipynb")) === "MINE" && said.length === 1, "an edit outside keeping size and time: seen (by its SHA-256), not written over");
    m3.close();
  }

  // ---- 5. order: a write still waiting (an IPC call in flight), then a create and a rename: the file is there
  {
    for (const rename of [true, false]) {
      const disk = memDisk(), ws = await launch(), m = mirror(ws, disk);
      await ws.create("/block.txt", { content: enc("first") });
      const release = disk.hold("/block.txt");
      await tick(10);
      await ws.create("/new.txt", { content: enc("valuable") });
      if (rename) await ws.rename("/new.txt", "/renamed.txt");
      release();
      await m.drain(5000);
      const at = rename ? "/renamed.txt" : "/new.txt";
      check(text(disk, at) === "valuable" && (!rename || !disk.files.has("/new.txt")), `a create ${rename ? "and a rename" : "(the control: no rename)"} behind a write in flight: ${at} on disk, as made`);
      m.close();
    }
  }

  // ---- 6. a burst: many saves of one file while the disk is slow: written once or a few times, the last contents
  {
    const disk = memDisk(), ws = await launch(), m = mirror(ws, disk);
    await ws.create("/x.txt", { content: enc("v0") });
    await m.drain(5000);
    const release = disk.hold("/x.txt");
    for (let i = 1; i <= 25; i++) await ws.write("/x.txt", enc("v" + i));
    await tick(10);
    const waiting = m.pending;
    release();
    check(await m.drain(5000), "the burst: all on disk");
    const w = disk.writes.get("/x.txt");
    check(text(disk, "/x.txt") === "v25" && w <= 4, `25 saves while the disk was slow: written ${w} times, the last contents (${waiting} waiting at most)`);
    // (and with failures: tried again, in order, the last contents)
    let errors = [];
    m.on.error = (p, e) => errors.push([p, e === null ? null : String(e.message ?? e)]);
    disk.failing("/x.txt", 2);
    for (let i = 26; i <= 40; i++) await ws.write("/x.txt", enc("v" + i));
    await ws.rename("/x.txt", "/y.txt");
    check(await m.drain(10000), "a burst with failures: all on disk in the end");
    check(text(disk, "/y.txt") === "v40" && !disk.files.has("/x.txt"), "the failed write tried again, before the rename after it: /y.txt has the last contents");
    check(errors.length >= 2 && errors[0][0] === "/x.txt" && /disk full/.test(errors[0][1]) && errors.at(-1)[1] === null, "the failure said, by its file, then said over: " + JSON.stringify(errors.slice(0, 3)));
    m.close();
  }

  // ---- 7. a failure that lasts: drain says no (a quit then asks); the failure on the banner, by its file
  {
    const disk = memDisk(), ws = await launch();
    const banner = W.diskBanner();
    const m = mirror(ws, disk, new Map(), { error: (p, e) => banner.set("error", e === null ? null : `Couldn't save ${p} to disk: ${e.message}`) });
    disk.failing("/p.txt", -1);
    await ws.create("/p.txt", { content: enc("kept?") });
    check(!(await m.drain(300)) && m.pending === 1 && m.failing?.[0] === "/p.txt", "a write that keeps failing: still waiting, not taken for done");
    check(/Couldn't save \/p\.txt to disk: disk full/.test(document.getElementById("sb-disk-banner")?.textContent ?? ""), "the banner names the file and why");
    disk.failing("/p.txt", 0);
    check(await m.drain(5000) && text(disk, "/p.txt") === "kept?" && !document.getElementById("sb-disk-banner").textContent, "the disk back: written, the banner gone");
    m.close();
  }

  // ---- 8. a quit: waits for the disk; the editor's save first; a lasting failure asks; the controls
  const quit = async (opts) => {
    const calls = [], listeners = new Map();
    W.drainOnQuit({ mirror: () => opts.m, invoke: async (c) => { calls.push(c); }, listen: (ev, f) => listeners.set(ev, f), freeze: () => calls.push("freeze"), flushEditor: opts.flushEditor, timeoutMs: opts.timeoutMs ?? 5000 });
    const done = listeners.get("sb-quit")();
    return { calls, done };
  };
  {
    const disk = memDisk(), ws = await launch(), m = mirror(ws, disk);
    await ws.create("/q.txt", { content: enc("one") });
    await m.drain(5000);
    const release = disk.hold("/q.txt");
    await ws.write("/q.txt", enc("two"));
    const { calls, done } = await quit({ m });
    await tick(50);
    check(calls.includes("app_quit_hold") && calls.includes("freeze") && !calls.includes("app_quit_now"), "a quit with a write in flight: held, edits stopped, not quit yet");
    release();
    await done;
    check(calls.at(-1) === "app_quit_now" && text(disk, "/q.txt") === "two", "...then quit, once it was on disk");
    document.getElementById("sb-quitting")?.remove();
    m.close();
  }
  {
    // (the control: quit at once, without draining: the change isn't on disk)
    const disk = memDisk(), ws = await launch(), m = mirror(ws, disk);
    await ws.create("/q.txt", { content: enc("one") });
    await m.drain(5000);
    const release = disk.hold("/q.txt");
    await ws.write("/q.txt", enc("two"));
    m.close();
    check(text(disk, "/q.txt") === "one", "the control: a quit without the drain loses the change in flight");
    release();
  }
  for (const flush of [true, false]) {
    // (a notebook's save the editor hasn't made yet: made by the quit's flush, then on disk; the control: not flushed)
    const disk = memDisk(), ws = await launch(), m = mirror(ws, disk);
    await ws.create("/nb.ipynb", { content: NB("a = 1") });
    await m.drain(5000);
    const e = await ws.stat("/nb.ipynb");
    const pendingSave = async () => { await ws.write("/nb.ipynb", NB("a = 2")); m.docSaved(e.ref); };
    const { calls, done } = await quit({ m, flushEditor: flush ? pendingSave : undefined });
    await done;
    check(calls.at(-1) === "app_quit_now" && (flush ? nbSource(text(disk, "/nb.ipynb")) === "a = 2" : nbSource(text(disk, "/nb.ipynb")) === "a = 1"), flush ? "a quit with the notebook's save pending: the save made first, then on disk, then quit" : "the control: without the editor's flush, the pending save isn't on disk at the quit");
    document.getElementById("sb-quitting")?.remove();
    m.close();
  }
  {
    // (a failure that lasts: the person chooses; nothing quits by itself)
    const disk = memDisk(), ws = await launch(), m = mirror(ws, disk);
    disk.failing("/z.txt", -1);
    await ws.create("/z.txt", { content: enc("z") });
    const { calls, done } = await quit({ m, timeoutMs: 200 });
    await tick(400);
    const buttons = [...document.querySelectorAll("#sb-quitting button")].map((b) => b.textContent);
    check(!calls.includes("app_quit_now") && buttons.includes("Wait") && buttons.some((t) => /^Quit and lose 1 change$/.test(t)), "a quit with a write that keeps failing: not quit, the person asked: " + JSON.stringify(buttons));
    [...document.querySelectorAll("#sb-quitting button")].find((b) => b.textContent.startsWith("Quit and lose")).click();
    await done;
    check(calls.at(-1) === "app_quit_now", "...and quit only when they choose to");
    document.getElementById("sb-quitting")?.remove();
    m.close();
  }

  // ---- 9. what the import can't open: reported, left on disk
  {
    const disk = memDisk();
    await disk.external("/bad.ipynb", "not JSON");
    await disk.external("/good.txt", "fine");
    const ws = await launch(), r = await W.importDisk(ws, disk);
    check(r.files === 1 && r.skipped.length === 1 && r.skipped[0][0] === "/bad.ipynb" && disk.files.has("/bad.ipynb"), "a file the import can't open: reported (" + JSON.stringify(r.skipped) + "), left on disk");
  }

  // ---- 10. a large workspace's import, timed (an observation)
  {
    const disk = memDisk();
    const big = JSON.stringify(NB("y = 1\n".repeat(200)));
    for (let i = 0; i < 500; i++) await disk.external(`/nb/n${String(i).padStart(3, "0")}.ipynb`, big);
    const blob = new Uint8Array(1 << 20).fill(7);
    for (let i = 0; i < 200; i++) await disk.write(`/data/f${i}.bin`, blob, "any");
    const ws = await launch();
    const r = await W.importDisk(ws, disk);
    check(r.files === 700 && r.skipped.length === 0, `a large workspace imported: ${r.files} files, ${(r.bytes / 2 ** 20).toFixed(0)} MiB`);
    results.push([true, `OBS import of 500 notebooks and 200 MiB of files: ${r.ms} ms (this machine, headless Chromium, SHA-256s included; the app's IPC reads not included)`]);
  }
}
