// "Chat here" (W2 B), the Agents page's own: your computers in the Connect dialog, each with Chat here, and the
// attempt it starts: a leg to that computer's agent (agent-relay.ts), then a pairing over it (agent-ui.ts's adopt) and
// the grant dialog. Kept out of agent-ui.ts, which every page's pairing chunk carries; only this page has it.

import type { AgentLink, AgentPairing } from "../workspace/agent-pair";

/** The Connect dialog's words for your computers (board, W2 B Copy). */
export const RUNNER_COPY = {
  heading: "Or chat with an agent on one of your computers:",
  button: "Chat here",
  finding: "Finding your computers…",
  none: "None of your computers is set up for this. On one, run: sagebrush remote login",
  failed: (reason: string) => `Your computers: ${reason}`,
};
/** How long a computer's agent has to say it's ready (agent.ready) after the leg's hello: its process starting. */
export const READY_MS = 30_000;

type Runner = { remote_id: string; name: string };
type End = { kind: string; why: string };
/** What the attempt needs: your computers, a leg to one (open, or ended with why), and the page's words for it. */
export type ChatHereHost = {
  list(): Promise<Runner[]>;
  open(r: Runner): Promise<{ link: AgentLink; ended: End | null }>;
  onConnecting(r: Runner): void;
  onFailed(r: Runner, e: End): void;
};
/** What it needs of the page's pairing (agent-ui.ts's mountAgentPairing). */
type Ui = { adopt(link: AgentLink, computer: string): AgentPairing; grant(p: AgentPairing): Promise<void>; live(): boolean; readonly pairing: AgentPairing | null };

const CSS = `
.sbag-box .runners { display: grid; gap: 6px; border-top: 1px solid #e6e9e1; padding-top: 10px; }
.sbag-box .runner { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
`;

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
    try { opened = await host.open(r); } catch (e) { if (mine === attempt) host.onFailed(r, { kind: "lost", why: String((e as Error)?.message ?? e) }); return; }
    if (mine !== attempt || u.live()) { opened.link.close(); return; }
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
    host.list().then((list) => {
      if (!list.length) { status.textContent = RUNNER_COPY.none; return; }
      status.textContent = "";
      for (const r of list) {
        const b = el("button", { type: "button", textContent: RUNNER_COPY.button });
        b.onclick = () => { close(); void start(r); };
        sec.append(el("div", { className: "runner" }, el("span", { textContent: r.name }), b));
      }
    }, (e) => { status.textContent = RUNNER_COPY.failed(String((e as Error)?.message ?? e)); });
    return sec;
  };
}
