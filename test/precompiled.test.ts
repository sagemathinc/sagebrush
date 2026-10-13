// Library modules compiled when the site was built (src/compile.ts,
// precompiled; web/build.ts makes them, web/worker.ts fetches them): used
// for their own build only, for the mode and module they were made for, and
// for a library file of the same length; anything else compiles as before.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile, execModule, libDir } from "../src/compile";

test("precompiled library modules: used only for their own build, mode, module and source", () => {
  const g = globalThis as any;
  const filename = join(libDir(), "colorsys.py");
  const source = readFileSync(filename, "utf8");
  const marker = compile("WHERE = 'precompiled'\n", filename, "colorsys");
  const load = () => execModule(source, filename, "colorsys");
  const was = [g.__SAGEBRUSH_BUILD_ID__, g.__SAGEBRUSH_PRECOMPILED__];
  try {
    g.__SAGEBRUSH_BUILD_ID__ = "build-a";
    g.__SAGEBRUSH_PRECOMPILED__ = { build: "build-a", modules: { "py|colorsys": { ...marker, len: source.length } } };
    assert.equal(load().WHERE, "precompiled");
    // another build's
    g.__SAGEBRUSH_PRECOMPILED__.build = "build-b";
    assert.equal(load().WHERE, undefined);
    assert.equal(typeof load().rgb_to_hsv, "function");
    // another length of source (an edited file)
    g.__SAGEBRUSH_PRECOMPILED__ = { build: "build-a", modules: { "py|colorsys": { ...marker, len: source.length + 1 } } };
    assert.equal(load().WHERE, undefined);
    // Sage mode's own key, or another module's
    g.__SAGEBRUSH_PRECOMPILED__ = { build: "build-a", modules: { "sage|colorsys": { ...marker, len: source.length }, "py|other": { ...marker, len: source.length } } };
    assert.equal(load().WHERE, undefined);
    // a name only inherited by the table (no prototype lookups)
    g.__SAGEBRUSH_PRECOMPILED__ = { build: "build-a", modules: Object.create({ "py|colorsys": { ...marker, len: source.length } }) };
    assert.equal(load().WHERE, undefined);
    // a file outside the library
    g.__SAGEBRUSH_PRECOMPILED__ = { build: "build-a", modules: { "py|colorsys": { ...marker, len: source.length } } };
    assert.equal(execModule(source, "/tmp/colorsys.py", "colorsys").WHERE, undefined);
  } finally {
    [g.__SAGEBRUSH_BUILD_ID__, g.__SAGEBRUSH_PRECOMPILED__] = was;
  }
});
