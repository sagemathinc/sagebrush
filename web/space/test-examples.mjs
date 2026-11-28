// ci: web-browser/space order=6 runner=bun
// The 3D view's examples as the build writes them (web/build.ts, after a site build: bun web/build.ts): every file it
// writes for /space/ passes the repository's push text check (web/space/examples/text-check.ts), which catches each of
// its words and allows "cup product"; the generated "Modular forms in Sagebrush" is a space the viewer accepts, with
// its crates, Python layers, notes, samples (each output exactly what running it with this checkout gives) and plot;
// and "Sagebrush's repository", paths and links only, its files read from GitHub at the build's commit; the page's
// list offers both. (Fetched only when picked:
// web/space/test-page.mjs.)
//   bun web/space/test-examples.mjs
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PUSH_PATTERN, PUSH_TEXT, textProblems } from "./examples/text-check.ts";
import { checkSpace } from "./src/read.ts";

const here = new URL(".", import.meta.url).pathname, out = join(here, "..", "dist", "space");
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : "")); if (!c) failures++; };

// ---- the check: each of its alternatives, as a word in a sentence, is caught (built from the pattern itself, so no
//      word of it is written here); "cup product" is allowed; plain text passes
const samples = PUSH_TEXT.source.split("|").map((alt) => alt.replace(/\\b/g, "").replace("[0-9]", "1").replace(/\\\//g, "/"));
const missed = samples.filter((w) => textProblems(`see ${w} here`).length !== 1);
ok(samples.length >= 10 && missed.length === 0, `the check catches each of its ${samples.length} words`, missed);
// (and the pattern is exactly the push check's, byte for byte: its SHA-256, so no alternative can be dropped or changed
//  without this row failing; when the push check changes, this pin and the encoded copy change with it)
const PUSH_SHA256 = "81baf79c9c0f73e9d4e1bcab25b0c9fcb92ded9d562cb8463e4595a5da38adaa";
ok(createHash("sha256").update(PUSH_PATTERN).digest("hex") === PUSH_SHA256, "the pattern is the push check's (its SHA-256)", createHash("sha256").update(PUSH_PATTERN).digest("hex"));
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
  ok(/dimension_cusp_forms\(k\)\)/.test(plot.text) && !/\/ *3/.test(plot.text), "the plot's program draws the dimensions as they are (unscaled, as the surface is)", plot.text);
  ok(JSON.stringify(plot.surface.z) === grid.replace(/ /g, "") && JSON.stringify(plot.surface.x) === JSON.stringify([...Array(40)].map((_, i) => i + 1)) && JSON.stringify(plot.surface.y) === JSON.stringify([...Array(12)].map((_, i) => 2 * i + 2)), "the plot's dimensions are the ones computed now", { stored: JSON.stringify(plot.surface.z).slice(0, 80), run: grid.slice(0, 80) });
}
// ---- How the 3D view works: its own code, with tours (previews only; every function the text names exists)
ok(list.includes("self.space.json"), "the page's list offers the 3D view's own code");
let me = null;
try { me = checkSpace(JSON.parse(readFileSync(join(out, "self.space.json"), "utf8"))); ok(true, "the viewer accepts it (checkSpace)"); } catch (e) { ok(false, "the viewer accepts it", String(e)); }
if (me) {
  const ids = new Set(me.nodes.map((n) => n.id));
  ok(me.nodes.length === 41 && me.nodes.every((n) => typeof n.summary === "string" && n.summary.length > 20), "41 objects (13 parts of main.ts, 9 of xr.ts, 18 files and the overview), each with its summary", me.nodes.length);
  ok(me.tours.length === 5 && me.tours.every((t) => t.steps.length >= 4 && t.steps.every((st) => ids.has(st.node))), "five tours, each stop an object of the space");
  ok(me.edges.every((e) => ids.has(e.from) && ids.has(e.to)) && me.edges.length > 50, `its ${me.edges.length} links join its objects`);
  ok(me.nodes.every((n) => !("src" in n)) && me.nodes.every((n) => String(n.text ?? "").split("\n").length <= 60), "previews only: no src, at most 60 lines each");
  // (as main.ts decides what may be run: a code or plot3d object that isn't a notebook's cell)
  const runnable = (n) => (n.kind === "code" || n.kind === "plot3d") && !n.cell;
  ok(readFileSync(join(here, "src", "main.ts"), "utf8").includes('const runnable = (nd) => (nd.kind === "code" || nd.kind === "plot3d") && !nd.cell;'), "main.ts decides what may be run as this check does");
  ok(!me.nodes.some(runnable) && me.nodes.filter((n) => n.kind === "file").length === 40, "nothing in it can be run: its sources are files (40), the overview a note", me.nodes.filter(runnable).map((n) => n.id).slice(0, 5));
  ok(/not shown here/.test(me.nodes.find((n) => n.id === "space/src/tex.ts")?.text ?? ""), "a preview line the push text check would catch is left out, and says so");
  const web = join(here, ".."), sources = ["space/src/main.ts", "space/src/xr.ts", ...me.nodes.filter((n) => /\.(ts|js)$/.test(n.id)).map((n) => n.id)].map((f) => readFileSync(join(web, f), "utf8")).join("\n");
  const named = new Set([...JSON.stringify([me.nodes.map((n) => n.summary), me.tours]).matchAll(/\*\*([A-Za-z_$][\w$]*)\*\*/g)].map((m) => m[1]).filter((w) => /[a-z][A-Z]|^[a-z]+$/.test(w) && !/^(load|run|go|step|draw|open|press|hit|leave|enter|save|restore|search|look|editor|math|embed|start|layered|frame|engine|interrupt|layout|tick)$/.test(w) || /^[a-z]+[A-Z]/.test(w)));
  const missing = [...named].filter((w) => !new RegExp(`(function\\s+${w}\\b|\\b${w}\\s*[=:(]|\\bas\\s+${w}\\b|\\b${w}\\b\\s*\\}?\\s*from)`).test(sources));
  ok(named.size > 30 && missing.length === 0, `each of the ${named.size} functions its text names in bold is in the code`, missing);
}
// ---- Sagebrush's repository: paths, lengths and links only; its files read from GitHub at the build's commit
ok(list.includes("repository.space.json"), "the page's list offers the repository");
let repo = null;
try { repo = checkSpace(JSON.parse(readFileSync(join(out, "repository.space.json"), "utf8"))); ok(true, "the viewer accepts it (checkSpace)"); } catch (e) { ok(false, "the viewer accepts it", String(e)); }
if (repo) {
  const t = repo.tree, head = execFileSync("git", ["-C", join(here, "..", ".."), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  ok(t.commit === head && t.base === `https://raw.githubusercontent.com/sagemathinc/sagebrush/${head}/`, "its files are read from GitHub at this build's commit", { commit: t.commit, base: t.base });
  globalThis.location = new URL("https://sagebrush.space/space/");
  const { pinnedRaw } = await import("./src/read.ts");
  ok(t.files.every(([p]) => { try { pinnedRaw(t.base + p.split("/").map(encodeURIComponent).join("/"), t.commit); return true; } catch { return false; } }), `each of its ${t.files.length} files is one the viewer may read`);
  // (the viewer reads that commit only: its hash is compiled into the page's code)
  const js = readdirSync(join(out, "chunks")).map((f) => join(out, "chunks", f)).concat(join(out, "space.js"));
  ok(js.some((f) => readFileSync(f, "utf8").includes(JSON.stringify(head))), "the viewer's code has this build's commit compiled in");
  ok(t.files.length > 1000 && t.files.some(([p]) => p === "web/space/src/read.ts") && t.imports.length > 1000, "it is the whole tree, with its imports", { files: t.files.length, imports: t.imports.length });
  ok(repo.nodes.length === 0 && !JSON.stringify(t).includes("def "), "and carries no file's text");
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
