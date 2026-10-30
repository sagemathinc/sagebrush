// An agent on this computer, paired with the LaTeX editor's page (design/workspace-agent-protocol.md): the shared
// pairing module (web/workspace/agent-ui.ts), in a chunk of its own, /sagebrush-latex-agent.js, fetched only when the
// person asks to connect an agent, opens a ?pair= link, or has an agent remembered.
export { mountAgentPairing } from "../workspace/agent-ui";
