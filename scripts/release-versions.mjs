#!/usr/bin/env node
// One version for everything a release tag publishes. Every release workflow
// (release.yml: npm and the executables; pypi.yml: the `sagebrush` wheels;
// pypi-mcp.yml: `sagebrush-mcp`) starts with
//
//   node scripts/release-versions.mjs v1.2.3
//
// and stops if any package's version isn't the tag's, so a tag publishes all
// of them at one version or none of them. It checks:
//   - packages/sagebrush and cdn (npm `sagebrush`, `sagebrush-web`);
//   - engine/py and engine/py-mcp (PyPI `sagebrush`, `sagebrush-mcp`);
//   - sagebrush-mcp's dependency on sagebrush: at least this version;
//   - the board package's own version is its own, but it names the CLI it
//     pairs with: ^MAJOR.MINOR.0 of the tag.
// RELEASE_ROOT (for the tests) is the tree to read; it defaults to this one.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.RELEASE_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2] || "";
const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
if (!m) {
  console.error(`release-versions: the tag must be vMAJOR.MINOR.PATCH, not ${JSON.stringify(tag)}`);
  process.exit(2);
}
const version = tag.slice(1);

const npm = (p) => JSON.parse(readFileSync(join(root, p, "package.json"), "utf8"));
// (the [project] table's own `version = "..."` and `dependencies = [...]`, as these two files write them)
function pyproject(p) {
  const text = readFileSync(join(root, p, "pyproject.toml"), "utf8");
  const project = (/^\[project\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text) || [])[1] || "";
  const v = /^version\s*=\s*"([^"]*)"/m.exec(project);
  const deps = /^dependencies\s*=\s*\[([^\]]*)\]/m.exec(project);
  return { version: v ? v[1] : null, dependencies: deps ? [...deps[1].matchAll(/"([^"]*)"/g)].map((d) => d[1]) : [] };
}

const rows = [
  ["npm sagebrush (packages/sagebrush)", npm("packages/sagebrush").version, version],
  ["npm sagebrush-web (cdn)", npm("cdn").version, version],
  ["PyPI sagebrush (engine/py)", pyproject("engine/py").version, version],
  ["PyPI sagebrush-mcp (engine/py-mcp)", pyproject("engine/py-mcp").version, version],
  [
    "sagebrush-mcp's dependency on sagebrush",
    pyproject("engine/py-mcp").dependencies.find((d) => /^sagebrush\s*[<>=!~]/.test(d)) ?? null,
    `sagebrush>=${version}`,
  ],
  ["the board package's sagebrush peer", npm("packages/sagebrush-board").peerDependencies?.sagebrush ?? null, `^${m[1]}.${m[2]}.0`],
];

let bad = 0;
for (const [what, have, want] of rows) {
  const ok = have === want;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${have ?? "(none)"}${ok ? "" : `, want ${want}`}`);
}
if (bad) {
  console.error(`release-versions: ${bad} of ${rows.length} don't match ${tag}; a release tag publishes all of them at one version or none`);
  process.exit(1);
}
console.log(`release-versions: everything ${tag} publishes is at ${version}`);
