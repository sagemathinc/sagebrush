import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { startKernel } from "./kernel-harness";

// The Jupyter kernel's optional package set: `sagebrush --jupyter-kernel FILE
// --pkgset ID|FILE` (or SAGEBRUSH_PKGSET) lets its cells import the set's
// packages, as a run with --pkgset does; a set that can't be had stops the
// kernel before it starts, with the reason.  Driven over the kernel's shell
// socket (test/kernel-harness.ts).
const DIST = __dirname + "/..";
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const canon = (v: any): string =>
  Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v !== null && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v);

// a one-package set on disk: dir/pkgset/<S>.json and dir/pkg/<h>.json (as test/pkgcache.test.ts makes it)
function setOnDisk() {
  const dir = mkdtempSync(join(tmpdir(), "sb-kernel-set-"));
  mkdirSync(join(dir, "pkg"));
  mkdirSync(join(dir, "pkgset"));
  const files = { "py/greet.py": "MSG = 'from the set'\n" };
  const chunk = Buffer.from(canon({ format: "sagebrush-pkg-chunk", v: 1, kind: "src", package: "@sagebrush/greet@0.1.0", files }));
  const h = sha(chunk);
  writeFileSync(join(dir, "pkg", h + ".json"), chunk);
  const ix = { format: "sagebrush-pkgset", v: 1, core_api: 1, packages: { "@sagebrush/greet@0.1.0": { dir: "greet", root: "py", files: { "py/greet.py": sha(files["py/greet.py"]) }, modules: ["greet"], requires: [], core_req: { api: 1, level: 1 }, src: { sha256: h, size: chunk.length }, pre: {}, cost: {} } } };
  const index = Buffer.from(canon(ix));
  const S = sha(index);
  writeFileSync(join(dir, "pkgset", S + ".json"), index);
  return { dir, file: join(dir, "pkgset", S + ".json"), index };
}

/** Start a kernel, run code in it, and give its execute_reply's content; or, if the kernel exits first, its exit
 * status and stderr. */
async function runIn(args: string[], code: string, env: Record<string, string> = {}): Promise<{ reply?: any; status?: number | null; stderr: string }> {
  const k = await startKernel(args, env);
  // (every case has an end: a kernel that neither exits nor answers within 30 s is a failure, not a hang)
  const bound = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("no end within 30 s: " + k.out.stderr)), 30000))]);
  try {
    if (!k.started) return { status: await bound(k.exited), stderr: k.out.stderr };
    const reply = await bound(k.exec(code));
    return { reply, stderr: k.out.stderr };
  } finally {
    k.close();
    await k.stop();
  }
}

const CODE = "import greet\nassert greet.MSG == 'from the set'";

test("--jupyter-kernel --pkgset FILE: the set's packages import in its cells", async () => {
  const s = setOnDisk();
  try {
    const r = await runIn(["--pkgset", s.file], CODE);
    assert.equal(r.reply?.status, "ok", JSON.stringify(r));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("--jupyter-kernel with SAGEBRUSH_PKGSET: the same", async () => {
  const s = setOnDisk();
  try {
    const r = await runIn([], CODE, { SAGEBRUSH_PKGSET: s.file });
    assert.equal(r.reply?.status, "ok", JSON.stringify(r));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("--jupyter-kernel --pkgset FILE beats SAGEBRUSH_PKGSET", async () => {
  const s = setOnDisk();
  try {
    // (the environment names a set that can't be had: the flag's set is the one used, and the kernel starts)
    const bad = join(s.dir, "pkgset", "f".repeat(64) + ".json");
    writeFileSync(bad, s.index);
    const r = await runIn(["--pkgset", s.file], CODE, { SAGEBRUSH_PKGSET: bad });
    assert.equal(r.reply?.status, "ok", JSON.stringify(r));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("--jupyter-kernel --pkgset with a relative FILE: still the same set after the notebook changes folder and the interpreter restarts", async () => {
  const s = setOnDisk();
  const elsewhere = mkdtempSync(join(tmpdir(), "sb-kernel-elsewhere-"));
  const k = await startKernel(["--pkgset", join("pkgset", basename(s.file))], {}, s.dir);
  try {
    assert.equal((await k.exec(CODE)).status, "ok", k.out.stderr);
    assert.equal((await k.exec(`import os\nos.chdir(${JSON.stringify(elsewhere)})`)).status, "ok", k.out.stderr);
    // (a call that never checks for an interrupt: the kernel restarts its interpreter, which reads the set again)
    const stuck = k.exec("import re\nre.match('(a+)+$', 'a' * 40 + 'b')");
    await new Promise((r) => setTimeout(r, 500));
    k.interrupt();
    await stuck;
    const after = await Promise.race([k.exec(CODE), new Promise<any>((r) => setTimeout(() => r({ status: "no reply within 30 s" }), 30000))]);
    assert.equal(after.status, "ok", JSON.stringify(after) + k.out.stderr);
  } finally {
    k.close();
    await k.stop();
    rmSync(s.dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("--jupyter-kernel without a set: the package isn't there", async () => {
  const r = await runIn([], CODE, { SAGEBRUSH_PKGSET: "" });
  assert.equal(r.reply?.status, "error", JSON.stringify(r));
  assert.equal(r.reply?.ename, "ModuleNotFoundError");
});

test("--jupyter-kernel with a set that can't be had: it stops before it starts, saying why", async () => {
  const s = setOnDisk();
  try {
    // (an index file whose name isn't its digest)
    const bad = join(s.dir, "pkgset", "f".repeat(64) + ".json");
    writeFileSync(bad, s.index);
    const r = await runIn(["--pkgset", bad], CODE);
    assert.equal(r.status, 2, JSON.stringify(r));
    assert.match(r.stderr, /sagebrush: package set: .*not the one its id names/);
    const none = await runIn(["--pkgset"], CODE);
    assert.equal(none.status, 2, JSON.stringify(none));
    assert.match(none.stderr, /--pkgset takes a set id or a pkgset\/<id>\.json file/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("--jupyter-kernel: a restart whose package set is gone ends the kernel with the reason, never a hang", async () => {
  const s = setOnDisk();
  const k = await startKernel(["--pkgset", s.file]);
  try {
    assert.equal((await k.exec(CODE)).status, "ok", k.out.stderr);
    // (the set's index gone since the kernel started; then a call that never checks for an interrupt, a
    // catastrophic regular expression, so the kernel restarts its interpreter, which reads the set again)
    rmSync(s.file);
    void k.exec("import re\nre.match('(a+)+$', 'a' * 40 + 'b')");
    await new Promise((r) => setTimeout(r, 500));
    k.interrupt();
    const status = await Promise.race([k.exited, new Promise((r) => setTimeout(() => r("still running"), 30000))]);
    assert.equal(status, 2, k.out.stderr);
    assert.match(k.out.stderr, /sagebrush: package set: /);
  } finally {
    k.close();
    await k.stop();
    rmSync(s.dir, { recursive: true, force: true });
  }
});
