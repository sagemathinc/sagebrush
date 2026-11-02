// The export's lazy chunk (sagebrush-export.js) and its worker (sagebrush-export-worker.js), each against its reviewed
// ceiling in web/workspace/export/size-ceiling.json, tightly: over its ceiling fails, and so does more than 1024 bytes
// under it (the ceiling is then lowered in the same change, as a growth marker is).  The pages' own growth is the size
// gate's (its cli/pyjs.cjs marker); this guards the lazy files themselves, which no core bundle row measures alone
// (E1 r2, daybreak2's E1-D2-2).  Measured as CI builds them: bun 1.4.4, after `bun web/build.ts`.
//   node scripts/check-export-size.mjs           check
//   node scripts/check-export-size.mjs --print   the sizes now
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ceilings = JSON.parse(readFileSync(join(root, "web/workspace/export/size-ceiling.json"), "utf8"));
const SLACK = 1024;
let bad = 0;
for (const f of ["sagebrush-export.js", "sagebrush-export-worker.js"]) {
  const size = statSync(join(root, "web/dist", f)).size, ceiling = ceilings.bytes?.[f];
  if (process.argv.includes("--print")) { console.log(`${f} ${size}`); continue; }
  if (typeof ceiling !== "number") { bad++; console.log(`FAIL ${f}: no ceiling in size-ceiling.json`); continue; }
  const ok = size <= ceiling && ceiling - size <= SLACK;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${f}: ${size} bytes, ceiling ${ceiling}${size > ceiling ? ` (${size - ceiling} over: raise it, reviewed, with the reason)` : ceiling - size > SLACK ? ` (${ceiling - size} under: lower it to at most ${size + SLACK})` : ""}`);
}
if (bad) { console.log(`bun ${process.versions.bun ?? "(not bun)"}; the ceilings are for bun 1.4.4's output`); process.exit(1); }
