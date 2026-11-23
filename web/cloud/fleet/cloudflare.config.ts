// The fleet Worker (agent-autonomous-browser-relay.md r2.1 §3 and §5): the browser relay's two control-plane calls
// (./fleet.ts), on a name of its own, fleet-dev.sagebrush.space, which only the relay calls.  DEV only: there is no
// production deployment, and any mode but `--mode dev` refuses to build (README: deploy).
//
// Its only bindings: the kill switch, the aud the opens are signed for, the relay's service key (a secret, generated
// and installed at deploy, never in this repository, argv or a log) and its own D1 database (migrations/, applied by
// hand).  No session, sync, share or account binding: the fleet service's state comes through FleetFacts once it
// exists.  The D1 id is filled in when the database exists (created at deploy); until then this Worker isn't deployed.
import { bindings, defineConfig, triggers } from "cf/config";
import * as devEntrypoint from "./src/dev.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: ({ mode }) => {
    if (mode !== "dev") throw new Error("the fleet Worker has no production deployment: build it with --mode dev");
    return {
      name: "sagebrush-fleet-dev",
      compatibilityDate: "2026-10-01",
      entrypoint: devEntrypoint,
      domains: ["fleet-dev.sagebrush.space"],
      env: {
        // (the kill switch: "1" answers calls; anything else answers 503)
        FLEET_RELAY_OPEN: bindings.text("1"),
        // (the audience DEV's opens are signed for: the fleet core's AUDIENCES)
        FLEET_AUD: bindings.text("https://dev.sagebrush.space"),
        // (32 random bytes, base64url: the relay's copy is on the relay VM, beside relay-dev's own key)
        RELAY_CONTROL_KEY: bindings.secret(),
        // (consumed control-call ids, the sequence, epochs and changes: nothing else)
        FLEET_RELAY_DB: bindings.d1({ name: "sagebrush-fleet-dev", id: "00000000-0000-4000-8000-000000000000" }),
      },
      // (every 10 minutes: control ids past their 10 minutes, changes past 24 hours)
      triggers: [triggers.scheduled({ schedule: "*/10 * * * *" })],
    };
  },
});
