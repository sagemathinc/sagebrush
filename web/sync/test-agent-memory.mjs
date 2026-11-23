// ci: web-sync.2 order=71
// The rules of Autonomous agents' memory namespaces (web/sync/agent-memory.ts; agent-autonomous-o4-memory r2 §1-§4):
// the scopes an agent gets back, and none while the fleet's feature is off; which namespace a path is in; moves only
// within one; note names, sizes and expiry, each at its exact boundary.  Pure: nothing is wired to them yet.
//
//   node web/sync/test-agent-memory.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const src = execFileSync("bun", ["build", join(here, "agent-memory.ts"), "--format", "esm", "--target", "node"], { encoding: "utf8" });
const M = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

let count = 0, failures = 0;
const ok = (c, what) => { count++; if (!c) { failures++; console.log("FAIL " + what); } };

// (synthetic fleet ids: 26 base32 characters, the last one of a e i m q u y 4)
const A = "aaaaaaaaaaaaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbbbbbbbbbbbq", T = "tttttttttttttttttttttttttu", G = "ggggggggggggggggggggggggg4";
const paths = (s) => JSON.stringify(s.map((x) => `${x.path} ${x.access}`));

// §0, §2.1: the scopes M
ok(M.memoryScopes({ agent: A, tags: [T], rights: ["memory", "workspace"] }, false).length === 0, "the feature off: no memory scope at all, whatever the rights (fixture 0)");
ok(M.memoryScopes({ agent: A, tags: [T], rights: ["workspace"] }, true).length === 0, "without the memory right: none (fixture 15)");
ok(paths(M.memoryScopes({ agent: A, tags: [T, G], rights: ["memory"] }, true)) === JSON.stringify([`/.agents/memory/agent/${A} write`, `/.agents/memory/tag/${T} write`, `/.agents/memory/tag/${G} write`]), "on, with the right: its own namespace and each of its tags', read-write, nothing else (no implicit global)");
ok(paths(M.memoryScopes({ agent: A, tags: [T, T], rights: ["memory"] }, true)).split("tag/").length === 2, "a tag listed twice gives one scope");
ok(M.memoryScopes({ agent: "Agent-Name", tags: [], rights: ["memory"] }, true).length === 0 && paths(M.memoryScopes({ agent: A, tags: ["../x", "TTTTTTTTTTTTTTTTTTTTTTTTTU"], rights: ["memory"] }, true)) === JSON.stringify([`/.agents/memory/agent/${A} write`]), "ids that aren't fleet ids name no namespace");

// §3: namespaces and moves
ok(M.namespaceOf(`/.agents/memory/agent/${A}/n.md`) === `agent/${A}` && M.namespaceOf(`/.agents/memory/tag/${T}`) === `tag/${T}`, "a path's namespace");
ok(M.namespaceOf("/.agents") === null && M.namespaceOf("/.agents/memory") === null && M.namespaceOf("/notes/n.md") === null && M.namespaceOf(`/.agents/memory/other/${A}/n.md`) === null && M.namespaceOf("/.agents/memory/agent/x/n.md") === null, "anything else is in none");
ok(M.sameNamespaceMove(`/.agents/memory/agent/${A}/a.md`, `/.agents/memory/agent/${A}/b.md`), "a move within one namespace (fixture 6, positive)");
ok(!M.sameNamespaceMove(`/.agents/memory/agent/${A}/a.md`, "/x.md") && !M.sameNamespaceMove("/x.md", `/.agents/memory/agent/${A}/a.md`), "never out to, or in from, an ordinary path (fixture 6)");
ok(!M.sameNamespaceMove(`/.agents/memory/agent/${A}/a.md`, `/.agents/memory/tag/${T}/a.md`) && !M.sameNamespaceMove(`/.agents/memory/agent/${A}/a.md`, `/.agents/memory/agent/${B}/a.md`), "never into another namespace (fixtures 7, 8)");
ok(M.sameNamespaceMove("/x.md", "/y/z.md") && !M.sameNamespaceMove("/x.md", "/.agents/x.md"), "ordinary to ordinary is not this rule's; into the reserved folder never");

// §4: names
const name = (n) => M.isNotePath(`/.agents/memory/agent/${A}/${n}`);
ok(name("a.md") && name("x".repeat(64) + ".md") && name("a-b9.md"), "a.md, a 64-character name, inner hyphens (fixture 18, positive)");
for (const bad of ["x".repeat(65) + ".md", "-a.md", "a-.md", "A.md", "a.MD", ".md", "a.txt", "a b.md", "a\u0000.md", "a/b.md"])
  ok(!name(bad), "a note's name refused: " + JSON.stringify(bad));
ok(!M.isNotePath(`/.agents/memory/agent/${A}`) && !M.isNotePath(`/.agents/memory/agent/${A}/sub/a.md`), "the namespace itself, or a folder in it, isn't a note (no folders)");

// §4: sizes, in UTF-8 bytes
ok(M.noteBytesOk("a".repeat(8192)) && !M.noteBytesOk("a".repeat(8193)), "8,192 bytes pass, 8,193 don't (fixture 17)");
ok(M.noteBytesOk("a".repeat(8189) + "é") && !M.noteBytesOk("a".repeat(8190) + "€"), "a multi-byte character straddling the limit counts in bytes");

// §4: expiry, 90 days after the last save or renewal, strictly
const D = 86_400_000, t0 = 1_800_000_000_000;
ok(!M.expired(t0, t0 + 90 * D - 1000) && !M.expired(t0, t0 + 90 * D) && M.expired(t0, t0 + 90 * D + 1000), "90 days less a second: live; 90 days: live; a second past: expired (fixture 20)");

console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
