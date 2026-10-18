// Ctrl-C in a program the CLI runs (the launcher, build/cli/pyjs, runs it in
// a worker thread): SIGINT raises KeyboardInterrupt inside it, so `except
// KeyboardInterrupt` and `finally` run; an uncaught one prints CPython's
// traceback and ends the process by SIGINT (a shell's 130); time.sleep ends
// at once; a call that does not poll (input() on a pipe) gives way to a
// second Ctrl-C; and stdout and stderr come out in the order written, as on
// the main thread.  Under Node, Deno and Bun, and the Deno executable when
// it is built.
//   node web/test-cli-sigint.mjs [launcher]
//   (default packages/sagebrush/bin/sagebrush.cjs, the npm package's
//   command, with the bundle node scripts/build-cli.mjs puts beside it in
//   dist/; a .cjs, which Deno runs as CommonJS)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const launcher = process.argv[2] ?? new URL("../packages/sagebrush/bin/sagebrush.cjs", import.meta.url).pathname;
const exe = new URL("../build/cli/pyjs-deno", import.meta.url).pathname;
const has = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
const runtimes = [["node", [process.execPath, launcher]]];
if (has("deno")) runtimes.push(["deno", ["deno", "run", "-A", launcher]]);
if (has("bun")) runtimes.push(["bun", ["bun", launcher]]);
if (existsSync(exe)) runtimes.push(["deno executable", [exe]]);
const dir = mkdtempSync(join(tmpdir(), "sb-sigint-"));
const file = (name, src) => {
  const p = join(dir, name);
  writeFileSync(p, src);
  return p;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// run cmd, send SIGINT (`signals` times, `gap` ms apart) once it has printed
// "go", and collect what it printed (stdout and stderr apart) and how it ended
function interrupted(cmd, { signals = 1, gap = 300, limit = 20000, stdin = "ignore" } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd.slice(1), { stdio: [stdin, "pipe", "pipe"] });
    let out = "", err = "", sent = 0;
    const t0 = Date.now();
    const timer = setTimeout(() => p.kill("SIGKILL"), limit);
    p.stdout.on("data", async (d) => {
      out += d;
      if (sent === 0 && out.includes("go\n")) {
        for (sent = 1; sent <= signals; sent++) {
          await sleep(sent === 1 ? 200 : gap);
          p.kill("SIGINT");
        }
      }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ out, err, code, signal, ms: Date.now() - t0 });
    });
  });
}

const caught = file("caught.py", "import time\nprint('go', flush=True)\ntry:\n    try:\n        while True:\n            pass\n    finally:\n        print('finally')\nexcept KeyboardInterrupt:\n    print('caught KeyboardInterrupt')\nprint('after')\n");
const uncaught = file("uncaught.py", "def spin():\n    while True:\n        pass\nprint('go', flush=True)\nspin()\n");
const sleeps = file("sleeps.py", "import time\nprint('go', flush=True)\nt = time.monotonic()\ntry:\n    time.sleep(30)\nexcept KeyboardInterrupt:\n    print('slept', round(time.monotonic() - t) < 5)\n");
const reads = file("reads.py", "print('go', flush=True)\ninput()\n");
const order = file("order.py", "import sys\nfor i in range(3):\n    print('out', i)\n    sys.stdout.flush()\n    sys.stderr.write(f'err {i}\\n')\n    sys.stderr.flush()\nprint('last out', flush=True)\nraise ValueError('the end')\n");

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ": " + detail}`);
};
for (const [rt, cmd] of runtimes) {
  let r = await interrupted([...cmd, caught]);
  check(`${rt}: except and finally run`, r.out === "go\nfinally\ncaught KeyboardInterrupt\nafter\n" && r.code === 0, JSON.stringify(r));
  r = await interrupted([...cmd, uncaught]);
  check(`${rt}: uncaught, CPython's traceback and SIGINT`, r.signal === "SIGINT" && /^Traceback \(most recent call last\):\n[\s\S]*, in spin\n[\s\S]*\nKeyboardInterrupt\n$/.test(r.err), JSON.stringify(r));
  r = await interrupted([...cmd, sleeps]);
  check(`${rt}: time.sleep ends at once`, r.out === "go\nslept True\n" && r.code === 0 && r.ms < 10000, JSON.stringify(r));
  // (input() on a pipe that stays open: the first Ctrl-C is not seen until the
  // read returns; a second within 2 s ends the process)
  r = await interrupted([...cmd, reads], { signals: 2, gap: 500, stdin: "pipe" });
  check(`${rt}: a second Ctrl-C ends a blocked read`, r.signal === "SIGINT" || /KeyboardInterrupt\n$/.test(r.err), JSON.stringify(r));
  // the order of stdout and stderr, one pipe for both, against the main thread's
  const both = (env) => spawnSync("sh", ["-c", '"$@" 2>&1', "sh", ...cmd, order], { encoding: "utf8", env: { ...process.env, ...env } });
  const w = both({}), m = both({ SAGEBRUSH_NO_WORKER: "1" });
  check(`${rt}: stdout and stderr in order, as on the main thread`, w.stdout === m.stdout && w.status === 1 && m.status === 1 && /^out 0\nerr 0\nout 1\nerr 1\nout 2\nerr 2\nlast out\nTraceback/.test(w.stdout), JSON.stringify([w.stdout, m.stdout, w.status, m.status]));
  // exit statuses and a program on stdin, as before
  const st = spawnSync(cmd[0], [...cmd.slice(1), "-c", "import sys; sys.exit(3)"]);
  check(`${rt}: sys.exit(3)`, st.status === 3, String(st.status));
  const si = spawnSync(cmd[0], cmd.slice(1), { input: "print(6 * 7)\n", encoding: "utf8" });
  check(`${rt}: a program on stdin`, si.stdout === "42\n" && si.status === 0, JSON.stringify([si.stdout, si.stderr]));
}
process.exit(failed ? 1 : 0);
