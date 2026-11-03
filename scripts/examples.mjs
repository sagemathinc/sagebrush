// The examples gallery's runner (plan U7 final f8c4313e, section 2 and appendix A5): the one way to run
// an example, and the one way to refresh what is committed for it.
//
//   node scripts/examples.mjs validate [--root DIR]
//       every example's id, manifest (by kind), files, sizes and tags
//   node scripts/examples.mjs run ID... [--root DIR] [--update]
//       run each from source in a fresh copy and compare with what is committed:
//         notebook  its code cells on a fresh session; the normalized outputs must equal the committed ones
//         board     `sagebrush board check --json` (an older board: `board run`): every code item runs and every
//                   check passes; it renders
//         latex     `latex run` (executable features), then `latex check` (no errors) and `latex render`,
//                   whose HTML must equal the committed preview.html byte for byte, but for KaTeX's shared
//                   stylesheet, which the committed one holds as a marker (committedPreview: r4.1)
//       --update rewrites the committed outputs or preview.html from the run (the diff shows in the PR)
//   node scripts/examples.mjs ci --shard K --of N --ran FILE [--root DIR]
//       CI's shard: the selected ids (EXAMPLES_IDS, a JSON list) at positions i mod N == K - 1, run 2 at a
//       time, each killed at 30 s; the ids it ran written to FILE
//   node scripts/examples.mjs census --ran-dir DIR
//       every selected id (EXAMPLES_IDS) ran exactly once across the shards' FILEs, at most 24 each
//
// Needs `pnpm run build` (dist/) first; boards and LaTeX run through dist/src/cli.js.
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ID,
  SLUG_MAX,
  census,
  committedOutputs,
  committedPreview,
  folderFiles,
  notebookFormProblem,
  previewMarkProblem,
  SHARED_CSS,
  leaks,
  listExamples,
  manifestProblems,
  normalizeNotebook,
  sha256,
  shardIds,
  sizeProblems,
} from "./examples-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const CLI = join(repo, "dist", "src", "cli.js");
/** each example's whole run, killed (SIGKILL) at this */
export const DEADLINE_MS = Math.min(
  30_000,
  Number(process.env.EXAMPLES_DEADLINE_MS) || 30_000,
); // (a test may lower it, never raise it)
const CONCURRENCY = 2;

const arg = (argv, name, dflt) => {
  const i = argv.indexOf(name);
  return i < 0 ? dflt : argv[i + 1];
};

function validate(root) {
  const tags = JSON.parse(readFileSync(join(root, "tags.json"), "utf8"));
  const problems = [];
  const sharedSha = existsSync(join(root, SHARED_CSS)) ? sha256(readFileSync(join(root, SHARED_CSS))) : null;
  for (const e of listExamples(root)) {
    if (!ID.test(e.id) || e.slug.length > SLUG_MAX)
      problems.push(
        `${e.id}: not an id (kind/slug, slug lowercase words and hyphens, at most ${SLUG_MAX})`,
      );
    if (e.error) {
      problems.push(`${e.id}: ${e.error}`);
      continue;
    }
    for (const p of manifestProblems(
      e.manifest,
      e.kind,
      folderFiles(e.dir),
      tags,
    ))
      problems.push(`${e.id}: ${p}`);
    for (const p of sizeProblems(e.dir, e.manifest))
      problems.push(`${e.id}: ${p}`);
    // (a notebook in the runner's own form, so its sizes are what they are; a preview whose marker names the
    // corpus's one shared stylesheet: r4.1)
    if (e.kind === "notebook" && /\.ipynb$/.test(e.manifest.main ?? "") && existsSync(join(e.dir, e.manifest.main))) {
      const why = notebookFormProblem(readFileSync(join(e.dir, e.manifest.main), "utf8"));
      if (why) problems.push(`${e.id}: ${e.manifest.main}: ${why}`);
    }
    if (e.kind === "latex" && existsSync(join(e.dir, "preview.html"))) {
      const why = previewMarkProblem(readFileSync(join(e.dir, "preview.html"), "utf8"), sharedSha);
      if (why) problems.push(`${e.id}: ${why}`);
    }
    // (a .board.json is the current format, which `board check` checks; without its header the runner
    // would take it for an older board)
    if (e.kind === "board" && /\.board\.json$/.test(e.manifest.main ?? "")) {
      let format;
      try {
        format = JSON.parse(readFileSync(join(e.dir, e.manifest.main), "utf8")).format;
      } catch {}
      if (format !== "sagebrush-board")
        problems.push(`${e.id}: main: a .board.json needs "format": "sagebrush-board"`);
    }
  }
  return problems;
}

/**
 * CI's selection (EXAMPLES_IDS, from ci-paths), or why it isn't one. The jobs run only for a selection that isn't
 * empty, so an empty or missing one is a wiring fault (an output the changes job didn't export reads as ''), and
 * a census of it would pass with nothing run (grader B2)
 */
function selectedIds() {
  const raw = process.env.EXAMPLES_IDS ?? "";
  let ids;
  try {
    ids = JSON.parse(raw);
  } catch {}
  if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== "string"))
    return `EXAMPLES_IDS is ${JSON.stringify(raw)}, not the selection (a JSON list of ids, not empty): is it among the changes job's outputs?`;
  return ids;
}

/** run a command with a deadline (SIGKILL) and a scrubbed environment: {code, out, err, killed} */
function sh(cmd, args, { cwd, env, deadline }) {
  return new Promise((resolve) => {
    const ms = Math.max(1, deadline - Date.now());
    const p = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "",
      err = "",
      killed = false;
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => {
      killed = true;
      p.kill("SIGKILL");
    }, ms);
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out, err, killed });
    });
  });
}

const tail = (s) => s.trim().split("\n").slice(-6).join("\n");

/** one example: {id, ok, problems[]} (and with update, what it rewrote) */
export async function runExample(root, id, { update = false } = {}) {
  const e = listExamples(root).find((x) => x.id === id);
  if (!e || e.error)
    return { id, ok: false, problems: [e ? e.error : "no such example"] };
  const m = e.manifest;
  const deadline = Date.now() + DEADLINE_MS;
  const tmp = mkdtempSync(
    join(process.env.RUNNER_TEMP || tmpdir(), "example-"),
  );
  const work = join(tmp, "work");
  cpSync(e.dir, work, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: tmp,
    TMPDIR: tmp,
    TZ: "UTC",
    LANG: "C.UTF-8",
    ...(process.env.CHROME ? { CHROME: process.env.CHROME } : {}),
  };
  const problems = [];
  const date = new Date().toISOString().slice(0, 10);
  try {
    if (e.kind === "notebook") {
      const seed = sha256(id);
      const outFile = join(tmp, "outputs.json");
      const r = await sh(
        process.execPath,
        [
          join(here, "examples-notebook-child.mjs"),
          work,
          m.main,
          m.mode,
          seed,
          outFile,
        ],
        { cwd: work, env, deadline },
      );
      if (r.killed) problems.push(`killed at ${DEADLINE_MS / 1000} s`);
      else if (r.code !== 0 || !existsSync(outFile))
        problems.push(`the run failed (exit ${r.code}): ${tail(r.err)}`);
      else {
        const fresh = JSON.parse(readFileSync(outFile, "utf8"));
        const committed = JSON.parse(readFileSync(join(e.dir, m.main), "utf8"));
        const freshNb = { ...committed, cells: [] };
        let ci = 0;
        for (const c of committed.cells)
          freshNb.cells.push(
            c.cell_type === "code"
              ? { ...c, execution_count: null, outputs: committedOutputs(fresh[ci++]) }
              : c,
          );
        const fn = normalizeNotebook(freshNb, m.loose ?? []);
        for (const [i, c] of fn.entries())
          if (c.error) problems.push(`cell ${i + 1} raised ${c.error}`);
        for (const l of leaks(fn, { tmp, date, host: hostname(), checkout: realpathSync(repo) }))
          problems.push(`an output holds ${l}`);
        for (const [cell, want] of Object.entries(m.expect ?? {})) {
          const got = JSON.stringify(fn[Number(cell)] ?? []);
          if (!got.includes(JSON.stringify(String(want)).slice(1, -1)))
            problems.push(
              `cell ${cell}: the output doesn't contain ${JSON.stringify(want)}`,
            );
        }
        if (update && !problems.length)
          writeFileSync(
            join(e.dir, m.main),
            JSON.stringify(freshNb, null, 1) + "\n",
          );
        else {
          // (which code cell first differs, and how: a CI log says what changed, not only that something did)
          const cn = normalizeNotebook(committed, m.loose ?? []);
          const at = fn.findIndex((c, i) => JSON.stringify(c) !== JSON.stringify(cn[i]));
          if (at >= 0 || fn.length !== cn.length)
            problems.push(
              `the outputs differ from the committed ones, first at code cell ${at >= 0 ? at + 1 : fn.length + 1}: ` +
                `now ${JSON.stringify(fn[at] ?? null).slice(0, 300)}, committed ${JSON.stringify(cn[at] ?? null).slice(0, 300)} ` +
                `(node scripts/examples.mjs run ${id} --update rewrites them)`,
            );
        }
      }
    } else if (e.kind === "board") {
      // (a board in the current format: `board check`, which runs its code items and checks the rest; an older
      // board, which check refuses for its missing header: `board run`. The verdict needs both the exit code
      // and the report's own `ok`)
      const text = readFileSync(join(work, m.main), "utf8");
      let current = false;
      try {
        current = JSON.parse(text).format === "sagebrush-board";
      } catch {}
      const r = await sh(
        process.execPath,
        [
          CLI,
          "board",
          current ? "check" : "run",
          m.main,
          "--json",
          "--timeout",
          String(DEADLINE_MS / 1000),
        ],
        { cwd: work, env, deadline },
      );
      let report = null;
      try {
        report = JSON.parse(r.out);
      } catch {}
      if (r.killed) problems.push(`killed at ${DEADLINE_MS / 1000} s`);
      else if (r.code !== 0 || report?.ok !== true) {
        const why =
          report?.problems?.map((x) => x.message) ??
          report?.items
            ?.filter((i) => i.status !== "ok")
            .map((i) => `${i.id}: ${i.status}`) ??
          [];
        problems.push(
          `board ${current ? "check" : "run"} failed (exit ${r.code}, ok ${report?.ok}): ${why.slice(0, 4).join("; ") || tail(r.out + r.err)}`,
        );
      }
      const g = r.killed
        ? null
        : await sh(
            process.execPath,
            [
              CLI,
              "board",
              "render",
              m.main,
              "--svg",
              "-o",
              join(tmp, "board.svg"),
            ],
            { cwd: work, env, deadline },
          );
      if (g && (g.killed || g.code !== 0))
        problems.push(`board render failed: ${tail(g.err)}`);
    } else {
      if (
        (m.features ?? []).some((f) =>
          ["sagetex", "pythontex", "matlab"].includes(f),
        )
      ) {
        const r = await sh(
          process.execPath,
          [
            CLI,
            "latex",
            "run",
            m.main,
            "--timeout",
            String(DEADLINE_MS / 1000),
          ],
          { cwd: work, env, deadline },
        );
        if (r.killed) problems.push(`killed at ${DEADLINE_MS / 1000} s`);
        else if (r.code !== 0)
          problems.push(
            `latex run failed (exit ${r.code}): ${tail(r.out + r.err)}`,
          );
      }
      if (!problems.length) {
        const c = await sh(
          process.execPath,
          [CLI, "latex", "check", m.main, "--json"],
          { cwd: work, env, deadline },
        );
        if (c.killed || c.code !== 0)
          problems.push(
            `latex check: ${c.killed ? "killed" : tail(c.out + c.err)}`,
          );
        const html = join(tmp, "preview.html");
        const r = await sh(
          process.execPath,
          [CLI, "latex", "render", m.main, "-o", html],
          { cwd: work, env, deadline },
        );
        if (r.killed || r.code !== 0)
          problems.push(`latex render: ${r.killed ? "killed" : tail(r.err)}`);
        else {
          const { html: page, fonts } = committedPreview(readFileSync(html, "utf8"));
          // (the corpus's one copy of the stylesheet: each render's must be it, byte for byte; --update writes it)
          const sharedFile = join(root, SHARED_CSS);
          if (!fonts) problems.push("latex render: not one KaTeX stylesheet to share (scripts/examples-lib.mjs committedPreview)");
          else if (update && !problems.length) {
            if (!existsSync(sharedFile) || readFileSync(sharedFile, "utf8") !== fonts) {
              mkdirSync(dirname(sharedFile), { recursive: true });
              writeFileSync(sharedFile, fonts);
            }
          } else if (!existsSync(sharedFile))
            problems.push(`examples/${SHARED_CSS} is missing (node scripts/examples.mjs run ${id} --update writes it)`);
          else if (readFileSync(sharedFile, "utf8") !== fonts)
            problems.push(
              `the render's KaTeX stylesheet (${sha256(fonts).slice(0, 12)}) isn't examples/${SHARED_CSS} (${sha256(readFileSync(sharedFile)).slice(0, 12)}): --update rewrites it, and then every LaTeX preview`,
            );
          const got = Buffer.from(page);
          if (update && !problems.length)
            writeFileSync(join(e.dir, "preview.html"), got);
          else if (
            !existsSync(join(e.dir, "preview.html")) ||
            sha256(got) !== sha256(readFileSync(join(e.dir, "preview.html")))
          )
            problems.push(
              `preview.html differs from the render (node scripts/examples.mjs run ${id} --update rewrites it)`,
            );
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { id, ok: problems.length === 0, problems };
}

async function runMany(root, ids, opts) {
  const results = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, ids.length) },
    async () => {
      while (next < ids.length) {
        const id = ids[next++];
        const t = Date.now();
        const r = await runExample(root, id, opts);
        console.log(
          `${r.ok ? "ok  " : "FAIL"} ${id} (${((Date.now() - t) / 1000).toFixed(1)} s)${r.ok ? "" : "\n  " + r.problems.join("\n  ")}`,
        );
        results.push(r);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function main(argv) {
  const cmd = argv[0];
  const root = arg(argv, "--root", join(repo, "examples"));
  if (cmd === "validate") {
    const p = validate(root);
    for (const x of p) console.error(x);
    console.log(
      `${listExamples(root).length} examples: ${p.length ? p.length + " problems" : "ok"}`,
    );
    return p.length ? 1 : 0;
  }
  if (cmd === "run") {
    const ids = argv
      .slice(1)
      .filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--root");
    const results = await runMany(root, ids, {
      update: argv.includes("--update"),
    });
    return results.every((r) => r.ok) ? 0 : 1;
  }
  if (cmd === "ci") {
    const k = Number(arg(argv, "--shard")),
      n = Number(arg(argv, "--of"));
    const selected = selectedIds();
    if (typeof selected === "string") {
      console.error(selected);
      return 1;
    }
    const ids = shardIds(selected, k, n);
    const p = validate(root);
    if (p.length) {
      for (const x of p) console.error(x);
      return 1;
    }
    console.log(`shard ${k} of ${n}: ${ids.length} examples`);
    const results = await runMany(root, ids, {});
    mkdirSync(dirname(arg(argv, "--ran")), { recursive: true });
    writeFileSync(
      arg(argv, "--ran"),
      JSON.stringify(results.map((r) => r.id)) + "\n",
    );
    return results.every((r) => r.ok) ? 0 : 1;
  }
  if (cmd === "census") {
    const dir = arg(argv, "--ran-dir");
    const lists = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
    const selected = selectedIds();
    if (typeof selected === "string") {
      console.error(selected);
      return 1;
    }
    const p = census(selected, lists);
    for (const x of p) console.error(x);
    console.log(
      `census: ${lists.length} shards, ${lists.flat().length} runs: ${p.length ? "FAIL" : "ok"}`,
    );
    return p.length ? 1 : 0;
  }
  console.error(
    "usage: node scripts/examples.mjs validate | run ID... [--update] | ci --shard K --of N --ran FILE | census --ran-dir DIR  [--root DIR]",
  );
  return 2;
}

// (as a script by any path to it, a symlink included: the raw argv[1] compare ran nothing through one)
const isMain = () => {
  try {
    return (
      basename(process.argv[1]) === "examples.mjs" ||
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
};
if (isMain()) process.exitCode = await main(process.argv.slice(2));
