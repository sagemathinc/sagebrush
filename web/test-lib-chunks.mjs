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
console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
