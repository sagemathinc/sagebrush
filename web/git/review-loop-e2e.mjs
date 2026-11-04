// git-proto: pair once on /board/, then move between pages; the agent's calls must keep working on each page.
// Real sagebrush-mcp (web/git/mcp.py over stdio) + headless Chromium over CDP.  node review-loop-e2e.mjs <port>
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
console.log("start"); await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
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
  await check("on /git/", "workspace_list", { folder: "/" });
  await check("create /a.tex", "workspace_create", { path: "/a.tex", content: { text: "A one.\n" } });
  await check("create /b.md", "workspace_create", { path: "/b.md", content: { text: "B one.\n" } });
  console.log("main commit", await ev(`(async () => { const { ws, R } = window.__sbGit; return await R.commit("main", await R.snapshot(ws, "/"), "start", { name: "you" }); })()`));
  await check("git_branch", "workspace_git_branch", { name: "two" });
  await check("edit a", "workspace_write", { path: "/Branches/two/a.tex", base: 0, content: { text: "A two.\n" } });
  await check("edit b", "workspace_write", { path: "/Branches/two/b.md", base: 0, content: { text: "B two.\n" } });
  await check("commit review", "workspace_git_commit", { name: "two", message: "Both files, version two", review: true });
  const waiting = tool("workspace_git_wait", { name: "two", seconds: 30 });
  await sleep(2000);
  await ev(`window.__sbGit.select("two")`); await sleep(1500);
  console.log("ui", await ev(`(async () => { const secs = [...document.querySelectorAll("#one section, #one .change, #one h3")]; const picks = [...document.querySelectorAll("#one .pick")]; const pb = picks.find((p) => p.parentElement?.textContent.includes("/b.md") || p.closest("section")?.textContent.includes("/b.md")); if (!pb) return "no pick for b: " + picks.length; pb.querySelector("input[type=checkbox]").click(); const why = pb.querySelector(".why"); why.value = "keep the old wording"; const acc = [...document.querySelectorAll("#one button")].find((b) => b.textContent === "Accept"); acc.click(); await new Promise((r) => setTimeout(r, 2500)); return document.querySelector("#one .done-note")?.textContent || "no note"; })()`));
  const w = await waiting; results.push({ label: "git_wait returned the decision", ...w }); console.log(w.ok ? "PASS" : "FAIL", "git_wait", w.ms + " ms", w.out);
  const st = await rpc("tools/call", { name: "workspace_git_status", arguments: { name: "two" } });
  const S = st.result?.structuredContent?.result; console.log("status", JSON.stringify({ status: S?.status, files: S?.files, next: S?.next?.slice(0, 80) }));
  results.push({ label: "partly-accepted with per-file reason", ok: S?.status === "partly-accepted" && S?.files?.["/b.md"]?.reason === "keep the old wording" && S?.files?.["/a.tex"]?.decision === "accepted", out: "" });
  const ra = await rpc("tools/call", { name: "workspace_read", arguments: { path: "/a.tex" } }); const rb = await rpc("tools/call", { name: "workspace_read", arguments: { path: "/b.md" } });
  const ta = ra.result?.structuredContent?.result?.content?.text, tb = rb.result?.structuredContent?.result?.content?.text;
  results.push({ label: "main has a two, b one", ok: ta === "A two.\n" && tb === "B one.\n", out: JSON.stringify([ta, tb]) });
  const rr = await rpc("tools/call", { name: "workspace_read", arguments: { path: "/Branches/two/b.md" } });
  await check("rework b on the same branch", "workspace_write", { path: "/Branches/two/b.md", base: rr.result?.structuredContent?.result?.rev, content: { text: "B one, plus a line.\n" } });
  const c2 = await rpc("tools/call", { name: "workspace_git_commit", arguments: { name: "two", message: "b: keep the old wording, add a line", review: true } });
  const C2 = c2.result?.structuredContent?.result; console.log("commit2", JSON.stringify(C2?.changes));
  results.push({ label: "second review shows only b", ok: JSON.stringify(C2?.changes) === JSON.stringify([{ path: "/b.md", kind: "changed" }]), out: JSON.stringify(C2?.changes) });
  for (const r of results.slice(-4)) console.log(r.ok ? "PASS" : "FAIL", r.label, r.out || "");
} catch (e) { console.log("ERROR", e?.stack || e); } finally {
  console.log("SUMMARY", results.filter((r) => r.ok).length, "of", results.length, "passed");
  console.log("mcp stderr:", mcpErr.split("\n").filter((l) => l && !/pairing code/.test(l)).slice(-8).join("\n"));
  cleanup(); process.exit(0);
}
