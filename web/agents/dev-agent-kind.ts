// A check build's ?agent=<kind> on the Agents page: which of a computer's agents ("claude", "codex", ...) the page asks
// its runner for when it chats there. It picks the kind only: the leg names it in its hello and the runner's answer
// decides (a kind the runner doesn't offer is refused there); what the agent may do is the grant's, as for any agent.
// Without the parameter, or with a name that isn't a kind's, the page asks for none (the runner's first kind).

/** The runner's own pattern for a kind's name (its --agent NAME). */
const KIND = /^[a-z][a-z0-9-]{0,15}$/;

/** The kind ?agent= names in `search` (location.search), or undefined. */
export function devAgentKind(search: string): string | undefined {
  const v = new URLSearchParams(search).get("agent");
  return v !== null && KIND.test(v) ? v : undefined;
}

/** A kind as the picker names it before connecting: Claude, Codex, else the kind as given. */
export function kindLabel(kind: string | undefined): string {
  if (kind === undefined || kind === "claude") return "Claude";
  if (kind === "codex") return "Codex";
  return kind;
}
