// ci: web-sync.1 order=23
// Tests for web/cloud/check-move.mjs, the contents-equal check of a move from the cloud repository (plan r1 §1), on
// two throwaway git repositories: a "cloud" one with web/x/ at a commit, and a "core" one with web/cloud/x/.
//   node web/cloud/test-check-move.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-move.mjs");
const root = mkdtempSync(join(tmpdir(), "sb-check-move-"));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "ok" : "FAIL"} - ${m}`); if (!c) failed++; };
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" });
// (sub: "cloud" or "core", under root)
const put = (sub, files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, sub, p)), { recursive: true }); writeFileSync(join(root, sub, p), t); } };

const OLD = {
  "web/x/a.ts": 'import { b } from "./b.ts";\nexport const a = b + 1;\n',
  "web/x/b.ts": "export const b = 1;\n",
  "web/x/test-x.mjs": '// Tests for web/x/ (node web/x/test-x.mjs)\nconst mf = {};\nconst site = join(here, "../site");\nawait mf.dispatchRequest("https://h/");\n',
};
// (any Miniflare dispatch method stands for the real one, which the dispatch census keeps out of this file)
const NEW = {
  "web/cloud/x/a.ts": OLD["web/x/a.ts"],
  "web/cloud/x/b.ts": OLD["web/x/b.ts"],
  "web/cloud/x/test-x.mjs": '// ci: web-sync.1 order=1\n// Tests for web/cloud/x/ (node web/cloud/x/test-x.mjs)\nimport { dispatch } from "../../miniflare-dispatch.mjs";\nconst mf = {};\nconst site = join(here, "../../site");\nawait dispatch(mf, "https://h/");\n',
};
const cloud = join(root, "cloud"), core = join(root, "core");
mkdirSync(join(root, "cloud")); mkdirSync(join(root, "core"));
git(cloud, "init", "-q"); put("cloud", OLD); git(cloud, "add", "-A"); git(cloud, "commit", "-qm", "c");
const sha = git(cloud, "rev-parse", "HEAD").trim();
git(core, "init", "-q");
const run = (files, extra = []) => {
  rmSync(join(root, "core", "web"), { recursive: true, force: true }); put("core", files);
  return spawnSync(process.execPath, [script, cloud, sha, "web/x", "web/cloud/x", ...extra], { cwd: core, encoding: "utf8" });
};

try {
  let r = run(NEW);
  ok(r.status === 0 && /ok: web\/cloud\/x is web\/x at /.test(r.stdout), `the move's own edits only: equal (${r.stdout.trim()})`);

  r = run({ ...NEW, "web/cloud/x/b.ts": "export const b = 2;\n" });
  ok(r.status === 1 && /b\.ts:1:/.test(r.stdout), "a changed value: a difference");

  r = run({ ...NEW, "web/cloud/x/b.ts": "export const b = 1;\n// added\n" });
  ok(r.status === 1 && /b\.ts: 2 lines/.test(r.stdout), "an added line: a difference");

  r = run({ ...NEW, "web/cloud/x/c.ts": "x\n" });
  ok(r.status === 1 && /c\.ts: not in web\/x/.test(r.stdout), "a file only here: a difference");

  const { ["web/cloud/x/b.ts"]: _, ...noB } = NEW;
  r = run(noB);
  ok(r.status === 1 && /web\/x\/b\.ts: not in web\/cloud\/x/.test(r.stdout), "a file left behind: a difference");

  r = run({ ...NEW, "web/cloud/x/a.ts": 'import { b } from "./b.ts";\nexport const a = b + 2;\n' }, ["--emit-allow"]);
  const emitted = JSON.parse(r.stdout);
  ok(r.status === 1 && emitted.length === 1 && emitted[0].to === "export const a = b + 2;", "--emit-allow lists the one unexplained line");
  writeFileSync(join(root, "allow.json"), JSON.stringify(emitted));
  r = run({ ...NEW, "web/cloud/x/a.ts": 'import { b } from "./b.ts";\nexport const a = b + 2;\n' }, ["--allow", join(root, "allow.json")]);
  ok(r.status === 0 && /1 listed edits/.test(r.stdout), "a listed edit: equal");
  r = run(NEW, ["--allow", join(root, "allow.json")]);
  ok(r.status === 1 && /allow entry 0 .* matched no line/.test(r.stdout), "a listed edit no line has: a difference");

  r = run({ ...NEW, "web/cloud/x/test-x.mjs": NEW["web/cloud/x/test-x.mjs"].replace('import { dispatch } from "../../miniflare-dispatch.mjs";\n', 'import { dispatch } from "../../miniflare-dispatch.mjs";\nimport "./evil.mjs";\n') });
  ok(r.status === 1, "an added import: a difference (only the dispatch import is dropped)");

  r = run({ ...NEW, "web/cloud/x/test-x.mjs": "// ci: web-sync.1 order=1\n" + NEW["web/cloud/x/test-x.mjs"].replace("const mf = {};\n", "const mf = {};\n// ci: web-sync.2 order=1\n") });
  ok(r.status === 1, "a second ci header and one moved in among the lines: a difference");

  r = spawnSync(process.execPath, [script, cloud, sha, "web/x"], { cwd: core, encoding: "utf8" });
  ok(r.status === 2, "usage: exit 2");
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failed ? `FAILED: ${failed}` : "all check-move tests passed");
process.exit(failed ? 1 : 0);
