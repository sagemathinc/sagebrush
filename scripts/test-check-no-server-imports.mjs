// ci: inline (ci.yml)
// Tests for scripts/check-no-server-imports.mjs (PR #59, astra's CORR-PR59-2):
// real imports however they are written are found; imports inside comments
// and strings are not.  And the license direction: MIT code never depends on
// web/cloud/ (MS-RSL), while web/cloud/ may import MIT code.
//   bun scripts/test-check-no-server-imports.mjs
import { serverImports, cloudImports } from "./check-no-server-imports.mjs";

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
const cloudFound = (path, text) => cloudImports([{ path, text }]).length > 0;
function expectCloud(what, path, text, want) {
  if (cloudFound(path, text) !== want) {
    failures++;
    console.log(`FAIL ${what}: expected ${want ? "an edge into web/cloud/" : "none"}`);
  }
}
expectCloud("a static import", "web/a.ts", `import { x } from "./cloud/remote/server.ts";`, true);
expectCloud("from a server directory (MIT too)", "web/share/server.ts", `import { purgeRemotes } from "../cloud/remote/server.ts";`, true);
expectCloud("a dynamic import", "web/workspace/a.mjs", `await import("../cloud/sync/test-harness.mjs");`, true);
expectCloud("a type-only import", "web/sync/account.ts", `import type { Charge } from "../cloud/sync/charge.ts";`, true);
expectCloud("a re-export", "web/a.ts", `export * from "./cloud/lti/launch.ts";`, true);
expectCloud("a require", "scripts/a.js", `const s = require("../web/cloud/sync/floors.ts");`, true);
expectCloud("an HTML script src", "web/a.html", `<script src="./cloud/site/src/index.ts"></script>`, true);
expectCloud("a path that climbs back in", "web/workspace/a.ts", `import "../workspace/../cloud/remote/relay.ts";`, true);
expectCloud("a computed import's path literal", "web/workspace/a.mjs", `const dir = new URL("../cloud/sync/", import.meta.url); await import(dir + "web/cloud/sync/test-harness.mjs");`, true);
expectCloud("a path in a string", "scripts/a.mjs", `run("node", ["web/cloud/sync/test-sync.mjs"]);`, true);
expectCloud("a path in a template literal", "scripts/a.mjs", "const f = `${root}/web/cloud/lti/worker.ts`;", true);
expectCloud("a package.json file: dependency", "web/site/package.json", JSON.stringify({ dependencies: { remote: "file:../cloud/remote" } }), true);
expectCloud("a package.json workspace path", "package.json", JSON.stringify({ workspaces: ["web/cloud/site"] }), true);
expectCloud("an unparsable package.json is reported", "web/x/package.json", "{", true);
// not edges: each must pass
expectCloud("a path in a line comment", "web/workspace/a.mjs", `// cloud's harness: web/cloud/sync/test-harness.mjs\nexport const a = 1;`, false);
expectCloud("a path in a block comment", "web/a.ts", `/* see web/cloud/README.md */ export const a = 1;`, false);
expectCloud("a similar name", "web/a.ts", `import { x } from "./cloudflare/env.ts"; const s = "web/cloudy";`, false);
expectCloud("an npm package named cloud", "web/a.ts", `import { x } from "cloud";`, false);
expectCloud("a package.json with ordinary dependencies", "web/site/package.json", JSON.stringify({ devDependencies: { cf: "^1.0.0", typescript: "^7.0.2" } }), false);
// (the checker's own two files may name web/cloud/ as data, but an import from them is still an edge)
expectCloud("the checker naming web/cloud/ as data", "scripts/check-no-server-imports.mjs", `const CLOUD = "web/cloud/";`, false);
expectCloud("the checker importing web/cloud/", "scripts/check-no-server-imports.mjs", `import "../web/cloud/remote/server.ts";`, true);
expectCloud("the test importing web/cloud/", "scripts/test-check-no-server-imports.mjs", `await import("../web/cloud/sync/floors.ts");`, true);
expectCloud("any other script naming web/cloud/", "scripts/check-other.mjs", `const CLOUD = "web/cloud/";`, true);
if (cloudImports([{ path: "web/cloud/remote/server.ts", text: `import { x } from "../../share/server.ts"; import { y } from "./relay.ts";` }]).length) {
  failures++;
  console.log("FAIL web/cloud/ importing MIT code or itself is allowed");
}

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
