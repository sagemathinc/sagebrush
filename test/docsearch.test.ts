import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const cli = join(__dirname, "..", "src", "cli.js");
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("every intrinsic Magma mode binds has a summary and an example in the Magma index (lib/_magma_docsearch.py)", () => {
  const r = run("-m", "_magma_docsearch", "--check");
  assert.equal(r.stdout.trim(), '{"missing": [], "extra": [], "no_example": []}', r.stdout + r.stderr);
  assert.equal(r.status, 0);
});

test("sagebrush --search --mode searches that language's index; the default is unchanged", () => {
  const magma = run("--search", "class", "group", "--mode", "magma");
  assert.match(magma.stdout, /^ClassGroup\(K : Bound, Proof\)    \[magma\]\n    The class group of a number field/);
  const matlab = run("--search", "linsolve", "--mode", "matlab");
  assert.match(matlab.stdout, /^linsolve\(\)    \[matlab\]/);
  const sage = run("--search", "selmer", "rank");
  assert.match(sage.stdout, /^EllipticCurve_rational_field\.selmer_rank\(\)\n/);
  // (a catalog entry, for agents: call form and status, summary, first example, differs: catalog/SCHEMA.md)
  const py = run("--search", "linear", "system", "--mode", "python").stdout;
  assert.match(py, /^numpy\.linalg\.solve\(a, b\)    \[python\]    \[partial\]\n    The solution x of the linear system a x = b\.\n    >>> import numpy as np\n    >>> np\.linalg\.solve\(\[\[3, 1\], \[1, 2\]\], \[9, 8\]\)\n    array\(\[2\., 3\.\]\)\n    differs: Accepts every argument of NumPy 2\.5\.1/);
  const pyj = JSON.parse(run("--search", "linear", "system", "--mode", "python", "--json").stdout);
  assert.equal(pyj[0].name, "numpy.linalg.solve");
  // (each example with the prelude lines it needs, CORR-012-1)
  assert.equal(pyj[0].examples[0].setup, "import numpy as np");
  const setups = run("-c", "import _catalog as c\nP = 'import numpy as np\\nimport math, cmath, itertools\\nfrom fractions import Fraction'\nfor code in ['math.pi', 'Fraction(1, 3) + cmath.sqrt(-1)', 'len([1])', 'npx = 1']: print(repr(c.setup(P, code)))").stdout;
  assert.equal(setups, "'import math'\n'import cmath\\nfrom fractions import Fraction'\n''\n''\n");
  // (a whole call form, MATLAB's, is shown as written; "(...)" follows the name, CORR-012-2)
  const forms = run("-c", "import _pyjs_docsearch as d\nprint(d.describe({'name': 'max', 'kind': 'function', 'signature': 'M = max(A)\\n[M, I] = max(___)', 'summary': 'S.', 'doc': ''}, 'matlab'))").stdout;
  assert.match(forms, /^M = max\(A\)    \[matlab\]\n    also: \[M, I\] = max\(___\)\n    S\.\n$/);
  for (const k of ["signature", "summary", "examples", "differs", "status", "upstream_version"]) assert.ok(k in pyj[0], k);
  // (a block's code at the prompt, its continuation lines after ...)
  assert.match(run("--search", "lru_cache", "--mode", "python").stdout, /\n    >>> @functools\.lru_cache\(maxsize=None\)\n    \.\.\. def fib\(n\):\n/);
  const json = JSON.parse(run("--search", "unit", "group", "--mode", "magma", "--json").stdout);
  assert.equal(json[0].name, "UnitGroup");
  assert.equal(json[0].language, "magma");
  // (an alias is a name of its entry: found and ranked by it, catalog/SCHEMA.md)
  const alias = run("-c", "import _pyjs_docsearch as d\ne = {'name': 'diff', 'aliases': ['derivative'], 'summary': 'S.', 'doc': '', 'open_problem': False}\nprint(d.score(e, ['derivative'], 'derivative'), d.score(dict(e, aliases=[]), ['derivative'], 'derivative'))").stdout.trim();
  assert.equal(alias, "30 0");
  // (what a search hands an agent is bounded: HARD-012-1)
  const huge = [
    "import json, _pyjs_docsearch as d",
    "e = {'name': 'f', 'kind': 'function', 'signature': '(x)' + ''.join('\\nf(%d)' % i for i in range(50)), 'summary': 'S.', 'doc': 'D' * 10**6,",
    "     'examples': [{'code': 'x = 1\\n' * 5000, 'expected': 'y' * 10**6 + '\\n'}], 'differs': ['z' * 5000] * 100, 'alternative': 'w' * 10**5}",
    "t = d.describe(e, 'python')",
    "kept, omitted = d.bounded_entries([e] * 3)",
    "small, n = d.bounded_entries([dict(e, doc='D' * 6000, examples=[], differs=[], alternative='a')] * 50)",
    "print(json.dumps([len(t) <= d.HIT_CHARS + 40, 'more call forms' in t, 'more lines' in t, 'more characters' in t, 'more differs lines' in t,",
    "  len(kept), omitted, len(small) < 50 and n == 50 - len(small), len(json.dumps(small, indent=1)) <= d.JSON_BYTES,",
    "  len(d.search('e', 10**9)), d.clamp_limit(-5), d.clamp_limit('x'),",
    "  len(d.within(['x' * 1000] * 100)) <= 61 and d.within(['x' * 1000] * 100)[-1].startswith('...['),",
    "  len('\\n'.join(d.within(['x' * (d.TOTAL_CHARS + 1)]))) <= d.TOTAL_CHARS, len('\\n'.join(d.within(['x' * (d.TOTAL_CHARS + 1), 'y']))) <= d.TOTAL_CHARS,",
    "  d.within(['x' * (d.TOTAL_CHARS + 1), 'y'])[-1] == '...[1 more hits not shown: narrow the query]', d.within(['a', 'b']) == ['a', 'b']]))",
  ].join("\n");
  assert.deepEqual(JSON.parse(run("-c", huge).stdout), [true, true, true, true, true, 0, 3, true, true, 50, 1, 20, true, true, true, true, true]);
  const lots = run("--search", "e", "--mode", "python", "--limit", "100000").stdout;
  assert.ok(lots.split("\n").filter((l) => l && !l.startsWith(" ")).length <= 50 && lots.length <= 61000, "hits: " + lots.length);
  assert.ok(JSON.parse(run("--search", "e", "--mode", "python", "--json").stdout).length <= 10);
  const bad = run("--search", "x", "--mode", "fortran");
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /--mode must be one of sage, python, magma, matlab/);
});

test("the capability map has every language, and each area's sample search finds some of that area's functions", () => {
  const dir = mkdtempSync(join(tmpdir(), "capmap-"));
  const f = join(dir, "check.py");
  writeFileSync(f, [
    "import _capability_map as C, _pyjs_docsearch as D",
    "md = C.build()",
    "for h in ('## Sage and Python', '## Magma', '## MATLAB'):",
    "    assert h in md, h",
    "bad = []",
    "for mode, rows in (('sage', C.sage_rows()), ('magma', C.magma_rows()), ('matlab', C.matlab_rows())):",
    "    for area, entries, query in rows:",
    "        assert entries, area",
    "        names = set(e['name'] for e in entries)",
    "        hits = [e['name'] for _, e in D.search(query, 20, None if mode == 'sage' else mode)]",
    "        if not names.intersection(hits):",
    "            bad.append((mode, area, query))",
    "print('bad', bad)",
    "",
  ].join("\n"));
  const r = spawnSync(process.execPath, [cli, f], { encoding: "utf8", cwd: dir });
  assert.equal(r.stdout.trim(), "bad []", r.stdout + r.stderr);
});

// On an equal score, a catalog entry (reviewed, with its examples) ranks before an auto-extracted one (catalog false:
// a docstring's summary, a curated PyPI package's), then the shorter name; no score changes (@sagebrush's ruling, Nov 9,
// when mpmath's functions joined the Python index). Both mirrors: lib/_pyjs_docsearch.py and web/docsearch.ts.
test("docsearch: on an equal score, a catalog entry before an auto-extracted one, then the shorter name (both mirrors)", async () => {
  const entries = [
    { name: "pkg.res", summary: "the residual of a linear system", doc: "", open_problem: false, catalog: false },
    { name: "numpy.linalg.solve", summary: "the solution of a linear system", doc: "", open_problem: false },
    { name: "zz.auto", summary: "a linear system", doc: "", open_problem: false, catalog: false },
    { name: "aa.cat", summary: "a linear system again", doc: "", open_problem: false },
  ];
  const want = ["aa.cat", "numpy.linalg.solve", "pkg.res", "zz.auto"];
  // (the Python mirror, as sagebrush --search and the MCP server use it)
  const py = run("-c", `import _pyjs_docsearch as d, json\nE = json.loads(${JSON.stringify(JSON.stringify(entries))})\nfor e in E: e["catalog"] = e.get("catalog", None) if "catalog" in e else None\nE = [{k: v for k, v in e.items() if not (k == "catalog" and v is None)} for e in E]\nd.index_for = lambda mode=None: E\nprint(json.dumps([e["name"] for s, e in d.search("linear system", mode="python")]))`);
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), want);
  // (the web mirror, web/docsearch.ts, which imports nothing: its types stripped by Node, and imported as it is)
  const { stripTypeScriptTypes } = (await import("node:module")) as any;
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(__dirname, "..", "..", "web", "docsearch.ts"), "utf8");
  const js: string = stripTypeScriptTypes(src);
  // (a real ESM import: tsc's CommonJS output would make import() a require())
  const esm = new Function("u", "return import(u)") as (u: string) => Promise<any>;
  const web = await esm("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  const idx = web.prepareIndex(entries, "python");
  assert.deepEqual(web.searchIndex(idx, "linear system").map((e: any) => e.name), want);
  assert.deepEqual(web.searchIndexes([["python", idx]], "linear system").map((e: any) => e.name), want);
});

// A function that is partial or not there yet, and a search with no match, come with a request: the prefilled
// coverage-request issue (.github/ISSUE_TEMPLATE/coverage-request.yml). Agents get it from `sagebrush --search` (its
// text and --json's request_url) and the MCP server; the page from web/docsearch.ts. Both mirrors give the same URL.
test("docsearch: a request for what's partial, missing or not found, the same URL from both mirrors", async () => {
  const base = "https://github.com/sagemathinc/sagebrush/issues/new?template=coverage-request.yml&labels=coverage-request";
  const miss = run("--search", "zzqq", "nothing", "--mode", "matlab");
  assert.equal(miss.status, 0, miss.stderr);
  assert.equal(miss.stdout, `No MATLAB function's documentation has all of: zzqq nothing\n    request it: ${base}&title=%5BRequest%5D%20MATLAB%3A%20zzqq%20nothing&mode=MATLAB&name=zzqq%20nothing\n`);
  // (--json: [] for a miss, its request on stderr; a partial entry carries its request_url, a full one none)
  const jmiss = run("--search", "zzqq", "--mode", "python", "--json");
  assert.deepEqual(JSON.parse(jmiss.stdout), []);
  assert.match(jmiss.stderr, /request it: .*title=%5BRequest%5D%20Python%3A%20zzqq&mode=Python&name=zzqq\n/);
  const pyj = JSON.parse(run("--search", "linear", "system", "--mode", "python", "--json").stdout);
  assert.equal(pyj[0].status, "partial");
  assert.equal(pyj[0].request_url, `${base}&title=%5BRequest%5D%20Python%3A%20numpy.linalg.solve&mode=Python&name=numpy.linalg.solve`);
  assert.ok(pyj.every((e: any) => (e.request_url !== undefined) === (e.catalog !== false && ["partial", "stub-error", "absent"].includes(e.status))));
  // (the text a person or an agent reads ends with it)
  assert.match(run("--search", "linear", "system", "--mode", "python").stdout, /^numpy\.linalg\.solve[\s\S]*?\n    request it: https:\/\/github\.com\/[^\n]*name=numpy\.linalg\.solve\n/);
  // (which results carry it: a catalog entry that is partial, a stub or absent; not a full one, nor an auto-extracted one)
  const which = run("-c", "import _pyjs_docsearch as d\nb = {'kind': 'function', 'signature': '(x)', 'summary': 'S.', 'doc': ''}\nE = [dict(b, name=n, status=s, **({'catalog': False} if n == 'auto' else {})) for n, s in (('partial', 'partial'), ('absent', 'absent'), ('stub', 'stub-error'), ('full', 'full'), ('auto', 'partial'))]\nprint([e['name'] for e in E if 'request it: ' + d.request_url('python', e['name']) in d.describe(e, 'python')])");
  assert.equal(which.stdout.trim(), "['partial', 'absent', 'stub']", which.stderr);
  // (the two mirrors encode alike, whatever the name: spaces, &, #, quotes, non-ASCII)
  // (and at most 200 characters, code points, of a long name; a lone surrogate as U+FFFD, so it always encodes)
  const names = ["fir1", "a b&c#d", "ζ(s) 'x' \"y\" ü/é?=+", "~!*()-_.", "x".repeat(300), "ζ".repeat(250), "😀".repeat(210), "\ud800a\udc00b😀"];
  const py = run("-c", `import _pyjs_docsearch as d, json\nprint(json.dumps([d.request_url(m, n) for m in ("sage", "python", "magma", "matlab", None) for n in ${JSON.stringify(names)}]))`);
  assert.equal(py.status, 0, py.stderr);
  const { stripTypeScriptTypes } = (await import("node:module")) as any;
  const { readFileSync } = await import("node:fs");
  const esm = new Function("u", "return import(u)") as (u: string) => Promise<any>;
  const web = await esm("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(readFileSync(join(__dirname, "..", "..", "web", "docsearch.ts"), "utf8"))).toString("base64"));
  const js = ["sage", "python", "magma", "matlab", "sage"].flatMap((m) => names.map((n) => web.requestUrl(m, n)));
  assert.deepEqual(JSON.parse(py.stdout), js);
  const clipped = (n: string) => new URL(web.requestUrl("magma", n)).searchParams.get("name");
  assert.deepEqual([clipped("x".repeat(300)), clipped("😀".repeat(210)), clipped("\ud800a\udc00b😀")], ["x".repeat(200), "😀".repeat(200), "\ufffda\ufffdb😀"]);
  // (a huge query: the CLI's text and its request stay small)
  const huge = run("--search", "ζ".repeat(30000), "--mode", "matlab");
  assert.ok(huge.status === 0 && huge.stdout.length < 4000 && huge.stdout.trimEnd().endsWith("&name=" + "%CE%B6".repeat(200)), huge.stdout.length + huge.stderr);
  // (and each decodes to the form, its mode and its name)
  const u = new URL(web.requestUrl("matlab", names[2]));
  assert.deepEqual([u.searchParams.get("template"), u.searchParams.get("labels"), u.searchParams.get("mode"), u.searchParams.get("name"), u.searchParams.get("title")], ["coverage-request.yml", "coverage-request", "MATLAB", names[2], "[Request] MATLAB: " + names[2]]);
  // (the result's status, as the page shows it: an auto-extracted entry has none)
  assert.deepEqual(["full", "partial", "stub-error", "absent"].map((status) => web.docStatus({ status })), ["works", "partly", "not-yet", "not-yet"]);
  assert.equal(web.docStatus({ status: "partial", catalog: false }), null);
});

// The real system's names the index lacks (web/upstream-names.mts): found by name only, after every documented
// result; one Sagebrush lacks is Not yet, one it has undocumented has no status.
test("docsearch: the real system's names, after the documented results", async () => {
  const { stripTypeScriptTypes } = (await import("node:module")) as any;
  const { readFileSync } = await import("node:fs");
  const esm = new Function("u", "return import(u)") as (u: string) => Promise<any>;
  const web = await esm("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(readFileSync(join(__dirname, "..", "..", "web", "docsearch.ts"), "utf8"))).toString("base64"));
  const idx = web.prepareIndex([{ name: "firls_like", summary: "a filter like fir1", doc: "", status: "full" }, { name: "filter", summary: "Filters data.", doc: "" }], "matlab");
  const up = web.prepareUpstream({ groups: ["Signal Processing Toolbox"], absent: ["fir1\t0", "fir2\t0", "AND"], present: ["filtfilt_has"] }, "matlab");
  const names = (q: string, limit?: number) => web.searchWithUpstream(idx, up, q, limit).map((e: any) => e.name);
  // (the documented match first, though the Not yet name matches better)
  assert.deepEqual(names("fir1"), ["firls_like", "fir1"]);
  assert.deepEqual(names("fir"), ["firls_like", "fir1", "fir2"]);
  assert.deepEqual(names("fir", 1), ["firls_like"]);
  // (then the names Sagebrush has undocumented, before the ones it hasn't)
  assert.deepEqual(names("filt"), ["filter", "firls_like", "filtfilt_has"]);
  assert.deepEqual(web.searchWithUpstream([], web.prepareUpstream({ absent: ["filtfilt"], present: ["filtfilt_has"] }, "matlab"), "filtfilt").map((e: any) => e.name), ["filtfilt_has", "filtfilt"]);
  // (by name only: their summary's words, and their toolbox's, find none of them)
  assert.deepEqual(names("sagebrush"), []);
  assert.deepEqual(names("signal processing"), []);
  const [fir1] = web.searchWithUpstream(idx, up, "fir1").slice(1);
  assert.deepEqual([web.docStatus(fir1), fir1.summary, web.docHead(fir1), fir1.upstream], ["not-yet", "Not in Sagebrush yet: MATLAB's Signal Processing Toolbox has it.", "fir1", "absent"]);
  const [and] = web.searchWithUpstream(idx, up, "AND");
  assert.deepEqual([web.docStatus(and), and.summary], ["not-yet", "Not in Sagebrush yet: MATLAB has it."]);
  const [has] = web.searchWithUpstream(idx, up, "filtfilt_has");
  assert.deepEqual([web.docStatus(has), has.summary, has.upstream], [null, "In Sagebrush; not documented here yet.", "present"]);
  // (over the limit: exactly `limit` results, the documented ones first, then the upstream ones that fit)
  const many = web.prepareIndex(["fir_a", "fir_b", "fir_c"].map((name) => ({ name, summary: "", doc: "" })), "matlab");
  const manyUp = web.prepareUpstream({ absent: ["fir1", "fir2", "fir3"], present: ["fir_has"] }, "matlab");
  assert.deepEqual(web.searchWithUpstream(many, manyUp, "fir", 5).map((e: any) => e.name), ["fir_a", "fir_b", "fir_c", "fir_has", "fir1"]);
  assert.deepEqual(web.searchWithUpstream(many, manyUp, "fir", 2).map((e: any) => e.name), ["fir_a", "fir_b"]);
  // (a mixed-case name is found by its lowercase query, and by its own case)
  const mixed = web.prepareUpstream({ absent: ["AbelianGroup", "scipy.signal.FIR"] }, "sage");
  assert.deepEqual(web.searchWithUpstream([], mixed, "abeliangroup").map((e: any) => e.name), ["AbelianGroup"]);
  assert.deepEqual(web.searchWithUpstream([], mixed, "AbelianGroup").map((e: any) => e.name), ["AbelianGroup"]);
  assert.deepEqual(web.searchWithUpstream([], mixed, "fir").map((e: any) => e.name), ["scipy.signal.FIR"]);
  // (without the file, as in the app, the search is the index's alone)
  assert.deepEqual(web.searchWithUpstream(idx, null, "fir").map((e: any) => e.name), ["firls_like"]);
  assert.deepEqual(web.prepareUpstream(null, "matlab"), { present: [], absent: [] });
  // (the page's languages each have a file, and nothing else)
  assert.deepEqual(Object.keys(web.DOC_UPSTREAM).sort(), Object.keys(web.DOC_INDEX).sort());
});
