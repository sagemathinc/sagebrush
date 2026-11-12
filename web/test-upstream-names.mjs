// ci: checks.3 order=131
// The real systems' names in the function search (web/upstream-names.mts), on a built web/dist:
// - exactly the six lists (catalog/<mode>/upstream.txt) and the page's four files, each list within its caps, and the
//   caps refusing what is over them (controls);
// - every name of a page language's list exactly once in its search: in its index, or in its file as Not yet or
//   undocumented, as Sagebrush's own runtime says (the probe run again here gives the same bytes);
// - the files are LAZY (the "docs" offline item), never in the shell, and the names stay out of the CLI bundle (so
//   the npm package), the Python package, the app and the indexes.
//
//   node scripts/build-cli.mjs && bun web/build.ts && node web/test-upstream-names.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPSTREAM_CAPS, UPSTREAM_LISTS, UPSTREAM_MODES, checkUpstreamTotal, parseUpstream, upstreamAsset, upstreamBytes } from "./upstream-names.mts";

let failures = 0;
const ok = (c, name) => (console.log((c ? "ok   " : "FAIL ") + name), c || failures++);
const refuses = (f, re) => { try { f(); return false; } catch (e) { return re.test(String(e)); } };
const here = new URL(".", import.meta.url).pathname, root = join(here, "..");
const dist = (f) => join(here, "dist", f);

// the census: the six lists, the four files
const lists = execFileSync("git", ["ls-files", "catalog/*/upstream.txt"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean).sort();
ok(JSON.stringify(lists) === JSON.stringify(UPSTREAM_LISTS.map((m) => `catalog/${m}/upstream.txt`).sort()), "exactly the six lists are in git: " + lists.join(", "));
const files = readdirSync(join(here, "dist")).filter((f) => f.startsWith("docs-upstream-")).sort();
ok(JSON.stringify(files) === JSON.stringify(UPSTREAM_MODES.map((m) => `docs-upstream-${m}.json`).sort()), "exactly the page's four files are built: " + files.join(", "));

// each list within its caps
const rows = {};
for (const m of UPSTREAM_LISTS) rows[m] = parseUpstream(readFileSync(join(root, "catalog", m, "upstream.txt"), "utf8"), m);
ok(UPSTREAM_LISTS.every((m) => rows[m].length > 0 && rows[m].length <= UPSTREAM_CAPS.names), "every list has names, at most " + UPSTREAM_CAPS.names + ": " + UPSTREAM_LISTS.map((m) => `${m} ${rows[m].length}`).join(", "));

// the controls: what's over a cap, or not a name, is refused
const big = (n) => Array.from({ length: n }, (_, i) => "n" + i).join("\n");
ok(refuses(() => parseUpstream("a\nb\na\n", "t"), /"a" is listed twice/), "a name listed twice is refused");
ok(refuses(() => parseUpstream("a b\n", "t"), /whitespace/) && refuses(() => parseUpstream("a\u0007\n", "t"), /control/) && refuses(() => parseUpstream("\tg\n", "t"), /blank/), "a name with a space, a control character, or none, is refused");
ok(refuses(() => parseUpstream("x".repeat(UPSTREAM_CAPS.nameBytes + 1), "t"), /over 120 bytes/) && !refuses(() => parseUpstream("x".repeat(UPSTREAM_CAPS.nameBytes), "t"), /./), "a name over its byte cap is refused, one at it isn't");
ok(refuses(() => parseUpstream("a\tg\th\n", "t"), /two tabs/) && refuses(() => parseUpstream("a\t" + "g".repeat(UPSTREAM_CAPS.groupBytes + 1), "t"), /group/), "a line with two tabs, or an over-long group, is refused");
ok(refuses(() => parseUpstream(big(UPSTREAM_CAPS.names + 1), "t"), /names, over/) && parseUpstream(big(UPSTREAM_CAPS.names), "t").length === UPSTREAM_CAPS.names, "a list over its name cap is refused, one at it isn't");
ok(refuses(() => parseUpstream(Array.from({ length: UPSTREAM_CAPS.groups + 1 }, (_, i) => `n${i}\tg${i}`).join("\n"), "t"), /groups, over/), "a list over its group cap is refused");
ok(refuses(() => upstreamBytes({ groups: [], absent: ["x".repeat(UPSTREAM_CAPS.fileBytes)], present: [] }, "t"), /over 196608/), "a file over its byte cap is refused");
ok(refuses(() => checkUpstreamTotal({ a: UPSTREAM_CAPS.allBytes, b: 1 }), /in all, over/) && !refuses(() => checkUpstreamTotal({ a: UPSTREAM_CAPS.allBytes }), /./), "the files over their aggregate cap are refused, at it they aren't");

// a name the index has as an alias is documented there, so it isn't listed again; one it lacks is
const aliased = upstreamAsset(parseUpstream("max\nmaximum\nmin\n", "t"), new Set(["min"]), [{ name: "max", aliases: ["maximum"] }]);
ok(JSON.stringify(aliased) === JSON.stringify({ groups: [], absent: [], present: ["min"] }), "a documented entry's name and aliases aren't listed as upstream: " + JSON.stringify(aliased));

// the probe's rules, on the runtime (scripts/upstream-probe.py run as the build runs it, on a small list)
const tmp = mkdtempSync(join(tmpdir(), "sb-up-"));
const probe = (mode, names, prelude = "") => {
  const list = join(tmp, mode + ".txt");
  writeFileSync(list, names.join("\n") + "\n");
  const code = `${prelude}\nimport sys\nsys.argv = ["upstream-probe.py", ${JSON.stringify(mode)}, ${JSON.stringify(list)}]\nexec(compile(open(${JSON.stringify(join(root, "scripts", "upstream-probe.py"))}).read(), "upstream-probe.py", "exec"), {"__name__": "__main__"})`;
  return execFileSync("node", [join(root, "build", "cli", "pyjs.cjs"), "-c", code], { encoding: "utf8" }).split("\n").filter(Boolean);
};
// (Python: a module that imports but lacks the attribute, and one that doesn't import, are both absent)
const py = probe("python", ["math.sqrt", "math.no_such_attribute", "math", "no_such_module_x.f"]);
ok(JSON.stringify(py) === JSON.stringify(["math.sqrt", "math"]), "python: a missing attribute of a module that imports is absent, as is a module that doesn't import: " + JSON.stringify(py));
// (Magma: a name whose translation is a Python keyword plus "_" is present; with no such intrinsic in Magma mode
// today, a stand-in _magma that exports one)
const mg = probe("magma", ["in", "Factorization", "NoSuchIntrinsic"], "import sys\nclass M: __all__ = ['in_', 'Factorization']\nsys.modules['_magma'] = M()");
ok(JSON.stringify(mg) === JSON.stringify(["in", "Factorization"]), "magma: a keyword name exported as keyword + _ is present, an unexported one absent: " + JSON.stringify(mg));
rmSync(tmp, { recursive: true, force: true });

// the probe again, and each list's file again: the same bytes (for the page's four), within the caps (all six)
const sizes = {}, assets = {};
for (const m of UPSTREAM_LISTS) {
  const out = execFileSync("node", [join(root, "build", "cli", "pyjs.cjs"), ...(m === "sage" ? ["--sage"] : []), join(root, "scripts", "upstream-probe.py"), m, join(root, "catalog", m, "upstream.txt")], { encoding: "utf8", maxBuffer: 1 << 26 });
  const index = UPSTREAM_MODES.includes(m) ? JSON.parse(readFileSync(dist(m === "sage" ? "docs-index.json" : `docs-index-${m}.json`), "utf8")) : [];
  assets[m] = upstreamAsset(rows[m], new Set(out.split("\n").filter(Boolean)), index);
  const bytes = upstreamBytes(assets[m], m);
  sizes[m] = bytes.length;
  if (UPSTREAM_MODES.includes(m)) ok(Buffer.compare(Buffer.from(bytes), readFileSync(dist(`docs-upstream-${m}.json`))) === 0, `${m}: the probe run again gives the built file's bytes (${bytes.length} B, ${assets[m].absent.length} Not yet, ${assets[m].present.length} undocumented)`);
}
ok(!refuses(() => checkUpstreamTotal(sizes), /./), `all six files, ${Object.values(sizes).reduce((a, b) => a + b, 0)} B, within ${UPSTREAM_CAPS.allBytes}`);

// every name once: in the index (a name or an alias), or in the file, as Not yet or undocumented
const once = (m, asset) => {
  const index = JSON.parse(readFileSync(dist(m === "sage" ? "docs-index.json" : `docs-index-${m}.json`), "utf8"));
  const count = new Map();
  const add = (n) => count.set(n, (count.get(n) ?? 0) + 1);
  // (an index's names once each: Magma's lists an overloaded intrinsic once per signature)
  new Set(index.flatMap((e) => [e.name, ...(e.aliases ?? [])])).forEach(add);
  for (const r of [...asset.absent, ...asset.present]) add(r.split("\t")[0]);
  return rows[m].filter((r) => count.get(r.name) !== 1).map((r) => r.name);
};
for (const m of UPSTREAM_MODES) {
  const asset = JSON.parse(readFileSync(dist(`docs-upstream-${m}.json`), "utf8"));
  const bad = once(m, asset);
  ok(bad.length === 0, `${m}: each of its ${rows[m].length} names is in its search exactly once` + (bad.length ? `: not ${bad.slice(0, 5).join(", ")}` : ""));
  ok(asset.absent.concat(asset.present).every((r) => { const [, g] = r.split("\t"); return g === undefined || asset.groups[+g] !== undefined; }), `${m}: each group a name names is in its file's groups`);
  // (controls: a name dropped from the file, or listed in it twice, is caught)
  if (asset.absent.length) {
    ok(once(m, { ...asset, absent: asset.absent.slice(1) }).length === 1 && once(m, { ...asset, absent: [asset.absent[0], ...asset.absent] }).length === 1, `${m}: (control) a name dropped from its file, or in it twice, is caught`);
  }
}
// the page shows Not yet exactly for what the runtime lacks: the probe's other answer is an undocumented name
ok(assets.matlab.absent.some((r) => r.startsWith("fir1\t")) && assets.python.present.includes("abc.ABC") && assets.python.absent.includes("asyncio.run"), "fir1 (MATLAB) and asyncio.run (Python) are Not yet; abc.ABC (Python) is undocumented");

// LAZY, the "docs" item, never the shell
const sw = readFileSync(dist("sw.js"), "utf8");
const literal = (name) => JSON.parse(new RegExp(`^const ${name} = (.*);$`, "m").exec(sw)[1]);
const LAZY = literal("LAZY"), SHELL = literal("SHELL");
ok(files.every((f) => LAZY.includes(f)) && !SHELL.some((p) => p.startsWith("docs-")), "the files are LAZY (kept once used), not in the shell every visitor downloads");
const inv = JSON.parse(readFileSync(dist("offline-inventory.json"), "utf8"));
const docs = inv.items.find((it) => it.id === "docs");
ok(docs?.files === 4 + files.length, `the "docs" offline item holds the indexes and the files: ${docs?.files} files`);

// the names stay out: the CLI bundle (the npm package's sagebrush.cjs), the Python package, the app and the indexes
// (names only the files have, and a list's own header; the CLI's page, index.html, names the files, not their names)
const sentinels = ["AcceleratedLifeModel", "AggregateBayesianOptimization", "annotationlib.ForwardRef", "AbelianGroupWithValues", "the names of its function reference"];
ok(!/docs-upstream/.test(readFileSync(join(root, "app", "build-frontend.mjs"), "utf8")) && !readdirSync(join(root, "engine", "py", "python", "sagebrush", "_sagelib")).some((f) => f.startsWith("docs-upstream")), "the app's and the Python package's files name none of the files");
ok(UPSTREAM_MODES.every((m) => assets[m].absent.length > 0) && ["AcceleratedLifeModel\t0", "annotationlib.ForwardRef", "AbelianGroupWithValues"].every((s) => Object.values(assets).some((a) => a.absent.includes(s) || a.absent.some((r) => r.startsWith(s + "\t")))), "(the sentinels are names of the files)");
const outside = [join(root, "build", "cli", "pyjs.cjs"), ...readdirSync(join(root, "engine", "py", "python", "sagebrush", "_sagelib")).map((f) => join(root, "engine", "py", "python", "sagebrush", "_sagelib", f)), ...readdirSync(join(here, "dist")).filter((f) => f.startsWith("docs-index")).map(dist), join(root, "app", "build-frontend.mjs")];
const leaks = outside.filter((p) => existsSync(p) && statSync(p).isFile() && sentinels.some((s) => readFileSync(p, "utf8").includes(s)));
ok(leaks.length === 0, `no name of the files is in the CLI bundle, the Python package, an index or the app's file list (${outside.length} files)` + (leaks.length ? ": " + leaks.join(", ") : ""));
const appDist = join(root, "app", "dist");
ok(!existsSync(appDist) || !readdirSync(appDist).some((f) => f.startsWith("docs-upstream-")), "app/dist (where built) has none of the files");

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
