// The LaTeX comments' agent loop end to end (plan latex-comments r4.2 §9, design COMMENTS-IMPL-DB3-5): the LaTeX
// editor's page (web/dist built with SAGEBRUSH_LATEX_PREVIEW=test, served by web/serve.py with the site's headers, its
// CSP included) paired with the REAL pairing server (engine/py/python/sagebrush/pairing.py, as sagebrush-mcp runs it),
// and the latex_comments_* tools (sagebrush/latex_comments_tools.py) called over it as an agent calls them:
//   - a person comments in the editor; the page offers Agent; a ?pair= link connects; the person allows the paper's
//     folder (the agent chunk is fetched only then);
//   - the agent lists the comments, shows the thread whole, edits the .tex (workspace.read, workspace.write with base)
//     so the commented text occurs twice, lists again (ambiguous, both candidates), re-attaches it to the second,
//     replies and resolves;
//   - a .tex outside the granted folder can't be read through the tools;
//   - the person opens the document again and sees the thread resolved, the agent's reply labelled "agent";
//   - Revoke: the tools get nothing.
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && CHROME=google-chrome node web/latex/test-latex-agent-e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0, checks = 0;
const ok = (c, msg, detail) => { checks++; console.log((c ? "ok   " : "FAIL ") + msg + (c || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400))); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the site, as web/serve.py serves it (the site's headers: COOP/COEP and the CSP)
const server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const sport = await new Promise((res, rej) => { let acc = ""; server.stdout.on("data", (b) => { acc += b; const m = /(\d{2,5})/.exec(acc); if (m) res(+m[1]); }); setTimeout(() => rej(new Error("no server port")), 15000); });
const origin = `http://127.0.0.1:${sport}`;

// ---- the real pairing server and the tools, driven over stdin/stdout (one JSON line each way)
const DRIVER = `
import importlib.util, json, os, sys, types
src = os.environ["SB_SRC"]
pkg = types.ModuleType("sagebrush"); pkg.__path__ = [src]; sys.modules["sagebrush"] = pkg
for name in ("workspace_tools", "pairing", "latex_comments", "latex_comments_tools"):
    spec = importlib.util.spec_from_file_location("sagebrush." + name, os.path.join(src, name + ".py"))
    mod = importlib.util.module_from_spec(spec); sys.modules["sagebrush." + name] = mod; spec.loader.exec_module(mod); setattr(pkg, name, mod)
from sagebrush import pairing as P, latex_comments_tools as LT
from sagebrush.workspace_tools import PageError, NotConnected
p = P.Pairing({"name": "Claude Code", "client": "claude-code", "version": "0"})
port, code = p.start()
print(json.dumps({"port": port, "code": code}), flush=True)
for line in sys.stdin:
    m = json.loads(line)
    try:
        if m["op"] == "tool":
            content, structured, is_error = LT.call(p, m["name"], m["args"], timeout=10)
            print(json.dumps({"structured": structured, "is_error": is_error}), flush=True)
        elif m["op"] == "req":
            print(json.dumps({"ok": p.request(m["method"], m["params"], timeout=10)}), flush=True)
        elif m["op"] == "status":
            s = p.status(); print(json.dumps({"ok": {"paired": s.get("paired"), "granted": s.get("granted")}}), flush=True)
    except NotConnected as e:
        print(json.dumps({"notconnected": str(e)}), flush=True)
    except PageError as e:
        print(json.dumps({"err": {"code": e.code, "message": str(e)}}), flush=True)
    except Exception as e:
        print(json.dumps({"err": {"code": type(e).__name__, "message": str(e)}}), flush=True)
`;
const py = spawn("python3", ["-s", "-c", DRIVER], { env: { ...process.env, SB_SRC: join(here, "../../engine/py/python/sagebrush"), SAGEBRUSH_MCP_DEV_ORIGIN: origin }, stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: py.stdout });
const waiters = [];
lines.on("line", (l) => waiters.shift()?.(JSON.parse(l)));
const next = () => new Promise((r) => waiters.push(r));
const drive = (m) => { const r = next(); py.stdin.write(JSON.stringify(m) + "\n"); return r; };
py.on("exit", (c) => { for (const w of waiters.splice(0)) w({ exited: c }); });
const first = await Promise.race([next(), sleep(15000).then(() => ({ exited: "no code in 15 s" }))]);
if (!first.port) { console.log("FAIL the pairing server didn't start: " + JSON.stringify(first)); try { py.kill(); } catch {} server.kill(); process.exit(1); }
const tool = (name, args) => drive({ op: "tool", name, args });

// ---- Chromium
let cdp = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-latex-agent-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdp}`, "--window-size=1400,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
try {
  if (!cdp) cdp = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
  const sock = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const waiting = new Map(), requests = [], console_ = [];
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
    if (m.method === "Log.entryAdded" || m.method === "Runtime.consoleAPICalled") console_.push(JSON.stringify(m.params).slice(0, 300));
    if (m.method === "Fetch.requestPaused") send(failChunk ? "Fetch.failRequest" : "Fetch.continueRequest", failChunk ? { requestId: m.params.requestId, errorReason: "InternetDisconnected" } : { requestId: m.params.requestId });
  };
  let failChunk = false;
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); sock.send(JSON.stringify({ id, method, params })); });
  // (a reply without a result, a page gone mid-navigation, is a failed evaluation, retried by until)
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (!r.result || r.result.exceptionDetails) throw new Error(JSON.stringify(r.result?.exceptionDetails ?? r.error ?? r).slice(0, 400)); return r.result.result?.value; };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  const go = async (q) => { await ev("window.__old = 1").catch(() => {}); await send("Page.navigate", { url: origin + "/" + q }); await sleep(300); return until("!window.__old && !!window.sagebrush?.workspace", 60000); };
  for (const m of ["Page.enable", "Runtime.enable", "Network.enable", "Log.enable"]) await send(m);
  const W = "window.sagebrush.workspace";
  const J = JSON.stringify;

  // the person's paper, and another .tex outside the folder they will grant
  ok(await go("?latex=1"), "the site opens, the LaTeX editor on");
  const TEX = "\\documentclass{article}\n\\begin{document}\nThe first claim is obvious from the definitions.\n\nA last paragraph.\n\\end{document}\n";
  const fid = await ev(`(async () => { await ${W}.mkdir("/papers"); await ${W}.mkdir("/other"); await ${W}.create("/other/x.tex", { content: new TextEncoder().encode("\\\\documentclass{article}\\n") }); return (await ${W}.create("/papers/paper.tex", { content: new TextEncoder().encode(${J(TEX)}) })).fid; })()`);
  ok(typeof fid === "string", "the paper is made");
  // the person comments in the editor (Ctrl/Cmd+Alt+M on a source selection)
  ok(await go(`?tex=${encodeURIComponent(fid)}&latex=1`) && await until(`document.querySelector(".tex-preview")?.textContent.includes("first claim")`), "the paper opens in the editor");
  ok(await ev(`!!document.querySelector(".tex-agent")`), "the editor offers Agent");
  ok(!requests.some((u) => /sagebrush-latex-agent/.test(u)), "the agent chunk isn't fetched before it's wanted");
  await ev(`(() => { const t = document.querySelector(".tex-src"), i = t.value.indexOf("is obvious"); t.focus(); t.setSelectionRange(i, i + "is obvious".length); return true; })()`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "m", code: "KeyM", modifiers: 3, windowsVirtualKeyCode: 77 });
  ok(await until(`!!document.querySelector(".sb-cm-compose textarea")`), "the composer opens");
  await ev(`(() => { document.querySelector(".sb-cm-compose textarea").value = "Why is this obvious? Give the argument."; document.querySelector(".sb-cm-compose .sb-cm-send").click(); return true; })()`);
  ok(await until(`${W}.stat("/papers/paper.tex.comments.json").then((e) => !!e)`), "the comment is saved beside the paper");

  // the agent: before it's connected, the tools say so
  const nc = await tool("latex_comments_list", { path: "/papers/paper.tex" });
  ok(nc.is_error && nc.structured.error.code === "not_connected", "before pairing, the tools say no page is connected", nc);
  // the agent chunk's fetch failing (the network down): said, and the next try fetches it again; on the Agent button,
  // then on a ?pair= link (its code unused: nothing connected)
  const failedSaid = `/Couldn't load the agent connection/.test(document.querySelector(".tex-status")?.textContent ?? "")`;
  await send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-latex-agent.js*" }] });
  failChunk = true;
  await ev(`document.querySelector(".tex-agent").click()`);
  ok(await until(failedSaid) && !(await ev(`!!document.querySelector(".sbag-box")`)), "the agent chunk's fetch failing: the page says so");
  failChunk = false;
  await ev(`document.querySelector(".tex-agent").click()`);
  ok(await until(`!!document.querySelector(".sbag-box")`), "the next click fetches it again, and Connect opens", requests.filter((u) => /sagebrush-latex-agent/.test(u)));
  failChunk = true;
  ok(await go(`?tex=${encodeURIComponent(fid)}&latex=1&pair=${first.code}&port=${first.port}`) && await until(failedSaid), "a ?pair= link whose chunk fails: said too");
  failChunk = false;
  await send("Fetch.disable");
  // a ?pair= link: Connect, then the grant (the paper's folder, may change files, until the page closes)
  ok(await go(`?tex=${encodeURIComponent(fid)}&latex=1&pair=${first.code}&port=${first.port}`), "the ?pair= link opens the editor");
  ok(await until(`!!document.querySelector(".sbag-box button.primary")`), "the Connect dialog shows", console_.slice(-5));
  ok(requests.some((u) => /sagebrush-latex-agent\.js/.test(u)), "the agent chunk is fetched for it");
  await ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
  const paired = await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`);
  ok(paired, "paired: the grant dialog asks the person (the site's CSP admits the loopback socket)", { console: console_.filter((l) => /WebSocket|Security|refused|ws:\/\/|connect-src|Private|loopback/i.test(l)).slice(-6), err: await ev(`document.querySelector(".sbag-box .err")?.textContent ?? ""`).catch(() => "") });
  await ev(`(() => { document.querySelector('.sbag-box input[value="/papers"]').click(); const s = document.querySelector(".sbag-box select"); s.value = "page"; s.dispatchEvent(new Event("change")); return true; })()`);
  await ev(`([...document.querySelectorAll(".sbag-box button.primary")].pop().click(), true)`);
  ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed: the bar shows the agent");

  // the agent's work (COMMENTS-IMPL-DB3-5): list, show, edit the .tex, list (ambiguous), reattach, reply, resolve
  const L1 = await tool("latex_comments_list", { path: "/papers/paper.tex" });
  const t1 = L1.structured.result?.threads?.[0];
  ok(!L1.is_error && L1.structured.result.threads.length === 1 && t1.status === "exact" && t1.quote === "is obvious" && t1.first.author === "person:me", "the agent lists the person's comment", L1.structured);
  const S1 = await tool("latex_comments_show", { path: "/papers/paper.tex", thread: t1.id });
  ok(!S1.is_error && S1.structured.result.messages.length === 1 && S1.structured.result.messages[0].text === "Why is this obvious? Give the argument.", "and shows the thread whole", S1.structured);
  const rd = await drive({ op: "req", method: "workspace.read", params: { path: "/papers/paper.tex" } });
  const cur = rd.ok?.content?.text ?? new TextDecoder().decode(Uint8Array.from(atob(rd.ok?.content?.base64 ?? ""), (c) => c.charCodeAt(0)));
  const TEX2 = cur.replace("The first claim is obvious from the definitions.", "The first claim is obvious from the definitions. The first claim is obvious from the definitions.");
  const wr = await drive({ op: "req", method: "workspace.write", params: { path: "/papers/paper.tex", content: { text: TEX2 }, base: rd.ok?.rev } });
  ok(!!wr.ok, "the agent edits the .tex with an ordinary write (its base)", wr);
  const L2 = await tool("latex_comments_list", { path: "/papers/paper.tex" });
  const t2 = L2.structured.result?.threads?.[0];
  ok(t2?.status === "ambiguous" && t2.candidates?.length === 2, "after the edit, the thread is ambiguous, with both places", L2.structured);
  const RA = await tool("latex_comments_reattach", { path: "/papers/paper.tex", thread: t1.id, occurrence: 2 });
  ok(!RA.is_error && RA.structured.result.status === "exact" && RA.structured.result.offsets.start === TEX2.lastIndexOf("is obvious"), "the agent re-attaches it to the second place", RA.structured);
  const RP = await tool("latex_comments_reply", { path: "/papers/paper.tex", thread: t1.id, text: "The sentence was doubled by my edit; the comment is on the second copy now." });
  ok(!RP.is_error && RP.structured.result.messages.at(-1).author === "agent:Claude-Code", "the agent replies, credited to agent:Claude-Code", RP.structured);
  const RS = await tool("latex_comments_resolve", { path: "/papers/paper.tex", thread: t1.id });
  ok(!RS.is_error && RS.structured.result.resolved === true, "and resolves it", RS.structured);
  // outside the grant: the page refuses the read
  const OUT = await tool("latex_comments_list", { path: "/other/x.tex" });
  ok(OUT.is_error && OUT.structured.error.code === "invalid", "a .tex outside the granted folder: refused", OUT.structured);
  ok(await ev(`${W}.stat("/other/x.tex.comments.json").then((e) => !e)`), "and nothing is made there");

  // the person opens the paper again: the thread resolved, the reply labelled agent
  ok(await go(`?tex=${encodeURIComponent(fid)}&latex=1`) && await until(`/Comments/.test(document.querySelector(".tex-comments")?.textContent ?? "")`), "the person opens the paper again");
  await until(`document.querySelector(".tex-src")?.value.includes("definitions. The first claim")`);
  await ev(`(document.querySelector(".tex-comments").click(), true)`);
  ok(await until(`[...document.querySelectorAll(".sb-cm-list h3")].some((h) => /^Resolved/.test(h.textContent))`), "the list shows it under Resolved");
  const seen = await ev(`(() => { const it = document.querySelector(".sb-cm-list .sb-cm-item"); return { text: it?.textContent ?? "", agent: !!it?.querySelector(".sb-cm-agent") }; })()`);
  ok(seen.agent && seen.text.includes("doubled by my edit"), "with the agent's reply, labelled agent", seen);

  // Revoke: the tools get nothing
  ok(await go(`?tex=${encodeURIComponent(fid)}&latex=1`), "the page again");
  const st = await drive({ op: "status" });
  ok(st.ok?.paired === false || st.ok?.granted === false, "a grant 'until the page closes' ended with the page", st);
  const after = await tool("latex_comments_list", { path: "/papers/paper.tex" });
  ok(after.is_error && /not_connected|closed|revoked/.test(after.structured.error.code + " " + after.structured.error.message), "after it, the tools get nothing", after.structured);
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  try { py.kill(); } catch {}
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `FAIL: ${failures} of ${checks}` : `ok: the LaTeX comments' agent loop, ${checks} checks`);
process.exit(failures ? 1 : 0);
