// The terminal panel's size (plan-bash-shell r8c E5.6): the panel's own code (web/shell/panel.ts and what it alone
// brings: panel-render.ts and panel.css, which it imports as text; the page's commands, panel-commands.ts and
// presence.ts, are the page's, charged by the size gate's marker) bundled and minified as ESM, then gzipped
// at level 9 with a fixed mtime; fails above LIMIT (below).  The bundler is bun's (the repository builds with bun,
// pinned in CI and budgets.json; it has no esbuild), with the options E5.6 names: --bundle --minify --format=esm.
// Conservative: the CSS is counted as panel.ts embeds it (unminified text).
// The dependency census: every bundled input is one of the panel's own files (relative, in web/shell/), and no
// import is bare (no npm specifier); host.ts is a type-only import, erased.
//   bun web/shell/panel-size.mjs        (prints the figures; exit 1 on a failure)
import { gzipSync } from "node:zlib";
import { join, relative } from "node:path";

// (E5.6's 8 192 B, raised to 9 216 B by daybreak2's ruling on #326 r2 (terminal-panel-pr326-r2-daybreak2.md,
// 3b9176e9): the 274 B over the old ceiling are the r1 reviews' required fixes only, no new features); raised to
// 9 344 B by daybreak2's rulings on #337 r3 (terminal-longline-pr337-r3-size-ruling-daybreak2.md, 423988e6; set at
// 9 344 by DB2-LL-337-3, terminal-longline-pr337-r3-daybreak2.md, 96f6bf15: bun 1.4.4, CI's pin, measures 9 281):
// "DB2-LL-337-2 exact UAX regional-indicator parity across retained windows, plus scalar-safe slice hold."
const LIMIT = 9344;
const here = import.meta.dir;
const root = join(here, "..", "..");
const ALLOWED = new Set(["web/shell/panel.ts", "web/shell/panel-render.ts", "web/shell/panel.css"]);
const fails = [];

const r = await Bun.build({ entrypoints: [join(here, "panel.ts")], target: "browser", format: "esm", minify: true, metafile: true });
if (!r.success) {
  console.log("panel-size: the bundle failed:\n" + r.logs.map(String).join("\n"));
  process.exit(1);
}
// (E5.6's figure: the JS with panel.css's text taken out, then panel.css minified on its own, the two concatenated)
const cssBuild = await Bun.build({ entrypoints: [join(here, "panel.css")], minify: true });
const css = Buffer.from(await cssBuild.outputs[0].arrayBuffer());
const noCss = await Bun.build({ entrypoints: [join(here, "panel.ts")], target: "browser", format: "esm", minify: true,
  plugins: [{ name: "css-out", setup(b) { b.onLoad({ filter: /panel\.css$/ }, () => ({ contents: "", loader: "text" })); } }] });
const jsOnly = Buffer.from(await noCss.outputs[0].arrayBuffer());
const specGz = gzipSync(Buffer.concat([jsOnly, css]), { level: 9 });
console.log(`panel-size: E5.6 figure: ${jsOnly.length} B JS + ${css.length} B CSS minified = ${specGz.length} B gzipped`);
const js = Buffer.from(await r.outputs[0].arrayBuffer());
const inputs = Object.keys(r.metafile?.inputs ?? {}).map((p) => relative(root, join(root, p)).replace(/^(\.\.\/)+/, ""));
for (const p of inputs) {
  const rel = relative(root, p.startsWith("/") ? p : join(process.cwd(), p));
  const norm = ALLOWED.has(p) ? p : rel;
  if (!ALLOWED.has(norm)) fails.push(`an input outside the panel's own files: ${p}`);
}
for (const [p, info] of Object.entries(r.metafile?.inputs ?? {})) {
  for (const imp of info.imports ?? []) {
    if (!/^\.{1,2}\//.test(imp.original ?? imp.path) && !(imp.path ?? "").startsWith("/")) fails.push(`a bare import in ${p}: ${imp.original ?? imp.path}`);
  }
}
// (gzip, level 9, fixed mtime: zlib's gzip header has mtime 0 and no name; deterministic for the same input)
const gz = gzipSync(js, { level: 9 });
console.log(`panel-size: as shipped (CSS embedded unminified): ${js.length} B minified, ${gz.length} B gzipped; inputs: ${inputs.join(", ")}`);
if (specGz.length > LIMIT) fails.push(`${specGz.length} B gzipped (E5.6's figure) is over ${LIMIT}`);
if (fails.length) {
  console.log("panel-size: FAIL\n  " + fails.join("\n  "));
  process.exit(1);
}
console.log("panel-size: ok");
