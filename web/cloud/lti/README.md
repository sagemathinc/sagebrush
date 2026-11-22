# web/cloud/lti: the LTI 1.3 tool

Hosted-service code: it lives in this repository under `web/cloud/`, MS-RSL (`web/cloud/LICENSE.md`), and no MIT code imports it (`scripts/check-no-server-imports.mjs`).

**What it is:** launch, registration and sessions;
handles, recovery and erasure; deep linking;
grade passback (AGS) with the course and gradebook; and a harness, `vmtest/`,
that runs it against real Moodle and Canvas with synthetic data.

**Imports:** outside this directory, only `web/sync-protocol/doc-protocol.ts` (and the code it imports); its tests also use `web/miniflare-dispatch.mjs`, `web/board/doc.ts` (test-marks) and web/site's Miniflare.
- **Nothing deploys it yet:** there's no Wrangler config and no route.
- **Without its bindings,** every `/lti/*` route answers 404.

**Tests:** `node web/cloud/lti/test-lti.mjs`, run from the repository's root after `cd web/site && npm ci`. It uses Miniflare from web/site's
node_modules, with real Durable Objects (SQLite) and D1, against a synthetic platform and a fake cocalc.ai. Synthetic data only. The other suites (test-content.mjs, grading/test-*.mjs) run the same way; CI runs them all in web-sync.8 and web-sync.9.
