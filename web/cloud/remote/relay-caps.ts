// The relay's caps table (core design r1.9 §5, §13.6; terminal addendum T1.4 §T2): by kind and channel, read by the
// relay (relay.ts) and by the Worker's page route (server.ts), kept apart so the Worker doesn't import the Durable
// Object's class.
export type Kind = "runner" | "agent";
export type Chan = "kernel" | "terminal" | "agent" | "engine";

/** The engine channel (remote r3.3 §"What is reused", H1, H4): one page leg per notebook, carrying the app engine's
 * protocol for one kernel entry, text or binary, each way at most this (below 4 MiB, so the runner's lease stays
 * 4 MiB, as for the agent channel). */
export const RUNNER_ENGINE_FRAME = 4 * 1024 * 1024 - 2048;
/** The kernel entries a notebook's engine page may name (r3.3 D1, refined): the engine's four language modes and the
 * machine's own Python.  Bound into the page's identity (H4): a page for one entry never reaches another's kernel. */
export const ENGINE_ENTRIES = ["sagebrush-python", "sagebrush-sage", "sagebrush-magma", "sagebrush-matlab", "python"] as const;
export type EngineEntry = (typeof ENGINE_ENTRIES)[number];
/** What a runner says it speaks, in x-sb-remote-caps: the engine channel's version.  A runner that doesn't say it is
 * never sent an engine page (its strict page-open grammar would refuse the engine page's fields). */
export const ENGINE_CAP = "engine/1";

/** A runner's agent channel's message cap, envelope included, either way (`sagebrush remote --serve-agents`): below
 * 4 MiB, so a runner's lease (account.ts leaseBytes: its largest message, rounded up to 4 MiB) stays 4 MiB.  The runner
 * advertises 2 KiB less as the payload (agent_child.py AGENT_FRAME and AGENT_ADVERTISED, the same figures). */
export const RUNNER_AGENT_FRAME = 4 * 1024 * 1024 - 2048;

/** One caps table, by kind and channel (§13.6, T1.4 §T2): the relay's code reads it, and has no other branch on them. */
export const RELAY_CAPS: Record<Kind, Partial<Record<Chan, { legs: number; pageToPeer: number; peerToPage: number; window: number }>>> = {
  runner: {
    kernel: { legs: 1, pageToPeer: Math.round(2.25 * 1024 * 1024) + 64 * 1024, peerToPage: 1024 * 1024, window: 8 * 1024 * 1024 },
    terminal: { legs: 4, pageToPeer: 65536, peerToPage: 65536, window: 1024 * 1024 },
    // (the agent channel, `sagebrush remote --serve-agents`: one page, RUNNER_AGENT_FRAME either way, in the runner's
    // unchanged 8 MiB window)
    agent: { legs: 1, pageToPeer: RUNNER_AGENT_FRAME, peerToPage: RUNNER_AGENT_FRAME, window: 8 * 1024 * 1024 },
    // (the engine channel: `legs` is per notebook here (the newer page for a notebook replaces the older, whatever its
    // entry); the remote's open notebooks together are bounded by its service budget, engineBudget())
    engine: { legs: 1, pageToPeer: RUNNER_ENGINE_FRAME, peerToPage: RUNNER_ENGINE_FRAME, window: 8 * 1024 * 1024 },
  },
  agent: {
    agent: { legs: 1, pageToPeer: 12 * 1024 * 1024, peerToPage: 12 * 1024 * 1024 + 2048, window: 16 * 1024 * 1024 },
  },
};
/**
 * The relay's service budget for engine pages (remote r3.3 P1), per remote: a deployment setting (the Worker's
 * variables REMOTE_ENGINE_PAGES, REMOTE_ENGINE_QUEUE_BYTES and REMOTE_ENGINE_ATTEMPTS), never the host's memory, which
 * decides on kernels separately (r3.3 Limits).  The envelope it protects is the relay object's memory (128 MiB on the
 * platform): every engine page's frames waiting for the account's byte lease together at most `queueBytes` (a leg
 * whose frame would pass it closes 1013, as for its own window), and each page's socket and accounting (a few KiB)
 * times `pages`; with the other channels' windows (kernel 8 MiB, terminals 4 x 1 MiB, agent 8 MiB, the peer's 8 MiB)
 * the defaults stay under 80 MiB.  `attempts`: the engine pages' used attempt ids kept at once (each a few bytes of
 * storage, until its expiry).  Reaching `pages` refuses a further notebook's page in words (429); a notebook already
 * open replacing its own page is never refused by it.
 */
export const ENGINE_BUDGET_DEFAULTS = Object.freeze({ pages: 64, queueBytes: 48 * 1024 * 1024, attempts: 16 });
/** The settings' accepted ranges: outside them (or not a plain decimal integer), the budget is misconfigured and no
 * engine page is admitted (503), never a silent default. */
export const ENGINE_BUDGET_RANGE = Object.freeze({ pages: [1, 4096], queueBytes: [8 * 1024 * 1024, 96 * 1024 * 1024], attempts: [1, 1024] });
export type EngineBudget = { pages: number; queueBytes: number; attempts: number };
/** The budget from the Worker's variables, or null if any set one is invalid. */
export function engineBudget(env: { REMOTE_ENGINE_PAGES?: string; REMOTE_ENGINE_QUEUE_BYTES?: string; REMOTE_ENGINE_ATTEMPTS?: string }): EngineBudget | null {
  const out = { ...ENGINE_BUDGET_DEFAULTS };
  for (const [k, v] of [["pages", env.REMOTE_ENGINE_PAGES], ["queueBytes", env.REMOTE_ENGINE_QUEUE_BYTES], ["attempts", env.REMOTE_ENGINE_ATTEMPTS]] as const) {
    if (v === undefined) continue;
    if (typeof v !== "string" || !/^[1-9][0-9]{0,9}$/.test(v)) return null;
    const n = Number(v), [lo, hi] = ENGINE_BUDGET_RANGE[k];
    if (n < lo || n > hi) return null;
    out[k] = n;
  }
  return out;
}
/** A peer leg's window, as a receiver (all its pages' messages to it): its kind's largest (§5: 8 MiB runner, 16 agent). */
export const PEER_WINDOW: Record<Kind, number> = { runner: 8 * 1024 * 1024, agent: 16 * 1024 * 1024 };

/** A kind's channel's caps, or null: own properties only (never `constructor`, `__proto__` or anything inherited). */
export function capsFor(kind: string, chan: string): { legs: number; pageToPeer: number; peerToPage: number; window: number } | null {
  if (!Object.hasOwn(RELAY_CAPS, kind)) return null;
  const byChan = RELAY_CAPS[kind as Kind] as Record<string, { legs: number; pageToPeer: number; peerToPage: number; window: number }>;
  return Object.hasOwn(byChan, chan) ? byChan[chan] : null;
}
/** A peer kind's window, or null (own properties only). */
export function peerWindow(kind: string): number | null {
  return Object.hasOwn(PEER_WINDOW, kind) ? PEER_WINDOW[kind as Kind] : null;
}
