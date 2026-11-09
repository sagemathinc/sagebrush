// An agent on this computer, paired with the notebook page (design/workspace-agent-protocol.md): the shared pairing
// module (agent-ui.ts), in a chunk of its own, /sagebrush-agent.js, fetched only when the person asks to connect an
// agent, opens a ?pair= link, or has an agent remembered.
export { mountAgentPairing } from "./agent-ui";
