// The agent-flow harness's "computer" surface (web/agent-flows/harness.mjs's surfaces, run by
// test-agent-flows-computer.mjs beside this file): the Agents page (/agents/) with the agent on one of the person's own
// computers (Chat here), with nothing stood in for between the page and the agent:
//   - the relay: the remotes' Worker and its relay (web/cloud/remote/test-entry.ts, as test-relay.mjs runs it) in
//     Miniflare, a real D1 and a session from /auth/dev; the site (web/dist, with its own _headers) on the same
//     origin, as sagebrush.space serves both. Or a deployed site (DEV), with a session the caller made;
//   - the computer: a real `sagebrush remote` runner (this tree's engine/py, built and installed: it signs with the
//     engine's native ES256), enrolled by the device flow (`sagebrush remote login`, approved by the signed-in
//     account), started with --serve-agents; revoked again at the end;
//   - the agent: the reviewed sagebrush-agent (the tarball and SHA-256 engine/py/test_remote_agent.py names, checked),
//     the runner's child, with only its model scripted (computer-agent.mjs): the case's calls, made through the
//     agent's own tools;
//   - the page: the harness's Chrome, signed in: Connect, Chat here on that computer, the grant, Allow.
// The scripted model and this surface share a folder on this computer: each call is a numbered command file there.
// Every wait is bounded, as the harness's own are: each request to the site within CDP_MS, a child's end within
// CLEANUP_MS after SIGKILL, the relay's start within START_MS; a surface closed (a case over its time) stops every
// step still on its way at its next check, and nothing it started outlives it.
//
//   startComputerSite(opts) -> { origin, cookie, close }        (opts.site: { origin, cookieFile }, a deployed site)
//   computerSurface(site, page, opts) -> the harness's surface: { name, tool, connect, beginTurn, endTurn, shownPath,
//                                        liveCells, close }    (opts.runnerLate: ms, Chat here before the runner starts)
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { migrations } from "../share/migrations.mjs";
import { allow, PANE_CELLS, CDP_MS, CLEANUP_MS, sleep } from "../../agent-flows/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const dist = join(root, "web", "dist");
const py = join(root, "engine", "py");
// (the reviewed agent, as engine/py/test_remote_agent.py names it: its tarball and SHA-256, one place for both)
const pins = readFileSync(join(py, "test_remote_agent.py"), "utf8");
const VENDORED = join(py, "fixtures", /^VENDORED = os\.path\.join\(HERE, "fixtures", "(sagebrush-agent-[0-9.]+\.tgz)"\)$/m.exec(pins)?.[1] ?? "(not named)");
const VENDORED_SHA256 = /^VENDORED_SHA256 = "([0-9a-f]{64})"$/m.exec(pins)?.[1] ?? "(not named)";
const STUB_DEPS = join(py, "remote_agent_stub_deps.mjs");
const A = "11111111-1111-4111-8111-111111111111";
/** The relay's start in Miniflare (the Worker built, workerd up), at most. */
export const START_MS = 60_000;
/** The surface's whole close (Disconnect, every process it started killed and reaped, the computer revoked), at most:
 *  within the harness's own bound on a surface's close (runCase's CLEANUP_MS). */
export const CLOSE_MS = CLEANUP_MS - 500;
/** The variables the runner (and through it the agent) gets from this process's environment: nothing else of it. */
const ENV_KEEP = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"];
/** `p`, or a refusal saying `what` once `ms` have passed. */
const bounded = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(`${what}: no answer in ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t)); };
/** A request to the site, within CDP_MS (and `signal`, a surface's own). */
const fetchT = (url, init = {}, ms = CDP_MS) => fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms) });

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

/** The site's own end: every upgraded socket destroyed (closeAllConnections leaves them), the server's close and
 *  Miniflare's end each bounded by CLEANUP_MS; what failed or hung, as the problems (never swallowed). */
export async function closeSite({ server = null, upgraded = new Set(), mf = null } = {}) {
  const problems = [];
  for (const s of upgraded) s.destroy();
  upgraded.clear();
  if (server?.listening) {
    server.closeAllConnections?.();
    const e = await bounded(new Promise((r) => server.close((err) => r(err ?? null))), CLEANUP_MS, "the site's server close").catch((x) => x);
    if (e) problems.push(String(e.message ?? e));
  }
  if (mf) {
    const e = await bounded(Promise.resolve().then(() => mf.dispose()), CLEANUP_MS, "Miniflare's end").then(() => null, (x) => x);
    if (e) problems.push(String(e.message ?? e).startsWith("Miniflare's end") ? e.message : "Miniflare's end: " + (e.message ?? e));
  }
  return problems;
}

/** A deployed site's origin and session, refused unless exactly as they must be: an https origin and nothing else,
 *  and a regular file (no link) only its owner can read, holding one name=value (no ";", space or control). */
export function deployedSite({ origin, cookieFile }) {
  const u = new URL(origin);
  if (u.protocol !== "https:" || u.username || u.password || u.origin !== origin.replace(/\/$/, "")) throw new Error("the site's origin must be https://host, nothing more");
  const st = lstatSync(cookieFile);
  if (!st.isFile()) throw new Error("the cookie file must be a regular file (not a link)");
  if (st.mode & 0o077) throw new Error("the cookie file must be readable by its owner only (0600)");
  const cookie = readFileSync(cookieFile, "utf8").replace(/\r?\n$/, "");
  if (!/^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]+$/.test(cookie)) throw new Error("the cookie file must hold one name=value (no ';', space or control)");
  return { origin: u.origin, cookie, close: async () => [] };
}

/** The relay and the site on one origin, and a signed-in session for the account the relay allows. close() resolves
 *  to the problems of the site's end (none: []). */
export async function startComputerSite(opts = {}) {
  // (a deployed site: its relay and its pages, and a session the caller made, read from a 0600 file, never printed)
  if (opts.site) return deployedSite(opts.site);
  if (!existsSync(join(dist, "agents", "agents.js"))) throw new Error("no web/dist/agents: SAGEBRUSH_AGENTS=1 bun web/build.ts first");
  const require = createRequire(join(root, "web", "site", "package.json"));
  const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
  const script = execFileSync("bun", ["build", join(root, "web", "cloud", "remote", "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8", maxBuffer: 64 << 20, timeout: START_MS });
  const bindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", REMOTE_CHAL_KEY: "chal-key", REMOTE_ACCOUNTS: A };
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: "127.0.0.1", port: 0,
    workers: [{ name: "remote", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"], bindings,
      durableObjects: { REMOTE_RELAY: { className: "TestRemoteRelay", useSQLite: true }, REMOTE_ACCOUNT: { className: "TestRemoteAccount", useSQLite: true } } }],
  }));
  let server = null;
  const upgraded = new Set();
  const close = () => closeSite({ server, upgraded, mf });
  try {
    const up = new URL((await bounded(mf.ready, START_MS, "the relay in Miniflare")).href);
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
      const end = () => { sock.destroy(); u.destroy(); upgraded.delete(sock); upgraded.delete(u); };
      upgraded.add(sock);
      upgraded.add(u);
      for (const s of [u, sock]) { s.on("error", end); s.on("close", end); }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    // (localhost: the session cookie is __Host- and Secure, which Chromium keeps over plain HTTP for localhost)
    const origin = `http://localhost:${server.address().port}`;
    const r = await fetchT(origin + "/auth/dev", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ token: "dev-token", account_id: A }) });
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
  for (const name of execFileSync("tar", ["-tzf", VENDORED], { encoding: "utf8", timeout: CDP_MS }).split("\n").filter(Boolean))
    if (!name.startsWith("package/") || name.split("/").includes("..")) throw new Error("unexpected member in the agent tarball: " + name);
  execFileSync("tar", ["-xzf", VENDORED, "-C", into, "--no-same-owner", "--no-same-permissions"], { timeout: CDP_MS });
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
/** The processes of group `pgid` still running (a zombie, ended and waiting to be reaped, doesn't count). */
function inGroup(pgid) {
  const left = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const f = readFileSync(`/proc/${d}/stat`, "utf8").replace(/^.*\) /s, "").split(" ");
      if (Number(f[2]) === pgid && f[0] !== "Z") left.push(Number(d));
    } catch { /* (gone meanwhile) */ }
  }
  return left;
}
const running = (pid) => { try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "")[0] !== "Z"; } catch { return false; } };
/** A process this surface started, and its whole group, ended: SIGKILL at once (a process that ignores TERM can't
 *  hold it up), then waited for until `left()` ms run out; what is still running afterwards, as one problem. */
async function endGroup(p, what, left) {
  if (!p) return null;
  try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} }
  for (; left() > 0 && (inGroup(p.pid).length || (p.exitCode === null && p.signalCode === null)); ) await sleep(25);
  const still = inGroup(p.pid);
  return still.length || (p.exitCode === null && p.signalCode === null) ? `${what}: still running after the close (pids ${[p.pid, ...still].join(", ")})` : null;
}
const alive = running;
const ppidOf = (pid) => { try { return Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[1]); } catch { return null; } };

/** The harness's surface (harness.mjs's mcp and chat have the same shape), on the site from startComputerSite. */
export async function computerSurface(site, page, opts = {}) {
  const log = opts.log ?? ((s) => console.log(s));
  // (a name no other computer of the account has: the revocation below takes only what this run enrolled)
  const computer = opts.computer ?? `lab-box-${randomBytes(6).toString("hex")}`;
  const tmp = mkdtempSync(join(tmpdir(), "sb-computer-"));
  const script = join(tmp, "script");
  const home = join(tmp, "home");
  mkdirSync(script, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  const S = { login: null, runner: null, revoke: null, enrolled: new Set(), started: null, turn: false, ending: null, n: 0, failures: [], closed: false, abort: new AbortController() };
  // (once closed, a connect still on its way stops at its next step: nothing it would start outlives the surface)
  const live = () => { if (S.closed) throw new Error("the computer surface was closed"); };
  const base = site.origin, cookie = site.cookie;
  const python = process.env.PYTHON ?? "python3";
  // (the runner's environment, built here: the few variables of this one it needs (ENV_KEEP), its own home, and the
  //  site; never this process's others (credentials, proxies, PYTHONPATH), and never the session cookie)
  const env = { ...Object.fromEntries(ENV_KEEP.filter((k) => typeof process.env[k] === "string").map((k) => [k, process.env[k]])), HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".state"), XDG_CACHE_HOME: join(home, ".cache"), SAGEBRUSH_REMOTE_ORIGIN: base, NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" };
  const pkg = unpackAgent(tmp);
  const agentCmd = [process.execPath, "--import", STUB_DEPS, join(here, "computer-agent.mjs"), pkg, script].map((a) => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a)).join(" ");

  /** The runner, as the person starts it; waits for its own leg to be up. */
  const startRunner = async () => {
    live();
    S.runner = child(python, ["-m", "sagebrush", "remote", "--serve-agents", "--agent-cmd", agentCmd], { cwd: home, env });
    for (let i = 0; i < 600 && !/^Connected to /m.test(S.runner.out); i++) {
      if (S.runner.exitCode !== null) throw new Error("the runner exited: " + S.runner.out.slice(-800));
      await sleep(100);
      live();
    }
    if (!/^Connected to /m.test(S.runner.out)) throw new Error("the runner didn't connect: " + S.runner.out.slice(-800));
  };

  /** One command to the scripted model, in the turn that's open; its result. */
  const command = async (cmd, ms = 120000) => {
    const k = S.n++;
    writeFileSync(join(script, `.cmd-${k}.json`), JSON.stringify(cmd));
    execFileSync("mv", [join(script, `.cmd-${k}.json`), join(script, `cmd-${k}.json`)]);
    const f = join(script, `res-${k}.json`);
    for (const t = Date.now(); !existsSync(f); await sleep(50)) if (live(), Date.now() - t > ms) throw new Error(`no answer to ${cmd.tool ?? "the turn's end"} in ${ms / 1000} s` + (S.runner ? ": " + S.runner.out.slice(-400) : ""));
    return JSON.parse(readFileSync(f, "utf8"));
  };

  const surface = {
    name: "computer",
    computer,
    /** The person: enrolls the computer, starts its runner, Connect, Chat here on it, the grant, Allow. */
    async connect(grant) {
      try {
        if (!(() => { try { execFileSync(python, ["-c", "import sagebrush._native, sagebrush.remote.relay"], { cwd: home, env, stdio: "pipe", timeout: CDP_MS }); return true; } catch { return false; } })())
          throw new Error(`${python} has no built sagebrush (its native module): build and install engine/py (maturin build, pip install), or set PYTHON`);
        live();
        const login = (S.login = child(python, ["-m", "sagebrush", "remote", "login", "--name", computer], { cwd: home, env }));
        let code = null;
        for (let i = 0; i < 300 && !code; i++) { code = /the code ([A-Z]{4}-[A-Z]{4})/.exec(login.out)?.[1] ?? null; if (!code) await sleep(100); live(); }
        if (!code) throw new Error("sagebrush remote login printed no code: " + login.out.slice(-500));
        // (the account's computers before this one: the revocation takes only computers that weren't among them and have
        //  this run's name, so never another of the account's. It is this surface's from before the approval is sent:
        //  once approved, the computer is enrolled whatever happens next, and a close revokes it, then checks it's gone)
        const peers = async (ms = CDP_MS) => {
          const r = await fetchT(base + "/api/remote/v1/peers", { headers: { cookie } }, ms);
          if (!r.ok) throw new Error(`the account's computers weren't listed (${r.status})`);
          return ((await r.json()).peers ?? []).filter((x) => x && typeof x.remote_id === "string");
        };
        const before = new Set((await peers()).map((x) => x.remote_id));
        live();
        const ours = (list) => list.filter((x) => x.name === computer && !before.has(x.remote_id)).map((x) => x.remote_id);
        S.revoke = async (left) => {
          for (const id of ours(await peers(left()))) S.enrolled.add(id);
          for (const id of S.enrolled) {
            const r = await fetchT(base + "/api/remote/v1/revoke", { method: "POST", headers: { "content-type": "application/json", origin: base, cookie }, body: JSON.stringify({ remote_id: id }) }, left());
            if (!r.ok) S.failures.push(`${computer} (${id}) wasn't revoked (${r.status})`);
          }
          const stillThere = (await peers(left())).filter((x) => S.enrolled.has(x.remote_id)).map((x) => x.remote_id);
          if (stillThere.length) S.failures.push(`${computer} is still enrolled after its revocation (${stillThere.join(", ")})`);
        };
        const form = await fetchT(base + "/remote/activate", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base, cookie }, body: new URLSearchParams({ code, decision: "approve" }).toString(), signal: S.abort.signal });
        live();
        if (form.status >= 400) throw new Error(`the approval was refused (${form.status}): ${(await form.text()).slice(0, 300)}`);
        // (approved: the computer this run enrolled, by its id, the moment it is listed)
        for (const id of ours(await peers().catch(() => []))) S.enrolled.add(id);
        if ((await Promise.race([login.gone, sleep(30000).then(() => "timeout")])) !== 0) throw new Error("sagebrush remote login didn't finish: " + login.out.slice(-500));
        live();
        log(`     [computer] ${computer} enrolled by the device flow, approved signed in`);
        if (!opts.runnerLate) await startRunner();

        // (the page, signed in)
        const [cn, cv] = cookie.split(/=(.*)/s);
        await page.send("Network.setCookie", { name: cn, value: cv, url: base + "/", path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
        await page.navigate(base + "/agents/");
        live();
        if (!(await page.until(`!!document.querySelector('#editor .mb') && !document.querySelector('#connect').hidden`, 60000))) throw new Error("the Agents page didn't open");
        const listed = `[...document.querySelectorAll('.sbag-box .runner')].some((r) => r.textContent.includes(${JSON.stringify(computer)}) && [...r.querySelectorAll('button')].some((b) => b.textContent === 'Chat here'))`;
        let shown = false;
        for (let i = 0; i < 10 && !shown; i++) {
          await page.ev(`(document.querySelector('#connect').click(), true)`);
          shown = await page.until(listed, 6000);
          live();
          if (!shown) await page.ev(`([...document.querySelectorAll('.sbag-box button')].find((b) => b.textContent === 'Cancel')?.click(), true)`);
        }
        if (!shown) throw new Error(`the Connect dialog doesn't list ${computer} with Chat here: ` + (await page.ev(`[...document.querySelectorAll('.sbag-box')].at(-1)?.textContent ?? ''`)));
        await page.ev(`(() => { window.__whoSeen = []; new MutationObserver(() => window.__whoSeen.push(document.querySelector('#who').textContent)).observe(document.querySelector('#who'), { childList: true, subtree: true, characterData: true }); return true; })()`);
        await page.ev(`([...[...document.querySelectorAll('.sbag-box .runner')].find((r) => r.textContent.includes(${JSON.stringify(computer)})).querySelectorAll('button')].find((b) => b.textContent === 'Chat here').click(), true)`);
        if (opts.runnerLate) { await sleep(opts.runnerLate); await startRunner(); }
        await allow(page, grant);
        live();
        if (!(await page.until(`document.querySelector('#who').textContent.includes(${JSON.stringify("on " + computer)})`, 30000))) throw new Error("not connected after Allow: " + (await page.ev(`document.querySelector('#who').textContent`)));
        S.started = JSON.parse(readFileSync(join(script, "started.json"), "utf8"));
        // (the agent runs on the computer: under the runner, the runner's own child)
        if (!(S.started.ppid === S.runner.pid || ppidOf(S.started.pid) === S.runner.pid)) throw new Error(`the agent (pid ${S.started.pid}) isn't the runner's child (runner ${S.runner.pid})`);
        surface.agentHost = S.started.host;
        surface.whoSeen = await page.ev(`window.__whoSeen ?? []`);
      } catch (e) {
        // (enrollment refused, or closed meanwhile: the login ends with it, never left polling)
        await endGroup(S.login, "sagebrush remote login", () => CLEANUP_MS);
        throw e;
      }
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
      // (the turn's end, never left to reject on its own: what goes wrong is a failure of the case, unless the surface
      //  was closed meanwhile, which stops it on purpose)
      S.ending = command({ end: true, text }).catch((e) => { if (!S.closed) S.failures.push("the turn's end: " + e.message); });
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
    /** Disconnect: the runner ends the agent (its process gone); every process this surface started killed and
     *  reaped; the computer revoked and checked gone; everything removed. All within CLOSE_MS: what isn't done by
     *  then is a failure of the case. */
    async close() {
      const end = Date.now() + CLOSE_MS, left = () => Math.max(0, end - Date.now());
      // (a turn's end still on its way gets a moment to finish first, so a case that ended normally closes cleanly)
      if (S.ending) await Promise.race([S.ending, sleep(Math.min(1000, left()))]);
      S.closed = true;
      S.abort.abort();
      try {
        if (S.started) {
          await bounded(page.ev(`([...document.querySelectorAll('.sbag-bar button')].find((b) => b.textContent === 'Disconnect')?.click(), true)`), Math.max(1, Math.min(1000, left())), "Disconnect").catch(() => {});
          for (const t = Date.now(); Date.now() - t < Math.min(1500, left()) && alive(S.started.pid); ) await sleep(50);
          if (alive(S.started.pid)) S.failures.push("Disconnect: the agent's process on the computer is still there");
        }
      } finally {
        // (the login, the runner and the agent, each with its group, ended outright and checked reaped)
        if (S.started && alive(S.started.pid)) { try { process.kill(-S.started.pid, "SIGKILL"); } catch {} try { process.kill(S.started.pid, "SIGKILL"); } catch {} }
        for (const [p, what] of [[S.login, "sagebrush remote login"], [S.runner, "the runner"]]) { const f = await endGroup(p, what, left); if (f) S.failures.push(f); }
        if (S.started) { for (; left() > 0 && alive(S.started.pid); ) await sleep(25); if (alive(S.started.pid)) S.failures.push(`the agent (pid ${S.started.pid}): still running after the close`); }
        if (S.revoke) await S.revoke(left).catch((e) => S.failures.push(`${computer} wasn't revoked: ${e.message}`));
        rmSync(tmp, { recursive: true, force: true });
      }
      return S.failures;
    },
  };
  return surface;
}
