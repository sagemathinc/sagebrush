// ci: agent-flows-computer
// The computer surface's own lifetime (surface-computer.mjs), with no relay, runner or browser: a stand-in PYTHON whose
// `remote login` prints a code and waits, as the real one does until the code is approved, and a stand-in site that
// holds the approval or refuses it.
//   - closed while the approval is pending: the login's process ends (reaped), the approval request is cancelled, the
//     connect stops there (no runner started, the page never touched), close reports nothing wrong;
//   - an enrollment refused: the connect fails saying so, and the login's process ends with it (never left polling).
//   node web/agent-flows/test-surface-computer-lifetime.mjs
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computerSurface } from "./surface-computer.mjs";
import { DEFAULT_GRANT, sleep } from "./harness.mjs";

let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : "")); if (!c) failures++; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (f, ms = 10000) => { for (const t = Date.now(); Date.now() - t < ms; await sleep(50)) if (f()) return true; return false; };

const tmp = mkdtempSync(join(tmpdir(), "sb-computer-life-"));
// (the stand-in interpreter: its preflight passes; `remote login` says its code as the real one does, then waits)
// (each process it becomes says its pid, by kind, in pids.txt: the rows find them there, not through the surface)
const pids = join(tmp, "pids.txt");
const fake = join(tmp, "python");
writeFileSync(fake, `#!/bin/sh
case "$1" in
  -c) exit 0 ;;
esac
case "$*" in
  *"remote login"*) echo "login $$" >> "${pids}"; printf 'To let this computer run code for your sagebrush account, open\\n  http://localhost/remote/activate\\nsigned in, and check that it shows the code ABCD-EFGH.  (Waiting 10 minutes.)\\n' >&2; exec sleep 600 ;;
esac
echo "runner $$" >> "${pids}"
exec sleep 600
`);
const pidsOf = (kind) => (existsSync(pids) ? readFileSync(pids, "utf8") : "").split("\n").filter((l) => l.startsWith(kind + " ")).map((l) => Number(l.split(" ")[1]));
const reset = () => writeFileSync(pids, "");
chmodSync(fake, 0o700);
process.env.PYTHON = fake;

// (the stand-in site: /remote/activate held, or refused as an account that may not connect a computer)
const site = { mode: "hold", asked: 0, held: [] };
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/remote/activate") {
    site.asked++;
    if (site.mode === "refuse") { res.writeHead(403, { "content-type": "text/html" }); res.end("<p>Connecting a computer isn't enabled for your account yet.</p>"); return; }
    site.held.push(res); // (never answered: the approval pending)
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://localhost:${server.address().port}`;
// (the page: these rows end before any page step, so any use of it is a failure)
const used = [];
const page = new Proxy({}, { get: (_, k) => (...a) => { used.push(String(k)); throw new Error("the page was used: " + String(k)); } });

try {
  // ---- closed while the approval is pending
  {
    reset();
    const s = await computerSurface({ origin, cookie: "__Host-sb_session=x" }, page, { log: () => {} });
    const connecting = s.connect(DEFAULT_GRANT).then(() => "connected", (e) => e.message);
    ok(await until(() => pidsOf("login").length === 1 && site.asked === 1), "the login started and its code was sent for approval (held)");
    const [login] = pidsOf("login");
    ok(alive(login), "…its process is running while the approval is pending");
    const problems = await s.close();
    ok(!alive(login), "closed during the pending approval: the login's process is gone (ended and reaped)", { login });
    const said = await Promise.race([connecting, sleep(5000).then(() => "still waiting")]);
    ok(said !== "connected" && said !== "still waiting", `…the connect stopped there (${said})`);
    ok(pidsOf("runner").length === 0 && used.length === 0, "…no runner started and the page never touched", { runner: pidsOf("runner"), used });
    ok(Array.isArray(problems) && problems.length === 0, "…close reports nothing wrong", problems);
    await sleep(300);
    ok(!alive(login), "…and nothing restarts it afterwards");
  }
  // ---- an enrollment refused
  {
    site.mode = "refuse";
    site.asked = 0;
    reset();
    const s = await computerSurface({ origin, cookie: "__Host-sb_session=x" }, page, { log: () => {} });
    const said = await s.connect(DEFAULT_GRANT).then(() => "connected", (e) => e.message);
    ok(/the approval was refused \(403\)/.test(said), `a refused enrollment: the connect fails saying so (${said.slice(0, 120)})`);
    const [login] = pidsOf("login");
    ok(login > 0 && !alive(login), "…and the login's process ended with it, not left polling", { login });
    ok(pidsOf("runner").length === 0 && used.length === 0, "…no runner started and the page never touched", { runner: pidsOf("runner"), used });
    const problems = await s.close();
    ok(Array.isArray(problems) && problems.length === 0, "…close after it reports nothing wrong", problems);
  }
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  for (const pid of [...pidsOf("login"), ...pidsOf("runner")]) try { process.kill(pid, "SIGKILL"); } catch {}
  for (const r of site.held) r.destroy();
  server.closeAllConnections?.();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `test-surface-computer-lifetime: ${failures} failed` : "test-surface-computer-lifetime: all passed");
process.exit(failures ? 1 : 0);
