// Every domain-separation label of the end-to-end encryption, in one frozen table (design: e2e-encryption.md §2, §3,
// §6, §11). A label names its purpose and its version (the ".v1"): a new derivation gets a new label beside the old,
// never in its place (§11.1). test-e2e-crypto.mjs checks the table: every label distinct, and none a prefix of another
// (each is followed by its inputs, so a prefix could make two derivations' inputs equal).
export const LABELS = Object.freeze({
  // ---- from an epoch's secret S[e] (§2): HKDF-SHA256, each key under its own label (keys.ts)
  epochIndex: "sagebrush.e2e.epoch.index.v1",
  epochAddr: "sagebrush.e2e.epoch.addr.v1",
  epochBlob: "sagebrush.e2e.epoch.blob.v1",
  epochWrap: "sagebrush.e2e.epoch.wrap.v1",
  // ---- blobs (§3.3): the wire address, the file key, the chunk key (keys.ts); the chunk's AAD (chunks.ts)
  blobAddress: "sagebrush.blob.v1",
  blobFile: "sagebrush.blob.file.v1",
  blobChunk: "sagebrush.blob.chunk.v1",
  blobChunkAad: "sagebrush.e2e.blob.chunk.aad.v1",
  // ---- a document's, snapshot's or index snapshot's chunks (§3.2): the per-sealing key, and the AAD (chunks.ts)
  objectKey: "sagebrush.e2e.object.key.v1",
  objectChunkAad: "sagebrush.e2e.object.chunk.aad.v1",
  // ---- the key chain's (keys and devices, §11.1 and §11.2): here so that one table covers every label
  keyring: "sagebrush.keyring.v1",
  kemPop: "sagebrush.kem-pop.v1",
  recoverySign: "sagebrush.e2e.recovery.sign.v1",
  recoveryKem: "sagebrush.e2e.recovery.kem.v1",
  epochCommit: "sagebrush.e2e.epoch-commit.v1",
  // the key chain's envelopes, wrappers and probes (e2e/core/, keys and devices): spelled there for now, registered
  // here so that the one collision check covers them
  chainEnvelope: "sagebrush.e2e.chain.v1",
  wrapEnvelope: "sagebrush.e2e.wrap.v1",
  preEntry: "sagebrush.e2e.pre-entry.v1",
  publicKeyProbe: "sagebrush.e2e.public-key-probe.v1",
  keySalt: "sagebrush.e2e.v1",
  // ---- named by the design for later work (§6.2): listed so that nothing else takes them
  logSegment: "sagebrush.logseg.v1",
  remote: "sagebrush.remote.v1",
});

export type Label = (typeof LABELS)[keyof typeof LABELS];
