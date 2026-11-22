// The support page (plan-support-requests r12 §2): GET / (the form), /support.js and /support.css, all from this
// Worker, under the page's CSP: nothing but its own files and Turnstile's.  The page sends one request per
// attempt to ./support.ts's API, with a fresh Turnstile token each time, and shows only the answer's ref.
import { KINDS, MAX_DESCRIPTION, MAX_TITLE, MIN_DESCRIPTION, MIN_TITLE, siteKeyOk, type SupportEnv } from "./support.ts";

export const CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "connect-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const LABELS: Record<(typeof KINDS)[number], string> = {
  bug: "Something is broken",
  pkg: "A missing package or module",
  feat: "A missing LaTeX, Sage or MATLAB feature",
  book: "A book or paper to support",
  other: "Something else",
};

const common = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
};

// The page's files, or null for any other path.
export function handlePage(req: Request, env: SupportEnv): Response | null {
  const path = new URL(req.url).pathname;
  if (path !== "/" && path !== "/support.js" && path !== "/support.css") return null;
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  if (path === "/support.js") return new Response(SCRIPT, { headers: { ...common, "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
  if (path === "/support.css") return new Response(STYLE, { headers: { ...common, "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" } });
  if (!siteKeyOk(env.TURNSTILE_SITE_KEY)) return new Response("support is unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  return new Response(page(env.TURNSTILE_SITE_KEY), {
    headers: { ...common, "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-cache" },
  });
}

const options = KINDS.map((k) => `<option value="${k}">${LABELS[k]}</option>`).join("");

// (the site key is checked by siteKeyOk: letters, digits, _ and - only)
const page = (siteKey: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Report an issue or request support | Sagebrush</title>
<link rel="stylesheet" href="/support.css">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" defer></script>
<script src="/support.js" defer></script>
</head>
<body>
<main>
<h1>Report an issue or request support</h1>
<p><a href="https://sagebrush.space/" rel="noopener noreferrer">Back to Sagebrush</a></p>
<form id="form" novalidate>
<label for="kind">What is it about?</label>
<select id="kind" name="kind" required>${options}</select>
<label for="title">Title</label>
<input id="title" name="title" required minlength="${MIN_TITLE}" maxlength="${MAX_TITLE}" autocomplete="off">
<label for="description">Description</label>
<textarea id="description" name="description" required minlength="${MIN_DESCRIPTION}" maxlength="${MAX_DESCRIPTION}" rows="10"></textarea>
<p class="hint">To share a file, paste its text, or a link to a shared Sagebrush document.</p>
<label for="email">Email (optional)</label>
<input id="email" name="email" type="email" maxlength="254" autocomplete="email">
<p class="hint">Add an email if you can, so we can reply.</p>
<div id="turnstile" data-sitekey="${siteKey}"></div>
<button id="send" type="button">Send</button>
<p id="status" role="status" aria-live="polite"></p>
</form>
<section class="privacy">
<h2>Privacy</h2>
<p>Sagebrush's support service attaches no account, session or device information and keeps no copy of your request. What you type is passed to CoCalc's support system and handled exactly like a request through CoCalc's own support form: it goes to CoCalc's Zendesk help desk, may appear in CoCalc's server logs, and, if you give an email, is matched to a CoCalc account name for that email, if one exists. It is kept like other CoCalc support tickets. It may contain personal information you choose to include. If you give an email address, replies come to it, and CoCalc's support desk may email you about this request.</p>
<p>To limit abuse per person, your IP address is passed to CoCalc's support system with your request and kept there for 8 days in the request's rate-limit record (as on CoCalc's own support form). It isn't added to the ticket.</p>
</section>
</main>
</body>
</html>
`;

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1d2b32;background:#fafaf7}
main{max-width:40rem;margin:2rem auto;padding:0 1rem}
label{display:block;margin-top:1rem;font-weight:600}
input,select,textarea{display:block;width:100%;box-sizing:border-box;font:inherit;padding:.4rem}
.hint{margin:.25rem 0 0;font-size:.9rem;color:#4b5b63}
#turnstile{margin-top:1rem}
button{margin-top:1rem;font:inherit;padding:.5rem 1.25rem;cursor:pointer}
#status{min-height:1.5rem}
.privacy{margin-top:2rem;font-size:.9rem;color:#4b5b63}
`;

// (the page's script: no inline code under the CSP; every value shown is set with textContent)
const SCRIPT = `"use strict";
(function () {
  var form = document.getElementById("form");
  var status = document.getElementById("status");
  var send = document.getElementById("send");
  var box = document.getElementById("turnstile");
  var token = "";
  var widget = null;
  function show(text) { status.textContent = text; }
  function render() {
    if (!window.turnstile) { setTimeout(render, 100); return; }
    widget = window.turnstile.render(box, {
      sitekey: box.dataset.sitekey,
      action: "support",
      callback: function (t) { token = t; },
      "expired-callback": function () { token = ""; },
      "error-callback": function () { token = ""; }
    });
  }
  render();
  // An agent's draft, in the fragment (the addendum to plan-support-requests r12, section 2): #draft=<base64url of the
  // UTF-8 JSON {"v":1,"kind","title","description"}>. Read once, the fields filled, the fragment cleared. Only those
  // keys are read, and only when every one is valid (else the form stays empty); anything else (send, submit, email)
  // is ignored. Nothing is sent: only the person's own click on Send sends.
  if (location.hash.indexOf("#draft=") === 0) {
    var raw = location.hash.slice(7);
    history.replaceState(null, "", location.pathname + location.search);
    try {
      var bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
      var d = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, function (c) { return c.charCodeAt(0); })));
      if (d && d.v === 1 && ${JSON.stringify(KINDS)}.indexOf(d.kind) >= 0 && typeof d.title === "string" && typeof d.description === "string" &&
          d.title.length >= ${MIN_TITLE} && d.title.length <= ${MAX_TITLE} && d.description.length >= ${MIN_DESCRIPTION} && d.description.length <= ${MAX_DESCRIPTION}) {
        form.kind.value = d.kind;
        form.title.value = d.title;
        form.description.value = d.description;
        show("An agent drafted this request. Review it, add your email if you like, and press Send.");
      }
    } catch (err) {}
  }
  var messages = {
    400: "Please check the fields and try again.",
    403: "The check didn't pass. Please try again.",
    413: "That's too long. Please shorten the description.",
    429: "Too many requests from this address. Please try again later.",
    503: "Support is unavailable right now. Please try again in a few minutes."
  };
  // Only the person's own activation of Send sends (the addendum's section 6.5; astra's SUPPORT-DRAFT-1, python's
  // design): there is no form submission path (Send is a type="button", and a submit, by requestSubmit() or Enter in a
  // field, is cancelled and sends nothing), and the one POST is in Send's own click listener, only for a trusted
  // click on Send itself (the mouse, or Enter or Space on Send focused) with user activation. A script's send.click()
  // isn't trusted, whatever the window's activation from a click elsewhere.
  form.addEventListener("submit", function (e) { e.preventDefault(); });
  send.addEventListener("click", function (e) {
    e.preventDefault();
    if (!e.isTrusted || e.target !== e.currentTarget || (navigator.userActivation && !navigator.userActivation.isActive)) return;
    var kind = form.kind.value, title = form.title.value, description = form.description.value, email = form.email.value.trim();
    if (title.length < ${MIN_TITLE} || title.length > ${MAX_TITLE}) { show("The title needs ${MIN_TITLE} to ${MAX_TITLE} characters."); return; }
    if (description.length < ${MIN_DESCRIPTION} || description.length > ${MAX_DESCRIPTION}) { show("The description needs ${MIN_DESCRIPTION} to ${MAX_DESCRIPTION} characters."); return; }
    if (!token) { show("Please complete the check above first."); return; }
    var body = { kind: kind, title: title, description: description };
    if (email) body.email = email;
    var used = token;
    token = "";
    send.disabled = true;
    show("Sending...");
    fetch("/api/v1/requests", {
      method: "POST",
      headers: { "content-type": "application/json", "x-turnstile-token": used, "x-submission-id": crypto.randomUUID() },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 200 && typeof j.ref === "string") {
          form.reset();
          show("Request received: #" + j.ref);
        } else {
          show(messages[r.status] || messages[503]);
        }
      });
    }, function () {
      show(messages[503]);
    }).then(function () {
      send.disabled = false;
      // (a fresh challenge for every attempt)
      if (widget !== null) window.turnstile.reset(widget);
    });
  });
})();
`;
