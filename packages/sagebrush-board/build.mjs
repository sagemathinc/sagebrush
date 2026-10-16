// Build @sagemathinc/sagebrush-board (run with Bun: bun build.mjs):
// - dist/index.js: one ES module, web/board/index.ts and what it imports
//   (the stylesheets inside, as text), for browsers;
// - dist/index.d.ts: its types (tsc), from dist/types;
// - dist/submission.js and .d.ts: a host's check of a board's answers
//   (web/board/ask.ts checkSubmission, web/board-host-protocol.md), alone,
//   so that a host takes it without the board.
// What a board loads only when it needs it (the notebook's engine for code
// items, KaTeX, patchflow for TimeTravel) is not in it: the host gives it
// (mount.ts BoardHost: code, math, history).
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });

const r = await Bun.build({
  entrypoints: [join(root, "web", "board", "index.ts")],
  outdir: dist,
  naming: "index.js",
  target: "browser",
  format: "esm",
  sourcemap: "linked",
});
const sub = await Bun.build({
  entrypoints: [join(root, "web", "board", "ask.ts")],
  outdir: dist,
  naming: "submission.js",
  target: "browser",
  format: "esm",
  sourcemap: "linked",
});
for (const b of [r, sub]) if (!b.success) {
  for (const l of b.logs) console.error(l);
  process.exit(1);
}

const tsc = Bun.spawnSync([join(root, "node_modules", ".bin", "tsc"), "--ignoreConfig", "--declaration", "--emitDeclarationOnly",
  "--strict", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--lib", "dom,dom.iterable,es2023",
  "--skipLibCheck", "--allowJs", "--rootDir", join(root, "web"), "--outDir", join(dist, "types"),
  join(root, "web", "board", "text-imports.d.ts"), join(root, "web", "board", "index.ts"), join(root, "web", "board", "ask.ts")], { stdout: "inherit", stderr: "inherit" });
if (tsc.exitCode !== 0) process.exit(1);
writeFileSync(join(dist, "index.d.ts"), 'export * from "./types/board/index";\n');
writeFileSync(join(dist, "submission.d.ts"), 'export { checkSubmission, type Posted, type Checked, type Submission } from "./types/board/ask";\n');

const size = (await Bun.file(join(dist, "index.js")).arrayBuffer()).byteLength;
const subSize = (await Bun.file(join(dist, "submission.js")).arrayBuffer()).byteLength;
console.log(`dist/index.js: ${(size / 1024).toFixed(0)} kB; dist/submission.js: ${(subSize / 1024).toFixed(0)} kB; dist/index.d.ts, submission.d.ts`);
