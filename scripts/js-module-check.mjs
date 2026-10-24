// The publisher's checks of a js package's one module (plan-modular-packages
// r4 addendum A1.3, A1.4; plan-bash-shell r3 §1.3, §1.4), by parsing it with
// acorn (scripts/vendor/acorn-8.19.0, unchanged), never by searching its text:
//
//   - self-contained: no ImportDeclaration, no ImportExpression, no export …
//     from (ExportNamedDeclaration or ExportAllDeclaration with a source), and
//     no Identifier named importScripts anywhere (a property name included).
//     Text that only looks like one (in a string, a comment, a template
//     literal) is not code and isn't refused.  This is build hygiene, not the
//     boundary: computed access (self["import" + "Scripts"]) can't be seen
//     statically; the shell worker's own CSP is the boundary (bash plan §6).
//   - host_req: the module reaches the page only through hostCall("<literal
//     name>", …); each name maps to the SHELL_HOST_LEVEL that introduced it
//     (web/shell/host-levels.json), and host_req is the highest.  A
//     non-literal name, a name not in the table, or postMessage anywhere but
//     inside the hostCall helper is an error.
//
// Used only by scripts/optional-packages.mjs; in no core artifact.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const acorn = require("./vendor/acorn-8.19.0/acorn.js");

/** The module's AST (ES module, latest syntax), or a thrown Error naming the line. */
export function parseModule(text) {
  return acorn.parse(text, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: false });
}

// Every node of the tree, with its ancestors (an explicit stack: no recursion
// limit on deep trees).
function* nodes(ast) {
  const stack = [[ast, []]];
  while (stack.length) {
    const [node, up] = stack.pop();
    yield [node, up];
    const below = [...up, node];
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (let k = v.length - 1; k >= 0; k--) if (v[k] && typeof v[k].type === "string") stack.push([v[k], below]);
      } else if (v && typeof v.type === "string") stack.push([v, below]);
    }
  }
}
const at = (n) => `${n.loc.start.line}:${n.loc.start.column + 1}`;

/** What makes `text` not self-contained: a list of "line:col what" (empty if none). */
export function importFindings(text) {
  const found = [];
  for (const [n] of nodes(parseModule(text))) {
    if (n.type === "ImportDeclaration") found.push(`${at(n)} import declaration`);
    else if (n.type === "ImportExpression") found.push(`${at(n)} dynamic import()`);
    else if ((n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && n.source) found.push(`${at(n)} export … from`);
    else if (n.type === "Identifier" && n.name === "importScripts") found.push(`${at(n)} importScripts`);
  }
  return found;
}

// (inside the helper: a function declaration named hostCall, or a function
// assigned to a variable named hostCall)
const isHelper = (n) =>
  (n.type === "FunctionDeclaration" && n.id?.name === "hostCall") ||
  (n.type === "VariableDeclarator" && n.id?.type === "Identifier" && n.id.name === "hostCall" && /Function/.test(n.init?.type ?? ""));

/**
 * host_req of `text` against `table` ({name: level}): the highest level of the
 * literal names passed to hostCall.  Returns {host_req, names, errors}; any
 * error means the build fails.
 */
export function hostRequirement(text, table) {
  const names = new Set();
  const errors = [];
  for (const [n, up] of nodes(parseModule(text))) {
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "hostCall") {
      const a = n.arguments[0];
      if (!a || a.type !== "Literal" || typeof a.value !== "string") errors.push(`${at(n)} hostCall's name is not a string literal`);
      else if (!Object.hasOwn(table, a.value)) errors.push(`${at(n)} hostCall(${JSON.stringify(a.value)}) is not in the host level table`);
      else names.add(a.value);
    }
    const isPost = (n.type === "Identifier" && n.name === "postMessage") || (n.type === "Literal" && n.value === "postMessage" && up.at(-1)?.type === "MemberExpression");
    if (isPost && !up.some(isHelper)) errors.push(`${at(n)} postMessage outside the hostCall helper`);
  }
  let host_req = 0;
  for (const name of names) host_req = Math.max(host_req, table[name]);
  return { host_req, names: [...names].sort(), errors };
}
