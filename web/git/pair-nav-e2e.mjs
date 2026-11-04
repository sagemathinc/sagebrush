// git-proto: pair once on /board/, then move between pages; the agent's calls must keep working on each page.
// Real sagebrush-mcp (web/git/mcp.py over stdio) + headless Chromium over CDP.  node pair-nav-e2e.mjs <port>
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const port = Number(process.argv[2] || 8766);
const origin = `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
const cleanup = () => { for (const k of kids) { try { process.kill(-k.pid, "SIGTERM"); } catch {} } };
process.on("exit", cleanup);

const srv = spawn("python3", ["web/serve.py", String(port)], { cwd: "/scratch/ux/git", stdio: "ignore", detached: true }); kids.push(srv);
const mcp = spawn("/tmp/sbmcp-venv/bin/python", ["/scratch/ux/git/web/git/mcp.py"], { env: { ...process.env, SAGEBRUSH_MCP_DEV_ORIGIN: origin }, stdio: ["pipe", "pipe", "pipe"], detached: true }); kids.push(mcp);
let mcpErr = ""; mcp.stderr.on("data", (d) => (mcpErr += d));
const waiting = new Map(); let mid = 0;
createInterface({ input: mcp.stdout }).on("line", (l) => { try { const m = JSON.parse(l); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch {} });
const rpc = (method, params) => new Promise((r) => { const i = ++mid; waiting.set(i, r); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
const tool = async (name, args = {}) => { const t0 = Date.now(); const r = await rpc("tools/call", { name, arguments: args }); const sc = r.result?.structuredContent; return { ms: Date.now() - t0, ok: !r.result?.isError, out: JSON.stringify(sc?.result ?? sc?.error ?? r.result?.content?.[0]?.text ?? r.error).slice(0, 160) }; };
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const ch = spawn("chromium", ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9334", `--user-data-dir=/tmp/pairnav-${process.pid}`, "about:blank"], { stdio: "ignore", detached: true }); kids.push(ch);
for (let i = 0; i < 50; i++) { await sleep(200); try { await fetch("http://127.0.0.1:9334/json/version"); break; } catch {} }
const tabs = await (await fetch("http://127.0.0.1:9334/json")).json();
const cdp = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (cdp.onopen = r));
let id = 0; const pend = new Map();
cdp.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); cdp.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const go = async (url) => { await send("Page.navigate", { url }); await sleep(3500); };
const results = [];
const check = async (label, name = "workspace_list", args = { folder: "/" }) => { const r = await tool(name, args); results.push({ label, ...r }); console.log(r.ok ? "PASS" : "FAIL", label, `${r.ms} ms`, r.out); };
try {
  await send("Page.enable"); await send("Runtime.enable");
  cdp.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.method === "Runtime.consoleAPICalled" && /error|warn/.test(d.params.type)) console.log("console", d.params.type, d.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 200)); if (d.method === "Runtime.exceptionThrown") console.log("exception", (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).slice(0, 200)); });
  const cr = await rpc("tools/call", { name: "workspace_connect", arguments: {} });
  const link = cr.result?.structuredContent?.result?.link;
  console.log("link ok", !!link);
  await go(link);
  console.log("connect click", await ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /^Connect$/.test(x.textContent.trim()) && x.offsetParent); if (b) { b.click(); return "clicked"; } return "none"; })()`));
  await sleep(2000);
  console.log("allow", await ev(`(() => { const d = [...document.querySelectorAll(".sbag-dlg")].find((x) => /Allow this agent/.test(x.textContent)); if (!d) return "no dialog"; const all = d.querySelector(".folders input[type=checkbox]"); if (all && !all.checked) all.click(); const rem = [...d.querySelectorAll("label")].find((l) => /emember/.test(l.textContent))?.querySelector("input"); const b = [...d.querySelectorAll("button")].find((x) => x.textContent.trim() === "Allow"); b.click(); return "allowed, remember=" + (rem ? rem.checked : "?"); })()`));
  await sleep(1500);
  await check("1 board (just paired)");
  await go(`${origin}/git/`);
  await check("2 moved to /git/");
  await check("2b git_status on /git/", "workspace_git_status", {});
  await check("2c create /t.tex from /git/", "workspace_create", { path: "/t.tex", content: { text: "\\documentclass{article}\\begin{document}Hi $x^2$.\\end{document}\n" } });
  const st = await ev(`(async () => JSON.stringify(await window.__sbGit.ws.stat("/t.tex")))()`);
  console.log("stat", String(st).slice(0, 200));
  const fid = JSON.parse(st || "{}").fid ?? JSON.parse(st || "{}").id;
  await go(`${origin}/?tex=${fid}`);
  for (let i = 0; i < 20; i++) { const d = await ev(`JSON.stringify({ agentBtn: !!document.querySelector(".tex-agent"), bar: !!document.querySelector(".sbag-bar"), url: location.href.slice(-40) })`); if (i % 4 === 0 || d.includes('"bar":true')) console.log("latex wait", i, d); if (d.includes('"bar":true')) break; await sleep(1000); }
  { const r = await send("Page.captureScreenshot", { format: "png" }); (await import("node:fs")).writeFileSync("/scratch/ux/pairnav-latex.png", Buffer.from(r.result.data, "base64")); }
  console.log("latex dbg", await ev(`(async () => { const st = document.querySelector(".tex-status, [class*=status]")?.textContent; const bar = !!document.querySelector(".sbag-bar"); let g = "?"; try { const W = (await import("/workspace-api-probe.js").catch(() => null)); } catch {} return JSON.stringify({ st: (st||"").slice(0,200), bar, scripts: [...document.scripts].map(s=>s.src).filter(Boolean).slice(0,6) }); })()`));
  await check("3 moved to the LaTeX editor (/latex/?tex=)");
  await check("3b read /t.tex in the editor", "workspace_read", { path: "/t.tex" });
  await go(`${origin}/board/`);
  await check("4 back to /board/");
  const h = await send("Page.getNavigationHistory");
  const back = h.result.entries[h.result.currentIndex - 1];
  await send("Page.navigateToHistoryEntry", { entryId: back.id }); await sleep(3500);
  await check("5 browser Back to " + new URL(back.url).pathname);
} catch (e) { console.log("ERROR", e?.stack || e); } finally {
  console.log("SUMMARY", results.filter((r) => r.ok).length, "of", results.length, "passed");
  console.log("mcp stderr:", mcpErr.split("\n").filter((l) => l && !/pairing code/.test(l)).slice(-8).join("\n"));
  cleanup(); process.exit(0);
}
