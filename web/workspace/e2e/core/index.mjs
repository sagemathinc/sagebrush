// E2E keys and devices, the pure core (design/e2e-encryption.md §2, §2.1, §2.2, §3.4, §11.1, §11.2). Like the fleet
// core it builds on, it needs the fleet core's crypto backend installed first (fleetCore() in a page; useCrypto in
// tests). HPKE is passed in (PR 1's hpke object), never imported here.

export { E2EError, LABELS, SUITES, knownSuite, AUDIENCES } from "./base.mjs";
export { checkKemPublic, newKem } from "./x25519.mjs";
export { kemFromSeed, ed25519FromSeed } from "./seeded.mjs";
export { CODE_LENGTH, newRecoverySeed, codeOfSeed, showCode, seedOfCode, recoveryKeys } from "./recovery.mjs";
export { newEpochSecret, epochCommit, checkRingMeta, sealKeyring, openKeyring, walkBack } from "./keyring.mjs";
export { preEntryHash, challenge, respond, checkResponse } from "./pop.mjs";
export { TYPE as CHAIN_TYPE, DEVICE_KINDS, apply as applyChainEntry, replay as replayChain, replayFrom, loadAnchored, checkpointOf, ringMeta, pinOf, checkPin, currentDevice, epochAt, nextBody, deviceSigner, recoverySigner, sealEntry } from "./chain.mjs";
export { TYPE as WRAP_TYPE, contextOf, wrapEpoch, verifyWrapper, openWrapper, checkTransition, openRecovery } from "./wrap.mjs";
