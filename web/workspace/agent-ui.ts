// "Connect an agent" (design/workspace-agent-protocol.md §2): the code and port the agent gave, the person's grant
// (which folders; read, or read and write; for how long; remember or not), a bar while it's connected (what it
// may do, how many changes it made, Revoke), and, in Safari, the plain reason it can't work there.
//
//   mountAgentPairing(ws, { button })   wires a page's button (or none: then only a ?pair=CODE&port=N link opens
//                                       it), and offers to reconnect a remembered agent.

import { pairLink } from "./pair-link";
import { AgentPairing, AgentError, takeReloadRecord, reloadDecision, markReloadLeft, type AgentLink, type Created, type GrantStore, type Kept, type ReloadRecord, type ReloadScope } from "./agent-pair";
import { TRASH, nameOf } from "./paths";
import type { NotebookEdit } from "./notebook-edit";
import type { RunVerbs } from "./agent-pair";
import type { BranchHost, gitBranch, gitBranchParams, gitBranchProblem, watchBranches } from "./git-branch";
import type { GitHost, gitServe } from "./git-verbs";

/** What the page needs of its workspace. */
export type PairingWorkspace = GrantStore & {
  forAgent(actor: string, host?: { owner?: () => string | null }): any;
  /** git_branch's host (Workspace.branchHost), and the branches' reconcile: absent, no git_branch on this page. */
  branchHost?(actor: string): BranchHost;
  reconcileBranches?(closed: string): Promise<unknown>;
  watch?(f: () => void): () => void;
  list(folder?: string): Promise<{ path: string; kind: string }[]>;
  stat(p: string): Promise<{ trashed?: { from: string } } | null | undefined>;
};

/** The chips' menus, numbered once for the page: no two mounts give two menus one id. */
let menuSeq = 0;

export const SAFARI = "Safari can't reach a program on this computer: use Chrome or Firefox.";
// (Chrome asks once, per site, before a page may reach a program on this computer (Chrome 149: its "loopback network"
// permission); headless or blocked, the socket fails with ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS.  A paraphrase, not
// Chrome's exact label, which hasn't been seen in a headed browser yet)
export const CHROME_ALLOW = "This browser needs your OK for this site to reach apps on this computer: allow it, then Connect again.";
/** Any other browser (Firefox, …): true whatever the cause. */
export const OTHER_FAIL = "This browser couldn't reach the agent on this computer: check that it's still running, then Connect again.";
/** Where the longer explanations are (William, Nov 8: one short line in the app, the rest behind "Learn more"). */
/** A code without its port: the port is in the link the agent gives, so that's what to ask for. */
/** A code the agent refused (already used, or past its 5 minutes): never the local-network advice, which is for a
 *  connection that got no answer at all. */
export const SPENT_CODE = (program?: string) => program === "sagebrush-agent"
  ? "This code was already used or has expired. Use the newest link sagebrush-agent printed: it prints a new one when the page goes away, or when you press Enter in its terminal."
  : "This code was already used or has expired: ask your agent for a new link.";
export const ONLY_CODE = "That's only the code: ask your agent for its link (sagebrush.space/board/?pair=…), and open it.";

/** What the person put in the Connect dialog: the agent's link (?pair=CODE&port=N, as pasted, with or without its
 * https://), or "CODE PORT" / "CODE:PORT"; a code alone only with the port its ?pair link came with (`port`). */
export function readConnect(text: string, port = ""): { code: string; port: number } | { error: string } {
  const t = text.trim();
  if (!t) return { error: "Paste the link your agent gave." };
  let code = "", p = "";
  const q = /[?&]pair=([^&#\s]*)/.exec(t);
  if (q) {
    // (a malformed %-escape is a link that isn't the agent's, said as any other)
    try { code = decodeURIComponent(q[1]); } catch { return { error: "That link isn't right: ask your agent for its link again." }; }
    p = /[?&]port=([^&#\s]*)/.exec(t)?.[1] ?? "";
    if (!code) return { error: "That link has no code: ask your agent for its link again." };
    if (!p) return { error: "That link has no port: ask your agent for its link again." };
  } else {
    const m = /^([^\s:/?&=]+)(?:\s+|\s*:\s*)(\d+)$/.exec(t);
    if (m) [code, p] = [m[1], m[2]];
    else if (/^[^\s:/?&=]+$/.test(t) && port) [code, p] = [t, port];
    else if (/^[^\s:/?&=]+$/.test(t)) return { error: ONLY_CODE };
    else return { error: "That isn't the agent's link: ask your agent for its link (sagebrush.space/board/?pair=…), and open it." };
  }
  const n = Number(p);
  if (!/^\d+$/.test(p) || !Number.isInteger(n) || n < 1 || n > 65535) return { error: "That link's port isn't right: ask your agent for its link again." };
  return { code, port: n };
}

export const CONNECT_DOCS = "/agents/connect/";
const learnMore = () => { const a = document.createElement("a"); a.href = CONNECT_DOCS; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Learn more"; return a; };
export const isChromium = (ua = navigator.userAgent) => /chrome|chromium|crios|edg/i.test(ua);
export const isSafari = (ua = navigator.userAgent) => /safari/i.test(ua) && !/chrome|chromium|crios|fxios|android|edg/i.test(ua);
/** The one line under a failed Connect: Safari's reason only in Safari, Chrome's permission only in Chrome. */
export const failHint = (ua = navigator.userAgent) => isSafari(ua) ? SAFARI : isChromium(ua) ? CHROME_ALLOW : OTHER_FAIL;
/** The agent as the grant dialog names it: its own claim, "X (as it says)", and its program as well only when that differs
 * ("Claude (as it says, claude-code)"); sagebrush-mcp gives one name for both when its client has no title. */
export const agentSays = (name: string, client: string) => `${name} (as it says${client && client !== name ? ", " + client : ""})`;
/** `f` for a pairing's creation only while that pairing is the one the page has adopted (`current()`): a creation an
 * older or superseded pairing completes is never told to the page. */
export const onlyCurrent = (current: () => AgentPairing | null, f: (c: Created, p: AgentPairing) => void) => (c: Created, p: AgentPairing) => { if (current() === p) f(c, p); };

const CSS = `
.sbag-dlg { position: fixed; inset: 0; background: rgba(20,25,18,.35); display: grid; place-items: center; z-index: 1000; font: 14px/1.45 system-ui, sans-serif; color: #1d241a; }
.sbag-box { background: #fff; border-radius: 10px; padding: 18px 20px; width: min(440px, 92vw); box-shadow: 0 10px 40px rgba(0,0,0,.25); display: grid; gap: 10px; }
.sbag-box h2 { margin: 0; font-size: 16px; }
.sbag-box label { display: flex; gap: 8px; align-items: center; }
.sbag-box input[type=text] { font: inherit; padding: 5px 8px; border: 1px solid #cfd5c8; border-radius: 6px; flex: 1; }
.sbag-box .folders { max-height: 160px; overflow: auto; border: 1px solid #e6e9e1; border-radius: 6px; padding: 6px 8px; display: grid; gap: 2px; }
.sbag-box .row { display: flex; gap: 8px; justify-content: flex-end; }
.sbag-box button { font: inherit; border: 1px solid #cfd5c8; background: #fff; border-radius: 6px; padding: 5px 12px; cursor: pointer; }
.sbag-box button.primary { background: #3f6b35; color: #fff; border-color: #3f6b35; }
.sbag-box .err { color: #9b2c1f; white-space: pre-wrap; }
.sbag-box .note { color: #5c6657; font-size: 12px; }
/* (a compact chip, light and quiet, with the agent's controls in its menu: W4, William Nov 20 2026, "the big black box
   about approval is so ugly and annoying") */
.sbag-bar { position: fixed; left: 12px; bottom: calc(12px + var(--sb-alpha-banner, 0px)); z-index: 999; background: #f4f3ee; color: #24231f; border: 1px solid #e0ddd2; border-radius: 16px; padding: 2px 4px; font: 12px system-ui, sans-serif; display: flex; gap: 6px; align-items: center; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
.sbag-bar button.chip { background: transparent; color: inherit; border: 0; border-radius: 12px; padding: 2px 8px; display: flex; gap: 6px; align-items: center; min-width: 0; max-width: 420px; }
.sbag-bar button.chip > span:not(.dot) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.sbag-bar button.chip:hover, .sbag-bar button.chip[aria-expanded=true] { background: #e9e7de; }
.sbag-bar .dot { width: 7px; height: 7px; border-radius: 50%; background: #4f8a3c; flex: none; }
.sbag-bar .menu { display: none; position: fixed; z-index: 10000; max-height: calc(100vh - 16px); overflow: auto; min-width: 260px; max-width: min(420px, calc(100vw - 16px)); background: #fff; color: #24231f; border: 1px solid #e0ddd2; border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.15); padding: 8px; gap: 6px; }
.sbag-bar.open .menu { display: grid; }
.sbag-bar .menu .items { display: grid; gap: 6px; }
.sbag-bar .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.sbag-bar .menu .full { color: #6b6a63; line-height: 1.4; }
.sbag-bar .menu button { text-align: left; border: 1px solid #e0ddd2; background: #fff; color: #24231f; border-radius: 6px; padding: 5px 10px; }
.sbag-bar .menu button:hover, .sbag-bar .menu button:focus-visible { background: #f4f3ee; }
.sbag-bar .menu button.danger { color: #9b2c1f; border-color: #e8c4bd; }
/* (docked: in the page's own row for it, [data-sbag-slot], never over what the person types in or reads; decided Nov 19 2026) */
.sbag-bar.docked { position: relative; left: auto; bottom: auto; margin: 6px 12px; width: fit-content; max-width: calc(100% - 24px); flex-wrap: wrap; box-shadow: none; }
/* (in a header's row, [data-sbag-inline]: one line, its words cut short, so the header keeps its height) */
[data-sbag-inline] > .sbag-bar.docked { margin: 0; padding: 3px 6px 3px 12px; flex-wrap: nowrap; min-width: 0; max-width: 100%; }
[data-sbag-inline] > .sbag-bar.docked > button.chip { min-width: 0; flex: 0 1 auto; }
[data-sbag-inline] > .sbag-bar.docked > button:not(.chip), [data-sbag-inline] > .sbag-bar.docked .made-slot > button { flex: none; white-space: nowrap; }
.sbag-bar button { font: inherit; border: 0; border-radius: 12px; padding: 3px 10px; background: #fff; color: #24231f; cursor: pointer; }
.sbag-bar button.open { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbag-bar .made-slot { display: contents; }
.sbag-bar .made { display: flex; gap: 8px; align-items: center; padding-left: 10px; border-left: 1px solid #e0ddd2; white-space: nowrap; min-width: 0; max-width: 480px; }
.sbag-bar .made b { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sbag-bar .made button { flex: none; }
.sbag-bar button.cta { background: #8fd17a; color: #10200c; font-weight: 600; padding: 4px 16px; }
`;

let styled = false;
const style = () => { if (styled) return; styled = true; const s = document.createElement("style"); s.textContent = CSS; document.head.append(s); };
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

/** Where a reload restore stands (A14): the page shows it (its bar, its status line, its composer). `canReconnect`: a
 * record this page may still use with one click (the same scope and identity, not expired). */
export type RestoreState =
  | { kind: "restoring" }
  | { kind: "restored" }
  | { kind: "not-restored"; why: "unreachable" | "refused" | "expired" | "discarded" | "unusable" | "not-a-reload"; canReconnect: boolean };
/** A restore attempt's bound (A14 r3.1 §3: one attempt, 10 s, no retry loop). */
export const RESTORE_MS = 10_000;
// (a reload's silent reconnect can reach the agent before its server has seen the old page's connection close: until
// then it answers "another page is paired with this agent". Asked again every BUSY_STEP_MS, for BUSY_FOR_MS at most,
// then given up on as before. Nothing about who may pair changes: the same session, the same refusal otherwise)
export const BUSY_STEP_MS = 250;
export const BUSY_FOR_MS = 2000;
// (exactly the agent server's words, engine/py/python/sagebrush/pairing.py; not the remote computer's, which differ)
const busy = (p: AgentPairing) => /^the agent refused: another page is paired with this agent$/.test(p.closeReason);
// (whether to ask again: a wait of at most what is left of the window, then yes only if the window is still open and
// the attempt still owns the page (`mine`: no other pairing has been adopted meanwhile, as a person's own Connect);
// no attempt ever begins at or after the deadline, nor after it was superseded)
async function again(deadline: number, mine: () => boolean): Promise<boolean> {
  const left = deadline - Date.now();
  if (left <= 0 || !mine()) return false;
  await new Promise((r) => setTimeout(r, Math.min(BUSY_STEP_MS, left)));
  return Date.now() < deadline && mine();
}

/** The page's pairing: a dialog to connect, a bar while connected.  Returns the button's handler. `reload` (A14) turns on
 * the reload record: its scope, and a callback for the restore's states; `quietLoss` leaves an involuntary loss to the
 * page's own bar (no dialog). */
export function mountAgentPairing(ws: PairingWorkspace, o: { button?: HTMLElement | null; onPairing?: (p: AgentPairing) => void; egressTurn?: boolean; notebookEdit?: (edit: NotebookEdit, may: () => boolean, hold?: () => Promise<() => void>, turnId?: string) => Promise<unknown>; branches?: { gitBranch: typeof gitBranch; gitBranchParams: typeof gitBranchParams; gitBranchProblem: typeof gitBranchProblem; watchBranches: typeof watchBranches; gitServe?: typeof gitServe }; reload?: { scope: ReloadScope; storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null; onState?: (s: RestoreState) => void; onRemembered?: (g: Kept["grant"]) => void }; quietLoss?: boolean; program?: string; runVerbs?: RunVerbs; extra?: (close: () => void) => HTMLElement; open?: (c: Created) => void; onCreated?: (c: Created, p: AgentPairing) => void } = {}) {
  style();
  // `program`: the page's own program (the Agents page: sagebrush-agent) named in the dialog instead of sagebrush-mcp
  const named = (s: string) => o.program ? s.replace(/(the agent's |your agent's )?sagebrush-mcp/g, o.program) : s;
  let pairing: AgentPairing | null = null;
  let bar: HTMLElement | null = null;
  const trashEntry = async (p: string) => (await ws.stat(p)) as any;
  const page = { origin: location.origin, path: location.pathname };
  // (a page in a frame of this tab (the Agents page's .tex pane): the tab's reload record is the top page's, so this
  //  page's pairing neither takes it, writes it, nor marks it left; it pairs as any page without a record does)
  let framed = true;
  try { framed = window.top !== window; } catch { framed = true; }
  if (framed && o.reload) o = { ...o, reload: undefined };
  // (the reload record's storage: this tab's sessionStorage, or none if it can't be reached)
  let storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = null;
  if (o.reload) { try { storage = o.reload.storage === undefined ? sessionStorage : o.reload.storage; } catch { storage = null; } }
  let leaving = false;
  if (o.reload) {
    addEventListener("pagehide", () => { leaving = true; markReloadLeft(storage, Date.now()); });
    addEventListener("pageshow", (e) => { if ((e as PageTransitionEvent).persisted) leaving = false; });
  }
  // (an agent's runs of code (chat plan PR 4a): the page's run-holder.ts, only where the page offers them)
  const runVerbs = o.runVerbs;
  const make = (port: number, how: { code: string } | { session: string; pairingId: string; agent?: { name: string; client: string } } | { link: AgentLink; computer: string }) =>
    new AgentPairing(port, how, { verbsFor: (actor, host) => ws.forAgent(actor, host), ...(ws.branchHost && o.branches ? { gitBranch: { params: o.branches.gitBranchParams, problem: o.branches.gitBranchProblem, run: (a) => o.branches!.gitBranch(ws.branchHost!(a.actor), a) } } : {}), ...(ws.branchHost && o.branches?.gitServe ? { gitVerbs: o.branches.gitServe(ws as unknown as { branchHost(actor: string): GitHost }) } : {}), store: ws, trashEntry, page, ...(runVerbs ? { runVerbs } : {}), ...(o.notebookEdit ? { notebookEdit: o.notebookEdit } : {}), ...(o.egressTurn ? { egressTurn: true } : {}), ...(o.onCreated ? { onCreated: onlyCurrent(() => pairing, o.onCreated) } : {}), ...(o.reload ? { reload: { storage, scope: o.reload.scope, leaving: () => leaving } } : {}) });
  // (the branches' records made right with their folders: now, and whenever the workspace changes; chat plan PR 3)
  // (`branches`: git_branch and its reconcile, on the pages that offer it (they import git-branch.ts), never in a
  //  pairing chunk of a page that doesn't, the LaTeX page's)
  if (o.branches && ws.branchHost && ws.reconcileBranches && ws.watch) o.branches.watchBranches(ws as any);
  // (a parsed, same-scope record kept in memory for one [Reconnect]; never written back)
  let kept: ReloadRecord | null = null;

  function dialog(title: string, body: (box: HTMLElement, close: () => void) => void, onClose?: () => void) {
    const box = h("div", { className: "sbag-box" }, h("h2", { textContent: title }));
    const dlg = h("div", { className: "sbag-dlg" }, box);
    dlg.setAttribute("role", "dialog");
    const close = () => { if (!dlg.isConnected) return; dlg.remove(); onClose?.(); };
    dlg.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    body(box, close);
    document.body.append(dlg);
    return close;
  }

  // (the chip's menu closes on a press anywhere else on the page, and when the page scrolls or resizes under it)
  let closeMenu: (() => void) | null = null;
  // (what the bar is drawn from, but for its counts: the same, its words are updated in place, so focus and a press
  //  under way are kept; else it is drawn again)
  let barKey = "";
  let barText: ((short: string, full: string) => void) | null = null;
  // (what the agent made last, Open beside it: replaced on its own, never redrawing the chip)
  let barMade: ((made: Created | null) => void) | null = null;
  // (the pairing the chip shows: its controls act on it alone)
  let shownP: AgentPairing | null = null;
  document.addEventListener("pointerdown", (e) => { if (bar && closeMenu && !bar.contains(e.target as Node)) closeMenu(); }, true);
  addEventListener("resize", () => closeMenu?.());
  addEventListener("scroll", (e) => { if (bar && !bar.contains(e.target as Node)) closeMenu?.(); }, true);

  function showBar() {
    const p = pairing;
    if (!p || p.state !== "granted" || !p.grant) { bar?.remove(); bar = null; barKey = ""; barText = null; barMade = null; closeMenu = null; shownP = null; return; }
    const g = p.grant;
    const where = g.folders.includes("/") ? "everywhere" : "in " + g.folders.join(", ");
    const changes = `${p.changes} change${p.changes === 1 ? "" : "s"}`;
    // (the whole of it, as the menu's description and the chip's title; the chip says it short: W4)
    const full = `${p.hello!.agent.name} on ${p.link ? p.computer : "your computer"}: ${g.write ? "can read and write" : "can only read"} ${where}${g.run ? " · may run code" : ""} · ${changes}`;
    const short = `${p.hello!.agent.name} · ${g.write ? "can edit" : "read only"}${g.folders.includes("/") ? "" : " · some folders"}${g.run ? " · can run code" : ""} · ${changes}`;
    const made = o.open && p.created ? p.created : null;
    // (the controls the chip holds: the same, it is updated in place (its words, and Open), never redrawn)
    const key = JSON.stringify([p.hello!.agent.name, !!p.link, p.computer ?? "", g.run]);
    if (bar && key === barKey && barText && barMade && p === shownP) { barText(short, full); barMade(made); return; }
    // (drawn again: an open menu stays open, and the focus goes back to the same kind of control: the chip, the same
    //  place in the menu (or its first, where that control is gone), or Open)
    const wasOpen = !!bar?.classList.contains("open");
    const act = bar && bar.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const had = !act ? null : act.classList.contains("chip") ? { kind: "chip" } : act.getAttribute("role") === "menuitem" ? { kind: "item", i: [...act.parentElement!.children].indexOf(act) } : { kind: "open" };
    bar?.remove();
    // (over a runner, Revoke is a Disconnect that also stops the agent there: the runner ends its process group)
    const revoke = p.link ? h("button", { textContent: "Disconnect", title: `Disconnect and stop the agent on ${p.computer}` }) : h("button", { textContent: "Revoke" });
    revoke.className = "danger";
    // (only the pairing this chip was drawn for, while the chip still shows it and it is still the page's and granted: a
    //  chip left from another, even one pressed after a newer pairing is granted, acts on nothing)
    const drawn = p;
    const shown = () => (drawn === shownP && drawn === pairing && drawn.state === "granted" ? drawn : null);
    revoke.onclick = () => { const q = shown(); if (q) void q.revoke("revoked by the person"); else showBar(); };
    // ("May run code" turned off here, mid-session: a run going ends (chat plan PR 4); turned on only by a new grant)
    const noRun = g.run ? h("button", { textContent: "Turn off running code", title: "The agent may no longer run code, and a run going now stops (connect it again to allow it)" }) : null;
    if (noRun) noRun.onclick = () => { const q = shown(); if (q) void q.noRun(); else showBar(); };
    // (Open: what the agent created last, where the page can open it (its `open`), as Files would)
    // (a board it made opens in a tab of its own, never by itself (a tab only opens on a click, and this page keeps the
    //  pairing): said as what the agent did, with Open beside it, the bar's one call to action)
    const madeSlot = h("span", { className: "made-slot" });
    let openBtn: HTMLButtonElement | null = null;
    // (the same thing made again (the counts moved): the same button, so a press already under way on it still lands)
    let madeKey: string | null = null, madeNow: Created | null = null;
    barMade = (m) => {
      madeNow = m;
      const mk = m ? JSON.stringify([m.kind, m.path]) : "";
      if (mk === madeKey) return;
      madeKey = mk;
      const board = m?.kind === "board";
      const open = m ? h("button", { className: board ? "cta" : "open", textContent: board ? "Open" : "Open " + nameOf(m.path), title: board ? `Open ${m.path} in a new tab, where its code runs` : `Open ${m.path}` }) : null;
      if (open) open.onclick = () => { if (madeNow) o.open!(madeNow); };
      const did = board && open ? h("span", { className: "made" }, `${p.hello!.agent.name} made`, h("b", { textContent: nameOf(m!.path) }), open) : open;
      const focused = !!openBtn && document.activeElement === openBtn;
      madeSlot.replaceChildren(...(did ? [did] : []));
      openBtn = open;
      if (focused) openBtn?.focus();
    };
    barMade(made);
    // (the chip, and its menu: what the agent may do, Turn off running code, and Revoke one click away; by keyboard too:
    //  Enter, Space or ↓ opens it on its first control, ↑ ↓ Home End move, Escape closes it back on the chip, Tab closes it)
    const n = ++menuSeq;
    const chipWords = h("span", { textContent: short });
    const arrow = h("span", { textContent: "▾" });
    arrow.setAttribute("aria-hidden", "true");
    const chip = h("button", { className: "chip", title: full }, h("span", { className: "dot" }), chipWords, arrow);
    const items = [...(noRun ? [noRun] : []), revoke];
    const fullEl = h("div", { className: "full", id: `sbag-menu-desc-${n}`, textContent: full });
    const list = h("div", { className: "items", id: `sbag-menu-${n}` }, ...items);
    list.setAttribute("role", "menu");
    list.setAttribute("aria-label", `${p.hello!.agent.name}: access`);
    list.setAttribute("aria-describedby", fullEl.id);
    for (const b of items) { b.setAttribute("role", "menuitem"); b.tabIndex = -1; }
    const menu = h("div", { className: "menu" }, fullEl, list);
    chip.setAttribute("aria-haspopup", "menu");
    chip.setAttribute("aria-expanded", "false");
    chip.setAttribute("aria-controls", list.id);
    // (said to a screen reader as it changes: the summary only, never the menu)
    const said = h("span", { className: "sr", textContent: short });
    said.setAttribute("role", "status");
    barText = (sh, fu) => { chipWords.textContent = sh; said.textContent = sh; chip.title = fu; fullEl.textContent = fu; };
    const place = () => {
      // (fixed, from the chip's own box: no ancestor clips it; above the chip where there is room, else below; kept
      //  within the window's width)
      const r = chip.getBoundingClientRect(), w = menu.offsetWidth, ht = menu.offsetHeight;
      menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
      const top = r.top - ht - 6 >= 8 ? r.top - ht - 6 : r.bottom + 6;
      menu.style.top = `${Math.max(8, Math.min(top, innerHeight - ht - 8))}px`;
    };
    const show = (on: boolean, focus = on) => {
      if (!bar) return;
      bar.classList.toggle("open", on);
      chip.setAttribute("aria-expanded", String(on));
      if (on) place();
      if (on && focus) items[0].focus();
      else if (!on && focus) chip.focus();
    };
    chip.onclick = () => show(!bar?.classList.contains("open"));
    chip.onkeydown = (e) => { if (e.key === "ArrowDown") { e.preventDefault(); show(true); } };
    list.onkeydown = (e) => {
      // (a key held down from the chip's Enter never repeats onto a control: Revoke may be the first)
      if (e.repeat && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); return; }
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") { e.preventDefault(); show(false, true); }
      else if (e.key === "Tab") show(false, false);
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus(); }
      else if (e.key === "Home" || e.key === "End") { e.preventDefault(); items[e.key === "Home" ? 0 : items.length - 1].focus(); }
    };
    closeMenu = () => show(false, false);
    bar = h("div", { className: "sbag-bar" }, chip, menu, said, madeSlot);
    shownP = p;
    barKey = key;
    dock();
    if (wasOpen) show(true, false);
    if (had?.kind === "chip") chip.focus();
    else if (had?.kind === "item") (items[had.i] ?? items[0]).focus();
    else if (had?.kind === "open") (openBtn ?? chip).focus();
  }
  // (the bar's place: a [data-sbag-slot] the page shows, a row or a header of its layout, the highest-numbered one (an
  //  editor's page over the notebook page's); an overlay at the bottom left only on a page that has none. Placed again,
  //  once per frame at most, when the page changes what it shows, as to the LaTeX or code page and back)
  function dock() {
    if (!bar) return;
    let slot: HTMLElement | null = null;
    for (const e of document.querySelectorAll<HTMLElement>("[data-sbag-slot]")) if (e.offsetParent !== null && (!slot || +e.dataset.sbagSlot! > +slot.dataset.sbagSlot!)) slot = e;
    bar.classList.toggle("docked", !!slot);
    if (bar.parentElement !== (slot ?? document.body)) (slot ?? document.body).append(bar);
  }
  let docking = false;
  new MutationObserver(() => { if (bar && !docking) { docking = true; requestAnimationFrame(() => { docking = false; dock(); }); } }).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "hidden"], childList: true, subtree: true });

  async function grantDialog(p: AgentPairing) {
    const top = (await ws.list("/")).filter((e) => e.kind === "folder" && e.path !== TRASH).map((e) => e.path);
    const hello = p.hello!;
    dialog("Allow this agent?", (box, close) => {
      box.append(h("div", { textContent: `${agentSays(hello.agent.name, hello.agent.client)} wants to ${hello.wants.write ? "read and change" : "read"} files in your workspace.` }));
      // (Everything ticked when it opens: the default, D; the folders a narrowing, chat plan r4)
      const all = h("input", { type: "checkbox" });
      all.checked = true;
      const boxes = top.map((f) => { const c = h("input", { type: "checkbox", value: f }); c.checked = !!hello.wants.folders?.includes(f); return c; });
      const folders = h("div", { className: "folders" }, h("label", {}, all, h("b", { textContent: "Everything" })), ...top.map((f, i) => h("label", {}, boxes[i], f)));
      if (!top.length) folders.append(h("div", { className: "note", textContent: "There are no folders yet: only Everything can be granted." }));
      all.onchange = () => { for (const c of boxes) c.disabled = all.checked; };
      for (const c of boxes) c.disabled = true;
      const write = h("input", { type: "checkbox" });
      write.checked = !!hello.wants.write;
      // ("May run code" (design/workspace-files.md §8.3): on for the person's own agent, the one they connected here with
      //  its code; board's C4 line under it)
      const run = h("input", { type: "checkbox" });
      run.checked = true;
      // (over a runner nothing is kept in B: no reload record, no remembered grant)
      const how = h("select", {}, h("option", { value: "3600000", textContent: "for 1 hour" }), h("option", { value: "page", textContent: o.reload && !p.link ? "while this page is open (a reload keeps it)" : "until I close this page" }), h("option", { value: "86400000", textContent: "for 1 day" }));
      const remember = h("input", { type: "checkbox" });
      const syncRemember = () => { remember.disabled = how.value === "page"; if (remember.disabled) remember.checked = false; };
      how.onchange = syncRemember;
      syncRemember();
      const err = h("div", { className: "err" });
      const allow = h("button", { className: "primary", textContent: "Allow" });
      const cancel = h("button", { textContent: "Cancel" });
      cancel.onclick = () => { close(); void p.revoke("not allowed"); };
      allow.onclick = async () => {
        const chosen = all.checked ? ["/"] : boxes.filter((c) => c.checked).map((c) => c.value);
        if (!chosen.length) { err.textContent = "Choose at least one folder (or Everything)."; return; }
        try {
          await p.allow({ folders: chosen, write: write.checked, run: run.checked, expires: how.value === "page" ? null : Date.now() + Number(how.value) }, remember.checked);
          close();
          showBar();
        } catch (e) { err.textContent = String((e as Error).message ?? e); }
      };
      box.append(h("div", { textContent: "Folders it may use:" }), folders, h("label", {}, write, "may change files (else read only)"), h("label", {}, run, "May run code"), h("div", { className: "note", textContent: "Runs notebooks and .py and .sage files in Sagebrush's sandbox, using only the files it may read and write." }), h("label", {}, "Allow it ", how), ...(p.link ? [] : [h("label", {}, remember, "Remember this agent (reconnect without a new code)")]), err, h("div", { className: "row" }, cancel, allow));
      // (focus on its first control when it opens, as the code dialog does: a keyboard path lands in it; board's B-A14-2)
      setTimeout(() => all.focus());
    });
  }

  function watch(p: AgentPairing) {
    pairing = p;
    showBar(); // (a newer pairing, not yet granted: the chip of the one before goes now)
    o.onPairing?.(p);
    let was = false;
    p.onChange(() => {
      showBar();
      if (p.state === "paired" || p.state === "granted") was = true;
      // (S2: the kept record belongs to the lifetime it came from: a newer pairing granted, or this one's own Revoke
      //  or expiry, ends it; only this pairing's own loss puts its own record there)
      if (p.state === "granted" && pairing === p) kept = null;
      if (p.state === "closed" && pairing === p && /^revoked by the person$|^the grant expired$/.test(p.closeReason)) kept = null;
      // (a refused hello is said in the Connect dialog itself; this is for a pairing that was connected)
      if (was && p.state === "closed" && p.closeReason && !/^revoked by the person$|^not allowed$/.test(p.closeReason)) {
        if (pairing === p && p.closeReason !== "the grant expired") kept = p.lostRecord;
        if (o.quietLoss) return;
        dialog("The agent is disconnected", (box, close) => {
          box.append(h("div", { className: "err", textContent: p.closeReason }));
          const okb = h("button", { className: "primary", textContent: "OK" });
          okb.onclick = close;
          box.append(h("div", { className: "row" }, okb));
        });
      }
    });
  }

  /** The Connect dialog. `back` (A14 §3): where focus returns if it closes without connecting (the page's bar button). */
  function connect(code = "", port = "", back?: HTMLElement) {
    if (isSafari() && o.extra) {
      // (Safari can't reach a program on this computer; the page's other way to connect (Chat here) it can use)
      if (pairing && pairing.state !== "closed") { showBar(); return; }
      dialog("Connect an agent", (box, close) => { const okb = h("button", { textContent: "Cancel" }); okb.onclick = close; box.append(o.extra!(close), h("div", { className: "note" }, SAFARI, " ", learnMore()), h("div", { className: "row" }, okb)); }, () => { if (back?.isConnected && !pairingLive()) back.focus(); });
      return;
    }
    if (isSafari()) {
      dialog("Connect an agent", (box, close) => { const okb = h("button", { className: "primary", textContent: "OK" }); okb.onclick = close; box.append(h("div", { textContent: SAFARI }, " ", learnMore()), h("div", { className: "row" }, okb)); });
      return;
    }
    if (pairing && pairing.state !== "closed") { showBar(); return; }
    dialog("Connect an agent", (box, close) => {
      // (one field: the link the agent gave, pasted, or its code and port; a ?pair link fills in the code and keeps its
      //  port (decided Nov 19 2026), so nobody types a port)
      const c = h("input", { type: "text", placeholder: "the link the agent gave", value: code, autocomplete: "off" });
      const err = h("div", { className: "err" });
      if (code && !port) err.textContent = ONLY_CODE;
      const go = h("button", { className: "primary", textContent: "Connect" });
      const cancel = h("button", { textContent: "Cancel" });
      cancel.onclick = close;
      go.onclick = async () => {
        err.textContent = "";
        const r = readConnect(c.value, c.value.trim() === code ? port : "");
        if ("error" in r) { err.textContent = r.error; return; }
        const n = r.port;
        go.disabled = true;
        go.textContent = "Connecting…"; // (a second try shows it is trying: never a button that seems to do nothing)
        // (a socket the browser blocks, by the page's security policy or a refused local-network permission,
        // may never say so: the connection gets 8 s, and a policy violation is said at once)
        let blocked = "";
        const onViolation = (e: SecurityPolicyViolationEvent) => { if (/^wss?:\/\/(127\.0\.0\.1|localhost)/.test(e.blockedURI)) blocked = "this page's security policy blocked the connection to the agent"; };
        document.addEventListener("securitypolicyviolation", onViolation);
        try {
          const p = make(n, { code: r.code });
          watch(p);
          await Promise.race([
            p.paired(),
            new Promise((_, reject) => {
              const t0 = Date.now();
              const tick = () => {
                if (p.state !== "connecting") return;
                if (blocked || Date.now() - t0 > 8000) {
                  void p.revoke(blocked || "no answer from the agent");
                  reject(new Error(blocked ? `Couldn't connect: ${blocked}.` : "Couldn't reach the agent: is it still running, and did this browser allow the page to reach apps on this device?"));
                } else setTimeout(tick, 200);
              };
              tick();
            }),
          ]);
          document.removeEventListener("securitypolicyviolation", onViolation);
          close();
          await grantDialog(p);
        } catch (e) {
          document.removeEventListener("securitypolicyviolation", onViolation);
          go.disabled = false;
          go.textContent = "Connect";
          const m = String((e as Error).message ?? e);
          const failed = /^the connection failed/.test(m); // (nothing answered: not a refusal by the agent)
          // (the agent answered, and refused the code: it was spent or expired; nothing about this browser's permissions)
          if (!failed && (e as any)?.code === "refused" && /wrong or expired code|code has expired/i.test(m)) {
            err.textContent = SPENT_CODE(o.program);
            c.value = "";
            return;
          }
          err.textContent = (/^refused|^protocol/.test(String((e as any)?.code)) && !failed && !/^the agent refused/i.test(m) ? "The agent refused: " : "") + named(m) + (/failed/.test(String((e as Error).message)) ? "\n\n" + failHint() : "");
          if (/failed/.test(String((e as Error).message))) err.append(" ", learnMore());
        }
      };
      // (this page was connected earlier: its own way back first, with no code: Reconnect, or a remembered grant)
      const earlier = h("div", { className: "row earlier" });
      earlier.hidden = true;
      const back1 = kept ?? pairing?.lostRecord ?? null;
      if (back1) {
        const rb = h("button", { className: "primary", textContent: "Reconnect" });
        rb.onclick = () => { close(); void reconnectKept(); };
        earlier.append(h("span", { textContent: "Claude was connected to this page earlier." }), rb);
        earlier.hidden = false;
      } else {
        void remembered().then((g) => {
          if (!g || !box.isConnected || pairingLive()) return;
          const ub = h("button", { className: "primary", textContent: "Use remembered access" });
          ub.onclick = () => { close(); void reconnect(); };
          earlier.append(h("span", { textContent: "This page remembers an agent." }), ub);
          earlier.hidden = false;
        });
      }
      box.append(earlier, h("div", { className: "note", textContent: o.program ? `Start ${o.program} in a terminal on this computer: it prints a link. Open it, or paste it here.` : "Ask your agent (Claude Code, Codex, …, with sagebrush-mcp) to connect to Sagebrush: it gives a link. Open it, or paste it here." }),
        h("label", {}, "Link ", c), err, h("div", { className: "row" }, cancel, go), ...(o.extra ? [o.extra(close)] : []));
      setTimeout(() => c.focus());
    }, () => { if (back?.isConnected && !pairingLive()) back.focus(); });
  }
  const pairingLive = () => !!pairing && pairing.state !== "closed";

  /** The first remembered grant still in force, for the page's "Use remembered access" (A14 N6); null if none. */
  async function remembered(): Promise<Kept["grant"] | null> {
    try {
      const all = (await ws.agentGrants()) as Record<string, Kept>;
      return Object.values(all).find((k) => k?.grant && k.session && (k.grant.expires === null || Date.now() < k.grant.expires))?.grant ?? null;
    } catch { return null; }
  }
  /** A remembered agent: reconnect with its session, and give it the same grant again (if it hasn't expired). The
   * grant given, or null. */
  async function reconnect(): Promise<Kept["grant"] | null> {
    const kept = (await ws.agentGrants()) as Record<string, Kept>;
    for (const [id, k] of Object.entries(kept)) {
      if (!k?.grant || !k.session || (k.grant.expires !== null && !(Date.now() < k.grant.expires))) { await ws.putAgentGrant(id, null); continue; }
      const deadline = Date.now() + BUSY_FOR_MS;
      for (;;) {
        let p: AgentPairing | null = null;
        try {
          if (k.grant.expires !== null && !(Date.now() < k.grant.expires)) break; // (expired while it waited)
          p = make(k.port, { session: k.session, pairingId: id });
          watch(p);
          await p.paired();
          // (superseded meanwhile by a pairing the person chose: this attempt goes, touching nothing of theirs)
          if (pairing !== p) { p.drop(); return null; }
          // (expired while it paired: an attempt asked in time can be answered after the expiry; never given then, as
          //  restoreWith's)
          if (k.grant.expires !== null && !(Date.now() < k.grant.expires)) { void p.revoke("the grant expired"); break; }
          await p.allow({ folders: k.grant.folders, write: k.grant.write, run: k.grant.run === true, expires: k.grant.expires, id: k.grant.id }, true);
          // (superseded while the grant was being given, by a Connect submitted meanwhile: its socket goes too, so no
          //  granted connection outlives the person's choice)
          if (pairing !== p) { p.drop(); return null; }
          showBar();
          return k.grant;
        } catch {
          // (the old page's connection not yet seen closed: asked again, briefly, while this attempt still owns the page)
          const tried = p;
          if (tried && busy(tried) && (await again(deadline, () => pairing === tried))) continue;
          if (tried && pairing !== tried) return null;
          /* (the server restarted, or the agent is gone: a new code is needed; the grant stays until it expires or is revoked) */
          break;
        }
      }
    }
    return null;
  }

  /** One attempt with a reload record (A14): its session, at most RESTORE_MS; the agent must be the one it was, the
   * grant not expired; then exactly its grant again (never wider, never longer), which writes the record anew. With
   * the pairing it made (null if none), so a caller can tell whether a newer pairing replaced it meanwhile (S2). */
  async function restoreWith(r: ReloadRecord): Promise<{ res: "ok" | "unreachable" | "refused" | "expired"; p: AgentPairing | null }> {
    if (r.grant.expires !== null && !(Date.now() < r.grant.expires)) return { res: "expired", p: null };
    let p: AgentPairing;
    const timeout = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), RESTORE_MS));
    const deadline = Date.now() + BUSY_FOR_MS;
    let got: "paired" | "refused" | "unreachable" | "timeout";
    for (;;) {
      if (r.grant.expires !== null && !(Date.now() < r.grant.expires)) return { res: "expired", p: null }; // (expired while it waited)
      try { p = make(r.port, { session: r.session, pairingId: r.pairingId, agent: r.agent }); } catch { return { res: "unreachable", p: null }; }
      watch(p);
      got = await Promise.race([p.paired().then(() => "paired" as const, (e) => (e instanceof AgentError && e.code !== "refused" ? "refused" : /^the agent refused/.test(p.closeReason) ? "refused" : "unreachable") as "refused" | "unreachable"), timeout]);
      // (the old page's connection not yet seen closed: asked again, briefly, within RESTORE_MS)
      const tried = p;
      if (got === "refused" && busy(tried) && (await again(deadline, () => pairing === tried))) continue;
      break;
    }
    // (superseded meanwhile by a pairing the person chose: the caller's current(p) says nothing and keeps nothing)
    if (pairing !== p) { if (got === "paired") p.drop(); return { res: "unreachable", p }; }
    if (got === "timeout") { void p.revoke("no answer from the agent"); return { res: "unreachable", p }; }
    if (got !== "paired") return { res: got, p };
    if (r.grant.expires !== null && !(Date.now() < r.grant.expires)) { void p.revoke("the grant expired"); return { res: "expired", p }; }
    if (pairing !== p) { p.drop(); return { res: "unreachable", p }; }
    try { await p.allow({ folders: r.grant.folders, write: r.grant.write, run: r.grant.run === true, expires: r.grant.expires, ...(r.grant.id ? { id: r.grant.id } : {}) }, false); } catch { void p.revoke("the grant couldn't be given again"); return { res: "refused", p }; }
    if (pairing !== p) { p.drop(); return { res: "unreachable", p }; } // (superseded while the grant was being given)
    showBar();
    return { res: "ok", p };
  }
  const say = (s: RestoreState) => o.reload?.onState?.(s);
  /** The page's [Reconnect] (A14): the record kept in memory, once. A refusal or an expiry ends it; an unreachable
   * agent leaves it for the next click. */
  /** Whether an attempt's result may still speak: no newer pairing was adopted after the one it made (S2). */
  const current = (p: AgentPairing | null) => p === null || p === pairing;
  async function reconnectKept(): Promise<RestoreState> {
    const r = kept ?? pairing?.lostRecord ?? null;
    if (!r) { const s: RestoreState = { kind: "not-restored", why: "discarded", canReconnect: false }; say(s); return s; }
    say({ kind: "restoring" });
    const { res, p } = await restoreWith(r);
    // (a late result, after a newer pairing replaced this attempt, says nothing and keeps nothing)
    if (!current(p)) return { kind: "not-restored", why: "discarded", canReconnect: false };
    if (res === "ok") { kept = null; const s: RestoreState = { kind: "restored" }; say(s); return s; }
    kept = res === "unreachable" ? r : null; // (unreachable: the SAME record stays for the next click)
    const s: RestoreState = { kind: "not-restored", why: res, canReconnect: res === "unreachable" };
    say(s);
    return s;
  }
  /** On load (A14 §1): the reload record, taken (consumed before anything), decided; with no record, the remembered
   * grants as before. After a record that wasn't restored, a remembered grant is not tried silently. */
  async function restoreOnLoad() {
    const t = o.reload ? takeReloadRecord(storage) : ({ kind: "none" } as const);
    // (genuinely no record: the remembered reconnect, as before; an unusable one (unreadable, not removable, malformed)
    //  is said, and a remembered grant is only offered, never tried in its place, S1)
    if (t.kind === "none") { const g = await reconnect(); if (g) o.reload?.onRemembered?.(g); return; }
    if (t.kind === "bad") return say({ kind: "not-restored", why: "unusable", canReconnect: false });
    const r = t.record;
    const nav = (performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined)?.type ?? "navigate";
    const d = reloadDecision(r, { scope: o.reload!.scope, navType: nav, now: Date.now() });
    // (discarded: its grant over, another workspace or page, or not a reload of this tab: the last needs a new Allow)
    const sameScope = r.workspace === o.reload!.scope.workspace && r.page === o.reload!.scope.page;
    if (d === "discard") return say({ kind: "not-restored", why: r.grant.expires !== null && !(Date.now() < r.grant.expires) ? "expired" : sameScope ? "not-a-reload" : "discarded", canReconnect: false });
    if (d === "click") { kept = r; return say({ kind: "not-restored", why: "not-a-reload", canReconnect: true }); }
    say({ kind: "restoring" });
    const { res, p } = await restoreWith(r);
    if (!current(p)) return;
    if (res === "ok") return say({ kind: "restored" });
    kept = res === "unreachable" ? r : null;
    say({ kind: "not-restored", why: res, canReconnect: res === "unreachable" });
  }

  if (o.button) o.button.addEventListener("click", () => connect());
  const link = pairLink();
  if (link) connect(link.code, link.port);
  // (in a microtask: the caller has this function's result before any restore state is said to it)
  else queueMicrotask(() => void restoreOnLoad());
  return { connect, reconnectKept, remembered, useRemembered: () => reconnect(), get canReconnect() { return !!(kept ?? pairing?.lostRecord); }, get pairing() { return pairing; },
    // (another way to connect, the page's own (the Agents page's Chat here): a pairing over its link, watched as any,
    //  and the grant dialog for it)
    adopt: (link: AgentLink, computer: string) => { const p = make(0, { link, computer }); watch(p); return p; }, grant: (p: AgentPairing) => grantDialog(p), live: () => pairingLive() };
}
