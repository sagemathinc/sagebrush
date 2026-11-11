import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/release-versions.mjs, which every release workflow runs on its tag:
// on a tree whose versions all match it passes, and each package that
// disagrees on its own makes it fail.
const script = join(__dirname, "..", "..", "scripts", "release-versions.mjs");

interface Tree {
  npm: string;
  web: string;
  py: string;
  mcp: string;
  mcpDep: string;
  boardPeer: string;
}
const good: Tree = { npm: "1.2.3", web: "1.2.3", py: "1.2.3", mcp: "1.2.3", mcpDep: "sagebrush>=1.2.3", boardPeer: "^1.2.0" };

function tree(t: Tree): string {
  const root = mkdtempSync(join(tmpdir(), "release-versions-"));
  const put = (p: string, text: string) => {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  put("packages/sagebrush/package.json", JSON.stringify({ name: "sagebrush", version: t.npm }));
  put("cdn/package.json", JSON.stringify({ name: "sagebrush-web", version: t.web }));
  put("packages/sagebrush-board/package.json", JSON.stringify({ name: "@sagemathinc/sagebrush-board", version: "0.4.1", peerDependencies: { sagebrush: t.boardPeer } }));
  // (as the real files write them: build-system first, then [project] with its version and dependencies)
  put("engine/py/pyproject.toml", `[build-system]\nrequires = ["maturin>=1.5"]\n\n[project]\nname = "sagebrush"\nversion = "${t.py}"\ndependencies = []\n\n[tool.maturin]\nversion = "9.9.9"\n`);
  put("engine/py-mcp/pyproject.toml", `[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "sagebrush-mcp"\nversion = "${t.mcp}"\ndependencies = ["${t.mcpDep}"]\n\n[project.scripts]\nsagebrush-mcp = "sagebrush_mcp:main"\n`);
  return root;
}

function run(root: string, tag: string) {
  return spawnSync(process.execPath, [script, tag], { encoding: "utf8", env: { ...process.env, RELEASE_ROOT: root } });
}

test("every version at the tag's: passes", () => {
  const r = run(tree(good), "v1.2.3");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /everything v1\.2\.3 publishes is at 1\.2\.3/);
});

test("each package that disagrees fails on its own", () => {
  const cases: [keyof Tree, string, RegExp][] = [
    ["npm", "1.2.2", /FAIL npm sagebrush \(packages\/sagebrush\): 1\.2\.2, want 1\.2\.3/],
    ["web", "1.2.4", /FAIL npm sagebrush-web \(cdn\): 1\.2\.4, want 1\.2\.3/],
    ["py", "1.2.2", /FAIL PyPI sagebrush \(engine\/py\): 1\.2\.2, want 1\.2\.3/],
    ["mcp", "1.3.0", /FAIL PyPI sagebrush-mcp \(engine\/py-mcp\): 1\.3\.0, want 1\.2\.3/],
    ["mcpDep", "sagebrush>=1.2.2", /FAIL sagebrush-mcp's dependency on sagebrush: sagebrush>=1\.2\.2, want sagebrush>=1\.2\.3/],
    ["boardPeer", "^1.1.0", /FAIL the board package's sagebrush peer: \^1\.1\.0, want \^1\.2\.0/],
  ];
  for (const [key, value, line] of cases) {
    const r = run(tree({ ...good, [key]: value }), "v1.2.3");
    assert.equal(r.status, 1, `${key}: ${r.stdout}`);
    assert.match(r.stdout, line, key);
    assert.equal((r.stdout.match(/^FAIL/gm) || []).length, 1, `${key}: only its own row fails`);
  }
});

test("sagebrush-mcp with no dependency on sagebrush fails", () => {
  const r = run(tree({ ...good, mcpDep: "mcp>=1.0" }), "v1.2.3");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL sagebrush-mcp's dependency on sagebrush: \(none\)/);
});

test("a tag that isn't vMAJOR.MINOR.PATCH is refused", () => {
  for (const tag of ["", "1.2.3", "v1.2", "py-v1.2.3", "v1.2.3-rc1"]) {
    const r = run(tree(good), tag);
    assert.equal(r.status, 2, JSON.stringify(tag));
    assert.match(r.stderr, /the tag must be vMAJOR\.MINOR\.PATCH/);
  }
});
