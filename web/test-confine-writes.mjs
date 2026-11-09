// ci: web-runner order=117 chrome
// Confinement phase 2 (write trees; design PACKET-r3, astra's and daybreak3's DESIGN CLEAR), in headless Chromium,
// on the person's own notebook in the sandboxed runner:
//   - a write into a folder it may not change is refused; the prompt asks about that path, offering its folder, never
//     "/"; a synthetic click, a press begun before it arms, a repeating Enter: nothing; a fresh trusted click: allowed;
//   - a widening doesn't reach the interpreter that is running (a forged change into the new folder from it is kept
//     nowhere; a loop running when it's allowed stays refused there); the next explicit run starts a new interpreter,
//     which may; an automatic restart in between doesn't capture it (astra's binding pin);
//   - scoped: other folders, /proj/outx beside /proj/out, /tmpfile beside /tmp refused; /tmp changed and kept nowhere;
//   - a narrowing (another tab's, by its storage event) refuses a running loop at its next write ("changed"), and a
//     change still queued is kept nowhere;
//   - a rename is one change: refused into a folder it may not change (nothing moved); a forged rename with one path
//     outside is kept nowhere, wholly; one wholly inside is kept;
//   - Don't allow: silent for the rest of the session;
//   - a scoped notebook never runs in the page's own interpreter (?runner=0): it says why.
//   bun web/build.ts, then node web/test-confine-writes.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-confine-"));
const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", "--window-size=1280,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(150); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const W = "window.sagebrush.workspace";
const base = `http://127.0.0.1:${port}/`;
const go = async (url) => { await send("Page.navigate", { url }); await until("document.querySelector('#status')?.textContent.startsWith('ready')", 90000); await sleep(300); };
const at = async (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
const mouse = async (type, p) => send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
// (the person's own click: one the browser marks isTrusted)
const trusted = async (sel) => { const p = await at(sel); if (!p) throw new Error("no " + sel); await mouse("mousePressed", p); await mouse("mouseReleased", p); await sleep(200); };
const out = (i = 0) => ev(`[...document.querySelectorAll('#cells .cell')][${i}]?.querySelector('.out')?.textContent ?? ''`);
const setCode = (code, i = 0) => ev(`(() => { const ta = [...document.querySelectorAll('#cells .cell textarea')][${i}]; ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
const runAll = () => ev("sagebrush.notebook.runAll().then(() => 1)");
const outHas = (re, ms = 60000) => until(`${re}.test(document.querySelector('#cells .cell .out')?.textContent ?? '')`, ms);
const stat = (p) => ev(`${W}.stat(${JSON.stringify(p)}).then((e) => !!e, () => false)`);
const trees = () => ev("(() => { const g = sagebrush.permissions()?.grants?.write; return g ? [...g.stored, ...g.once].sort() : null; })()");
const prompt = () => ev("sagebrush.filesPrompt()");
const barText = () => ev("document.querySelector('#filesbar').hidden ? '' : document.querySelector('#fbtext').textContent");
// (a choice made in another tab: the record changed in storage, and this tab told by its storage event)
const otherTab = (f) => ev(`(() => { const k = "sagebrush-grants", r = JSON.parse(localStorage.getItem(k) ?? '{"v":1,"seq":0,"docs":{}}'), id = sagebrush.permissions().doc, e = (r.docs[id] ??= {}); (${f})(e); e.t = ++r.seq; localStorage.setItem(k, JSON.stringify(r)); window.dispatchEvent(new StorageEvent("storage", { key: k })); return 1; })()`);
const forged = (msg) => ev(`(() => { sagebrush.kernel.worker.onmessage?.({ data: ${msg} }); return 1; })()`);
const settle = () => sleep(1500);
// (an open prompt answered Don't allow, as a person would, before a section that expects one of its own: one at a time)
const dismiss = async () => { if (await prompt()) { await sleep(700); await trusted("#fbdeny"); } };
// (a write of a file into a folder that exists: the person's own folders, made first)
const TRY = (path, tag) => `try:\n    open(${JSON.stringify(path)}, 'w').write('x'); print('${tag}:ok')\nexcept PermissionError as e:\n    print('${tag}:refused', e)`;

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await go(base + "?runner=1");
  await until(`!!${W}`, 60000);
  for (const d of ["out", "other", "outx", "w2", "r", "q", "d", "once", "life", "oc"]) await ev(`${W}.create("/proj/${d}/keep.txt", { content: new TextEncoder().encode("k") }).then(() => 1)`);
  await ev(`(() => { document.querySelector('#filebtn')?.click(); document.querySelector('#filemenu [data-group="new"]')?.click(); document.querySelector('#filemenu [data-f="new"]').click(); return 1; })()`);
  await until("sagebrush.notebook.cells().length === 1 && !sagebrush.notebook.cells()[0].ta.value", 20000);
  await sleep(800);
  check(JSON.stringify(await trees()) === "[]", "a new notebook of the person's may change nothing yet (O1)");

  // ---- the prompt: the path's folder, never "/"; synthetic, early and repeating answers do nothing
  const scratch0 = await ev("sagebrush.files.scratchArrived()");
  await setCode("import os\n" + TRY("/proj/out/a.txt", "A"));
  await runAll();
  check(await outHas("/A:refused/"), "a write into /proj/out is refused: " + (await out()).trim().slice(0, 140));
  check(await until("!!sagebrush.filesPrompt()", 10000), "…and the prompt asks");
  const p0 = await prompt();
  // (a press begun before it arms, released after: nothing)
  const pa = await at("#fballow");
  await mouse("mousePressed", pa);
  check(p0?.path === "/proj/out/a.txt" && p0.folder === "/proj/out" && /wants to change \/proj\/out\/a\.txt/.test(await barText()) && /^Allow in \/proj\/out, then run again \(restarts\)$/.test(await ev("document.querySelector('#fballow').textContent")), "…about that path, offering its folder /proj/out (never /): " + JSON.stringify(p0));
  check(p0.armedIn > 0, "(the press began before it armed: " + p0.armedIn + " ms to go)");
  await sleep(700);
  await mouse("mouseReleased", pa);
  await sleep(200);
  check(JSON.stringify(await trees()) === "[]" && !!(await prompt()), "a press begun before the prompt armed, released after: nothing allowed");
  await ev("(document.querySelector('#fballow').click(), 1)");
  check(JSON.stringify(await trees()) === "[]", "a synthetic click: nothing allowed");
  await ev("(document.querySelector('#fballow').focus(), 1)");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, autoRepeat: true, isAutoRepeat: true });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(200);
  check(JSON.stringify(await trees()) === "[]", "a repeating Enter: nothing allowed");
  // (a press bound to its button, its request and the permissions' revision (astra's PROMPT934-3): one that leaves the
  // button before its release answers nothing; one held across a change of the permissions, even a change and its undoing,
  // answers nothing, and the prompt closes)
  await mouse("mousePressed", pa);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pa.x + 300, y: pa.y + 200, button: "left" });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pa.x, y: pa.y, button: "left" });
  await mouse("mouseReleased", pa);
  await sleep(200);
  check(JSON.stringify(await trees()) === "[]" && !!(await prompt()), "a press that left the button before its release: nothing allowed, the prompt still open");
  await mouse("mousePressed", pa);
  await otherTab(`(e) => { e.write = [...new Set([...(e.write ?? []), "/proj/zz9"])]; }`);
  await otherTab(`(e) => { e.write = (e.write ?? []).filter((x) => x !== "/proj/zz9"); }`);
  await mouse("mouseReleased", pa);
  await sleep(200);
  check(JSON.stringify(await trees()) === "[]" && !(await prompt()), "a press held across a change of the permissions and its undoing: nothing allowed, the prompt closed");
  // (the next refusal asks again; a fresh press answers it)
  await runAll();
  check(await until("!!sagebrush.filesPrompt()", 10000), "(the next run's refusal asks again)");
  await sleep(700);
  await trusted("#fballow");
  check(JSON.stringify(await trees()) === '["/proj/out"]' && !(await prompt()), "a fresh trusted click after it armed: /proj/out allowed, the prompt closed");
  // (File > Permissions… names the folders, and its switch allows everywhere: board's B3 on #934)
  check(await until(`document.querySelector('#permsfiles').textContent === "Allowed only in /proj/out: this notebook's code can't change files anywhere else." && document.querySelector('#filesperm').textContent === "Allow file changes anywhere"`, 5000), "File > Permissions…: allowed only in /proj/out, said so; its switch allows file changes anywhere: " + JSON.stringify(await ev("[document.querySelector('#permsfiles').textContent, document.querySelector('#filesperm').textContent]")));

  // ---- a widening doesn't reach the interpreter running; the next explicit run starts one that may
  await forged(`{ fsChanged: "/proj/out/forged.txt", data: new Uint8Array([1]) }`);
  await settle();
  check(!(await stat("/proj/out/forged.txt")), "a change into the new folder from the interpreter that was running (a forged one) is kept nowhere");
  // (an automatic restart in between keeps the old ceiling: its code can't write there either)
  await ev("(sagebrush.kernel.restart(), 1)");
  await until("sagebrush.kernel.ready", 30000);
  await sleep(500);
  const auto = await ev(`new Promise((res) => { let t = ''; sagebrush.kernel.execute(${JSON.stringify("import os\n" + TRY("/proj/out/auto.txt", "AUTO"))}, { mode: 'python' }, { start() {}, out(x) { t += x; }, display() {}, interact() {}, clear() {}, done() { res(t); }, stopped(m) { res(t + m); } }); })`);
  await settle();
  check(/AUTO:refused/.test(auto) && !(await stat("/proj/out/auto.txt")), "an automatic restart doesn't capture the widening: its code's write there is still refused: " + auto.trim().slice(0, 140));
  await ev("(window.__old = sagebrush.kernel.worker, 1)");
  await setCode("import os\n" + TRY("/proj/out/a.txt", "A") + "\n" + TRY("/proj/other/b.txt", "B") + "\n" + TRY("/proj/outx/c.txt", "C") + "\nos.makedirs('/tmp', exist_ok=True)\n" + TRY("/tmp/t.txt", "T") + "\n" + TRY("/tmpfile", "F"));
  await runAll();
  check(await outHas("/F:/"), "the next explicit run, in a new interpreter: " + (await out()).replace(/\n/g, " ").slice(0, 400));
  const o1 = await out();
  check(/A:ok/.test(o1) && /B:refused/.test(o1) && /C:refused/.test(o1) && /T:ok/.test(o1) && /F:refused/.test(o1), "…writes /proj/out; refuses /proj/other, /proj/outx beside it and /tmpfile beside /tmp; /tmp is scratch");
  check(await ev("sagebrush.files.scratchArrived()") === scratch0, "…its scratch (/tmp/t.txt) stays in its interpreter: nothing of it reaches the page");
  await settle();
  // (a change from an interpreter still waiting in the queue when an explicit run replaces it: kept nowhere, at its final
  // admission, though inside the folder)
  await ev("(window.__release = sagebrush.files.holdDrain(), 1)");
  await forged(`{ fsChanged: "/proj/out/queued-gen.txt", data: new Uint8Array([1]) }`);
  await until("sagebrush.files.queue().paths > 0", 5000);
  await ev("(sagebrush.kernel.restart(), 1)");
  await until("sagebrush.kernel.ready", 30000);
  await ev("(window.__release(), 1)");
  await settle();
  check(!(await stat("/proj/out/queued-gen.txt")), "a change queued from an interpreter that is then replaced is kept nowhere at its final admission, though inside the folder");
  // (a late change from the interpreter the explicit run replaced: another generation's, kept nowhere)
  await ev(`(() => { window.__old.onmessage?.({ data: { fsChanged: "/proj/out/late.txt", data: new Uint8Array([1]) } }); return 1; })()`);
  await settle();
  check(await ev("window.__old !== sagebrush.kernel.worker") && !(await stat("/proj/out/late.txt")), "a late change from the interpreter that run replaced (an older generation) is kept nowhere, inside the folder too");
  check((await stat("/proj/out/a.txt")) && !(await stat("/proj/other/b.txt")) && !(await stat("/proj/outx/c.txt")) && !(await stat("/tmp/t.txt")) && !(await stat("/tmpfile")), "…the workspace has /proj/out/a.txt only (/tmp kept nowhere)");

  // ---- the routes (§8): each of Python's ways of changing files, allowed inside /proj/out and refused outside
  await dismiss();
  const V = (tag, expr) => `try:\n    ${expr}; print('${tag}:ok')\nexcept PermissionError:\n    print('${tag}:refused')\nexcept Exception as e:\n    print('${tag}:' + type(e).__name__)`;
  await setCode(["import os, shutil, pathlib",
    V("append", "open('/proj/out/a.txt', 'a').write('y')"), V("mkdir", "os.mkdir('/proj/out/sub')"), V("pathlib", "pathlib.Path('/proj/out/p.txt').write_text('p')"),
    V("copy", "shutil.copy('/proj/out/a.txt', '/proj/out/c.txt')"), V("rename", "os.rename('/proj/out/c.txt', '/proj/out/d.txt')"), V("replace", "os.replace('/proj/out/d.txt', '/proj/out/e.txt')"), V("remove", "os.remove('/proj/out/e.txt')"),
    V("x-append", "open('/proj/other/keep.txt', 'a').write('y')"), V("x-mkdir", "os.mkdir('/proj/other/sub')"), V("x-pathlib", "pathlib.Path('/proj/other/p.txt').write_text('p')"),
    V("x-copy", "shutil.copy('/proj/out/a.txt', '/proj/other/c.txt')"), V("x-out", "os.rename('/proj/out/a.txt', '/proj/other/a.txt')"), V("x-in", "os.rename('/proj/other/keep.txt', '/proj/out/keep2.txt')"),
    V("x-remove", "os.remove('/proj/other/keep.txt')"), V("x-rmtree", "shutil.rmtree('/proj/other')"), "print('ROUTES:end')"].join("\n"));
  await runAll();
  check(await outHas("/ROUTES:end/"), "(each route tried)");
  const ro = await out();
  const inside = ["append", "mkdir", "pathlib", "copy", "rename", "replace", "remove"], outside = ["x-append", "x-mkdir", "x-pathlib", "x-copy", "x-out", "x-in", "x-remove", "x-rmtree"];
  check(inside.every((t) => new RegExp(`^${t}:ok$`, "m").test(ro)) && outside.every((t) => new RegExp(`^${t}:refused$`, "m").test(ro)), "Python: append, mkdir, pathlib, shutil.copy, rename, replace and remove allowed inside /proj/out; each refused outside it, a rename out of it and into it included: " + ro.replace(/\n/g, " ").slice(0, 400));
  await settle();
  check((await stat("/proj/out/p.txt")) && (await stat("/proj/other/keep.txt")) && !(await stat("/proj/other/p.txt")) && !(await stat("/proj/other/a.txt")) && !(await stat("/proj/out/keep2.txt")), "…the workspace agrees: changed inside, nothing changed outside");
  // (each language's own notebook: its writes refused, then allowed in /proj/out by the prompt; Magma has no
  // file-writing intrinsic on this master, so its row is the control: nothing is written)
  const nbOwn = await ev("localStorage.getItem('sagebrush-current')");
  for (const [mode, code, okRe] of [
    ["sage", "try:\n    open('/proj/out/sage.txt', 'w').write(str(factor(12))); print('SAGE:ok')\nexcept PermissionError:\n    print('SAGE:refused')", /SAGE:ok/],
    ["matlab", "try\n  f = fopen('/proj/out/matlab.txt', 'w'); fprintf(f, 'x'); fclose(f); disp('MATLAB:ok')\ncatch e\n  disp(['MATLAB:refused ' e.message])\nend", /MATLAB:ok/],
    ["magma", "PrintFile(\"/proj/out/magma.txt\", 1);\nprint \"MAGMA:end\";", null],
  ]) {
    await dismiss();
    await ev(`(() => { document.querySelector('#filebtn')?.click(); document.querySelector('#filemenu [data-group="new"]')?.click(); document.querySelector('#filemenu [data-f="new"]').click(); return 1; })()`);
    await until("sagebrush.notebook.cells().length === 1 && !sagebrush.notebook.cells()[0].ta.value", 20000);
    await ev(`(sagebrush.notebook.setMode(${JSON.stringify(mode)}), 1)`);
    await setCode(code);
    await runAll();
    if (!okRe) {
      check(await outHas("/MAGMA:end|not implemented/", 90000) && !(await stat("/proj/out/magma.txt")), "Magma: no file-writing intrinsic here (" + (await out()).trim().split("\n")[0].slice(0, 100) + "): nothing written");
      continue;
    }
    check(await outHas(`/${mode.toUpperCase()}:refused/`, 120000), `${mode}: its write into /proj/out is refused at first: ` + (await out()).trim().slice(0, 120));
    await until(`sagebrush.filesPrompt()?.folder === '/proj/out'`, 15000);
    await sleep(700);
    await trusted("#fballow");
    await runAll();
    check(await outHas(String(okRe), 120000) && (await (async () => { await settle(); return stat(`/proj/out/${mode}.txt`); })()), `${mode}: allowed in /proj/out by the prompt, the next run writes /proj/out/${mode}.txt`);
  }
  await go(base + "?nb=" + encodeURIComponent(nbOwn) + "&runner=1");

  // ---- a widening while a loop runs: still refused in that run; the next run may
  await dismiss();
  await setCode("import os, time\nfor i in range(24):\n    try:\n        open('/proj/w2/y.txt', 'w').write(str(i)); print('W2:ok', i)\n    except PermissionError:\n        print('W2:refused', i)\n    time.sleep(0.25)\nprint('LOOP:end')");
  await ev("(sagebrush.notebook.runAll(), 1)");
  check(await until("sagebrush.filesPrompt()?.folder === '/proj/w2'", 20000), "a loop refused at /proj/w2: the prompt asks for /proj/w2");
  await sleep(700);
  await trusted("#fballow");
  check(JSON.stringify(await trees()) === '["/proj/out","/proj/w2"]', "…allowed while the loop runs");
  check(await outHas("/LOOP:end/", 30000), "(the loop ends)");
  check(!/W2:ok/.test(await out()) && !(await stat("/proj/w2/y.txt")), "…and every write of that run stays refused, and nothing is kept: a widening reaches only the next run");
  await setCode("import os\n" + TRY("/proj/w2/y.txt", "Y"));
  await runAll();
  check(await outHas("/Y:ok/"), "the next run writes /proj/w2/y.txt");

  // ---- a policy reaches a running interpreter only between runs: a narrowing ELSEWHERE refuses the running loop's next
  // write ("permissions changed: run it again"), even into a folder that stays allowed (the new policy, which still covers
  // it, isn't adopted mid-run)
  await dismiss();
  await otherTab(`(e) => { e.write = [...new Set([...(e.write ?? []), "/proj/zz"])]; }`);
  await setCode("import time\nfor i in range(40):\n    try:\n        open('/proj/out/steady.txt', 'w').write(str(i)); print('s', i, flush=True)\n    except PermissionError as e:\n        print('stopped at', i, e); break\n    time.sleep(0.25)");
  await ev("(sagebrush.notebook.runAll(), 1)");
  await outHas("/s 3/", 30000);
  await otherTab(`(e) => { e.write = (e.write ?? []).filter((x) => x !== "/proj/zz"); }`);
  check(await outHas("/stopped at \\d+ .*permissions changed/", 20000), "a narrowing elsewhere (/proj/zz) refuses the running loop's next write into /proj/out, still allowed: the new policy waits for the next run: " + (await out()).trim().split("\n").slice(-1)[0].slice(0, 160));
  await settle();
  // ---- a narrowing (another tab's) refuses a running loop at its next write; a queued change is kept nowhere
  await dismiss();
  await setCode("import time\nh = open('/proj/w2/flight.txt', 'w')\nfor i in range(40):\n    try:\n        h.write('x'); h.flush(); print('w', i, flush=True)\n    except PermissionError as e:\n        print('refused at', i, e); break\n    time.sleep(0.25)");
  await ev("(sagebrush.notebook.runAll(), 1)");
  await outHas("/w 3/", 30000);
  await otherTab(`(e) => { e.write = (e.write ?? []).filter((x) => x !== "/proj/w2"); }`);
  check(await outHas("/refused at \\d+ .*permissions changed/", 20000), "another tab's narrowing refuses a running loop at its next write, through a file it opened before: " + (await out()).trim().split("\n").slice(-1)[0].slice(0, 160));
  await setCode("import os\n" + TRY("/proj/out/q.txt", "Q"));
  await ev("(window.__release = sagebrush.files.holdDrain(), 1)");
  await runAll();
  await outHas("/Q:ok/");
  await until("sagebrush.files.queue().paths > 0", 10000);
  await otherTab(`(e) => { e.write = (e.write ?? []).filter((x) => x !== "/proj/out"); }`);
  await ev("(window.__release(), 1)");
  await settle();
  check(!(await stat("/proj/out/q.txt")), "a change still queued when its folder is taken away is kept nowhere");

  // ---- a rename is one change
  await dismiss();
  await setCode("import os\n" + TRY("/proj/r/f.txt", "R"));
  await runAll();
  await until("sagebrush.filesPrompt()?.folder === '/proj/r'", 20000);
  await sleep(700);
  await trusted("#fballow");
  await setCode("import os\n" + TRY("/proj/r/f.txt", "R") + "\ntry:\n    os.rename('/proj/r/f.txt', '/proj/q/f.txt'); print('MV:ok')\nexcept Exception as e:\n    print('MV:' + type(e).__name__)");
  await runAll();
  check(await outHas("/MV:/"), "(a rename out of /proj/r)");
  await settle();
  check(/R:ok/.test(await out()) && /MV:PermissionError/.test(await out()) && (await stat("/proj/r/f.txt")) && !(await stat("/proj/q/f.txt")), "a rename into a folder it may not change is refused, and nothing moves: " + (await out()).replace(/\n/g, " ").slice(0, 160));
  await forged(`{ fsRename: { from: "/proj/r/f.txt", to: "/elsewhere/f.txt", changes: [["/proj/r/f.txt", null], ["/elsewhere/f.txt", new Uint8Array([1])]] } }`);
  await settle();
  check((await stat("/proj/r/f.txt")) && !(await stat("/elsewhere/f.txt")), "a rename with one path outside its folders (forged) is kept nowhere, wholly: the file stays where it was");
  // (what an interpreter sends is input (astra's Q934-1, daybreak3): a change shaped like the queue's rename batch, inside
  // a folder it may change, carrying a member outside; paths not in their one canonical form; bytes that aren't bytes; a
  // rename whose from, to or a member isn't canonical, or whose from is outside: each kept nowhere)
  await forged(`{ fsChanged: "/proj/r/shape.txt", data: { changes: [["/elsewhere/shape.txt", new Uint8Array([1])]] } }`);
  for (const p of ["/proj/r/../elsewhere/up.txt", "/proj/r//dbl.txt", "/proj/r/./dot.txt", "proj/r/rel.txt", "/proj/r/trail/", "/", "/proj/r/del\u007f.txt", "/proj/r/" + "n".repeat(256), "/proj/r/" + Array(40).fill("d").join("/")]) await forged(`{ fsChanged: ${JSON.stringify(p)}, data: new Uint8Array([1]) }`);
  await forged(`{ fsChanged: "/proj/r/str.txt", data: "not bytes" }`);
  await forged(`{ fsChanged: "/proj/r/arr.txt", data: [1, 2] }`);
  await forged(`{ fsRename: { from: "/proj/r/../elsewhere", to: "/proj/r/m2", changes: [["/proj/r/m2/a.txt", new Uint8Array([1])]] } }`);
  await forged(`{ fsRename: { from: "/elsewhere/src", to: "/proj/r/m3", changes: [["/proj/r/m3/a.txt", new Uint8Array([1])]] } }`);
  await forged(`{ fsRename: { from: "/proj/r/q", to: "/proj/r/m4", changes: [["/proj/r/m4/../../../elsewhere/b.txt", new Uint8Array([1])]] } }`);
  await settle();
  const leaked = [];
  for (const p of ["/proj/r/shape.txt", "/elsewhere/shape.txt", "/elsewhere/up.txt", "/proj/r/dbl.txt", "/proj/r/dot.txt", "/proj/r/rel.txt", "/proj/r/trail", "/proj/r/str.txt", "/proj/r/arr.txt", "/proj/r/m2/a.txt", "/proj/r/m3/a.txt", "/elsewhere/b.txt"]) if (await stat(p)) leaked.push(p);
  check(leaked.length === 0, "an interpreter's malformed changes are kept nowhere: batch-shaped data, non-canonical paths, bytes that aren't bytes, a rename with a non-canonical or outside from or member: " + JSON.stringify(leaked));
  await forged(`{ fsRename: { from: "/proj/r/f.txt", to: "/proj/r/h.txt", changes: [["/proj/r/f.txt", null], ["/proj/r/h.txt", new Uint8Array([104])]] } }`);
  await settle();
  check(!(await stat("/proj/r/f.txt")) && (await stat("/proj/r/h.txt")), "one wholly inside is kept, both of its changes");

  // ---- the queue (daybreak3's condition): a rename is one entry, in its place, counted whole, refused whole
  const keep = (p, d) => `["${p}", ${d === null ? "null" : `new TextEncoder().encode(${JSON.stringify(d)})`}]`;
  const text = (p) => ev(`${W}.read(${JSON.stringify(p)}).then((r) => new TextDecoder().decode(r.content), () => null)`);
  await ev("(window.__release = sagebrush.files.holdDrain(), 1)");
  await forged(`{ fsChanged: "/proj/r/o1.txt", data: new TextEncoder().encode("1") }`);
  await forged(`{ fsRename: { from: "/proj/r/o1.txt", to: "/proj/r/o2.txt", changes: [${keep("/proj/r/o1.txt", null)}, ${keep("/proj/r/o2.txt", "1")}] } }`);
  await forged(`{ fsChanged: "/proj/r/o1.txt", data: new TextEncoder().encode("2") }`);
  await ev("(window.__release(), 1)");
  await settle();
  check((await text("/proj/r/o1.txt")) === "2" && (await text("/proj/r/o2.txt")) === "1", "a write, then a rename of it, then a new write at its old path: kept in that order (o1 = 2, o2 = 1)");
  const q0 = await ev("sagebrush.files.queue()");
  await ev("(sagebrush.files.setQueueMax(8), 1)");
  await forged(`{ fsRename: { from: "/proj/r/big", to: "/proj/r/big2", changes: [${keep("/proj/r/big2/a.txt", "0123456789")}] } }`);
  const q1 = await ev("sagebrush.files.queue()");
  await ev("(sagebrush.files.setQueueMax(256 * 2 ** 20), 1)");
  await settle();
  check(q1.refused === q0.refused + 1 && q1.paths === 0 && q1.bytes === 0 && !(await stat("/proj/r/big2/a.txt")), "a rename past the queue's limit: refused whole, the queue's count unchanged: " + JSON.stringify([q0, q1]));
  await ev("(window.__release = sagebrush.files.holdDrain(), 1)");
  await forged(`{ fsRename: { from: "/proj/r/h.txt", to: "/proj/r/z.txt", changes: [${keep("/proj/r/h.txt", null)}, ${keep("/proj/r/z.txt", "h")}] } }`);
  await otherTab(`(e) => { e.write = (e.write ?? []).filter((x) => x !== "/proj/r"); }`);
  await ev("(window.__release(), 1)");
  await settle();
  check((await stat("/proj/r/h.txt")) && !(await stat("/proj/r/z.txt")) && (await ev("sagebrush.files.queue().paths")) === 0, "a rename queued, then its folder taken away: nothing of it kept, and nothing left waiting");
  // (taken away after the queue's final check, while the first change waits to be kept: its locked admission refuses, and
  // nothing of the rename is kept)
  await otherTab(`(e) => { e.write = [...new Set([...(e.write ?? []), "/proj/r"])]; }`);
  await runAll();
  await settle();
  check(await until("sagebrush.files.queue().paths === 0 && !sagebrush.files.queue().draining", 10000), "(nothing waiting before the rename)");
  await ev("(window.__keep = sagebrush.files.holdKeep(), 1)");
  await forged(`{ fsRename: { from: "/proj/r/h.txt", to: "/proj/r/y.txt", changes: [${keep("/proj/r/h.txt", null)}, ${keep("/proj/r/y.txt", "h")}] } }`);
  // (the rename taken from the queue, past its final check, and held where its first change is kept)
  check(await until("sagebrush.files.queue().paths === 0 && sagebrush.files.queue().draining", 10000), "(the rename past the queue's final check, held at its first change)");
  await otherTab(`(e) => { e.write = (e.write ?? []).filter((x) => x !== "/proj/r"); }`);
  await ev("(window.__keep(), 1)");
  await settle();
  check((await stat("/proj/r/h.txt")) && !(await stat("/proj/r/y.txt")), "taken away after the final check, before the first change is kept: nothing of the rename kept");

  // ---- a prompt closed unanswered at Stop and at a restart, and the next refusal asks again (PROMPT934-3)
  await dismiss();
  // (Stop while the cell that was refused still runs: the prompt it raised closes)
  await setCode("import os, time\n" + TRY("/proj/life/l.txt", "L") + "\nfor i in range(80):\n    print('k', i, flush=True); time.sleep(0.25)");
  await ev("(sagebrush.notebook.runAll(), 1)");
  check(await until("sagebrush.filesPrompt()?.folder === '/proj/life'", 10000) && await outHas("/k 2/", 20000), "(a refusal asks about /proj/life, its cell still running)");
  await ev("(document.querySelector('#stop').click(), 1)");
  check(await until("!sagebrush.filesPrompt()", 5000), "Stop (the cell still running) closes the open prompt unanswered");
  await until("sagebrush.kernel.ready", 30000);
  // (the same by the notebook's own Stop, as a cell's Stop button and the keyboard's i, i reach it: astra's follow-up)
  await ev("(sagebrush.notebook.runAll(), 1)");
  check(await until("sagebrush.filesPrompt()?.folder === '/proj/life'", 10000) && await outHas("/k 2/", 20000), "(asked again, its cell running)");
  await ev("(sagebrush.notebook.interrupt(), 1)");
  check(await until("!sagebrush.filesPrompt()", 5000), "the notebook's own Stop (a cell's, the keyboard's) closes the open prompt unanswered too");
  await until("sagebrush.kernel.ready", 30000);
  await setCode("import os\n" + TRY("/proj/life/l.txt", "L"));
  await runAll();
  check(await until("sagebrush.filesPrompt()?.folder === '/proj/life'", 10000), "…and the next refusal asks again");
  await ev("(sagebrush.kernel.restart(), 1)");
  check(await until("!sagebrush.filesPrompt()", 10000), "a restart closes the open prompt unanswered");
  await until("sagebrush.kernel.ready", 30000);
  await runAll();
  check(await until("sagebrush.filesPrompt()?.folder === '/proj/life'", 10000), "…and the next interpreter's refusal asks again");
  await dismiss();
  // (a refusal the interpreter reports with a path not in its canonical form, or past the workspace's own path rules: no
  // prompt; in a folder never refused, so a prompt could show)
  for (const p of ["/proj/fresh/../x.txt", "/proj/fresh//y.txt", "/proj/fresh/z\u007f.txt", "/proj/fresh/" + "n".repeat(256), "/proj/fresh/" + Array(40).fill("d").join("/")]) await forged(`{ fsRefused: ${JSON.stringify(p)}, what: "open" }`);
  await sleep(500);
  check(!(await prompt()), "a reported refusal with a non-canonical path asks nothing");

  // ---- "Allow once" (SESSION934-4): it takes effect in the interpreter its Run starts, and ends with it
  await dismiss();
  await setCode("import os\n" + TRY("/proj/once/o.txt", "O"));
  await runAll();
  check(await outHas("/O:refused/") && await until("sagebrush.filesPrompt()?.folder === '/proj/once'", 10000), "a write into /proj/once is refused, and the prompt asks for /proj/once");
  await sleep(700);
  await trusted("#fbonce");
  check((await ev("sagebrush.permissions().grants.write.once")).includes("/proj/once"), "Allow once: /proj/once allowed for now");
  // (an automatic restart while it waits for its Run doesn't spend it: that interpreter's ceiling can't use it)
  await ev("(sagebrush.kernel.restart(), 1)");
  await until("sagebrush.kernel.ready", 30000);
  check((await ev("sagebrush.permissions().grants.write.once")).includes("/proj/once"), "…an automatic restart before its Run leaves it waiting, not spent");
  await runAll();
  check(await outHas("/O:ok/"), "…the next run (a new interpreter) writes there");
  await ev("(sagebrush.kernel.restart(), 1)");
  await until("sagebrush.kernel.ready", 30000);
  await runAll();
  check(await outHas("/O:refused/") && !(await ev("sagebrush.permissions().grants.write.once")).includes("/proj/once"), "…and after the interpreter restarts, the once grant is gone: refused again");
  // (a once scope covered by a wider ceiling, everything allowed before its Run: it takes effect there all the same, so it
  // ends at the next start, not left behind; astra's r3 note)
  await dismiss();
  await setCode("import os\n" + TRY("/proj/oc/c.txt", "C"));
  await runAll();
  check(await until("sagebrush.filesPrompt()?.folder === '/proj/oc'", 10000), "(a refusal asks about /proj/oc)");
  await sleep(700);
  await trusted("#fbonce");
  await trusted("#filebtn"); await trusted("#permsmenu"); await trusted("#filesperm");
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  check(JSON.stringify(await trees()) .includes('"/"') && (await ev("sagebrush.permissions().grants.write.once")).includes("/proj/oc"), "(everything allowed, the once grant for /proj/oc still waiting)");
  await runAll();
  check(await outHas("/C:ok/"), "(the next run writes /proj/oc)");
  await ev("(sagebrush.kernel.restart(), 1)");
  await until("sagebrush.kernel.ready", 30000);
  check(!(await ev("sagebrush.permissions().grants.write.once")).includes("/proj/oc"), "a once scope that took effect under a wider ceiling (\"/\") still ends at the next start");
  await otherTab(`(e) => { e.write = (e.write ?? []).filter((x) => x !== "/"); }`);
  await dismiss();

  // ---- no shared memory, and the epoch's end: a narrowing restarts the interpreter instead
  await otherTab(`(e) => { e.write = [...new Set([...(e.write ?? []), "/proj/r", "/proj/out"])]; }`);
  await setCode("import time\nfor i in range(40):\n    print('t', i, flush=True); time.sleep(0.25)");
  await ev("(sagebrush.notebook.runAll(), 1)");
  await outHas("/t 3/", 30000);
  await ev("(sagebrush.kernel.epochShared = false, 1)");
  await otherTab(`(e) => { e.write = (e.write ?? []).filter((x) => x !== "/proj/r"); }`);
  check(await outHas("/permissions changed, so its interpreter was restarted/", 15000), "without shared memory, a narrowing ends the interpreter (a running loop is stopped): " + (await out()).trim().split("\n").slice(-1)[0]);
  await until("sagebrush.kernel.ready", 30000);
  await ev("(sagebrush.notebook.runAll(), 1)");
  await outHas("/t 3/", 30000);
  check((await ev("sagebrush.files.raiseEpoch(2 ** 31 - 2)")) === 2 ** 31 - 2, "(the interpreter's epoch raised to its end)");
  await otherTab(`(e) => { e.write = (e.write ?? []).filter((x) => x !== "/proj/out"); }`);
  check(await outHas("/permissions changed, so its interpreter was restarted/", 15000), "at the epoch's end, a narrowing starts a new interpreter rather than reuse an epoch");
  await until("sagebrush.kernel.ready", 30000);

  // ---- Don't allow: silent for the rest of the session
  await dismiss();
  await setCode("import os\n" + TRY("/proj/d/x.txt", "D"));
  await runAll();
  await until("sagebrush.filesPrompt()?.folder === '/proj/d'", 20000);
  await sleep(700);
  await trusted("#fbdeny");
  check(!(await prompt()) && !(await trees()).includes("/proj/d"), "Don't allow: nothing allowed, the prompt closed");
  await runAll();
  await outHas("/D:refused/");
  await sleep(800);
  check(!(await prompt()), "…and the same refusal again asks nothing, for the rest of the session");

  // ---- a scoped notebook never runs in the page's own interpreter
  await otherTab(`(e) => { e.write = ["/proj/out"]; }`);
  const sc = await trees();
  check(JSON.stringify(sc) === '["/proj/out"]', "(the notebook scoped to /proj/out: " + JSON.stringify(sc) + ")");
  const own = await ev("localStorage.getItem('sagebrush-current')");
  await go(base + "?nb=" + encodeURIComponent(own) + "&runner=0");
  await setCode("print('PLAIN')");
  await runAll();
  check(await outHas("/can't run here/", 30000) && !/PLAIN/.test(await out()), "?runner=0: a scoped notebook doesn't run in the page's own interpreter, and says why: " + (await out()).trim().slice(0, 120));

  // ---- the person's own flow, no test hook (@sagebrush, r5): File > Permissions… allows file changes, then the
  // person's Runs, each a trusted click into its cell and Shift+Enter: one cell writes a file, the next reads it, and the reader
  // depends on the writer through the file; then Run stale, the person's click, as the first Run after a widening
  await go(base + "?reactive&runner=1");
  await ev(`(() => { document.querySelector('#filebtn')?.click(); document.querySelector('#filemenu [data-group="new"]')?.click(); document.querySelector('#filemenu [data-f="new"]').click(); return 1; })()`);
  await until("sagebrush.notebook.cells().length === 1 && !sagebrush.notebook.cells()[0].ta.value && sagebrush.kernel?.ready", 30000);
  await sleep(800);
  await ev("(sagebrush.notebook.addCell(''), 1)");
  await setCode("with open('flow.txt', 'w') as f:\n    f.write('x' * 3)", 0);
  await setCode("print(len(open('flow.txt').read()))", 1);
  const key = async (k, code, vk) => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk }); await sleep(200); };
  // (the person's Run of a cell: a click into it, then Shift+Enter, each a trusted input)
  const runB = async (i) => {
    const p = await ev(`(() => { const t = [...document.querySelectorAll('#cells .cell textarea')][${i}]; t.scrollIntoView({ block: "center" }); const r = t.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
    await mouse("mousePressed", p); await mouse("mouseReleased", p); await sleep(200);
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
    await sleep(200);
  };
  const permsSwitch = async () => { await trusted("#filebtn"); await trusted("#permsmenu"); await trusted("#filesperm"); await key("Escape", "Escape", 27); };
  await permsSwitch();
  check((await ev("sagebrush.permissions()?.files")) === true, "the person's flow: File > Permissions… allows file changes (trusted clicks)");
  await runB(0);
  await until("!/running|queued/.test([...document.querySelectorAll('#cells .cell')][0].className)", 30000);
  await runB(1);
  check(await until("[...document.querySelectorAll('#cells .cell')][1]?.querySelector('.out')?.textContent.trim() === '3'", 30000), "…the writer run (Shift+Enter), then the reader: it reads the file written (" + JSON.stringify((await out(0)).trim().slice(0, 120)) + ", " + JSON.stringify((await out(1)).trim().slice(0, 120)) + ")");
  await setCode("with open('flow.txt', 'w') as f:\n    f.write('x' * 5)", 0);
  await runB(0);
  check(await until("[...document.querySelectorAll('#cells .cell')][1]?.querySelector('.out')?.textContent.trim() === '5'", 30000), "…the writer changed and run (Shift+Enter) reruns the reader: it depends on the writer through the file (" + JSON.stringify((await out(1)).trim()) + ")");
  // (a narrowing, then the widening again: the interpreter running keeps its narrowed ceiling until the person's next
  // Run, here Run stale)
  await permsSwitch();
  check((await ev("sagebrush.permissions()?.files")) === false, "(file changes stopped, by the switch)");
  await permsSwitch();
  check((await ev("sagebrush.permissions()?.files")) === true, "(and allowed again)");
  await setCode("with open('flow.txt', 'w') as f:\n    f.write('x' * 7)", 0);
  // (a restart, not a Run, keeps the narrowed ceiling (every start but an explicit Run's does), and makes every cell
  // stale: Run stale is then the person's first Run since the widening)
  await ev("(sagebrush.notebook.restart(), 1)");
  await until("sagebrush.kernel?.ready === true", 30000);
  const staleShown = await until("!document.querySelector('#runstale').hidden", 15000);
  if (staleShown) await trusted("#runstale");
  check(staleShown && (await until("[...document.querySelectorAll('#cells .cell')][1]?.querySelector('.out')?.textContent.trim() === '7'", 30000)), "Run stale, the person's click as the first Run after a widening, starts a new interpreter that may change files: the writer and its reader run (" + JSON.stringify({ shown: staleShown, out0: (await out(0)).trim().slice(0, 120), out1: (await out(1)).trim().slice(0, 120) }) + ")");
} catch (e) {
  check(false, "threw: " + (e?.stack ?? e));
} finally {
  const gone = chrome.exitCode !== null ? Promise.resolve() : new Promise((r) => chrome.once("exit", r));
  chrome.kill(); serve.kill();
  await Promise.race([gone, sleep(5000)]);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
