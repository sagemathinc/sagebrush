// ci: web-runner order=171 runner=bun
// What Connect an agent copies for the person's agent (agent-instruction.ts), exactly: on sagebrush.space the plain
// commands; on any other site, the commands that make sagebrush-mcp accept that site and send its link there; and every
// command one sagebrush-mcp accepts (engine/py/python/sagebrush/pairing.py's origins).
//   bun web/workspace/test-agent-instruction.mjs
import { agentInstruction, SITE, MCP_COMMAND } from "./agent-instruction.ts";

let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (c || detail === undefined ? "" : " " + JSON.stringify(detail))); if (!c) failures++; };

// (sagebrush.space: exactly this, word for word; a change here is a change to what every person pastes)
const prod = agentInstruction("https://sagebrush.space");
ok(prod === [
  "Connect to my Sagebrush workspace at https://sagebrush.space.",
  "",
  '1. Add the MCP server "sagebrush" (stdio, command: uvx sagebrush-mcp).',
  "   Claude Code: claude mcp add sagebrush -- uvx sagebrush-mcp",
  "   Codex: codex mcp add sagebrush -- uvx sagebrush-mcp",
  "   No uvx? Install uv (https://docs.astral.sh/uv/), or use: pipx run sagebrush-mcp",
  "2. If its tools aren't loaded in this session, ask me to restart you; I'll paste this again.",
  "3. Call its workspace_connect tool and give me the link it returns.",
].join("\n"), "sagebrush.space: the instruction, exactly", prod);
ok(SITE === "https://sagebrush.space" && MCP_COMMAND === "uvx sagebrush-mcp" && !/SAGEBRUSH_MCP_DEV_ORIGIN/.test(prod), "sagebrush.space needs no SAGEBRUSH_MCP_DEV_ORIGIN (sagebrush-mcp accepts it as it is)");

// (any other site: its origin in the first line and in SAGEBRUSH_MCP_DEV_ORIGIN, in the server's description and in
//  both commands, and nowhere a second origin)
for (const origin of ["https://dev.sagebrush.space", "https://cya.sagebrush.cloud", "http://localhost:8000"]) {
  const t = agentInstruction(origin);
  const env = `--env SAGEBRUSH_MCP_DEV_ORIGIN=${origin}`;
  ok(t.split("\n")[0] === `Connect to my Sagebrush workspace at ${origin}.`
    && t.includes(`(stdio, command: uvx sagebrush-mcp, environment: SAGEBRUSH_MCP_DEV_ORIGIN=${origin}).`)
    && t.includes(`   Claude Code: claude mcp add sagebrush ${env} -- uvx sagebrush-mcp`)
    && t.includes(`   Codex: codex mcp add sagebrush ${env} -- uvx sagebrush-mcp`)
    && t.split(origin).length - 1 === 4 && !t.includes("https://sagebrush.space"), `${origin}: its origin, in the first line, the server's environment and both commands`, t);
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
