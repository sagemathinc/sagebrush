// The copy path's cases (web/examples/copy.ts; plan-examples-gallery A1-A3), run in a page on a real workspace
// (IndexedDB) against the examples test-examples-copy.mjs serves: window.run() -> [[ok, what], ...].
import { W, C, P } from "./bundle.js";

const enc = new TextEncoder();
const sha = async (b) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function run() {
  const out = [];
  const check = (ok, what) => out.push([!!ok, what]);
  const ws = await W.Workspace.open({ name: "examples-copy-" + Math.random().toString(36).slice(2) });
  const catalog = await (await fetch("/examples/index.json")).json();
  const paths = async (under = "/Examples") => {
    const all = [];
    const walk = async (d) => {
      for (const e of await ws.list(d).catch(() => [])) {
        all.push(e.path);
        if (e.kind === "folder") await walk(e.path);
      }
    };
    await walk(under);
    return all.sort();
  };
  const refused = async (id, code, what, o = {}) => {
    const before = JSON.stringify(await paths("/"));
    let err = null;
    try {
      await C.copyExample(ws, id, { catalog, ...o });
    } catch (e) {
      err = e;
    }
    check(err instanceof C.ExampleError && err.code === code, `${what}: refused, ${code} (${err?.code}: ${err?.message})`);
    check(JSON.stringify(await paths("/")) === before, `${what}: the workspace is unchanged`);
  };

  // ---- copies
  const nb = await C.copyExample(ws, "notebook/hello-python", { catalog });
  check(nb.root === "/Examples/Hello, Python" && nb.main.kind === "notebook" && nb.main.path === "/Examples/Hello, Python/main.ipynb", "a notebook: a new folder named by its title, main a notebook: " + nb.root + " " + nb.main.path);
  check(nb.main.made === "elsewhere", "a copy is made: elsewhere (A3)");
  const doc = (await ws.read(nb.main.path)).content;
  check(Array.isArray(doc.cells) && doc.cells.some((c) => /2\*\*100/.test(c.code ?? "")), "its cells are the example's");
  const again = await C.copyExample(ws, "notebook/hello-python", { catalog });
  check(again.root === "/Examples/Hello, Python (2)", "a second copy: a new folder, never the first one reused: " + again.root);
  const tex = await C.copyExample(ws, "latex/article", { catalog });
  const texBytes = (await ws.readUpTo(tex.main.path, 1 << 20)).content;
  const served = new Uint8Array(await (await fetch("/raw/latex/article/main.tex")).arrayBuffer());
  check(tex.main.kind === "file" && (await sha(texBytes)) === (await sha(served)), "a LaTeX document: main.tex a data file, byte for byte the example's");
  const board = await C.copyExample(ws, "board/hello", { catalog });
  check(board.main.kind === "board", "a board: a board");
  const deep = await C.copyExample(ws, "notebook/deep", { catalog });
  check(JSON.stringify(deep.made.map((e) => e.path)) === JSON.stringify(["/Examples/Deep", "/Examples/Deep/data", "/Examples/Deep/data/more", "/Examples/Deep/main.ipynb", "/Examples/Deep/data/a.txt", "/Examples/Deep/data/more/b.csv"]), "folders first, then the files, in files.json's order: " + deep.made.map((e) => e.path));

  // ---- A1: refused before anything is written
  await refused("notebook/nope", "unknown", "an id the catalog doesn't name");
  await refused("notebook/..%2f..", "unknown", "an encoded ..");
  await refused("../notebook/hello-python", "unknown", "a relative id");
  await refused("notebook/bad-hash", "invalid", "a file whose bytes aren't files.json's sha256");
  await refused("notebook/bad-catalog", "invalid", "a files.json that isn't the one the catalog names");
  await refused("notebook/bad-member", "invalid", "a ZIP member named other than files.json says");
  await refused("notebook/dotdot", "invalid", "a .. path");
  await refused("notebook/absolute", "invalid", "an absolute path");
  await refused("notebook/backslash", "invalid", "a backslash path");
  await refused("notebook/collide", "invalid", "two paths the same but for case");
  await refused("notebook/nfc", "invalid", "a path not in NFC");
  await refused("notebook/main-missing", "invalid", "main not among the files");
  await refused("notebook/main-kind", "invalid", "main not of the example's kind");
  await refused("notebook/too-big", "invalid", "more than 2 MiB");
  await refused("notebook/not-ipynb", "invalid", "an .ipynb that isn't a notebook");
  await refused("notebook/redirect", "fetch", "a files.json that redirects (to another origin)");
  const esc = await C.copyExample(ws, "notebook/escape-title", { catalog });
  check(/^\/Examples\/[^/]+$/.test(esc.root) && !esc.root.split("/").includes("..") && esc.made.every((e) => e.path.startsWith(esc.root)), "a title with slashes and dots: one folder under /Examples, everything inside it: " + esc.root);

  // ---- A2: create-only into a reserved root
  // (an existing root: never reused, its files byte-identical)
  await ws.mkdir("/Examples/Pair");
  await ws.create("/Examples/Pair/keep.txt", { content: enc.encode("mine") });
  const pair = await C.copyExample(ws, "notebook/pair", { catalog });
  check(pair.root === "/Examples/Pair (2)", "an existing root: the next name: " + pair.root);
  check(new TextDecoder().decode((await ws.readUpTo("/Examples/Pair/keep.txt", 100)).content) === "mine", "and the existing folder's file is as it was");
  // (two copies of the same title at once: two folders, both whole)
  const [x, y] = await Promise.all([C.copyExample(ws, "notebook/pair", { catalog }), C.copyExample(ws, "notebook/pair", { catalog })]);
  check(new Set([x.root, y.root]).size === 2 && x.made.length === 3 && y.made.length === 3, "two copies at once: two folders, each whole: " + x.root + " | " + y.root);
  // (the root replaced between two creates: the copy stops; nothing goes into the replacement)
  {
    let err = null, root = null;
    try {
      await C.copyExample(ws, "notebook/pair", {
        catalog,
        progress: async (made) => {
          if (made !== 1) return;
          root = "/Examples/Pair (5)";
          await ws.rename(root, "/Examples/Pair (5) moved");
          await ws.mkdir(root);
        },
      });
    } catch (e) {
      err = e;
    }
    check(err?.code === "stopped" && /was moved or replaced/.test(err.message) && /incomplete/.test(err.message), "the root replaced mid-copy: stopped, said incomplete: " + err?.message);
    check(JSON.stringify(await paths(root)) === "[]", "nothing was written into the replacement");
    check(JSON.stringify(await paths("/Examples/Pair (5) moved")) === JSON.stringify(["/Examples/Pair (5) moved/main.ipynb"]), "what was copied stays, under its name (moved by the test, not by the copy)");
  }
  // (a nested folder replaced while the root stays)
  {
    let err = null;
    try {
      await C.copyExample(ws, "notebook/deep", {
        catalog,
        progress: async (made) => {
          if (made !== 2) return;
          await ws.rename("/Examples/Deep (2)/data/more", "/Examples/Deep (2)/data/other");
          await ws.mkdir("/Examples/Deep (2)/data/more");
        },
      });
    } catch (e) {
      err = e;
    }
    check(err?.code === "stopped" && /data\/more was moved or replaced/.test(err.message), "a nested folder replaced: stopped: " + err?.message);
    check(JSON.stringify(await paths("/Examples/Deep (2)/data/more")) === "[]", "nothing written into the nested replacement");
  }
  // (a failure on the second file: something there already; the first stays, the other is untouched)
  {
    let err = null;
    try {
      await C.copyExample(ws, "notebook/pair", {
        catalog,
        progress: async (made) => {
          if (made === 1) await ws.create("/Examples/Pair (6)/notes.txt", { content: enc.encode("theirs") });
        },
      });
    } catch (e) {
      err = e;
    }
    check(err?.code === "stopped" && /notes\.txt is there already/.test(err.message), "a failure on the second file: stopped: " + err?.message);
    check(new TextDecoder().decode((await ws.readUpTo("/Examples/Pair (6)/notes.txt", 100)).content) === "theirs", "the file that was there is byte-identical");
    check(JSON.stringify(err?.copied?.made) === JSON.stringify(["/Examples/Pair (6)", "/Examples/Pair (6)/main.ipynb"]), "the error says what was copied: " + JSON.stringify(err?.copied));
  }

  // ---- the panel (A4 in its own embedding: every catalog string is text)
  {
    let opened = null;
    const closed = P.openExamplesPanel({ ws, open: (e) => { opened = e; } }, { kind: "notebook" });
    const dlg = document.querySelector("dialog.sb-examples");
    for (let i = 0; i < 100 && !dlg.querySelector('button[data-id="notebook/hello-python"]'); i++) await new Promise((r) => setTimeout(r, 20));
    check(dlg?.open, "the panel opens as a modal dialog");
    const ids = () => [...dlg.querySelectorAll("li button")].map((b) => b.dataset.id);
    check(ids().length > 3 && ids().every((id) => id.startsWith("notebook/")), "opened on notebooks: " + ids().length);
    const evil = dlg.querySelector('button[data-id="notebook/evil-title"]');
    check(evil && evil.querySelector(".t").textContent.startsWith("</script><img") && !dlg.querySelector("img") && !dlg.querySelector("li b") && !dlg.querySelector("li i") && window.pwned === undefined, "a title, summary and tag with markup are text in the panel: no element made, no script run");
    const frame = dlg.querySelector("iframe");
    check(frame.getAttribute("sandbox") === "" && /^\/examples\/notebook\/[a-z0-9-]+\/$/.test(frame.getAttribute("src") ?? ""), "the preview is the example's page, in an <iframe sandbox=\"\">: " + frame.getAttribute("sandbox") + " " + frame.getAttribute("src"));
    dlg.querySelector('button[data-kind="board"]').click();
    check(ids().length >= 1 && ids().every((id) => id.startsWith("board/")), "the Boards tab: boards only: " + ids());
    dlg.querySelector('button[data-kind="all"]').click();
    const search = dlg.querySelector("input[type=search]");
    search.value = "pair";
    search.dispatchEvent(new Event("input"));
    check(JSON.stringify(ids()) === JSON.stringify(["notebook/pair"]), "a search narrows the list: " + ids());
    search.value = "";
    search.dispatchEvent(new Event("input"));
    dlg.querySelector('button[data-id="board/hello"]').click();
    check(frame.getAttribute("src") === "/examples/board/hello/" && dlg.querySelector(".acts a").getAttribute("href") === "/examples/board/hello/hello.zip", "choosing one shows its page and its ZIP");
    dlg.querySelector(".acts button").click();
    await closed;
    check(opened?.kind === "board" && /^\/Examples\/Hello, board/.test(opened.path) && !document.querySelector("dialog.sb-examples"), "Open a copy: copied, the panel closed, the host told to open its main: " + opened?.path);
  }
  return out;
}
