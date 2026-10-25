// scripts/npm-pack-metrics.mjs (plan-npm-pack-metrics-r3 §3): npm's output
// parsed strictly, the wrapper's error paths with a fake npm first on PATH, the
// real bundled npm once (a smoke test: a fake can't catch npm's own config
// loading failing), the base binding, the report, and the workflow contract.
//   node scripts/test-npm-pack-metrics.mjs
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindFetched, isolationProblem, literalEntryProblem, makeRecord, md, packDir, parsePack, readRecord, recordProblems, report, runNpm, ARGS, CAPS, FORMAT } from "./npm-pack-metrics.mjs";

let passed = 0, failures = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}
const reason = (name, r, want) => check(name, typeof r?.reason === "string" && r.reason.startsWith(want), JSON.stringify(r).slice(0, 300));

const tmp = mkdtempSync(join(tmpdir(), "npm-pack-metrics-test-"));
try {
  // ---- parsing
  const FILES = ["a.txt", "dist/b.cjs"];
  const pkgOut = (over = {}, files = [{ path: "a.txt", size: 3 }, { path: "dist/b.cjs", size: 5 }, { path: "package.json", size: 10 }]) =>
    JSON.stringify([{ id: "sagebrush@0.0.1", name: "sagebrush", version: "0.0.1", size: 100, unpackedSize: files.reduce((s, f) => s + f.size, 0), entryCount: files.length, files, ...over }]);
  {
    const r = parsePack(pkgOut(), FILES);
    check("parse: a good pack", r.size === 100 && r.unpackedSize === 18 && r.entryCount === 3 && r.files.length === 3 && !r.reason, JSON.stringify(r));
    check("parse: files sorted by path", r.files.map((f) => f[0]).join() === "a.txt,dist/b.cjs,package.json");
    reason("parse: a missing files entry", parsePack(pkgOut({}, [{ path: "a.txt", size: 3 }, { path: "package.json", size: 10 }]), FILES), "missing from the pack: dist/b.cjs");
    reason("parse: two elements", parsePack(JSON.stringify([JSON.parse(pkgOut())[0], JSON.parse(pkgOut())[0]]), FILES), "npm output is not exactly one package: 2 elements");
    reason("parse: zero elements", parsePack("[]", FILES), "npm output is not exactly one package: 0 elements");
    reason("parse: another package", parsePack(pkgOut({ name: "other" }), FILES), "npm packed another package: other");
    reason("parse: a non-integer size", parsePack(pkgOut({ size: "100" }), FILES), "npm's size is not a non-negative safe integer");
    reason("parse: a negative size", parsePack(pkgOut({ size: -1 }), FILES), "npm's size is not a non-negative safe integer");
    reason("parse: an unsafe size", parsePack(pkgOut({ size: 2 ** 53 }), FILES), "npm's size is not a non-negative safe integer");
    reason("parse: a fractional size (strict JSON)", parsePack(pkgOut().replace('"size":100', '"size":100.5'), FILES), "npm output is not JSON");
    reason("parse: entryCount ≠ files", parsePack(pkgOut({ entryCount: 4 }), FILES), "entryCount is not the number of files: 4 vs 3");
    reason("parse: a bad tuple (size)", parsePack(pkgOut({ unpackedSize: 0 }, [{ path: "a.txt", size: -3 }]), ["a.txt"]), "a bad file size for a.txt");
    reason("parse: a bad tuple (path)", parsePack(pkgOut({}, [{ path: 7, size: 3 }]), []), "a bad file path");
    reason("parse: a control character in a path", parsePack(pkgOut({}, [{ path: "a\nb", size: 3 }]), []), "a bad file path");
    reason("parse: a duplicate path", parsePack(pkgOut({}, [{ path: "a.txt", size: 3 }, { path: "a.txt", size: 3 }]), []), "a duplicate path: a.txt");
    reason("parse: the sum isn't unpackedSize", parsePack(pkgOut({ unpackedSize: 19 }), FILES), "the file sizes don't sum to unpackedSize: 18 vs 19");
    reason("parse: over the files cap", parsePack(pkgOut({}, Array.from({ length: CAPS.files + 1 }, (_, i) => ({ path: `f${i}`, size: 1 }))), []), `more than ${CAPS.files} files`);
    reason("parse: a path over the cap", parsePack(pkgOut({}, [{ path: "x".repeat(CAPS.path_chars + 1), size: 1 }]), []), "a bad file path");
    reason("parse: duplicate keys (strict JSON)", parsePack('[{"name":"sagebrush","name":"sagebrush"}]', []), "npm output is not JSON");
    reason("parse: trailing garbage", parsePack(pkgOut() + "\ngarbage", FILES), "npm output is not JSON");
    reason("parse: a long reason is clipped", parsePack(pkgOut({ name: "n".repeat(1000) }), FILES), "npm packed another package: nnnn");
    check("parse: reasons are at most the cap", parsePack(pkgOut({ name: "n".repeat(1000) }), FILES).reason.length <= "npm packed another package: ".length + CAPS.reason_chars);
  }
  // ---- literal "files" entries (a directory or glob: its own reason, never a packaging failure)
  {
    const d = join(tmp, "lit");
    mkdirSync(join(d, "dist"), { recursive: true });
    writeFileSync(join(d, "a.txt"), "abc");
    check("literal: a file", literalEntryProblem("a.txt", d) === null);
    check("literal: a missing file is left to the membership check", literalEntryProblem("nope.txt", d) === null);
    for (const e of ["dist", "dist/", "lib/*.js", "a?.txt", "[ab].txt", "{a,b}", "!a.txt", "./a.txt", "../a.txt"]) check(`literal: ${e} is not literal`, literalEntryProblem(e, d) === e);
  }
  // ---- the wrapper, with a fake npm first on PATH
  const bin = join(tmp, "bin"), fake = join(tmp, "fake"), pkg = join(tmp, "pkg");
  mkdirSync(bin);
  mkdirSync(fake);
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "a.txt"), "abc");
  writeFileSync(join(pkg, "dist", "b.cjs"), "hello");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "sagebrush", version: "0.0.1", files: FILES }));
  writeFileSync(join(fake, "good.json"), pkgOut());
  writeFileSync(join(bin, "npm"), `#!/bin/sh
echo "$$" > "$FAKE_DIR/pid"
echo "$*" >> "$FAKE_DIR/calls"
env > "$FAKE_DIR/env"
if [ "$1" = "--version" ]; then echo 11.0.0-fake; exit 0; fi
printf '%s\\n' "$*" > "$FAKE_DIR/args"
case "$FAKE_NPM" in
  exit) echo "the last line" >&2; exit 3 ;;
  notjson) echo "npm notice something" ;;
  trailing) cat "$FAKE_DIR/good.json"; echo garbage ;;
  hang) exec sleep 30 ;;
  selfkill) kill -9 $$ ;;
  *) cat "$FAKE_DIR/good.json" ;;
esac
`);
  chmodSync(join(bin, "npm"), 0o755);
  const fakeEnv = (mode, extra = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: fake, FAKE_NPM: mode, ...extra });
  {
    const r = packDir(pkg, { env: fakeEnv("good") });
    check("wrapper: a good pack", r.size === 100 && r.entryCount === 3 && r.key.npm === "11.0.0-fake" && /^[0-9a-f]{64}$/.test(r.key.script_sha256), JSON.stringify(r));
    check("wrapper: the exact arguments", readFileSync(join(fake, "args"), "utf8").trim() === ARGS.join(" "));
    const rec = makeRecord({ commit: "c".repeat(40), tree: "t".repeat(40), run: { id: "1", attempt: "1", job: "checks" }, m: r });
    check("wrapper: the record validates", recordProblems(rec).length === 0, recordProblems(rec).join("; "));
    writeFileSync(join(tmp, "rec.json"), JSON.stringify(rec));
    const back = readRecord(join(tmp, "rec.json"));
    check("wrapper: the record round-trips", JSON.stringify(back) === JSON.stringify(rec), JSON.stringify(back).slice(0, 200));
  }
  reason("wrapper: npm exits non-zero", packDir(pkg, { env: fakeEnv("exit") }), "npm exited 3: the last line");
  reason("wrapper: npm prints non-JSON", packDir(pkg, { env: fakeEnv("notjson") }), "npm output is not JSON");
  reason("wrapper: JSON with trailing garbage", packDir(pkg, { env: fakeEnv("trailing") }), "npm output is not JSON");
  {
    const t0 = Date.now();
    const r = packDir(pkg, { env: fakeEnv("hang"), timeoutMs: 200 });
    reason("wrapper: a hang times out", r, "npm timed out after 200 ms");
    check("wrapper: the timeout is the injected one", Date.now() - t0 < 10_000, `${Date.now() - t0} ms`);
    const pid = Number(readFileSync(join(fake, "pid"), "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    check("wrapper: the timed-out child was killed", pid > 0 && !alive, `pid ${pid}`);
  }
  {
    // (NPM-PACK-138-3: only spawnSync's own timeout is a timeout; a SIGKILL from elsewhere is a failure)
    const r = packDir(pkg, { env: fakeEnv("selfkill"), timeoutMs: 60_000 });
    reason("wrapper: a SIGKILL that isn't the timeout", r, "npm exited SIGKILL");
  }
  reason("wrapper: npm missing from PATH", packDir(pkg, { env: { ...fakeEnv("good"), PATH: join(tmp, "empty-path") } }), "npm not found");
  {
    // (NPM-PACK-138-1: refused before any npm invocation, even npm --version)
    writeFileSync(join(pkg, ".npmrc"), "this is = [not valid\n");
    rmSync(join(fake, "calls"), { force: true });
    reason("wrapper: a project npmrc", packDir(pkg, { env: fakeEnv("good") }), "project npmrc present");
    check("wrapper: a project npmrc means npm is never invoked", !existsSync(join(fake, "calls")), existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8") : "");
    rmSync(join(pkg, ".npmrc"));
  }
  {
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "sagebrush", version: "0.0.1", files: ["a.txt", "dist"] }));
    reason("wrapper: a directory files entry", packDir(pkg, { env: fakeEnv("good") }), "package.json files entry is not a literal file path: dist");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "sagebrush", version: "0.0.1", files: FILES }));
  }
  {
    packDir(pkg, { env: fakeEnv("good", { npm_config_foo: "1", NPM_CONFIG_BAR: "2", Npm_Config_Baz: "3", npm_config_userconfig: "/nonexistent", npm_config_globalconfig: "/nonexistent" }) });
    const env = readFileSync(join(fake, "env"), "utf8").split("\n").filter((l) => /^npm_config_/i.test(l));
    const names = env.map((l) => l.split("=")[0]).sort();
    check("wrapper: no inherited npm_config_* reaches npm", names.join() === "npm_config_globalconfig,npm_config_userconfig", names.join());
    const u = env.find((l) => l.startsWith("npm_config_userconfig="))?.split("=")[1], g = env.find((l) => l.startsWith("npm_config_globalconfig="))?.split("=")[1];
    check("wrapper: user and global configs are two distinct files", u && g && u !== g && u !== "/nonexistent", `${u} ${g}`);
    check("wrapper: the config files are removed afterwards", u && !existsSync(u) && !existsSync(g));
  }
  {
    const a = join(tmp, "cfg-a"), b = join(tmp, "cfg-b"), l = join(tmp, "cfg-l"), full = join(tmp, "cfg-full");
    writeFileSync(a, "");
    writeFileSync(b, "");
    writeFileSync(full, "x=1\n");
    symlinkSync(a, l);
    check("isolation: two empty files pass", isolationProblem(a, b) === null);
    reason("isolation: the same path", runNpm(["--version"], { cwd: pkg, env: fakeEnv("good"), configs: [a, a] }), "npm config isolation failed: the same path");
    reason("isolation: a symlink to the other", runNpm(["--version"], { cwd: pkg, env: fakeEnv("good"), configs: [a, l] }), "npm config isolation failed: the same file");
    reason("isolation: a non-empty file", runNpm(["--version"], { cwd: pkg, env: fakeEnv("good"), configs: [a, full] }), "npm config isolation failed: " + full + " is not an empty regular file");
  }
  // ---- the real npm (smoke): the wrapper's own spawn, the exact flags, a hostile parent environment
  {
    const real = join(tmp, "real");
    mkdirSync(join(real, "lib"), { recursive: true });
    writeFileSync(join(real, "a.txt"), "0123456789");
    writeFileSync(join(real, "lib", "b.js"), "module.exports = 1;\n");
    writeFileSync(join(real, "package.json"), JSON.stringify({ name: "sagebrush", version: "0.0.1", files: ["a.txt", "lib/b.js"], scripts: { prepack: "node -e \"require('fs').writeFileSync('ran','')\"" } }) + "\n");
    const hostile = { ...process.env, npm_config_ignore_scripts: "false", NPM_CONFIG_DRY_RUN: "false", npm_config_userconfig: "/nonexistent" };
    delete hostile.FAKE_NPM;
    const r = packDir(real, { env: hostile });
    check("real npm: packs", !r.reason && /^\d+\.\d+\.\d+/.test(r.key.npm ?? ""), JSON.stringify(r).slice(0, 400));
    if (!r.reason) {
      const want = ["a.txt", "lib/b.js", "package.json"].map((p) => [p, statSync(join(real, p)).size]);
      check("real npm: the exact entries and sizes", JSON.stringify(r.files) === JSON.stringify(want) && r.entryCount === 3, JSON.stringify(r.files));
      check("real npm: the exact unpackedSize", r.unpackedSize === want.reduce((s, f) => s + f[1], 0), String(r.unpackedSize));
      const rec = makeRecord({ commit: "c", tree: "t", run: {}, m: r });
      check("real npm: the record validates", recordProblems(rec).length === 0, recordProblems(rec).join("; "));
    }
    check("real npm: no tarball written (--dry-run held)", !readdirSync(real).some((f) => f.endsWith(".tgz")));
    check("real npm: no script ran (--ignore-scripts held)", !existsSync(join(real, "ran")));
  }
  // ---- the base binding
  {
    const sizes = { commit: "b".repeat(40), tree: "t".repeat(40), run: { id: "9", attempt: "1", job: "checks" } };
    const good = { format: FORMAT, v: 1, ...sizes, key: { npm: "1", node: "1", script_sha256: "s" }, size: 1, unpackedSize: 1, entryCount: 1, files: [["a", 1]] };
    check("bind: the same producer", bindFetched(sizes, good) === good);
    check("bind: another commit", bindFetched(sizes, { ...good, commit: "x" }).unavailable === "the base's npm-pack record names another commit");
    check("bind: another tree", bindFetched(sizes, { ...good, tree: "x" }).unavailable === "the base's npm-pack record names another tree");
    check("bind: another run", bindFetched(sizes, { ...good, run: { ...sizes.run, attempt: "2" } }).unavailable === "the base's npm-pack record names another run");
    check("bind: a record that predates the metrics", bindFetched(sizes, { unavailable: "no npm-pack record" }).unavailable === "n/a (the base's record predates npm-pack metrics)");
    writeFileSync(join(tmp, "bad.json"), "{");
    check("read: a malformed record", /^a malformed npm-pack record/.test(readRecord(join(tmp, "bad.json")).unavailable));
    writeFileSync(join(tmp, "bad2.json"), JSON.stringify({ ...good, unpackedSize: 2 }));
    check("read: an inconsistent record", /don't sum to unpackedSize/.test(readRecord(join(tmp, "bad2.json")).unavailable));
    writeFileSync(join(tmp, "bad3.json"), JSON.stringify({ ...good, files: [["a", 1], ["a", 0]], entryCount: 2 }));
    check("read: a duplicate path in a record", /a duplicate path/.test(readRecord(join(tmp, "bad3.json")).unavailable));
    check("read: a missing record", readRecord(join(tmp, "none.json")).unavailable === "no npm-pack record");
    // (NPM-PACK-138-2: a record-supplied reason is held to the same envelope as the wrapper's own)
    writeFileSync(join(tmp, "long.json"), JSON.stringify({ format: FORMAT, v: 1, commit: "c", tree: "t", run: {}, key: null, unavailable: "r".repeat(1000) + "\u0001\u001b[31m\nx" }));
    const lr = readRecord(join(tmp, "long.json"));
    check("read: a long record-supplied reason is clipped", typeof lr.unavailable === "string" && lr.unavailable.length <= CAPS.reason_chars && !/[\u0000-\u001f\u007f]/.test(lr.unavailable), JSON.stringify(lr.unavailable?.length));
    const lrep = report(lr, lr, "transition").join("\n");
    check("report: a long record-supplied reason stays within the cap", lrep.split("\n").every((l) => l.length <= CAPS.reason_chars + 100) && !/[\u0000-\u0009\u000b-\u001f]/.test(lrep), String(Math.max(...lrep.split("\n").map((l) => l.length))));
  }
  // ---- the report
  {
    const key = { npm: "11.20.0", node: "24.21.0", script_sha256: "s" };
    const r = (size, files, k = key) => ({ format: FORMAT, v: 1, commit: "c", tree: "t", run: {}, key: k, size, unpackedSize: files.reduce((s, f) => s + f[1], 0), entryCount: files.length, files });
    const M = r(1000, [["a", 10], ["b", 20]]), B = r(900, [["a", 10], ["b", 15]]);
    const normal = report(M, B, "transition").join("\n");
    check("report: normal shows Δ", normal.includes("| packed (`size`) | 900 | 1,000 | +100 |") && normal.includes("| unpacked (`unpackedSize`) | 25 | 30 | +5 |") && normal.includes("| entries | 2 | 2 | 0 |"), normal);
    check("report: normal lists the changed file", normal.includes("- b: 15 → 20") && !normal.includes("- a:"), normal);
    const kd = report(M, r(900, [["a", 10]], { ...key, npm: "11.0.0" }), "transition").join("\n");
    check("report: a key mismatch prints no Δ", kd.includes("| packed (`size`) | 900 | 1,000 |  |") && kd.includes("not comparable: key differs"), kd);
    const nb = report(M, { unavailable: "no npm-pack record" }, "transition").join("\n");
    check("report: a missing base record", nb.includes("| packed (`size`) | n/a | 1,000 |  |") && nb.includes("- base: no npm-pack record"), nb);
    const na = report(M, { unavailable: "n/a (the base's record predates npm-pack metrics)" }, "transition").join("\n");
    check("report: an n/a base", na.includes("predates npm-pack metrics"), na);
    check("report: an absolute run", report(M, B, "absolute").join("\n").includes("- base: no base (absolute run)"));
    check("report: a malformed base", report(M, { unavailable: "a malformed npm-pack record: x" }, "transition").join("\n").includes("- base: a malformed npm-pack record: x"));
    check("report: an unavailable merge", report({ unavailable: "missing from the pack: dist/sagebrush.cjs" }, B, "transition").join("\n").includes("merge: unavailable: missing from the pack: dist/sagebrush.cjs"));
    check("report: a missing merge record", report({ unavailable: "no npm-pack record" }, B, "transition").join("\n").includes("merge: unavailable: no npm-pack record"));
    const hostile = report({ unavailable: "x | y `z` <b>[l](u)\\\nnext" }, B, "transition").join("\n");
    check("report: a hostile reason is escaped", hostile.includes("x \\| y \\`z\\` \\<b\\>\\[l\\](u)\\\\ next"), hostile);
    const hp = report(r(1, [["p|`<x>`", 2]]), r(1, [["p|`<x>`", 1]]), "transition").join("\n");
    check("report: a hostile path is escaped", hp.includes("- p\\|\\`\\<x\\>\\`: 1 → 2"), hp);
    check("md: newlines become spaces", md("a\r\nb") === "a b");
  }
  // ---- the workflow contract (PLAN-NPM-PACK-1)
  {
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const job = (name) => {
      const start = ci.indexOf(`\n  ${name}:\n`);
      const rest = ci.slice(start + 1);
      const end = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
      return end < 0 ? rest : rest.slice(0, end + 1);
    };
    const steps = (j) => j.split(/\n      - /).slice(1);
    const sb = steps(job("size-base"));
    const iPack = sb.findIndex((s) => s.includes("npm-pack-metrics.mjs --base"));
    const iRecord = sb.findIndex((s) => s.startsWith("name: record (the base)"));
    const iOld = sb.findIndex((s) => /\n {8}if: .*need_old/.test(s));
    check("contract: size-base packs after the base record and before the old-key toolchain", iRecord >= 0 && iPack === iRecord + 1 && iOld > iPack, `${iRecord} ${iPack} ${iOld}`);
    const ck = steps(job("checks"));
    const iRec = ck.findIndex((s) => s.includes("npm-pack-metrics.mjs --record"));
    const iSizes = ck.findIndex((s) => s.startsWith("name: the size record"));
    const iUp = ck.findIndex((s) => s.includes("name: sizes-${{ github.sha }}"));
    check("contract: checks records after the size record and before the upload", iSizes >= 0 && iRec > iSizes && iUp > iRec, `${iSizes} ${iRec} ${iUp}`);
    check("contract: the upload is the size-record directory (sizes.json at its root)", iUp >= 0 && /\n {10}path: \$\{\{ runner\.temp \}\}\/size-record\/?\n/.test(ck[iUp] + "\n") && ck.some((s) => s.includes('--record --out "$RUNNER_TEMP/size-record/sizes.json"')), ck[iUp]);
    const sg = steps(job("size-gate"));
    const iGate = sg.findIndex((s) => s.startsWith("name: the gate\n"));
    const iRep = sg.findIndex((s) => s.includes("npm-pack-metrics.mjs --report"));
    check("contract: the report runs after the gate, with if: always()", iGate >= 0 && iRep > iGate && /\n {8}if: always\(\)\n/.test(sg[iRep]), sg[iRep]);
    for (const [where, s] of [["checks", ck[iRec]], ["size-base", sb[iPack]], ["size-gate", sg[iRep]]]) check(`contract: the ${where} npm-pack step is continue-on-error`, /\n {8}continue-on-error: true\n/.test(s ?? ""), s);
    check("contract: the tests run in checks", ck.some((s) => s.includes("node scripts/test-npm-pack-metrics.mjs")));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`npm-pack-metrics: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
