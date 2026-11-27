import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Exercise the real launcher before any bundle is loaded. The injected maps
// and process model let normal hosts test the small-VA guest, including its
// startup-only restart (no user code may run twice).
const launcher = readFileSync(join(__dirname, "../../packages/sagebrush/bin/sagebrush.cjs"), "utf8");
const low = "10000-20000 r-xp 00000000 00:00 0 /node\n3fcf46e000-3fcf48f000 rw-p 00000000 00:00 0 [stack]\n";
const STOP = {};
function probe(options: any = {}) {
  const calls: any[] = [];
  const env = { KEEP_ME: "yes", ...options.env };
  const proc: any = {
    platform: options.platform ?? "linux", versions: options.versions ?? { node: "26.13.1" },
    allowedNodeEnvironmentFlags: new Set(options.unsupported ? [] : ["--disable-wasm-trap-handler"]),
    execArgv: options.execArgv ?? ["--stack-trace-limit=12"], env,
    execPath: "/usr/bin/node", argv: ["/usr/bin/node", "/tmp/sagebrush.cjs", "--sage", "-c", "print(1)"],
    pid: 123, stderr: { write: (s: string) => calls.push(["stderr", s]) },
    exit: (code: number) => { calls.push(["exit", code]); throw STOP; },
    kill: (pid: number, signal: string) => { calls.push(["kill", pid, signal]); throw STOP; },
  };
  if (!options.oldNode) proc.execve = (...args: any[]) => { calls.push(["execve", ...args]); throw STOP; };
  const req = (name: string) => {
    if (name === "node:worker_threads") return { isMainThread: options.worker !== true };
    if (name === "node:fs") return { readFileSync: () => {
      if (options.unreadable) throw new Error("EACCES");
      return options.maps ?? low;
    } };
    if (name === "node:child_process") return { spawnSync: (...args: any[]) => {
      calls.push(["spawn", ...args]); return options.child ?? { status: 7 };
    } };
    // Reaching compile-cache setup means startup proceeded without restart.
    if (name === "node:module") { calls.push(["continue"]); throw STOP; }
    throw STOP;
  };
  try { runInNewContext(launcher.replace(/^#!.*\n/, ""), { process: proc, require: req }); } catch (e) { if (e !== STOP) throw e; }
  return { calls, env };
}

test("small Linux VA restarts before loading the bundle, preserving arguments and environment", () => {
  const { calls, env } = probe({ env: { NODE_OPTIONS: "--max-old-space-size=512 --trace-warnings" } });
  assert.equal(calls[0][0], "execve");
  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(calls[0][2]), ["/usr/bin/node", "--stack-trace-limit=12", "/tmp/sagebrush.cjs", "--sage", "-c", "print(1)"]);
  assert.equal(calls[0][3].NODE_OPTIONS, "--max-old-space-size=512 --trace-warnings --disable-wasm-trap-handler");
  assert.equal(calls[0][3].KEEP_ME, "yes");
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=512 --trace-warnings", "no mutation of the original environment");
});

test("normal, unknown and non-Node environments do not restart", () => {
  for (const options of [
    { maps: low + "7ffffffde000-7ffffffff000 rw-p 0 00:00 0 [stack]\n" },
    { maps: "10000000000-10000001000 rw-p 0 00:00 0\n" },
    { maps: "" }, { maps: "not a mapping" }, { unreadable: true },
    { platform: "darwin" }, { platform: "win32" },
    { versions: { node: "22", bun: "1.4.4" } }, { versions: { node: "22", deno: "2" } },
    { unsupported: true }, { worker: true },
  ]) assert.equal(probe(options).calls[0][0], "continue", JSON.stringify(options));
});

test("explicit flag prevents a restart loop, including inherited NODE_OPTIONS", () => {
  for (const options of [
    { execArgv: ["--disable-wasm-trap-handler"] },
    { env: { NODE_OPTIONS: "--trace-warnings --disable-wasm-trap-handler" } },
  ]) assert.equal(probe(options).calls[0][0], "continue");
});

test("older Node fallback preserves exit codes and signals, and diagnoses spawn failure", () => {
  const ordinary = probe({ oldNode: true });
  assert.equal(ordinary.calls[0][0], "spawn");
  assert.equal(ordinary.calls[0][3].stdio, "inherit");
  assert.equal(ordinary.calls[0][3].env.NODE_OPTIONS, "--disable-wasm-trap-handler");
  assert.deepEqual(ordinary.calls[1], ["exit", 7]);
  assert.deepEqual(probe({ oldNode: true, child: { signal: "SIGTERM", status: null } }).calls[1], ["kill", 123, "SIGTERM"]);
  const failed = probe({ oldNode: true, child: { error: new Error("ENOENT") } }).calls;
  assert.match(failed[1][1], /cannot restart Node.*ENOENT/);
  assert.deepEqual(failed[2], ["exit", 1]);
});

test("real Node restart reaches the program worker once with bounds checks enabled", { skip: process.platform !== "linux" || !process.allowedNodeEnvironmentFlags.has("--disable-wasm-trap-handler") }, () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-launcher-va-"));
  try {
    writeFileSync(join(dir, "sagebrush.cjs"), launcher);
    // Only /proc's data is simulated. The restart, Node option processing,
    // launcher worker, argv, and wasm allocations are real.
    writeFileSync(join(dir, "maps.cjs"), `const fs=require('node:fs'),read=fs.readFileSync;fs.readFileSync=function(p,...a){return p==='/proc/self/maps'?${JSON.stringify(low)}:read.call(this,p,...a)};`);
    writeFileSync(join(dir, "pyjs.cjs"), `
      const {isMainThread,workerData}=require('node:worker_threads');
      const memories=[];for(let i=0;i<40;i++)memories.push(new WebAssembly.Memory({initial:1}));
      require('node:fs').writeSync(1,JSON.stringify({isMainThread,argv:workerData.sagebrushCli.argv,options:process.env.NODE_OPTIONS,count:memories.length})+'\\n');
    `);
    const env = { ...process.env, NODE_OPTIONS: `--require=${join(dir, "maps.cjs")} --stack-trace-limit=12` };
    const result = spawnSync(process.execPath, [join(dir, "sagebrush.cjs"), "--sage", "-c", "print(1)"], { env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1, "program executes once");
    const out = JSON.parse(result.stdout);
    assert.equal(out.isMainThread, false);
    assert.deepEqual(out.argv, ["--sage", "-c", "print(1)"]);
    assert.equal(out.count, 40);
    assert.match(out.options, /--stack-trace-limit=12 --disable-wasm-trap-handler$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
