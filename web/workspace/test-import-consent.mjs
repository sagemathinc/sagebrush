// ci: web-runner order=511 runner=bun
// A board brought in from a file (an upload, a drop, Open as…) waits for the person: "Run this board's code" (the
// interim rule, until design/capabilities.md's gate). The mark is made where every such board is made, in
// web/workspace/upload.ts (uploadFiles and convertCopy), never by the pages that open one, and it fails closed: a mark
// that can't be written means the board isn't made, and one that can't be read means waiting. Driven here against a
// workspace stand-in and a sessionStorage stand-in whose writes and reads can be made to fail.
//   bun web/workspace/test-import-consent.mjs
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : "")); if (!c) failures++; };

// (this tab's storage: working, or failing to write, or writing nothing, or failing to read)
const store = new Map();
let mode = "ok";
globalThis.sessionStorage = {
  getItem(k) { if (mode === "read-throws") throw new Error("storage unavailable"); return store.get(k) ?? null; },
  setItem(k, v) { if (mode === "write-throws") throw new Error("quota"); if (mode !== "write-lost") store.set(k, v); },
  removeItem(k) { store.delete(k); },
};
const { uploadFiles, convertCopy, isPaused, unpause, pauseBoard } = await import("./upload.ts");

// (a workspace: documents and files by path, refs handed out as they are made)
function workspace() {
  const entries = new Map();
  let n = 0;
  const entry = (path, kind) => ({ path, kind, ref: kind === "file" ? undefined : `r${++n}`, fid: `f${n}`, created: n, size: 0, updated: n });
  const parent = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
  return {
    entries,
    limits: { maxFolderEntries: 1000 },
    async list(folder) { return [...entries.values()].filter((x) => parent(x.entry.path) === (folder.replace(/\/$/, "") || "/")).map((x) => x.entry); },
    async create(p, { content }) { const e = entry(p, p.endsWith(".board.json") ? "board" : "notebook"); entries.set(p, { entry: e, content }); return e; },
    async putFile(p, bytes) { entries.set(p, { entry: entry(p, "file"), content: bytes }); },
    async stat(p) { return entries.get(p)?.entry; },
    async remove(p) { entries.delete(p); },
    async readUpTo(p) { const x = entries.get(p); return { entry: x.entry, content: x.content }; },
  };
}
const BOARD = JSON.stringify({ format: "sagebrush-board", version: 1, title: "B", nodes: [{ id: "a", text: "print(1)" }] });
const NOTEBOOK = JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 });
const file = (name, text) => new File([text], name);
const O = { maxBytes: 1 << 20, docMaxBytes: 1 << 20, mode: "python" };
const boards = (ws) => [...ws.entries.values()].filter((x) => x.entry.kind === "board").map((x) => x.entry);

// ---- every board an upload makes waits, in a single-file upload and in a several-file one (the branch the pages
//      never marked), and a notebook beside them doesn't
{
  mode = "ok"; store.clear();
  const ws = workspace();
  const one = await uploadFiles(ws, [file("solo.board.json", BOARD)], "/", O);
  ok(one.made.length === 1 && isPaused(one.made[0].ref), "a board uploaded alone waits for its code to be run", one.made);
  const many = await uploadFiles(ws, [file("a.board.json", BOARD), file("b.board.json", BOARD), file("n.ipynb", NOTEBOOK), file("data.txt", "x")], "/", O);
  const made = many.made.filter((e) => e.kind === "board");
  ok(made.length === 2 && made.every((e) => isPaused(e.ref)), "every board of a several-file upload waits too", made.map((e) => [e.path, isPaused(e.ref)]));
  const nb = many.made.find((e) => e.kind === "notebook");
  ok(!!nb && !isPaused(nb.ref), "a notebook made beside them isn't marked");
}
// ---- Open as… (a converted copy made a board) waits, marked where it is made
{
  mode = "ok"; store.clear();
  const ws = workspace();
  await ws.putFile("/notes.txt", new TextEncoder().encode("hello"));
  const made = await convertCopy(ws, await ws.stat("/notes.txt"), "board", { maxBytes: 1 << 20, mode: "python", asBoard: () => JSON.parse(BOARD) });
  ok(made.kind === "board" && isPaused(made.ref), "a board made from a file by Open as… waits", made);
}
// ---- fail-closed: a mark that can't be written (or isn't kept) means the board isn't made, and is said
for (const m of ["write-throws", "write-lost"]) {
  mode = m; store.clear();
  const ws = workspace();
  const r = await uploadFiles(ws, [file("x.board.json", BOARD), file("n.ipynb", NOTEBOOK)], "/", O);
  ok(boards(ws).length === 0 && !r.made.some((e) => e.kind === "board"), `${m}: the board isn't made (nothing left in the workspace)`, [...ws.entries.keys()]);
  ok(r.refused.some((t) => /x\.board\.json/.test(t) && /couldn't be kept waiting/.test(t)), `${m}: and the upload says why`, r.refused);
  ok(r.made.some((e) => e.kind === "notebook"), `${m}: a notebook in the same upload is still made`);
  const ws2 = workspace();
  await ws2.putFile("/notes.txt", new TextEncoder().encode("hello"));
  let threw = "";
  try { await convertCopy(ws2, await ws2.stat("/notes.txt"), "board", { maxBytes: 1 << 20, mode: "python", asBoard: () => JSON.parse(BOARD) }); } catch (e) { threw = String(e.message); }
  ok(/couldn't be kept waiting/.test(threw) && boards(ws2).length === 0, `${m}: Open as… makes no board either, and says why`, threw);
}
// ---- and if the board made can't be taken away again either: it stays, but waits for this tab's life, and the
//      person is told to delete it
{
  mode = "write-throws"; store.clear();
  const ws = workspace();
  ws.remove = async () => { throw new Error("remove failed"); };
  const r = await uploadFiles(ws, [file("stuck.board.json", BOARD)], "/", O);
  const left = boards(ws);
  ok(left.length === 1 && r.made.length === 0, "the mark and the removal both failing: the board is still there, not reported as made", left.map((e) => e.path));
  ok(r.refused.some((t) => /stuck\.board\.json/.test(t) && /couldn't be removed: delete it/.test(t) && t.includes(left[0].path)), "…the upload says it couldn't be removed, naming it, to delete", r.refused);
  mode = "ok";
  ok(isPaused(left[0].ref) === true && store.size === 0, "…and it waits all the same, for this tab's life (no mark stored)");
}
// ---- fail-closed on reading: a mark that can't be read means waiting; with working storage, a board made here
//      (never marked) runs, and one the person ran is no longer marked
{
  mode = "ok"; store.clear();
  ok(pauseBoard("here") === true && isPaused("here"), "a mark written is read back");
  mode = "read-throws";
  ok(isPaused("here") === true && isPaused("never-marked") === true, "a mark that can't be read means waiting, for any board");
  mode = "ok";
  ok(isPaused("made-here") === false, "with working storage, a board made here (never marked) doesn't wait");
  unpause("here");
  ok(isPaused("here") === false, "and one the person ran (unpause) no longer waits");
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
