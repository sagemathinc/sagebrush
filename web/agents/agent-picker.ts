// The Agents page's agent menu: one button in the header that lists where the agent can run (your computers, each
// with Claude; Claude on this computer) and, while connected, Disconnect. The computer last chatted on comes first.
// What each choice does is the page's, passed in.

type Runner = { remote_id: string; name: string };

/** The menu's words, word for word as reviewed. */
export const PICKER_COPY = {
  button: (live: boolean) => (live ? "Connected ▾" : "Connect ▾"),
  computers: "Your computers",
  finding: "Finding your computers…",
  none: "None of your computers is set up for this. On one, run: sagebrush remote login",
  failed: (reason: string) => `Your computers: ${reason}`,
  signIn: "Sign in with CoCalc",
  onComputer: (name: string, agent = "Claude") => `${agent} on ${name}`,
  lastUsed: "last used",
  thisComputer: "Claude on this computer…",
  disconnect: "Disconnect",
};
/** Where the last computer chatted on is kept, in this browser (its id and name only). */
export const LAST_KEY = "sagebrush-agents-last-computer";

export interface PickerHost {
  /** the agent a computer's entry names before connecting (a check build's ?agent=; else Claude) */
  agent?: string;
  list(): Promise<Runner[]>;
  chatHere(r: Runner): void;
  connectHere(): void;
  /** connected now: Disconnect is offered */
  live(): boolean;
  disconnect(): void;
}

export function lastComputer(): Runner | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null");
    return v && typeof v.remote_id === "string" && v.remote_id && typeof v.name === "string" ? { remote_id: v.remote_id, name: v.name.slice(0, 80) } : null;
  } catch {
    return null;
  }
}
/** The person's own Disconnect forgets it: after it, nothing of that computer is kept in this browser. */
export function forgetComputer() {
  try {
    localStorage.removeItem(LAST_KEY);
  } catch {
    // (no storage: nothing was kept)
  }
}
export function rememberComputer(r: Runner) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ remote_id: r.remote_id, name: r.name }));
  } catch {
    // (no storage: nothing is remembered)
  }
}

const CSS = `
.pick-menu { position: fixed; z-index: 50; min-width: 240px; max-width: min(360px, 92vw); background: #fff; border: 1px solid #d9ddd3;
  border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.12); padding: 6px; display: grid; gap: 2px; font-size: 14px; }
.pick-menu .h { color: #6b7066; font-size: 12px; padding: 4px 8px 2px; }
.pick-menu .note { color: #6b7066; padding: 4px 8px; }
.pick-menu button, .pick-menu a { text-align: left; background: none; border: 0; border-radius: 6px; padding: 6px 8px; font: inherit; color: inherit; cursor: pointer; text-decoration: none; }
.pick-menu button:hover, .pick-menu button:focus-visible, .pick-menu a:hover, .pick-menu a:focus-visible { background: #f1f3ee; outline: none; }
.pick-menu small { color: #6b7066; margin-left: 6px; }
.pick-menu hr { border: 0; border-top: 1px solid #e6e9e1; margin: 4px 0; }
`;

export function mountPicker(btn: HTMLElement, host: PickerHost) {
  if (!document.getElementById("sb-pick-css")) document.head.append(Object.assign(document.createElement("style"), { id: "sb-pick-css", textContent: CSS }));
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  let menu: HTMLElement | null = null;

  function close(refocus = true) {
    if (!menu) return;
    menu.remove();
    menu = null;
    btn.setAttribute("aria-expanded", "false");
    removeEventListener("pointerdown", outside, true);
    if (refocus) btn.focus();
  }
  function outside(e: Event) {
    if (menu && !menu.contains(e.target as Node) && !btn.contains(e.target as Node)) close(false);
  }
  const items = () => (menu ? [...menu.querySelectorAll<HTMLElement>("button, a")] : []);
  function item(label: string | Node[], act: () => void): HTMLButtonElement {
    const b = el("button", { type: "button" });
    b.setAttribute("role", "menuitem");
    b.append(...(typeof label === "string" ? [label] : label));
    b.onclick = () => { close(false); act(); };
    return b;
  }

  function open() {
    if (menu) return close();
    const last = lastComputer();
    const status = el("div", { className: "note", textContent: PICKER_COPY.finding });
    status.setAttribute("role", "status");
    const computers = el("div", { style: "display:grid;gap:2px" } as Partial<HTMLDivElement>);
    menu = el("div", { className: "pick-menu" }, el("div", { className: "h", textContent: PICKER_COPY.computers }), status, computers, el("hr"));
    menu.setAttribute("role", "menu");
    menu.append(item(PICKER_COPY.thisComputer, () => host.connectHere()));
    if (host.live()) menu.append(item(PICKER_COPY.disconnect, () => host.disconnect()));
    menu.onkeydown = (e) => {
      const all = items(), i = all.indexOf(document.activeElement as HTMLElement);
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
      else if (e.key === "Tab") close(false);
    };
    document.body.append(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`;
    btn.setAttribute("aria-expanded", "true");
    addEventListener("pointerdown", outside, true);
    // (the menu itself has the focus until your computers are listed; then the first item)
    menu.tabIndex = -1;
    menu.focus();
    const mine = menu;
    host.list().then((list) => {
      if (menu !== mine) return;
      if (!list.length) { status.textContent = PICKER_COPY.none; return; }
      status.remove();
      // (the computer last chatted on first; a name is text, never markup)
      const sorted = last ? [...list.filter((c) => c.remote_id === last.remote_id), ...list.filter((c) => c.remote_id !== last.remote_id)] : list;
      for (const c of sorted) {
        const label: Node[] = [document.createTextNode(PICKER_COPY.onComputer(c.name, host.agent))];
        if (last && c.remote_id === last.remote_id) label.push(el("small", { textContent: PICKER_COPY.lastUsed }));
        computers.append(item(label, () => host.chatHere(c)));
      }
      if (document.activeElement === menu) items()[0]?.focus();
    }, (e) => {
      if (menu !== mine) return;
      if (document.activeElement === menu) items()[0]?.focus();
      status.textContent = PICKER_COPY.failed(String((e as Error)?.message ?? e));
      // (signed out: the site's own sign-in, back to this page after)
      if ((e as { signedOut?: boolean })?.signedOut) {
        const a = el("a", { className: "sign-in", href: `/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`, textContent: PICKER_COPY.signIn });
        a.setAttribute("role", "menuitem");
        computers.append(a);
      }
    });
  }
  btn.addEventListener("click", open);
  return { open, close };
}
