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
  // (chat plan PR 4a: an agent's runs of code, in Sagebrush's sandbox, on the pages that offer them: the notebook page)
  run_notebook: { description: "Run a notebook's code cells in order in Sagebrush's sandbox, which can't reach the network (beyond loading its own packages), and get each cell's result. In your own branch its outputs are saved into the branch's copy if the notebook hasn't changed meanwhile; anywhere else they are only returned. Its code may change files only where you may write and, for the person's own notebook, where they allowed it. Needs \"May run code\"; one run at a time in a page.", params: obj({ path: { type: "string", minLength: 1, maxLength: 4096, description: "the notebook" }, timeout_s: { type: "integer", minimum: 1, description: "seconds before it is stopped, 1 to 600 (120 if left out; over 600 is refused by the page)" } }, ["path"]) },
  run_file: { description: "Run a .py or .sage file in Sagebrush's sandbox, which can't reach the network (beyond loading its own packages), and get its output and exit status. Its code may change files only where you may write: in your own branch, the branch; a person's file, nothing. Needs \"May run code\"; one run at a time in a page.", params: obj({ path: { type: "string", minLength: 1, maxLength: 4096, description: "the .py or .sage file" }, timeout_s: { type: "integer", minimum: 1, description: "seconds before it is stopped, 1 to 600 (120 if left out; over 600 is refused by the page)" } }, ["path"]) },
  run_stop: { description: "Stop your run going in this page, if there is one.", params: obj({}, []) },
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
