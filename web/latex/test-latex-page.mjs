// The LaTeX editor's page end to end, in headless Chrome against a web/dist built with SAGEBRUSH_LATEX_PREVIEW=test
// (the page also on loopback hosts), served by web/serve.py (cross-origin isolated, as the site):
//   - the flag: off, no editor and no LaTeX file fetched; on, nothing fetched before a .tex is opened;
//   - opening by fid, the banner, Save gated on edits, Ctrl/Cmd+S, "Saved" / "No changes to save";
//   - the byte rules: the fixtures saved and read back; mixed endings and NUL open without Save;
//   - the save target: a rename followed; the file in Trash, refused; another tab's save overwritten (and kept as a
//     version); beforeunload with unsaved edits;
//   - images: one in the folder shown from a blob: URL; one outside refused with its reason;
//   - a 1.5 MiB paragraph and list shown as pieces of at most 128 KiB, never two versions at once.
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && CHROME=google-chrome node web/latex/test-latex-page.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the server: web/serve.py on a port it picks, printed once it listens
const server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const sport = await new Promise((res, rej) => { let acc = ""; server.stdout.on("data", (b) => { acc += b; const m = /(\d{2,5})/.exec(acc); if (m) res(+m[1]); }); setTimeout(() => rej(new Error("no server port")), 15000); });
const base = `http://127.0.0.1:${sport}/`;
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-latex-page-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1400,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [], requests = [], dialogs = [], sizes = new Map(), reqUrl = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Network.requestWillBeSent") { requests.push(m.params.request.url); reqUrl.set(m.params.requestId, m.params.request.url); }
  if (m.method === "Network.loadingFinished") sizes.set(reqUrl.get(m.params.requestId) ?? m.params.requestId, m.params.encodedDataLength);
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.type); send("Page.handleJavaScriptDialog", { accept: true }); }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const go = async (url) => { await send("Page.navigate", { url }); await sleep(400); };
const fails = []; let checks = 0;
const check = (ok, what, detail) => { checks++; if (!ok) { fails.push(what); console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); } };
const W = "window.sagebrush?.workspace";
const latexFetches = () => requests.filter((u) => /sagebrush-latex/.test(u));
const bytesOf = (p) => ev(`${W}.read(${JSON.stringify(p)}).then((r) => Array.from(r.content))`);
const mk = (p, arr) => ev(`${W}.create(${JSON.stringify(p)}, { content: new Uint8Array(${JSON.stringify(arr)}) }).then((e) => e.fid)`);
const enc = (s) => Array.from(new TextEncoder().encode(s));
const DOC = "\\documentclass{article}\n\\begin{document}\n\\section{Hello}\nSome text with $x^2$.\n\\end{document}\n";
const open = async (fid, q = "&latex=1") => { await go(base + "?tex=" + encodeURIComponent(fid) + q); return until(`!!document.querySelector(".tex-page")`, 20000); };
const page = (expr) => ev(`(() => { const P = document.querySelector(".tex-page"); return ${expr}; })()`);
const typeInto = (text) => ev(`(() => { const t = document.querySelector(".tex-src"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input")); return true; })()`);
const ctrlS = () => send("Input.dispatchKeyEvent", { type: "keyDown", key: "s", code: "KeyS", modifiers: 2, windowsVirtualKeyCode: 83 });
const statusIs = (re, ms = 10000) => until(`${re}.test(document.querySelector(".tex-status")?.textContent ?? "")`, ms);

try {
  for (const m of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(m);
  // ---- the flag: off (no ?latex=1, nothing stored): ?tex= shows the note, and nothing of the editor is fetched
  await go(base);
  await until(`!!${W}`, 60000);
  await ev(`localStorage.removeItem("sagebrush-latex-preview"); true`);
  const fid = await mk("/t/doc.tex", enc(DOC));
  requests.length = 0;
  await go(base + "?tex=" + fid);
  await sleep(1500);
  check(await ev(`!document.querySelector(".tex-page") && document.body.innerText.includes("The LaTeX editor isn't enabled here.")`), "flag off: the note, no editor");
  check(latexFetches().length === 0, "flag off: no LaTeX file fetched", latexFetches());
  check(await ev(`[...document.querySelectorAll("button")].some((b) => b.textContent === "Preview it")`), "flag off: the note offers the file's preview");
  // on, by the URL: no LaTeX file fetched before a .tex is opened
  requests.length = 0;
  await go(base + "?latex=1"); await until(`!!${W}`, 60000); await sleep(1000);
  check(latexFetches().length === 0, "flag on: nothing fetched before a .tex is opened (zero eager fetch)", latexFetches());

  // ---- opening, the banner, Save gated on edits (the first open's requests recorded: the cold first click)
  requests.length = 0; sizes.clear();
  check(await open(fid), "the editor opens by fid");
  check(await until(`document.querySelector(".tex-preview h2, .tex-preview h1")?.textContent.includes("Hello")`, 20000), "the preview renders the section");
  const cold = { requests: requests.length, bytes: [...sizes.values()].reduce((a, b) => a + b, 0), latex: [...sizes.entries()].filter(([u]) => /sagebrush-latex/.test(u)).reduce((a, [, b]) => a + b, 0) };
  console.log("cold first click (loopback, uncompressed; the gated number is the TIMING protocol's against DEV):", JSON.stringify(cold));
  check(await page(`P.querySelector(".tex-banner").textContent.startsWith("LaTeX editor: an early prototype. Save (Ctrl/Cmd+S) overwrites the file.")`), "the banner says save overwrites");
  check(await page(`P.querySelector(".tex-save").disabled === true && P.querySelector(".tex-dirty").hidden === true`), "Save disabled, nothing unsaved");
  check(latexFetches().some((u) => /sagebrush-latex\.js/.test(u)) && latexFetches().some((u) => /sagebrush-latex-worker\.js/.test(u)), "the page and its worker fetched now", latexFetches());
  const rev0 = await ev(`${W}.stat("/t/doc.tex").then((e) => e.rev ?? 0)`);
  await send("Runtime.evaluate", { expression: `document.querySelector(".tex-src").focus()` });
  await ctrlS();
  check(await statusIs(/No changes to save/), "Ctrl+S on clean text: no write, said");
  check((await ev(`${W}.stat("/t/doc.tex").then((e) => e.rev ?? 0)`)) === rev0, "…and the revision unchanged");
  await typeInto(DOC.replace("Some text", "Edited text"));
  check(await page(`P.querySelector(".tex-dirty").hidden === false && P.querySelector(".tex-save").disabled === false`), "an edit: Unsaved changes, Save enabled");
  await ctrlS();
  check(await statusIs(/^Saved$/), "Ctrl+S: Saved");
  check(JSON.stringify(await bytesOf("/t/doc.tex")) === JSON.stringify(enc(DOC.replace("Some text", "Edited text"))), "…the bytes written are the text");
  check(await page(`P.querySelector(".tex-dirty").hidden === true && P.querySelector(".tex-save").disabled === true`), "…and nothing unsaved after");

  // ---- the byte rules, through the page: the fixtures saved after an edit and read back
  const BOM = [0xef, 0xbb, 0xbf];
  const fixtures = [["crlf", enc("a\r\nb\r\n"), (t) => enc(t.replace(/\n/g, "\r\n"))], ["bom", BOM.concat(enc("a\nb\n")), (t) => enc(t)], ["bom-crlf", BOM.concat(enc("a\r\nb\r\n")), (t) => enc(t.replace(/\n/g, "\r\n"))]];
  for (const [name, b, expect] of fixtures) {
    const f = await mk(`/t/${name}.tex`, b);
    await open(f);
    await until(`document.querySelector(".tex-save") && !document.querySelector(".tex-save").hidden`, 10000);
    const text = await ev(`document.querySelector(".tex-src").value`);
    await typeInto(text + "c\n"); await ctrlS();
    await statusIs(/^Saved$/);
    const got = await bytesOf(`/t/${name}.tex`), want = expect(text + "c\n");
    check(JSON.stringify(got) === JSON.stringify(want) && got.filter((x, i) => x === 0xef && got[i + 1] === 0xbb && got[i + 2] === 0xbf).length === (b[0] === 0xef ? 1 : 0), "fixture " + name + ": saved and read back exactly, one BOM at most", { got: got.slice(0, 12), want: want.slice(0, 12) });
  }
  const mixed = await mk("/t/mixed.tex", enc("a\r\nb\nc\n"));
  await open(mixed); await sleep(800);
  check(await page(`P.querySelector(".tex-save").hidden === true && P.querySelector(".tex-banner").textContent.includes("mixes line endings")`), "mixed line endings: no Save, the banner says why");
  const mrev = await ev(`${W}.stat("/t/mixed.tex").then((e) => e.rev ?? 0)`);
  await typeInto("changed\n"); await ctrlS(); await sleep(500);
  check((await ev(`${W}.stat("/t/mixed.tex").then((e) => e.rev ?? 0)`)) === mrev && (await statusIs(/can't be saved here/, 3000)), "…Ctrl+S writes nothing, says why");
  await ev(`window.onbeforeunload = null; true`);
  const nul = await mk("/t/nul.tex", [0x61, 0, 0x62]);
  await open(nul); await sleep(800);
  check(await page(`P.textContent.includes("can't be opened in the LaTeX editor") && !P.querySelector(".tex-src")`), "a NUL file: no editor, says why");

  // ---- the save target
  const f2 = await mk("/t/r.tex", enc(DOC));
  await open(f2); await sleep(500);
  await ev(`${W}.rename("/t/r.tex", "/t/moved.tex").then(() => 1)`);
  await typeInto(DOC + "% x\n"); await ctrlS();
  check(await statusIs(/^Saved$/) && JSON.stringify(await bytesOf("/t/moved.tex")) === JSON.stringify(enc(DOC + "% x\n")), "a rename elsewhere: the save follows the file");
  await ev(`${W}.remove("/t/moved.tex").then(() => 1)`);
  await typeInto(DOC + "% y\n"); await ctrlS();
  check(await statusIs(/Not saved: this file isn't here any more/), "the file in Trash: not saved");
  // another tab's save, then this one's: last write wins, the other kept as a version
  const f3 = await mk("/t/lw.tex", enc(DOC));
  await open(f3); await sleep(500);
  await ev(`${W}.write("/t/lw.tex", new TextEncoder().encode("other tab\\n")).then(() => 1)`);
  await typeInto(DOC + "% mine\n"); await ctrlS(); await statusIs(/^Saved$/);
  const hist = await ev(`${W}.history("/t/lw.tex").then((h) => h.length)`);
  check(JSON.stringify(await bytesOf("/t/lw.tex")) === JSON.stringify(enc(DOC + "% mine\n")) && hist >= 2, "another tab saved: overwritten (last write wins), its bytes kept as a version", { hist });
  // beforeunload with unsaved edits
  await typeInto(DOC + "% unsaved\n");
  dialogs.length = 0;
  await send("Page.navigate", { url: base + "?latex=1" }); await sleep(1500);
  check(dialogs.includes("beforeunload"), "unsaved edits: the browser asks before leaving", dialogs);

  // ---- images: in the folder, from a blob: URL; outside, refused with its reason
  const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 227, 85, 242, 156, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
  await go(base + "?latex=1"); await until(`!!${W}`, 60000);
  await mk("/img/fig.png", png);
  await mk("/other.png", png);
  const fi = await mk("/img/doc.tex", enc("\\documentclass{article}\n\\begin{document}\n\\includegraphics{fig}\n\\includegraphics{../other.png}\n\\end{document}\n"));
  await open(fi);
  check(await until(`[...document.querySelectorAll(".tex-preview img.graphic")].some((i) => i.src.startsWith("blob:"))`, 15000), "an image in the folder: shown from a blob: URL");
  check(await until(`document.querySelector(".tex-preview").textContent.includes("[image: ../other.png: outside this folder]")`, 15000), "an image outside the folder: refused, with its reason");

  // ---- a large paragraph and list: pieces of at most 128 KiB, never two versions at once
  const para = "\\documentclass{article}\n\\begin{document}\n" + "word ".repeat(200000) + "\n\n\\begin{itemize}\n" + "\\item list item text\n".repeat(22000) + "\\end{itemize}\n\\end{document}\n";
  const fb = await mk("/t/big.tex", enc(para));
  await open(fb);
  const bigOk = await until(`document.querySelectorAll(".tex-preview .pc").length > 10`, 60000);
  check(bigOk, "a large document: shown in pieces", await ev(`({ pcs: document.querySelectorAll(".tex-preview .pc").length, status: document.querySelector(".tex-status")?.textContent, bound: document.querySelector(".tex-preview .bounderr")?.textContent, ph: document.querySelectorAll(".tex-preview .toolarge").length })`));
  check(await ev(`[...document.querySelectorAll(".tex-preview .pc")].every((p) => new TextEncoder().encode(p.innerHTML).length <= 128 * 1024 + 64)`), "…each piece at most 128 KiB");
  check(await ev(`[...document.querySelectorAll(".tex-preview .pc > .list.cont")].length > 0 && [...document.querySelectorAll(".tex-preview .pc > .p.cont")].length > 0`), "…lists and paragraphs continued in copies of their container");
  // (an observer: no moment where an old and a new version of a group are both visible)
  await ev(`(() => { window.__mixed = 0; new MutationObserver(() => { const vis = [...document.querySelectorAll(".tex-preview > .ch:not([hidden])")]; const words = vis.filter((c) => c.textContent.includes("CHANGED")).length; if (words && vis.some((c) => c.textContent.startsWith("word word") && !c.textContent.includes("CHANGED") && c.querySelector(".p"))) window.__mixed++; }).observe(document.querySelector(".tex-preview"), { childList: true, subtree: false, attributes: true, attributeFilter: ["hidden"] }); return true; })()`);
  await typeInto(para.replace("word word", "CHANGED word"));
  check(await until(`document.querySelector(".tex-preview").textContent.includes("CHANGED")`, 60000), "the edited large paragraph is re-patched");
  check((await ev(`window.__mixed`)) === 0, "…never an old and a new version of it at once");

  // ---- the patch loop: no Long Task over 50 ms while a large paragraph and list are re-patched (correctness run,
  // not a timing box: recorded and checked here, measured again under the TIMING protocol)
  await ev(`(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: false }); return true; })()`);
  await typeInto(para.replace("CHANGED word", "AGAIN word"));
  await until(`document.querySelector(".tex-preview").textContent.includes("AGAIN")`, 60000);
  await sleep(500);
  const lts = await ev(`window.__lt`);
  const own = await ev(`({ step: +document.querySelector(".tex-preview").dataset.patchMaxMs, swap: +document.querySelector(".tex-preview").dataset.swapMaxMs })`);
  console.log("long tasks during the re-patch (ms):", JSON.stringify(lts), "patch loop's own longest step and swap (ms):", JSON.stringify(own));
  check(own.step <= 50 && own.swap <= 50, "the patch loop's own steps and swap each under 50 ms", own);
  check(lts.every((d) => d <= 50), "no Long Task over 50 ms while re-patching (VM2, not a timing box)", { lts, own });

  // ---- a 1.5 MiB enumerate and a 1.5 MiB plain theorem: pieces whose styles and labels continue; a large table: a placeholder
  const thmDoc = "\\documentclass{article}\n\\newtheorem{theorem}{Theorem}\n\\begin{document}\n\\begin{theorem}\n" + "theorem words go on and on here. ".repeat(6000).split(". ").join(".\n\n") + "\n\\end{theorem}\n\n\\begin{enumerate}\n" + "\\item an item\n".repeat(6000) + "\\end{enumerate}\n\\end{document}\n";
  const ft = await mk("/t/thm.tex", enc(thmDoc));
  await open(ft);
  await until(`document.querySelectorAll(".tex-preview .thm.cont").length > 0 && document.querySelectorAll(".tex-preview .list.cont").length > 0`, 60000);
  const cont = await ev(`(() => {
    const thms = [...document.querySelectorAll(".tex-preview .thm")], lists = [...document.querySelectorAll(".tex-preview ol.list")];
    const fs = (e) => getComputedStyle(e).fontStyle, pl = (e) => getComputedStyle(e).paddingLeft, cls = (e) => [...e.classList].filter((c) => c !== "cont").join(".");
    const labels = lists.flatMap((l) => [...l.querySelectorAll(":scope > li > .lbl")].map((x) => x.textContent));
    return { thms: thms.length, thmSame: thms.every((t) => fs(t) === fs(thms[0]) && cls(t) === cls(thms[0])), lists: lists.length, listSame: lists.every((l) => pl(l) === pl(lists[0]) && cls(l) === cls(lists[0])), labels: labels.length, seq: labels.every((t, i) => t === (i + 1) + "."), status: document.querySelector(".tex-status")?.textContent, bound: !!document.querySelector(".tex-preview .bounderr") };
  })()`);
  check(cont.thms > 1 && cont.thmSame && cont.lists > 1 && cont.listSame && cont.labels === 6000 && cont.seq, "split theorem and list: the same classes and computed styles in every piece, labels 1..6000 in order", cont);
  const tabDoc = "\\documentclass{article}\n\\begin{document}\n\\begin{tabular}{ll}\n" + "aaaaaaaaaaaaaaaaaaaaaaaa & b \\\\\n".repeat(6000) + "\\end{tabular}\n\\end{document}\n";
  const ftab = await mk("/t/tab.tex", enc(tabDoc));
  await open(ftab);
  check(await until(`document.querySelector(".tex-preview").textContent.includes("this table is too large to display in the prototype")`, 60000), "a table over 128 KiB: a placeholder with its reason, never split", await ev(`({ status: document.querySelector(".tex-status")?.textContent, tables: document.querySelectorAll(".tex-preview table").length })`));

  // ---- r5 §4's worst cases: one line of 1 MiB - 1 (the plain path) edited at its end; a chunk over 2 MiB (a placeholder)
  const oneLine = "\\documentclass{article}\\begin{document}" + "x".repeat(2 ** 20 - 1 - 60) + "\\end{document}";
  const fl = await mk("/t/oneline.tex", enc(oneLine));
  await open(fl); await sleep(1000);
  await ev(`(() => { window.__lt2 = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt2.push(Math.round(e.duration)); }).observe({ type: "longtask" }); return true; })()`);
  await typeInto(oneLine.replace("\\end{document}", "y\\end{document}")); await sleep(2500);
  const lt2 = await ev(`window.__lt2`);
  console.log("long tasks after an edit of a 1 MiB line (ms):", JSON.stringify(lt2));
  check(await ev(`document.querySelectorAll(".tex-hl .hl-line").length === 1 && !document.querySelector(".tex-hl .hl-line span")`), "a 1 MiB line: drawn plain, not highlighted");
  const big3 = "\\documentclass{article}\n\\begin{document}\n" + "word ".repeat(460000) + "\n\\end{document}\n";
  const f3m = await mk("/t/huge-chunk.tex", enc(big3));
  await open(f3m);
  check(await until(`document.querySelector(".tex-preview").textContent.includes("this block is too large to display in the prototype")`, 60000), "a chunk over 2 MiB: a placeholder with its size, nothing inserted", await ev(`({ status: document.querySelector(".tex-status")?.textContent, pcs: document.querySelectorAll(".tex-preview .pc").length })`));
  // ---- a file in Trash, opened by its fid
  const ftr = await mk("/t/trashme.tex", enc(DOC));
  await ev(`${W}.remove("/t/trashme.tex").then(() => 1)`);
  await go(base + "?tex=" + ftr + "&latex=1"); await sleep(1500);
  check(await ev(`document.querySelector(".tex-page")?.textContent.includes("This file isn't here any more (it's in the Trash).")`), "a fid only in Trash: Gone, in the Trash");
  // ---- gone: an unknown fid
  await go(base + "?tex=ffffffffffffffff&latex=1"); await sleep(1500);
  check(await ev(`document.querySelector(".tex-page")?.textContent.includes("This file isn't here any more.")`), "an unknown fid: Gone");
  check(errors.length === 0, "no page errors", errors);
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  ws.close(); chrome.kill(); server.kill();
  await sleep(300); rmSync(profile, { recursive: true, force: true });
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks}:\n  ${fails.join("\n  ")}` : `ok: the LaTeX editor's page, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
