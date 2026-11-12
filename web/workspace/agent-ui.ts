// "Connect an agent" (design/workspace-agent-protocol.md §2): the code and port the agent gave, the person's grant
// (which folders; read, or read and write; for how long; remember or not), a bar while it's connected (what it
// may do, how many changes it made, Revoke), and, in Safari, the plain reason it can't work there.
//
//   mountAgentPairing(ws, { button })   wires a page's button (or none: then only a ?pair=CODE&port=N link opens
//                                       it), and offers to reconnect a remembered agent.

import { pairLink } from "./pair-link";
import { AgentPairing, AgentError, takeReloadRecord, reloadDecision, markReloadLeft, type GrantStore, type Kept, type ReloadRecord, type ReloadScope } from "./agent-pair";
import { TRASH } from "./paths";
import type { NotebookEdit } from "./notebook-edit";
import type { RunVerbs } from "./agent-pair";
import type { BranchHost, gitBranch, gitBranchParams, gitBranchProblem, watchBranches } from "./git-branch";
import type { GIT_VERBS, GitHost } from "./git-verbs";

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

export const SAFARI = "Safari can't reach a program on this computer: use Chrome or Firefox.";
// (Chrome asks once, per site, before a page may reach a program on this computer (Chrome 149: its "loopback network"
// permission); headless or blocked, the socket fails with ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS.  A paraphrase, not
// Chrome's exact label, which hasn't been seen in a headed browser yet)
export const CHROME_ALLOW = "This browser needs your OK for this site to reach apps on this computer: allow it, then Connect again.";
/** Any other browser (Firefox, …): true whatever the cause. */
export const OTHER_FAIL = "This browser couldn't reach the agent on this computer: check that it's still running, then Connect again.";
/** Where the longer explanations are (William, Nov 8: one short line in the app, the rest behind "Learn more"). */
export const CONNECT_DOCS = "/agents/connect/";
const learnMore = () => { const a = document.createElement("a"); a.href = CONNECT_DOCS; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Learn more"; return a; };
export const isChromium = (ua = navigator.userAgent) => /chrome|chromium|crios|edg/i.test(ua);
export const isSafari = (ua = navigator.userAgent) => /safari/i.test(ua) && !/chrome|chromium|crios|fxios|android|edg/i.test(ua);
/** The one line under a failed Connect: Safari's reason only in Safari, Chrome's permission only in Chrome. */
export const failHint = (ua = navigator.userAgent) => isSafari(ua) ? SAFARI : isChromium(ua) ? CHROME_ALLOW : OTHER_FAIL;

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
.sbag-bar { position: fixed; left: 12px; bottom: calc(12px + var(--sb-alpha-banner, 0px)); z-index: 999; background: #1d241a; color: #fff; border-radius: 18px; padding: 6px 8px 6px 14px; font: 13px system-ui, sans-serif; display: flex; gap: 10px; align-items: center; box-shadow: 0 4px 14px rgba(0,0,0,.2); }
.sbag-bar button { font: inherit; border: 0; border-radius: 12px; padding: 3px 10px; background: #fff; color: #1d241a; cursor: pointer; }
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
export function mountAgentPairing(ws: PairingWorkspace, o: { button?: HTMLElement | null; onPairing?: (p: AgentPairing) => void; notebookEdit?: (edit: NotebookEdit, may: () => boolean, hold?: () => Promise<() => void>) => Promise<unknown>; branches?: { gitBranch: typeof gitBranch; gitBranchParams: typeof gitBranchParams; gitBranchProblem: typeof gitBranchProblem; watchBranches: typeof watchBranches; gitVerbs?: typeof GIT_VERBS }; reload?: { scope: ReloadScope; storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null; onState?: (s: RestoreState) => void; onRemembered?: (g: Kept["grant"]) => void }; quietLoss?: boolean; program?: string; runVerbs?: RunVerbs } = {}) {
  style();
  // `program`: the page's own program (the Agents page: sagebrush-agent) named in the dialog instead of sagebrush-mcp
  const named = (s: string) => o.program ? s.replace(/(the agent's |your agent's )?sagebrush-mcp/g, o.program) : s;
  let pairing: AgentPairing | null = null;
  let bar: HTMLElement | null = null;
  const trashEntry = async (p: string) => (await ws.stat(p)) as any;
  const page = { origin: location.origin, path: location.pathname };
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
  const make = (port: number, how: { code: string } | { session: string; pairingId: string; agent?: { name: string; client: string } }) =>
    new AgentPairing(port, how, { verbsFor: (actor, host) => ws.forAgent(actor, host), ...(ws.branchHost && o.branches ? { gitBranch: { params: o.branches.gitBranchParams, problem: o.branches.gitBranchProblem, run: (a) => o.branches!.gitBranch(ws.branchHost!(a.actor), a) } } : {}), ...(ws.branchHost && o.branches?.gitVerbs ? { gitVerbs: { params: (m: string, p: unknown) => o.branches!.gitVerbs!.params(m as any, p), problem: o.branches.gitVerbs.problem, run: (a) => o.branches!.gitVerbs!.run(ws.branchHost!(a.actor) as unknown as GitHost, a.method as any, a.params, { owner: a.owner, actor: a.actor, live: a.live, ended: a.ended }) } } : {}), store: ws, trashEntry, page, ...(runVerbs ? { runVerbs } : {}), ...(o.notebookEdit ? { notebookEdit: o.notebookEdit } : {}), ...(o.reload ? { reload: { storage, scope: o.reload.scope, leaving: () => leaving } } : {}) });
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

  function showBar() {
    bar?.remove();
    const p = pairing;
    if (!p || p.state !== "granted" || !p.grant) { bar = null; return; }
    const g = p.grant;
    const where = g.folders.includes("/") ? "everywhere" : "in " + g.folders.join(", ");
    const text = h("span", { textContent: `${p.hello!.agent.name} (as it says): ${g.write ? "read and write" : "read only"} ${where}${g.run ? " · may run code" : ""} · ${p.changes} change${p.changes === 1 ? "" : "s"}` });
    const revoke = h("button", { textContent: "Revoke" });
    revoke.onclick = () => void p.revoke("revoked by the person");
    // ("May run code" turned off here, mid-session: a run going ends (chat plan PR 4); turned on only by a new grant)
    const noRun = g.run ? h("button", { textContent: "Turn off running code", title: "The agent may no longer run code, and a run going now stops (connect it again to allow it)" }) : null;
    if (noRun) noRun.onclick = () => void p.noRun();
    bar = h("div", { className: "sbag-bar" }, text, ...(noRun ? [noRun] : []), revoke);
    bar.setAttribute("role", "status");
    document.body.append(bar);
  }

  async function grantDialog(p: AgentPairing) {
    const top = (await ws.list("/")).filter((e) => e.kind === "folder" && e.path !== TRASH).map((e) => e.path);
    const hello = p.hello!;
    dialog("Allow this agent?", (box, close) => {
      box.append(h("div", { textContent: `${hello.agent.name} (as it says${hello.agent.client ? ", " + hello.agent.client : ""}) wants to ${hello.wants.write ? "read and change" : "read"} files in your workspace.` }));
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
      const how = h("select", {}, h("option", { value: "3600000", textContent: "for 1 hour" }), h("option", { value: "page", textContent: o.reload ? "while this page is open (a reload keeps it)" : "until I close this page" }), h("option", { value: "86400000", textContent: "for 1 day" }));
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
      box.append(h("div", { textContent: "Folders it may use:" }), folders, h("label", {}, write, "may change files (else read only)"), h("label", {}, run, "May run code"), h("div", { className: "note", textContent: "Runs notebooks and .py and .sage files in Sagebrush's sandbox, using only the files it may read and write." }), h("label", {}, "Allow it ", how), h("label", {}, remember, "Remember this agent (reconnect without a new code)"), err, h("div", { className: "row" }, cancel, allow));
      // (focus on its first control when it opens, as the code dialog does: a keyboard path lands in it; board's B-A14-2)
      setTimeout(() => all.focus());
    });
  }

  function watch(p: AgentPairing) {
    pairing = p;
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
    if (isSafari()) {
      dialog("Connect an agent", (box, close) => { const okb = h("button", { className: "primary", textContent: "OK" }); okb.onclick = close; box.append(h("div", { textContent: SAFARI }, " ", learnMore()), h("div", { className: "row" }, okb)); });
      return;
    }
    if (pairing && pairing.state !== "closed") { showBar(); return; }
    dialog("Connect an agent", (box, close) => {
      const c = h("input", { type: "text", placeholder: "the code the agent gave", value: code, autocomplete: "off" });
      const pt = h("input", { type: "text", placeholder: "its port", value: port, inputMode: "numeric" });
      const err = h("div", { className: "err" });
      const go = h("button", { className: "primary", textContent: "Connect" });
      const cancel = h("button", { textContent: "Cancel" });
      cancel.onclick = close;
      go.onclick = async () => {
        err.textContent = "";
        const n = Number(pt.value.trim());
        if (!Number.isInteger(n) || n < 1 || n > 65535) { err.textContent = "The port is the number the agent gave with the code."; return; }
        if (!c.value.trim()) { err.textContent = "Enter the code the agent gave."; return; }
        go.disabled = true;
        // (a socket the browser blocks, by the page's security policy or a refused local-network permission,
        // may never say so: the connection gets 8 s, and a policy violation is said at once)
        let blocked = "";
        const onViolation = (e: SecurityPolicyViolationEvent) => { if (/^wss?:\/\/(127\.0\.0\.1|localhost)/.test(e.blockedURI)) blocked = "this page's security policy blocked the connection to the agent"; };
        document.addEventListener("securitypolicyviolation", onViolation);
        try {
          const p = make(n, { code: c.value });
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
          const m = String((e as Error).message ?? e);
          const failed = /^the connection failed/.test(m); // (nothing answered: not a refusal by the agent)
          err.textContent = (/^refused|^protocol/.test(String((e as any)?.code)) && !failed && !/^the agent refused/i.test(m) ? "The agent refused: " : "") + named(m) + (/failed/.test(String((e as Error).message)) ? "\n\n" + failHint() : "");
          if (/failed/.test(String((e as Error).message))) err.append(" ", learnMore());
        }
      };
      box.append(h("div", { className: "note", textContent: o.program ? `Start ${o.program} in a terminal on this computer: it prints a code and a port (and a link that fills them in).` : "In your agent (Claude Code, Codex, …) with sagebrush-mcp, ask it to connect to Sagebrush: it gives a code and a port." }),
        h("label", {}, "Code ", c), h("label", {}, "Port ", pt), err, h("div", { className: "row" }, cancel, go));
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
    if (d === "discard") return say({ kind: "not-restored", why: r.grant.expires !== null && !(Date.now() < r.grant.expires) ? "expired" : "discarded", canReconnect: false });
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
  return { connect, reconnectKept, remembered, useRemembered: () => reconnect(), get canReconnect() { return !!(kept ?? pairing?.lostRecord); }, get pairing() { return pairing; } };
}
