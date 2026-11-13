// Your enrolled computers (`sagebrush remote login`) and the relay's page legs to them, for the pages that open one:
// the terminal panel (web/notebook/remote-terminal-view.ts) and the Agents page's Chat here (agent-relay.ts). Kept
// apart from either, so neither page loads the other's code.

export interface Runner {
  remote_id: string;
  name: string;
  /** the agent kinds it last reported, in its order ([] for none): a hint for a picker, never a choice, since a page
   *  asks for a kind by name and the runner's hello answer decides */
  agents: string[];
  /** when it reported them (ms), or null */
  agents_at: number | null;
}

/** The runner's own agent-name pattern and its most kinds (relay.py's AGENT_NAME and AGENT_KINDS). */
const AGENT_NAME = /^[a-z][a-z0-9-]{0,15}$/;
const AGENT_KINDS = 4;

/** A peer's agents as the page takes them: a list of at most AGENT_KINDS unique valid names, else [] (and its time,
 *  a non-negative whole number of ms, only with such a list). */
export function runnerAgents(p: any): { agents: string[]; agents_at: number | null } {
  const a = p?.agents;
  const ok = Array.isArray(a) && a.length <= AGENT_KINDS && a.every((n: unknown) => typeof n === "string" && AGENT_NAME.test(n)) && new Set(a).size === a.length;
  if (!ok || a.length === 0) return { agents: [], agents_at: null };
  return { agents: [...a], agents_at: Number.isSafeInteger(p.agents_at) && p.agents_at >= 0 ? p.agents_at : null };
}

/** Your enrolled computers: GET /api/remote/v1/peers (this site, its session cookie), kind "runner" only.  Signed out,
 *  it throws an error marked signedOut. */
export async function listRunners(f: typeof fetch = fetch): Promise<Runner[]> {
  const r = await f("/api/remote/v1/peers", { credentials: "same-origin", headers: { accept: "application/json" } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("sign in to see them"), { signedOut: true });
  if (!r.ok) throw new Error(`this site can't list your computers (HTTP ${r.status})`);
  const j = await r.json().catch(() => null);
  const peers = Array.isArray(j?.peers) ? j.peers : [];
  return peers
    .filter((p: any) => p && p.kind === "runner" && typeof p.remote_id === "string" && p.remote_id.length > 0 && p.remote_id.length <= 200)
    .map((p: any) => ({ remote_id: p.remote_id, name: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 80) : p.remote_id.slice(0, 12), ...runnerAgents(p) }));
}

/** Whether this account can use its computers here (the peers answer's `available`, literally true; anything else,
 *  an error or another sign-in state included, is false).  The notebook page asks once, to offer its terminal. */
export async function remoteAvailable(f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await f("/api/remote/v1/peers", { credentials: "same-origin", headers: { accept: "application/json" } });
    return r.ok && (await r.json()).available === true;
  } catch {
    return false;
  }
}

/** The relay's page leg for a remote and channel, on this site. */
export function pageLegUrl(remoteId: string, chan: "kernel" | "terminal" | "agent", loc: { protocol: string; host: string } = location): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/api/remote/v1/page?${new URLSearchParams({ remote: remoteId, chan })}`;
}
