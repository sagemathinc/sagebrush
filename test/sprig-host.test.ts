import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, HOST_DETAIL, py, ROOT, sprig } from "./sprig-helpers";

// Sprig's host boundary (design/sprig-mvp.md §9): the hidden flag, the file, network and process refusals, names that
// stay Sprig symbols, and the gate inventory with its fail-closed census.

test("--sprig runs only -c in this version (hidden until S1.4), and is not in --help", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprig-flag-"));
  try {
    writeFileSync(join(dir, "x.sprig"), 'Print["ran"]\n');
    writeFileSync(join(dir, "x.wl"), 'Print["ran"]\n');
    for (const args of [["--sprig", "x.sprig"], ["--sprig", "x.wl"], ["--sprig"], ["--sprig", "-i", "-c", "1"], ["--sprig", "-m", "x"], ["--sprig", "--emit", "x.sprig"]]) {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", input: "1\n", timeout: 60000 });
      assert.equal(r.status, 2, args.join(" "));
      assert.equal(r.stderr, "sagebrush: --sprig runs only -c in this version of Sagebrush\n", args.join(" "));
      assert.equal(r.stdout, "", args.join(" "));
    }
    const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
    assert.doesNotMatch(help.stdout + help.stderr, /sprig/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (§9: every file, network and process function is refused before any of its arguments is evaluated, with Sprig's
// message, $Failed and the session unchanged; S1.1 reaches no file at all, so the file functions are refused too)
const REFUSED: [string, string][] = [
  ['Get["probe.sprig"]', 'Get::notyet: Get isn\'t available in Sprig yet.'],
  ['Import["probe.sprig"]', "Import::notyet: Import isn't available in Sprig yet."],
  ['Import["https://example.com/x"]', "Import::nonetwork: Import can't reach the network: it is off for documents."],
  ['ReadList["probe.sprig"]', "ReadList::notyet: ReadList isn't available in Sprig yet."],
  ['ReadList["!touch made-by-sprig"]', "ReadList::noprocess: ReadList can't start a program: Sprig doesn't run programs."],
  ['OpenRead["!touch made-by-sprig"]', "OpenRead::noprocess: OpenRead can't start a program: Sprig doesn't run programs."],
  ['FileExistsQ["probe.sprig"]', "FileExistsQ::notyet: FileExistsQ isn't available in Sprig yet."],
  ['Put[1, "made-by-sprig"]', "Put::notyet: Put isn't available in Sprig yet."],
  ['PutAppend[1, "made-by-sprig"]', "PutAppend::notyet: PutAppend isn't available in Sprig yet."],
  ['Export["made-by-sprig.txt", 1]', "Export::notyet: Export isn't available in Sprig yet."],
  ['DeleteFile["probe.sprig"]', "DeleteFile::notyet: DeleteFile isn't available in Sprig yet."],
  ['RenameFile["probe.sprig", "made-by-sprig"]', "RenameFile::notyet: RenameFile isn't available in Sprig yet."],
  ['CreateDirectory["made-by-sprig"]', "CreateDirectory::notyet: CreateDirectory isn't available in Sprig yet."],
  ['SetDirectory["/"]', "SetDirectory::notyet: SetDirectory isn't available in Sprig yet."],
  ['URLRead["https://example.com"]', "URLRead::nonetwork: URLRead can't reach the network: it is off for documents."],
  ['URLFetch["https://example.com"]', "URLFetch::nonetwork: URLFetch can't reach the network: it is off for documents."],
  ['URLDownload["https://example.com", "made-by-sprig"]', "URLDownload::nonetwork: URLDownload can't reach the network: it is off for documents."],
  ['Run["touch made-by-sprig"]', "Run::noprocess: Run can't start a program: Sprig doesn't run programs."],
  ['RunProcess[{"touch", "made-by-sprig"}]', "RunProcess::noprocess: RunProcess can't start a program: Sprig doesn't run programs."],
];

test("§9: every file, network and process function is refused before any effect, the session unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprig-gates-"));
  try {
    writeFileSync(join(dir, "probe.sprig"), 'Print["loaded"]\n');
    for (const [call, message] of REFUSED) {
      const r = sprig(call, dir);
      assert.equal(r.status, 0, call);
      assert.equal(r.stdout, "$Failed\n", `${call}: $Failed, and nothing else printed`);
      assert.equal(r.stderr, message + "\n", call);
      assert.deepEqual(readdirSync(dir), ["probe.sprig"], `${call}: no file made or removed`);
      // (an argument with an effect, inside Sprig: it is never evaluated, so the session is as it was)
      const held = call.replace("[", "[a = 2; Print[\"evaluated\"]; ");
      const h = sprig(`a = 1;\n${held}\na`, dir);
      // (OpenRead with no literal "!cmd" is no pipe: it stays an inert, held expression, design §9)
      if (call.startsWith("OpenRead")) {
        const lines = h.stdout.split("\n");
        assert.ok(lines[0].startsWith("OpenRead[a = 2 ; Print[") && lines[1] === "1" && !h.stdout.includes("evaluated\n"), `${held}: inert (${h.stdout})`);
      } else assert.equal(h.stdout, "$Failed\n1\n", `${held}: the argument never ran`);
      assert.doesNotMatch(h.stderr, HOST_DETAIL);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§9: names, strings and contexts stay Sprig symbols, never Python objects (negative controls)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprig-names-"));
  try {
    const cases: [string, string, string][] = [
      ["os", "os\n", ""],
      ["sys", "sys\n", ""],
      ["eval", "eval\n", ""],
      ["Global`os", "os\n", ""],
      ["os[\"system\"][\"touch made-by-sprig\"]", 'os["system"]["touch made-by-sprig"]\n', ""],
      ["Head[Global`os]", "Symbol\n", ""],
      ['Symbol["os"]', "os\n", ""],
      ['Symbol["os"]["system"]["touch made-by-sprig"]', 'os["system"]["touch made-by-sprig"]\n', ""],
      ['Symbol["__import__"]', 'Symbol["__import__"]\n', "Symbol::symname: The string __import__ cannot be used for a symbol name. A symbol name must start with a letter followed by letters and numbers.\n"],
      ['Symbol["__import__"]["os"]', 'Symbol["__import__"]["os"]\n', "Symbol::symname: The string __import__ cannot be used for a symbol name. A symbol name must start with a letter followed by letters and numbers.\n"],
      ['ToExpression["os"]', "os\n", ""],
      ['ToExpression["__builtins__"]', "__*__builtins\n", ""],
      ['ToExpression["Run[\\"touch made-by-sprig\\"]"]', "$Failed\n", "Run::noprocess: Run can't start a program: Sprig doesn't run programs.\n"],
      // (functions Sprig doesn't know are inert expressions: no exit, no environment, no file, no package)
      ["Exit[3]", "Exit[3]\n", ""],
      ["Quit[]", "Quit[]\n", ""],
      ['Environment["HOME"]', 'Environment["HOME"]\n', ""],
      ['WriteString["made-by-sprig", "x"]', 'WriteString["made-by-sprig", "x"]\n', ""],
      ['Needs["os`"]', 'Needs["os`"]\n', ""],
      ['OpenRead["made-by-sprig"]', 'OpenRead["made-by-sprig"]\n', ""],
    ];
    for (const [src, out, err] of cases) {
      const r = sprig(src + "\n1 + 1", dir);
      assert.equal(r.stdout, out + "2\n", `${src}: inert, and the session answers`);
      assert.equal(r.stderr, err, src);
      assert.deepEqual(readdirSync(dir), [], `${src}: no file made`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§9: the gate inventory lists every route in lib/_sprig, each with its decision (scripts/sprig-gates.mjs)", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "sprig-gates.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const inventory = JSON.parse(readFileSync(join(ROOT, "scripts", "sprig-gates.json"), "utf8")).routes;
  for (const k of Object.keys(inventory)) assert.ok(!/^call:/.test(k), `${k}: Sprig calls no host builtin by name`);
  for (const k of Object.keys(inventory)) assert.ok(!/^import:(os|io|subprocess|socket|shutil|pathlib|builtins|importlib|ctypes|js)$/.test(k), `${k}: Sprig imports no host module of files, processes or the network in S1.1`);
  // (each refused builtin has a behavioural pin above)
  const pinned = new Set(REFUSED.map(([call]) => call.slice(0, call.indexOf("["))));
  for (const [k, v] of Object.entries(inventory) as [string, { decision: string }][])
    if (v.decision === "refused" && !pinned.has(k.slice("builtin:".length))) {
      const r = sprig(`${k.slice("builtin:".length)}[a = 2]\na`, ROOT);
      assert.equal(r.stdout, "$Failed\na\n", `${k}: refused before its argument ran`);
      assert.match(r.stderr, /^\w+::(notyet|nonetwork|noprocess): /, k);
    }
});

// (the census fails closed, as Rill's: each mutant plants one spelling in a copy of lib/_sprig, and the census must list
// a new route or report a problem)
test("§9: the gate census catches every planted route spelling (mutants)", async () => {
  const { census } = await import(join(ROOT, "scripts", "sprig-gates.mjs"));
  const base = census(ROOT);
  assert.deepEqual(base.problems, []);
  const MUTANTS: [string, string, RegExp][] = [
    ["mem.py", "import sys as s\n", /import the census can't read|`as`/],
    ["mem.py", "from sys import stdout\n", /absolute `from … import`/],
    ["mem.py", "import sys\nout = sys\n", /host module sys used as a value/],
    ["mem.py", "import os\nos.system('x')\n", /^host:os\.system$|^import:os$/],
    ["base.py", "BUILTINS['Evil'] = _print\n", /BUILTINS used in a form/],
    ["base.py", "BUILTINS.update(Evil=_print)\n", /BUILTINS used in a form/],
    ["base.py", 'BUILTINS["Evil"] = _print\n', /^builtin:Evil$/],
    ["base.py", 'EXTRA = ("Evil",)\nfor _n in EXTRA:\n    BUILTINS[_n] = _print\n', /^builtin:Evil$/],
    ["base.py", "for _n in names():\n    BUILTINS[_n] = _print\n", /BUILTINS loop over names|BUILTINS used in a form/],
    ["base.py", 'BUILTINS = {"Evil": _print}\n', /BUILTINS assigned more than once|^builtin:Evil$/],
    ["eval.py", "x = (1).__class__\n", /introspection attribute __class__/],
    ["eval.py", "g = Session.__globals__\n", /introspection attribute __globals__/],
    ["eval.py", "f = open('x')\n", /^call:open$/],
    ["eval.py", "e = eval('1')\n", /^call:eval$/],
    ["eval.py", "a = getattr(Session, 'x')\n", /^call:getattr$/],
    ["parse.py", "m = __import__('os')\n", /^call:__import__$/],
  ];
  for (const [file, code, want] of MUTANTS) {
    const dir = mkdtempSync(join(tmpdir(), "sprig-census-"));
    try {
      cpSync(join(ROOT, "lib", "_sprig"), join(dir, "lib", "_sprig"), { recursive: true });
      appendFileSync(join(dir, "lib", "_sprig", file), "\n" + code);
      const got = census(dir);
      const newRoutes = [...got.routes.keys()].filter((k: string) => !base.routes.has(k));
      const caught = got.problems.some((p: string) => want.test(p)) || newRoutes.some((k: string) => want.test(k));
      assert.ok(caught, `${file} + ${JSON.stringify(code)}: not caught (problems ${JSON.stringify(got.problems)}, new routes ${JSON.stringify(newRoutes)})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// (ENGINE's condition on ruling 1: Sprig's start does no Sage work, so the offline item's declared Sage dependency
// costs a Sprig session nothing until S2)
