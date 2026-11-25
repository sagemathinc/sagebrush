// /agents/fleet/: the person's Autonomous fleet, read only (design: agent-autonomous-pages-fleet r2.1).
// - This device (#device): this browser's place in the device chain, its pin, a fork and Reset this device.
// - Hosts (#hosts): each host's verified certificate, the grant the person signed, and whether the host applied it.
// - A host (#host/<id>): the agents its verified grant lists, each with the host's unverified report beside it.
// Every signed object is verified on this page (fleet-verify.ts) before anything about it is shown. The host's state is
// an unverified report (view.ts). This page signs nothing; its one write is Reset this device (fleet-device.ts).
import { PinMoved, StorageFailed, hostFingerprintShown, syncChain, verifyGrant, verifyGrantAck, verifyHostCert, verifyHostRevocation, type Chain, type FleetCtx, type HostCert } from "../../workspace/fleet-verify";
import { deviceKey, resetDevice } from "../../workspace/fleet-device";
import { ServiceError, fixtureSource, isLoopback, serviceSource, sourceKind, type ChainPage, type HostRow, type OpRow, type Source } from "./client";
import * as V from "./view";

const T = {
  title: "Your fleet",
  device: "This device",
  hosts: "Hosts",
  back: "← Hosts",
  loading: "Loading…",
  noFleet: "You have no fleet yet. Autonomous agents run on hosts you pair from the Sagebrush app.",
  unavailable: "The fleet service didn't answer. Nothing here was trusted. Try again in a moment.",
  signIn: "Sign in to see your fleet.",
  refused: (code: string) => `The fleet service refused (${code}). Nothing here was trusted.`,
  chainBad: (code: string) => `This device list didn't verify (${code}). Nothing in it was trusted.`,
  tier: "This browser",
  tierLine: "A browser device can narrow what a host may do; widening it needs the Sagebrush app.",
  enrolled: (name: string) => `Enrolled as “${name}”.`,
  notEnrolled: "This browser isn't one of this fleet's devices.",
  removed: "This device was removed from your fleet.",
  pin: (seq: number, short: string) => `Device list checked up to entry ${seq} (${short}).`,
  fork: "This device was shown two different device lists for your fleet. It trusts neither and signs nothing. To use this browser with your fleet again, reset it here, then add it again from another device.",
  reset: "Reset this device",
  resetConfirm: "Reset this device? Its key for this fleet is deleted here; nothing else changes.",
  resetDone: "This device was reset.",
  storage: "This browser couldn't save its fleet record. Nothing was trusted.",
  noHosts: "No hosts are paired with your fleet yet.",
  hostBad: (code: string) => `Its certificate didn't verify (${code}). Nothing about this host is shown.`,
  revoked: "revoked",
  grantBad: (code: string) => `its grant didn't verify (${code})`,
  newerBad: (code: string) => `a newer grant didn't verify (${code})`,
  unresolved: "its newest grants couldn't be read: not checked",
  notYet: "not yet in force",
  gen: (gen: number) => `grant ${gen}`,
  unknownHost: "There is no such host in your fleet.",
  agentsNone: "Its grant lists no agents.",
  root: "root: can change anything in its workspace scopes",
  reportFrom: (host: string, age: string) => `from host ${host}, received ${age}`,
  ops: "Narrowings you asked for",
  approx: "about",
} as const;

// ---- the source, and the guard against late answers
const url = new URL(location.href);
// (the service's chain pages are read by the core's own reader, through fleet-verify.ts, once the mirror carries it)
const readPage = (_bytes: Uint8Array, _after: number): ChainPage => { throw new ServiceError("unavailable", 0); };
const src: Source = sourceKind(url) === "fixtures" ? fixtureSource() : serviceSource(readPage);
const fresh = V.freshness();
/** At most this many pages of a host's grants (16 each) are read; more than that is shown as unresolved. */
const GRANT_PAGES_MAX = 64;

// ---- DOM
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {}, ...kids: (Node | string | null)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) (e as any)[k] = v;
  for (const k of kids) if (k !== null) e.append(k);
  return e;
};
const main = () => document.querySelector("#fleet") as HTMLElement;
const draw = (...kids: (Node | null)[]) => main().replaceChildren(...kids.filter((k): k is Node => k !== null));
const note = (text: string, cls = "note") => el("p", { className: cls, textContent: text });

/** An unverified report's box: labelled, muted, with its claimed source and age; never a verified mark. */
function reportBox(r: V.HostReport, ...rows: Node[]) {
  const head = r.kind === "report"
    ? T.reportFrom(r.source, r.age === null ? V.TEXT.unknown : V.ago(r.age)) + (r.stale ? ` (${V.TEXT.stale})` : "")
    : V.TEXT.notReported;
  return el("div", { className: "report" }, el("p", { className: "report-label", textContent: V.TEXT.unverified }), el("p", { className: "report-src", textContent: head }), ...rows);
}
const row = (k: string, v: string) => el("div", { className: "kv" }, el("span", { className: "k", textContent: k }), el("span", { className: "v", textContent: V.bounded(v) }));

// ---- the fleet, verified: the chain first, then each host's certificate, grant and acknowledgement
type HostView = Readonly<{
  host: string;
  cert: HostCert | null;
  certRefused: string | null;
  name: string;
  fingerprint: string;
  revoked: boolean;
  grant: { gen: number; notBefore: number; notAfter: number | null; agents: readonly any[] } | null;
  grantRefused: string | null;
  /** The grants couldn't all be read (a page that failed to load, or more than this page reads): unresolved. */
  grantUnresolved: boolean;
  ackGen: number | null;
  /** The current grant narrows the verified one before it. */
  narrowing: boolean;
}>;
type Loaded =
  | { kind: "no-fleet" }
  | { kind: "error"; text: string }
  | { kind: "fork"; ctx: FleetCtx }
  | { kind: "ok"; ctx: FleetCtx; chain: Chain; hosts: HostView[] };

/** What a service failure says: sign in, try again, or the refusal's own code. */
const serviceText = (e: ServiceError) => (e.code === "unauthenticated" || e.status === 401 ? T.signIn : e.code === "unavailable" || e.code === "rate" || e.status === 429 || e.status >= 500 ? T.unavailable : T.refused(e.code));
const codeOf = (e: unknown) => (e && typeof e === "object" && typeof (e as any).code === "string" && /^[a-z_]{1,40}$/.test((e as any).code) ? (e as any).code : "error");

async function verifiedChain(ctx: FleetCtx): Promise<Chain> {
  // (another tab pinned further meanwhile: read the list again, once)
  for (let i = 0; ; i++) {
    try { return await syncChain(ctx, await src.chain()); } catch (e) { if (e instanceof PinMoved && i === 0) continue; throw e; }
  }
}

/** A grant's own not_before_ms, read only as the clock its lifetime is checked at (the signature covers it); else now. */
function startOf(text: string): number {
  try { const nb = JSON.parse(text)?.body?.not_before_ms; if (Number.isSafeInteger(nb) && nb > 0) return nb; } catch {}
  return src.now();
}

async function verifyHost(ctx: FleetCtx, chain: Chain, h: HostRow): Promise<HostView> {
  const base = { host: h.host, cert: null, certRefused: null, name: "", fingerprint: "", revoked: false, grant: null, grantRefused: null, grantUnresolved: false, ackGen: null, narrowing: false };
  let cert: HostCert;
  try { cert = await verifyHostCert(ctx, chain, h.cert); } catch (e) { return { ...base, certRefused: codeOf(e) }; }
  const body = cert.body as { host: string; name: string };
  if (body.host !== h.host) return { ...base, certRefused: "not_granted" };
  const v: { -readonly [K in keyof HostView]: HostView[K] } = { ...base, cert, name: body.name, fingerprint: await hostFingerprintShown(cert) };
  if (h.revocation) { try { await verifyHostRevocation(ctx, chain, h.host, h.revocation); v.revoked = true; } catch {} }
  // (the host's accepted grants, oldest first, verified IN ORDER as the host accepted them: the first against nothing,
  //  each next one against the previous VERIFIED one, so a narrowing signed by a browser device verifies against what
  //  it narrows. The walk stops at the first grant that doesn't verify; nothing after it is shown as verified.)
  if (h.grant_gen !== null) {
    let cur: { gen: number; bytes: Uint8Array; body: unknown } | null = null;
    let prevGen = 0, widened = true, after = 0;
    walk: for (let page = 0; page < GRANT_PAGES_MAX; page++) {
      let p: { grants: readonly string[]; head: number };
      try { p = await src.grantsPage(h.host, after); } catch { v.grantUnresolved = true; break; }
      if (!p.grants.length) break;
      for (const text of p.grants) {
        try {
          // (each checked at its own start: the host accepted it then, and its signer, form and place in the order
          //  are what the walk proves; whether the newest is still in force is shown from its lifetime, below)
          const g = (await verifyGrant(ctx, chain, cert, text, cur, startOf(text))) as { body: { gen: number }; widens: boolean };
          prevGen = cur?.gen ?? 0;
          widened = g.widens;
          cur = { gen: g.body.gen, bytes: new TextEncoder().encode(text), body: g.body };
        } catch (e) {
          v.grantRefused = codeOf(e);
          break walk;
        }
      }
      after = cur?.gen ?? after;
      if (cur && cur.gen >= p.head) break;
      if (page === GRANT_PAGES_MAX - 1) v.grantUnresolved = true;
    }
    // (the service names a grant but none could be read and verified: not "no grant")
    if (!cur && !v.grantRefused) v.grantUnresolved = true;
    if (cur) {
      const b = cur.body as { gen: number; not_before_ms: number; not_after_ms: number | null; agents: any[] };
      v.grant = { gen: b.gen, notBefore: b.not_before_ms, notAfter: b.not_after_ms, agents: b.agents };
      v.narrowing = prevGen > 0 && prevGen < b.gen && !widened;
      if (h.grant_gen > b.gen && !v.grantRefused) v.grantUnresolved = true;
    }
  }
  if (h.ack && v.grant) {
    try { v.ackGen = ((await verifyGrantAck(ctx, cert, h.ack, v.grant.gen)) as { gen: number }).gen; } catch {}
  }
  return v;
}

async function load(): Promise<Loaded> {
  let f: { fleet: string; aud: string } | null;
  try { f = await src.fleet(); } catch (e) { return { kind: "error", text: e instanceof ServiceError ? serviceText(e) : T.unavailable }; }
  if (!f) return { kind: "no-fleet" };
  const ctx: FleetCtx = { aud: f.aud, fleet: f.fleet };
  let chain: Chain;
  try { chain = await verifiedChain(ctx); } catch (e) {
    if (codeOf(e) === "chain_fork") return { kind: "fork", ctx };
    if (e instanceof ServiceError) return { kind: "error", text: serviceText(e) };
    // (the core refuses with a reason code; anything else came from this browser's own storage, which couldn't keep or
    //  read the pin: nothing was trusted either way)
    if (e instanceof StorageFailed || codeOf(e) === "error") return { kind: "error", text: T.storage };
    return { kind: "error", text: T.chainBad(codeOf(e)) };
  }
  let rows: HostRow[];
  try { rows = await src.hosts(); } catch (e) { return { kind: "error", text: e instanceof ServiceError ? serviceText(e) : T.unavailable }; }
  const hosts: HostView[] = [];
  for (const h of rows) hosts.push(await verifyHost(ctx, chain, h));
  return { kind: "ok", ctx, chain, hosts };
}

// ---- the views
const tabs = (on: "device" | "hosts") => el("nav", { className: "tabs" },
  el("a", { href: "#device", className: on === "device" ? "on" : "", textContent: T.device }), " ",
  el("a", { href: "#hosts", className: on === "hosts" ? "on" : "", textContent: T.hosts }));

async function deviceView(l: Loaded) {
  if (l.kind === "fork") {
    const b = el("button", { type: "button", id: "reset", textContent: T.reset });
    const msg = el("p", { className: "msg", role: "status" });
    b.onclick = async () => {
      if (!confirm(T.resetConfirm)) return;
      b.disabled = true;
      try { await resetDevice(l.ctx.fleet); msg.textContent = T.resetDone; } catch { msg.textContent = T.storage; b.disabled = false; }
    };
    return draw(tabs("device"), note(T.fork, "warn"), b, msg);
  }
  if (l.kind !== "ok") return;
  const k = await deviceKey(l.ctx.fleet).catch(() => null);
  let status: string = T.notEnrolled;
  if (k) for (const d of (l.chain as any).devices.values() as Iterable<{ raw: Uint8Array; name: string; removed: number | null }>) {
    if (d.raw.length === k.publicRaw.length && d.raw.every((x, i) => x === k.publicRaw[i])) { status = d.removed === null ? T.enrolled(d.name) : T.removed; break; }
  }
  const seq = (l.chain as any).seq as number, head = (l.chain as any).hashes[seq] as string;
  draw(tabs("device"), el("div", { className: "card" }, el("h2", { textContent: T.tier }), note(T.tierLine), note(status), note(T.pin(seq, head.slice(0, 8)))));
}

function grantLine(h: HostView): string {
  if (!h.grant) return h.grantRefused ? T.grantBad(h.grantRefused) : h.grantUnresolved ? T.unresolved : V.TEXT.grant.none;
  // (the last VERIFIED grant; a newer one that didn't verify, or couldn't be read, is said after it, and then nothing
  //  is "applied": the host may be on a grant this page couldn't check)
  const newer = h.grantRefused ? T.newerBad(h.grantRefused) : h.grantUnresolved ? T.unresolved : null;
  const s = newer ? (h.narrowing ? "narrowing" : "waiting") : V.grantState(h.grant.gen, h.ackGen, h.narrowing);
  const life = src.now() < h.grant.notBefore ? T.notYet : V.lifetime(h.grant.notAfter, src.now());
  return [T.gen(h.grant.gen), life, V.TEXT.grant[s], newer].filter(Boolean).join(" · ");
}

function hostsView(l: Loaded) {
  if (l.kind !== "ok") return;
  if (!l.hosts.length) return draw(tabs("hosts"), note(T.noHosts));
  const list = el("ul", { className: "hosts" });
  for (const h of l.hosts) {
    if (h.certRefused) { list.append(el("li", { className: "host refused" }, el("span", { className: "name", textContent: h.host }), " ", note(T.hostBad(h.certRefused), "warn"))); continue; }
    list.append(el("li", { className: "host" },
      el("a", { href: `#host/${h.host}`, className: "name", textContent: V.bounded(h.name) }), " ",
      el("code", { className: "fp", textContent: h.fingerprint }), " ",
      h.revoked ? el("span", { className: "revoked", textContent: T.revoked }) : null,
      el("p", { className: "grant", textContent: grantLine(h) })));
    (list.lastElementChild as HTMLElement).dataset.host = h.host;
  }
  draw(tabs("hosts"), list);
}

async function hostView(l: Loaded, id: string, ticket: { n: number; key: string }) {
  if (l.kind !== "ok") return;
  const h = l.hosts.find((x) => x.host === id && !x.certRefused);
  const back = el("a", { href: "#hosts", className: "back", textContent: T.back });
  if (!h) return draw(back, note(T.unknownHost));
  // (the host's report and ops: unverified, read after the verified facts are on screen, and drawn only if the person
  //  is still on this host)
  const now = src.now();
  const [raw, ops] = await Promise.all([src.state(id).catch(() => null), src.ops(id).catch(() => null)]);
  // (tests only, on a loopback page: the answer held before it is drawn, so a test can move on meanwhile)
  const hold = isLoopback(location.hostname) && typeof (window as any).__fleetHold === "function" ? (window as any).__fleetHold : null;
  if (hold) await hold("state");
  if (!fresh.current(ticket)) return;
  const r = V.readHostReport(raw, id, now);
  const head = el("div", { className: "card" },
    el("h2", { textContent: V.bounded(h.name) }), el("code", { className: "fp", textContent: h.fingerprint }),
    h.revoked ? el("p", { className: "revoked", textContent: T.revoked }) : null,
    el("p", { className: "grant", textContent: grantLine(h) }),
    reportBox(r, row("health", V.healthShown(r)), ...(r.kind === "report" && !r.stale && r.reasons.length ? [row("reasons", r.reasons.join(", "))] : [])));
  const agents = el("ul", { className: "agents" });
  for (const a of h.grant?.agents ?? []) {
    const rep = V.agentShown(r, a.agent);
    const words = rep ? [
      row("run", rep.run),
      ...rep.fences.map((f) => row("fenced", V.fenceWords(f))),
      row("lease", rep.lease === "live" && rep.leaseEnds !== null ? `${rep.lease}, ${rep.leaseLapsed ? "ended" : `ends ${T.approx} ${new Date(rep.leaseEnds).toLocaleTimeString()}`}` : rep.lease),
      ...(V.restoreWords(rep.restore, rep.run) ? [row("restore", V.restoreWords(rep.restore, rep.run)!)] : []),
    ] : [];
    const li = el("li", { className: "agent" },
      el("h3", { textContent: V.bounded(a.name ?? a.agent) }),
      row("client", String(a.client ?? "")),
      ...(Array.isArray(a.tags) && a.tags.length ? [row("tags", a.tags.join(", "))] : []),
      ...(Array.isArray(a.workspace) ? a.workspace.map((s: any) => row("workspace", `${s.path}${s.write ? " (may change files)" : " (read only)"}`)) : []),
      a.root ? note(T.root, "warn") : null,
      reportBox(r, ...words));
    li.dataset.agent = a.agent;
    agents.append(li);
  }
  if (!agents.childElementCount) agents.append(el("li", { textContent: T.agentsNone }));
  const opList = el("ul", { className: "ops" });
  for (const o of ops ?? []) opList.append(el("li", { textContent: `${V.bounded(String(o.kind))}: ${V.bounded(String(o.state))}` }));
  draw(back, head, agents, ...(ops && ops.length ? [el("h3", { textContent: T.ops }), reportBox(r, opList)] : []));
}

// ---- routing: each change of view takes a ticket; a load's answer is drawn only for the newest ticket
let loaded: Promise<Loaded> | null = null;
async function route() {
  const hash = location.hash.slice(1);
  const id = hash.startsWith("host/") ? hash.slice(5) : null;
  const ticket = fresh.take({ account: "", fleet: "", host: id ?? hash });
  draw(note(T.loading));
  const l = await (loaded ??= load());
  if (!fresh.current(ticket)) return;
  if (l.kind === "no-fleet") return draw(note(T.noFleet));
  if (l.kind === "error") return draw(note(l.text, "warn"));
  if (id !== null) return hostView(l, id, ticket);
  if (hash === "hosts") return hostsView(l);
  return deviceView(l);
}
window.addEventListener("hashchange", () => void route());
document.title = T.title + " · Sagebrush";
void route();
