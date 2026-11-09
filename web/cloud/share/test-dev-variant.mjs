// ci: web-sync.1 order=17
// The variant check, both ways (grader's PR 1 conditions): web/share/serve-dev.mjs's startDev refuses to run the core
// server when the hosted variant is expected and the reverse, on the instance itself; and run-mit-suite.mjs's verdict
// fails a run that didn't start the hosted server with exactly the merged migrations, or didn't finish.
//   node web/cloud/share/test-dev-variant.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { migrations } from "./migrations.mjs";
import { verdict } from "./run-mit-suite.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const serveDev = join(here, "../../share/serve-dev.mjs");
const { startDev } = await import(pathToFileURL(serveDev).href);
let failures = 0;
const ok = (c, what) => { if (!c) { failures++; console.log("FAIL " + what); } };
const cloud = { SHARE_DEV_ENTRY: join(here, "test-entry.ts"), SHARE_DEV_MIGRATIONS: JSON.stringify(migrations().map((m) => m.path)) };
const names = migrations().map((m) => m.name);

// startDev on each server, expecting each variant: only the matching pairs start
let port = 18850;
async function starts(env) {
  const saved = { ...process.env };
  for (const k of ["SHARE_DEV_ENTRY", "SHARE_DEV_MIGRATIONS", "SHARE_DEV_EXPECT"]) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const d = await startDev({ sitePort: port++, filesPort: port++ });
    await d.close();
    return null;
  } catch (e) {
    return String(e.message);
  } finally {
    for (const k of ["SHARE_DEV_ENTRY", "SHARE_DEV_MIGRATIONS", "SHARE_DEV_EXPECT"]) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
ok((await starts({})) === null, "the core server, expecting core: starts");
ok((await starts({ ...cloud, SHARE_DEV_EXPECT: "hosted" })) === null, "the hosted server, expecting hosted: starts");
ok(/expected the hosted variant, found sharePreview absent and the remotes table absent/.test(await starts({ SHARE_DEV_EXPECT: "hosted" })), "the core server, expecting hosted: refused");
ok(/expected the core variant, found sharePreview answering and the remotes table present/.test(await starts({ ...cloud, SHARE_DEV_EXPECT: "core" })), "the hosted server, expecting core: refused");
ok(/SHARE_DEV_ENTRY: no such file/.test(await starts({ ...cloud, SHARE_DEV_ENTRY: join(here, "no-such-entry.ts"), SHARE_DEV_EXPECT: "hosted" })), "a missing entry: refused, no fallback");
// (each signal alone is not the hosted variant, and either one alone is not core's: the check needs both, or neither)
const coreOnly = JSON.stringify(migrations().slice(0, 5).map((m) => m.path));
const coreEntry = join(here, "../../share/test-entry.ts");
ok(/found sharePreview answering and the remotes table absent/.test(await starts({ SHARE_DEV_ENTRY: cloud.SHARE_DEV_ENTRY, SHARE_DEV_MIGRATIONS: coreOnly, SHARE_DEV_EXPECT: "hosted" })), "the hosted entry without 0009, expecting hosted: refused");
ok(/found sharePreview answering and the remotes table absent/.test(await starts({ SHARE_DEV_ENTRY: cloud.SHARE_DEV_ENTRY, SHARE_DEV_MIGRATIONS: coreOnly, SHARE_DEV_EXPECT: "core" })), "the hosted entry without 0009, expecting core: refused");
ok(/found sharePreview absent and the remotes table present/.test(await starts({ SHARE_DEV_ENTRY: coreEntry, SHARE_DEV_MIGRATIONS: cloud.SHARE_DEV_MIGRATIONS, SHARE_DEV_EXPECT: "hosted" })), "core's entry with 0009, expecting hosted: refused");
ok(/found sharePreview absent and the remotes table present/.test(await starts({ SHARE_DEV_ENTRY: coreEntry, SHARE_DEV_MIGRATIONS: cloud.SHARE_DEV_MIGRATIONS, SHARE_DEV_EXPECT: "core" })), "core's entry with 0009, expecting core: refused");
// (a list without 0005 is no share database: refused, whichever variant is expected)
ok(/migration 0005 wasn't applied/.test(await starts({ SHARE_DEV_ENTRY: coreEntry, SHARE_DEV_MIGRATIONS: JSON.stringify(migrations().slice(0, 4).map((m) => m.path)), SHARE_DEV_EXPECT: "core" })), "core's entry without 0005: refused");
// (a 200 at the route isn't sharePreview's answer: its body must be sharePreview's JSON)
{
  const dir0 = mkdtempSync(join(tmpdir(), "variant-entry-"));
  try {
    const fake = join(dir0, "entry.ts");
    writeFileSync(fake, 'export default { fetch() { return new Response("<html>a page</html>", { status: 200 }); } };\n');
    ok(/found sharePreview absent and the remotes table present/.test(await starts({ SHARE_DEV_ENTRY: fake, SHARE_DEV_MIGRATIONS: cloud.SHARE_DEV_MIGRATIONS, SHARE_DEV_EXPECT: "hosted" })), "an entry answering 200 with a page everywhere, expecting hosted: refused");
  } finally {
    rmSync(dir0, { recursive: true, force: true });
  }
}

// the verdict on finished runs
const line = `share dev server: the hosted variant; migrations applied: ${names.join(",")}`;
const v = (status, stdout, done = /^all \d+ passed$/) => verdict({ status, stdout }, done, names);
ok(v(0, `${line}\nall 3 passed\n`) === null, "a passing run");
ok(/exited 1/.test(v(1, `${line}\nall 3 passed\n`)), "a nonzero exit");
ok(/never started/.test(v(0, "all 3 passed\n")), "no dev server");
ok(/wasn't the hosted variant/.test(v(0, `share dev server: the core variant; migrations applied: ${names.slice(0, 5).join(",")}\nall 3 passed\n`)), "the core variant");
ok(/wasn't the hosted variant/.test(v(0, `share dev server: the hosted variant; migrations applied: ${names.slice(0, 9).join(",")}\nall 3 passed\n`)), "a migration missing");
ok(/wasn't the hosted variant/.test(v(0, `share dev server: the hosted variant; migrations applied: ${[...names.slice(1), names[0]].join(",")}\nall 3 passed\n`)), "the migrations out of order");
ok(/completion line is missing/.test(v(0, `${line}\n3 checks so far\n`)), "an early return");
ok(/ran no checks/.test(v(0, `${line}\nall 0 passed\n`)), "zero checks");

// runOnHosted end to end, on a one-check suite that starts the dev server: its own server, a missing entry, core's
const dir = mkdtempSync(join(tmpdir(), "cloud-variant-"));
try {
  const suite = join(dir, "test-tiny.mjs");
  writeFileSync(suite, `import { startDev } from ${JSON.stringify(pathToFileURL(serveDev).href)};\nconst d = await startDev({ sitePort: 18870, filesPort: 18871 });\nawait d.close();\nconsole.log("all 1 passed");\n`);
  const run = (opts) => spawnSync(process.execPath, ["--input-type=module", "-e", `import { runOnHosted } from ${JSON.stringify(pathToFileURL(join(here, "run-mit-suite.mjs")).href)}; runOnHosted(${JSON.stringify(suite)}, /^all \\d+ passed$/, ${JSON.stringify(opts)});`], { encoding: "utf8" });
  let r = run({});
  ok(r.status === 0 && r.stdout.includes("test-tiny.mjs passed on the hosted variant"), `runOnHosted on the hosted server: ${r.status} ${r.stdout.slice(-200)}`);
  r = run({ entry: join(here, "no-such-entry.ts") });
  ok(r.status === 1 && r.stdout.includes("FAIL test-tiny.mjs on the hosted variant"), "runOnHosted with a missing entry exits 1");
  r = run({ entry: join(here, "../../share/test-entry.ts"), list: migrations().slice(0, 5).map((m) => m.path) });
  ok(r.status === 1 && r.stdout.includes("FAIL test-tiny.mjs on the hosted variant"), "runOnHosted pointed at core's server exits 1");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
