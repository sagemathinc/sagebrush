#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const event = process.env.GITHUB_EVENT_NAME ?? "local";
const ref = process.env.GITHUB_REF ?? "";
const head = process.env.GITHUB_SHA || "HEAD";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function hasCommit(commit) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function changedFiles() {
  if (event === "workflow_dispatch" || event === "schedule") return [];
  if (event === "pull_request") {
    const base = `origin/${process.env.GITHUB_BASE_REF}`;
    const mergeBase = git("merge-base", base, head);
    return git("diff", "--name-only", `${mergeBase}...${head}`).split("\n").filter(Boolean);
  }
  if (event === "push") {
    const before = process.env.GITHUB_EVENT_BEFORE ?? "";
    if (/^[0]+$/.test(before) || !before) {
      return git("show", "--pretty=", "--name-only", head).split("\n").filter(Boolean);
    }
    // A rebased/force-pushed branch can name an unreachable old SHA in
    // `before`.  Compare the whole branch with master rather than failing or
    // accidentally certifying a partial path set.
    if (!hasCommit(before)) {
      const mergeBase = git("merge-base", "origin/master", head);
      return git("diff", "--name-only", `${mergeBase}...${head}`).split("\n").filter(Boolean);
    }
    return git("diff", "--name-only", before, head).split("\n").filter(Boolean);
  }
  return git("show", "--pretty=", "--name-only", head).split("\n").filter(Boolean);
}

// (tests replay a file list through the classifier: one path a line)
const files = process.env.CI_PATHS_FILES
  ? readFileSync(process.env.CI_PATHS_FILES, "utf8").split("\n").filter(Boolean)
  : changedFiles();
const full = event === "workflow_dispatch" || event === "schedule" ||
  (event === "push" && ref === "refs/heads/master");
const matches = (patterns) => files.some((file) => patterns.some((pattern) => pattern.test(file)));
const every = (patterns) => files.length > 0 && files.every((file) => patterns.some((pattern) => pattern.test(file)));

// Only these paths are certified as prose-only.  In particular, examples/*.md
// is executable board input and must not be treated as documentation.
const docsPaths = [
  /^design\//,
  /^README(?:\.[^/]*)?$/,
  /^CONTRIBUTING(?:\.[^/]*)?$/,
  /^SECURITY(?:\.[^/]*)?$/,
  /^LICENSE(?:[-.][^/]*)?$/,
];
const docsOnly = !full && every(docsPaths);

const workflowOrBuildPaths = [
  /^\.github\/workflows\/ci\.yml$/,
  /^scripts\/ci-paths\.mjs$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig(?:\.[^/]*)?\.json$/,
];
// The committed engine artifacts are what the runtime loads (src/runtime/
// engine.ts, the CDN module): a change to them is a runtime change, tested
// by the node, web and mode suites as well as the engine's.  Rust-only
// engine/ changes that leave them alone cannot change runtime behaviour.
const runtimePaths = [
  /^src\//, /^lib\//, /^test\//, /^target\//, /^conformance\//,
  /^catalog\//, /^scripts\/(?!ci-paths\.mjs$)/, /^wasm\//, /^cdn\//,
];
const webPaths = [/^web\//, /^examples\//, /^packages\/sagebrush-board\//];
const modePaths = [
  /^sage-tests\//, /^magma-tests\//, /^matlab-tests\//,
  /^numpy-tests\//, /^scipy-tests\//, /^pypi-tests\//, /^bench\/mpmath\//,
];
const enginePaths = [
  /^engine\//, /^wasm\//, /^Cargo(?:\.lock|\.toml)$/,
  /^scripts\/build-engine\.mjs$/,
];
const appPaths = [/^app\//, /^\.github\/workflows\/app\.yml$/];
const workflowOrBuild = matches(workflowOrBuildPaths);
const runtime = matches(runtimePaths);
const webChange = matches(webPaths);
const modeChange = matches(modePaths);
const engineChange = matches(enginePaths);
const appOnly = !full && every(appPaths);

// Unknown paths deliberately fall back to the fast suite, file by file: an
// unknown path beside known ones still triggers it.  Skips are allowed only
// for the two narrow, audited classes above.
const knownPaths = [...docsPaths, ...workflowOrBuildPaths, ...runtimePaths, ...webPaths, ...modePaths, ...enginePaths, ...appPaths];
const fallback = files.some((file) => !knownPaths.some((pattern) => pattern.test(file)));
const node = full || workflowOrBuild || runtime || webChange || fallback;
const web = full || workflowOrBuild || runtime || webChange || fallback;
const modes = full || workflowOrBuild || runtime || modeChange || fallback;
const engineSmoke = full || workflowOrBuild || engineChange || fallback;

const outputs = {
  full,
  docs_only: docsOnly,
  app_only: appOnly,
  node,
  web,
  modes,
  engine_smoke: engineSmoke,
  engine_full: full,
  files: files.length,
};
for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
console.error(`ci paths (${event}, ${files.length} files): ${JSON.stringify(outputs)}`);
