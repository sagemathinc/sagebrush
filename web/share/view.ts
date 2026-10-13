// A shared collection's page, /s/<id> (or /s/<id>@<version>): its title,
// license and files, and a notebook of it opened in the page.  Nothing runs
// until the reader presses Run: a shared notebook is someone else's code.
// The collection's files are mounted in the interpreter (web/shims/fs.ts):
// each is fetched from the user-content domain, and checked against its
// SHA-256, the first time the code reads it.  Everything shown here comes
// from the uploader, so it goes into the page as text, never as markup.
import { createNotebook, fromFile, MemoryStore, toIpynb, WorkerKernel } from "../notebook/index.js";

interface File { path: string; sha256: string; size: number }
interface Shared {
  id: string;
  version: string;
  latest: string;
  files_origin: string;
  manifest: { title: string; license?: string; created: string; files: File[] };
}

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const el = (tag: string, text = "", attrs: Record<string, string> = {}) => {
  const e = document.createElement(tag);
  e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const size = (n: number) => (n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(1)} kB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(2)} GB`);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const OPENABLE = /\.(ipynb|py|sage)$/i;

async function main() {
  const m = location.pathname.match(/^\/s\/([a-z2-7]{12})(?:@([0-9a-f]{8,64}))?\/?$/);
  if (!m) return fail("This is not a link to a shared collection.");
  const r = await fetch(`/api/share/c/${m[1]}${m[2] ? `?at=${m[2]}` : ""}`);
  if (!r.ok) return fail(r.status === 404 ? "This collection doesn't exist, or its owner deleted it." : `The collection could not be loaded (HTTP ${r.status}).`);
  const c = (await r.json()) as Shared;
  const fileUrl = (f: File) => new URL(`/b/${f.sha256}`, c.files_origin).href;

  document.title = `${c.manifest.title} — Sagebrush`;
  $("#title").textContent = c.manifest.title;
  const meta = $("#meta");
  meta.append(el("span", `Shared ${c.manifest.created.slice(0, 10)}`));
  if (c.manifest.license) meta.append(el("span", `License: ${c.manifest.license}`));
  meta.append(el("span", `Version ${c.version.slice(0, 12)}`, { title: c.version }));
  if (c.version !== c.latest) {
    const a = el("a", "A newer version exists", { href: `/s/${c.id}` });
    meta.append(a);
  }

  const list = $("#files");
  for (const f of c.manifest.files) {
    const li = document.createElement("li");
    if (OPENABLE.test(f.path)) {
      const b = el("button", f.path, { type: "button", class: "link" });
      b.onclick = () => open(f);
      li.append(b);
    } else li.append(el("span", f.path));
    li.append(el("span", size(f.size), { class: "size" }));
    li.append(el("a", "download", { href: fileUrl(f), class: "dl", download: f.path.split("/").pop()! }));
    list.append(li);
  }

  // one interpreter, with every file of the collection mounted
  const mount = c.manifest.files.map((f) => [f.path, { url: fileUrl(f), sha256: f.sha256, size: f.size }]);
  const kernel = new WorkerKernel({
    createWorker: () => new Worker("/sagebrush-worker.js", { type: "module" }),
    onStart: (w: Worker) => w.postMessage({ mount }),
  });
  let nb: any = null;
  let current: File | null = null;

  async function open(f: File) {
    $("#status").textContent = `opening ${f.path}…`;
    const resp = await fetch(fileUrl(f));
    const bytes = await resp.arrayBuffer();
    if (!resp.ok || hex(await crypto.subtle.digest("SHA-256", bytes)) !== f.sha256) {
      $("#status").textContent = `${f.path} could not be loaded`;
      return;
    }
    let doc;
    try {
      doc = fromFile(f.path, new TextDecoder().decode(bytes));
    } catch (e) {
      $("#status").textContent = String((e as Error).message ?? e);
      return;
    }
    if (!kernel.worker) kernel.start();
    nb ??= createNotebook($("#nb"), { kernel, staleOnLoad: true, assetBase: "/" });
    await nb.attach(new MemoryStore(doc));
    current = f;
    $("#nbbar").hidden = false;
    $("#nbname").textContent = f.path;
    $("#status").textContent = "Nothing has run yet: the outputs are as shared. Run all runs this notebook in your browser.";
    for (const b of list.querySelectorAll("button.link")) b.classList.toggle("on", b.textContent === f.path);
  }

  $("#runall").onclick = () => nb?.runAll();
  $("#stop").onclick = () => nb?.interrupt();
  $("#download").onclick = () => {
    if (!nb || !current) return;
    const a = el("a", "", { href: URL.createObjectURL(new Blob([toIpynb(nb.snapshot())], { type: "application/x-ipynb+json" })), download: current.path.split("/").pop()!.replace(/\.(py|sage)$/i, ".ipynb") });
    a.click();
    URL.revokeObjectURL(a.getAttribute("href")!);
  };
  const first = c.manifest.files.find((f) => /\.ipynb$/i.test(f.path)) ?? c.manifest.files.find((f) => OPENABLE.test(f.path));
  if (first) await open(first);
  (window as any).shared = { c, kernel, get nb() { return nb; } }; // for tests
}

function fail(text: string) {
  $("#title").textContent = "Not found";
  $("#status").textContent = text;
}

main().catch((e) => fail(String(e?.message ?? e)));
