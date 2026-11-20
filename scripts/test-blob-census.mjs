// ci: checks.3 order=105
// The blob stores' static census (copy-on-write for workspace branches): only
// web/workspace/blobs.ts writes the blob stores or changes a blob reference. Sources are parsed with TypeScript's
// parser (the pinned typescript-api), so comments don't count. The code that holds the workspace's database
// (web/workspace/, web/history/, web/journal/; not a vendored reference build, export-ref-*) is held to rules 1 to 3;
// every other app source under web/ (but the sync server's, which has no IndexedDB) to rule 4, so no other way into
// that database goes unseen. Other databases have stores named "blobs" of their own (the notebooks' and the replay's
// images), which is why rules 1 to 3 are kept to the workspace's code. Outside blobs.ts:
//   1. the store names "blobs" and "versionBlobs" appear only as the argument of an objectStore(...) whose result is
//      at once read (get, getKey, getAll, getAllKeys, count), as a transaction's scope (inTx(...) or
//      .transaction(...), a string or an array of strings), in db.ts's schema, or in api.ts's RESET_STORES and
//      BYTE_STORES (a reset's pages: the one place blobs go without dropBlobRef, under its fence). Any other use, an
//      alias, a cursor, a clear, a store list a loop could reach, is flagged;
//   2. nothing writes a `blob` property: no object literal with a `blob` key, no assignment to or delete of `.blob`
//      (an Entry's or a Version's reference);
//   3. no pin storage key on a blob made: no "b:" + x, no `b:${x}`;
//   4. (outside the workspace's code) no "sagebrush-workspace", WS_DB or openWorkspaceDb, but the uses listed in
//      ELSEWHERE by their exact line, with why.
// And blobs.ts itself (rule 5): every store write in it (put, add, delete, clear, update) is in one of its helpers
// (HELPERS), and but for the total's own write to meta, inside inHelper(...), which the test build's guard reads.
// Two existing `blob` keys that aren't references are listed in UNRELATED by their exact line, with why; any other,
// or either changed, is flagged.
// Planted controls run the same rules over sources that break each one, and must be flagged.
//   node scripts/test-blob-census.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript-api";

const root = new URL("..", import.meta.url).pathname;
const OWNER = "web/workspace/blobs.ts";
const STORES = new Set(["blobs", "versionBlobs"]);
const READS = new Set(["get", "getKey", "getAll", "getAllKeys", "count"]);
const ALLOWED_DECLS = { "web/workspace/api.ts": new Set(["RESET_STORES", "BYTE_STORES"]) };
const WORKSPACE_CODE = ["web/workspace/", "web/history/", "web/journal/"];
const SERVER = new Set(["web/sync", "web/sync-protocol"]);
const ELSEWHERE = new Map([
  // (the notebooks' stores read the workspace's meta, never its other stores: the authority each owned write confirms)
  ["web/notebook/stores.js:const PRIMARY = \"sagebrush-workspace\";", true],
  // (the workspace's Web Lock's name, not its database)
  ["web/notebook/stores.js:const WORKSPACE_LOCK = \"sagebrush-workspace\";", true],
  // (an agent grant's scope string names the workspace, opening nothing)
  ["web/agents/page.ts:import { WS_DB } from \"../workspace/db\";", true],
  ["web/agents/page.ts:      scope: { workspace: `${WS_DB}/${ws.identity.workspace}`, page: location.origin + location.pathname },", true],
]);
const UNRELATED = new Map([
  // (a history checkpoint's own encoded bytes, in the notebooks' history database, not a workspace reference)
  ["web/workspace/checkpoint.ts", "  return { record, blob, sha256: await sha256Hex(blob), bytes: blob.length };"],
  // (the export's in-memory Blob sink's size bound)
  ["web/workspace/export/run.ts", "  blob: 256 * 2 ** 20,"],
]);
const TEST = /(^|\/)(test-[^/]*|[^/]*-cases\.js|[^/]*-check\.js|[^/]*guard[^/]*\.(js|mjs)|[^/]*-entry\.ts)$/;

// (the sources git tracks: a build's outputs, generated into web/ and ignored, are not sources)
function sources() {
  const tracked = execFileSync("git", ["ls-files", "-z", "web"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  return tracked.filter((r) => /\.(ts|mts|js|mjs)$/.test(r) && !/\.d\.ts$/.test(r) && !TEST.test(r) && !r.split("/").some((d) => d === "node_modules" || d === "dist" || /^export-ref-/.test(d)) && ![...SERVER].some((d) => r.startsWith(d + "/")));
}

/** The census's findings in one source: each a string naming the file, line and rule. */
const HELPERS = new Set(["haveBlob", "dropBlobRef", "setEntryBlob", "clearEntryBlob", "putVersionBlob", "dropVersionBlob", "addTotal"]);
const WRITES = new Set(["put", "add", "delete", "clear", "update"]);
/** Rule 5: blobs.ts's own store writes. */
function owner(file, text) {
  const found = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const at = (n) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const fnName = (n) => { for (let p = n.parent; p; p = p.parent) if ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) && p.name) return p.name.text; else if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.text; return null; };
  const inHelperCall = (n) => { for (let p = n.parent; p; p = p.parent) if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "inHelper") return true; return false; };
  // (a store's writes: the receiver is objectStore(...), or a name bound to one, or meta's)
  const storeNames = new Set();
  const collect = (n) => { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && /\.objectStore\(/.test(n.initializer.getText(sf))) storeNames.add(n.name.text); ts.forEachChild(n, collect); };
  collect(sf);
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && WRITES.has(n.expression.name.text)) {
      const recv = n.expression.expression, rt = recv.getText(sf);
      const isStore = /\.objectStore\(/.test(rt) || (ts.isIdentifier(recv) && storeNames.has(recv.text));
      if (isStore) {
        const f = fnName(n);
        if (!f || !HELPERS.has(f)) found.push(`${at(n)}: blobs.ts writes a store outside its helpers (in ${f ?? "the module"})`);
        else if (f !== "addTotal" && !inHelperCall(n)) found.push(`${at(n)}: blobs.ts writes a store outside inHelper(...) (in ${f})`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

export function census(file, text) {
  if (file === OWNER) return owner(file, text);
  const found = [];
  if (!WORKSPACE_CODE.some((d) => file.startsWith(d))) return elsewhere(file, text);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.m?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const at = (n) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const lineOf = (n) => text.split("\n")[sf.getLineAndCharacterOfPosition(n.getStart(sf)).line];
  const declName = (n) => { for (let p = n.parent; p; p = p.parent) if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text; return null; };
  const callee = (c) => (ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : ts.isIdentifier(c.expression) ? c.expression.text : "");
  const storeUseOk = (lit) => {
    // (db.ts's schema)
    if (file === "web/workspace/db.ts") return true;
    const allowed = ALLOWED_DECLS[file];
    if (allowed && allowed.has(declName(lit))) return true;
    let p = lit.parent;
    // (a scope: inTx(db, "blobs" | [..., "blobs"], ...) or db.transaction(...))
    const arr = ts.isArrayLiteralExpression(p) ? p : null;
    const call = arr ? arr.parent : p;
    if (ts.isCallExpression(call) && (callee(call) === "inTx" || callee(call) === "transaction") && call.arguments.includes(arr ?? lit)) return true;
    // (objectStore("blobs").get(...) and the other reads, at once)
    if (ts.isCallExpression(p) && callee(p) === "objectStore" && p.arguments[0] === lit) {
      const use = p.parent;
      return ts.isPropertyAccessExpression(use) && READS.has(use.name.text) && ts.isCallExpression(use.parent);
    }
    return false;
  };
  const visit = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && STORES.has(n.text) && !storeUseOk(n)) found.push(`${at(n)}: the store "${n.text}" used outside blobs.ts other than to read it or as a scope`);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isStringLiteral(n.left) && n.left.text === "b:") found.push(`${at(n)}: a blob pin's storage key ("b:" + ...) made outside blobs.ts`);
    if (ts.isTemplateExpression(n) && n.head.text === "b:") found.push(`${at(n)}: a blob pin's storage key (\`b:\${...}\`) made outside blobs.ts`);
    if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) {
      const key = n.name && ts.isComputedPropertyName(n.name) ? n.name.expression : n.name;
      const name = key && (ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && !(ts.isIdentifier(key) && n.name !== key) ? key.text : null;
      if (name === "blob" && ts.isObjectLiteralExpression(n.parent) && UNRELATED.get(file) !== lineOf(n)) found.push(`${at(n)}: an object written with a \`blob\` reference outside blobs.ts`);
    }
    // (.blob, and ["blob"] or [`blob`]: a member named so, whichever way it is written)
    const isBlobMember = (x) => (ts.isPropertyAccessExpression(x) && x.name.text === "blob") || (ts.isElementAccessExpression(x) && (ts.isStringLiteral(x.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(x.argumentExpression)) && x.argumentExpression.text === "blob");
    const ASSIGN = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.PlusEqualsToken]);
    if (ts.isBinaryExpression(n) && ASSIGN.has(n.operatorToken.kind) && isBlobMember(n.left)) found.push(`${at(n)}: a \`blob\` reference assigned outside blobs.ts`);
    if (ts.isDeleteExpression(n) && isBlobMember(n.expression)) found.push(`${at(n)}: a \`blob\` reference deleted outside blobs.ts`);
    // (Object.assign(x, { blob }), Reflect.set(x, "blob", ...), Object.defineProperty(x, "blob", ...): a "blob" string handed to a writer)
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["set", "defineProperty", "deleteProperty"].includes(n.expression.name.text) && ts.isIdentifier(n.expression.expression) && ["Reflect", "Object"].includes(n.expression.expression.text) && n.arguments.some((a) => (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && a.text === "blob")) found.push(`${at(n)}: a \`blob\` reference written by ${n.expression.expression.text}.${n.expression.name.text} outside blobs.ts`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Rule 4: a source outside the workspace's code naming its database. */
function elsewhere(file, text) {
  const found = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.m?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const lines = text.split("\n");
  const visit = (n) => {
    const hit = ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === "sagebrush-workspace") || (ts.isIdentifier(n) && (n.text === "WS_DB" || n.text === "openWorkspaceDb"));
    if (hit) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      if (!ELSEWHERE.has(`${file}:${lines[line]}`)) found.push(`${file}:${line + 1}: the workspace's database named outside the workspace's code`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

let failures = 0, checks = 0;
const ok = (c, what) => { checks++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) failures++; };

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  const files = sources();
  const all = files.flatMap((f) => census(f, readFileSync(join(root, f), "utf8")));
  ok(files.includes(OWNER) && files.includes("web/workspace/api.ts") && files.includes("web/workspace/sync-pins.ts") && files.length > 200, `the census reads every app source under web/ but the sync server's (${files.length} files)`);
  ok(all.length === 0, `no blob store written, no blob reference changed, no "b:" key made outside blobs.ts${all.length ? ":\n  " + all.join("\n  ") : ""}`);
  // (controls: each rule broken once, in a file that isn't blobs.ts)
  const planted = [
    ["a delete on blobs", 'tx.objectStore("blobs").delete(k);'],
    ["an alias of blobs", 'const st = tx.objectStore("blobs"); st.get(k);'],
    ["a cursor on versionBlobs", 'tx.objectStore("versionBlobs").openCursor();'],
    ["a clear", 'tx.objectStore("blobs").clear();'],
    ["a store list a loop could reach", 'for (const s of ["fileBytes", "blobs"]) tx.objectStore(s).clear();'],
    ["a template literal store name", "tx.objectStore(`versionBlobs`).put(x);"],
    ["an object with a blob reference", "st.put({ ...e, blob: sha });"],
    ["a shorthand blob reference", "const blob = sha; st.put({ path, blob });"],
    ["an assigned .blob", "e.blob = sha;"],
    ["a deleted .blob", "delete e.blob;"],
    ['an assigned ["blob"]', 'e["blob"] = sha;'],
    ['a deleted ["blob"]', 'delete e["blob"];'],
    ["an assigned [`blob`]", "e[`blob`] = sha;"],
    ['a computed key ["blob"]', 'st.put({ ...e, ["blob"]: sha });'],
    ["a ??= on .blob", "e.blob ??= sha;"],
    ['Reflect.set with "blob"', 'Reflect.set(e, "blob", sha);'],
    ['Object.defineProperty with "blob"', 'Object.defineProperty(e, "blob", { value: sha });'],
    ['a "b:" key', 'const skey = "b:" + sha;'],
    ['a "b:" template key', "const skey = `b:${sha}`;"],
    ["RESET_STORES's allowance used in another file", 'const RESET_STORES = ["blobs"];'],
    ["the workspace's database named elsewhere (rule 4)", 'const db = indexedDB.open("sagebrush-workspace");', "web/board/planted.ts"],
    ["openWorkspaceDb used elsewhere (rule 4)", "const db = await openWorkspaceDb();", "web/board/planted.ts"],
    ["an unrelated line's allowance used elsewhere", "  return { record, blob, sha256: await sha256Hex(blob), bytes: blob.length };"],
  ];
  for (const [what, src, at] of planted) ok(census(at ?? "web/workspace/planted.ts", src).length > 0, `control: ${what} is flagged`);
  // (rule 5's controls: blobs.ts writing a store outside its helpers, or outside inHelper)
  ok(census(OWNER, 'export function sneak(tx) { inHelper(() => tx.objectStore("blobs").delete(k)); }').length > 0, "control: blobs.ts writing a store outside its helpers is flagged");
  ok(census(OWNER, 'async function dropBlobRef(tx) { const st = tx.objectStore("blobs"); st.delete(k); }').length > 0, "control: blobs.ts writing a store outside inHelper is flagged");
  ok(census(OWNER, readFileSync(join(root, OWNER), "utf8")).length === 0, "blobs.ts itself: every store write in a helper, inside inHelper");
  // (and what is allowed stays allowed)
  const fine = [
    ["a read", 'tx.objectStore("blobs").getAllKeys();'],
    ["a scope", 'inTx(db, ["entries", "blobs"], "readonly", f); db.transaction("blobs");'],
    ["a variable named blob read", "const blob = await read(); use(blob, e.blob);"],
    ["the owner itself", null],
  ];
  for (const [what, src] of fine) ok((src === null ? census(OWNER, 'async function dropBlobRef(tx) { inHelper(() => tx.objectStore("blobs").delete(k)); e.blob = s; "b:" + s; }') : census("web/workspace/planted.ts", src)).length === 0, `allowed: ${what}`);
  console.log(failures ? `test-blob-census: ${failures} of ${checks} FAILED` : `ok: the blob stores' census, ${checks} checks`);
  process.exit(failures ? 1 : 0);
}
