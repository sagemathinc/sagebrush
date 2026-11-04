// ci: checks.3 order=15
// The census of Miniflare#dispatchFetch: every call goes through web/miniflare-dispatch.mjs's
// dispatch(), which reads the answer's body at once (master 576f0bf6's S4d: undici's
// FinalizationRegistry cancels a body stream Miniflare shares, once the Response it dropped is
// collected).  The name anywhere else in the repository's tracked code fails here, named.  And
// dispatch() itself, on a fake Miniflare.
//
//   node scripts/test-dispatch-census.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { dispatch } from "../web/miniflare-dispatch.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = "web/miniflare-dispatch.mjs";
const SELF = "scripts/test-dispatch-census.mjs"; // (its fixtures below name it, in strings)
// (the identifier itself, however it is reached: a call, `const { dispatchFetch } = mf`, `mf["dispatchFetch"]`; a
// mention in a comment or a string counts too, which errs on the side of naming it)
const NAME = /\bdispatchFetch\b/;
// (the call sites known when the census was made: each must be scanned, and import the helper, so a scan that misses
// them (a wrong file pattern, a dropped extension) fails rather than passing on nothing)
const KNOWN = ["web/share/serve-dev.mjs", "web/share/test-share.mjs", "web/sync/test-sync.mjs", "web/test-engines.mjs", "web/test-pwa-update.mjs"];
const IMPORTS = /^import \{ dispatch \} from "(?:\.\.?\/)+miniflare-dispatch\.mjs";$/m;

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
    text.split("\n").forEach((l, i) => NAME.test(l) && out.push(`${path}:${i + 1}`));
  }
  return out;
}

// ---- the rule itself, on fixed texts
ok(calls([["web/x.mjs", "const r = await mf.dispatchFetch(url);"]]).join() === "web/x.mjs:1", "a direct call is found");
ok(calls([["web/x.mjs", "a\nreturn h.mf .dispatchFetch (u, init);"]]).join() === "web/x.mjs:2", "…with spacing, on its line");
ok(calls([["web/x.mjs", "const r = await dispatch(mf, url);"]]).length === 0, "a call through dispatch() isn't");
ok(calls([[HELPER, "const r = await m.dispatchFetch(url, init);"]]).length === 0, "the helper's own call isn't");
ok(calls([["web/x.mjs", "const { dispatchFetch } = mf;\nawait dispatchFetch(url);"]]).join() === "web/x.mjs:1,web/x.mjs:2", "a destructured name is found, and its call");
ok(calls([["web/x.mjs", 'const r = await mf["dispatchFetch"](url);']]).join() === "web/x.mjs:1", "a bracketed name is found");
ok(calls([["web/x.mjs", "// see Miniflare#dispatchFetch"]]).join() === "web/x.mjs:1", "a mention in a comment is found");
ok(calls([["web/x.mjs", "const myDispatchFetcher = 1; dispatchFetches(); dispatch_fetch();"]]).length === 0, "other identifiers that contain it aren't");

// ---- the repository: tracked code only (node_modules are never tracked)
const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.mjs", "*.js", "*.cjs", "*.ts", "*.mts", "*.tsx"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((p) => p && !p.endsWith(".d.ts"));
const texts = new Map(tracked.map((p) => [p, readFileSync(join(root, p), "utf8")]));
for (const k of KNOWN) ok(texts.has(k) && IMPORTS.test(texts.get(k)), `${k}: scanned, and it imports dispatch() from ${HELPER}`);
const found = calls(texts);
ok(found.length === 0, `dispatchFetch is named only in ${HELPER} (${tracked.length} files): ` + (found.join(", ") || "none other"));
ok(/\.dispatchFetch\(/.test(texts.get(HELPER) ?? ""), `${HELPER} itself calls dispatchFetch`);

// ---- dispatch() on a fake Miniflare (`m.dispatchFetch` answering what it is given)
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc");
const fake = (r) => ({ dispatchFetch: async (url, init) => ((fake.last = { url, init }), r) });
for (const status of [204, 205, 304]) {
  const r = new Response(null, { status });
  const got = await dispatch(fake(r), "http://x/a", { method: "GET" }).catch((e) => e);
  ok(got === r, `a ${status} (no body) is returned as it came: ` + (got === r ? "the same" : String(got)));
}
{
  const headers = new Headers([["content-type", "text/plain"], ["set-cookie", "a=1; Path=/"], ["set-cookie", "b=2; Path=/"]]);
  const given = new Response("the body", { status: 201, statusText: "Made", headers });
  const m = fake(given);
  const r = await dispatch(m, "http://x/b", { method: "POST" });
  ok(r !== given && given.bodyUsed, "a body is read at once, into a new Response");
  ok(m.dispatchFetch && fake.last.url === "http://x/b" && fake.last.init.method === "POST", "the url and init are passed on as given");
  gc();
  await new Promise((resolve) => setImmediate(resolve));
  gc();
  ok((await r.text()) === "the body", "a body is readable after a forced gc and a task boundary");
  ok(r.status === 201 && r.statusText === "Made" && r.headers.get("content-type") === "text/plain", "status, statusText and headers are kept");
  ok(JSON.stringify(r.headers.getSetCookie()) === JSON.stringify(["a=1; Path=/", "b=2; Path=/"]), "each set-cookie is kept, separately");
}

console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
