// ci: checks.2 order=20 runner=bun
// The Terminal commands' bridge's size gate (design-term-3b2 r1 §1, daybreak2's ruling: a check of its own, not a
// budgets.json row): web/dist/shell/term-bridge.js as web/build.ts made it (CI's pinned bun), its raw bytes and Node's
// gzip -9 bytes each under its own ceiling.  Also pinned: the chunk's inputs are exactly the reviewed ones (a bare or
// unexpected import fails here), it is rebuilt from them to the same bytes, terminal.js names it only for its dynamic
// import, the site serves the same bytes, and the app's copy (app/build-frontend.mjs copies dist/shell whole) too.
//   bun web/build.ts && bun web/shell/term-bridge-size.mjs        (prints the figures; exit 1 on a failure)
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// (the first measurement + 64 B, as daybreak2 ruled: bun 1.4.4 and Node 24.21.0's zlib at level 9, on the PR's head)
const LIMIT_RAW = 20822, LIMIT_GZIP = 7743;
// (the reviewed inputs: the bridge, the command line's reader and the file channel; loader.ts and host.ts by type only)
const INPUTS = ["web/shell/term-bridge.ts", "src/term-command.ts", "web/term-sync.ts"];
const root = join(import.meta.dir, "..", "..");
const fails = [];
const chunk = join(root, "web", "dist", "shell", "term-bridge.js");
if (!existsSync(chunk)) {
  console.log("term-bridge-size: FAIL\n  web/dist/shell/term-bridge.js is missing: run bun web/build.ts first");
  process.exit(1);
}
const js = readFileSync(chunk);
// (gzip by Node's zlib, level 9, as the binding figures are: this script runs under bun, whose zlib differs)
const gz = Number(execFileSync("node", ["-e", "process.stdout.write(String(require('zlib').gzipSync(require('fs').readFileSync(process.argv[1]), { level: 9 }).length))", chunk], { encoding: "utf8" }));
console.log(`term-bridge-size: web/dist/shell/term-bridge.js: ${js.length} B raw (ceiling ${LIMIT_RAW}), ${gz} B gzip -9 by Node (ceiling ${LIMIT_GZIP})`);
if (js.length > LIMIT_RAW) fails.push(`${js.length} B raw is over ${LIMIT_RAW}`);
if (!(gz > 0) || gz > LIMIT_GZIP) fails.push(`${gz} B gzipped is over ${LIMIT_GZIP}`);
if (!/export\s*\{[^}]*\bbridge\b/.test(js.toString("utf8"))) fails.push("the chunk doesn't export bridge");

// its inputs, from the same build web/build.ts makes: exactly the reviewed ones, and the same bytes
const r = await Bun.build({ entrypoints: [join(root, "web", "shell", "term-bridge.ts")], target: "browser", format: "esm", minify: true, metafile: true });
if (!r.success) fails.push("the chunk doesn't build: " + r.logs.map(String).join("; ").slice(0, 300));
else {
  const inputs = Object.keys(r.metafile.inputs).map((p) => p.replace(/^\.\//, "")).sort();
  const want = [...INPUTS].sort();
  if (JSON.stringify(inputs) !== JSON.stringify(want)) fails.push(`its inputs are ${inputs.join(", ")}, not the reviewed ${want.join(", ")}`);
  const built = Buffer.from(await r.outputs[0].arrayBuffer());
  if (!built.equals(js)) fails.push("web/dist/shell/term-bridge.js isn't what its inputs build to (rebuild with bun web/build.ts)");
}
// lazy: terminal.js names it only for a dynamic import, at the first command
const terminal = join(root, "web", "dist", "shell", "terminal.js");
if (!existsSync(terminal) || !/import\([^)]*["']term-bridge\.js["']/.test(readFileSync(terminal, "utf8"))) fails.push("terminal.js doesn't name term-bridge.js for a dynamic import");
// the site and the app serve the same bytes (where they were built)
for (const [where, f] of [["the site", join(root, "web", "site", "public", "shell", "term-bridge.js")], ["the app", join(root, "app", "dist", "shell", "term-bridge.js")]]) {
  const dir = join(f, "..", "terminal.js");
  if (existsSync(dir) && readFileSync(dir).equals(readFileSync(terminal)) && !(existsSync(f) && readFileSync(f).equals(js))) fails.push(`${where}'s shell/term-bridge.js isn't the built chunk`);
}

if (fails.length) {
  console.log("term-bridge-size: FAIL\n  " + fails.join("\n  "));
  process.exit(1);
}
console.log("term-bridge-size: ok");
