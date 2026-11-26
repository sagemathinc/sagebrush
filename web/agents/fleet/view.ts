// The fleet pages' view model (design: agent-autonomous-pages-fleet r2.1 §1-§2.1): what each page says, worked out from
// the facts the page verified (page.ts, through the verifier) and the reports the service relays. Pure: no DOM, no fetch, no storage.
//
// Two kinds of input, never mixed:
// - VERIFIED facts: a host's certificate, its grant and the host's acknowledgement, each checked on this page. Only they
//   decide "applied" (a grant the host acknowledged) and every other verified state.
// - UNVERIFIED reports: the host's state as the service relays it (`…/state`). The page can't prove where one came from,
//   so it is labelled "Unverified report", with the host it claims to come from and its age. Each field is one of a
//   closed set of values (the producer's own lists, below), and anything else is "unknown". A report that is missing or
//   older than its bound is unknown, never healthy. A report is advisory only: nothing here lets it change a verified
//   state, enable an action, or feed anything that signs.

/** A report older than this is stale: the health signal's 10 s cadence, times 3. */
export const STALE_MS = 30_000;
/** Free text from a report or an object, as shown: plain text, at most this many characters (r2.3 §1.8). */
export const TEXT_MAX = 200;

// ---- the producer's closed lists (sagebrush-agent lib/fleet/host: host-state.mjs HEALTH and HEALTH_REASONS,
//      registry.mjs STATES, fence.mjs CAUSES plus "transferred", restore-record.mjs STATES; test-fleet-pages.mjs
//      compares them with the agent's own files when it has them)
export const HEALTH = ["ok", "degraded", "failing"] as const;
export const HEALTH_REASONS = ["audit_full", "audit_timeout", "audit_unavailable", "clone_detected", "qualify_required", "uid_exhausted"] as const;
export const RUN_STATES = ["provisioned", "running", "paused", "stopped", "revoked", "deleted"] as const;
export const FENCES = ["all", "agent", "expiry", "backup", "lease", "restore", "transferred"] as const;
export const LEASES = ["live", "none"] as const;
export const RESTORE_STATES = ["staging", "staged", "filling", "published", "validated", "not_fitting", "failed"] as const;

export type Health = (typeof HEALTH)[number];
export type Run = (typeof RUN_STATES)[number];
export type Fence = (typeof FENCES)[number];
export type Restore = (typeof RESTORE_STATES)[number];
/** A report's field: one of its closed values, or "unknown". */
export type Known<T> = T | "unknown";

export const TEXT = {
  unverified: "Unverified report",
  notReported: "This host hasn't reported yet",
  unknown: "unknown",
  stale: "stale",
  health: { ok: "ok", degraded: "degraded", failing: "failing" } satisfies Record<Health, string>,
  run: { provisioned: "provisioned", running: "running", paused: "paused", stopped: "stopped", revoked: "revoked", deleted: "deleted" } satisfies Record<Run, string>,
  fence: {
    lease: "waiting for an execution lease (offline more than 10 minutes, or a generation change)",
    transferred: "moved to another host",
    restore: "restored, waiting for resume",
    backup: "a backup is running",
    expiry: "the grant expired",
    agent: "paused or stopped by you",
    all: "every agent stopped by you",
  } satisfies Record<Fence, string>,
  restore: {
    restoring: "restoring",
    checking: "restored, checking",
    waiting: "restored, waiting to resume",
    resumed: "restored and resumed",
    notFitting: "doesn't fit: needs more space",
    failed: "restore failed",
  },
  grant: {
    none: "no grant yet",
    applied: "applied",
    waiting: "waiting for the host",
    narrowing: "narrowing: waiting for the host",
  },
} as const;

const known = <T extends string>(list: readonly T[], v: unknown): Known<T> => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : "unknown");
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Free text as the page shows it: a string, cut to TEXT_MAX characters (by code point), else "". Always shown as text. */
export function bounded(v: unknown): string {
  if (typeof v !== "string") return "";
  const cps = Array.from(v);
  return cps.length > TEXT_MAX ? cps.slice(0, TEXT_MAX - 1).join("") + "…" : v;
}

/** How long ago, in words: "just now", "40 s ago", "3 min ago", "2 h ago", "5 days ago". */
export function ago(ms: number): string {
  if (!(ms >= 0)) return TEXT.unknown;
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 172800) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

/** One agent's line in a report. */
export type AgentReport = Readonly<{
  run: Known<Run>;
  fences: readonly Known<Fence>[];
  lease: Known<"live" | "none">;
  /** The lease's end on the host's clock (approximate), and whether it has passed by this page's clock. */
  leaseEnds: number | null;
  leaseLapsed: boolean;
  restore: Known<Restore> | null;
}>;

/** A host's report as the page shows it. "none": nothing to show ("This host hasn't reported yet"). */
export type HostReport =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "report";
      /** The host the report claims to come from (the route's host: the page asked for it). */
      source: string;
      /** When the service last heard from the host (the service's clock), and how long ago that is by the page's. */
      seenAt: number | null;
      age: number | null;
      /** Older than STALE_MS, or with no usable time: every field below is then shown as unknown. */
      stale: boolean;
      health: Known<Health>;
      reasons: readonly Known<(typeof HEALTH_REASONS)[number]>[];
      agents: ReadonlyMap<string, AgentReport>;
    }>;

const AGENT_ID = /^[a-z2-7]{25}[aeimquy4]$/;

/**
 * The service's `…/state` answer for `host`, read for display at `now` (this page's clock). Anything not of the agreed
 * shape is unknown, field by field; a missing answer is "none". It is never an error: a report can't break the page.
 */
export function readHostReport(raw: unknown, host: string, now: number): HostReport {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return { kind: "none" };
  const r = raw as { host?: unknown; agents?: unknown };
  const h = (r.host && typeof r.host === "object" && !Array.isArray(r.host) ? r.host : {}) as Record<string, unknown>;
  const seenAt = isTime(h.last_seen_ms) ? h.last_seen_ms : null;
  const age = seenAt === null ? null : Math.max(0, now - seenAt);
  const stale = age === null || age > STALE_MS;
  const reasons = Array.isArray(h.health_reasons) ? h.health_reasons.slice(0, 16).map((x) => known(HEALTH_REASONS, x)) : [];
  const agents = new Map<string, AgentReport>();
  if (r.agents && typeof r.agents === "object" && !Array.isArray(r.agents)) {
    for (const [id, v] of Object.entries(r.agents as Record<string, unknown>).slice(0, 1024)) {
      if (!AGENT_ID.test(id) || !v || typeof v !== "object" || Array.isArray(v)) continue;
      const a = v as Record<string, unknown>;
      const ends = isTime(a.lease_expires_at_ms) ? a.lease_expires_at_ms : null;
      agents.set(id, {
        run: known(RUN_STATES, a.run),
        fences: Array.isArray(a.fences) ? [...new Set(a.fences.slice(0, 16).map((x) => known(FENCES, x)))] : ["unknown"],
        lease: known(LEASES, a.lease),
        leaseEnds: ends,
        leaseLapsed: ends !== null && ends <= now,
        restore: a.restore === null ? null : known(RESTORE_STATES, a.restore),
      });
    }
  }
  return { kind: "report", source: host, seenAt, age, stale, health: known(HEALTH, h.health), reasons, agents };
}

/** A report's health as shown: unknown when stale (missing or stale means unknown, never healthy). */
export function healthShown(r: HostReport): Known<Health> {
  return r.kind === "report" && !r.stale ? r.health : "unknown";
}

/** One agent's live state as shown, from a report: everything unknown when the report is stale or doesn't list it. */
export function agentShown(r: HostReport, agent: string): AgentReport | null {
  if (r.kind !== "report") return null;
  const a = r.agents.get(agent);
  if (!a) return null;
  if (r.stale) return { run: "unknown", fences: ["unknown"], lease: "unknown", leaseEnds: null, leaseLapsed: false, restore: a.restore === null ? null : "unknown" };
  return a;
}

/**
 * The restore stage in the page's words (r2.1 §2.1), read with `run` and the fences; null shows nothing. "Restored and
 * resumed" needs run "running" AND no `restore` fence: after an unknown outcome of resume-restored, a plain resume
 * records running while the `restore` fence still holds the agent stopped.
 */
export function restoreWords(restore: Known<Restore> | null, run: Known<Run>, fences: readonly Known<Fence>[]): string | null {
  switch (restore) {
    case null: return null;
    case "staging": case "staged": case "filling": return TEXT.restore.restoring;
    case "published": return TEXT.restore.checking;
    case "validated":
      if (fences.includes("restore")) return TEXT.restore.waiting;
      if (run === "unknown" || fences.includes("unknown")) return TEXT.unknown;
      return run === "running" ? TEXT.restore.resumed : TEXT.restore.waiting;
    case "not_fitting": return TEXT.restore.notFitting;
    case "failed": return TEXT.restore.failed;
    default: return TEXT.unknown;
  }
}

/** A fence in the page's words. */
export function fenceWords(f: Known<Fence>): string {
  return f === "unknown" ? TEXT.unknown : TEXT.fence[f];
}

/**
 * A grant's state as shown, from VERIFIED facts only: the generation of the grant the page verified (null: none), the
 * generation the host's verified acknowledgement names (null: none verified), and whether that grant narrows the one
 * before it. "applied" only when a verified acknowledgement names this very generation (r4 F8). No report is an input.
 */
export function grantState(grantGen: number | null, ackGen: number | null, narrowing: boolean): keyof typeof TEXT.grant {
  if (grantGen === null) return "none";
  if (ackGen !== null && ackGen === grantGen) return "applied";
  return narrowing ? "narrowing" : "waiting";
}

/** A grant's lifetime in words, at `now`: "no expiry", "expires in 3 days", "expired". */
export function lifetime(notAfterMs: number | null, now: number): string {
  if (notAfterMs === null) return "no expiry";
  const left = notAfterMs - now;
  if (left <= 0) return "expired";
  const h = Math.floor(left / 3_600_000);
  if (h < 1) return `expires in ${Math.max(1, Math.floor(left / 60_000))} min`;
  if (h < 48) return `expires in ${h} h`;
  return `expires in ${Math.floor(h / 24)} days`;
}

/**
 * A guard for answers that arrive late: each load takes a ticket, and its answer is drawn only while the ticket is
 * still the newest for the same account, fleet and host. An answer for a context the person has left is dropped.
 */
export function freshness() {
  let n = 0, key = "";
  return {
    take(ctx: { account: string; fleet: string; host?: string }) { n += 1; key = JSON.stringify([ctx.account, ctx.fleet, ctx.host ?? ""]); return { n, key }; },
    current(t: { n: number; key: string }) { return t.n === n && t.key === key; },
  };
}
