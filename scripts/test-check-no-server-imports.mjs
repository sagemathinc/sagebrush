// Tests for scripts/check-no-server-imports.mjs (PR #59, astra's CORR-PR59-2):
// real imports however they are written are found; imports inside comments
// and strings are not.
//   bun scripts/test-check-no-server-imports.mjs
import { serverImports } from "./check-no-server-imports.mjs";

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

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
