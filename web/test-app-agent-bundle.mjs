// ci: checks.3 order=41
// The agent bundle the desktop app ships (app/engine/agent-bundle.mjs): the shrinkwrap's optional packages must be
// exactly the Claude Code binaries, the tree may hold only regular files and folders, every file is 0644, the
// manifest's bytes depend only on the files, and the pinned release is a reviewed one. (The real bundle, built by
// app/engine/bundle.mjs, is checked by the app's own verify_bundle in its Rust tests.)
//
//   node web/test-app-agent-bundle.mjs
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AGENT, CLAUDE_PLATFORMS, checkOptional, listFiles, manifestBytes, normalizeModes } from "../app/engine/agent-bundle.mjs";

let fails = 0, n = 0;
const ok = (cond, what) => { n++; if (!cond) { fails++; console.log(`FAIL: ${what}`); } };
const throws = (f, re, what) => { try { f(); ok(false, `${what} (no error)`); } catch (e) { ok(re.test(String(e?.message)), `${what}: ${e?.message}`); } };
const here = fileURLToPath(new URL(".", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "agent-bundle-"));
const NODE = { version: "24.21.0", sha256: "a".repeat(64), size: 11 };

// (a shrinkwrap with exactly the eight Claude Code packages optional)
const claude = Object.fromEntries(CLAUDE_PLATFORMS.map((p) => [`node_modules/@anthropic-ai/claude-agent-sdk-${p}`, { version: "0.3.330", optional: true }]));
const wrap = (extra = {}) => ({ packages: { "": { name: "sagebrush-agent" }, "node_modules/ws": { version: "8.22.0" }, ...claude, ...extra } });
ok(checkOptional(wrap()).length === 8, "the eight Claude Code binaries are the optional packages");
throws(() => checkOptional(wrap({ "node_modules/fsevents": { optional: true } })), /aren't exactly/, "another optional package stops the build");
const seven = wrap();
delete seven.packages["node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"];
throws(() => checkOptional(seven), /aren't exactly/, "a missing one stops it too (the list changed: look again)");
const notOptional = wrap();
notOptional.packages["node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"] = { version: "0.3.330" };
throws(() => checkOptional(notOptional), /aren't exactly/, "a Claude Code binary that isn't optional would be installed: stop");

// (a tree: two built in different orders give the same manifest bytes; modes come out 0644 and 0755)
function tree(name, order) {
  const root = join(temp, name);
  const files = [["package/package.json", "{}"], ["package/lib/a.mjs", "export {}\n"], ["package/node_modules/ws/index.js", "x"], ["package/bin/sagebrush-agent.mjs", "#!/usr/bin/env node\n"]];
  for (const [p, body] of order ? files.reverse() : files) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  chmodSync(join(root, "package/bin/sagebrush-agent.mjs"), 0o755);
  chmodSync(join(root, "package/lib/a.mjs"), 0o666);
  return root;
}
const a = tree("a", false), b = tree("b", true);
normalizeModes(a);
normalizeModes(b);
ok((statSync(join(a, "package/bin/sagebrush-agent.mjs")).mode & 0o777) === 0o644, "an executable file is made 0644 (Node runs it)");
ok((statSync(join(a, "package/lib/a.mjs")).mode & 0o777) === 0o644, "a file writable by others is made 0644");
ok((statSync(join(a, "package/lib")).mode & 0o777) === 0o755, "a folder is 0755");
const ma = manifestBytes({ agent: AGENT, node: NODE, root: a }), mb = manifestBytes({ agent: AGENT, node: NODE, root: b });
ok(ma.equals(mb), "the manifest's bytes depend only on the files");
const m = JSON.parse(ma);
ok(JSON.stringify(Object.keys(m)) === JSON.stringify(["v", "agent", "node", "files"]), `the manifest's keys: no claude_code block (${Object.keys(m)})`);
ok(m.v === 1 && m.agent.version === AGENT.version && m.agent.release_sha256 === AGENT.sha256, "v 1 and the pinned release");
ok(JSON.stringify(m.node) === JSON.stringify(NODE), "the Node as given: version, sha256, size (no path)");
ok(JSON.stringify(m.files.map((f) => f.path)) === JSON.stringify(["package/bin/sagebrush-agent.mjs", "package/lib/a.mjs", "package/node_modules/ws/index.js", "package/package.json"]), "every file, sorted");
ok(m.files.every((f) => f.mode === "0644" && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isInteger(f.size)), "each file: its sha256, size, 0644");
ok(m.files[1].sha256 === createHash("sha256").update("export {}\n").digest("hex") && m.files[1].size === 10, "a.mjs: its exact sha256 and size");

// (what the build refuses)
const withLink = tree("link", false);
symlinkSync("/etc/hostname", join(withLink, "package/lib/evil.mjs"));
throws(() => listFiles(withLink), /a link/, "a link in the tree");
const withDirLink = tree("dirlink", false);
symlinkSync("/tmp", join(withDirLink, "package/node_modules/tmp"));
throws(() => listFiles(withDirLink), /a link/, "a link to a folder");
const withFifo = tree("fifo", false);
execFileSync("mkfifo", [join(withFifo, "package/lib/pipe")]);
throws(() => listFiles(withFifo), /not a file or a folder/, "a special file");
const withClaude = tree("claude", false);
mkdirSync(join(temp, "claude", "package/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"), { recursive: true }); // (withClaude is temp/claude)
writeFileSync(join(withClaude, "package/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"), "bin");
throws(() => manifestBytes({ agent: AGENT, node: NODE, root: withClaude }), /Claude Code binary package/, "a Claude Code binary in the tree");
const withManifest = tree("manifest", false);
writeFileSync(join(withManifest, "MANIFEST.json"), "{}");
throws(() => manifestBytes({ agent: AGENT, node: NODE, root: withManifest }), /already has a MANIFEST/, "a tree that already has a manifest");

// (the pinned release is a reviewed one: the sha256 the agents site's own test has for that version)
const site = readFileSync(join(here, "agents", "test-agents-site.mjs"), "utf8");
const reviewed = new RegExp(`^  "${AGENT.version.replaceAll(".", "\\.")}": "([0-9a-f]{64})",?$`, "m").exec(site)?.[1];
ok(reviewed === AGENT.sha256, `the pinned agent ${AGENT.version} is a reviewed release (${reviewed})`);

rmSync(temp, { recursive: true, force: true });
console.log(`${n - fails}/${n} passed`);
if (fails) process.exit(1);
