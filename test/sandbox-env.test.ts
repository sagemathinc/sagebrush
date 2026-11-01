import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The sandbox's environment (scripts/sandbox-env.mjs, scripts/build-cli.mjs --sandbox; plan deno-sandbox-env r2):
// build-cli runs for real with a stub compiler (PYJS_DENO) that records the flags and the entry it is given; the
// behaviour cases then run that captured entry under `deno run` with those captured flags, less only the
// compile-only ones, so neither is rebuilt here.  The sentinel values are never printed: the program reports
// names, booleans and a hash.

const ROOT = join(__dirname, "..", "..");
const SB = () => import(join(ROOT, "scripts", "sandbox-env.mjs"));
const OUT = `build/sbx-test-${process.pid}`;
const TMP = mkdtempSync(join(tmpdir(), "sbx-test-"));
const STUB = join(TMP, "deno-stub.sh");
writeFileSync(STUB, [
  "#!/bin/sh",
  "# (a stub deno compile: its argv and its entry kept, the output file made empty)",
  'printf "%s\\n" "$@" > "$SBX_CAPTURE/argv"',
  'prev=; last=; for a in "$@"; do if [ "$prev" = "-o" ]; then : > "$a"; fi; prev=$a; last=$a; done',
  'cp "$last" "$SBX_CAPTURE/entry.cjs"',
  "",
].join("\n"));
chmodSync(STUB, 0o755);
after(() => {
  rmSync(join(ROOT, OUT), { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

const PROBE = "probe-" + createHash("sha256").update(String(process.pid)).digest("hex").slice(0, 12);
const SECRET = "secret-" + createHash("sha256").update("s" + process.pid).digest("hex").slice(0, 12);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** build-cli --sandbox with these grants, through the stub: the captured argv and entry. */
const builds = new Map<string, { argv: string[]; entry: string; entryPath: string }>();
function build(allow: string) {
  const had = builds.get(allow);
  if (had) return had;
  const cap = mkdtempSync(join(TMP, "cap-"));
  const r = spawnSync(process.execPath, ["scripts/build-cli.mjs", "--sandbox", `--out=${OUT}`], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, PYJS_DENO: STUB, SBX_CAPTURE: cap, PYJS_SANDBOX_ALLOW: allow },
  });
  assert.equal(r.status, 0, `build-cli (${allow}): ${r.stderr.slice(-2000)}`);
  const argv = readFileSync(join(cap, "argv"), "utf8").split("\n").slice(0, -1);
  const b = { argv, entry: readFileSync(join(cap, "entry.cjs"), "utf8"), entryPath: join(cap, "entry.cjs") };
  builds.set(allow, b);
  return b;
}
/** The captured flags for `deno run`: the compile flags less `compile`, `-o <exe>`, `--target=…` and the entry. */
function runFlags(argv: string[]) {
  const f: string[] = [];
  for (let i = 1; i < argv.length - 1; i++) {
    if (argv[i] === "-o") { i++; continue; }
    if (argv[i].startsWith("--target=")) continue;
    f.push(argv[i]);
  }
  return f;
}
/** A program on the captured entry's stdin, as the sandbox takes it, with SBX_PROBE and SBX_SECRET set. */
function runEntry(allow: string, program: string, env: Record<string, string> = {}) {
  const b = build(allow);
  const r = spawnSync("deno", ["run", ...runFlags(b.argv), b.entryPath], {
    cwd: TMP, input: program, encoding: "utf8", env: { ...process.env, SBX_PROBE: PROBE, SBX_SECRET: SECRET, ...env },
  });
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET), "the forbidden sentinel never printed");
  return r;
}
const REPORT = `import os, json, hashlib, _time
e = os.environ
print(json.dumps({"keys": sorted(k for k in e if k in ("SBX_PROBE", "SBX_SECRET", "PATH")), "n": len(e),
  "probe": hashlib.sha256(e["SBX_PROBE"].encode()).hexdigest() if "SBX_PROBE" in e else None,
  "secret": "SBX_SECRET" in e, "node_zone": _time._zone()[2]}))
`;
function report(allow: string, env: Record<string, string> = {}) {
  const r = runEntry(allow, REPORT, env);
  assert.equal(r.status, 0, `${allow || "(no grant)"}: rc ${r.status}: ${r.stderr.replace(/\x1b\[[0-9;]*m/g, "").slice(-1500)}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

// ---- W: the build's wiring (the flags and the entry deno compile is given)

test("W1 no grant: the flags are exactly --no-prompt; the entry is the bundle with the env adapter after its #! line; nothing granted", async () => {
  const { sandboxEntry } = await SB();
  const b = build("");
  assert.deepEqual(b.argv.slice(0, -1), ["compile", "--no-check", "--no-config", "--no-prompt", "-o", join(ROOT, OUT, "pyjs-sandbox")]);
  assert.ok(!b.argv.some((a) => /^(-A|--allow|--deny|-[A-Z])/.test(a)), "no permission flag");
  const bundle = readFileSync(join(ROOT, OUT, "pyjs.cjs"), "utf8");
  const nl = bundle.indexOf("\n") + 1;
  assert.ok(bundle.startsWith("#!"));
  assert.equal(b.entry.slice(0, nl), bundle.slice(0, nl), "the #! line first");
  assert.equal(b.entry.slice(b.entry.length - (bundle.length - nl)), bundle.slice(nl), "then the whole bundle, byte for byte");
  const prologue = b.entry.slice(nl, b.entry.length - (bundle.length - nl));
  assert.equal(prologue, sandboxEntry({ bundleText: bundle, allow: "" }).prologue, "between them, the adapter alone");
  assert.equal(b.entry.split("makeEnvAdapter(process.env, Deno.errors.NotCapable,").length, 2, "installed once");
  assert.match(prologue, /makeEnvAdapter\(process\.env, Deno\.errors\.NotCapable, \[\]\)/, "granted: none");
});
test("W2 PYJS_SANDBOX_ALLOW's tokens are the flags, and its env names the adapter's list", () => {
  const b = build("--allow-env=SBX_PROBE --allow-read=.");
  assert.deepEqual(b.argv.slice(3, -3), ["--no-prompt", "--allow-env=SBX_PROBE", "--allow-read=."]);
  assert.match(b.entry, /makeEnvAdapter\(process\.env, Deno\.errors\.NotCapable, \["SBX_PROBE"\]\)/);
});
test("W3 an env grant spelled another way is refused by the build (the flags and the list can't disagree)", () => {
  for (const allow of ["-E", "-E=SBX_PROBE", "--allow-envX", "--allow-env=SBX-PROBE"]) {
    const cap = mkdtempSync(join(TMP, "cap-"));
    const r = spawnSync(process.execPath, ["scripts/build-cli.mjs", "--sandbox", `--out=${OUT}`], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PYJS_DENO: STUB, SBX_CAPTURE: cap, PYJS_SANDBOX_ALLOW: allow } });
    assert.notEqual(r.status, 0, allow);
    assert.match(r.stderr, /PYJS_SANDBOX_ALLOW/, allow);
    assert.equal(existsSync(join(cap, "argv")), false, `${allow}: nothing compiled`);
  }
});

// ---- E: the captured entry under deno run, with the captured flags

test("E0 no grant: it runs; the environment is empty", () => {
  const r = report("");
  assert.deepEqual(r.keys, []);
  assert.equal(r.n, 0);
  assert.equal(r.probe, null);
});
test("E1 --allow-env=SBX_PROBE: exactly SBX_PROBE, its real value", () => {
  const r = report("--allow-env=SBX_PROBE");
  assert.deepEqual(r.keys, ["SBX_PROBE"]);
  assert.equal(r.n, 1);
  assert.equal(r.probe, sha(PROBE));
});
test("E2 --allow-env=PATH: it runs (no later read refused); exactly PATH", () => {
  const r = report("--allow-env=PATH");
  assert.deepEqual(r.keys, ["PATH"]);
  assert.equal(r.n, 1);
});
test("E3 --allow-env --deny-env=SBX_SECRET: everything but SBX_SECRET", () => {
  const r = report("--allow-env --deny-env=SBX_SECRET");
  assert.deepEqual(r.keys, ["PATH", "SBX_PROBE"]);
  assert.equal(r.secret, false);
  assert.equal(r.probe, sha(PROBE));
});
test("E4 a granted behaviour switch takes effect (SAGEBRUSH_TIME_NO_ZONE_FILES=1); ungranted, the default", () => {
  assert.equal(report("--allow-env=SAGEBRUSH_TIME_NO_ZONE_FILES", { SAGEBRUSH_TIME_NO_ZONE_FILES: "1" }).node_zone, false, "granted: set");
  assert.equal(report("", { SAGEBRUSH_TIME_NO_ZONE_FILES: "1" }).node_zone, true, "not granted: the default");
});
test("E5 no grant: a write is still PermissionError, nothing created", () => {
  const p = join(TMP, "e5-written");
  const r = runEntry("", `try:\n    open(${JSON.stringify(p)}, "w")\n    print("ALLOWED")\nexcept Exception as e:\n    print(type(e).__name__)\n`);
  assert.equal(r.stdout.trim().split("\n").pop(), "PermissionError");
  assert.equal(existsSync(p), false);
});
test("E6 --allow-env: everything, SBX_SECRET too", () => {
  const r = report("--allow-env");
  assert.deepEqual(r.keys, ["PATH", "SBX_PROBE", "SBX_SECRET"]);
  assert.equal(r.secret, true);
});

// ---- U: the adapter itself, with an injected refusal class

class Denied extends Error {}
/** A fake environment: `vals` readable; reading `refused` names (or listing, if `listRefused`) throws `Denied`;
 * `boom` names throw a TypeError (not a refusal). */
function fakeEnv(o: { vals: Record<string, string>; refused?: string[]; listRefused?: boolean; boom?: string[]; listBoom?: boolean; setRefused?: boolean }) {
  return new Proxy({ ...o.vals } as Record<string, string>, {
    get(t, k) { if (typeof k === "string" && o.boom?.includes(k)) throw new TypeError("boom"); if (typeof k === "string" && (o.refused?.includes(k) || (o.listRefused && !(k in o.vals)))) throw new Denied(); return t[k as string]; },
    has(t, k) { if (typeof k === "string" && o.boom?.includes(k)) throw new TypeError("boom"); if (typeof k === "string" && o.refused?.includes(k)) throw new Denied(); return k in t; },
    ownKeys(t) { if (o.listBoom) throw new TypeError("boom"); if (o.listRefused) throw new Denied(); return Reflect.ownKeys(t); },
    set(t, k, v) { if (o.setRefused) throw new Denied(); t[k as string] = v; return true; },
    deleteProperty(t, k) { if (o.setRefused) throw new Denied(); delete t[k as string]; return true; },
  });
}
test("U1 a refusal absorbed per operation: get undefined, has false, the list is the granted names that read", async () => {
  const { makeEnvAdapter } = await SB();
  const e = makeEnvAdapter(fakeEnv({ vals: { A: "1", C: "3" }, refused: ["B"], listRefused: true }), Denied, ["A", "B", "Z"]);
  assert.equal(e.A, "1");
  assert.equal(e.B, undefined);
  assert.equal("B" in e, false);
  assert.equal("A" in e, true);
  assert.deepEqual(Object.keys(e), ["A"], "granted and readable only (B refused, Z unset, C not granted)");
  assert.deepEqual(Object.entries(e), [["A", "1"]]);
  const full = makeEnvAdapter(fakeEnv({ vals: { A: "1", C: "3" } }), Denied, []);
  assert.deepEqual(Object.keys(full).sort(), ["A", "C"], "a listable environment: the real list");
});
test("U2 any other error propagates unchanged, from every operation", async () => {
  const { makeEnvAdapter } = await SB();
  const e = makeEnvAdapter(fakeEnv({ vals: { A: "1" }, boom: ["X"], listBoom: true }), Denied, ["X"]);
  assert.throws(() => e.X, TypeError, "get");
  assert.throws(() => "X" in e, TypeError, "has");
  assert.throws(() => Object.keys(e), TypeError, "ownKeys");
  assert.throws(() => Object.getOwnPropertyDescriptor(e, "X"), TypeError, "getOwnPropertyDescriptor");
  const listed = makeEnvAdapter(fakeEnv({ vals: { A: "1" }, boom: ["X"], listRefused: true }), Denied, ["X"]);
  assert.throws(() => Object.keys(listed), TypeError, "a granted name's read, while listing");
});
test("U3 writes are not caught: a refused set or delete throws the refusal", async () => {
  const { makeEnvAdapter } = await SB();
  const e = makeEnvAdapter(fakeEnv({ vals: { A: "1" }, setRefused: true }), Denied, []);
  assert.throws(() => { e.B = "2"; }, Denied);
  assert.throws(() => { delete e.A; }, Denied);
  const ok = makeEnvAdapter(fakeEnv({ vals: {} }), Denied, []);
  ok.B = "2";
  assert.equal(ok.B, "2", "an allowed write reaches the real environment");
});
test("U4 parseAllow: each granted name once; the full and deny forms grant no list", async () => {
  const { parseAllow } = await SB();
  assert.deepEqual(parseAllow("--allow-env=A,B --allow-env=B,C --allow-read=."), { flags: ["--allow-env=A,B", "--allow-env=B,C", "--allow-read=."], granted: ["A", "B", "C"] });
  for (const f of ["--allow-env", "-A", "--allow-all", "--deny-env", "--deny-env=S", ""]) assert.deepEqual(parseAllow(f).granted, [], f);
  for (const f of ["-E", "-E=A", "--allow-env-x", "--allow-env=A,,B", "--allow-env=1A"]) assert.throws(() => parseAllow(f), /PYJS_SANDBOX_ALLOW/, f);
});
