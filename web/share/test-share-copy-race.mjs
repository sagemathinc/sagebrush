// ci: web-runner order=185 runner=bun
// The reader's copy (web/share-client/view.ts), its makeCopy and CopyStore (their source, transpiled, with the page's
// own fetchChecked and folderOf), the real MemoryStore, a workspace with revision-checked writes that refuses a taken
// path, as the real one does.
//   - Another tab (astra's B1-COPY-1): the revision a copy's later saves are based on is the one its creation wrote.
//     Another tab's write, made while the copy's data files are fetched or between the creation and its read, is never
//     written over: this tab's next save is a conflict, said, and the other tab's contents stay, whichever part of the
//     notebook it changed alone (its metadata, a cell's outputs, its language). With none (the control), or with only
//     the store's own envelope changed (a journal's mark, no new revision), every save is kept.
//   - What the copy writes (grader's r3 pins): a data file whose bytes don't match the collection's SHA-256 isn't
//     written, and the reader is told (B3); a data file the reader already has there is kept (B4); a file already at
//     the copy's own path is kept, the copy going to "… (2).ipynb" (B9); the folder is one name made from the title,
//     never "." or ".." (B12); the copy holds none of the book's own id or revision (B10).
//   bun web/share/test-share-copy-race.mjs
import { readFileSync } from "node:fs";
import { MemoryStore } from "../notebook/stores.js";

let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };

const src = readFileSync(new URL("../share-client/view.ts", import.meta.url), "utf8");
const cut = (from, to) => { const i = src.indexOf(from), j = src.indexOf(to, i); if (i < 0 || j < i) throw new Error(`view.ts: ${from} not found`); return src.slice(i, j); };
const T = new Bun.Transpiler({ loader: "ts" });
const code = T.transformSync(cut("  const fetchChecked = ", "  // (what a reader writes") + "\nreturn CopyStore;");
const folderOf = new Function(T.transformSync(cut("const folderOf = ", "\n\nasync function main()") + "\nreturn folderOf;"))();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

const doc = (text, title = "original") => ({ cells: [{ id: "c1", type: "code", code: text, outputs: [] }], mode: "python", metadata: { title } });
// (the stored record, as the workspace keeps one: the content and its envelope, which a write sets)
const stored = (content, rev) => ({ content: { ...structuredClone(content), id: "ref1", name: "ch", updated: Date.now(), rev }, rev });
const codeOf = (d) => d?.cells?.[0]?.code;
const DATA = "x,y\n1,2\n";

// competitor: "fetch" (while the data file is fetched) | "read" (between the creation and its read) | "meta", "outputs",
// "mode" (there, a change of the metadata, a cell's outputs or the language alone) | "mark" (there, the envelope alone:
// no new revision) | null.  o: { title, pre: {path: content}, served (the data file's bytes as served), first (the
// first edit's notebook) }
async function run(competitor, o = {}) {
  const files = new Map(), status = { textContent: "" }, created = [];
  const folder = folderOf(o.title ?? "Book"), path = `${folder}/ch.ipynb`;
  for (const [p, content] of Object.entries(o.pre ?? {})) files.set(p.replace("/Book", folder), p.endsWith(".ipynb") ? stored(content, 1) : { content, rev: 1 });
  let release, fetching;
  const held = new Promise((r) => (release = r)), asked = new Promise((r) => (fetching = r));
  let raced = false;
  const target = () => store.copy?.at ?? [...files.keys()].filter((k) => k.startsWith(folder + "/ch") && k.endsWith(".ipynb")).pop();
  const other = () => {
    const at = target(), row = files.get(at);
    if (competitor === "mark") files.set(at, { content: { ...row.content, unjournaled: true, j: 0, hash: "" }, rev: row.rev });
    else if (competitor === "meta") files.set(at, stored({ ...row.content, metadata: { title: "the other tab's" } }, row.rev + 1));
    else if (competitor === "outputs") files.set(at, stored({ ...row.content, cells: row.content.cells.map((c) => ({ ...c, outputs: [{ output_type: "stream", text: "the other tab's output" }] })) }, row.rev + 1));
    else if (competitor === "mode") files.set(at, stored({ ...row.content, mode: "sage" }, row.rev + 1));
    else files.set(at, stored(doc("the other tab's"), row.rev + 1));
    raced = true;
  };
  const ws = {
    async stat(p) { return files.get(p); },
    async mkdir(p) { if (files.has(p)) throw new Error("exists"); files.set(p, { folder: true }); },
    async create(p, x) { if (files.has(p)) throw new Error(`${p} exists: a taken path is refused`); created.push([p, x.content]); files.set(p, p.endsWith(".ipynb") ? stored({ mode: "python", ...x.content }, 1) : { content: x.content, rev: 1 }); },
    async read(p) { if (["read", "meta", "outputs", "mode", "mark"].includes(competitor) && !raced) other(); const row = files.get(p); return { content: structuredClone(row.content), rev: row.rev }; },
    async write(p, content, x) { const row = files.get(p); if (x.base !== row.rev) throw Object.assign(new Error("conflict"), { code: "conflict" }); files.set(p, stored(content, row.rev + 1)); return { rev: row.rev + 1 }; },
  };
  const c = { manifest: { title: o.title ?? "Book", files: [{ path: "ch.ipynb" }, { path: "data.csv", sha256: await sha(DATA) }] } };
  const served = o.served ?? DATA;
  // (the collection's file server: the data file's bytes, held until the test lets them through)
  const fetchStub = async () => { fetching(); await held; return new Response(served); };
  const remembered = [];
  const CopyStore = new Function("MemoryStore", "workspace", "folderOf", "c", "NOTEBOOK", "fetch", "fileUrl", "hex", "remember", "yours", "textOf", "$", "keyOf", code)(
    MemoryStore, async () => ws, folderOf, c, /\.ipynb$/i, fetchStub, (f) => "https://files.example/" + f.sha256, hex,
    (k, at) => remembered.push([k, at]), () => {},
    (d) => JSON.stringify(d.cells.map((x) => x.code)), () => status, (f) => f.path,
  );
  const store = new CopyStore(doc("the book's"), { path: "ch.ipynb" }, null, true);
  const first = store.save(o.first ?? doc("first edit"));
  // (the data file's fetch, or the save's end where nothing is fetched: the reader already has the file, B4)
  await Promise.race([asked, first]);
  if (competitor === "fetch") other();
  release();
  await first;
  const afterFirst = status.textContent;
  status.textContent = "";
  await store.save(doc("next edit"));
  const at = store.copy?.at ?? path, row = files.get(at);
  return { files, created, path, at, row, final: codeOf(row?.content), title: row?.content.metadata?.title, rev: row?.rev, afterFirst, afterNext: status.textContent, copy: store.copy, remembered, data: files.get(`${folder}/data.csv`) };
}
const bytes = (d) => (d?.content instanceof Uint8Array ? new TextDecoder().decode(d.content) : typeof d?.content === "string" ? d.content : null);

// ---- another tab
{
  const r = await run(null);
  ok(r.final === "next edit" && r.rev === 2, `no other tab: both edits are kept in the copy (${r.final}, rev ${r.rev})`);
  ok(r.copy?.rev === 2 && r.copy?.at === "/Book/ch.ipynb" && !r.afterFirst && !r.afterNext, `and nothing is said (${JSON.stringify([r.afterFirst, r.afterNext])})`);
  ok(bytes(r.data) === DATA && r.remembered.length === 1, "the data file is copied beside it, its bytes checked, and the copy remembered");
}
for (const when of ["fetch", "read"]) {
  const what = when === "fetch" ? "while the data file is fetched" : "between the creation and its read";
  const r = await run(when);
  ok(r.final === "the other tab's", `another tab's write ${what} stays: the next edit doesn't write over it (${r.final})`);
  ok(/another tab/.test(r.afterNext), `the next edit is said not saved (${JSON.stringify(r.afterNext)})`);
  ok(when === "fetch" ? r.copy?.rev === 1 && r.afterFirst === "" : r.copy === null && /another tab/.test(r.afterFirst), `the base is the creation's revision, ${when === "fetch" ? "1, not the other tab's" : "not adopted: the first edit's save is said too"} (${JSON.stringify(r.copy && { rev: r.copy.rev })})`);
  ok(r.data && r.remembered.length === 1, "the data file is still copied and the copy remembered (a reload opens it)");
}
{
  const r = await run("meta");
  ok(r.final === "first edit" && r.title === "the other tab's", `another tab's change of the metadata alone, between the creation and its read, stays: the next edit doesn't write over it (${r.final}, ${r.title})`);
  ok(r.copy === null && /another tab/.test(r.afterFirst) && /another tab/.test(r.afterNext), `…not adopted, and said (${JSON.stringify([r.afterFirst, r.afterNext])})`);
}
{
  // (B19: the cells' outputs are the notebook's too)
  const r = await run("outputs");
  const outs = r.row?.content.cells?.[0]?.outputs ?? [];
  ok(r.final === "first edit" && outs.some((x) => /the other tab's output/.test(x.text)), `another tab's change of a cell's outputs alone stays: its outputs are there, the next edit doesn't write over them (${JSON.stringify(outs)})`);
  ok(r.copy === null && /another tab/.test(r.afterFirst) && /another tab/.test(r.afterNext), `…not adopted, and said (${JSON.stringify([r.afterFirst, r.afterNext])})`);
}
{
  // (B20: and its language)
  const r = await run("mode");
  ok(r.final === "first edit" && r.row?.content.mode === "sage", `another tab's change of the language alone stays: still Sage, the next edit doesn't write over it (${r.row?.content.mode})`);
  ok(r.copy === null && /another tab/.test(r.afterFirst) && /another tab/.test(r.afterNext), `…not adopted, and said (${JSON.stringify([r.afterFirst, r.afterNext])})`);
}
{
  const r = await run("mark");
  ok(r.final === "next edit" && r.title === "original" && r.copy?.rev === 2 && !r.afterFirst && !r.afterNext, `the store's own envelope changed alone (a journal's mark, no new revision): the copy is adopted, both edits kept (${r.final}, rev ${r.copy?.rev})`);
}

// ---- what the copy writes
{
  // (B3: the bytes are checked against the collection's SHA-256 before anything of them is written)
  const r = await run(null, { served: "x,y\n9,9\n" });
  ok(r.data === undefined, `a data file whose bytes don't match the collection's SHA-256 isn't written into the reader's files (${JSON.stringify(bytes(r.data))})`);
  ok(/couldn't be saved: data\.csv could not be loaded/.test(r.afterFirst), `…and the reader is told (${JSON.stringify(r.afterFirst)})`);
}
{
  // (B4: the reader's own file at a data file's path is theirs)
  const r = await run(null, { pre: { "/Book": null, "/Book/data.csv": "the reader's own data" } });
  ok(bytes(r.data) === "the reader's own data", `a data file the reader already has there is kept, never written over (${JSON.stringify(bytes(r.data))})`);
  ok(r.copy?.at === "/Book/ch.ipynb" && r.final === "next edit" && !r.afterFirst, `…and the copy is made beside it (${r.copy?.at}, ${JSON.stringify(r.afterFirst)})`);
}
{
  // (B9: a file already at the copy's own path is kept: the copy is "… (2).ipynb")
  const r = await run(null, { pre: { "/Book": null, "/Book/ch.ipynb": doc("the reader's own ch") } });
  ok(r.copy?.at === "/Book/ch (2).ipynb" && r.final === "next edit" && !r.afterFirst, `with a file already at /Book/ch.ipynb, the copy goes to "/Book/ch (2).ipynb" (${r.copy?.at}, ${JSON.stringify(r.afterFirst)})`);
  ok(codeOf(r.files.get("/Book/ch.ipynb")?.content) === "the reader's own ch" && r.files.get("/Book/ch.ipynb")?.rev === 1, `…and the file already there is unchanged (${codeOf(r.files.get("/Book/ch.ipynb")?.content)})`);
}
{
  // (B12: one folder made from the title: a name, never a path; "." and ".." aren't names)
  const cases = [["Book", "/Book"], ["a/b/../c", "/a b .. c"], ["../../etc", "/.. .. etc"], ["Hello, World! (2024)", "/Hello World 2024"], ["..", "/Shared"], [".", "/Shared"], ["", "/Shared"], ["!!!", "/Shared"], ["/", "/Shared"], ["Ünïcode Bücher", "/Ünïcode Bücher"]];
  const bad = cases.filter(([t, want]) => folderOf(t) !== want).map(([t, want]) => [t, folderOf(t), want]);
  ok(bad.length === 0, `the folder from a title with /, .., punctuation or nothing: one name (${bad.length ? JSON.stringify(bad) : cases.map(([t, w]) => `${JSON.stringify(t)} → ${w}`).join(", ")})`);
  const long = folderOf("x".repeat(59) + " " + "y".repeat(40));
  ok(long.length <= 61 && !long.endsWith(" ") && /^\/[^/]+$/.test(long), `at most 60 characters, no space left at its end (${JSON.stringify(long)})`);
  const r = await run(null, { title: ".." });
  ok(r.copy?.at === "/Shared/ch.ipynb" && !r.afterFirst, `a collection titled ".." is copied to /Shared, not to a path no workspace can hold (${r.copy?.at}, ${JSON.stringify(r.afterFirst)})`);
}
{
  // (B10: the copy is the reader's: none of the book's own id or revision in what is created)
  const r = await run(null, { first: { ...doc("first edit"), id: "the-book's-id", rev: 7 } });
  const nb = r.created.find(([p]) => p.endsWith(".ipynb"))?.[1];
  ok(nb && !("id" in nb) && !("rev" in nb) && codeOf(nb) === "first edit", `the copy is created without the book's id or revision (${JSON.stringify(nb && Object.keys(nb))})`);
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
