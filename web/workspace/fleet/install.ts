// The page's one way into the fleet core. core/ is a byte-for-byte mirror of sagebrush-agent's lib/fleet/core/ at
// 2d4870a5932f01ebdb156f18547f909bd37e6ed5, with fleet.schema.json and reasons.json from its schema/fleet/
// (test-fleet-core.mjs pins every file's sha256). The core takes one crypto backend and one schema loader per page
// and refuses any other after that, so every page module that verifies goes through fleetCore() here, never through
// core/ itself. The strict Ed25519 rules (canonical points, no small-order key, S < L) are the core's own and run
// before WebCrypto's verify: Chromium's WebCrypto accepts a small-order forgery by itself.
import * as core from "./core/index.mjs";
import fleetSchema from "./fleet.schema.json";
import reasons from "./reasons.json";

const BUNDLED: Readonly<Record<string, unknown>> = Object.freeze({ "fleet.schema.json": fleetSchema, "reasons.json": reasons });
const load = (name: string): unknown => {
  if (!Object.hasOwn(BUNDLED, name)) throw new Error(`no bundled fleet schema ${name}`);
  return BUNDLED[name];
};

// (the same backend object every time: the core takes a second install of the very same one as a no-op, so a call
//  after a failed schema install doesn't trip over the crypto it already has)
let backend: ReturnType<typeof core.webCrypto> | null = null;
let ready = false;

/** The fleet core, with this page's WebCrypto and the bundled frozen schemas installed; throws without WebCrypto. */
export function fleetCore(): typeof core {
  if (!ready) {
    backend ??= core.webCrypto();
    core.useCrypto(backend);
    core.useSchemas(load);
    ready = true;
  }
  return core;
}
