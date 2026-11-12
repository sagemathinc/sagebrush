// ci: web-runner order=165 runner=bun
// The permission digest's canonical JSON, the page's copy (agent-canon.ts), against the agent's own fixtures
// (agent-canon-fixtures.json: sagebrush-agent 0.4.0's test/canon-fixtures.json, its sha named there): every case's
// verdict, its canonical text, and the digest of a card holding it. Lone surrogates are accepted and escaped, as the
// agent does; a non-finite number, 33 levels and over 16 KiB are refused. The same inputs through the vendored agent's
// own permissionDigest are compared in engine/py/test_remote_agent_page.py (the shared vector).
//   bun web/workspace/test-agent-canon.mjs
import { readFileSync } from "node:fs";
import { canon, permissionText, permissionDigest, CANON_MAX, CANON_DEPTH, DIGEST_DOMAIN } from "./agent-canon.ts";

let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };

const fx = JSON.parse(readFileSync(new URL("./agent-canon-fixtures.json", import.meta.url), "utf8"));
ok(fx.domain === DIGEST_DOMAIN && fx.max === CANON_MAX && fx.depth === CANON_DEPTH, "the fixtures' domain, budget and depth are the page's");
ok(fx.cases.length === 32, `all 32 of the agent's cases (${fx.cases.length})`);

for (const c of fx.cases) {
  const text = c.input !== null ? c.input : JSON.stringify(c.string.map(([ch, n]) => ch.repeat(n)).join(""));
  const value = JSON.parse(text);
  const r = canon(value);
  ok(r.ok === c.ok, `${c.class}: ${c.name}: ${c.ok ? "accepted" : "refused"}${r.ok ? "" : ` (${r.reason})`}`);
  if (!c.ok || !r.ok) continue;
  const want = c.canon ?? JSON.stringify(value);
  ok(r.text === want, `${c.class}: ${c.name}: its canonical text`);
  const d = await permissionDigest({ child: fx.ids.child, conversation: fx.ids.conversation, request: fx.ids.request, tool: fx.ids.tool, input: value });
  ok(d === c.digest, `${c.class}: ${c.name}: the digest of a card holding it`);
}

// (r3a, r3b: lone surrogates accepted and escaped as the agent does, a high one at the end of a string included)
for (const [name, s] of [["a lone high", "x\ud800y"], ["a lone low", "\udfff"], ["a high at the end", "ab\udbff"]]) {
  const r = canon({ q: s });
  ok(r.ok && r.text === JSON.stringify({ q: s }) && /\\ud[89ab]|\\udf/.test(r.text), `${name} surrogate: accepted, escaped as lower-case \\uXXXX (${r.ok ? r.text : r.reason})`);
}
// (the refusals that stay)
ok(!canon({ a: Infinity }).ok && !canon({ a: NaN }).ok, "a non-finite number is refused");
let deep = 0;
for (let i = 0; i < 33; i++) deep = [deep];
ok(!canon(deep).ok && canon(deep[0]).ok, "33 levels refused, 32 accepted");
ok(!canon({ a: "x".repeat(CANON_MAX) }).ok, "over 16 KiB refused");
ok(permissionText({ child: 1, conversation: "c", request: "r", tool: "t", input: {} }) === null, "a card whose ids aren't strings has no digest (the page denies it)");
ok(await permissionDigest({ child: "c", conversation: "c", request: "r", tool: "t", input: { a: Infinity } }) === null, "nor does one whose input canon refuses");

console.log(failures ? `test-agent-canon: ${failures} failed` : "test-agent-canon: all passed");
process.exit(failures ? 1 : 0);
