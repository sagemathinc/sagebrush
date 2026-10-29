// The questions preview's build flag (web/build.ts): a flagged build puts the page in
// web/dist/questions, and an ordinary build after it removes it again (dist isn't
// cleared between builds). Runs `bun web/build.ts` three times: flagged, ordinary, flagged.
//   node web/test-questions-flag.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const page = join(here, "dist", "questions", "index.html"), dir = join(here, "dist", "questions");
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const build = (flagged) => {
  const env = { ...process.env };
  delete env.SAGEBRUSH_QUESTIONS; delete env.SAGEBRUSH_PREVIEW_HOST;
  if (flagged) env.SAGEBRUSH_QUESTIONS = "1";
  execFileSync("bun", [join(here, "build.ts")], { env, stdio: ["ignore", "ignore", "inherit"] });
};

build(true);
ok(existsSync(page), "a flagged build (SAGEBRUSH_QUESTIONS=1) puts the page in dist/questions");
build(false);
ok(!existsSync(dir), `an ordinary build after it removes dist/questions${existsSync(dir) ? ` (left: ${readdirSync(dir).join(", ")})` : ""}`);
build(true);
ok(existsSync(page), "a flagged build after that puts it back");
