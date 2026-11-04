// The cases of web/notebook/test-myst.mjs's part A, in the page (real IndexedDB): "Open as a notebook" for a
// Jupytext MyST .md (web/workspace/upload.ts openableAsFile, convertCopy; web/notebook/myst.js).
import { Workspace } from "../workspace/api";
import { convertCopy, fileHead, openableAsFile } from "../workspace/upload";
import { fromMyst } from "./myst.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const enc = (s) => new TextEncoder().encode(s);
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");
const names = async (w, f) => (await w.list(f)).map((e) => e.path).sort();

export async function run() {
  const CHAPTER = window.CHAPTER; // (the chapter, given by the test page)
  localStorage.clear();
  const w = await Workspace.open({ name: "ws-myst-test", mainName: "main-myst-test" });
  await w.mkdir("/b");
  const md = "/b/09-Improving_DL.md";
  await w.putFile(md, enc(CHAPTER));
  // which: by its first 4 KiB; without them (none read in time), by its name
  check(openableAsFile("09-Improving_DL.md", CHAPTER.slice(0, 4096)) === "notebook", "a MyST .md: opened as a notebook (its first 4 KiB)");
  check(openableAsFile("09-Improving_DL.md", null) === "board", "...its head not read: by its name, as before (a board)");
  check(openableAsFile("README.md", "# A readme\n") === "board", "another .md: as before (a board)");
  check(openableAsFile("x.py", null) === "notebook" && openableAsFile("x.bin", "---") === null, "other names: as openableAs says");
  // the file browser's read of a .md's head: a whole chapter (16 KB, past 4 KiB) read, its first 4 KiB given
  const fh = await fileHead(w, md, 1 << 24);
  check(fh !== null && fh.length <= 4096 && fh.startsWith("---\n") && openableAsFile("09-Improving_DL.md", fh) === "notebook", `the file browser's head of a ${CHAPTER.length}-byte chapter: ${fh?.length} characters, a notebook`);
  check((await fileHead(w, "/b/none.md", 1 << 24)) === null, "...of a file not there: none (its name decides)");
  // the copy, made beside it: its cells, its source's sha256, what's said
  let said = "";
  const e1 = await convertCopy(w, await w.stat(md), "notebook", { maxBytes: 1 << 24, mode: "python", myst: fromMyst, said: (m) => { said = m; } });
  const d1 = (await w.read(e1.path)).content;
  check(e1.path === "/b/09-Improving_DL.ipynb", "the copy beside it: " + e1.path);
  check(d1.cells.filter((c) => !c.type || c.type === "code").length === 37 && d1.mode === "sage", "...its 37 code cells, in Sage mode");
  check(d1.metadata?.sagebrush?.source === (await sha(CHAPTER)), "...the .md's sha256 recorded");
  check(said === 'Opened a notebook copy of "09-Improving_DL.md" beside it. The .md isn\'t changed.', "...said: " + said);
  // opened again: the same copy, none made
  said = "";
  const e2 = await convertCopy(w, await w.stat(md), "notebook", { maxBytes: 1 << 24, mode: "python", myst: fromMyst, said: (m) => { said = m; } });
  check(e2.path === e1.path && (await names(w, "/b")).length === 2, "opened again: the same copy, no other made");
  check(said === 'Opened your notebook copy of "09-Improving_DL.md". The .md isn\'t changed.', "...said: " + said);
  // the .md changed: a new copy, the earlier one kept as it was
  await w.putFile(md, enc(CHAPTER.replace("# Improvements on Computations of Discrete Logs", "# Improvements, revised")));
  said = "";
  const e3 = await convertCopy(w, await w.stat(md), "notebook", { maxBytes: 1 << 24, mode: "python", myst: fromMyst, said: (m) => { said = m; } });
  check(e3.path === "/b/09-Improving_DL (2).ipynb", "the .md changed: a new copy, " + e3.path);
  check(said === "The .md changed since your last copy, so this is a new copy; your earlier one is kept.", "...said: " + said);
  check(JSON.stringify((await w.read(e1.path)).content.cells) === JSON.stringify(d1.cells), "...the earlier copy unchanged");
  // a taken name, not a copy of it: never written over
  await w.create("/b/10-Other.ipynb", { content: { mode: "python", cells: [{ id: "k", code: "keep = 1" }] } });
  await w.putFile("/b/10-Other.md", enc(CHAPTER));
  const e4 = await convertCopy(w, await w.stat("/b/10-Other.md"), "notebook", { maxBytes: 1 << 24, mode: "python", myst: fromMyst });
  check(e4.path === "/b/10-Other (2).ipynb" && (await w.read("/b/10-Other.ipynb")).content.cells[0].code === "keep = 1", "a notebook already of that name: kept, the copy beside it");
  check(new TextDecoder().decode((await w.readUpTo(md, 1 << 24)).content).includes("# Improvements, revised"), "the .md itself: never written");
  // another .md: not a notebook
  await w.putFile("/b/README.md", enc("# A readme\n"));
  let err = "";
  try { await convertCopy(w, await w.stat("/b/README.md"), "notebook", { maxBytes: 1 << 24, mode: "python", myst: fromMyst }); } catch (e) { err = String(e?.message ?? e); }
  check(/not a Jupytext MyST notebook/.test(err), "another .md as a notebook: refused, " + err);
  return results;
}
