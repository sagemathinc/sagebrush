// The Terminal in the desktop and Android apps (William, Oct 30): the app's page, app/dist from
// app/build-frontend.mjs, served as the app serves it (app/serve-app.py: lib.rs's headers, the shell worker's CSP
// included), in headless Chromium with window.__TAURI__ before the page's scripts, as the app's web view has it.
// Twice: cross-origin isolated, as the desktop app, and not (--no-coi), as Android's web view, which has no
// SharedArrayBuffer.  Each time ⋯ ▸ Terminal shows, the dock opens, the bash set loads from the app's own files,
// and `echo ok` prints ok; the worker comes with its own policy, and from inside it a fetch (this origin's, another's),
// a module from another origin and a worker of its own are refused by that policy.
//   bun web/build.ts && node app/build-frontend.mjs && bun web/shell/test-panel-app.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const root = join(import.meta.dir, "..", "..");
if (!existsSync(join(root, "app", "dist", "shell", "preview-set.json"))) throw new Error("build app/dist first (node app/build-frontend.mjs)");
const CSP = /const SHELL_WORKER_CSP: &str = "([^"]*)";/.exec(readFileSync(join(root, "app", "src-tauri", "src", "lib.rs"), "utf8"))?.[1];
let checks = 0;
const fails = [];
const check = (ok, what) => {
  checks++;
  if (!ok) fails.push(what);
  console.log(`${ok ? "ok" : "FAIL"} ${what}`);
};
const servers = [];
let chrome = null;
const profile = mkdtempSync(join(tmpdir(), "sb-test-panel-app-"));
try {
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1100,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
  const dport = await devtoolsPort(profile);
  const target = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let seq = 0;
  const waiting = new Map();
  // (the page's workers, attached as they start: the shell worker's session, by its script)
  const workers = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id));
    if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") workers.set(m.params.targetInfo.url, m.params.sessionId);
  };
  const send = (method, params = {}, sessionId) => new Promise((r) => {
    const id = ++seq;
    waiting.set(id, r);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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
  // (the app's start: no files handed to it, no self-test; app/src-tauri/src/lib.rs's commands)
  await send("Page.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__TAURI__ = { core: { invoke: async (c) => (c === "startup_files" ? [] : null) }, event: { listen: async () => () => {} } };` });
  for (const coi of [true, false]) {
    const as = coi ? "the desktop app (isolated)" : "Android (not isolated)";
    const port = await startServe(() => {
      const s = spawn("python3", [join(root, "app", "serve-app.py"), ...(coi ? [] : ["--no-coi"]), "0"], { stdio: ["ignore", "pipe", "pipe"] });
      servers.push(s);
      return s;
    }).port;
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    // (the app-only File items shown: the page's start ran through, in app mode)
    const started = await until(`(() => { const b = document.querySelector('[data-f="openfile"]'); return !!window.__TAURI__ && !!b && !b.hidden; })()`, 60000);
    const iso = await evaluate(`({ coi: globalThis.crossOriginIsolated === true, sab: typeof SharedArrayBuffer })`);
    check(!!started && iso?.coi === coi && (coi || iso.sab === "undefined"), `${as}: the app's page started (${JSON.stringify(iso)})`);
    check(!!(await until(`(() => { const b = document.querySelector("#termbtn"); return !!b && !b.hidden; })()`, 10000)), `${as}: ⋯ ▸ Terminal shows`);
    const wcsp = await evaluate(`fetch("shell/worker-boot.js", { cache: "no-store" }).then((r) => r.headers.get("content-security-policy"))`);
    check(!!CSP && wcsp === CSP && /connect-src 'none'/.test(wcsp), `${as}: the shell worker comes with its own policy, lib.rs's: ${JSON.stringify(wcsp)}`);
    await evaluate(`document.querySelector("#termbtn").click()`);
    const up = await until(`(() => { const t = document.querySelector(".sb-term"); return !!t && !t.hidden && t.dataset.startMs !== undefined && !document.querySelector(".sb-term-loading"); })()`, 60000);
    const saved = await evaluate(`document.querySelector("#saved")?.textContent ?? ""`);
    check(!!up, `${as}: the dock opens and the shell starts from the app's own files${up ? "" : ` (the page says: ${JSON.stringify(saved)})`}`);
    await evaluate(`(() => {
      const ta = document.querySelector(".sb-term textarea");
      document.querySelector(".sb-term-status").textContent = "";
      ta.value = "echo ok";
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    })()`);
    await until(`document.querySelectorAll(".sb-term-cmd").length >= 1 && !document.querySelector(".sb-term").classList.contains("running") && document.querySelector(".sb-term-status").textContent !== ""`, 60000);
    const r = await evaluate(`(() => { const c = [...document.querySelectorAll(".sb-term-cmd")].at(-1); return c && { out: c.querySelector(".sb-term-out")?.textContent, status: document.querySelector(".sb-term-status").textContent }; })()`);
    check(r?.out === "ok\n" && r.status === "done", `${as}: echo ok prints ok: ${JSON.stringify(r)}`);
    // The policy at work in the shell worker itself, from inside it (R-380-3, astra's S2): a fetch of this origin's own
    // page and one of another origin (localhost, the same server, readable from anywhere: app/serve-app.py), a module imported
    // from that other origin, and a worker of its own, each refused, and each refusal the policy's (a
    // securitypolicyviolation event names its directive; the shell's own sandbox would refuse without one).  No
    // network connections; a module from this origin is still allowed (script-src 'self')
    const wsess = [...workers].find(([u]) => u === `http://127.0.0.1:${port}/shell/worker-boot.js`)?.[1];
    const probe = wsess && (await send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const seen = [], onViolation = (e) => seen.push(e.effectiveDirective);
      self.addEventListener("securitypolicyviolation", onViolation);
      const own = await fetch(location.origin + "/index.html", { cache: "no-store" }).then((r) => "fetched " + r.status, (e) => "refused");
      const other = await fetch("http://localhost:${port}/index.html", { mode: "no-cors", cache: "no-store" }).then((r) => "fetched", (e) => "refused");
      const mod = await import("http://localhost:${port}/shell/worker-boot.js").then(() => "imported", (e) => "refused");
      let worker;
      const blob = URL.createObjectURL(new Blob(["postMessage(1)"], { type: "text/javascript" }));
      try {
        const w = new Worker(blob);
        let timer;
        worker = await new Promise((r) => { w.onmessage = () => r("ran"); w.onerror = () => r("refused"); timer = setTimeout(() => r("no answer"), 5000); });
        clearTimeout(timer);
        w.terminate();
      } catch (e) { worker = "refused " + e.name; }
      URL.revokeObjectURL(blob);
      await new Promise((r) => setTimeout(r, 500));
      self.removeEventListener("securitypolicyviolation", onViolation);
      return { own, other, mod, worker, seen: seen.sort() };
    })()` }, wsess))?.result?.result?.value;
    check(!!probe && probe.own === "refused" && probe.other === "refused" && probe.mod === "refused" && /^refused/.test(probe.worker) &&
      probe.seen.filter((d) => d === "connect-src").length === 2 && probe.seen.includes("worker-src") && probe.seen.some((d) => /^script-src/.test(d)),
      `${as}: in the shell worker, a fetch of this origin and of another, a module from another origin, and a worker of its own, refused by its policy (connect-src, script-src, worker-src): ${wsess ? JSON.stringify(probe) : "no shell worker attached: " + JSON.stringify([...workers.keys()])}`);
    // The app self-test's own Terminal checks (web/notebook/selftest-terminal.js in sagebrush-selftest.js, as
    // selftest() runs them), here with the stubbed bridge as the page's: the module's logic on app/dist served
    // as the app serves it.  Information, not native evidence (the apps' self-tests and their logs are that).
    const tc = await evaluate(`import("./sagebrush-selftest.js").then((m) => m.terminalChecks((c, a) => window.__TAURI__.core.invoke(c, a)))`);
    // (Chromium: the engine fixed as chromium, the three requests' events matched one to one and nothing else
    // (astra's NC-R1-A1), and the differential, the grader's cross-check)
    check(Array.isArray(tc) && tc.length === 3 && tc.every(([, ok]) => ok) && /routes=tauri-internals-invoke:unavailable,tauri-core-invoke:ok,/.test(tc[1][2]) &&
      /^engine=chromium mode=all-events violations=3 events=ipc-scheme:1,ipc-localhost:1,own-origin:1 unmatched=0 differential=own-origin:refused,control:fetched-ok /.test(tc[2][2]),
      `${as}: the self-test's three Terminal checks pass, the page's route the stub's core.invoke: ${JSON.stringify(tc?.[1]).slice(0, 300)} ${JSON.stringify(tc?.[2]).slice(0, 600)}`);
    // (a dead worker: the checks pointed at a directory with no shell/; check 3 must FAIL, the worker never
    // reporting (a load error ends the wait early; else the whole-report bound, 30 s), never pass on silence)
    const dead = await evaluate(`import("./sagebrush-selftest.js").then((m) => m.terminalChecks((c, a) => window.__TAURI__.core.invoke(c, a), location.origin + "/no-such-dir/"))`);
    check(Array.isArray(dead) && dead[0][1] === false && dead[2][1] === false && /didn't report|worker error|boot failed/.test(dead[2][2]),
      `${as}: a dead worker (no shell/ there): check 3 FAILS, no report: ${JSON.stringify(dead?.[2] ?? dead).slice(0, 300)}`);
    // ---- Tab completion, help, compgen and ls colours (plan-term-help-tab r3.1 §5 E1-E7), in the isolated pass only.
    // Each check's text starts with its case id ("E2.u1: ..."): the control runs (K*) compare the failing ids.  Tab and
    // Shift-Tab are real key events (CDP Input), so the browser's own focus move happens when the panel leaves it.
    if (coi) {
      const T = `document.querySelector(".sb-term textarea")`;
      const key = async (k, shift = false) => {
        const ev = { key: k, code: k, windowsVirtualKeyCode: k === "Tab" ? 9 : 13, modifiers: shift ? 8 : 0 };
        await send("Input.dispatchKeyEvent", { type: "keyDown", ...ev });
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...ev });
      };
      const set = (v, caret = v.length, end = caret) => evaluate(`(() => { const ta = ${T}; ta.focus(); ta.value = ${JSON.stringify(v)}; ta.setSelectionRange(${caret}, ${end}); return true; })()`);
      const value = () => evaluate(`${T}?.value ?? null`);
      const focused = () => evaluate(`document.activeElement === ${T}`);
      const ncmds = () => evaluate(`document.querySelectorAll(".sb-term-cmd").length`);
      const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
      // (a value changed from `from`, or `from` after `ms`)
      const settle = async (from, ms = 3000) => { const t0 = Date.now(); let v; while ((v = await value()) === from && Date.now() - t0 < ms) await sleepMs(50); return v; };
      // (a command typed and run: its output's text, status, the command count after it)
      const run = async (cmd) => {
        await evaluate(`(() => { document.querySelector(".sb-term-status").textContent = ""; const ta = ${T}; ta.value = ${JSON.stringify(cmd)}; ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); })()`);
        await until(`!document.querySelector(".sb-term").classList.contains("running") && document.querySelector(".sb-term-status").textContent !== ""`, 60000);
        return evaluate(`(() => { const c = [...document.querySelectorAll(".sb-term-cmd")].at(-1); return { out: c.querySelector(".sb-term-out")?.textContent ?? "", status: document.querySelector(".sb-term-status").textContent, html: c.querySelector(".sb-term-out")?.innerHTML ?? "", n: document.querySelectorAll(".sb-term-cmd").length }; })()`);
      };
      // (the fixtures: a folder of their own; each file holds its own name)
      const NAMES = ["a;touch m", "$(touch m)x", `it's "q"`, "q$(touch m)", "r`touch m`"];
      const sq = (x) => "'" + x.replace(/'/g, "'\\''") + "'";
      await run("mkdir -p /e2e && cd /e2e");
      for (const nm of NAMES) await run(`printf %s ${sq(nm)} > ${sq(nm)}`);
      await run("printf n > notes.csv; mkdir -p sub; touch xy1 xy2");
      const noM = async () => (await run("test -e m && echo HAS-M || echo no-m")).out === "no-m\n";
      check((await noM()) && (await run("ls -1")).out.split("\n").filter(Boolean).length === NAMES.length + 4, `E0: the fixtures are in /e2e, and no m`);
      // E1 commands and paths
      await set("mkd"); await key("Tab"); const e1a = await settle("mkd");
      await set("cat no"); await key("Tab"); const e1b = await settle("cat no");
      await set("cd su"); await key("Tab"); const e1c = await settle("cd su");
      await set("cat xy"); await key("Tab"); const e1d = await settle("cat xy", 800); await key("Tab"); await sleepMs(800);
      const block = await evaluate(`document.querySelector(".sb-term-cands")?.textContent ?? null`);
      check(e1a === "mkdir " && e1b === "cat notes.csv " && e1c === "cd sub/" && e1d === "cat xy" && block === "xy1  xy2", `E1: mkd → ${JSON.stringify(e1a)}; cat no → ${JSON.stringify(e1b)}; cd su → ${JSON.stringify(e1c)}; cat xy → ${JSON.stringify(e1d)}, then the block ${JSON.stringify(block)}`);
      // E2 the literal insertion, then Enter: exactly that file, one command, no m
      const e2 = async (id, typed, want) => {
        // (no m from an earlier case: each case answers for itself)
        await run("rm -f m");
        await set(typed); await key("Tab");
        const v = await settle(typed);
        const before = await ncmds();
        const r = v !== typed ? await run(v) : null;
        const ok = !!r && r.out === want && r.status === "done" && r.n === before + 1 && (await noM());
        check(ok, `${id}: ${JSON.stringify(typed)}+Tab → ${JSON.stringify(v)}; Enter: ${JSON.stringify(r?.out)} ${r?.status} (${before} → ${r?.n} commands)`);
      };
      await e2("E2.u1", "cat a", "a;touch m");
      await e2("E2.u2", "cat it", `it's "q"`);
      await e2("E2.u3", "cat \\$", "$(touch m)x");
      await e2("E2.s1", "cat 'a", "a;touch m");
      await e2("E2.s2", "cat 'it", `it's "q"`);
      await e2("E2.s3", "cat '$", "$(touch m)x");
      await e2("E2.d1", `cat "a`, "a;touch m");
      await e2("E2.d2", `cat "it`, `it's "q"`);
      await e2("E2.d3", `cat "\\$`, "$(touch m)x");
      await e2("E2.d4", `cat "q`, "q$(touch m)");
      await e2("E2.d5", `cat "r`, "r`touch m`");
      await set("cat $"); const e2xf = await focused(); await key("Tab"); await sleepMs(500);
      check(e2xf && (await value()) === "cat $" && !(await focused()), `E2.x: cat $+Tab declined: unchanged (${JSON.stringify(await value())}) and focus moved`);
      // E3 Tab never executes
      const n3 = await ncmds();
      await set("echo hi"); await key("Tab"); await sleepMs(800);
      const v3 = await value(), n3b = await ncmds();
      await evaluate(`${T}.value = ""; ${T}.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }))`);
      const up = await value();
      check(v3 === "echo hi" && n3b === n3 && up !== "echo hi", `E3: echo hi+Tab: input ${JSON.stringify(v3)}, commands ${n3} → ${n3b}, history's last ${JSON.stringify(up)}`);
      // E4 no keyboard trap
      const leaves = async (setup) => { await setup(); await key("Tab"); await sleepMs(300); return !(await focused()); };
      const e4 = {
        empty: await leaves(() => set("")),
        mid: await leaves(() => set("cat no", 5)),
        sel: await leaves(() => set("cat no", 4, 6)),
        shift: await (async () => { await set("cat no"); await key("Tab", true); await sleepMs(300); return !(await focused()); })(),
        end: await (async () => { await set("cat no"); await key("Tab"); await settle("cat no"); return await focused(); })(),
      };
      // (a command that runs until Stop: the shell has no sleep)
      await evaluate(`(() => { const ta = ${T}; ta.value = "while :; do :; done"; ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); })()`);
      await until(`document.querySelector(".sb-term").classList.contains("running")`, 30000);
      e4.running = await leaves(() => set("cat no"));
      await evaluate(`document.querySelector(".sb-term-stop").click()`);
      await until(`!document.querySelector(".sb-term").classList.contains("running")`, 30000);
      check(e4.empty, `E4.empty: empty input + Tab: focus leaves`);
      check(e4.mid, `E4.mid: caret mid-word + Tab: focus leaves`);
      check(e4.sel, `E4.sel: a selection + Tab: focus leaves`);
      check(e4.running, `E4.running: a command running + Tab: focus leaves`);
      check(e4.shift, `E4.shift: Shift-Tab: focus leaves`);
      check(e4.end, `E4.end: at a word's end + Tab: focus stays (it completes)`);
      // E5 a late listing inserts nothing
      await evaluate(`window.__sbTermTabDelayMs = 400`);
      const req0 = Number(await evaluate(`document.querySelector(".sb-term").dataset.tabRequests ?? 0`));
      await set("cat no"); await key("Tab"); await sleepMs(50);
      await send("Input.insertText", { text: "x" });
      await sleepMs(900);
      const e5a = await value(), req1 = Number(await evaluate(`document.querySelector(".sb-term").dataset.tabRequests ?? 0`));
      check(e5a === "cat nox" && req1 === req0 + 1, `E5.a: more typing during a slow listing: ${JSON.stringify(e5a)}, ${req1 - req0} request`);
      await set("cat no"); await key("Tab"); await sleepMs(50);
      await run("cd sub");
      await sleepMs(900);
      check((await value()) === "" && !(await evaluate(`document.querySelector(".sb-term-cands")`)), `E5.b: a cd during a slow listing: nothing inserted (${JSON.stringify(await value())})`);
      await run("cd /e2e");
      // E6 colours
      const c6 = await run("ls");
      const c6l = await run("ls -l"), c6p = await run("ls | cat"), c6r = await run("ls > out.txt; cat out.txt");
      const coloured = (h) => /class="[^"]*sb-fg-/.test(h);
      check(/<span class="[^"]*sb-fg-4[^"]*">sub<\/span>/.test(c6.html) && !/<span class="[^"]*sb-fg-[^"]*">notes\.csv/.test(c6.html), `E6.ls: ls colours the folder sub, not a data file (${c6.html.slice(0, 300)})`);
      check(!coloured(c6l.html) && !coloured(c6p.html) && !coloured(c6r.html), `E6.plain: ls -l, ls | cat, ls > f: no colour (${[c6l, c6p, c6r].map((x) => x.html.slice(0, 80)).join(" | ")})`);
      await evaluate(`window.__sbTermTabDelayMs = 0`);
      // E7 help and compgen
      const h = await run("help"), hls = await run("help ls"), hno = await run("help nosuch"), cg = await run("compgen -c ca"), cz = await run("compgen -c zz"), cp = await run("echo x | compgen -c");
      check(/\bopen\b/.test(h.out) && /\bls\b/.test(h.out) && /\bcd\b/.test(h.out) && h.status === "done", `E7.help: help lists open, ls, cd (${h.status})`);
      check(/^ls - list directory contents/.test(hls.out), `E7.name: help ls shows ls's usage (${JSON.stringify(hls.out.slice(0, 60))})`);
      check(hno.status === "exit 1", `E7.none: help nosuch: exit 1 (${hno.status})`);
      check(cg.out === "caller\ncat\n" && cz.status === "exit 1" && cp.out === "", `E7.compgen: compgen -c ca ${JSON.stringify(cg.out)}; zz ${cz.status}; in a pipe bash's ${JSON.stringify(cp.out)}`);
      // E5.c last: the panel ended while a slow listing is in flight: nothing inserted anywhere, no block
      await evaluate(`window.__sbTermTabDelayMs = 400`);
      await set("cat no"); await key("Tab"); await sleepMs(50);
      await evaluate(`document.querySelector(".sb-term-end").click()`);
      await sleepMs(900);
      check(!(await evaluate(`document.querySelector(".sb-term-cands") || document.querySelector(".sb-term")`)), `E5.c: the session ended during a slow listing: nothing left`);
      await evaluate(`window.__sbTermTabDelayMs = 0`);
    }
  }
  ws.close();
} finally {
  // (its whole process group: the renderer and GPU processes too, not only the main one)
  try { if (chrome?.pid) process.kill(-chrome.pid, "SIGKILL"); } catch {}
  for (const s of servers) s.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
if (fails.length) {
  console.log(`test-panel-app: ${fails.length} of ${checks} FAILED`);
  process.exit(1);
}
console.log(`test-panel-app: all ${checks} checks pass`);
