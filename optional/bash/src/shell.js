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
//   module -> page  shell.ready {version}
//                   shell.result {id, exit: {code, stdout, stderr}}  (exec() resolved: a real exit)
//                   shell.result {id, rejected: {message}}           (exec() rejected: never a status)
// The files are an in-memory file system here; the workspace's, through the
// page's mediator, are step 2.
import { Bash, InMemoryFs } from "../vendor/just-bash-3.6.0/browser.js";

export const VERSION = "0.1.0";

// The commands the first release registers (plan-bash-shell r3 §8), and no
// others: no network command, no python or js-exec, nothing deferred (tee,
// xargs, tar, gzip, sqlite3, ...).  The interpreter's own builtins (cd,
// export, test and 35 more, listed in ../README.md) are always there.
export const COMMANDS = [
  "ls", "cat", "head", "tail", "wc", "mkdir", "mv", "cp", "rm", "touch", "stat", "tree", "find",
  "grep", "sort", "uniq", "cut", "tr", "sed", "awk", "diff",
  "echo", "printf", "pwd", "basename", "dirname", "env", "true", "false", "seq",
  "jq",
];

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
      r = await new Bash({ fs, cwd: "/", commands: COMMANDS }).exec(script, typeof stdin === "string" ? { stdin } : {});
    } catch (err) {
      // (a rejection is reported as one: r3 §7.4, D8 point 5)
      hostCall("shell.result", { id, rejected: { message: String((err && err.message) || err) } });
      return;
    }
    hostCall("shell.result", { id, exit: { code: r.exitCode, stdout: r.stdout, stderr: r.stderr } });
  };
  hostCall("shell.ready", { version: VERSION });
}
