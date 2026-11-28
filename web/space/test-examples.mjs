// ci: web-browser/space order=6 runner=bun
// The 3D view's examples as the build writes them (web/build.ts, after a site build: bun web/build.ts): every file it
// writes for /space/ passes the repository's push text check (web/space/examples/text-check.ts), which catches each of
// its words and allows "cup product"; the generated "Modular forms in Sagebrush" is a space the viewer accepts, with
// its crates, Python layers, notes, samples (each output exactly what running it with this checkout gives) and plot,
// and the page's list offers it. (Fetched only when picked:
// web/space/test-page.mjs.)
//   bun web/space/test-examples.mjs
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PUSH_TEXT, textProblems } from "./examples/text-check.ts";
import { checkSpace } from "./src/read.ts";

const here = new URL(".", import.meta.url).pathname, out = join(here, "..", "dist", "space");
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : "")); if (!c) failures++; };

// ---- the check: each of its alternatives, as a word in a sentence, is caught (built from the pattern itself, so no
//      word of it is written here); "cup product" is allowed; plain text passes
const samples = PUSH_TEXT.source.split("|").map((alt) => alt.replace(/\\b/g, "").replace("[0-9]", "1").replace(/\\\//g, "/"));
const missed = samples.filter((w) => textProblems(`see ${w} here`).length !== 1);
ok(samples.length >= 10 && missed.length === 0, `the check catches each of its ${samples.length} words`, missed);
ok(textProblems("the cup product of two classes").length === 0, "and allows \"cup product\"");
ok(textProblems("Modular symbols over Gamma0(N): Hecke operators").length === 0, "plain text passes");

// ---- everything the build writes for the page (texts: spaces, the project, the page, its description) passes it
const texts = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "chunks" ? [] : texts(join(dir, e.name))) : /\.(json|md|html|py|sage|js|ts|rs|ipynb|txt)$/.test(e.name) && e.name !== "space.js" ? [join(dir, e.name)] : []));
const files = texts(out), failing = files.map((f) => [f.slice(out.length + 1), textProblems(readFileSync(f, "utf8"))]).filter(([, h]) => h.length);
ok(files.length >= 5 && failing.length === 0, `the ${files.length} files written for /space/ pass the push text check`, failing.slice(0, 3));

// ---- Modular forms in Sagebrush
const list = JSON.parse(readFileSync(join(out, "spaces.json"), "utf8"));
ok(list.includes("modular-forms.space.json"), "the page's list offers it", list);
const raw = readFileSync(join(out, "modular-forms.space.json"), "utf8");
let space = null;
try { space = checkSpace(JSON.parse(raw)); } catch (e) { ok(false, "the viewer accepts it", String(e)); }
if (space) {
  ok(true, "the viewer accepts it (checkSpace)");
  const ids = new Set(space.nodes.map((n) => n.id)), kinds = (k) => space.nodes.filter((n) => n.kind === k);
  const crates = ["modsym", "hmf", "ap", "lfun"];
  ok(crates.every((c) => space.nodes.some((n) => n.kind === "file" && n.title.startsWith(`engine/${c}/src/`))), "the four crates' Rust files are in it");
  ok(space.nodes.some((n) => n.kind === "file" && n.title === "lib/_sage_modular.py") && space.nodes.some((n) => n.kind === "file" && n.title === "lib/sagebrush/mf.py"), "and the Python layers that call them");
  ok(crates.every((c) => ids.has("note-" + c)) && ids.has("overview"), "a note per crate, and the overview");
  ok(kinds("code").length === 6 && kinds("code").every((n) => n.lang === "sage" && n.output), "six Sage samples, each with its output");
  ok(kinds("plot3d").length === 1 && kinds("plot3d")[0].surface?.z?.length === 12, "the dimension plot (k = 2..24)");
  ok(space.edges.length > 100 && space.edges.every((e) => ids.has(e.from) && ids.has(e.to)), `its ${space.edges.length} links join its objects`);
  ok(space.nodes.every((n) => !("src" in n)), "nothing in it is fetched: no node has a src");
  // (each sample's output is what running it gives: its program with this checkout's Sagebrush (build/cli/pyjs.cjs,
  //  Sage syntax), the repr of its last line, compared exactly)
  const cli = join(here, "..", "..", "build", "cli", "pyjs.cjs");
  for (const n of kinds("code")) {
    const lines = n.text.split("\n"), last = lines.pop();
    let got;
    try { got = execFileSync("node", [cli, "--sage", "-c", [...lines, `print(repr((${last})))`].join("\n")], { encoding: "utf8", timeout: 300_000 }).replace(/\n$/, ""); } catch (e) { got = "failed: " + String(e.stderr ?? e).slice(-300); }
    ok(got === n.output, `the sample "${n.title}" shows exactly the output it gives`, got === n.output ? undefined : { stored: n.output.slice(0, 120), run: got.slice(0, 240) });
  }
  // (and the plot's data is the dimensions themselves: dim S_k(Gamma0(N)) for N = 1..40, k = 2..24 even, computed now)
  const plot = kinds("plot3d")[0], grid = execFileSync("node", [cli, "--sage", "-c", "print([[Gamma0(N).dimension_cusp_forms(k) for N in range(1, 41)] for k in range(2, 26, 2)])"], { encoding: "utf8", timeout: 300_000 }).trim();
  ok(JSON.stringify(plot.surface.z) === grid.replace(/ /g, "") && JSON.stringify(plot.surface.x) === JSON.stringify([...Array(40)].map((_, i) => i + 1)) && JSON.stringify(plot.surface.y) === JSON.stringify([...Array(12)].map((_, i) => 2 * i + 2)), "the plot's dimensions are the ones computed now", { stored: JSON.stringify(plot.surface.z).slice(0, 80), run: grid.slice(0, 80) });
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
