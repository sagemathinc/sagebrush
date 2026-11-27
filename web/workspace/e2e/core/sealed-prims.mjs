// The fleet core's pure functions that sealed ops use (e2e/sealed-op.mjs, and the sync server's check of a sealed op's
// signature and hash), named here so that nothing outside e2e/core/ names the fleet core itself. A caller outside the
// E2E code installs the core's backend first, through e2e/core-ready.ts.
import { canonText } from "../../fleet/core/canonical.mjs";
import { enc, sha256b64, unb64 } from "../../fleet/core/bytes.mjs";
import { verifyStrict } from "../../fleet/core/ed25519.mjs";

export { canonText, enc, sha256b64, unb64, verifyStrict };
