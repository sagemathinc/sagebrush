import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// xml.etree (P3c-2): CPython 3.14.10's ElementTree, ElementPath, ElementInclude and cElementTree, unchanged, over
// Sagebrush's pyexpat. test/etree_cases.py; its .out is CPython 3.14.10's, run with the C accelerator blocked, so
// the oracle is the same pure-Python ElementTree that Sagebrush ships.
const ROOT = join(__dirname, "../..");
const CASES = join(ROOT, "test/etree_cases.py");
const OUT = join(ROOT, "test/etree_cases.out");

test("xml.etree: parsing, building, ElementPath, iterparse, pull parsing, writing, C14N, as CPython 3.14.10", () => {
  const want = readFileSync(OUT, "utf8").split("\n");
  const got = execFileSync(process.execPath, [join(__dirname, "../src/cli.js"), CASES], { encoding: "utf8" }).split("\n");
  assert.ok(want.length > 150, "the recording has every case");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `etree_cases.py line ${i + 1}`);
});

// (the recording's provenance: CI's CPython, when it is 3.14.10, prints the committed .out)
test("etree_cases.out is what CPython 3.14.10 prints", (t) => {
  const v = execFileSync("python3", ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8" }).trim();
  if (v !== "3.14.10") return t.skip(`python3 is ${v}, not the recording's 3.14.10`);
  assert.equal(execFileSync("python3", ["-I", CASES], { encoding: "utf8" }), readFileSync(OUT, "utf8"));
});

// the shipped files are CPython 3.14.10's, byte for byte below the one header line each carries: pinned by their
// SHA-256s in CPython 3.14.10's Lib/xml/etree, and compared with the machine's own when its python3 is 3.14.10
const UPSTREAM: Record<string, string> = {
  "__init__.py": "91950edfb196c105d93886f8af7ea3c0a79e06a6b63be3e5a4ea09804e8672a6",
  "ElementTree.py": "850760098750fbce571ca4411ec444e70d73a0afe3efe74541d4eb99b3ab1b63",
  "ElementPath.py": "f9c2102cf56cf9859d34e69877ad4e8a04a0cdabb6390cf2189f04aa8101759f",
  "ElementInclude.py": "8e10c99668216701224831c82f13b36d29cd408554c19e34d290c351595df4ce",
  "cElementTree.py": "d0f57acab07fe4f9c116c3392d85946bac8e78608f409cea70005f16ea019b57",
};
const shipped = (f: string) => {
  const ours = readFileSync(join(ROOT, "lib/xml/etree", f), "utf8");
  assert.match(ours, /^# Copied unchanged from CPython 3\.14 Lib\/xml\/etree\/[A-Za-z_]+\.py \(PSF License; see cdn\/LICENSE-CPython\.txt\)\.\n/, f);
  return ours.slice(ours.indexOf("\n") + 1);
};

test("lib/xml/etree is CPython 3.14.10's, unchanged but for the header line", async () => {
  const { createHash } = await import("node:crypto");
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(join(ROOT, "lib/xml/etree")).sort(), Object.keys(UPSTREAM).sort());
  for (const [f, sha] of Object.entries(UPSTREAM)) assert.equal(createHash("sha256").update(shipped(f)).digest("hex"), sha, f);
});

test("the pins are the machine's CPython 3.14.10 Lib/xml/etree", (t) => {
  const dir = execFileSync("python3", ["-I", "-c", "import sys, xml.etree, os; print('%d.%d.%d' % sys.version_info[:3], os.path.dirname(xml.etree.__file__))"], { encoding: "utf8" }).trim().split(" ");
  if (dir[0] !== "3.14.10") return t.skip(`python3 is ${dir[0]}, not 3.14.10`);
  for (const f of Object.keys(UPSTREAM)) assert.equal(shipped(f), readFileSync(join(dir[1], f), "utf8"), f);
});

// every open() xml.etree makes, under a spy, in a fresh directory (the design note's inventory): parse and iterparse
// read a path, write writes one, ElementInclude's default loader reads an href only in include(); a document with an
// xi:include, an external entity or a DTD opens nothing. test/etree_files.out is CPython 3.14.10's (python3 -I).
const inTmp = (cmd: string, args: string[]) => {
  const { mkdtempSync, rmSync, readdirSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "sb-etree-"));
  try {
    const out = execFileSync(cmd, args, { cwd: dir, encoding: "utf8" });
    assert.deepEqual(readdirSync(dir), [], "the script removes what it wrote");
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const FILES_PY = join(ROOT, "test/etree_files.py");
const FILES_OUT = join(ROOT, "test/etree_files.out");

test("xml.etree's file paths: every open() it makes, and none while parsing, as CPython 3.14.10", () => {
  const want = readFileSync(FILES_OUT, "utf8").split("\n");
  const got = inTmp(process.execPath, [join(__dirname, "../src/cli.js"), FILES_PY]).split("\n");
  assert.ok(want.length > 20);
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `etree_files.py line ${i + 1}`);
});

test("etree_files.out is what CPython 3.14.10 prints", (t) => {
  const v = execFileSync("python3", ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8" }).trim();
  if (v !== "3.14.10") return t.skip(`python3 is ${v}, not the recording's 3.14.10`);
  assert.equal(inTmp("python3", ["-I", FILES_PY]), readFileSync(FILES_OUT, "utf8"));
});

// (found by the inventory: open()'s errors= on a text file's writes; ElementTree's write(path) is us-ascii with
// "xmlcharrefreplace")
test("open() writes a text file with the errors= handler given, as CPython", () => {
  const f = join(ROOT, "test/open_errors_cases.py");
  const want = execFileSync("python3", ["-I", f], { encoding: "utf8" });
  assert.equal(execFileSync(process.execPath, [join(__dirname, "../src/cli.js"), f], { encoding: "utf8" }), want);
});

// real SVG files, made at test time and never committed: Sagebrush's own matplotlib plot always; matplotlib's when
// the machine's python3 has it; Sage's when SAGEBRUSH_SAGE_ORACLE names a Sage. Each parsed by CPython's pure-Python
// ElementTree and by Sagebrush's, test/etree_svg.py printing the same lines.
test("xml.etree over real SVG files (Sagebrush's, matplotlib's, Sage's) reads what CPython reads", (t) => {
  const v = execFileSync("python3", ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" }).trim();
  if (v !== "3.14") return t.skip(`python3 is ${v}, not 3.14`);
  const { mkdtempSync, rmSync, existsSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "sb-etree-svg-"));
  try {
    const cli = join(__dirname, "../src/cli.js");
    const plot = `import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([1, 2, 3], [1, 4, 9], label="sq"); ax.scatter([1, 2], [3, 4]); ax.bar([1, 2], [2, 1])
ax.set_title("caf\\u00e9 & tea"); ax.legend()
fig.savefig(%r)`;
    execFileSync(process.execPath, [cli, "-c", plot.replace("%r", JSON.stringify(join(dir, "sagebrush.svg")))], { encoding: "utf8" });
    const files = [join(dir, "sagebrush.svg")];
    try {
      execFileSync("python3", ["-c", 'import matplotlib; matplotlib.use("svg")\n' + plot.replace("%r", JSON.stringify(join(dir, "matplotlib.svg")))], { stdio: "ignore" });
      files.push(join(dir, "matplotlib.svg"));
    } catch {
      t.diagnostic("python3 has no matplotlib: its SVG is not compared");
    }
    const sage = process.env.SAGEBRUSH_SAGE_ORACLE;
    if (sage) {
      execFileSync(sage, ["-c", `(plot(sin, (0, 6)) + text("caf\\u00e9", (1, 0.5))).save(${JSON.stringify(join(dir, "sage.svg"))})`], { stdio: "ignore", timeout: 600000 });
      files.push(join(dir, "sage.svg"));
    } else t.diagnostic("SAGEBRUSH_SAGE_ORACLE is not set: Sage's SVG is not compared");
    for (const f of files) assert.ok(existsSync(f), f);
    const svgPy = join(ROOT, "test/etree_svg.py");
    const want = execFileSync("python3", ["-I", svgPy, ...files], { encoding: "utf8" }).split("\n");
    const got = execFileSync(process.execPath, [cli, svgPy, ...files], { encoding: "utf8" }).split("\n");
    assert.equal(want.length, 1 + 13 * files.length);
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `etree_svg.py line ${i + 1}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
