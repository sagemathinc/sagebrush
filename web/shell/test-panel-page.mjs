// The terminal panel on the notebook page (plan-bash-shell r8c E5; step 6's preview): a smoke test in headless
// Chromium against web/dist built with SAGEBRUSH_TERMINAL=1 (the bash set in dist, as a hosted preview has it).
// ⋯ ▸ Terminal opens the dock; commands run through the page's ShellHost with the person principal: text, SGR
// colour, visible escapes, cd carried to the next command, stderr and a non-zero exit, Stop-free.  E5.8's full
// list (keys, caps, slices, screen-reader order, placement) follows in step 6's PR.
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
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1100,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
  if (process.argv[2]) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.argv[2], Buffer.from(shot.result.data, "base64"));
    console.log(`screenshot ${process.argv[2]}`);
  }
  ws.close();
} finally {
  chrome?.kill("SIGKILL");
  server?.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
if (fails.length) {
  console.log(`test-panel-page: ${fails.length} of ${checks} FAILED`);
  process.exit(1);
}
console.log(`test-panel-page: all ${checks} checks pass`);
