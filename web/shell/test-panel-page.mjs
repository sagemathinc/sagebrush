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
  await evaluate(`document.querySelector("#termbtn").click()`);
  check(!!(await until(`(() => { const t = document.querySelector(".sb-term"); return t && !t.hidden; })()`, 15000)), "the dock opens");
  // one command: type, Enter, wait for the polite status after its output
  let n = 0;
  const run = async (cmd) => {
    n++;
    await evaluate(`(() => {
      const ta = document.querySelector(".sb-term textarea");
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
