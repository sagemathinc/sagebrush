// ci: web-runner order=189
// The computer surface's own lifetime (surface-computer.mjs), with no relay, runner or browser: a stand-in PYTHON whose
// `remote login` prints a code and waits until the stand-in site approves it, as the real one does, and whose runner
// says it connected; and a stand-in site that holds the approval, refuses it or approves it (enrolling the computer),
// and lists and revokes the account's computers as the relay does.
//   - the surface reads what the Agents page's pane shows through the harness's one pane observer (PANE_CELLS);
//   - closed while the approval is pending: the login's process ends (reaped), the approval request is cancelled, the
//     connect stops there (no runner started, the page never touched), close reports nothing wrong;
//   - an enrollment refused: the connect fails saying so, and the login's process ends with it (never left polling);
//   - approved, then closed before the login has ended: the computer, enrolled by then, is revoked by the close;
//   - another computer of the account with the same name, from before: never revoked, only this run's; and one
//     still listed after its revocation is reported;
//   - a runner, and its child, that ignore TERM: the close kills them, checks them reaped, within CLOSE_MS;
//   - the runner's environment: this process's PATH and locale only, its own home, the site; nothing else;
//   - a deployed site: refused unless https and a regular 0600 cookie file holding one name=value;
//   - the site's end: upgraded sockets destroyed, a failing or hung Miniflare end reported, never swallowed.
//   node web/cloud/agent-flows/test-surface-computer-lifetime.mjs
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computerSurface, closeSite, deployedSite, CLOSE_MS } from "./surface-computer.mjs";
import { DEFAULT_GRANT, PANE_CELLS, CLEANUP_MS, sleep } from "../../agent-flows/harness.mjs";

let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : "")); if (!c) failures++; };
const running = (pid) => { try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "")[0] !== "Z"; } catch { return false; } };
const until = async (f, ms = 10000) => { for (const t = Date.now(); Date.now() - t < ms; await sleep(50)) if (f()) return true; return false; };

const tmp = mkdtempSync(join(tmpdir(), "sb-computer-life-"));
// (the stand-in interpreter: its preflight passes; `remote login` says its code as the real one does, then waits for
//  the site's approval (the file "approved"), unless "hold-login" says to go on waiting; a runner says it connected,
//  and with "stubborn" it and a child of its own ignore TERM. Each process it becomes says its pid, by kind, in
//  pids.txt, and the login writes its environment to env.txt: the rows find them there, not through the surface.)
const pids = join(tmp, "pids.txt");
const fake = join(tmp, "python");
writeFileSync(fake, `#!/bin/sh
case "$1" in
  -c) exit 0 ;;
esac
case "$*" in
  *"remote login"*)
    echo "login $$" >> "${pids}"
    env > "${tmp}/env.txt"
    printf 'To let this computer run code for your sagebrush account, open\\n  http://localhost/remote/activate\\nsigned in, and check that it shows the code ABCD-EFGH.  (Waiting 10 minutes.)\\n' >&2
    while [ ! -f "${tmp}/approved" ] || [ -f "${tmp}/hold-login" ]; do sleep 0.05; done
    exit 0 ;;
esac
echo "runner $$" >> "${pids}"
if [ -f "${tmp}/stubborn" ]; then
  trap '' TERM
  sh -c 'trap "" TERM; echo "runner-child $$" >> "${pids}"; while :; do sleep 1; done' &
fi
echo "Connected to the stand-in relay"
while :; do sleep 1; done
`);
const pidsOf = (kind) => (existsSync(pids) ? readFileSync(pids, "utf8") : "").split("\n").filter((l) => l.startsWith(kind + " ")).map((l) => Number(l.split(" ")[1]));
const reset = () => { writeFileSync(pids, ""); for (const f of ["approved", "hold-login", "stubborn", "env.txt"]) rmSync(join(tmp, f), { force: true }); };
chmodSync(fake, 0o700);
process.env.PYTHON = fake;
process.env.SB_LIFETIME_SECRET = "not-for-the-runner"; // (a variable of this process the runner must never see)

// (the stand-in site: /remote/activate held, refused as an account that may not connect a computer, or approved,
//  which enrolls the computer under its name; the account's computers listed and revoked as the relay does)
const site = { mode: "hold", asked: 0, held: [], peers: [], revoked: [], n: 0 };
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/remote/activate") {
    site.asked++;
    if (site.mode === "refuse") { res.writeHead(403, { "content-type": "text/html" }); res.end("<p>Connecting a computer isn't enabled for your account yet.</p>"); return; }
    if (site.mode === "approve") {
      site.peers.push({ name: site.name, remote_id: "r-new-" + ++site.n });
      writeFileSync(join(tmp, "approved"), "");
      res.writeHead(303, { location: "/remote/activated" }); res.end(); return;
    }
    site.held.push(res); // (never answered: the approval pending)
    return;
  }
  if (req.method === "GET" && req.url === "/api/remote/v1/peers") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ peers: site.peers })); return; }
  if (req.method === "POST" && req.url === "/api/remote/v1/revoke") {
    let body = "";
    req.on("data", (d) => { body += d; });
    // (sticky: the revocation answered, the computer kept, as a relay that failed to remove it)
    req.on("end", () => { const id = JSON.parse(body).remote_id; site.revoked.push(id); if (!site.sticky) site.peers = site.peers.filter((p) => p.remote_id !== id); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://localhost:${server.address().port}`;
// (the page: these rows end before any page step, so any use of it is a failure)
const used = [];
const page = new Proxy({}, { get: (_, k) => (...a) => { used.push(String(k)); throw new Error("the page was used: " + String(k)); } });
const surface = (computer) => computerSurface({ origin, cookie: "__Host-sb_session=x" }, page, { log: () => {}, ...(computer ? { computer } : {}) });

try {
  // ---- the pane: the surface reads it through the harness's one observer, never a null only the saved copy stands in for
  {
    const s = await surface();
    ok(s.liveCells === PANE_CELLS && /\.pane-body/.test(PANE_CELLS), "the computer surface reads the pane through the harness's pane observer");
    ok(/^lab-box-[0-9a-f]{12}$/.test(s.computer), "its computer's name is this run's own (lab-box- and 12 random hex digits)", s.computer);
    await s.close();
  }
  // ---- closed while the approval is pending
  {
    reset();
    site.mode = "hold";
    const s = await surface();
    const connecting = s.connect(DEFAULT_GRANT).then(() => "connected", (e) => e.message);
    ok(await until(() => pidsOf("login").length === 1 && site.asked === 1), "the login started and its code was sent for approval (held)");
    const [login] = pidsOf("login");
    ok(running(login), "…its process is running while the approval is pending");
    const problems = await s.close();
    ok(!running(login), "closed during the pending approval: the login's process is gone (ended and reaped)", { login });
    const said = await Promise.race([connecting, sleep(5000).then(() => "still waiting")]);
    ok(said !== "connected" && said !== "still waiting", `…the connect stopped there (${said})`);
    ok(pidsOf("runner").length === 0 && used.length === 0, "…no runner started and the page never touched", { runner: pidsOf("runner"), used });
    ok(Array.isArray(problems) && problems.length === 0, "…close reports nothing wrong", problems);
    await sleep(300);
    ok(!running(login), "…and nothing restarts it afterwards");
  }
  // ---- the runner's environment (the login's, the same one): this process's PATH and locale, its own home, the site
  {
    const env = Object.fromEntries(readFileSync(join(tmp, "env.txt"), "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const allowed = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "SAGEBRUSH_REMOTE_ORIGIN", "NO_PROXY", "no_proxy", "PWD", "SHLVL", "_", "OLDPWD"]);
    const extra = Object.keys(env).filter((k) => !allowed.has(k));
    ok(extra.length === 0 && !("SB_LIFETIME_SECRET" in env) && env.SAGEBRUSH_REMOTE_ORIGIN === origin && env.HOME?.startsWith(tmpdir()) && !Object.values(env).some((v) => v.includes("sb_session")), "the runner's environment: PATH and locale from here, its own home, the site; nothing else (no other variable, no session cookie)", { extra, home: env.HOME });
  }
  // ---- an enrollment refused
  {
    site.mode = "refuse";
    site.asked = 0;
    reset();
    const s = await surface();
    const said = await s.connect(DEFAULT_GRANT).then(() => "connected", (e) => e.message);
    ok(/the approval was refused \(403\)/.test(said), `a refused enrollment: the connect fails saying so (${said.slice(0, 120)})`);
    const [login] = pidsOf("login");
    ok(login > 0 && !running(login), "…and the login's process ended with it, not left polling", { login });
    ok(pidsOf("runner").length === 0 && used.length === 0, "…no runner started and the page never touched", { runner: pidsOf("runner"), used });
    const problems = await s.close();
    ok(Array.isArray(problems) && problems.length === 0, "…close after it reports nothing wrong", problems);
  }
  // ---- approved, then closed before the login has ended; another computer of the same name, from before, kept
  {
    site.mode = "approve";
    site.asked = 0;
    site.revoked = [];
    reset();
    writeFileSync(join(tmp, "hold-login"), "");
    const name = "lab-box-samename";
    site.name = name;
    site.peers = [{ name, remote_id: "r-someone-elses" }];
    const s = await surface(name);
    const connecting = s.connect(DEFAULT_GRANT).then(() => "connected", (e) => e.message);
    ok(await until(() => site.peers.some((p) => p.remote_id.startsWith("r-new-"))), "the approval went through: the computer is enrolled, its login still waiting");
    const [login] = pidsOf("login");
    const problems = await s.close();
    ok(site.revoked.length === 1 && site.revoked[0].startsWith("r-new-") && !site.peers.some((p) => p.remote_id.startsWith("r-new-")), "closed before the login ended: the computer this run enrolled is revoked, and checked gone", { revoked: site.revoked, peers: site.peers });
    ok(site.peers.some((p) => p.remote_id === "r-someone-elses") && !site.revoked.includes("r-someone-elses"), "…the account's other computer of the same name, from before, is never revoked", site.peers);
    ok(login > 0 && !running(login) && pidsOf("runner").length === 0 && used.length === 0, "…the login's process is gone, no runner started, the page never touched", { login, runner: pidsOf("runner"), used });
    ok(Array.isArray(problems) && problems.length === 0 && (await Promise.race([connecting, sleep(5000).then(() => "still waiting")])) !== "connected", "…close reports nothing wrong, and the connect stopped", problems);
    site.peers = [];
  }
  // ---- a revocation answered but the computer still listed: the close says so
  {
    site.mode = "approve";
    site.revoked = [];
    site.sticky = true;
    reset();
    writeFileSync(join(tmp, "hold-login"), "");
    const s = await surface();
    site.name = s.computer;
    const connecting = s.connect(DEFAULT_GRANT).catch(() => {});
    await until(() => site.peers.some((p) => p.name === s.computer));
    const problems = await s.close();
    await connecting;
    ok(problems.some((f) => /still enrolled after its revocation/.test(f)), "a computer still listed after its revocation: the close reports it", problems);
    site.sticky = false;
    site.peers = [];
  }
  // ---- a runner, and its child, that ignore TERM: killed and reaped within CLOSE_MS
  {
    site.mode = "approve";
    site.name = null;
    site.revoked = [];
    reset();
    writeFileSync(join(tmp, "stubborn"), "");
    const s = await surface();
    site.name = s.computer;
    const said = await s.connect(DEFAULT_GRANT).then(() => "connected", (e) => e.message);
    const [runner] = pidsOf("runner"), [kid] = pidsOf("runner-child");
    ok(/the page was used/.test(said) && runner > 0 && kid > 0 && running(runner) && running(kid), "the runner started (it and its child ignore TERM), then the connect stopped at the page", { said, runner, kid });
    const t0 = Date.now();
    const problems = await s.close();
    const took = Date.now() - t0;
    ok(!running(runner) && !running(kid) && took < CLOSE_MS + 500 && CLOSE_MS < CLEANUP_MS, `…the close killed both and checked them reaped, in ${took} ms (within CLOSE_MS ${CLOSE_MS}, under the harness's CLEANUP_MS)`, { runner: running(runner), kid: running(kid), took });
    ok(problems.length === 0 && site.revoked.length === 1, "…reporting nothing wrong, the computer revoked", { problems, revoked: site.revoked });
    site.peers = [];
  }
  // ---- a deployed site: https and a regular 0600 file holding one name=value, or refused
  {
    const good = join(tmp, "cookie-ok"), loose = join(tmp, "cookie-loose"), link = join(tmp, "cookie-link"), two = join(tmp, "cookie-two"), ctl = join(tmp, "cookie-ctl");
    writeFileSync(good, "__Host-sb_session=abc123\n", { mode: 0o600 });
    writeFileSync(loose, "__Host-sb_session=abc123\n", { mode: 0o644 });
    chmodSync(loose, 0o644);
    symlinkSync(good, link);
    writeFileSync(two, "a=b; c=d\n", { mode: 0o600 });
    writeFileSync(ctl, "a=b\u0007\n", { mode: 0o600 });
    const refused = (o) => { try { deployedSite(o); return false; } catch { return true; } };
    const d = deployedSite({ origin: "https://dev.sagebrush.space", cookieFile: good });
    ok(d.origin === "https://dev.sagebrush.space" && d.cookie === "__Host-sb_session=abc123", "a deployed site: an https origin and a 0600 file with one name=value is taken");
    const cases = { "an http origin": { origin: "http://dev.sagebrush.space", cookieFile: good }, "an origin with a path": { origin: "https://dev.sagebrush.space/x", cookieFile: good }, "a file others can read": { origin: "https://dev.sagebrush.space", cookieFile: loose }, "a link": { origin: "https://dev.sagebrush.space", cookieFile: link }, "two cookies": { origin: "https://dev.sagebrush.space", cookieFile: two }, "a control character": { origin: "https://dev.sagebrush.space", cookieFile: ctl } };
    const taken = Object.entries(cases).filter(([, o]) => !refused(o)).map(([k]) => k);
    ok(taken.length === 0, "…and each other form refused: " + Object.keys(cases).join(", "), taken);
  }
  // ---- the site's end: an upgraded socket destroyed; a failing or hung Miniflare end reported, within its bound
  {
    const up = createServer();
    const upgraded = new Set();
    up.on("upgrade", (req, sock) => { upgraded.add(sock); sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); });
    await new Promise((r) => up.listen(0, "127.0.0.1", r));
    const client = connect(up.address().port, "127.0.0.1");
    let clientClosed = false;
    client.on("close", () => { clientClosed = true; });
    client.on("error", () => {});
    client.resume(); // (read what comes, so its end is seen)
    await new Promise((r) => client.on("connect", r));
    client.write("GET /remote/x HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    await until(() => upgraded.size === 1, 3000);
    const failing = await closeSite({ server: up, upgraded, mf: { dispose: async () => { throw new Error("workerd crashed"); } } });
    ok(await until(() => clientClosed, 3000) && !up.listening, "the site's end destroys an open upgraded socket and closes the server");
    ok(failing.length === 1 && /Miniflare's end: workerd crashed/.test(failing[0]), "…a failing Miniflare end is reported, not swallowed", failing);
    const t0 = Date.now();
    const hung = await closeSite({ mf: { dispose: () => new Promise(() => {}) } });
    const took = Date.now() - t0;
    ok(hung.length === 1 && /Miniflare's end: no answer in/.test(hung[0]) && took < CLEANUP_MS + 1000, `…a hung Miniflare end is reported after its bound (${took} ms)`, hung);
  }
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  for (const pid of [...pidsOf("login"), ...pidsOf("runner"), ...pidsOf("runner-child")]) try { process.kill(pid, "SIGKILL"); } catch {}
  for (const r of site.held) r.destroy();
  server.closeAllConnections?.();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `test-surface-computer-lifetime: ${failures} failed` : "test-surface-computer-lifetime: all passed");
process.exit(failures ? 1 : 0);
