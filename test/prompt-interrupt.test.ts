import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ctrl-C at the interactive prompt: the prompt's inputs run in a worker, this process's main thread keeps the
// terminal, and a Ctrl-C while an input runs reaches it, a call into the engine included. The prompt then comes back,
// the session as it was. Each case runs the prompt in a pseudo-terminal (script -qfec), types its inputs and presses
// Ctrl-C as a person does (the byte 0x03).
const CLI = join(__dirname, "..", "src", "cli.js");
const hasScript = spawnSync("sh", ["-c", "command -v script"]).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// (the terminal's control sequences, and its echo of a pressed Ctrl-C, out of the text)
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "").replace(/^(\^C)+/gm, "");

// (again: the next press of the same gesture, a double tap: it keeps the first press's mark and time, so the
// acknowledgment of the first press, which may come before it, still counts)
type Step = { send?: string } | { press: true; again?: boolean } | { signal: NodeJS.Signals; group?: boolean } | { wait: number } | { until: RegExp; ms?: number };

/** A measured allowance for a promptness bound: `base` ms on an idle machine, plus four of the session's own round
 * trips of a trivial input (rtt), so that a loaded runner, slower at everything, isn't held to an idle one's clock. */
const allowed = (base: number, rtt: number) => base + 4 * Math.max(0, rtt);

/** The pids of the processes under PID (script's child: sagebrush itself, by exec). */
const children = (pid: number) =>
  spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);

/** The prompt (sagebrush ARGS) in a pty, the steps played in order; its text and how it ended. */
async function prompt(args: string[], steps: Step[], env: Record<string, string> = {}, o: { node?: string[]; then?: string } = {}) {
  // (exec: the shell script starts gives way to sagebrush, so the status is sagebrush's own; o.then: a command run
  // in the same terminal after sagebrush ends instead)
  const quote = (a: string) => `'${a}'`;
  const run = [process.execPath, ...(o.node ?? []), CLI, ...args].map(quote).join(" ");
  const cmd = o.then === undefined ? `exec ${run}` : `${run}; ${o.then}`;
  // (TERM: a terminal that edits lines; with TERM=dumb, as some shells run, Node's readline has no completion, and
  // redraws no prompt)
  const p = spawn("script", ["-qfec", cmd, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"], detached: true, env: { ...process.env, TERM: "xterm", ...env } });
  let out = "";
  p.stdout!.on("data", (d) => (out += d));
  p.stderr!.on("data", (d) => (out += d));
  let ended: { code: number | null; t: number } | null = null;
  const t0 = Date.now();
  p.on("exit", (code) => (ended = { code, t: Date.now() - t0 }));
  const seen: Record<string, number> = {};
  // (rtt: each awaited pattern's time since the last input sent, a round trip at the prompt)
  const rtt: Record<string, number> = {};
  let pressedAt = 0, sentAt = 0;
  // (an `until` looks only at the output after the last input, Ctrl-C or signal: a prompt already on the screen
  // isn't the next one.  On a loaded runner the first inputs were still running when a stale match of the banner's
  // prompt let the next steps go ahead, and the Ctrl-C meant for the long sum interrupted them instead.)
  let mark = 0;
  try {
    for (const s of steps) {
      if ("send" in s && s.send !== undefined) {
        mark = out.length;
        sentAt = Date.now();
        p.stdin!.write(s.send);
      }
      if ("press" in s) {
        if (!s.again) {
          mark = out.length;
          pressedAt = Date.now();
        }
        p.stdin!.write("\x03");
      }
      if ("signal" in s) {
        mark = out.length;
        pressedAt = Date.now();
        // (group: to sagebrush's process group, as a shell's kill -INT -PGID; script makes its child a group leader)
        for (const c of children(p.pid!)) process.kill(s.group ? -c : c, s.signal);
      }
      if ("wait" in s) await sleep(s.wait);
      if ("until" in s) {
        const t = Date.now();
        const fresh = () => s.until.test(plain(out.slice(mark)));
        while (!fresh() && Date.now() - t < (s.ms ?? 20000) && ended === null) await sleep(20);
        seen[String(s.until)] = fresh() ? Date.now() - pressedAt : -1;
        rtt[String(s.until)] = fresh() ? Date.now() - sentAt : -1;
      }
    }
    for (let t = Date.now(); ended === null && Date.now() - t < 10000; ) await sleep(20);
  } finally {
    if (ended === null) try { process.kill(-p.pid!, "SIGKILL"); } catch {}
  }
  return { out: plain(out), ended: ended as { code: number | null; t: number } | null, seen, rtt };
}

test("a Python loop at the prompt: Ctrl-C raises KeyboardInterrupt, and the session goes on", { skip: !hasScript && "no script(1)", timeout: 90000 }, async () => {
  const r = await prompt([], [
    { until: />>> $/, ms: 30000 },
    { send: "k = 0\r" },
    { send: "while True: k += 1\r\r" },
    { wait: 1500 },
    { press: true },
    { until: /KeyboardInterrupt\n>>> $/ },
    { send: "print('k counted', k > 0)\r" },
    { until: /k counted True/ },
    { send: "exit()\r" },
  ]);
  assert.match(r.out, /Traceback \(most recent call last\):\n  File "<stdin>", line 1, in <module>\n    while True: k \+= 1\nKeyboardInterrupt\n/, r.out);
  assert.match(r.out, /k counted True/, r.out);
  assert.deepEqual(r.ended?.code, 0, r.out);
});

test("a call into the engine (Sage's factor): Ctrl-C stops it, KeyboardInterrupt, and the prompt takes the next input", { skip: !hasScript && "no script(1)", timeout: 120000 }, async () => {
  const r = await prompt(["--sage"], [
    { until: /sage: $/, ms: 60000 },
    // (a product of two primes of 40 digits, above the quadratic sieve's range: hours for the engine's factor_integer)
    { send: "n = next_prime(10^39) * next_prime(3 * 10^39)\r" },
    { until: /sage: $/ },
    // (a round trip at the prompt, measured: the allowance below)
    { send: "1 + 1\r" },
    { until: /\n2\nsage: $/ },
    { send: "r = factor(n)\r" },
    { until: /r = factor\(n\)\n$/ },
    { wait: 2000 },
    { press: true },
    { until: /KeyboardInterrupt\nsage: $/, ms: 10000 },
    { send: "2^10\r" },
    { until: /\n1024\n/ },
    { send: "exit()\r" },
  ]);
  assert.match(r.out, /in factor_integer\n[\s\S]*_sbengine\.call[\s\S]*\nKeyboardInterrupt\n/, r.out);
  // (it stops within the matrix's Stop bound's order: the engine polls the flag; 2 s idle, measured slack under load)
  const stopped = r.seen[String(/KeyboardInterrupt\nsage: $/)];
  assert.ok(stopped >= 0 && stopped < allowed(2000, r.rtt[String(/\n2\nsage: $/)]), JSON.stringify({ seen: r.seen, rtt: r.rtt }));
  assert.match(r.out, /\n1024\n/, r.out);
  assert.equal(r.ended?.code, 0, r.out);
});

test("a second Ctrl-C 1 to 2 s after the first, while the first is unseen, ends the process as SIGINT's default", { skip: !hasScript && "no script(1)", timeout: 90000 }, async () => {
  const r = await prompt([], [
    { until: />>> $/, ms: 30000 },
    // (a regular expression that backtracks for minutes and does not look at the flag)
    { send: "import re; re.match(r'(a+)+$', 'a' * 40 + 'b')\r" },
    { wait: 1500 },
    { press: true },
    { wait: 1200 },
    { press: true },
  ]);
  // (script reports a child ended by SIGINT as 130)
  assert.ok(r.ended !== null && r.ended.code === 130, JSON.stringify(r.ended) + r.out);
});

test("a double tap (two Ctrl-C 50 ms apart) is one press: one KeyboardInterrupt, and the session goes on", { skip: !hasScript && "no script(1)", timeout: 90000 }, async () => {
  const r = await prompt([], [
    { until: />>> $/, ms: 30000 },
    { send: "k = 0\r" },
    { send: "while True: k += 1\r\r" },
    { wait: 1500 },
    { press: true },
    { wait: 50 },
    { press: true, again: true },
    // (the second tap may come after the prompt is back: then it is a Ctrl-C at an empty prompt, which redraws it)
    { until: /KeyboardInterrupt\n>>> (?:\n>>> )?$/ },
    // (and the second press doesn't wait for the next input: it is gone)
    { send: "import time; time.sleep(1.5); print('k counted', k > 0)\r" },
    { until: /k counted True\n>>> $/ },
    { send: "exit()\r" },
  ]);
  // (the interrupt seen, whether before or after the second tap: not a wait that timed out)
  assert.ok(r.seen[String(/KeyboardInterrupt\n>>> (?:\n>>> )?$/)] >= 0, JSON.stringify(r.seen) + r.out);
  assert.equal(r.out.match(/KeyboardInterrupt/g)?.length, 1, r.out);
  assert.match(r.out, /k counted True/, r.out);
  assert.equal(r.ended?.code, 0, r.out);
});

test("the terminal leaves raw mode however the prompt's front ends, an uncaught exception included", { skip: !hasScript && "no script(1)", timeout: 90000 }, async () => {
  // (a preload throws on this process's main thread once the front has put the terminal in raw mode, and reports at
  // the exit, after the front's own handlers, whether the terminal was put back; stty then reads the terminal itself)
  const dir = mkdtempSync(join(tmpdir(), "sb-prompt-int-"));
  try {
    const pre = join(dir, "throw-after-raw.cjs");
    writeFileSync(pre, [
      `const { isMainThread } = require("node:worker_threads");`,
      `if (isMainThread && process.stdin.isTTY) {`,
      `  const set = process.stdin.setRawMode.bind(process.stdin);`,
      `  let raw = false, planted = false;`,
      `  process.stdin.setRawMode = (on) => { raw = on; set(on);`,
      `    if (on && !planted) { planted = true; setTimeout(() => {`,
      `      process.on("exit", () => require("node:fs").writeSync(2, "RAW AT EXIT " + raw + "\\n"));`,
      `      throw new Error("planted failure in the front");`,
      `    }, 3000); }`,
      `    return process.stdin; };`,
      `}`,
    ].join("\n"));
    const r = await prompt([], [{ until: /RAW AT EXIT/, ms: 30000 }, { until: /speed/, ms: 10000 }], {}, { node: ["--require", pre], then: "stty -a" });
    assert.match(r.out, /planted failure in the front/, r.out);
    assert.match(r.out, /RAW AT EXIT false\n/, r.out);
    // (canonical mode and echo back on, as the shell had them)
    assert.match(r.out, /(^|\s)icanon(\s|$)/m, r.out);
    assert.match(r.out, /(^|\s)echo(\s|$)/m, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Ctrl-C while the prompt waits clears the line; Tab completes from the session", { skip: !hasScript && "no script(1)", timeout: 90000 }, async () => {
  const r = await prompt([], [
    { until: />>> $/, ms: 30000 },
    { send: "x = (1 +" },
    { press: true },
    { until: /KeyboardInterrupt\n>>> $/ },
    { send: "print(6 * 7 + 1)\r" },
    { until: /\n43\n>>> $/ },
    // (Tab: the session's names, from the worker)
    { send: "toolong_name = 7\r" },
    { until: /toolong_name = 7\n>>> $/ },
    { send: "toolo\t" },
    { wait: 500 },
    { send: " * 6\r" },
    { until: /\n42\n/ },
    { send: "\x04" },
  ]);
  assert.match(r.out, /KeyboardInterrupt\n>>> /, r.out);
  // (the cleared line's text isn't part of the next input)
  assert.match(r.out, /\n43\n/, r.out);
  assert.match(r.out, /\n42\n/, r.out);
  assert.equal(r.ended?.code, 0, r.out);
});

test("a line typed while an input runs waits its turn, echoed after that input's output", { skip: !hasScript && "no script(1)", timeout: 90000 }, async () => {
  const r = await prompt([], [
    { until: />>> $/, ms: 30000 },
    { send: "import time; time.sleep(1.5); print('A' * 3)\r" },
    { wait: 300 },
    { send: "print('B' * 3)\r" },
    { until: /\nBBB\n>>> $/ },
    { send: "exit()\r" },
  ]);
  assert.match(r.out, /\nAAA\n>>> print\('B' \* 3\)\nBBB\n>>> /, r.out);
  assert.equal(r.ended?.code, 0, r.out);
});

test("-i: Ctrl-C reaches the program, then the prompt, with the program's names", { skip: !hasScript && "no script(1)", timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-prompt-int-"));
  try {
    const f = join(dir, "prog.py");
    writeFileSync(f, "done = 0\nwhile True:\n    done += 1\n");
    const r = await prompt(["-i", f], [
      { wait: 2500 },
      { press: true },
      { until: /KeyboardInterrupt\n>>> $/ },
      { send: "print('done', done > 0)\r" },
      { until: /done True/ },
      { send: "exit(4)\r" },
    ]);
    assert.match(r.out, /done True/, r.out);
    assert.equal(r.ended?.code, 4, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A MATLAB script loaded with -i, then a loop at the MATLAB prompt that never calls the engine: Ctrl-C at the terminal,
// or SIGINT from elsewhere (kill -INT), stops it, and the script's variables are still there.
for (const how of ["Ctrl-C", "kill -INT"] as const) {
  test(`MATLAB, -i a script, a loop at the prompt: ${how} gives the prompt back, the script's variables kept`, { skip: !hasScript && "no script(1)", timeout: 90000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-prompt-int-"));
    try {
      const f = join(dir, "setup.m");
      writeFileSync(f, "sentinel = 4242;\n");
      const r = await prompt(["--matlab", "-q", "-i", f], [
        { until: />> $/, ms: 30000 },
        { send: "while true; spin=1; end\r" },
        { wait: 1500 },
        how === "Ctrl-C" ? { press: true } : { signal: "SIGINT" },
        { until: /KeyboardInterrupt\n>> $/, ms: 10000 },
        { send: "disp(sentinel)\r" },
        { until: /\n +4242\n>> $/ },
        { send: "exit\r" },
      ]);
      // (the interrupt as MATLAB's prompt shows it: no frames of the translation)
      assert.match(r.out, /\nKeyboardInterrupt\n>> /, r.out);
      assert.doesNotMatch(r.out, /Traceback/, r.out);
      assert.match(r.out, /\n +4242\n>> /, r.out);
      assert.equal(r.ended?.code, 0, r.out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// A session with state, then a long generator sum at the Sage prompt: Ctrl-C at the terminal, or SIGINT to the
// process group, stops it within a second (on a loaded machine, a second and four measured round trips), and the
// state is still there and usable.
for (const how of ["Ctrl-C", "kill -INT -pgid"] as const) {
  test(`Sage, a long sum at the prompt: ${how} stops it promptly, the session's state kept`, { skip: !hasScript && "no script(1)", timeout: 120000 }, async () => {
    const r = await prompt(["--sage"], [
      { until: /sage: $/, ms: 60000 },
      { send: "marker = 'kept'; P = matrix(QQ, [[1/2, 1/4], [1/5, 1/2]])\r" },
      { until: /\nsage: $/ },
      // (a round trip at the prompt, measured: the allowance below)
      { send: "1 + 1\r" },
      { until: /\n2\nsage: $/ },
      { send: "sum(i*i for i in range(1000000000))\r" },
      // (the sum's line taken, then a second of it running)
      { until: /range\(1000000000\)\)\n$/ },
      { wait: 1000 },
      how === "Ctrl-C" ? { press: true } : { signal: "SIGINT", group: true },
      { until: /KeyboardInterrupt\nsage: $/, ms: 8000 },
      { send: "print(marker, (identity_matrix(QQ, 2) - P).inverse())\r" },
      { until: /kept \[[^\n]*\n[^\n]*\]\nsage: $/ },
      { send: "exit()\r" },
    ]);
    // (within a second on an idle machine, against the sum's minutes; on a loaded one, measured slack: allowed)
    const stopped = r.seen[String(/KeyboardInterrupt\nsage: $/)];
    assert.ok(stopped >= 0 && stopped < allowed(1000, r.rtt[String(/\n2\nsage: $/)]), JSON.stringify({ seen: r.seen, rtt: r.rtt }) + r.out);
    // (N = (I - Q)^-1 of the friction run's absorbing chain)
    assert.match(r.out, /kept \[5\/2 5\/4\]\n\[  1 5\/2\]/, r.out);
    assert.equal(r.ended?.code, 0, r.out);
  });
}

test("SAGEBRUSH_NO_WORKER keeps the prompt on the main thread, as before", { skip: !hasScript && "no script(1)", timeout: 90000 }, async () => {
  const r = await prompt([], [
    { until: />>> $/, ms: 30000 },
    { send: "print(6 * 7)\r" },
    { until: /\n42\n/ },
    { send: "exit(3)\r" },
  ], { SAGEBRUSH_NO_WORKER: "1" });
  assert.match(r.out, /\n42\n/, r.out);
  assert.equal(r.ended?.code, 3, r.out);
});
