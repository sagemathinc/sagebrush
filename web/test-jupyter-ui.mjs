// The notebook's Jupyter-like editing, in headless Chromium with real key
// events: command mode (Esc; A, B, D D, Z, C, V, M, Y, Shift+M, H), edit mode
// (auto-indent, ↑/↓ between cells, Ctrl+; split, Ctrl+/ comments), dragging a
// cell by its prompt, + Code between cells, and printing to PDF.  Serve web/dist:
//   bun web/build.ts && (cd web/dist && python3 ../serve.py 8765) &
//   node web/test-jupyter-ui.mjs            (PDF=out.pdf keeps the printout)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const url = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const profile = mkdtempSync(join(tmpdir(), "sb-jupyter-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9338", `--user-data-dir=${profile}`, "--window-size=1200,1600", "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch("http://127.0.0.1:9338/json")).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };

// a real key press; mods: "shift", "ctrl", "alt", "meta"
const CODES = { Enter: [13, "Enter"], Escape: [27, "Escape"], ArrowUp: [38, "ArrowUp"], ArrowDown: [40, "ArrowDown"], Tab: [9, "Tab"], Backspace: [8, "Backspace"], ";": [186, "Semicolon"], "/": [191, "Slash"] };
async function press(key, ...mods) {
  const m = (mods.includes("alt") ? 1 : 0) | (mods.includes("ctrl") ? 2 : 0) | (mods.includes("meta") ? 4 : 0) | (mods.includes("shift") ? 8 : 0);
  const [code, name] = CODES[key] ?? [key.toUpperCase().charCodeAt(0), /\d/.test(key) ? "Digit" + key : "Key" + key.toUpperCase()];
  const k = mods.includes("shift") && key.length === 1 ? key.toUpperCase() : key;
  const text = key === "Enter" ? "\r" : key.length === 1 && !(m & 7) ? k : undefined;
  await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code: name, windowsVirtualKeyCode: code, modifiers: m, text });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: name, windowsVirtualKeyCode: code, modifiers: m });
  await sleep(30);
}
const type = (text) => send("Input.insertText", { text });
const values = () => ev("[...document.querySelectorAll('.cell textarea')].map(t => t.value)");
const focusIs = () => ev(`(() => { const a = document.activeElement, c = a.closest('.cell'); return c ? [...document.querySelectorAll('.cell')].indexOf(c) + (a.tagName === 'TEXTAREA' ? ':edit' : ':command') : a.tagName; })()`);

try {
  await send("Page.navigate", { url });
  await until("document.querySelector('#status')?.textContent.startsWith('ready')");
  await ev("document.querySelector('[data-f=new]').click()");
  await until("document.querySelector('#nbname').value === 'Untitled' && document.activeElement.tagName === 'TEXTAREA'");

  // auto-indent: one level after a colon, back after return
  await type("def f(x):"); await press("Enter"); await type("return x + 1"); await press("Enter"); await type("f(41)");
  ok((await values())[0] === "def f(x):\n    return x + 1\nf(41)", "Enter keeps the indentation, adds a level after ':' and drops it after return: " + JSON.stringify((await values())[0]));

  // Ctrl+; splits at the caret
  await ev("(() => { const t = document.activeElement; t.setSelectionRange(t.value.length - 5, t.value.length - 5); })()");
  await press(";", "ctrl");
  let v = await values();
  ok(v.length === 2 && v[0] === "def f(x):\n    return x + 1" && v[1] === "f(41)" && (await focusIs()) === "1:edit", "Ctrl+; splits the cell at the cursor: " + JSON.stringify(v));

  // Shift+Enter runs and moves on, making a cell at the end (after the run button defines f)
  await ev("document.querySelectorAll('.cell .runb')[0].click(); document.querySelectorAll('.cell textarea')[1].focus()");
  await press("Enter", "shift");
  await until("document.querySelectorAll('.cell')[1].querySelector('.out').textContent.includes('42')");
  ok((await focusIs()) === "2:edit" && /\[\d+\]/.test(await ev("document.querySelectorAll('.cell .n')[1].textContent")), "Shift+Enter runs (42, with its prompt [n]:) and moves to a new cell");

  // command mode: Esc, K/J, A, D D, Z
  await press("Escape");
  ok((await focusIs()) === "2:command", "Esc is command mode, on the cell");
  await press("k");
  ok((await focusIs()) === "1:command", "K selects the cell above");
  await press("a");
  ok((await values()).length === 4 && (await focusIs()) === "1:command", "A inserts a cell above");
  await press("d"); await press("d");
  ok((await values()).length === 3 && (await focusIs()) === "1:command", "D D deletes it");
  await press("x");
  ok((await values()).join("|") === "def f(x):\n    return x + 1|", "X cuts a cell");
  await press("z");
  ok((await values()).join("|") === "def f(x):\n    return x + 1|f(41)|", "Z undoes the deletion: " + JSON.stringify(await values()));
  await press("c"); await press("v");
  ok((await values()).join("|") === "def f(x):\n    return x + 1|f(41)|f(41)|", "C V copies a cell below");
  await press("k");
  await press("m", "shift");
  ok((await values()).join("|") === "def f(x):\n    return x + 1|f(41)\nf(41)|", "Shift+M merges with the cell below: " + JSON.stringify(await values()));
  await press("m");
  ok(await ev("document.querySelectorAll('.cell')[1].classList.contains('markdown') && document.querySelectorAll('.cell')[1].querySelector('[data-a=type]').value === 'markdown'"), "M makes it Markdown (and the toolbar says so)");
  await press("y");
  ok(await ev("!document.querySelectorAll('.cell')[1].classList.contains('markdown')"), "Y makes it code again");
  await press("h");
  ok(await ev("document.querySelector('#keysdlg').open"), "H lists the keyboard shortcuts");
  await press("Escape");

  // edit mode: Enter edits; ↑ on the first line goes to the cell above, at its end
  await ev("document.querySelectorAll('.cell')[1].focus()");
  await press("Enter");
  ok((await focusIs()) === "1:edit", "Enter edits the selected cell");
  await ev("document.activeElement.setSelectionRange(2, 2)");
  await press("ArrowUp");
  ok((await focusIs()) === "0:edit" && (await ev("document.activeElement.selectionStart === document.activeElement.value.length")), "↑ on the first line goes to the end of the cell above");
  await press("ArrowDown");
  ok((await focusIs()) === "1:edit", "↓ on the last line goes to the cell below");
  await ev("document.activeElement.setSelectionRange(8, 8)"); // on the second line of f(41)\nf(41)
  await press("ArrowUp");
  ok((await focusIs()) === "1:edit" && (await ev("document.activeElement.selectionStart")) < 6, "↑ on a later line moves within the cell");
  await press("ArrowUp");
  ok((await focusIs()) === "0:edit", "...and from the first line leaves it");

  // Ctrl+/ comments and uncomments the selected lines
  await ev("document.activeElement.select()");
  await press("/", "ctrl");
  ok((await values())[0] === "# def f(x):\n#     return x + 1", "Ctrl+/ comments the lines: " + JSON.stringify((await values())[0]));
  await press("/", "ctrl");
  ok((await values())[0] === "def f(x):\n    return x + 1", "...and uncomments them");

  // drag the third cell by its prompt to the top
  await ev("document.querySelectorAll('.cell')[2].querySelector('textarea').value = 'third'");
  await ev(`(() => {
    const cs = [...document.querySelectorAll('.cell')], dt = new DataTransfer(), g = cs[2].querySelector('.gutter'), y = cs[0].getBoundingClientRect().top + 3;
    g.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    cs[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    cs[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    g.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  })()`);
  ok((await values())[0] === "third" && (await ev("document.querySelector('#dropline').hidden")), "dragging a cell by its prompt moves it: " + JSON.stringify(await values()));

  // + Code under a cell inserts below it
  await ev("document.querySelectorAll('.cell')[0].querySelector('[data-a=addcode]').click()");
  ok((await values()).length === 4 && (await values())[1] === "" && (await focusIs()) === "1:edit", "+ Code between cells inserts there");

  // printing: the notebook alone, light, its code without the editors
  await ev("(() => { const t = document.querySelectorAll('.cell textarea')[1]; t.value = 'import math\\nprint(math.pi)'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelectorAll('.cell .runb')[1].click(); })()");
  await until("document.querySelectorAll('.cell')[1].querySelector('.out').textContent.includes('3.14159')");
  await ev("document.querySelector('#nbname').value = 'Homework 3'; dispatchEvent(new Event('beforeprint'))");
  await send("Emulation.setEmulatedMedia", { media: "print" });
  const st = await ev(`(() => { const d = (s) => getComputedStyle(document.querySelector(s)).display; return { header: d('header'), bar: d('.bar'), about: d('.about'), ta: d('.cell textarea'), head: d('.cell .head'), printhead: d('#printhead'), name: document.querySelector('#printname').textContent, title: document.title, bg: getComputedStyle(document.body).backgroundColor }; })()`);
  ok(st.header === "none" && st.bar === "none" && st.about === "none" && st.ta === "none" && st.head === "none" && st.printhead === "block" && st.name === "Homework 3" && st.title === "Homework 3" && st.bg === "rgb(255, 255, 255)",
     "print shows only the notebook, titled by its name: " + JSON.stringify(st));
  const pdf = await send("Page.printToPDF", { printBackground: true });
  const bytes = Buffer.from(pdf.data ?? "", "base64");
  if (process.env.PDF) writeFileSync(process.env.PDF, bytes);
  ok(bytes.subarray(0, 5).toString() === "%PDF-" && bytes.length > 5000, `prints to a PDF (${bytes.length} bytes)`);
  await send("Emulation.setEmulatedMedia", { media: "" });
  await ev("dispatchEvent(new Event('afterprint'))");
} catch (e) {
  console.log("ERROR", e.message);
  process.exitCode = 1;
} finally {
  ws.close();
  chrome.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}
