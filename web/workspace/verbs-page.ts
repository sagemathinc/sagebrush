// The verbs a page does itself, beside the facade's (verbs.ts), and schema.json written with them all: kept apart from
// verbs.ts so that a page's pairing chunk, which compiles verbs.ts's schema, carries none of them.
//   bun web/workspace/verbs-page.ts --write    (schema.json written again)

import { VERBS, obj, schema } from "./verbs";

/** The verbs the page does itself, with the workspace's host-only methods (git-branch.ts), rather than through
 * Workspace.forAgent's facade, and only on the pages that offer them: never facade methods (the drift check in
 * test-workspace*.mjs leaves out these alone), and not in the schema the pairing compiles (verbs.ts's), so that a page's
 * pairing chunk carries none of them; schema.json, sagebrush-mcp's tools, has them all. */
export const PAGE_VERBS = {
  git_branch: { description: "A branch of the workspace to work in: a copy of main (what the grant lets you read, except /Branches, /Trash and /Proposals) at /Branches/<name>/. Only you, under this grant, may change it; main stays as it is. Name it for what the work is about; a taken name is refused.", params: obj({ name: { type: "string", minLength: 1, maxLength: 40, pattern: "^[a-z0-9][a-z0-9-]{0,39}$", description: "1 to 40 of a-z, 0-9 and -, starting with a letter or digit" } }, ["name"]) },
  // (a branch's history and its review by the person, on the pages that offer branches)
  git_commit: { description: "Commit your branch /Branches/<name>/ as it is now. With review: true, ask the person to review it: they decide on each file. A commit with nothing changed records nothing.", params: obj({ name: { type: "string", minLength: 1, maxLength: 40, pattern: "^[a-z0-9][a-z0-9-]{0,39}$", description: "the branch's name, as given to git_branch" }, message: { type: "string", minLength: 1, maxLength: 10000, description: "what the commit does; its first line is the review's title" }, review: { type: "boolean", description: "ask the person to review it" } }, ["name", "message"]) },
  git_status: { description: "Where your branch stands: open, review, accepted, partly-accepted, rejected or changes-requested; the person's decision and reason for each file of the commit they reviewed, and their note; and whether main has changed since the branch began.", params: obj({ name: { type: "string", minLength: 1, maxLength: 40, pattern: "^[a-z0-9][a-z0-9-]{0,39}$", description: "the branch's name" } }, ["name"]) },
  git_wait: { description: "Wait for the person's decision on your branch while it asks for review: returns as soon as they decide, or after seconds (at most 50; call again to keep waiting), with what git_status says.", params: obj({ name: { type: "string", minLength: 1, maxLength: 40, pattern: "^[a-z0-9][a-z0-9-]{0,39}$", description: "the branch's name" }, seconds: { type: "integer", minimum: 1, description: "how long to wait, 1 to 50 (50 if left out; over 50 is refused by the page)" } }, ["name"]) },
  // (chat plan PR 4a: an agent's runs of code, in Sagebrush's sandbox, on the pages that offer them: the notebook page)
  run_notebook: { description: "Run a notebook's code cells in order in Sagebrush's sandbox, which can't reach the network (beyond loading its own packages), and get each cell's result. In your own branch its outputs are saved into the branch's copy if the notebook hasn't changed meanwhile; anywhere else they are only returned. Its code may change files only where you may write and, for the person's own notebook, where they allowed it. Needs \"May run code\"; one run at a time in a page.", params: obj({ path: { type: "string", minLength: 1, maxLength: 4096, description: "the notebook" }, timeout_s: { type: "integer", minimum: 1, description: "seconds before it is stopped, 1 to 600 (120 if left out; over 600 is refused by the page)" } }, ["path"]) },
  run_file: { description: "Run a .py or .sage file in Sagebrush's sandbox, which can't reach the network (beyond loading its own packages), and get its output and exit status. Its code may change files only where you may write: in your own branch, the branch; a person's file, nothing. Needs \"May run code\"; one run at a time in a page.", params: obj({ path: { type: "string", minLength: 1, maxLength: 4096, description: "the .py or .sage file" }, timeout_s: { type: "integer", minimum: 1, description: "seconds before it is stopped, 1 to 600 (120 if left out; over 600 is refused by the page)" } }, ["path"]) },
  run_stop: { description: "Stop your run going in this page, if there is one.", params: obj({}, []) },
  // (chat plan PR 4b: a .tex built as Sagebrush's LaTeX editor shows it, its SageTeX code run in the sandbox)
  latex_build: { description: "Build a .tex as Sagebrush's LaTeX editor shows it: the check report (problems with their lines, beamer frames) and up to 4 pages or frames as PNG images. Its SageTeX and Python code items run in Sagebrush's sandbox, which can't reach the network (beyond loading its own packages). Their code may change files only where you may write: in your own branch, the branch; a person's file, nothing. In your own branch the results file is saved beside the .tex if the .tex hasn't changed meanwhile; anywhere else nothing is saved. Needs \"May run code\"; one run at a time in a page.", params: obj({ path: { type: "string", minLength: 1, maxLength: 4096, description: "the .tex file" }, pages: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 4, description: "page or frame numbers, from 1 (the first if left out)" }, timeout_s: { type: "integer", minimum: 1, description: "seconds before it is stopped, 1 to 600 (120 if left out; over 600 is refused by the page)" } }, ["path"]) },
} as const;

/** schema.json's text: every verb, the facade's and the pages'. */
export const schemaText = () => JSON.stringify(schema({ ...VERBS, ...PAGE_VERBS }), null, 2) + "\n";

// (only when run itself, `bun web/workspace/verbs-page.ts --write`: without import.meta or a top-level await, as verbs.ts was)
const run = typeof process !== "undefined" ? process.argv?.[1] ?? "" : "";
if (/(^|[\\/])verbs-page\.ts$/.test(run) && process.argv.includes("--write")) {
  void import("node:fs").then(({ writeFileSync }) => {
    writeFileSync(run.replace(/verbs-page\.ts$/, "schema.json"), schemaText());
    console.log("wrote web/workspace/schema.json");
  });
}
