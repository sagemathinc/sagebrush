#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [sourceFile, compiledFile, shard] = process.argv.slice(2);
const match = /^(\d+)\/(\d+)$/.exec(shard ?? "");
if (!sourceFile || !compiledFile || !match) {
  console.error("usage: test-name-shard.mjs SOURCE COMPILED I/N");
  process.exit(2);
}
const index = Number(match[1]);
const total = Number(match[2]);
if (index < 1 || index > total) throw new Error(`bad shard ${shard}`);

const source = readFileSync(sourceFile, "utf8");
const calls = [...source.matchAll(/^test\(/gm)].length;
const names = [...source.matchAll(/^test\("((?:\\.|[^"\\])*)"/gm)]
  .map((item) => JSON.parse(`"${item[1]}"`));
if (names.length !== calls) {
  throw new Error(`${sourceFile}: all ${calls} top-level test names must be string literals (${names.length} are)`);
}
const selected = names.filter((_, position) => position % total === index - 1);
if (selected.length === 0) throw new Error(`${sourceFile}: shard ${shard} is empty`);
const escape = (text) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
const pattern = `^(?:${selected.map(escape).join("|")})$`;
console.error(`${sourceFile}: shard ${shard}, ${selected.length}/${names.length} tests`);
const result = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, compiledFile], {
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
