// ci: web-sync.1 order=17 runner=bun
// Whether a database's budget_claims (migration 0016) is counted (web/share/server.ts and web/cloud/share/server.ts,
// budgetClaims): asked until it says yes, never again after, and only ever turned to yes.  Two first probes that
// overlap the migration, the older one's "no" answering after the newer one's "yes", leave it yes; counting then reads
// the table whatever BUDGET_CLAIMS says, and only claimsWritable needs the binding.
//   bun web/cloud/share/test-budget-claims.mjs
const results = [];
const check = (ok, what) => { results.push([!!ok, what]); if (!ok) console.log("FAIL", what); };

for (const [name, path] of [["core", "../../share/server.ts"], ["cloud", "./server.ts"]]) {
  const { budgetClaims, claimsWritable, sharingUsed } = await import(path);
  // (a database whose answers the test releases in its own order)
  // (the first two probes wait for the test; any later one is answered at once, and counted, so a mutant fails promptly)
  const asked = [];
  let later = 0;
  const db = { prepare: () => ({ first: () => (asked.length < 2 ? new Promise((resolve) => asked.push(resolve)) : (later++, Promise.resolve({ x: 1 }))) }) };
  const env = { SHARE_DB: db };
  const before = budgetClaims(env); // (asked before the migration ...)
  const after = budgetClaims(env); // (... and after it)
  asked[1]({ x: 1 });
  check((await after) === true, `${name}: the newer probe finds the table`);
  asked[0](null);
  check((await before) === true, `${name}: the older probe's late "no" leaves it yes`);
  check((await budgetClaims(env)) === true && later === 0, `${name}: yes once, never asked again (${later} more probes)`);
  check((await sharingUsed(env)).includes("budget_claims"), `${name}: every check of the budget then counts the claims`);
  check((await claimsWritable(env)) === false && (await claimsWritable({ ...env, BUDGET_CLAIMS: "on" })) === true && (await claimsWritable({ ...env, BUDGET_CLAIMS: "yes" })) === false,
    `${name}: writing needs BUDGET_CLAIMS exactly "on"; counting never does`);
}
// (a fresh module: a database without the table is asked each time, and never counted)
{
  const { budgetClaims, sharingUsed } = await import("../../share/server.ts?fresh");
  let n = 0;
  const env = { SHARE_DB: { prepare: () => ({ first: async () => (n++, null) }) } };
  check((await budgetClaims(env)) === false && (await budgetClaims(env)) === false && n === 2, "no table: asked each time (no stale no), never yes");
  check(!(await sharingUsed(env)).includes("budget_claims"), "no table: no check of the budget reads it");
}

// (structural: every statement that counts the budget interpolates an expression captured once before it, never a probe
// of its own: in one statement, two probes could answer either side of the migration (one in SET, the other in WHERE))
{
  const { readFileSync } = await import("node:fs");
  const here = new URL(".", import.meta.url).pathname;
  const files = { "share (core)": "../../share/server.ts", "share (cloud)": "./server.ts", "sync's account": "../../sync/account.ts", "the mirror's account": "../mirror/account.ts" };
  for (const [name, rel] of Object.entries(files)) {
    const src = readFileSync(here + rel, "utf8");
    check(!/\$\{\s*await\s+(?:used|sharingUsed|budgetClaims)\b/.test(src), `${name}: no budget expression probed inside a statement's template`);
  }
  const sync = readFileSync(here + "../../sync/account.ts", "utf8");
  const raise = sync.match(/UPDATE sync_accounts SET claim_bytes = claim_bytes \+ MIN\(\?3, \?6 - claim_bytes - \(\$\{(\w+)\}\)\) WHERE [^`]*MIN\(\?3, \?6 - claim_bytes - \(\$\{(\w+)\}\)\) >= \?7/);
  check(raise && raise[1] === raise[2] && (sync.match(/sharingUsed\(/g) ?? []).length === 1, `sync's raise: SET and WHERE interpolate one captured expression (${raise?.[1]}, ${raise?.[2]})`);
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`${results.length - failed}/${results.length} budget claims checks passed`);
process.exit(failed ? 1 : 0);
