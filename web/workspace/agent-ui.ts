// "Connect an agent" (design/workspace-agent-protocol.md §2): the code and port the agent gave, the person's grant
// (which folders; read, or read and write; for how long; remember or not), a bar while it's connected (what it
// may do, how many changes it made, Revoke), and, in Safari, the plain reason it can't work there.
//
//   mountAgentPairing(ws, { button })   wires a page's button (or none: then only a ?pair=CODE&port=N link opens
//                                       it), and offers to reconnect a remembered agent.

import { AgentPairing, type GrantStore, type Kept } from "./agent-pair";
import { TRASH } from "./paths";

/** What the page needs of its workspace. */
export type PairingWorkspace = GrantStore & {
  forAgent(actor: string): any;
  list(folder?: string): Promise<{ path: string; kind: string }[]>;
  stat(p: string): Promise<{ trashed?: { from: string } } | null | undefined>;
};

export const SAFARI = "Safari doesn't let a web page reach a program on this computer. Use Chrome or Firefox, or the Sagebrush desktop app.";
export const isSafari = (ua = navigator.userAgent) => /safari/i.test(ua) && !/chrome|chromium|crios|fxios|android|edg/i.test(ua);

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

/** A small "Connect an agent" button in a page's corner, for a page with no menu of its own to put it in. */
export function floatingButton(): HTMLElement {
  const b = document.createElement("button");
  b.textContent = "Connect an agent";
  b.style.cssText = "position:fixed;right:12px;bottom:calc(12px + var(--sb-alpha-banner, 0px));z-index:998;font:13px system-ui,sans-serif;border:1px solid #cfd5c8;background:#fff;border-radius:16px;padding:5px 12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12)";
  document.body.append(b);
  return b;
}

/** The page's pairing: a dialog to connect, a bar while connected.  Returns the button's handler. */
export function mountAgentPairing(ws: PairingWorkspace, o: { button?: HTMLElement | null } = {}) {
  style();
  let pairing: AgentPairing | null = null;
  let bar: HTMLElement | null = null;
  const trashEntry = async (p: string) => (await ws.stat(p)) as any;
  const page = { origin: location.origin, path: location.pathname };
  const make = (port: number, how: { code: string } | { session: string; pairingId: string }) =>
    new AgentPairing(port, how, { verbsFor: (actor) => ws.forAgent(actor), store: ws, trashEntry, page });

  function dialog(title: string, body: (box: HTMLElement, close: () => void) => void) {
    const box = h("div", { className: "sbag-box" }, h("h2", { textContent: title }));
    const dlg = h("div", { className: "sbag-dlg" }, box);
    dlg.setAttribute("role", "dialog");
    const close = () => dlg.remove();
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
    const text = h("span", { textContent: `${p.hello!.agent.name} (as it says): ${g.write ? "read and write" : "read only"} ${where} · ${p.changes} change${p.changes === 1 ? "" : "s"}` });
    const revoke = h("button", { textContent: "Revoke" });
    revoke.onclick = () => void p.revoke("revoked by the person");
    bar = h("div", { className: "sbag-bar" }, text, revoke);
    bar.setAttribute("role", "status");
    document.body.append(bar);
  }

  async function grantDialog(p: AgentPairing) {
    const top = (await ws.list("/")).filter((e) => e.kind === "folder" && e.path !== TRASH).map((e) => e.path);
    const hello = p.hello!;
    dialog("Allow this agent?", (box, close) => {
      box.append(h("div", { textContent: `${hello.agent.name} (as it says${hello.agent.client ? ", " + hello.agent.client : ""}) wants to ${hello.wants.write ? "read and change" : "read"} files in your workspace.` }));
      const all = h("input", { type: "checkbox" });
      const boxes = top.map((f) => { const c = h("input", { type: "checkbox", value: f }); c.checked = !!hello.wants.folders?.includes(f); return c; });
      const folders = h("div", { className: "folders" }, h("label", {}, all, h("b", { textContent: "Everything" })), ...top.map((f, i) => h("label", {}, boxes[i], f)));
      if (!top.length) folders.append(h("div", { className: "note", textContent: "There are no folders yet: only Everything can be granted." }));
      all.onchange = () => { for (const c of boxes) c.disabled = all.checked; };
      const write = h("input", { type: "checkbox" });
      write.checked = !!hello.wants.write;
      const how = h("select", {}, h("option", { value: "3600000", textContent: "for 1 hour" }), h("option", { value: "page", textContent: "until I close this page" }), h("option", { value: "86400000", textContent: "for 1 day" }));
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
          await p.allow({ folders: chosen, write: write.checked, expires: how.value === "page" ? null : Date.now() + Number(how.value) }, remember.checked);
          close();
          showBar();
        } catch (e) { err.textContent = String((e as Error).message ?? e); }
      };
      box.append(h("div", { textContent: "Folders it may use:" }), folders, h("label", {}, write, "may change files (else read only)"), h("label", {}, "Allow it ", how), h("label", {}, remember, "Remember this agent (reconnect without a new code)"), err, h("div", { className: "row" }, cancel, allow));
    });
  }

  function watch(p: AgentPairing) {
    pairing = p;
    let was = false;
    p.onChange(() => {
      showBar();
      if (p.state === "paired" || p.state === "granted") was = true;
      // (a refused hello is said in the Connect dialog itself; this is for a pairing that was connected)
      if (was && p.state === "closed" && p.closeReason && !/^revoked by the person$|^not allowed$/.test(p.closeReason)) {
        dialog("The agent is disconnected", (box, close) => {
          box.append(h("div", { className: "err", textContent: p.closeReason }));
          const okb = h("button", { className: "primary", textContent: "OK" });
          okb.onclick = close;
          box.append(h("div", { className: "row" }, okb));
        });
      }
    });
  }

  function connect(code = "", port = "") {
    if (isSafari()) {
      dialog("Connect an agent", (box, close) => { const okb = h("button", { className: "primary", textContent: "OK" }); okb.onclick = close; box.append(h("div", { textContent: SAFARI }), h("div", { className: "row" }, okb)); });
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
        try {
          const p = make(n, { code: c.value });
          watch(p);
          await p.paired();
          close();
          await grantDialog(p);
        } catch (e) {
          go.disabled = false;
          const m = String((e as Error).message ?? e);
          err.textContent = (/^refused|^protocol/.test(String((e as any)?.code)) && !/^the agent refused/i.test(m) ? "The agent refused: " : "") + m + (/failed/.test(String((e as Error).message)) ? "\n\n" + SAFARI.replace(/^Safari/, "If this is Safari: Safari") : "");
        }
      };
      box.append(h("div", { className: "note", textContent: "In your agent (Claude Code, Codex, …) with sagebrush-mcp, ask it to connect to Sagebrush: it gives a code and a port." }),
        h("label", {}, "Code ", c), h("label", {}, "Port ", pt), err, h("div", { className: "row" }, cancel, go));
      setTimeout(() => c.focus());
    });
  }

  /** A remembered agent: reconnect with its session, and give it the same grant again (if it hasn't expired). */
  async function reconnect() {
    const kept = (await ws.agentGrants()) as Record<string, Kept>;
    for (const [id, k] of Object.entries(kept)) {
      if (!k?.grant || !k.session || (k.grant.expires !== null && !(Date.now() < k.grant.expires))) { await ws.putAgentGrant(id, null); continue; }
      try {
        const p = make(k.port, { session: k.session, pairingId: id });
        watch(p);
        await p.paired();
        await p.allow({ folders: k.grant.folders, write: k.grant.write, expires: k.grant.expires }, true);
        showBar();
        return;
      } catch { /* (the server restarted, or the agent is gone: a new code is needed; the grant stays until it expires or is revoked) */ }
    }
  }

  if (o.button) o.button.addEventListener("click", () => connect());
  const q = new URLSearchParams(location.search);
  if (q.has("pair")) connect(q.get("pair") ?? "", q.get("port") ?? "");
  else void reconnect();
  return { connect, get pairing() { return pairing; } };
}
