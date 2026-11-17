// ci: web-sync.1 order=19 runner=bun
// The cloud overlay's session reader (sessionResult, under sessionOf) refuses a token that isn't the shape the site
// makes (32 random bytes, base64url, 43 characters) before any hash or D1 read; a well-formed one that isn't a session
// costs exactly one D1 read (design/sync-server.md §2).  The core reader's own check is web/sync/test-ingress.mjs's.
import { sessionOf, SESSION_TOKEN } from "./server.ts";

let fails = 0, checks = 0;
const ok = (c, what) => { checks++; if (!c) { fails++; console.log("FAIL:", what); } };
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
let prepares = 0;
const env = { SHARE_DB: { prepare() { prepares++; return { bind: () => ({ first: async () => null, run: async () => ({}) }) }; } } };
const req = (t) => new Request("https://sagebrush.test/", { headers: { cookie: "__Host-sb_session=" + t } });

ok(SESSION_TOKEN.test(token()) && !SESSION_TOKEN.test(token() + "=") && !SESSION_TOKEN.test(token().slice(1)) && !SESSION_TOKEN.test("x".repeat(42) + "+"), "a session token is exactly 43 base64url characters");
for (const bad of ["x", "x".repeat(42), "x".repeat(44), "x".repeat(42) + "=", "x".repeat(42) + "/", "x".repeat(42) + "."]) {
  const before = prepares;
  ok((await sessionOf(req(bad), env)) === null && prepares === before, `a malformed token (${bad.length} chars) is no session, with no D1 read`);
}
const before = prepares;
ok((await sessionOf(req(token()), env)) === null && prepares === before + 1, "a well-formed token that isn't a session: no session, exactly one D1 read");

console.log(fails ? `FAIL: ${fails} of ${checks} checks` : `ok: the cloud overlay's session shape, ${checks} checks`);
process.exit(fails ? 1 : 0);
