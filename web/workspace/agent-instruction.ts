// What "Connect an agent" copies for the person's own coding agent: one instruction, for any agent with MCP, that adds
// sagebrush-mcp (the package on PyPI, run with uvx), then asks for the one-time pairing link its workspace_connect tool
// gives (engine/py/python/sagebrush/workspace_tools.py). The person pastes it into the agent and opens the link.
//
// sagebrush-mcp accepts pages from https://sagebrush.space only, unless SAGEBRUSH_MCP_DEV_ORIGIN names one more
// (engine/py/python/sagebrush/pairing.py: the development site, a preview site or a local server), so on any other site
// the commands set it to that site's origin, and the link it gives opens there.

export const SITE = "https://sagebrush.space";
export const MCP_COMMAND = "uvx sagebrush-mcp";

/** The instruction for a page at `origin`. */
export function agentInstruction(origin: string): string {
  const env = origin === SITE ? "" : ` --env SAGEBRUSH_MCP_DEV_ORIGIN=${origin}`;
  return [
    `Connect to my Sagebrush workspace at ${origin}.`,
    "",
    `1. Add the MCP server "sagebrush" (stdio, command: ${MCP_COMMAND}${env ? `, environment: SAGEBRUSH_MCP_DEV_ORIGIN=${origin}` : ""}).`,
    `   Claude Code: claude mcp add sagebrush${env} -- ${MCP_COMMAND}`,
    `   Codex: codex mcp add sagebrush${env} -- ${MCP_COMMAND}`,
    "   No uvx? Install uv (https://docs.astral.sh/uv/), or use: pipx run sagebrush-mcp",
    "2. If its tools aren't loaded in this session, ask me to restart you; I'll paste this again.",
    "3. Call its workspace_connect tool and give me the link it returns.",
  ].join("\n");
}
