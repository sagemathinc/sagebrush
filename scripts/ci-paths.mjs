#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const event = process.env.GITHUB_EVENT_NAME ?? "local";
const ref = process.env.GITHUB_REF ?? "";
const head = process.env.GITHUB_SHA || "HEAD";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
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
    return git("diff", "--name-only", before, head).split("\n").filter(Boolean);
  }
  return git("show", "--pretty=", "--name-only", head).split("\n").filter(Boolean);
}

const files = changedFiles();
const full = event === "workflow_dispatch" || event === "schedule" ||
  (event === "push" && ref === "refs/heads/master");
const matches = (patterns) => files.some((file) => patterns.some((pattern) => pattern.test(file)));
const every = (patterns) => files.length > 0 && files.every((file) => patterns.some((pattern) => pattern.test(file)));

// Only these paths are certified as prose-only.  In particular, examples/*.md
// is executable board input and must not be treated as documentation.
const docsOnly = !full && every([
  /^design\//,
  /^README(?:\.[^/]*)?$/,
  /^CONTRIBUTING(?:\.[^/]*)?$/,
  /^SECURITY(?:\.[^/]*)?$/,
  /^LICENSE(?:[-.][^/]*)?$/,
]);

const workflowOrBuild = matches([
  /^\.github\/workflows\/ci\.yml$/,
  /^scripts\/ci-paths\.mjs$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig(?:\.[^/]*)?\.json$/,
]);
const runtime = matches([
  /^src\//, /^lib\//, /^test\//, /^target\//, /^conformance\//,
  /^catalog\//, /^scripts\/(?!ci-paths\.mjs$)/,
]);
const webChange = matches([
  /^web\//, /^examples\//, /^packages\/sagebrush-board\//,
]);
const modeChange = matches([
  /^sage-tests\//, /^magma-tests\//, /^matlab-tests\//,
  /^numpy-tests\//, /^scipy-tests\//, /^pypi-tests\//, /^bench\/mpmath\//,
]);
const engineChange = matches([
  /^engine\//, /^wasm\//, /^Cargo(?:\.lock|\.toml)$/,
  /^scripts\/build-engine\.mjs$/,
]);
const appOnly = !full && every([/^app\//, /^\.github\/workflows\/app\.yml$/]);

// Unknown paths deliberately fall back to the fast suite.  Skips are allowed
// only for the two narrow, audited classes above.
const known = docsOnly || appOnly || workflowOrBuild || runtime || webChange || modeChange || engineChange;
const fallback = !known && files.length > 0;
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
