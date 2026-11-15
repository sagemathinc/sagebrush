// File ▸ Gradescope template… (the same chunk as the student's dialog, sagebrush-gradescope.js): the instructor's side.
// The handout's exercises (its saved outline, else the headings), each with its page budget, which the instructor
// adjusts, renames, merges into the one before or splits at the selected cell; Save outline writes them into the
// notebook's metadata, so every student's copy carries them.  The template PDF is the handout itself (no outputs) in
// exactly the students' layout, and the page list is the text for Gradescope's outline.

import { detect, headingOf, headingText, LIMITS, outlineFor, outlineHash, readOutline, sections, withOutline, type Exercise, type Outline, type Paper } from "./outline";
import { build, contentPages, fits, measure, printView, type Item } from "./render";
import type { Host } from "./dialog";
import { dialogStyle, el, plural } from "./ui";

const CSS = `
dialog.gs-tpl { width: min(720px, 95vw); max-height: 92vh; }
.gs-tpl td input[type=text] { width: 100%; box-sizing: border-box; }
.gs-tpl td input[type=number] { width: 4.2em; }
.gs-tpl pre.list { margin: 0; padding: 8px 10px; border: 1px solid #8884; border-radius: 6px; font-size: .88rem; white-space: pre-wrap; max-height: 10em; overflow: auto; }
.gs-tpl .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.gs-tpl .row .grow { flex: 1; }
.gs-tpl label.paper { display: flex; gap: 8px; align-items: center; }
`;
let styled = false;
const same = (a: Outline | null, b: Outline | null) => (a && b ? outlineHash(a) === outlineHash(b) && JSON.stringify(a.exercises.map((e) => e.title)) === JSON.stringify(b.exercises.map((e) => e.title)) : a === b);

export async function openTemplate(host: Host): Promise<void> {
  dialogStyle();
  if (!styled) document.head.append(Object.assign(document.createElement("style"), { textContent: CSS }));
  styled = true;
  document.querySelector("dialog.gs-dlg")?.remove();
  const dlg = document.body.appendChild(el("dialog", { className: "gs-dlg gs-tpl" }));
  dlg.setAttribute("aria-label", "Gradescope template");
  const form = dlg.appendChild(el("form", { method: "dialog" }));
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", () => dlg.remove());
  const status = el("p", { className: "sub" });
  form.append(el("h2", { textContent: "Gradescope template" }), status);
  dlg.showModal();

  const nb = host.nb;
  const doc = () => nb.snapshot();
  const savedNow = () => { const o = readOutline(doc().metadata); return o && !("error" in o) ? o : null; };
  let saved = savedNow();
  const found = outlineFor(doc());
  let paper: Paper = found.outline?.paper ?? "letter";
  // (budgets not chosen yet: those of an outline found from the headings, set to the content's pages plus one)
  let rows: Exercise[] = (found.outline?.exercises ?? []).map((e) => ({ ...e }));
  let fresh = found.source !== "saved";
  const contentOf = new Map<string, number>();

  const paperSel = el("select", {}, el("option", { value: "letter", textContent: "Letter" }), el("option", { value: "a4", textContent: "A4" }));
  paperSel.value = paper;
  const table = el("table");
  const list = el("pre", { className: "list" });
  const advice = el("p", { className: "note", textContent: "Each exercise gets the pages the handout takes, plus one for the answer. Give an exercise whose answer prints long output or a figure two more." });
  const note = el("p", { className: "note" });
  const saveBtn = el("button", { type: "button", className: "primary", textContent: "Save outline" });
  const removeBtn = el("button", { type: "button", textContent: "Remove outline" });
  const pdfBtn = el("button", { type: "button", textContent: "Template PDF…" });
  const copyBtn = el("button", { type: "button", className: "link", textContent: "Copy" });
  const addBtn = el("button", { type: "button", textContent: "Start an exercise at the selected cell" });
  const detectBtn = el("button", { type: "button", textContent: "Find from headings again" });
  form.append(
    el("div", { className: "row" }, el("label", { className: "paper" }, "Paper", paperSel), el("span", { className: "grow" }), detectBtn, addBtn),
    table,
    advice,
    el("div", { className: "row" }, el("span", { className: "grow", textContent: "Page list, for the assignment's outline in Gradescope:" }), copyBtn),
    list, note,
    el("div", { className: "acts" }, el("button", { type: "button", textContent: "Close", onclick: close }), removeBtn, pdfBtn, saveBtn),
  );

  const outline = (): Outline | null => (rows.length ? { v: 1, paper, exercises: rows.map((e) => ({ ...e })) } : null);
  const live = () => new Map(nb.cells().map((c) => [c.id, c]));

  // (the handout's own pages per exercise, without outputs; a fresh outline's budgets follow them)
  async function remeasure() {
    const o = outline();
    contentOf.clear();
    if (!o) return;
    const { sections: secs } = sections(doc().cells, o.exercises);
    const measured = await measure(secs, live(), paper, { outputs: false });
    secs.forEach((s, i) => contentOf.set(s.exercise.id, contentPages(measured[i], paper)));
    if (fresh) for (const e of rows) e.pages = Math.min(LIMITS.pages, Math.max(1, (contentOf.get(e.id) ?? 0) + 1));
  }

  function draw() {
    const o = outline();
    table.replaceChildren(el("tr", {}, el("th", { textContent: "Exercise" }), el("th", { textContent: "Pages" }), el("th", { textContent: "Handout takes" }), el("th")));
    rows.forEach((e, i) => {
      const title = el("input", { type: "text", value: e.title, maxLength: LIMITS.title });
      title.setAttribute("aria-label", `Exercise ${i + 1}'s title`);
      title.addEventListener("input", () => { e.title = title.value.trim() || e.title; drawList(); });
      const pages = el("input", { type: "number", min: "1", max: String(LIMITS.pages), value: String(e.pages) });
      pages.setAttribute("aria-label", `${e.title}'s pages`);
      pages.addEventListener("input", () => { const n = Math.round(Number(pages.value)); if (n >= 1 && n <= LIMITS.pages) { e.pages = n; fresh = false; drawList(); } });
      const c = contentOf.get(e.id);
      const go = el("button", { type: "button", className: "link", textContent: "Go to", onclick: () => { close(); const l = live().get(e.cell); if (l) nb.select(l); } });
      const merge = el("button", { type: "button", className: "link", textContent: i ? "Merge up" : "Remove", title: i ? "Its cells join the exercise before" : "Its cells are left out of the PDF, as the front matter is", onclick: () => { rows.splice(i, 1); void redraw(); } });
      table.append(el("tr", {}, el("td", {}, title), el("td", {}, pages), el("td", { textContent: c === undefined ? "heading not found" : plural(c, "page") }), el("td", {}, go, " ", merge)));
    });
    drawList();
    removeBtn.hidden = !saved;
    saveBtn.disabled = pdfBtn.disabled = !o;
  }
  function drawStatus() {
    const total = 1 + rows.reduce((a, e) => a + e.pages, 0);
    status.textContent = !rows.length
      ? "No exercises yet: each starts at a Markdown heading such as “Exercise 1.” or “Question 2:”, or at a cell you select and add here."
      : `${plural(rows.length, "exercise")}, ${plural(total, "page")} on ${paper === "a4" ? "A4" : "Letter"} paper: page 1 is the student's name, then each exercise has its pages. Every student's PDF has exactly these pages.`;
  }
  // (the status line, the page list and the saved note follow every change of a title or a budget)
  function drawList() {
    drawStatus();
    const o = outline();
    const total = 1 + rows.reduce((a, e) => a + e.pages, 0);
    let at = 2;
    list.textContent = o ? ["Name: page 1", ...rows.map((e) => { const first = at; at += e.pages; return `${e.title}: ${e.pages === 1 ? `page ${first}` : `pages ${first}–${at - 1}`}`; })].join("\n") + `\n(${plural(total, "page")})` : "";
    note.textContent = !o ? "" : same(o, saved) ? `Saved in this notebook (layout ${o.v}·${outlineHash(o)}): every copy made from it now has these pages.` : saved ? "Changed since it was saved: Save outline, then hand it out again. Copies made before keep the pages they had." : "Not saved yet: Save outline before you hand the notebook out, so every copy has these pages.";
  }
  async function redraw() {
    status.textContent = "Measuring the exercises…";
    await remeasure();
    draw();
  }

  paperSel.addEventListener("change", () => { paper = paperSel.value === "a4" ? "a4" : "letter"; void redraw(); });
  detectBtn.addEventListener("click", () => {
    const keep = new Map(rows.map((e) => [e.cell, e]));
    rows = detect(doc().cells).map((e) => ({ ...e, ...(keep.has(e.cell) ? { title: keep.get(e.cell)!.title, pages: keep.get(e.cell)!.pages } : {}) }));
    fresh = !rows.some((e) => keep.has(e.cell));
    void redraw();
  });
  addBtn.addEventListener("click", () => {
    const cell = (nb as { active?: { id: string } | null }).active;
    const cells = doc().cells;
    const at = cell ? cells.findIndex((c) => c.id === cell.id) : -1;
    if (at < 0) { status.textContent = "Select a cell in the notebook first (click it), then choose this again."; return; }
    if (rows.some((e) => e.cell === cell!.id)) { status.textContent = "An exercise already starts at the selected cell."; return; }
    if (rows.length >= LIMITS.exercises) return;
    const c = cells[at];
    const hd = c.type === "markdown" ? headingOf(c.code) : null;
    const ids = new Set(rows.map((e) => e.id));
    let id = hd ? `${hd.kind.toLowerCase()}-${hd.num}` : `part-${rows.length + 1}`;
    for (let k = 2; ids.has(id); k++) id = `${id.replace(/-\d+$/, "")}-${k}`;
    const title = (hd ? `${hd.kind} ${hd.num}` : (c.type === "markdown" ? headingText(c.code) : "") || `Exercise ${rows.length + 1}`).slice(0, LIMITS.title);
    const order = new Map(cells.map((x, i) => [x.id, i]));
    rows.push({ id, title, cell: c.id, pages: 1 });
    rows.sort((a, b) => (order.get(a.cell) ?? 1e9) - (order.get(b.cell) ?? 1e9));
    void redraw();
  });
  saveBtn.addEventListener("click", () => {
    const o = outline();
    if (!o || !nb.setMeta) return;
    nb.setMeta({ metadata: withOutline(doc().metadata, o) });
    saved = savedNow();
    fresh = false;
    draw();
  });
  removeBtn.addEventListener("click", () => {
    if (!nb.setMeta) return;
    nb.setMeta({ metadata: withOutline(doc().metadata, null) });
    saved = savedNow();
    draw();
  });
  copyBtn.addEventListener("click", () => { void navigator.clipboard?.writeText(list.textContent ?? "").then(() => (copyBtn.textContent = "Copied"), () => {}); });
  pdfBtn.addEventListener("click", async () => {
    const o = outline();
    if (!o) return;
    const { sections: secs } = sections(doc().cells, o.exercises);
    const measured = await measure(secs, live(), paper, { outputs: false });
    const fitted = fits(measured, paper);
    const at = new Map(secs.map((s, i) => [s.exercise.id, i]));
    const items: Item[] = o.exercises.map((e) => (at.has(e.id) ? { title: e.title, budget: e.pages, ex: measured[at.get(e.id)!], fit: fitted[at.get(e.id)!] } : { title: e.title, budget: e.pages, ex: null, fit: null }));
    const r = build({ title: host.title, name: "", collaborators: "", date: "", paper, mode: "fixed", layout: `${o.v}·${outlineHash(o)}` }, items);
    if ("error" in r) { note.textContent = `${r.error}: give it more pages.`; return; }
    close();
    await printView(r.el, paper, host.print);
  });

  if (found.error) status.textContent = `${found.error[0].toUpperCase()}${found.error.slice(1)}: it is shown as found from the headings.`;
  await redraw();
  if (found.error) note.textContent = `The saved outline couldn't be read (${found.error}); Save outline replaces it.`;
}
