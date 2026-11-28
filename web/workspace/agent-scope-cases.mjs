// The agent scope rule's table (agent-scope.ts), shared by every call site's tests: the sync server's endpoint today,
// and a device answering a relayed verb once grants are sealed to the person's devices. Each row: the grant's scopes,
// the call's raw path, the access it needs, and scopeCheck's verdict.
export const SCOPE_CASES = [
  // (the reserved folder: refused before any scope, "/" included)
  { scopes: [["/", "write"]], path: "/.agents", need: "read", verdict: "reserved" },
  { scopes: [["/", "write"]], path: "/.agents/x", need: "read", verdict: "reserved" },
  { scopes: [["/", "write"]], path: "/.agents/memory/agent/a/n.md", need: "write", verdict: "reserved" },
  { scopes: [["/A", "read"]], path: "/.agents/x", need: "read", verdict: "reserved" },
  // (siblings and nested folders of the same name are ordinary)
  { scopes: [["/", "write"]], path: "/.agents-x", need: "write", verdict: "in" },
  { scopes: [["/", "write"]], path: "/.agentsX/y", need: "write", verdict: "in" },
  { scopes: [["/", "write"]], path: "/.Agents", need: "write", verdict: "in" },
  { scopes: [["/", "write"]], path: "/x/.agents/y", need: "write", verdict: "in" },
  // (the ordinary match: whole segments, read is read only)
  { scopes: [["/A", "read"]], path: "/A/x", need: "read", verdict: "in" },
  { scopes: [["/A", "read"]], path: "/A/x", need: "write", verdict: "out" },
  { scopes: [["/A", "write"]], path: "/A2", need: "read", verdict: "out" },
  // (not a workspace path: invalid before anything else; normPath refuses "." and ".." names and empty segments rather
  // than resolve them, so no other spelling reaches the reserved folder)
  { scopes: [["/", "write"]], path: "/x/../.agents/y", need: "read", verdict: "invalid" },
  { scopes: [["/", "write"]], path: "/./.agents", need: "read", verdict: "invalid" },
  { scopes: [["/", "write"]], path: "//.agents", need: "read", verdict: "invalid" },
  { scopes: [["/", "write"]], path: "relative/.agents", need: "read", verdict: "invalid" },
  { scopes: [["/", "write"]], path: 7, need: "read", verdict: "invalid" },
];
