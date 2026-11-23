import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// magic(n) for n = 1..8 as MATLAB R2026b printed it (mat2str): magic(2), which is not a magic square (none of order 2
// exists), is [1 3; 4 2] in MATLAB; Sagebrush gave [4 3; 1 2].

const cli = join(__dirname, "..", "src", "cli.js");

const MATLAB: [string, string][] = [["magic1", "1"], ["magic2", "[1 3;4 2]"], ["magic3", "[8 1 6;3 5 7;4 9 2]"], ["magic4", "[16 2 3 13;5 11 10 8;9 7 6 12;4 14 15 1]"], ["magic5", "[17 24 1 8 15;23 5 7 14 16;4 6 13 20 22;10 12 19 21 3;11 18 25 2 9]"], ["magic6", "[35 1 6 26 19 24;3 32 7 21 23 25;31 9 2 22 27 20;8 28 33 17 10 15;30 5 34 12 14 16;4 36 29 13 18 11]"], ["magic7", "[30 39 48 1 10 19 28;38 47 7 9 18 27 29;46 6 8 17 26 35 37;5 14 16 25 34 36 45;13 15 24 33 42 44 4;21 23 32 41 43 3 12;22 31 40 49 2 11 20]"], ["magic8", "[64 2 3 61 60 6 7 57;9 55 54 12 13 51 50 16;17 47 46 20 21 43 42 24;40 26 27 37 36 30 31 33;32 34 35 29 28 38 39 25;41 23 22 44 45 19 18 48;49 15 14 52 53 11 10 56;8 58 59 5 4 62 63 1]"]];

test("magic(1) to magic(8) are MATLAB's matrices, magic(2) = [1 3; 4 2] included", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-magic-"));
  writeFileSync(join(dir, "main.m"), "for n = 1:8, fprintf('magic%d|%s\\n', n, mat2str(magic(n))); end\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, MATLAB.map(([k, v]) => `${k}|${v}\n`).join(""));
});
