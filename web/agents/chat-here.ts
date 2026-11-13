// "Chat here", the Agents page's own: your computers in the Connect dialog, each with Chat here, and the
// attempt it starts: a leg to that computer's agent (agent-relay.ts), then a pairing over it (agent-ui.ts's adopt) and
// the grant dialog. Kept out of agent-ui.ts, which every page's pairing chunk carries; only this page has it.

import type { AgentLink, AgentPairing } from "../workspace/agent-pair";

/** The Connect dialog's words for your computers, word for word as reviewed. */
export const RUNNER_COPY = {
  heading: "Or chat with an agent on one of your computers:",
  button: "Chat here",
  finding: "Finding your computers…",
  none: "None of your computers is set up for this. On one, run: sagebrush remote login",
  failed: (reason: string) => `Your computers: ${reason}`,
  signIn: "Sign in with CoCalc",
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
  function section(close: () => void): HTMLElement {
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
    }, (e) => {
      status.textContent = RUNNER_COPY.failed(String((e as Error)?.message ?? e));
      // (signed out: the site's own sign-in, back to this page after)
      if ((e as { signedOut?: boolean })?.signedOut) sec.append(el("a", { className: "sign-in", href: `/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`, textContent: RUNNER_COPY.signIn }));
    });
    return sec;
  }
  // (the section for the Connect dialog, and Chat here itself, for the header's agent menu)
  return Object.assign(section, { start: (r: Runner) => void start(r) });
}

/** The shell-and-files switch's words (an agent on one of the person's computers), word for word as reviewed. */
export const NATIVE_COPY = {
  label: (computer: string) => `Allow shell and files on ${computer}`,
  scope: (agent: string, computer: string) => `${agent} runs as you on ${computer}: it can run commands and read and change files there, asking first as it does in a terminal.`,
  bar: (on: boolean) => (on ? "shell and files on" : "Sagebrush files only"),
};

/** The grant dialog's switch for an agent on one of the person's computers: on by default, with its one line of scope. */
export function nativeSwitch(p: { computer: string; hello: { agent: { name: string } } | null }) {
  const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: true });
  const label = document.createElement("label");
  label.append(box, NATIVE_COPY.label(p.computer));
  const note = Object.assign(document.createElement("div"), { className: "note", textContent: NATIVE_COPY.scope(p.hello?.agent.name ?? "The agent", p.computer) });
  return { nodes: [label, note], native: () => box.checked };
}

/** The bar's mode: the one the agent says it enforces (its agent.mode, kept by the page), else the one asked for. One
 *  element, which the page updates when the agent says. */
const said = new WeakMap<object, boolean>();
const shown = new WeakMap<object, HTMLElement>();
export function nativeBar(p: object & { grant: { native?: boolean } | null }) {
  const el = document.createElement("span");
  el.textContent = NATIVE_COPY.bar(said.get(p) ?? p.grant?.native === true);
  shown.set(p, el);
  return el;
}
/** The agent's agent.mode, for that pairing's bar. */
export function agentMode(p: object, params: unknown) {
  const n = (params as { native?: unknown } | null)?.native;
  if (typeof n !== "boolean") return;
  said.set(p, n);
  const el = shown.get(p);
  if (el) el.textContent = NATIVE_COPY.bar(n);
}
