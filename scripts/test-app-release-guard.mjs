// ci: checks.3 order=60
// The signed Mac app's job (.github/workflows/app.yml, mac-release) runs only
// on this repository, for a push of an app-v* tag or a dispatch that asks to
// sign: never on a pull request, and never for a dispatch without `sign`, on
// a tag too.  Its `if:` is read from the workflow and evaluated here over
// every case (GitHub's expression syntax, only the parts it uses: anything
// else in it fails this test, rather than being guessed).
//
//   node scripts/test-app-release-guard.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const text = readFileSync(join(root, ".github", "workflows", "app.yml"), "utf8");
const job = /^  mac-release:\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:\n|(?![\s\S]))/m.exec(text);
let failed = 0, passed = 0;
const ok = (c, what) => (c ? passed++ : (failed++, console.log("FAIL " + what)));
if (!job) {
  console.log("FAIL no mac-release job in .github/workflows/app.yml");
  process.exit(1);
}
const cond = /^    if: (.+)$/m.exec(job[1])?.[1];
ok(!!cond, "the job has an if: on one line");
ok(/^    environment: sagebrush-signing$/m.test(job[1]), "the job uses the sagebrush-signing environment");

// GitHub's expression syntax, as much as the condition uses: context names, 'strings', ==, !=, &&, ||, !, ( ),
// startsWith(a, b)
function evaluate(expr, ctx) {
  const toks = expr.match(/\s*(?:'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.-]*|==|!=|&&|\|\||[!(),])/gy);
  if (!toks || toks.join("").length !== expr.length) throw new Error("an expression this test doesn't read: " + expr);
  const t = toks.map((s) => s.trim());
  let i = 0;
  const peek = () => t[i], eat = (x) => { if (t[i] !== x) throw new Error(`expected ${x} at ${t[i]}`); i++; };
  const value = (name) => {
    if (name === "true") return true;
    if (name === "false") return false;
    const v = name.split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    if (v === undefined && !name.startsWith("inputs.")) throw new Error("an unknown context value: " + name);
    return v ?? null;
  };
  const primary = () => {
    const x = t[i++];
    if (x === "(") { const v = or(); eat(")"); return v; }
    if (x === "!") return !primary();
    if (x?.startsWith("'")) return x.slice(1, -1).replace(/''/g, "'");
    if (x === "startsWith") {
      eat("(");
      const a = or();
      eat(",");
      const b = or();
      eat(")");
      return String(a ?? "").toLowerCase().startsWith(String(b ?? "").toLowerCase());
    }
    if (/^[A-Za-z_]/.test(x ?? "")) return value(x);
    throw new Error("unexpected " + x);
  };
  const cmp = () => {
    let v = primary();
    while (peek() === "==" || peek() === "!=") {
      const op = t[i++], w = primary();
      const eq = typeof v === "string" && typeof w === "string" ? v.toLowerCase() === w.toLowerCase() : v === w;
      v = op === "==" ? eq : !eq;
    }
    return v;
  };
  const and = () => { let v = cmp(); while (peek() === "&&") { i++; const w = cmp(); v = v ? w : v; } return v; };
  const or = () => { let v = and(); while (peek() === "||") { i++; const w = and(); v = v ? v : w; } return v; };
  const v = or();
  if (i !== t.length) throw new Error("left over: " + t.slice(i).join(" "));
  return !!v;
}

const REPO = "sagemathinc/sagebrush";
const cases = [
  // [what, event, ref, inputs, repository, signs]
  ["a push of an app-v tag", "push", "refs/tags/app-v0.4.0", {}, REPO, true],
  ["a dispatch with sign", "workflow_dispatch", "refs/heads/master", { sign: true }, REPO, true],
  ["a dispatch with sign, on an app-v tag", "workflow_dispatch", "refs/tags/app-v0.4.0", { sign: true }, REPO, true],
  ["a dispatch without sign", "workflow_dispatch", "refs/heads/master", { sign: false }, REPO, false],
  ["a dispatch without sign, on an app-v tag", "workflow_dispatch", "refs/tags/app-v0.4.0", { sign: false }, REPO, false],
  ["a dispatch with no inputs", "workflow_dispatch", "refs/heads/master", {}, REPO, false],
  ["a push to master", "push", "refs/heads/master", {}, REPO, false],
  ["a push of another tag", "push", "refs/tags/v1.0.0", {}, REPO, false],
  ["a push of a branch named like the tag", "push", "refs/heads/app-v1", {}, REPO, false],
  ["a pull request", "pull_request", "refs/pull/1/merge", {}, REPO, false],
  ["a pull request whose ref looks like the tag", "pull_request", "refs/tags/app-v0.4.0", { sign: true }, REPO, false],
  ["a pull_request_target", "pull_request_target", "refs/tags/app-v0.4.0", { sign: true }, REPO, false],
  ["a schedule", "schedule", "refs/tags/app-v0.4.0", {}, REPO, false],
  ["a fork's push of an app-v tag", "push", "refs/tags/app-v0.4.0", {}, "someone/sagebrush", false],
  ["a fork's dispatch with sign", "workflow_dispatch", "refs/heads/master", { sign: true }, "someone/sagebrush", false],
];
if (cond) {
  for (const [what, event_name, ref, inputs, repository, signs] of cases) {
    let got;
    try {
      got = evaluate(cond, { github: { event_name, ref, repository }, inputs });
    } catch (e) {
      ok(false, `${what}: ${e.message}`);
      continue;
    }
    ok(got === signs, `${what}: ${signs ? "signs" : "never signs"} (the condition says ${got})`);
  }
  // (the evaluator itself: it refuses what it doesn't read)
  let refused = false;
  try { evaluate("contains(github.ref, 'x')", { github: {} }); } catch { refused = true; }
  ok(refused, "the evaluator refuses an expression it doesn't read");
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
