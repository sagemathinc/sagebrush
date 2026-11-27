#!/usr/bin/env node
// The optional tier's WebAssembly modules (.github/workflows/optional.yml): the published modules wasm/pins.json
// names, fetched as scripts/wasm-fetch.mjs does.  On a track (scripts/pin-policy.mjs: a pull request into track/*, a
// push or dispatch on it) the engine runs ahead of its pin, which is published only with the track's pull into
// master: when every failure is a 404 there, the job's package tests are skipped, saying "skipped (track pin
// unpublished)", and they run on that pull, whose pins are published.  Any other failure, or a 404 off a track, fails.
//   node scripts/optional-wasm.mjs     (writes skip=true or skip=false to $GITHUB_OUTPUT when it is set)
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchModules } from "./wasm-fetch.mjs";
import { unpublishedOnly } from "./wasm-fetch-or-build.mjs";
import { onTrack, runRefs } from "./pin-policy.mjs";

export const SKIPPED = "skipped (track pin unpublished)";

export async function optionalModules({ fetch = fetchModules, env = process.env, log = (line) => console.log(line) } = {}) {
  try {
    await fetch({ log });
    return "fetched";
  } catch (error) {
    if (!onTrack(runRefs(env)) || !unpublishedOnly(error)) throw error;
    log(error.message);
    log(`::notice title=optional packages::${SKIPPED}: the package tests run on the track's pull into master`);
    return "skipped";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error("usage: node scripts/optional-wasm.mjs");
    process.exit(2);
  }
  try {
    const result = await optionalModules();
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip=${result === "skipped"}\n`);
    if (result === "skipped" && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `packages: ${SKIPPED}\n`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
