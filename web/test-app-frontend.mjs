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

// The Terminal's shell worker in the app: the app serves it with the site's own policy (web/csp-policy.mts
// shellWorkerPolicy: no network), from lib.rs's SHELL_WORKER_CSP, on its exact path
const policyOf = (mts) => { const m = /export function shellWorkerPolicy\(\): string \{\s*return \[([^\]]*)\]\.join\("; "\);/.exec(mts); return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join("; ") : null; };
const appServes = (rs, policy) => !!policy && /const SHELL_WORKER_CSP: &str = "([^"]*)";/.exec(rs)?.[1] === policy &&
  rs.includes(`if request.url().split(['?', '#']).next() == Some("/shell/worker-boot.js") {\n                        response.add_header("Content-Security-Policy", SHELL_WORKER_CSP);`);
const libRs = readFileSync(join(here, "..", "app", "src-tauri", "src", "lib.rs"), "utf8");
const policy = policyOf(readFileSync(join(here, "csp-policy.mts"), "utf8"));
ok(!!policy && /connect-src 'none'/.test(policy) && appServes(libRs, policy), "the app serves shell/worker-boot.js with the site's shell worker policy (lib.rs = csp-policy.mts)");
ok(!appServes(libRs.replace("connect-src 'none'; ", ""), policy) && !appServes(libRs.replace(`Some("/shell/worker-boot.js")`, `Some("/shell/worker.js")`), policy),
  "a lib.rs policy other than the site's, or on another path: refused");

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

  // the Terminal (William, Oct 30: in the desktop and Android apps): the page's module, its worker and the bash set,
  // each refused when the copy leaves it out (#358 shipped the menu item without them)
  ok(/checked, [1-9]\d* by a relative path; the Terminal's set with [1-9]\d* packages?\)/.test(check().out), "the Terminal's module, worker and set are in app/dist and checked");
  const page = join(copy, "index.html");
  const html = readFileSync(page, "utf8");
  ok(html.includes(`"./shell/terminal.js"`), "the page imports ./shell/terminal.js (the check's case)");
  const moveAway = (f) => { renameSync(join(copy, f), join(dir, "moved")); return () => renameSync(join(dir, "moved"), join(copy, f)); };
  let back = moveAway("shell/terminal.js");
  r = check();
  ok(r.status === 1 && r.out.includes("./shell/terminal.js: the page names it, but app/dist has no shell/terminal.js"), "shell/terminal.js left out of the copy: refused");
  back();
  back = moveAway("shell/worker-boot.js");
  r = check();
  ok(r.status === 1 && r.out.includes("shell/worker-boot.js: missing from app/dist"), "shell/worker-boot.js left out: refused");
  back();
  const S = JSON.parse(readFileSync(join(copy, "shell", "preview-set.json"), "utf8")).S;
  back = moveAway(`pkgset/${S}.json`);
  r = check();
  ok(r.status === 1 && r.out.includes(`pkgset/${S}.json: missing from app/dist`), "the set's index left out: refused");
  back();
  const pkg = readdirSync(join(copy, "pkg"))[0];
  back = moveAway(`pkg/${pkg}`);
  r = check();
  ok(r.status === 1 && r.out.includes(`pkg/${pkg} (`) && r.out.includes("missing from app/dist"), "the set's package left out: refused");
  back();
  const pbytes = readFileSync(join(copy, "pkg", pkg));
  writeFileSync(join(copy, "pkg", pkg), Buffer.concat([pbytes.subarray(0, -1), Buffer.from(" ")]));
  r = check();
  ok(r.status === 1 && r.out.includes(`pkg/${pkg} (`) && r.out.includes("not the bytes its set pins"), "the set's package with other bytes: refused");
  writeFileSync(join(copy, "pkg", pkg), pbytes);
  writeFileSync(page, html.replace("</body>", `<script>const later = () => import("./more/feature.js");</script></body>`));
  r = check();
  ok(r.status === 1 && r.out.includes("./more/feature.js: the page names it, but app/dist has no more/feature.js"), "a page import of a module the app doesn't ship: refused");
  writeFileSync(page, html);

  ok(check().status === 0, "the copy, each change undone, passes again");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
