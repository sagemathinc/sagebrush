// ci: web-runner order=125 runner=bun chrome
// The isolated output renderer's harness (OUT-ISO plan r3, phase 1), local evidence only
// (astra, Nov 7: the hosted site's headers, URLs and cookie-free loading are separate gates):
// web/output-shell (the shell and its packaged srcdoc) and web/notebook/output-frames.js (the
// host side), in headless Chromium, on a page of their own:
//   - a render commits once per generation, a same-height replacement too, with the frame
//     sandboxed allow-scripts only;
//   - inside the frame: an opaque origin, no cookies, storage, parent DOM or network;
//   - a rogue renderer's messages (another generation, a duplicate, unknown fields, an
//     oversized message, a height flood) change nothing they shouldn't;
//   - a renderer that never starts, or never commits, ends in its deadline with text, never
//     inline content; a dispose before ready leaves nothing;
//   - EVICT-LAYOUT-1 under a small cap: never more live frames than the cap, placeholders
//     keep their heights, scrolling back replays, the anchor stays within a pixel;
//   - the hosted variant, genuinely cross-site (the page on localhost, the shell on 127.0.0.1,
//     daybreak3's ruling): served with web/output-shell/build.mts's own headers, no redirect, no
//     cookie sent or readable, refused under an ancestor it doesn't list; and every
//     environment's shell URL still empty (web/output-shell/sites.mts);
//   - 50 and 200 areas, scrolled under the cap and dense with none: the figures that freeze the
//     cap (printed, not asserted).
//   CHROME=google-chrome bun web/test-output-frames.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
import { buildOutputShell, hostedShellFiles } from "./output-shell/build.mts";
import { SITES, checkSites } from "./output-shell/sites.mts";
import { pagePolicy } from "./csp-policy.mts";
import { scriptHashes } from "./csp.ts";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-outiso-"));
const shell = await buildOutputShell(Bun.build.bind(Bun), join(here, "output-shell", "shell.js"));
// (rogue renderers, test-only pages without the shell's policy: each says ready, then misbehaves)
const rogue = (body) => `<!doctype html><body><script>
addEventListener("message", (e) => { const port = e.ports[0]; port.onmessage = (m) => { const r = JSON.parse(m.data); if (r.type === "render") (${body})(port, r); }; port.postMessage(JSON.stringify({ v: 1, type: "ready" })); }, { once: true });
</script></body>`;
const ROGUES = {
  // (wrong generation, wrong area, wrong ids, unknown field, oversized, then a height flood, then the right commit)
  liar: rogue(`(port, r) => {
    const c = (o) => port.postMessage(JSON.stringify({ v: 1, type: "committed", generation: r.generation, area: r.area, ids: r.outputs.map((x) => x.id), height: 50, ...o }));
    c({ generation: r.generation + 7 }); c({ area: "other" }); c({ ids: ["nope"] }); c({ extra: 1 }); c({ height: Infinity }); c({ height: 1e9 });
    port.postMessage("x".repeat(4 * 1024 * 1024 + 10));
    for (let i = 0; i < 500; i++) port.postMessage(JSON.stringify({ v: 1, type: "height", generation: r.generation, height: 10 + i }));
    setTimeout(() => { c({ height: 77 }); c({ height: 88 }); }, 100);
  }`),
  silent: `<!doctype html><body></body>`,
  stuck: rogue(`() => {}`),
  // (commits 300 ms after the render: a message still to come when the set is disposed)
  late: rogue(`(port, r) => setTimeout(() => port.postMessage(JSON.stringify({ v: 1, type: "committed", generation: r.generation, area: r.area, ids: r.outputs.map((x) => x.id), height: 40 })), 300)`),
};
const host = await Bun.build({ entrypoints: [join(here, "notebook", "output-frames.js")], target: "browser", format: "esm", define: { __SB_OUTPUT_SHELL__: JSON.stringify(shell.srcdoc) } });
if (!host.success) throw new Error(host.logs.join("\n"));
writeFileSync(join(site, "of.js"), await host.outputs[0].text());
// (the pages the frames get, as data the page fetches: never inlined in its own script)
writeFileSync(join(site, "data.json"), JSON.stringify({ shell: shell.srcdoc, rogues: ROGUES }));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>output frames</title>
<style>#scroller{height:600px;overflow:auto;position:relative} .area{min-height:20px;margin-bottom:300px}</style>
<div id="top"></div><div id="scroller"></div>
<script type="module">
import { createOutputFrames, PACKAGED_SHELL } from "./of.js";
const data = await (await fetch("./data.json")).json();
window.SHELL = data.shell;
window.PACKAGED = PACKAGED_SHELL === data.shell;
window.ROGUES = data.rogues;
window.events = [];
window.make = (o = {}) => createOutputFrames({ ...(o.url ? { url: o.url } : { srcdoc: o.rogue ? ROGUES[o.rogue] : SHELL }), cap: o.cap ?? 24, root: o.root ?? null, loadMs: o.loadMs, commitMs: o.commitMs, onEvent: (e) => events.push({ ...e, t: performance.now() }) });
window.until = async (f, ms = 15000) => { const t = performance.now(); while (performance.now() - t < ms) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return null; };
window.box = (parent = document.getElementById("top")) => { const d = document.createElement("div"); d.className = "area"; parent.append(d); return d; };
document.cookie = "canary=host-cookie"; localStorage.setItem("canary", "host-storage");
window.ready = true;
</script>`);
// (the app's own page policy, as web/build.ts serves a page: a srcdoc frame inherits it, so the shell runs
// only where the page's policy lists the shell's script hash too)
const pageHtml = readFileSync(join(site, "index.html"), "utf8");
const appPolicy = { "/app.html": pagePolicy([...scriptHashes(pageHtml), shell.scriptHash]), "/app-nohash.html": pagePolicy(scriptHashes(pageHtml)) };
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (appPolicy[p]) return new Response(pageHtml, { headers: { "content-type": "text/html", "content-security-policy": appPolicy[p] } });
  if (p === "/secret") return new Response("host secret", { headers: { "access-control-allow-origin": "*" } });
  const files = { "/": ["index.html", "text/html"], "/of.js": ["of.js", "text/javascript"], "/data.json": ["data.json", "application/json"] };
  if (!files[p]) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, files[p][0])), { headers: { "content-type": files[p][1] } });
} });
// (the hosted shell's own site: 127.0.0.1, while the page is on localhost; "/" lists the page as
// its ancestor, "/other/" only a page that isn't this one; it records any cookie it is sent)
const shellSeen = { cookies: [], paths: [] };
const hosted = (ancestors) => {
  const f = hostedShellFiles(shell, ancestors);
  const headers = Object.fromEntries(f._headers.split("\n/index.html")[0].split("\n").slice(1).filter(Boolean).map((l) => l.trim().split(/: (.*)/s).slice(0, 2)));
  return { body: f["index.html"], headers: { ...headers, "content-type": "text/html; charset=utf-8" } };
};
let shellPages;
const shellSite = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  shellSeen.paths.push(p);
  if (req.headers.get("cookie")) shellSeen.cookies.push(req.headers.get("cookie"));
  const page = shellPages[p];
  return page ? new Response(page.body, { headers: page.headers }) : new Response("not found", { status: 404 });
} });
const appOrigin = `http://localhost:${server.port}`;
shellPages = { "/": hosted([appOrigin]), "/other/": hosted(["http://localhost:1"]) };
const shellUrl = `http://127.0.0.1:${shellSite.port}/`;
// (the dense measurement's page script: all areas asked for at once, none capped below the count)
const dense = (count) => `(async () => {
      const host = document.createElement("div"); host.style.cssText = "height:900px;overflow:auto"; document.body.prepend(host); scrollTo(0, 0);
      const from = events.length, t0 = performance.now();
      const M = make({ cap: ${count}, root: host });
      for (let i = 0; i < ${count}; i++) { const b = box(host); b.style.margin = "0"; const a = M.area("d${count}-" + i, b); a.show(); a.render([{ id: "o", kind: "html", body: "<p>row " + i + "</p><table><tr><td>a</td><td>b</td></tr></table>" }]); }
      const mine = () => events.slice(from).filter((e) => e.area.startsWith("d${count}-"));
      await until(() => mine().filter((e) => e.type === "committed" || e.type === "error").length >= ${count}, 30000);
      const at = (type) => mine().filter((e) => e.type === type).map((e) => e.t - t0).sort((x, y) => x - y);
      const q = (xs, f) => xs.length ? Math.round(xs[Math.min(xs.length - 1, Math.floor(f * xs.length))]) : -1;
      const ready = at("ready"), done = at("committed"), errors = mine().filter((e) => e.type === "error").map((e) => e.reason);
      window.KEEP = M; window.KEEPHOST = host;
      return { live: M.counts().live, ready: [q(ready, 0.5), q(ready, 0.95), q(ready, 1)], committed: [done.length, q(done, 0.5), q(done, 0.95), q(done, 1)], errors };
    })()`;
const denseLine = (count, fig) => `dense ${count}: ${fig.live} live; ready p50/p95/max ${fig.ready.join("/")} ms; committed ${fig.committed[0]} at p50/p95/max ${fig.committed.slice(1).join("/")} ms; ${fig.errors.length} timeouts ${JSON.stringify([...new Set(fig.errors)])}`;
// (Firefox and WebKit, through playwright: the dense figures only, for the cap's provenance; local, not CI)
//   BROWSER=firefox|webkit PLAYWRIGHT=<playwright's index.mjs> bun web/test-output-frames.mjs
const ENGINE = process.env.BROWSER ?? "chromium";
if (ENGINE !== "chromium") {
  const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
  const browser = await (pw[ENGINE] ?? pw.default[ENGINE]).launch();
  let bad = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(`${appOrigin}/`);
    await page.waitForFunction("window.ready === true");
    for (const count of [50, 200]) {
      const fig = await page.evaluate(dense(count));
      console.log(`(${ENGINE} ${denseLine(count, fig)})`);
      if (fig.committed[0] + fig.errors.length !== count) { bad++; console.log(`FAIL ${ENGINE} dense ${count}: a render didn't end exactly once`); }
      await page.evaluate("(KEEP.dispose(), KEEPHOST.remove(), 1)");
    }
  } finally {
    await browser.close();
    server.stop(true);
    shellSite.stop(true);
    rmSync(site, { recursive: true, force: true });
  }
  process.exit(bad ? 1 : 0);
}
// (the browser's own process tree's proportional memory, Linux: what the frames' processes cost; null elsewhere)
const treePss = (root) => {
  try {
    const kids = new Map();
    for (const d of readdirSync("/proc")) if (/^\d+$/.test(d)) { try { const pp = Number(readFileSync(`/proc/${d}/stat`, "utf8").split(") ")[1].split(" ")[1]); kids.set(pp, [...(kids.get(pp) ?? []), Number(d)]); } catch {} }
    let kb = 0; const todo = [root];
    while (todo.length) { const p = todo.pop(); todo.push(...(kids.get(p) ?? [])); try { kb += Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${p}/smaps_rollup`, "utf8"))?.[1] ?? 0); } catch {} }
    return kb * 1024;
  } catch { return null; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-outiso-p-"));
let port = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
let failures = 0, checks = 0;
const ok = (c, msg) => { checks++; console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
// ---- the per-environment config: no shell URL yet, and its checks refuse what they should
ok(Object.values(SITES).every((s) => s.shell === "") && checkSites().length === 0, "every environment's shell URL is empty, so each uses the packaged variant");
{
  const bad = (shell, extra = {}) => checkSites({ ...SITES, dev: { shell, ancestors: SITES.dev.ancestors }, ...extra }).length > 0;
  ok(bad("http://shell.example/") && bad("https://shell.example/x") && bad("https://shell.example/?a=1") && bad("https://render.cocalcusercontent.com/")
    && bad("https://out.sagebrush.space/") && bad("https://shell.example/", { prod: { shell: "https://shell.example/", ancestors: SITES.prod.ancestors } })
    && !bad("https://shell.example/"), "the config refuses http, a path not ending in /, a query, the app's or user content's site, and one shell for two environments");
}
try {
  if (!port) port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map(), contexts = new Map(), frames = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") console.log("(page exception: " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300) + ")");
    if (m.method === "Runtime.executionContextCreated" && m.params.context.auxData?.isDefault) contexts.set(m.sessionId ?? m.params.context.auxData.frameId, m.params.context.id);
    // (a sandboxed frame is its own process, site isolation: reached as an attached target)
    if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "iframe") {
      frames.push(m.params.sessionId);
      ws.send(JSON.stringify({ id: ++n, sessionId: m.params.sessionId, method: "Runtime.enable" }));
      ws.send(JSON.stringify({ id: ++n, sessionId: m.params.sessionId, method: "Runtime.runIfWaitingForDebugger" }));
    }
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const sendIn = (sessionId, method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, sessionId, method, params })); });
  const evIn = async (sessionId, expression) => { const r = await sendIn(sessionId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "threw"); return r.result?.value; };
  const ev = async (expression, contextId) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 600) ?? JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result?.value; };
  await send("Runtime.enable"); await send("Page.enable"); await send("Performance.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Network.enable");
  // (a cookie canary on the shell's site: it must never be sent to the shell or readable in it)
  await send("Network.setCookie", { name: "canary", value: "shell-site", url: shellUrl });
  await send("Page.navigate", { url: `${appOrigin}/` });
  for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);

  // ---- a render commits, once per generation; the frame is sandboxed allow-scripts only
  await ev(`(window.F = make(), window.A = F.area("a1", box(), { title: "Output of cell 1" }), A.show(), A.render([{ id: "o1", kind: "html", body: "<b>bold</b><table><tr><td>1</td><td>2</td></tr></table>" }]), 1)`);
  const c1 = await ev(`until(() => events.find((e) => e.area === "a1" && e.type === "committed" && e.generation === 1))`);
  ok(!!c1, "a render commits (generation 1)");
  const fr = await ev(`(() => { const f = document.querySelector("#top iframe"); return f && { sandbox: f.getAttribute("sandbox"), title: f.title, h: f.style.height, state: A.state }; })()`);
  ok(fr?.sandbox === "allow-scripts" && fr.title === "Output of cell 1", "the frame is sandbox=\"allow-scripts\" only, titled: " + JSON.stringify(fr));
  ok(fr?.state.height > 0 && fr.h === `${fr.state.height}px`, "its height is the committed one: " + fr?.h);
  await ev(`(A.render([{ id: "o1", kind: "html", body: "<b>bold</b><table><tr><td>1</td><td>2</td></tr></table>" }]), 1)`);
  const c2 = await ev(`until(() => events.find((e) => e.area === "a1" && e.type === "committed" && e.generation === 2))`);
  ok(!!c2 && (await ev(`events.filter((e) => e.area === "a1" && (e.type === "committed" || e.type === "error")).length`)) === 2, "a same-height replacement commits afresh, and each generation ends exactly once");

  // ---- inside the frame: opaque, no cookies, storage, parent or network
  await ev(`until(() => true)`); await sleep(300);
  const fsess = frames[0];
  ok(!!fsess, "the frame's own script context is reachable for the canaries (an out-of-process frame: " + frames.length + ")");
  if (fsess) {
    const probe = await evIn(fsess, `(async () => {
      const r = { origin: self.origin };
      try { r.cookie = document.cookie; } catch (e) { r.cookie = "threw " + e.name; }
      try { r.storage = localStorage.getItem("canary"); } catch (e) { r.storage = "threw " + e.name; }
      try { r.parent = parent.document.title; } catch (e) { r.parent = "threw " + e.name; }
      try { r.fetch = await (await fetch("http://127.0.0.1:${server.port}/secret")).text(); } catch (e) { r.fetch = "threw " + e.name; }
      // (a worker's code runs only if it says so: the constructor may return and its script be refused afterwards)
      r.worker = await new Promise((done) => {
        let w;
        try { w = new Worker(URL.createObjectURL(new Blob(["postMessage('ran')"], { type: "text/javascript" }))); } catch (e) { return done("threw " + e.name); }
        w.onmessage = () => done("ran"); w.onerror = () => done("refused"); setTimeout(() => done("refused (silent)"), 1500);
      });
      return r;
    })()`);
    ok(probe.origin === "null", "the frame's origin is opaque: " + probe.origin);
    ok(!/canary/.test(String(probe.cookie)) && !/canary/.test(String(probe.storage)), "it reads neither the page's cookie nor its storage: " + JSON.stringify([probe.cookie, probe.storage]));
    ok(/^threw/.test(probe.parent), "nor the parent's DOM: " + probe.parent);
    ok(/^threw/.test(probe.fetch), "nor the network (connect-src 'none'): " + probe.fetch);
    ok(probe.worker !== "ran", "nor runs a worker (worker-src 'none'): " + probe.worker);
  }

  ok(await ev("window.PACKAGED"), "the host module's packaged shell is the built srcdoc (the bundles' __SB_OUTPUT_SHELL__)");

  // ---- the hosted variant, cross-site: its headers, no redirect, no cookie, its ancestors
  const direct = await fetch(shellUrl, { redirect: "manual" });
  const csp = direct.headers.get("content-security-policy") ?? "";
  ok(direct.status === 200 && /frame-ancestors http:\/\/localhost:\d+(;|$)/.test(csp) && /connect-src 'none'/.test(csp) && direct.headers.get("cross-origin-embedder-policy") === "require-corp" && direct.headers.get("cross-origin-resource-policy") === "cross-origin" && !direct.headers.get("set-cookie"),
    "the hosted shell answers 200 (no redirect) with its own CSP, COEP and CORP, and sets no cookie: " + direct.status);
  const framesBefore = frames.length;
  await ev(`(window.H = make({ url: ${JSON.stringify(shellUrl)} }), window.HA = H.area("h1", box()), HA.show(), HA.render([{ id: "o1", kind: "html", body: "<i>hosted</i>" }]), 1)`);
  const hc = await ev(`until(() => events.find((e) => e.area === "h1" && (e.type === "committed" || e.type === "error")))`);
  ok(hc?.type === "committed", "a hosted render commits, the shell on another site: " + JSON.stringify(hc));
  await sleep(300);
  let hsess = null;
  for (const s of frames.slice(framesBefore)) if ((await evIn(s, "location.href").catch(() => "")) === shellUrl) hsess = s;
  ok(!!hsess, "the hosted frame is its own process, at the shell's exact URL");
  if (hsess) {
    const hp = await evIn(hsess, `(async () => {
      const r = { origin: self.origin, meta: !!document.querySelector("meta[http-equiv]") };
      try { r.cookie = document.cookie; } catch (e) { r.cookie = "threw " + e.name; }
      try { r.storage = localStorage.length; } catch (e) { r.storage = "threw " + e.name; }
      try { r.fetch = await (await fetch("${appOrigin}/secret")).text(); } catch (e) { r.fetch = "threw " + e.name; }
      return r;
    })()`);
    ok(hp.origin === "null" && !hp.meta && /^threw/.test(hp.cookie) && /^threw/.test(String(hp.storage)) && /^threw/.test(hp.fetch),
      "inside it: an opaque origin, no cookie or storage, and no network under the response's own policy (no meta CSP): " + JSON.stringify(hp));
  }
  ok(shellSeen.cookies.length === 0, "the shell's site was never sent its cookie: " + JSON.stringify(shellSeen.cookies));
  await ev(`(window.HX = make({ url: ${JSON.stringify(shellUrl + "other/")}, loadMs: 1500 }), window.HXA = HX.area("hx1", box()), HXA.show(), HXA.render([{ id: "o1", kind: "html", body: "<i>x</i>" }]), 1)`);
  const hx = await ev(`until(() => events.find((e) => e.area === "hx1" && (e.type === "committed" || e.type === "error")), 6000)`);
  ok(hx?.type === "error" && shellSeen.paths.includes("/other/"), "under an ancestor it doesn't list, the hosted shell is refused, and the render ends with text: " + JSON.stringify(hx));
  await ev("(H.dispose(), HX.dispose(), 1)");

  // ---- a rogue renderer: what it says out of turn changes nothing
  await ev(`(window.R = make({ rogue: "liar" }), window.RA = R.area("r1", box()), RA.show(), RA.render([{ id: "x", kind: "text", body: "t" }]), 1)`);
  await ev(`until(() => events.find((e) => e.area === "r1" && e.type === "committed"))`);
  await sleep(400);
  const rl = await ev(`({ ends: events.filter((e) => e.area === "r1" && (e.type === "committed" || e.type === "error")), h: RA.state.height })`);
  ok(rl.ends.length === 1 && rl.ends[0].type === "committed" && rl.h === 77, "a rogue renderer's other generation, area, ids, fields, sizes and duplicate commit are ignored: one commit, its height 77: " + JSON.stringify(rl));

  // ---- deadlines: a renderer that never starts, or never commits, ends with text
  await ev(`(window.S = make({ rogue: "silent", loadMs: 700 }), window.SA = S.area("s1", window.SB = box()), SA.show(), SA.render([{ id: "x", kind: "html", body: "<b>rich</b>" }]), 1)`);
  const se = await ev(`until(() => events.find((e) => e.area === "s1" && e.type === "error"), 5000)`);
  const sbox = await ev(`(() => { const b = SB; return { text: b.textContent, rich: !!b.querySelector("b, table, iframe") }; })()`);
  ok(!!se && /didn't start/.test(se.reason) && !sbox.rich && /couldn't be shown/.test(sbox.text), "a renderer that never starts ends at its deadline, with text, nothing inline: " + JSON.stringify([se?.reason, sbox]));
  await ev(`(window.T = make({ rogue: "stuck", commitMs: 700 }), window.TA = T.area("t1", box()), TA.show(), TA.render([{ id: "x", kind: "html", body: "<b>rich</b>" }]), 1)`);
  const te = await ev(`until(() => events.find((e) => e.area === "t1" && e.type === "error"), 5000)`);
  ok(!!te && /didn't finish/.test(te.reason) && (await ev(`T.counts().live`)) === 0, "one that never commits ends at its deadline, its frame gone: " + te?.reason);
  await ev(`(window.D = make(), window.DA = D.area("d1", box()), DA.show(), DA.render([{ id: "x", kind: "text", body: "t" }]), DA.dispose(), 1)`);
  await sleep(300);
  const dd = await ev(`({ ends: events.filter((e) => e.area === "d1" && (e.type === "committed" || e.type === "error")).map((e) => e.reason || e.type), counts: D.counts() })`);
  ok(dd.ends.length === 1 && dd.ends[0] === "disposed" && dd.counts.live === 0 && dd.counts.areas === 0 && dd.counts.ports === 0, "a dispose before ready ends the render once and leaves no frame, port or area: " + JSON.stringify(dd));

  // ---- EVICT-LAYOUT-2: show() is one admission's priority, not a pin (cap 1, both areas offscreen)
  const offscreen = `(() => { const s = document.createElement("div"); s.style.cssText = "height:100px;overflow:auto"; document.body.append(s); const sp = document.createElement("div"); sp.style.height = "3000px"; s.append(sp); return s; })()`;
  await ev(`(window.sc2 = ${offscreen}, window.K = make({ cap: 1, root: sc2 }), window.KA = K.area("k1", box(sc2)), window.KB = K.area("k2", box(sc2)),
    KA.render([{ id: "o", kind: "html", body: "<div style=\\"height:66px\\">a</div>" }]), KB.render([{ id: "o", kind: "text", body: "b" }]), KA.show(), 1)`);
  const k1 = await ev(`until(() => events.find((e) => e.area === "k1" && e.type === "committed"))`);
  await ev(`(KB.show(), 1)`);
  const k2 = await ev(`until(() => events.find((e) => e.area === "k2" && e.type === "committed"))`);
  const kx = await ev(`({ a: KA.state, b: KB.state, live: K.counts().live, hold: sc2.querySelectorAll(".area")[0].querySelector(".sb-out-placeholder")?.style.height })`);
  ok(!!k1 && !!k2 && kx.live === 1 && !kx.a.live && kx.b.live && kx.hold === `${kx.a.height}px`,
    "an area revealed with show() and committed, then offscreen, gives its frame to the next reveal, its height held: " + JSON.stringify(kx));
  await ev(`(KA.show(), 1)`);
  const k3 = await ev(`until(() => events.find((e) => e.area === "k1" && e.type === "committed" && e.generation === 2))`);
  ok(!!k3 && (await ev("KB.state.live")) === false && (await ev("K.counts().live")) === 1, "revealed again, it replays as a new generation and the other gives its frame back");
  await ev("(K.dispose(), sc2.remove(), 1)");

  // ---- RENDER-COMMIT-2: disposing the set ends every pending render once (live, starved of a frame, offscreen)
  await ev(`(window.sc3 = ${offscreen}, window.Z = make({ rogue: "late", cap: 1, root: sc3, commitMs: 60000 }),
    window.ZA = Z.area("z1", box(sc3)), window.ZB = Z.area("z2", box(sc3)), window.ZC = Z.area("z3", box(sc3)),
    ZA.render([{ id: "o", kind: "text", body: "a" }]), ZA.show(), 1)`);
  await ev(`until(() => events.find((e) => e.area === "z1" && e.type === "ready"))`);
  const zs = await ev(`(ZB.render([{ id: "o", kind: "text", body: "b" }]), ZB.show(), ZC.render([{ id: "o", kind: "text", body: "c" }]),
    ({ before: Z.counts(), bLive: ZB.state.live, cLive: ZC.state.live, _: Z.dispose() }))`);
  await sleep(800);
  const zd = await ev(`({ ends: ["z1", "z2", "z3"].map((id) => events.filter((e) => e.area === id && (e.type === "committed" || e.type === "error")).map((e) => e.reason || e.type)),
    counts: Z.counts(), kids: [...sc3.querySelectorAll(".area")].map((b) => b.childElementCount), refused: (() => { try { Z.area("z4", box(sc3)); return false; } catch { return true; } })() })`);
  ok(zs.before.live === 1 && zs.before.pending === 3 && !zs.bLive && !zs.cLive && zd.ends.every((e) => e.length === 1 && e[0] === "disposed")
    && zd.counts.areas === 0 && zd.counts.live === 0 && zd.kids.slice(0, 3).every((n) => n === 0) && zd.refused,
    "disposing the set ends the live, the frame-starved and the offscreen render once each, a late commit included, and leaves nothing: " + JSON.stringify([zs.before, zd]));
  await ev("(sc3.remove(), 1)");

  // ---- EVICT-LAYOUT-1 under a cap of 3, in a scrolling container
  await ev(`(() => {
    window.sc = document.getElementById("scroller");
    window.E = make({ cap: 3, root: sc });
    window.EA = [];
    for (let i = 0; i < 12; i++) { const a = E.area("e" + i, box(sc)); a.render([{ id: "o", kind: "html", body: "<p>area " + i + "</p>".repeat(1) + "<div style=\\"height:" + (40 + 10 * i) + "px\\"></div>" }]); EA.push(a); }
    window.maxLive = 0;
    const tick = () => { maxLive = Math.max(maxLive, E.counts().live); requestAnimationFrame(tick); }; tick();
    return 1;
  })()`);
  await ev(`until(() => events.filter((e) => e.type === "committed" && /^e\\d/.test(e.area)).length >= 2)`);
  const end = await ev(`sc.scrollHeight`);
  for (let y = 0; y <= end; y += 300) { await ev(`(sc.scrollTop = ${y}, 1)`); await sleep(120); }
  await sleep(500);
  for (let y = end; y >= 0; y -= 300) { await ev(`(sc.scrollTop = ${y}, 1)`); await sleep(120); }
  await sleep(800);
  const evx = await ev(`({ max: maxLive, live: E.counts().live, ports: E.counts().ports, committed: new Set(events.filter((e) => e.type === "committed" && /^e\\d/.test(e.area)).map((e) => e.area)).size, holders: [...sc.querySelectorAll(".sb-out-placeholder")].map((p) => p.style.height) })`);
  ok(evx.max <= 3 && evx.live <= 3 && evx.ports <= 3, "never more live frames than the cap (3), ports alike: " + JSON.stringify([evx.max, evx.live, evx.ports]));
  ok(evx.committed === 12, "every area committed as it was scrolled to: " + evx.committed);
  ok(evx.holders.length >= 9 && evx.holders.every((h) => h !== "120px"), "evicted areas are placeholders holding their committed heights: " + evx.holders.slice(0, 4).join(","));
  // (the anchor: an area's position before and after a full eviction cycle with nothing changed)
  const anchor = async () => ev(`(() => { sc.scrollTop = 6 * 340; return EA[6] && document.querySelectorAll("#scroller .area")[6].getBoundingClientRect().top; })()`);
  const before = await anchor(); await sleep(400);
  for (let y = 0; y <= 12 * 340; y += 680) { await ev(`(sc.scrollTop = ${y}, 1)`); await sleep(150); }
  const after = await anchor(); await sleep(400);
  const after2 = await ev(`document.querySelectorAll("#scroller .area")[6].getBoundingClientRect().top`);
  ok(Math.abs(after2 - before) <= 1, `after eviction cycles the anchor moved at most a pixel: ${before} -> ${after2}`);

  // ---- 50 and 200 areas: the figures for the cap (printed; the cap's frozen value comes from these)
  for (const count of [50, 200]) {
    const fig = await ev(`(async () => {
      const host = document.createElement("div"); host.style.cssText = "height:600px;overflow:auto"; document.body.prepend(host); scrollTo(0, 0);
      const M = make({ cap: 24, root: host });
      const t0 = performance.now(); let first = 0;
      const areas = [];
      for (let i = 0; i < ${count}; i++) { const b = box(host); const a = M.area("m${count}-" + i, b); areas.push(a); a.render([{ id: "o", kind: "html", body: "<p>row " + i + "</p><table><tr><td>a</td><td>b</td></tr></table>" }]); }
      await until(() => (first = events.find((e) => e.type === "committed" && e.area.startsWith("m${count}-"))) && true, 15000);
      const firstMs = first ? first.t - t0 : -1;
      await until(() => events.filter((e) => e.type === "committed" && e.area.startsWith("m${count}-")).length >= Math.min(${count}, 2), 15000);
      const c = M.counts();
      M.dispose(); host.remove();
      return { firstMs: Math.round(firstMs), live: c.live, areas: c.areas };
    })()`);
    const mem = await send("Performance.getMetrics");
    console.log(`(${count} areas: first commit ${fig.firstMs} ms, ${fig.live} live frames of ${fig.areas} areas; JS heap ${Math.round((mem.metrics?.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / 1e6)} MB)`);
    ok(fig.live <= 24 && fig.firstMs >= 0, `${count} areas: the cap holds (${fig.live} live) and the first commit comes`);
  }
  // ---- dense: 50 and 200 areas all asked for at once, no cap below the count (the cap's
  // provenance: readiness, commit and load-timeout distributions, frames and memory; printed)
  const metric = async (name) => (await send("Performance.getMetrics")).metrics?.find((m) => m.name === name)?.value ?? 0;
  for (const count of [50, 200]) {
    const heap0 = await metric("JSHeapUsedSize"), task0 = await metric("TaskDuration"), frs0 = await metric("Frames"), pss0 = treePss(chrome.pid);
    const fig = await ev(dense(count));
    await sleep(500);
    const pss1 = treePss(chrome.pid);
    const frs = await metric("Frames"), heap1 = await metric("JSHeapUsedSize"), task1 = await metric("TaskDuration");
    console.log(`(chromium ${denseLine(count, fig)}; ${frs - frs0} frames (CDP's count); browser processes +${pss0 === null ? "?" : Math.round((pss1 - pss0) / 1e6)} MB PSS (${pss0 === null ? "?" : ((pss1 - pss0) / 1e6 / count).toFixed(2)} MB a frame); page heap +${Math.round((heap1 - heap0) / 1e6)} MB; main-thread tasks ${Math.round((task1 - task0) * 1000)} ms)`);
    ok(fig.committed[0] + fig.errors.length === count, `dense ${count}: every render ended exactly once`);
    await ev("(KEEP.dispose(), KEEPHOST.remove(), 1)");
  }
  // ---- under the app's real page policy (inherited by the srcdoc frame): with the shell's hash it commits; without it,
  // the shell never runs and the render ends with text
  for (const [page, want] of [["app.html", "committed"], ["app-nohash.html", "error"]]) {
    await send("Page.navigate", { url: `${appOrigin}/${page}` });
    await sleep(200);
    for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
    await ev(`(window.P = make({ loadMs: 1500 }), window.PA = P.area("p1", box()), PA.show(), PA.render([{ id: "o1", kind: "html", body: "<b>p</b>" }]), 1)`);
    const pe = await ev(`until(() => events.find((e) => e.area === "p1" && (e.type === "committed" || e.type === "error")), 6000)`);
    ok(pe?.type === want, `under the app's page policy ${page === "app.html" ? "listing the shell's hash, a render commits" : "without the shell's hash, the shell doesn't run and the render ends with text"}: ` + JSON.stringify(pe));
  }
  ws.close();
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  server.stop(true);
  shellSite.stop(true);
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
console.log(failures ? `${failures} of ${checks} failed` : `${checks}/${checks} passed`);
process.exit(failures ? 1 : 0);
