// Library modules compiled when the site was built (src/compile.ts,
// precompiled; web/build.ts makes them, web/worker.ts fetches them and checks
// their SHA-256): an entry is used only for the library file it was made
// from (its build, mode, module, exact path, and the library's own source);
// anything else compiles as before (design/security.md, SEC-8D6-1, PRE-8D6-2).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile, execModule, libDir } from "../src/compile";

test("precompiled library modules: used only for the library file they were made from", () => {
  const g = globalThis as any;
  const filename = join(libDir(), "colorsys.py");
  const source = readFileSync(filename, "utf8");
  const marker = compile("WHERE = 'precompiled'\n", filename, "colorsys");
  const entry = { ...marker, path: "colorsys.py" };
  const load = (src = source, file = filename) => execModule(src, file, "colorsys");
  const was = [g.__SAGEBRUSH_BUILD_ID__, g.__SAGEBRUSH_PRECOMPILED__, g.__PYJS_LIB__];
  try {
    g.__SAGEBRUSH_BUILD_ID__ = "build-a";
    g.__PYJS_LIB__ = { "colorsys.py": source };
    g.__SAGEBRUSH_PRECOMPILED__ = { build: "build-a", modules: { "py|colorsys": entry } };
    assert.equal(load().WHERE, "precompiled");
    // another build's
    g.__SAGEBRUSH_PRECOMPILED__.build = "build-b";
    assert.equal(load().WHERE, undefined);
    assert.equal(typeof load().rgb_to_hsv, "function");
    g.__SAGEBRUSH_PRECOMPILED__.build = "build-a";
    // a source other than the library's own, even of the same length (PRE-8D6-2)
    const same = source.replace(/[a-z]/, (c) => (c === "a" ? "b" : "a"));
    assert.equal(same.length, source.length);
    assert.equal(load(same).WHERE, undefined);
    // a file outside the library, also beside it with the same prefix (lib-attacker/)
    assert.equal(load(source, "/tmp/colorsys.py").WHERE, undefined);
    assert.equal(load(source, libDir() + "-attacker/colorsys.py").WHERE, undefined);
    // an entry made for another path, or malformed
    g.__SAGEBRUSH_PRECOMPILED__.modules["py|colorsys"] = { ...entry, path: "other.py" };
    assert.equal(load().WHERE, undefined);
    g.__SAGEBRUSH_PRECOMPILED__.modules["py|colorsys"] = { ...entry, lineMap: "x" };
    assert.equal(load().WHERE, undefined);
    // Sage mode's own key, or another module's; a name only inherited by the table
    g.__SAGEBRUSH_PRECOMPILED__ = { build: "build-a", modules: { "sage|colorsys": entry, "py|other": entry } };
    assert.equal(load().WHERE, undefined);
    g.__SAGEBRUSH_PRECOMPILED__ = { build: "build-a", modules: Object.create({ "py|colorsys": entry }) };
    assert.equal(load().WHERE, undefined);
    // and the right one, again
    g.__SAGEBRUSH_PRECOMPILED__ = { build: "build-a", modules: { "py|colorsys": entry } };
    assert.equal(load().WHERE, "precompiled");
  } finally {
    [g.__SAGEBRUSH_BUILD_ID__, g.__SAGEBRUSH_PRECOMPILED__, g.__PYJS_LIB__] = was;
  }
});
