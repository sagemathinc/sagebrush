// ci: checks.3 order=110 runner=bun
// The package fixtures against TeX's text (web/latex/package-fixtures.mjs): each fixture's preview shows at least
// its expect.json's share of TeX's tokens, at most its stray tokens and at most its problems. A ratchet: a change that
// shows more raises the fixture's numbers in the same PR, toward recall 1, no strays and no problems.
//   bun web/latex/test-latex-packages.mjs            (the checks)
//   bun web/latex/test-latex-packages.mjs --report   (each fixture's numbers, its missing and stray tokens, and problems)
import { fixtureNames, measure, expectOf } from "./package-fixtures.mjs";

const report = process.argv.includes("--report");
const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 600)); };
const names = fixtureNames();
check("fixtures-found", names.length >= 11, names);
for (const name of names) {
  const m = measure(name), e = expectOf(name);
  const probs = [...new Set(m.problems.map((p) => p.kind + ":" + p.name))];
  if (report) console.log(name, JSON.stringify({ recall: +m.recall.toFixed(3), stray: m.strayCount, problems: m.problems.length, missing: m.missing, strayTokens: m.stray.slice(0, 20), problemNames: probs }));
  check(name + "-recall", m.recall >= e.recall, { recall: m.recall, want: e.recall, missing: m.missing });
  check(name + "-stray", m.strayCount <= e.stray, { stray: m.strayCount, want: e.stray, tokens: m.stray.slice(0, 20) });
  check(name + "-problems", m.problems.length <= e.problems, { problems: m.problems.length, want: e.problems, names: probs });
}

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}: ${failed.join(", ")}` : `ok: the LaTeX package fixtures, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
