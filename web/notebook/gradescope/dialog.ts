// File ▸ Download ▸ PDF for Gradescope… (a lazy chunk, sagebrush-gradescope.js, web/build.ts): the student's dialog.
// It finds the assignment's exercises (the notebook's saved outline, else the headings), measures each against its
// pages, says what to look at first (preflight.ts), and makes the print view (render.ts) for the browser's Save as PDF.
// Nothing blocks saving: an exercise too long for its pages is named, with how much and a way to go to it, and the
// student may still save a PDF of variable length, which says so on its cover.
//
//   const { openGradescope } = await import("/sagebrush-gradescope.js");
//   openGradescope({ nb, title: docName() });

import { outlineFor, sections, type Cell, type Outline } from "./outline";
import { findings, studentInfo, type CellState } from "./preflight";
import { build, fits, measure, printView, type Item, type LiveCell } from "./render";
import type { Mode } from "./layout";

/** The notebook (web/notebook/notebook.js), as this dialog uses it. */
export interface NotebookApi {
  cells(): LiveCell[];
  snapshot(): { cells: Cell[]; metadata?: Record<string, unknown> };
  select(cell: LiveCell): void;
  renderMd(cell: LiveCell): Promise<void>;
  setMeta?(patch: Record<string, unknown>): void;
}
export interface Host {
  nb: NotebookApi;
  title: string;
  /** The template dialog (step 3), for an instructor; absent where it isn't offered. */
  openTemplate?: () => void;
  /** (tests) instead of window.print() */
  print?: () => void | Promise<void>;
}

const CSS = `
dialog.gs-dlg { width: min(640px, 94vw); max-height: 90vh; padding: 0; border: 1px solid #8884; border-radius: 10px; color: inherit; background: Canvas; }
dialog.gs-dlg::backdrop { background: #0006; }
.gs-dlg form { display: flex; flex-direction: column; gap: 12px; padding: 16px 18px; }
.gs-dlg h2 { margin: 0; font-size: 1.15rem; }
.gs-dlg .sub { margin: 0; opacity: .8; font-size: .92rem; }
.gs-dlg label { display: grid; grid-template-columns: 8.5em 1fr; align-items: center; gap: 8px; }
.gs-dlg input[type=text] { font: inherit; padding: 4px 6px; }
.gs-dlg table { border-collapse: collapse; width: 100%; font-size: .93rem; }
.gs-dlg td, .gs-dlg th { text-align: left; padding: 3px 6px; border-bottom: 1px solid #8883; }
.gs-dlg td.ok { color: #15803d; } .gs-dlg td.bad { color: #b42318; font-weight: 600; }
.gs-dlg ul { margin: 0; padding-left: 1.2em; } .gs-dlg li { margin: 3px 0; }
.gs-dlg .over { border: 1.5px solid #b42318; border-radius: 6px; padding: 8px 10px; }
.gs-dlg .note { font-size: .88rem; opacity: .85; margin: 0; }
.gs-dlg .acts { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.gs-dlg button { font: inherit; padding: 5px 12px; border-radius: 6px; cursor: pointer; }
.gs-dlg button.primary { font-weight: 600; }
.gs-dlg button.link { border: 0; background: none; padding: 0 2px; color: LinkText; text-decoration: underline; }
`;
let styled = false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
}

/** What the page shows of a code cell: run or not, changed since, an error, something interactive. */
function stateOf(c: LiveCell, snap: Cell | undefined): CellState {
  const out = c.out;
  return {
    ran: !!out.firstElementChild || (snap?.n != null && snap.n !== ""),
    // (a notebook just opened marks every cell edited until it runs: its outputs are the saved ones, "stale", which is
    // no reason to warn)
    edited: c.el.classList.contains("edited") && !c.el.classList.contains("stale"),
    error: c.el.classList.contains("error") || !!out.querySelector("pre .e"),
    interactive: !!out.querySelector(".interact, figure.plot3d, figure.plotgraph, .sb-anim"),
  };
}

const STAGE_NOTE = ["fits", "fits, pictures smaller", "fits, text smaller", "fits, text smaller"];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export async function openGradescope(host: Host): Promise<void> {
  if (!styled) document.head.append(Object.assign(document.createElement("style"), { textContent: CSS }));
  styled = true;
  document.querySelector("dialog.gs-dlg")?.remove();
  const dlg = document.body.appendChild(el("dialog", { className: "gs-dlg" }));
  dlg.setAttribute("aria-label", "PDF for Gradescope");
  const form = dlg.appendChild(el("form", { method: "dialog" }));
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", () => dlg.remove());
  const status = el("p", { className: "sub", textContent: "Measuring the exercises…" });
  form.append(el("h2", { textContent: "PDF for Gradescope" }), status);
  dlg.showModal();

  const snap = host.nb.snapshot();
  const found = outlineFor(snap);
  const templateLink = () => (host.openTemplate ? [el("button", { type: "button", className: "link", textContent: "Set up the pages (instructors)…", onclick: () => { close(); host.openTemplate!(); } })] : []);
  if (!found.outline) {
    status.textContent = "This notebook has no exercises to lay out: each starts at a Markdown heading such as “Exercise 1.” or “Question 2:”, or the instructor sets them up.";
    form.append(el("div", { className: "acts" }, ...templateLink(), el("button", { type: "button", textContent: "Close", onclick: close })));
    return;
  }
  const outline: Outline = found.outline;
  const live = new Map(host.nb.cells().map((c) => [c.id, c]));
  const { sections: secs, missing } = sections(snap.cells, outline.exercises);
  // (Markdown being edited is shown as it renders: the PDF has its rendered text)
  for (const s of secs) for (const c of s.cells) {
    const l = live.get(c.id);
    if (l && c.type === "markdown" && !l.el.classList.contains("rendered")) await host.nb.renderMd(l);
  }
  let measured;
  try {
    measured = await measure(secs, live, outline.paper);
  } catch (e) {
    status.textContent = `The exercises couldn't be measured: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
    form.append(el("div", { className: "acts" }, el("button", { type: "button", textContent: "Close", onclick: close })));
    return;
  }
  const fitted = fits(measured, outline.paper);
  const at = new Map(secs.map((s, i) => [s.exercise.id, i]));
  const items: Item[] = outline.exercises.map((e) => (at.has(e.id) ? { title: e.title, budget: e.pages, ex: measured[at.get(e.id)!], fit: fitted[at.get(e.id)!] } : { title: e.title, budget: e.pages, ex: null, fit: null }));
  const snapById = new Map(snap.cells.map((c) => [c.id, c]));
  const goTo = (id: string) => () => { close(); const c = live.get(id); if (c) host.nb.select(c); };

  // the student's name and collaborators, as the front matter has them
  const info = studentInfo(snap.cells, secs[0]?.exercise.cell);
  const name = el("input", { type: "text", value: info.name, placeholder: "Your name", autocomplete: "name" });
  const collab = el("input", { type: "text", value: info.collaborators, placeholder: "None" });
  const total = 1 + outline.exercises.reduce((a, e) => a + e.pages, 0);
  status.textContent = `${outline.exercises.length === 1 ? "1 exercise" : `${outline.exercises.length} exercises`}, ${plural(total, "page")} on ${outline.paper === "a4" ? "A4" : "Letter"} paper: page 1 has your name, then each exercise has its own pages.${found.source === "detected" ? " (Found from the headings: the instructor hasn't set the pages up, so each exercise has one.)" : ""}`;
  form.append(el("label", {}, "Name", name), el("label", {}, "Collaborators", collab));

  const table = el("table", {}, el("tr", {}, el("th", { textContent: "Exercise" }), el("th", { textContent: "Pages" }), el("th", { textContent: "" })));
  items.forEach((it) => {
    const ok = !it.ex || it.fit!.fits;
    const what = !it.ex ? "heading not found" : ok ? STAGE_NOTE[it.fit!.stage] : `about ${plural(it.fit!.over, "page")} too long`;
    table.append(el("tr", {}, el("td", { textContent: it.title }), el("td", { textContent: String(it.budget) }), el("td", { className: ok && it.ex ? "ok" : "bad", textContent: what })));
  });
  form.append(table);

  // (the name's finding follows the field as it is typed in)
  const list = findings(secs, missing, (id) => { const c = live.get(id); return c ? stateOf(c, snapById.get(id)) : undefined; }, "-");
  const findingsBox = el("div");
  const showFindings = () => {
    const now = name.value.trim() ? list : [...findings([], [], () => undefined, ""), ...list];
    findingsBox.replaceChildren(...(now.length ? [el("p", { className: "sub", textContent: "Before you save:" }), el("ul", {}, ...now.map((f) => el("li", {}, f.text, " ", f.cell ? el("button", { type: "button", className: "link", textContent: "Fix it", onclick: goTo(f.cell) }) : f.kind === "name" ? el("button", { type: "button", className: "link", textContent: "Fix it", onclick: () => name.focus() }) : "")))] : []));
  };
  name.addEventListener("input", showFindings);
  showFindings();
  form.append(findingsBox);

  const over = items.filter((it) => it.ex && !it.fit!.fits);
  const pagesNote = el("p", { className: "note" });
  const save = async (mode: Mode) => {
    const doc = { title: host.title, name: name.value.trim(), collaborators: collab.value.trim() || "none", date: new Date().toLocaleDateString(), paper: outline.paper, mode };
    const r = build(doc, items);
    if ("error" in r) { pagesNote.textContent = r.error; return; }
    close();
    await printView(r.el, outline.paper, host.print);
  };
  if (over.length) {
    const first = over[0];
    form.append(el("div", { className: "over" },
      `${first.title} is about ${plural(first.fit!.over, "page")} longer than its ${plural(first.budget, "page")}${over.length > 1 ? ` (and ${plural(over.length - 1, "more exercise")})` : ""}. Shorten its output (print less, make pictures smaller), then save. `,
      el("button", { type: "button", className: "link", textContent: "Fix it", onclick: goTo(first.ex!.first) }),
      el("p", { className: "note", textContent: "Or save it anyway: the PDF then has as many pages as it needs, and in Gradescope you match each question to its pages yourself." })));
  }
  pagesNote.textContent = over.length ? "" : `In the print dialog, choose Save as PDF and keep the default settings (margins Default, scale 100%). Your PDF should have ${plural(total, "page")}: upload it to Gradescope as it is.`;
  form.append(pagesNote);
  const acts = el("div", { className: "acts" }, ...templateLink(), el("button", { type: "button", textContent: "Cancel", onclick: close }));
  if (over.length) acts.append(el("button", { type: "button", textContent: "Save anyway (variable length)", onclick: () => void save("variable") }));
  else acts.append(el("button", { type: "button", className: "primary", textContent: "Save PDF…", onclick: () => void save("fixed") }));
  form.append(acts);
}
