#!/usr/bin/env node
// The plan's CI benchmark for the finite-field limits (plan-ff-limits r3,
// section 6): the largest call admitted at the ceiling ff.work = 10^8,
// MinimalPolynomial in GF(2^79) (79373117 cops), in a 96 MiB heap, must take
// under 15 s on CI's runner.  The call alone is timed (in Python, around it),
// not the session's start; run by itself, not beside other tests.  On the
// reference VM it takes about 1.7 s (Node 24.21.0, PR #93's measurements).
//   node scripts/bench-ff-limits.mjs        (after pnpm run build)
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_S = 15;
const dir = mkdtempSync(join(tmpdir(), "sb-ff-bench-"));
const limits = join(dir, "limits.json"), script = join(dir, "bench.sage");
writeFileSync(limits, '{"ff.work": 100000000}');
writeFileSync(script, 'import time\nR.<x> = GF(2)[]\nK = GF(2^79, "a", modulus=x^79 + x^9 + 1)\nt = time.time()\nf = (K.gen()^3 + K.gen()).minpoly()\nprint(f.degree(), time.time() - t)\n');
const env = { ...process.env };
delete env.SAGEBRUSH_LIMITS;
const r = spawnSync(process.execPath, ["--max-old-space-size=96", join(root, "dist", "src", "cli.js"), "--limits", limits, script], { encoding: "utf8", env, timeout: 300000 });
const [deg, secs] = (r.stdout ?? "").trim().split(" ");
if (r.status !== 0 || deg !== "79") {
  console.error(`bench-ff-limits: the call did not complete (status ${r.status}):\n${r.stdout}${r.stderr}`);
  process.exit(1);
}
const s = Number(secs);
console.log(`bench-ff-limits: MinimalPolynomial in GF(2^79), 79373117 cops at ff.work = 10^8, 96 MiB heap: ${s.toFixed(2)} s (at most ${MAX_S} s)`);
if (!(s < MAX_S)) process.exit(1);
