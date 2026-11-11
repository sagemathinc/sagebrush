// An agent on this computer, paired with the notebook page (design/workspace-agent-protocol.md): the shared pairing
// module (agent-ui.ts), in a chunk of its own, /sagebrush-agent.js, fetched only when the person asks to connect an
// agent, opens a ?pair= link, or has an agent remembered.
export { mountAgentPairing } from "./agent-ui";
// (and the run verbs' holder and line: the notebook page offers an agent's runs of code, chat plan PR 4a)
export { runVerbsFor } from "./run-holder";
