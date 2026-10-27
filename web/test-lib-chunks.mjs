// The library's chunks with packages (web/lib-chunks.mts): a package's
// module that a mode's start imported (recorded at its package path,
// "pkg:<dir>/<path>", src/compile.ts) gets its compiled code in the
// package's group, which is then in that mode's start; nothing recorded
// for a file no package or library has is used.
//   bun web/test-lib-chunks.mjs
import { libChunks } from "./lib-chunks.mts";

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
ok(JSON.stringify(plain.manifest.modes.matlab) === JSON.stringify(["core", "matlab"]) && JSON.stringify(manifest.modes.matlab) === JSON.stringify(["core", "matlab", "pkg-scipy-io"]), "without packages, the library's start as before; with them, the same plus the package's: " + JSON.stringify([plain.manifest.modes.matlab, manifest.modes.matlab]));
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
console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
