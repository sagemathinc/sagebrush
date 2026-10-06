// lib/_viewer3d.py from web/viewer3d.js: the 3D viewer's source as a Python
// string, embedded in the HTML that Jupyter shows for Graphics3d.
//   node scripts/gen-viewer3d.mjs           write it
//   node scripts/gen-viewer3d.mjs --check   fail if it is out of date (CI)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const js = readFileSync(join(root, "web", "viewer3d.js"), "utf8");
if (js.includes("</")) throw new Error("web/viewer3d.js must not contain '</' (it is embedded in a <script>)");
const out = `"""The 3D viewer (generated from web/viewer3d.js by scripts/gen-viewer3d.mjs; do not edit)."""\n\nVIEWER_JS = ${JSON.stringify(js)}\n`;
const dest = join(root, "lib", "_viewer3d.py");
if (process.argv.includes("--check")) {
  if (!existsSync(dest) || readFileSync(dest, "utf8") !== out) {
    console.error("out of date: lib/_viewer3d.py (run node scripts/gen-viewer3d.mjs)");
    process.exit(1);
  }
} else writeFileSync(dest, out);
