#!/usr/bin/env node
// Tests of scripts/architecture-article.mjs (the architecture article's link
// check and pages), on small boards and a fake git, then on the real board.
//   node scripts/test-architecture-article.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLinks, pages, BOARD, DIR } from "./architecture-article.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = "a".repeat(40), B = "b".repeat(40);
const url = (path, c = A) => `https://github.com/sagemathinc/sagebrush/blob/${c}/${path}`;
// a fake repository: at commit A, src/x.ts has 10 lines and README.md exists
const files = { [`${A}:src/x.ts`]: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", [`${A}:README.md`]: "# r\n" };
const git = (args) => {
  if (args[0] === "cat-file" && args[1] === "-e") { if (args[2] !== `${A}^{commit}`) throw new Error("no commit"); return ""; }
  const [op, spec] = args[0] === "cat-file" ? [args[1], args[2]] : [];
  if (!(spec in files)) throw new Error("missing");
  return op === "-t" ? "blob\n" : files[spec];
};
const board = (refs, { stamp = A.slice(0, 8), extra = "" } = {}) => ({
  format: "sagebrush-board", version: 1, title: "t",
  nodes: [
    { id: "start", title: "Start here", text: `Hello.${extra}\n\nLast updated 2026-10-25, at sagebrush \`${stamp}\`.` },
    { id: "g", kind: "group", title: "Region", children: refs.map((ref, i) => ({ id: "n" + i, title: "N" + i, text: "t" + i, detail: "d" + i, ref })) },
  ],
});
const problems = (doc) => checkLinks(doc, git).problems;
let n = 0;
const ok = (doc, what) => { assert.deepEqual(problems(doc), [], what); n++; };
const bad = (doc, re, what) => { const p = problems(doc); assert.ok(p.some((x) => re.test(x)), `${what}: ${JSON.stringify(p)}`); n++; };

ok(board([url("src/x.ts#L1-L10"), url("README.md"), url("README.md?plain=1#L1"), url("README.md#principles")]), "good links");
bad(board([url("src/y.ts")]), /src\/y\.ts is not a file/, "a path that doesn't exist at the commit");
{ const p = problems(board([url("src/x.ts", B)], { stamp: B.slice(0, 8) })); assert.equal(p.length, 1, JSON.stringify(p)); assert.match(p[0], /isn't in this clone/); n++; } // (a missing commit: one problem, not one per link)
bad(board([url("src/x.ts#L5-L11")]), /outside its 10 lines/, "a line range past the end");
bad(board([url("src/x.ts#L6-L5")]), /outside/, "a reversed line range");
bad(board([url("src/x.ts"), url("README.md", B)]), /pinned to 2 commits/, "two commits");
bad(board([url("src/x.ts")], { stamp: "bbbbbbbb" }), /"Last updated" names bbbbbbbb/, "the stamp names another commit");
bad({ ...board([url("src/x.ts")]), nodes: [{ id: "start", title: "s", text: "no stamp" }] }, /must say "Last updated/, "no stamp");
bad(board(["https://github.com/sagemathinc/sagebrush-cloud-private/blob/" + A + "/README.md"]), /not a permalink into https:\/\/github.com\/sagemathinc\/sagebrush /, "a private repository");
bad(board(["https://github.com/sagemathinc/sagebrush/blob/master/README.md"]), /not a permalink/, "a branch, not a commit");
bad(board([url("src/x.ts")], { extra: " See https://github.com/sagemathinc/sagebrush-cloud-private/blob/main/x." }), /text: .*not a permalink/, "a GitHub link written in a note's text");
ok(board([url("src/x.ts")], { extra: " See https://sagebrush.space/articles/." }), "a link elsewhere is prose");
// (astra's CORR-ARCH-1 probes: a ref is always checked, whatever it starts with)
bad(board(["https://example.com/unpinned"]), /note n0: https:\/\/example\.com\/unpinned is not a permalink/, "a ref to another site");
bad(board(["javascript:alert(1)"]), /note n0: javascript:alert\(1\) is not a permalink/, "a javascript: ref");
bad(board(["http://github.com/sagemathinc/sagebrush-cloud-private/blob/main/README.md"]), /note n0: http:\/\/github\.com\/sagemathinc\/sagebrush-cloud-private/, "an http: ref into the private repository");
bad(board(["http://github.com/sagemathinc/sagebrush/blob/" + A + "/src/x.ts"]), /not a permalink/, "an http: permalink");
bad(board(["#p2"]), /note n0: #p2 is not a permalink/, "a ref to a place on the board");
bad(board([url("src/x.ts")], { extra: " See HTTP://GitHub.com/sagemathinc/sagebrush-cloud-private." }), /text: HTTP:\/\/GitHub\.com\/sagemathinc\/sagebrush-cloud-private\. is not a permalink/, "a GitHub link in text, any case and scheme");
bad(board([url("src/x.ts")], { extra: " See https://raw.githubusercontent.com/sagemathinc/sagebrush/master/README.md" }), /text: https:\/\/raw\.githubusercontent\.com/, "a raw GitHub link in text");
bad(board([url("src/x.ts")], { extra: " [click](javascript:alert(1))" }), /javascript:/, "a javascript: link in text");
bad(board([url("src/x.ts")], { extra: " [x](data:text/html,hi)" }), /a link to data:text\/html,hi/, "a data: link in text");
ok(board([url("src/x.ts")], { extra: " [the viewer](/board/?doc=/a.board.json), [here](#top)" }), "site-relative and in-page links");
{ const r = checkLinks(board([url("src/x.ts"), url("README.md")]), git); assert.equal(r.links, 2, "every ref counted"); n++; }

// the pages: every note of a titled region, its detail and its code link, and the stamp
const doc = board([url("src/x.ts#L2-L3")]);
const r = checkLinks(doc, git);
const out = pages(doc, r);
const map = out[`${DIR}/01-the-map.md`], readme = out[`${DIR}/README.md`];
assert.match(map, /^<!-- description: /, "the description comes first"); n++;
assert.match(map, /^# The map$/m); n++;
assert.match(map, /^## Region$/m); n++;
assert.match(map, /^### N0$\n\nt0\n\nd0\n\nSource: \[`src\/x\.ts, lines 2–3`\]\(https:\/\/github\.com\/sagemathinc\/sagebrush\/blob\/a{40}\/src\/x\.ts#L2-L3\)$/m, "a note, its detail and its link"); n++;
assert.ok(!/^Last updated .*`aaaaaaaa`\.$/m.test(map.split("## Start here")[1].split("##")[0]), "the stamp isn't repeated in the start note"); n++;
for (const page of [map, readme]) { assert.match(page, /Last updated 2026-10-25, at sagebrush \[`aaaaaaaa`\]\(https:\/\/github\.com\/sagemathinc\/sagebrush\/tree\/a{40}\)\./); n++; }
assert.match(readme, /\]\(01-the-map\.md\)/, "the series' page links its article (web/build-articles.ts requires it)"); n++;
assert.match(readme, /\/board\/\?doc=\/articles\/architecture\/architecture\.board\.json/, "the interactive board's link"); n++;

// the real board: its links check out at its commit, and the pages are current
const real = JSON.parse(readFileSync(join(root, BOARD), "utf8"));
const rgit = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
const rr = checkLinks(real, rgit);
const have = (() => { try { rgit(["cat-file", "-e", `${rr.commit}^{commit}`]); return true; } catch { return false; } })();
if (have) {
  assert.deepEqual(rr.problems, [], "the real board's links");
  n++;
} else console.log(`(the real board's commit ${rr.commit.slice(0, 8)} isn't in this clone: architecture-article.mjs --check fetches it)`);
for (const [file, text] of Object.entries(pages(real, rr))) { assert.equal(readFileSync(join(root, file), "utf8"), text, `${file} is current`); n++; }
for (const s of JSON.stringify(real).match(/https?:\/\/[^\s"\\)]+/g) ?? []) assert.ok(!/sagebrush-cloud/.test(s), `no link into the cloud repository: ${s}`);
n++;
// --built: after web/build.ts, the site has the board beside the article's pages, where the
// README's /board/?doc= link loads it from (web/build-articles.ts copies a series' boards)
if (process.argv.includes("--built")) {
  const site = join(root, "web/site/public/articles/architecture");
  assert.ok(readFileSync(join(site, "architecture.board.json"), "utf8") === readFileSync(join(root, BOARD), "utf8"), "the built site has the board, as committed");
  assert.match(readFileSync(join(site, "index.html"), "utf8"), /href="\/board\/\?doc=\/articles\/architecture\/architecture\.board\.json"/, "the built page links it");
  assert.match(readFileSync(join(site, "01-the-map.html"), "utf8"), /Last updated \d{4}-\d{2}-\d{2}, at sagebrush/, "the built map has its stamp");
  n += 3;
}
console.log(`test-architecture-article: ${n} checks passed`);
