// The workspace's verbs as agents call them (design/workspace-files.md §8.2;
// the wire protocol, design/workspace-agent-protocol.md): one description,
// from which web/workspace/schema.json is written (sagebrush-mcp's tools are
// made from that file, and the page checks every call against it).  The
// verbs are Workspace.forAgent's (api.ts), minus watch and ops, which agents
// get otherwise (a subscription, the log).  Nothing here is a verb a person
// alone may use (dropVersions, emptying Trash, forget).
//   bun web/workspace/verbs.ts --write    (schema.json written again)
// web/workspace/test-workspace.mjs fails when schema.json is stale.

import { MAX_PATH, MAX_DEPTH, MAX_NAME } from "./paths";

/** At most this much content (a document's JSON, a file's bytes) in one call, either way: more is refused with its size, never cut. */
export const MAX_CONTENT_BYTES = 8 * 2 ** 20;
/** One WebSocket frame: 8 MiB of bytes is about 10.7 MiB as base64, with the JSON around it (agreed with sagebrush-python). */
export const MAX_FRAME_BYTES = 12 * 2 ** 20;
/** Entries in one list() answer; more come with {more: true, cursor}. */
export const MAX_LIST = 10_000;
/** Versions in one history() answer. */
export const MAX_HISTORY = 100;

const path = { type: "string", minLength: 1, maxLength: 1024, pattern: "^/", description: "A workspace path: absolute, \"/\"-separated" };
// a document's content (a notebook's {cells, ...} or a board's JSON), or a data file's bytes as text or base64
const content = {
  description: "A notebook's document ({cells: [...]}) or a board's JSON as {json}; a data file's bytes as {text} (UTF-8) or {base64}",
  oneOf: [
    { type: "object", required: ["json"], properties: { json: { type: "object" } }, additionalProperties: false },
    { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
    { type: "object", required: ["base64"], properties: { base64: { type: "string", pattern: "^[A-Za-z0-9+/]*={0,2}$" } }, additionalProperties: false },
  ],
};
const obj = (props: Record<string, unknown>, required: string[]) => ({ type: "object", properties: props, required, additionalProperties: false });

export const VERBS = {
  list: { description: "The entries in a folder (with recursive, everything under it), by path; Trash only when listed itself.", params: obj({ folder: path, recursive: { type: "boolean" }, cursor: { type: "string" } }, ["folder"]) },
  stat: { description: "One entry, or null.", params: obj({ path }, ["path"]) },
  read: { description: "An entry and its contents, with the revision to give write as base.", params: obj({ path }, ["path"]) },
  write: { description: "New contents for a notebook, board or data file, only if its revision is still base (else a conflict, with the current contents). A data file's old bytes are kept as a version.", params: obj({ path, content, base: { type: "integer", minimum: 0 } }, ["path", "content", "base"]) },
  create: { description: "A new notebook (.ipynb), board (.board.json) or data file, its kind from its name; a taken path is refused.", params: obj({ path, content, mode: { enum: ["python", "sage", "magma", "matlab"] } }, ["path"]) },
  mkdir: { description: "A folder, and any above it that aren't there.", params: obj({ path }, ["path"]) },
  rename: { description: "An entry (a folder with all it holds) moved to a free path.", params: obj({ from: path, to: path }, ["from", "to"]) },
  duplicate: { description: "A copy of a notebook, board or data file, at to (else the first free \"name (2)\" beside it).", params: obj({ path, to: path }, ["path"]) },
  remove: { description: "An entry put in Trash; nothing of its contents removed.", params: obj({ path }, ["path"]) },
  restore: { description: "An entry in Trash put back where it was (or beside what took its place).", params: obj({ path }, ["path"]) },
  history: { description: "A data file's kept versions, in the order kept.", params: obj({ path, cursor: { type: "string" } }, ["path"]) },
  version: { description: "The bytes of one of a data file's versions (an index into history).", params: obj({ path, index: { type: "integer", minimum: 0 } }, ["path", "index"]) },
} as const;

/** schema.json: the verbs, their parameters' JSON Schemas, and the limits. */
export function schema() {
  return {
    $comment: "Written by web/workspace/verbs.ts (bun web/workspace/verbs.ts --write); do not edit.",
    protocol: 1,
    limits: { maxContentBytes: MAX_CONTENT_BYTES, maxFrameBytes: MAX_FRAME_BYTES, maxPath: MAX_PATH, maxDepth: MAX_DEPTH, maxName: MAX_NAME, maxList: MAX_LIST, maxHistory: MAX_HISTORY, inFlight: 8, perSecond: 100, burst: 200 },
    verbs: Object.fromEntries(Object.entries(VERBS).map(([name, v]) => [`workspace.${name}`, { description: v.description, params: { $schema: "https://json-schema.org/draft/2020-12/schema", ...v.params } }])),
  };
}
export const schemaText = () => JSON.stringify(schema(), null, 2) + "\n";

// (only when run itself, `bun web/workspace/verbs.ts --write`: without import.meta or a top-level await, so this
// file also type-checks where the page's agent modules are checked, tsconfig.web.json)
const run = typeof process !== "undefined" ? process.argv?.[1] ?? "" : "";
if (/(^|[\\/])verbs\.ts$/.test(run) && process.argv.includes("--write")) {
  void import("node:fs").then(({ writeFileSync }) => {
    writeFileSync(run.replace(/verbs\.ts$/, "schema.json"), schemaText());
    console.log("wrote web/workspace/schema.json");
  });
}
