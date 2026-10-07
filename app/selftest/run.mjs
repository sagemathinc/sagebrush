// Run the desktop app's self-test: copy this folder's notebook and data to a
// scratch folder, start the app with SAGEBRUSH_APP_SELFTEST pointing at it,
// and print its report.  The page opens the notebook, runs it (Sage, a file
// in its folder, 3D), checks what Python wrote, saves, and reports
// (selftest() in web/index.html); the app then exits.
//
//   node app/selftest/run.mjs <the app's executable>
import { spawn } from "node:child_process";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) throw new Error("usage: node app/selftest/run.mjs <executable>");
const here = new URL(".", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "sagebrush-app-selftest-"));
for (const f of ["selftest.ipynb", "data.csv"]) copyFileSync(new URL(f, here), join(dir, f));
const p = spawn(exe, [], { env: { ...process.env, SAGEBRUSH_APP_SELFTEST: join(dir, "selftest.ipynb") }, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
p.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
p.stderr.on("data", (d) => process.stderr.write(d));
const timer = setTimeout(() => { console.log("FAIL the app did not report within 240 s"); p.kill(); process.exit(1); }, 240000);
p.on("exit", (code) => {
  clearTimeout(timer);
  const passed = code === 0 && out.includes("all passed");
  console.log(passed ? "self-test passed" : `self-test failed (exit code ${code})`);
  process.exit(passed ? 0 : 1);
});
