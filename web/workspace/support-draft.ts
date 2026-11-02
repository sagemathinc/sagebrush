// An agent drafts a support request; the person reviews it and sends it (plan-support-requests r12, its addendum
// "agents draft support requests, people send them"; William, Nov 2: agents "should not SUBMIT it, but they should
// make it a 1-click process for the human").
//
// The draft is shown as a card on the page: "Review and send" opens the support form, filled in, in a new tab, and
// the person presses Send there. Nothing here sends anything:
//   - the tools' answer is only {drafted: true, shown: "card"}: no URL, window or handle on the form;
//   - nothing goes over the network until the person clicks: the form's URL is made in the click's handler;
//   - only a trusted click opens it: a script's .click() or a dispatched event (isTrusted false) opens nothing;
//   - the card holds no link, so there is no href for a script to follow.
// It is no boundary against an agent that drives the whole browser (CDP makes trusted input): there the form's own
// guards hold (CoCalc's form now; Turnstile on the Sagebrush page later).
//
// The two callers: the notebook page's WebMCP tool draft_support_request (web/index.html) and the pairing verb
// support.draft (agent-pair.ts, schema.json).

declare const __SB_BUILD__: string;

/** Where "Review and send" goes: CoCalc's support form (interim), or the Sagebrush page (once PR 1 is live). */
export const SUPPORT_DRAFT_TARGET: "cocalc" | "sagebrush" = "cocalc";

export const DRAFT_KINDS = ["bug", "pkg", "feat", "book", "other"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
export type Draft = { kind: DraftKind; subject: string; body: string };
/** The lengths, in JS (UTF-16) code units, as schema.json says them. */
export const DRAFT_LIMITS = { subject: [5, 180], body: [10, 19_000] } as const;
/** At most this long a URL to CoCalc's form: its server refuses a request whose query is about 15.8 KB (431), and the
 * browser's cookies count too. */
export const COCALC_MAX_URL = 8000;
/** The tools' whole answer. */
export const DRAFT_RESULT = Object.freeze({ drafted: true, shown: "card" });
/** What the tools' descriptions and llms.txt tell agents. */
export const DRAFT_HINT =
  "When you're blocked, or Sagebrush is missing a feature or package, draft a support request with draft_support_request: the person reviews it and sends it with one click. You can't send it yourself.";
export const DRAFT_DESCRIPTION =
  DRAFT_HINT +
  " kind is bug, pkg (a missing package), feat, book or other; subject is 5 to 180 characters; body 10 to 19,000, in plain text: say what you tried and what happened. There are no attachments: put the relevant text, or a link to a shared Sagebrush document, in the body. The person sees a card on the page; the answer is only {drafted: true, shown: \"card\"}.";

const COCALC_TYPE: Record<DraftKind, string> = { bug: "problem", feat: "task", pkg: "task", book: "task", other: "question" };
const build = () => (typeof __SB_BUILD__ === "string" && __SB_BUILD__ ? __SB_BUILD__ : "dev");

/** The draft in args, or why it isn't one (a message the agent can act on). */
export function checkDraft(args: unknown, how: { mode: string; via: "webmcp" | "pairing" }): Draft | string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a !== "object" || Array.isArray(a)) return "the arguments are {kind?, subject, body}";
  for (const k of Object.keys(a)) if (!["kind", "subject", "body"].includes(k)) return `unknown argument ${JSON.stringify(k.slice(0, 40))}: the arguments are kind, subject and body (no email, no attachments)`;
  const kind = a.kind === undefined ? "other" : a.kind;
  if (!DRAFT_KINDS.includes(kind as DraftKind)) return `kind is one of ${DRAFT_KINDS.join(", ")} (default other)`;
  for (const k of ["subject", "body"] as const) {
    const v = a[k], [lo, hi] = DRAFT_LIMITS[k];
    if (typeof v !== "string") return `${k} is a string of ${lo} to ${hi} characters`;
    if (v.trim().length < lo || v.length > hi) return `${k} is ${v.length} characters: it must be ${lo} to ${hi}`;
  }
  const d = { kind: kind as DraftKind, subject: (a.subject as string).trim(), body: a.body as string };
  if (SUPPORT_DRAFT_TARGET === "cocalc") {
    const n = draftURL(d, how).length;
    if (n > COCALC_MAX_URL) return `this draft is ${n} characters as a link to the support form, over its ${COCALC_MAX_URL}: shorten the body, or put the details in a shared Sagebrush document and link it`;
  }
  return d;
}

/** The line the form gets about where the draft came from: "Sagebrush <build>, <mode>, <WebMCP|pairing>". */
export const draftContext = (mode: string, via: "webmcp" | "pairing") => `Sagebrush ${build()}, ${mode}, ${via === "webmcp" ? "WebMCP" : "pairing"}`;

const b64url = (s: string) => {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The support form, filled in with the draft. */
export function draftURL(d: Draft, how: { mode: string; via: "webmcp" | "pairing" }): string {
  if (SUPPORT_DRAFT_TARGET === "sagebrush")
    return "https://support.sagebrush.space/new#draft=" + b64url(JSON.stringify({ v: 1, kind: d.kind, title: d.subject, description: d.body }));
  const q = (s: string) => encodeURIComponent(s);
  return `https://cocalc.ai/support/new?type=${q(COCALC_TYPE[d.kind])}&subject=${q(`[sagebrush] ${d.kind}: ${d.subject}`)}&body=${q(d.body)}&url=${q("https://sagebrush.space/")}&context=${q(draftContext(how.mode, how.via))}`;
}

let card: HTMLElement | null = null;

/** Show the draft as the page's one card (a new draft replaces the one shown). */
export function showSupportDraft(d: Draft, how: { mode: string; via: "webmcp" | "pairing" }): typeof DRAFT_RESULT {
  card?.remove();
  const el = document.createElement("div");
  el.id = "supportdraft";
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", "A support request an agent drafted");
  el.setAttribute("aria-live", "polite");
  el.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + var(--sb-alpha-banner, 0px));z-index:999;max-width:min(560px,calc(100vw - 24px));box-sizing:border-box;font:14px system-ui,sans-serif;color:#1f2a1c;background:#fff;border:1px solid #cfd5c8;border-radius:10px;padding:12px 14px;box-shadow:0 4px 18px rgba(0,0,0,.18)";
  const p = document.createElement("p");
  p.style.cssText = "margin:0 0 4px";
  p.append("An agent drafted a support request: ");
  const s = document.createElement("strong");
  s.textContent = d.subject;
  p.append(s);
  const note = document.createElement("p");
  note.style.cssText = "margin:0 0 10px;font-size:12.5px;color:#556";
  note.textContent = SUPPORT_DRAFT_TARGET === "cocalc" ? "Review and send opens CoCalc's support form, filled in, in a new tab. Nothing is sent until you press Send there." : "Review and send opens Sagebrush's support form, filled in, in a new tab. Nothing is sent until you press Send there.";
  const btn = (label: string, primary: boolean) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = `font:inherit;border-radius:6px;padding:4px 12px;cursor:pointer;margin-right:8px;border:1px solid ${primary ? "#4a6b3a" : "#cfd5c8"};background:${primary ? "#4a6b3a" : "#fff"};color:${primary ? "#fff" : "#1f2a1c"}`;
    return b;
  };
  const review = btn("Review and send", true), discard = btn("Discard", false);
  const close = () => { el.remove(); if (card === el) card = null; };
  // (only the person's own click: a script's click() or dispatched event is not trusted, and opens nothing)
  review.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    const url = draftURL(d, how);
    close();
    window.open(url, "_blank", "noopener,noreferrer");
  });
  discard.addEventListener("click", (e) => { if (e.isTrusted) close(); });
  el.append(p, note, review, discard);
  document.body.append(el);
  card = el;
  return DRAFT_RESULT;
}
