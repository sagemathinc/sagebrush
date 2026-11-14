// ci: web-runner order=598 chrome
// File ▸ Download ▸ PDF for Gradescope… (web/notebook/gradescope) in headless Chromium against the built page, on
// synthetic notebooks only: the PDF Chromium saves from the print view has the template's pages exactly (the cover,
// then each exercise's budget), at the outline's paper size; an exercise longer than its pages is named with how
// much, and saving anyway gives a PDF of variable length that says so on its cover; the preflight names an unrun
// cell, an empty name, and its Fix it goes to the cell; without an outline the headings are found.
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
  ok(await until(`!!document.querySelector('#filemenu button[data-f="gradescope"]')`, 5000), "File ▸ Download has PDF for Gradescope…");
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
  ok(!(await ev(`!!document.querySelector("dialog.gs-dlg button.primary")`)), "...and no fixed-length Save PDF");
  ok(/Your name isn't filled in/.test(t), "a placeholder name counts as no name");
  await shot("dialog-overflow");
  await click("Save anyway (variable length)");
  await until("window.__gsPrinting === true", 10000);
  p = await pdf("variable");
  ok(p.pages === 1 + 1 + 3 + 1, `the variable-length PDF has the pages it needs (${p.pages})`);
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

  // nothing to lay out
  await load({ mode: "python", cells: [md("m", "# Notes"), { id: "c", code: "1", outputs: [] }] });
  await open();
  ok(await until(`/no exercises to lay out/.test(document.querySelector("dialog.gs-dlg")?.innerText ?? "")`, 10000), "a notebook without exercises is told how they are found");
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`);
} finally {
  done();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
