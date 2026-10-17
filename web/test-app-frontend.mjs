// The desktop app's page (app/build-frontend.mjs) builds from web/dist with
// every file its worker needs, the pinned zone data's included, and its check
// fails on what does not match: a file in lib/tzdata the worker does not name,
// a zone file whose bytes are not those its index names, a missing index, an
// unknown directory in lib/. (ci.yml's app check, run by the VM CI too: a
// lib/tzdata the check did not know failed only GitHub's app workflow.)
// Build web/dist first: bun web/build.ts
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const script = join(here, "..", "app", "build-frontend.mjs");
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };

const built = execFileSync(process.execPath, [script], { encoding: "utf8" });
ok(/its zone data's index and \d+ zone files for \d+ zones/.test(built), "app/dist builds, with the zone data checked: " + built.trim());
const tz = join(here, "..", "app", "dist", "lib", "tzdata");
const files = readdirSync(tz);
ok(files.some((f) => /^index-[0-9a-f]{64}\.json$/.test(f)) && files.filter((f) => f.endsWith(".tzif")).length > 300, `app/dist/lib/tzdata has the index and the zone files (${files.length} files)`);

// (each change on a copy, undone after)
const dir = mkdtempSync(join(tmpdir(), "sb-app-frontend-"));
try {
  const copy = join(dir, "dist");
  cpSync(join(here, "..", "app", "dist"), copy, { recursive: true });
  const check = () => { const r = spawnSync(process.execPath, [script, "--check", copy], { encoding: "utf8" }); return { status: r.status, out: r.stdout + r.stderr }; };
  ok(check().status === 0, "the copy passes the check");
  const ctz = join(copy, "lib", "tzdata");
  const index = readdirSync(ctz).find((f) => f.startsWith("index-"));
  const zone = readdirSync(ctz).find((f) => f.endsWith(".tzif"));

  writeFileSync(join(ctz, "extra.tzif"), "TZif");
  let r = check();
  ok(r.status === 1 && r.out.includes("lib/tzdata/extra.tzif: in app/dist but not the worker's"), "a file in lib/tzdata the worker does not name: refused");
  rmSync(join(ctz, "extra.tzif"));

  const bytes = readFileSync(join(ctz, zone));
  writeFileSync(join(ctz, zone), Buffer.concat([bytes, Buffer.from([0])]));
  r = check();
  ok(r.status === 1 && r.out.includes(`lib/tzdata/${zone} (`) && r.out.includes("not the bytes the zone data's index names"), "a zone file with other bytes: refused");
  writeFileSync(join(ctz, zone), bytes);

  rmSync(join(ctz, zone));
  r = check();
  ok(r.status === 1 && r.out.includes(`lib/tzdata/${zone} (`) && r.out.includes("missing from app/dist"), "a zone file missing: refused");
  writeFileSync(join(ctz, zone), bytes);

  renameSync(join(ctz, index), join(dir, index));
  r = check();
  ok(r.status === 1 && r.out.includes(`lib/tzdata/${index}: missing from app/dist`), "the zone data's index missing: refused");
  renameSync(join(dir, index), join(ctz, index));

  mkdirSync(join(copy, "lib", "other"));
  r = check();
  ok(r.status === 1 && r.out.includes("lib/other: in app/dist but not the worker's"), "a directory in lib/ the worker does not name: refused");
  rmSync(join(copy, "lib", "other"), { recursive: true });

  ok(check().status === 0, "the copy, each change undone, passes again");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
