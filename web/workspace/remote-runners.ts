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
  return (await listComputers(f)).runners;
}

/** The words for an account the site doesn't let connect a computer (the server's refusal says the same). */
export const NOT_ENABLED = "Connecting a computer isn't enabled for your account yet.";

/** Your enrolled computers and whether this account may use them here, from one answer (GET /api/remote/v1/peers):
 *  `available` is the answer's, literally true or else false; signed out, it throws an error marked signedOut. */
export async function listComputers(f: typeof fetch = fetch): Promise<{ available: boolean; runners: Runner[] }> {
  const r = await f("/api/remote/v1/peers", { credentials: "same-origin", headers: { accept: "application/json" } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("sign in to see them"), { signedOut: true });
  if (!r.ok) throw new Error(`this site can't list your computers (HTTP ${r.status})`);
  const j = await r.json().catch(() => null);
  const peers = Array.isArray(j?.peers) ? j.peers : [];
  const runners = peers
    .filter((p: any) => p && p.kind === "runner" && typeof p.remote_id === "string" && p.remote_id.length > 0 && p.remote_id.length <= 200)
    .map((p: any) => ({ remote_id: p.remote_id, name: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 80) : p.remote_id.slice(0, 12), ...runnerAgents(p) }));
  return { available: j?.available === true, runners };
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

/** What renaming or removing a computer answered: done, or why not ("taken", "length" with the most characters a
 *  name may have, "chars", "gone": not one of this account's computers any more, or "failed" with the reason). */
export type ComputerChange = { ok: true; name?: string } | { ok: false; why: "taken" | "length" | "chars" | "gone" | "failed"; max?: number; message?: string };

/** How long a rename or remove waits for its whole answer before it fails, so its button comes back. */
export const COMPUTER_CHANGE_MS = 20_000;

// (the request and its body race the deadline: a fetch that ignores the abort still loses, and the answer is a failure)
async function computerPost(path: string, body: object, f: typeof fetch, ms: number): Promise<{ status: number; j: any }> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => { ac.abort(); fail(new Error(`no answer in ${ms / 1000} s`)); }, ms);
  });
  const ask = (async () => {
    const r = await f(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: ac.signal });
    return { status: r.status, j: await r.json().catch(() => null) };
  })();
  ask.catch(() => {}); // (lost to the deadline: its own rejection is not unhandled)
  try {
    return await Promise.race([ask, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Rename one of your computers (POST /api/remote/v1/rename): the site refuses a name another of them has. */
export async function renameComputer(remoteId: string, name: string, f: typeof fetch = fetch, ms = COMPUTER_CHANGE_MS): Promise<ComputerChange> {
  try {
    const { status, j } = await computerPost("/api/remote/v1/rename", { remote_id: remoteId, name }, f, ms);
    if (status === 200 && j?.ok === true) return { ok: true, name: typeof j.name === "string" ? j.name : name };
    if (j?.error === "name_taken") return { ok: false, why: "taken" };
    if (j?.error === "invalid_name") return { ok: false, why: j.why === "chars" ? "chars" : "length", max: Number.isSafeInteger(j.max) ? j.max : undefined };
    if (status === 404) return { ok: false, why: "gone" };
    return { ok: false, why: "failed", message: `HTTP ${status}` };
  } catch (e) {
    return { ok: false, why: "failed", message: String((e as Error)?.message ?? e) };
  }
}

/** Remove one of your computers (POST /api/remote/v1/revoke): it stops being sent code until it enrolls again. */
export async function removeComputer(remoteId: string, f: typeof fetch = fetch, ms = COMPUTER_CHANGE_MS): Promise<ComputerChange> {
  try {
    const { status, j } = await computerPost("/api/remote/v1/revoke", { remote_id: remoteId }, f, ms);
    if (status === 200 && j?.ok === true) return { ok: true };
    if (status === 404) return { ok: false, why: "gone" };
    return { ok: false, why: "failed", message: `HTTP ${status}` };
  } catch (e) {
    return { ok: false, why: "failed", message: String((e as Error)?.message ?? e) };
  }
}

/** The relay's page leg for a remote and channel, on this site. */
export function pageLegUrl(remoteId: string, chan: "kernel" | "terminal" | "agent", loc: { protocol: string; host: string } = location): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/api/remote/v1/page?${new URLSearchParams({ remote: remoteId, chan })}`;
}
