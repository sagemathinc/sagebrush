// The account, at the top right of the notebook and board pages' bars, beside Share: the one place it is. Signed out,
// "Sign in", to the site's sign-in and back to this page; signed in, the account's initial, with a menu (who is signed
// in, sync and storage where the page has them, Sign out); on a site without accounts (the CLI's page, a preview, one
// whose server doesn't answer), nothing. Read once as the page loads: a sign-in or a sign-out reloads the page.
import { signInUrl } from "../share-client/upload";

/** The site's answer about the account: 200 with {name, email} signed in, 401 signed out, anything else no accounts. */
export const ACCOUNT_URL = "/api/share/me";
/** Signing out: a POST, and the page reloaded. */
export const SIGN_OUT_URL = "/auth/logout";

export type AccountState = { state: "none" } | { state: "out" } | { state: "in"; name: string; email: string };

/** The account, as the site answers it (given 10 s; anything unexpected is "none"). */
export async function readAccount(signal?: AbortSignal): Promise<AccountState> {
  try {
    const r = await fetch(ACCOUNT_URL, { credentials: "same-origin", signal });
    if (r.status === 401) return { state: "out" };
    if (!r.ok) return { state: "none" };
    const a = (await r.json()) as { name?: unknown; email?: unknown } | null;
    const email = typeof a?.email === "string" ? a.email : "";
    const name = typeof a?.name === "string" && a.name.trim() ? a.name.trim() : email || "Your account";
    return { state: "in", name, email };
  } catch {
    return { state: "none" };
  }
}

export interface AccountHost {
  /** Sync and storage: the page's Storage panel (its sync section first), where the page has one */
  storage?: () => void;
}

const CSS = `
.sbacct { flex: none; display: inline-flex; align-items: center; position: relative; }
.sbacct[hidden] { display: none; }
.sbacct-in { display: inline-flex; align-items: center; font-size: 13.5px; padding: 4px 11px; border-radius: 8px; text-decoration: none; white-space: nowrap;
  border: 1px solid var(--accent, var(--board-accent, #4a6b49)); background: var(--accent, var(--board-accent, #4a6b49)); color: var(--on-accent, var(--board-on-accent, #fff)); }
.sbacct-in:hover, .sbacct-in:focus-visible { filter: brightness(1.08); }
.sbacct-btn { width: 30px; height: 30px; padding: 0; border-radius: 50%; border: 0; cursor: pointer; display: inline-grid; place-items: center;
  font: 600 14px/1 system-ui, sans-serif; background: var(--accent, var(--board-accent, #4a6b49)); color: var(--on-accent, var(--board-on-accent, #fff)); }
.sbacct-btn:focus-visible { outline: 2px solid var(--accent2, var(--board-accent, #8aa37b)); outline-offset: 2px; }
.sbacct-menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 1000; min-width: 220px; max-width: min(320px, 92vw); padding: 6px;
  border-radius: 10px; border: 1px solid var(--line, var(--board-border, #d4d4cb)); background: var(--cell, var(--board-surface, #fff)); color: var(--fg, inherit);
  box-shadow: 0 8px 28px rgba(0, 0, 0, .18); font-size: 13.5px; }
.sbacct-menu[hidden] { display: none; }
.sbacct-who { padding: 6px 10px 8px; border-bottom: 1px solid var(--line, var(--board-border, #d4d4cb)); margin-bottom: 4px; }
.sbacct-who b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbacct-who span { display: block; font-size: 12.5px; opacity: .75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbacct-menu button { display: block; width: 100%; text-align: left; padding: 7px 10px; border: 0; border-radius: 6px; background: none; color: inherit; font: inherit; cursor: pointer; }
.sbacct-menu button:hover, .sbacct-menu button:focus-visible { background: var(--code, var(--board-hover, #f3f2ec)); outline: none; }
`;

/** The account in `slot` (an element in the page's bar, right of Share); `destroy()` stops a pending read. */
export function mountAccount(slot: HTMLElement, host: AccountHost = {}): { ready: Promise<AccountState>; destroy(): void } {
  if (!document.getElementById("sbacct-css")) {
    const st = document.createElement("style");
    st.id = "sbacct-css";
    st.textContent = CSS;
    document.head.append(st);
  }
  slot.classList.add("sbacct");
  slot.hidden = true;
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 10_000);
  let gone = false, offDoc: (() => void) | null = null;
  const draw = (a: AccountState) => {
    slot.replaceChildren();
    slot.hidden = a.state === "none";
    if (a.state === "out") {
      const link = document.createElement("a");
      link.className = "sbacct-in";
      link.href = signInUrl(location.pathname + location.search + location.hash);
      link.textContent = "Sign in";
      slot.append(link);
    }
    if (a.state !== "in") return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sbacct-btn";
    btn.textContent = a.name.charAt(0).toUpperCase() || "?";
    btn.title = a.email ? `${a.name} (${a.email})` : a.name;
    btn.setAttribute("aria-label", `Account: ${btn.title}`);
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "sbacct-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    const who = document.createElement("div");
    who.className = "sbacct-who";
    const nm = document.createElement("b");
    nm.textContent = a.name;
    who.append(nm);
    if (a.email && a.email !== a.name) { const em = document.createElement("span"); em.textContent = a.email; who.append(em); }
    menu.append(who);
    const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); offDoc?.(); offDoc = null; };
    const item = (text: string, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = text;
      b.onclick = () => { close(); run(); };
      menu.append(b);
    };
    if (host.storage) item("Sync and storage…", host.storage);
    item("Sign out", () => void signOut());
    btn.onclick = () => {
      if (!menu.hidden) return close();
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      (menu.querySelector("button") as HTMLButtonElement | null)?.focus();
      const down = (e: PointerEvent) => { if (!slot.contains(e.target as Node)) close(); };
      const key = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); btn.focus(); } };
      document.addEventListener("pointerdown", down, true);
      document.addEventListener("keydown", key, true);
      offDoc = () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key, true); };
    };
    slot.append(btn, menu);
  };
  const ready = readAccount(abort.signal).then((a) => {
    clearTimeout(timer);
    if (!gone) draw(a);
    return a;
  });
  return {
    ready,
    destroy() { gone = true; abort.abort(); clearTimeout(timer); offDoc?.(); slot.replaceChildren(); slot.hidden = true; },
  };
}

async function signOut(): Promise<void> {
  try { await fetch(SIGN_OUT_URL, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }); } catch {}
  location.reload();
}
