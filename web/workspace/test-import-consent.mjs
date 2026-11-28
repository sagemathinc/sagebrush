// ci: web-runner order=511 runner=bun
// A board brought in from a file (an upload, a drop, Open as…) waits for the person: "Run this board's code" (the
// interim rule, until design/capabilities.md's gate). The mark is made where every such board is made, in
// web/workspace/upload.ts (uploadFiles and convertCopy), never by the pages that open one, and it fails closed: a mark
// that can't be written means the board isn't made, and one that can't be read means waiting. Driven here against a
// workspace stand-in (removing puts in Trash, as the workspace does) and storage stand-ins whose writes and reads can be
// made to fail. A board is never made unless a mark can be kept: a probe is asked before it is created.
//   bun web/workspace/test-import-consent.mjs
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : "")); if (!c) failures++; };

// (this tab's storage and the site's: each working, or failing to write, or writing nothing, or failing to read)
const stand = () => {
  const store = new Map();
  const s = { store, mode: "ok",
    getItem(k) { if (s.mode === "read-throws") throw new Error("storage unavailable"); return store.get(k) ?? null; },
    // ("marks-fail": the probe is kept, but a board's mark isn't: storage that fills up between the two)
    setItem(k, v) { if (s.mode === "write-throws" || (s.mode === "marks-fail" && k !== "sagebrush-board-paused-probe")) throw new Error("quota"); if (s.mode !== "write-lost") store.set(k, v); },
    removeItem(k) { store.delete(k); } };
  return s;
};
globalThis.sessionStorage = stand();
globalThis.localStorage = stand();
const store = { clear() { sessionStorage.store.clear(); localStorage.store.clear(); }, get size() { return sessionStorage.store.size + localStorage.store.size; } };
// (`mode` sets both: a failure of both is what makes a board unmarkable)
let mode = "ok";
const setMode = (m, local = m) => { mode = m; sessionStorage.mode = m; localStorage.mode = local; };
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
    creates: 0,
    async create(p, { content }) { this.creates++; const e = entry(p, p.endsWith(".board.json") ? "board" : "notebook"); entries.set(p, { entry: e, content }); return e; },
    async putFile(p, bytes) { entries.set(p, { entry: entry(p, "file"), content: bytes }); },
    async stat(p) { return entries.get(p)?.entry; },
    // (as the workspace does: removing puts the entry in Trash, its content and ref kept; only emptying Trash deletes)
    async remove(p) { const x = entries.get(p); entries.delete(p); const at = "/Trash/" + p.slice(p.lastIndexOf("/") + 1); const e = { ...x.entry, path: at }; entries.set(at, { entry: e, content: x.content }); return e; },
    async emptyTrash(paths) { for (const t of paths) entries.delete(t); return paths.length; },
    async readUpTo(p) { const x = entries.get(p); return { entry: x.entry, content: x.content }; },
  };
}
const BOARD = JSON.stringify({ format: "sagebrush-board", version: 1, title: "B", nodes: [{ id: "a", text: "print(1)" }] });
const NOTEBOOK = JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 });
const file = (name, text) => new File([text], name);
const O = { maxBytes: 1 << 20, docMaxBytes: 1 << 20, mode: "python" };
// (boards anywhere, Trash included: a board in Trash, restored, would run)
const boards = (ws) => [...ws.entries.values()].filter((x) => x.entry.kind === "board").map((x) => x.entry);

// ---- every board an upload makes waits, in a single-file upload and in a several-file one (the branch the pages
//      never marked), and a notebook beside them doesn't
{
  setMode("ok"); store.clear();
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
  setMode("ok"); store.clear();
  const ws = workspace();
  await ws.putFile("/notes.txt", new TextEncoder().encode("hello"));
  const made = await convertCopy(ws, await ws.stat("/notes.txt"), "board", { maxBytes: 1 << 20, mode: "python", asBoard: () => JSON.parse(BOARD) });
  ok(made.kind === "board" && isPaused(made.ref), "a board made from a file by Open as… waits", made);
}
// ---- fail-closed: a mark that can't be written (or isn't kept) means the board isn't made, and is said
for (const m of ["write-throws", "write-lost"]) {
  setMode(m); store.clear();
  const ws = workspace();
  const r = await uploadFiles(ws, [file("x.board.json", BOARD), file("n.ipynb", NOTEBOOK)], "/", O);
  ok(ws.creates === 1 && boards(ws).length === 0 && !r.made.some((e) => e.kind === "board"), `${m}: the board is never made (refused before it is created; nothing in the workspace or its Trash)`, { creates: ws.creates, paths: [...ws.entries.keys()] });
  ok(r.refused.some((t) => /x\.board\.json/.test(t) && /couldn't be kept waiting/.test(t)), `${m}: and the upload says why`, r.refused);
  ok(r.made.some((e) => e.kind === "notebook"), `${m}: a notebook in the same upload is still made`);
  const ws2 = workspace();
  await ws2.putFile("/notes.txt", new TextEncoder().encode("hello"));
  let threw = "";
  try { await convertCopy(ws2, await ws2.stat("/notes.txt"), "board", { maxBytes: 1 << 20, mode: "python", asBoard: () => JSON.parse(BOARD) }); } catch (e) { threw = String(e.message); }
  ok(/couldn't be kept waiting/.test(threw) && boards(ws2).length === 0 && ws2.creates === 0, `${m}: Open as… makes no board either (nothing created), and says why`, threw);
}
// ---- this tab's storage can't be written, the site's can: the mark is kept there (every tab: stricter), the board
//      is made and waits, also as a new page of this tab sees it; Run clears both
for (const m of ["write-throws", "write-lost"]) {
  setMode(m, "ok"); store.clear();
  const ws = workspace();
  const r = await uploadFiles(ws, [file("fallback.board.json", BOARD)], "/", O);
  const e = r.made[0];
  ok(e?.kind === "board" && localStorage.store.get("sagebrush-board-paused:" + e.ref) === "1" && sessionStorage.store.size === 0, `${m} in this tab's storage: the mark is kept in the site's storage instead`, [...localStorage.store.keys()]);
  setMode("ok");
  ok(isPaused(e.ref), `${m}: the board waits, as any page reading the storage sees it`);
  unpause(e.ref);
  ok(!isPaused(e.ref) && store.size === 0, `${m}: and Run (unpause) clears the mark from both`);
}
{
  setMode("ok", "read-throws");
  ok(isPaused("never-marked") === true, "the site's storage can't be read: waiting, though this tab's can");
  setMode("ok");
}
// ---- the probe kept, the board's own mark not (storage filling up between the two): the board, once made, is
//      deleted for good (Trash emptied of it: restored, it would run), and the upload says so
{
  setMode("marks-fail"); store.clear();
  const ws = workspace();
  const r = await uploadFiles(ws, [file("late.board.json", BOARD)], "/", O);
  ok(ws.creates === 1 && boards(ws).length === 0 && r.made.length === 0, "a mark failing after the board is made: it is deleted for good, nothing left in Trash", [...ws.entries.keys()]);
  ok(r.refused.some((t) => /late\.board\.json/.test(t) && /so it wasn't made/.test(t)), "…and the upload says why", r.refused);
}
// ---- and if even deleting it fails: it is still there, waits for this page's life, and the person is told where
{
  setMode("marks-fail"); store.clear();
  const ws = workspace();
  ws.emptyTrash = async () => { throw new Error("emptying failed"); };
  const r = await uploadFiles(ws, [file("stuck.board.json", BOARD)], "/", O);
  const left = boards(ws);
  ok(left.length === 1 && left[0].path === "/Trash/stuck.board.json" && r.made.length === 0, "the mark and the deletion both failing: the board is left in Trash, not reported as made", left.map((e) => e.path));
  ok(r.refused.some((t) => /stuck\.board\.json/.test(t) && /\(\/Trash\/stuck\.board\.json\) couldn't be deleted: delete it/.test(t)), "…the upload names where it is, to delete", r.refused);
  setMode("ok");
  ok(isPaused(left[0].ref) === true && store.size === 0, "…and it waits all the same, for this page's life (no mark stored)");
}
// ---- fail-closed on reading: a mark that can't be read means waiting; with working storage, a board made here
//      (never marked) runs, and one the person ran is no longer marked
{
  setMode("ok"); store.clear();
  ok(pauseBoard("here") === true && isPaused("here"), "a mark written is read back");
  setMode("read-throws");
  ok(isPaused("here") === true && isPaused("never-marked") === true, "a mark that can't be read means waiting, for any board");
  setMode("ok");
  ok(isPaused("made-here") === false, "with working storage, a board made here (never marked) doesn't wait");
  unpause("here");
  ok(isPaused("here") === false, "and one the person ran (unpause) no longer waits");
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
