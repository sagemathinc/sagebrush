import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The bash shell's oracle freeze (plan-bash-shell r3, step 0).  The cases are
// test/bash-oracle-cases.json; test/bash-oracle.json is what GNU bash, IPython
// and CPython did with them (test/bash_oracle.py); test/bash-known.json is
// every difference of just-bash 3.6.0 from GNU bash that the plan accepts
// (§3.3, D1 D2 D6 D7), each with what just-bash does instead.  So a redirection
// case passes only if just-bash does exactly what GNU bash does, or exactly
// what the accepted difference says: a new difference, or a change in a known
// one, fails here.  The later steps' adapter is held to the same file.
const dir = __dirname + "/../../test/";
const cases = JSON.parse(readFileSync(dir + "bash-oracle-cases.json", "utf8"));
const oracle = JSON.parse(readFileSync(dir + "bash-oracle.json", "utf8"));
const known: { redirections: Record<string, { plan: string; reason: string; differs: Record<string, unknown> }> } = JSON.parse(readFileSync(dir + "bash-known.json", "utf8"));
// (the CommonJS build of the pinned devDependency)
const { Bash, InMemoryFs } = require("just-bash");

// bytes as a string when they are UTF-8, else their values (as bash_oracle.py writes them)
const text = (b: Uint8Array): string | number[] => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return [...b];
  }
};
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const byId = (list: { id: string }[]) => new Map(list.map((x) => [x.id, x]));

// just-bash's InMemoryFs makes missing parent folders on a write; a POSIX
// file system (and the workspace) doesn't.  So the cases run over it with
// that one rule changed: a write whose folder is missing is ENOENT, as open(2)
// gives it, and the interpreter's handling of the error is what's compared.
function posixParents(inner: any) {
  const parentOf = (p: string) => p.replace(/\/[^/]*$/, "") || "/";
  return new Proxy(inner, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== "function") return v;
      if (k !== "writeFile" && k !== "appendFile") return v.bind(t);
      return async (p: string, ...rest: unknown[]) => {
        if (!(await t.exists(parentOf(p)))) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
        return v.call(t, p, ...rest);
      };
    },
  });
}

async function inJustBash(script: string) {
  const fs = posixParents(new InMemoryFs());
  for (const [name, content] of Object.entries(cases.setup)) await fs.writeFile("/" + name, typeof content === "string" ? content : new Uint8Array(content as number[]));
  // (a file system error at a redirection rejects exec() in just-bash 3.6.0: "rejects", D8)
  const r = await new Bash({ fs, cwd: "/" }).exec(script).catch(() => ({ exitCode: "rejects", stdout: "" }));
  const files: Record<string, string | number[] | null> = {};
  for (const name of cases.observe) files[name] = (await fs.exists("/" + name)) ? text(await fs.readFileBuffer("/" + name)) : null;
  return { exit: r.exitCode, stdout: text(latin1(r.stdout)), files };
}

test("the oracle file is current: every case has exactly one result, and nothing else", () => {
  for (const part of ["redirections", "ipython", "os_system"]) {
    assert.deepEqual(oracle[part].map((x: { id: string }) => x.id), cases[part].map((x: { id: string }) => x.id), part);
  }
  for (const id of Object.keys(known.redirections)) assert.ok(byId(cases.redirections).has(id), `bash-known.json names ${id}, which isn't a case`);
});

test("redirections: just-bash 3.6.0 does what GNU bash does, or exactly the accepted difference", async () => {
  const want = byId(oracle.redirections);
  const bad: string[] = [];
  for (const c of cases.redirections) {
    const o = want.get(c.id) as any;
    const expected = { exit: o.exit, stdout: o.stdout, files: o.files, ...(known.redirections[c.id]?.differs ?? {}) };
    const got = await inJustBash(c.script);
    try {
      assert.deepEqual(got, expected);
    } catch {
      bad.push(`${c.id} (${c.script}): just-bash ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}${known.redirections[c.id] ? ` (${known.redirections[c.id].plan})` : ""}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("the accepted differences are differences: each one's GNU bash result is not what just-bash does", () => {
  const want = byId(oracle.redirections);
  for (const [id, k] of Object.entries(known.redirections)) {
    const o = want.get(id) as any;
    for (const [field, value] of Object.entries(k.differs)) assert.notDeepEqual(o[field], value, `${id}.${field}`);
  }
});

// The oracle itself, again, where CI has it: GNU bash for the redirections
// and CPython for os.system.  (IPython isn't installed in CI; its part is
// frozen in the file, from the version recorded there.)
const hasBash = spawnSync("bash", ["--version"]).status === 0;
test("GNU bash here still does what the frozen oracle says (exit, stdout, files)", { skip: !hasBash && "no bash" }, () => {
  const want = byId(oracle.redirections);
  const bad: string[] = [];
  for (const c of cases.redirections) {
    const d = mkdtempSync(join(tmpdir(), "bash-oracle-"));
    try {
      for (const [name, content] of Object.entries(cases.setup)) writeFileSync(join(d, name), typeof content === "string" ? content : Buffer.from(content as number[]));
      const r = spawnSync("bash", ["-c", c.script], { cwd: d, env: { PATH: process.env.PATH, LC_ALL: "C" } });
      const files: Record<string, string | number[] | null> = {};
      for (const name of cases.observe) files[name] = existsSync(join(d, name)) ? text(readFileSync(join(d, name))) : null;
      const got = { exit: r.status, stdout: text(r.stdout), files };
      const o = want.get(c.id) as any;
      try {
        assert.deepEqual(got, { exit: o.exit, stdout: o.stdout, files: o.files });
      } catch {
        bad.push(`${c.id}: ${JSON.stringify(got)}`);
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }
  assert.deepEqual(bad, []);
});

const python = process.env.PYTHON ?? "python3";
const hasPython = spawnSync(python, ["-c", "pass"]).status === 0;
test("CPython's os.system still returns the wait status the oracle froze (exit code << 8)", { skip: !hasPython && "no python3" }, () => {
  for (const c of oracle.os_system) {
    const command = byId(cases.os_system).get(c.id) as any;
    const d = mkdtempSync(join(tmpdir(), "bash-oracle-"));
    try {
      const r = spawnSync(python, ["-I", "-c", "import os, sys\nv = os.system(sys.argv[1])\nopen(sys.argv[2], 'w').write(str(v))", command.command, join(d, "status")], { cwd: d, env: { PATH: process.env.PATH, LC_ALL: "C" } });
      assert.deepEqual({ status: Number(readFileSync(join(d, "status"), "utf8")), stdout: text(r.stdout), stderr: text(r.stderr) }, { status: c.status, stdout: c.stdout, stderr: c.stderr }, c.id);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

// Class A off is exactly +Infinity (§4.2 A): accepted, and a run past each of
// just-bash's own defaults isn't stopped.  The same run with the defaults is.
// (the just-bash limits behind §4.2's class A keys: script_ms, commands,
// loop_iterations, work_units)
const OFF = Object.fromEntries(
  ["maxExecutionTimeMs", "maxCommandCount", "maxLoopIterations", "maxAwkIterations", "maxSedIterations", "maxJqIterations", "maxWorkUnits"].map((k) => [k, Infinity]),
);
for (const [what, script, out] of [
  ["commands (default 100,000)", "i=0; while (( i++ < 100001 )); do :; done; echo $i", "100002\n"],
  ["awk loop iterations (default 100,000)", "awk 'BEGIN{for(i=0;i<100001;i++)n++; print n}'", "100001\n"],
]) {
  // (in a child process: under node:test's async hooks the same 100,001-step
  // run is about 8 times slower)
  test(`+Infinity is accepted for the own-computation limits and lifts just-bash's own default: ${what}`, () => {
    const run = (limits: object | null) => {
      const program = `const { Bash } = require(${JSON.stringify(require.resolve("just-bash"))});
        new Bash(${limits ? "{ executionLimits: JSON.parse(process.argv[1], (k, v) => (v === 'Infinity' ? Infinity : v)) }" : ""}).exec(process.argv[2]).then((r) => process.stdout.write(JSON.stringify([r.exitCode, r.stdout])));`;
      const r = spawnSync(process.execPath, ["-e", program, JSON.stringify(limits ?? {}, (k, v) => (v === Infinity ? "Infinity" : v)), script], { encoding: "utf8" });
      return JSON.parse(r.stdout);
    };
    assert.deepEqual(run(OFF), [0, out]);
    assert.notEqual(run(null)[0], 0, "with just-bash's defaults the same run is stopped");
  });
}

// The adapter will implement only the asynchronous file methods (§3.1): over
// such a file system, making the shell and running it writes nothing (no
// /bin, /dev or /proc of just-bash's default layout).
test("a file system without *Sync methods gets nothing written by making and starting the shell", async () => {
  const inner = new InMemoryFs();
  await inner.writeFile("/f", "old\n");
  const before = (await inner.readdir("/")).sort();
  const mutating = /^(writeFile|appendFile|mkdir|rm|cp|mv|createExclusive|symlink|link|chmod|utimes)$/;
  const calls: string[] = [];
  const fs = new Proxy(inner, {
    get(t, k) {
      if (typeof k === "string" && k.endsWith("Sync")) return undefined;
      const v = (t as any)[k];
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        if (typeof k === "string" && mutating.test(k)) calls.push(`${k}(${String(a[0])})`);
        return v.apply(t, a);
      };
    },
    has: (t, k) => !(typeof k === "string" && k.endsWith("Sync")) && k in t,
  });
  const sh = new Bash({ fs, cwd: "/" });
  const r = await sh.exec("true");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual((await inner.readdir("/")).sort(), before);
});
