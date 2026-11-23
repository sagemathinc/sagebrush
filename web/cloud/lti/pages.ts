// The tool's few pages (plan-lti-r5 §3.3, §3.5).  Each is self-contained, with
// a nonce'd script, a strict CSP and frame-ancestors from the approved
// framing origins only (never a wildcard).

import { escapeHtml, randomHex } from "./util.ts";

const NOTICE = "Sagebrush for classes is in early testing.";

export function page(opts: { title: string; body: string; script?: string; frameAncestors: string[]; status?: number; headers?: Record<string, string>; formAction?: string }): Response {
  const nonce = randomHex(16);
  const fa = opts.frameAncestors.length ? opts.frameAncestors.join(" ") : "'none'";
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors ${fa}; base-uri 'none'; form-action 'self'${opts.formAction ? " " + opts.formAction : ""}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:1.5rem;color:#222}.notice{font-size:12px;color:#555;border-bottom:1px solid #ddd;padding-bottom:4px;margin-bottom:1rem}button,a.button{font:inherit;padding:.4rem .9rem}</style></head>
<body><div class="notice">${NOTICE}</div>${opts.body}${opts.script ? `<script nonce="${nonce}">${opts.script}</script>` : ""}</body></html>`;
  return new Response(html, {
    status: opts.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(opts.headers ?? {}),
    },
  });
}

/** A value embedded in a script, safely: JSON with `<` escaped. */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function errorPage(code: string, frameAncestors: string[], status = 400): Response {
  return page({ title: "Sagebrush", body: `<p>This launch couldn't be completed (${escapeHtml(code)}). Open it again from your course.</p>`, frameAncestors, status });
}

/**
 * The storage-mode login page (§3.3 step 1): put state and nonce into the
 * platform's storage, checking each answer's subject, message_id, origin and
 * source, then go to the platform's auth endpoint.  Any error or a 5 s timeout
 * goes to the server's cookie fallback instead.
 */
export function storageLoginPage(o: { target: string; storageOrigin: string; key: string; state: string; nonce: string; authUrl: string; fallbackUrl: string; frameAncestors: string[] }): Response {
  const script = `(() => {
  const O = ${js(o.storageOrigin)}, T = ${js(o.target)}, K = ${js(o.key)};
  const win = T === "_parent" ? window.parent : window.parent.frames[T];
  const go = (u) => { window.location.replace(u); };
  if (!win) return go(${js(o.fallbackUrl)});
  const want = new Map();
  const put = (key, value) => new Promise((ok, no) => {
    const id = crypto.randomUUID();
    want.set(id, { key, ok, no });
    win.postMessage({ subject: "lti.put_data", message_id: id, key, value }, O);
  });
  window.addEventListener("message", (e) => {
    if (e.origin !== O || e.source !== win) return;
    const d = e.data;
    if (!d || d.subject !== "lti.put_data.response" || !want.has(d.message_id)) return;
    const w = want.get(d.message_id);
    want.delete(d.message_id);
    if (d.error || d.key !== w.key) w.no(); else w.ok();
  });
  const t = setTimeout(() => go(${js(o.fallbackUrl)}), 5000);
  Promise.all([put("sb_state_" + K, ${js(o.state)}), put("sb_nonce_" + K, ${js(o.nonce)})]).then(() => { clearTimeout(t); go(${js(o.authUrl)}); }, () => { clearTimeout(t); go(${js(o.fallbackUrl)}); });
})();`;
  return page({ title: "Sagebrush", body: "<p>Opening…</p>", script, frameAncestors: o.frameAncestors });
}

/** Redeem a ticket for a session, same-origin, then show the app (stage A: a placeholder). */
const redeemScript = (ticket: string | null, verify: string | null) => `(() => {
  const show = (t) => { document.getElementById("s").textContent = t; };
  const post = (path, body, headers = {}) => fetch(path, { method: "POST", credentials: "omit", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then((r) => r.json());
  const open = (ticket) => post("/lti/session", { ticket }).then((s) => {
    // a deep-link request opens the picker, by a same-origin form POST naming only its transaction
    if (s.deep_link) {
      const f = document.createElement("form");
      f.method = "post"; f.action = "/lti/deeplink/pick";
      const i = document.createElement("input"); i.type = "hidden"; i.name = "dl"; i.value = s.deep_link;
      f.appendChild(i); document.body.appendChild(f); f.submit();
      return;
    }
    if (!s.token) return show("This course isn't set up for Sagebrush yet (" + (s.error || "error") + ").");
    sessionStorage.setItem("sb_lti_token", s.token);
    show("Signed in as " + s.role + ".");
  });
  ${ticket !== null ? `open(${js(ticket)});` : ""}
  ${verify !== null ? verify : ""}
})();`;

export function ticketPage(ticket: string, frameAncestors: string[]): Response {
  return page({ title: "Sagebrush", body: `<p id="s">Opening…</p>`, script: redeemScript(ticket, null), frameAncestors });
}

/**
 * The storage-mode verify page (§3.3 step 2): it holds `corr` and nothing that
 * grants access by itself.  It reads state and nonce back from the platform's
 * storage (checking every answer), then verifies same-origin.
 */
export function verifyPage(o: { corr: string; key: string; target: string; storageOrigin: string; newTab: string; frameAncestors: string[] }): Response {
  const verify = `
  const O = ${js(o.storageOrigin)}, T = ${js(o.target)}, K = ${js(o.key)};
  const win = T === "_parent" ? window.parent : window.parent.frames[T];
  const fallback = () => { document.getElementById("s").hidden = true; document.getElementById("f").hidden = false; };
  if (!win) { fallback(); return; }
  const want = new Map();
  const get = (key) => new Promise((ok, no) => {
    const id = crypto.randomUUID();
    want.set(id, { key, ok, no });
    win.postMessage({ subject: "lti.get_data", message_id: id, key }, O);
  });
  window.addEventListener("message", (e) => {
    if (e.origin !== O || e.source !== win) return;
    const d = e.data;
    if (!d || d.subject !== "lti.get_data.response" || !want.has(d.message_id)) return;
    const w = want.get(d.message_id);
    want.delete(d.message_id);
    if (d.error || d.key !== w.key || typeof d.value !== "string") w.no(); else w.ok(d.value);
  });
  const t = setTimeout(fallback, 5000);
  Promise.all([get("sb_state_" + K), get("sb_nonce_" + K)]).then(([state, nonce]) => {
    clearTimeout(t);
    return post("/lti/launch/verify", { corr: ${js(o.corr)}, state, nonce }).then((v) => v.ticket ? open(v.ticket) : fallback());
  }, () => { clearTimeout(t); fallback(); });`;
  return page({ title: "Sagebrush", body: `<p id="s">Opening…</p><div id="f" hidden>${newTabBody(o.newTab)}</div>`, script: redeemScript(null, verify), frameAncestors: o.frameAncestors });
}

const newTabBody = (href: string) => `<p>Your browser blocked this frame from signing in.</p><p><a class="button" href="${escapeHtml(href)}" target="_blank" rel="noopener">Open in a new tab</a></p><p style="font-size:13px;color:#555">If that doesn't work, open it again from your course. Instructors can set this placement to open in a new window.</p>`;

/** §3.3 step 4: one button, a fresh top-level login. */
export function newTabPage(href: string, frameAncestors: string[]): Response {
  return page({ title: "Sagebrush", body: newTabBody(href), frameAncestors });
}

/** amendment 2 r1 §2.2: a launch request too large for Sagebrush, refused with its parameter-specific code. */
export function tooLargePage(code: string, frameAncestors: string[]): Response {
  return page({ title: "Sagebrush", body: `<p>Your course sent a launch request too large for Sagebrush (${escapeHtml(code)}). Please report this to your instructor or to Sagebrush support.</p><p data-error="${escapeHtml(code)}"></p>`, frameAncestors, status: 400 });
}

export function guestPage(frameAncestors: string[]): Response {
  return page({ title: "Sagebrush", body: "<p>Sagebrush has nothing for your role in this course yet.</p>", frameAncestors });
}

export function notYetPage(what: string, frameAncestors: string[]): Response {
  return page({ title: "Sagebrush", body: `<p>${escapeHtml(what)} isn't available yet.</p>`, frameAncestors });
}

/** After dynamic registration: tell the LMS to close the registration window (LTI Dynamic Registration §3.6). */
export function registeredPage(ok: boolean, frameAncestors: string[]): Response {
  const script = ok ? `(window.opener || window.parent).postMessage({ subject: "org.imsglobal.lti.close" }, "*");` : undefined;
  return page({
    title: "Sagebrush",
    body: ok ? "<p>Sagebrush is registered. It will work once your institution's admin approves it on cocalc.ai.</p>" : "<p>Registration failed. Ask for a new registration link.</p>",
    script,
    frameAncestors,
    status: ok ? 200 : 400,
  });
}
