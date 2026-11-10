// ci: web-browser/terminal.3 order=10 runner=bun
// The terminal panel on the notebook and board pages (plan-bash-shell r8c E5; plan-term-xterm r2.7 PR 2: the screen is
// xterm): a smoke test in headless Chromium against web/dist.  ⋯ ▸ Terminal opens the dock; commands run through the
// page's ShellHost with the person principal, typed with real key events into xterm's input: text, SGR colour, cd
// carried, stderr and a non-zero exit; the input sources (a query's answer in the output never becomes input; a paste
// is the panel's; an IME Enter never submits); the OUT-ISO rules on the shell's output (OSC 52, OSC 8, the title);
// E5.8's keys, caps, placement and screen-reader order; the page commands; the r1 reviews' findings (board TP-1..TP-9);
// the front order with the console and the room below the page.  What the screen holds is read from xterm's buffer.
//   bun web/build.ts && bun web/shell/test-panel-page.mjs [SHOT.png]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = join(import.meta.dir, "..");
if (!existsSync(join(here, "dist", "shell", "preview-set.json"))) throw new Error("build web/dist first (bun web/build.ts)");
let checks = 0;
const fails = [];
const check = (ok, what) => {
  checks++;
  if (!ok) fails.push(what);
  console.log(`${ok ? "ok" : "FAIL"} ${what}`);
};
let server = null, chrome = null;
const profile = mkdtempSync(join(tmpdir(), "sb-test-panel-"));
try {
  const port = await startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
  const url = `http://127.0.0.1:${port}/`;
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1100,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
  const dport = await devtoolsPort(profile);
  const target = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id));
  };
  // (a DevTools call that never answers is a failure in words, never a hang)
  const send = (method, params = {}) => new Promise((r, j) => {
    const id = ++seq;
    const t = setTimeout(() => (waiting.delete(id), j(new Error(`DevTools ${method} gave no answer in 30 s`))), 30000);
    waiting.set(id, (m) => (clearTimeout(t), r(m)));
    if (process.env.TRACE) console.log("trace", method, JSON.stringify(params).slice(0, 140));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const until = async (expr, ms = 30000) => {
    const t = Date.now();
    for (;;) {
      const v = await evaluate(expr);
      if (v && !v.error) return v;
      if (Date.now() - t > ms) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const pause = (ms) => new Promise((res) => setTimeout(res, ms));
  // (real keys, as the keyboard sends them: they reach xterm's input and the panel's key handler)
  const VK = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Home: 36, End: 35 };
  const realKey = async (key, { ctrl = false, shift = false, code = key.length === 1 ? "Key" + key.toUpperCase() : key, text } = {}) => {
    const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const vk = VK[key] ?? key.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  };
  const type = async (s) => { for (const ch of s) await realKey(ch, { text: ch, code: "" }); };
  const T = "window.__sbTerm";
  const TA = `document.querySelector(".sb-term .xterm-helper-textarea")`;
  const focusTerm = () => evaluate(`${T}.term.focus(), 1`);
  // (the screen's lines after a marker: the buffer's logical lines, wrapped rows joined, trailing spaces trimmed)
  await send("Page.navigate", { url });
  check(!!(await until(`(() => { const b = document.querySelector("#termbtn"); return b && !b.hidden; })()`)), "⋯ ▸ Terminal shows on a local host");
  // (TESTS973-1: before the Terminal is ever opened, there is no End terminal session…)
  check(await evaluate(`document.querySelector("#termendbtn")?.hidden === true`), "H9: a fresh page, the Terminal never opened: End terminal session… hidden");
  const HELPERS = `window.confirm = () => true; window.__lines = (from, to) => { const t = window.__sbTerm.term, b = t.buffer.active, out = [];
      for (let i = from; i < to; i++) { const l = b.getLine(i); if (!l) continue; const s = l.translateToString(true); if (l.isWrapped && out.length) out[out.length - 1] += s; else out.push(s); }
      return out; };
    window.__cursorLine = () => { const b = window.__sbTerm.term.buffer.active; return b.baseY + b.cursorY; };`;
  // (a preview host's notice gutter and the alpha notice lifted above it, as web/preview/notice.js lays them out:
  // the dock must stack above both, so neither covers the prompt; William's first finding)
  await evaluate(`(() => {
    const g = document.createElement("div"); g.id = "sb-preview-notice";
    g.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:44px;background:#eee;z-index:2147483001";
    document.body.append(g);
    const a = document.getElementById("sb-alpha-banner");
    if (a) a.style.bottom = "44px";
  })()`);
  await evaluate(`document.querySelector("#termbtn").click()`);
  check(!!(await until(`(() => { const t = document.querySelector(".sb-term"); return t && !t.hidden && !!${T}; })()`, 15000)), "the dock opens");
  await evaluate(HELPERS);
  // (T358-2/3: the intro above the screen, in the tab's first terminal: a static line, not live, describing the input)
  const intro = await evaluate(`(() => { const i = document.querySelector(".sb-term-intro"); const t = ${TA}; const body = document.querySelector(".sb-term-body");
    return i && { text: i.textContent, live: i.getAttribute("aria-live"), role: i.getAttribute("role"), described: (t.getAttribute("aria-describedby") || "").split(" "),
      above: i.getBoundingClientRect().bottom <= body.getBoundingClientRect().top + 1 }; })()`);
  check(intro && /Trash/.test(intro.text) && /other devices/.test(intro.text) && !intro.live && !intro.role && intro.described.includes("sb-term-intro") && intro.described.includes("sb-term-note") && intro.above,
    `T358-3: the intro, above the screen, static, describing the input: ${JSON.stringify(intro)}`);
  check(!!(await until(`!!document.querySelector(".sb-term-loading") || document.querySelector(".sb-term").dataset.startMs !== undefined`, 5000)), "opening shows 'Starting the shell…' while bash loads (or it was already up)");
  check(!!(await until(`document.querySelector(".sb-term").dataset.startMs !== undefined && !document.querySelector(".sb-term-loading")`, 30000)), "the loading line goes once the shell is up");
  const covered = await evaluate(`(() => {
    const body = document.querySelector(".sb-term-body").getBoundingClientRect();
    const tops = ["sb-alpha-banner", "sb-preview-notice"].map((id) => document.getElementById(id)).filter(Boolean).map((e) => e.getBoundingClientRect().top);
    return { bottom: body.bottom, tops, focused: document.activeElement === ${TA} };
  })()`);
  check(covered && covered.tops.every((t) => covered.bottom <= t + 1) && covered.focused, `the screen is above every bottom overlay, and its input focused: ${JSON.stringify(covered)}`);
  const xt = await evaluate(`({ addons: ${T}.term._addonManager?._addons?.length ?? null, srm: ${T}.term.options.screenReaderMode, sb: ${T}.term.options.scrollback })`);
  check(xt.srm === true && xt.sb === 6000, `xterm: screenReaderMode on, scrollback 6 000 rows: ${JSON.stringify(xt)}`);

  // one command: the editor's line set, a real Enter, the polite status after its output; then the output read from
  // the screen, between the line of its prompt and the next prompt.  (A wait that runs out is a failure, never a slow pass.)
  const run = async (cmd) => {
    await focusTerm();
    const from = await evaluate(`(() => { document.querySelector(".sb-term-status").textContent = ""; ${T}.editor.reset(${JSON.stringify(cmd)}); return window.__cursorLine(); })()`);
    await realKey("Enter");
    if (/^\s*(?:clear|reset)\s*$/.test(cmd)) {
      await until(`!${T}.writer.writing && ${T}.cmd === null`, 10000);
      await pause(100);
      return { status: await evaluate(`document.querySelector(".sb-term-status").textContent`), cwd: await evaluate(`document.querySelector(".sb-term-cwd").textContent`) };
    }
    if (!(await until(`!document.querySelector(".sb-term").classList.contains("running") && document.querySelector(".sb-term-status").textContent !== "" && !${T}.writer.writing`, 60000)))
      throw new Error(`run(${JSON.stringify(cmd)}): no status within 60 s`);
    return evaluate(`(() => {
      const lines = window.__lines(Math.max(0, ${from} - 2), window.__cursorLine());
      const start = lines.findLastIndex((l, i) => l.includes(" $ ") && l.trimEnd().endsWith(${JSON.stringify(cmd.split("\n")[0].trimEnd())}));
      let out = lines.slice(start + 1 + ${cmd.split("\n").length - 1});
      let exit = null;
      if (out.length && /^(exit \\d+.*|\\^C \\(stopped\\)|the shell is unavailable: .*)$/.test(out.at(-1))) exit = out.pop();
      return { out: out.length ? out.join("\\n") + "\\n" : "", exit, status: document.querySelector(".sb-term-status").textContent, cwd: document.querySelector(".sb-term-cwd").textContent, start };
    })()`);
  };
  // (a cell's colour on the screen: the first cell holding `ch` in the last 60 lines)
  const fgOf = (ch) => evaluate(`(() => { const b = ${T}.term.buffer.active; for (let y = b.length - 1; y >= Math.max(0, b.length - 60); y--) { const l = b.getLine(y); for (let x = 0; x < l.length; x++) { const c = l.getCell(x); if (c.getChars() === ${JSON.stringify(ch)}) return { fg: c.getFgColor(), palette: c.isFgPalette() }; } } return null; })()`);
  let r = await run("echo hello");
  check(r?.out === "hello\n" && r.status === "done", `echo: ${JSON.stringify(r)}`);
  r = await run("printf '\\033[31mQ\\033[0m plain\\n'");
  const q = await fgOf("Q");
  check(r?.out === "Q plain\n" && q?.palette && q.fg === 1, `SGR 31 colours the cell red (palette 1): ${JSON.stringify({ r, q })}`);
  r = await run("mkdir -p tdir && cd tdir");
  check(r?.cwd === "/tdir", `cd carries to the header: ${r?.cwd}`);
  r = await run("pwd");
  check(r?.out === "/tdir\n", `the next command runs in it: ${JSON.stringify(r?.out)}`);
  r = await run("echo oops >&2; exit 3");
  const ops = await fgOf("o");
  check(r?.out === "oops\n" && ops?.palette && ops.fg === 1 && r?.exit === "exit 3" && r?.status === "exit 3", `stderr in red, exit 3 shown and announced: ${JSON.stringify({ r, ops })}`);
  r = await run("printf '<b>x</b>\\n'");
  check(r?.out === "<b>x</b>\n" && (await evaluate(`!document.querySelector(".sb-term b")`)), "markup from data stays text");

  // ---- the input sources (plan §2, astra TX1): what the output asks never becomes input
  await evaluate(`window.__execs = 0; const ex = ${T}.opts.host.exec.bind(${T}.opts.host); ${T}.opts.host.exec = (...a) => (window.__execs++, ex(...a)); 1`);
  r = await run("printf 'q\\033[6n\\033[c\\033[>c\\033[?1000h\\n'");
  await pause(300);
  const after = await evaluate(`({ buf: ${T}.editor.buf, execs: window.__execs })`);
  check(r?.status === "done" && after.buf === "" && after.execs === 1, `DSR, DA and a mouse-mode request in the output: no input, no extra command (${JSON.stringify(after)})`);
  // (a query split across the 64 KiB slices of one output, and one in the last slice)
  r = await run("printf 'a%.0s' $(seq 1 65534); printf '\\033[6n'; printf 'b%.0s' $(seq 1 70000); printf '\\033[c\\n'");
  await pause(300);
  check(r?.status === "done" && (await evaluate(`${T}.editor.buf`)) === "" && (await evaluate(`window.__execs`)) === 2, "queries at a slice edge and in the last slice: still no input");
  // (the positive control: once the output is drawn, a real key does reach the editor)
  await focusTerm();
  await type("ok");
  check((await evaluate(`${T}.editor.buf`)) === "ok", "the control: after the output, real typing reaches the line");
  await realKey("u", { ctrl: true });
  // (a paste is the panel's: it goes into the line, never runs by itself; a many-line paste then runs as one script on Enter)
  await evaluate(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", "echo one\\r\\necho two"); ${TA}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  check((await evaluate(`${T}.editor.buf`)) === "echo one\necho two" && (await evaluate(`window.__execs`)) === 2, "a paste goes into the line, line ends normalized, and doesn't run");
  r = await run("echo one\necho two");
  check(r?.out === "one\ntwo\n", `on Enter a many-line line runs as one script: ${JSON.stringify(r?.out)}`);
  // (TP-4: an input method's Enter confirms its composition, never a submit)
  await evaluate(`${T}.editor.reset("echo 日本")`);
  const ex4 = await evaluate(`window.__execs`);
  await evaluate(`${TA}.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, keyCode: 229, bubbles: true, cancelable: true })), 1`);
  await pause(200);
  check((await evaluate(`window.__execs`)) === ex4 && (await evaluate(`${T}.editor.buf`)) === "echo 日本", "TP-4: Enter while composing runs nothing and keeps the line");
  await evaluate(`${TA}.dispatchEvent(new CompositionEvent("compositionend", { data: "語", bubbles: true })), 1`);
  check((await evaluate(`${T}.editor.buf`)) === "echo 日本語", "an input method's text arrives from compositionend");
  // (grader X5: a browser that follows compositionend with an insertText of the same text: the text arrives once)
  await evaluate(`(() => { ${TA}.dispatchEvent(new CompositionEvent("compositionend", { data: "本", bubbles: true })); ${TA}.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "本", bubbles: true })); return 1; })()`);
  check((await evaluate(`${T}.editor.buf`)) === "echo 日本語本", `X5: compositionend then the same insertText: inserted once: ${JSON.stringify(await evaluate(`${T}.editor.buf`))}`);
  // (grader X7: a phone keyboard: keydown 229, not composing, then insertText: inserted once; its Enter (229, then
  // insertLineBreak) never submits)
  await evaluate(`${T}.editor.reset("echo ")`);
  const ex7 = await evaluate(`window.__execs`);
  await evaluate(`(() => { const k = (key) => { const e = new KeyboardEvent("keydown", { key, keyCode: 229, isComposing: false, bubbles: true, cancelable: true }); Object.defineProperty(e, "keyCode", { get: () => 229 }); ${TA}.dispatchEvent(e); };
    k("Unidentified"); ${TA}.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "ph", bubbles: true }));
    k("Enter"); ${TA}.dispatchEvent(new InputEvent("input", { inputType: "insertLineBreak", bubbles: true })); return 1; })()`);
  await pause(200);
  check((await evaluate(`${T}.editor.buf`)) === "echo ph" && (await evaluate(`window.__execs`)) === ex7, `X7: a phone keyboard's text inserted once, its 229 Enter never submits: ${JSON.stringify(await evaluate(`${T}.editor.buf`))}`);
  // (#854 follow-up X6: text the browser inserts with no keydown at all (the OS emoji picker, dictation) is inserted
  // once; a key the panel takes is still inserted once, not again by its input event)
  await evaluate(`${T}.editor.reset("echo ")`);
  await evaluate(`${TA}.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "\u{1F600}", bubbles: true })), 1`);
  await pause(100);
  const x6 = await evaluate(`${T}.editor.buf`);
  await focusTerm();
  await type("z");
  await pause(100);
  check(x6 === "echo \u{1F600}" && (await evaluate(`${T}.editor.buf`)) === "echo \u{1F600}z", `X6: an emoji picker's text (no keydown) inserted once, and a typed key after it once: ${JSON.stringify(await evaluate(`${T}.editor.buf`))}`);
  await evaluate(`${T}.editor.reset("")`);

  // ---- OUT-ISO on the shell's output (the rules of web/term/xterm-view.ts, shared with the remote terminal)
  await evaluate(`window.__clip = 0; navigator.clipboard.writeText = async () => { window.__clip++; }; window.__opened = []; window.open = (...a) => (window.__opened.push(a), null); 1`);
  r = await run("printf '\\033]52;c;aGVsbG8=\\007\\033]0;<img src=x onerror=window.__pwn=1>T\\007done\\n'");
  check(r?.out === "done\n" && (await evaluate(`window.__clip`)) === 0, "OSC 52 doesn't write the clipboard");
  const title = await evaluate(`({ text: document.querySelector(".sb-term-title").textContent, img: !!document.querySelector(".sb-term img"), pwn: window.__pwn })`);
  check(title.text.startsWith("<img") && !title.img && title.pwn === undefined, `a title is text in the header, never markup: ${JSON.stringify(title)}`);
  r = await run(`printf '\\033]0;%s\\007\\n' "$(printf 'T%.0s' $(seq 1 300))"`);
  check((await evaluate(`document.querySelector(".sb-term-title").textContent.length`)) === 120, "a long title is capped at 120 characters");
  r = await run("printf '\\033]8;;javascript:window.__pwn2=1\\033\\\\JSLINK\\033]8;;\\033\\\\\\n'");
  check(r?.out === "JSLINK\n" && (await evaluate(`window.__opened.length`)) === 0, "a javascript: OSC 8 link shows its text and opens nothing");

  // clear and reset: the panel's own (William: both said "command not found")
  await run("clear");
  check((await evaluate(`window.__lines(0, ${T}.term.buffer.active.length).filter((l) => l !== "").length`)) <= 1, "clear empties the screen (the prompt stays)");
  r = await run("echo after-clear");
  check(r?.out === "after-clear\n", "commands run after clear");
  // (H8: scrolled up after a long output, a key typed or a paste brings the screen back to the prompt)
  await run("seq 1 150");
  const view = () => evaluate(`(() => { const b = ${T}.term.buffer.active; return { y: b.viewportY, base: b.baseY }; })()`);
  await evaluate(`${T}.term.scrollToTop(), 1`);
  const up8 = await view();
  await focusTerm();
  await type("e");
  await pause(100);
  const typed8 = await view();
  await evaluate(`${T}.term.scrollToTop(), 1`);
  await evaluate(`(() => { const d = new DataTransfer(); d.setData("text/plain", "cho h8"); ${TA}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true })); return 1; })()`);
  await pause(100);
  const pasted8 = await view();
  check(up8.base > 20 && up8.y < up8.base && typed8.y === typed8.base && pasted8.y === pasted8.base && (await evaluate(`${T}.editor.buf`)) === "echo h8",
    `H8: scrolled up, a key typed and a paste each bring the screen back to the prompt: ${JSON.stringify({ up8, typed8, pasted8 })}`);
  await evaluate(`${T}.term.scrollToTop(), 1`);
  r = await run("echo h8-after");
  check(r?.out === "h8-after\n" && (await view()).y === (await view()).base, "H8: and Enter runs from there, the screen at the prompt");
  // (TESTS970: a Tab that completes scrolls too; the browser's own keys (Shift+Tab) and a Tab the prompt declines
  //  (an empty line: focus moves on) leave the screen where it was)
  await run("seq 1 150");
  await focusTerm();
  await evaluate(`${T}.editor.reset("ech"), ${T}.term.scrollToTop(), 1`);
  await realKey("Tab");
  const done70 = await until(`${T}.editor.buf === "echo "`, 10000);
  const tab70 = await view();
  // (and a Tab that lists the candidates (two of them: "e" names several commands) brings it back too)
  await evaluate(`${T}.editor.reset("e"), 1`);
  await focusTerm();
  await evaluate(`${T}.term.scrollToTop(), 1`);
  await realKey("Tab");
  await pause(300);
  await realKey("Tab");
  await pause(500);
  const list70 = { ...(await view()), buf: await evaluate(`${T}.editor.buf`) };
  await evaluate(`${T}.editor.reset(""), 1`);
  await focusTerm();
  await evaluate(`${T}.term.scrollToTop(), 1`);
  await realKey("Tab", { shift: true });
  await pause(200);
  const shift70 = await view();
  await focusTerm();
  await evaluate(`${T}.term.scrollToTop(), 1`);
  await realKey("Tab");
  await pause(500);
  const empty70 = await view();
  check(done70 && tab70.y === tab70.base && tab70.base > 20 && list70.y === list70.base && shift70.y === 0 && empty70.y === 0,
    `H8: a completing Tab, or one that lists the candidates, brings the screen back; Shift+Tab and a declined Tab leave it scrolled up: ${JSON.stringify({ done70, tab70, list70, shift70, empty70 })}`);
  await focusTerm();
  await run("reset");
  r = await run("pwd");
  check(r?.out === "/tdir\n" && r?.status === "done", `after reset a fresh shell runs, in the same directory: ${JSON.stringify(r)}`);
  // (r5, ENGINE E3: reset while a start is under way: the start adopted and finished first, never cleared or
  // overlapped; the admission held meanwhile, so another Enter is refused with the line kept)
  await evaluate(`(() => { const t = ${T}, h = t.opts.host; window.__ends = 0; const e0 = h.endShell.bind(h); h.endShell = (w) => (window.__ends++, e0(w));
    t.ready = false; t.starting = new Promise((r) => (window.__startGo = () => { t.ready = true; r(); })); return 1; })()`);
  await focusTerm();
  await evaluate(`${T}.editor.reset("reset"), 1`);
  await realKey("Enter");
  await pause(200);
  await evaluate(`${T}.editor.reset("echo early"), 1`);
  await realKey("Enter");
  const e3 = await evaluate(`({ ends: window.__ends, held: ${T}.cmd !== null, buf: ${T}.editor.buf, note: document.querySelector(".sb-term-note").textContent })`);
  check(e3.ends === 0 && e3.held && e3.buf === "echo early" && e3.note === "A command is running: Stop it first.", `reset during a start: the start not ended, the admission held, another Enter refused with its line kept: ${JSON.stringify(e3)}`);
  await evaluate(`window.__startGo(), 1`);
  check(!!(await until(`${T}.cmd === null && ${T}.ready && window.__ends === 1`, 20000)), "and once that start is done: one end, one fresh start, the admission let go");
  // (grader A4: an Enter the editor refuses (a reverse search's match past the bound) lets its admission go: the next
  // command runs)
  await evaluate(`(() => { const t = ${T}, h = t.editor.history; h.entries.push("y".repeat(t.editor.maxBytes + 1)); t.editor.search = { q: "y", at: h.entries.length - 1, failed: false, saved: "", savedCur: 0 }; return 1; })()`);
  await focusTerm();
  await realKey("Enter");
  const a4 = await evaluate(`({ cmd: ${T}.cmd, note: document.querySelector(".sb-term-note").textContent })`);
  // (the panel's admission let go at once, before the next Enter: #854 r8)
  check(a4.cmd === null && /^Not typed:/.test(a4.note), `A4: the refused Enter's admission is let go at once: ${JSON.stringify(a4)}`);
  await evaluate(`(() => { const t = ${T}; t.editor.history.entries.pop(); t.editor.search = null; t.editor.reset(""); return 1; })()`);
  r = await run("echo a4");
  check(a4.cmd === null && /^Not typed:/.test(a4.note) && r?.out === "a4\n", `A4: a refused Ctrl-R Enter lets its admission go; the next command runs: ${JSON.stringify(a4)} ${JSON.stringify(r?.out)}`);
  // (r6: the start it waits on fails instead: the reset still ends cleanly with a fresh start, the admission let go)
  await evaluate(`(() => { const t = ${T}; t.ready = false; t.starting = new Promise((_, j) => (window.__startNo = () => j(new Error("start failed")))); return 1; })()`);
  await evaluate(`${T}.editor.reset("reset"), 1`);
  await realKey("Enter");
  await pause(100);
  await evaluate(`window.__startNo(), 1`);
  check(!!(await until(`${T}.cmd === null && ${T}.ready && window.__ends === 2`, 20000)), "a reset whose awaited start fails: one end, one fresh start, the admission let go");
  await evaluate(`${T}.editor.reset(""), 1`);
  // open, ps, top: the panel's own (William's P1)
  r = await run("cd /");
  r = await run("ps");
  check(/^PID\s+TAB\s+KIND\s+STATE\s+TIME\s+MEM\s+NAME\n/.test(r?.out ?? "") && /notebook\s+\S+\s+\d\d:\d\d:\d\d.*\[this tab\]/.test(r.out) && /terminal\s+running/.test(r.out),
    `ps lists this tab's notebook and its terminal (running ps itself): ${JSON.stringify(r?.out)}`);
  await send("Target.createTarget", { url });
  await pause(6000);
  r = await run("ps");
  const nbRows = (r?.out ?? "").split("\n").filter((l) => /\snotebook\s/.test(l));
  check(nbRows.length >= 2 && nbRows.some((l) => !l.includes("[this tab]")), `ps lists another tab's notebook: ${JSON.stringify(r?.out)}`);
  await send("Target.createTarget", { url: url + "board/?new=python" });
  await pause(8000);
  r = await run("ps");
  check(/\sboard\s+\S+\s+\d\d:\d\d:\d\d.*\.board\.json\s+\(python\)/.test(r?.out ?? ""), `ps lists a board tab, with its path and language: ${JSON.stringify(r?.out)}`);
  await send("Page.bringToFront");
  r = await run("open no-such-file.txt");
  check(/open: no-such-file.txt: No such file or directory/.test(r?.out ?? "") && r?.exit === "exit 1" && r?.status === "exit 1", `open: a missing path is an error: ${JSON.stringify(r)}`);
  r = await run("open");
  check(/^usage: open FILE/.test(r?.out ?? "") && r?.exit === "exit 2", `open with no file: usage, exit 2: ${JSON.stringify(r)}`);
  const ls = await run("ls -1");
  const nbFile = (ls?.out ?? "").split("\n").find((l) => l.endsWith(".ipynb"));
  if (nbFile) {
    r = await run(`open '${nbFile}'`);
    check(r?.out === `opened /${nbFile} (a notebook, in a new tab)\n` && r?.status === "done", `open a notebook: ${JSON.stringify(r)}`);
  } else check(false, `ls shows a notebook to open: ${JSON.stringify(ls?.out)}`);
  await send("Page.bringToFront");
  r = await run("echo 'ps | grep' | cat");
  check(r?.out === "ps | grep\n", "a line with shell syntax goes to bash, not the panel's commands");
  // top: refreshed in place until Stop
  await focusTerm();
  await evaluate(`document.querySelector(".sb-term-status").textContent = ""; ${T}.editor.reset("top")`);
  const topFrom = await evaluate(`window.__cursorLine()`);
  await realKey("Enter");
  await pause(2500);
  const t1 = await evaluate(`window.__lines(${topFrom}, window.__cursorLine() + 1).join("\\n")`);
  const topCount = (t1.match(/^top - /gm) || []).length;
  check(/top - \d\d:\d\d:\d\d\s+\d+ tabs?, \d+ documents?, \d+ running/.test(t1 ?? "") && topCount === 1 && (await evaluate(`document.querySelector(".sb-term").classList.contains("running")`)) === true,
    `top shows a live listing, refreshed in place (one listing on screen), and keeps running: ${topCount}; ${JSON.stringify((t1 ?? "").slice(0, 120))}`);
  await evaluate(`document.querySelector(".sb-term-stop").click()`);
  check(!!(await until(`!document.querySelector(".sb-term").classList.contains("running") && document.querySelector(".sb-term-status").textContent === "done"`, 5000)), "Stop ends top");

  // ---- E5.8: keys, placement and the screen-reader order
  const running = () => evaluate(`document.querySelector(".sb-term").classList.contains("running")`);
  const LOOP = "i=0; while true; do i=$((i+1)); done";
  const start = async (cmd) => { await focusTerm(); await evaluate(`document.querySelector(".sb-term-status").textContent = ""; ${T}.editor.reset(${JSON.stringify(cmd)})`); await realKey("Enter"); };
  await start(LOOP);
  check(!!(await until(`document.querySelector(".sb-term").classList.contains("running")`, 10000)), "a long command runs");
  // (Enter while a command runs: no submit, no queue, the line kept as typed ahead, the note)
  await type("echo queued");
  const exQ = await evaluate(`window.__execs`);
  await realKey("Enter");
  check((await evaluate(`window.__execs`)) === exQ && (await evaluate(`${T}.editor.buf`)) === "echo queued" && (await evaluate(`document.querySelector(".sb-term-note").textContent`)) === "A command is running: Stop it first.",
    "Enter while running: nothing submitted or queued, the typed-ahead line kept, the note shown");
  // (r4 12, astra T854-5, daybreak3 E4: Ctrl-R, a match, Enter while a command runs: refused by the one admission
  // before the editor takes the line; the search stays as it was, nothing submitted, the history untouched)
  await evaluate(`document.querySelector(".sb-term-note").textContent = ""`);
  const hQ = await evaluate(`${T}.editor.history.entries.length`);
  await realKey("r", { ctrl: true });
  await type("i=0");
  await realKey("Enter");
  const rsQ = await evaluate(`({ s: !!${T}.editor.search, q: ${T}.editor.search?.q, h: ${T}.editor.history.entries.length, x: window.__execs, note: document.querySelector(".sb-term-note").textContent })`);
  check(rsQ.s && rsQ.q === "i=0" && rsQ.h === hQ && rsQ.x === exQ && rsQ.note === "A command is running: Stop it first.",
    `Ctrl-R Enter while running: refused before the editor takes the match; the search kept, nothing run, history as it was: ${JSON.stringify(rsQ)}`);
  await realKey("g", { ctrl: true });
  check((await evaluate(`${T}.editor.buf`)) === "echo queued" && (await running()) === true, "Ctrl-G leaves the search: the typed-ahead line back, the command still running");
  // (Ctrl-C with a selection on the screen: the browser's copy, the command keeps running.  The note just shown
  // shortens the screen, and xterm drops a selection when it is resized: the selection is made once that refit is done)
  await pause(300);
  await evaluate(`${T}.term.selectAll(), 1`);
  await realKey("c", { ctrl: true });
  check((await running()) === true && (await evaluate(`${T}.term.hasSelection()`)) === true, "Ctrl-C with a selection is the copy, and the command keeps running");
  await evaluate(`${T}.term.clearSelection(), 1`);
  // (Ctrl-L during a run: the screen cleared, the command still running)
  await realKey("l", { ctrl: true });
  await until(`!${T}.writer.writing`, 5000);
  check((await running()) === true && (await evaluate(`window.__lines(0, ${T}.term.buffer.active.length).filter((l) => l !== "").length`)) <= 1, "Ctrl-L during a run clears the screen and keeps the command running");
  // (Ctrl-C with no selection: Stop)
  await realKey("c", { ctrl: true });
  check(!!(await until(`!document.querySelector(".sb-term").classList.contains("running") && document.querySelector(".sb-term-status").textContent === "stopped"`, 10000)), "Ctrl-C with no selection stops the command");
  await until(`!${T}.writer.writing`, 5000);
  check((await evaluate(`window.__lines(0, window.__cursorLine())`)).includes("^C (stopped)"), "the stopped command says so");
  check((await evaluate(`${T}.editor.buf`)) === "echo queued", "the typed-ahead line is at the next prompt");
  await realKey("u", { ctrl: true });
  // (r4 5, SEC/PERF on e8153082: a reverse search's query past SHOW_UNITS is drawn as its summary, bounded before
  // the redraw is made: nothing cut after; then Ctrl-G back)
  const cuts0 = await evaluate(`${T}.writer.stats.cuts`);
  await evaluate(`(() => { const t = ${T}; t.editor.search = { q: "q".repeat(196608), at: -1, failed: true, saved: "", savedCur: 0 }; t.redraw(); return 1; })()`);
  await until(`!${T}.writer.writing`, 5000);
  const rsBig = await evaluate(`window.__lines(window.__cursorLine(), window.__cursorLine() + 1)[0]`);
  check(rsBig.startsWith("(failed reverse-i-search)`[1 line, 196608 bytes") && (await evaluate(`${T}.writer.stats.cuts`)) === cuts0 && (await evaluate(`${T}.writer.stats.maxWrite`)) <= 65536,
    `a 192 KiB query is drawn as its summary, nothing made past its room: ${JSON.stringify(rsBig.slice(0, 80))}`);
  await realKey("g", { ctrl: true });
  // (SEC T854-6 on c783715a: the summary of a 192 KiB many-line line is counted in constant space: while it is drawn,
  // no split and no encode of anything past SHOW_UNITS)
  const spy = await evaluate(`(async () => { const t = ${T}, big = ("a\\n").repeat(98304);
    const sp = String.prototype.split, en = TextEncoder.prototype.encode, seen = { split: 0, encode: 0 };
    String.prototype.split = function (...a) { if (this.length > 4096) seen.split++; return sp.apply(this, a); };
    TextEncoder.prototype.encode = function (x) { if (x && x.length > 4096) seen.encode++; return en.call(this, x); };
    try { t.editor.reset(big); t.redraw(); await t.writer.idle(); } finally { String.prototype.split = sp; TextEncoder.prototype.encode = en; }
    const l = window.__lines(window.__cursorLine(), window.__cursorLine() + 1)[0]; t.editor.reset(""); t.redraw(); await t.writer.idle();
    return { ...seen, line: l.slice(0, 60) }; })()`);
  check(spy.split === 0 && spy.encode === 0 && spy.line.includes("[98305 lines, 196608 bytes"), `a 192 KiB line's summary: no split or encode of it while drawn: ${JSON.stringify(spy)}`);
  // (and the prompt's cwd: its last 256 units after an ellipsis, however long the directory)
  const cwdWas = await evaluate(`${T}.cwd`);
  await evaluate(`(() => { const t = ${T}; t.setCwd("/" + "d".repeat(100000)); t.redraw(); return 1; })()`);
  await until(`!${T}.writer.writing`, 5000);
  const cwdLine = await evaluate(`window.__lines(window.__cursorLine() - 3, window.__cursorLine() + 1).join("")`);
  check(cwdLine.includes("\u2026" + "d".repeat(50)) && !cwdLine.includes("d".repeat(300)) && (await evaluate(`${T}.writer.stats.cuts`)) === cuts0, `a 100 000-unit cwd is drawn as its last 256 units, nothing cut after: ${cwdLine.length} units on screen`);
  await evaluate(`${T}.setCwd(${JSON.stringify(cwdWas)}), ${T}.redraw(), 1`);
  await until(`!${T}.writer.writing`, 5000);
  // (r4 11, 12: the screen still drawing (the writer's ledger pressed): Enter refused before the editor takes the line;
  // the line and the history kept, nothing run.  The pressure is simulated: the writer's own caps are pinned in
  // test-term-writer.mjs)
  await type("echo unsent");
  const hB = await evaluate(`${T}.editor.history.entries.length`), exB = await evaluate(`window.__execs`);
  await evaluate(`Object.defineProperty(${T}.writer, "pressed", { get: () => true, configurable: true }), 1`);
  await realKey("Enter");
  const busyB = await evaluate(`({ buf: ${T}.editor.buf, h: ${T}.editor.history.entries.length, x: window.__execs, note: document.querySelector(".sb-term-note").textContent })`);
  await evaluate(`delete ${T}.writer.pressed, 1`);
  await evaluate(`document.querySelector(".sb-term-status").textContent = ""`);
  check(busyB.buf === "echo unsent" && busyB.h === hB && busyB.x === exB && busyB.note === "The screen is still drawing: try again in a moment.",
    `Enter while the screen is drawing: the line and history kept, nothing run, the note: ${JSON.stringify(busyB)}`);
  await realKey("Enter");
  check(!!(await until(`document.querySelector(".sb-term-status").textContent === "done"`, 10000)) && (await evaluate(`window.__execs`)) === exB + 1, "and once it has drawn, the same Enter runs the kept line");
  // (Stop by the button)
  await start(LOOP);
  await until(`document.querySelector(".sb-term").classList.contains("running")`, 10000);
  await evaluate(`document.querySelector(".sb-term-status").textContent = ""; document.querySelector(".sb-term-stop").click()`);
  check(!!(await until(`!document.querySelector(".sb-term").classList.contains("running") && document.querySelector(".sb-term-status").textContent === "stopped"`, 10000)), "Stop by the button");
  r = await run("echo after-stop");
  check(r?.out === "after-stop\n", "the shell runs again after Stop");
  // (Ctrl-C when idle: ^C on the line, the line cleared)
  await focusTerm();
  await type("half typed");
  await realKey("c", { ctrl: true });
  await until(`!${T}.writer.writing`, 5000);
  check((await evaluate(`${T}.editor.buf`)) === "" && (await evaluate(`window.__lines(0, window.__cursorLine()).at(-1)`)).endsWith("half typed^C"), "Ctrl-C when idle: ^C after the line, and the line cleared");
  // (the editor's keys, real: Left, Backspace, Home, Ctrl-E, Ctrl-K.  Ctrl-W is the editor's too (test-line-editor.mjs),
  // but a real Ctrl-W is the browser's: it closes the tab before any page sees it)
  await type("echo abc");
  await realKey("ArrowLeft");
  await realKey("Backspace");
  await realKey("Home");
  await type("X");
  await realKey("e", { ctrl: true });
  const ed1 = await evaluate(`[${T}.editor.buf, ${T}.editor.cur]`);
  await realKey("Home");
  await realKey("k", { ctrl: true });
  check(ed1[0] === "Xecho ac" && ed1[1] === 8 && (await evaluate(`${T}.editor.buf`)) === "", `the editor's keys, real: ${JSON.stringify(ed1)}`);
  await realKey("u", { ctrl: true });
  // (history: Up from an edited line keeps the draft; Down past the newest restores it)
  await run("echo hist-1");
  await focusTerm();
  await type("my draft");
  await realKey("ArrowUp");
  const up = await evaluate(`${T}.editor.buf`);
  await realKey("ArrowDown");
  check(up === "echo hist-1" && (await evaluate(`${T}.editor.buf`)) === "my draft", `history Up/Down keeps the draft: up=${JSON.stringify(up)}`);
  await realKey("u", { ctrl: true });
  await realKey("r", { ctrl: true });
  await type("hist");
  await until(`!${T}.writer.writing`, 5000);
  const rs = await evaluate(`window.__lines(window.__cursorLine(), window.__cursorLine() + 1)[0]`);
  await realKey("Escape");
  check(/^\(reverse-i-search\)`hist': echo hist-1$/.test(rs) && (await evaluate(`${T}.editor.buf`)) === "echo hist-1", `Ctrl-R: bash's search prompt drawn on the line, Escape keeps the match: ${JSON.stringify(rs)}`);
  // (no match: bash's failed form)
  await realKey("u", { ctrl: true });
  await realKey("r", { ctrl: true });
  await type("echz");
  await until(`!${T}.writer.writing`, 5000);
  const rf = await evaluate(`window.__lines(window.__cursorLine(), window.__cursorLine() + 1)[0]`);
  await realKey("g", { ctrl: true });
  check(/^\(failed reverse-i-search\)`echz': /.test(rf), `Ctrl-R with no match: bash's failed prompt: ${JSON.stringify(rf)}`);
  await realKey("u", { ctrl: true });
  // (the screen-reader order: the polite status changes only after the last output is on the screen)
  await evaluate(`window.__seen = null; window.__mo = new MutationObserver(() => { if (window.__seen === null && document.querySelector(".sb-term-status").textContent) window.__seen = window.__lines(0, ${T}.term.buffer.active.length).includes("3000"); });
    window.__mo.observe(document.querySelector(".sb-term-status"), { childList: true, subtree: true, characterData: true })`);
  r = await run("seq 1 3000");
  check(r?.status === "done" && (await evaluate(`(window.__mo.disconnect(), window.__seen)`)) === true, "the status is announced after the output is on the screen");
  const a11y = await evaluate(`({ rows: document.querySelectorAll(".sb-term .xterm-accessibility-tree > div").length, stop: document.querySelector(".sb-term-stop").tagName, label: ${TA}.getAttribute("aria-label") })`);
  check(a11y.rows > 0 && a11y.stop === "BUTTON" && /in \//.test(a11y.label ?? ""), `the screen's accessible rows exist; Stop is a button; the input's label names the cwd: ${JSON.stringify(a11y)}`);
  // (the retention bound: xterm's 6 000 rows, the latest kept)
  await run("clear");
  r = await run("seq 1 9998");
  const sb = await evaluate(`({ len: ${T}.term.buffer.active.length, rows: ${T}.term.rows })`);
  check(sb.len <= 6000 + sb.rows && r?.out.endsWith("9998\n"), `the scrollback holds at most 6 000 rows plus the screen, the latest kept: ${JSON.stringify(sb)}`);
  // (DB2-TERM-326-2: every displayed path capped before it is written) a page command writing past S1, in many writes
  // and in one; one replacing its output past it; Enters past the scrollback
  await evaluate(`(() => { const c = ${T}.opts.commands;
    c.manylines = async (a, io) => { for (let i = 0; i < 7000; i++) io.write("w" + i + "\\n"); return 0; };
    c.bigwrite = async (a, io) => { io.write("y".repeat(2 * 1048576)); return 0; };
    c.bigreplace = async (a, io) => { io.replace("r\\n".repeat(6000)); await new Promise((r) => setTimeout(r, 50)); io.replace("s\\n".repeat(7000)); return 0; };
  })()`);
  r = await run("manylines");
  check(r?.status === "done" && r.out.endsWith("w6999\n"), `a page command's 7 000 writes: all within S1, the last shown (${JSON.stringify((r?.out ?? "").slice(-20))})`);
  r = await run("bigwrite");
  check(r?.status === "done" && /\[\u2026 1048576 more bytes not shown\]\n$/.test(r.out) && r.out.length < 1048576 + 200, `a page command's 2 MiB write: 1 MiB shown, then the omission line (${(r?.out ?? "").slice(-40)})`);
  r = await run("bigreplace");
  check(r?.status === "done" && r.out.endsWith("s\n") && !r.out.includes("r\n") , `a page command's replace: the latest text (${(r?.out ?? "").slice(-10)})`);
  // (#854 follow-up O3: a refresh past the writer's room is cut in the panel at REPLACE_MAX (57 280 bytes), before the
  // writer sees it: no cut there, and the rest counted in the command's one marker)
  await evaluate(`(() => { ${T}.opts.commands.hugereplace = async (a, io) => { io.replace("h".repeat(70000)); await new Promise((r) => setTimeout(r, 50)); return 0; }; return 1; })()`);
  const cutsO3 = await evaluate(`${T}.writer.stats.cuts`);
  r = await run("hugereplace");
  check(r?.status === "done" && /\[\u2026 12720 more bytes not shown\]\n$/.test(r.out) && (await evaluate(`${T}.writer.stats.cuts`)) === cutsO3,
    `O3: a 70 000-byte refresh: 57 280 shown, the panel's cut counted (12 720), no cut in the writer: ${JSON.stringify((r?.out ?? "").slice(-40))}`);
  // (#854 follow-up O4: an exit line's text is cut at EXIT_UNITS (512), a shell's long reason included)
  await evaluate(`(() => { const h = ${T}.opts.host, x0 = h.exec; h.exec = async () => { h.exec = x0; return { kind: "unavailable", row: 2, reason: "R".repeat(2000), ops: [] }; }; return 1; })()`);
  await run("echo o4");
  const o4 = await evaluate(`${T}.screenText`);
  check(o4.includes("the shell is unavailable: " + "R".repeat(486)) && !o4.includes("R".repeat(487)), `O4: a 2 000-unit reason: the exit line cut at 512 units (${(o4.match(/R+/g) ?? []).map((x) => x.length).join(",")})`);
  await focusTerm();
  for (let i = 0; i < 300; i++) await evaluate(`${T}.editor.reset(""), 1`), await realKey("Enter");
  await until(`!${T}.writer.writing`, 20000);
  check((await evaluate(`${T}.term.buffer.active.length`)) <= 6000 + (await evaluate(`${T}.term.rows`)), "prompt-only lines stay within the scrollback");

  // ---- board's r1 findings
  // (TP-3: the person's text is one eval: a trailing backslash, an open heredoc or quote never reach the bookkeeping)
  await run("clear");
  await run("cd /tdir");
  for (const [what, cmd] of [["a trailing backslash", "echo a \\"], ["an unterminated heredoc", "cat <<EOF\nhello"], ["an unterminated quote", 'echo "abc']]) {
    r = await run(cmd);
    const all = await evaluate(`window.__lines(0, window.__cursorLine()).join("\\n")`);
    check(!/__sb|\x1e/.test(all) && r?.cwd === "/tdir" && (r?.status === "done" || /^exit \d+$/.test(r?.status ?? "")), `${what}: no bookkeeping shown, the status (${r?.status}) and the cwd (${r?.cwd}) kept`);
  }
  r = await run(`echo 'x'"y" && echo "it's" && echo '$HOME \\ \`'`);
  check(r?.out === "xy\nit's\n$HOME \\ `\n", `quoting through the eval: ${JSON.stringify(r?.out)}`);
  r = await run("cd / && pwd");
  check(r?.out === "/\n" && r?.cwd === "/", "cd still carries through the eval");
  // (a control character in the line is drawn visibly, never sent to the screen as a control)
  await evaluate(`${T}.editor.reset("echo \\u001b[2Jx")`);
  await evaluate(`${T}.editor.key({ key: "End" })`);
  await realKey("ArrowLeft");
  await until(`!${T}.writer.writing`, 5000);
  check((await evaluate(`window.__lines(window.__cursorLine(), window.__cursorLine() + 1)[0]`)).includes("echo \u241b[2Jx"), "an ESC in the line is drawn as a visible symbol");
  await evaluate(`${T}.editor.reset(""), 1`);
  // (the line's bound: a paste past bash.source_bytes refused whole, with the note)
  await evaluate(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", "x".repeat(${T}.editor.maxBytes + 1)); ${TA}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  check((await evaluate(`${T}.editor.buf`)) === "" && /^Not pasted: it's longer than the Terminal accepts at once \(\d+ (MiB|KiB|bytes)\)\.$/.test(await evaluate(`document.querySelector(".sb-term-note").textContent`)),
    `a paste past the line's bound is refused whole, with the note: ${JSON.stringify(await evaluate(`document.querySelector(".sb-term-note").textContent`))}`);
  // (TP-6: the running note is polite, describes the input, and is gone when the run ends)
  await start(LOOP);
  await until(`document.querySelector(".sb-term").classList.contains("running")`, 10000);
  await realKey("Enter");
  const note = await evaluate(`(() => { const nt = document.querySelector(".sb-term-note"); return { shown: !nt.hidden, live: nt.getAttribute("aria-live"), described: (${TA}.getAttribute("aria-describedby") || "").split(" ").includes(nt.id) }; })()`);
  await evaluate(`document.querySelector(".sb-term-stop").click()`);
  await until(`!document.querySelector(".sb-term").classList.contains("running")`, 10000);
  check(note.shown && note.live === "polite" && note.described && (await evaluate(`document.querySelector(".sb-term-note").hidden`)) === true, `TP-6: the note is polite and describes the input, and is gone after the run: ${JSON.stringify(note)}`);
  // (TP-8: the grip: focusable, its value, Up/Down within 120 px and 80% of the window, remembered on this device)
  const g0 = await evaluate(`(() => { const g = document.querySelector(".sb-term-grip"); return { tab: g.tabIndex, now: +g.getAttribute("aria-valuenow"), min: +g.getAttribute("aria-valuemin"), max: +g.getAttribute("aria-valuemax"), h: Math.round(document.querySelector(".sb-term").getBoundingClientRect().height) }; })()`);
  const gkey = (k, shift = false) => evaluate(`document.querySelector(".sb-term-grip").dispatchEvent(new KeyboardEvent("keydown", { key: "${k}", shiftKey: ${shift}, bubbles: true, cancelable: true }))`);
  await gkey("ArrowUp");
  const g1 = await evaluate(`+document.querySelector(".sb-term-grip").getAttribute("aria-valuenow")`);
  for (let i = 0; i < 40; i++) await gkey("ArrowUp", true);
  const gMax = await evaluate(`({ now: +document.querySelector(".sb-term-grip").getAttribute("aria-valuenow"), h: Math.round(document.querySelector(".sb-term").getBoundingClientRect().height), ih: innerHeight, kept: +localStorage.getItem("sb-term-h") })`);
  for (let i = 0; i < 60; i++) await gkey("ArrowDown", true);
  const gMin = await evaluate(`+document.querySelector(".sb-term-grip").getAttribute("aria-valuenow")`);
  check(g0.tab === 0 && g0.min === 120 && g0.now === g0.h && g1 === g0.now + 24 && gMax.now === Math.round(gMax.ih * 0.8) && gMax.h === gMax.now && gMax.kept === gMax.now && gMin === 120,
    `TP-8: the grip resizes from the keyboard within 120 px and 80%, and is remembered: ${JSON.stringify({ g0, g1, gMax, gMin })}`);
  await gkey("ArrowUp", true);
  // (a double-click puts the default height back and forgets the remembered one, as every panel's edge does)
  await evaluate(`document.querySelector(".sb-term-grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))`);
  const gReset = await evaluate(`({ now: +document.querySelector(".sb-term-grip").getAttribute("aria-valuenow"), kept: localStorage.getItem("sb-term-h") })`);
  check(gReset.now === 280 && gReset.kept === null, `TP-8: a double-click on the grip puts 280 px back and forgets the height: ${JSON.stringify(gReset)}`);
  // (TP-9: the history: 500 at most, oldest dropped; a command repeated at once kept once)
  const hist = await evaluate(`(() => { const h = ${T}.editor.history; for (let i = 0; i < 520; i++) h.push("h" + i); h.push("same"); h.push("same");
    return { len: h.entries.length, first: h.entries[0], last2: h.entries.slice(-2) }; })()`);
  check(hist.len === 500 && hist.first === "h21" && hist.last2[0] === "h519" && hist.last2[1] === "same", `TP-9: history holds 500, oldest dropped, an immediate repeat kept once: ${JSON.stringify(hist)}`);
  // (TP-9: hiding by ⋯ ▸ Terminal as well as by the dock's own control; TP-7: focus doesn't fall to body)
  await evaluate(`${TA}.focus(); document.querySelector("#termbtn").click()`);
  check((await evaluate(`document.querySelector(".sb-term").hidden`)) === true && (await evaluate(`document.activeElement !== document.body`)), "TP-9/TP-7: ⋯ ▸ Terminal hides an open dock, and focus goes back, not to body");
  await evaluate(`document.querySelector("#termbtn").click()`);
  await evaluate(`${TA}.focus(); document.querySelector(".sb-term-hide").click()`);
  check((await evaluate(`document.querySelector(".sb-term").hidden`)) === true && (await evaluate(`document.activeElement?.id`)) === "morebtn", `TP-7: the dock's own hide returns focus to the ⋯ button (${await evaluate(`document.activeElement?.id || document.activeElement?.tagName`)})`);
  await evaluate(`document.querySelector("#termbtn").click()`);
  // (TP-7-R2: a keyboard reopen from the ⋯ menu, with real key events, then the dock's hide by keyboard)
  await evaluate(`document.querySelector(".sb-term-hide").click()`);
  await evaluate(`document.querySelector("#morebtn").focus()`);
  await realKey("Enter", { text: "\r" });
  await until(`!document.querySelector("#moremenu").hidden`, 5000);
  await evaluate(`document.querySelector("#termbtn").focus()`);
  await realKey("Enter", { text: "\r" });
  const reopened = await until(`!document.querySelector(".sb-term").hidden`, 5000);
  await evaluate(`document.querySelector(".sb-term-hide").focus()`);
  await realKey("Enter", { text: "\r" });
  const kb = await evaluate(`({ hidden: document.querySelector(".sb-term").hidden, focus: document.activeElement?.id || document.activeElement?.tagName })`);
  check(reopened && kb.hidden === true && kb.focus === "morebtn", `TP-7-R2: reopened from the ⋯ menu by keyboard, hidden by keyboard: focus on the ⋯ button (${JSON.stringify(kb)})`);
  // (#852 V11, grader X4: an opener still in the page and focusable gets focus back, not the ⋯ fallback)
  await evaluate(`(() => { const b = document.createElement("button"); b.id = "x4opener"; b.textContent = "x4"; document.body.appendChild(b); b.focus(); ${T}.show(); return 1; })()`);
  await until(`!document.querySelector(".sb-term").hidden`, 5000);
  const x4in = await evaluate(`document.querySelector(".sb-term").contains(document.activeElement)`);
  await evaluate(`document.querySelector(".sb-term-hide").click()`);
  const x4 = await evaluate(`document.activeElement?.id || document.activeElement?.tagName`);
  await evaluate(`document.getElementById("x4opener").remove(), 1`);
  check(x4in && x4 === "x4opener", `X4: hiding returns focus to the visible opener, not the ⋯ button (${x4})`);
  await evaluate(`document.querySelector("#termbtn").click()`);
  await until(`!document.querySelector(".sb-term").hidden`, 5000);
  // (TP-1: ✕ ends the shell's worker: counted, with reset as the control that fires)
  await evaluate(`window.__term = 0; const t0 = Worker.prototype.terminate; Worker.prototype.terminate = function () { window.__term++; return t0.call(this); }`);
  await run("echo before-reset");
  await run("reset");
  await until(`document.querySelector(".sb-term").dataset.startMs !== undefined`, 10000);
  r = await run("echo after-reset");
  const afterReset = await evaluate(`window.__term`);
  check(afterReset === 1 && r?.out === "after-reset\n", `TP-1 control: reset ends one worker (${afterReset}), and a fresh one runs`);
  // ---- long lines (a real terminal's: wrapped rows of one logical line)
  await run("clear");
  r = await run("seq 1 200000 | tr -d '\\n'; echo");
  const ll = await evaluate(`(() => { const t = ${T}.term; t.selectAll(); const sel = t.getSelection(); t.clearSelection();
    const lines = sel.split("\\n").filter((l) => l.length > 1000); return { long: lines.length, tail: (lines[0] ?? "").slice(-14), len: (lines[0] ?? "").length, rows: t.buffer.active.length }; })()`);
  check(r?.status === "done" && /\[\u2026 \d+ more bytes not shown\]\n$/.test(r.out) && ll.long === 1 && ll.len > 500000 && /^\d+$/.test(ll.tail) && ll.rows <= 6000 + 200, `a 1 MiB line (its start past the 6 000-row scrollback, as in any terminal): within S1, the omission line after it, the selection copies its wrapped rows as one line: ${JSON.stringify(ll)}`);
  r = await run("printf 'A%.0s' $(seq 1 50); printf '\\r'; printf 'B%.0s' $(seq 1 45); echo");
  check(r?.out === "B".repeat(45) + "AAAAA\n", `\\r returns to the row's start, as a terminal's does: ${JSON.stringify(r?.out)}`);
  // (E5.5's measures: first paint after the first output is drawn, then the last)
  await send("Page.bringToFront");
  await evaluate(`performance.clearMeasures("sb-term:first-paint"); performance.clearMeasures("sb-term:last-paint")`);
  r = await run("printf 'e%.0s' $(seq 1 100000) >&2; echo");
  const fp = await evaluate(`({ fp: performance.getEntriesByName("sb-term:first-paint").length, lp: performance.getEntriesByName("sb-term:last-paint").length,
    order: (performance.getEntriesByName("sb-term:first-paint").at(-1)?.duration ?? 1e9) <= (performance.getEntriesByName("sb-term:last-paint").at(-1)?.duration ?? -1) })`);
  check(r?.status === "done" && fp.fp === 1 && fp.lp === 1 && fp.order, `E5.5's measures: one first paint, then one last paint, for stderr-heavy output: ${JSON.stringify(fp)}`);
  // (hide keeps the session; ✕ ends it)
  const kept = await evaluate(`${T}.screenText`);
  await evaluate(`document.querySelector(".sb-term-hide").click()`);
  check((await evaluate(`document.querySelector(".sb-term").hidden`)) === true, "hide hides the dock");
  // (H9, ruling (d): End terminal session… only while the Terminal is open: hidden with it closed, back when it opens)
  const closedItem = await evaluate(`document.querySelector("#termendbtn").hidden`);
  await evaluate(`document.querySelector("#termbtn").click()`);
  check(closedItem === true && (await evaluate(`!document.querySelector("#termendbtn").hidden`)), "H9: End terminal session… is hidden while the Terminal is closed, and shown again when it opens");
  check((await evaluate(`document.querySelector(".sb-term").hidden`)) === false && (await evaluate(`${T}.screenText`)) === kept, "⋯ ▸ Terminal again: the same session, its screen kept");
  // (H9, William: the dock's ✕ closes, keeping the session (above), and the "–" is gone; ending it is the page's own
  //  ⋯ ▸ End terminal session…, shown while the Terminal is open)
  const hdr = await evaluate(`({ x: document.querySelector(".sb-term-hide").textContent, label: document.querySelector(".sb-term-hide").getAttribute("aria-label"),
    title: document.querySelector(".sb-term-hide").title, buttons: [...document.querySelectorAll(".sb-term-head button")].map((b) => b.textContent),
    item: (() => { const b = document.querySelector("#termendbtn"); return b && { shown: !b.hidden, text: b.textContent, next: b.previousElementSibling?.id }; })() })`);
  check(hdr.x === "✕" && hdr.label === "Close the terminal" && hdr.title === "Close (keeps the session)" && !hdr.buttons.includes("–") && hdr.buttons.length === 2
    && hdr.item?.shown && hdr.item.text === "End terminal session…" && hdr.item.next === "termbtn",
    `H9: the dock's ✕ is Close (no "–"); ⋯ ▸ End terminal session… is shown under Terminal while the Terminal is open: ${JSON.stringify(hdr)}`);
  // (End terminal session… always asks, saying a running command is stopped; No keeps everything)
  await evaluate(`window.__asked = []; window.confirm = (m) => (window.__asked.push(m), false); 1`);
  await evaluate(`document.querySelector("#termendbtn, [data-sbb=termend]").click()`);
  const kept9 = await evaluate(`({ asked: window.__asked, dock: document.querySelectorAll(".sb-term").length })`);
  // (and with a command running, the question says it is stopped)
  await focusTerm();
  await evaluate(`${T}.editor.reset("while :; do :; done"), 1`);
  await realKey("Enter");
  await until(`document.querySelector(".sb-term").classList.contains("running")`, 30000);
  await evaluate(`document.querySelector("#termendbtn, [data-sbb=termend]").click()`);
  const running9 = await evaluate(`({ asked: window.__asked.at(-1), running: document.querySelector(".sb-term").classList.contains("running") })`);
  await evaluate(`document.querySelector(".sb-term-stop").click()`);
  await until(`!document.querySelector(".sb-term").classList.contains("running")`, 30000);
  await evaluate(`window.confirm = () => true; 1`);
  check(kept9.asked.length === 1 && kept9.asked[0] === "End this terminal session? Its output and command history are cleared. This can't be undone." && kept9.dock === 1
    && running9.asked === "End this terminal session? The command running now is stopped. Its output and command history are cleared. This can't be undone." && running9.running,
    `H9: End session… asks first (saying a running command is stopped); No keeps the session: ${JSON.stringify({ kept9, running9 })}`);
  // (r6, SEC T854-8: a reset waiting on a start when ✕ ends the session: once that start resolves, no fresh start, no
  // end of the shell for reset, no exec and no prompt)
  await evaluate(`(() => { const t = ${T}, h = t.opts.host; window.__starts = 0; window.__execs8 = 0; const s0 = h.shellFor.bind(h), x0 = h.exec.bind(h);
    h.shellFor = () => (window.__starts++, s0()); h.exec = (...a) => (window.__execs8++, x0(...a));
    t.ready = false; t.starting = new Promise((r) => (window.__startGo8 = r)); window.__t8 = t; return 1; })()`);
  await focusTerm();
  await evaluate(`${T}.editor.reset("reset"), 1`);
  await realKey("Enter");
  await pause(100);
  await evaluate(`document.querySelector("#termendbtn, [data-sbb=termend]").click()`);
  check((await evaluate(`document.querySelectorAll(".sb-term").length === 0 && document.querySelector("#termendbtn").hidden`)), "End terminal session… ends it (the dock is gone), and the item goes");
  await evaluate(`window.__startGo8(), 1`);
  await pause(500);
  const t8 = await evaluate(`({ starts: window.__starts, execs: window.__execs8, prompt: window.__t8.editing, ended: window.__t8.ended })`);
  check(t8.starts === 0 && t8.execs === 0 && t8.ended && !t8.prompt, `✕ during a reset's wait on a start: once the start resolves, no fresh start, exec or prompt: ${JSON.stringify(t8)}`);
  check((await evaluate(`window.__term`)) === 2, `TP-1: ✕ ends the shell's worker too (terminate calls: ${await evaluate(`window.__term`)}, after reset's 1)`);
  await evaluate(`document.querySelector("#termbtn").click()`);
  await until(`!!document.querySelector(".sb-term") && !document.querySelector(".sb-term").hidden && !!${T}`, 10000);
  await evaluate(HELPERS);
  await focusTerm();
  await realKey("ArrowUp");
  check((await evaluate(`${T}.screenText`)).split("\n").length === 1 && (await evaluate(`${T}.editor.buf`)) === "", "a new session after End session: no scrollback and no history");
  check((await evaluate(`document.querySelectorAll(".sb-term-intro").length`)) === 0 && (await evaluate(`${TA}.getAttribute("aria-describedby")`)) === "sb-term-note",
    "T358-3: the intro once per tab: a new terminal in the same tab has none");
  // (the intro's "Got it", William, Oct 30)
  const reopen = async () => {
    await evaluate(`document.querySelector("#termendbtn, [data-sbb=termend]").click()`);
    await evaluate(`sessionStorage.removeItem("sb-term-intro")`);
    await evaluate(`document.querySelector("#termbtn").click()`);
    await until(`!!document.querySelector(".sb-term") && !document.querySelector(".sb-term").hidden && !!${T}`, 10000);
  };
  await reopen();
  const got = await evaluate(`(() => { const b = document.querySelector(".sb-term-intro button"); return { text: b?.textContent, described: ${TA}.getAttribute("aria-describedby"),
    kept: localStorage.getItem("sagebrush-term-intro"), named: document.getElementById("sb-term-intro")?.textContent.includes("Got it"),
    button: b?.getAttribute("aria-describedby") }; })()`);
  check(got.text === "Got it" && got.described === "sb-term-intro sb-term-note" && got.kept === null && got.named === false && got.button === "sb-term-intro",
    `the intro, not yet put away, in a new tab's first terminal, with its "Got it": ${JSON.stringify(got)}`);
  await evaluate(`document.querySelector(".sb-term-intro button").click()`);
  const gone = await evaluate(`({ intro: document.querySelectorAll(".sb-term-intro, #sb-term-intro").length, described: ${TA}.getAttribute("aria-describedby"),
    focus: document.activeElement === ${TA}, kept: localStorage.getItem("sagebrush-term-intro") })`);
  check(gone.intro === 0 && gone.described === "sb-term-note" && gone.focus && gone.kept === "1", `"Got it" puts the intro away, the input keeps the focus, and this device keeps it: ${JSON.stringify(gone)}`);
  await reopen();
  const later = await evaluate(`({ intro: document.querySelectorAll(".sb-term-intro").length, described: ${TA}.getAttribute("aria-describedby") })`);
  check(later.intro === 0 && later.described === "sb-term-note", `put away, a new tab's first terminal on this device has no intro: ${JSON.stringify(later)}`);
  await evaluate(`localStorage.removeItem("sagebrush-term-intro")`);
  await reopen();
  const refused = await evaluate(`(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === "sagebrush-term-intro") throw new DOMException("refused", "QuotaExceededError"); return set.call(this, k, v); };
    const swallow = (e) => e.preventDefault();
    addEventListener("error", swallow);
    try { document.querySelector(".sb-term-intro button").click(); } finally { Storage.prototype.setItem = set; removeEventListener("error", swallow); }
    return { intro: document.querySelectorAll(".sb-term-intro, #sb-term-intro").length, described: ${TA}.getAttribute("aria-describedby"),
      focus: document.activeElement === ${TA}, kept: localStorage.getItem("sagebrush-term-intro") };
  })()`);
  check(refused.intro === 0 && refused.described === "sb-term-note" && refused.focus && refused.kept === null,
    `a storage that refuses the write: Got it still puts the intro away and the input keeps the focus (N386-2): ${JSON.stringify(refused)}`);
  // (under 700 px: a full-height sheet, with the extra keys on a touch screen)
  await send("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
  await pause(300);
  const sheet = await evaluate(`(() => { const r = document.querySelector(".sb-term").getBoundingClientRect(); return { top: r.top, h: r.height, ih: innerHeight }; })()`);
  check(sheet && sheet.top <= 1 && sheet.h >= sheet.ih * 0.85, `under 700 px the dock is a full-height sheet: ${JSON.stringify(sheet)}`);
  await send("Emulation.clearDeviceMetricsOverride");
  // ---- the ⋯ and File menus' last entries, pressable by a real hit test (board's B380-1..3)
  const MENUS = [["#morebtn", "#moremenu"], ["#filebtn", "#filemenu"]];
  const lastEntry = async (btn, menu) => {
    await evaluate(`scrollTo(0, 0), document.querySelector("${menu}").hidden && document.querySelector("${btn}").click(), 1`);
    await pause(200);
    const m = await evaluate(`(() => {
      const m = document.querySelector("${menu}"), items = [...m.querySelectorAll("button:not([hidden]), a:not([hidden])")], l = items.at(-1);
      l.scrollIntoView({ block: "nearest" });
      const r = l.getBoundingClientRect(), at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { open: !m.hidden, pressable: !!at && (at === l || l.contains(at)), at: at && (at.id || at.className || at.tagName), scrolls: m.scrollHeight > m.clientHeight + 1,
        bottom: Math.round(m.getBoundingClientRect().bottom), h: innerHeight, dock: Math.round(document.querySelector(".sb-term:not([hidden])")?.getBoundingClientRect().top ?? -1) };
    })()`);
    await evaluate(`document.querySelector("${menu}").hidden || document.querySelector("${btn}").click(), 1`);
    return m;
  };
  for (const [btn, menu] of MENUS) {
    const m = await lastEntry(btn, menu);
    check(m?.open && m.pressable && m.dock > 0 && (!m.scrolls || m.bottom > m.dock), `B380-2: the dock open, ${menu} is above it, not shortened by it, its last entry pressable: ${JSON.stringify(m)}`);
  }
  await evaluate(`document.querySelector(".sb-term-hide").click()`);
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 420, deviceScaleFactor: 1, mobile: false });
  await pause(300);
  for (const [btn, menu] of MENUS) {
    const m = await lastEntry(btn, menu);
    check(m?.open && m.pressable && m.bottom <= m.h, `B380-3: in a 420 px window, ${menu}'s last entry is clear of the foot's notices, pressable: ${JSON.stringify(m)}`);
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector("#consolebtn").click()`);
  await until(`!document.querySelector("#console").hidden`, 5000);
  for (const [btn, menu] of MENUS) {
    const m = await lastEntry(btn, menu);
    check(m?.open && m.pressable && !m.scrolls, `B380-1: at 800 px with the console open, ${menu} fits whole, its last entry pressable: ${JSON.stringify(m)}`);
  }
  await evaluate(`document.querySelector("#consolebtn").click()`);
  await send("Emulation.clearDeviceMetricsOverride");
  // ---- the front order and the room below the page (plan PR 2): the console and the Terminal share the bottom
  // (after the menus' checks: the console's own status line, once loaded, sits above the toolbar)
  if (await evaluate(`document.querySelector(".sb-term").hidden`)) await evaluate(`document.querySelector("#termbtn").click()`);
  await evaluate(`document.querySelector("#consolebtn").click()`);
  await until(`!document.querySelector("#console").hidden`, 10000);
  const z = (sel) => evaluate(`+getComputedStyle(document.querySelector("${sel}")).zIndex`);
  check((await z("#console")) > (await z(".sb-term")), `the console, chosen after, is in front of the Terminal (${await z("#console")} > ${await z(".sb-term")})`);
  await evaluate(`document.querySelector("#termbtn").click(); document.querySelector("#termbtn").click()`);
  await until(`!document.querySelector(".sb-term").hidden`, 5000);
  check((await z(".sb-term")) > (await z("#console")), "the Terminal chosen again is in front of the console");
  await evaluate(`(() => { const r = document.querySelector("#console").getBoundingClientRect(); document.querySelector("#console").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r.x + 5, clientY: r.y + 5 })); })()`);
  check((await z("#console")) > (await z(".sb-term")), "a touch on the console brings it in front");
  const room = await evaluate(`({ pad: parseFloat(getComputedStyle(document.body).paddingBottom), t: document.querySelector(".sb-term").getBoundingClientRect().height, c: document.querySelector("#console").offsetHeight })`);
  check(room.pad >= Math.max(room.t, room.c) - 1, `the room below the page is the tallest open panel's: ${JSON.stringify(room)}`);
  await evaluate(`document.querySelector("#consolebtn").click()`);
  // (the theme follows the page's)
  const bg = () => evaluate(`${T}.term.options.theme.background`);
  await evaluate(`document.documentElement.dataset.theme = "light"`);
  await pause(100);
  const light = await bg();
  await evaluate(`document.documentElement.dataset.theme = "dark"`);
  await pause(100);
  const dark = await bg();
  check(light && dark && light !== dark && dark === (await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--sb-term-bg").trim()`)), `the screen's colours follow the page's theme: light ${light}, dark ${dark}`);
  await evaluate(`delete document.documentElement.dataset.theme`);
  // ---- the board page's dock (TP-5): ⋯ ▸ Terminal there too, placed as on the notebook page, with ps listing the board
  await evaluate(`document.querySelector("#termendbtn, [data-sbb=termend]")?.click()`);
  await send("Page.navigate", { url: url + "board/?new=python" });
  const BTERM = `document.querySelector('#board [data-sbb="term"]')`, BMORE = `document.querySelector('#board [data-sbb="menubtn"]')`;
  check(!!(await until(`(() => { const b = ${BTERM}; return !!b && !b.hidden; })()`, 30000)), "board: ⋯ ▸ Terminal shows on a local host");
  check(await evaluate(`document.querySelector("#board [data-sbb=termend]")?.hidden === true`), "board: a fresh page, the Terminal never opened: End terminal session… hidden (TESTS973-1)");
  await evaluate(`${BMORE}.click(); ${BTERM}.click()`);
  check(!!(await until(`(() => { const t = document.querySelector(".sb-term"); return !!t && !t.hidden && t.dataset.startMs !== undefined && !document.querySelector(".sb-term-loading") && !!${T}; })()`, 30000)),
    "board: the dock opens and its shell starts (the module and the set from a directory up)");
  await evaluate(HELPERS);
  r = await run("echo board-ok");
  check(r?.out === "board-ok\n" && r.status === "done", `board: a command runs: ${JSON.stringify(r)}`);
  const bp = await evaluate(`(() => {
    const body = document.querySelector(".sb-term-body").getBoundingClientRect(), dock = document.querySelector(".sb-term").getBoundingClientRect();
    const tops = ["sb-alpha-banner", "sb-preview-notice"].map((id) => document.getElementById(id)).filter((e) => e && e.getBoundingClientRect().height > 0).map((e) => e.getBoundingClientRect().top);
    return { bottom: body.bottom, tops, dockTop: dock.top, boardBottom: document.getElementById("board").getBoundingClientRect().bottom };
  })()`);
  check(bp && bp.tops.every((t) => bp.bottom <= t + 1) && bp.boardBottom <= bp.dockTop + 1, `board: the screen above every bottom overlay, the board ending above the dock: ${JSON.stringify(bp)}`);
  r = await run("ps");
  check(/\bboard\b/.test(r?.out ?? "") && /\bterminal\b/.test(r?.out ?? ""), `board: ps lists this tab's board and its terminal: ${JSON.stringify(r?.out)}`);
  // (B363-1: with the focus anywhere in the dock, its keys are the terminal's; a click on the board gives them back)
  const rawKey = async (key, code, vk, modifiers = 0) => {
    for (const ty of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type: ty, key, code, windowsVirtualKeyCode: vk, modifiers });
    await pause(150);
  };
  const realClick = async (x, y) => {
    for (const ty of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type: ty, x, y, button: "left", buttons: ty === "mousePressed" ? 1 : 0, clickCount: 1 });
    await pause(250);
  };
  const ids = () => evaluate(`window.sagebrush.board.snapshot().doc.nodes.map((nd) => nd.id).join(",")`);
  const boardState = () => evaluate(`({ ids: window.sagebrush.board.snapshot().doc.nodes.map((nd) => nd.id).join(","),
    selected: document.querySelectorAll("#board .board-item.selected").length, find: !!document.querySelector('#board [data-sbb="find"]:not([hidden])') })`);
  await evaluate(`window.sagebrush.board.load({ title: "Keys", nodes: [{ id: "a", title: "Alpha", x: 0, y: 0 }, { id: "b", title: "Beta", x: 300, y: 0 }] })`);
  await pause(800);
  await evaluate(`(() => { const e = document.querySelector('#board [data-sbb="edit"]'); if (e.getAttribute("aria-pressed") !== "true") e.click(); })()`);
  await pause(400);
  const at = await evaluate(`(() => { const r = window.board.clientRect("a"); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 20) }; })()`);
  await realClick(at.x, at.y);
  const k0 = await boardState();
  check(k0.ids === "a,b" && k0.selected === 1 && !k0.find, `board: two items, one selected, in Edit: ${JSON.stringify(k0)}`);
  const doc = () => evaluate(`JSON.stringify(window.sagebrush.board.snapshot().doc)`);
  const d0 = await doc();
  await rawKey("ArrowRight", "ArrowRight", 39);
  const d1 = await doc();
  check(d1 !== d0 && (await ids()) === "a,b", `board: a real arrow on the board nudges the selected item (an edit to undo): ${d0 === d1 ? "unchanged" : "changed"}`);
  const screenAt = await evaluate(`(() => { const r = document.querySelector(".sb-term-body").getBoundingClientRect(); return { x: r.left + 40, y: r.top + 10 }; })()`);
  const KEYS = [["Delete", "Delete", 46], ["Backspace", "Backspace", 8], ["ArrowUp", "ArrowUp", 38], ["ArrowLeft", "ArrowLeft", 37], ["z", "KeyZ", 90, 2], ["y", "KeyY", 89, 2], ["f", "KeyF", 70, 2]];
  for (const [where, focus] of [["the screen", null], ["the grip", ".sb-term-grip"], ["the Hide button", ".sb-term-hide"], ["the input", ".sb-term .xterm-helper-textarea"]]) {
    if (focus) await evaluate(`document.querySelector(${JSON.stringify(focus)}).focus()`);
    else await realClick(screenAt.x, screenAt.y);
    const inDock = await evaluate(`!!document.activeElement?.closest(".sb-term")`);
    const h0 = await evaluate(`document.querySelector(".sb-term").getBoundingClientRect().height`);
    let changedBy = null;
    for (const k of KEYS) {
      await rawKey(...k);
      if (changedBy === null && (await doc()) !== d1) changedBy = (k[3] ? "Ctrl+" : "") + k[0];
    }
    const s = await boardState();
    const h1 = await evaluate(`document.querySelector(".sb-term").getBoundingClientRect().height`);
    check(inDock && changedBy === null && s.ids === "a,b" && s.selected === 1 && !s.find && (where !== "the grip" || h1 > h0),
      `board: real keys with the focus on ${where} are the terminal's (the board's document unchanged after each): ${JSON.stringify({ inDock, changedBy, ...s, h0, h1 })}`);
  }
  await evaluate(`${T}.editor.reset(""), 1`);
  const atA = await evaluate(`(() => { const r = window.board.clientRect("a"); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 20) }; })()`);
  await realClick(atA.x, atA.y);
  await rawKey("z", "KeyZ", 90, 2);
  check((await doc()) === d0, `board: Ctrl+Z with the board's keys undoes the nudge (the dock's Ctrl+Z had one to undo): ${(await doc()) === d0 ? "undone" : "not undone"}`);
  const atB = await evaluate(`(() => { const r = window.board.clientRect("b"); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 20) }; })()`);
  await realClick(atB.x, atB.y);
  await rawKey("Delete", "Delete", 46);
  check((await ids()) === "a", `board: a click on the board gives it its keys back (Delete deletes the item clicked): ${await ids()}`);
  await evaluate(`${TA}.focus()`);
  await evaluate(`document.querySelector(".sb-term-hide").click()`);
  const bf = await evaluate(`({ hidden: document.querySelector(".sb-term").hidden, focus: document.activeElement?.dataset?.sbb ?? document.activeElement?.tagName,
    boardBottom: document.getElementById("board").getBoundingClientRect().bottom })`);
  check(bf.hidden && bf.focus === "menubtn" && bf.boardBottom > bp.boardBottom + 100, `board: hide gives focus back to the ⋯ button, and the board its height: ${JSON.stringify(bf)}`);
  // (TESTS973-2: ruling (d) on the board too: hidden after ✕, shown again when the Terminal opens)
  const bClosed = await evaluate(`document.querySelector("#board [data-sbb=termend]").hidden`);
  await evaluate(`${BMORE}.click(); ${BTERM}.click()`);
  await until(`!document.querySelector(".sb-term").hidden`, 10000);
  check(bClosed === true && (await evaluate(`!document.querySelector("#board [data-sbb=termend]").hidden`)), "board: End terminal session… is hidden while the Terminal is closed, and shown again when it opens (TESTS973-2)");
  // (TESTS973-3: on the board too, End terminal session… asks first, and No keeps the session)
  await evaluate(`window.__askedB = []; window.confirm = (m) => (window.__askedB.push(m), false); 1`);
  await evaluate(`document.querySelector("#board [data-sbb=termend]").click()`);
  const keptB = await evaluate(`({ asked: window.__askedB, dock: document.querySelectorAll(".sb-term").length, shown: !document.querySelector(".sb-term").hidden })`);
  await evaluate(`window.confirm = () => true; 1`);
  check(keptB.asked.length === 1 && keptB.asked[0] === "End this terminal session? Its output and command history are cleared. This can't be undone." && keptB.dock === 1 && keptB.shown,
    `board: End terminal session… asks once, in the same words, and No keeps the session (TESTS973-3): ${JSON.stringify(keptB)}`);
  await send("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
  await pause(300);
  const bsheet = await evaluate(`(() => { const r = document.querySelector(".sb-term").getBoundingClientRect(); return { top: r.top, h: r.height, ih: innerHeight }; })()`);
  check(bsheet && bsheet.top <= 1 && bsheet.h >= bsheet.ih * 0.85, `board: under 700 px the dock is a full-height sheet: ${JSON.stringify(bsheet)}`);
  await send("Emulation.clearDeviceMetricsOverride");
  // (grader T4, astra's ask: the first command while the shell starts, then ✕, then the start resolves: no exec, nothing
  // drawn)
  await evaluate(`(() => { const t = ${T}, h = t.opts.host; window.__x4 = 0; const x0 = h.exec.bind(h); h.exec = (...a) => (window.__x4++, x0(...a));
    t.ready = false; t.starting = new Promise((r) => (window.__go4 = () => { t.ready = true; r(); })); window.__t4 = t; return 1; })()`);
  await focusTerm();
  await evaluate(`${T}.editor.reset("echo t4"), 1`);
  await realKey("Enter");
  await pause(100);
  const w4 = await evaluate(`window.__t4.writer.stats.writes`);
  const shown4 = await evaluate(`!document.querySelector("[data-sbb=termend]").hidden && document.querySelector("[data-sbb=termend]").previousElementSibling?.dataset.sbb === "term"`);
  await evaluate(`document.querySelector("#termendbtn, [data-sbb=termend]").click()`);
  check(shown4 && (await evaluate(`document.querySelectorAll(".sb-term").length === 0 && document.querySelector("[data-sbb=termend]").hidden`)), "board: ⋯ ▸ End terminal session…, shown under Terminal while the Terminal is open, ends the session (the dock and the item go)");
  await evaluate(`window.__go4(), 1`);
  await pause(500);
  const t4 = await evaluate(`({ execs: window.__x4, writes: window.__t4.writer.stats.writes - ${w4}, running: !!window.__t4.running })`);
  check(t4.execs === 0 && t4.writes === 0 && !t4.running, `T4: ✕ while the first command waits on the shell's start: once it resolves, no exec and nothing drawn: ${JSON.stringify(t4)}`);
  if (process.argv[2]) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.argv[2], Buffer.from(shot.result.data, "base64"));
    console.log(`screenshot ${process.argv[2]}`);
  }
  ws.close();
} finally {
  // (its whole process group: the renderer and GPU processes too, not only the main one)
  try { if (chrome?.pid) process.kill(-chrome.pid, "SIGKILL"); } catch {}
  server?.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
if (fails.length) {
  console.log(`test-panel-page: ${fails.length} of ${checks} FAILED`);
  process.exit(1);
}
console.log(`test-panel-page: all ${checks} checks pass`);
