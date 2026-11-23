// The support Worker (plan-support-requests r12): the "Report an issue / request support" page and its API
// (./support.ts, ./page.ts), on a domain of its own, so it shares no cookie, storage or origin with the site.
// `--mode dev` deploys support-dev.sagebrush.space, calling DEV's CoCalc; production deploys
// support.sagebrush.space, calling https://cocalc.ai.  Each from its own entry: src/dev.ts and src/prod.ts.
//
// Its only bindings: the kill switch, its own origin, Turnstile's site key (public) and secret, CoCalc's intake
// URL and key, SUPPORT_IP (a per-IP flood gate, per Cloudflare location) and its own counter-only D1 database
// (the account-wide backstop: migrations/, applied by hand, DEV first).  No app data, session, sync or share
// binding.  The secrets come from the deploy's secrets file, never from this repository.
//
// Production is closed (SUPPORT_OPEN "0") until William's go; it never runs on Turnstile's test keys
// (test-support.mjs: production's test-key rows).  The D1 ids and the Turnstile site keys are filled in when those exist (created
// by William or @sagebrush); until then this Worker isn't deployed (README: replace before deploy).
import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/prod.ts" with { type: "cf-worker" };
import * as devEntrypoint from "./src/dev.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: ({ mode }) => {
    const dev = mode === "dev";
    return {
      name: dev ? "sagebrush-support-dev" : "sagebrush-support",
      compatibilityDate: "2026-10-01",
      entrypoint: dev ? devEntrypoint : entrypoint,
      domains: [dev ? "support-dev.sagebrush.space" : "support.sagebrush.space"],
      env: {
        // (the kill switch: "1" accepts requests; anything else answers 503)
        SUPPORT_OPEN: bindings.text(dev ? "1" : "0"),
        // (the one origin a request may come from: this Worker's own page)
        SUPPORT_ORIGIN: bindings.text(dev ? "https://support-dev.sagebrush.space" : "https://support.sagebrush.space"),
        // (empty until each hostname's widget exists: the page then answers 503, never a bogus key)
        TURNSTILE_SITE_KEY: bindings.text(dev ? "" : ""),
        TURNSTILE_SECRET: bindings.secret(),
        // (production's is fixed in src/prod.ts too; DEV's is DEV's CoCalc, once William names it)
        COCALC_INTAKE_URL: bindings.text(dev ? "https://lite4b.cocalc.ai/api/v2/support/sagebrush-intake" : "https://cocalc.ai/api/v2/support/sagebrush-intake"),
        COCALC_INTAKE_KEY: bindings.secret(),
        // (per IP, a flood gate before Turnstile: 3 a minute, per Cloudflare location; the exact per-person limits
        // are CoCalc's, in its intake namespace; a namespace of each deployment's own)
        SUPPORT_IP: bindings.rateLimit({ namespace: dev ? "4104" : "4204", simple: { limit: 3, period: 60 } }),
        // (the backstop's counters only)
        SUPPORT_DB: dev
          ? bindings.d1({ name: "sagebrush-support-dev", id: "00000000-0000-4000-8000-000000000000" })
          : bindings.d1({ name: "sagebrush-support", id: "00000000-0000-4000-8000-000000000001" }),
      },
      // (the backstop's cleanup: hour rows after 2 days, day rows after 30)
      triggers: [triggers.scheduled({ schedule: "41 4 * * *" })],
    };
  },
});
