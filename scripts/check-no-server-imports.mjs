// Core must not import the Cloudflare application's server code, which moves
// to sagemathinc/sagebrush-cloud (plan-cloud-split-r1 §2): no file outside
// web/{site,files,share,sync,lti}/ may import a module inside them.  The open
// sync protocol is web/sync-protocol/, and the share client web/share-client/.
//
//   node scripts/check-no-server-imports.mjs     (exit 1 on any such import)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = /^web\/(site|files|share|sync|lti)\//;
const SOURCE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|html)$/;
// import/export ... from "x", import("x"), require("x"), import "x", <script src="x">
const SPECIFIERS = [
  /\b(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+["']([^"']+)["']/g,
  /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g,
];

const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\n")
  .filter((f) => f && SOURCE.test(f) && !SERVER.test(f) && !f.includes("node_modules/") && !f.startsWith("upstream/"));
const bad = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(join(root, f), "utf8");
  } catch {
    continue;
  }
  if (text.length > 4 << 20) continue;
  for (const re of SPECIFIERS) {
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
      const target = normalize(spec.startsWith("/") ? join("web", spec) : join(dirname(f), spec)).replace(/\\/g, "/");
      if (SERVER.test(target + (target.endsWith("/") ? "" : "/")) || SERVER.test(target)) bad.push(`${f}: ${spec} -> ${relative(".", target)}`);
    }
  }
}
if (bad.length) {
  console.error("core imports server code (plan-cloud-split-r1 §2):\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log(`no server imports in ${files.length} core source files`);
