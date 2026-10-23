// Builds are reproducible whatever the checkout's path: a second build of
// the same commit, from a checkout at a different path (and path length),
// writes byte-identical engine files and the same engine id, and no built
// file names either checkout's path.  The engine id is a hash of the engine
// files, and sw.js, the CSP and the board bundles derive from it, so a path in
// the worker (as Bun's inlined __dirname once was) made every deploy from a new
// directory publish a "new" engine.  Run after a normal build (CI's web-sync
// job), which this compares against.
//   bun web/test-reproducible-build.mjs
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
let failures = 0;
const ok = (c, what) => {
  if (!c) {
    failures++;
    console.log("FAIL", what);
  }
};
const run = (cmd, args, cwd, env = {}) => spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 1 << 26 });

const latestA = JSON.parse(readFileSync(join(here, "dist", "engine", "latest.json"), "utf8"));

// (the second checkout: HEAD, at a path unlike the first, with the build's untracked inputs linked in)
const base = mkdtempSync(join(tmpdir(), "sb-reproducible-"));
const other = join(base, "a-longer-and-different-checkout-path");
let r = run("git", ["worktree", "add", "-q", "--detach", other, "HEAD"], root);
ok(r.status === 0, `a second checkout of HEAD (git worktree add): ${r.stderr}`);
try {
  // node_modules, wherever the first checkout has them, are linked; build/ (the CLI build's generated
  // files, which web/build.ts reads) is copied
  for (const d of ["node_modules", "web/node_modules", "web/site/node_modules"]) {
    if (existsSync(join(root, d)) && !existsSync(join(other, d))) symlinkSync(join(root, d), join(other, d));
  }
  if (existsSync(join(root, "build"))) cpSync(join(root, "build"), join(other, "build"), { recursive: true });
  r = run("bun", [join(other, "web", "build.ts")], other, { SAGEBRUSH_NO_SITE: "1" });
  ok(r.status === 0, `the second build exits 0 (status ${r.status}): ${(r.stderr ?? "").split("\n").slice(-5).join(" | ")}`);

  const latestB = JSON.parse(readFileSync(join(other, "web", "dist", "engine", "latest.json"), "utf8"));
  ok(latestA.id === latestB.id, `the same engine id from both paths (${latestA.id}, ${latestB.id})`);
  const dirA = join(here, "dist", "engine", latestA.id), dirB = join(other, "web", "dist", "engine", latestB.id);
  const files = (d) => readdirSync(d, { recursive: true }).filter((f) => statSync(join(d, f)).isFile()).sort();
  const fa = files(dirA), fb = existsSync(dirB) ? files(dirB) : [];
  ok(fa.length > 0 && fa.join() === fb.join(), `the same engine files from both paths (${fa.length}, ${fb.length})`);
  const differ = fa.filter((f) => fb.includes(f) && !readFileSync(join(dirA, f)).equals(readFileSync(join(dirB, f))));
  ok(differ.length === 0, `every engine file is byte-identical (differ: ${differ.slice(0, 5).join(", ")})`);

  // (no built file names either checkout's path)
  for (const [dist, mine] of [[join(here, "dist"), root], [join(other, "web", "dist"), other]]) {
    const named = files(dist).filter((f) => readFileSync(join(dist, f)).includes(Buffer.from(mine + "/")));
    ok(named.length === 0, `no file in ${relative(base, dist) || dist} names its checkout's path (${named.slice(0, 5).join(", ")})`);
  }
} finally {
  run("git", ["worktree", "remove", "--force", other], root);
  rmSync(base, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : `reproducible build: all passed (engine ${latestA.id})`);
process.exit(failures ? 1 : 0);
