import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { installEmbeddedLib, installEmbeddedPackages, libEmbedStats, PACKAGE_BLOB_BYTES } from "../src/lib-embed";

// The CLI's embedded library, compressed (src/lib-embed.ts; plan cli-lib-gzip-plan-r1): the payload made exactly as
// scripts/build-cli.mjs makes it, decoded by the production installer on a fresh global object.

const ROOT = join(__dirname, "..", "..");
// (scripts/build-id.mjs is the library's one definition, which build-cli.mjs uses too)
const libFiles = async () => (await import(join(ROOT, "scripts", "build-id.mjs"))).libFiles(ROOT + "/") as Record<string, string>;
const payloadOf = (lib: unknown) => gzipSync(Buffer.from(JSON.stringify(lib), "utf8"), { level: 9 }).toString("base64");

test("the embedded library decodes to exactly the library: every path, every source, byte for byte", async () => {
  const lib = await libFiles();
  assert.ok(Object.keys(lib).length > 100, "the real library");
  const g: any = {};
  installEmbeddedLib(g, payloadOf(lib));
  const got = g.__PYJS_LIB__;
  assert.deepEqual(Object.keys(got).sort(), Object.keys(lib).sort());
  for (const k of Object.keys(lib)) assert.ok(Buffer.from(got[k], "utf8").equals(Buffer.from(lib[k], "utf8")), `${k}: the same bytes`);
});

test("decoded once: the getter becomes a plain data property (a global assignment's flags), the compressed string goes, the same object after", async () => {
  const g: any = {};
  installEmbeddedLib(g, payloadOf({ "a.py": "x = 1\n", "b/c.py": "é\n" }));
  assert.equal(typeof g.__PYJS_LIB_GZ__, "string", "compressed until read");
  assert.equal(typeof Object.getOwnPropertyDescriptor(g, "__PYJS_LIB__")!.get, "function", "a getter until read");
  const before = libEmbedStats.decodes;
  const first = g.__PYJS_LIB__;
  assert.equal(libEmbedStats.decodes, before + 1, "the production decoder ran once");
  const d = Object.getOwnPropertyDescriptor(g, "__PYJS_LIB__")!;
  assert.deepEqual({ get: d.get, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable }, { get: undefined, writable: true, enumerable: true, configurable: true });
  assert.equal("__PYJS_LIB_GZ__" in g, false, "the compressed string deleted");
  assert.equal(g.__PYJS_LIB__, first, "the same object on the second read");
  assert.equal(libEmbedStats.decodes, before + 1, "and no second decode");
  assert.deepEqual(first, { "a.py": "x = 1\n", "b/c.py": "é\n" });
});

test("a failed decode throws its own error and installs nothing: the getter and the compressed string stay", () => {
  const g: any = {};
  installEmbeddedLib(g, Buffer.from("not gzip").toString("base64"));
  assert.throws(() => g.__PYJS_LIB__, (e: any) => e && /header|gzip|incorrect/i.test(String(e.message ?? e)));
  assert.equal(typeof g.__PYJS_LIB_GZ__, "string", "the compressed string kept");
  assert.equal(typeof Object.getOwnPropertyDescriptor(g, "__PYJS_LIB__")!.get, "function", "still the getter");
  // (not UTF-8 inside a valid gzip: the decoder's TypeError, nothing installed.  The bytes are valid JSON but for
  // the 0xff inside the string, so a lossy decode would parse and install {"a.py": "\ufffd"}: this pins fatal: true)
  const h: any = {};
  installEmbeddedLib(h, gzipSync(Buffer.concat([Buffer.from('{"a.py":"', "utf8"), Buffer.from([0xff]), Buffer.from('"}', "utf8")])).toString("base64"));
  assert.throws(() => h.__PYJS_LIB__, TypeError);
  assert.equal(typeof h.__PYJS_LIB_GZ__, "string", "the compressed string kept");
  assert.equal(typeof Object.getOwnPropertyDescriptor(h, "__PYJS_LIB__")!.get, "function", "still the getter");
});

test("an assignment before any read replaces the getter with the value, as a plain global would", () => {
  const g: any = {};
  installEmbeddedLib(g, payloadOf({ "a.py": "1\n" }));
  const before = libEmbedStats.decodes;
  g.__PYJS_LIB__ = { "z.py": "2\n" };
  assert.deepEqual(g.__PYJS_LIB__, { "z.py": "2\n" });
  assert.equal(libEmbedStats.decodes, before, "nothing decoded");
  assert.equal("__PYJS_LIB_GZ__" in g, false);
});

// (the lazy part, P3a: names whose files come from a second blob, decoded on the first read of one of them; grader's
// r820 pins) a blob that isn't exactly the named files, one missing, one extra, or the same count with another
// name, throws at that first read and settles nothing: every lazy name stays its getter, and a later read throws
// again rather than finding a partial library; a name the eager part also has, or listed twice, is refused at install
test("the lazy part: a blob that isn't exactly its named files throws at the first read and settles none of them", () => {
  const eager = payloadOf({ "a.py": "1\n" });
  const names = ["l1.py", "l2.py"];
  const blobs: [string, Record<string, string>][] = [
    ["a name missing", { "l1.py": "x\n" }],
    ["an extra name", { "l1.py": "x\n", "l2.py": "y\n", "l3.py": "z\n" }],
    ["the same count, another name", { "l1.py": "x\n", "lx.py": "y\n" }],
  ];
  for (const [what, files] of blobs) {
    const g: any = {};
    installEmbeddedLib(g, eager, payloadOf(files), names);
    const lib = g.__PYJS_LIB__;
    assert.equal(lib["a.py"], "1\n", `${what}: the eager part is there`);
    for (const n of names) {
      assert.throws(() => lib[n], /the embedded library's lazy part is not the files it names/, `${what}: reading ${n}`);
      for (const m of names) assert.equal(typeof Object.getOwnPropertyDescriptor(lib, m)!.get, "function", `${what}: ${m} not settled after reading ${n}`);
    }
    assert.equal("lx.py" in lib || "l3.py" in lib, false, `${what}: no file of the bad blob installed`);
  }
  // (and the right blob settles both names as plain values, decoded once)
  const g: any = {};
  installEmbeddedLib(g, eager, payloadOf({ "l1.py": "x\n", "l2.py": "y\n" }), names);
  const lib = g.__PYJS_LIB__, before = libEmbedStats.lazyDecodes;
  assert.equal(lib["l2.py"], "y\n");
  assert.equal(lib["l1.py"], "x\n");
  assert.equal(libEmbedStats.lazyDecodes, before + 1, "decoded once");
  for (const n of names) assert.equal(Object.getOwnPropertyDescriptor(lib, n)!.value, lib[n], `${n} a plain value`);
});

test("the lazy part: a name the eager part also has, or a name listed twice, is refused", () => {
  const g: any = {};
  installEmbeddedLib(g, payloadOf({ "a.py": "1\n" }), payloadOf({ "a.py": "2\n" }), ["a.py"]);
  assert.throws(() => g.__PYJS_LIB__, /the embedded library names a\.py twice/);
  const h: any = {};
  installEmbeddedLib(h, payloadOf({ "a.py": "1\n" }), payloadOf({ "l.py": "2\n" }), ["l.py", "l.py"]);
  assert.throws(() => h.__PYJS_LIB__, /the embedded library names l\.py twice/);
});

// (keyed family blobs, design/rill.md §6.3 and daybreak2's ruling for Rill A1.1) each family decodes only on the first
// read of one of its own files, independently of pathlib's blob and of the other families, and is counted per key
test("keyed families: each decodes on the first read of its own files only, counted per key", () => {
  const g: any = {};
  installEmbeddedLib(g, payloadOf({ "a.py": "1\n" }), payloadOf({ "p.py": "p\n" }), ["p.py"], {
    rill: [payloadOf({ "_rill/__init__.py": "r\n", "_rill/lex.py": "l\n" }), ["_rill/__init__.py", "_rill/lex.py"]],
    other: [payloadOf({ "o.py": "o\n" }), ["o.py"]],
  });
  const lib = g.__PYJS_LIB__;
  const before = { lazy: libEmbedStats.lazyDecodes, rill: libEmbedStats.families.rill ?? 0, other: libEmbedStats.families.other ?? 0 };
  assert.equal(lib["a.py"], "1\n");
  assert.deepEqual(Object.keys(lib).sort(), ["_rill/__init__.py", "_rill/lex.py", "a.py", "o.py", "p.py"], "every name visible before any decode");
  assert.equal(libEmbedStats.families.rill ?? 0, before.rill, "no family decoded by the eager read");
  assert.equal(lib["_rill/lex.py"], "l\n");
  assert.equal(lib["_rill/__init__.py"], "r\n");
  assert.equal(libEmbedStats.families.rill, before.rill + 1, "rill decoded once for both its files");
  assert.equal(libEmbedStats.lazyDecodes, before.lazy, "pathlib's blob not decoded by rill's files");
  assert.equal(libEmbedStats.families.other ?? 0, before.other, "the other family not decoded");
  assert.equal(lib["p.py"], "p\n");
  assert.equal(libEmbedStats.lazyDecodes, before.lazy + 1);
  assert.equal(lib["o.py"], "o\n");
  assert.equal(libEmbedStats.families.other, before.other + 1);
  // (a family whose blob isn't exactly its names throws, as pathlib's does; a name in two families is refused)
  const h: any = {};
  installEmbeddedLib(h, payloadOf({ "a.py": "1\n" }), undefined, undefined, { rill: [payloadOf({ "_rill/x.py": "x\n" }), ["_rill/y.py"]] });
  assert.throws(() => h.__PYJS_LIB__["_rill/y.py"], /the embedded library's lazy part is not the files it names/);
  const k: any = {};
  installEmbeddedLib(k, payloadOf({ "a.py": "1\n" }), undefined, undefined, { one: [payloadOf({ "s.py": "1\n" }), ["s.py"]], two: [payloadOf({ "s.py": "2\n" }), ["s.py"]] });
  assert.throws(() => k.__PYJS_LIB__, /the embedded library names s\.py twice/);
});

// The CLI's packages (scripts/build-cli.mjs, installEmbeddedPackages): the registry plain, each package's files a blob
// of their own, decoded on the first read of one of its files, never at startup; @sagebrush's ruling, Nov 9, so that a
// package costs a run nothing until it is imported.
test("embedded packages: each package decodes on the first read of its own files only, counted per package", () => {
  const g: any = {};
  const reg = { format: 1, modules: { a: "@x/a@1", b: "@x/b@1" } };
  installEmbeddedPackages(g, reg, {
    "pkg-a": [payloadOf({ "pkg-a/py/a.py": "A\n", "pkg-a/py/a2.py": "A2\n" }), ["pkg-a/py/a.py", "pkg-a/py/a2.py"]],
    "pkg-b": [payloadOf({ "pkg-b/py/b.py": "B\n" }), ["pkg-b/py/b.py"]],
  });
  const P = g.__SAGEBRUSH_PACKAGES__, before = { a: libEmbedStats.packages["pkg-a"] ?? 0, b: libEmbedStats.packages["pkg-b"] ?? 0 };
  assert.equal(P.registry, reg, "the registry, plain");
  assert.deepEqual(Object.keys(P.files).sort(), ["pkg-a/py/a.py", "pkg-a/py/a2.py", "pkg-b/py/b.py"], "every file visible before any decode");
  assert.ok(Object.hasOwn(P.files, "pkg-b/py/b.py"), "as src/compile.ts asks");
  assert.equal(libEmbedStats.packages["pkg-a"] ?? 0, before.a, "nothing decoded yet");
  assert.equal(P.files["pkg-a/py/a2.py"], "A2\n");
  assert.equal(P.files["pkg-a/py/a.py"], "A\n");
  assert.equal(libEmbedStats.packages["pkg-a"], before.a + 1, "pkg-a decoded once for both its files");
  assert.equal(libEmbedStats.packages["pkg-b"] ?? 0, before.b, "pkg-b not decoded by pkg-a's files");
  assert.equal(P.files["pkg-b/py/b.py"], "B\n");
  assert.equal(libEmbedStats.packages["pkg-b"], before.b + 1);
});

test("embedded packages fail closed: a corrupt blob, one past its ceiling, or one that isn't exactly its names throws and settles nothing", () => {
  const good = payloadOf({ "p/py/x.py": "x\n" });
  // (corrupt: the gzip's data bytes changed; each read throws again, and the file stays a getter)
  const bytes = Buffer.from(good, "base64");
  for (let i = 12; i < bytes.length - 8; i++) bytes[i] ^= 0x5a;
  const c: any = {};
  installEmbeddedPackages(c, {}, { p: [bytes.toString("base64"), ["p/py/x.py"]] });
  assert.throws(() => c.__SAGEBRUSH_PACKAGES__.files["p/py/x.py"]);
  assert.throws(() => c.__SAGEBRUSH_PACKAGES__.files["p/py/x.py"], Error, "still not settled");
  assert.ok(Object.getOwnPropertyDescriptor(c.__SAGEBRUSH_PACKAGES__.files, "p/py/x.py")!.get, "a getter still");
  // (past PACKAGE_BLOB_BYTES inflated: refused while inflating, not after)
  const big: any = {};
  installEmbeddedPackages(big, {}, { p: [gzipSync(Buffer.from(JSON.stringify({ "p/py/x.py": "x".repeat(PACKAGE_BLOB_BYTES) }), "utf8"), { level: 1 }).toString("base64"), ["p/py/x.py"]] });
  assert.throws(() => big.__SAGEBRUSH_PACKAGES__.files["p/py/x.py"], RangeError);
  // (a blob whose files aren't its names; a name outside its package's directory)
  const m: any = {};
  installEmbeddedPackages(m, {}, { p: [payloadOf({ "p/py/y.py": "y\n" }), ["p/py/x.py"]] });
  assert.throws(() => m.__SAGEBRUSH_PACKAGES__.files["p/py/x.py"], /the embedded library's lazy part is not the files it names/);
  assert.throws(() => installEmbeddedPackages({}, {}, { p: [good, ["q/py/x.py"]] }), /names a file outside it/);
  // (a sibling whose name only starts with the package's: pkgs/tab's blob may not name pkgs/tabulate's files)
  assert.throws(() => installEmbeddedPackages({}, {}, { "pkgs/tab": [payloadOf({ "pkgs/tabulate/x.py": "x\n" }), ["pkgs/tabulate/x.py"]] }), /names a file outside it/);
});

// The CLI's packages.gen.js as scripts/build-cli.mjs writes it (scripts/packages.mjs packagesGenSource; the node
// suites run without a built bundle): every package file decodes to exactly the repository's bytes (each pinned by
// the registry's SHA-256 too, which src/compile.ts checks on import).
const packagesMjs = async () => await import(join(ROOT, "scripts", "packages.mjs"));
test("the CLI's packages.gen.js: each package's blob is exactly that package's files, byte for byte", async () => {
  const { readFileSync } = await import("node:fs");
  const { readPackages, packagesGenSource } = await packagesMjs();
  assert.match(readFileSync(join(ROOT, "scripts", "build-cli.mjs"), "utf8"), /writeFileSync\(join\(out, "packages\.gen\.js"\), packagesGenSource\(packages\)\);/, "build-cli.mjs writes exactly packagesGenSource's");
  const gen: string = packagesGenSource(readPackages(ROOT));
  const head = 'import { installEmbeddedPackages } from "../../src/lib-embed";\n';
  assert.ok(gen.startsWith(head), "the generated module installs the packages through src/lib-embed.ts");
  const g: any = {};
  new Function("globalThis", "installEmbeddedPackages", gen.slice(head.length))(g, installEmbeddedPackages);
  const P = g.__SAGEBRUSH_PACKAGES__;
  const reg = JSON.parse(readFileSync(join(ROOT, "packages", "registry.json"), "utf8"));
  assert.deepEqual(P.registry, reg, "the registry, as committed");
  const want: string[] = [];
  for (const pkg of Object.values(reg.packages) as any[]) for (const f of Object.keys(pkg.files)) want.push(`${pkg.dir}/${f}`);
  assert.deepEqual(Object.keys(P.files).sort(), want.sort(), "every registry file, and only those");
  for (const k of want) assert.equal(P.files[k], readFileSync(join(ROOT, "packages", k), "utf8"), k);
});

// The CLI with its packages embedded as the bundle carries them (installed by a preload before src/cli starts, as
// packages.gen.js runs before it in the bundle): a package's blob is decoded only when the package is imported. With
// tabulate's blob corrupted, a start still runs and imports another package; only `import tabulate` fails, closed.
test("the CLI decodes no package at startup: a corrupted package fails only its own import", async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "sb-lazy-pkg-"));
  try {
    const pre = join(dir, "packages-preload.mjs");
    writeFileSync(
      pre,
      [
        `import { createRequire } from "node:module";`,
        `import { readPackages, packageBlobs } from ${JSON.stringify(join(ROOT, "scripts", "packages.mjs"))};`,
        `const { installEmbeddedPackages } = createRequire(import.meta.url)(${JSON.stringify(join(__dirname, "..", "src", "lib-embed.js"))});`,
        `const p = readPackages(${JSON.stringify(ROOT)});`,
        `const blobs = packageBlobs(p.files);`,
        `if (process.env.CORRUPT) { const b = Buffer.from(blobs[process.env.CORRUPT][0], "base64"); for (let i = 12; i < b.length - 8; i++) b[i] ^= 0x5a; blobs[process.env.CORRUPT][0] = b.toString("base64"); }`,
        `installEmbeddedPackages(globalThis, p.registry, blobs);`,
      ].join("\n"),
    );
    const cli = join(__dirname, "..", "src", "cli.js");
    const run = (code: string, corrupt?: string) =>
      spawnSync(process.execPath, ["--import", pre, cli, "-c", code], { encoding: "utf8", env: { ...process.env, SAGEBRUSH_NO_COMPILE_CACHE: "1", CORRUPT: corrupt ?? "" } });
    // (the control: intact blobs import from the embedded copies, /$pyjs/packages)
    const ok = run("import tabulate; print(tabulate.__file__)");
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, "/$pyjs/packages/pypi-tabulate/py/tabulate.py\n");
    const pass = run("print('started')", "pypi-tabulate");
    assert.equal(pass.status, 0, pass.stderr);
    assert.equal(pass.stdout, "started\n");
    const other = run("import sortedcontainers; print(sortedcontainers.SortedList([2, 1]))", "pypi-tabulate");
    assert.equal(other.status, 0, other.stderr);
    assert.equal(other.stdout, "SortedList([1, 2])\n");
    const broken = run("import tabulate", "pypi-tabulate");
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /ImportError|Error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
