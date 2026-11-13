// Signed out, a call to sign in at the foot of the Files panel, hard to miss, and a short dialog on why it's worth it,
// with the way in.  Signed in, or on a site that has no sign-in (a local build, a preview), nothing shows.
//
// Whether someone is signed in: the share service's /api/share/me, asked once per page (401: signed out; 200: signed
// in; 404: this site has no sign-in).  On a site without it, ?signin-demo shows the signed-out look, so it can be seen
// on a preview; a site with sign-in always answers 401 or 200, so the flag changes nothing there.
//
// Signing in goes to the site's /auth/login, which comes back to this page; the files in this browser are untouched.

/** Every word the call and its dialog show, in one place. */
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
};

export type SignInStatus = "signed-in" | "signed-out" | "none";

let asked: Promise<SignInStatus> | null = null;
/** Whether this page's visitor is signed in, asked once per page. */
export function signInStatus(): Promise<SignInStatus> {
  return (asked ??= (async (): Promise<SignInStatus> => {
    try {
      const r = await fetch("/api/share/me", { credentials: "same-origin", signal: AbortSignal.timeout(10_000) });
      await r.body?.cancel().catch(() => {});
      if (r.status === 401) return "signed-out";
      if (r.ok) return "signed-in";
      if (r.status === 404 && new URLSearchParams(location.search).has("signin-demo")) return "signed-out";
      return "none";
    } catch {
      return "none";
    }
  })());
}

/** The site's sign-in, coming back to this page as it is. */
export const signInHref = () => `/auth/login?return=${encodeURIComponent(location.pathname + location.search + location.hash)}`;

const STYLE = `
.sbfiles .fsignin { display: flex; flex-direction: column; align-items: stretch; gap: 2px; margin: 8px 10px 8px; padding: 9px 12px; border: 0; border-radius: 7px; background: var(--accent, #4a6b49); color: var(--on-accent, #ffffff); font: inherit; text-align: center; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,.18); }
.sbfiles .fsignin[hidden] { display: none; }
.sbfiles .fsignin b { font-size: 15px; font-weight: 650; }
.sbfiles .fsignin:hover { filter: brightness(1.08); }
.sbfiles .fsignin:focus-visible { outline: 2px solid var(--fg, #1f2421); outline-offset: 2px; }
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

/** The dialog: why sign in, and the way in.  Esc, Not now or a click outside closes it. */
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

/** The call to sign in, inserted before `before` in the Files panel: shown only once the visitor is known to be signed out. */
export function mountSignInCta(before: HTMLElement): HTMLButtonElement {
  style();
  const w = SIGNIN_WORDS;
  const btn = el("button", { class: "fsignin", type: "button", "aria-haspopup": "dialog" }, el("b", {}, w.button));
  btn.hidden = true;
  btn.onclick = () => openSignInWhy();
  before.before(btn);
  void signInStatus().then((s) => { btn.hidden = s !== "signed-out"; });
  return btn;
}
