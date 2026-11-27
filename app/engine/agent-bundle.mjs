// The agent the desktop app hosts on macOS and Linux (design/app-agent-host.md §4 step 2): the exact reviewed
// sagebrush-agent release tarball, pinned below by version and SHA-256, with its shrinkwrapped dependencies, put into
// app/src-tauri/agent/ by app/engine/bundle.mjs, with agent/MANIFEST.json listing every file. The app compiles the
// manifest's SHA-256 in (build.rs) and checks the tree against it before each start (src/agent_host.rs
// verify_bundle).
//
// Without the Claude Code CLI for now: the shrinkwrap's optional packages, which are exactly the SDK's per-platform
// Claude Code binaries, are left out (--omit=optional), and the manifest has no claude_code block. The agent never
// uses a `claude` on PATH, so it can't chat until one is bundled; the browser sidecars (lib/fleet/browser/) don't
// need it.
//
// Every file is a regular file, mode 0644 (Node runs the scripts; nothing is executed directly), every folder 0755;
// a link or anything else fails the build. The manifest's bytes depend only on the files: paths sorted, no times.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

// a reviewed release: its SHA-256 is the one web/agents/test-agents-site.mjs's RELEASE_SHA256 has for it
export const AGENT = {
  version: "0.8.16",
  sha256: "6a5bf14a119388d7806dcbc63891b6974ef786e1eded429cd65d6d176f727613",
};
export const agentUrl = (version) => `https://agents.sagebrush.cloud/agents/sagebrush-agent-${version}.tgz`;

// the shrinkwrap's optional packages: the Claude Code binaries, and nothing else, all left out
export const CLAUDE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-arm64-musl", "linux-x64", "linux-x64-musl", "win32-arm64", "win32-x64"];
const CLAUDE_PREFIX = "node_modules/@anthropic-ai/claude-agent-sdk-";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** The shrinkwrap's optional packages must be exactly the Claude Code binaries (else the build stops). */
export function checkOptional(shrinkwrap) {
  const optional = Object.entries(shrinkwrap?.packages ?? {}).filter(([, v]) => v?.optional).map(([k]) => k).sort();
  const want = CLAUDE_PLATFORMS.map((p) => CLAUDE_PREFIX + p).sort();
  if (JSON.stringify(optional) !== JSON.stringify(want)) {
    throw new Error(`the agent's optional packages aren't exactly the Claude Code binaries: ${JSON.stringify(optional)}`);
  }
  return optional;
}

/** Every file under `root`, as [relative '/' path, absolute path], sorted by path; a link or a special file throws. */
export function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name), r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`a link in the agent's files: ${r}`);
      if (st.isDirectory()) walk(full, r);
      else if (st.isFile()) out.push([r, full]);
      else throw new Error(`not a file or a folder in the agent's files: ${r}`);
    }
  };
  walk(root, "");
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Folders 0755, files 0644 (after listFiles has refused links and special files). */
export function normalizeModes(root) {
  chmodSync(root, 0o755);
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const st = lstatSync(full);
    if (st.isDirectory()) normalizeModes(full);
    else if (st.isFile()) chmodSync(full, 0o644);
  }
}

/** MANIFEST.json's bytes for the tree at `root` (no MANIFEST.json in it yet): v 1, the agent release, Node, files. */
export function manifestBytes({ agent, node, root }) {
  const files = listFiles(root).map(([path, full]) => {
    if (path === "MANIFEST.json") throw new Error("the agent's tree already has a MANIFEST.json");
    const b = readFileSync(full);
    return { path, sha256: sha256(b), size: b.length, mode: "0644" };
  });
  if (files.some((f) => f.path.startsWith("package/" + CLAUDE_PREFIX) || f.path.includes("/@anthropic-ai/claude-agent-sdk-"))) {
    throw new Error("a Claude Code binary package is in the agent's files");
  }
  const m = { v: 1, agent: { version: agent.version, release_sha256: agent.sha256 }, node: { version: node.version, sha256: node.sha256, size: node.size }, files };
  return Buffer.from(JSON.stringify(m) + "\n");
}

/**
 * Put the agent into `<tauri>/agent/`: the tarball (from `cache`, else downloaded, checked against AGENT.sha256 before
 * it is unpacked), its dependencies installed with the pinned Node's own npm (`nodeBin`, `npmCli`) from the
 * shrinkwrap, no optional packages, no scripts, no bin links; then the modes, then MANIFEST.json. Returns the
 * manifest's SHA-256.
 */
export function bundleAgent({ tauri, cache, nodeBin, npmCli, node }) {
  // (absolute: npm runs in the package's folder)
  [tauri, cache, nodeBin, npmCli] = [tauri, cache, nodeBin, npmCli].map((p) => resolve(p));
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, `sagebrush-agent-${AGENT.version}.tgz`);
  if (!existsSync(archive) || sha256(readFileSync(archive)) !== AGENT.sha256) {
    rmSync(archive, { force: true });
    const part = archive + ".part";
    execFileSync("curl", ["-fsSL", "--retry", "3", "-o", part, agentUrl(AGENT.version)], { stdio: "inherit" });
    const got = sha256(readFileSync(part));
    if (got !== AGENT.sha256) {
      rmSync(part, { force: true });
      throw new Error(`sagebrush-agent ${AGENT.version}: SHA-256 ${got}, not the pinned ${AGENT.sha256}`);
    }
    cpSync(part, archive);
    rmSync(part, { force: true });
  }
  const agent = join(tauri, "agent");
  rmSync(agent, { recursive: true, force: true });
  mkdirSync(agent, { recursive: true });
  // (tar refuses absolute names and '..' by default; listFiles below refuses any link it leaves)
  execFileSync("tar", ["-xzf", archive, "-C", agent, "--no-same-owner", "--no-same-permissions", "package"]);
  const pkg = join(agent, "package");
  const pj = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  if (pj.name !== "sagebrush-agent" || pj.version !== AGENT.version) throw new Error(`the tarball is ${pj.name} ${pj.version}, not sagebrush-agent ${AGENT.version}`);
  checkOptional(JSON.parse(readFileSync(join(pkg, "npm-shrinkwrap.json"), "utf8")));
  execFileSync(nodeBin, [npmCli, "ci", "--omit=optional", "--omit=dev", "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund", "--cache", join(cache, "npm")], { cwd: pkg, stdio: "inherit", env: { ...process.env, npm_config_update_notifier: "false" } });
  for (const p of CLAUDE_PLATFORMS) if (existsSync(join(pkg, CLAUDE_PREFIX + p))) throw new Error(`npm installed the Claude Code binary for ${p}`);
  listFiles(agent); // (refuses links and special files before any mode is set)
  normalizeModes(agent);
  const bytes = manifestBytes({ agent: AGENT, node, root: agent });
  const tmp = join(agent, "MANIFEST.json.part");
  writeFileSync(tmp, bytes, { mode: 0o644 });
  renameSync(tmp, join(agent, "MANIFEST.json"));
  return { sha256: sha256(bytes), files: JSON.parse(bytes).files.length };
}
