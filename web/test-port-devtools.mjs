// ci: checks.3 order=140
// devtoolsPort's failures say why (web/test-port.mjs; the Chrome-start reds of Nov 3, master c6ac36fb's web-artifacts
// and #579's checks.3): fake Chromes, no browser.  A timeout lists the profile (none, empty, populated); given the
// process, one that exits fails at once with its code and the tail of its stderr, one that can't be started fails at
// once in words, a chatty one's stderr is drained and cut to its last CHROME_STDERR_TAIL bytes, and one that says its
// port still gives it.  Each check against its own fake.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROME_STDERR_TAIL, PROFILE_LIST_MAX, devtoolsPort } from "./test-port.mjs";

const dir = mkdtempSync(join(tmpdir(), "sb-devtools-port-"));
let failed = 0, passed = 0;
const check = (ok, what, detail) => {
  if (ok) passed++;
  else { failed++; console.log(`FAIL ${what}: ${JSON.stringify(detail)}`); }
};
// (a fake Chrome: node running `source`, its profile as argv[2], stderr piped as the shared launchers pipe it)
const fake = (name, source) => {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(script, source);
  const profile = join(dir, `${name}-profile`);
  const child = spawn(process.execPath, [script, profile], { stdio: ["ignore", "ignore", "pipe"] });
  return { child, profile };
};
const failure = async (p) => {
  const t = Date.now();
  try {
    return { port: await p, ms: Date.now() - t };
  } catch (e) {
    return { message: String(/** @type {Error} */ (e).message), ms: Date.now() - t };
  }
};

try {
  // (1) no process, no profile: the timeout says there is none
  {
    const r = await failure(devtoolsPort(join(dir, "never"), 300));
    check(/within 0\.3 s/.test(r.message ?? "") && /no profile directory \(ENOENT\)/.test(r.message), "a timeout with no profile says so", r);
    check(!/stderr/.test(r.message ?? ""), "without { child }, no stderr is claimed", r);
  }
  // (2) an empty profile, and a populated one (named, at most PROFILE_LIST_MAX, sorted)
  {
    const empty = join(dir, "empty");
    mkdirSync(empty);
    const r = await failure(devtoolsPort(empty, 300));
    check(/the profile is empty/.test(r.message ?? ""), "a timeout with an empty profile says so", r);
    const full = join(dir, "full");
    mkdirSync(full);
    for (let i = 0; i < PROFILE_LIST_MAX + 3; i++) writeFileSync(join(full, `f${String(i).padStart(2, "0")}`), "");
    const s = await failure(devtoolsPort(full, 300));
    check(new RegExp(`${PROFILE_LIST_MAX + 3} profile entries: f00, f01, `).test(s.message ?? "") && /, \.\.\.\)/.test(s.message) && !/f14/.test(s.message),
      "a timeout with a populated profile names its first entries", s);
  }
  // (3) a Chrome that exits 1 at once, after a line on stderr: it fails at once, with the code and the line
  {
    const { child, profile } = fake("exits", `process.stderr.write("[fake] no usable sandbox\\n"); process.exit(1);`);
    const r = await failure(devtoolsPort(profile, 30_000, { child }));
    check(/Chrome exited \(1\) before saying its DevTools port/.test(r.message ?? "") && /its stderr ends: \[fake\] no usable sandbox/.test(r.message),
      "an exit fails with its code and its stderr", r);
    check(r.ms < 10_000, "an exit fails at once, not after the timeout", r.ms);
  }
  // (3b) its last words after its exit (a helper process it leaves holding stderr, as Chrome's zygote can): kept
  {
    const { child, profile } = fake("late", `import { spawn } from "node:child_process"; spawn(process.execPath, ["-e", "setTimeout(() => process.stderr.write('[fake helper] crashed late\\\\n'), 300)"], { stdio: ["ignore", "ignore", "inherit"] }); process.exit(3);`);
    const r = await failure(devtoolsPort(profile, 30_000, { child }));
    check(/Chrome exited \(3\)/.test(r.message ?? "") && /\[fake helper\] crashed late/.test(r.message), "stderr written after the exit is waited for", r);
  }
  // (4) a Chrome that sleeps: the timeout, with the profile it made and its stderr
  {
    const { child, profile } = fake("sleeps", `import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync(process.argv[2]); writeFileSync(process.argv[2] + "/Local State", "{}"); process.stderr.write("[fake] starting\\n"); setTimeout(() => {}, 60_000);`);
    const r = await failure(devtoolsPort(profile, 1000, { child }));
    check(/within 1 s/.test(r.message ?? "") && /1 profile entries: Local State/.test(r.message) && /its stderr ends: \[fake\] starting/.test(r.message),
      "a timeout lists the profile and keeps the stderr", r);
    child.kill("SIGKILL");
  }
  // (5) a chatty Chrome (200 KB of stderr) that exits 2: never blocked on its pipe, and only the tail is kept
  {
    const { child, profile } = fake("chatty", `for (let i = 0; i < 2000; i++) process.stderr.write("x".repeat(99) + "\\n"); process.stderr.write("[fake] last words", () => process.exit(2));`);
    const r = await failure(devtoolsPort(profile, 30_000, { child }));
    const tail = (r.message ?? "").split("its stderr ends: ")[1] ?? "";
    check(/Chrome exited \(2\)/.test(r.message ?? "") && tail.endsWith("[fake] last words") && Buffer.byteLength(tail) <= CHROME_STDERR_TAIL,
      "a chatty Chrome's stderr is cut to its tail", { head: (r.message ?? "").slice(0, 120), tail: Buffer.byteLength(tail) });
  }
  // (6) a Chrome that can't be started: it fails at once in words, and the spawn error is never thrown unhandled
  {
    const profile = join(dir, "missing-profile");
    const child = spawn(join(dir, "no-such-chrome"), [], { stdio: ["ignore", "ignore", "pipe"] });
    const r = await failure(devtoolsPort(profile, 30_000, { child }));
    check(/Chrome couldn't start \(ENOENT\)/.test(r.message ?? "") && r.ms < 10_000, "a Chrome that can't be started fails at once", r);
  }
  // (7) a Chrome that says its port: given back, and its stderr drained after
  {
    const { child, profile } = fake("says", `import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync(process.argv[2]); writeFileSync(process.argv[2] + "/DevToolsActivePort", "43210\\n/devtools/browser/x\\n"); process.stderr.write("[fake] up\\n"); setTimeout(() => {}, 60_000);`);
    const r = await failure(devtoolsPort(profile, 30_000, { child }));
    check(r.port === 43210, "a Chrome that says its port gives it", r);
    child.kill("SIGKILL");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (failed) {
  console.log(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`ok: devtoolsPort's failures, ${passed} checks`);
