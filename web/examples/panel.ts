// File > Examples… (U7; U0's menu item): the examples gallery in the app, a lazy chunk (sagebrush-examples-panel.js,
// web/build.ts). The catalog (/examples/index.json) as a list, filtered by kind and by words; the chosen example's
// preview, its own static page (/examples/<kind>/<slug>/, web/build-examples.ts) in an <iframe sandbox=""> that
// allows nothing (A4); "Open a copy" through the one copy path (copy.ts copyExample: A1-A3), then the host opens its
// main file.  Every catalog string reaches the panel as text (textContent), never as HTML.
//
//   const { openExamplesPanel } = await import("/sagebrush-examples-panel.js");
//   await openExamplesPanel({ ws, open: (entry) => ... }, { kind: "notebook" });
import type { Entry, Workspace } from "../workspace/api";
import { copyExample, ExampleError, type Catalog, type CatalogEntry } from "./copy";

export type ExamplesHost = { ws: Workspace; open: (e: Entry) => unknown };
type Kind = "notebook" | "board" | "latex";
const KINDS: [Kind | "all", string][] = [["all", "All"], ["notebook", "Notebooks"], ["board", "Boards"], ["latex", "LaTeX"]];
const MODE: Record<string, string> = { python: "Python", sage: "Sage", magma: "Magma", matlab: "MATLAB" };

const CSS = `
dialog.sb-examples { width: min(1100px, 96vw); height: min(780px, 92vh); padding: 0; border: 1px solid #8884; border-radius: 10px; color: inherit; background: Canvas; }
dialog.sb-examples::backdrop { background: #0006; }
.sb-examples .bar { display: flex; gap: 0.5rem; align-items: center; padding: 0.6rem 0.8rem; border-bottom: 1px solid #8884; }
.sb-examples .bar h2 { margin: 0 0.6rem 0 0; font-size: 1.1rem; }
.sb-examples .bar input { flex: 1; min-width: 6rem; padding: 0.3rem 0.5rem; }
.sb-examples .bar button[aria-pressed="true"] { font-weight: 700; }
.sb-examples .body { display: grid; grid-template-columns: 19rem 1fr; height: calc(100% - 3.2rem); }
.sb-examples ul { list-style: none; margin: 0; padding: 0.3rem; overflow-y: auto; border-right: 1px solid #8884; }
.sb-examples li button { display: block; width: 100%; text-align: left; padding: 0.45rem 0.55rem; border: 0; border-radius: 6px; background: none; color: inherit; cursor: pointer; font: inherit; }
.sb-examples li button[aria-selected="true"], .sb-examples li button:hover { background: #8882; }
.sb-examples li .t { font-weight: 600; display: block; }
.sb-examples li .m { font-size: 0.8rem; opacity: 0.7; }
.sb-examples .show { display: flex; flex-direction: column; min-width: 0; }
.sb-examples .acts { display: flex; gap: 0.6rem; align-items: center; padding: 0.5rem 0.8rem; border-bottom: 1px solid #8884; }
.sb-examples .acts .msg { font-size: 0.9rem; opacity: 0.85; }
.sb-examples iframe { flex: 1; width: 100%; border: 0; background: #fff; }
.sb-examples .empty { padding: 2rem; opacity: 0.7; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
}

/** The catalog, from the site (same origin, no redirect followed). */
export async function loadCatalog(base = "/examples/"): Promise<Catalog> {
  const r = await fetch(`${base}index.json`, { redirect: "error", credentials: "same-origin" });
  if (!r.ok) throw new Error(`the examples' list: ${r.status}`);
  const c = await r.json();
  if (!c || !Array.isArray(c.examples)) throw new Error("the examples' list isn't one");
  return c as Catalog;
}

/** Whether an example matches the words typed (every word, in its title, summary, tags or language). */
export function matches(e: CatalogEntry, words: string): boolean {
  const hay = [e.title, e.summary ?? "", ...(e.tags ?? []), e.mode ?? "", e.kind].join(" ").toLowerCase();
  return words.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** Opens the panel; resolves when it closes. `opts.kind`: the kind shown first. */
export async function openExamplesPanel(host: ExamplesHost, opts: { kind?: Kind; catalog?: Catalog; base?: string } = {}): Promise<void> {
  const base = opts.base ?? "/examples/";
  const dlg = el("dialog", { className: "sb-examples" });
  dlg.setAttribute("aria-label", "Examples");
  dlg.append(el("style", { textContent: CSS }));
  const search = el("input", { type: "search", placeholder: "Search the examples" });
  search.setAttribute("aria-label", "Search the examples");
  const close = el("button", { type: "button", textContent: "Close" });
  const tabs = KINDS.map(([k, label]) => {
    const b = el("button", { type: "button", textContent: label });
    b.dataset.kind = k;
    return b;
  });
  dlg.append(el("div", { className: "bar" }, el("h2", { textContent: "Examples" }), ...tabs, search, close));
  const list = el("ul");
  list.setAttribute("role", "listbox");
  const copyBtn = el("button", { type: "button", textContent: "Open a copy", disabled: true });
  const zipLink = el("a", { textContent: "Download (ZIP)" });
  const msg = el("span", { className: "msg" });
  const frame = el("iframe");
  frame.setAttribute("sandbox", "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = "The example's preview";
  const show = el("div", { className: "show" }, el("div", { className: "acts" }, copyBtn, zipLink, msg), frame);
  dlg.append(el("div", { className: "body" }, list, show));
  document.body.append(dlg);

  let kind: Kind | "all" = opts.kind ?? "all", chosen: CatalogEntry | null = null, busy = false;
  let catalog: Catalog = { examples: [] };
  const done = new Promise<void>((resolve) => dlg.addEventListener("close", () => { dlg.remove(); resolve(); }, { once: true }));
  close.onclick = () => dlg.close();
  dlg.showModal();

  const choose = (e: CatalogEntry | null) => {
    chosen = e;
    for (const b of list.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-selected", String(b.dataset.id === e?.id));
    copyBtn.disabled = !e || busy;
    msg.textContent = "";
    if (!e) {
      frame.removeAttribute("src");
      zipLink.removeAttribute("href");
      return;
    }
    frame.src = `${base}${e.id}/`;
    zipLink.href = `${base}${e.id}/${e.id.split("/")[1]}.zip`;
    zipLink.setAttribute("download", "");
  };
  const render = () => {
    for (const b of tabs) b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
    const shown = catalog.examples.filter((e) => (kind === "all" || e.kind === kind) && matches(e, search.value));
    list.replaceChildren(
      ...shown.map((e) => {
        const b = el("button", { type: "button" }, el("span", { className: "t", textContent: e.title }), el("span", { className: "m", textContent: [e.kind, MODE[e.mode ?? ""] ?? "", ...(e.tags ?? [])].filter(Boolean).join(" · ") }));
        b.dataset.id = e.id;
        b.title = e.summary ?? "";
        b.setAttribute("role", "option");
        b.onclick = () => choose(e);
        return el("li", {}, b);
      }),
    );
    if (!shown.length) list.append(el("li", { className: "empty", textContent: catalog.examples.length ? "No example matches." : "Loading…" }));
    choose(shown.find((e) => e.id === chosen?.id) ?? shown[0] ?? null);
  };
  for (const b of tabs) b.onclick = () => { kind = b.dataset.kind as Kind | "all"; render(); };
  search.oninput = render;
  copyBtn.onclick = async () => {
    if (!chosen || busy) return;
    busy = true;
    copyBtn.disabled = true;
    const e = chosen;
    msg.textContent = `Copying "${e.title}"…`;
    try {
      const r = await copyExample(host.ws, e.id, { catalog, base, progress: (n, of) => { msg.textContent = `Copying "${e.title}": ${n} of ${of} files`; } });
      dlg.close();
      await host.open(r.main);
    } catch (err) {
      msg.textContent = err instanceof ExampleError && err.code === "stopped" ? String(err.message) : `Not copied: ${(err as Error)?.message ?? err}`;
    } finally {
      busy = false;
      copyBtn.disabled = !chosen;
    }
  };
  render();
  try {
    catalog = opts.catalog ?? (await loadCatalog(base));
    render();
  } catch (err) {
    list.replaceChildren(el("li", { className: "empty", textContent: `The examples couldn't be loaded: ${(err as Error)?.message ?? err}` }));
  }
  return done;
}
