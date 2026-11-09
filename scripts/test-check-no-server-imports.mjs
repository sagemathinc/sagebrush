// ci: inline (ci.yml)
// Tests for scripts/check-no-server-imports.mjs (PR #59, astra's CORR-PR59-2):
// real imports however they are written are found; imports inside comments
// and strings are not.  And the license direction: MIT code never depends on
// web/cloud/ (MS-RSL), while web/cloud/ may import MIT code.
//   bun scripts/test-check-no-server-imports.mjs
import { serverImports, cloudImports, cloudInputs } from "./check-no-server-imports.mjs";

let failures = 0;
const found = (path, text) => serverImports([{ path, text }]).length > 0;
function expect(what, path, text, want) {
  const got = found(path, text);
  if (got !== want) {
    failures++;
    console.log(`FAIL ${what}: expected ${want ? "a server import" : "none"}`);
  }
}

// real imports, each must be found
expect("a static import", "web/a.ts", `import { x } from "./sync/doc.ts";`, true);
expect("a commented dynamic import (astra's case)", "web/a.ts", `await import(/* comment */ '../web/sync/doc.ts');`, true);
expect("a dynamic import with a line comment", "web/a.ts", `await import( // why\n "./sync/doc.ts");`, true);
expect("a re-export", "web/a.ts", `export * from "./share/server.ts";`, true);
expect("a side-effect import", "web/x/a.mjs", `import "../sync/server.ts";`, true);
expect("a require", "web/a.js", `const s = require("./share/files.ts");`, true);
expect("a type-only import", "web/a.ts", `import type { Env } from "./sync/env.ts";`, true);
expect("a type-only re-export", "web/a.ts", `export type { Env } from "./sync/env.ts";`, true);
expect("a default type import", "web/a.ts", `import type Env from "./sync/env.ts";`, true);
expect("an exported type alias is not an import", "web/a.ts", `export type Kind = "a" | "b"; import type { X } from "./workspace/paths.ts";`, false);
expect("a file with a #! line", "scripts/a.mjs", `#!/usr/bin/env node\nimport "../web/sync/doc.ts";`, true);
expect("from a deeper directory", "web/workspace/a.ts", `import { x } from "../sync/account.ts";`, true);
expect("lti", "web/a.ts", `import { x } from "./lti/launch.ts";`, true);
expect("an HTML module script", "web/a.html", `<script type="module">import { a } from "./share/server.ts";</script>`, true);
expect("an HTML script src", "web/a.html", `<script src="./site/src/index.ts"></script>`, true);
expect("an import via a path that climbs back in", "web/workspace/a.ts", `import "../workspace/../sync/doc.ts";`, true);
expect("a web-root import", "web/workspace/a.ts", `import "/sync/doc.ts";`, true);

// not imports, or not server code: each must pass
expect("an import in a line comment", "web/a.ts", `// import("./sync/doc.ts")\nexport const a = 1;`, false);
expect("an import in a block comment", "web/a.ts", `/* import { x } from "./sync/doc.ts"; */ export const a = 1;`, false);
expect("an import in a string", "web/a.ts", `const s = "import('./sync/doc.ts')"; export { s };`, false);
expect("an import in a template literal", "web/a.ts", "const s = `import('./sync/doc.ts')`; export { s };", false);
expect("an import in an HTML comment", "web/a.html", `<!-- <script src="./sync/doc.ts"></script> -->`, false);
expect("the open protocol", "web/workspace/a.ts", `import { checkOp } from "../sync-protocol/protocol.ts";`, false);
expect("the share client", "web/index.ts", `import { uploadCollection } from "./share-client/upload.ts";`, false);
expect("a similar name", "web/a.ts", `import { x } from "./syncdb/doc.ts";`, false);
expect("a package import", "web/a.ts", `import { x } from "sync";`, false);
// (files inside the server directories are allowed to import each other)
if (serverImports([{ path: "web/sync/server.ts", text: `import { x } from "./doc.ts";` }]).length) {
  failures++;
  console.log("FAIL a server file importing a server file is not core's import");
}
// (an unparsable file is reported, never skipped)
if (!serverImports([{ path: "web/a.ts", text: "import { from" }]).length) {
  failures++;
  console.log("FAIL an unparsable file is reported");
}

// (web/cloud/ is server code: it may import the server directories and MIT code)
if (serverImports([{ path: "web/cloud/remote/server.ts", text: `import { x } from "../../share/server.ts";` }]).length) {
  failures++;
  console.log("FAIL web/cloud/ importing a server directory is not core's import");
}

// the license direction: each edge from MIT code into web/cloud/ must be found
const cloudFound = (path, text, extra = []) => cloudImports([...extra, { path, text }]).length > 0;
function expectCloud(what, path, text, want, extra = []) {
  if (cloudFound(path, text, extra) !== want) {
    failures++;
    console.log(`FAIL ${what}: expected ${want ? "an edge into web/cloud/" : "none"}`);
  }
}
// (imports, resolved)
expectCloud("a static import", "web/a.ts", `import { x } from "./cloud/remote/server.ts";`, true);
expectCloud("from a server directory (MIT too)", "web/share/server.ts", `import { purgeRemotes } from "../cloud/remote/server.ts";`, true);
expectCloud("a dynamic import", "web/workspace/a.mjs", `await import("../cloud/sync/test-harness.mjs");`, true);
expectCloud("a type-only import", "web/sync/account.ts", `import type { Charge } from "../cloud/sync/charge.ts";`, true);
expectCloud("a re-export", "web/a.ts", `export * from "./cloud/lti/launch.ts";`, true);
expectCloud("a require", "scripts/a.js", `const s = require("../web/cloud/sync/floors.ts");`, true);
expectCloud("an HTML script src", "web/a.html", `<script src="./cloud/site/src/index.ts"></script>`, true);
expectCloud("a path that climbs back in", "web/workspace/a.ts", `import "../workspace/../cloud/remote/relay.ts";`, true);
expectCloud("an absolute (web-root) import", "web/a.ts", `import "/cloud/remote/server.ts";`, true);
// (computed and non-import loads: the segment rule, with no full web/cloud spelling in the sample)
expectCloud("a relative URL file load", "web/workspace/a.mjs", `readFileSync(new URL("../cloud/sync/secret.json", import.meta.url));`, true);
expectCloud("a computed import from a relative directory", "web/workspace/a.mjs", `const d = new URL("../cloud/sync/", import.meta.url); await import(d + name);`, true);
expectCloud("a computed join of a bare segment", "web/workspace/a.mjs", `await import(["..", "cloud", "sync", f].join("/"));`, true);
expectCloud("a template with the segment", "scripts/a.mjs", "const f = `${root}/web/cloud/lti/worker.ts`;", true);
expectCloud("the bare directory in a string", "scripts/a.mjs", `const d = join(root, "web/cloud");`, true);
expectCloud("a path in a string", "scripts/a.mjs", `run("node", ["web/cloud/sync/test-sync.mjs"]);`, true);
expectCloud("an inline HTML module's computed load", "web/a.html", `<script type="module">const d = "./cloud/"; await import(d + "x.js");</script>`, true);
expectCloud("an HTML attribute", "web/a.html", `<link rel="stylesheet" href="./cloud/site/x.css">`, true);
expectCloud("an unquoted HTML attribute", "web/a.html", `<a href=../cloud>x</a>`, true);
expectCloud("HTML prose is not a path", "web/a.html", `<p>Runs in the cloud, or on "your" computer/cloud desk.</p>`, false);
expectCloud("a bare segment literal (an npm package named cloud: fail-closed)", "web/a.ts", `import { x } from "cloud";`, true);
// (packages and workspaces)
const cloudPkg = [{ path: "web/cloud/sync/package.json", text: JSON.stringify({ name: "@sagebrush/cloud-sync", private: true }) }];
for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  expectCloud(`a ${field} file: path`, "web/site/package.json", JSON.stringify({ [field]: { r: "file:../c" + "loud/remote" } }), true);
  expectCloud(`a ${field} by the cloud package's name (workspace:*)`, "web/site/package.json", JSON.stringify({ [field]: { "@sagebrush/cloud-sync": "workspace:*" } }), true, cloudPkg);
  expectCloud(`a ${field} by the cloud package's name (a version)`, "web/site/package.json", JSON.stringify({ [field]: { "@sagebrush/cloud-sync": "^1.0.0" } }), true, cloudPkg);
}
expectCloud("a bundleDependencies name", "web/site/package.json", JSON.stringify({ bundleDependencies: ["@sagebrush/cloud-sync"] }), true, cloudPkg);
expectCloud("a bare relative dependency path", "web/site/package.json", JSON.stringify({ dependencies: { r: "../c" + "loud/remote" } }), true);
expectCloud("a package.json imports alias", "web/site/package.json", JSON.stringify({ imports: { "#c": "../c" + "loud/sync/index.mjs" } }), true);
expectCloud("a package.json workspace path", "package.json", JSON.stringify({ workspaces: ["web/c" + "loud/site"] }), true);
expectCloud("a workspace glob matching a cloud package", "package.json", JSON.stringify({ workspaces: ["web/*/*"] }), true, cloudPkg);
expectCloud("a pnpm workspace glob matching a cloud package", "pnpm-workspace.yaml", "packages:\n  - 'web/**'\n", true, cloudPkg);
expectCloud("a bare import of the cloud package", "web/site/src/a.ts", `import { x } from "@sagebrush/cloud-sync";`, true, cloudPkg);
expectCloud("a subpath import of the cloud package", "web/site/src/a.ts", `import { x } from "@sagebrush/cloud-sync/floors";`, true, cloudPkg);
expectCloud("an unquoted pnpm workspace entry ending a line", "pnpm-workspace.yaml", "packages:\n  - web/c" + "loud\n  - packages/*\n", true);
expectCloud("a template line starting with the segment", "scripts/a.mjs", "const s = `a\n" + "c" + "loud/x`;", true);
expectCloud("an MIT package depended on by name", "packages/x/package.json", JSON.stringify({ dependencies: { "sagebrush-site": "workspace:*" } }), false, [{ path: "web/site/package.json", text: JSON.stringify({ name: "sagebrush-site", private: true }) }, ...cloudPkg]);
{
  const got = cloudImports([{ path: "web/a.ts", text: `import { from "../c` + `loud/x.ts";` }]);
  if (!got.some((b) => b.includes("unparsable")) || !got.some((b) => b.includes('a "cloud" path segment'))) {
    failures++;
    console.log(`FAIL an unparsable file's raw text is still segment-checked: ${JSON.stringify(got)}`);
  }
}
expectCloud("tsconfig paths into it", "tsconfig.web.json", JSON.stringify({ compilerOptions: { paths: { "@c/*": ["web/c" + "loud/*"] } } }), true);
expectCloud("an unparsable package.json is reported", "web/x/package.json", "{", true);
expectCloud("an unparsable cloud package.json is reported", "web/a.ts", "export const a = 1;", true, [{ path: "web/cloud/x/package.json", text: "{" }]);
// not edges: each must pass
expectCloud("a path in a line comment", "web/workspace/a.mjs", `// cloud's harness: web/c${""}loud/sync/test-harness.mjs\nexport const a = 1;`, false);
expectCloud("a path in a block comment", "web/a.ts", `/* see web/c${""}loud/README.md */ export const a = 1;`, false);
expectCloud("an HTML comment", "web/a.html", `<!-- <script src="./cloud/x.js"></script> --><p>x</p>`, false);
expectCloud("similar names", "web/a.ts", `import { x } from "./cloudflare/env.ts"; const s = "web/cloudy"; const c = cloud.x;`, false);
expectCloud("a web-root import of a similar name", "web/a.ts", `import "/cloudflare/x.ts";`, false);
expectCloud("a package.json with ordinary dependencies", "web/site/package.json", JSON.stringify({ devDependencies: { cf: "^1.0.0", "@cloudflare/vite-plugin": "beta" } }), false);
expectCloud("a similar package name", "web/site/package.json", JSON.stringify({ dependencies: { "@sagebrush/cloud-syncer": "^1" } }), false, cloudPkg);
expectCloud("a nearby imports alias", "web/site/package.json", JSON.stringify({ imports: { "#c": "./src/cloudy.mjs" } }), false);
expectCloud("a workspace glob that doesn't reach it", "package.json", JSON.stringify({ workspaces: ["web/site", "packages/*"] }), false, cloudPkg);
if (cloudImports([{ path: "web/cloud/remote/server.ts", text: `import { x } from "../../share/server.ts"; import { y } from "./relay.ts"; const d = "../cloud/";` }]).length) {
  failures++;
  console.log("FAIL web/cloud/ importing MIT code or itself is allowed");
}
// (the checker's own two files may name web/cloud/ as data, but an import from them is still an edge)
expectCloud("the checker naming web/cloud/ as data", "scripts/check-no-server-imports.mjs", `const CLOUD = "web/c${""}loud/";`, false);
expectCloud("the checker importing web/cloud/", "scripts/check-no-server-imports.mjs", `import "../web/cloud/remote/server.ts";`, true);
expectCloud("the checker importing via the web root", "scripts/check-no-server-imports.mjs", `import "/cloud/remote/server.ts";`, true);
expectCloud("the checker importing a similar web-root name", "scripts/check-no-server-imports.mjs", `import "/cloudflare/x.ts";`, false);
expectCloud("the test importing web/cloud/", "scripts/test-check-no-server-imports.mjs", `await import("../web/cloud/sync/floors.ts");`, true);
expectCloud("any other script naming web/cloud/", "scripts/check-other.mjs", `const CLOUD = "web/c${""}loud/";`, true);
// (the word as data: only the listed exact texts, only in their file)
expectCloud("the SERVER mode name, listed", "web/workspace/test-doc-sync.mjs", `const CLOUD = process.env.SERVER === "cloud";`, false);
expectCloud("a path in the same file", "web/workspace/test-doc-sync.mjs", `const CLOUD = process.env.SERVER === "cloud"; await import("../c" + "loud/sync/x.mjs");`, true);
expectCloud("the listed text in another file", "web/workspace/other.mjs", `const CLOUD = process.env.SERVER === "cloud";`, true);

// the bundle inputs (web/build.ts, scripts/build-cli.mjs, scripts/js-bundle.mjs fail their build on any)
{
  const root = "/repo";
  const got = cloudInputs(["web/cloud/remote/server.ts", "/repo/web/cloud/sync/floors.ts", "../cloud/x.ts", "web/cloudflare/x.ts", "src/cli.ts", "/elsewhere/web/cloud/x.ts"], "/repo/web", root);
  // (from cwd /repo/web: web/cloud/... is /repo/web/web/cloud, ../cloud is /repo/cloud, so neither is web/cloud/)
  const want = ["/repo/web/cloud/sync/floors.ts"];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.log(`FAIL cloudInputs: ${JSON.stringify(got)}`);
  }
  if (cloudInputs(["cloud/remote/server.ts"], "/repo/web", root).length !== 1 || cloudInputs(["web/cloud/x.ts"], "/repo", root).length !== 1) {
    failures++;
    console.log("FAIL cloudInputs resolves against its cwd");
  }
}

// main, the step CI runs: a temporary repository, its verdict and exit code (grader's C16-C18; daybreak3's E2)
{
  const { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync, execFileSync } = await import("node:child_process");
  const script = new URL("./check-no-server-imports.mjs", import.meta.url).pathname;
  const repo = mkdtempSync(join(tmpdir(), "cloud-fence-"));
  const put = (p, t) => { mkdirSync(join(repo, p, ".."), { recursive: true }); writeFileSync(join(repo, p), t); };
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, stdio: "pipe" });
  const runIt = () => spawnSync(process.execPath, [script, "--root", repo], { encoding: "utf8" });
  try {
    git("init", "-q");
    put("web/ok.ts", `import { a } from "./workspace/a.ts";\n`);
    put("web/cloud/remote/server.ts", `import { b } from "../../share/b.ts";\n`);
    symlinkSync("server.ts", join(repo, "web/cloud/remote/index.ts")); // (a link inside web/cloud/ is its own business)
    git("add", "-A");
    let r = runIt();
    if (r.status !== 0) { failures++; console.log(`FAIL main on a clean repository: exit ${r.status} ${r.stderr}`); }
    put("web/edge.ts", `import { s } from "./cloud/remote/server.ts";\n`);
    put("web/page.html", `<script src="./cloud/remote/server.ts"></script>\n`);
    put("web/site/package.json", JSON.stringify({ dependencies: { r: "file:../c" + "loud/remote" } }));
    put("web/big.mjs", "export const pad = " + JSON.stringify("x".repeat(5 << 20)) + `;\nawait import("./c` + `loud/remote/server.ts");\n`);
    git("add", "-A");
    r = runIt();
    for (const f of ["web/edge.ts", "web/page.html", "web/site/package.json", "web/big.mjs"]) if (r.status !== 1 || !r.stderr.includes(f)) { failures++; console.log(`FAIL main must exit 1 naming ${f}: exit ${r.status}`); }
    rmSync(join(repo, "web/edge.ts")); rmSync(join(repo, "web/page.html")); rmSync(join(repo, "web/site/package.json")); rmSync(join(repo, "web/big.mjs"));
    git("add", "-A");
    // (a tracked link outside web/cloud/ into it: an alias no text names)
    symlinkSync("cloud/remote", join(repo, "web/alias"));
    git("add", "-A");
    r = runIt();
    if (r.status !== 1 || !r.stderr.includes("web/alias: a link into")) { failures++; console.log(`FAIL main must exit 1 on a link into web/cloud/: exit ${r.status}`); }
    rmSync(join(repo, "web/alias"));
    symlinkSync("workspace", join(repo, "web/alias2"));
    git("add", "-A");
    r = runIt();
    if (r.status !== 0) { failures++; console.log(`FAIL main on a link elsewhere: exit ${r.status} ${r.stderr}`); }
    put("web/locked.ts", "export const a = 1;\n");
    git("add", "-A");
    chmodSync(join(repo, "web/locked.ts"), 0);
    r = runIt();
    if (process.getuid?.() !== 0 && (r.status !== 1 || !r.stderr.includes("web/locked.ts: unreadable"))) { failures++; console.log(`FAIL main must exit 1 on an unreadable tracked file: exit ${r.status}`); }
    chmodSync(join(repo, "web/locked.ts"), 0o644);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
