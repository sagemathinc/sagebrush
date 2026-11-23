// The fleet protocol's pure core (design: agent-autonomous-schemas.md r2.3, sha256 db905c9d72ba5d4e…dddc7e3): no Node
// built-ins, so a page, a Worker or the app's web view loads these files as they are. Install a crypto backend
// (useCrypto: webCrypto() from ./webcrypto.mjs, or Node's) and the schemas (useSchemas) first. Everything that hashes,
// verifies or signs is async; the form checks and key lookups aren't. In Node, ../index.mjs installs both.

export { useCrypto } from "./crypto.mjs";
export { webCrypto } from "./webcrypto.mjs";
export { FREEZE, useSchemas, fleetSchema, reasonNames, bodyValidator } from "./schemas.mjs";
export { FleetError, refuse, ID, isId, newId, random, idOfBytes, bytesOfId, b64, unb64, B64LEN, sha256, sha256b64, utf8, enc, concat, bytesEqual } from "./bytes.mjs";
export { canonText, canonBytes, parseCanonical, SIGNED_MAX, SIGNED_DEPTH } from "./canonical.mjs";
export { verifyStrict, strictShape, checkPublicKey, canonicalPoint, smallOrder, keyId, keyIdInput, asKey, keyFromSeed } from "./ed25519.mjs";
export { AUDIENCES, TYPES, signedBytes, parseEnvelope, seal, sealAdd, open } from "./envelope.mjs";
export { compile } from "./schema.mjs";
export { apply as applyChainEntry, replay as replayChain, deviceKey, requireTier, serviceKeyAt } from "./chain.mjs";
export { newRecoveryCode, showCode, readCode, recoveryKey } from "./recovery.mjs";
export { openByDevice, canonicalPath, hostFingerprint, deviceFingerprint, showFingerprint, narrowsOnly, preimageHash, verifyHostCert, verifyGrant, verifyGrantAck, verifyHostOp, verifyRevocation, verifyApproval } from "./verify.mjs";
export { HPKE, deriveKeyPair, setupSender, setupRecipient, seal as hpkeSeal, open as hpkeOpen } from "./hpke.mjs";
export { encKeyId, sealPackage, verifyPackage, sealCap, openCap } from "./sealed.mjs";
