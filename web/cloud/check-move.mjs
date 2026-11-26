// Cloud into the monorepo (plan r1 §1): a moved directory is the cloud repository's at one named commit, byte for byte,
// apart from the edits a move needs.  Run by the author and the reviewers against their own clone of the cloud
// repository (CI has no access to it):
//
//   node web/cloud/check-move.mjs <cloud-clone> <sha> <from> <to> [--allow <allow.json>] [--emit-allow]
//   e.g. node web/cloud/check-move.mjs <clone> fed41fb web/support web/cloud/support
//
// The two trees must list the same files.  Each file must be equal once both are normalised by the move's own edits:
//   - a quoted relative path ("./x", "../x", "." or ".."), in an import or anywhere, compares as one placeholder;
//   - `<from>` as a path in the text (not inside a longer one) compares as `<to>`;
//   - the new file's leading `// ci:` header lines (those before any other line) and its import of
//     miniflare-dispatch.mjs are dropped;
//   - `dispatch(m, ` compares as a call of Miniflare's dispatch method on m, `m.dispatch<Name>(`, which the move
//     replaces with core's helper (scripts/test-dispatch-census.mjs; the census keeps the method's name out of this file).
// Any other line that differs must be listed in the allow file, [{file, from, to}] with the exact old and new
// lines (no normalisation), each used exactly once.  --emit-allow prints, as an allow file, the lines no listed edit
// covers (for the PR's own list, which its reviewers read).  Exit 0: equal; 1: a difference, each one printed; 2: usage.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const usage = () => { console.error("usage: check-move.mjs <cloud-clone> <sha> <from> <to> [--allow <allow.json>] [--emit-allow]"); process.exit(2); };
const args = process.argv.slice(2);
const ei = args.indexOf("--emit-allow");
const emit = ei >= 0 && args.splice(ei, 1).length === 1;
const ai = args.indexOf("--allow");
const allowPath = ai >= 0 ? args.splice(ai, 2)[1] : null;
if (args.length !== 4 || (ai >= 0 && !allowPath)) usage();
const [clone, sha, from, to] = args;
const strip = (p) => p.replace(/\/+$/, "");
const FROM = strip(from), TO = strip(to);
const git = (...a) => execFileSync("git", ["-C", clone, ...a], { encoding: "buffer", maxBuffer: 1 << 28 });

const commit = git("rev-parse", "--verify", `${sha}^{commit}`).toString().trim();
const oldFiles = git("ls-tree", "-r", "-z", "--name-only", commit, "--", FROM).toString().split("\0").filter(Boolean).map((f) => relative(FROM, f)).sort();
// (the new tree as this checkout has it: tracked files and untracked ones git doesn't ignore)
const newFiles = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", TO], { encoding: "utf8" })
  .split("\0").filter(Boolean).map((f) => relative(TO, f)).sort();

const allow = allowPath ? JSON.parse(readFileSync(allowPath, "utf8")) : [];
const used = new Array(allow.length).fill(0);
const problems = [], unlisted = [];
for (const f of oldFiles.filter((x) => !newFiles.includes(x))) problems.push(`${FROM}/${f}: not in ${TO}`);
for (const f of newFiles.filter((x) => !oldFiles.includes(x))) problems.push(`${TO}/${f}: not in ${FROM} at ${commit.slice(0, 12)}`);

const REL = /(["'`])\.{1,2}(?:\/[^"'`\s]*)?\1/g;
const norm = (line) => line.replace(new RegExp(`(?<![\\w/-])${FROM.replace(/[.]/g, "\\.")}(?![\\w-])`, "g"), TO).replace(/\b(\w+)\.dispatch[A-Z]\w*\(/g, "dispatch($1, ").replace(REL, "$1<rel>$1");
const lead = (lines) => { let k = 0; while (k < lines.length && /^\/\/ ci: /.test(lines[k])) k++; return k; };
const dropNew = (lines) => lines.slice(lead(lines)).filter((l) => !/^import \{ dispatch \} from ["'][./]+miniflare-dispatch\.mjs["'];$/.test(l));

for (const f of oldFiles.filter((x) => newFiles.includes(x))) {
  const a = git("show", `${commit}:${FROM}/${f}`), b = readFileSync(join(TO, f));
  if (a.equals(b)) continue;
  const al = a.toString("utf8").split("\n"), bl = dropNew(b.toString("utf8").split("\n"));
  // (line for line after the drops: a move adds and removes no other line, so the counts must agree)
  if (al.length !== bl.length) { problems.push(`${TO}/${f}: ${al.length} lines at ${FROM}, ${bl.length} here (after the headers and the dispatch import)`); continue; }
  for (let i = 0; i < al.length; i++) {
    if (al[i] === bl[i] || norm(al[i]) === norm(bl[i])) continue;
    const k = allow.findIndex((x, j) => !used[j] && x.file === `${TO}/${f}` && x.from === al[i] && x.to === bl[i]);
    if (k >= 0) { used[k]++; continue; }
    problems.push(`${TO}/${f}:${i + 1}:\n  - ${al[i]}\n  + ${bl[i]}`);
    unlisted.push({ file: `${TO}/${f}`, from: al[i], to: bl[i] });
  }
}
allow.forEach((x, j) => { if (!used[j]) problems.push(`allow entry ${j} (${x.file}) matched no line`); });
if (emit) { console.log(JSON.stringify(unlisted, null, 1)); process.exit(problems.length ? 1 : 0); }
for (const p of problems) console.log(p);
console.log(problems.length ? `FAILED: ${problems.length} difference(s)` : `ok: ${TO} is ${FROM} at ${commit} (${oldFiles.length} files; ${allow.length} listed edits)`);
process.exit(problems.length ? 1 : 0);
