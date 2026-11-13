// The account spot at the foot of the Files panel, as in CoCalc, Claude and ChatGPT: signed out, a Sign in button
// that is hard to miss, and a short dialog on why it's worth it, with the way in; signed in, the account chip (an
// initial and the account's name) whose menu says who is signed in, with Sign out.  On the notebook
// page, while the Files panel is hidden, a person icon in the bottom-left corner opens the same dialog, or the same
// menu.  Signed in or out is all it changes: a site without sign-in (a local build, a preview) shows nothing.
//
// Whether someone is signed in: the share service's /api/share/me, asked once per page (401: signed out; 200: signed
// in, with the account; 404: this site has no sign-in).  On a site without it, ?signin-demo shows the signed-out look
// (?signin-demo=in the signed-in one), so it can be seen on a preview; a site with sign-in always answers 401 or 200, so
// the flag changes nothing there.
//
// Signing in goes to the site's /auth/login, which comes back to this page.  Signing out ends this browser's sign-in
// (POST /auth/logout) and reloads the page; nothing in this browser is touched, and the page says so once.

/** Every word the spot, its dialog and its menu show, in one place. */
export const SIGNIN_WORDS = {
  button: "Sign in",
  title: "Sign in to sync and publish",
  reasons: [
    "Sync your notebooks between your browsers and devices. Signed out, your work stays in this browser only.",
    "Publish a notebook or a talk as a link anyone can open, run and copy.",
  ],
  go: "Sign in with CoCalc",
  later: "Not now",
  note: "Sagebrush uses your CoCalc account. Making one is free.",
  noName: "Your account",
  signedInAs: (who: string) => `Signed in as ${who}`,
  chipLabel: (who: string) => `Account: ${who}, menu`,
  signOut: "Sign out",
  signedOut: "Signed out. Your notebooks in this browser are still here; sync is off until you sign in again.",
  railSignedOut: "Sign in",
};

export type Me = { account_id: string; name?: string | null; email?: string | null };
export type Account = { state: "signed-in"; me: Me } | { state: "signed-out" } | { state: "none" };

let asked: Promise<Account> | null = null;
/** Whether this page's visitor is signed in, and as whom; asked once per page. */
export function account(): Promise<Account> {
  return (asked ??= (async (): Promise<Account> => {
    const demo = new URLSearchParams(location.search).get("signin-demo");
    try {
      const r = await fetch("/api/share/me", { credentials: "same-origin", signal: AbortSignal.timeout(10_000) });
      if (r.status === 401) { await r.body?.cancel().catch(() => {}); return { state: "signed-out" }; }
      if (r.ok) {
        const me = (await r.json().catch(() => null)) as Me | null;
        return me && typeof me.account_id === "string" ? { state: "signed-in", me } : { state: "none" };
      }
      await r.body?.cancel().catch(() => {});
      if (r.status === 404 && demo !== null) return demo === "in" ? { state: "signed-in", me: { account_id: "demo", name: "Ada Lovelace", email: "ada@example.org" } } : { state: "signed-out" };
      return { state: "none" };
    } catch {
      return { state: "none" };
    }
  })());
}

/** The site's sign-in, coming back to this page as it is. */
export const signInHref = () => `/auth/login?return=${encodeURIComponent(location.pathname + location.search + location.hash)}`;

const shownName = (me: Me) => (me.name?.trim() || me.email?.trim() || SIGNIN_WORDS.noName);
const initialOf = (me: Me) => (me.name?.trim() || me.email?.trim() || "?").slice(0, 1).toUpperCase();
/** A colour for the account's initial, the same for the same account. */
function hueOf(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const PERSON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 14c.6-2.7 2.7-4.25 5.25-4.25S12.65 11.3 13.25 14"/></svg>`;

const STYLE = `
.sbfiles .facct { margin: 8px 10px; }
.sbfiles .facct[hidden] { display: none; }
.sbfiles .fsignin { display: flex; width: 100%; align-items: center; justify-content: center; gap: 8px; padding: 9px 12px; border: 0; border-radius: 7px; background: var(--accent, #4a6b49); color: var(--on-accent, #ffffff); font: inherit; font-size: 15px; font-weight: 650; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,.18); }
.sbfiles .fsignin svg { width: 17px; height: 17px; }
.sbfiles .fsignin:hover { filter: brightness(1.08); }
.sbfiles .fsignin:focus-visible { outline: 2px solid var(--fg, #1f2421); outline-offset: 2px; }
.sbfiles .fsignedout { margin: 6px 2px 0; font-size: 12px; color: var(--muted, #5d645f); }
.sbfiles .fchip { display: flex; width: 100%; align-items: center; gap: 9px; padding: 6px 8px; border: 0; border-radius: 7px; background: none; color: var(--sbf-fg, #1f2421); font: inherit; text-align: left; cursor: pointer; }
.sbfiles .fchip:hover, .sbfiles .fchip[aria-expanded="true"] { background: #e6e5de; }
.sbfiles .fchip .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.sbfiles .fchip .cv { color: #5d645f; font-size: 12px; }
.sbav { display: inline-grid; place-items: center; flex: none; width: 26px; height: 26px; border-radius: 50%; color: #ffffff; font-size: 13px; font-weight: 700; }
.sbacctmenu { position: fixed; z-index: 1000; min-width: 220px; max-width: min(320px, calc(100vw - 16px)); padding: 6px; border: 1px solid var(--line, #d4d4cb); border-radius: 8px; background: var(--bg, #fbfaf7); color: var(--fg, #1f2421); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.18); }
.sbacctmenu .who { margin: 4px 8px 0; font-weight: 600; overflow-wrap: anywhere; }
.sbacctmenu .em { margin: 0 8px 4px; font-size: 12.5px; color: var(--muted, #5d645f); overflow-wrap: anywhere; }
.sbacctmenu hr { margin: 6px 0; border: 0; border-top: 1px solid var(--line, #d4d4cb); }
.sbacctmenu a, .sbacctmenu button { display: block; width: 100%; padding: 7px 8px; border: 0; border-radius: 5px; background: none; color: inherit; font: inherit; text-align: left; text-decoration: none; cursor: pointer; }
.sbacctmenu a:hover, .sbacctmenu button:hover, .sbacctmenu a:focus-visible, .sbacctmenu button:focus-visible { background: var(--code, #ecebe4); outline: none; }
.sbacctrail.pill { display: inline-flex !important; align-items: center; gap: 5px; width: auto !important; height: 26px; padding: 0 10px 0 8px !important; border: 0; border-radius: 13px !important; background: var(--accent, #4a6b49) !important; color: var(--on-accent, #ffffff) !important; font: 600 12.5px/1 system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer; white-space: nowrap; }
.sbacctrail.pill svg { width: 14px; height: 14px; }
.sbacctrail.pill:hover { filter: brightness(1.08); }
.sbacctrail[hidden] { display: none !important; }
body.wsfiles #sbcorner .sbacctrail { display: none !important; }
#sbacctcorner { position: fixed; left: 8px; bottom: calc(6px + var(--sb-alpha-banner, 0px)); z-index: 1000; display: flex; }
body.wsfiles #sbacctcorner { display: none; }
#sbacctcorner .sbacctbtn { display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%; background: none; cursor: pointer; }
@media print { #sbacctcorner, .sbacctrail { display: none !important; } }
dialog.sbsignin { max-width: min(440px, calc(100vw - 32px)); padding: 22px 24px 18px; border: 1px solid var(--line, #d4d4cb); border-radius: 10px; background: var(--bg, #fbfaf6); color: var(--fg, #1f2421); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
dialog.sbsignin::backdrop { background: rgba(0,0,0,.35); }
dialog.sbsignin h2 { margin: 0 0 12px; font-size: 19px; }
dialog.sbsignin ul { margin: 0 0 18px; padding-left: 20px; }
dialog.sbsignin li { margin: 0 0 8px; }
dialog.sbsignin .acts { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
dialog.sbsignin .acts a, dialog.sbsignin .acts button { padding: 8px 16px; border-radius: 6px; font: inherit; font-size: 14.5px; cursor: pointer; text-decoration: none; }
dialog.sbsignin .acts a { background: var(--accent, #4a6b49); color: var(--on-accent, #ffffff); border: 1px solid var(--accent, #4a6b49); font-weight: 600; }
dialog.sbsignin .acts button { background: none; color: var(--fg, #1f2421); border: 1px solid var(--line, #c9c8bf); }
dialog.sbsignin .note { margin: 14px 0 0; font-size: 12.5px; color: var(--muted, #5d645f); }
:root[data-theme="dark"] .sbfiles .fchip:hover, :root[data-theme="dark"] .sbfiles .fchip[aria-expanded="true"] { background: #262b27; }
:root[data-theme="dark"] .sbfiles .fchip .cv { color: #a3aba4; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .sbfiles .fchip:hover, :root:not([data-theme="light"]) .sbfiles .fchip[aria-expanded="true"] { background: #262b27; }
  :root:not([data-theme="light"]) .sbfiles .fchip .cv { color: #a3aba4; }
}
`;
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(Object.assign(document.createElement("style"), { textContent: STYLE }));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}
const icon = () => { const s = el("span", { "aria-hidden": "true" }); s.innerHTML = PERSON; return s.firstElementChild as Element; };
const avatar = (me: Me) => { const a = el("span", { class: "sbav", "aria-hidden": "true" }, initialOf(me)); a.style.background = `hsl(${hueOf(me.account_id)} 38% 42%)`; return a; };

/** The dialog: why sign in, and the way in.  Esc, Not now or a click outside closes it; nothing is remembered. */
export function openSignInWhy(): HTMLDialogElement {
  style();
  document.querySelector("dialog.sbsignin")?.remove();
  const w = SIGNIN_WORDS;
  const go = el("a", { href: signInHref() }, w.go);
  const later = el("button", { type: "button" }, w.later);
  const dlg = el("dialog", { class: "sbsignin", "aria-labelledby": "sbsignin-title" },
    el("h2", { id: "sbsignin-title" }, w.title),
    el("ul", {}, ...w.reasons.map((r) => el("li", {}, r))),
    el("div", { class: "acts" }, later, go),
    el("p", { class: "note" }, w.note));
  later.onclick = () => dlg.close();
  // (a click on the backdrop, outside the dialog's box, closes it)
  dlg.addEventListener("click", (ev) => {
    const r = dlg.getBoundingClientRect();
    if (ev.target === dlg && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom)) dlg.close();
  });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  // (the way in has the focus, for Enter, without a ring drawn on a dialog opened by a click; the keyboard shows it)
  go.focus({ focusVisible: false } as FocusOptions);
  return dlg;
}

/** Sign out of this browser, then reload: the page says once that nothing here was lost. */
export async function signOut(): Promise<void> {
  try {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {}
  try { sessionStorage.setItem("sb-signed-out", "1"); } catch {}
  location.reload();
}

/** The account menu, above (else below) `at`: who, and Sign out; Esc, a choice or a click elsewhere closes it. */
export function openAccountMenu(at: HTMLElement, me: Me): HTMLElement {
  style();
  document.querySelectorAll(".sbacctmenu").forEach((m) => ((m as any).sbClose ?? (() => m.remove()))());
  const w = SIGNIN_WORDS;
  const named = !!me.name?.trim();
  const out = el("button", { role: "menuitem", type: "button" }, w.signOut);
  const menu = el("div", { class: "sbacctmenu", role: "menu", "aria-label": shownName(me) },
    el("p", { class: "who" }, w.signedInAs(named ? me.name!.trim() : shownName(me))),
    ...(named && me.email ? [el("p", { class: "em" }, me.email)] : []),
    el("hr"), out);
  document.body.append(menu);
  const r = at.getBoundingClientRect(), m = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, innerWidth - m.width - 8));
  const top = r.top - m.height - 6 >= 8 ? r.top - m.height - 6 : Math.min(innerHeight - m.height - 8, r.bottom + 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  at.setAttribute("aria-expanded", "true");
  const items = [out];
  const close = () => { menu.remove(); at.setAttribute("aria-expanded", "false"); removeEventListener("pointerdown", away, true); removeEventListener("keydown", key, true); };
  const away = (ev: Event) => { if (!menu.contains(ev.target as Node) && !at.contains(ev.target as Node)) close(); };
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") { close(); at.focus(); return; }
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const to = ev.key === "ArrowDown" ? (i + 1) % items.length : ev.key === "ArrowUp" ? (i <= 0 ? items.length - 1 : i - 1) : -1;
    if (to >= 0) { ev.preventDefault(); items[to].focus(); }
  };
  out.onclick = () => { close(); void signOut(); };
  (menu as any).sbClose = close;
  setTimeout(() => { if (menu.isConnected) { addEventListener("pointerdown", away, true); addEventListener("keydown", key, true); } });
  out.focus({ focusVisible: false } as FocusOptions);
  return menu;
}

/** The account spot, inserted before `before` in the Files panel: the Sign in button signed out, the chip signed in. */
export function mountSignInCta(before: HTMLElement): HTMLElement {
  style();
  const w = SIGNIN_WORDS;
  const spot = el("div", { class: "facct" });
  spot.hidden = true;
  before.before(spot);
  void account().then((a) => {
    if (a.state === "signed-out") {
      const btn = el("button", { class: "fsignin", type: "button", "aria-haspopup": "dialog" }, icon(), el("span", {}, w.button));
      btn.onclick = () => openSignInWhy();
      spot.replaceChildren(btn);
      let was = false;
      try { was = sessionStorage.getItem("sb-signed-out") === "1"; sessionStorage.removeItem("sb-signed-out"); } catch {}
      if (was) spot.append(el("p", { class: "fsignedout", role: "status" }, w.signedOut));
      spot.hidden = false;
    } else if (a.state === "signed-in") {
      const who = shownName(a.me);
      const chip = el("button", { class: "fchip", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": w.chipLabel(who) }, avatar(a.me), el("span", { class: "nm" }, who), el("span", { class: "cv", "aria-hidden": "true" }, "⌃"));
      chip.onclick = () => (chip.getAttribute("aria-expanded") === "true" ? (document.querySelector(".sbacctmenu") as any)?.sbClose?.() : openAccountMenu(chip, a.me));
      spot.replaceChildren(chip);
      spot.hidden = false;
    }
  });
  return spot;
}

/** The same spot while the Files panel is hidden: a person icon in the page's corner (`corner`, the notebook page's). */
export function mountAccountIcon(corner: HTMLElement, buttonClass = "cbtn"): HTMLButtonElement {
  style();
  const b = el("button", { class: `${buttonClass} sbacctrail`, type: "button" });
  b.append(icon());
  b.hidden = true;
  corner.append(b);
  void account().then((a) => {
    if (a.state === "signed-out") {
      // (a small green pill, as hard to miss as the panel's button: the person icon and "Sign in")
      b.classList.add("pill");
      b.append(el("span", {}, SIGNIN_WORDS.railSignedOut));
      b.title = SIGNIN_WORDS.railSignedOut;
      b.setAttribute("aria-haspopup", "dialog");
      b.onclick = () => openSignInWhy();
      b.hidden = false;
    } else if (a.state === "signed-in") {
      const who = shownName(a.me);
      b.replaceChildren(avatar(a.me));
      b.title = who;
      b.setAttribute("aria-label", SIGNIN_WORDS.chipLabel(who));
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
      b.onclick = () => (b.getAttribute("aria-expanded") === "true" ? (document.querySelector(".sbacctmenu") as any)?.sbClose?.() : openAccountMenu(b, a.me));
      b.hidden = false;
    }
  });
  return b;
}

/** The same spot on a page that has no corner of its own (the board page): a corner made for it, at the window's
 * bottom left, shown while the Files panel is hidden. */
export function mountAccountCorner(): HTMLElement {
  style();
  const corner = el("div", { id: "sbacctcorner" });
  document.body.append(corner);
  mountAccountIcon(corner, "sbacctbtn");
  return corner;
}
