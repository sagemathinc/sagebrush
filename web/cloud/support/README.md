# web/cloud/support: the support Worker

The "Report an issue / request support" page for Sagebrush and its one API, on a domain of its own:
`support.sagebrush.space` (production) and `support-dev.sagebrush.space` (`--mode dev`). The plan is
plan-support-requests r12.

The page (`page.ts`) sends a request to `POST /api/v1/requests` (`support.ts`). The Worker checks it and passes it
to CoCalc's support system, `POST <CoCalc>/api/v2/support/sagebrush-intake` (cocalc-ai#1548, docs/sagebrush.md
section 6 there). CoCalc creates the Zendesk ticket exactly as its own support form does. The Worker keeps no copy
of a request; its only storage is the backstop's counters.

**What the API checks, in order** (each fails closed; `support.ts`'s header has the details):

1. **The kill switch** (`SUPPORT_OPEN`, "1" to accept) and the CoCalc URL's allowlist. Production also refuses
   Turnstile's test keys.
2. **The Origin**, byte-exact (`SUPPORT_ORIGIN`). There is no CORS.
3. **The type and length:** `Content-Type: application/json`, and a `Content-Length` of at most 131,072 bytes.
4. **The client and admission:**
   - the client IP is `CF-Connecting-IP`, and must be an IP literal;
   - `SUPPORT_IP` is a flood gate of 3 a minute per IP, per Cloudflare location;
   - this isolate admits at most 8 requests at a time.
5. **`X-Submission-Id`**, a UUIDv4. It is used only for the answer's ref and as a line in the ticket.
6. **Turnstile siteverify** of `X-Turnstile-Token`, with action `support` and this Worker's own hostname; the token
   must be fresh (never in the future, at most 300 s old). Only then is the body read, by a counting reader:
   - **the whole read has a deadline of 10 s (`BODY_DEADLINE_MS` = 10,000)**, from the first byte to the last;
   - a body not complete by then is answered **408 `body-timeout`**; a body longer or shorter than its
     Content-Length, or whose stream fails (the client went away), **400**; past 131,072 bytes, **413**;
   - in each of these cases the body's stream is **cancelled** at once, and the request's **admission slot is
     released** (one of the isolate's 8), so a stalled upload holds its slot for at most 10 s after siteverify.
7. **A strict parse:** one object with exactly the keys `kind`, `title`, `description` and an optional `email`, all
   strings.
8. **The account-wide abuse backstop** in D1: fewer than 600 this UTC hour and 3,000 this UTC day, both or neither,
   never refunded. A refusal is a 503 with a Retry-After to the next hour or day, and the log code
   `support-backstop-exhausted`.
9. **One call to CoCalc**, with `X-Sagebrush-Intake-Key` and `X-Sagebrush-Client-IP`. Its answer is mapped by HTTP
   status only:

   | CoCalc's answer | The Worker's answer |
   | --- | --- |
   | 200 `{ok: true}` | 200 `{ref}` |
   | 400 | 400 |
   | 429 | 429 |
   | 401 | 503, logged as `intake-key-rejected` |
   | anything else, including a redirect or a timeout | 503 |

**The per-person limits are CoCalc's:** per email, per IP and per email and IP, in their own namespace (see
docs/sagebrush.md section 6 in cocalc-ai). `SUPPORT_IP` only stops floods cheaply, before Turnstile.

**Logs** carry fixed codes and CoCalc's HTTP status only.

**An agent's draft** (the addendum to plan-support-requests r12): `https://support.sagebrush.space/#draft=<base64url
of the UTF-8 JSON {"v":1,"kind","title","description"}>` fills the form, for the person to review and send.
- The page reads the fragment once and clears it with `history.replaceState`. A fragment never reaches a server or
  a log.
- It fills the fields only when `v` is 1 and the kind, title and description are all valid; otherwise the form stays
  empty. Every other key (`send`, `submit`, `email`) is ignored.
- Only the person's own activation of Send sends. Send is a `type="button"`, so there is no form submission path: a
  submit (`requestSubmit()`, Enter in a field) is cancelled and sends nothing. The one POST is in Send's own click
  listener, for a trusted click on Send itself (the mouse, or Enter or Space with Send focused) with user activation.
  A script's `send.click()` isn't trusted, even after the person has clicked elsewhere on the page.

## Setup (William or @sagebrush; nothing secret is in this repository)

- **Replace before deploy** (placeholders in `cloudflare.config.ts`): the two D1 ids and the two Turnstile site keys
  (empty: the page answers 503 until set).
- **The D1 databases**, `sagebrush-support-dev` and `sagebrush-support`: put their ids in `cloudflare.config.ts`.
  Apply `migrations/` by hand, DEV first. PROD is applied only with William's per-file OK, never by a deploy.
- **A Turnstile widget** for each hostname: its site key goes into `TURNSTILE_SITE_KEY` in `cloudflare.config.ts`,
  and its secret is the `TURNSTILE_SECRET` secret.
- **`COCALC_INTAKE_KEY`**, a secret equal to CoCalc's `sagebrush_support_intake_key` setting: 32 random bytes in
  base64url, `openssl rand 32 | basenc --base64url | tr -d =`.
- **DEV's CoCalc URL** (`COCALC_INTAKE_URL`, dev only): it must be https, on cocalc.ai or a host under it, with
  exactly the intake path.
- **Production** is `SUPPORT_OPEN` "0" until William's go.

## Deploy (by @sagebrush; this Worker isn't in the automatic DEV deploy)

```sh
cd web/cloud/support && npm install
npx cf deploy --mode dev     # support-dev.sagebrush.space
npx cf deploy                # production: only with William's OK
```

## Tests

```sh
(cd web/site && npm ci) && node web/cloud/support/test-support.mjs
```

This runs in Miniflare with a real D1 and rate-limit simulation, a fake siteverify and a fake CoCalc. Its last
check runs `web/cloud/support/test-support-page.mjs`: the page's script in headless Chromium, with the draft pre-fill and
the Send guard. CI runs both in web-sync.1 (test-support.mjs's `// ci:` header).

**Note:** this Worker imports nothing outside `web/cloud/support`; the site install above is only the tests'
Miniflare.
