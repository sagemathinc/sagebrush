// The terminal panel on the notebook page (plan-bash-shell r8c E5; step 6's preview): a smoke test in headless
// Chromium against web/dist built with SAGEBRUSH_TERMINAL=1 (the bash set in dist, as a hosted preview has it).
// ⋯ ▸ Terminal opens the dock; commands run through the page's ShellHost with the person principal: text, SGR
// colour, visible escapes, cd carried to the next command, stderr and a non-zero exit; E5.8's keys, caps, placement
// and screen-reader order; the page commands; and the r1 reviews' findings (board TP-1..TP-9, daybreak2 326-2).
//   SAGEBRUSH_TERMINAL=1 bun web/build.ts && bun web/shell/test-panel-page.mjs [SHOT.png]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = join(import.meta.dir, "..");
if (!existsSync(join(here, "dist", "shell", "preview-set.json"))) throw new Error("build web/dist with SAGEBRUSH_TERMINAL=1 first");
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
  const send = (method, params = {}) => new Promise((r) => {
    const id = ++seq;
    waiting.set(id, r);
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
  await send("Page.navigate", { url });
  check(!!(await until(`(() => { const b = document.querySelector("#termbtn"); return b && !b.hidden; })()`)), "⋯ ▸ Terminal shows on a local host");
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
  check(!!(await until(`(() => { const t = document.querySelector(".sb-term"); return t && !t.hidden; })()`, 15000)), "the dock opens");
  check(!!(await until(`!!document.querySelector(".sb-term-loading") || document.querySelector(".sb-term").dataset.startMs !== undefined`, 5000)), "opening shows 'Starting the shell…' while bash loads (or it was already up)");
  check(!!(await until(`document.querySelector(".sb-term").dataset.startMs !== undefined && !document.querySelector(".sb-term-loading")`, 30000)), "the loading line goes once the shell is up");
  const covered = await evaluate(`(() => {
    const ta = document.querySelector(".sb-term textarea").getBoundingClientRect();
    const tops = ["sb-alpha-banner", "sb-preview-notice"].map((id) => document.getElementById(id)).filter(Boolean).map((e) => e.getBoundingClientRect().top);
    return { taBottom: ta.bottom, tops, focused: document.activeElement === document.querySelector(".sb-term textarea") };
  })()`);
  check(covered && covered.tops.every((t) => covered.taBottom <= t) && covered.focused, `the prompt is above every bottom overlay, and focused: ${JSON.stringify(covered)}`);
  // (the live DOM's totals, counted from the DOM itself, independently of the panel's own accounting: code units,
  // lines (each block line, plus each line end inside an output) and runs (each element or text node in an output,
  // and each block line), the drop marker included; DB2-TERM-326-2: never over the scrollback's caps)
  const DOM_TOTALS = `(() => {
    const log = document.querySelector(".sb-term-log");
    if (!log) return null;
    let units = 0, lines = 0, spans = 0;
    for (const c of log.children) {
      if (!c.classList.contains("sb-term-cmd")) { units += c.textContent.length; lines++; spans++; continue; }
      for (const b of c.children) {
        units += b.textContent.length;
        if (b.classList.contains("sb-term-out")) {
          lines += (b.textContent.match(/\\n/g) || []).length;
          // (a long line's page boxes and a slice's chunk boxes: each one, and each node in it, a chunk's page boxes too)
          const count = (p) => [...p.childNodes].reduce((a, nd) => a + 1 + (nd.matches?.(".sb-term-page, .sb-term-chunk") ? count(nd) : 0), 0);
          spans += count(b);
        } else {
          lines += 1 + (b.textContent.match(/\\n/g) || []).length;
          spans++;
        }
      }
    }
    return { units, lines, spans };
  })()`;
  const CAPS_SB = { units: 4194304, lines: 6000, spans: 50000 };
  const over = [];
  const invariant = async (what) => {
    const t = await evaluate(DOM_TOTALS);
    if (t && (t.units > CAPS_SB.units || t.lines > CAPS_SB.lines || t.spans > CAPS_SB.spans)) over.push(`${what}: ${JSON.stringify(t)}`);
    return t;
  };
  // one command: type, Enter, wait for the polite status after its output
  let n = 0;
  const run = async (cmd) => {
    n++;
    await evaluate(`(() => {
      const ta = document.querySelector(".sb-term textarea");
      document.querySelector(".sb-term-status").textContent = "";
      ta.value = ${JSON.stringify(cmd)};
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    })()`);
    await until(`document.querySelectorAll(".sb-term-cmd").length >= ${n} && !document.querySelector(".sb-term").classList.contains("running") && document.querySelector(".sb-term-status").textContent !== ""`, 60000);
    await invariant(cmd);
    return evaluate(`(() => {
      const c = [...document.querySelectorAll(".sb-term-cmd")].at(-1);
      return { out: c.querySelector(".sb-term-out").textContent, html: c.querySelector(".sb-term-out").innerHTML,
               exit: c.querySelector(".sb-term-exit")?.textContent ?? null, status: document.querySelector(".sb-term-status").textContent,
               cwd: document.querySelector(".sb-term-cwd").textContent };
    })()`);
  };
  let r = await run("echo hello");
  check(r?.out === "hello\n" && r.status === "done", `echo: ${JSON.stringify(r)}`);
  r = await run("printf '\\033[31mred\\033[0m plain\\n'");
  check(/<span class="sb-fg-1">red<\/span> plain/.test(r?.html ?? ""), `SGR 31 -> a span of class sb-fg-1: ${r?.html}`);
  r = await run("printf 'a\\033[2Jb\\n'");
  check(r?.out === "a␛[2Jb\n", `a non-SGR escape shown visibly: ${JSON.stringify(r?.out)}`);
  r = await run("mkdir -p tdir && cd tdir");
  check(r?.cwd === "/tdir", `cd carries to the header: ${r?.cwd}`);
  r = await run("pwd");
  check(r?.out === "/tdir\n", `the next command runs in it: ${JSON.stringify(r?.out)}`);
  r = await run("echo oops >&2; exit 3");
  check(/class="sb-err[^"]*">oops/.test(r?.html ?? "") && r?.exit === "exit 3" && r?.status === "exit 3", `stderr marked, exit 3 shown and announced: ${JSON.stringify(r)}`);
  r = await run("printf '<b>x</b>\\n'");
  check(r?.out === "<b>x</b>\n" && !/<b>/.test(r?.html ?? ""), "markup from data stays text");
  check((await evaluate(`document.querySelector(".sb-term-log").getAttribute("aria-live")`)) === "off", "the log is never live");
  // clear and reset: the panel's own (William: both said "command not found")
  const typeEnter = (cmd) => evaluate(`(() => { const ta = document.querySelector(".sb-term textarea"); ta.value = ${JSON.stringify(cmd)};
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); })()`);
  await typeEnter("clear");
  check((await evaluate(`document.querySelectorAll(".sb-term-cmd").length`)) === 0, "clear empties the scrollback");
  n = 0;
  r = await run("echo after-clear");
  check(r?.out === "after-clear\n", "commands run after clear");
  await typeEnter("reset");
  check((await evaluate(`document.querySelectorAll(".sb-term-cmd").length`)) === 0, "reset empties the scrollback");
  n = 0;
  r = await run("pwd");
  check(r?.out === "/tdir\n" && r?.status === "done", `after reset a fresh shell runs, in the same directory: ${JSON.stringify(r)}`);
  // open, ps, top: the panel's own (William's P1)
  r = await run("cd /");
  r = await run("ps");
  check(/^PID\s+TAB\s+KIND\s+STATE\s+TIME\s+MEM\s+NAME\n/.test(r?.out ?? "") && /notebook\s+\S+\s+\d\d:\d\d:\d\d.*\[this tab\]/.test(r.out) && /terminal\s+running/.test(r.out),
    `ps lists this tab's notebook and its terminal (running ps itself): ${JSON.stringify(r?.out)}`);
  // (a second tab of the page answers too)
  await send("Target.createTarget", { url });
  await new Promise((res) => setTimeout(res, 6000));
  r = await run("ps");
  const nbRows = (r?.out ?? "").split("\n").filter((l) => /\snotebook\s/.test(l));
  check(nbRows.length >= 2 && nbRows.some((l) => !l.includes("[this tab]")), `ps lists another tab's notebook: ${JSON.stringify(r?.out)}`);
  // (a board tab answers too: web/board/page.ts's answer handler)
  await send("Target.createTarget", { url: url + "board/?new=python" });
  await new Promise((res) => setTimeout(res, 8000));
  r = await run("ps");
  check(/\sboard\s+\S+\s+\d\d:\d\d:\d\d.*\.board\.json\s+\(python\)/.test(r?.out ?? ""), `ps lists a board tab, with its path and language: ${JSON.stringify(r?.out)}`);
  r = await run("open no-such-file.txt");
  check(/open: no-such-file.txt: No such file or directory/.test(r?.out ?? "") && r?.exit === "exit 1" && r?.status === "exit 1", `open: a missing path is an error: ${JSON.stringify(r)}`);
  r = await run("open");
  check(/^usage: open FILE/.test(r?.out ?? "") && r?.exit === "exit 2", `open with no file: usage, exit 2: ${JSON.stringify(r)}`);
  const ls = await run("ls");
  const nbFile = (ls?.out ?? "").split("\n").find((l) => l.endsWith(".ipynb"));
  if (nbFile) {
    r = await run(`open '${nbFile}'`);
    check(r?.out === `opened /${nbFile} (a notebook, in a new tab)\n` && r?.status === "done", `open a notebook: ${JSON.stringify(r)}`);
  } else check(false, `ls shows a notebook to open: ${JSON.stringify(ls?.out)}`);
  r = await run("echo 'ps | grep' | cat");
  check(r?.out === "ps | grep\n", "a line with shell syntax goes to bash, not the panel's commands");
  // top: refreshed until Stop
  n++;
  await evaluate(`(() => { const ta = document.querySelector(".sb-term textarea"); document.querySelector(".sb-term-status").textContent = "";
    ta.value = "top"; ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); })()`);
  await new Promise((res) => setTimeout(res, 2500));
  const t1 = await evaluate(`[...document.querySelectorAll(".sb-term-cmd")].at(-1).querySelector(".sb-term-out").textContent`);
  check(/^top - \d\d:\d\d:\d\d\s+\d+ tabs?, \d+ documents?, \d+ running/.test(t1 ?? "") && (await evaluate(`document.querySelector(".sb-term").classList.contains("running")`)) === true, `top shows a live listing and keeps running: ${JSON.stringify((t1 ?? "").slice(0, 120))}`);
  await evaluate(`document.querySelector(".sb-term-stop").click()`);
  check(!!(await until(`!document.querySelector(".sb-term").classList.contains("running") && document.querySelector(".sb-term-status").textContent === "done"`, 5000)), "Stop ends top");
  // ---- E5.8: keys, placement and the screen-reader order
  const ta = `document.querySelector(".sb-term textarea")`;
  const key = (k, mods = {}) => evaluate(`(() => { const e = new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} });
    ${ta}.dispatchEvent(e); return e.defaultPrevented; })()`);
  const setInput = (v) => evaluate(`(() => { ${ta}.value = ${JSON.stringify(v)}; ${ta}.selectionStart = ${ta}.selectionEnd = ${JSON.stringify(v)}.length; })()`);
  const running = () => evaluate(`document.querySelector(".sb-term").classList.contains("running")`);
  const cmdCount = () => evaluate(`document.querySelectorAll(".sb-term-cmd").length`);
  const LOOP = "i=0; while true; do i=$((i+1)); done";
  // (a multi-line paste is one run)
  await run("clear");
  n = 0;
  r = await run("echo one\necho two");
  check(r?.out === "one\ntwo\n" && (await cmdCount()) === 1, `a multi-line input runs as one command: ${JSON.stringify(r?.out)}`);
  // (Enter while a command runs: no submit, no queue, the note)
  await setInput(LOOP);
  await key("Enter");
  check(!!(await until(`document.querySelector(".sb-term").classList.contains("running")`, 10000)), "a long command runs");
  const before = await cmdCount();
  await setInput("echo queued");
  await key("Enter");
  check((await cmdCount()) === before && (await evaluate(`${ta}.value`)) === "echo queued" && (await evaluate(`document.querySelector(".sb-term-note").textContent`)) === "A command is running: Stop it first.",
    "Enter while running: nothing submitted or queued, the input kept, the note shown");
  // (Ctrl-C with a selection: copy, the command keeps running)
  await evaluate(`getSelection().selectAllChildren(document.querySelector(".sb-term-pl"))`);
  const copyPrevented = await key("c", { ctrlKey: true });
  check(copyPrevented === false && (await running()) === true, "Ctrl-C with a selection is the copy (not prevented), and the command keeps running");
  await evaluate(`getSelection().removeAllRanges()`);
  // (Ctrl-L during a run: only the earlier commands are cleared)
  await key("l", { ctrlKey: true });
  check((await cmdCount()) === 1 && (await running()) === true, "Ctrl-L during a run clears the earlier commands and keeps the running one");
  // (Ctrl-C with no selection: Stop)
  await evaluate(`document.querySelector(".sb-term-status").textContent = ""`);
  const stopPrevented = await key("c", { ctrlKey: true });
  check(stopPrevented === true && !!(await until(`!document.querySelector(".sb-term").classList.contains("running") && document.querySelector(".sb-term-status").textContent === "stopped"`, 10000)),
    "Ctrl-C with no selection stops the command");
  check((await evaluate(`[...document.querySelectorAll(".sb-term-cmd")].at(-1).querySelector(".sb-term-exit")?.textContent`)) === "^C (stopped)", "the stopped command says so");
  // (Stop by the button)
  await setInput(LOOP);
  await key("Enter");
  await until(`document.querySelector(".sb-term").classList.contains("running")`, 10000);
  await evaluate(`document.querySelector(".sb-term-status").textContent = ""; document.querySelector(".sb-term-stop").click()`);
  check(!!(await until(`!document.querySelector(".sb-term").classList.contains("running") && document.querySelector(".sb-term-status").textContent === "stopped"`, 10000)), "Stop by the button");
  r = await run("echo after-stop");
  check(r?.out === "after-stop\n", "the shell runs again after Stop");
  // (Ctrl-C when idle: ^C, the input cleared)
  await setInput("half typed");
  const c0 = await cmdCount();
  await key("c", { ctrlKey: true });
  check((await evaluate(`${ta}.value`)) === "" && (await cmdCount()) === c0 + 1 && (await evaluate(`[...document.querySelectorAll(".sb-term-cmd")].at(-1).textContent`)).endsWith("^C"), "Ctrl-C when idle: ^C and the input cleared");
  // (history: Up from an edited input keeps the draft; Down past the newest restores it)
  await run("echo hist-1");
  await setInput("my draft");
  await key("ArrowUp");
  const up = await evaluate(`${ta}.value`);
  await key("ArrowDown");
  check(up === "echo hist-1" && (await evaluate(`${ta}.value`)) === "my draft", `history Up/Down keeps the draft: up=${JSON.stringify(up)}`);
  await setInput("");
  // (the screen-reader order: the polite status changes only after the last output has gone into the log)
  await evaluate(`window.__order = []; window.__mo = new MutationObserver((ms) => { for (const m of ms) window.__order.push(m.target.closest?.(".sb-term-status") || m.target.parentElement?.closest?.(".sb-term-status") ? "status" : "log"); });
    window.__mo.observe(document.querySelector(".sb-term"), { childList: true, subtree: true, characterData: true })`);
  r = await run("seq 1 3000");
  const order = await evaluate(`(() => { window.__mo.disconnect(); return window.__order; })()`);
  const lastLog = order.lastIndexOf("log"), lastStatus = order.lastIndexOf("status");
  check(r?.status === "done" && lastLog >= 0 && lastStatus > lastLog,
    `the status is announced after the output: the last status change at ${lastStatus}, the last output at ${lastLog}, of ${order.length}`);
  check((await evaluate(`document.querySelector(".sb-term-log").getAttribute("aria-live")`)) === "off" && (await evaluate(`document.querySelector(".sb-term-stop").tagName`)) === "BUTTON" && /\/ \$|in \//.test(await evaluate(`${ta}.getAttribute("aria-label")`)), "the log is never live; Stop is a button; the input's label names the cwd");
  // (the scrollback, end to end: two commands of 4 999 lines cross its 6 000-line cap together: the older is dropped
  // whole, and the marker says so; the DOM's lines stay within the cap, the marker included)
  await run("clear");
  n = 0;
  await run("seq 1 4999");
  r = await run("seq 5000 9998");
  const sb = await evaluate(`(() => { const log = document.querySelector(".sb-term-log");
    const lines = [...log.children].reduce((a, c) => a + (c.classList.contains("sb-term-cmd") ? 1 + (c.querySelector(".sb-term-out").textContent.match(/\\n/g) || []).length + c.querySelectorAll(".sb-term-exit").length : 1), 0);
    return { cmds: log.querySelectorAll(".sb-term-cmd").length, drop: log.querySelector(".sb-term-drop")?.textContent ?? null, lines }; })()`);
  check(sb && sb.cmds === 1 && sb.drop === "[1 earlier command dropped]" && sb.lines <= 6000 && r?.out.startsWith("5000\n") && r.out.endsWith("9998\n"),
    `the scrollback drops the older command whole when the sum crosses its line cap: ${JSON.stringify(sb)}`);
  // (DB2-TERM-326-2: every displayed path capped before insertion) a page command writing past the per-command caps,
  // in many writes and in one; one replacing its output past them; prompt-only lines past the scrollback's line cap;
  // exit lines at the scrollback's line boundary
  await run("clear");
  n = 0;
  await evaluate(`(() => { const c = window.__sbTerm.opts.commands;
    c.manylines = async (a, io) => { for (let i = 0; i < 7000; i++) io.write("w" + i + "\\n"); return 0; };
    c.bigwrite = async (a, io) => { io.write("y".repeat(2 * 1048576)); return 0; };
    c.bigreplace = async (a, io) => { io.replace("r\\n".repeat(6000)); await new Promise((r) => setTimeout(r, 50)); io.replace("s\\n".repeat(7000)); return 0; };
  })()`);
  const outOf = (sel = ".sb-term-out") => evaluate(`(() => { const c = [...document.querySelectorAll(".sb-term-cmd")].at(-1); const o = c.querySelector("${sel}"); return { text: o.textContent, lines: (o.textContent.match(/\\n/g) || []).length, nodes: o.childNodes.length }; })()`);
  r = await run("manylines");
  let o = await outOf();
  check(r?.status === "done" && o.lines === 4999 && /\[\u2026 \d+ more bytes not shown\]$/.test(o.text), `a page command's 7 000 writes: its first 4 999 lines, then the omission line (${o.lines} lines; ${JSON.stringify(o.text.slice(-40))})`);
  r = await run("bigwrite");
  o = await outOf();
  check(r?.status === "done" && o.text.length <= 1048576 && /more bytes not shown\]$/.test(o.text), `a page command's 2 MiB write: within the per-command units, with the omission line (${o.text.length})`);
  r = await run("bigreplace");
  o = await outOf();
  check(r?.status === "done" && o.lines === 4999 && o.text.startsWith("s\n") && /more bytes not shown\]$/.test(o.text), `a page command's replace past the caps: the latest text, capped (${o.lines} lines)`);
  // (prompt-only lines: 6 100 Enters on an empty input; the scrollback's line cap holds, the oldest dropped)
  await evaluate(`(() => { const ta = document.querySelector(".sb-term textarea"); for (let i = 0; i < 6100; i++) { ta.value = ""; ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); } })()`);
  let dt = await invariant("6 100 prompt-only lines");
  check(dt && dt.lines <= 6000 && dt.lines >= 5990 && /earlier commands dropped/.test(await evaluate(`document.querySelector(".sb-term-drop")?.textContent ?? ""`)), `6 100 prompt-only lines: the scrollback holds its line cap, with the marker (${JSON.stringify(dt)})`);
  // (exit lines at the boundary: commands that fail, each a prompt and an exit line, past the cap)
  await run("clear");
  n = 0;
  await run("seq 1 4990");
  for (let i = 0; i < 8; i++) await run("false");
  dt = await invariant("exit lines at the boundary");
  check(dt && dt.lines <= 6000, `exit lines at the scrollback's line boundary: within the cap (${JSON.stringify(dt)})`);
  check(over.length === 0, `after every command, the live DOM within the scrollback's caps: ${over.length ? over.slice(0, 3).join("; ") : "all"}`);
  // ---- board's r1 findings
  // (TP-3: the person's text is one eval: a trailing backslash, an open heredoc or quote never reach the bookkeeping)
  await run("clear");
  n = 0;
  await run("cd /tdir");
  for (const [what, cmd] of [["a trailing backslash", "echo a \\"], ["an unterminated heredoc", "cat <<EOF\nhello"], ["an unterminated quote", 'echo "abc']]) {
    r = await run(cmd);
    const all = await evaluate(`[...document.querySelectorAll(".sb-term-cmd")].at(-1).textContent`);
    check(!/__sb|\x1e/.test(all) && r?.cwd === "/tdir" && (r?.status === "done" || /^exit \d+$/.test(r?.status ?? "")), `${what}: no bookkeeping shown, the status (${r?.status}) and the cwd (${r?.cwd}) kept: ${JSON.stringify(all.slice(0, 120))}`);
  }
  r = await run(`echo 'x'"y" && echo "it's" && echo '$HOME \\ \`'`);
  check(r?.out === "xy\nit's\n$HOME \\ `\n", `quoting through the eval: ${JSON.stringify(r?.out)}`);
  r = await run("cd / && pwd");
  check(r?.out === "/\n" && r?.cwd === "/", "cd still carries through the eval");
  // (TP-4: an input method's Enter confirms its composition, never a submit)
  const before4 = await cmdCount();
  await setInput("echo 日本");
  const composing = await evaluate(`(() => { const e = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, keyCode: 229, bubbles: true, cancelable: true }); ${ta}.dispatchEvent(e); return ${ta}.value; })()`);
  check((await cmdCount()) === before4 && composing === "echo 日本", "TP-4: Enter while composing adds no command and keeps the input");
  await setInput("");
  // (TP-6: the running note is polite, named by the input, and gone when the run ends)
  await setInput(LOOP);
  await key("Enter");
  await until(`document.querySelector(".sb-term").classList.contains("running")`, 10000);
  await setInput("echo later");
  await key("Enter");
  const note = await evaluate(`(() => { const nt = document.querySelector(".sb-term-note"); return { shown: !nt.hidden, live: nt.getAttribute("aria-live"), described: ${ta}.getAttribute("aria-describedby") === nt.id }; })()`);
  await evaluate(`document.querySelector(".sb-term-stop").click()`);
  await until(`!document.querySelector(".sb-term").classList.contains("running")`, 10000);
  check(note.shown && note.live === "polite" && note.described && (await evaluate(`document.querySelector(".sb-term-note").hidden`)) === true, `TP-6: the note is polite and describes the input, and is gone after the run: ${JSON.stringify(note)}`);
  await setInput("");
  // (TP-8: the grip: focusable, its value, Up/Down within 120 px and 80% of the window, remembered for the session)
  const g0 = await evaluate(`(() => { const g = document.querySelector(".sb-term-grip"); return { tab: g.tabIndex, now: +g.getAttribute("aria-valuenow"), min: +g.getAttribute("aria-valuemin"), max: +g.getAttribute("aria-valuemax"), h: Math.round(document.querySelector(".sb-term").getBoundingClientRect().height) }; })()`);
  const gkey = (k, shift = false) => evaluate(`document.querySelector(".sb-term-grip").dispatchEvent(new KeyboardEvent("keydown", { key: "${k}", shiftKey: ${shift}, bubbles: true, cancelable: true }))`);
  await gkey("ArrowUp");
  const g1 = await evaluate(`+document.querySelector(".sb-term-grip").getAttribute("aria-valuenow")`);
  for (let i = 0; i < 40; i++) await gkey("ArrowUp", true);
  const gMax = await evaluate(`({ now: +document.querySelector(".sb-term-grip").getAttribute("aria-valuenow"), h: Math.round(document.querySelector(".sb-term").getBoundingClientRect().height), ih: innerHeight, kept: +sessionStorage.getItem("sb-term-h") })`);
  for (let i = 0; i < 60; i++) await gkey("ArrowDown", true);
  const gMin = await evaluate(`+document.querySelector(".sb-term-grip").getAttribute("aria-valuenow")`);
  check(g0.tab === 0 && g0.min === 120 && g0.now === g0.h && g1 === g0.now + 24 && gMax.now === Math.round(gMax.ih * 0.8) && gMax.h === gMax.now && gMax.kept === gMax.now && gMin === 120,
    `TP-8: the grip resizes from the keyboard within 120 px and 80%, and is remembered: ${JSON.stringify({ g0, g1, gMax, gMin })}`);
  await gkey("ArrowUp", true);
  // (TP-9: the history: 500 at most, oldest dropped; a command repeated at once kept once)
  const hist = await evaluate(`(() => { const t = window.__sbTerm; for (let i = 0; i < 520; i++) t.remember("h" + i); t.remember("same"); t.remember("same");
    return { len: t.history.length, first: t.history[0], last2: t.history.slice(-2) }; })()`);
  check(hist.len === 500 && hist.first === "h21" && hist.last2[0] === "h519" && hist.last2[1] === "same", `TP-9: history holds 500, oldest dropped, an immediate repeat kept once: ${JSON.stringify(hist)}`);
  // (TP-9: hiding by ⋯ ▸ Terminal as well as by the dock's own control; TP-7: focus doesn't fall to body)
  await evaluate(`document.querySelector(".sb-term textarea").focus(); document.querySelector("#termbtn").click()`);
  check((await evaluate(`document.querySelector(".sb-term").hidden`)) === true && (await evaluate(`document.activeElement !== document.body`)), "TP-9/TP-7: ⋯ ▸ Terminal hides an open dock, and focus goes back, not to body");
  await evaluate(`document.querySelector("#termbtn").click()`);
  await evaluate(`document.querySelector(".sb-term textarea").focus(); document.querySelector(".sb-term-hide").click()`);
  check((await evaluate(`document.querySelector(".sb-term").hidden`)) === true && (await evaluate(`document.activeElement?.id`)) === "morebtn", `TP-7: the dock's own hide returns focus to the ⋯ button (${await evaluate(`document.activeElement?.id || document.activeElement?.tagName`)})`);
  await evaluate(`document.querySelector("#termbtn").click()`);
  // (TP-7-R2: a keyboard reopen from the ⋯ menu, with real key events, then the dock's hide by keyboard: focus goes to
  // the ⋯ button, not to body, though the recorded opener (the menu item) is hidden by then)
  const realKey = async (key, code, vk, text) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  await evaluate(`document.querySelector(".sb-term-hide").click()`);
  await evaluate(`document.querySelector("#morebtn").focus()`);
  await realKey("Enter", "Enter", 13, "\r");
  await until(`!document.querySelector("#moremenu").hidden`, 5000);
  await evaluate(`document.querySelector("#termbtn").focus()`);
  await realKey("Enter", "Enter", 13, "\r");
  const reopened = await until(`!document.querySelector(".sb-term").hidden`, 5000);
  await evaluate(`document.querySelector(".sb-term-hide").focus()`);
  await realKey("Enter", "Enter", 13, "\r");
  const kb = await evaluate(`({ hidden: document.querySelector(".sb-term").hidden, focus: document.activeElement?.id || document.activeElement?.tagName })`);
  check(reopened && kb.hidden === true && kb.focus === "morebtn", `TP-7-R2: reopened from the ⋯ menu by keyboard, hidden by keyboard: focus on the ⋯ button (${JSON.stringify(kb)})`);
  await evaluate(`document.querySelector("#termbtn").click()`);
  await until(`!document.querySelector(".sb-term").hidden`, 5000);
  // (TP-1: ✕ ends the shell's worker: counted, with reset as the control that fires)
  await evaluate(`window.__term = 0; const t0 = Worker.prototype.terminate; Worker.prototype.terminate = function () { window.__term++; return t0.call(this); }`);
  await run("echo before-reset");
  await typeEnter("reset");
  await until(`document.querySelector(".sb-term").dataset.startMs !== undefined`, 10000);
  n = 0;
  r = await run("echo after-reset");
  const afterReset = await evaluate(`window.__term`);
  check(afterReset === 1 && r?.out === "after-reset\n", `TP-1 control: reset ends one worker (${afterReset}), and a fresh one runs`);
  // ---- long lines: pages (the long-line design; @sagebrush's conditions, board's B-LL-*, daybreak2's)
  await run("clear");
  n = 0;
  check((await evaluate(`document.querySelectorAll(".sb-term-page").length`)) === 0, "B-LL-6: no page element for lines of 4 Ki or less (all output so far)");
  // (board's R4-1: ordinary output, echo, ls, ps, a 20-line listing, gets no chunk box; it stays plain lines, as in #326)
  r = await run("seq 1 20");
  check(r?.out.split("\n").length === 21 && (await evaluate(`document.querySelectorAll(".sb-term-chunk").length`)) === 0,
    "R4-1: no chunk box for ordinary output (all output so far, a 20-line listing included)");
  await evaluate(`window.__lt = []; window.__lto = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }); window.__lto.observe({ type: "longtask" })`);
  r = await run("seq 1 200000 | tr -d '\\n'; echo");
  const ll = await evaluate(`(() => {
    window.__lto.disconnect();
    const out = [...document.querySelectorAll(".sb-term-cmd")].at(-1).querySelector(".sb-term-out");
    const pages = out.querySelectorAll(".sb-term-page");
    const sel = getSelection(); sel.selectAllChildren(out); const copied = sel.toString(); sel.removeAllRanges();
    const body = copied.replace(/\\n?\\[\\u2026 \\d+ more bytes not shown\\]\\n?$/, "");
    return { pages: pages.length, maxPage: Math.max(...[...pages].map((p) => p.textContent.length)), copiedLines: body.replace(/\\n$/, "").split("\\n").length,
             head: body.slice(0, 20), markInPage: [...pages].some((p) => p.textContent.includes("not shown")), textLen: out.textContent.length, longMax: Math.max(0, ...window.__lt), longN: window.__lt.length };
  })()`);
  check(r?.status === "done" && ll.pages >= 200 && ll.maxPage <= 4096 && ll.copiedLines === 1 && !ll.markInPage && ll.head === "12345678910111213141",
    `a 1 MiB line: ${ll.pages} pages of at most 4 096, and select-all copies it as ONE line, no break at a join, the omission line after the last page (${JSON.stringify(ll)})`);
  console.log(`info: the 1 MiB line's Long Tasks during its render: ${ll.longN}, the longest ${ll.longMax.toFixed(1)} ms (the gates are E5.5's, on the timing box)`);
  r = await run("printf 'A%.0s' $(seq 1 5000); printf '\\r'; printf 'B%.0s' $(seq 1 4500); echo");
  const rp = await evaluate(`(() => { const out = [...document.querySelectorAll(".sb-term-cmd")].at(-1).querySelector(".sb-term-out");
    return { text: out.textContent, pages: out.querySelectorAll(".sb-term-page").length }; })()`);
  check(rp.text === "B".repeat(4500) + "\n" && rp.pages === 1, `\\r over a paged line (TP-2, B-LL-3): only the last text, with its one page (${rp.pages} pages, ${rp.text.length} units)`);
  // (DB2-LL-337-4: stderr-only output, its 64 KiB reservation scanned in several empty slices first: first paint is
  // measured only once output is in, and that first output is the first slice's, at most 8 KiB and a token.  The page
  // brought to the front first: a hidden tab paints no frames, so it measures none)
  await send("Page.bringToFront");
  check((await evaluate(`document.visibilityState`)) === "visible", "the page is in front again (after the other tabs)");
  await evaluate(`window.__fi = null; window.__mo = new MutationObserver(() => {
    const o = [...document.querySelectorAll(".sb-term-out")].at(-1);
    if (!window.__fi && o && o.textContent.length) window.__fi = { t: performance.now(), n: o.textContent.length };
  }); window.__mo.observe(document.querySelector(".sb-term-log"), { childList: true, subtree: true, characterData: true });
  performance.clearMeasures("sb-term:first-paint")`);
  r = await run("printf 'e%.0s' $(seq 1 100000) >&2; echo");
  const fp = await evaluate(`(() => { window.__mo.disconnect(); const m = performance.getEntriesByName("sb-term:first-paint").at(-1);
    return { fi: window.__fi, fpEnd: m ? m.startTime + m.duration : null, n: performance.getEntriesByName("sb-term:first-paint").length }; })()`);
  check(r?.status === "done" && fp.n === 1 && fp.fi && fp.fpEnd >= fp.fi.t && fp.fi.n <= 16384,
    `DB2-LL-337-4: stderr-heavy output: first paint after the first output (${JSON.stringify(fp)}), that output a first slice's`);
  await invariant("long lines");
  // (hide keeps the session; ✕ ends it)
  const kept = await cmdCount();
  await evaluate(`document.querySelector(".sb-term-hide").click()`);
  check((await evaluate(`document.querySelector(".sb-term").hidden`)) === true, "hide hides the dock");
  await evaluate(`document.querySelector("#termbtn").click()`);
  check((await evaluate(`document.querySelector(".sb-term").hidden`)) === false && (await cmdCount()) === kept, "⋯ ▸ Terminal again: the same session, its scrollback kept");
  await evaluate(`document.querySelector(".sb-term-end").click()`);
  check((await evaluate(`document.querySelectorAll(".sb-term").length`)) === 0, "✕ ends the session (the dock is gone)");
  check((await evaluate(`window.__term`)) === 2, `TP-1: ✕ ends the shell's worker too (terminate calls: ${await evaluate(`window.__term`)}, after reset's 1)`);
  await evaluate(`document.querySelector("#termbtn").click()`);
  await until(`!!document.querySelector(".sb-term") && !document.querySelector(".sb-term").hidden`, 10000);
  await key("ArrowUp");
  check((await cmdCount()) === 0 && (await evaluate(`${ta}.value`)) === "", "a new session after ✕: no scrollback and no history");
  // (under 700 px: a full-height sheet)
  await send("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
  await new Promise((res) => setTimeout(res, 300));
  const sheet = await evaluate(`(() => { const r = document.querySelector(".sb-term").getBoundingClientRect(); return { top: r.top, h: r.height, ih: innerHeight }; })()`);
  check(sheet && sheet.top <= 1 && sheet.h >= sheet.ih * 0.85, `under 700 px the dock is a full-height sheet: ${JSON.stringify(sheet)}`);
  await send("Emulation.clearDeviceMetricsOverride");
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
