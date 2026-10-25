import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The bash shell's oracle freeze (plan-bash-shell r3, step 0).  The cases are
// test/bash-oracle-cases.json; test/bash-oracle.json is what GNU bash, IPython
// and CPython did with them (test/bash_oracle.py); test/bash-known.json is
// every difference of just-bash 3.6.0 from GNU bash that the plan accepts
// (§3.3, D1 D2 D6 D7, and D8 of its addendum), each with what just-bash does
// instead, run as the shell host runs it (wrapped, D8).  So a redirection
// case passes only if just-bash does exactly what GNU bash does, or exactly
// what the accepted difference says: a new difference, or a change in a known
// one, fails here.  The later steps' adapter is held to the same file.
const dir = __dirname + "/../../test/";
const cases = JSON.parse(readFileSync(dir + "bash-oracle-cases.json", "utf8"));
const oracle = JSON.parse(readFileSync(dir + "bash-oracle.json", "utf8"));
const known: { redirections: Record<string, { plan: string; reason: string; differs: Record<string, unknown> }> } = JSON.parse(readFileSync(dir + "bash-known.json", "utf8"));
// just-bash 3.6.0's CommonJS bundle, vendored unchanged (test/vendor/just-bash-3.6.0/vendor.json)
const VENDOR = dir + "vendor/just-bash-3.6.0/";
const vendor = JSON.parse(readFileSync(VENDOR + "vendor.json", "utf8"));
const JUST_BASH = VENDOR + "index.cjs";
const { Bash, InMemoryFs } = require(JUST_BASH);

test("the vendored just-bash files are the npm tarball's, by their recorded sha256", () => {
  for (const [name, f] of Object.entries(vendor.files) as [string, { sha256: string }][]) {
    assert.equal(createHash("sha256").update(readFileSync(VENDOR + name)).digest("hex"), f.sha256, name);
  }
});

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
// that one rule changed: a write whose folder is missing is refused, as
// open(2) refuses it, and the interpreter's handling of the error is what's
// compared.  `failAt: "commit"` refuses instead the final, non-empty write of
// such a path (the open succeeds, the content write fails: ENOSPC), which a
// refused workspace commit looks like.  `calls` records the writes asked for.
function posixParents(inner: any, failAt: "open" | "commit", calls: string[]) {
  const parentOf = (p: string) => p.replace(/\/[^/]*$/, "") || "/";
  return new Proxy(inner, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== "function") return v;
      if (k !== "writeFile" && k !== "appendFile") return v.bind(t);
      return async (p: string, data: unknown, ...rest: unknown[]) => {
        calls.push(`${String(k)} ${p} ${JSON.stringify(String(data))}`);
        if (!(await t.exists(parentOf(p)))) {
          if (failAt === "open" || String(data) !== "") throw Object.assign(new Error(`${failAt === "open" ? "ENOENT" : "ENOSPC"}: ${p}`), { code: failAt === "open" ? "ENOENT" : "ENOSPC" });
          return;
        }
        return v.call(t, p, data, ...rest);
      };
    },
  });
}

// The shell host runs every invocation as `{ SCRIPT\n}` (D8): in just-bash
// 3.6.0 a file system error at a redirection ends the innermost enclosing
// group, subshell or function body with status 1, keeping the output before
// it; with no enclosing one, exec() rejects and every output is lost.
const wrap = (script: string) => `{ ${script}\n}`;

async function inJustBash(script: string, { wrapped = true, failAt = "open" as "open" | "commit" } = {}) {
  const calls: string[] = [];
  const inner = new InMemoryFs();
  for (const [name, content] of Object.entries(cases.setup)) await inner.writeFile("/" + name, typeof content === "string" ? content : new Uint8Array(content as number[]));
  const fs = posixParents(inner, failAt, calls);
  const r = await new Bash({ fs, cwd: "/" }).exec(wrapped ? wrap(script) : script).catch(() => ({ exitCode: "rejects", stdout: "", stderr: "" }));
  const files: Record<string, string | number[] | null> = {};
  for (const name of cases.observe) files[name] = (await inner.exists("/" + name)) ? text(await inner.readFileBuffer("/" + name)) : null;
  return { exit: r.exitCode, stdout: text(latin1(r.stdout)), stderr: text(latin1(r.stderr)), files, calls };
}
// (what's compared: exit, stdout and files, and stderr and calls where bash-known.json records them)
const compared = (got: any, k?: { differs: Record<string, unknown> }) => ({
  exit: got.exit,
  stdout: got.stdout,
  files: got.files,
  ...("stderr" in (k?.differs ?? {}) ? { stderr: got.stderr } : {}),
  ...("calls" in (k?.differs ?? {}) ? { calls: got.calls } : {}),
});

// (grader's GRADER-PR116-1: the inlined versions are just-bash's own lockfile's;
// what the bundle states about itself must agree with them)
test("the bundle's own license banner names only inlined packages, at the versions vendor.json records", () => {
  const text = readFileSync(JUST_BASH, "utf8");
  const banner = /Bundled license information:([\s\S]*?)\*\//.exec(text);
  assert.ok(banner, "index.cjs has its bundled-license banner");
  const versions = new Map((vendor.inlined as { name: string; version: string }[]).map((p) => [p.name, p.version]));
  const named: string[] = [];
  // (each entry: "<package>/<file>:" lines, then the comment, up to the next blank line)
  for (const entry of banner![1].split(/\n\s*\n/)) {
    const files = [...entry.matchAll(/^((?:@[\w.-]+\/)?[\w.-]+)\/[^\s:]*:\s*$/gm)].map((m) => m[1]);
    if (!files.length) continue;
    const name = files[0];
    named.push(name);
    assert.ok(versions.has(name), `${name} is in the banner but not in vendor.json's inlined packages`);
    const stated = /@version v(\d+\.\d+\.\d+)|^\s*v(\d+\.\d+\.\d+)\s*$/m.exec(entry);
    if (stated) assert.equal(versions.get(name), stated[1] ?? stated[2], `${name}: the banner says ${stated[1] ?? stated[2]}`);
  }
  assert.deepEqual(named.sort(), ["ieee754", "papaparse", "re2js", "smol-toml"]);
});

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
    const got = compared(await inJustBash(c.script), known.redirections[c.id]);
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
    if ((k as { matches?: boolean }).matches) continue; // (a probe that records stderr and calls of a case that matches)
    const o = want.get(id) as any;
    const fields = Object.entries(k.differs).filter(([field]) => field in o && field !== "stderr");
    assert.ok(fields.some(([field, value]) => JSON.stringify(o[field]) !== JSON.stringify(value)), `${id}: no recorded field differs from GNU bash`);
  }
});

// D8, beyond the frozen cases: why the host wraps, and that a refused commit
// (the final write) ends the same way as a refused open.
const d8 = cases.redirections.filter((c: { id: string }) => c.id.startsWith("d8-") || c.id === "missing-folder");
test("D8: unwrapped, a refused redirection at the top level rejects exec(), losing every output", async () => {
  for (const id of ["d8-before-after", "d8-or-fallback", "missing-folder"]) {
    const got = await inJustBash((byId(cases.redirections).get(id) as any).script, { wrapped: false });
    assert.equal(got.exit, "rejects", id);
  }
});
test("D8: a refused final write ends an invocation exactly as a refused open does (wrapped)", async () => {
  for (const c of d8) {
    const open = await inJustBash(c.script, { failAt: "open" }), commit = await inJustBash(c.script, { failAt: "commit" });
    assert.deepEqual([commit.exit, commit.stdout, String(commit.stderr).replace(/ENOSPC/g, "ENOENT"), commit.files], [open.exit, open.stdout, open.stderr, open.files], c.id);
  }
});
test("D8: a limit is a typed result (status 126 with its message), not a file system rejection", async () => {
  const r = await new Bash({ executionLimits: { maxCommandCount: 5 } }).exec(wrap("for i in 1 2 3 4 5 6 7 8; do :; done"));
  assert.equal(r.exitCode, 126);
  assert.match(r.stderr, /too many commands executed \(>5\)/);
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
      const program = `const { Bash } = require(${JSON.stringify(JUST_BASH)});
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
