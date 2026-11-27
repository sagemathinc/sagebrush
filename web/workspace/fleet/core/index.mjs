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
export { apply as applyChainEntry, replay as replayChain, deviceKey, requireTier, serviceKeyAt, leaseKeyAt } from "./chain.mjs";
export { newRecoveryCode, showCode, readCode, recoveryKey } from "./recovery.mjs";
export { openByDevice, canonicalPath, hostFingerprint, deviceFingerprint, fleetFingerprint, showFingerprint, narrowsOnly, preimageHash, verifyHostCert, verifyGrant, verifyGrantAck, verifyHostOp, verifyRevocation, verifyApproval, verifyAgentTransfer, verifyTransferReceipt, checkTransferForHost, verifyLeaseRequest, verifyExecutionLease, verifyFenceAck } from "./verify.mjs";
export { HPKE, deriveKeyPair, setupSender, setupRecipient, seal as hpkeSeal, open as hpkeOpen, sendExport as hpkeSendExport, receiveExport as hpkeReceiveExport } from "./hpke.mjs";
export { encKeyId, sealPackage, verifyPackage, sealCap, openCap } from "./sealed.mjs";
export { SIG_KEYS, parseSig, requestBytes, verifyRequest } from "./request.mjs";
export {
  ROUTE as RELAY_ROUTE, COMMIT_ROUTE as RELAY_COMMIT_ROUTE, RECORD_HEADER_MAX, HEADERS_MAX, openTarget, parseOpenTarget, headerBytes, commitBody,
  parseCommit, verifyHostOpen, verifyAppOpen, verifyCommit, APP_TOKEN, APP_TOKEN_ROUTE, APP_TOKEN_MS, appTokenKey, parseAppTokenRequest,
  appTokenRequest, checkAppTokenRow,
} from "./relay.mjs";
export {
  ADMIT_ROUTE, EPOCHS_ROUTE, AUTH_HEADER, ANSWER_HEADER, REQUEST_MAX, ANSWER_MAX, CONTROL_SKEW_MS, CALL_ID_TTL_MS, FEED_MAX, ADMIT_REFUSALS,
  CURSOR_EXPIRED, SCHEMAS as CONTROL_SCHEMAS,
  controlKey, signControlRequest, parseControlAuth, verifyControlRequest, signControlAnswer, verifyControlAnswer, parseAdmitRequest, parseEpochsTarget,
  epochsTarget,
} from "./control.mjs";
export { APP_TOKEN_RATE, handleAppToken, handleControl } from "./worker.mjs";
export { LEASE_ROUTE, LEASE_BODY_MAX, LEASE_TTL_MS, LEASE_SKEW_MS, LEASE_GATE_MARGIN_MS, LEASE_RATE_HOST, LEASE_RATE_SOURCE, NONCE_KEEP_MS, firstLeaseGateOpen, handleLease, nextExpiry } from "./lease-service.mjs";
export {
  CHAIN_ROUTE, CHAIN_PAGE_ENTRIES, CHAIN_PAGE_BYTES, CHAIN_READ_MS, CHAIN_NONCE_KEEP_MS, CHAIN_RATE_HOST, CHAIN_RATE_SOURCE, chainTarget, parseChainTarget,
  parseChainPage, handleChainRead, chainPageBody,
} from "./chain-service.mjs";
export {
  GRANT_ROUTE, GRANT_PAIRS_MAX, GRANT_RESULT_MAX, GRANT_READ_BYTES, GRANT_READ_MS, GRANT_RATE_HOST, GRANT_RATE_SOURCE, grantTarget, parseGrantTarget,
  parseGrantRead, handleGrantRead, grantReadBody,
} from "./grant-service.mjs";
