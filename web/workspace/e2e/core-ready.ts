// The E2E core (core/, pure) with the fleet core's crypto backend and schemas installed, through the one way into the
// fleet core (fleet/install.ts's fleetCore()). For a module outside e2e/ that checks key chains with the E2E core (the
// sync server's key chain store): it calls this instead of naming the fleet core or an installer itself.
import { fleetCore } from "../fleet/install.ts";
import * as core from "./core/index.mjs";

/** The E2E core, ready to verify: the fleet core's backend installed first (once; again is a no-op). */
export function e2eCore(): typeof core {
  fleetCore();
  return core;
}
