# web/cloud/lti: the LTI 1.3 tool

Hosted-service code: it lives in this repository under `web/cloud/`, MS-RSL (`web/cloud/LICENSE.md`), and no MIT code imports it (`scripts/check-no-server-imports.mjs`).

**Spec:** `plan-lti-r5.md` (sha256 bf45075f…), approved Oct 23, 2026. This directory is stage A (r5 §13), arriving in three PRs:
1. launch, registration and sessions;
2. amendment 1 r6 (8ed41bc3…): handles, recovery and erasure;
3. the fixes found against real Moodle and Canvas, the vm-test harness, and amendment 2 r1 (508e1508…).

**Self-contained:** nothing here imports from the rest of the site.
- **Nothing deploys it yet:** there's no Wrangler config and no route.
- **Without its bindings,** every `/lti/*` route answers 404.

**Tests:** `node web/cloud/lti/test-lti.mjs`, run from the repository's root after `cd web/site && npm ci`. It uses Miniflare from web/site's
node_modules, with real Durable Objects (SQLite) and D1, against a synthetic platform and a fake cocalc.ai. Synthetic data only.
