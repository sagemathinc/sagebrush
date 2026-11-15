// ci: web-runner order=598 chrome
// File ▸ Download ▸ PDF for Gradescope… (web/notebook/gradescope) in headless Chromium against the built page, on
// synthetic notebooks only: the PDF Chromium saves from the print view has the template's pages exactly (the cover,
// then each exercise's budget), at the outline's paper size; an exercise longer than its pages is named with how
// much, and saving anyway gives a PDF of variable length that says so on its cover; the preflight names an unrun
// cell, an empty name, and its Fix it goes to the cell; without an outline the headings are found.  The instructor's
// template: budgets default to the handout's pages plus one, are edited, renamed, merged and split, saved into the
// notebook's metadata (and removed); the template PDF has no outputs and exactly the students' page count.
//   (cd web/dist && python3 ../serve.py 8765) &   node web/notebook/gradescope/test-gradescope-print.mjs
// (GS_SHOTS=dir: also the dialogs as PNG and the PDFs, for a look)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../../test-port.mjs";

const url = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const profile = mkdtempSync(join(tmpdir(), "sb-gradescope-"));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
if (!cdpPort) cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) console.log("  (threw)", r.exceptionDetails.exception?.description?.slice(0, 300)); return r.result?.value; };
const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
const done = () => { try { ws.close(); } catch {} chrome.kill(); setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500).unref(); };

// ---------------------------------------------------------------- synthetic notebooks
const md = (id, code) => ({ id, type: "markdown", code });
const stream = (text) => ({ output_type: "stream", name: "stdout", text });
const svg = (w, h) => ({ output_type: "display_data", data: { "image/svg+xml": `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect x="2" y="2" width="${w - 4}" height="${h - 4}" fill="none" stroke="currentColor"/></svg>`, "text/plain": "plot" }, metadata: {} });
const lines = (k) => Array.from({ length: k }, (_, i) => `line ${i + 1} of the long output`).join("\n") + "\n";
const outline = (pages, paper = "letter") => ({ sagebrush: { gradescope: { v: 1, paper, exercises: [
  { id: "exercise-1", title: "Exercise 1", cell: "e1", pages: pages[0] },
  { id: "exercise-2", title: "Exercise 2", cell: "e2", pages: pages[1] },
  { id: "exercise-3", title: "Exercise 3", cell: "e3", pages: pages[2] },
] } } });
const notebook = (metadata, name = "Ada Example") => ({ mode: "python", name: "Homework 0", metadata, cells: [
  md("f0", `# Homework 0\n\n**Name:** ${name}\n\nI collaborated with: Grace Example`),
  md("e1", "## Exercise 1. Sums\n\nAdd two numbers."),
  { id: "c1", code: "print(1 + 1)", outputs: [stream("2\n")], n: "1" },
  md("e2", "## Exercise 2: A long output\n\nPrint many lines."),
  { id: "c2", code: "for i in range(120):\n    print(f'line {i + 1} of the long output')", outputs: [stream(lines(120))], n: "2" },
  md("e3", "## Exercise 3) A picture"),
  { id: "c3", code: "plot(x^2)", outputs: [svg(600, 420)], n: "3" },
  { id: "c4", code: "x = 3\nx + 1", outputs: [], n: null },
] });
const load = (doc) => ev(`(async () => { await sagebrush.notebook.load(${JSON.stringify(doc)}); return true; })()`);
// (the dialog, opened from the chunk with a print that waits for the test's PDF)
const openT = () => ev(`(async () => {
  const m = await import(new URL("sagebrush-gradescope.js", location.href).href);
  window.__gsPrinting = false;
  m.openTemplate({ nb: sagebrush.notebook, title: "Homework 0", print: () => new Promise((r) => { window.__gsPrinting = true; window.__gsResume = r; }) });
  return true;
})()`);
const rowsT = () => ev(`[...document.querySelectorAll("dialog.gs-tpl tr")].slice(1).map((r) => [r.querySelector("input[type=text]").value, Number(r.querySelector("input[type=number]").value), r.children[2].textContent])`);
const saved = () => ev(`JSON.stringify(sagebrush.notebook.snapshot().metadata?.sagebrush?.gradescope ?? null)`);
const open = () => ev(`(async () => {
  const m = await import(new URL("sagebrush-gradescope.js", location.href).href);
  window.__gsPrinting = false;
  m.openGradescope({ nb: sagebrush.notebook, title: "Homework 0", print: () => new Promise((r) => { window.__gsPrinting = true; window.__gsResume = r; }) });
  return true;
})()`);
const dialogText = () => ev(`document.querySelector("dialog.gs-dlg")?.innerText ?? ""`);
const click = (label) => ev(`(() => { const b = [...document.querySelectorAll("dialog.gs-dlg button")].find((b) => b.textContent === ${JSON.stringify(label)}); b?.click(); return !!b; })()`);
// (the PDF Chromium saves of the print view, its pages counted and the first one's size, in points)
const shots = process.env.GS_SHOTS;
const shot = async (name) => { if (shots) writeFileSync(join(shots, name + ".png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64")); };
async function pdf(name) {
  const r = await send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true });
  if (shots && name) writeFileSync(join(shots, name + ".pdf"), Buffer.from(r.data, "base64"));
  const bytes = Buffer.from(r.data ?? "", "base64").toString("latin1");
  const pages = (bytes.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(bytes);
  return { pages, w: box ? Math.round(Number(box[3])) : 0, h: box ? Math.round(Number(box[4])) : 0 };
}
// (the print view as printed: it shows only under print media, so its boxes are measured there)
const printed = async (expr) => { await send("Emulation.setEmulatedMedia", { media: "print" }); try { return await ev(expr); } finally { await send("Emulation.setEmulatedMedia", { media: "" }); } };
const overflowing = `[...document.querySelectorAll("#gs-print .gs-box")].map((b, i) => [i, b.scrollHeight, b.clientHeight]).filter(([, s, c]) => !(c > 0 && s <= c + 1))`;
const resume = () => ev(`(async () => { window.__gsResume?.(); await new Promise((r) => setTimeout(r, 50)); return !document.getElementById("gs-print") && !document.body.classList.contains("gs-printing"); })()`);

try {
  await send("Page.navigate", { url });
  ok(await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000), "the notebook page is ready");

  // the menu offers it, and opens the dialog
  await load(notebook(outline([1, 3, 1])));
  await ev(`document.querySelector("#filebtn").click()`);
  ok(await until(`!!document.querySelector('#filemenu button[data-f="gradescope"]') && !!document.querySelector('#filemenu button[data-f="gstemplate"]')`, 5000), "File has PDF for Gradescope… and Gradescope template…");
  await ev(`document.querySelector('#filemenu button[data-f="gradescope"]').click()`);
  ok(await until(`!!document.querySelector("dialog.gs-dlg[open] button.primary")`, 20000), "...which opens the dialog, ready to save");
  await ev(`document.querySelector("dialog.gs-dlg")?.remove()`);

  // fixed length: the cover and each exercise's budget, Letter
  await open();
  ok(await until(`!!document.querySelector("dialog.gs-dlg button.primary")`, 20000), "the dialog measures the exercises");
  let t = await dialogText();
  ok(/3 exercises, 6 pages on Letter/.test(t), `it says the layout: 3 exercises, 6 pages on Letter (${JSON.stringify(t.split("\n")[1])})`);
  ok(await ev(`document.querySelector("dialog.gs-dlg input").value`) === "Ada Example", "the name is the front matter's");
  ok(await ev(`document.querySelectorAll("dialog.gs-dlg input")[1].value`) === "Grace Example", "...and the collaborators");
  ok(/Exercise 3: a code cell hasn't run/.test(t), "the preflight names the cell that hasn't run, in its exercise");
  ok(/should have 6 pages/.test(t), "it says how many pages the PDF must have");
  ok(!/changed since/.test(t), "a notebook just opened (its outputs the saved ones) isn't warned of changed cells");
  await shot("dialog-fixed");
  await click("Save PDF…");
  ok(await until("window.__gsPrinting === true", 10000), "Save PDF… prints the print view");
  let p = await pdf("fixed");
  ok(p.pages === 6, `the PDF has 6 pages (${p.pages})`);
  ok(p.w === 612 && p.h === 792, `...on Letter paper (${p.w}×${p.h} pt)`);
  const heads = await ev(`[...document.querySelectorAll("#gs-print .gs-page")].map((pg) => [...(pg.querySelector(".gs-head")?.children ?? [])].map((c) => c.textContent).join(" | ") || "cover")`);
  ok(heads?.[0] === "cover" && heads[1] === "Homework 0 · Exercise 1 | 2 / 6" && heads[2] === "Homework 0 · Exercise 2 · page 1 of 3 | 3 / 6" && heads[5] === "Homework 0 · Exercise 3 | 6 / 6", `each page's header names its exercise and its page: ${JSON.stringify(heads)}`);
  const cover = await ev(`document.querySelector("#gs-print .gs-cover").innerText`);
  ok(/Ada Example/.test(cover) && /Grace Example/.test(cover) && !/Variable length/.test(cover), "the cover has the name and the collaborators, and no variable-length banner");
  const fill = await printed(overflowing);
  ok(Array.isArray(fill) && fill.length === 0, `printed, no page's content runs past its box: ${JSON.stringify(fill)}`);
  ok(await resume(), "after printing, the print view and its page style are gone");

  // a second print started before the first one's cleanup (which may wait for afterprint) still prints its view
  await load(notebook(outline([1, 3, 1])));
  await ev(`(async () => {
    const m = await import(new URL("sagebrush-gradescope.js", location.href).href);
    window.__gsPrinting = false;
    const first = m.openGradescope({ nb: sagebrush.notebook, title: "Homework 0", print: () => {} });
    for (let i = 0; i < 200 && !document.querySelector("dialog.gs-dlg button.primary"); i++) await new Promise((r) => setTimeout(r, 50));
    document.querySelector("dialog.gs-dlg button.primary").click();
    await new Promise((r) => setTimeout(r, 100));
    m.openGradescope({ nb: sagebrush.notebook, title: "Homework 0", print: () => new Promise((r) => { window.__gsPrinting = true; window.__gsResume = r; }) });
    return true;
  })()`);
  await until(`!!document.querySelector("dialog.gs-dlg button.primary")`, 20000);
  await click("Save PDF…");
  await until("window.__gsPrinting === true", 10000);
  await sleep(1300);
  p = await pdf();
  ok(p.pages === 6 && (await ev(`document.body.classList.contains("gs-printing") && document.querySelectorAll("#gs-print").length === 1`)), `a print started during the last one's cleanup keeps its view (${p.pages} pages)`);
  await resume();

  // A4, from the outline
  await load(notebook(outline([1, 3, 1], "a4")));
  await open();
  await until(`!!document.querySelector("dialog.gs-dlg button.primary")`, 20000);
  await click("Save PDF…");
  await until("window.__gsPrinting === true", 10000);
  p = await pdf();
  ok(p.pages === 6 && p.w === 595 && p.h === 842, `an A4 outline gives A4 pages (${p.pages} pages, ${p.w}×${p.h} pt)`);
  await resume();

  // too long: named, by how much; saving anyway is variable length, with the banner
  await load(notebook(outline([1, 1, 1]), "[your name]"));
  await open();
  ok(await until(`/Save anyway/.test(document.querySelector("dialog.gs-dlg")?.innerText ?? "")`, 20000), "an exercise longer than its pages offers Save anyway");
  t = await dialogText();
  ok(/Exercise 2 is about [\d.]+ pages? longer than its 1 page/.test(t), `...naming it and by how much (${JSON.stringify((/Exercise 2 is about[^.]*\.\d*[^.]*/.exec(t) ?? [""])[0])})`);
  ok((await ev(`[...document.querySelectorAll("dialog.gs-dlg button.primary")].map((b) => b.textContent + (b.closest(".over") ? " (in the box)" : "")).join()`)) === "Fix it (in the box)" && !/Save PDF/.test(t), "...with Fix it, in its box, the one primary action, and no fixed-length Save PDF");
  ok(/Your name isn't filled in/.test(t), "a placeholder name counts as no name");
  await shot("dialog-overflow");
  await click("Save anyway (variable length)");
  await until("window.__gsPrinting === true", 10000);
  p = await pdf("variable");
  ok(p.pages === 1 + 1 + 3 + 1, `the variable-length PDF has the pages it needs (${p.pages})`);
  ok((await printed(`[...document.querySelectorAll("#gs-print .gs-box > .gs-b")].every((b) => !b.style.zoom)`)) === true, "...every exercise at full size, nothing shrunk");
  ok(/Variable length/.test(await ev(`document.querySelector("#gs-print .gs-cover").innerText`)), "...and says so on its cover");
  await resume();

  // Fix it goes to the cell
  await load(notebook(outline([1, 3, 1])));
  await open();
  await until(`!!document.querySelector("dialog.gs-dlg button.primary")`, 20000);
  await ev(`[...document.querySelectorAll("dialog.gs-dlg li")].find((li) => /hasn't run/.test(li.textContent)).querySelector("button").click()`);
  ok(await until(`!document.querySelector("dialog.gs-dlg") && document.activeElement?.closest(".cell") === sagebrush.notebook.cells().find((c) => c.id === "c4").el`, 5000), "Fix it closes the dialog and selects the cell that hasn't run");

  // the fitting stages: text a little smaller, pictures capped, and the printed pages still hold their content
  {
    const doc = notebook(outline([1, 2, 1]));
    doc.cells.find((c) => c.id === "c2").outputs = [stream(lines(95))];
    doc.cells.find((c) => c.id === "c3").outputs = [svg(600, 1000)];
    await load(doc);
    await open();
    await until(`!!document.querySelector("dialog.gs-dlg button.primary")`, 20000);
    const rows = await ev(`[...document.querySelectorAll("dialog.gs-dlg tr")].slice(1).map((r) => r.lastElementChild.textContent)`);
    ok(rows?.[1] === "fits, text smaller" && rows?.[2] === "fits, pictures smaller", `an exercise fits with smaller text, another with smaller pictures: ${JSON.stringify(rows)}`);
    await click("Save PDF…");
    await until("window.__gsPrinting === true", 10000);
    p = await pdf("stages");
    ok(p.pages === 5, `...and the PDF has the template's 5 pages (${p.pages})`);
    const boxes = await printed(overflowing);
    ok(Array.isArray(boxes) && boxes.length === 0, `...each page's content within its box, as printed: ${JSON.stringify(boxes)}`);
    const last = await printed(`[...document.querySelectorAll("#gs-print .gs-page")][3]?.querySelector(".gs-box").innerText.trim().split("\\n").at(-1)`);
    ok(last === "line 95 of the long output", `...and the long output's last line is on the exercise's last page (${JSON.stringify(last)})`);
    await resume();
  }

  // a cell changed since it ran this session is named
  await load(notebook(outline([1, 3, 1])));
  await ev(`(() => { const c = sagebrush.notebook.cells().find((c) => c.id === "c1").el; c.classList.remove("stale"); c.classList.add("edited"); })()`);
  await open();
  await until(`!!document.querySelector("dialog.gs-dlg button.primary")`, 20000);
  ok(/Exercise 1: a cell changed since it ran/.test(await dialogText()), "a cell changed since it ran is named, in its exercise");
  await ev(`document.querySelector("dialog.gs-dlg")?.remove()`);

  // no outline: the headings, one page each
  await load(notebook({}));
  await open();
  ok(await until(`/Save anyway|Save PDF/.test(document.querySelector("dialog.gs-dlg")?.innerText ?? "")`, 20000), "without an outline the dialog still opens");
  t = await dialogText();
  ok(/3 exercises, 4 pages/.test(t) && /Found from the headings/.test(t), "...with the headings' exercises, one page each, and says so");
  await ev(`document.querySelector("dialog.gs-dlg")?.remove()`);

  // the instructor's template, from the menu: found from the headings, budgets the handout's pages plus one
  {
    const doc = notebook({});
    doc.cells.find((c) => c.id === "c2").code = Array.from({ length: 70 }, (_, i) => `# step ${i + 1} of the handout's long code`).join("\n");
    await load(doc);
    await ev(`document.querySelector("#filebtn").click()`);
    await until(`!!document.querySelector('#filemenu button[data-f="gstemplate"]')`, 5000);
    await ev(`document.querySelector('#filemenu button[data-f="gstemplate"]').click()`);
    ok(await until(`document.querySelectorAll("dialog.gs-tpl tr").length === 4`, 20000), "Gradescope template… opens with the headings' 3 exercises");
    let rows = await rowsT();
    ok(JSON.stringify(rows) === JSON.stringify([["Exercise 1", 2, "1 page"], ["Exercise 2", 3, "2 pages"], ["Exercise 3", 2, "1 page"]]), `each budget is the handout's pages (no outputs) plus one: ${JSON.stringify(rows)}`);
    ok(/Not saved yet/.test(await ev(`document.querySelector("dialog.gs-tpl").innerText`)) && (await saved()) === "null", "...and nothing is saved until Save outline");
    ok(/plus one for the answer\. Give an exercise whose answer prints long output or a figure two more/.test(await ev(`document.querySelector("dialog.gs-tpl").innerText`)), "...and says how the defaults are set, and when to give more");
    await ev(`document.querySelector("dialog.gs-tpl")?.remove()`);
    await load(notebook({}));
  }
  await openT();
  await until(`document.querySelectorAll("dialog.gs-tpl tr").length === 4`, 20000);
  // edited: Exercise 1 renamed, Exercise 2 given 3 pages; saved into the notebook
  await ev(`(() => { const r = [...document.querySelectorAll("dialog.gs-tpl tr")]; const t = r[1].querySelector("input[type=text]"); t.value = "Sums"; t.dispatchEvent(new Event("input")); const n = r[2].querySelector("input[type=number]"); n.value = "3"; n.dispatchEvent(new Event("input")); })()`);
  await click("Save outline");
  let o = JSON.parse((await saved()) ?? "null");
  ok(o && o.v === 1 && o.paper === "letter" && JSON.stringify(o.exercises.map((e) => [e.title, e.cell, e.pages])) === JSON.stringify([["Sums", "e1", 2], ["Exercise 2", "e2", 3], ["Exercise 3", "e3", 2]]), `Save outline writes the outline into the notebook's metadata: ${JSON.stringify(o?.exercises)}`);
  t = await ev(`document.querySelector("dialog.gs-tpl").innerText`);
  ok(/Saved in this notebook \(layout 1·[0-9a-f]{6}\)/.test(t), "...and says it is saved, with its layout's name");
  await shot("template-dialog");
  ok((await ev(`document.querySelector("dialog.gs-tpl pre.list").textContent`)) === "Name: page 1\nSums: pages 2–3\nExercise 2: pages 4–6\nExercise 3: pages 7–8\n(8 pages)", "the page list, for Gradescope's outline");
  await click("Template PDF…");
  ok(await until("window.__gsPrinting === true", 20000), "Template PDF… prints");
  p = await pdf("template-pdf");
  ok(p.pages === 8, `the template PDF has the outline's 8 pages (${p.pages})`);
  const tv = await printed(`({ text: document.getElementById("gs-print").innerText, name: document.querySelector("#gs-print .gs-cover .gs-field .v").textContent, over: ${overflowing} })`);
  ok(tv && !/line 1 of the long output/.test(tv.text) && /for i in range/.test(tv.text) && tv.name === "" && /layout 1·[0-9a-f]{6}/.test(tv.text), `...with the handout's code and no outputs, a blank name and the layout's name on the cover (${JSON.stringify({ outputs: /line 1 of the long output/.test(tv?.text), code: /for i in range/.test(tv?.text), name: tv?.name, layout: tv?.text.match(/\d+ pages · layout .*/)?.[0] })})`);
  ok(tv && tv.over.length === 0, "...and no page's content past its box");
  await resume();
  // a student's PDF of the same notebook has the template's pages, and the same layout name
  await open();
  await until(`!!document.querySelector("dialog.gs-dlg button.primary")`, 20000);
  await click("Save PDF…");
  await until("window.__gsPrinting === true", 10000);
  p = await pdf();
  const lay = await ev(`document.querySelector("#gs-print .gs-layout").textContent`);
  ok(p.pages === 8 && lay === tv?.text.match(/8 pages · layout 1·[0-9a-f]{6}/)?.[0], `a student's PDF has the template's 8 pages and its layout (${p.pages}, ${JSON.stringify(lay)})`);
  await resume();
  // merged, split at a selected cell, A4; removed
  await openT();
  await until(`document.querySelectorAll("dialog.gs-tpl tr").length === 4`, 20000);
  ok(/Saved in this notebook/.test(await ev(`document.querySelector("dialog.gs-tpl").innerText`)), "the template reopens with the saved outline");
  await ev(`[...document.querySelectorAll("dialog.gs-tpl tr")][3].querySelector("button[title^='Its cells join']").click()`);
  ok(await until(`document.querySelectorAll("dialog.gs-tpl tr").length === 3`, 10000), "Merge up joins Exercise 3 into Exercise 2");
  ok(/Changed since it was saved/.test(await ev(`document.querySelector("dialog.gs-tpl").innerText`)), "...and says the outline changed since it was saved");
  await ev(`sagebrush.notebook.select(sagebrush.notebook.cells().find((c) => c.id === "c3"))`);
  await click("Start an exercise at the selected cell");
  ok(await until(`document.querySelectorAll("dialog.gs-tpl tr").length === 4`, 10000), "a selected cell starts an exercise of its own");
  await ev(`(() => { const s = document.querySelector("dialog.gs-tpl select"); s.value = "a4"; s.dispatchEvent(new Event("change")); })()`);
  await until(`!/Measuring/.test(document.querySelector("dialog.gs-tpl .sub").textContent)`, 10000);
  await click("Save outline");
  o = JSON.parse((await saved()) ?? "null");
  ok(o?.paper === "a4" && JSON.stringify(o.exercises.map((e) => e.cell)) === JSON.stringify(["e1", "e2", "c3"]), `...saved on A4, the new exercise starting at that cell: ${JSON.stringify(o?.exercises)}`);
  await click("Remove outline");
  ok((await saved()) === "null", "Remove outline takes it out of the notebook's metadata");
  await ev(`document.querySelector("dialog.gs-tpl")?.remove()`);

  // nothing to lay out
  await load({ mode: "python", cells: [md("m", "# Notes"), { id: "c", code: "1", outputs: [] }] });
  await open();
  ok(await until(`/no exercises marked/.test(document.querySelector("dialog.gs-dlg")?.innerText ?? "")`, 10000), "a notebook without exercises is told so, and how they are found");
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`);
} finally {
  done();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
