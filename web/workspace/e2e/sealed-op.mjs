// The bytes a device signs for one sealed index op (design/e2e-encryption.md §4, §4.1; e2e PR 5b): the op's place
// (the account; the sync account's generation, which "Delete my synced data" ends, and the key chain's generation,
// which survives that; the key chain's head it was sealed under; the sync device and its dseq), its
// envelope (by SHA-256) and the exact blob references it adds and releases, and the E2E device that signs.  Domain-
// separated, in the fleet protocol's canonical JSON, so a signature for one op can't be moved to another account,
// position, envelope or set of references.  The client signs these bytes; the server verifies them against the signer's
// key in the current chain before the op has any effect.

import { canonText, enc, sha256b64 } from "./core/sealed-prims.mjs";

export const SEALED_OP_DOMAIN = "sagebrush.e2e.sealed-op.v1\n";

/**
 * @param {{ account: string, syncGeneration: number, chainGeneration: string, head: string, device: string, dseq: number, env: Uint8Array,
 *   adds: string[], releases: string[], signer: string }} op
 * @returns {Promise<Uint8Array>}
 */
export async function sealedOpMessage(op) {
  const body = {
    account: op.account, sync_generation: op.syncGeneration, chain_generation: op.chainGeneration, head: op.head, device: op.device, dseq: op.dseq,
    env: await sha256b64(op.env), adds: [...op.adds], releases: [...op.releases], signer: op.signer,
  };
  return enc(SEALED_OP_DOMAIN + canonText(body));
}
