// "Chat here", the Agents page's own: your computers in the Connect dialog, each with Chat here, and the
// attempt it starts: a leg to that computer's agent (agent-relay.ts), then a pairing over it (agent-ui.ts's adopt) and
// the grant dialog. Kept out of agent-ui.ts, which every page's pairing chunk carries; only this page has it.

import type { AgentLink, AgentPairing } from "../workspace/agent-pair";
import { NOT_ENABLED } from "../workspace/remote-runners";

/** The Connect dialog's words for your computers, word for word as reviewed. */
export const RUNNER_COPY = {
  heading: "Or chat with an agent on one of your computers:",
  button: "Chat here",
  finding: "Finding your computers…",
  none: "None of your computers is set up for this. On one, run: sagebrush remote login",
  // (an account the site doesn't let connect a computer: this sentence alone, before any command (the server's words))
  notEnabled: NOT_ENABLED,
  failed: (reason: string) => `Your computers: ${reason}`,
  signIn: "Sign in",
  // (each computer's line under its name: when it last connected with an agent, and when it was set up; two with one
  //  name also show the start of their ids, so they can be told apart)
  seen: (ago: string) => `connected ${ago}`,
  added: (date: string) => `added ${date}`,
  id: (id: string) => `id ${id}`,
  remove: "Remove…",
  removeTitle: (name: string) => `Remove ${name} from your computers`,
  removeAsk: (name: string) => `Remove ${name}? It can't connect again until you run sagebrush remote login on it.`,
  removeYes: "Remove",
  removeNo: "Keep",
  removing: "Removing…",
  removeFailed: (name: string, reason: string) => `Couldn't remove ${name}: ${reason}`,
};
/** How long a computer's agent has to say it's ready (agent.ready) after the leg's hello: its process starting. */
export const READY_MS = 30_000;
/** A computer whose runner isn't connected yet (its leg unreachable): Chat here waits for it this long, trying again
 * every RETRY_MS, as a runner just started takes a few seconds to reach the relay. */
export const WAIT_MS = 60_000;
export const RETRY_MS = 2_000;

type Runner = { remote_id: string; name: string; agents_at?: number | null; created?: number | null };
type End = { kind: string; why: string };
/** What the attempt needs: your computers, a leg to one (open, or ended with why), and the page's words for it. */
export type ChatHereHost = {
  list(): Promise<{ available: boolean; runners: Runner[] }>;
  open(r: Runner): Promise<{ link: AgentLink; ended: End | null }>;
  onConnecting(r: Runner): void;
  /** its runner isn't connected yet: waiting for it */
  onWaiting(r: Runner): void;
  onFailed(r: Runner, e: End): void;
  /** remove it from your computers (the site's revoke); throws with the reason if it wasn't removed */
  remove?(r: Runner): Promise<void>;
};
/** What it needs of the page's pairing (agent-ui.ts's mountAgentPairing). */
type Ui = { adopt(link: AgentLink, computer: string): AgentPairing; grant(p: AgentPairing): Promise<void>; live(): boolean; readonly pairing: AgentPairing | null };

const CSS = `
.sbag-box .runners { display: grid; gap: 6px; border-top: 1px solid #e6e9e1; padding-top: 10px; }
.sbag-box .runner { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.sbag-box .runner .who { display: grid; min-width: 0; }
.sbag-box .runner .who > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbag-box .runner .seen { color: #5f6b5a; font-size: 0.85em; }
.sbag-box .runner .acts { display: flex; gap: 6px; flex: 0 0 auto; }
`;

/** How long ago, in words (as the fleet pages say it): "just now", "40 s ago", "3 min ago", "2 h ago", "5 days ago". */
export function ago(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 172800) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

/** A computer's line under its name: when it last connected, when it was set up, and its id's start when another of
 *  your computers has the same name. */
export function runnerDetail(r: Runner, sameName: boolean, now = Date.now()): string {
  const parts: string[] = [];
  if (typeof r.agents_at === "number") parts.push(RUNNER_COPY.seen(ago(now - r.agents_at)));
  if (typeof r.created === "number") parts.push(RUNNER_COPY.added(new Date(r.created * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })));
  if (sameName) parts.push(RUNNER_COPY.id(r.remote_id.slice(0, 6)));
  return parts.join(" · ");
}

export function chatHere(host: ChatHereHost, ui: () => Ui | null) {
  if (!document.getElementById("sbag-runners-css")) document.head.append(Object.assign(document.createElement("style"), { id: "sbag-runners-css", textContent: CSS }));
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  // (each Chat here is one attempt: a newer one, or a pairing adopted meanwhile, supersedes it)
  let attempt = 0;

  async function start(r: Runner) {
    const u = ui();
    if (!u) return;
    const mine = ++attempt;
    host.onConnecting(r);
    let opened: { link: AgentLink; ended: End | null };
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      try { opened = await host.open(r); } catch (e) { if (mine === attempt) host.onFailed(r, { kind: "lost", why: String((e as Error)?.message ?? e) }); return; }
      if (mine !== attempt || u.live()) { opened.link.close(); return; }
      // (its runner not connected yet: wait for it, as a person who just started it clicks at once)
      if (opened.ended?.kind !== "unreachable" || Date.now() + RETRY_MS > deadline) break;
      host.onWaiting(r);
      await new Promise((res) => setTimeout(res, RETRY_MS));
      if (mine !== attempt || u.live()) return;
    }
    if (opened.ended) return host.onFailed(r, opened.ended);
    const p = u.adopt(opened.link, r.name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([p.paired(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("")), READY_MS); })]);
    } catch {
      if (p.state !== "closed") void p.revoke(""); // (no agent.ready: its start is stopped, as a Disconnect)
      if (mine === attempt) host.onFailed(r, p.linkEnd && p.linkEnd.kind !== "disconnected" ? p.linkEnd : { kind: "lost", why: "" });
      return;
    } finally { clearTimeout(timer); }
    if (u.pairing !== p || mine !== attempt) { p.drop(); return; }
    await u.grant(p);
  }

  /** Your computers, each with Chat here, for the Connect dialog: listed as it opens; a name is text, never markup. */
  return function section(close: () => void): HTMLElement {
    const sec = el("div", { className: "runners" });
    const status = el("div", { className: "note", textContent: RUNNER_COPY.finding });
    status.setAttribute("role", "status");
    sec.append(el("div", { textContent: RUNNER_COPY.heading }), status);
    host.list().then(({ available, runners: list }) => {
      if (!available) { status.textContent = RUNNER_COPY.notEnabled; return; }
      if (!list.length) { status.textContent = RUNNER_COPY.none; return; }
      status.textContent = "";
      const names = new Map<string, number>();
      for (const r of list) names.set(r.name, (names.get(r.name) ?? 0) + 1);
      for (const r of list) {
        const b = el("button", { type: "button", textContent: RUNNER_COPY.button });
        b.onclick = () => { close(); void start(r); };
        const detail = runnerDetail(r, names.get(r.name)! > 1);
        const who = el("span", { className: "who" }, el("span", { textContent: r.name }));
        if (detail) who.append(el("span", { className: "seen", textContent: detail }));
        const acts = el("span", { className: "acts" }, b);
        const row = el("div", { className: "runner" }, who, acts);
        if (host.remove) acts.append(removeButton(r, row, acts));
        sec.append(row);
      }
    }, (e) => {
      // (a site without computers, a local one: no section at all, nothing a person there could do about it)
      if ((e as { absent?: boolean })?.absent) return void sec.remove();
      status.textContent = RUNNER_COPY.failed(String((e as Error)?.message ?? e));
      // (signed out: the site's own sign-in, back to this page after)
      if ((e as { signedOut?: boolean })?.signedOut) sec.append(el("a", { className: "sign-in", href: `/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`, textContent: RUNNER_COPY.signIn }));
    });
    return sec;

    // (Remove…: asked in the row itself, then the site's revoke; the row goes once it's removed, and the list says so
    //  when none is left)
    function removeButton(r: Runner, row: HTMLElement, acts: HTMLElement): HTMLButtonElement {
      const rm = el("button", { type: "button", textContent: RUNNER_COPY.remove, title: RUNNER_COPY.removeTitle(r.name) });
      rm.onclick = () => {
        const ask = el("span", { className: "note", textContent: RUNNER_COPY.removeAsk(r.name) });
        const yes = el("button", { type: "button", className: "danger", textContent: RUNNER_COPY.removeYes });
        const no = el("button", { type: "button", textContent: RUNNER_COPY.removeNo });
        const kept = [...acts.childNodes];
        const confirmRow = el("div", { className: "runner remove-ask" }, ask, el("span", { className: "acts" }, yes, no));
        row.after(confirmRow);
        acts.replaceChildren();
        no.onclick = () => { confirmRow.remove(); acts.replaceChildren(...kept); rm.focus(); };
        yes.onclick = async () => {
          yes.disabled = no.disabled = true;
          ask.textContent = RUNNER_COPY.removing;
          status.textContent = "";
          try {
            await host.remove!(r);
          } catch (e) {
            confirmRow.remove();
            acts.replaceChildren(...kept);
            status.textContent = RUNNER_COPY.removeFailed(r.name, String((e as Error)?.message ?? e));
            return;
          }
          confirmRow.remove();
          row.remove();
          if (!sec.querySelector(".runner")) status.textContent = RUNNER_COPY.none;
        };
        yes.focus();
      };
      return rm;
    }
  };
}
