// Runs one of web/share's MIT test suites against this directory's share server (MS-RSL), never a copy of it:
// web/share/serve-dev.mjs starts SHARE_DEV_ENTRY (test-entry.ts here) with SHARE_DEV_MIGRATIONS (the merged list,
// migrations.mjs) and checks, on that instance, that it is the hosted variant.  The run passes only if the suite exits 0,
// printed its completion line, and the server printed that it was the hosted variant with exactly the merged migrations,
// in order: a suite that never started its server, or returned early, fails here.
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrations } from "./migrations.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The verdict on a finished run: null when it passed, or why not. */
export function verdict({ status, stdout }, done, names) {
  if (status !== 0) return `the suite exited ${status}`;
  const lines = stdout.split("\n");
  const variant = lines.filter((l) => l.startsWith("share dev server: "));
  if (variant.length === 0) return "the suite never started the share dev server";
  const want = `share dev server: the hosted variant; migrations applied: ${names.join(",")}`;
  if (variant.some((l) => l !== want)) return `the server wasn't the hosted variant with the merged migrations: ${variant.find((l) => l !== want)}`;
  const end = lines.findLast((l) => done.test(l));
  if (!end) return "the suite's completion line is missing";
  const n = /(\d+)/.exec(end)?.[1];
  if (n !== undefined && Number(n) === 0) return "the suite ran no checks";
  return null;
}

/** Runs `suite` (absolute, or relative to this directory) with the hosted variant and exits with the verdict. */
export function runOnHosted(suite, done, { entry = join(here, "test-entry.ts"), list = migrations().map((m) => m.path) } = {}) {
  const env = { ...process.env, SHARE_DEV_ENTRY: entry, SHARE_DEV_MIGRATIONS: JSON.stringify(list), SHARE_DEV_EXPECT: "hosted" };
  delete env.SHARE_URL; // (a remote URL would skip the dev server: this run is about this directory's server)
  const r = spawnSync(process.execPath, [isAbsolute(suite) ? suite : join(here, suite), ...process.argv.slice(2)], { env, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], maxBuffer: 1 << 28 });
  process.stdout.write(r.stdout ?? "");
  const why = verdict({ status: r.status, stdout: r.stdout ?? "" }, done, list.map((p) => basename(p)));
  console.log(why ? `FAIL ${basename(suite)} on the hosted variant: ${why}` : `${basename(suite)} passed on the hosted variant`);
  process.exit(why ? 1 : 0);
}
