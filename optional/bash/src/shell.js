// The bash shell's module (plan-bash-shell r3, step 1): just-bash 3.6.0 and
// its dependencies, bundled by scripts/optional-packages.mjs into one
// self-contained ES module, run only in the shell worker that
// web/shell/worker-boot.js starts (its own CSP: no network, no eval).
//
// The worker hands start() a MessagePort to the page.  Everything the module
// tells the page goes through hostCall, with a literal message name from
// web/shell/host-levels.json: the publisher computes host_req from those
// names, and refuses any other postMessage.  Step 1's protocol is only this:
//   page -> module  {exec: {id, script, stdin?}}
//   module -> page  shell.ready {version}; shell.result {id, exitCode, stdout, stderr}
// The files are an in-memory file system here; the workspace's, through the
// page's mediator, are step 2.
import { Bash, InMemoryFs } from "../vendor/just-bash-3.6.0/browser.js";

export const VERSION = "0.1.0";

export function start(port) {
  function hostCall(name, payload) {
    port.postMessage({ name, payload });
  }
  const fs = new InMemoryFs();
  port.onmessage = async (e) => {
    const m = e.data;
    if (!m || typeof m !== "object" || !m.exec || typeof m.exec.script !== "string") return;
    const { id, script, stdin } = m.exec;
    let r;
    try {
      r = await new Bash({ fs, cwd: "/" }).exec(script, typeof stdin === "string" ? { stdin } : {});
    } catch (err) {
      r = { exitCode: -1, stdout: "", stderr: String(err && err.message) };
    }
    hostCall("shell.result", { id, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr });
  };
  hostCall("shell.ready", { version: VERSION });
}
