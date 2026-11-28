// ci: web-browser/space order=6 runner=bun
// The 3D view's examples as the build writes them (web/build.ts, after a site build: bun web/build.ts): every file it
// writes for /space/ passes the repository's push text check (web/space/examples/text-check.ts), which catches each of
// its words and allows "cup product"; the generated "Modular forms in Sagebrush" is a space the viewer accepts, with
// its crates, Python layers, notes, samples and plot, and the page's list offers it. (Fetched only when picked:
// web/space/test-page.mjs.)
//   bun web/space/test-examples.mjs
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
  ok(!/https?:\/\//.test(JSON.stringify(space.nodes.map((n) => n.src ?? ""))), "nothing in it is fetched from elsewhere (no node has a src)");
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
