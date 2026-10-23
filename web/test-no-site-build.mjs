// The core build without web/site/ (PR #59, astra's CORR-PR59-1;
// plan-cloud-split-r1 §2): `SAGEBRUSH_NO_SITE=1 bun web/build.ts` must
// succeed, produce web/dist/, and write nothing into web/site/, as when
// web/site/ has moved to sagebrush-cloud.  Run after a normal build (CI's
// web-sync job), so web/site/ exists and any write into it would show.
//   bun web/test-no-site-build.mjs
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (c, what) => {
  if (!c) {
    failures++;
    console.log("FAIL", what);
  }
};

/** path -> mtime and size of every file under dir (none if absent) */
function snapshot(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
      } else {
        const s = statSync(p);
        out.set(p, `${s.mtimeMs}:${s.size}`);
      }
    }
  };
  walk(dir);
  return out;
}

const site = join(here, "site");
const before = snapshot(site);
const t0 = Date.now();
const r = spawnSync("bun", [join(here, "build.ts")], { cwd: join(here, ".."), env: { ...process.env, SAGEBRUSH_NO_SITE: "1" }, encoding: "utf8", maxBuffer: 1 << 26 });
ok(r.status === 0, `the no-site build exits 0 (status ${r.status}): ${(r.stderr ?? "").split("\n").slice(-5).join(" | ")}`);
for (const f of ["index.html", "sw.js", "sagebrush-worker.js", "s/index.html", "_headers"]) {
  const p = join(here, "dist", f);
  ok(existsSync(p) && statSync(p).mtimeMs >= t0 - 1000, `web/dist/${f} is written by the no-site build`);
}
const after = snapshot(site);
const changed = [...after].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);
const added = [...after.keys()].filter((p) => !before.has(p));
ok(changed.length === 0 && added.length === 0, `nothing under web/site/ is written (changed ${changed.slice(0, 3).join(", ")}; added ${added.slice(0, 3).join(", ")})`);
console.log(failures ? `${failures} failed` : "no-site build: all passed");
process.exit(failures ? 1 : 0);
