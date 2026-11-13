// ci: web-browser/terminal.3 order=20 runner=bun
// A prompt in the Terminal panel (term-prompt design r1, r1a, r1b): a bare `python` (or sage) typed at the panel's own
// line opens that language's prompt in a session of its own, in headless Chromium against web/dist, typed with real
// key events.  Checks:
// - the banner, then `>>> `; a statement's output; a continued `for` drawn after `... `; the header says Python and
//   Stop says "Stop Python";
// - Ctrl+C at a fresh `>>> ` (the editor's own: KeyboardInterrupt, the same prompt), in a continuation (the input
//   dropped, back to `>>> `), and while a statement runs (the language's interrupt: the prompt goes on, 1+1 is 2);
// - Enter while a statement runs: the prompt's own words, not the shell's;
// - history per language: Up at `>>> ` recalls the prompt's line, never the shell's;
// - ✕ hides and keeps the prompt where it was; Ctrl+D leaves, back to the shell's prompt, status done;
// - sage: its `sage: ` prompt and preparser; matlab and magma: their banners and prompts, a statement, Ctrl+C at a
//   fresh prompt (KeyboardInterrupt, as for every language), Ctrl+D back to the shell;
// - what a statement has left, with small bounds: a continuation paste past its bytes, one past its lines, and a line
//   typed past its bytes are each refused whole (nothing of them runs), then 1+1 is 2; a paste within them runs;
// - End terminal session… at `>>> ` and while a statement runs: the prompt gone, the next open the shell's, a new
//   python prompt's history empty.
//   bun web/build.ts && bun web/shell/test-panel-prompt.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = join(import.meta.dir, "..");
if (!existsSync(join(here, "dist", "shell", "preview-set.json"))) throw new Error("build web/dist first (bun web/build.ts)");
const fails = [];
let checks = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) fails.push(what);
  console.log(`${ok ? "ok" : "FAIL"} ${what}`);
};
let server = null, chrome = null;
const profile = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "sb-test-prompt-"));
try {
  const port = await startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
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
  const send = (method, params = {}) => new Promise((r, j) => {
    const id = ++seq;
    const t = setTimeout(() => (waiting.delete(id), j(new Error(`DevTools ${method} gave no answer in 30 s`))), 30000);
    waiting.set(id, (m) => (clearTimeout(t), r(m)));
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
  const VK = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowUp: 38, ArrowDown: 40 };
  const realKey = async (key, { ctrl = false, shift = false, code = key.length === 1 ? "Key" + key.toUpperCase() : key, text } = {}) => {
    const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const vk = VK[key] ?? key.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  };
  const type = async (s) => { for (const ch of s) await realKey(ch, { text: ch, code: "" }); };
  const line = async (s) => { await type(s); await realKey("Enter"); };
  // (Ctrl+C: given to the panel's key handler as its keydown hook gives it (a plain pass-through); in this harness the
  //  DevTools-dispatched Ctrl+C is taken as the browser's copy and never reaches the page)
  const ctrlC = () => evaluate(`${T}.onKey({ key: "c", ctrl: true, alt: false, meta: false, shift: false }, null), 1`);
  const T = "window.__sbTerm";
  const screen = () => evaluate(`${T}.screenText`);
  const last = async (n = 1) => (await screen()).split("\n").slice(-n);
  // (until the screen's last line is exactly `p` (a prompt waiting) and, if given, the screen holds `has`)
  // (and the panel is asking: a prompt's request pending (or the shell's prompt), the editor empty, so no key races ahead)
  const waitPrompt = (p, has = null, ms = 15000) => until(`(() => { const t = ${T}, s = t.screenText; const l = s.split("\\n").pop(); return l === ${JSON.stringify(p)} && (!t.pr || !!t.pr.ask) && t.editor.buf === "" && ${has === null ? "true" : `s.includes(${JSON.stringify(has)})`}; })()`, ms);

  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  // (the button is in the page's HTML, shown before the page's script has bound its click; a click before that is
  //  lost and the dock never opens, so wait for the handler, not only the button)
  check(!!(await until(`(() => { const b = document.querySelector("#termbtn"); return b && !b.hidden && typeof b.onclick === "function"; })()`)), "⋯ ▸ Terminal is there");
  await evaluate(`window.confirm = () => true; document.querySelector("#termbtn").click()`);
  const opened = await until(`(() => { const t = document.querySelector(".sb-term"); return t && !t.hidden && !!${T}; })()`, 15000);
  check(!!opened, "the dock opens");
  const shellUp = await until(`document.querySelector(".sb-term").dataset.startMs !== undefined && !document.querySelector(".sb-term-loading")`, 60000);
  if (!shellUp) console.log("state", JSON.stringify(await evaluate(`({ t: !!window.__sbTerm, ds: { ...document.querySelector(".sb-term")?.dataset }, loading: document.querySelector(".sb-term-loading")?.textContent ?? null, screen: window.__sbTerm?.screenText?.slice(-200) })`)));
  check(!!shellUp, "the shell is up");
  await evaluate(`${T}.term.focus(), 1`);
  // (a shell line first, so the shell's history holds it)
  await line("echo shell-history");
  check(!!(await until(`${T}.screenText.includes("shell-history\\n")`, 30000)), "a shell line runs");

  // ---- python's prompt
  await line("python");
  check(!!(await waitPrompt(">>> ", "Python, in a session of its own (not any notebook's), with your workspace's files.")), `python: the banner, then >>> (${JSON.stringify(await last(3))})`);
  const head = await evaluate(`({ title: document.querySelector(".sb-term-title").textContent, stop: document.querySelector(".sb-term-stop").title, hidden: document.querySelector(".sb-term-stop").hidden })`);
  check(head.title === "Python" && head.stop === "Stop Python" && head.hidden === false, `the header says Python, Stop says Stop Python (${JSON.stringify(head)})`);
  const st = () => evaluate(`(() => { const t = ${T}; return { pr: !!t.pr, ask: !!t.pr?.ask, kind: t.pr?.ask?.args?.kind, running: !!t.running, editing: t.editing, buf: t.editor.buf, last: t.screenText.split("\\n").slice(-2) }; })()`);
  if (process.env.DEBUG) console.log("before x", JSON.stringify(await st()));
  await type("x = 6 * 7");
  if (process.env.DEBUG) console.log("typed x", JSON.stringify(await st()));
  await realKey("Enter");
  await pause(2000);
  if (process.env.DEBUG) console.log("after x", JSON.stringify(await st()));
  await waitPrompt(">>> ");
  await type("print(x)");
  if (process.env.DEBUG) console.log("typed print", JSON.stringify(await st()));
  await realKey("Enter");
  await pause(2000);
  if (process.env.DEBUG) console.log("after print", JSON.stringify(await st()));
  check(!!(await waitPrompt(">>> ", "\n42\n")), `a statement's output (${JSON.stringify(await last(3))})`);
  await line("for i in range(2):");
  check(!!(await waitPrompt("... ")), "a continued input asks with ... ");
  await line("    print('row', i)");
  await waitPrompt("... ");
  await line("");
  check(!!(await waitPrompt(">>> ", "row 1\n")), `the for ran when the input ended (${JSON.stringify(await last(4))})`);

  // ---- Ctrl+C: at a fresh >>>, in a continuation, while a statement runs
  await type("half typed");
  await ctrlC();
  check(!!(await waitPrompt(">>> ", "KeyboardInterrupt\n")), `Ctrl+C at >>>: KeyboardInterrupt, the same prompt (${JSON.stringify(await last(3))})`);
  await line("if True:");
  await waitPrompt("... ");
  const kiBefore = (await screen()).split("\n").filter((l) => l === "KeyboardInterrupt").length;
  // (twice at once: the second, before the worker asks again, sends and draws nothing)
  await ctrlC();
  await ctrlC();
  check(!!(await waitPrompt(">>> ")), "Ctrl+C in a continuation: the input dropped, back to >>>");
  const kiAfter = (await screen()).split("\n").filter((l) => l === "KeyboardInterrupt").length;
  check(kiAfter === kiBefore + 1, `a second Ctrl+C before the worker asks again: one KeyboardInterrupt line, nothing more (${kiBefore} -> ${kiAfter})`);
  await line("print('not interrupted')");
  check(!!(await waitPrompt(">>> ", "not interrupted\n")), "and the next statement runs, not interrupted by it");
  await line("while True: pass");
  await pause(1500);
  await realKey("Enter");
  const note = await evaluate(`document.querySelector(".sb-term-note")?.textContent ?? ""`);
  check(note === "Python is still running: wait, or press Ctrl+C to interrupt it.", `Enter while a statement runs: the prompt's own words (${JSON.stringify(note)})`);
  await ctrlC();
  check(!!(await waitPrompt(">>> ", "KeyboardInterrupt")), `Ctrl+C while a statement runs: its KeyboardInterrupt, the prompt goes on (${JSON.stringify(await last(3))})`);
  await line("print(1+1)");
  check(!!(await waitPrompt(">>> ", "\n2\n")), "then 1+1 is 2");

  // ---- history per language: Up recalls the prompt's line, never the shell's
  await realKey("ArrowUp");
  const up = await evaluate(`${T}.editor.buf`);
  check(up === "print(1+1)", `Up at >>> recalls the prompt's own last line (${JSON.stringify(up)})`);
  await ctrlC();
  await waitPrompt(">>> ");

  // ---- hide keeps; Ctrl+D leaves
  await evaluate(`document.querySelector(".sb-term-hide").click(), 1`);
  await pause(300);
  await evaluate(`document.querySelector("#termbtn").click(), 1`);
  await pause(300);
  check((await last())[0] === ">>> " && (await evaluate(`${T}.editor !== undefined && document.querySelector(".sb-term-title").textContent === "Python"`)), "✕ hides and keeps the prompt where it was");
  await evaluate(`${T}.term.focus(), 1`);
  await realKey("d", { ctrl: true });
  check(!!(await until(`(() => { const l = ${T}.screenText.split("\\n").pop(); return / \\$ $/.test(l) && document.querySelector(".sb-term-title").textContent === ""; })()`, 30000)), `Ctrl+D leaves: the shell's prompt again (${JSON.stringify(await last(2))})`);
  await realKey("ArrowUp");
  check((await evaluate(`${T}.editor.buf`)) === "python", "the shell's history is the shell's: Up recalls python, not the prompt's lines");
  await ctrlC();

  // ---- sage
  await line("sage");
  check(!!(await waitPrompt("sage: ", "Sage, in a session")), "sage: its banner and sage: prompt");
  await line("factor(2^10 - 1)");
  check(!!(await waitPrompt("sage: ", "3 * 11 * 31")), "sage's preparser");
  await realKey("d", { ctrl: true });
  check(!!(await until(`/ \\$ $/.test(${T}.screenText.split("\\n").pop())`, 30000)), "Ctrl+D leaves sage");

  // ---- matlab and magma: their banners and prompts, a statement, Ctrl+C at a fresh prompt (r1b's table: KeyboardInterrupt
  // for every language, the same request kept), Ctrl+D back to the shell
  const shellPrompt = () => until(`/ \\$ $/.test(${T}.screenText.split("\\n").pop())`, 30000);
  for (const [cmd, name, ps, stmt, want] of [["matlab", "MATLAB", ">> ", "disp(6*7)", "42"], ["magma", "Magma", "> ", "print 6*7;", "42"]]) {
    await line(cmd);
    check(!!(await waitPrompt(ps, `${name}, in a session of its own`, 60000)), `${cmd}: its banner and ${JSON.stringify(ps)} prompt`);
    await line(stmt);
    check(!!(await waitPrompt(ps, `\n${want}\n`)), `${cmd}: ${stmt} gives ${want}`);
    await ctrlC();
    check(!!(await waitPrompt(ps, "^C\nKeyboardInterrupt\n")), `${cmd}: Ctrl+C at a fresh prompt: KeyboardInterrupt, the prompt again`);
    await realKey("d", { ctrl: true });
    check(!!(await shellPrompt()) && (await evaluate(`document.querySelector(".sb-term-title").textContent`)) === "", `${cmd}: Ctrl+D back to the shell`);
  }

  // ---- what a statement has left (r1 §7.1), with small bounds (40 bytes, 4 lines, a newline each): a paste or line
  // past it is refused whole, nothing of it runs, the next statement starts fresh
  await evaluate(`${T}.promptLimits = { sourceBytes: 40, lines: 4 }, 1`);
  await line("python");
  await waitPrompt(">>> ", "Python, in a session", 60000);
  const paste = (text) => evaluate(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(text)}); document.querySelector(".sb-term .xterm-helper-textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()`);
  const TOO = "input too long (the limit is 40 bytes, 4 lines)";
  const refusedThenFresh = async (what) => {
    check(!!(await waitPrompt(">>> ", TOO)), `${what}: refused whole, back to >>> (${JSON.stringify(await last(3))})`);
    await evaluate(`${T}.term.clear(), 1`);
    await line("1+1");
    check(!!(await waitPrompt(">>> ", "\n2\n")), `${what}: then 1+1 is 2`);
    check(!(await screen()).includes("\nTAIL\n"), `${what}: no line of it ran afterwards`);
    await evaluate(`${T}.term.clear(), 1`);
  };
  // (a legal continued prefix, then a paste that fits the editor but not what the statement has left)
  await line("if True:");
  await waitPrompt("... ");
  await paste("  a = 1\n  b = " + "2".repeat(30) + "\nprint('TAIL')");
  await realKey("Enter");
  await refusedThenFresh("a continuation paste past the statement's bytes");
  // (past its lines, within its bytes: 1 + 4 lines, 23 bytes)
  await line("if True:");
  await waitPrompt("... ");
  await paste("  1\n  2\n  3\n4");
  await realKey("Enter");
  await refusedThenFresh("a continuation paste past the statement's lines");
  // (a line typed while a continuation waits, past what is left)
  await line("if True:");
  await waitPrompt("... ");
  await line("  x = " + "1".repeat(30));
  await refusedThenFresh("a continuation line typed past the statement's bytes");
  // (within the bounds: a paste of two statements runs both)
  await paste("u = 3\nprint(u * 5)");
  await realKey("Enter");
  check(!!(await waitPrompt(">>> ", "\n15\n")), "a paste within the bounds: both its statements run");
  await realKey("d", { ctrl: true });
  await shellPrompt();
  await evaluate(`${T}.promptLimits = null, 1`);

  // ---- End terminal session… ends a prompt: at >>>, and while a statement runs; the next open is the shell's, and a
  // new python prompt has no history from before
  const endSession = async () => {
    await evaluate(`window.confirm = () => true; document.querySelector("#termendbtn").click(), 1`);
    await until(`!document.querySelector(".sb-term") || document.querySelector(".sb-term").hidden || !window.__sbTerm?.pr`, 30000);
    await pause(500);
    await evaluate(`document.querySelector("#termbtn").click(), 1`);
    return until(`(() => { const t = window.__sbTerm; return t && !t.pr && / \\$ $/.test(t.screenText.split("\\n").pop()) && document.querySelector(".sb-term-title").textContent === ""; })()`, 60000);
  };
  await line("python");
  await waitPrompt(">>> ", "Python, in a session", 60000);
  await line("print('before end')");
  await waitPrompt(">>> ", "before end");
  check(!!(await endSession()), "End at >>>: the prompt is gone, the title cleared, the next open is the shell's $");
  await evaluate(`${T}.term.focus(), 1`);
  await line("python");
  await waitPrompt(">>> ", "Python, in a session", 60000);
  await realKey("ArrowUp");
  check((await evaluate(`${T}.editor.buf`)) === "", `after End, a new python prompt's history is empty (${JSON.stringify(await evaluate(`${T}.editor.buf`))})`);
  await line("import time; time.sleep(60)");
  await until(`!${T}.pr?.ask`, 10000);
  check(!!(await endSession()), "End while a statement runs: the prompt is gone, the next open is the shell's $");
} catch (e) {
  check(false, "the test ran: " + (e?.stack ?? e));
} finally {
  try { process.kill(-chrome.pid); } catch {}
  server?.kill();
  rmSync(profile, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} FAILED of ${checks}` : `ok: a prompt in the Terminal panel, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
