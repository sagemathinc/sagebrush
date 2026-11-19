// The agent-flow harness's "computer" surface: the Agents page (/agents/) with the agent on one of the person's own
// computers (Chat here), with nothing stood in for between the page and the agent:
//   - the relay: the remotes' Worker and its relay (web/cloud/remote/test-entry.ts, as test-relay.mjs runs it) in
//     Miniflare, a real D1 and a session from /auth/dev; the site (web/dist, with its own _headers) on the same
//     origin, as sagebrush.space serves both. Or a deployed site (DEV), with a session the caller made;
//   - the computer: a real `sagebrush remote` runner (this tree's engine/py, built and installed: it signs with the
//     engine's native ES256), enrolled by the device flow (`sagebrush remote login`, approved by the signed-in
//     account), started with --serve-agents; revoked again at the end;
//   - the agent: the reviewed sagebrush-agent (engine/py/fixtures, its SHA-256 checked), the runner's child, with only
//     its model scripted (computer-agent.mjs): the case's calls, made through the agent's own tools;
//   - the page: the harness's Chrome, signed in: Connect, Chat here on that computer, the grant, Allow.
// The scripted model and this surface share a folder on this computer: each call is a numbered command file there.
//
//   startComputerSite(opts) -> { origin, cookie, close }        (opts.site: { origin, cookieFile }, a deployed site)
//   computerSurface(site, page, opts) -> the harness's surface: { name, tool, connect, beginTurn, endTurn, shownPath,
//                                        liveCells, close }    (opts.runnerLate: ms, Chat here before the runner starts)
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { migrations } from "../cloud/share/migrations.mjs";
import { allow, PANE_CELLS } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dist = join(root, "web", "dist");
const py = join(root, "engine", "py");
const VENDORED = join(py, "fixtures", "sagebrush-agent-0.5.0.tgz");
const VENDORED_SHA256 = "019b9020c12a0294705ac6c1ba76433b71dab8e89ef3be31e063cba54401016b"; // (test_remote_agent.py's)
const STUB_DEPS = join(py, "remote_agent_stub_deps.mjs");
const A = "11111111-1111-4111-8111-111111111111";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the site's headers, as web/serve.py applies them (test-agents-chat-here.mjs's reading of web/dist/_headers)
function siteHeaders() {
  const rules = [];
  let cur = null;
  for (const line of readFileSync(join(dist, "_headers"), "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) { cur = { pattern: line.trim(), headers: [] }; rules.push(cur); continue; }
    const i = line.indexOf(":");
    cur?.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return (path) => {
    const h = {};
    for (const r of rules) {
      const m = r.pattern.endsWith("*") ? path.startsWith(r.pattern.slice(0, -1)) : path === r.pattern;
      if (m) for (const [k, v] of r.headers) h[k.toLowerCase()] = v;
    }
    return h;
  };
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".map": "application/json" };
const RELAYED = (p) => p.startsWith("/api/") || p.startsWith("/auth/") || p.startsWith("/remote/");

/** The relay and the site on one origin, and a signed-in session for the account the relay allows. */
export async function startComputerSite(opts = {}) {
  if (opts.site) {
    // (a deployed site: its relay and its pages, and a session the caller made, read from a 0600 file, never printed)
    const cookie = readFileSync(opts.site.cookieFile, "utf8").trim();
    if (!/^[A-Za-z0-9_-]+=\S+$/.test(cookie)) throw new Error("the cookie file isn't one name=value");
    return { origin: new URL(opts.site.origin).origin, cookie, close: () => {} };
  }
  if (!existsSync(join(dist, "agents", "agents.js"))) throw new Error("no web/dist/agents: SAGEBRUSH_AGENTS=1 bun web/build.ts first");
  const require = createRequire(join(root, "web", "site", "package.json"));
  const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
  const script = execFileSync("bun", ["build", join(root, "web", "cloud", "remote", "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const bindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", REMOTE_CHAL_KEY: "chal-key", REMOTE_ACCOUNTS: A };
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: "127.0.0.1", port: 0,
    workers: [{ name: "remote", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"], bindings,
      durableObjects: { REMOTE_RELAY: { className: "TestRemoteRelay", useSQLite: true }, REMOTE_ACCOUNT: { className: "TestRemoteAccount", useSQLite: true } } }],
  }));
  let server = null;
  const close = async () => { server?.closeAllConnections?.(); server?.close(); await mf.dispose().catch(() => {}); };
  try {
    const up = new URL((await mf.ready).href);
    const db = await mf.getD1Database("SHARE_DB");
    for (const { path: m } of migrations())
      for (const s of readFileSync(m, "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();
    // (the site's files, and the relay's routes passed through, HTTP and WebSocket alike)
    const headersFor = siteHeaders();
    server = createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (RELAYED(url.pathname)) {
        const r = httpRequest({ host: up.hostname, port: up.port, method: req.method, path: req.url, headers: req.headers }, (u) => { res.writeHead(u.statusCode, u.rawHeaders); u.pipe(res); });
        r.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        req.pipe(r);
        return;
      }
      let p = normalize(decodeURIComponent(url.pathname));
      if (p.endsWith("/")) p += "index.html";
      const f = join(dist, p);
      if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { ...headersFor(url.pathname), "content-type": TYPES[p.slice(p.lastIndexOf("."))] ?? "application/octet-stream" });
      res.end(readFileSync(f));
    });
    server.on("upgrade", (req, sock, head) => {
      if (!RELAYED(new URL(req.url, "http://x").pathname)) return sock.destroy();
      const u = connect(Number(up.port), up.hostname, () => {
        let h = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) h += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        u.write(h + "\r\n");
        if (head?.length) u.write(head);
        u.pipe(sock);
        sock.pipe(u);
      });
      const end = () => { sock.destroy(); u.destroy(); };
      for (const s of [u, sock]) { s.on("error", end); s.on("close", end); }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    // (localhost: the session cookie is __Host- and Secure, which Chromium keeps over plain HTTP for localhost)
    const origin = `http://localhost:${server.address().port}`;
    const r = await fetch(origin + "/auth/dev", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ token: "dev-token", account_id: A }) });
    const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
    if (!cookie) throw new Error(`no session from /auth/dev (${r.status})`);
    return { origin, cookie, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** The vendored agent, its SHA-256 checked before anything is read from it, unpacked into `into`. */
function unpackAgent(into) {
  const buf = readFileSync(VENDORED);
  if (createHash("sha256").update(buf).digest("hex") !== VENDORED_SHA256) throw new Error("the vendored sagebrush-agent isn't the reviewed one");
  for (const name of execFileSync("tar", ["-tzf", VENDORED], { encoding: "utf8" }).split("\n").filter(Boolean))
    if (!name.startsWith("package/") || name.split("/").includes("..")) throw new Error("unexpected member in the agent tarball: " + name);
  execFileSync("tar", ["-xzf", VENDORED, "-C", into, "--no-same-owner", "--no-same-permissions"]);
  return join(into, "package");
}

/** A child process in its own group, its output kept (the last 64 KiB). */
function child(cmd, args, opts) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, ...opts });
  p.out = "";
  const keep = (d) => { p.out = (p.out + d.toString()).slice(-65536); };
  p.stdout.on("data", keep);
  p.stderr.on("data", keep);
  p.gone = new Promise((r) => p.once("exit", (code) => r(code)));
  return p;
}
async function stopChild(p, ms = 5000) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  try { process.kill(-p.pid, "SIGTERM"); } catch { p.kill("SIGTERM"); }
  if (!(await Promise.race([p.gone.then(() => true), sleep(ms).then(() => false)]))) {
    try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill("SIGKILL"); }
    await p.gone;
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ppidOf = (pid) => { try { return Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[1]); } catch { return null; } };

let computers = 0;
/** The harness's surface (harness.mjs's mcp and chat have the same shape), on the site from startComputerSite. */
export async function computerSurface(site, page, opts = {}) {
  const log = opts.log ?? ((s) => console.log(s));
  const computer = opts.computer ?? `lab-box-${++computers}`;
  const tmp = mkdtempSync(join(tmpdir(), "sb-computer-"));
  const script = join(tmp, "script");
  const home = join(tmp, "home");
  mkdirSync(script, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  const S = { runner: null, revoke: null, started: null, turn: false, ending: null, n: 0, failures: [] };
  const base = site.origin, cookie = site.cookie;
  const python = process.env.PYTHON ?? "python3";
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".state"), SAGEBRUSH_REMOTE_ORIGIN: base, NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "PYTHONPATH"]) delete env[k];
  const pkg = unpackAgent(tmp);
  const agentCmd = [process.execPath, "--import", STUB_DEPS, join(here, "computer-agent.mjs"), pkg, script].map((a) => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a)).join(" ");

  /** The runner, as the person starts it; waits for its own leg to be up. */
  const startRunner = async () => {
    S.runner = child(python, ["-m", "sagebrush", "remote", "--serve-agents", "--agent-cmd", agentCmd], { cwd: home, env });
    for (let i = 0; i < 600 && !/^Connected to /m.test(S.runner.out); i++) {
      if (S.runner.exitCode !== null) throw new Error("the runner exited: " + S.runner.out.slice(-800));
      await sleep(100);
    }
    if (!/^Connected to /m.test(S.runner.out)) throw new Error("the runner didn't connect: " + S.runner.out.slice(-800));
  };

  /** One command to the scripted model, in the turn that's open; its result. */
  const command = async (cmd, ms = 120000) => {
    const k = S.n++;
    writeFileSync(join(script, `.cmd-${k}.json`), JSON.stringify(cmd));
    execFileSync("mv", [join(script, `.cmd-${k}.json`), join(script, `cmd-${k}.json`)]);
    const f = join(script, `res-${k}.json`);
    for (const t = Date.now(); !existsSync(f); await sleep(50)) if (Date.now() - t > ms) throw new Error(`no answer to ${cmd.tool ?? "the turn's end"} in ${ms / 1000} s` + (S.runner ? ": " + S.runner.out.slice(-400) : ""));
    return JSON.parse(readFileSync(f, "utf8"));
  };

  const surface = {
    name: "computer",
    computer,
    /** The person: enrolls the computer, starts its runner, Connect, Chat here on it, the grant, Allow. */
    async connect(grant) {
      if (!(() => { try { execFileSync(python, ["-c", "import sagebrush._native, sagebrush.remote.relay"], { cwd: home, env, stdio: "pipe" }); return true; } catch { return false; } })())
        throw new Error(`${python} has no built sagebrush (its native module): build and install engine/py (maturin build, pip install), or set PYTHON`);
      const login = child(python, ["-m", "sagebrush", "remote", "login", "--name", computer], { cwd: home, env });
      let code = null;
      for (let i = 0; i < 300 && !code; i++) { code = /the code ([A-Z]{4}-[A-Z]{4})/.exec(login.out)?.[1] ?? null; if (!code) await sleep(100); }
      if (!code) throw new Error("sagebrush remote login printed no code: " + login.out.slice(-500));
      const form = await fetch(base + "/remote/activate", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base, cookie }, body: new URLSearchParams({ code, decision: "approve" }).toString() });
      if (form.status >= 400) throw new Error(`the approval was refused (${form.status}): ${(await form.text()).slice(0, 300)}`);
      if ((await Promise.race([login.gone, sleep(30000).then(() => "timeout")])) !== 0) throw new Error("sagebrush remote login didn't finish: " + login.out.slice(-500));
      S.revoke = async () => {
        // (this run's computer, revoked as the person revokes one: own account, same site)
        const list = await (await fetch(base + "/api/remote/v1/peers", { headers: { cookie } })).json();
        for (const p of (list.peers ?? []).filter((x) => x.name === computer)) {
          const r = await fetch(base + "/api/remote/v1/revoke", { method: "POST", headers: { "content-type": "application/json", origin: base, cookie }, body: JSON.stringify({ remote_id: p.remote_id }) });
          if (!r.ok) S.failures.push(`${computer} wasn't revoked (${r.status})`);
        }
      };
      log(`     [computer] ${computer} enrolled by the device flow, approved signed in`);
      if (!opts.runnerLate) await startRunner();

      // (the page, signed in)
      const [cn, cv] = cookie.split(/=(.*)/s);
      await page.send("Network.setCookie", { name: cn, value: cv, url: base + "/", path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
      await page.navigate(base + "/agents/");
      if (!(await page.until(`!!document.querySelector('#editor .mb') && !document.querySelector('#connect').hidden`, 60000))) throw new Error("the Agents page didn't open");
      const listed = `[...document.querySelectorAll('.sbag-box .runner')].some((r) => r.textContent.includes(${JSON.stringify(computer)}) && [...r.querySelectorAll('button')].some((b) => b.textContent === 'Chat here'))`;
      let shown = false;
      for (let i = 0; i < 10 && !shown; i++) {
        await page.ev(`(document.querySelector('#connect').click(), true)`);
        shown = await page.until(listed, 6000);
        if (!shown) await page.ev(`([...document.querySelectorAll('.sbag-box button')].find((b) => b.textContent === 'Cancel')?.click(), true)`);
      }
      if (!shown) throw new Error(`the Connect dialog doesn't list ${computer} with Chat here: ` + (await page.ev(`[...document.querySelectorAll('.sbag-box')].at(-1)?.textContent ?? ''`)));
      await page.ev(`(() => { window.__whoSeen = []; new MutationObserver(() => window.__whoSeen.push(document.querySelector('#who').textContent)).observe(document.querySelector('#who'), { childList: true, subtree: true, characterData: true }); return true; })()`);
      await page.ev(`([...[...document.querySelectorAll('.sbag-box .runner')].find((r) => r.textContent.includes(${JSON.stringify(computer)})).querySelectorAll('button')].find((b) => b.textContent === 'Chat here').click(), true)`);
      if (opts.runnerLate) { await sleep(opts.runnerLate); await startRunner(); }
      await allow(page, grant);
      if (!(await page.until(`document.querySelector('#who').textContent.includes(${JSON.stringify("on " + computer)})`, 30000))) throw new Error("not connected after Allow: " + (await page.ev(`document.querySelector('#who').textContent`)));
      S.started = JSON.parse(readFileSync(join(script, "started.json"), "utf8"));
      // (the agent runs on the computer: under the runner, the runner's own child)
      if (!(S.started.ppid === S.runner.pid || ppidOf(S.started.pid) === S.runner.pid)) throw new Error(`the agent (pid ${S.started.pid}) isn't the runner's child (runner ${S.runner.pid})`);
      surface.agentHost = S.started.host;
      surface.whoSeen = await page.ev(`window.__whoSeen ?? []`);
    },
    /** The person sends the prompt from the composer; the agent's turn starts (it says "Working on <its computer>."). */
    async beginTurn(prompt) {
      // (the turn before it finished first: a message sent during a turn would interrupt it ("Send now"))
      await S.ending;
      if (!(await page.until(`document.querySelector('#send').textContent === 'Send'`, 30000))) throw new Error("the agent's turn before didn't finish");
      await page.ev(`(() => { if (!document.querySelector('#editor textarea')) document.querySelector('#editor .mb-block')?.click(); return true; })()`);
      if (!(await page.until(`!!document.querySelector('#editor textarea')`, 5000))) throw new Error("the composer has no text box");
      await page.ev(`(document.querySelector('#editor textarea').focus(), true)`);
      await page.send("Input.insertText", { text: prompt });
      await page.ev(`(document.querySelector('#send').click(), true)`);
      S.turn = true;
    },
    endTurn(text = "Done.") {
      if (!S.turn) return S.ending;
      S.turn = false;
      S.ending = command({ end: true, text });
      return S.ending;
    },
    /** One agent call, by sagebrush-mcp's name, through the agent's own tools; in a turn of its own if none is open. */
    async tool(name, args = {}) {
      const own = !S.turn;
      if (own) await surface.beginTurn(`(${name} ${args.path ?? args.folder ?? ""})`.replace(/ \)$/, ")"));
      try {
        const r = await command({ tool: name, args });
        let result = null;
        try { result = JSON.parse(r.text); } catch { /* (an agent's own words, not JSON) */ }
        const error = r.isError ? { code: "error", message: r.text } : null;
        return { text: r.text, structured: { result: error ? null : result, error }, isError: !!r.isError };
      } finally {
        if (own) await surface.endTurn("");
      }
    },
    /** The notebook the person sees: the Agents page's pane, its tab shown. */
    shownPath: `document.querySelector(".pane-head .tab.on")?.dataset.tab ?? null`,
    liveCells: PANE_CELLS,
    /** Disconnect: the runner ends the agent (its process gone); the computer revoked; everything removed. */
    async close() {
      try {
        if (S.started) {
          await page.ev(`([...document.querySelectorAll('.sbag-bar button')].find((b) => b.textContent === 'Disconnect')?.click(), true)`).catch(() => {});
          for (const t = Date.now(); Date.now() - t < 15000 && alive(S.started.pid); ) await sleep(100);
          if (alive(S.started.pid)) S.failures.push("Disconnect: the agent's process on the computer is still there");
        }
      } finally {
        await stopChild(S.runner);
        if (S.revoke) await S.revoke().catch((e) => S.failures.push(`${computer} wasn't revoked: ${e.message}`));
        rmSync(tmp, { recursive: true, force: true });
      }
      return S.failures;
    },
  };
  return surface;
}

/** The grant dialog ("Allow this agent?"), set as the case's grant, then Allow (harness.mjs's, the same steps). */
