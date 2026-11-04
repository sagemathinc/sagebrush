// ci: web-runner order=185 runner=bun
// The reader's copy and another tab (web/share-client/view.ts; astra's B1-COPY-1): the revision a copy's later saves
// are based on is the one its creation wrote.  Another tab's write, made while the copy's data files are fetched or
// between the creation and its read, is never written over: this tab's next save is a conflict, said, and the other
// tab's contents stay, its metadata alone included.  Without one (the control), or with only the store's own envelope
// changed (a journal's mark, no new revision), every save is kept.  The page's own makeCopy and CopyStore (their
// source, transpiled), the real MemoryStore, a workspace with revision-checked writes.
//   bun web/share/test-share-copy-race.mjs
import { readFileSync } from "node:fs";
import { MemoryStore } from "../notebook/stores.js";

let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };

const src = readFileSync(new URL("../share-client/view.ts", import.meta.url), "utf8");
const cut = (from, to) => { const i = src.indexOf(from), j = src.indexOf(to); if (i < 0 || j < i) throw new Error(`view.ts: ${from} not found`); return src.slice(i, j); };
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(cut("  async function makeCopy(", "  // (what a reader writes") + "\nreturn CopyStore;");

const doc = (text, title = "original") => ({ cells: [{ id: "c1", type: "code", code: text, outputs: [] }], mode: "python", metadata: { title } });
// (the stored record, as the workspace keeps one: the content and its envelope, which a write sets)
const stored = (content, rev) => ({ content: { ...structuredClone(content), id: "ref1", name: "ch", updated: Date.now(), rev }, rev });
const codeOf = (d) => d?.cells?.[0]?.code;

// competitor: "fetch" (while the data file is fetched) | "read" (between the creation and its read) | "meta" (there,
// a change of the metadata alone) | "mark" (there, the envelope alone: no new revision) | null
async function run(competitor) {
  const files = new Map(), status = { textContent: "" };
  let release, fetching;
  const held = new Promise((r) => (release = r)), asked = new Promise((r) => (fetching = r));
  let raced = false;
  const other = () => {
    const row = files.get("/Book/ch.ipynb");
    if (competitor === "mark") files.set("/Book/ch.ipynb", { content: { ...row.content, unjournaled: true, j: 0, hash: "" }, rev: row.rev });
    else files.set("/Book/ch.ipynb", stored(competitor === "meta" ? { ...row.content, metadata: { title: "the other tab's" } } : doc("the other tab's"), row.rev + 1));
    raced = true;
  };
  const ws = {
    async stat(p) { return files.get(p); },
    async mkdir(p) { files.set(p, { folder: true }); },
    async create(p, o) { if (files.has(p)) throw new Error("exists"); files.set(p, p.endsWith(".ipynb") ? stored({ mode: "python", ...o.content }, 1) : { content: o.content, rev: 1 }); },
    async read(p) { if (["read", "meta", "mark"].includes(competitor) && !raced) other(); const row = files.get(p); return { content: structuredClone(row.content), rev: row.rev }; },
    async write(p, content, o) { const row = files.get(p); if (o.base !== row.rev) throw Object.assign(new Error("conflict"), { code: "conflict" }); files.set(p, stored(content, row.rev + 1)); return { rev: row.rev + 1 }; },
  };
  const c = { manifest: { title: "Book", files: [{ path: "ch.ipynb" }, { path: "data.csv" }] } };
  const remembered = [];
  const CopyStore = new Function("MemoryStore", "workspace", "folderOf", "c", "OPENABLE", "fetchChecked", "remember", "yours", "textOf", "$", "keyOf", code)(
    MemoryStore, async () => ws, () => "/Book", c, /\.ipynb$/i,
    async () => { fetching(); await held; return new ArrayBuffer(1); },
    (k, at) => remembered.push([k, at]), () => {},
    (d) => JSON.stringify(d.cells.map((x) => x.code)), () => status, (f) => f.path,
  );
  const store = new CopyStore(doc("the book's"), { path: "ch.ipynb" }, null, true);
  const first = store.save(doc("first edit"));
  await asked;
  if (competitor === "fetch") other();
  release();
  await first;
  const afterFirst = status.textContent;
  status.textContent = "";
  await store.save(doc("next edit"));
  return { final: codeOf(files.get("/Book/ch.ipynb").content), title: files.get("/Book/ch.ipynb").content.metadata?.title, rev: files.get("/Book/ch.ipynb").rev, afterFirst, afterNext: status.textContent, copy: store.copy, remembered, data: files.has("/Book/data.csv") };
}

{
  const r = await run(null);
  ok(r.final === "next edit" && r.rev === 2, `no other tab: both edits are kept in the copy (${r.final}, rev ${r.rev})`);
  ok(r.copy?.rev === 2 && r.copy?.at === "/Book/ch.ipynb" && !r.afterFirst && !r.afterNext, `and nothing is said (${JSON.stringify([r.afterFirst, r.afterNext])})`);
  ok(r.data && r.remembered.length === 1, "the data file is copied beside it and the copy remembered");
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
  const r = await run("mark");
  ok(r.final === "next edit" && r.title === "original" && r.copy?.rev === 2 && !r.afterFirst && !r.afterNext, `the store's own envelope changed alone (a journal's mark, no new revision): the copy is adopted, both edits kept (${r.final}, rev ${r.copy?.rev})`);
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
