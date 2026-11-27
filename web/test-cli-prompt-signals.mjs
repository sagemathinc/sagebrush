// ci: checks.1 order=20
// Signals and the interactive prompt (the launcher runs it on its main
// thread, where a signal handler runs only when the thread is idle).  While
// the prompt waits for input, SIGTERM and SIGHUP remove its figures and end
// it; while it evaluates, they keep their default action, so a computation
// that never returns still ends, in a closed terminal too (SIGHUP), instead
// of running on unseen.  SIGINT keeps the prompt's own handler in both.
// A pty (python3's pty module) stands in for the terminal.
//   node web/test-cli-prompt-signals.mjs [launcher]
//   (default packages/sagebrush/bin/sagebrush.cjs, the npm package's
//   command, with the bundle node scripts/build-cli.mjs puts beside it)
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launcher = process.argv[2] ?? new URL("../packages/sagebrush/bin/sagebrush.cjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "sb-prompt-signals-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

// the driver: start the prompt on a pty, type each line of `lines` (waiting
// for its prompt to come back, unless it is the last and `busy`), then send
// `signal` and report how the process ended within `wait` seconds
const driver = join(dir, "drive.py");
writeFileSync(driver, `
import json, os, pty, select, signal, sys, time
spec = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.environ["TMPDIR"] = spec["tmp"]
    os.environ["TERM"] = "xterm"  # (a real cursor-writing terminal, regardless of the runner's TERM=dumb)
    if spec.get("inject"):
        os.environ["SAGEBRUSH_TEST_TERMINAL_ERROR"] = spec["inject"]
    if spec.get("noWorker"):
        os.environ["SAGEBRUSH_NO_WORKER"] = "1"
    os.execvp(spec["node"], [spec["node"]] + spec.get("nodeArgs", []) + [spec["launcher"]] + spec["args"])
out = b""
def read_until(pred, limit):
    global out
    end = time.time() + limit
    while time.time() < end and not pred():
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                out += os.read(fd, 65536)
            except OSError:
                return
prompts = lambda: out.count(b">>> ") + out.count(b"sage: ")  # (Python's prompt, and --sage's)
read_until(lambda: prompts() >= 1, 60)
for i, line in enumerate(spec["lines"]):
    n = prompts()
    os.write(fd, line.encode() + b"\\n")
    if i == len(spec["lines"]) - 1 and spec["busy"]:
        read_until(lambda: False, 1.5)  # (it runs: no prompt comes back)
    else:
        read_until(lambda: prompts() > n, 60)
busy_ok = prompts() == len(spec["lines"]) if spec["busy"] else True
t0 = time.time()
if spec["signal"] == "CLOSE":
    os.close(fd)  # (the terminal goes away: the kernel hangs up the session's foreground group)
elif spec["signal"] != "WAIT":
    os.kill(pid, getattr(signal, spec["signal"]))  # (straight to the launcher's process)
status = None
while time.time() - t0 < spec["wait"]:
    w, s = os.waitpid(pid, os.WNOHANG)
    if w:
        status = s
        break
    if spec["signal"] == "CLOSE":
        time.sleep(0.05)  # (nothing left to read)
    else:
        read_until(lambda: False, 0.05)
secs = time.time() - t0
if status is None:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
how = None if status is None else (("signal", os.WTERMSIG(status)) if os.WIFSIGNALED(status) else ("exit", os.WEXITSTATUS(status)))
print(json.dumps({"how": how, "secs": secs, "busy_ok": busy_ok, "plotted": b"Saved " in out, "injected": b"TERMINAL_ERROR_INJECTED" in out, "out": out.decode("utf8", "replace")[-400:]}))
`);

// Deterministically take the terminal-close window: readline writes the prompt, then cursorTo. Fail that next
// write through the stream's normal error event, without closing the real PTY or waiting for a scheduling race.
// This fixture injects an error; it does not handle it or introduce a delay.
const injectFile = join(dir, "terminal-error.cjs");
writeFileSync(injectFile, `
const { writeSync } = require('node:fs');
const [stream, code] = (process.env.SAGEBRUSH_TEST_TERMINAL_ERROR || '').split(':');
const stdout = process.stdout, original = stdout.write;
let prompts = 0, injected = false;
stdout.write = function(chunk, ...args) {
  const text = String(chunk);
  if (text.includes('>>> ') || text.includes('sage: ')) prompts++;
  if (!injected && prompts >= 2 && /at cursorTo /.test(new Error().stack || '')) {
    injected = true;
    writeSync(2, 'TERMINAL_ERROR_INJECTED\\n');
    process[stream].destroy(Object.assign(new Error('injected terminal failure'), { code }));
    return false;
  }
  return original.call(this, chunk, ...args);
};
`);

function prompt(lines, signal, { busy = false, wait = 2, args = [], inject, noWorker = false } = {}) {
  const tmp = mkdtempSync(join(dir, "tmp-"));
  const spec = { node: process.execPath, launcher, args, lines, signal, busy, wait, tmp, inject, noWorker, nodeArgs: inject ? ["--require", injectFile] : [] };
  const r = spawnSync("python3", [driver, JSON.stringify(spec)], { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) return { error: r.stderr || String(r.error), tmp };
  return { ...JSON.parse(r.stdout), tmp, figures: readdirSync(tmp).filter((f) => f.startsWith("sagebrush-figures-")) };
}

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ": " + JSON.stringify(detail)}`);
};
const SIGNUM = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
const PLOT = "import matplotlib.pyplot as plt; plt.plot([1, 2, 3]); plt.show()";
const BUSY = "while True: pass";
// (a flush hook that marks it was reached, flushed to the terminal, then never
// returns (Sagebrush's os has no write); the marker is built when the hook runs, so the terminal's echo of
// the entry can't match it, astra2)
const HOOK = "import _pyjs_open as f, sys; f._flush_all = lambda: (sys.stdout.write('FLUSH' + '_REACHED_%d' % 7), sys.stdout.flush(), exec('while True: pass'))";

for (const mode of [[], ["--sage"]]) {
  const m = mode.length ? " (--sage)" : "";
  for (const sig of ["SIGTERM", "SIGHUP"]) {
    // evaluating: the default action, at once (it ended the process even
    // though the computation never returns)
    let r = prompt([BUSY], sig, { busy: true, args: mode });
    check(`${sig} ends a computing prompt${m}`, r.busy_ok && r.how?.[0] === "signal" && r.how[1] === SIGNUM[sig] && r.secs < 2, r);
    // after the entry, Python's file flush that never returns (it is
    // Python code too): still busy, still the default action
    r = prompt([HOOK], sig, { busy: true, args: mode });
    check(`${sig} ends a prompt whose post-entry flush never returns${m}`, /FLUSH_REACHED_7/.test(r.out) && r.busy_ok && r.how?.[0] === "signal" && r.how[1] === SIGNUM[sig] && r.secs < 2, r);
    // waiting for input, after a computation and a figure: the prompt's
    // handler again, which removes the figures, then ends it by the signal
    r = prompt([PLOT, "6 * 7"], sig, { args: mode });
    check(`${sig} at the prompt removes its figures and ends it${m}`, r.how?.[0] === "signal" && r.how[1] === SIGNUM[sig] && r.figures?.length === 0 && /Saved \S+figure-1\.svg/.test(r.out) && /42/.test(r.out), r);
  }
}
// the terminal closed under it (its pty's master closed), busy or idle: the
// kernel's hangup ends it as the direct SIGHUP above does
{
  let r = prompt([BUSY], "CLOSE", { busy: true });
  check("closing its terminal ends a computing prompt", r.busy_ok && r.how !== null && r.secs < 2, r);
  r = prompt([PLOT], "CLOSE");
  check("closing its terminal at the prompt ends it and removes its figures", r.how !== null && r.figures?.length === 0, r);
}
// SIGINT is the prompt's own, evaluating or not: a computing prompt is not
// ended by it (the prompt runs user code on its thread, so nothing sees it
// until the computation returns: a known limit, a follow-up), and at the
// prompt it removes the figures and ends it, as before
let r = prompt([BUSY], "SIGINT", { busy: true });
check("SIGINT doesn't kill a computing prompt (its handler stays)", r.busy_ok && r.how === null, r);
r = prompt([PLOT], "SIGINT");
check("SIGINT at the prompt removes its figures, as before", r.how?.[0] === "signal" && r.how[1] === SIGNUM.SIGINT && r.figures?.length === 0, r);
for (const noWorker of [false, true]) {
  const mode = noWorker ? " (no worker)" : "";
  for (const stream of ["stdout", "stdin"]) {
    for (const code of ["EIO", "EPIPE", "ECONNRESET"]) {
      r = prompt([PLOT], "WAIT", { inject: `${stream}:${code}`, noWorker });
      check(`${stream} ${code} at cursorTo takes SIGHUP cleanup${mode}`, r.injected && r.plotted && r.how?.[0] === "signal" && r.how[1] === SIGNUM.SIGHUP && r.figures?.length === 0, r);
    }
    r = prompt([PLOT], "WAIT", { inject: `${stream}:ENOSPC`, noWorker });
    check(`${stream} unrelated errors are not swallowed${mode}`, r.injected && r.plotted && r.how?.[0] === "exit" && r.how[1] === 1 && /ENOSPC/.test(r.out), r);
  }
}
if (!existsSync(launcher)) check("the launcher exists", false, launcher);
process.exit(failed ? 1 : 0);
