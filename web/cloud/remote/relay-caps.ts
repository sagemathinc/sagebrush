// The relay's caps table (core design r1.9 §5, §13.6; terminal addendum T1.4 §T2): by kind and channel, read by the
// relay (relay.ts) and by the Worker's page route (server.ts), kept apart so the Worker doesn't import the Durable
// Object's class.
export type Kind = "runner" | "agent";
export type Chan = "kernel" | "terminal" | "agent";

/** One caps table, by kind and channel (§13.6, T1.4 §T2): the relay's code reads it, and has no other branch on them. */
export const RELAY_CAPS: Record<Kind, Partial<Record<Chan, { legs: number; pageToPeer: number; peerToPage: number; window: number }>>> = {
  runner: {
    kernel: { legs: 1, pageToPeer: Math.round(2.25 * 1024 * 1024) + 64 * 1024, peerToPage: 1024 * 1024, window: 8 * 1024 * 1024 },
    terminal: { legs: 4, pageToPeer: 65536, peerToPage: 65536, window: 1024 * 1024 },
    // (the agent channel, `sagebrush remote --serve-agents`: one page, 6 MiB of payload plus its envelope either way,
    // inside the runner's 8 MiB window, which is unchanged)
    agent: { legs: 1, pageToPeer: 6 * 1024 * 1024 + 2048, peerToPage: 6 * 1024 * 1024 + 2048, window: 8 * 1024 * 1024 },
  },
  agent: {
    agent: { legs: 1, pageToPeer: 12 * 1024 * 1024, peerToPage: 12 * 1024 * 1024 + 2048, window: 16 * 1024 * 1024 },
  },
};
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
