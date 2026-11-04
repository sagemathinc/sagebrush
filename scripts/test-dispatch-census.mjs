// ci: checks.3 order=15
// The census of Miniflare#dispatchFetch: every call goes through web/miniflare-dispatch.mjs's
// dispatch(), which reads the answer's body at once (master 576f0bf6's S4d: undici's
// FinalizationRegistry cancels a body stream Miniflare shares, once the Response it dropped is
// collected).  A call anywhere else in the repository's tracked code fails here, named.
//
//   node scripts/test-dispatch-census.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = "web/miniflare-dispatch.mjs";
const SELF = "scripts/test-dispatch-census.mjs"; // (its fixtures below are calls, in strings)
// (a call: `.dispatchFetch(`, with any spacing; a mention in a comment or a string still counts, which errs on the
// side of naming it)
const CALL = /\.\s*dispatchFetch\s*\(/;

let failures = 0, count = 0;
const ok = (cond, what) => {
  count++;
  if (cond) console.log("ok " + what);
  else {
    failures++;
    console.log("FAIL " + what);
  }
};

/** The [path, line] of each call in `files` (path → text) outside the helper (and this census). */
export function calls(files) {
  const out = [];
  for (const [path, text] of files) {
    if (path === HELPER || path === SELF) continue;
    text.split("\n").forEach((l, i) => CALL.test(l) && out.push(`${path}:${i + 1}`));
  }
  return out;
}

// ---- the rule itself, on fixed texts
ok(calls([["web/x.mjs", "const r = await mf.dispatchFetch(url);"]]).join() === "web/x.mjs:1", "a direct call is found");
ok(calls([["web/x.mjs", "a\nreturn h.mf .dispatchFetch (u, init);"]]).join() === "web/x.mjs:2", "…with spacing, on its line");
ok(calls([["web/x.mjs", "const r = await dispatch(mf, url);"]]).length === 0, "a call through dispatch() isn't");
ok(calls([[HELPER, "const r = await m.dispatchFetch(url, init);"]]).length === 0, "the helper's own call isn't");

// ---- the repository: tracked code only (node_modules are never tracked)
const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.mjs", "*.js", "*.cjs", "*.ts", "*.mts", "*.tsx"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((p) => p && !p.endsWith(".d.ts"));
const found = calls(tracked.map((p) => [p, readFileSync(join(root, p), "utf8")]));
ok(found.length === 0, `every dispatchFetch call goes through ${HELPER}'s dispatch() (${tracked.length} files): ` + (found.join(", ") || "none other"));
ok(CALL.test(readFileSync(join(root, HELPER), "utf8")), `${HELPER} itself calls dispatchFetch`);

console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
