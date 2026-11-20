// The agent the "computer" surface's runner starts: the reviewed sagebrush-agent (the package unpacked from
// engine/py/fixtures, its SHA-256 checked by surface-computer.mjs), run exactly as its own `--stdio` mode runs it,
// with one change: the model is a script. Nothing else is stood in for: its stdio framing, agent.ready, its turns and
// events, and its workspace tools, which call the page's verbs through the runner and the relay.
//
//   node --import <the package's stub deps> computer-agent.mjs PACKAGE_DIR SCRIPT_DIR
//
// SCRIPT_DIR is shared with the surface (both on this computer):
//   - at start, this agent writes started.json: its pid, its parent's (the runner) and this computer's name;
//   - each chat message starts a turn, which says "Working on <this computer's name>." and then takes the surface's
//     commands in order, cmd-<n>.json (n = 0, 1, ... across turns): { tool, args } is one call, by sagebrush-mcp's
//     name, made through the agent's own tools, its result written to res-<n>.json as { tool, as, text, isError };
//     { end: true, text } says the text and ends the turn.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [pkg, dir] = process.argv.slice(2);
if (!pkg || !dir) {
  console.error("usage: computer-agent.mjs PACKAGE_DIR SCRIPT_DIR");
  process.exit(2);
}
const lib = (f) => pathToFileURL(join(pkg, "lib", f)).href;
const { AgentServer, TEXT } = await import(lib("server.mjs"));
const { stdinChunks } = await import(lib("stdio.mjs"));
const { fakeCreateServer } = await import(lib("fake.mjs"));

const put = (name, value) => {
  // (written whole, then renamed: the surface never reads half a file)
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, join(dir, name));
};
put("started.json", { pid: process.pid, ppid: process.ppid, host: hostname() });

/** A case's call, by sagebrush-mcp's name, as this agent's own tools make it (null: it has no such tool). */
function translate(tool, args, have) {
  if (have[tool]) return [tool, args];
  if (tool === "workspace_create") {
    const c = args.content ?? {};
    if (c.json && /\.ipynb$/i.test(args.path)) {
      const cells = (c.json.cells ?? []).map((x) => (typeof x.markdown === "string" ? { type: "markdown", source: x.markdown } : { type: "code", source: String(x.code ?? x.source ?? "") }));
      return ["workspace_write_notebook", { path: args.path, mode: args.mode ?? c.json.mode ?? "python", cells }];
    }
    return ["workspace_write", { path: args.path, text: String(c.text ?? "") }];
  }
  return null;
}

let next = 0; // (the next command's number, across turns)
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
});

function scriptedQuery({ options }) {
  const signal = options.abortController?.signal;
  // (the agent's own MCP server: "sagebrush_page" from 0.7.5, "sagebrush" before; its tools are named after it)
  const server = options.mcpServers.sagebrush_page ? "sagebrush_page" : "sagebrush";
  const tools = options.mcpServers[server].handlers;
  const session = options.resume ?? `scripted-${process.pid}`;
  let index = 0;
  function* text(t) {
    const i = index++;
    yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: i, content_block: { type: "text", text: "" } } };
    yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: i, delta: { type: "text_delta", text: t } } };
    yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: i } };
  }
  async function* run() {
    yield { type: "system", subtype: "init", session_id: session, model: "scripted", tools: [] };
    yield* text(`Working on ${hostname()}.`);
    for (;;) {
      const n = next;
      const file = join(dir, `cmd-${n}.json`);
      while (!existsSync(file)) await sleep(25, signal);
      next++;
      const cmd = JSON.parse(readFileSync(file, "utf8"));
      if (cmd.end) {
        if (cmd.text) yield* text(String(cmd.text));
        put(`res-${n}.json`, { end: true });
        break;
      }
      const t = translate(cmd.tool, cmd.args ?? {}, tools);
      if (!t) { put(`res-${n}.json`, { tool: cmd.tool, text: `this agent has no tool ${cmd.tool}`, isError: true }); continue; }
      const [name, input] = t;
      const i = index++;
      const id = `toolu_${n}`;
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: i, content_block: { type: "tool_use", id, name: `mcp__${server}__${name}`, input: {} } } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: i } };
      const r = await tools[name](input);
      put(`res-${n}.json`, { tool: cmd.tool, as: name, text: (r.content ?? []).map((x) => x.text ?? "").join(""), isError: !!r.isError });
      yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: r.content, is_error: !!r.isError }] } };
    }
    yield { type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 1, output_tokens: 1 }, session_id: session };
  }
  return run();
}

// (as bin/sagebrush-agent.mjs runs --stdio)
const server = new AgentServer({ query: scriptedQuery, stdio: true });
server.createServer = fakeCreateServer;
let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  let problems;
  try { problems = await server.close(); } catch (e) { problems = [String(e?.message ?? e)]; }
  for (const p of problems) console.error(p);
  process.exit(problems.length ? 1 : code);
};
const fatal = (t) => { console.error(t); stop(1); };
process.stdout.on("error", () => stop(0));
process.on("SIGINT", () => server.stopTurns());
process.once("SIGTERM", () => stop(0));
await server.serveStdio({ input: stdinChunks(), output: process.stdout, fatal });
if (!server.stdioStarted) fatal(TEXT.badStart);
else stop(0);
