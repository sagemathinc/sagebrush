// ci: web-browser/board-unit.2 order=130 runner=bun
// The library's chunks with packages (web/lib-chunks.mts): a package's
// module that a mode's start imported (recorded at its package path,
// "pkg:<dir>/<path>", src/compile.ts) gets its compiled code in the
// package's group, which is then in that mode's start; nothing recorded
// for a file no package or library has is used.
//   bun web/test-lib-chunks.mjs
import { libChunks, groupOf, familyViolation, MODE_FAMILIES } from "./lib-chunks.mts";

let fails = 0, checks = 0;
const ok = (c, what) => { checks++; if (!c) { fails++; console.log("FAIL " + what); } else console.log("ok   " + what); };
const mod = (path) => ({ path, code: "(function ($g, R) {})", lineMap: [] });
const lib = { "core.py": "C = 1\n", "_matlab.py": "M = 1\n", "scipy/__init__.py": "\n", "other.py": "O = 1\n" };
const packages = {
  registry: { format: 1, modules: { "scipy.io": "@sagebrush/scipy-io@0.1.0", spare: "@sagebrush/spare@0.1.0" }, packages: {} },
  files: { "scipy-io/py/scipy/io/__init__.py": "from .matlab import loadmat\n", "scipy-io/py/scipy/io/matlab.py": "def loadmat(): pass\n", "spare/py/spare.py": "S = 1\n" },
};
const rec = (modules) => ({ build: "b", modules });
const recordings = {
  py: rec({ "py|core": mod("core.py") }),
  matlab: rec({
    "py|core": mod("core.py"),
    "py|_matlab": mod("_matlab.py"),
    "py|scipy": mod("scipy/__init__.py"),
    "py|scipy.io": mod("pkg:scipy-io/py/scipy/io/__init__.py"),
    "py|scipy.io.matlab": mod("pkg:scipy-io/py/scipy/io/matlab.py"),
    // (a path no package has, and a package path given as a library one)
    "py|ghost": mod("pkg:ghost/py/ghost.py"),
    "py|io2": mod("scipy-io/py/scipy/io/__init__.py"),
  }),
};
const { manifest, chunks } = libChunks(lib, recordings, "b", packages);
const body = (ref) => JSON.parse(chunks.get(ref.file).toString());

const g = manifest.chunks["pkg-scipy-io"];
ok(g?.src && g?.pre, "a package a mode's start imported has a src and a pre chunk: " + JSON.stringify(Object.keys(g ?? {})));
ok(JSON.stringify(Object.keys(body(g.pre).modules)) === JSON.stringify(["py|scipy.io", "py|scipy.io.matlab"]), "its pre chunk holds exactly its modules' code: " + JSON.stringify(Object.keys(body(g.pre).modules)));
ok(body(g.pre).group === "pkg-scipy-io" && body(g.pre).kind === "pre" && body(g.pre).build === "b", "...labelled with its group, kind and build");
ok(manifest.chunks["pkg-spare"]?.src && !manifest.chunks["pkg-spare"].pre, "a package no start imported: sources only");
ok(manifest.modes.matlab.at(-1) === "pkg-scipy-io" && manifest.modes.matlab.includes("core"), "MATLAB's start fetches the package's group, after the library's: " + JSON.stringify(manifest.modes.matlab));
ok(!manifest.modes.matlab.includes("pkg-spare") && !manifest.modes.matlab.some((x) => /ghost/.test(x)), "...and no package it didn't import, nor one that doesn't exist");
const allPre = Object.values(manifest.chunks).filter((c) => c.pre).flatMap((c) => Object.keys(body(c.pre).modules));
ok(!allPre.includes("py|ghost") && !allPre.includes("py|io2"), "recorded code for a file no package or library has is in no chunk: " + JSON.stringify(allPre));
ok(manifest.packages.files["scipy-io/py/scipy/io/matlab.py"] === "pkg-scipy-io", "the manifest maps each package file to its group");
// (without packages: the library's chunks and modes as before)
const plain = libChunks(lib, { py: recordings.py, matlab: rec({ "py|core": mod("core.py"), "py|_matlab": mod("_matlab.py") }) }, "b");
ok(JSON.stringify(plain.manifest.modes.matlab) === JSON.stringify(["core", "matlab"]) && JSON.stringify(manifest.modes.matlab) === JSON.stringify(["core", "matlab", "mod-scipy", "pkg-scipy-io"]), "without packages, the library's start as before; with them, the same plus scipy's own group (not MATLAB's) and the package's: " + JSON.stringify([plain.manifest.modes.matlab, manifest.modes.matlab]));
// (the order is by kind, never the recording's: a start that imported the package before the mode's own other file
// still lists that file's group first, then the package's)
const pkgFirst = libChunks(lib, { py: recordings.py, matlab: rec({
  "py|core": mod("core.py"),
  "py|scipy.io": mod("pkg:scipy-io/py/scipy/io/__init__.py"),
  "py|scipy.io.matlab": mod("pkg:scipy-io/py/scipy/io/matlab.py"),
  "py|_matlab": mod("_matlab.py"),
  "py|scipy": mod("scipy/__init__.py"),
}) }, "b", packages);
ok(JSON.stringify(pkgFirst.manifest.modes.matlab) === JSON.stringify(["core", "matlab", "mod-scipy", "pkg-scipy-io"]), "a start recorded package-first: its files' own groups still before the package's: " + JSON.stringify(pkgFirst.manifest.modes.matlab));
// (a private module and its public twin share a group; other names that
// would share one are an error)
const twins = libChunks({ "string/__init__.py": "import _string\n", "_string.py": "X = 1\n", "core.py": "" }, { py: rec({}) }, "b");
ok(twins.manifest.files["_string.py"] === "mod-string" && twins.manifest.files["string/__init__.py"] === "mod-string", "_string and string: one group, mod-string");
let clash = "";
try { libChunks({ "a_b.py": "", "a-b.py": "" }, { py: rec({}) }, "b"); } catch (e) { clash = String(e.message); }
ok(/would both be mod-a-b/.test(clash), "two other names that would share a group are refused: " + clash);
// (MATLAB's sparse LU, _matlab_lu and _matlab_colamd, is its own group,
// matlab-lu; the other MATLAB extras, and names that only start alike, stay
// in matlab-more; a file a mode's start compiled stays in that mode's group)
const lu = libChunks({ "core.py": "", "_matlab.py": "", "_matlab_lu.py": "L = 1\n", "_matlab_colamd.py": "C = 1\n", "_matlab_plot.py": "", "_matlab_lu_extra.py": "", "_matlab_colamd_extra.py": "", "_matlab_tex.py": "" },
  { py: rec({ "py|core": mod("core.py") }), matlab: rec({ "py|core": mod("core.py"), "py|_matlab": mod("_matlab.py") }) }, "b");
const fl = lu.manifest.files;
ok(fl["_matlab_lu.py"] === "matlab-lu" && fl["_matlab_colamd.py"] === "matlab-lu", "_matlab_lu and _matlab_colamd: matlab-lu");
ok(["_matlab_plot.py", "_matlab_lu_extra.py", "_matlab_colamd_extra.py", "_matlab_tex.py"].every((f) => fl[f] === "matlab-more") && fl["_matlab.py"] === "matlab", "the other MATLAB extras stay in matlab-more, _matlab in matlab: " + JSON.stringify(fl));
ok(lu.manifest.chunks["matlab-lu"]?.src && !lu.manifest.chunks["matlab-lu"].pre && !lu.manifest.modes.matlab.includes("matlab-lu"), "matlab-lu: sources only, and no mode's start fetches it");
ok(JSON.stringify(Object.keys(JSON.parse(lu.chunks.get(lu.manifest.chunks["matlab-lu"].src.file).toString()).files).sort()) === JSON.stringify(["_matlab_colamd.py", "_matlab_lu.py"]), "its chunk holds exactly those two files");
const luRec = libChunks({ "core.py": "", "_matlab.py": "", "_matlab_lu.py": "" }, { py: rec({}), matlab: rec({ "py|_matlab": mod("_matlab.py"), "py|_matlab_lu": mod("_matlab_lu.py") }) }, "b");
ok(luRec.manifest.files["_matlab_lu.py"] === "matlab", "a start that compiled _matlab_lu keeps it in its own group (the recordings first)");
// (live data, fredapi, yfinance and their bridge _sbdata_live, is one group, mod-live-data: three top-level
// names, let through the clash check on purpose; a name that only starts alike stays in its own mod- group)
const ld = libChunks({ "core.py": "", "fredapi.py": "F = 1\n", "yfinance.py": "Y = 1\n", "_sbdata_live.py": "S = 1\n", "fredapi_extra.py": "" }, { py: rec({ "py|core": mod("core.py") }) }, "b");
const fd = ld.manifest.files;
ok(["fredapi.py", "yfinance.py", "_sbdata_live.py"].every((f) => fd[f] === "mod-live-data") && fd["fredapi_extra.py"] === "mod-fredapi-extra", "fredapi, yfinance and _sbdata_live: mod-live-data; fredapi_extra its own: " + JSON.stringify(fd));
ok(ld.manifest.chunks["mod-live-data"]?.src && !ld.manifest.chunks["mod-live-data"].pre && Object.values(ld.manifest.modes).every((g) => !g.includes("mod-live-data")), "mod-live-data: sources only, and no mode's start fetches it");
ok(JSON.stringify(Object.keys(JSON.parse(ld.chunks.get(ld.manifest.chunks["mod-live-data"].src.file).toString()).files).sort()) === JSON.stringify(["_sbdata_live.py", "fredapi.py", "yfinance.py"]), "its chunk holds exactly those three files");
// (elliptic curves over GF(p), _sage_ec_ff, is its own group, mod-sage-ec-ff;
// the other Sage extras, _sage_ec among them, stay in sage-more)
const ec = libChunks({ "core.py": "", "sage_all.py": "", "_sage_ec_ff.py": "E = 1\n", "_sage_ec.py": "", "_sage_ec_cubic.py": "", "_sage_lazy.py": "" },
  { py: rec({ "py|core": mod("core.py") }), sage: rec({ "py|core": mod("core.py"), "py|sage_all": mod("sage_all.py") }) }, "b");
const fe = ec.manifest.files;
ok(fe["_sage_ec_ff.py"] === "mod-sage-ec-ff", "_sage_ec_ff: mod-sage-ec-ff");
ok(["_sage_ec.py", "_sage_ec_cubic.py", "_sage_lazy.py"].every((f) => fe[f] === "sage-more") && fe["sage_all.py"] === "sage", "the other Sage extras stay in sage-more, sage_all in sage: " + JSON.stringify(fe));
ok(ec.manifest.chunks["mod-sage-ec-ff"]?.src && !ec.manifest.chunks["mod-sage-ec-ff"].pre && !ec.manifest.modes.sage.includes("mod-sage-ec-ff"), "mod-sage-ec-ff: sources only, and Sage mode's start doesn't fetch it");
// (Rill's routing, design/rill.md §6.1 and §6.5: Rill's start is checked last, so a file another start uses stays in
// core, sci or sage; the start's own files are rill; Rill's other files go by family, never mod-rill; no other mode's
// start fetches a Rill group; and the offline inventory's Rill item owns every rill-* group)
const rl = libChunks({ "core.py": "", "shared.py": "", "sage_all.py": "", "_sage_shared.py": "", "_rill/__init__.py": "", "_rill/eval.py": "",
  "_rill/stats/lm.py": "", "_rill/base/strings.py": "", "_rill/ggplot2/geom.py": "", "_rill/dplyr/verbs.py": "", "_rill/tibble.py": "",
  "_rill/data/mtcars.py": "", "_rill/graphics.py": "" }, {
  py: rec({ "py|core": mod("core.py"), "py|shared": mod("shared.py") }),
  sage: rec({ "py|core": mod("core.py"), "py|sage_all": mod("sage_all.py"), "py|_sage_shared": mod("_sage_shared.py") }),
  rill: rec({ "py|core": mod("core.py"), "py|shared": mod("shared.py"), "py|_sage_shared": mod("_sage_shared.py"), "py|_rill": mod("_rill/__init__.py"), "py|_rill.eval": mod("_rill/eval.py") }),
}, "b");
const fr = rl.manifest.files;
ok(fr["_rill/__init__.py"] === "rill" && fr["_rill/eval.py"] === "rill", "Rill's start's own files: rill");
ok(fr["shared.py"] === "core" && fr["_sage_shared.py"] === "sage", "a file another start uses stays in core or sage, never rill: " + JSON.stringify([fr["shared.py"], fr["_sage_shared.py"]]));
ok(fr["_rill/ggplot2/geom.py"] === "rill-ggplot2", "_rill/ggplot2/**: rill-ggplot2");
ok(fr["_rill/dplyr/verbs.py"] === "rill-dplyr" && fr["_rill/tibble.py"] === "rill-dplyr", "_rill/dplyr/** and _rill/tibble.py: rill-dplyr");
ok(fr["_rill/data/mtcars.py"] === "rill-data", "_rill/data/**: rill-data");
ok(["_rill/stats/lm.py", "_rill/base/strings.py", "_rill/graphics.py"].every((f) => fr[f] === "rill-more"), "any other _rill/** file: rill-more");
ok(!Object.values(fr).includes("mod-rill"), "no file is mod-rill");
ok(JSON.stringify(rl.manifest.modes.rill) === JSON.stringify(["core", "sage", "rill"]), "Rill's start fetches its start group and the groups it shares, in START_ORDER: " + JSON.stringify(rl.manifest.modes.rill));
ok(Object.entries(rl.manifest.modes).every(([m, gs]) => m === "rill" || !gs.some((g) => g.startsWith("rill"))), "no other mode's start includes a Rill group: " + JSON.stringify(rl.manifest.modes));
ok(rl.manifest.chunks.rill?.pre && ["rill-more", "rill-ggplot2", "rill-dplyr", "rill-data"].every((g) => rl.manifest.chunks[g]?.src && !rl.manifest.chunks[g].pre), "rill has its compiled code; the families no start uses, sources only");
const { itemOfGroup } = await import("./offline-inventory.mts");
ok(["rill", "rill-more", "rill-ggplot2", "rill-dplyr", "rill-data"].every((g) => itemOfGroup(g) === "rill"), "the offline inventory's Rill item owns every Rill group");
// (Sprig's routing, design/sprig-mvp.md §6.1 and §6.4: Sprig's start is checked last, so a file another start uses
// (Rill's included) stays in theirs; the start's own files are sprig; _sprig/plot.py is sprig-plot and any other
// _sprig/** file sprig-more, never mod-sprig; no other mode's start fetches a Sprig group; and the offline inventory's
// Sprig item owns every sprig-* group)
const sp = libChunks({ "core.py": "", "shared.py": "", "sage_all.py": "", "_sage_shared.py": "", "_rill/__init__.py": "", "_rill/both.py": "",
  "_sprig/__init__.py": "", "_sprig/eval.py": "", "_sprig/plot.py": "", "_sprig/math.py": "", "_sprig/sub/lists.py": "" }, {
  py: rec({ "py|core": mod("core.py"), "py|shared": mod("shared.py") }),
  sage: rec({ "py|core": mod("core.py"), "py|sage_all": mod("sage_all.py"), "py|_sage_shared": mod("_sage_shared.py") }),
  rill: rec({ "py|core": mod("core.py"), "py|_rill": mod("_rill/__init__.py"), "py|_rill.both": mod("_rill/both.py") }),
  sprig: rec({ "py|core": mod("core.py"), "py|shared": mod("shared.py"), "py|_sage_shared": mod("_sage_shared.py"), "py|_rill.both": mod("_rill/both.py"),
    "py|_sprig": mod("_sprig/__init__.py"), "py|_sprig.eval": mod("_sprig/eval.py") }),
}, "b");
const fs2 = sp.manifest.files;
ok(fs2["_sprig/__init__.py"] === "sprig" && fs2["_sprig/eval.py"] === "sprig", "Sprig's start's own files: sprig");
ok(fs2["shared.py"] === "core" && fs2["_sage_shared.py"] === "sage" && fs2["_rill/both.py"] === "rill", "a file another start uses stays in core, sage or rill, never sprig: " + JSON.stringify([fs2["shared.py"], fs2["_sage_shared.py"], fs2["_rill/both.py"]]));
ok(fs2["_sprig/plot.py"] === "sprig-plot", "_sprig/plot.py: sprig-plot");
ok(fs2["_sprig/math.py"] === "sprig-more" && fs2["_sprig/sub/lists.py"] === "sprig-more", "any other _sprig/** file: sprig-more");
ok(!Object.values(fs2).includes("mod-sprig"), "no file is mod-sprig");
ok(JSON.stringify(sp.manifest.modes.sprig) === JSON.stringify(["core", "sage", "rill", "sprig"]), "Sprig's start fetches its start group and the groups it shares, in START_ORDER: " + JSON.stringify(sp.manifest.modes.sprig));
ok(Object.entries(sp.manifest.modes).every(([m, gs]) => m === "sprig" || !gs.some((g) => g.startsWith("sprig"))), "no other mode's start includes a Sprig group: " + JSON.stringify(sp.manifest.modes));
ok(!sp.manifest.modes.sprig.includes("sprig-plot") && !sp.manifest.modes.sprig.includes("sprig-more"), "Sprig's start fetches neither sprig-plot nor sprig-more");
ok(sp.manifest.chunks.sprig?.pre && ["sprig-more", "sprig-plot"].every((g) => sp.manifest.chunks[g]?.src && !sp.manifest.chunks[g].pre), "sprig has its compiled code; the groups no start uses, sources only");
ok(["sprig", "sprig-more", "sprig-plot"].every((g) => itemOfGroup(g) === "sprig"), "the offline inventory's Sprig item owns every Sprig group");
// (a mode's group holds only that mode's own families, MODE_FAMILIES: any other file a start imports gets a group of its
// own, so importing it never fetches a mode's start (import time fetched MATLAB's, weakref Magma's, os.path sci's).
// _pytime and _tzrules, the time module's, are one shared family group, mod-time)
{
  const own = { sci: "numpy/__init__.py", sage: "_sage_ff.py", matlab: "_matlab.py", magma: "_magma.py", rill: "_rill/__init__.py", sprig: "_sprig/__init__.py" };
  const other = ["weakref.py", "posixpath.py", "_pytime.py", "_tzrules.py", "_special.py", "_memguard.py", "importlib/__init__.py", "_padic.py", "_sage_ffsub.py", "_matlab_x.py"];
  for (const m of Object.keys(MODE_FAMILIES)) {
    // (each mode's start imports its own file and every other one; Sage's family file _sage_ffsub and MATLAB's
    // _matlab_x, in other modes' starts, are other files there)
    const lib = Object.fromEntries([...Object.values(own), ...other, "core.py"].map((p) => [p, ""]));
    const sets = { py: new Set(["core.py"]), [m]: new Set([own[m], ...other]) };
    const got = Object.fromEntries(other.map((p) => [p, groupOf(p, sets)]));
    ok(groupOf(own[m], sets) === m, `${m}'s own file stays in ${m}: ${own[m]}`);
    ok(other.every((p) => (MODE_FAMILIES[m](p.split("/")[0].replace(/\.py$/, "")) ? got[p] === m : got[p] !== m && !Object.hasOwn(MODE_FAMILIES, got[p]))), `${m}'s start: every other file a group of its own, never ${m}'s nor another mode's: ` + JSON.stringify(got));
    const r = libChunks(lib, { py: { build: "b", modules: { "py|core": mod("core.py") } }, [m]: { build: "b", modules: Object.fromEntries(["core.py", own[m], ...other].map((p) => ["py|" + p, mod(p)])) } }, "b");
    ok(r.manifest.files["_pytime.py"] === "mod-time" && r.manifest.files["_tzrules.py"] === "mod-time" && JSON.stringify(Object.keys(JSON.parse(r.chunks.get(r.manifest.chunks["mod-time"].src.file).toString()).files).sort()) === JSON.stringify(["_pytime.py", "_tzrules.py"]), `${m}: _pytime and _tzrules, one shared group mod-time, its chunk exactly those two`);
    // (sci is no mode's start of its own: numpy's import)
    if (m === "sci") continue;
    const gs = r.manifest.modes[m];
    ok(gs[0] === "core" && gs.includes(m) && gs.indexOf(m) < gs.indexOf("mod-time") && gs.includes("mod-weakref"), `${m}'s start fetches core, then ${m}, then its files' own groups: ` + JSON.stringify(gs));
  }
  ok(familyViolation("weakref.py", "magma") !== null && familyViolation("_magma.py", "magma") === null && familyViolation("weakref.py", "mod-weakref") === null && familyViolation("os.py", "core") === null,
    "the build's check: a file outside a mode's families in that mode's group is refused; its own family, a mod- group or core is not");
  let refused = "";
  try { familyViolation("posixpath.py", "sci") && (() => { throw new Error(familyViolation("posixpath.py", "sci")); })(); } catch (e) { refused = String(e.message); }
  ok(/posixpath\.py is in the sci group, but isn't one of sci's own files/.test(refused), "...and says which file and group: " + refused);
}
console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
