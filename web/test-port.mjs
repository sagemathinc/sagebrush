// Ports for the browser tests, so that any number of test runs can share a
// machine (the shared test VM runs several CI runs at once): a test's
// Chrome is started with --remote-debugging-port=0, or CDP_PORT when it is
// set, and devtoolsPort() reads the port Chrome chose from its profile's
// DevToolsActivePort file; a server a test starts listens where freePort()
// says (port 0: the system's choice), or on port 0 itself; web/serve.py, on
// port 0, says the port it took once it is listening, and startServe() waits
// for that (no port chosen here that something else can take first).
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/** The DevTools port of a Chrome started with --remote-debugging-port=0 and
 * --user-data-dir=profile, once it is listening (within `ms`). */
export async function devtoolsPort(profile, ms = 60_000) {
  const t = Date.now();
  for (;;) {
    try {
      const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      if (port > 0) return port;
    } catch {}
    if (Date.now() - t > ms) throw new Error(`Chrome did not say its DevTools port within ${ms / 1000} s (${profile})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A port free now (the system's choice), for a server that must be told one. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** How long startServe waits for the port line, and the most it reads before it. */
export const SERVE_MS = 30_000, SERVE_OUT_MAX = 4096;
/** Start serve.py (spawnChild() spawns it with port 0) and learn its port: the one line it prints once it is
 * listening. Fails in words if it exits, can't start, says anything else, writes more than SERVE_OUT_MAX bytes
 * before that line (counted in bytes, before anything is kept), or is silent for `ms`; on every failure the child
 * is killed. Its listeners go once settled, and the rest
 * of its stdout is drained; stderr keeps only a 2,000-character tail (PR #103 review: LIMIT-PWA103-1/LIFE-PWA103-2). */
export function startServe(spawnChild, ms = SERVE_MS) {
  const child = spawnChild();
  let err = "";
  child.stderr?.on("data", (d) => { err = (err + d).slice(-2000); });
  const port = new Promise((resolve, reject) => {
    const kept = [];
    let bytes = 0;
    const settle = (f, v) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      child.stdout?.resume();
      f(v);
    };
    const fail = (why) => { try { child.kill("SIGKILL"); } catch {} settle(reject, new Error(why + (err ? " (stderr: " + err.slice(-500) + ")" : ""))); };
    // (the cap is in bytes and comes first: a chunk that would take what is kept past SERVE_OUT_MAX is refused before
    // it is kept or parsed, whether or not it holds a newline; PR #103 review, LIMIT-PWA103-1)
    const onData = (d) => {
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
      if (bytes + chunk.length > SERVE_OUT_MAX) return fail(`serve.py wrote more than ${SERVE_OUT_MAX} bytes before its port line`);
      bytes += chunk.length;
      kept.push(chunk);
      const out = Buffer.concat(kept);
      const nl = out.indexOf(0x0a);
      if (nl < 0) return;
      const line = out.subarray(0, nl).toString("utf8").trim();
      if (/^\d{1,5}$/.test(line) && +line > 0 && +line < 65536) settle(resolve, Number(line));
      else fail("serve.py said something other than its port: " + JSON.stringify(line.slice(0, 80)));
    };
    const onExit = (code, signal) => fail(`serve.py exited before listening (${code ?? signal})`);
    const onError = (e) => fail(`serve.py couldn't start (${e?.code ?? e})`);
    const timer = setTimeout(() => fail(`serve.py didn't say its port within ${ms / 1000} s`), ms);
    child.stdout.on("data", onData);
    child.on("exit", onExit);
    child.on("error", onError);
  });
  return { child, port };
}
